/*
  Checks the shortlist of sites for a deficit mineral on the Mineral Outlook: the surveyed deposits ranked by how soon a first usable load reaches a chosen colony (src/renderer/utilities/deficit-sites.js, src/renderer/components/minerals/DeficitSites.vue, its mount in src/renderer/pages/mineral-outlook.vue and the optional reads in src/renderer/utilities/capabilities.js).

  bun scripts/check-deficit-sites.js [--no-mutations] [--no-saves]

  The utility is run on deposits, colonies, jump points and mines worked by hand, at a carrier speed where one day is 86,400,000 km. What the shortlist explains: the amount, accessibility and distance of a deposit and the four delays of its first delivery (deployment, extraction of a first load, route out and back, depletion) as figures of their own. What changes the rank: a farther site, a slower carrier, a smaller load, a slower build and a ground that gives way to a carrier's limit each move a site past another. What is never listed: a deposit on a body the race has not surveyed (the loader runs on a small in-memory database of its own, with a body only another race surveyed, a body nobody surveyed and a body in a system the race has no survey of), a deposit under a known alien colony, a deposit with nothing left. What is unknown: a site with no explored route, no explored way back, no destination, speed, load, builder, mine type or number of mines has an unknown first delivery, never 0, and is listed after the ranked; a failed read is named and the rest stands. The panel's script runs as a pseudo instance over scripts/lib/page-loader.js with a change of speed, load and drive recalculating the rows, and its template and the page are read as text. The table draws a page of sites at a time and offers no page of every site: hundreds of rows drawn at once make each later frame of the window take seconds (FU-80).

  The saves (saves/AuroraDB.db, saves/AuroraDB_271_skoormit_saved.db, game 138, race 785, and AuroraDB.db, game 140, race 784, read-only; a save that is not there is skipped) give the real loaders, compared with raw counts of the survey tables, and the ranking of real deposits: its order, its arrival times, the routes compared with an independent search of the explored jump points, and the sites the race already works.

  Each mutation of the utility, the panel, the page or the capability table must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const FILES = {
  utility: path.join(root, 'src', 'renderer', 'utilities', 'deficit-sites.js'),
  component: path.join(root, 'src', 'renderer', 'components', 'minerals', 'DeficitSites.vue'),
  page: path.join(root, 'src', 'renderer', 'pages', 'mineral-outlook.vue'),
  capabilities: path.join(root, 'src', 'renderer', 'utilities', 'capabilities.js'),
}
const U = 'utility'
const V = 'component'
const P = 'page'
const C = 'capabilities'
const NAMES = ['deficit-sites', 'mineral-supply', 'mineral-outlook', 'minerals', 'colony-minerals', 'mining-data', 'provenance', 'jump-graph', 'colony-transit', 'production', 'capabilities']
const SAVES = [
  { file: 'saves/AuroraDB.db', game: 138, race: 785 },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
  { file: 'AuroraDB.db', game: 140, race: 784 },
]

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const THEME_STUB = 'export const chartTheme = () => ({ categorical: [], ink: "", inkMuted: "" }); export const withAlpha = (color) => color; export const flowColor = () => ""'
const MIXIN_STUB = 'export default { methods: {}, asyncComputed: {} }'
const STORE = { getters: { config: { get: () => 'Tick' } }, state: {} }

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

const SHORT_LIMIT = Number(process.env.SHORT_LIMIT) || 300
const DROPPED = new Set(['rule', 'inputs', 'assumptions', 'row', 'route', 'site', 'out', 'back', 'sites'])

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

// True, or a text with what differed (the bounded assertion's own, shortened).
const same = (actual, expected) => {
  try {
    assert.deepEqual(actual, expected)

    return true
  } catch (error) {
    return `${short(actual)} != ${short(expected)}`
  }
}

const templateErrors = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed

  return compiler.compileTemplate({ source: descriptor.template.content, filename: 'component.vue', id: 'component' }).errors.map(String)
}

const PRONOUNS = /\b(I|me|my|mine|you|your|we|our)\b/i

// ---------- the world worked by hand ----------

const RACE = 5
const GAME = 1
const KM = 86400000
const SYSTEM = 1

const world = (m) => {
  const { ds, ms, provenance, minerals } = m
  const MINS = minerals.MINERALS
  const value = provenance.valueOrNull
  // A figure to six places, null where it is not known.
  const fig = (result) => { const number = value(result); return number === null ? null : Math.round(number * 1e6) / 1e6 }
  const HOME = { PopulationID: 1, PopName: 'Home', SystemID: SYSTEM, Xcor: 0, Ycor: 0 }
  // 10 automated mines cost 100 BP, weigh 50 t and dig 100 t/yr at accessibility 1.
  const TYPE = { PlanetaryInstallationID: 1, Name: 'Automated Mine', Cost: 10, CargoPoints: 5, Workers: 0, Mining: 1, recipe: null, eligibility: [] }
  const BASIS = { speed: 1000, drive: 'drive', lagrange: false, cargo: 100 }
  const rate = (perYear) => provenance.ofRule({ rule: 'mineBootstrap.localBuild', value: perYear, inputs: { present: ['the idle construction capacity'] }, units: 'BP/yr' })
  const jp = (id, system, link, x, y, over = {}) => ({ WarpPointID: id, SystemID: system, WPLink: link, Distance: 0, Xcor: x, Ycor: y, JumpGateStrength: 0, Explored: 1, MilitaryRestricted: 0, IgnoreForDistance: 0, ...over })
  // System 1 holds Home; the link 11 to 21 leads to system 2. System 3 has no link.
  const JUMPS = [jp(11, 1, 21, KM, 0), jp(21, 2, 11, 0, 0)]
  const SOURCES = { jumpPoints: JUMPS, lagrangePoints: [], classes: [], types: [TYPE], colonies: [HOME], projects: [], race: { MineProduction: 10 }, problems: [] }
  const days = (count) => ({ SystemID: SYSTEM, Xcor: count * KM, Ycor: 0 })
  const deposit = (id, over = {}) => ({ SystemBodyID: id, MaterialID: 1, Amount: 100000, Accessibility: 1, HalfOriginalAmount: 50000, OriginalAcc: 1, SystemID: SYSTEM, Xcor: 0, Ycor: 0, RadiationLevel: 0, Surveyed: 1, AlienColonies: 0, OwnColonies: 1, SystemName: 'Sol', SystemBodyName: null, Component: null, ...over })
  // The new site P, one day from Home: build 100 d, carry 1 d, first load 182.5 d, one day each way.
  const sitePlaced = (id, count, over = {}) => deposit(id, { ...days(count), ...over })
  const colony = (id, name, over = {}) => ({ PopulationID: id, PopName: name, SystemID: SYSTEM, MassDriverDest: 0, Drivers: 0, DriverGaps: 0, DestinationID: null, DestinationName: null, DestinationRaceID: null, DestinationSystemID: null, ...Object.fromEntries(MINS.map(({ name }) => [name, 0])), ...over })
  const toward = (to, over = {}) => ({ MassDriverDest: to.PopulationID, DestinationID: to.PopulationID, DestinationName: to.PopName, DestinationRaceID: RACE, DestinationSystemID: to.SystemID, ...over })
  const surface = (id, name, body, over = {}) => ({ PopulationID: id, PopName: name, SystemID: SYSTEM, SystemName: 'Sol', SystemBodyID: body, MaterialID: 1, MassDriverExport: 0, PurchaseCivilianMinerals: 0, ManualMineCount: 10, AutomatedMineCount: 0, CivilianMineCount: 0, MineProduction: 10, Accessibility: 1, GovernorBonus: 1, SectorBonus: 1, Efficiency: 1, StabilityModifier: 1, PoliticalModifier: 1, RadiationModifier: 1, ...over })
  const packetRow = (id) => ({ PopulationID: id, ...Object.fromEntries(MINS.flatMap(({ name }) => [[name, 0], [`Missing${name}`, 0]])) })
  const supply = ({ surface: surfaceRows, routes, flows = null }) => ms.mineralSupply({ surface: surfaceRows, orbital: [], navalAdmins: {}, routes, packets: {}, cargo: {}, RaceID: RACE, materialId: 1, flows, entries: [] })
  // The race works body `body` with 10 manned mines (100 t/yr) and no route.
  const worked = (body, over = {}) => ds.minedBodies(supply({ surface: [surface(2, 'Mine', body, over)], routes: [colony(1, 'Home'), colony(2, 'Mine')] }).sites)
  const rank = (candidates, over = {}) => ds.rankSites({ candidates, mined: new Map(), destination: HOME, builder: { colony: HOME, rate: rate(365) }, type: TYPE, count: 10, basis: BASIS, sources: SOURCES, ...over })
  const by = (rows, id) => rows.find((row) => row.SystemBodyID === id)
  const order = (rows) => rows.map((row) => row.SystemBodyID)

  return { ds, ms, provenance, value, fig, HOME, TYPE, BASIS, rate, JUMPS, jp, SOURCES, days, deposit, sitePlaced, colony, toward, surface, packetRow, supply, worked, rank, by, order, MINS }
}

// ---------- the checks that need no save ----------

const pure = (ctx) => {
  const w = world(ctx.m)
  const { ds, ms, provenance, value, fig, HOME, TYPE, BASIS, rate, jp, SOURCES, deposit, sitePlaced, colony, toward, surface, supply, worked, rank, by, order } = w
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const unavailable = (result) => !provenance.isAvailable(result)
  const P1 = sitePlaced(10, 1)
  const Q = (count) => sitePlaced(20, count)

  // ----- what the shortlist explains -----
  add('explain: a new site\'s first delivery is its deployment, the dig of a first load and the way out and back, each a figure of its own', () => {
    const row = by(rank([P1]), 10)

    return same([row.state, fig(row.deployment), fig(row.extraction), fig(row.firstLoad), fig(row.out.results.time), fig(row.back.results.time), fig(row.roundTrip), row.eta, fig(row.delivered), fig(row.amount), fig(row.accessibility), row.out.km], ['new', 101, 100, 182.5, 1, 1, 2, 284.5, 100, 100000, 1, KM])
  })
  add('explain: the deployment of a site away from the builder is the build and the carry of the mines, and the carry takes a trip for each load', () => {
    const one = by(rank([P1]), 10)
    const two = by(rank([P1], { basis: { ...BASIS, cargo: 25 } }), 10)
    const built = by(rank([sitePlaced(11, 0)]), 11)

    return same([fig(one.deployment), fig(two.deployment), fig(built.deployment)], [101, 103, 100]) === true && fig(two.firstLoad) === 45.625 ? true : short([one.deployment, two.deployment, built.deployment])
  })
  add('explain: the distance is the route out to the site in kilometres, jumps and astronomical units, and the way across a jump is counted', () => {
    const far = sitePlaced(30, 3, { SystemID: 2, Xcor: 3 * KM })
    const row = by(rank([far]), 30)
    const route = value(row.distance)

    return route && route.km === 4 * KM && route.jumps === 1 && Number.isFinite(route.au) && row.out.state === 'routed' && fig(row.out.results.time) === 4 ? true : short(route)
  })
  add('explain: a site the carrier cannot empty in step with the mines is held to what it carries, and the delivery a year is the smaller', () => {
    const far = by(rank([sitePlaced(40, 100)]), 40)
    const near = by(rank([P1]), 10)

    return same([fig(far.delivered), fig(near.delivered)], [91.25, 100])
  })
  add('explain: every delay and the delivery carry a result of their own rule, and the deposit figures a rule of the deposit', () => {
    const row = by(rank([P1]), 10)
    const rules = ['deployment', 'firstLoad', 'roundTrip', 'depletion', 'firstDelivery', 'delivered'].map((key) => row[key].rule.id)
    const deposits = [row.amount.rule.id, row.accessibility.rule.id]

    return rules.every((id) => id.startsWith('deficitSites.')) && new Set(rules).size === rules.length && deposits.every((id) => id === 'deficitSites.deposit') ? true : short([rules, deposits])
  })
  add('explain: an amount or accessibility the save does not give is unavailable, not 0, and the site is still listed', () => {
    const rows = rank([sitePlaced(50, 1, { Amount: null, Accessibility: null })])
    const row = rows[0]

    return unavailable(row.amount) && unavailable(row.accessibility) && value(row.amount) === null && rows.length === 1 && row.eta === null ? true : short(row)
  })
  add('explain: the mine count and the mine type are the shortlist\'s own, and more mines dig a first load sooner', () => {
    const ten = by(rank([P1]), 10)
    const twenty = by(rank([P1], { count: 20 }), 10)

    return fig(twenty.extraction) === 200 && fig(twenty.firstLoad) === 91.25 && fig(twenty.deployment) === 201 && fig(ten.firstLoad) === 182.5 ? true : short([twenty.extraction, twenty.firstLoad, twenty.deployment])
  })

  // ----- what changes the rank -----
  add('delay: a site that is farther loses to a nearer one, and a different route changes the order', () => {
    const near = order(rank([P1, Q(50)], { mined: worked(20) }))
    const far = order(rank([P1, Q(150)], { mined: worked(20) }))

    return same([near, far], [[20, 10], [10, 20]])
  })
  add('delay: a mine already working has no deployment delay, so it beats a new site at the same distance, and a slow build loses a new site its place', () => {
    const quick = rank([P1, Q(150)], { mined: worked(20) })
    const slow = rank([P1, Q(150)], { mined: worked(20), builder: { colony: HOME, rate: rate(36.5) } })

    return same([order(quick), order(slow), fig(by(slow, 10).deployment), fig(by(slow, 20).deployment), by(slow, 10).eta], [[10, 20], [20, 10], 1001, 0, 1184.5])
  })
  add('delay: the arrival of a worked site is the longer of the first load and the way out, then the way back, and the new site waits for its deployment first', () => {
    const rows = rank([P1, Q(50)], { mined: worked(20) })

    return same([by(rows, 20).eta, by(rows, 10).eta, by(rows, 20).state, fig(by(rows, 20).deployment)], [232.5, 284.5, 'worked', 0])
  })
  add('delay: the ranked are numbered from 1 in the order of their first delivery, and the rest carry no number', () => {
    const rows = rank([P1, Q(50), sitePlaced(21, 70), sitePlaced(22, 5, { SystemID: 9 })], { mined: worked(20) })
    const ranked = rows.filter((row) => row.rank !== null)

    return same(ranked.map((row) => row.rank), ranked.map((_row, index) => index + 1)) === true && ranked.every((row, index) => index === 0 || ranked[index - 1].eta <= row.eta) && rows.filter((row) => row.rank === null).every((row) => row.order > ranked.length) ? true : short(rows.map((row) => [row.SystemBodyID, row.rank, row.eta]))
  })
  add('delay: sites with the same first delivery and delivery a year are ordered by the amount in the deposit, then by name', () => {
    const rows = rank([sitePlaced(31, 1, { Amount: 900000, HalfOriginalAmount: 450000 }), sitePlaced(30, 1, { Amount: 500, HalfOriginalAmount: 250 })])

    return same(order(rows), [31, 30]) === true && rows[0].eta === rows[1].eta ? true : short(rows.map((row) => [row.SystemBodyID, row.eta]))
  })

  // ----- the transport -----
  add('transport: a different speed recalculates every time and flips the rank of a near new site and a far worked one', () => {
    const at = (speed) => rank([P1, Q(50)], { mined: worked(20), basis: { ...BASIS, speed } })
    const fast = at(1000)
    const slow = at(250)

    return same([order(fast), order(slow), by(slow, 10).eta, by(slow, 20).eta, fig(by(slow, 10).roundTrip), fig(by(fast, 10).roundTrip)], [[20, 10], [10, 20], 290.5, 400, 8, 2])
  })
  add('transport: a smaller load needs more trips to carry the mines and digs a first load sooner, so the arrival changes with it', () => {
    const big = by(rank([P1]), 10)
    const small = by(rank([P1], { basis: { ...BASIS, cargo: 25 } }), 10)

    return big.eta !== small.eta && fig(small.deployment) > fig(big.deployment) && fig(small.firstLoad) < fig(big.firstLoad) ? true : short([big.eta, small.eta])
  })
  add('transport: the drive decides which jump points are crossed: a ship without a jump drive reaches no system beyond a point that is not stabilised', () => {
    const far = sitePlaced(30, 3, { SystemID: 2 })
    const withDrive = by(rank([far], { basis: { ...BASIS, drive: 'drive' } }), 30)
    const gates = by(rank([far], { basis: { ...BASIS, drive: 'gates' } }), 30)

    return withDrive.eta !== null && gates.eta === null && gates.out.state === 'needs-drive' && gates.rank === null ? true : short([withDrive.eta, gates.out.state])
  })
  add('transport: no speed, drive or Lagrange choice adds a link: the sites with a known arrival under a ship without a drive are among those with a drive', () => {
    const sites = [P1, Q(50), sitePlaced(30, 3, { SystemID: 2 }), sitePlaced(60, 0, { SystemID: 3 })]
    const known = (basis) => rank(sites, { basis: { ...BASIS, ...basis } }).filter((row) => row.eta !== null).map((row) => row.SystemBodyID).sort()
    const open = known({ drive: 'drive' })
    const narrow = known({ drive: 'gates' })

    return narrow.every((id) => open.includes(id)) && !known({ speed: 5000 }).includes(60) && !known({ lagrange: true }).includes(60) && !open.includes(60) ? true : short([open, narrow])
  })
  add('transport: the page\'s choice of speed, load and drive is the whole of the carrier: the same rows come back for the same choice', () => {
    const a = rank([P1, Q(50)], { mined: worked(20), basis: { ...BASIS, speed: 400 } })
    const b = rank([Q(50), P1], { mined: worked(20), basis: { ...BASIS, speed: 400 } })

    return same(a.map((row) => [row.SystemBodyID, row.eta]), b.map((row) => [row.SystemBodyID, row.eta]))
  })

  // ----- what is never listed -----
  const surveyed = (id, over = {}) => deposit(id, over)
  add('hidden: a deposit on a body the race has not surveyed is not a candidate, a deposit of another mineral is not, and what is left is those surveyed', () => {
    const rows = [surveyed(1), surveyed(2, { Surveyed: 0 }), surveyed(3, { Surveyed: null }), { ...surveyed(4), Surveyed: undefined }, surveyed(5, { MaterialID: 2 }), surveyed(6, { Surveyed: '1' })]
    const found = ds.candidatesOf({ deposits: rows, materialId: 1 })

    return same([found.sites.map((site) => site.SystemBodyID), found.excluded.unsurveyed], [[1], 4])
  })
  add('hidden: a deposit under a known alien colony is left out and one whose alien colonies are not read stays', () => {
    const found = ds.candidatesOf({ deposits: [surveyed(1, { AlienColonies: 1 }), surveyed(2, { AlienColonies: null }), surveyed(3, { AlienColonies: 0 }), surveyed(4, { AlienColonies: 3 })], materialId: 1 })

    return same([found.sites.map((site) => site.SystemBodyID), found.excluded.alienHeld], [[2, 3], 2])
  })
  add('hidden: a deposit with nothing left is left out and one whose amount is not read stays, its depletion unknown', () => {
    const found = ds.candidatesOf({ deposits: [surveyed(1, { Amount: 0 }), surveyed(2, { Amount: null }), surveyed(3, { Amount: 10 }), surveyed(4, { Amount: -5 })], materialId: 1 })

    return same([found.sites.map((site) => site.SystemBodyID), found.excluded.exhausted], [[2, 3], 2])
  })
  add('hidden: the loader reads the deposits of the bodies the race has surveyed only, and counts the colonies on them', async () => {
    const db = await memoryDeposits()
    const loaded = await ds.loadSiteDeposits(db, { GameID: GAME, RaceID: RACE })

    await db.close()

    const ids = loaded.deposits.map((row) => row.SystemBodyID).sort()
    const row = (id) => loaded.deposits.find((item) => item.SystemBodyID === id)

    return same([ids, loaded.problems, loaded.deposits.every((item) => item.Surveyed === 1), [row(1), row(4), row(5)].map((item) => [item.AlienColonies, item.OwnColonies]), row(1).SystemName, row(1).SystemBodyName, row(5).Xcor], [[1, 4, 5], [], true, [[0, 0], [1, 0], [0, 1]], 'Sol', 'Alpha I', 50])
  })
  add('hidden: a shortlist built from the loader lists only surveyed bodies, and the alien-held one never ranks', async () => {
    const db = await memoryDeposits()
    const loaded = await ds.loadSiteDeposits(db, { GameID: GAME, RaceID: RACE })

    await db.close()

    const found = ds.candidatesOf({ deposits: loaded.deposits, materialId: 1 })
    const rows = rank(found.sites)

    return same([order(rows).sort(), found.excluded.alienHeld], [[1, 5], 1])
  })
  add('hidden: a save without the survey table reads no deposit and says what it lacks', async () => {
    const db = await memoryDeposits({ without: 'FCT_SystemBodySurveys' })
    const loaded = await ds.loadSiteDeposits(db, { GameID: GAME, RaceID: RACE })

    await db.close()

    return loaded.deposits.length === 0 && loaded.problems.length === 1 && loaded.problems[0].includes('FCT_SystemBodySurveys') ? true : short(loaded)
  })
  add('hidden: a column or table the save lacks reads as unknown, never 0 or none', async () => {
    const db = await memoryDeposits({ without: ['FCT_AlienPopulation', 'FCT_Population'], dropRadiation: true })
    const loaded = await ds.loadSiteDeposits(db, { GameID: GAME, RaceID: RACE })

    await db.close()

    return loaded.deposits.length === 3 && loaded.deposits.every((row) => row.AlienColonies === null && row.OwnColonies === null && row.RadiationLevel === null && row.Surveyed === 1) ? true : short(loaded.deposits)
  })

  // ----- what is unknown -----
  add('unknown: a site with no explored route has an unknown first delivery, never 0, and is listed after the ranked', () => {
    const rows = rank([sitePlaced(60, 0, { SystemID: 3 }), P1])
    const lost = by(rows, 60)

    return lost.eta === null && lost.rank === null && lost.out.state === 'no-route' && unavailable(lost.firstDelivery) && lost.rankResult.status === 'unavailable' && order(rows)[0] === 10 && order(rows)[1] === 60 ? true : short(rows.map((row) => [row.SystemBodyID, row.eta, row.out.state]))
  })
  add('unknown: a way out that is explored with no explored way back leaves the arrival unknown and the way back named', () => {
    const blind = [jp(11, 1, 21, KM, 0), jp(21, 2, 11, 0, 0, { Explored: 0 })]
    const far = sitePlaced(30, 3, { SystemID: 2, Xcor: 3 * KM })
    const open = by(rank([far]), 30)
    const row = by(rank([far], { sources: { ...SOURCES, jumpPoints: blind } }), 30)

    return open.eta === 290.5 && row.out.state === 'routed' && row.back.state === 'no-route' && row.eta === null && unavailable(row.roundTrip) && row.rank === null ? true : short([open.eta, row.out.state, row.back.state, row.eta])
  })
  add('unknown: a link that is not explored is never crossed, so a site beyond it has no route', () => {
    const closed = [jp(11, 1, 21, KM, 0, { Explored: 0 }), jp(21, 2, 11, 0, 0)]
    const row = by(rank([sitePlaced(30, 3, { SystemID: 2 })], { sources: { ...SOURCES, jumpPoints: closed } }), 30)

    return row.out.state !== 'routed' && row.eta === null ? true : row.out.state
  })
  add('unknown: a body with no position has no route', () => {
    const row = by(rank([sitePlaced(70, 0, { Xcor: null, Ycor: null })]), 70)

    return row.eta === null && row.out.state === 'no-position' ? true : short([row.eta, row.out.state])
  })
  add('unknown: without a destination, a speed, a cargo hold, a drive, a mine type, a number of mines or a builder the arrival is unknown, not 0', () => {
    const cases = { destination: { destination: null }, speed: { basis: { ...BASIS, speed: null } }, cargo: { basis: { ...BASIS, cargo: null } }, drive: { basis: { ...BASIS, drive: null } }, type: { type: null }, count: { count: null }, builder: { builder: null } }
    const rows = Object.entries(cases).map(([name, over]) => [name, by(rank([P1, Q(50)], { mined: worked(20), ...over }), 10)])

    return rows.every(([, row]) => row.eta === null && row.rank === null && row.firstDelivery.status === 'unavailable') ? true : short(rows.map(([name, row]) => [name, row.eta]))
  })
  add('unknown: a missing mine type, number or builder leaves a worked site\'s arrival known, as it does not wait for new mines', () => {
    const row = (over) => by(rank([P1, Q(50)], { mined: worked(20), ...over }), 20)

    return [{ type: null }, { count: null }, { builder: null }].every((over) => row(over).eta === 232.5) && row({ destination: null }).eta === null && row({ basis: { ...BASIS, speed: null } }).eta === null && row({ basis: { ...BASIS, cargo: null } }).eta === null ? true : short([row({ count: null }).eta, row({ basis: { ...BASIS, cargo: null } }).eta])
  })
  add('unknown: a blank number of mines is no number, never 0, and only a whole number above 0 is one', () => {
    const read = ['', ' ', '0', '-3', '2.5', 'x', null, undefined, 10, '10', ' 7 '].map((text) => ds.normaliseCount(text))

    return same(read, [null, null, null, null, null, null, null, null, 10, 10, 7])
  })
  add('unknown: a builder with no idle capacity or no known rate leaves the build unknown, named', () => {
    const none = by(rank([P1], { builder: { colony: HOME, rate: rate(0) } }), 10)
    const blank = by(rank([P1], { builder: { colony: HOME, rate: provenance.unavailable({ rule: 'mineBootstrap.localBuild', missing: ['the colony\'s construction capacity'], units: 'BP/yr' }) } }), 10)

    return none.eta === null && blank.eta === null && unavailable(none.deployment) && unavailable(blank.deployment) && blank.deployment.inputs.missing.length > 0 ? true : short([none.deployment, blank.deployment])
  })
  add('unknown: a site with a position and no route in the way of a mine with no cargo figure has an unknown carry', () => {
    const row = by(rank([P1], { type: { ...TYPE, CargoPoints: null } }), 10)

    return row.eta === null && unavailable(row.deployment) && row.deployment.inputs.missing.some((text) => /cargo/.test(text)) ? true : short(row.deployment)
  })
  add('unknown: the sources load whatever can be read, name each read that failed and never throw, and a project read that failed is not an empty list', async () => {
    const broken = { query: async () => { throw new Error('no such table') } }
    const loaded = await ds.loadDeploymentSources(broken, { GameID: GAME, RaceID: RACE })
    const some = await ds.loadDeploymentSources({ query: async (sql) => { if (/FCT_JumpPoint/.test(sql)) { throw new Error('no such table') } return [[]] } }, { GameID: GAME, RaceID: RACE })
    const noProjects = await ds.loadDeploymentSources({ query: async (sql) => { if (/FCT_IndustrialProjects/.test(sql)) { throw new Error('no such table') } return [[]] } }, { GameID: GAME, RaceID: RACE })
    const read = await ds.loadDeploymentSources({ query: async () => [[]] }, { GameID: GAME, RaceID: RACE })

    return loaded.problems.length === 7 && loaded.problems.every((problem) => problem.source && problem.text) && loaded.jumpPoints.length === 0 && loaded.race.MineProduction === null && some.problems.length === 1 && some.problems[0].source === 'jumps' && loaded.projects === null && noProjects.projects === null && noProjects.problems.length === 1 && noProjects.problems[0].source === 'projects' && Array.isArray(read.projects) && read.projects.length === 0 ? true : short([loaded.problems.map((problem) => problem.source), some.problems, noProjects.projects, noProjects.problems])
  })

  // ----- the depletion -----
  add('deplete: a deposit that holds less than one load is flagged, has no arrival and is not ranked, and is listed after the ranked sites', () => {
    const rows = rank([sitePlaced(80, 0, { Amount: 10, HalfOriginalAmount: 5 }), sitePlaced(81, 5)])
    const empty = by(rows, 80)

    return empty.exhausts === true && empty.rank === null && empty.eta === null && by(rows, 81).exhausts === false && by(rows, 81).rank === 1 && order(rows)[0] === 81 ? true : short(rows.map((row) => [row.SystemBodyID, row.exhausts, row.rank, row.eta]))
  })
  add('deplete: the depletion of a new site starts when the mines stand, and of a worked site at once', () => {
    const rows = rank([P1, Q(50)], { mined: worked(20) })
    const forecast = ctx.m.outlook.depositForecastResult(P1, by(rows, 10).extraction)
    const years = value(forecast).yearsToDepletion

    return near(value(by(rows, 10).depletion), 101 + years * 365) && near(value(by(rows, 20).depletion), value(ctx.m.outlook.depositForecastResult(Q(50), by(rows, 20).extraction)).yearsToDepletion * 365) ? true : short([by(rows, 10).depletion, years])
  })
  add('deplete: a deposit with more in it lasts longer at the same extraction, and a faster build delays the depletion', () => {
    const rich = by(rank([sitePlaced(80, 1, { Amount: 400000, HalfOriginalAmount: 200000 })]), 80)
    const poor = by(rank([sitePlaced(81, 1, { Amount: 40000, HalfOriginalAmount: 20000 })]), 81)

    return value(rich.depletion) > value(poor.depletion) ? true : short([rich.depletion, poor.depletion])
  })
  add('deplete: a deposit whose amount is not read has no depletion, no first load and no rank, and is listed with the unknown', () => {
    const row = by(rank([sitePlaced(50, 1, { Amount: null })]), 50)

    return unavailable(row.depletion) && unavailable(row.firstLoad) && row.exhausts === null && row.eta === null && row.rank === null ? true : short([row.depletion, row.exhausts, row.eta])
  })
  add('deplete: a deposit that holds exactly one load is ranked, and one that holds less is not, whatever its arrival', () => {
    const exact = by(rank([sitePlaced(50, 1, { Amount: 50, HalfOriginalAmount: 25 })]), 50)
    const under = by(rank([sitePlaced(51, 1, { Amount: 49.9, HalfOriginalAmount: 25 })]), 51)

    return exact.exhausts === false && exact.rank === 1 && under.exhausts === true && under.eta === null && under.rank === null && under.notes.length > 0 ? true : short([exact.exhausts, exact.rank, under.exhausts, under.eta, under.rank])
  })
  add('deplete: the first load is dug out of the deposit as its accessibility falls, so a deposit past half its original amount takes longer than the flat rate says', () => {
    const site = sitePlaced(50, 1, { Amount: 60, HalfOriginalAmount: 30 })
    const row = by(rank([site]), 50)
    const days = value(row.firstLoad)
    const dug = (at) => site.Amount - ctx.m.minerals.depositStateAt(site, value(row.extraction), at / 365).amount

    return days > 182.5 && near(dug(days), 50) && dug(days - 1) < 50 ? true : short([days, dug(days), dug(days - 1)])
  })
  add('deplete: a deposit nothing can mine (no extraction under radiation, no accessibility) has no depletion day and no rank, and does not stop the others being ranked', () => {
    const rows = rank([sitePlaced(95, 1, { RadiationLevel: 10000 }), sitePlaced(96, 1, { Accessibility: 0 }), P1])
    const idle = [by(rows, 95), by(rows, 96)]

    return by(rows, 10).rank === 1 && by(rows, 10).eta === 284.5 && idle.every((row) => unavailable(row.depletion) && row.depletion.inputs.missing.length > 0 && row.eta === null && row.rank === null) && order(rows)[0] === 10 ? true : short(rows.map((row) => [row.SystemBodyID, row.rank, row.eta, row.depletion.status]))
  })
  add('cargo: the hold is the carrier\'s figure and a tonne of mineral takes two tonnes of it: the load of a trip, the first load and the trips for the mines follow the hold', () => {
    const hold = (cargo) => by(rank([P1], { basis: { ...BASIS, cargo } }), 10)

    return same([fig(hold(100).firstLoad), fig(hold(200).firstLoad), fig(hold(50).deployment), fig(hold(49).deployment)], [182.5, 365, 101, 103]) === true ? true : short([hold(100).firstLoad, hold(200).firstLoad, hold(50).deployment, hold(49).deployment])
  })
  add('unknown: a carrier with no drive known flies no route, so every arrival is unknown, and the state names the drive', () => {
    const rows = rank([P1, Q(50)], { mined: worked(20), basis: { ...BASIS, drive: null } })

    return rows.every((row) => row.eta === null && row.rank === null && row.out.state === 'no-drive') ? true : short(rows.map((row) => [row.SystemBodyID, row.eta, row.out.state]))
  })

  // ----- the mines the race already works -----
  const baseRoutes = () => {
    const home = colony(1, 'Home', { Drivers: 1 })

    return { home, mine: colony(2, 'Mine', { Drivers: 2, ...toward(home) }), other: colony(3, 'Other', { Drivers: 1 }) }
  }
  const bought = { CivilianMineCount: 20, PurchaseCivilianMinerals: 1, MassDriverExport: 1 }
  const flows = (rows) => ms.transferFlows(rows, 1)
  const deliveryOf = (destinationId, to) => {
    const { home, mine, other } = baseRoutes()
    const target = to === 'other' ? other : home
    const result = supply({ surface: [surface(2, 'Mine', 20, bought)], routes: [home, { ...mine, ...toward(target) }, other], flows: flows([{ PopulationID: 2, MaterialID: 1, MineralDataType: 12, Amount: 40 }]) })

    return by(rank([P1, Q(50)], { mined: ds.minedBodies(result.sites), destination: destinationId === 3 ? { ...HOME, PopulationID: 3 } : HOME }), 20)
  }
  add('supply: a site whose mass-driver route names the chosen colony delivers now: no wait, and the delivery a year is the save\'s supply', () => {
    const row = deliveryOf(1, 'home')

    return row.state === 'delivering' && row.eta === 0 && row.rank === 1 && fig(row.delivered) === 240 && fig(row.deployment) === 0 ? true : short([row.state, row.eta, row.rank, row.delivered])
  })
  add('supply: a site whose route names another colony is mined but hauled by the carrier, and a note says so', () => {
    const row = deliveryOf(1, 'other')

    return row.state === 'worked' && row.eta !== 0 && row.notes.length > 0 ? true : short([row.state, row.eta, row.notes])
  })
  add('supply: a site that delivers to the chosen colony only counts for that colony', () => {
    const row = deliveryOf(3, 'home')

    return row.state === 'worked' ? true : row.state
  })
  const withLedger = (ledger) => {
    const { home, mine, other } = baseRoutes()
    const result = supply({ surface: [surface(2, 'Mine', 20)], routes: [home, { ...mine, ...toward(home) }, other], flows: ledger })

    return by(rank([P1, Q(50)], { mined: ds.minedBodies(result.sites) }), 20)
  }
  add('supply: a route to the chosen colony with no delivery shown (none in the ledger, or no ledger) is not a delivery now: the carrier hauls the output, with a note', () => {
    const none = withLedger(flows([{ PopulationID: 9, MaterialID: 1, MineralDataType: 12, Amount: 40 }]))
    const unread = withLedger(null)
    const shown = withLedger(flows([{ PopulationID: 2, MaterialID: 1, MineralDataType: 12, Amount: 40 }]))

    return [none, unread].every((row) => row.state === 'worked' && row.eta === 232.5 && row.notes.length > 0) && shown.state === 'delivering' && shown.eta === 0 ? true : short([none.state, none.eta, unread.state, unread.eta, shown.state])
  })
  add('worked: a body the race mines is not a new site: no deployment, the extraction of its mines, and nothing wrong for a mine that digs nothing', () => {
    const mined = worked(20)
    const row = by(rank([P1, Q(50)], { mined }), 20)
    const idle = by(rank([Q(50)], { mined: worked(20, { ManualMineCount: 0 }) }), 20)

    return row.state === 'worked' && fig(row.deployment) === 0 && fig(row.extraction) === 100 && idle.state === 'new' ? true : short([row.state, row.deployment, idle.state])
  })
  add('worked: the bodies are grouped by the body, with the mines at it summed', () => {
    const result = supply({ surface: [surface(2, 'Mine', 20), surface(3, 'Mine two', 20, { ManualMineCount: 20 })], routes: [colony(1, 'Home'), colony(2, 'Mine'), colony(3, 'Mine two')] })
    const mined = ds.minedBodies(result.sites)

    return mined.size === 1 && mined.get(20).sites.length === 2 && fig(mined.get(20).extraction) === 300 ? true : short([mined.size, fig(mined.get(20).extraction)])
  })

  // ----- the panel -----
  const { componentText, options } = ctx
  const deposits = [P1, Q(50), sitePlaced(90, 0, { Amount: 0 }), sitePlaced(91, 1, { AlienColonies: 2 })]
  const mount = (data = {}) => instantiate(options, { $store: STORE, data: { mineral: { id: 1, name: 'Duranium' }, supply: null, deposits: { deposits, problems: [] }, sources: SOURCES, builders: [{ colony: HOME, rate: rate(365) }], runway: null, destinationId: 1, speed: 1000, cargo: 100, drive: 'drive', mineCount: '10', lagrange: false, ...data } })
  const supplied = () => supply({ surface: [surface(2, 'Mine', 20)], routes: [colony(1, 'Home'), colony(2, 'Mine')] })
  const keysOf = (vm) => vm.items.map((item) => item.key)

  add('panel: the rows are the surveyed deposits left after the exclusions, ranked, each with its figures as numbers and their results', () => {
    const vm = mount({ supply: supplied() })
    const item = vm.items.find((row) => row.key === '10-1')

    return same(keysOf(vm), ['20-1', '10-1']) === true && same([item.rank, item.order, item.amount, item.accessibility, item.deployment, item.extraction, item.firstLoad, item.roundTrip, item.firstDelivery, item.km], [2, 2, 100000, 1, 101, 100, 182.5, 2, 284.5, KM]) === true && item.firstDeliveryResult.rule.id === 'deficitSites.firstDelivery' ? true : short(vm.items)
  })
  add('panel: a change of the carrier\'s speed, load or drive recalculates the rows and the order', () => {
    const vm = mount({ supply: supplied() })
    const first = keysOf(vm)

    vm.speed = 250

    const slow = keysOf(vm)
    const slowEta = vm.items.find((row) => row.key === '10-1').firstDelivery

    vm.speed = 1000
    vm.cargo = 25

    const small = vm.items.find((row) => row.key === '10-1').firstDelivery

    vm.cargo = 50
    vm.speed = null

    const blank = vm.items.map((row) => row.firstDelivery)

    return same([first, slow, slowEta, small !== 284.5, blank], [['20-1', '10-1'], ['10-1', '20-1'], 290.5, true, [null, null]])
  })
  add('panel: a change of the destination, the builder or the number of mines recalculates the rows', () => {
    const vm = mount({ supply: supplied() })
    const eta = () => vm.items.find((row) => row.key === '10-1').firstDelivery
    const before = eta()

    vm.mineCount = '20'

    const more = eta()

    vm.mineCount = '10'
    vm.builders = [{ colony: HOME, rate: rate(36.5) }]

    const slow = eta()

    vm.destinationId = null

    return before === 284.5 && more !== before && slow === 1184.5 && eta() === null ? true : short([before, more, slow, eta()])
  })
  const classRow = (over) => ({ ShipClassID: 1, ClassName: 'Hauler', MaxSpeed: 1000, CargoCapacity: 100, Size: 100, MilitaryEngines: 0, Drive: 500, AnyDrive: 500, DriveUnknown: 0, AnyDriveUnknown: 0, NoKindDrive: null, NoKindDriveUnknown: 0, ...over })
  const arrival = (vm, key) => vm.items.find((row) => row.key === key).firstDelivery
  add('panel: taking a ship class takes its speed, its cargo hold and its drive, and the mineral load follows the hold', () => {
    const vm = mount({ supply: supplied(), speed: 250, cargo: 25, sources: { ...SOURCES, classes: [classRow({ MaxSpeed: 1000, CargoCapacity: 100 })] } })

    vm.takeClass(1)

    return same([vm.speed, vm.cargo, vm.drive, arrival(vm, '10-1')], [1000, 100, 'drive', 284.5])
  })
  add('panel: a class with no cargo figure leaves the cargo unknown, not the previous carrier\'s, so no first load and no arrival is shown', () => {
    const vm = mount({ supply: supplied(), cargo: 100, sources: { ...SOURCES, classes: [classRow({ CargoCapacity: null }), classRow({ ShipClassID: 2, CargoCapacity: 0 })] } })
    const before = arrival(vm, '10-1')

    vm.takeClass(1)

    const nulled = [vm.cargo, arrival(vm, '10-1'), arrival(vm, '20-1')]

    vm.cargo = 100
    vm.takeClass(2)

    return before === 284.5 && same([nulled, vm.cargo, arrival(vm, '10-1')], [[null, null, null], null, null])
  })
  add('panel: a class whose jump drive cannot be settled leaves the drive unknown, not the previous carrier\'s, so no arrival is shown, and a drive can be set again', () => {
    const vm = mount({ supply: supplied(), drive: 'drive', sources: { ...SOURCES, classes: [classRow({ Size: null })] } })

    vm.takeClass(1)

    const unknown = [vm.drive, arrival(vm, '10-1'), arrival(vm, '20-1'), vm.ranked.every((row) => row.out.state === 'no-drive')]

    vm.setDrive('gates')

    const set = vm.drive

    vm.setDrive(undefined)

    return same([unknown, set, vm.drive], [[null, null, null, true], 'gates', null])
  })
  add('panel: a figure that is not known is null with its result kept, never 0, and the site is listed after the ranked', () => {
    const vm = mount({ supply: supplied(), destinationId: null })

    return vm.items.every((item) => item.firstDelivery === null && item.rank === null && item.firstDeliveryResult.status === 'unavailable' && item.km === null) && vm.items.length === 2 ? true : short(vm.items)
  })
  add('panel: a blank number of mines leaves the new sites unknown and the worked ones known', () => {
    const vm = mount({ supply: supplied(), mineCount: '' })

    return same(vm.items.map((item) => [item.key, item.firstDelivery]), [['20-1', 232.5], ['10-1', null]])
  })
  add('panel: every figure carries a result with a rule, so a mark can show where it came from', () => {
    const vm = mount({ supply: supplied() })
    const columns = ['amount', 'accessibility', 'extraction', 'delivered', 'deployment', 'firstLoad', 'roundTrip', 'depletion', 'firstDelivery']

    return vm.items.every((item) => columns.every((column) => item[`${column}Result`] && item[`${column}Result`].rule) && item.distanceResult.rule && item.rankResult.rule) ? true : short(vm.items[0])
  })
  add('panel: the deposits left out are counted and the read problems are shown', () => {
    const vm = mount({ deposits: { deposits, problems: ['a table is lacking'] }, sources: { ...SOURCES, problems: [{ source: 'jumps', text: 'the jump points could not be read' }] } })

    return same([vm.candidates.excluded.exhausted, vm.candidates.excluded.alienHeld, vm.problemTexts.length], [1, 1, 2])
  })
  add('panel: the unknown sorts last whichever way the table sorts, and the default sort is the rank', () => {
    const vm = mount({ supply: supplied(), mineCount: '' })
    const rows = vm.items
    const keys = (desc) => vm.sortNullLast(rows, ['firstDelivery'], [desc]).map((row) => row.key)

    return same([keys(false), keys(true), vm.sitesTable.sortBy], [['20-1', '10-1'], ['20-1', '10-1'], ['order']])
  })
  add('panel: with no mineral selected there is no row and no throw', () => {
    const vm = mount({ mineral: null })

    return vm.items.length === 0 ? true : short(vm.items)
  })

  // ----- the template, read as text -----
  const tag = (componentText.match(/<v-card\b[^>]*>/) || [''])[0]
  const summary = (tag.match(/data-summary="([^"]*)"/) || [])[1] || ''
  const slots = [...componentText.matchAll(/<template (?:v-for="[^"]*" )?#\[`item\.([^`]*)`\]="\{ item \}">([\s\S]*?)<\/template>/g)].map((match) => ({ column: match[1], body: match[2] }))

  add('panel-template: the panel is a top-level .panel with a data-summary of its own that has no digit and no first or second person', () => (/class="panel[ "]/.test(tag) && /[A-Za-z]/.test(summary) && !/\d/.test(summary) && !PRONOUNS.test(summary) ? true : tag))
  add('panel-template: while the reads behind the shortlist are loading or failed the panel shows their state and not the table, and takes them as props', () => {
    const before = componentText.slice(0, componentText.indexOf('<v-data-table'))
    const gated = /v-else-if="[^"]*\bloading\b[^"]*\bfailed\b[^"]*"[^>]*>\s*<load-state\b/.test(before) && /<\/div>\s*<template v-else>/.test(before)
    const props = ['loading', 'failed', 'error'].every((name) => name in (options.props || {}))

    return gated && props && 'LoadState' in options.components ? true : short([gated, props, Object.keys(options.components)])
  })
  add('panel-template: the template compiles', () => { const errors = templateErrors(componentText); return errors.length ? short(errors) : true })
  add('panel-template: the foot and the labels are in the UI voice: no first or second person', () => {
    const template = (componentText.match(/<template>([\s\S]*)<\/template>\s*<script>/) || [])[1] || ''
    const visible = template.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ')

    return PRONOUNS.test(visible) ? `the template speaks to a person: ${(visible.match(PRONOUNS) || [])[0]}` : true
  })
  add('panel-template: every cell that shows a figure carries a mark of its result: each branch of the rank, distance and figure cells', () => {
    const cells = slots.filter((slot) => ['order', 'km'].includes(slot.column) || slot.column.includes('column'))
    const bare = cells.filter((slot) => (slot.body.match(/<span\b/g) || []).length !== (slot.body.match(/<provenance-mark\b/g) || []).length).map((slot) => slot.column)

    return cells.length === 4 && !bare.length ? true : `${cells.length} cells; no mark in ${bare.join(', ')}`
  })
  add('panel-template: the table keys its rows, sorts the unknown last and has a column for each figure the rows hold', () => {
    const vm = mount({ supply: supplied() })
    const row = vm.items[0]
    const missing = vm.headers.filter((header) => !(header.value in row)).map((header) => header.value)

    return !missing.length && /item-key="key"/.test(componentText) && /:custom-sort="sortNullLast"/.test(componentText) ? true : `columns without a figure: ${missing.join(', ')}`
  })
  add('panel-template: the view fields are kept with the others of the race, the table under its own key', () => {
    const keys = [...componentText.matchAll(/key: '(\w+)'/g)].map((match) => match[1])

    return keys.length === 8 && new Set(keys).size === 8 && /tableView\('deficitSites\w+'/.test(componentText) ? true : short(keys)
  })
  add('panel-template: the table draws a page of sites at a time and offers no page of every site: hundreds of rows drawn at once make each later frame of the window take seconds', () => {
    const vm = mount({ supply: supplied() })
    const table = (componentText.match(/<v-data-table\b[^>]*>/) || [''])[0]
    const sizes = vm.pageSizes || []
    const paged = table.includes(':items-per-page.sync="sitesTable.itemsPerPage"') && table.includes(':footer-props="{ itemsPerPageOptions: pageSizes }"') && !/disable-pagination|hide-default-footer/.test(table)

    return paged && sizes.length > 0 && sizes.every((size) => Number.isInteger(size) && size > 0 && size <= 60) && sizes.includes(vm.sitesTable.itemsPerPage) ? true : short([table, sizes, vm.sitesTable])
  })

  return statements
}

// ---------- the page ----------

const page = (ctx) => {
  const w = world(ctx.m)
  const { ds, provenance, value, HOME } = w
  const { pageText, pageOptions, pageReal, m } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const mountTag = (pageText.match(/<deficit-sites\b[^>]*>/) || [''])[0]
  const labels = (pageText.match(/const INPUT_LABELS = \{([\s\S]*?)\n\}/) || [])[1] || ''
  const labelKeys = [...labels.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])
  const trackedKeys = [...pageText.matchAll(/tracked\('(\w+)'/g)].map((match) => match[1])
  const READS = ['siteDeposits', 'deploymentSources']
  const mount = (data = {}) => instantiate(pageOptions, { $store: STORE, data: { loadErrors: {}, ...data } })

  add('page: the panel is mounted once with the focused mineral, the supply, the deposits, the sources, the builders and the runway, and registered', () => {
    const props = [':mineral="focusMineral"', ':supply="supply"', ':deposits="siteDeposits"', ':sources="deploymentSources"', ':builders="deficitBuilders"', ':runway="focusRunway"', ':loading="shortlistState.loading"', ':failed="shortlistState.failed"', ':error="shortlistState.error"']

    return props.every((prop) => mountTag.includes(prop)) && (pageText.match(/<deficit-sites\b/g) || []).length === 1 && 'DeficitSites' in pageOptions.components ? true : `${mountTag} ${Object.keys(pageOptions.components)}`
  })
  add('page: the panel sits beside the supply panel, inside the forecast gate where every read has loaded', () => {
    const gate = pageText.indexOf('<template v-if="forecastReady">')
    const supplyAt = pageText.indexOf('<mineral-supply')
    const mountAt = pageText.indexOf('<deficit-sites')
    const dialog = pageText.indexOf('<v-dialog v-model="flowsOpen"')

    return gate > 0 && gate < supplyAt && supplyAt < mountAt && mountAt < dialog ? true : [gate, supplyAt, mountAt, dialog].join(' ')
  })
  // The page with the real load-state mixin (the rest of the page's checks stub it out): a read that settles records its state in `loadErrors` as in the app, and the store the mixin writes the freshness to is not under test.
  const mountReal = (data = {}) => instantiate({ mixins: [pageReal], methods: { inputSettled() {} } }, { $store: STORE, data: { loadErrors: {}, game: {}, stockpile: [], packets: [], ledger: [], ...data } })
  const settled = (key) => ({ [key]: null })
  const coreSettled = () => Object.assign({}, ...labelKeys.filter((key) => !READS.includes(key)).map(settled))
  add('page: the runway, forecasts and supply do not wait for the sites panel\'s reads, and a failure of one is shown on that panel alone', async () => {
    const busy = { query: async () => { throw new Error('SQLITE_BUSY') } }
    const vm = mountReal({ loadErrors: coreSettled(), database: busy, GameID: GAME, RaceID: RACE })
    const before = [vm.forecastReady, vm.inputsLoaded, vm.shortlistState.loading]

    await vm.runAsync('siteDeposits').catch(() => {})

    const failed = [vm.forecastReady, vm.failedInputs.length, vm.failedInputsText, vm.shortlistState.failed !== '', vm.shortlistState.loading, vm.shortlistState.error]

    vm.loadErrors.siteDeposits = null
    vm.loadErrors.deploymentSources = null

    const ready = [vm.forecastReady, vm.shortlistState.loading, vm.shortlistState.failed]

    return same([before, failed, ready], [[true, true, true], [true, 0, '', true, false, 'SQLITE_BUSY'], [true, false, '']])
  })
  add('page: a core read that fails still holds back the forecasts, and the sites panel\'s reads in flight or failed give no shortlist', () => {
    const vm = mountReal({ loadErrors: { ...coreSettled(), ledger: 'locked' } })
    const core = [vm.forecastReady, vm.failedInputs, vm.shortlistState.loading]
    const alone = mountReal({ loadErrors: { ...coreSettled(), siteDeposits: null, deploymentSources: 'locked' } }).shortlistState
    const again = mountReal({ loadErrors: { ...coreSettled(), siteDeposits: undefined, deploymentSources: null } }).shortlistState

    return same([core, alone.failed !== '', alone.loading, again.failed, again.loading], [[false, ['ledger'], true], true, false, '', true])
  })
  add('page: the template compiles', () => { const errors = templateErrors(pageText); return errors.length ? short(errors) : true })
  add('page: each read has one name as a tracked key, an asyncComputed and an INPUT_LABELS key, with its default', () => {
    const asyncKeys = Object.keys(pageOptions.asyncComputed)
    const defaults = READS.map((key) => pageOptions.asyncComputed[key] && pageOptions.asyncComputed[key].default)

    return READS.every((key) => labelKeys.includes(key) && trackedKeys.includes(key) && asyncKeys.includes(key)) && trackedKeys.every((key) => asyncKeys.includes(key) && labelKeys.includes(key)) && same(defaults, [ds.NO_SITE_DEPOSITS, ds.NO_DEPLOYMENT_SOURCES]) === true ? true : short([labelKeys, trackedKeys, asyncKeys])
  })
  add('page: the reads are of the race and game selected, and wait for a database, a game and a race', async () => {
    const empty = mount({ database: null, GameID: GAME, RaceID: RACE })
    const none = await empty.runAsync('siteDeposits')
    const noSources = await empty.runAsync('deploymentSources')
    const db = await memoryDeposits()
    const full = mount({ database: db, GameID: GAME, RaceID: RACE })
    const read = await full.runAsync('siteDeposits')

    await db.close()

    return none === ds.NO_SITE_DEPOSITS && noSources === ds.NO_DEPLOYMENT_SOURCES && read.deposits.length === 3 && full.loadErrors.siteDeposits === null ? true : short([none, noSources, read.deposits.length])
  })
  add('page: the builders are the colonies read for the sources, each with the idle construction capacity the page holds for it', () => {
    const capacity = (id) => provenance.ofRule({ rule: 'mineBootstrap.localBuild', value: 500 + id, inputs: { present: ['the capacity'] }, units: 'BP/yr' })
    const vm = mount({ deploymentSources: { ...ds.NO_DEPLOYMENT_SOURCES, colonies: [HOME, { ...HOME, PopulationID: 2, PopName: 'Two' }], projects: [] }, populationCapacityResult: (id) => capacity(id) })
    const builders = vm.deficitBuilders

    return builders.length === 2 && builders.every((entry) => entry.colony && entry.rate) && value(builders[0].rate) !== null && value(builders[0].rate) !== value(builders[1].rate) ? true : short(builders)
  })
  add('page: the builders\' capacity is unknown when the running projects could not be read, and known when they were read and there are none', () => {
    const capacity = (id) => provenance.ofRule({ rule: 'mineBootstrap.localBuild', value: 500 + id, inputs: { present: ['the capacity'] }, units: 'BP/yr' })
    const sources = (projects) => ({ ...ds.NO_DEPLOYMENT_SOURCES, colonies: [HOME], projects })
    const failed = mount({ deploymentSources: sources(null), populationCapacityResult: capacity }).deficitBuilders
    const none = mount({ deploymentSources: sources([]), populationCapacityResult: capacity }).deficitBuilders

    return failed.length === 1 && value(failed[0].rate) === null && failed[0].rate.inputs.missing.length > 0 && none.length === 1 && value(none[0].rate) !== null ? true : short([failed, none])
  })
  add('page: the runway is the focused mineral\'s, with its result, and nothing without a focused row', () => {
    const none = mount({ focusRow: null })
    const some = mount({ focusRow: { runway: 4.5, results: { runway: 'result' } } })

    return none.focusRunway === null && same(some.focusRunway, { years: 4.5, result: 'result' }) === true ? true : short([none.focusRunway, some.focusRunway])
  })
  add('page: the surveyed deposits and the routes for new sites are optional inputs of the Mineral Outlook: the page goes on without them', () => {
    const optional = (key) => m.capabilities.isOptional('/mineral-outlook', key)

    return optional('siteDeposits') && optional('deploymentSources') && !optional('surfaceMining') && !m.capabilities.isOptional('/habitability', 'siteDeposits') ? true : 'the optional reads changed'
  })

  return statements
}

// ---------- the in-memory deposits ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows]))))
const execSql = (raw, sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))
const closeRaw = (raw) => new Promise((resolve) => raw.close(resolve))

// A small save of the tables the loader reads, worked by hand: bodies 1, 4 and 5 are surveyed by race 5 (4 has a known alien colony, 5 a colony of the race), body 2 only by race 6, body 3 by nobody, and body 6 by race 5 in a system it has no survey of. `without` drops tables, `dropRadiation` the radiation column.
const memoryDeposits = async ({ without = [], dropRadiation = false } = {}) => {
  const raw = new sqlite3.Database(':memory:')
  const dropped = new Set([].concat(without))
  const tables = {
    FCT_MineralDeposit: 'create table FCT_MineralDeposit (GameID int, SystemBodyID int, MaterialID int, Amount real, Accessibility real, HalfOriginalAmount real, OriginalAcc real)',
    FCT_SystemBodySurveys: 'create table FCT_SystemBodySurveys (GameID int, SystemBodyID int, RaceID int)',
    FCT_SystemBody: `create table FCT_SystemBody (GameID int, SystemBodyID int, SystemID int, StarID int, ${dropRadiation ? '' : 'RadiationLevel real, '}Xcor real, Ycor real, BodyClass int, PlanetNumber int, OrbitNumber int)`,
    FCT_RaceSysSurvey: 'create table FCT_RaceSysSurvey (GameID int, SystemID int, RaceID int, Name text)',
    FCT_Star: 'create table FCT_Star (StarID int, Component int)',
    FCT_SystemBodyName: 'create table FCT_SystemBodyName (SystemBodyID int, RaceID int, Name text)',
    FCT_Population: 'create table FCT_Population (PopulationID int, GameID int, RaceID int, SystemBodyID int)',
    FCT_AlienPopulation: 'create table FCT_AlienPopulation (GameID int, PopulationID int, ViewingRaceID int)',
  }
  const bodies = [1, 2, 3, 4, 5, 6]
  const rows = [
    ...Object.entries(tables).filter(([table]) => !dropped.has(table)).map(([, sql]) => sql),
    ...bodies.map((id) => `insert into FCT_MineralDeposit values (${GAME}, ${id}, 1, 1000, 1, 500, 1)`),
    ...[1, 4, 5, 6].map((id) => `insert into FCT_SystemBodySurveys values (${GAME}, ${id}, ${RACE})`),
    `insert into FCT_SystemBodySurveys values (${GAME}, 2, 6)`,
    ...bodies.map((id) => `insert into FCT_SystemBody (GameID, SystemBodyID, SystemID, StarID, ${dropRadiation ? '' : 'RadiationLevel, '}Xcor, Ycor) values (${GAME}, ${id}, ${id === 6 ? 2 : 1}, 1, ${dropRadiation ? '' : '0, '}${id * 10}, 0)`),
    `insert into FCT_RaceSysSurvey values (${GAME}, 1, ${RACE}, 'Sol')`,
    'insert into FCT_Star values (1, 1)',
    `insert into FCT_SystemBodyName values (1, ${RACE}, 'Alpha I')`,
    `insert into FCT_Population values (40, ${GAME}, 7, 4)`,
    `insert into FCT_Population values (50, ${GAME}, ${RACE}, 5)`,
    `insert into FCT_AlienPopulation values (${GAME}, 40, ${RACE})`,
    `insert into FCT_AlienPopulation values (${GAME}, 40, 6)`,
  ]
  const statements = rows.filter((sql) => !/^insert into (\w+)/.test(sql) || !dropped.has(sql.match(/^insert into (\w+)/)[1]))

  await execSql(raw, `${statements.join(';\n')};`)

  return { query: (sql) => allRows(raw, sql), close: () => closeRaw(raw) }
}

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

// ---------- the saves ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve({ file: path.basename(resolved), query: (sql) => allRows(raw, sql), close: () => closeRaw(raw) })))
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

const saveStatements = async (ctx, save) => {
  const { m } = ctx
  const { ds, ms, mining, colony: colonyModule, graph, provenance, minerals } = m
  const value = provenance.valueOrNull
  const database = await openSave(save.file)

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const ids = { GameID: save.game, RaceID: save.race }
  const [race] = await rowsOf(database, `select RaceID from FCT_Race where GameID = ${save.game} and RaceID = ${save.race}`)

  if (!race) {
    console.log(`SKIP  ${save.file}: game ${save.game} race ${save.race} is not in the file`)
    await database.close()

    return { skipped: true, statements: [] }
  }

  const label = save.file
  const statements = []
  const add = (name, test) => statements.push([`${name} (${label})`, test])
  const loaded = await ds.loadSiteDeposits(database, ids)
  const sources = await ds.loadDeploymentSources(database, ids)
  const colonies = sources.colonies.filter((colony) => Number.isFinite(colony.Xcor) && Number.isFinite(colony.Ycor))
  const destination = colonies[0]
  const builder = { colony: colonies[colonies.length - 1], rate: provenance.ofRule({ rule: 'mineBootstrap.localBuild', value: 365, inputs: { present: ['a rate of 365 BP/yr'] }, units: 'BP/yr' }) }
  const type = sources.types[0]
  const BASIS = { speed: 1000, drive: 'drive', lagrange: true, cargo: 2000 }
  const surveyed = new Set((await rowsOf(database, `select SystemBodyID from FCT_SystemBodySurveys where RaceID = ${save.race}`)).map((row) => row.SystemBodyID))
  const mineralIds = minerals.MINERALS.slice(0, 2).map((mineral) => mineral.id)
  const surfaceRows = await rowsOf(database, mining.surfaceMiningQuery(ids))
  const routes = await ms.loadSiteRoutes(database, ids)
  const packets = await colonyModule.loadPacketsInFlight(database, ids)
  const rankOf = (materialId, over = {}) => {
    const candidates = ds.candidatesOf({ deposits: loaded.deposits, materialId })
    const result = ms.mineralSupply({ surface: surfaceRows, orbital: [], navalAdmins: {}, routes, packets, cargo: {}, RaceID: save.race, materialId, flows: null, entries: [] })

    return { candidates, rows: ds.rankSites({ candidates: candidates.sites, mined: ds.minedBodies(result.sites), destination, builder, type, count: 10, basis: BASIS, sources, ...over }) }
  }

  add('save-loader: the deposits read are those on the bodies the race has surveyed in the systems it knows, and nothing is left unsaid', async () => {
    const [{ Total: total }] = await rowsOf(database, `select count(*) as Total from FCT_MineralDeposit inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID where FCT_MineralDeposit.GameID = ${save.game} and FCT_MineralDeposit.SystemBodyID in (select SystemBodyID from FCT_SystemBodySurveys where RaceID = ${save.race}) and FCT_SystemBody.SystemID in (select SystemID from FCT_RaceSysSurvey where GameID = ${save.game} and RaceID = ${save.race})`)

    return loaded.deposits.length === total && loaded.problems.length === 0 && sources.problems.length === 0 && total > 0 ? true : `${loaded.deposits.length} rows of ${total}: ${short([loaded.problems, sources.problems])}`
  })
  add('save-hidden: no deposit is read of a body the race has not surveyed, whatever the mineral, and the shortlist never holds more than the save does', async () => {
    const [{ Total: every }] = await rowsOf(database, `select count(*) as Total from FCT_MineralDeposit where GameID = ${save.game}`)
    const leaked = loaded.deposits.filter((row) => !surveyed.has(row.SystemBodyID))
    const found = mineralIds.map((id) => rankOf(id).rows.filter((row) => !surveyed.has(row.SystemBodyID)).length)

    return leaked.length === 0 && found.every((count) => count === 0) && loaded.deposits.length <= every ? true : `${leaked.length} deposits of unsurveyed bodies of ${every}: ${short(found)}`
  })
  add('save-alien: no listed site stands under a known alien colony', async () => {
    const aliens = new Set((await rowsOf(database, `select FCT_Population.SystemBodyID from FCT_AlienPopulation inner join FCT_Population on FCT_Population.PopulationID = FCT_AlienPopulation.PopulationID where FCT_AlienPopulation.GameID = ${save.game} and FCT_AlienPopulation.ViewingRaceID = ${save.race}`)).map((row) => row.SystemBodyID))
    const listed = mineralIds.flatMap((id) => rankOf(id).rows.filter((row) => aliens.has(row.SystemBodyID)))

    return listed.length === 0 ? true : short(listed.map((row) => row.SystemBodyID))
  })
  add('save-rank: every candidate is listed once, the ranked come first by first delivery from 1 and none is ranked with an unknown arrival', async () => {
    const problems = []

    for (const id of mineralIds) {
      const { candidates, rows } = rankOf(id)
      const ranked = rows.filter((row) => row.rank !== null)
      const ids = rows.map((row) => row.key)

      if (new Set(ids).size !== candidates.sites.length || ids.length !== candidates.sites.length) {
        problems.push(`${id}: ${ids.length} rows of ${candidates.sites.length} candidates`)
      }

      if (!ranked.every((row, index) => row.rank === index + 1 && row.eta !== null && (index === 0 || ranked[index - 1].eta <= row.eta)) || !rows.slice(ranked.length).every((row) => row.rank === null)) {
        problems.push(`${id}: the order`)
      }
    }

    return problems.length ? problems.join('; ') : true
  })
  add('save-arrival: a site with a way out and a way back, a load and mines or a route of the save has an arrival no shorter than its round trip, and one with no explored way has none', async () => {
    const problems = []

    for (const id of mineralIds) {
      for (const row of rankOf(id).rows) {
        const routed = row.out.state === 'routed' && row.back.state === 'routed'

        if (row.state !== 'delivering' && row.eta !== null && (!routed || row.eta < value(row.roundTrip) - 1e-9)) {
          problems.push(`${id}/${row.SystemBodyID}: ${row.eta} against ${short(row.roundTrip)}`)
        }

        if (row.state !== 'delivering' && !routed && row.eta !== null) {
          problems.push(`${row.SystemBodyID}: an arrival without a route`)
        }
      }
    }

    return problems.length ? problems.slice(0, 3).join('; ') : true
  })
  add('save-speed: a faster carrier never lengthens a known arrival and never adds a route, and none gives an unknown arrival to every site that is not already delivering', async () => {
    const problems = []

    for (const id of mineralIds) {
      const slow = rankOf(id, { basis: { ...BASIS, speed: 1000 } }).rows
      const fast = rankOf(id, { basis: { ...BASIS, speed: 2000 } }).rows
      const none = rankOf(id, { basis: { ...BASIS, speed: null } }).rows
      const fastBy = new Map(fast.map((row) => [row.key, row]))

      slow.forEach((row) => {
        const quick = fastBy.get(row.key)

        if ((row.eta === null) !== (quick.eta === null) || (row.eta !== null && quick.eta > row.eta + 1e-9)) {
          problems.push(`${row.key}: ${row.eta} at 1000, ${quick.eta} at 2000`)
        }
      })

      if (!none.every((row) => row.state === 'delivering' || row.eta === null)) {
        problems.push(`${id}: an arrival with no speed`)
      }
    }

    return problems.length ? problems.slice(0, 3).join('; ') : true
  })
  add('save-route: the distances are those of an independent search of the explored jump points, out and back', async () => {
    const places = (point) => ({ SystemID: point.SystemID, Xcor: point.Xcor, Ycor: point.Ycor })
    const options = { order: 'km', lagrangePoints: sources.lagrangePoints }
    const from = graph.searchRoutes(sources.jumpPoints, [places(destination)], options)
    const problems = []
    let compared = 0

    for (const id of mineralIds) {
      const routed = rankOf(id).rows.filter((row) => row.out.state === 'routed')

      for (const row of routed.filter((_item, index) => index % 20 === 0).slice(0, 12)) {
        const way = from.toPlace(places(row.site))
        const back = graph.searchRoutes(sources.jumpPoints, [places(row.site)], options).toPlace(places(destination))

        compared++

        if (!way || Math.abs(way.km - row.out.km) > 1e-6 * Math.max(1, way.km) || (row.back.state === 'routed') !== Boolean(back) || (back && Math.abs(back.km - row.back.km) > 1e-6 * Math.max(1, back.km))) {
          problems.push(`${row.SystemBodyID}: ${row.out.km} against ${way && way.km}`)
        }
      }
    }

    return problems.length ? problems.slice(0, 3).join('; ') : compared > 0 ? true : 'no routed site to compare'
  })
  add('save-worked: a body the race mines now is a worked or delivering site with no deployment, and a body no mine works is a new site', async () => {
    const problems = []

    for (const id of mineralIds) {
      const result = ms.mineralSupply({ surface: surfaceRows, orbital: [], navalAdmins: {}, routes, packets, cargo: {}, RaceID: save.race, materialId: id, flows: null, entries: [] })
      const mined = ds.minedBodies(result.sites)

      for (const row of rankOf(id).rows) {
        const found = mined.get(row.SystemBodyID)
        const digging = found && provenance.isAvailable(found.extraction) && found.extraction.value > 0

        if (digging && (row.state === 'new' || value(row.deployment) !== 0)) {
          problems.push(`${row.SystemBodyID}: mined and read as ${row.state}`)
        }

        if (!found && row.state !== 'new') {
          problems.push(`${row.SystemBodyID}: not mined and read as ${row.state}`)
        }
      }
    }

    return problems.length ? problems.slice(0, 3).join('; ') : true
  })

  return { skipped: false, statements, close: () => database.close() }
}

// ---------- the planted faults ----------

// A planted fault and the checks that must fail for it: each name is the key of a check (the text before its colon), and the fault is caught only when every one of them fails.
/* eslint-disable no-template-curly-in-string */
const MUTATIONS = [
  { name: 'a body the race has not surveyed taken as a candidate', file: U, find: 'if (deposit.Surveyed !== 1) {', replace: 'if (false) {', fails: ['hidden'] },
  { name: 'a deposit under an alien colony taken as a candidate', file: U, find: '} else if (isNumber(deposit.AlienColonies) && deposit.AlienColonies > 0) {', replace: '} else if (false) {', fails: ['hidden', 'save-alien'] },
  { name: 'an exhausted deposit taken as a candidate', file: U, find: '} else if (isNumber(deposit.Amount) && deposit.Amount <= 0) {', replace: '} else if (false) {', fails: ['hidden'] },
  { name: 'every deposit read, surveyed or not', file: U, find: ' and FCT_MineralDeposit.SystemBodyID in (${surveyed})', replace: '', fails: ['hidden', 'save-hidden'] },
  { name: 'the way back left out of the first delivery', file: U, find: 'compute: (values) => Math.max(values.deployment + values.firstLoad, values.out) + values.back', replace: 'compute: (values) => Math.max(values.deployment + values.firstLoad, values.out)', fails: ['explain', 'delay'] },
  { name: 'the way out waited for after the first load is dug', file: U, find: 'compute: (values) => Math.max(values.deployment + values.firstLoad, values.out) + values.back', replace: 'compute: (values) => values.deployment + values.firstLoad + values.out + values.back', fails: ['delay'] },
  { name: 'the way back taken as the way out', file: U, find: 'const back = destination ? flight(here, destination) : noFlight(\'a destination colony\')', replace: 'const back = destination ? flight(destination, here) : noFlight(\'a destination colony\')', fails: ['unknown'] },
  { name: 'the ranked ordered by the longest arrival', file: U, find: '(group(a) === 0 ? a.eta - b.eta : 0)', replace: '(group(a) === 0 ? b.eta - a.eta : 0)', fails: ['delay'] },
  { name: 'an unknown arrival read as 0', file: U, find: 'eta: valueOrNull(firstDelivery),', replace: 'eta: valueOrNull(firstDelivery) ?? 0,', fails: ['unknown'] },
  { name: 'a site with an unknown arrival ranked with the others', file: U, find: 'const group = (row) => (row.exhausts === true ? 1 : row.eta === null ? 2 : 0)', replace: 'const group = (row) => (row.exhausts === true ? 1 : row.eta === null ? 0 : 0)', fails: ['unknown'] },
  { name: 'the carry left out of the deployment', file: U, find: 'compute: (values) => values.build + values.carry', replace: 'compute: (values) => values.build', fails: ['explain', 'delay'] },
  { name: 'one trip to carry the mines whatever the hold', file: U, find: 'const trips = Math.ceil(tonnes.value / cargo)', replace: 'const trips = 1', fails: ['explain', 'transport', 'cargo'] },
  { name: 'a new site with no deployment', file: U, find: 'const deployment = state === \'new\' ? deploymentOf(', replace: 'const deployment = state === \'new\' && false ? deploymentOf(', fails: ['explain', 'delay'] },
  { name: 'the carrier\'s limit left out of the delivery a year', file: U, find: 'Math.min(values.extraction, (values.load * DAYS_PER_YEAR) / values.roundTrip)', replace: 'values.extraction', fails: ['explain'] },
  { name: 'the amount of the deposit left out of the tie-break', file: U, find: 'larger(valueOrNull(a.amount), valueOrNull(b.amount))', replace: '0', fails: ['delay'] },
  { name: 'a deposit that holds exactly one load flagged as empty', file: U, find: 'isNumber(site.Amount) ? site.Amount < load.value : null', replace: 'isNumber(site.Amount) ? site.Amount <= load.value : null', fails: ['deplete'] },
  { name: 'the depletion counted from the day of the order, not from the deployment', file: U, find: 'values.deployment + values.forecast.yearsToDepletion * DAYS_PER_YEAR', replace: 'values.forecast.yearsToDepletion * DAYS_PER_YEAR', fails: ['deplete'] },
  { name: 'every route of the save taken as the chosen colony\'s', file: U, find: '(found.deliveries[destination.PopulationID] || [])', replace: 'Object.values(found.deliveries).flat()', fails: ['supply'] },
  { name: 'a body the race mines read as a new site', file: U, find: 'const working = found !== null && (!isAvailable(found.extraction) || found.extraction.value > 0)', replace: 'const working = false', fails: ['worked', 'delay', 'save-worked'] },
  { name: 'a mine count of 0 taken as a number', file: U, find: 'return Number.isInteger(count) && count > 0 ? count : null', replace: 'return Number.isInteger(count) && count >= 0 ? count : null', fails: ['unknown'] },
  { name: 'a failed read thrown instead of named', file: U, find: 'return fallback', replace: 'throw error', fails: ['unknown'] },
  { name: 'the carrier\'s speed ignored for the route', file: U, find: 'const chosen = { speed: normaliseSpeed(basis.speed),', replace: 'const chosen = { speed: normaliseSpeed(1000),', fails: ['transport', 'save-speed'] },
  { name: 'the carrier\'s cargo hold ignored', file: U, find: 'const cargoValue = normaliseSpeed(basis.cargo)', replace: 'const cargoValue = normaliseSpeed(100)', fails: ['transport', 'explain', 'unknown', 'cargo'] },
  { name: 'the hold taken as the tonnes of mineral a trip takes', file: U, find: 'value: cargo / CARGO_PER_MINERAL', replace: 'value: cargo', fails: ['cargo', 'explain'] },
  { name: 'a carrier with no drive known flying as if it had one', file: U, find: 'basis.drive === \'drive\' || basis.drive === \'gates\' ? from(origin)', replace: 'true ? from(origin)', fails: ['unknown'] },
  { name: 'a failed read of the projects read as none', file: U, find: 'attempt(\'projects\', () => loadBootstrapProjects(database, ids), null)', replace: 'attempt(\'projects\', () => loadBootstrapProjects(database, ids), [])', fails: ['unknown'] },
  { name: 'a route that shows no delivery taken as delivering now', file: U, find: '.filter((entry) => isAvailable(entry.supply) && entry.supply.value > 0)', replace: '.filter((entry) => !isAvailable(entry.supply) || entry.supply.value >= 0)', fails: ['supply'] },
  { name: 'a route with a supply that is not read taken as delivering now', file: U, find: '.filter((entry) => isAvailable(entry.supply) && entry.supply.value > 0)', replace: '.filter((entry) => !isAvailable(entry.supply) || entry.supply.value > 0)', fails: ['supply'] },
  { name: 'the first load dug at the flat rate whatever the accessibility', file: U, find: '  return high\n}', replace: '  return flat\n}', fails: ['deplete'] },
  { name: 'a deposit holding less than one load not flagged', file: U, find: 'isNumber(site.Amount) ? site.Amount < load.value : null', replace: 'isNumber(site.Amount) ? site.Amount < 0 : null', fails: ['deplete'] },
  { name: 'a deposit holding less than one load given an arrival', file: U, find: '  } else if (isAvailable(load) && isNumber(site.Amount) && site.Amount < load.value) {', replace: '  } else if (false) {', fails: ['deplete'] },
  { name: 'the carrier\'s drive ignored', file: U, find: 'drive: basis.drive, lagrange: basis.lagrange }', replace: 'drive: \'drive\', lagrange: basis.lagrange }', fails: ['transport'] },
  { name: 'the panel without its summary', file: V, find: 'data-summary="', replace: 'data-sum="', fails: ['panel-template'] },
  { name: 'the panel showing the shortlist while its reads are loading or failed', file: V, find: 'v-else-if="loading || failed"', replace: 'v-else-if="false"', fails: ['panel-template'] },
  { name: 'a figure of the panel without its mark', file: V, find: '{{ duration(item[column]) }}<provenance-mark :result="item[`${column}Result`]" />', replace: '{{ duration(item[column]) }}', fails: ['panel-template'] },
  { name: 'the panel\'s carrier cargo never reaching the ranking', file: V, find: 'return { speed: this.speed, drive: this.drive, lagrange: this.lagrange, cargo: this.cargo }', replace: 'return { speed: this.speed, drive: this.drive, lagrange: this.lagrange, cargo: 100 }', fails: ['panel'] },
  { name: 'the panel\'s number of mines fixed', file: V, find: 'count: this.mines,', replace: 'count: 10,', fails: ['panel'] },
  { name: 'a ship class\'s unsettled drive keeping the previous carrier\'s', file: V, find: 'this.drive = driveOfClass(found)', replace: 'this.drive = driveOfClass(found) || this.drive', fails: ['panel'] },
  { name: 'a ship class with no cargo keeping the previous carrier\'s hold', file: V, find: 'this.cargo = normaliseSpeed(found.CargoCapacity)', replace: 'this.cargo = normaliseSpeed(found.CargoCapacity) || this.cargo', fails: ['panel'] },
  { name: 'a ship class\'s cargo not taken at all', file: V, find: 'this.cargo = normaliseSpeed(found.CargoCapacity)', replace: '', fails: ['panel'] },
  { name: 'a drive that cannot be set to unknown again', file: V, find: 'this.drive = DRIVE_IDS.includes(value) ? value : null', replace: 'this.drive = DRIVE_IDS.includes(value) ? value : this.drive', fails: ['panel'] },
  { name: 'the page reading builders\' capacity as known when the projects were not read', file: P, find: 'const usage = projects ? industryUsage(projects) : null', replace: 'const usage = industryUsage(projects || [])', fails: ['page'] },
  { name: 'the page without a label for the deposits', file: P, find: '  siteDeposits: \'the surveyed deposits\',', replace: '', fails: ['page'] },
  { name: 'the page reading the sources with no database', file: P, find: '!this.database || !this.GameID || !this.RaceID) {\n          return NO_SITE_DEPOSITS', replace: 'false) {\n          return NO_SITE_DEPOSITS', fails: ['page'] },
  { name: 'a deposit nothing can mine given a depletion day', file: U, find: 'const depletion = idle ? unavailable(', replace: 'const depletion = false ? unavailable(', fails: ['deplete'] },
  { name: 'the forecasts waiting for the sites panel\'s reads', file: P, find: 'return allLoaded(this.loadErrors, CORE_INPUTS)', replace: 'return allLoaded(this.loadErrors, Object.keys(INPUT_LABELS))', fails: ['page'] },
  { name: 'a failure of the sites panel\'s reads counted with the forecasts\'', file: P, find: 'return CORE_INPUTS.filter((key) => this.loadErrors[key])', replace: 'return Object.keys(INPUT_LABELS).filter((key) => this.loadErrors[key])', fails: ['page'] },
  { name: 'the sites panel\'s reads in flight not shown as loading', file: P, find: 'loading: failed.length === 0 && !allLoaded(this.loadErrors, OPTIONAL_INPUTS)', replace: 'loading: false', fails: ['page'] },
  { name: 'the sources a required input of the page', file: C, find: 'key === \'siteDeposits\' || key === \'deploymentSources\'', replace: 'key === \'siteDeposits\'', fails: ['page'] },
  { name: 'the sites table drawn whole, with no pages', file: V, find: ':items-per-page.sync="sitesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense', replace: 'dense disable-pagination hide-default-footer', fails: ['panel-template'] },
  { name: 'a page of every site offered', file: V, find: 'const PAGE_SIZES = [15, 30, 60]', replace: 'const PAGE_SIZES = [15, 30, 60, -1]', fails: ['panel-template'] },
]
/* eslint-enable no-template-curly-in-string */

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, () => fs.readFileSync(file, 'utf8')]))

// The sources one run reads: the real ones, or the real ones with one planted fault.
const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((name) => [name, TEXTS[name]()]))

  if (mutant) {
    sources[mutant.file] = patched(path.basename(FILES[mutant.file]), sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

const contextOf = async (sources) => {
  const changed = (name) => sources[name] !== TEXTS[name]()
  const sourcesFor = { ...(changed(U) ? { 'deficit-sites': sources[U] } : {}), ...(changed(C) ? { capabilities: sources[C] } : {}) }
  const utilitySources = { ...(changed(U) ? { 'utilities/deficit-sites': sources[U] } : {}), ...(changed(C) ? { 'utilities/capabilities': sources[C] } : {}) }
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: sourcesFor })
  const modules = { 'components/charts/theme': THEME_STUB, 'mixins/production-modifiers': MIXIN_STUB }
  const options = await loadPage('components/minerals/DeficitSites', { stubs: STUBS, sources: { 'components/minerals/DeficitSites': sources[V], ...utilitySources } })
  const pageOptions = await loadPage('pages/mineral-outlook', { stubs: STUBS, modules, sources: { 'pages/mineral-outlook': sources[P], ...utilitySources } })
  const pageReal = await loadPage('pages/mineral-outlook', { stubs: STUBS, modules: { ...modules, 'mixins/load-state': null }, sources: { 'pages/mineral-outlook': sources[P], ...utilitySources } })

  return { m: { ds: loaded['deficit-sites'], ms: loaded['mineral-supply'], outlook: loaded['mineral-outlook'], minerals: loaded.minerals, colony: loaded['colony-minerals'], mining: loaded['mining-data'], provenance: loaded.provenance, graph: loaded['jump-graph'], capabilities: loaded.capabilities }, options, pageOptions, pageReal, componentText: sources[V], pageText: sources[P] }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

// The statements run, as [name, result]; `keys` limits them to the checks of those keys.
const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

let useSaves = true

const statementsOf = async (ctx, withSaves) => {
  const statements = [...pure(ctx), ...page(ctx)]
  const opened = []
  const skipped = []

  if (withSaves && useSaves) {
    for (const save of SAVES) {
      const read = await saveStatements(ctx, save)

      if (read.skipped) {
        skipped.push(save.file)
      } else {
        statements.push(...read.statements)
        opened.push(read)
      }
    }
  }

  return { statements, opened, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, opened, skipped } = await statementsOf(ctx, true)

  console.log('\nDeficit sites: the surveyed deposits of a mineral ranked by first usable delivery, on deposits, mines and routes worked by hand, the panel, the page and the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  const keys = new Set(statements.map(([name]) => keyOf(name)))
  const bare = MUTATIONS.filter((mutation) => !mutation.fails.some((key) => !key.startsWith('save-') && keys.has(key))).map((mutation) => mutation.name)

  check('mutations: every planted fault names a group of checks that needs no save, so a checkout without the saves still catches it', bare.length ? short(bare) : true)

  for (const [name, result] of await runStatements(statements)) {
    check(name, result)
  }

  await Promise.all(opened.map((read) => read.close()))
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

  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  // The checks of the saves are witnesses: each must fail when its save is there, and none is needed when it is not. Every planted fault names a group that needs no save, and that group must fail whatever saves are present.
  const required = mutant.fails.filter((key) => !key.startsWith('save-'))
  const witnesses = mutant.fails.filter((key) => key.startsWith('save-'))
  const { statements, opened } = await statementsOf(ctx, witnesses.length > 0)
  const present = (key) => statements.some(([name]) => keyOf(name) === key)
  const named = [...required, ...witnesses.filter(present)]
  const absent = required.filter((key) => !present(key))
  const results = await runStatements(statements, named)
  const missed = named.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  await Promise.all(opened.map((read) => read.close()))
  check(`mutation caught: ${mutant.name}`, !required.length ? 'names no group of checks that needs no save' : absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
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

  useSaves = options.saves

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const extra = options.saves ? [] : ['--no-saves']
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...extra], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id, ...extra], weight: 3 }))])
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
