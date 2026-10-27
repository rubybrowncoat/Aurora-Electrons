/* eslint-disable no-template-curly-in-string */
/*
  Checks the comparison of the three routes to mining capacity at a colony (src/renderer/utilities/mine-bootstrap.js, its reads in src/renderer/utilities/mine-bootstrap-data.js, the freight cargo kind of src/renderer/utilities/haul-plan.js and the Mine bootstrap panel of src/renderer/pages/colony-outlook.vue).

  bun scripts/check-mine-bootstrap.js [--no-mutations] [--no-saves]

  The utilities are run on synthetic colonies, freighters and ground formations worked by hand: what a number of mines costs, weighs and needs in workers; the local build of a colony that is fully staffed, understaffed (it cannot receive its full capacity), at an efficiency of 0, fully held by running projects, short of minerals or short of workers once the manned mines stand; the import of mines built at another colony and carried in (the tonnage, the lift of the class, the trips, the freight deficit and the labour deficit of manned and automated mines, no freighter, no route, no builder); and the engineers' route (the commander multiplier, the capacity modifier of a headquarters, the chain of parents at the same colony, the formations aboard ships, the engineers already at the colony) with its unavailable cases (a version the rules are not mapped for, a missing column, a null rating, size, headquarters capacity or commander bonus, a lookup the save does not confirm).

  The reads run on a small in-memory database of their own: which installation types the race can build, the colonies' places, stock and cargo handling, the projects, the freighters and troop ships, and the formations with their commanders; the reads that meet a column the save lacks or a null value say unknown, never 0. The page is run as a pseudo instance on rows given as data, and its template is read as text.

  The saves (AuroraDB.db, game 140, race 784, and saves/AuroraDB_271_skoormit_saved.db, game 138, race 785, read-only; a save that is not there is skipped and counts as neither a pass nor a failure) give the real reads, which are compared with raw counts, the engineers' rating at each colony compared with the figure the Production page's modifiers hold, the routes of real colonies, and copies of the saves in memory (temporary tables over the read-only save) with a colony short of workers, a null rating, a null commander bonus, a dropped column and an unconfirmed commander bonus lookup.

  Each mutation of a utility, the page or the haul module must fail the checks it names. A mutation's run calls only the functions that make the checks it names and loads the page only for the page's checks or the saves'; the head fails when a check a run names reads the page that run leaves out. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { runChild } = require('./lib/check-pool')
const { HarnessError } = require('./lib/browser-observe')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const U = 'src/renderer/utilities/mine-bootstrap.js'
const D = 'src/renderer/utilities/mine-bootstrap-data.js'
const H = 'src/renderer/utilities/haul-plan.js'
const P = 'src/renderer/pages/colony-outlook.vue'
const C = 'src/renderer/utilities/capabilities.js'
const FILES = { [U]: 'mine-bootstrap', [D]: 'mine-bootstrap-data', [H]: 'haul-plan' }
const NAMES = ['mine-bootstrap', 'mine-bootstrap-data', 'colonies', 'production', 'haul-plan', 'provenance', 'minerals']
const SAVES = [
  { file: 'AuroraDB.db', game: 140, race: 784 },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
]
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const THEME_STUB = 'export const chartTheme = () => ({ categorical: [], ink: \'\', inkMuted: \'\', primary: \'\' }); export const withAlpha = (color) => color; export const patternImage = () => null; export const seriesIdentity = () => null'
const MINERAL_COLUMNS = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const STATUSES = ['works', 'limited', 'blocked', 'unavailable']

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

const near = (actual, expected, tolerance = 1e-9) => assert.ok(typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} is not ${expected}`)

const keyOf = (name) => name.slice(0, name.indexOf(':'))

// ---------- the fixtures worked by hand ----------

const fixtures = (m) => {
  const { provenance } = m
  const cap = (value) => provenance.ofRule({ rule: 'mineBootstrap.localBuild', value, units: 'BP/yr' })
  // A colony of 1000 M people at colony cost 0: services take 70%, agriculture 5%, so 250 M can work.
  const split = (required) => m.colonies.workerSplit({}, 1000, 0, required)
  const MINE = { PlanetaryInstallationID: 7, Name: 'Mine', Cost: 120, CargoPoints: 25000, Workers: 0.05, recipe: { 10: 120 } }
  const AUTO = { PlanetaryInstallationID: 12, Name: 'Automated Mine', Cost: 240, CargoPoints: 25000, Workers: 0, recipe: { 10: 240 } }
  const req = (type = MINE, quantity = 10) => m['mine-bootstrap'].mineRequirements(type, quantity)
  const local = (over = {}) => ({ requirement: req(), capacity: { now: cap(1200), full: cap(1200) }, usage: undefined, colony: { Efficiency: 1 }, workers: { now: split(100), later: split(100), cost: 0 }, stock: { 10: 5000 }, ...over })
  const T = { PopulationID: 1, PopName: 'Target', SystemID: 10, Xcor: 0, Ycor: 0, ShuttleCapacity: 1, ServiceNames: 'Spaceport' }
  const B1 = { colony: { PopulationID: 2, PopName: 'Builder', SystemID: 10, Xcor: 3e6, Ycor: 4e6, ShuttleCapacity: 1, ServiceNames: 'Spaceport' }, rate: cap(600), stock: { 10: 5000 } }
  const B2 = { colony: { PopulationID: 3, PopName: 'Far', SystemID: 11, Xcor: 0, Ycor: 0, ShuttleCapacity: 1, ServiceNames: 'Spaceport' }, rate: cap(3000), stock: { 10: 5000 } }
  const B3 = { colony: { PopulationID: 4, PopName: 'Idle', SystemID: 10, Xcor: 1e6, Ycor: 0, ShuttleCapacity: 1, ServiceNames: 'Spaceport' }, rate: cap(0), stock: { 10: 5000 } }
  const FREIGHTER = { ShipClassID: 1, ClassName: 'Hauler', CargoCapacity: 100000, ColonistCapacity: 0, MaxSpeed: 1000, FuelPerHour: 100, Size: 20, MilitaryEngines: 0, Drive: 0, AnyDrive: 0, ShuttleStrength: 1, ClassCrew: 10, EnginePower: 100, FuelEfficiency: 1, FuelCapacity: 1e12, Ships: 2 }
  const options = (requirement = req()) => m['mine-bootstrap'].builderOptions({ requirement, target: T, builders: [B3, B2, B1], jumpPoints: [] })
  const importing = (over = {}) => ({ builder: options()[0], freighters: [FREIGHTER], shuttleTechnology: 1, version: '2.7.x', workers: { now: split(249.9), later: split(249.9), cost: 0 }, ...over })
  const runImport = (over = {}, requirement = req()) => m['mine-bootstrap'].importRoute({ requirement, target: T, ...importing(over) })
  const form = (id, over = {}) => ({ FormationID: id, Name: `F${id}`, PopulationID: 1, ShipID: 0, ParentFormationID: 0, ownSize: 5000, hq: 6000, rating: 0, commander: null, ...over })
  const power = (formations, population = 1) => m['mine-bootstrap'].engineerPower(formations, population)
  const FACTOR = { ConstructionProduction: 12, EngineerProductionModifier: 0.5 }
  const groundFormations = () => [
    form(1, { PopulationID: 5, rating: 10, commander: { bonus: 1.2 } }),
    form(2, { PopulationID: 5, rating: 4, commander: { bonus: 1.5 }, ownSize: 7000 }),
    form(3, { PopulationID: 0, ShipID: 9, rating: 3, commander: { bonus: 1.3 } }),
    form(4, { PopulationID: 1, rating: 2, commander: { bonus: 1.1 } }),
  ]
  const ground = (over = {}) => ({ requirement: req(), target: T, ground: { gaps: [], formations: groundFormations() }, factor: FACTOR, capacity: cap(1000), usage: undefined, version: '2.7.x', troopCapacity: { lift: 16000, ships: 2, classes: [{ TroopCapacity: 8000, Ships: 2 }] }, ...over })
  const runGround = (over = {}) => m['mine-bootstrap'].groundRoute(ground(over))

  return { cap, split, MINE, AUTO, req, local, T, B1, B2, B3, FREIGHTER, options, importing, runImport, form, power, FACTOR, groundFormations, ground, runGround }
}

// `carryFormations` on inputs that once made it loop forever (a formation of no tonnage with no bay to hold it). A loop cannot be judged in the process that makes the checks, so a child of its own (`--carry-probe`, with the mutant's source when a fault is planted) answers every case, under a time limit; a child that does not answer in time fails the check by an assertion (the loop is the defect the check is for). A child that ends any other way (a nonzero exit, a crash of the subject or of the load, no answer, an answer of another shape) is a HarnessError, which stops the run: a crash is never credit for a planted fault.
const CARRY_PROBE = 'CARRY-PROBE '
const CARRY_LIMIT = 30000
const CARRY_CASES = [
  { name: 'no bay: every formation of known tonnage is held by none (a tonnage of 0 or below included) and an unknown one is unsized', classes: [], masses: [[1, 0], [2, 5000], [3, null], [4, -3]], expected: { carried: [], later: [], lifts: 0, oversize: [2, 1, 4], unsized: [3] } },
  { name: 'classes with no ship are no bay', classes: [{ TroopCapacity: 8000, Ships: 0 }], masses: [[1, 0], [2, 100]], expected: { carried: [], later: [], lifts: 0, oversize: [2, 1], unsized: [] } },
  { name: 'classes of unknown capacity are no bay', classes: [{ TroopCapacity: null, Ships: 2 }], masses: [[1, 0]], expected: { carried: [], later: [], lifts: 0, oversize: [1], unsized: [] } },
  { name: 'a bay of negative capacity holds no formation, a tonnage of 0 included', classes: [{ TroopCapacity: -5, Ships: 1 }], masses: [[1, 0]], expected: { carried: [], later: [], lifts: 0, oversize: [1], unsized: [] } },
  { name: 'only formations of unknown tonnage and no bay', classes: [], masses: [[1, null]], expected: { carried: [], later: [], lifts: 0, oversize: [], unsized: [1] } },
  { name: 'no formation and no bay', classes: [], masses: [], expected: { carried: [], later: [], lifts: 0, oversize: [], unsized: [] } },
  { name: 'a bay holds a formation of no tonnage beside a full one, and an unknown one is unsized', classes: [{ TroopCapacity: 8000, Ships: 1 }], masses: [[1, 0], [2, 8000], [3, null]], expected: { carried: [2, 1], later: [], lifts: 1, oversize: [], unsized: [3] } },
  { name: 'a bay of capacity 0 holds a formation of no tonnage and no other', classes: [{ TroopCapacity: 0, Ships: 1 }], masses: [[1, 0], [2, 1]], expected: { carried: [1], later: [], lifts: 1, oversize: [2], unsized: [] } },
]

// The child of the carry probe: the answers of the real source or of the mutant named by CARRY_MUTANT. CARRY_CONTROL breaks the child on purpose for the control `carriage-harness`: `startup` (it fails before loading), `subject` (the subject throws), `silent` (it ends without an answer), `malformed` (an answer that is not JSON), `shape` (an answer of the wrong shape) or a kind of record in the right number of answers: `nulls`, `empty` (no fields), `partial` (a field missing), `text` (a list that is text), `ids` (a list that holds other than ids) or `lifts` (a lift count that is not a number).
const carryProbe = async () => {
  const control = process.env.CARRY_CONTROL

  if (control === 'startup') {
    throw new Error('the carry probe failed to start')
  }

  const mutant = MUTANTS.find(({ id }) => id === process.env.CARRY_MUTANT)
  const real = mutant && mutant.file === U ? patched(U, textOf(U), mutant.find, mutant.replace) : textOf(U)
  const source = control === 'subject' ? patched(U, real, 'const biggest = Math.max(...bays)', 'throw new Error(\'a planted throw of the subject\')') : real
  const { 'mine-bootstrap': mb } = await loadUtilities(['mine-bootstrap'], { stubs: STUBS, sources: { 'mine-bootstrap': source } })
  const ids = (items) => items.map((item) => item.formation.FormationID)

  const answers = CARRY_CASES.map(({ classes, masses }) => {
    const planned = mb.carryFormations(masses.map(([id, size]) => ({ formation: { FormationID: id, ownSize: size }, bp: 1 })), { classes })

    return { carried: ids(planned.carried), later: ids(planned.later), lifts: planned.lifts, oversize: ids(planned.oversize), unsized: ids(planned.unsized) }
  })

  if (control === 'silent') {
    process.exit(0)
  }

  const records = (change) => answers.map((record) => change(record))
  const wrong = { shape: {}, nulls: records(() => null), empty: records(() => ({})), partial: records((record) => ({ carried: record.carried, later: record.later, oversize: record.oversize, lifts: record.lifts })), text: records((record) => ({ ...record, carried: 'none' })), ids: records((record) => ({ ...record, unsized: [null] })), lifts: records((record) => ({ ...record, lifts: '1' })) }

  console.log(control === 'malformed' ? `${CARRY_PROBE}{not json` : `${CARRY_PROBE}${JSON.stringify(wrong[control] || answers)}`)
  process.exit(0)
}

// The answers of the child, one per case. A child past its limit is the loop: an assertion. Any other way the child fails to answer, a launcher that throws or rejects included, is the harness's own failure (HarnessError). `launch` is the launcher of the child (the controls of `carriage-harness` give a broken one).
const carryAnswers = async (mutant, control = '', launch = runChild) => {
  let ended

  try {
    ended = await launch(__filename, ['--carry-probe'], { env: { CARRY_MUTANT: mutant || '', CARRY_CONTROL: control }, limit: CARRY_LIMIT })
  } catch (error) {
    throw new HarnessError(`the carry probe could not be started: ${error && error.message}`)
  }

  const { code, stdout, stderr, timedOut } = ended

  assert.equal(timedOut, false, `carryFormations did not return in ${CARRY_LIMIT / 1000} s`)

  const unfit = (why) => new HarnessError(`the carry probe ${why} (status ${code}): ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
  const line = stdout.split('\n').find((row) => row.startsWith(CARRY_PROBE))
  let answers

  if (code !== 0) {
    throw unfit('ended with a nonzero status')
  }

  if (!line) {
    throw unfit('printed no answers')
  }

  try {
    answers = JSON.parse(line.slice(CARRY_PROBE.length))
  } catch (error) {
    throw unfit('printed an answer that is not JSON')
  }

  if (!Array.isArray(answers) || answers.length !== CARRY_CASES.length) {
    throw unfit('printed an answer of the wrong shape')
  }

  const ids = (value) => Array.isArray(value) && value.every((id) => Number.isInteger(id))
  const bad = answers.findIndex((record) => !(record && typeof record === 'object' && ['carried', 'later', 'oversize', 'unsized'].every((field) => ids(record[field])) && Number.isFinite(record.lifts)))

  if (bad >= 0) {
    throw unfit(`printed a record of the wrong shape for the case ${bad} (${CARRY_CASES[bad].name})`)
  }

  return answers
}

const pure = (ctx) => {
  const { m } = ctx
  const f = fixtures(m)
  const { cap, split, MINE, AUTO, req, local, T, B1, FREIGHTER, runImport, form, power, groundFormations, runGround } = f
  const mb = m['mine-bootstrap']
  const { provenance } = m
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const runLocal = (over = {}) => mb.localRoute(local(over))

  add('rules: the four rules are registered for 2.7.x with the kind of check each is', () => {
    const expected = { 'mineBootstrap.requirements': 'confirmed', 'mineBootstrap.localBuild': 'estimated', 'mineBootstrap.import': 'estimated', 'mineBootstrap.groundAssistance': 'estimated' }
    const bad = Object.entries(expected).filter(([id, verification]) => { const rule = provenance.getRule(id); return !rule || rule.verification !== verification || !rule.versions.includes('2.7.x') }).map(([id]) => id)

    assert.deepEqual(bad, [])

    return true
  })

  // ----- what a number of mines takes -----
  add('requirements: ten manned mines cost 1200 BP, weigh 250000 t, need 0.5 M workers and 1200 t of Corundium', () => {
    const r = req()

    assert.equal(r.manned, true)
    near(r.bp.value, 1200)
    near(r.tonnes.value, 250000)
    near(r.workers.value, 0.5)
    assert.deepEqual(r.recipe, [{ id: 10, name: 'Corundium', tonnes: 1200 }])
    assert.equal(r.bp.status, 'confirmed')

    return true
  })
  add('requirements: automated mines need no workers and are not manned', () => {
    const r = req(AUTO)

    assert.equal(r.manned, false)
    near(r.workers.value, 0)
    near(r.bp.value, 2400)

    return true
  })
  add('requirements: a type with no cost, no workers or an invalid number is unavailable and names what is missing, never 0', () => {
    const noCost = req({ ...MINE, Cost: null })
    const noWorkers = req({ ...MINE, Workers: null })
    const noNumber = req(MINE, null)

    assert.equal(noCost.bp.status, 'unavailable')
    assert.ok(noCost.bp.inputs.missing.some((text) => text.includes('build cost')))
    assert.equal(noWorkers.manned, null)
    assert.equal(noWorkers.workers.status, 'unavailable')
    assert.ok(noNumber.bp.inputs.missing.includes('a number of mines'))
    assert.equal(noNumber.recipe, null)

    return true
  })

  // ----- route 2: the colony's own industry -----
  add('local: a fully staffed colony builds the mines in a year of its idle capacity and the route works', () => {
    const route = runLocal()

    assert.equal(route.status, 'works')
    near(route.figures.rate.value, 1200)
    near(route.figures.days.value, 365)
    near(route.figures.freeAfterNow, 149.5, 1e-6)
    assert.deepEqual(route.limits, [])
    assert.ok(route.worksNow[0].includes('365 days'))

    return true
  })
  add('local: an understaffed colony cannot receive its full capacity: the route is limited and the lost capacity is named', () => {
    const route = runLocal({ workers: { now: split(300), later: split(300), cost: 0 }, colony: { Efficiency: 250 / 300 }, capacity: { now: cap(1000), full: cap(1200) } })

    assert.equal(route.status, 'limited')
    near(route.figures.rate.value, 1000)
    near(route.figures.full.value, 1200)
    near(route.figures.lostBP, 200)
    near(route.figures.days.value, 438)
    assert.ok(route.limits[0].includes('Full local production is not possible'))
    assert.ok(route.limits[0].includes('short of workers'))

    return true
  })
  add('local: the build runs at the idle share only, so projects holding 40% leave 720 BP/yr and 608 days', () => {
    const route = runLocal({ usage: { used: 40, missing: [] } })

    near(route.figures.rate.value, 720)
    near(route.figures.days.value, 608.3333333333334)
    assert.equal(route.status, 'works')

    return true
  })
  add('local: a colony at an efficiency of 0 makes no construction and the route is blocked with its reason', () => {
    const route = runLocal({ capacity: { now: cap(0), full: null }, colony: { Efficiency: 0 } })

    assert.equal(route.status, 'blocked')
    assert.ok(route.limits[0].includes('efficiency of 0'))
    assert.deepEqual(route.worksNow, [])

    return true
  })
  add('local: a colony whose projects hold all its capacity has nothing to build with and is blocked', () => {
    const route = runLocal({ usage: { used: 100, missing: [] } })

    assert.equal(route.status, 'blocked')
    assert.ok(route.limits[0].includes('idle construction capacity'))

    return true
  })
  add('local: a share the save does not give leaves the route unavailable, naming the input', () => {
    const route = runLocal({ usage: { used: 0, missing: ['the production type of the project Retool'] } })

    assert.equal(route.status, 'unavailable')
    assert.ok(route.missing.some((text) => text.includes('Retool')))

    return true
  })
  add('local: manned mines that leave the colony short of workers once built limit the route and name the efficiency they leave', () => {
    const route = runLocal({ workers: { now: split(249.8), later: split(249.8), cost: 0 } })

    assert.equal(route.status, 'limited')
    near(route.figures.freeAfterNow, -0.3, 1e-6)
    near(route.figures.efficiencyAfter, 250 / 250.3, 1e-6)
    assert.ok(route.limits.some((text) => text.includes('manned mines need')))

    return true
  })
  add('local: the same colony builds automated mines without a labour limit', () => {
    const route = runLocal({ requirement: req(AUTO), workers: { now: split(249.8), later: split(249.8), cost: 0 } })

    assert.equal(route.status, 'works')
    near(route.figures.freeAfterNow, 0.2, 1e-6)

    return true
  })
  add('local: a mineral the stock lacks limits the route and is named with its shortfall; a stock not read is a missing input, not a zero', () => {
    const short = runLocal({ stock: { 10: 500 } })
    const unread = runLocal({ stock: null })
    const absent = runLocal({ stock: {} })

    assert.equal(short.status, 'limited')
    assert.deepEqual(short.figures.shortMinerals.map((item) => [item.name, item.short]), [['Corundium', 700]])
    assert.equal(unread.status, 'works')
    assert.ok(unread.missing.includes('the colony\'s mineral stock'))
    assert.ok(absent.missing.includes('the stock of Corundium'))
    assert.equal(absent.status, 'works')

    return true
  })
  add('local: an input missing (the build cost, the capacity, the colony cost of manned mines) leaves the figure unavailable and the route says so', () => {
    const noCost = runLocal({ requirement: req({ ...MINE, Cost: null }) })
    const noCapacity = runLocal({ capacity: { now: provenance.unavailable({ rule: 'mineBootstrap.localBuild', missing: ['the colony\'s production modifiers'] }), full: null } })
    const noColonyCost = runLocal({ workers: { now: split(100), later: split(100), cost: null } })

    assert.equal(noCost.status, 'unavailable')
    assert.ok(noCost.missing.some((text) => text.includes('build cost')))
    assert.equal(noCapacity.status, 'unavailable')
    assert.ok(noCapacity.missing.includes('the colony\'s production modifiers'))
    assert.ok(noColonyCost.missing.includes('the colony\'s workers and colony cost'))

    return true
  })
  add('local-full: the full capacity takes the saved efficiency out of the overall modifier, and is not known at an efficiency of 0 or unknown', () => {
    const modifiers = { ConstructionProduction: 10, OverallProductionModifier: 50, ConstructionPower: 4, EngineerProductionModifier: 1, GroundConstructionPower: 0 }
    const full = mb.fullStaffModifiers(modifiers, 0.5)

    near(full.OverallProductionModifier, 100)
    assert.equal(full.ConstructionProduction, 10)
    assert.equal(mb.fullStaffModifiers(modifiers, 0), null)
    assert.equal(mb.fullStaffModifiers(modifiers, null), null)
    assert.equal(mb.fullStaffModifiers(undefined, 0.5), null)

    return true
  })

  // ----- route 1: import -----
  add('import: the builder with a route and a build time comes first, then one with no route, and a builder with no capacity last', () => {
    const [first, second, third] = f.options()

    assert.deepEqual([first.colony.PopName, second.colony.PopName, third.colony.PopName], ['Builder', 'Far', 'Idle'])
    near(first.route.km, 5e6)
    assert.equal(first.route.jumps, 0)
    near(first.buildDays, 730)
    assert.equal(second.route, null)
    assert.equal(third.buildDays, null)

    return true
  })
  add('import: ten manned mines weigh 250000 t, one lift of the two freighters is 200000 t, so 50000 t is a freight deficit and the haul takes 2 trips', () => {
    const route = runImport()
    const best = route.figures.best

    assert.equal(best.estimate.holds, 3)
    assert.equal(best.trips, 2)
    near(best.lift, 200000)
    near(route.figures.freightDeficit, 50000)
    near(route.figures.tonnes.value, 250000)
    assert.ok(route.limits.some((text) => text.includes('Freight deficit: 50000 t')))
    assert.equal(route.status, 'limited')

    return true
  })
  add('import: the manned mines need 0.5 M workers at a colony with 0.1 M free: a labour deficit of 0.4 M', () => {
    const route = runImport()

    near(route.figures.labour.needed, 0.5)
    near(route.figures.labour.deficitNow, 0.4, 1e-6)
    near(route.figures.labour.deficitLater, 0.4, 1e-6)
    assert.ok(route.limits.some((text) => text.startsWith('Labour deficit')))

    return true
  })
  add('import: automated mines show no labour deficit while their freight deficit stays', () => {
    const route = runImport({ workers: { now: split(249.9), later: split(249.9), cost: 0 } }, req(AUTO))

    near(route.figures.labour.needed, 0)
    near(route.figures.labour.deficitNow, 0)
    assert.ok(!route.limits.some((text) => text.startsWith('Labour deficit')))
    near(route.figures.freightDeficit, 50000)

    return true
  })
  add('import: one mine fits one lift with the workers free: nothing is short and the route works', () => {
    const route = runImport({}, req(MINE, 1))

    assert.equal(route.status, 'works')
    assert.equal(route.figures.trips, 1)
    near(route.figures.freightDeficit, 0)
    near(route.figures.labour.deficitNow, 0)
    assert.deepEqual(route.limits, [])
    assert.ok(route.worksNow[0].includes('Builder builds the mines'))

    return true
  })
  add('import: the total is the build days at the builder plus the haul days of the class', () => {
    const route = runImport()

    near(route.figures.totalDays, 730 + route.figures.best.estimate.classDays)
    near(route.figures.haulDays, Math.ceil(3 / 2) * route.figures.tripDays)

    return true
  })
  add('import: with no freighter the whole tonnage is the freight deficit and the route is blocked', () => {
    const route = runImport({ freighters: [] })

    assert.equal(route.status, 'blocked')
    near(route.figures.freightDeficit, 250000)
    assert.ok(route.limits[0].includes('No freighter'))
    assert.equal(route.figures.best, null)

    return true
  })
  add('import: a class that cannot move (no speed) or a colony without a charted route or a builder blocks the route', () => {
    const immobile = runImport({ freighters: [{ ...FREIGHTER, MaxSpeed: 0 }] })
    const unreachable = runImport({ builder: f.options().find((option) => option.colony.PopName === 'Far') })
    const none = runImport({ builder: null })
    const idle = runImport({ builder: f.options().find((option) => option.colony.PopName === 'Idle') })

    assert.equal(immobile.status, 'blocked')
    assert.equal(unreachable.status, 'blocked')
    assert.ok(unreachable.limits[0].includes('no charted route'))
    assert.equal(none.status, 'blocked')
    assert.equal(idle.status, 'blocked')
    assert.ok(idle.limits[0].includes('no idle construction capacity'))

    return true
  })
  add('import: a colony without a spaceport that a large ship cannot land at blocks the route and names the handling problem', () => {
    const route = runImport({ builder: { ...f.options()[0], colony: { ...B1.colony, ShuttleCapacity: 0 } }, freighters: [{ ...FREIGHTER, ShuttleStrength: 0 }] })

    assert.equal(route.status, 'blocked')
    assert.ok(route.limits[0].includes('No freighter class can run the haul'))

    return true
  })
  add('import: a builder short of a mineral limits the route, and the standing gaps are always listed as missing', () => {
    const route = runImport({ builder: { ...f.options()[0], stock: { 10: 100 } } })

    assert.ok(route.limits.some((text) => text.includes('Corundium by 1100 t')))
    assert.ok(route.missing.includes('Mines already installed at other colonies are not counted.'))
    assert.ok(route.missing.includes('Whether the freighters are free is not read.'))

    return true
  })
  add('import: a missing tonnage or cost leaves the route unavailable and names the input', () => {
    const route = runImport({}, req({ ...MINE, CargoPoints: null }))

    assert.equal(route.status, 'unavailable')
    assert.ok(route.missing.some((text) => text.includes('cargo points')))

    return true
  })
  add('haul: a haul of installations counts one cargo point to the tonne and a haul of minerals two, and the default is minerals', () => {
    const haul = { tonnes: 100000, km: 1e6, from: B1.colony, to: T }
    const installations = m['haul-plan'].haulByClass(haul, FREIGHTER, 1, '2.7.x', 'installations')
    const minerals = m['haul-plan'].haulByClass(haul, FREIGHTER, 1, '2.7.x', 'minerals')
    const byDefault = m['haul-plan'].haulByClass(haul, FREIGHTER, 1, '2.7.x')

    assert.equal(installations.holds, 1)
    assert.equal(minerals.holds, 2)
    assert.equal(byDefault.holds, 2)

    return true
  })

  // ----- route 3: ground-force assistance -----
  add('ground-command: a commander with a headquarters that holds the formation gives its Production bonus to the rating', () => {
    near(power([form(1, { rating: 10, commander: { bonus: 1.2 } })]).power, 12)
    near(power([form(1, { rating: 10 })]).power, 10)

    return true
  })
  add('ground-command: the headquarters load takes each formation\'s tonnage whole while the saved fraction stays on the formation', () => {
    const fits = form(1, { rating: 10, commander: { bonus: 1.2 }, ownSize: 300.5, hq: 300 })
    const over = form(1, { rating: 10, commander: { bonus: 1.2 }, ownSize: 301.5, hq: 300 })

    near(power([fits]).power, 12)
    near(power([over]).power, 10)
    assert.equal(fits.ownSize, 300.5)

    return true
  })
  add('ground-command: a formation larger than its headquarters capacity gets no bonus (capacity modifier 0)', () => {
    near(power([form(1, { rating: 10, commander: { bonus: 1.2 }, ownSize: 7000 })]).power, 10)

    return true
  })
  add('ground-command: the capacity counts the formation and every subordinate, wherever they stand', () => {
    const C = form(1, { rating: 10, commander: { bonus: 1.2 }, ownSize: 200, hq: 300 })
    const X = form(9, { PopulationID: 77, ParentFormationID: 1, ownSize: 200 })

    near(power([C]).power, 12)
    near(power([C, X]).power, 10)

    return true
  })
  add('ground-command: a parent at the same colony with a commander adds a quarter of its bonus excess, once its own headquarters holds the tree', () => {
    const P = form(2, { commander: { bonus: 1.4 }, ownSize: 100, hq: 1000 })
    const C = form(1, { rating: 10, commander: { bonus: 1.2 }, ownSize: 200, hq: 300, ParentFormationID: 2 })

    near(power([C, P]).power, 10 * 1.2 * 1.1)

    return true
  })
  add('ground-command: the chain goes on up through each parent at the colony', () => {
    const G = form(3, { commander: { bonus: 1.8 }, ownSize: 100, hq: 10000 })
    const P = form(2, { commander: { bonus: 1.4 }, ownSize: 100, hq: 1000, ParentFormationID: 3 })
    const C = form(1, { rating: 10, commander: { bonus: 1.2 }, ownSize: 200, hq: 300, ParentFormationID: 2 })

    near(power([C, P, G]).power, 10 * 1.2 * 1.1 * 1.2)

    return true
  })
  add('ground-command: a parent elsewhere, without a commander, or whose headquarters does not hold its tree adds nothing', () => {
    const C = form(1, { rating: 10, commander: { bonus: 1.2 }, ownSize: 200, hq: 300, ParentFormationID: 2 })
    const parent = (over) => form(2, { commander: { bonus: 1.4 }, ownSize: 100, hq: 1000, ...over })

    near(power([C, parent({ PopulationID: 2 })]).power, 12)
    near(power([C, parent({ commander: null })]).power, 12)
    near(power([C, parent({ hq: 250 })]).power, 12)
    near(power([C, parent({ PopulationID: 0, ShipID: 4 })]).power, 12)

    return true
  })
  add('ground-command: a subordinate with a commander of an over-full parent chain still counts the lower links that hold', () => {
    const P = form(2, { commander: { bonus: 1.4 }, ownSize: 100, hq: 1000 })
    const C = form(1, { rating: 10, commander: { bonus: 1.2 }, ownSize: 200, hq: 300, ParentFormationID: 2 })
    const X = form(9, { ParentFormationID: 1, ownSize: 200 })

    near(power([C, P, X]).power, 10 * 1 * 1.1)

    return true
  })
  add('ground-command: a bonus or a size that is not known leaves the formation unknown and out of the power; a cycle of parents ends', () => {
    const unknownBonus = power([form(1, { rating: 10, commander: { bonus: null } }), form(2, { rating: 2 })])
    const unknownRating = power([form(1, { rating: null })])
    const cycle = power([form(1, { rating: 10, commander: { bonus: 1.2 }, ParentFormationID: 2 }), form(2, { commander: { bonus: 1.2 }, ParentFormationID: 1 })])

    assert.deepEqual(unknownBonus.unknown.map((formation) => formation.FormationID), [1])
    near(unknownBonus.power, 2)
    assert.equal(unknownRating.unknown.length, 1)
    assert.equal(cycle.unknown.length, 1)

    return true
  })
  add('ground-command: formations aboard ships and formations without construction rating add nothing', () => {
    near(power([form(1, { PopulationID: 0, ShipID: 3, rating: 10 }), form(4, { PopulationID: 1, ShipID: 3, rating: 10 }), form(2, { rating: 0 }), form(3, { rating: 1 })]).power, 1)

    return true
  })
  add('ground: engineers at other colonies add rating x commander multiplier x the race rate x the engineer modifier; those at the colony are counted apart', () => {
    const route = runGround()
    const figures = route.figures

    assert.equal(figures.candidates.length, 2)
    near(figures.added, (12 + 4) * 12 * 0.5)
    near(figures.present, 2.2 * 12 * 0.5)
    near(figures.rateNow, 1000)
    near(figures.rateWith, 1096)
    near(figures.daysNow, 438)
    near(figures.daysWith, (1200 / 1096) * 365)
    assert.equal(figures.aboard.length, 1)
    assert.equal(route.status, 'limited')
    assert.equal(runGround({ ground: { gaps: [], formations: [...groundFormations(), f.form(6, { PopulationID: 5, ShipID: 9, rating: 7 })] } }).figures.candidates.length, 2)

    return true
  })
  add('ground: the engineers\' contribution follows the race rate, not a fixed total: half the rate gives half the points', () => {
    const half = runGround({ factor: { ConstructionProduction: 6, EngineerProductionModifier: 0.5 } })

    near(half.figures.added, 48)

    return true
  })
  add('ground: the route is limited with the upper-bound caveat, the unmodelled move and the missing inputs, and names the ships aboard', () => {
    const route = runGround()

    assert.ok(route.limits.some((text) => text.includes('upper bound')))
    assert.ok(route.limits.some((text) => text.includes('not modelled')))
    assert.ok(route.limits.some((text) => text.includes('aboard ships')))
    assert.ok(route.missing.some((text) => text.includes('fortification')))
    assert.ok(route.worksNow.length > 0)

    return true
  })
  add('ground: without engineers elsewhere, without troop lift or with the colony\'s capacity all held the route is blocked', () => {
    const none = runGround({ ground: { gaps: [], formations: [f.form(4, { rating: 2 })] } })
    const lift = runGround({ troopCapacity: { lift: 0, ships: 0, classes: [] } })
    const busy = runGround({ usage: { used: 100, missing: [] } })

    assert.equal(none.status, 'blocked')
    assert.equal(lift.status, 'blocked')
    assert.ok(lift.limits.some((text) => text.includes('no troop ship')))
    assert.equal(busy.status, 'blocked')

    return true
  })
  add('ground-unavailable: a version the rules are not mapped for, or not known, makes the route unavailable with the reason', () => {
    const old = runGround({ version: '2.6.5' })
    const unknown = runGround({ version: null })

    assert.equal(old.status, 'unavailable')
    assert.ok(old.limits[0].includes('mapped for 2.7 saves only'))
    assert.equal(unknown.status, 'unavailable')
    assert.ok(unknown.limits[0].includes('not known'))
    assert.deepEqual(old.figures, {})

    return true
  })
  add('ground-unavailable: a save without the formation columns or the race rate makes the route unavailable and names them', () => {
    const gap = runGround({ ground: { gaps: ['FCT_GroundUnitClass.ConstructionRating'], formations: [] } })
    const noFactor = runGround({ factor: { ConstructionProduction: 12, EngineerProductionModifier: null } })

    assert.equal(gap.status, 'unavailable')
    assert.ok(gap.limits[0].includes('FCT_GroundUnitClass.ConstructionRating'))
    assert.equal(noFactor.status, 'unavailable')
    assert.ok(noFactor.missing.some((text) => text.includes('race construction rate')))

    return true
  })
  add('ground-unavailable: a null rating, size, headquarters capacity or commander bonus at any candidate makes the route unavailable', () => {
    const formations = (over) => [f.form(1, { PopulationID: 5, rating: 10, commander: { bonus: 1.2 }, ...over })]
    const rating = runGround({ ground: { gaps: [], formations: formations({ rating: null }) } })
    const bonus = runGround({ ground: { gaps: [], formations: formations({ commander: { bonus: null } }) } })
    const size = runGround({ ground: { gaps: [], formations: formations({ ownSize: null }) } })
    const hq = runGround({ ground: { gaps: [], formations: formations({ hq: null }) } })

    ;[rating, bonus, size, hq].forEach((route) => {
      assert.equal(route.status, 'unavailable')
      assert.ok(route.limits[0].includes('null for F1'))
    })

    return true
  })

  // ----- the review fixes -----
  const jumpPoint = (id, link, system, gate, x = 1e6) => ({ WarpPointID: id, SystemID: system, WPLink: link, Distance: 1, Xcor: x, Ycor: 0, JumpGateStrength: gate, Explored: 1, MilitaryRestricted: 0, IgnoreForDistance: 0 })
  const farOver = (jumpPoints) => mb.builderOptions({ requirement: req(), target: T, builders: [f.B2], jumpPoints }).find((option) => option.colony.PopName === 'Far')
  const ungatedRoute = { jumps: 1, km: 5e6, ungated: 1 }
  const viaRoute = (freighters, route = ungatedRoute, gatedRoute = null, requirement = req(MINE, 1)) => runImport({ builder: { ...f.options()[0], route, gatedRoute }, freighters }, requirement)
  const MAPPING = { ConstructionProduction: 12, OverallProductionModifier: 50, ConstructionPower: 4, EngineerProductionModifier: 0.5, GroundConstructionPower: 99 }
  const candidate = (id, size) => ({ formation: { FormationID: id, Name: `F${id}`, ownSize: size }, bp: size })
  const short = { now: split(300), later: split(300), cost: 0 }

  add('import-transit: the jump points on the route that are not stabilised on both sides are counted, and a route over stabilised ones alone is kept apart', () => {
    const open = farOver([jumpPoint(1, 2, 10, 0), jumpPoint(2, 1, 11, 0)])
    const gated = farOver([jumpPoint(1, 2, 10, 1), jumpPoint(2, 1, 11, 1)])
    const half = farOver([jumpPoint(1, 2, 10, 1), jumpPoint(2, 1, 11, 0)])
    const both = farOver([jumpPoint(1, 2, 10, 0), jumpPoint(2, 1, 11, 0), jumpPoint(3, 4, 10, 1, 9e6), jumpPoint(4, 3, 11, 1, 9e6)])

    assert.deepEqual([open.route.jumps, open.route.ungated], [1, 1])
    assert.equal(open.gatedRoute, null)
    assert.equal(gated.route.ungated, 0)
    assert.ok(gated.gatedRoute)
    assert.equal(half.route.ungated, 1)
    assert.equal(half.gatedRoute, null)
    assert.equal(both.route.ungated, 1)
    assert.equal(both.gatedRoute.ungated, 0)
    assert.ok(both.gatedRoute.km > both.route.km)

    return true
  })
  add('import-transit: a class whose jump drives cover its size crosses an unstabilised jump point; one that does not needs a tender, so the route is limited and says what is missing, never working', () => {
    const jumper = viaRoute([{ ...FREIGHTER, Drive: 20, AnyDrive: 20 }])
    const bare = viaRoute([FREIGHTER])
    const small = viaRoute([{ ...FREIGHTER, Drive: 10, AnyDrive: 10 }])
    const unknown = viaRoute([{ ...FREIGHTER, Drive: null, AnyDrive: null }])
    const mixed = viaRoute([FREIGHTER, { ...FREIGHTER, ShipClassID: 2, ClassName: 'Jumper', Drive: 20, AnyDrive: 20, Ships: 1 }])

    assert.equal(jumper.status, 'works')
    assert.equal(jumper.figures.best.transit.tender, 'none')
    ;[bare, small].forEach((route) => {
      assert.equal(route.status, 'limited')
      assert.equal(route.figures.best.transit.tender, 'required')
      assert.ok(route.limits.some((text) => text.startsWith('Jump tender needed')))
      assert.ok(route.missing.some((text) => text.includes('jump-capable tender')))
      assert.ok(!route.worksNow.some((text) => !text.includes('if a tender takes it through') && text.includes('carries them')))
    })
    assert.equal(unknown.status, 'limited')
    assert.equal(unknown.figures.best.transit.tender, 'unknown')
    assert.ok(unknown.missing.includes('The jump drives of the freighter classes'))
    assert.equal(mixed.figures.best.shipClass.ClassName, 'Jumper')
    assert.equal(mixed.status, 'works')

    return true
  })
  add('import-transit: a class with no jump drive takes the route over stabilised jump points when there is one, which is longer, and no tender is needed', () => {
    const detour = viaRoute([FREIGHTER], ungatedRoute, { jumps: 2, km: 9e6, ungated: 0 })
    const direct = viaRoute([{ ...FREIGHTER, Drive: 20, AnyDrive: 20 }])

    assert.equal(detour.status, 'works')
    assert.equal(detour.figures.best.transit.tender, 'none')
    assert.equal(detour.figures.best.transit.detour, true)
    assert.equal(detour.figures.best.transit.km, 9e6)
    assert.ok(detour.figures.haulDays > direct.figures.haulDays)
    assert.ok(detour.worksNow.some((text) => text.includes('stabilised')))
    assert.equal(direct.figures.best.transit.detour, false)

    return true
  })
  add('requirements: a type whose workers the save leaves null is neither manned nor automated, and no route takes it as automated', () => {
    const unknown = req({ ...MINE, Workers: null })
    const routes = [runLocal({ requirement: unknown }), runImport({}, unknown)]

    assert.equal(unknown.manned, null)
    routes.forEach((route) => {
      assert.equal(route.status, 'unavailable')
      assert.ok(route.missing.some((text) => text.includes('the workers of Mine')))
    })
    assert.ok(runGround({ requirement: unknown }).missing.some((text) => text.includes('the workers of Mine')))

    return true
  })
  add('requirements: a type the save does not say it can be built is unavailable in every figure and in every route, naming what is not said', () => {
    const type = { ...MINE, eligibility: ['whether Mine can be built (DIM_PlanetaryInstallation.NoBuild)'] }
    const requirement = req(type)

    ;[requirement.bp, requirement.tonnes, requirement.workers].forEach((result) => {
      assert.equal(result.status, 'unavailable')
      assert.ok(result.inputs.missing.some((text) => text.includes('NoBuild')))
    })
    assert.equal(runLocal({ requirement }).status, 'unavailable')
    assert.equal(runImport({}, requirement).status, 'unavailable')
    assert.ok(runGround({ requirement }).missing.some((text) => text.includes('NoBuild')))

    return true
  })
  add('local: a colony already short of workers does not charge that shortage to automated mines, and manned mines are charged their own need only', () => {
    const auto = runImport({ workers: short }, req(AUTO, 1))
    const manned = runImport({ workers: short }, req(MINE, 1))

    assert.equal(auto.status, 'works')
    near(auto.figures.labour.deficitNow, 0)
    near(auto.figures.labour.deficitLater, 0)
    near(auto.figures.labour.existingNow, 50, 1e-6)
    assert.ok(!auto.limits.some((text) => text.startsWith('Labour deficit')))
    assert.equal(manned.status, 'limited')
    near(manned.figures.labour.deficitNow, 0.05, 1e-6)
    near(manned.figures.labour.existingNow, 50, 1e-6)
    assert.ok(manned.limits.some((text) => text.startsWith('Labour deficit')))
    assert.ok(!runGround({ requirement: req(AUTO), workers: short }).limits.some((text) => text.includes('manned mines')))
    assert.ok(!runLocal({ requirement: req(AUTO), workers: short, colony: { Efficiency: 250 / 300 }, capacity: { now: cap(1000), full: cap(1200) } }).limits.some((text) => text.includes('manned mines')))

    return true
  })
  add('ground-mapped: the engineers at the colony are counted by the mapped command rule in the colony\'s own capacity, so its baseline holds exactly what the route calls present', () => {
    const formations = groundFormations()
    const mapped = mb.withMappedEngineers(MAPPING, { gaps: [], formations }, '2.7.x', 1)
    const over = mb.withMappedEngineers(MAPPING, { gaps: [], formations: [form(8, { PopulationID: 1, rating: 10, commander: { bonus: 1.2 }, ownSize: 7000 })] }, '2.7.x', 1)
    const none = mb.withMappedEngineers(MAPPING, { gaps: [], formations: [] }, '2.7.x', 1)
    const route = runGround({ factor: { ConstructionProduction: 12, EngineerProductionModifier: 0.5 }, ground: { gaps: [], formations } })

    near(mapped.GroundConstructionPower, 2.2)
    assert.equal(MAPPING.GroundConstructionPower, 99)
    assert.equal(mapped.ConstructionPower, 4)
    near(route.figures.present, mapped.GroundConstructionPower * 12 * 0.5)
    near(over.GroundConstructionPower, 10)
    assert.equal(none.GroundConstructionPower, 0)

    return true
  })
  add('ground-mapped: an unmapped version, a save lacking a formation column or a figure of the colony\'s engineers not known leaves the Production page\'s figure standing (null)', () => {
    const ground = { gaps: [], formations: groundFormations() }

    assert.equal(mb.withMappedEngineers(MAPPING, ground, '2.6.5', 1), null)
    assert.equal(mb.withMappedEngineers(MAPPING, ground, null, 1), null)
    assert.equal(mb.withMappedEngineers(MAPPING, { gaps: ['FCT_GroundUnitClass.HQCapacity'], formations: [] }, '2.7.x', 1), null)
    assert.equal(mb.withMappedEngineers(undefined, ground, '2.7.x', 1), null)
    assert.equal(mb.withMappedEngineers(MAPPING, { gaps: [], formations: [form(8, { PopulationID: 1, rating: null })] }, '2.7.x', 1), null)

    return true
  })
  add('ground: what the mines ask of the colony (the workers of manned mines, the minerals of the recipe) limits the engineers\' route as it does the local one, and an unread stock or colony cost is named', () => {
    const limited = runGround({ workers: { now: split(249.8), later: split(249.8), cost: 0 }, stock: { 10: 500 } })
    const free = runGround({ workers: { now: split(100), later: split(100), cost: 0 }, stock: { 10: 5000 } })
    const unread = runGround()

    assert.ok(limited.limits.some((text) => text.includes('manned mines need')))
    assert.ok(limited.limits.some((text) => text.includes('Corundium by 700 t')))
    assert.ok(!free.limits.some((text) => text.includes('manned mines need') || text.includes('stock is short')))
    assert.ok(unread.missing.includes('the colony\'s mineral stock'))
    assert.ok(unread.missing.includes('the colony\'s workers and colony cost'))

    return true
  })
  add('ground-carriage: a formation goes whole into one troop ship, the largest first into the first ship with room; one that fits no bay is apart from one that waits for another lift', () => {
    const some = mb.carryFormations([candidate(1, 5000), candidate(2, 7000), candidate(3, 3000)], { classes: [{ TroopCapacity: 8000, Ships: 1 }, { TroopCapacity: 6000, Ships: 1 }] })
    const packed = mb.carryFormations([candidate(1, 5000), candidate(3, 3000)], { classes: [{ TroopCapacity: 8000, Ships: 1 }] })
    const split3 = mb.carryFormations([candidate(1, 5000), candidate(2, 7000)], { classes: [{ TroopCapacity: 4000, Ships: 3 }] })
    const unsized = mb.carryFormations([candidate(1, null), candidate(2, 100)], { classes: [{ TroopCapacity: 8000, Ships: 1 }] })
    const twice = mb.carryFormations([candidate(1, 5000), candidate(2, 5000)], { classes: [{ TroopCapacity: 5000, Ships: 1 }] })
    const thrice = mb.carryFormations([candidate(1, 5000), candidate(2, 5000), candidate(3, 5000), candidate(4, 9000)], { classes: [{ TroopCapacity: 5000, Ships: 1 }] })
    const ids = (items) => items.map((item) => item.formation.FormationID)

    assert.deepEqual(ids(some.carried), [2, 1])
    assert.deepEqual(ids(some.later), [3])
    assert.equal(some.lifts, 2)
    assert.deepEqual(some.oversize, [])
    assert.equal(packed.carried.length, 2)
    assert.equal(packed.lifts, 1)
    assert.equal(split3.carried.length, 0)
    assert.equal(split3.later.length, 0)
    assert.equal(split3.lifts, 0)
    assert.deepEqual(ids(split3.oversize), [2, 1])
    assert.deepEqual(ids(unsized.unsized), [1])
    assert.deepEqual(ids(unsized.carried), [2])
    assert.deepEqual([ids(twice.carried), ids(twice.later), twice.lifts, twice.oversize.length], [[1], [2], 2, 0])
    assert.deepEqual([thrice.carried.length, thrice.later.length, thrice.lifts, ids(thrice.oversize)], [1, 2, 3, [4]])

    return true
  })
  add('carriage-return: carryFormations returns on a formation of no or unknown tonnage and no bay, a class with no ship, a capacity not known or a negative one, reporting what no bay holds as too large and what has no tonnage as unsized', async () => {
    const answers = await carryAnswers(ctx.mutant)

    CARRY_CASES.forEach((item, index) => assert.deepEqual(answers[index], item.expected, item.name))

    return true
  })
  add('carriage-harness: a probe that fails to start (a launcher that throws or rejects included), a subject that throws, a probe with no answer, a malformed one, one of the wrong shape or one whose records are null, empty, incomplete or of the wrong kind is a HarnessError that stops the run and no result a fault could be credited with', async () => {
    const failure = async (work) => {
      try {
        await work()
      } catch (error) {
        return error
      }

      return null
    }

    for (const control of ['startup', 'subject', 'silent', 'malformed', 'shape', 'nulls', 'empty', 'partial', 'text', 'ids', 'lifts']) {
      const error = await failure(() => carryAnswers(null, control))

      assert.ok(error instanceof HarnessError, `${control}: ${error ? `${error.name}: ${error.message}` : 'the probe returned answers'}`)
    }

    const launchers = {
      'a launcher that throws': () => {
        throw new Error('spawn EPERM: the launcher threw')
      },
      'a launcher that rejects': () => Promise.reject(new Error('spawn EPERM: the launcher rejected')),
    }

    for (const [name, launch] of Object.entries(launchers)) {
      const error = await failure(() => carryAnswers(null, '', launch))

      assert.ok(error instanceof HarnessError, `${name}: ${error ? `${error.name}: ${error.message}` : 'the probe returned answers'}`)
    }

    const compared = async (control, launch) => {
      const answers = await carryAnswers(null, control, launch)

      CARRY_CASES.forEach((item, index) => assert.deepEqual(answers[index], item.expected, item.name))

      return true
    }

    const crashes = { 'a probe that crashes': () => compared('subject'), 'a launcher that throws': () => compared('', launchers['a launcher that throws']), 'a launcher that rejects': () => compared('', launchers['a launcher that rejects']) }

    for (const control of ['nulls', 'empty', 'partial', 'text', 'ids', 'lifts']) {
      crashes[`a probe whose records are ${control}`] = () => compared(control)
    }

    for (const [name, probe] of Object.entries(crashes)) {
      const crash = await failure(() => runStatements([[`carriage-return: ${name}`, probe]]))

      assert.ok(crash instanceof HarnessError, `${name}: a statement whose probe could not answer was given a result that a fault could be credited with`)
    }

    return true
  })
  add('ground-carriage: a troop lift that adds up but cannot carry any formation whole blocks the route and counts no engineers; one that carries some counts only those', () => {
    const none = runGround({ troopCapacity: { lift: 12000, ships: 3, classes: [{ TroopCapacity: 4000, Ships: 3 }] } })
    const some = runGround({ troopCapacity: { lift: 6000, ships: 1, classes: [{ TroopCapacity: 6000, Ships: 1 }] } })
    const all = runGround()

    assert.equal(none.status, 'blocked')
    near(none.figures.added, 0)
    assert.equal(none.figures.carried.length, 0)
    assert.ok(none.limits.some((text) => text.includes('No troop ship can carry an engineer formation whole')))
    assert.equal(some.status, 'limited')
    near(some.figures.added, 72)
    near(some.figures.addedUpper, 96)
    assert.ok(some.limits.some((text) => text.includes('too large for any troop ship') && text.includes('F2')))
    near(all.figures.added, 96)
    near(all.figures.troopNeeded, 12000)

    return true
  })
  add('ground-carriage: formations that exceed one lift but each fit a bay are counted with the further lift they need, not called too large for any troop ship', () => {
    const formations = [form(1, { PopulationID: 5, rating: 10, commander: { bonus: 1.2 } }), form(5, { PopulationID: 5, rating: 10, commander: { bonus: 1.2 } })]
    const route = runGround({ ground: { gaps: [], formations }, troopCapacity: { lift: 5000, ships: 1, classes: [{ TroopCapacity: 5000, Ships: 1 }] } })

    assert.equal(route.status, 'limited')
    near(route.figures.added, 144)
    near(route.figures.addedUpper, 144)
    assert.equal(route.figures.carried.length, 2)
    assert.equal(route.figures.lifts, 2)
    assert.equal(route.figures.oversize.length, 0)
    near(route.figures.troopNeeded, 10000)
    assert.ok(route.limits.some((text) => text.includes('1 engineer formation waits for a further lift')))
    assert.ok(route.limits.some((text) => text.includes('in 2 lifts of the same ships')))
    assert.ok(!route.limits.some((text) => text.includes('too large for any troop ship')))

    return true
  })
  add('import-fuel: a freighter class whose engine power, fuel use or fuel capacity is null or not read leaves the import unavailable naming it, never a zero burn or a range failure', () => {
    const names = { EnginePower: 'the engine power of Hauler', FuelEfficiency: 'the fuel use per engine power of Hauler', FuelCapacity: 'the fuel capacity of Hauler' }
    const spare = { ...FREIGHTER, ShipClassID: 2, ClassName: 'Spare' }

    Object.entries(names).forEach(([column, name]) => {
      ;[null, undefined].forEach((value) => {
        const route = runImport({ freighters: [{ ...FREIGHTER, [column]: value }] }, req(MINE, 1))

        assert.equal(route.status, 'unavailable', column)
        assert.ok(route.missing.includes(name), column)
        assert.ok(route.limits.some((text) => text.includes('cannot be judged')), column)
        assert.ok(!route.limits.some((text) => text.includes('range')), column)
      })

      const mixed = runImport({ freighters: [{ ...FREIGHTER, [column]: null }, spare] }, req(MINE, 1))

      assert.equal(mixed.status, 'works', column)
      assert.equal(mixed.figures.best.shipClass.ClassName, 'Spare', column)
      assert.ok(mixed.missing.includes(name), column)
    })
    assert.equal(runImport({ freighters: [{ ...FREIGHTER, MaxSpeed: 0, EnginePower: null }] }).status, 'blocked')
    assert.ok(!runImport({}, req(MINE, 1)).missing.some((text) => text.includes('fuel')))

    return true
  })
  add('import-capacity: a builder whose idle capacity is not known leaves the import unavailable naming the inputs, while a known zero rate blocks it', () => {
    const builder = f.options()[0]
    const unknown = runImport({ builder: { ...builder, rate: provenance.unavailable({ rule: 'mineBootstrap.localBuild', missing: ['ConstructionProduction', 'the share the running projects hold'], units: 'BP/yr' }), buildDays: null } })
    const absent = runImport({ builder: { ...builder, rate: undefined, buildDays: null } })
    const zero = runImport({ builder: { ...builder, rate: cap(0), buildDays: null } })

    assert.equal(unknown.status, 'unavailable')
    assert.ok(unknown.missing.includes('ConstructionProduction') && unknown.missing.includes('the share the running projects hold'))
    assert.ok(!unknown.limits.some((text) => text.includes('no idle construction capacity')))
    ;['buildDays', 'haulDays', 'totalDays'].forEach((figure) => assert.ok(!provenance.isAvailable(unknown.figures.results[figure]) && unknown.figures.results[figure].inputs.missing.length > 0, figure))
    assert.ok(unknown.figures.results.buildDays.inputs.missing.includes('ConstructionProduction'))
    assert.equal(absent.status, 'unavailable')
    assert.equal(zero.status, 'blocked')
    assert.ok(zero.limits.some((text) => text.includes('no idle construction capacity')))

    return true
  })
  add('import-handling: a freighter class whose cargo shuttle bays are not known, or a colony whose spaceport service is not known, leaves the import unavailable naming what is missing, never a timed haul', () => {
    const builder = f.options()[0]
    const bays = runImport({ freighters: [{ ...FREIGHTER, ShuttleStrength: null }] }, req(MINE, 1))
    const service = runImport({ builder: { ...builder, colony: { ...builder.colony, ShuttleCapacity: null } } }, req(MINE, 1))
    const known = runImport({}, req(MINE, 1))

    assert.equal(bays.status, 'unavailable')
    assert.ok(bays.missing.some((text) => text.includes('cargo shuttle bays')))
    assert.equal(service.status, 'unavailable')
    assert.ok(service.missing.some((text) => text.includes('spaceport or cargo shuttle station')))
    assert.ok(!provenance.isAvailable(bays.figures.results.haulDays))
    assert.notEqual(known.status, 'unavailable')

    return true
  })
  add('results: an import that stops before the haul is timed still gives the hauling, total and freight figures as unavailable results naming what is missing', () => {
    const cases = {
      'no charted route': [runImport({ builder: f.options().find((option) => option.colony.PopName === 'Far') }), 'a charted route from Far'],
      'no idle capacity': [runImport({ builder: f.options().find((option) => option.colony.PopName === 'Idle') }), 'the idle construction capacity of Idle'],
      'unknown fuel': [runImport({ freighters: [{ ...FREIGHTER, EnginePower: null }] }, req(MINE, 1)), 'the engine power of Hauler'],
    }

    Object.entries(cases).forEach(([name, [route, reason]]) => {
      assert.ok(route.figures.builder, name)
      ;['haulDays', 'totalDays', 'freight'].forEach((figure) => {
        const result = route.figures.results[figure]

        if (!(name === 'unknown fuel' && figure === 'freight')) {
          assert.ok(result && !provenance.isAvailable(result), `${name} ${figure}`)
          assert.ok(result.inputs.missing.some((text) => text.includes(reason)), `${name} ${figure} names ${reason}`)
        }
      })
      assert.ok(route.figures.results.buildDays && route.figures.results.labour, name)
    })
    assert.ok(provenance.isAvailable(cases['unknown fuel'][0].figures.results.freight))

    return true
  })
  add('results: every figure a route states is a provenance result, available with its inputs or unavailable naming what is missing', () => {
    const results = (route) => Object.entries(route.figures.results).flatMap(([name, value]) => (value && typeof value.status === 'string' ? [[name, value]] : Object.entries(value).map(([inner, result]) => [`${name}.${inner}`, result])))
    const wanted = { local: ['efficiencyNow', 'efficiencyAfter'], import: ['buildDays', 'haulDays', 'totalDays', 'freight', 'labour.needed', 'labour.deficitNow', 'labour.deficitLater', 'labour.existingNow'], ground: ['added', 'present', 'rateNow', 'rateWith', 'daysNow', 'daysWith', 'troop'] }
    const routes = { local: runLocal(), import: runImport(), ground: runGround() }

    Object.entries(wanted).forEach(([id, names]) => {
      const found = Object.fromEntries(results(routes[id]))

      names.forEach((name) => {
        assert.ok(found[name] && typeof found[name].status === 'string' && 'inputs' in found[name], `${id} ${name}`)
        assert.ok(provenance.isAvailable(found[name]), `${id} ${name} unavailable`)
      })
    })

    const blind = runLocal({ colony: { Efficiency: null } })
    const noCost = runImport({ workers: { now: split(100), later: split(100), cost: null } })

    assert.ok(!provenance.isAvailable(blind.figures.results.efficiencyNow))
    assert.ok(!provenance.isAvailable(noCost.figures.results.labour.deficitNow))
    assert.ok(!provenance.isAvailable(runGround({ troopCapacity: null }).figures.results.troop))

    return true
  })
  add('text: a count of 1 is singular, and the figures in the text are written with the page\'s number format', () => {
    const day = runLocal({ requirement: req(MINE, 1), capacity: { now: cap(43800), full: cap(43800) } })
    const marked = runLocal({ format: (value) => `#${value}` })
    const trip = viaRoute([FREIGHTER], { jumps: 1, km: 5e6, ungated: 0 })
    const engineers = runGround({ ground: { gaps: [], formations: [form(1, { PopulationID: 5, rating: 10, commander: { bonus: 1.2 } })] } })
    const spaced = runImport({ format: (value) => `#${value}` })

    assert.ok(day.worksNow[0].includes('in 1 day at'), day.worksNow[0])
    assert.ok(!day.worksNow[0].includes('1 days'))
    assert.ok(marked.worksNow[0].includes('#365 days at #1200 BP/yr'), marked.worksNow[0])
    assert.ok(trip.worksNow[0].includes('over 1 jump in 1 trip,'), trip.worksNow[0])
    assert.ok(engineers.worksNow.some((text) => text.startsWith('1 engineer formation ')))
    assert.ok(spaced.limits.some((text) => text.includes('#50000 t')), spaced.limits.join('|'))

    return true
  })

  // ----- the comparison -----
  add('compare: the three routes come in the order import, local, ground, each with a status, what works now, its limits and its missing inputs', () => {
    const routes = mb.compareRoutes({ requirement: req(), target: T, local: local(), importing: f.importing(), ground: f.ground() })

    assert.deepEqual(routes.map((route) => route.id), ['import', 'local', 'ground'])
    routes.forEach((route) => {
      assert.ok(STATUSES.includes(route.status), route.status)
      ;['worksNow', 'limits', 'missing'].forEach((key) => assert.ok(Array.isArray(route[key]), `${route.id} ${key}`))
      assert.ok(route.worksNow.length > 0 || route.limits.length > 0, `${route.id} says nothing`)
    })

    return true
  })
  add('compare: a route with an input missing says what is missing, and unmapped ground assistance is unavailable with a reason', () => {
    const routes = mb.compareRoutes({ requirement: req({ ...MINE, Cost: null }), target: T, local: local({ requirement: req({ ...MINE, Cost: null }) }), importing: f.importing(), ground: f.ground({ version: null }) })
    const byId = Object.fromEntries(routes.map((route) => [route.id, route]))

    assert.equal(byId.local.status, 'unavailable')
    assert.ok(byId.local.missing.length > 0)
    assert.equal(byId.import.status, 'unavailable')
    assert.equal(byId.ground.status, 'unavailable')
    assert.ok(byId.ground.limits[0].startsWith('Unavailable:'))

    return true
  })

  return statements
}

// ---------- the reads on a database of their own ----------

const TABLES = {
  DIM_PlanetaryInstallation: ['PlanetaryInstallationID', 'Name', 'Cost', 'CargoPoints', 'Workers', 'MiningProductionValue', 'NoBuild', 'CivilianInstallation', 'RequiredTechID', 'CargoShuttleValue', ...MINERAL_COLUMNS],
  FCT_RaceTech: ['GameID', 'TechID', 'RaceID'],
  FCT_Population: ['PopulationID', 'PopName', 'SystemID', 'SystemBodyID', 'GameID', 'RaceID', ...MINERAL_COLUMNS],
  FCT_SystemBody: ['SystemBodyID', 'Xcor', 'Ycor'],
  FCT_PopulationInstallations: ['GameID', 'PopID', 'PlanetaryInstallationID', 'Amount'],
  FCT_IndustrialProjects: ['PopulationID', 'ProductionType', 'Percentage', 'Queue', 'Pause', 'Description'],
  FCT_ShipClass: ['ShipClassID', 'GameID', 'RaceID', 'ClassName', 'CargoCapacity', 'ColonistCapacity', 'MaxSpeed', 'EnginePower', 'FuelEfficiency', 'Size', 'Crew', 'FuelCapacity', 'TroopCapacity', 'MilitaryEngines'],
  FCT_Ship: ['ShipID', 'ShipClassID', 'ShippingLineID'],
  FCT_ClassComponent: ['ClassID', 'ComponentID', 'NumComponent'],
  FCT_ShipDesignComponents: ['SDComponentID', 'ComponentTypeID', 'ComponentValue', 'SpecialFunction'],
  FCT_Race: ['RaceID', 'CargoShuttleLoadModifier'],
  FCT_JumpPoint: ['WarpPointID', 'GameID', 'SystemID', 'WPLink', 'Distance', 'Xcor', 'Ycor', 'JumpGateStrength'],
  FCT_RaceJumpPointSurvey: ['WarpPointID', 'GameID', 'RaceID', 'Charted', 'Explored', 'MilitaryRestricted', 'IgnoreForDistance'],
  FCT_RaceSysSurvey: ['SystemID', 'GameID', 'RaceID'],
  FCT_GroundUnitFormation: ['FormationID', 'Name', 'RaceID', 'GameID', 'PopulationID', 'ShipID', 'ParentFormationID'],
  FCT_GroundUnitFormationElement: ['GameID', 'FormationID', 'Units', 'ClassID'],
  FCT_GroundUnitClass: ['GroundUnitClassID', 'Size', 'ConstructionRating', 'HQCapacity'],
  FCT_Commander: ['CommanderID', 'GameID', 'RaceID', 'CommanderType', 'CommandType', 'CommandID'],
  FCT_CommanderBonuses: ['CommanderID', 'BonusID', 'BonusValue'],
}

const installation = (over) => ({ Cost: 0, CargoPoints: 0, Workers: 0, MiningProductionValue: 0, NoBuild: 0, CivilianInstallation: 0, RequiredTechID: 0, CargoShuttleValue: 0, ...Object.fromEntries(MINERAL_COLUMNS.map((name) => [name, 0])), ...over })
const stock = (over = {}) => ({ ...Object.fromEntries(MINERAL_COLUMNS.map((name) => [name, 0])), ...over })

const FIXTURE_ROWS = {
  DIM_PlanetaryInstallation: [
    installation({ PlanetaryInstallationID: 7, Name: 'Mine', Cost: 120, CargoPoints: 25000, Workers: 0.05, MiningProductionValue: 1, Corundium: 120 }),
    installation({ PlanetaryInstallationID: 12, Name: 'Automated Mine', Cost: 240, CargoPoints: 25000, MiningProductionValue: 1, RequiredTechID: 100, Corundium: 240 }),
    installation({ PlanetaryInstallationID: 39, Name: 'Civilian Mining Complex', Cost: 2400, MiningProductionValue: 10, CivilianInstallation: 1 }),
    installation({ PlanetaryInstallationID: 38, Name: 'Conventional Industry', Cost: 240, MiningProductionValue: 0.15, NoBuild: 1 }),
    installation({ PlanetaryInstallationID: 60, Name: 'Locked Mine', Cost: 100, MiningProductionValue: 1, RequiredTechID: 999 }),
    installation({ PlanetaryInstallationID: 5, Name: 'Factory', Cost: 120 }),
    installation({ PlanetaryInstallationID: 61, Name: 'Unknown Recipe Mine', Cost: 100, MiningProductionValue: 1, Gallicite: null }),
    installation({ PlanetaryInstallationID: 20, Name: 'Spaceport', Cost: 100, CargoShuttleValue: 1 }),
  ],
  FCT_RaceTech: [{ GameID: 1, TechID: 100, RaceID: 1 }, { GameID: 1, TechID: 999, RaceID: 2 }],
  FCT_Population: [
    { PopulationID: 1, PopName: 'Alpha', SystemID: 10, SystemBodyID: 100, GameID: 1, RaceID: 1, ...stock({ Duranium: 50, Corundium: 2000 }) },
    { PopulationID: 2, PopName: 'Beta', SystemID: 10, SystemBodyID: 101, GameID: 1, RaceID: 1, ...stock() },
    { PopulationID: 3, PopName: 'Gamma', SystemID: 11, SystemBodyID: 102, GameID: 1, RaceID: 2, ...stock() },
    { PopulationID: 4, PopName: 'Delta', SystemID: 12, SystemBodyID: 999, GameID: 1, RaceID: 1, ...stock() },
  ],
  FCT_SystemBody: [{ SystemBodyID: 100, Xcor: 5, Ycor: 6 }, { SystemBodyID: 101, Xcor: 7, Ycor: 8 }, { SystemBodyID: 102, Xcor: 9, Ycor: 9 }],
  FCT_PopulationInstallations: [{ GameID: 1, PopID: 1, PlanetaryInstallationID: 20, Amount: 2 }, { GameID: 1, PopID: 2, PlanetaryInstallationID: 20, Amount: 0 }],
  FCT_IndustrialProjects: [
    { PopulationID: 1, ProductionType: 0, Percentage: 40, Queue: 0, Pause: 0, Description: 'Build' },
    { PopulationID: 3, ProductionType: 0, Percentage: 90, Queue: 0, Pause: 0, Description: 'Other race' },
  ],
  FCT_ShipClass: [
    { ShipClassID: 1, GameID: 1, RaceID: 1, ClassName: 'Hauler', CargoCapacity: 50000, ColonistCapacity: 0, MaxSpeed: 1000, EnginePower: 100, FuelEfficiency: 1, Size: 20, Crew: 10, FuelCapacity: 1e6, TroopCapacity: 0, MilitaryEngines: 0 },
    { ShipClassID: 2, GameID: 1, RaceID: 1, ClassName: 'Hull', CargoCapacity: 0, ColonistCapacity: 0, MaxSpeed: 1000, EnginePower: 100, FuelEfficiency: 1, Size: 20, Crew: 10, FuelCapacity: 1e6, TroopCapacity: 0, MilitaryEngines: 0 },
    { ShipClassID: 3, GameID: 1, RaceID: 1, ClassName: 'Slow', CargoCapacity: 50000, ColonistCapacity: 0, MaxSpeed: 1, EnginePower: 100, FuelEfficiency: 1, Size: 20, Crew: 10, FuelCapacity: 1e6, TroopCapacity: 0, MilitaryEngines: 0 },
    { ShipClassID: 4, GameID: 1, RaceID: 1, ClassName: 'Trooper', CargoCapacity: 0, ColonistCapacity: 0, MaxSpeed: 800, EnginePower: 100, FuelEfficiency: 1, Size: 20, Crew: 10, FuelCapacity: 1e6, TroopCapacity: 400, MilitaryEngines: 0 },
    { ShipClassID: 5, GameID: 1, RaceID: 2, ClassName: 'Other', CargoCapacity: 9000, ColonistCapacity: 0, MaxSpeed: 1000, EnginePower: 100, FuelEfficiency: 1, Size: 20, Crew: 10, FuelCapacity: 1e6, TroopCapacity: 0, MilitaryEngines: 0 },
  ],
  FCT_Ship: [
    ...[1, 2, 3].map((ShipID) => ({ ShipID, ShipClassID: 1, ShippingLineID: 0 })),
    { ShipID: 4, ShipClassID: 1, ShippingLineID: 5 },
    { ShipID: 5, ShipClassID: 2, ShippingLineID: 0 },
    { ShipID: 6, ShipClassID: 3, ShippingLineID: 0 },
    { ShipID: 7, ShipClassID: 4, ShippingLineID: 0 },
    { ShipID: 8, ShipClassID: 4, ShippingLineID: 0 },
    { ShipID: 9, ShipClassID: 5, ShippingLineID: 0 },
  ],
  FCT_ClassComponent: [{ ClassID: 1, ComponentID: 500, NumComponent: 2 }, { ClassID: 1, ComponentID: 501, NumComponent: 1 }],
  FCT_ShipDesignComponents: [{ SDComponentID: 500, ComponentTypeID: 14, ComponentValue: 1.5, SpecialFunction: 0 }, { SDComponentID: 501, ComponentTypeID: 16, ComponentValue: 30, SpecialFunction: 0 }],
  FCT_Race: [{ RaceID: 1, CargoShuttleLoadModifier: 50 }, { RaceID: 2, CargoShuttleLoadModifier: 0 }],
  FCT_GroundUnitFormation: [
    { FormationID: 1, Name: 'F1', RaceID: 1, GameID: 1, PopulationID: 7, ShipID: 0, ParentFormationID: 0 },
    { FormationID: 2, Name: 'F2', RaceID: 1, GameID: 1, PopulationID: 7, ShipID: 0, ParentFormationID: 0 },
    { FormationID: 3, Name: 'F3', RaceID: 1, GameID: 1, PopulationID: 7, ShipID: 0, ParentFormationID: 0 },
    { FormationID: 4, Name: 'F4', RaceID: 1, GameID: 1, PopulationID: 8, ShipID: 0, ParentFormationID: 0 },
    { FormationID: 5, Name: 'F5', RaceID: 1, GameID: 1, PopulationID: 8, ShipID: 0, ParentFormationID: 0 },
    { FormationID: 6, Name: 'F6', RaceID: 1, GameID: 1, PopulationID: 8, ShipID: 0, ParentFormationID: 0 },
    { FormationID: 7, Name: 'F7', RaceID: 2, GameID: 1, PopulationID: 9, ShipID: 0, ParentFormationID: 0 },
    { FormationID: 8, Name: 'F8', RaceID: 1, GameID: 1, PopulationID: 0, ShipID: 3, ParentFormationID: 1 },
  ],
  FCT_GroundUnitFormationElement: [
    { GameID: 1, FormationID: 1, Units: 50, ClassID: 1 },
    { GameID: 1, FormationID: 1, Units: 1, ClassID: 2 },
    { GameID: 1, FormationID: 1, Units: 1, ClassID: 4 },
    { GameID: 1, FormationID: 2, Units: 3, ClassID: 1 },
    { GameID: 1, FormationID: 3, Units: 1, ClassID: 3 },
    { GameID: 1, FormationID: 3, Units: 1, ClassID: 2 },
    { GameID: 1, FormationID: 8, Units: 2, ClassID: 1 },
    { GameID: 1, FormationID: 7, Units: 9, ClassID: 1 },
  ],
  FCT_GroundUnitClass: [
    { GroundUnitClassID: 1, Size: 100.5, ConstructionRating: 0.1, HQCapacity: 0 },
    { GroundUnitClassID: 2, Size: 40, ConstructionRating: 0, HQCapacity: 6000 },
    { GroundUnitClassID: 3, Size: 10, ConstructionRating: null, HQCapacity: 0 },
    { GroundUnitClassID: 4, Size: 0, ConstructionRating: 0, HQCapacity: 3000 },
  ],
  FCT_Commander: [
    { CommanderID: 1, GameID: 1, RaceID: 1, CommanderType: 4, CommandType: 5, CommandID: 1 },
    { CommanderID: 2, GameID: 1, RaceID: 1, CommanderType: 1, CommandType: 5, CommandID: 2 },
    { CommanderID: 3, GameID: 1, RaceID: 1, CommanderType: 4, CommandType: 5, CommandID: 3 },
    { CommanderID: 5, GameID: 1, RaceID: 1, CommanderType: 2, CommandType: 5, CommandID: 5 },
    { CommanderID: 6, GameID: 1, RaceID: 1, CommanderType: 4, CommandType: 3, CommandID: 6 },
    { CommanderID: 10, GameID: 1, RaceID: 2, CommanderType: 4, CommandType: 5, CommandID: 1 },
  ],
  FCT_CommanderBonuses: [
    { CommanderID: 1, BonusID: 5, BonusValue: 1.2 },
    { CommanderID: 1, BonusID: 4, BonusValue: 9 },
    { CommanderID: 2, BonusID: 4, BonusValue: 1.7 },
    { CommanderID: 3, BonusID: 5, BonusValue: null },
    { CommanderID: 5, BonusID: 5, BonusValue: 1.9 },
    { CommanderID: 6, BonusID: 5, BonusValue: 1.9 },
    { CommanderID: 10, BonusID: 5, BonusValue: 9 },
  ],
}

// An in-memory database with the tables above (those named in `without` as 'Table' or 'Table.Column' left out): `query(sql)` resolves [rows] as the app's database does.
const fixtureDatabase = (without = [], after = []) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(':memory:')
  const columnsOf = (table) => TABLES[table].filter((column) => !without.includes(`${table}.${column}`))
  const tables = Object.keys(TABLES).filter((table) => !without.includes(table))

  raw.serialize(() => {
    tables.forEach((table) => {
      raw.run(`create table ${table} (${columnsOf(table).join(', ')})`)
      ;(FIXTURE_ROWS[table] || []).forEach((row) => {
        const columns = columnsOf(table)

        raw.run(`insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`, columns.map((column) => row[column] === undefined ? null : row[column]))
      })
    })
    after.forEach((sql) => raw.run(sql))
    raw.get('select 1', (error) => (error ? reject(error) : resolve({ queries: [], query(sql) { this.queries.push(sql); return allRows(raw, sql) }, close: () => raw.close() })))
  })
})

const loaders = (ctx) => {
  const { m } = ctx
  const data = m['mine-bootstrap-data']
  const scope = { GameID: 1, RaceID: 1 }
  const statements = []
  const add = (name, test) => statements.push([name, test])

  add('loaders: the mine types are the mining installations the race can build, by name, with their recipes; a recipe with a null mineral is unknown', async () => {
    const db = await fixtureDatabase()
    const types = await data.loadMineTypes(db, scope)

    assert.deepEqual(types.map((type) => type.Name), ['Automated Mine', 'Mine', 'Unknown Recipe Mine'])
    assert.equal(types[1].recipe[10], 120)
    assert.equal(types[1].recipe[1], 0)
    assert.equal(types[1].Workers, 0.05)
    assert.equal(types[0].recipe[10], 240)
    assert.equal(types[2].recipe, null)

    return true
  })
  add('loaders: a technology the race has not researched leaves its type out, and another race\'s technology is not the race\'s', async () => {
    const db = await fixtureDatabase()
    const types = await data.loadMineTypes(db, scope)
    const other = await data.loadMineTypes(db, { GameID: 1, RaceID: 2 })

    assert.ok(!types.some((type) => type.Name === 'Locked Mine'))
    assert.deepEqual(other.map((type) => type.Name), ['Locked Mine', 'Mine', 'Unknown Recipe Mine'])

    return true
  })
  add('loaders: the colonies are the race\'s with a body, with their place, cargo handling and stock; a column the save lacks is a null stock', async () => {
    const db = await fixtureDatabase()
    const colonies = await data.loadBootstrapColonies(db, scope)
    const bare = await fixtureDatabase(['FCT_Population.Corundium', 'FCT_Population.Duranium', 'FCT_Population.Neutronium', 'FCT_Population.Corbomite', 'FCT_Population.Tritanium', 'FCT_Population.Boronide', 'FCT_Population.Mercassium', 'FCT_Population.Vendarite', 'FCT_Population.Sorium', 'FCT_Population.Uridium', 'FCT_Population.Gallicite'])

    assert.deepEqual(colonies.map((colony) => colony.PopName), ['Alpha', 'Beta'])
    assert.deepEqual([colonies[0].Xcor, colonies[0].Ycor, colonies[0].SystemID], [5, 6, 10])
    assert.deepEqual([colonies[0].ShuttleCapacity, colonies[0].ServiceNames], [2, 'Spaceport'])
    assert.equal(colonies[1].ShuttleCapacity, 0)
    assert.equal(colonies[0].stock[1], 50)
    assert.equal(colonies[0].stock[10], 2000)
    assert.equal(colonies[0].stock[2], 0)
    assert.equal(colonies[1].stock[10], 0)
    assert.equal((await data.loadBootstrapColonies(bare, scope))[0].stock, null)

    return true
  })
  add('loaders: the projects are the race\'s, with the fields the share of a colony is read from', async () => {
    const db = await fixtureDatabase()
    const projects = await data.loadBootstrapProjects(db, scope)

    assert.equal(projects.length, 1)
    assert.deepEqual([projects[0].PopulationID, projects[0].ProductionType, projects[0].Percentage, projects[0].Queue, projects[0].Paused, projects[0].Name], [1, 0, 40, 0, 0, 'Build'])

    return true
  })
  add('loaders: the freighters are the race\'s classes with cargo space and a speed, counted over its own ships, with their designed bays and jump drives; the troop capacity is read per class of the ships that carry it', async () => {
    const db = await fixtureDatabase()
    const { freighters, troops, gaps } = await data.loadBootstrapFreight(db, scope)

    assert.equal(freighters.length, 1)
    assert.deepEqual([freighters[0].ClassName, freighters[0].Ships, freighters[0].ShuttleStrength, freighters[0].CargoCapacity], ['Hauler', 3, 3, 50000])
    assert.deepEqual([freighters[0].Drive, freighters[0].AnyDrive, freighters[0].MilitaryEngines, freighters[0].Size], [30, 30, 0, 20])
    assert.deepEqual(gaps, [])
    assert.deepEqual(troops, { lift: 800, ships: 2, classes: [{ ShipClassID: 4, ClassName: 'Trooper', TroopCapacity: 400, Ships: 2 }] })

    return true
  })
  add('loaders: a save without a troop capacity column has no troop lift (unknown, not 0)', async () => {
    const db = await fixtureDatabase(['FCT_ShipClass.TroopCapacity'])
    const { troops } = await data.loadBootstrapFreight(db, scope)

    assert.equal(troops, null)

    return true
  })
  add('loaders: a formation keeps the fraction of its saved tonnage, which decides if a troop bay holds it', async () => {
    const { formations } = await data.loadGroundFormations(await fixtureDatabase(), scope)
    const half = { formation: formations.find((formation) => formation.FormationID === 2), bp: 1 }
    const carry = (bay) => m['mine-bootstrap'].carryFormations([half], { classes: [{ TroopCapacity: bay, Ships: 1 }] })

    assert.equal(half.formation.ownSize, 301.5)
    assert.deepEqual([carry(301).carried.length, carry(301).oversize.length], [0, 1])
    assert.deepEqual([carry(302).carried.length, carry(302).oversize.length], [1, 0])

    return true
  })
  add('loaders: a cargo shuttle bay or service installation with a null count, strength or amount leaves the handling unknown (null), and one with no row zero', async () => {
    const strength = async (after) => (await data.loadBootstrapFreight(await fixtureDatabase([], after), scope)).freighters[0].ShuttleStrength
    const capacity = async (after) => (await data.loadBootstrapColonies(await fixtureDatabase([], after), scope)).map((colony) => colony.ShuttleCapacity)
    const { runImport, MINE, req } = fixtures(m)
    const freight = await data.loadBootstrapFreight(await fixtureDatabase([], ['update FCT_ShipDesignComponents set ComponentValue = null where SDComponentID = 500']), scope)
    const route = runImport({ freighters: freight.freighters }, req(MINE, 1))

    near(await strength([]), 3)
    assert.equal(await strength(['update FCT_ShipDesignComponents set ComponentValue = null where SDComponentID = 500']), null)
    assert.equal(await strength(['update FCT_ClassComponent set NumComponent = null where ComponentID = 500']), null)
    assert.equal(await strength(['delete from FCT_ClassComponent where ComponentID = 500']), 0)
    assert.deepEqual(await capacity([]), [2, 0])
    assert.deepEqual(await capacity(['update FCT_PopulationInstallations set Amount = null where PopID = 1']), [null, 0])
    assert.deepEqual(await capacity(['update DIM_PlanetaryInstallation set CargoShuttleValue = null where PlanetaryInstallationID = 20']), [null, 0])
    assert.deepEqual(await capacity(['delete from FCT_PopulationInstallations where PopID = 1']), [0, 0])
    const extra = ["insert into DIM_PlanetaryInstallation (PlanetaryInstallationID, Name, CargoShuttleValue) values (21, 'Station', 3)", 'insert into FCT_PopulationInstallations (GameID, PopID, PlanetaryInstallationID, Amount) values (1, 1, 21, 1)']
    assert.deepEqual(await capacity(extra), [5, 0])
    assert.deepEqual(await capacity([...extra, 'update FCT_PopulationInstallations set Amount = null where PlanetaryInstallationID = 20 and PopID = 1']), [null, 0])
    assert.equal(route.status, 'unavailable')
    assert.ok(route.missing.some((text) => text.includes('cargo shuttle bays')))

    return true
  })
  add('loaders: the shuttle technology is the race\'s modifier, and null when it has none', async () => {
    const db = await fixtureDatabase()

    assert.equal(await data.loadShuttleTechnology(db, { RaceID: 1 }), 50)
    assert.equal(await data.loadShuttleTechnology(db, { RaceID: 2 }), null)

    return true
  })
  add('loaders: the formations of the race carry their own size (whole), headquarters capacity (the largest), rating (null while a class has none), place and parent', async () => {
    const db = await fixtureDatabase()
    const { gaps, formations } = await data.loadGroundFormations(db, scope)
    const byId = Object.fromEntries(formations.map((formation) => [formation.FormationID, formation]))

    assert.deepEqual(gaps, [])
    assert.deepEqual(formations.map((formation) => formation.FormationID), [1, 2, 3, 4, 5, 6, 8])
    assert.deepEqual([byId[1].ownSize, byId[1].hq, byId[1].PopulationID, byId[1].ShipID], [5065, 6000, 7, 0])
    near(byId[1].rating, 5)
    assert.equal(byId[2].ownSize, 301.5)
    assert.equal(byId[2].hq, 0)
    near(byId[2].rating, 0.3)
    assert.equal(byId[3].rating, null)
    assert.equal(byId[3].ownSize, 50)
    assert.deepEqual([byId[4].ownSize, byId[4].hq, byId[4].rating], [0, 0, 0])
    assert.deepEqual([byId[8].PopulationID, byId[8].ShipID, byId[8].ParentFormationID], [0, 3, 1])

    return true
  })
  add('loaders: a commander counts for a ground formation of its own race only, of a ground type; its Production bonus is 1 with no bonus row and unknown with a null value', async () => {
    const db = await fixtureDatabase()
    const { formations } = await data.loadGroundFormations(db, scope)
    const byId = Object.fromEntries(formations.map((formation) => [formation.FormationID, formation]))

    assert.deepEqual(byId[1].commander, { bonus: 1.2 })
    assert.deepEqual(byId[2].commander, { bonus: 1 })
    assert.deepEqual(byId[3].commander, { bonus: null })
    assert.equal(byId[4].commander, null)
    assert.equal(byId[5].commander, null)
    assert.equal(byId[6].commander, null)

    return true
  })
  add('loaders: with the commander bonus lookup not confirmed every commander\'s bonus is unknown, never 1', async () => {
    const db = await fixtureDatabase()
    const { formations } = await data.loadGroundFormations(db, { ...scope, blocked: new Set([5]) })

    assert.deepEqual(formations.filter((formation) => formation.commander).map((formation) => formation.commander.bonus), [null, null, null])

    return true
  })
  add('loaders: a missing table or column is a gap named, and no formation is given', async () => {
    const column = await data.loadGroundFormations(await fixtureDatabase(['FCT_GroundUnitClass.ConstructionRating']), scope)
    const table = await data.loadGroundFormations(await fixtureDatabase(['FCT_CommanderBonuses']), scope)

    assert.deepEqual(column.gaps, ['FCT_GroundUnitClass.ConstructionRating'])
    assert.deepEqual(column.formations, [])
    assert.deepEqual(table.gaps, ['FCT_CommanderBonuses (table)'])

    return true
  })
  add('loaders: a loader reading a save of an unexpected shape reads null for a column it lacks (a missing cost or worker count is unknown)', async () => {
    const db = await fixtureDatabase(['DIM_PlanetaryInstallation.Workers', 'DIM_PlanetaryInstallation.Cost'])
    const types = await data.loadMineTypes(db, scope)

    assert.ok(types.length > 0)
    types.forEach((type) => assert.deepEqual([type.Workers, type.Cost], [null, null]))

    return true
  })
  add('loaders: every read together gives the sources the page uses', async () => {
    const db = await fixtureDatabase()
    const sources = await data.loadBootstrapSources(db, scope)

    assert.deepEqual(Object.keys(sources).sort(), Object.keys(data.NO_BOOTSTRAP_SOURCES).sort())
    assert.equal(sources.types.length, 3)
    assert.equal(sources.colonies.length, 2)
    assert.equal(sources.freighters.length, 1)
    assert.equal(sources.shuttleTechnology, 50)
    assert.deepEqual(sources.jumpPoints, [])

    return true
  })

  add('loaders: a column the save lacks (the fuel capacity, the military engines flag, the size, the jump drive function, the shuttle value or modifier) is read as unknown and no read fails', async () => {
    const db = await fixtureDatabase(['FCT_ShipClass.FuelCapacity', 'FCT_ShipClass.MilitaryEngines', 'FCT_ShipClass.Size', 'FCT_ShipDesignComponents.SpecialFunction', 'DIM_PlanetaryInstallation.CargoShuttleValue', 'FCT_Race.CargoShuttleLoadModifier'])
    const sources = await data.loadBootstrapSources(db, scope)
    const [hauler] = sources.freighters

    assert.deepEqual(sources.problems, [])
    assert.equal(sources.freighters.length, 1)
    assert.deepEqual([hauler.FuelCapacity, hauler.MilitaryEngines, hauler.Size, hauler.Drive, hauler.AnyDrive], [null, null, null, null, null])
    assert.equal(sources.shuttleTechnology, null)
    sources.colonies.forEach((colony) => assert.equal(colony.ShuttleCapacity, null))
    assert.equal(sources.types.length, 3)

    return true
  })
  add('loaders: a fuel column the save lacks reaches the import as an unavailable route naming it', async () => {
    const { runImport, MINE, req } = fixtures(m)
    const names = { EnginePower: 'the engine power of Hauler', FuelEfficiency: 'the fuel use per engine power of Hauler', FuelCapacity: 'the fuel capacity of Hauler' }

    for (const [column, name] of Object.entries(names)) {
      const sources = await data.loadBootstrapSources(await fixtureDatabase([`FCT_ShipClass.${column}`]), scope)
      const route = runImport({ freighters: sources.freighters }, req(MINE, 1))

      assert.deepEqual(sources.problems, [], column)
      assert.equal(sources.freighters[0][column], null, column)
      assert.equal(route.status, 'unavailable', column)
      assert.ok(route.missing.includes(name), column)
    }

    return true
  })
  add('loaders: a table the cargo handling or the shuttle technology reads lacking leaves the handling unknown (null), never 0', async () => {
    const colonies = await data.loadBootstrapColonies(await fixtureDatabase(['FCT_PopulationInstallations']), scope)
    const bays = await data.loadBootstrapFreight(await fixtureDatabase(['FCT_ClassComponent']), scope)

    colonies.forEach((colony) => assert.deepEqual([colony.ShuttleCapacity, colony.ServiceNames], [null, null]))
    assert.equal(bays.freighters[0].ShuttleStrength, null)
    assert.equal(bays.freighters[0].Drive, null)

    return true
  })
  add('loaders: a source that fails to read is named in the problems and left empty while the others stand', async () => {
    const jumps = await data.loadBootstrapSources(await fixtureDatabase(['FCT_JumpPoint']), scope)
    const freight = await data.loadBootstrapSources(await fixtureDatabase(['FCT_ShipClass.CargoCapacity']), scope)

    assert.deepEqual(jumps.problems.map((problem) => problem.source), ['jumps'])
    assert.ok(jumps.problems[0].text.includes('could not be read'))
    assert.deepEqual(jumps.jumpPoints, [])
    assert.equal(jumps.types.length, 3)
    assert.equal(jumps.colonies.length, 2)
    assert.equal(jumps.freighters.length, 1)
    assert.deepEqual(freight.problems.map((problem) => problem.source), ['freight'])
    assert.ok(freight.problems[0].text.includes('FCT_ShipClass.CargoCapacity'))
    assert.deepEqual(freight.freighters, [])
    assert.equal(freight.types.length, 3)

    return true
  })
  add('loaders: a null flag or a missing flag column does not make a type buildable: it stays listed with what is unknown, and every figure of it is unavailable', async () => {
    const mb = m['mine-bootstrap']
    const named = (types, name) => types.find((type) => type.Name === name)
    const flags = await data.loadMineTypes(await fixtureDatabase([], ['update DIM_PlanetaryInstallation set NoBuild = null where PlanetaryInstallationID = 7', 'update DIM_PlanetaryInstallation set CivilianInstallation = null where PlanetaryInstallationID = 12', 'update DIM_PlanetaryInstallation set RequiredTechID = null where PlanetaryInstallationID = 61']), scope)
    const noColumn = await data.loadMineTypes(await fixtureDatabase(['DIM_PlanetaryInstallation.NoBuild']), scope)
    const noTechColumn = await data.loadMineTypes(await fixtureDatabase(['DIM_PlanetaryInstallation.RequiredTechID']), scope)
    const noTechTable = await data.loadMineTypes(await fixtureDatabase(['FCT_RaceTech']), scope)

    assert.ok(named(flags, 'Mine').eligibility.some((text) => text.includes('NoBuild')))
    assert.ok(named(flags, 'Automated Mine').eligibility.some((text) => text.includes('CivilianInstallation')))
    assert.ok(named(flags, 'Unknown Recipe Mine').eligibility.some((text) => text.includes('RequiredTechID')))
    assert.deepEqual(flags.map((type) => type.Name), ['Automated Mine', 'Mine', 'Unknown Recipe Mine'])
    assert.equal(mb.mineRequirements(named(flags, 'Mine'), 10).bp.status, 'unavailable')
    assert.ok(noColumn.length >= 3 && noColumn.every((type) => type.eligibility.some((text) => text.includes('NoBuild'))))
    assert.ok(noColumn.some((type) => type.Name === 'Conventional Industry'))
    assert.ok(noTechColumn.every((type) => type.eligibility.some((text) => text.includes('RequiredTechID'))))
    assert.deepEqual(named(noTechTable, 'Mine').eligibility, [])
    assert.ok(named(noTechTable, 'Automated Mine').eligibility.some((text) => text.includes('RequiredTechID')))
    assert.ok(named(noTechTable, 'Locked Mine').eligibility.length > 0)

    return true
  })
  add('loaders: a type the save says cannot be built, is civilian or needs a technology the race lacks is left out, and one it says is fine has nothing unknown', async () => {
    const types = await data.loadMineTypes(await fixtureDatabase(), scope)

    assert.deepEqual(types.map((type) => type.Name), ['Automated Mine', 'Mine', 'Unknown Recipe Mine'])
    types.forEach((type) => assert.deepEqual(type.eligibility, []))

    return true
  })

  return statements
}

// ---------- the page ----------

const pageStatements = (ctx) => {
  const { m, pageOptions, pageText } = ctx
  const { provenance } = m
  const f = fixtures(m)
  const { cap, split, MINE, AUTO, T, B1, FREIGHTER } = f
  const store = { $store: { getters: { 'capabilities/blockedBonuses': new Set() }, state: { RaceNPR: false }, dispatch: async () => {} } }
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const MODIFIERS = { ConstructionProduction: 10, OverallProductionModifier: 50, ConstructionPower: 4, EngineerProductionModifier: 1, GroundConstructionPower: 0 }
  const rows = () => [
    { PopulationID: 1, name: 'Target', Efficiency: 0.5, workersNow: split(300), workersLater: split(300), r: { construction: cap(2000), cost: cap(0) } },
    { PopulationID: 2, name: 'Builder', Efficiency: 1, workersNow: split(100), workersLater: split(100), r: { construction: cap(600), cost: cap(0) } },
  ]
  const sources = (over = {}) => ({ types: [MINE, AUTO], colonies: [T, { ...B1.colony, stock: { 10: 5000 } }].map((colony) => ({ stock: { 10: 5000 }, ...colony })), projects: [], freighters: [FREIGHTER], troops: { lift: 16000, ships: 2, classes: [{ TroopCapacity: 8000, Ships: 2 }] }, ground: { gaps: [], formations: [f.form(1, { PopulationID: 5, rating: 10, commander: { bonus: 1.2 } })] }, jumpPoints: [], shuttleTechnology: 1, problems: [], ...over })
  const mount = (data = {}, database = null) => instantiate(pageOptions, { ...store, database, GameID: 1, RaceID: 1, data: { rows: rows(), bootstrapSources: sources(), bootstrapVersion: '2.7.x', bootstrapColonyId: 1, populationProductionModifiers: { 1: MODIFIERS }, ...data } })
  const stubDatabase = () => ({ queries: [], query(sql) { this.queries.push(sql); return Promise.resolve([[]]) } })

  add('page: nothing is read until a colony is picked, and the reads come with the pick', async () => {
    const before = stubDatabase()
    const idle = instantiate(pageOptions, { ...store, database: before, GameID: 1, RaceID: 1 })

    await idle.runAsync('bootstrapSources')
    await idle.runAsync('bootstrapVersion')
    assert.equal(before.queries.length, 0)
    assert.equal(idle.bootstrapSources.types.length, 0)
    assert.equal(idle.bootstrapVersion, null)

    const after = stubDatabase()
    const picked = instantiate(pageOptions, { ...store, database: after, GameID: 1, RaceID: 1, data: { bootstrapColonyId: 1 } })

    await picked.runAsync('bootstrapSources')
    assert.ok(after.queries.length > 0)

    return true
  })
  add('page: the reads have one name as a tracked key, an asyncComputed and an INPUT_LABELS key, with a default', () => {
    const labels = (pageText.match(/const INPUT_LABELS = \{([\s\S]*?)\n\}/) || [])[1] || ''
    const labelKeys = [...labels.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])
    const trackedKeys = [...pageText.matchAll(/tracked\('(\w+)'/g)].map((match) => match[1])

    ;['bootstrapSources', 'bootstrapVersion'].forEach((name) => {
      assert.ok(labelKeys.includes(name), `INPUT_LABELS ${name}`)
      assert.ok(trackedKeys.includes(name), `tracked ${name}`)
      assert.ok(name in pageOptions.asyncComputed, `asyncComputed ${name}`)
      assert.ok('default' in pageOptions.asyncComputed[name])
    })

    return true
  })
  add('page: the number of mines is a whole number above 0, else it is not given and the routes say so', () => {
    assert.equal(mount({ bootstrapQuantity: '10' }).bootstrapCount, 10)
    assert.equal(mount({ bootstrapQuantity: '2.5' }).bootstrapCount, null)
    assert.equal(mount({ bootstrapQuantity: '' }).bootstrapCount, null)
    assert.equal(mount({ bootstrapQuantity: '0' }).bootstrapCount, null)

    const routes = mount({ bootstrapQuantity: 'x' }).bootstrapRoutes

    assert.equal(routes.find((route) => route.id === 'local').status, 'unavailable')
    assert.ok(routes.find((route) => route.id === 'local').missing.includes('a number of mines'))

    return true
  })
  add('page: the colony picked gets the three routes, the build time at its capacity and its own workers; the mine type defaults to the first the race can build', () => {
    const vm = mount()
    const routes = Object.fromEntries(vm.bootstrapRoutes.map((route) => [route.id, route]))

    assert.deepEqual(vm.bootstrapRoutes.map((route) => route.id), ['import', 'local', 'ground'])
    assert.equal(vm.bootstrapType.Name, 'Mine')
    near(routes.local.figures.rate.value, 2000)
    near(routes.local.figures.days.value, 219)
    assert.equal(routes.local.status, 'limited')
    near(routes.import.figures.labour.needed, 0.5)
    assert.equal(routes.import.figures.builder.name, 'Builder')

    return true
  })
  add('page: the full capacity of an understaffed colony is its modifiers with the saved efficiency taken out', () => {
    const routes = Object.fromEntries(mount().bootstrapRoutes.map((route) => [route.id, route]))

    near(routes.local.figures.full.value, 4000)
    near(routes.local.figures.lostBP, 2000)

    return true
  })
  add('page: the colony\'s own worker split now and at the horizon goes to the routes', () => {
    const vm = mount()
    const routes = Object.fromEntries(vm.bootstrapRoutes.map((route) => [route.id, route]))

    near(routes.local.figures.freeAfterNow, -50.5, 1e-6)
    near(routes.import.figures.labour.deficitNow, 0.5, 1e-6)
    near(routes.import.figures.labour.existingNow, 50, 1e-6)

    return true
  })
  add('page: the builders\' build time takes the share their own projects hold', () => {
    const free = mount()
    const held = mount({ bootstrapSources: sources({ projects: [{ PopulationID: 2, ProductionType: 0, Percentage: 50, Queue: 0, Paused: 0, Name: 'Busy' }] }) })

    near(free.bootstrapBuilders[0].buildDays, 730)
    near(held.bootstrapBuilders[0].buildDays, 1460)

    return true
  })
  add('page: the engineers\' route gets the formula version of the save and the troop lift', () => {
    const mapped = mount().bootstrapRoutes.find((route) => route.id === 'ground')
    const unknown = mount({ bootstrapVersion: null }).bootstrapRoutes.find((route) => route.id === 'ground')
    const lifted = mount({ bootstrapSources: sources({ troops: { lift: 0, ships: 0, classes: [] } }) }).bootstrapRoutes.find((route) => route.id === 'ground')

    assert.equal(mapped.status, 'limited')
    assert.equal(unknown.status, 'unavailable')
    assert.equal(lifted.status, 'blocked')

    return true
  })
  add('page: the chosen builder is the one used for the import', () => {
    const second = { ...B1.colony, PopulationID: 3, PopName: 'Second', Xcor: 6e6, Ycor: 8e6, stock: { 10: 5000 } }
    const vm = mount({ bootstrapSources: sources({ colonies: [{ ...T, stock: { 10: 5000 } }, { ...B1.colony, stock: { 10: 5000 } }, second] }), rows: [...rows(), { PopulationID: 3, name: 'Second', Efficiency: 1, workersNow: split(100), workersLater: split(100), r: { construction: cap(300), cost: cap(0) } }], bootstrapBuilderId: 3 })

    assert.equal(vm.bootstrapRoutes[0].figures.builder.name, 'Second')
    assert.equal(mount().bootstrapRoutes[0].figures.builder.name, 'Builder')

    return true
  })
  add('page: with no colony picked there are no routes, and a colony with no place has none either', () => {
    assert.deepEqual(mount({ bootstrapColonyId: null }).bootstrapRoutes, [])
    assert.deepEqual(mount({ bootstrapSources: sources({ colonies: [] }) }).bootstrapRoutes, [])

    return true
  })

  // ----- the template, read as text -----
  const startTag = (pageText.match(/<v-card class="panel mine-bootstrap"[^>]*>/) || [''])[0]
  const summary = (startTag.match(/data-summary="([^"]*)"/) || [])[1] || ''
  const foot = ((pageText.match(/<v-card class="panel mine-bootstrap"[\s\S]*?<\/v-card>/) || [''])[0].match(/<div class="panel-foot[^>]*>([\s\S]*?)<\/div>/) || [])[1] || ''
  const panel = (pageText.match(/<v-card class="panel mine-bootstrap"[\s\S]*?<\/v-card>/) || [''])[0]
  const voice = /\b(I|me|my|mine|you|your|we|our)\b/i

  add('template: the panel is a top-level .panel with a data-summary that has no digit and no first or second person', () => {
    assert.ok(startTag.length > 0, 'no panel')
    assert.ok(summary.length > 40, `summary: ${summary}`)
    assert.ok(!/\d/.test(summary), `a figure in ${summary}`)
    assert.ok(!voice.test(summary), `a person in ${summary}`)

    return true
  })
  add('template: the foot states the three routes, the freight and labour deficits, the unavailable ground route and its upper bound, and the dash, in the UI voice', () => {
    ;['Import', 'freight deficit', 'labour deficit', 'Local industry', 'Ground-force assistance', 'unavailable where the save lacks the columns or the version is not 2.7', 'upper bound', 'A dash is a figure the save cannot support'].forEach((text) => assert.ok(foot.includes(text), text))
    assert.ok(!voice.test(foot.replace(/<[^>]*>/g, '')), 'a person in the foot')

    return true
  })
  add('template: each route card shows its status, what works now, its limits and its missing inputs', () => {
    ;['routeStatus[route.status]', 'class="chart-title mt-2">Works now</div>', 'class="chart-title mt-2">Limits</div>', 'class="chart-title mt-2">Missing inputs</div>', 'route.worksNow', 'route.limits', 'route.missing', 'v-for="route in bootstrapRoutes"'].forEach((text) => assert.ok(panel.includes(text), text))

    return true
  })
  add('template: the panel has the colony, mine type, number and builder controls', () => {
    ;['v-model="bootstrapColonyId"', 'label="Mine type"', 'v-model="bootstrapQuantity"', 'label="Builder for the import"'].forEach((text) => assert.ok(panel.includes(text), text))

    return true
  })
  add('template: the panel is not part of a persisted view: its selections are plain data', () => {
    assert.ok(!/key: 'colonyOutlookBootstrap/.test(pageText))
    assert.deepEqual([pageOptions.data().bootstrapColonyId, pageOptions.data().bootstrapQuantity], [null, '10'])

    return true
  })

  // ----- the review fixes -----
  const withGround = (formations) => sources({ ground: { gaps: [], formations } })
  const BUILDER_MODIFIERS = { ConstructionProduction: 1, OverallProductionModifier: 100, ConstructionPower: 6, EngineerProductionModifier: 1, GroundConstructionPower: 0 }
  const routesOf = (vm) => Object.fromEntries(vm.bootstrapRoutes.map((route) => [route.id, route]))

  add('page: the engineers at the colony are counted in its capacity by the mapped command rule: the build now, the full capacity and the engineers\' route agree, and an unmapped save keeps the Production page\'s figure', () => {
    const formations = [f.form(7, { PopulationID: 1, rating: 10, commander: { bonus: 1.2 }, ownSize: 7000 })]
    const modifiers = { 1: { ...MODIFIERS, GroundConstructionPower: 12 } }
    const mapped = routesOf(mount({ bootstrapSources: withGround(formations), populationProductionModifiers: modifiers }))
    const unmapped = routesOf(mount({ bootstrapSources: withGround(formations), bootstrapVersion: null, populationProductionModifiers: modifiers }))

    near(mapped.local.figures.rate.value, 2100)
    near(mapped.local.figures.full.value, 4100)
    near(mapped.ground.figures.present, 100)
    near(mapped.ground.figures.rateNow, 2100)
    near(unmapped.local.figures.rate.value, 2000)
    near(unmapped.local.figures.full.value, 4120)

    return true
  })
  add('page: an engineer with a null commander bonus makes the colony\'s construction capacity unavailable, not the Production page\'s figure, for the build now, the full capacity and the builders', () => {
    const modifiers = { 1: { ...MODIFIERS, GroundConstructionPower: 12 }, 2: { ...BUILDER_MODIFIERS, GroundConstructionPower: 12 } }
    const here = mount({ bootstrapSources: withGround([f.form(7, { PopulationID: 1, rating: 10, commander: { bonus: null } })]), populationProductionModifiers: modifiers })
    const there = mount({ bootstrapSources: withGround([f.form(7, { PopulationID: 2, rating: 10, commander: { bonus: null } })]), populationProductionModifiers: modifiers })
    const routes = routesOf(here)

    assert.ok(!provenance.isAvailable(here.mappedConstruction(here.bootstrapTarget)))
    assert.equal(routes.local.status, 'unavailable')
    assert.ok(routes.local.missing.some((text) => text.includes('commander bonus')))
    assert.equal(routes.ground.status, 'unavailable')
    assert.ok(!provenance.isAvailable(there.bootstrapBuilders[0].rate))
    assert.ok(there.bootstrapBuilders[0].rate.inputs.missing.some((text) => text.includes('commander bonus')))
    assert.equal(routesOf(there).import.status, 'unavailable')
    assert.ok(routesOf(there).import.missing.some((text) => text.includes('commander bonus')))

    return true
  })
  add('page: the builders\' capacity counts their own engineers by the same rule', () => {
    const vm = mount({ bootstrapSources: withGround([f.form(7, { PopulationID: 2, rating: 10, commander: { bonus: 1.2 } })]), populationProductionModifiers: { 1: MODIFIERS, 2: BUILDER_MODIFIERS } })

    near(vm.bootstrapBuilders[0].buildDays, (1200 / 612) * 365)

    return true
  })
  add('page: the engineers\' route gets the colony\'s workers and stock', () => {
    const vm = mount({ bootstrapSources: sources({ colonies: [{ ...T, stock: { 10: 500 } }, { ...B1.colony, stock: { 10: 5000 } }] }) })
    const ground = routesOf(vm).ground

    assert.ok(ground.limits.some((text) => text.includes('Corundium by 700 t')))
    assert.ok(ground.limits.some((text) => text.includes('manned mines need')))

    return true
  })
  add('page: a freighter class with a fuel input the save leaves null leaves only the import unavailable, naming it', () => {
    const routes = routesOf(mount({ bootstrapSources: sources({ freighters: [{ ...FREIGHTER, EnginePower: null }] }) }))

    assert.equal(routes.import.status, 'unavailable')
    assert.ok(routes.import.missing.includes('the engine power of Hauler'))
    assert.equal(routes.local.status, 'limited')
    assert.equal(routes.ground.status, 'limited')

    return true
  })
  add('page: an import that stops before the haul is timed marks its hauling and total time rows with a result naming what is missing', () => {
    const vm = mount({ bootstrapSources: sources({ freighters: [{ ...FREIGHTER, EnginePower: null }] }) })
    const rows = Object.fromEntries(vm.routeFigures(routesOf(vm).import).map((figure) => [figure.label, figure]))

    ;['Hauling time', 'Hauling and build time'].forEach((label) => {
      assert.equal(rows[label].text, '—', label)
      assert.ok(rows[label].result && typeof rows[label].result.status === 'string', label)
      assert.ok(rows[label].result.inputs.missing.some((text) => text.includes('the engine power of Hauler')), label)
    })

    return true
  })
  add('page: the builder selector says "1 jump" and "2 jumps"', () => {
    const builder = (id, route) => ({ colony: { PopulationID: id, PopName: `B${id}` }, route })
    const vm = mount({ bootstrapBuilders: [builder(2, { jumps: 1 }), builder(3, { jumps: 2 }), builder(4, null)] })

    assert.deepEqual(vm.bootstrapBuilderItems.map((item) => item.text), ['B2 (1 jump)', 'B3 (2 jumps)', 'B4 (no route)'])

    return true
  })
  add('page: a read that failed leaves the routes that rest on it unavailable and is named in the panel, while the other routes stand', () => {
    const failed = (source) => routesOf(mount({ bootstrapSources: sources({ problems: [{ source, text: `the ${source} could not be read (boom)` }] }) }))
    const freight = failed('freight')
    const projects = failed('projects')
    const jumps = failed('jumps')

    assert.equal(freight.import.status, 'unavailable')
    assert.ok(freight.import.missing.includes('the freight could not be read (boom)'))
    assert.equal(freight.ground.status, 'unavailable')
    assert.equal(freight.local.status, 'limited')
    ;['import', 'local', 'ground'].forEach((id) => assert.equal(projects[id].status, 'unavailable', id))
    assert.equal(jumps.import.status, 'unavailable')
    assert.equal(jumps.local.status, 'limited')
    assert.equal(jumps.ground.status, 'limited')
    assert.ok(panel.includes('data-bootstrap-problems') && panel.includes('bootstrapSources.problems'))

    return true
  })
  add('page: the figure rows carry a provenance result each, are written with the page\'s separator and say 1 in the singular', () => {
    const vm = mount({ bootstrapQuantity: '1', separator: ',' })
    const routes = routesOf(vm)
    const rows = (id) => Object.fromEntries(vm.routeFigures(routes[id]).map((figure) => [figure.label, figure]))

    Object.values(routes).forEach((route) => {
      assert.ok(vm.routeFigures(route).length > 0, route.id)
      vm.routeFigures(route).forEach((figure) => assert.ok(figure.result && typeof figure.result.status === 'string', `${route.id} ${figure.label}`))
    })
    assert.ok(rows('local')['Idle construction capacity'].text.startsWith('2,000 BP/yr'))
    assert.ok(routes.local.worksNow[0].includes('2,000 BP/yr'), routes.local.worksNow[0])
    assert.ok(rows('import').Freight.text.includes('in 1 trip,'), rows('import').Freight.text)
    assert.ok(rows('import')['Built at'].text.includes(', 0 jumps,'))
    assert.ok(rows('ground')['Engineers that can move'].text.startsWith('1 formation of 1,'))
    assert.ok(Object.keys(rows('import')).includes('Workers short at the colony before the mines'))
    assert.ok(panel.includes('<provenance-mark v-if="figure.result" :result="figure.result" />'))

    return true
  })
  add('page: the picked colony of the page (the link\'s colony) is the panel\'s colony until another is chosen', () => {
    const vm = mount({ bootstrapColonyId: null })
    const [target, other] = rows()

    pageOptions.watch.focusRow.call(vm, other, null)
    assert.equal(vm.bootstrapColonyId, 2)
    vm.bootstrapColonyId = target.PopulationID
    pageOptions.watch.focusRow.call(vm, other, other)
    assert.equal(vm.bootstrapColonyId, 1)
    pageOptions.watch.focusRow.call(vm, null, other)
    assert.equal(vm.bootstrapColonyId, 1)

    return true
  })
  add('capabilities: the mine bootstrap reads are an optional input of the Colony Outlook page, which degrades without them, and every other route\'s inputs stay required', () => {
    const optional = (ctx.capabilitiesText.match(/const OPTIONAL = Object\.freeze\(\{([\s\S]*?)\r?\n\}\)/) || [])[1] || ''

    assert.ok(/'\/colony-outlook': \(key\) => key === 'bootstrapSources'( \|\| key === '\w+')*,?(\r?\n|$)/.test(optional), optional)
    assert.ok(!/'\/colony-outlook'[^\n]*(bootstrapVersion|\|\| true|=> true)/.test(optional))

    return true
  })

  return statements
}

// ---------- the saves ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows]))))

const runSql = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))

const rawQuery = (raw) => (sql) => allRows(raw, sql)

// The save opened read-only; `overlay(sqlList)` runs statements on temporary tables that shadow the save's own, so the save itself is never written.
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

    resolve({ file: path.basename(resolved), query: rawQuery(raw), overlay: (statements) => statements.reduce((chain, sql) => chain.then(() => runSql(raw, sql)), Promise.resolve()), close: () => raw.close() })
  })
})

const saveStatements = async (ctx, save) => {
  const { m, pageOptions } = ctx
  const database = await openSave(save.file)

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const scope = { GameID: save.game, RaceID: save.race }
  const data = m['mine-bootstrap-data']
  const mb = m['mine-bootstrap']
  const label = (text) => `${text} (${save.file})`
  const statements = []
  const add = (name, test) => statements.push([label(name), test])
  const store = (blocked = new Set()) => ({ $store: { getters: { 'capabilities/blockedBonuses': blocked }, state: { RaceNPR: false }, dispatch: async () => {} } })
  const pageOf = async (db = database, blocked = new Set()) => {
    const vm = instantiate(pageOptions, { ...store(blocked), database: db, GameID: save.game, RaceID: save.race })

    for (const read of ['colonies', 'inbound', 'populationProductionModifiers', 'arks']) {
      await vm.runAsync(read)
    }

    return vm
  }
  const withTarget = async (vm, id, quantity = '10') => {
    vm.bootstrapColonyId = id
    vm.bootstrapQuantity = quantity
    await vm.runAsync('bootstrapSources')
    await vm.runAsync('bootstrapVersion')

    return vm
  }
  const routesOf = (vm) => Object.fromEntries(vm.bootstrapRoutes.map((route) => [route.id, route]))
  // A colony the routes can be compared on: a place, an idle construction rate and engineers at other colonies.
  const pick = async (vm) => {
    await withTarget(vm, vm.rows[0].PopulationID)

    let fallback = null

    for (const row of vm.rows.filter((item) => item.Population > 0 && item.workersNow && item.Efficiency > 0)) {
      vm.bootstrapColonyId = row.PopulationID

      const routes = routesOf(vm)

      if (routes.local.figures.full && routes.ground.figures.candidates && routes.ground.figures.candidates.length > 0) {
        if (routes.local.figures.rate.value > 0) {
          return row
        }

        fallback = fallback || row
      }
    }

    return fallback
  }

  add('save-sources: the reads are checked against raw counts: types, colonies, formations, commanders and the units x rating total', async () => {
    const sources = await data.loadBootstrapSources(database, scope)
    const [[types]] = await database.query(`select count(*) as n from DIM_PlanetaryInstallation where MiningProductionValue > 0 and coalesce(NoBuild, 0) = 0 and coalesce(CivilianInstallation, 0) = 0 and (coalesce(RequiredTechID, 0) = 0 or RequiredTechID in (select TechID from FCT_RaceTech where GameID = ${save.game} and RaceID = ${save.race}))`)
    const [[colonies]] = await database.query(`select count(*) as n from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${save.game} and FCT_Population.RaceID = ${save.race}`)
    const [[formations]] = await database.query(`select count(*) as n from FCT_GroundUnitFormation where GameID = ${save.game} and RaceID = ${save.race}`)
    const [[commanders]] = await database.query(`select count(distinct FCT_Commander.CommandID) as n from FCT_Commander where GameID = ${save.game} and RaceID = ${save.race} and CommandType = 5 and CommanderType in (1, 4) and CommandID <> 0 and CommandID in (select FormationID from FCT_GroundUnitFormation where GameID = ${save.game} and RaceID = ${save.race})`)
    const [[rating]] = await database.query(`select sum(FCT_GroundUnitFormationElement.Units * FCT_GroundUnitClass.ConstructionRating) as total from FCT_GroundUnitFormationElement inner join FCT_GroundUnitFormation on FCT_GroundUnitFormation.FormationID = FCT_GroundUnitFormationElement.FormationID inner join FCT_GroundUnitClass on FCT_GroundUnitClass.GroundUnitClassID = FCT_GroundUnitFormationElement.ClassID where FCT_GroundUnitFormation.GameID = ${save.game} and FCT_GroundUnitFormation.RaceID = ${save.race}`)

    assert.equal(sources.types.length, types.n)
    assert.equal(sources.colonies.length, colonies.n)
    assert.deepEqual(sources.ground.gaps, [])
    assert.equal(sources.ground.formations.length, formations.n)
    assert.equal(sources.ground.formations.filter((formation) => formation.commander).length, commanders.n)
    near(sources.ground.formations.reduce((sum, formation) => sum + formation.rating, 0), rating.total, 1e-9)
    assert.ok(sources.types.every((type) => type.recipe !== null && Number.isFinite(type.Cost)))
    assert.ok(sources.freighters.every((shipClass) => shipClass.CargoCapacity > 0 && shipClass.Ships > 0))

    return true
  }, `${save.file} reads`)
  add('save-engineers: the engineers\' rating at each colony agrees with the Production page\'s figure where no parent headquarters is at the colony; where one is, the rule-mapped figure is the larger', async () => {
    const vm = await pageOf()
    const { ground } = await data.loadBootstrapSources(database, scope)
    const byId = Object.fromEntries(ground.formations.map((formation) => [formation.FormationID, formation]))
    let agree = 0
    let chained = 0

    for (const [id, modifiers] of Object.entries(vm.populationProductionModifiers)) {
      const mapped = mb.engineerPower(ground.formations, Number(id))
      const linked = ground.formations.some((formation) => formation.PopulationID === Number(id) && !formation.ShipID && formation.rating > 0 && formation.commander && byId[formation.ParentFormationID] && byId[formation.ParentFormationID].PopulationID === Number(id) && byId[formation.ParentFormationID].commander)

      assert.equal(mapped.unknown.length, 0)

      if (linked) {
        chained++
        assert.ok(mapped.power >= modifiers.GroundConstructionPower - 1e-9, `colony ${id}: ${mapped.power} below ${modifiers.GroundConstructionPower}`)
      } else {
        near(mapped.power, modifiers.GroundConstructionPower, 1e-9)
        agree++
      }
    }

    assert.ok(agree > 0)
    assert.ok(chained > 0, 'no colony with a parent headquarters to compare')

    return true
  })
  add('save-routes: real colonies get three routes in order with a status, the tonnage of the mines and a build time that is the cost over the idle rate', async () => {
    const vm = await pageOf()
    const sample = vm.rows.filter((row) => row.Population > 0).slice(0, 4)

    for (const row of sample) {
      await withTarget(vm, row.PopulationID, '5')

      const routes = routesOf(vm)
      const type = vm.bootstrapType

      assert.deepEqual(vm.bootstrapRoutes.map((route) => route.id), ['import', 'local', 'ground'])
      vm.bootstrapRoutes.forEach((route) => assert.ok(STATUSES.includes(route.status)))
      near(routes.import.figures.tonnes.value, type.CargoPoints * 5)

      if (routes.local.figures.days && Number.isFinite(routes.local.figures.days.value)) {
        near(routes.local.figures.days.value, (type.Cost * 5 / routes.local.figures.rate.value) * 365, 1e-9)
      }
    }

    return true
  })
  add('save-understaffed: no colony short of workers receives a full local route: the route is limited or blocked, never works', async () => {
    const vm = await pageOf()

    for (const row of vm.rows.filter((item) => item.workersNow && item.workersNow.free < -0.005)) {
      await withTarget(vm, row.PopulationID)
      assert.notEqual(routesOf(vm).local.status, 'works', row.name)
    }

    return true
  })
  add('save-faults: a copy of the save in memory with a colony short of workers: the route is limited, the lost capacity is named, and the full capacity is unchanged by the lower efficiency', async () => {
    const reference = await pageOf()
    const row = await pick(reference)

    assert.ok(row, 'no colony to cut')

    const full = routesOf(reference).local.figures.full.value
    const rate = routesOf(reference).local.figures.rate.value
    const wasShort = row.workersNow.free < -0.005

    await database.overlay(['create temp table FCT_Population as select * from main.FCT_Population', `update FCT_Population set Population = Population * 0.01, Efficiency = Efficiency * 0.5 where PopulationID = ${row.PopulationID}`])

    try {
      const vm = await pageOf()

      await withTarget(vm, row.PopulationID)

      const local = routesOf(vm).local

      assert.ok(vm.rows.find((item) => item.PopulationID === row.PopulationID).workersNow.free < -0.005 || wasShort)
      assert.notEqual(local.status, 'works')
      assert.ok(local.figures.lostBP > 0 || !(local.figures.rate.value > 0), 'the lost capacity is not named')
      near(local.figures.full.value, full, 1e-6)
      assert.ok(local.figures.rate.value <= rate + 1e-9)
    } finally {
      await database.overlay(['drop table temp.FCT_Population'])
    }

    return true
  })
  add('save-faults: a null construction rating at a candidate makes the engineers\' route unavailable, naming the formation', async () => {
    const reference = await pageOf()
    const row = await pick(reference)

    assert.ok(row)

    const candidate = routesOf(reference).ground.figures.candidates[0].formation
    const [[element]] = await database.query(`select FCT_GroundUnitClass.GroundUnitClassID as id from FCT_GroundUnitFormationElement inner join FCT_GroundUnitClass on FCT_GroundUnitClass.GroundUnitClassID = FCT_GroundUnitFormationElement.ClassID where FCT_GroundUnitFormationElement.FormationID = ${candidate.FormationID} and FCT_GroundUnitClass.ConstructionRating > 0 limit 1`)

    await database.overlay(['create temp table FCT_GroundUnitClass as select * from main.FCT_GroundUnitClass', `update FCT_GroundUnitClass set ConstructionRating = null where GroundUnitClassID = ${element.id}`])

    try {
      const vm = await withTarget(await pageOf(), row.PopulationID)
      const ground = routesOf(vm).ground

      assert.equal(ground.status, 'unavailable')
      assert.ok(ground.limits[0].includes('null for'))
    } finally {
      await database.overlay(['drop table temp.FCT_GroundUnitClass'])
    }

    return true
  })
  add('save-faults: a null commander bonus value makes the engineers\' route unavailable', async () => {
    const reference = await pageOf()
    const row = await pick(reference)

    assert.ok(row)

    const candidate = routesOf(reference).ground.figures.candidates.find((item) => item.formation.commander)

    assert.ok(candidate, 'no commanded candidate')

    await database.overlay(['create temp table FCT_CommanderBonuses as select * from main.FCT_CommanderBonuses', `delete from FCT_CommanderBonuses where BonusID = 5 and CommanderID in (select CommanderID from FCT_Commander where CommandType = 5 and CommandID = ${candidate.formation.FormationID})`, `insert into FCT_CommanderBonuses (CommanderID, BonusID, BonusValue) select CommanderID, 5, null from FCT_Commander where CommandType = 5 and CommandID = ${candidate.formation.FormationID}`])

    try {
      const vm = await withTarget(await pageOf(), row.PopulationID)

      assert.equal(routesOf(vm).ground.status, 'unavailable')
    } finally {
      await database.overlay(['drop table temp.FCT_CommanderBonuses'])
    }

    return true
  })
  add('save-faults: a dropped rating column makes the engineers\' route unavailable and names the column; the other routes stay', async () => {
    const reference = await pageOf()
    const row = await pick(reference)

    assert.ok(row)
    await database.overlay(['create temp table FCT_GroundUnitClass as select * from main.FCT_GroundUnitClass', 'alter table FCT_GroundUnitClass drop column ConstructionRating'])

    try {
      const vm = await withTarget(reference, row.PopulationID)
      const routes = routesOf(vm)

      assert.equal(routes.ground.status, 'unavailable')
      assert.ok(routes.ground.limits[0].includes('FCT_GroundUnitClass.ConstructionRating'))
      assert.notEqual(routes.local.status, 'unavailable')
    } finally {
      await database.overlay(['drop table temp.FCT_GroundUnitClass'])
    }

    return true
  })
  add('save-faults: a save that is not of the 2.7 shape (a dropped game column) makes the engineers\' route unavailable for its version', async () => {
    const reference = await pageOf()
    const row = await pick(reference)

    assert.ok(row)
    await database.overlay(['create temp table FCT_Game as select * from main.FCT_Game', 'alter table FCT_Game drop column AncientRelics'])

    try {
      const vm = await withTarget(await pageOf(), row.PopulationID)

      assert.equal(vm.bootstrapVersion, null)
      assert.equal(routesOf(vm).ground.status, 'unavailable')
    } finally {
      await database.overlay(['drop table temp.FCT_Game'])
    }

    return true
  })
  add('save-faults: with the commander bonus lookup not confirmed the engineers\' route is unavailable, not computed at a bonus of 1', async () => {
    const reference = await pageOf()
    const row = await pick(reference)

    assert.ok(row)

    const vm = await withTarget(await pageOf(database, new Set([5])), row.PopulationID)

    assert.notEqual(routesOf(vm).ground.status, 'limited')

    return true
  })

  return { skipped: false, statements, database }
}

// ---------- the mutations: each must fail the checks it names ----------

const MUTATIONS = [
  { name: 'an understaffed colony given the capacity of a fully staffed one', file: U, find: 'const rate = capacity.now ? idleConstruction(capacity.now, usage) : null', replace: 'const rate = capacity.full ? idleConstruction(capacity.full, usage) : null', fails: ['local', 'page'] },
  { name: 'the shortage of workers not noticed', file: U, find: 'const understaffed = Boolean(workers.now) && workers.now.free < -WORKER_TOLERANCE', replace: 'const understaffed = false', fails: ['local'] },
  { name: 'the lost capacity not worked out', file: U, find: 'const lostBP = isAvailable(full) && isAvailable(rate) ? Math.max(0, full.value - rate.value) : null', replace: 'const lostBP = 0', fails: ['local', 'page'] },
  { name: 'the efficiency left in the full capacity', file: U, find: 'OverallProductionModifier: modifiers.OverallProductionModifier / efficiency', replace: 'OverallProductionModifier: modifiers.OverallProductionModifier', fails: ['local-full', 'page'] },
  { name: 'an efficiency of 0 taken as a full capacity', file: U, find: 'isNumber(efficiency) && efficiency > 0 && isNumber(modifiers.OverallProductionModifier)', replace: 'isNumber(efficiency) && isNumber(modifiers.OverallProductionModifier)', fails: ['local-full'] },
  { name: 'a colony with no capacity given a build time', file: U, find: 'if (!(rate.value > 0)) {', replace: 'if (false) {', fails: ['local'] },
  { name: 'the share the running projects hold ignored', file: U, find: 'export const idleConstruction = (capacity, usage) => freeCapacity(capacity, usage).free', replace: 'export const idleConstruction = (capacity, usage) => freeCapacity(capacity, undefined).free', fails: ['local', 'ground', 'page'] },
  { name: 'the workers of manned mines left out of the mines\' needs', file: U, find: 'const extra = known ? requirement.workers.value : 0', replace: 'const extra = 0', fails: ['local', 'import'] },
  { name: 'unknown workers of the mines left out of the local build', file: U, find: 'const needs = [requirement.bp, requirement.workers]', replace: 'const needs = [requirement.bp]', fails: ['requirements'] },
  { name: 'unknown workers of the mines left out of the import', file: U, find: '[requirement.bp, requirement.tonnes, requirement.workers].filter((result) => !isAvailable(result))', replace: '[requirement.bp, requirement.tonnes].filter((result) => !isAvailable(result))', fails: ['requirements'] },
  { name: 'every type taken as manned', file: U, find: 'manned: isNumber(type.Workers) ? type.Workers > 0 : null', replace: 'manned: true', fails: ['requirements'] },
  { name: 'a type with no workers value taken as automated', file: U, find: 'manned: isNumber(type.Workers) ? type.Workers > 0 : null', replace: 'manned: !(type.Workers > 0) ? false : true', fails: ['requirements'] },
  { name: 'an automated mine charged workers', file: U, find: 'workers: times(type.Workers, `the workers of ${type.Name}`, \'M workers\')', replace: 'workers: times(Math.max(type.Workers, 0.05), `the workers of ${type.Name}`, \'M workers\')', fails: ['requirements'] },
  { name: 'the build cost not times the number', file: U, find: 'isNumber(value) && isNumber(quantity) ? ofRule({ rule, value: value * quantity,', replace: 'isNumber(value) && isNumber(quantity) ? ofRule({ rule, value,', fails: ['requirements', 'local'] },
  { name: 'the freight deficit not worked out', file: U, find: 'deficit: Math.max(0, weight - lift)', replace: 'deficit: 0', fails: ['import'] },
  { name: 'the trips not shared among the ships', file: U, find: 'trips: Math.ceil(estimate.holds / Math.max(1, shipClass.Ships))', replace: 'trips: estimate.holds', fails: ['import'] },
  { name: 'the mines carried as minerals', file: U, find: 'shuttleTechnology, version, \'installations\')', replace: 'shuttleTechnology, version, \'minerals\')', fails: ['import'] },
  { name: 'the cargo kind of the haul ignored', file: H, find: 'CARGO_POINTS[cargo]', replace: 'CARGO_POINTS.minerals', fails: ['haul', 'import'] },
  { name: 'the labour deficit not worked out', file: U, find: 'const shortNow = shortOf(afterNow)', replace: 'const shortNow = 0', fails: ['import', 'local'] },
  { name: 'the labour deficit at the horizon not worked out', file: U, find: 'const shortLater = shortOf(afterLater)', replace: 'const shortLater = 0', fails: ['import'] },
  { name: 'a route with no freighter that runs treated as open', file: U, find: 'const blocked = !best', replace: 'const blocked = false', fails: ['import'] },
  { name: 'an import with a deficit called working', file: U, find: 'status: blocked ? \'blocked\' : gapped ? \'limited\' : \'works\'', replace: 'status: blocked ? \'blocked\' : \'works\'', fails: ['import'] },
  { name: 'a local build with gaps called working', file: U, find: 'status: understaffed || need.gapped ? \'limited\' : \'works\'', replace: 'status: \'works\'', fails: ['local'] },
  { name: 'the builders not ranked by what they can do', file: U, find: 'Number(b.route !== null && b.buildDays !== null) - Number(a.route !== null && a.buildDays !== null)', replace: '0', fails: ['import'] },
  { name: 'a builder with no route given a freight time', file: U, find: 'if (!builder.route) {', replace: 'if (false) {', fails: ['import'] },
  { name: 'a mineral short at the stock not noticed', file: U, find: 'isNumber(stock[item.id]) && stock[item.id] < item.tonnes', replace: 'isNumber(stock[item.id]) && false', fails: ['local', 'import'] },
  { name: 'a stock not read taken as enough', file: U, find: 'const unknown = recipe.filter((item) => !isNumber(stock[item.id]))', replace: 'const unknown = []', fails: ['local'] },
  { name: 'the routes in another order', file: U, find: '  importRoute({ requirement, target, ...importing, format }),\n  localRoute({ requirement, ...local, format }),', replace: '  localRoute({ requirement, ...local, format }),\n  importRoute({ requirement, target, ...importing, format }),', fails: ['compare'] },
  { name: 'an unmapped version taken as mapped', file: U, find: 'if (ruleSupports(\'mineBootstrap.groundAssistance\', version) !== true) {', replace: 'if (false) {', fails: ['ground-unavailable'] },
  { name: 'an unknown version taken as mapped', file: U, find: 'if (ruleSupports(\'mineBootstrap.groundAssistance\', version) !== true) {', replace: 'if (ruleSupports(\'mineBootstrap.groundAssistance\', version) === false) {', fails: ['ground-unavailable'] },
  { name: 'a column the save lacks not named', file: U, find: 'if (ground.gaps.length) {', replace: 'if (false) {', fails: ['ground-unavailable'] },
  { name: 'a null rating or bonus given a figure', file: U, find: 'if (unknown.length || atTarget.unknown.length) {', replace: 'if (false) {', fails: ['ground-unavailable'] },
  { name: 'the capacity of a headquarters ignored', file: U, find: 'total === null || !isNumber(formation.hq) ? null : total > formation.hq ? 0 : 1', replace: 'total === null || !isNumber(formation.hq) ? null : 1', fails: ['ground-command'] },
  { name: 'the subordinates left out of the tonnage of a headquarters', file: U, find: 'const parts = (children[formation.FormationID] || []).map((child) => treeSize(child, children, seen))', replace: 'const parts = []', fails: ['ground-command'] },
  { name: 'the bonus not scaled by the capacity modifier', file: U, find: 'let multiplier = capacity >= 1 ? bonus : 1 + (bonus - 1) * capacity', replace: 'let multiplier = bonus', fails: ['ground-command'] },
  { name: 'a parent at another colony counted', file: U, find: '|| parent.PopulationID !== where ||', replace: '||', fails: ['ground-command'] },
  { name: 'a parent without a commander counted', file: U, find: '|| !parent.commander || seen.has(parent.FormationID)', replace: '|| seen.has(parent.FormationID)', fails: ['ground-command'] },
  { name: 'a parent counted at its whole bonus', file: U, find: 'const PARENT_SHARE = 0.25', replace: 'const PARENT_SHARE = 1', fails: ['ground-command'] },
  { name: 'a parent counted without its capacity modifier', file: U, find: 'multiplier *= 1 + (parent.commander.bonus - 1) * PARENT_SHARE * parentCapacity', replace: 'multiplier *= 1 + (parent.commander.bonus - 1) * PARENT_SHARE', fails: ['ground-command'] },
  { name: 'the chain stopped at the first parent', file: U, find: '    child = parent\n    where = parent.PopulationID', replace: '    return multiplier', fails: ['ground-command'] },
  { name: 'a formation aboard a ship counted', file: U, find: 'formation.PopulationID !== target.PopulationID && !formation.ShipID', replace: 'formation.PopulationID !== target.PopulationID', fails: ['ground'] },
  { name: 'a formation aboard a ship counted at the colony', file: U, find: 'formation.PopulationID === population && !formation.ShipID', replace: 'formation.PopulationID === population', fails: ['ground-command'] },
  { name: 'the engineers at the colony counted twice', file: U, find: 'formation.PopulationID > 0 && formation.PopulationID !== target.PopulationID', replace: 'formation.PopulationID > 0', fails: ['ground'] },
  { name: 'the engineers\' share taken as a fixed total', file: U, find: 'const factorValue = factor.ConstructionProduction * factor.EngineerProductionModifier', replace: 'const factorValue = 5', fails: ['ground'] },
  { name: 'the engineers\' economic modifier left out', file: U, find: 'const factorValue = factor.ConstructionProduction * factor.EngineerProductionModifier', replace: 'const factorValue = factor.ConstructionProduction', fails: ['ground'] },
  { name: 'a route with no troop lift called open', file: U, find: 'if (!(troopCapacity.lift > 0)) {', replace: 'if (false) {', fails: ['ground'] },
  { name: 'a route with no idle capacity called open', file: U, find: 'if (rateWith !== null && isAvailable(rateWith) && !(rateWith.value > 0)) {', replace: 'if (false) {', fails: ['ground'] },
  { name: 'engineers aboard ships not named', file: U, find: 'if (aboard.length) {', replace: 'if (false) {', fails: ['ground'] },
  { name: 'the upper bound not said', file: U, find: 'are excluded by the game and the assignment is not saved, so the figure is an upper bound.', replace: 'are excluded by the game and the assignment is not saved, so the figure is exact.', fails: ['ground'] },
  { name: 'the commander bonus lookup not honoured', file: D, find: 'bonus: blocked.has(PRODUCTION_BONUS) ? null : row.Rows === 0', replace: 'bonus: row.Rows === 0', fails: ['loaders'] },
  { name: 'a null bonus value taken as 1', file: D, find: 'row.Known === 0 ? null : row.BonusValue', replace: 'row.Known === 0 ? 1 : row.BonusValue', fails: ['loaders'] },
  { name: 'a commander with no bonus row taken as unknown', file: D, find: 'row.Rows === 0 ? 1 :', replace: 'row.Rows === 0 ? null :', fails: ['loaders'] },
  { name: 'a naval commander counted for a formation', file: D, find: ' and FCT_Commander.CommanderType in (${GROUND_COMMANDER_TYPES})', replace: '', fails: ['loaders'] },
  { name: 'a commander of a population counted for a formation', file: D, find: 'FCT_Commander.CommandType = ${FORMATION_COMMAND}', replace: 'FCT_Commander.CommandType >= 0', fails: ['loaders'] },
  { name: 'another race\'s commander counted', file: D, find: ' and FCT_Commander.RaceID = ${RaceID}', replace: '', fails: ['loaders'] },
  { name: 'the headquarters capacity summed, not the largest', file: D, find: 'Math.max(best, item.HQCapacity)', replace: 'best + item.HQCapacity', fails: ['loaders'] },
  { name: 'a null rating taken as 0', file: D, find: 'rows.some((row) => read(row) === null || read(row) === undefined || row.Units === null || row.Units === undefined) ? null :', replace: '', fails: ['loaders'] },
  { name: 'a missing column not named', file: D, find: 'if (missing.length) {\n    return { gaps: missing, formations: [] }', replace: 'if (false) {\n    return { gaps: missing, formations: [] }', fails: ['loaders'] },
  { name: 'a technology of another race counted', file: D, find: ' and FCT_RaceTech.RaceID = ${RaceID}', replace: '', fails: ['loaders'] },
  { name: 'a civilian installation offered', file: D, find: 'blocks: isSet(row.CivilianInstallation)', replace: 'blocks: false', fails: ['loaders'] },
  { name: 'an installation that cannot be built offered', file: D, find: 'blocks: isSet(row.NoBuild)', replace: 'blocks: false', fails: ['loaders'] },
  { name: 'an installation that does not mine offered', file: D, find: 'where DIM_PlanetaryInstallation.MiningProductionValue > 0 order by', replace: 'where DIM_PlanetaryInstallation.MiningProductionValue >= 0 order by', fails: ['loaders'] },
  { name: 'a recipe with a null mineral given', file: D, find: 'recipe: MINERALS.some((mineral) => row[`Recipe${mineral.id}`] === null || row[`Recipe${mineral.id}`] === undefined) ? null :', replace: 'recipe: false ? null :', fails: ['loaders'] },
  { name: 'a colony without a body offered', file: D, find: 'inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID ${served', replace: 'left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID ${served', fails: ['loaders'] },
  { name: 'the stock of every mineral read as the first', file: D, find: 'FCT_Population.${mineral.name} as Stock${mineral.id}', replace: 'FCT_Population.Duranium as Stock${mineral.id}', fails: ['loaders'] },
  { name: 'another race\'s projects counted', file: D, find: 'FCT_IndustrialProjects.PopulationID in (select FCT_Population.PopulationID from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID})', replace: '1 = 1', fails: ['loaders'] },
  { name: 'the pause flag not read', file: D, find: '${projects.has(\'Pause\') ? \'FCT_IndustrialProjects.Pause\' : \'null\'} as Paused', replace: 'null as Paused', fails: ['loaders'] },
  { name: 'a class that cannot move counted as a freighter', file: D, find: 'and FCT_ShipClass.MaxSpeed > 1 group by', replace: 'and FCT_ShipClass.MaxSpeed >= 0 group by', fails: ['loaders'] },
  { name: 'a class with no cargo space counted as a freighter', file: D, find: 'and FCT_ShipClass.CargoCapacity > 0 and', replace: 'and FCT_ShipClass.CargoCapacity >= 0 and', fails: ['loaders'] },
  { name: 'the troop lift taken as the largest class', file: D, find: 'classes.reduce((total, item) => total + item.TroopCapacity * item.Ships, 0)', replace: 'classes.reduce((total, item) => Math.max(total, item.TroopCapacity), 0)', fails: ['loaders'] },
  { name: 'a race with no shuttle technology given one', file: D, find: 'row && row.CargoShuttleLoadModifier > 0 ? row.CargoShuttleLoadModifier : null', replace: 'row ? row.CargoShuttleLoadModifier : null', fails: ['loaders'] },
  { name: 'a ground read of a save without a troop column given a lift', file: D, find: 'if (!shipClass.has(\'TroopCapacity\')) {', replace: 'if (false) {', fails: ['loaders'] },
  { name: 'every read made before a colony is picked', file: P, find: 'if (!this.bootstrapColonyId || !this.database || !this.GameID || !this.RaceID) {\n          return NO_BOOTSTRAP_SOURCES', replace: 'if (!this.database || !this.GameID || !this.RaceID) {\n          return NO_BOOTSTRAP_SOURCES', fails: ['page'] },
  { name: 'the formula version read before a colony is picked', file: P, find: 'if (!this.bootstrapColonyId || !this.database) {\n          return null', replace: 'if (!this.database) {\n          return null', fails: ['page'] },
  { name: 'the full capacity not given', file: P, find: 'const full = fullStaffModifiers(mapped || modifiers, target.Efficiency)', replace: 'const full = null', fails: ['page'] },
  { name: 'the builders\' own projects ignored', file: P, find: 'rate: idleConstruction(this.mappedConstruction(row), this.bootstrapUsage[`${row.PopulationID}-construction`])', replace: 'rate: this.mappedConstruction(row)', fails: ['page'] },
  { name: 'the colony\'s workers not passed', file: P, find: 'const workers = { now: target.workersNow, later: target.workersLater, cost: valueOrNull(target.r.cost) }', replace: 'const workers = { now: null, later: null, cost: valueOrNull(target.r.cost) }', fails: ['page'] },
  { name: 'the number of mines ignored', file: P, find: 'mineRequirements(this.bootstrapType, this.bootstrapCount)', replace: 'mineRequirements(this.bootstrapType, 1)', fails: ['page'] },
  { name: 'the troop lift not passed', file: P, find: 'troopCapacity: troops, workers, stock,', replace: 'troopCapacity: null, workers, stock,', fails: ['page'] },
  { name: 'the formula version not passed to the engineers', file: P, find: 'usage, version: this.bootstrapVersion, troopCapacity: troops', replace: 'usage, version: \'2.7.x\', troopCapacity: troops', fails: ['page'] },
  { name: 'the chosen builder ignored', file: P, find: 'this.bootstrapBuilders.find((option) => option.colony.PopulationID === this.bootstrapBuilderId) || this.bootstrapBuilders[0]', replace: 'this.bootstrapBuilders[0]', fails: ['page'] },
  { name: 'the read\'s label under another name', file: P, find: 'bootstrapSources: \'the mine bootstrap reads\'', replace: 'bootstrapSource: \'the mine bootstrap reads\'', fails: ['page'] },
  { name: 'the read tracked under another name', file: P, find: 'tracked(\'bootstrapSources\'', replace: 'tracked(\'bootstrapSource\'', fails: ['page'] },
  { name: 'the data-summary with a figure', file: P, find: 'data-summary="Three ways to add mining capacity', replace: 'data-summary="3 ways to add mining capacity', fails: ['template'] },
  { name: 'the panel without a data-summary', file: P, find: 'class="panel mine-bootstrap" data-summary="', replace: 'class="panel mine-bootstrap" data-sum="', fails: ['template'] },
  { name: 'the foot speaking to a person', file: P, find: 'Each route builds the same number of mines of one type.', replace: 'Each route builds your mines of one type.', fails: ['template'] },
  { name: 'the foot without the unavailable ground route', file: P, find: 'It is unavailable where the save lacks the columns or the version is not 2.7, and the figure', replace: 'The figure', fails: ['template'] },
  { name: 'the missing inputs not shown', file: P, find: '<div v-if="route.missing.length" class="chart-title mt-2">Missing inputs</div>', replace: '', fails: ['template'] },
  { name: 'the limits not shown', file: P, find: '<div v-if="route.limits.length" class="chart-title mt-2">Limits</div>', replace: '', fails: ['template'] },
  { name: 'what works now not shown', file: P, find: '<div v-if="route.worksNow.length" class="chart-title mt-2">Works now</div>', replace: '', fails: ['template'] },
  { name: 'the status of a route not shown', file: P, find: '{{ routeStatus[route.status] }}', replace: '', fails: ['template'] },
  { name: 'the selection kept as a persisted view', file: P, find: '      bootstrapColonyId: null,', replace: '      bootstrapColonyId: 0,', fails: ['template'] },
  { name: 'every route taken as covered by the freighters\' own jump drives', file: U, find: 'const covered = route.ungated === 0 ? true : driveKnown ? fleetCanTransit([{ Size: shipClass.Size, MilitaryEngines: shipClass.MilitaryEngines, Drive: shipClass.Drive, AnyDrive: shipClass.AnyDrive }]) : null', replace: 'const covered = true', fails: ['import-transit'] },
  { name: 'unknown jump drives taken as covering', file: U, find: 'AnyDrive: shipClass.AnyDrive }]) : null', replace: 'AnyDrive: shipClass.AnyDrive }]) : true', fails: ['import-transit'] },
  { name: 'the route over stabilised jump points not offered', file: U, find: 'const detour = covered !== true && gatedRoute', replace: 'const detour = false', fails: ['import-transit'] },
  { name: 'a class that needs a tender taken as needing none', file: U, find: 'const tender = covered === true || detour ? \'none\' : covered === false ? \'required\' : \'unknown\'', replace: 'const tender = \'none\'', fails: ['import-transit'] },
  { name: 'a tender not counted as a limit on the route', file: U, find: 'deficit > 0 || Boolean(tendered) || ', replace: 'deficit > 0 || ', fails: ['import-transit'] },
  { name: 'the tender not listed as missing', file: U, find: '      unread.push(best.transit.tender === \'required\' ? \'A jump-capable tender for the freighters (or stabilised jump points on the route)\' : \'The jump drives of the freighter classes\')', replace: '', fails: ['import-transit'] },
  { name: 'the jump points not stabilised not counted', file: U, find: 'ungated: routeLegs(route).filter((leg) => leg.kind === \'jump\' && !(hasGate(leg.from) && hasGate(leg.to))).length', replace: 'ungated: 0', fails: ['import-transit'] },
  { name: 'a jump point stabilised on one side only taken as stabilised', file: U, find: '!(hasGate(leg.from) && hasGate(leg.to))', replace: '!(hasGate(leg.from) || hasGate(leg.to))', fails: ['import-transit'] },
  { name: 'the route over stabilised jump points taking any jump point', file: U, find: 'transitRule({ gates: true, civilian: false }', replace: 'transitRule({ gates: false, civilian: false }', fails: ['import-transit'] },
  { name: 'the classes that need no tender not preferred', file: U, find: 'const unaided = options.find((option) => option.estimate.status === \'ok\' && option.transit.tender === \'none\') || null', replace: 'const unaided = null', fails: ['import-transit'] },
  { name: 'a type the save does not say it can be built given figures', file: U, find: 'const unknownEligibility = type.eligibility && type.eligibility.length ? type.eligibility : null', replace: 'const unknownEligibility = null', fails: ['requirements'] },
  { name: 'the shortage a colony already has charged to the mines', file: U, find: 'const shortOf = (after) => (after ? Math.min(extra, Math.max(0, -after.free)) : null)', replace: 'const shortOf = (after) => (after ? Math.max(0, -after.free) : null)', fails: ['local'] },
  { name: 'the engineers at the colony counted as the Production page counts them', file: U, find: 'return unknown.length ? { modifiers: null, unknown } : { modifiers: { ...modifiers, GroundConstructionPower: power }, unknown: [] }', replace: 'return { modifiers: { ...modifiers }, unknown: [] }', fails: ['ground-mapped'] },
  { name: 'the mapped engineers worked out for a version the rules are not mapped for', file: U, find: 'if (!modifiers || ruleSupports(\'mineBootstrap.groundAssistance\', version) !== true || ground.gaps.length) {', replace: 'if (!modifiers) {', fails: ['ground-mapped'] },
  { name: 'engineers of unknown rating counted as none in the colony\'s capacity', file: U, find: 'return unknown.length ? { modifiers: null, unknown } : {', replace: 'return {', fails: ['ground-mapped'] },
  { name: 'the colony\'s capacity taken from the Production page', file: P, find: 'const capacityNow = this.mappedConstruction(target)', replace: 'const capacityNow = target.r.construction', fails: ['page'] },
  { name: 'the full capacity worked out without the mapped engineers', file: P, find: 'fullStaffModifiers(mapped || modifiers, target.Efficiency)', replace: 'fullStaffModifiers(modifiers, target.Efficiency)', fails: ['page'] },
  { name: 'the builders\' capacity taken from the Production page', file: P, find: 'idleConstruction(this.mappedConstruction(row), ', replace: 'idleConstruction(row.r.construction, ', fails: ['page'] },
  { name: 'the mapped capacity never used', file: P, find: 'return gap || (mapped ? capacityResult(mapped, \'construction\', this.blockedBonuses) : row.r.construction)', replace: 'return gap || row.r.construction', fails: ['page'] },
  { name: 'the mines\' own needs left out of the engineers\' limits', file: U, find: '  limits.push(...need.limits)\n\n  return { ...route, status: stuck', replace: '  return { ...route, status: stuck', fails: ['ground'] },
  { name: 'the mines\' own gaps left out of the engineers\' missing inputs', file: U, find: '\'Whether the engineers are assigned to fortification work\', ...need.missing,', replace: '\'Whether the engineers are assigned to fortification work\',', fails: ['ground'] },
  { name: 'the colony\'s workers and stock not passed to the engineers\' route', file: P, find: 'troopCapacity: troops, workers, stock, gaps: failed([\'freight\', \'projects\']) }', replace: 'troopCapacity: troops, gaps: failed([\'freight\', \'projects\']) }', fails: ['page'] },
  { name: 'a formation carried by any ship whatever its size', file: U, find: 'const at = rooms.findIndex((room) => room >= candidate.formation.ownSize)', replace: 'const at = rooms.length ? 0 : -1', fails: ['ground-carriage'] },
  { name: 'the largest formation not placed first', file: U, find: '.sort((a, b) => b.formation.ownSize - a.formation.ownSize)', replace: '.sort(() => 0)', fails: ['ground-carriage'] },
  { name: 'the troop ships\' classes not read for the carriage', file: U, find: 'const carriage = troopCapacity && Array.isArray(troopCapacity.classes) ? carryFormations(candidates, troopCapacity) : null', replace: 'const carriage = null', fails: ['ground-carriage'] },
  { name: 'every formation counted as carried', file: U, find: 'const movable = carriage ? [...carriage.carried, ...carriage.later] : candidates', replace: 'const movable = candidates', fails: ['ground-carriage'] },
  { name: 'a route with no formation a ship can carry called open', file: U, find: '} else if (!movable.length && !carriage.unsized.length) {', replace: '} else if (false) {', fails: ['ground-carriage'] },
  { name: 'the build time of the import not given a result', file: P, find: 'result: results.totalDays }', replace: 'result: null }', fails: ['page'] },
  { name: 'the troop capacity not given a result', file: P, find: 'result: results.troop }', replace: 'result: null }', fails: ['page'] },
  { name: 'the efficiency with the mines not given a result', file: P, find: 'result: results.efficiencyAfter }', replace: 'result: null }', fails: ['page'] },
  { name: 'the workers short at the colony not given a result', file: P, find: 'result: labour.existingNow }', replace: 'result: null }', fails: ['page'] },
  { name: 'the engineers\' points not given a result', file: P, find: 'result: results.added }', replace: 'result: null }', fails: ['page'] },
  { name: 'the provenance mark of a figure row not shown', file: P, find: '<provenance-mark v-if="figure.result" :result="figure.result" />', replace: '', fails: ['page'] },
  { name: 'the freight figure not a result', file: U, find: 'results.freight = derived(rule, lifted ? lifted.trips : null,', replace: 'results.freightText = derived(rule, lifted ? lifted.trips : null,', fails: ['results'] },
  { name: 'the troop capacity result with no figure', file: U, find: 'troop: derived(rule, troopNeeded,', replace: 'troop: derived(rule, null,', fails: ['results'] },
  { name: 'the shortage at the colony given no result', file: U, find: 'existingNow: derived(rule, labour.existingNow,', replace: 'existingNow: derived(rule, null,', fails: ['results'] },
  { name: 'the bootstrap reads required of the page', file: C, find: '\'/colony-outlook\': (key) => key === \'bootstrapSources\'', replace: '\'/colony-outlook\': (key) => false && key === \'bootstrapSources\'', fails: ['capabilities'] },
  { name: 'a column of the classes read whether the save has it or not', file: D, find: 'const optional = selectedColumns(\'FCT_ShipClass\', shipClass, [\'ColonistCapacity\', \'Size\', \'EnginePower\', \'FuelEfficiency\', \'FuelCapacity\', \'MilitaryEngines\'])', replace: 'const optional = [\'ColonistCapacity\', \'Size\', \'EnginePower\', \'FuelEfficiency\', \'FuelCapacity\', \'MilitaryEngines\'].map((name) => `FCT_ShipClass.${name} as ${name}`).join(\', \')', fails: ['loaders'] },
  { name: 'the cargo handling read whether the save has it or not', file: D, find: 'const served = hasAll(installation, [\'PlanetaryInstallationID\', \'Name\', \'CargoShuttleValue\']) && hasAll(built, [\'GameID\', \'PopID\', \'PlanetaryInstallationID\', \'Amount\'])', replace: 'const served = true', fails: ['loaders'] },
  { name: 'the shuttle technology read whether the save has it or not', file: D, find: 'if (![\'RaceID\', \'CargoShuttleLoadModifier\'].every((name) => race.has(name))) {', replace: 'if (false) {', fails: ['loaders'] },
  { name: 'the jump drives read whether the save has the function or not', file: D, find: 'const drives = bays && designComponent.has(\'SpecialFunction\')', replace: 'const drives = bays', fails: ['loaders'] },
  { name: 'a read that fails failing every read', file: D, find: '      return fallback', replace: '      throw error', fails: ['loaders'] },
  { name: 'the classes the save cannot list not reported', file: D, find: 'if (freight.gaps.length) {', replace: 'if (false) {', fails: ['loaders'] },
  { name: 'a null flag taken as not set', file: D, find: 'const isSet = (value) => (value === null || value === undefined ? null : Number(value) !== 0)', replace: 'const isSet = (value) => (value === null || value === undefined ? false : Number(value) !== 0)', fails: ['loaders'] },
  { name: 'what the save does not say about a type not recorded', file: D, find: 'eligibility: verdicts.filter((verdict) => verdict.blocks === null).map(', replace: 'eligibility: [].map(', fails: ['loaders'] },
  { name: 'a null required technology taken as none', file: D, find: 'RequiredTechID is null then null when', replace: 'RequiredTechID is null then 1 when', fails: ['loaders'] },
  { name: 'a save without the technology table taken as having no technology', file: D, find: ': \'else null\'} end', replace: ': \'else 0\'} end', fails: ['loaders'] },
  { name: 'a technology the race lacks offered', file: D, find: ': Number(row.Researched) === 0 }', replace: ': false }', fails: ['loaders'] },
  { name: 'the singular of a count never used', file: U, find: '(count === 1 ? one : many)', replace: '(many)', fails: ['text'] },
  { name: 'a day always plural', file: U, find: '${format(shown, decimals)} ${plural(shown, \'day\')}', replace: '${format(shown, decimals)} days', fails: ['text'] },
  { name: 'the page\'s number format not used for figures', file: U, find: 'figure: (value, decimals = 0) => format(value, decimals),', replace: 'figure: (value, decimals = 0) => plainNumber(value, decimals),', fails: ['text'] },
  { name: 'the page\'s number format not used for tonnes', file: U, find: 'tonnes: (value) => `${format(value, 0)} t`,', replace: 'tonnes: (value) => `${plainNumber(value, 0)} t`,', fails: ['text'] },
  { name: 'the page\'s number format not passed to the routes', file: P, find: '        format: (value, decimals) => this.bootstrapNumber(value, decimals),\n', replace: '', fails: ['page'] },
  { name: 'a trip always plural in the figure rows', file: P, find: 'counted(figures.trips, \'trip\')', replace: '`${this.count(figures.trips)} trips`', fails: ['page'] },
  { name: 'the page\'s colony not the panel\'s colony', file: P, find: '        this.expanded = [row]\n        this.bootstrapColonyId = row.PopulationID', replace: '        this.expanded = [row]', fails: ['page'] },
  { name: 'the failed reads not passed to the import', file: P, find: 'workers, gaps: failed([\'freight\', \'jumps\', \'colonies\', \'handling\', \'projects\']) }', replace: 'workers }', fails: ['page'] },
  { name: 'the failed reads not passed to the local route', file: P, find: 'stock, gaps: failed([\'projects\']) }', replace: 'stock }', fails: ['page'] },
  { name: 'the failed reads not passed to the engineers\' route', file: P, find: 'workers, stock, gaps: failed([\'freight\', \'projects\']) }', replace: 'workers, stock }', fails: ['page'] },
  { name: 'the reads that failed not shown in the panel', file: P, find: 'data-bootstrap-problems>', replace: '>', fails: ['page'] },
  { name: 'an unknown fuel input taken as known by the freight estimate', file: U, find: 'const estimate = fuel.length && (timed.status === \'ok\' || timed.status === \'range\') ?', replace: 'const estimate = false ?', fails: ['import-fuel', 'page'] },
  { name: 'the engine power of a class not required of the freight estimate', file: U, find: 'EnginePower: \'the engine power\', ', replace: '', fails: ['import-fuel'] },
  { name: 'the fuel use of a class not required of the freight estimate', file: U, find: 'FuelEfficiency: \'the fuel use per engine power\', ', replace: '', fails: ['import-fuel'] },
  { name: 'the fuel capacity of a class not required of the freight estimate', file: U, find: ', FuelCapacity: \'the fuel capacity\' }', replace: ' }', fails: ['import-fuel'] },
  { name: 'an import with unknown fuel inputs called blocked rather than unavailable', file: U, find: 'if (!best && inputsUnknown.length) {', replace: 'if (false) {', fails: ['import-fuel', 'import-handling', 'page'] },
  { name: 'the unknown fuel inputs of the other classes not named', file: U, find: 'unread.push(...inputsUnknown)', replace: '', fails: ['import-fuel'] },
  { name: 'a formation another lift would carry called too large for any troop ship', file: U, find: 'oversize: sized.filter((candidate) => candidate.formation.ownSize > biggest)', replace: 'oversize: sized.filter((candidate) => !lifts.slice(0, 1).flat().includes(candidate))', fails: ['ground-carriage'] },
  { name: 'a formation of no tonnage waiting forever for room when no bay is there', file: U, find: 'const biggest = Math.max(...bays)', replace: 'const biggest = Math.max(0, ...bays)', fails: ['carriage-return'] },
  { name: 'the formations no bay holds not reported when there is no bay', file: U, find: 'oversize: sized.filter((candidate) => candidate.formation.ownSize > biggest)', replace: 'oversize: sized.filter((candidate) => bays.length && candidate.formation.ownSize > biggest)', fails: ['carriage-return'] },
  { name: 'the formations that wait for another lift dropped', file: U, find: 'later: lifts.slice(1).flat(),', replace: 'later: [],', fails: ['ground-carriage'] },
  { name: 'the formations of a further lift left out of the engineers\' figure', file: U, find: 'const movable = carriage ? [...carriage.carried, ...carriage.later] : candidates', replace: 'const movable = carriage ? carriage.carried : candidates', fails: ['ground-carriage'] },
  { name: 'the further lifts not counted in the text', file: U, find: 'carriage.lifts > 1 ?', replace: 'false ?', fails: ['ground-carriage'] },
  { name: 'the formations that wait for a lift not named', file: U, find: '\'formation waits\', \'formations wait\'', replace: '\'formation\', \'formations\'', fails: ['ground-carriage'] },
  { name: 'the builder selector with a plural for one jump', file: P, find: ' (${builder.route.jumps} ${plural(builder.route.jumps, \'jump\')})', replace: ' (${builder.route.jumps} jumps)', fails: ['page'] },
  { name: 'the hauling time left out of an import that stops before the haul', file: U, find: 'haulDays: derived(rule, null, { units: \'days\', name }), ', replace: '', fails: ['results', 'page'] },
  { name: 'the total time left out of an import that stops before the haul', file: U, find: 'totalDays: derived(rule, null, { units: \'days\', name }), ', replace: '', fails: ['results', 'page'] },
  { name: 'the freight left out of an import that stops before the haul', file: U, find: 'freight: derived(rule, null, { units: \'trips\', name }), labour: labourResults })', replace: 'labour: labourResults })', fails: ['results'] },
  { name: 'the missing fuel inputs not named by the timing results', file: U, find: 'untimed(inputsUnknown.join(\', \'))', replace: 'untimed(\'the haul\')', fails: ['results', 'page'] },
  { name: 'the missing route not named by the timing results', file: U, find: 'untimed(`a charted route from ${builder.colony.PopName} to the colony`)', replace: 'untimed(\'the haul\')', fails: ['results'] },
  { name: 'the freight of an import held for unknown inputs not worked out', file: U, find: 'results: { ...untimed(inputsUnknown.join(\', \')), freight: derived(rule, lifted.trips, { units: \'trips\', name: \'a freighter class that can lift the mines\', present: [\'the cargo capacity of the freighter class\'] }) } }', replace: 'results: untimed(inputsUnknown.join(\', \')) }', fails: ['results'] },
  { name: 'the saved fraction of a formation\'s tonnage dropped by the loader', file: D, find: 'ownSize: size, hq,', replace: 'ownSize: size === null ? null : Math.floor(size), hq,', fails: ['loaders'] },
  { name: 'the headquarters load counting the fraction of a formation\'s tonnage', file: U, find: 'Math.floor(formation.ownSize) + parts', replace: 'formation.ownSize + parts', fails: ['ground-command'] },
  { name: 'a bay with a null count or strength counted as no bay', file: D, find: '(FCT_ClassComponent.NumComponent is null or FCT_ShipDesignComponents.ComponentValue is null)', replace: '(1 = 0)', fails: ['loaders'] },
  { name: 'a class with no bay row left unknown', file: D, find: 'then null else coalesce((select sum(FCT_ClassComponent.NumComponent * FCT_ShipDesignComponents.ComponentValue) ${BAYS}), 0) end', replace: 'then null else (select sum(FCT_ClassComponent.NumComponent * FCT_ShipDesignComponents.ComponentValue) ${BAYS}) end', fails: ['loaders'] },
  { name: 'a service installation with a null amount or value counted as none', file: D, find: 'case when count(*) > count(DIM_PlanetaryInstallation.CargoShuttleValue * FCT_PopulationInstallations.Amount) then null else sum(DIM_PlanetaryInstallation.CargoShuttleValue * FCT_PopulationInstallations.Amount) end', replace: 'sum(DIM_PlanetaryInstallation.CargoShuttleValue * FCT_PopulationInstallations.Amount)', fails: ['loaders'] },
  { name: 'a service installation with a null amount or value left out of the read', file: D, find: '(FCT_PopulationInstallations.Amount is null or FCT_PopulationInstallations.Amount > 0) and (DIM_PlanetaryInstallation.CargoShuttleValue is null or DIM_PlanetaryInstallation.CargoShuttleValue > 0)', replace: 'FCT_PopulationInstallations.Amount > 0 and DIM_PlanetaryInstallation.CargoShuttleValue > 0', fails: ['loaders'] },
  { name: 'a colony with no service installation left unknown', file: D, find: 'case when VIR_Service.PopID is null then 0 else VIR_Service.ShuttleCapacity end', replace: 'VIR_Service.ShuttleCapacity', fails: ['loaders'] },
  { name: 'unknown cargo handling left out of the unknown inputs of the import', file: U, find: 'problem.status === \'unsupported\' && problem.code !== \'fuel\'', replace: 'false', fails: ['import-handling'] },
  { name: 'the engineers with a null figure leaving the capacity to the Production page', file: U, find: 'return unknown.length ? unavailable({ rule: \'mineBootstrap.groundAssistance\', missing: [engineerGap(unknown)], units: \'BP/yr\' }) : null', replace: 'return null', fails: ['page'] },
  { name: 'the colony capacity of the page not taking the unavailable engineers', file: P, find: 'return gap || (mapped ?', replace: 'return (mapped ?', fails: ['page'] },
  { name: 'an unavailable idle capacity of the builder read as none', file: U, find: 'const rate = builder.rate\n\n    if (!rate || !isAvailable(rate)) {', replace: 'const rate = builder.rate\n\n    if (false) {', fails: ['import-capacity'] },
  { name: 'the inputs of an unavailable builder capacity not named', file: U, find: 'const names = rate ? rate.inputs.missing :', replace: 'const names = false ? [] :', fails: ['import-capacity'] },
]

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = {}
const textOf = (file) => (TEXTS[file] = TEXTS[file] || fs.readFileSync(path.join(root, file), 'utf8'))

const sourcesOf = (mutant) => {
  const sources = Object.fromEntries([U, D, H, P, C].map((file) => [file, textOf(file)]))

  if (mutant) {
    sources[mutant.file] = patched(mutant.file, sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

// The functions that make the checks that need no save, in the order they run. Each key's checks are all made by one of them (checked by the head), so a mutation's run calls only theirs.
const BUILDERS = { pure, loaders, page: pageStatements }
const BUILDER_NAMES = Object.keys(BUILDERS)
const builderOf = (key) => (key === 'loaders' ? 'loaders' : ['page', 'template', 'capabilities'].includes(key) ? 'page' : 'pure')
const buildersOf = (keys) => BUILDER_NAMES.filter((name) => keys.some((key) => builderOf(key) === name))

// Whether a run judging `keys` loads the page: for the page's checks and the saves'.
const loadsPage = (keys) => keys.some((key) => key.startsWith('save-')) || buildersOf(keys).includes('page')

const contextOf = async (sources, page = true, mutant = null) => {
  const utilitySources = Object.fromEntries([U, D, H].filter((file) => sources[file] !== textOf(file)).map((file) => [FILES[file], sources[file]]))
  const m = await loadUtilities(NAMES, { stubs: STUBS, sources: utilitySources })
  const ctx = { m, pageText: sources[P], capabilitiesText: sources[C], mutant: mutant ? mutant.id : null }

  if (page) {
    const pageSources = { 'pages/colony-outlook': sources[P], ...Object.fromEntries(Object.entries(utilitySources).map(([name, text]) => [`utilities/${name}`, text])) }

    ctx.pageOptions = await loadPage('pages/colony-outlook', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB }, sources: pageSources })
  }

  return ctx
}

// The context of the head, whose loaded page notes each read: `reader` is the function making its checks (`make <name>`, `make saves`) or the key of the check running (`check <key>`), and `reads` holds the readers.
const traced = (ctx) => {
  const reads = new Set()
  const seen = { ...ctx, reader: null }

  Object.defineProperty(seen, 'pageOptions', {
    enumerable: true,
    get: () => {
      reads.add(seen.reader)

      return ctx.pageOptions
    },
  })

  return { ctx: seen, reads }
}

// The mutations whose run leaves out the page that a check it names, or a function making them, read in the head: none, when `page` says which runs load it.
const leftOut = (reads, page = loadsPage) => MUTATIONS.filter((mutation) => !page(mutation.fails) && [...buildersOf(mutation.fails).map((name) => `make ${name}`), ...mutation.fails.map((key) => `check ${key}`)].some((reader) => reads.has(reader))).map((mutation) => mutation.name)

// Faults planted in the choice of the runs that load the page, which the guard of the page's load must catch.
const LOAD_FAULTS = [
  { name: 'the page loaded only for the saves', page: (keys) => keys.some((key) => key.startsWith('save-')) },
]

// The statements run, as [name, result]; `keys` limits them to the checks of those keys. A traced context hears which check is running.
const runStatements = async (statements, keys = null, ctx = {}) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      ctx.reader = `check ${keyOf(name)}`
      result = await test()
    } catch (error) {
      if (error instanceof HarnessError) {
        throw error
      }

      result = `threw ${String(error.message).split('\n')[0]}`
    }

    results.push([name, result])
  }

  return results
}

// The statements of one run: those that need no save, and the saves' own when `withSaves`.
const statementsOf = async (ctx, withSaves, keys = null, names = BUILDER_NAMES) => {
  const built = names.map((name) => {
    ctx.reader = `make ${name}`

    return [name, BUILDERS[name](ctx)]
  })
  const statements = built.flatMap(([, list]) => list)
  const misplaced = [...new Set(built.flatMap(([name, list]) => list.map(([title]) => keyOf(title)).filter((key) => builderOf(key) !== name).map((key) => `${key} made by ${name}`)))]
  const opened = []
  const skipped = []

  if (withSaves) {
    ctx.reader = 'make saves'

    for (const save of SAVES) {
      const result = await saveStatements(ctx, save)

      if (result.skipped) {
        skipped.push(save.file)
      } else {
        statements.push(...result.statements)
        opened.push(result.database)
      }
    }
  }

  return { statements: statements.filter(([name]) => !keys || keys.includes(keyOf(name))), opened, skipped, misplaced }
}

const checkHead = async (withSaves) => {
  const { ctx, reads } = traced(await contextOf(sourcesOf(null)))
  const { statements, opened, skipped, misplaced } = await statementsOf(ctx, withSaves)

  console.log('\nThe routes to mining capacity at a colony, on colonies, freighters and formations worked by hand, on a database of its own, on the page and on the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  check('mutations: the checks of each key are all made by the function a mutation\'s run calls for that key, so the run judges every check of the keys it names', misplaced.length ? misplaced.join('; ') : true)

  for (const [name, result] of await runStatements(statements, null, ctx)) {
    check(name, result)
  }

  const missing = leftOut(reads)

  check('mutations: a mutation\'s run loads the page whenever a check it names reads it, so no check it names fails for want of the page', missing.length ? missing.join('; ') : true)

  for (const fault of LOAD_FAULTS) {
    check(`mutations: the guard of the page's load catches a fault planted in it: ${fault.name}`, leftOut(reads, fault.page).length ? true : 'no run left out the page its checks read')
  }

  opened.forEach((database) => database.close())
}

const checkMutant = async (mutant) => {
  const began = Date.now()
  let sources

  try {
    sources = sourcesOf(mutant)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `invalid mutant: ${error.message}`)

    return
  }

  const withSaves = mutant.fails.some((key) => key.startsWith('save-'))
  let ctx

  try {
    ctx = await contextOf(sources, loadsPage(mutant.fails), mutant)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  const { statements, opened } = await statementsOf(ctx, withSaves, mutant.fails, buildersOf(mutant.fails))
  const absent = mutant.fails.filter((key) => !statements.some(([name]) => keyOf(name) === key))
  const results = await runStatements(statements, mutant.fails)
  const missed = mutant.fails.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  opened.forEach((database) => database.close())
  check(`mutation caught: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: true, carryProbe: false }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--carry-probe') {
      options.carryProbe = true
    } else if (argv[index] === '--no-saves') {
      options.saves = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.carryProbe) {
    await carryProbe()
  }

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead(options.saves)
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...(options.saves ? [] : ['--no-saves'])], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id], weight: 3 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names')
    wanted.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
