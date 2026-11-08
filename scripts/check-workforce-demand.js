/*
  Checks the committed workforce of the Colony Outlook (utilities/workforce-demand.js, mixins/queue-forecast.js and the page's "With the queue" basis): the workers a colony needs once the installations in its queue and the shipyard upgrades under way are done, month by month along the population series.

  node scripts/check-workforce-demand.js [--no-mutations] [--save <save.db> <GameID> <RaceID>]...

  With no options it runs on the migrated 3.1 fixture of scripts/lib/fixtures.js, read-only.

  Worked cases on synthetic rows (labelled so) run the real functions: a factory or a yard upgrade that finishes raises the demand from the month its date falls in (a date on a month's last day counts in that month, the day after in the next), a paused, queued or stalled job adds nothing that is certain and a stalled one at most what its stock builds, a job with no date adds nothing to the lower demand and everything to the higher, a conversion adds the difference of the two installations (and lowers the demand where the new one needs fewer), a retool adds nothing, a shipyard activity the model does not know and a colony of a spied empire are unavailable and name what is missing, population orbiting aboard Arks never reaches the workers, and a colony with nothing queued gives the Outlook's own figure.

  The saves are read through the page's own reads and checked against counts of the rows in the save: on the current basis nothing extra is read and every row is the Outlook's own, value for value; on the committed basis with nothing queued it is the same; with the queue every event is one of the colony's projects or yards, in the forecast's order, dated the way the rules above say, with no phantom installation from a paused, queued or stalled job. A check that needs a case the save does not hold prints UNSUPPORTED and is in neither the passes nor the failures.

  The yards aboard a ship run on the saves that hold them, whatever saves are named (SHIP_YARD_SAVES, read-only; a copy is a temporary table over the save's own; a save that is not there reads UNSUPPORTED): the page's colonies read gives each colony the workers of the yards no ship holds, value for value against a sum worked out here from the save's yard and ship rows, and the colonies named for a yard aboard a ship read the figure worked out by hand; with the queue counted, an activity given to a yard aboard a ship in a copy is not read, and the workers the colony's activities change leave it out. A rewrite of both filters that says the same thing must leave those checks green.

  The species growth modifier is applied to positive growth only (3.1: docs `COLONY_AND_POPULATION_LIFECYCLE_REFERENCE.md` § Changes since the earlier line, line 229). A worked case runs a colony of 100 M people at a species modifier of 1.5, and one whose governor bonus takes its growth below zero, through the growth rate, the Outlook's growth figure and its projection, and reads the rate alone of a colony with no people and an unreadable modifier and of one with no people at a radiation level. The save whose own colonies are run beside it is read by hand (population, species, body and installation rows), not through the Outlook's colonies read, which is of the earlier schema: the interim 3.1 fixture of scripts/lib/fixtures.js (a game of the earlier line migrated to the 3.1 schema, game 141, race 784), UNSUPPORTED when it is not there. A save whose colonies all read a species modifier of 1 cannot tell either growth mutant apart: its save case is no credit for the mutant, and where no save can tell it apart the worked case carries the kill. Every colony's rate is compared with the rule worked out here, the species modifier on growth that is positive and left off growth that is not, with the zero case (no people) and the negative one (a governor bonus below zero) taken from the same colonies.

  The mutants load a temp copy of the utilities folder with one thing changed; each must fail the check named with it. The faults of the yards aboard a ship are planted in the page and must fail their checks by a value on every save that holds the case, never by a throw of the page.
*/
const path = require('path')
const fs = require('fs')
const os = require('os')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate, replacing } = require('./lib/page-loader')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { assert, boundary, caughtAll, judged, runChecks } = require('./lib/fault-credit')
const { fixtureSave } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const FIXTURE_SAVE = fixtureSave()
const DEFAULT_SAVES = [FIXTURE_SAVE]
// The saves that hold shipyards aboard a ship, with the colonies named for them and the workers their own yards need, read by hand from the save. In the migrated 3.1 fixture (game 141, race 784) the homeworld Aurelia (48979) holds two repair yards aboard ships, a shipbreaker's (1,500,000 t, 37.5 M were it counted) and a smaller one's (31,000 t, 0.775 M), beside 91.5 M of yards of its own (eight yards, from 1.25 M to 17.25 M each: the three commercial and five naval yards and a Light yard of 1,000 t and five slipways, which needs the whole 1.25 M as a naval yard does, not a tenth of it); `activity` is the shipbreaker's yard, which a copy gives an activity, as no save holds one on a yard aboard a ship.
const SHIP_YARD_SAVES = [
  { file: FIXTURE_SAVE.file, game: FIXTURE_SAVE.game, race: FIXTURE_SAVE.race, named: { 48979: 91.5 }, activity: 25 },
]
const MINERAL_NAMES = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
  'lodash/groupBy': 'export default (list, key) => list.reduce((groups, row) => { (groups[row[key]] ||= []).push(row); return groups }, {})',
}
const UTILITIES = ['workforce-demand', 'colonies', 'production', 'industry-cycle', 'minerals', 'decimal', 'provenance', 'search-run']
const TOLERANCE = 1e-9
const YEARS = 2
const MONTHS = YEARS * 12

// What the page draws with of the chart theme: nothing is drawn here.
const THEME_STUB = 'export const chartTheme = () => ({ categorical: [], ink: \'\', inkMuted: \'\', primary: \'\' }); export const withAlpha = (color) => color; export const patternImage = () => null; export const seriesIdentity = () => null'

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

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--save') {
      saves.push({ file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
    } else if (argv[index] === '--no-mutations') {
      continue
    } else {
      console.error(`Unknown option ${argv[index]}`)
      process.exit(2)
    }
  }

  return saves.length ? saves : DEFAULT_SAVES
}

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does, and counts the queries that name each table it is asked about. `run(sql)` runs a statement on a temporary table that shadows one of the save's own, so the save itself is never written.
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

    const database = {
      file: path.basename(resolved),
      queries: [],
      query: (sql) => new Promise((resolve, reject) => {
        database.queries.push(sql)
        raw.all(sql, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
      }),
      run: (sql) => new Promise((resolve, reject) => raw.run(sql, (runError) => (runError ? reject(runError) : resolve()))),
      close: () => raw.close(),
    }

    resolve(database)
  })
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

// The utilities loaded from a temp copy of the folder in which `from`, which must occur once in `file`, is replaced by `to`: a mutant that must fail the check named with it.
const mutatedUtilities = async (file, from, to) => {
  refusePlanting(`${file}: ${from}`)

  const source = path.join(root, 'src', 'renderer', 'utilities')
  const parts = fs.readFileSync(path.join(source, file), 'utf8').split(from)

  if (parts.length !== 2) {
    throw new Error(`the mutation "${from}" matches ${parts.length - 1} times in ${file}, not once`)
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-workforce-mutant-'))

  try {
    fs.cpSync(source, directory, { recursive: true })
    fs.writeFileSync(path.join(directory, file), parts.join(to))

    return await loadUtilities(UTILITIES, { stubs: STUBS, directory })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const MODIFIERS = { PopName: 'Test colony', ConstructionProduction: 36500, OverallProductionModifier: 1, ConstructionPower: 1, GroundConstructionPower: 0, OrdnanceProduction: 0, OrdnanceProductionPower: 0, FighterProduction: 0, FighterProductionPower: 0, MinConstructionPeriod: 86400, ShipyardBuildRate: 3650, ShipyardOperations: 1 }
const INSTALLATIONS = { 1: { Workers: 0.05 }, 2: { Workers: 0.2 }, 3: { Workers: 0 }, 4: { Workers: 0.1 } }

// A colony of 100 million people of which 20 million are employed by installations, the way the page reads one.
const colonyRow = (extra = {}) => ({ PopulationID: 7, PopName: 'Test colony', Population: 100, OrbitalPopulation: 0, CurrentColonyCost: 0, MaximumColonyCost: 0, ReqInf: 0, SpeciesID: 1, PopulationGrowthModifier: 1, PopulationGrowthBonus: 1, PopulationDensityModifier: 1, SystemBodyID: 70, BodyClass: 1, Radius: 6400, HydroExt: 0.5, TidalLock: 0, RadiationLevel: 0, LowGravity: 0, Infrastructure: 0, LGInfrastructure: 0, InstallationWorkers: 20, YardWorkers: 0, BodyPopulation: 100, InfrastructureCost: 0, ...extra })

// One industrial project of the colony as the page reads it, with 1,000,000 t of each mineral in stock unless the case says otherwise.
const projectRow = (extra = {}) => ({ ID: 1, Name: `Project ${extra.ID || 1}`, ProductionType: 0, ProductionID: 1, PopulationID: 7, Percentage: 100, Amount: 4, PartialCompletion: 0, ProdPerUnit: 1000, Queue: 0, Paused: 0, FuelRequired: 0, StockFuel: 0, ConversionFrom: null, ConversionSource: null, ...Object.fromEntries(MINERAL_NAMES.flatMap((name) => [[name, 0], [`Stock${name}`, 1e6]])), ...extra })

// A shipyard activity: an upgrade of 500 t of capacity at a commercial yard with two slipways, which takes 200 days at the colony's rate.
const yardRow = (extra = {}) => ({ ShipyardID: 5, PopulationID: 7, ShipyardName: 'Test yard', SYType: 1, Slipways: 2, Capacity: 10000, UpgradeTaskType: 2, RemainingProduction: 3000, Paused: 0, CapacityTarget: 0, StockDuranium: 1e6, StockNeutronium: 1e6, ...extra })

const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < TOLERANCE

// The cases of the committed workforce on synthetic rows, as [statement, held, key]. `apps` are the utilities under test (a mutant passes its own) and `capacities` the colony's capacity results from the page.
const syntheticCases = (apps, capacities) => {
  const results = []
  const wd = apps['workforce-demand']
  const holds = (key, statement, condition) => results.push([statement, (() => { try { return Boolean(condition()) } catch (error) { return false } })(), key])
  const scene = ({ projects = [], yards = [], colony = {}, modifiers = MODIFIERS, npr = false, forecast: given, years = YEARS } = {}) => {
    const entry = apps.colonies.outlookColonies([colonyRow(colony)], [], years)[0]
    const needs = wd.workforceNeeds({ projects, installations: INSTALLATIONS, yards })
    const forecast = given !== undefined ? given : needs.installation.length ? apps.production.industryForecast({ projects, capacities, modifiers, arrivals: [], npr }) : null
    const committed = wd.committedWorkforce({ colony: entry.colony, workersNow: entry.results.workersNow, cost: entry.results.cost, projection: entry.results.projection, needs, forecast, modifiers, npr })

    return { entry, needs, forecast, committed, value: committed.value, events: committed.value ? committed.value.events : [] }
  }
  const crafted = (forecast, exhaustive = true) => ({ cycleDays: 1, orders: { exhaustive }, figures: [{ forecast }] })
  const figure = (extra) => ({ outcome: 'finishes', delivered: 4, earliest: 40, latest: 40, startEarliest: 0, builtRange: [4, 4], unitsPerCycle: 0.1, cut: null, stall: null, ...extra })
  const factory = (extra = {}) => projectRow({ ID: 9, ...extra })

  // The request just under 0.1 floors to 0.0999 per day, so four units take 41 cycles.
  holds('dated', 'a factory of four, which the engine finishes on day 41, raises the workers needed by 4 x 0.05 M from the second month on (day 41 falls in it) and not before in the lower demand; the higher one agrees from then on (the units built sooner may count before), and the horizon figure is the colony\'s workers needed then', () => {
    const { value, events, entry } = scene({ projects: [factory()] })
    const [event] = events

    return events.length === 1 && event.status === 'dated' && event.kind === 'installation' && event.earliest === 41 && event.latest === 41 && near(value.required.low[1], 20) && near(value.required.low[2], 20.2) && near(value.required.low[MONTHS], 20.2) && value.required.low.every((workers, month) => workers <= value.required.high[month] + TOLERANCE && (month < 2 || near(workers, value.required.high[month]))) && near(value.later.best.required, 20.2) && near(value.later.best.free, entry.results.workersLater.value.available - 20.2) && near(value.later.worst.free, value.later.best.free)
  })

  holds('monthEdge', 'at the floored 0.9999 units per day, 29 units finish on day 30 (month 1), 30 on day 31 (month 2), and 364 on day 365 (month 12)', () => {
    const on = (amount, id) => scene({ projects: [factory({ Amount: amount, ProdPerUnit: 100, ProductionID: id })] }).value.required.low
    const thirty = on(29, 4)
    const thirtyOne = on(30, 4)
    const year = on(364, 1)

    return near(thirty[0], 20) && near(thirty[1], 22.9) && near(thirtyOne[1], 20) && near(thirtyOne[2], 23) && near(year[11], 20) && near(year[12], 38.2)
  })

  holds('paused', 'a paused project adds nothing in either demand, and a project queued behind it that never starts adds nothing either: no installation appears from a job that is not building', () => {
    const paused = scene({ projects: [factory({ ID: 8, Paused: 1 }), factory({ Queue: 1 })] })
    const none = (event) => event.low.every((change) => change === 0) && event.high.every((change) => change === 0)
    const byId = (id) => paused.events.find((event) => event.id === id)

    return paused.events.length === 2 && byId('project-8').status === 'paused' && none(byId('project-8')) && byId('project-9').status === 'queued' && none(byId('project-9')) && near(paused.value.later.best.required, 20) && near(paused.value.later.worst.required, 20)
  })

  holds('queuedStarts', 'a project queued behind one that finishes starts when it ends and is dated by the engine (day 82 here), counted from the month it falls in', () => {
    const { events, value } = scene({ projects: [factory({ ID: 8 }), factory({ Queue: 1 })] })
    const second = events.find((event) => event.id === 'project-9')

    return second.status === 'dated' && second.earliest === 82 && near(value.required.low[2], 20.2) && near(value.required.low[3], 20.4) && near(value.required.low[MONTHS], 20.4)
  })

  holds('stalled', 'a project that stalls on its minerals is never in the lower demand and in the higher at most what the stock builds (2 of 4), and one with no stock at all adds nothing to either', () => {
    const some = scene({ projects: [factory({ Duranium: 50, StockDuranium: 100 })] })
    const none = scene({ projects: [factory({ Duranium: 50, StockDuranium: 0 })] })
    const [event] = some.events

    return event.status === 'stalled' && event.low.every((change) => change === 0) && near(event.high[MONTHS], 0.1) && event.limits.length > 0 && none.events[0].status === 'stalled' && none.events[0].high.every((change) => change === 0) && near(none.value.later.worst.required, 20) && near(some.value.later.best.required, 20) && near(some.value.later.worst.required, 20.1)
  })

  holds('conversion', 'a conversion raises the workers needed by the difference of the two installations a unit, and lowers them where the one built needs fewer than the one replaced', () => {
    const up = scene({ projects: [factory({ Amount: 2, ProductionID: 2, ConversionFrom: 1, ConversionSource: 10 })] })
    const down = scene({ projects: [factory({ Amount: 2, ProductionID: 1, ConversionFrom: 2, ConversionSource: 10 })] })

    return near(up.events[0].delta, 0.15) && near(up.value.required.low[MONTHS], 20.3) && near(down.events[0].delta, -0.15) && near(down.value.required.low[MONTHS], 19.7) && near(down.value.required.high[MONTHS], 19.7) && down.value.later.best.free > down.entry.results.workersLater.value.available - 20
  })

  holds('conversionStalled', 'a stalled conversion to a smaller installation lowers the workers needed only in the lower demand (the most that could be converted) and never in the higher', () => {
    const stalled = scene({ projects: [factory({ Amount: 4, ProductionID: 1, ConversionFrom: 2, ConversionSource: 10, Duranium: 50, StockDuranium: 100 })] })

    return stalled.events[0].status === 'stalled' && near(stalled.value.required.low[MONTHS], 20 - 0.3) && near(stalled.value.required.high[MONTHS], 20)
  })

  holds('otherTypes', 'a project that is not an installation (a component, a ship part) and an installation that needs no workers add no event', () => {
    const other = scene({ projects: [factory({ ProductionType: 3, ProductionID: 0 }), factory({ ID: 10, ProductionID: 3 })] })

    return other.events.length === 0 && other.needs.missing.length === 0 && other.forecast === null
  })

  holds('yardDate', 'a yard upgrade that takes 200 days raises the yard\'s workers by what 500 t more capacity needs (0.25 M) from month 7 (day 200) and not before', () => {
    const { value, events } = scene({ yards: [yardRow()] })
    const [event] = events
    const lowOf = (remaining) => scene({ yards: [yardRow({ RemainingProduction: remaining })] }).value.required.low
    const thirty = lowOf(450)
    const thirtyOne = lowOf(465)
    const year = lowOf(5475)

    return events.length === 1 && event.kind === 'yard' && event.status === 'dated' && near(event.earliest, 200) && near(event.delta, 0.25) && near(value.required.low[6], 20) && near(value.required.low[7], 20.25) && near(value.required.high[7], 20.25) && near(value.required.high[6], 20) && near(thirty[0], 20) && near(thirty[1], 20.25) && near(thirtyOne[1], 20) && near(thirtyOne[2], 20.25) && near(year[11], 20) && near(year[12], 20.25)
  })

  holds('yardLight', 'a slipway at a light yard of 1,000 t with five slipways raises its workers by the whole 1,000 t over 4,000 (0.25 M), as at a naval yard, where a commercial yard of the same size needs a tenth of it (0.025 M)', () => {
    const [light, naval, commercial] = [4, 1, 2].map((SYType) => scene({ yards: [yardRow({ SYType, Capacity: 1000, Slipways: 5, UpgradeTaskType: 1 })] }).events[0])

    return light.kind === 'yard' && near(light.delta, 0.25) && near(naval.delta, 0.25) && near(commercial.delta, 0.025)
  })

  holds('yardPaused', 'a paused yard activity adds nothing, and one at a yard with no build rate (it makes no progress) adds nothing either', () => {
    const paused = scene({ yards: [yardRow({ Paused: 1 })] })
    const stuck = scene({ yards: [yardRow()], modifiers: { ...MODIFIERS, ShipyardBuildRate: 0 } })

    return paused.events[0].status === 'paused' && near(paused.value.later.worst.required, 20) && stuck.events[0].status === 'stalled' && near(stuck.value.later.worst.required, 20) && near(stuck.value.later.best.required, 20)
  })

  holds('yardShort', 'a yard upgrade the colony\'s Duranium or Neutronium cannot pay for is counted only in the higher demand, from the date the rate gives', () => {
    const short = scene({ yards: [yardRow({ StockDuranium: 10 })] })
    const unknown = scene({ yards: [yardRow({ StockNeutronium: null })] })
    const missing = scene({ yards: [yardRow({ StockNeutronium: undefined })] })

    return short.events[0].status === 'short' && short.events[0].low.every((change) => change === 0) && near(short.value.required.high[7], 20.25) && near(short.value.required.high[6], 20) && [unknown, missing].every(({ events, value }) => events[0].status === 'short' && near(value.required.low[MONTHS], 20) && near(value.required.high[MONTHS], 20.25))
  })

  holds('retool', 'a retool changes no workers: no event, and the colony is known', () => {
    const retool = scene({ yards: [yardRow({ UpgradeTaskType: 7 })] })

    return retool.events.length === 0 && retool.needs.missing.length === 0 && retool.committed.status !== 'unavailable'
  })

  holds('yardType', 'a yard activity of a type the model does not know (a spacemaster modification) makes the colony unavailable and names it, never zero workers', () => {
    const unknown = scene({ yards: [yardRow({ UpgradeTaskType: 9 })] })

    return unknown.committed.status === 'unavailable' && unknown.committed.value === null && unknown.committed.inputs.missing.some((name) => /spacemaster/.test(name))
  })

  holds('continual', 'a continual upgrade is dated approximately and counted only in the higher demand, in full from month 1, because what it has raised by then is not known and its minerals are not checked: its completion is never certain, so the lower demand never includes it, with a stock that pays for it as with none', () => {
    const { events, value } = scene({ yards: [yardRow({ UpgradeTaskType: 8, CapacityTarget: 12000 })] })
    const [event] = events

    return event.approximate === true && event.status === 'approximate' && near(value.required.high[1], 20 + event.delta) && value.required.low.every((workers) => near(workers, 20)) && event.limits.length > 0 && value.required.low.every((workers, month) => workers <= value.required.high[month] + TOLERANCE)
  })

  holds('unavailable', 'a colony whose queue the forecast could not settle is unavailable and names why: the forecast still running, a gap the forecast reports, a spied empire\'s colony, and an installation whose workers the save lacks', () => {
    const projects = [factory()]
    const running = scene({ projects, forecast: null })
    const gaps = scene({ projects, forecast: { gaps: ['the colony\'s construction capacity'] } })
    const npr = scene({ yards: [yardRow()], npr: true })
    const unknownType = apps['workforce-demand'].workforceNeeds({ projects: [factory({ ProductionID: 99 })], installations: INSTALLATIONS, yards: [] })

    return running.committed.status === 'unavailable' && running.committed.inputs.missing.some((name) => /still running/.test(name)) && gaps.committed.status === 'unavailable' && gaps.committed.inputs.missing.includes('the colony\'s construction capacity') && npr.committed.status === 'unavailable' && npr.committed.inputs.missing.some((name) => /capital/.test(name)) && unknownType.missing.length === 1
  })

  holds('unknownDate', 'a project whose date the forecast could not settle adds nothing to the lower demand and everything it could build to the higher from the first month, with no date', () => {
    const { events, value } = scene({ projects: [factory()], forecast: crafted(figure({ outcome: 'unresolved', delivered: 0, earliest: null, latest: null, builtRange: [0, 0] })) })
    const [event] = events

    return event.status === 'unknown' && event.earliest === null && event.latest === null && value.required.low.every((workers) => near(workers, 20)) && near(value.required.high[0], 20) && near(value.required.high[1], 20.2) && near(value.required.high[MONTHS], 20.2)
  })

  holds('sampled', 'a date from only some orders of the colony\'s projects is not a bound: it adds nothing to the lower demand and counts in the higher', () => {
    const { events, value } = scene({ projects: [factory()], forecast: crafted(figure(), false) })

    return events[0].status === 'sampled' && value.required.low.every((workers) => near(workers, 20)) && near(value.required.high[MONTHS], 20.2)
  })

  holds('range', 'a finish that depends on the order (day 30 to day 60.5) is in the lower demand at month 2, where every order has finished (month 2 ends on day 60.8), and in the higher from the first month', () => {
    const { events, value } = scene({ projects: [factory()], forecast: crafted(figure({ earliest: 30, latest: 60.5, unitsPerCycle: 0.2 })) })

    return events[0].status === 'range' && near(value.required.low[1], 20) && near(value.required.low[2], 20.2) && near(value.required.high[1], 20.2) && value.required.low.every((workers, month) => workers <= value.required.high[month] + TOLERANCE)
  })

  holds('zeroEvents', 'a colony with nothing queued, only a retool, or only projects that are not installations has exactly the Outlook\'s own worker split at the horizon and in every month: the committed figure equals the current one', () => {
    return [{}, { yards: [yardRow({ UpgradeTaskType: 7 })] }, { projects: [factory({ ProductionType: 3, ProductionID: 0 })] }].every((given) => {
      const { value, entry } = scene({ ...given, colony: { YardWorkers: 1.5 } })
      const current = entry.results.workersLater.value
      const now = entry.results.workersNow.value

      return JSON.stringify(value.later.best) === JSON.stringify(current) && JSON.stringify(value.later.worst) === JSON.stringify(current) && value.free.best.every((free, month) => near(free, value.free.worst[month])) && near(value.free.best[0], now.free) && near(value.free.best[MONTHS], current.free) && value.firstShort.best === value.firstShort.worst
    })
  })

  holds('currentSplit', 'the workers needed today are the installations and the yards of the colony and nothing else (20 M and 1.5 M of 100 M people here)', () => {
    const { entry } = scene({ colony: { InstallationWorkers: 20, YardWorkers: 1.5 } })
    const now = entry.results.workersNow.value

    return near(now.required, 21.5) && near(now.free, now.available - 21.5) && near(entry.results.workersLater.value.required, 21.5)
  })

  holds('ark', 'orbital people contribute to services and manufacturing but not surface agriculture: at 100 M surface and 100 M orbital the current and committed workforce have 61.251939 M available', () => {
    const { value, entry, committed } = scene({ projects: [factory()], colony: { OrbitalPopulation: 100, ArkOccupied: 100 } })
    const surface = entry.results.projection.value

    return committed.status !== 'unavailable' && near(entry.results.workersNow.value.available, 61.2519390047156) && near(value.later.best.population, surface.final) && near(value.later.best.totalPopulation, surface.final + 100) && near(value.later.best.agriculture, surface.final * 0.05)
  })

  holds('bounds', 'the lower demand never exceeds the higher in any month, so the free workers of the best case never fall below those of the worst', () => {
    return [scene({ projects: [factory()] }), scene({ projects: [factory({ Duranium: 50, StockDuranium: 100 })] }), scene({ projects: [factory({ Amount: 2, ProductionID: 1, ConversionFrom: 2, ConversionSource: 10 })] }), scene({ yards: [yardRow({ StockDuranium: 10 })] }), scene({ projects: [factory()], forecast: crafted(figure({ earliest: 30, latest: 60 })) })].every(({ value }) => value.required.low.every((workers, month) => workers <= value.required.high[month] + TOLERANCE) && value.free.best.every((free, month) => free >= value.free.worst[month] - TOLERANCE))
  })

  holds('firstShort', 'the first month a colony is short of workers is found on each demand: ten more installations of 0.2 M that are certain make it short from their date in both, and ones from only some orders only in the worst case', () => {
    const tight = { InstallationWorkers: 38 }
    const projects = [factory({ Amount: 10, ProductionID: 2 })]
    const ten = figure({ delivered: 10, builtRange: [10, 10], unitsPerCycle: 0.25 })
    const certain = scene({ projects, colony: tight, forecast: crafted(ten) })
    const possible = scene({ projects, colony: tight, forecast: crafted(ten, false) })

    return certain.value.firstShort.best === 2 && certain.value.firstShort.worst !== null && certain.value.firstShort.worst <= 2 && possible.value.firstShort.best === null && possible.value.firstShort.worst !== null && scene({ colony: tight }).value.firstShort.worst === null
  })

  holds('recoveryEpisode', 'the recovery of the worst-case shortage that contains the later supported shortage is kept apart from its earlier recovery: linear monthly increments give month 47 supported and month 59 possible; a larger possible demand remains short through month 60', () => {
    const yards = (target) => [yardRow({ UpgradeTaskType: 8, CapacityTarget: target }), yardRow({ ShipyardID: 6, ShipyardName: 'Later slipway', UpgradeTaskType: 1, Capacity: 19520, RemainingProduction: 10000 })]
    const colony = { InstallationWorkers: 23.24, YardWorkers: 14.76 }
    const [back, short] = [12000, 12400].map((target) => scene({ years: 5, colony, yards: yards(target) }).value)

    return back.firstShort.best === 14 && back.firstShort.worst === 1 && back.recovery.best === 47 && back.recovery.worst === 3 && back.recovery.worstAfterBest === 59 && short.recovery.worst === 5 && short.recovery.worstAfterBest === null && short.recovery.best === 47
  })

  const comp = (extra) => projectRow({ ProductionType: 3, ProductionID: 0, Amount: 1, ProdPerUnit: 1, Duranium: 1, StockDuranium: 1, ...extra })
  const queuedFactory = (extra) => projectRow({ ID: 3, Name: 'Queued factory', ProductionID: 1, Amount: 1, ProdPerUnit: 1, Duranium: 0, StockDuranium: 1, Percentage: 60, Queue: 1, ...extra })

  holds('queuedOrder', 'a mineral-free factory queued in the order the forecast kept, which the other order of two construction projects (40% and 60%, 1 t of Duranium between them) starts, is counted in the higher demand only (0.05 M from the first month, whichever order the projects are listed in) with the status of a project some orders start, never "queued, adds nothing", while a factory queued behind a paused project that every order leaves queued adds nothing', () => {
    const [one, other] = [[comp({ ID: 1, Percentage: 40 }), comp({ ID: 2, Percentage: 60 }), queuedFactory()], [comp({ ID: 2, Percentage: 60 }), comp({ ID: 1, Percentage: 40 }), queuedFactory()]].map((projects) => scene({ projects }))
    const never = scene({ projects: [projectRow({ ID: 8, Paused: 1 }), queuedFactory({ ID: 9, Percentage: 50 })] })

    return [one, other].every(({ forecast, events, value }) => forecast.orders.exhaustive === true && forecast.figures[2].forecast.outcome === 'queued' && events.length === 1 && events[0].status === 'maybe' && events[0].low.every((change) => change === 0) && near(events[0].high[1], 0.05) && near(events[0].high[MONTHS], 0.05) && near(value.required.high[1], 20.05) && near(value.required.low[MONTHS], 20) && value.free.worst[MONTHS] < value.free.best[MONTHS]) && never.events.find((event) => event.id === 'project-9').status === 'queued' && never.events.every((event) => event.high.every((change) => change === 0))
  })

  holds('queuedSampled', 'a factory queued behind six construction projects that compete for the stock, where the forecast could only sample the orders (12 tried, none starts it), may still be started by an order not tried: it is counted in the higher demand from the first month and not in the lower, as a project some orders start', () => {
    const holders = [10, 20, 10, 20, 20, 20].map((percentage, index) => comp({ ID: index + 1, Name: `Holder ${index + 1}`, Percentage: percentage, StockDuranium: 4 }))
    const { forecast, events, value } = scene({ projects: [...holders, queuedFactory({ ID: 7, Percentage: 80, StockDuranium: 4 })] })

    return forecast.orders.exhaustive === false && forecast.figures[6].forecast.outcome === 'queued' && forecast.figures[6].forecast.startEarliest === null && events.length === 1 && events[0].status === 'maybe' && events[0].low.every((change) => change === 0) && near(events[0].high[1], 0.05) && near(value.required.low[MONTHS], 20) && near(value.required.high[MONTHS], 20.05)
  })

  holds('continualZero', 'a continual upgrade at a yard with no Duranium and no Neutronium is counted in the higher demand only (the whole 1 M from the first month), like a finite upgrade with the same empty stock: its date is a rate\'s and its minerals are not checked, so its completion is never certain, in the lower demand at no month', () => {
    const continual = scene({ yards: [yardRow({ UpgradeTaskType: 8, CapacityTarget: 12000, StockDuranium: 0, StockNeutronium: 0 })] })
    const finite = scene({ yards: [yardRow({ StockDuranium: 0, StockNeutronium: 0 })] })
    const [event] = continual.events

    return event.status === 'approximate' && event.approximate === true && event.low.every((change) => change === 0) && near(event.high[1], event.delta) && continual.value.required.low.every((workers) => near(workers, 20)) && near(continual.value.required.high[MONTHS], 20 + event.delta) && finite.events[0].status === 'short' && finite.value.required.low.every((workers) => near(workers, 20))
  })

  holds('continualPausedNoTarget', 'a paused continual upgrade with no capacity target changes nothing (the game skips a paused yard activity and the model assumes it is not resumed), so it does not make the colony unavailable and the demand stays flat, as with a target; one not known to be paused still does', () => {
    const [none, target, nulled] = [{ CapacityTarget: 0 }, { CapacityTarget: 12000 }, { CapacityTarget: null }].map((extra) => scene({ yards: [yardRow({ UpgradeTaskType: 8, Paused: 1, ...extra })] }))
    const unknown = scene({ yards: [yardRow({ UpgradeTaskType: 8, Paused: null, CapacityTarget: 0 })] })

    return [none, target, nulled].every(({ committed, value }) => committed.status !== 'unavailable' && value.required.low.every((workers) => near(workers, 20)) && value.required.high.every((workers) => near(workers, 20))) && unknown.committed.status === 'unavailable'
  })

  holds('continualNoTarget', 'a continual upgrade with no positive capacity target has no stop condition (it raises the capacity for as long as it has minerals), so the demand it will reach has no bound: the colony is unavailable and the missing figure is named, never a demand that stops at today\'s capacity, while one with a target counts to it', () => {
    const open = scene({ yards: [yardRow({ UpgradeTaskType: 8, CapacityTarget: 0 })] })
    const negative = scene({ yards: [yardRow({ UpgradeTaskType: 8, CapacityTarget: -1 })] })
    const stopped = scene({ yards: [yardRow({ UpgradeTaskType: 8, CapacityTarget: 12000 })] })

    return [open, negative].every(({ committed }) => committed.status === 'unavailable' && committed.value === null && committed.inputs.missing.some((name) => /capacity target/.test(name))) && stopped.committed.status !== 'unavailable'
  })

  holds('growthModifier', 'the species growth modifier scales growth that is positive and is left off growth that is not: a colony of 100 M people at a species modifier of 1.5 grows at one and a half times its base rate, one with no people at all keeps a rate of 0 whatever its species modifier reads (even when the row has none), and one whose governor bonus takes its growth below zero keeps the whole loss, while the Outlook\'s growth figure and its projection carry the same rate', () => {
    const base = 0.2 / Math.cbrt(100)
    const capacityOf = (row) => apps.colonies.bodyCapacity(row)
    const rateOf = (row) => apps.colonies.growthRate(row, row.Population, row.BodyPopulation, capacityOf(row))
    const withBonus = (row, bonus) => apps.colonies.growthRate({ ...row, PopulationGrowthBonus: bonus }, row.Population, row.BodyPopulation, capacityOf(row))
    const positiveRow = colonyRow({ Population: 100, PopulationGrowthModifier: 1.5 })
    const zeroRow = colonyRow({ Population: 0, PopulationGrowthModifier: undefined })
    const negativeRow = colonyRow({ Population: 100, PopulationGrowthModifier: 1.5, PopulationGrowthBonus: -1 })
    const radiatedRow = colonyRow({ Population: 0, PopulationGrowthModifier: 1.5, RadiationLevel: 400 })
    const positive = rateOf(positiveRow)
    const negative = rateOf(negativeRow)
    const [grown] = apps.colonies.outlookColonies([positiveRow], [], YEARS)
    const [shrunk] = apps.colonies.outlookColonies([negativeRow], [], YEARS)

    return near(positive, base * 1.5) && rateOf(zeroRow) === 0 && near(rateOf(radiatedRow), 0) && near(negative, -base) && near(withBonus(positiveRow, 1), positive) && near(grown.results.growth.value, positive) && near(shrunk.results.growth.value, negative) && near(grown.results.projection.value.series[1], 100 * (1 + positive / 12)) && near(shrunk.results.projection.value.series[1], 100 * (1 + negative / 12)) && shrunk.results.projection.value.series[1] < 100
  })

  return results
}

// The page's rows on synthetic colonies, as [statement, held, key]: what the attention filter and the tile do with a colony short of workers only in the case where every completion that could happen does.
const pageCases = async (pageOptions, store) => {
  const results = []
  const holds = (key, statement, condition) => results.push([statement, (() => { try { return Boolean(condition()) } catch (error) { return false } })(), key])
  const open = async (colony, projects, extra = {}) => {
    const vm = instantiate(pageOptions, { ...store, data: { workerBasis: 'committed', colonies: [colonyRow(colony)], inbound: [], populationProductionModifiers: { 7: MODIFIERS }, industry: projects, yardActivities: [], installationTypes: INSTALLATIONS, ...extra } })

    await vm.startForecast()

    return vm
  }

  const orbital = await open({ InstallationWorkers: 40 }, [], { arks: { ships: [{ ShipID: 1, AssignedPopulationID: 7, OrbitBodyID: 70, SystemID: 1, Xcor: 0, Ycor: 0, CivilianFunction: 0, MoveOrders: 0, Berths: 100000000 }], cargo: [{ ShipID: 1, CargoTypeID: 1, Amount: 100000000, Rows: 1, Amounts: 1, SpeciesID: 1, SpeciesName: 'Source case' }], colonies: [{ PopulationID: 7, SystemBodyID: 70, SystemID: 1, Xcor: 0, Ycor: 0, Population: 100 }], assignments: [{ PopulationID: 7, SystemBodyID: 70 }] } })
  holds('orbitalPage', 'PAGE 100 M orbital people join 100 M surface people for 61.251939 M manufacturing workers and no shortage against 40 M demand, while surface population remains 100 M', () => {
    const row = orbital.rows[0]

    return near(row.Population, 100) && near(row.OrbitalPopulation, 100) && near(row.workersNow.available, 61.2519390047156) && near(row.workersNow.agriculture, 5) && row.shortNow === false && near(row.workersLater.totalPopulation, row.final + 100)
  })
  // 200 factories of 0.2 M workers that the Duranium in stock (1 t each, 100 t held) builds only half of: the colony has workers to spare in the supported case and is 9 M short in the worst one.
  const stalled = (installationWorkers, attentionOnly) => open({ InstallationWorkers: installationWorkers }, [projectRow({ ID: 9, Amount: 200, ProductionID: 2, Duranium: 1, StockDuranium: 100 })], { attentionOnly })
  const [worstOnly, fine] = [await stalled(38, true), await stalled(20, true)]
  const [worstRow] = worstOnly.rows
  const [fineRow] = fine.rows
  const [shortTile] = worstOnly.tiles.filter((tile) => tile.label === 'Colonies short of workers')
  const [fineTile] = fine.tiles.filter((tile) => tile.label === 'Colonies short of workers')

  holds('attentionPossible', 'PAGE a colony with workers to spare at the horizon in the supported case but short in "At worst" (a stalled queue of 200 factories at a colony with 38 M employed) is kept by the attention filter (not hidden), is not counted as short in the tile (0 now, 0 in 10 y: certain shortages only), is named in the tile as one that may be short, keeps its worst case as a result of its own beside the supported one, and its attention flag stays the supported case\'s (false); a colony with no such worst case is filtered out and the tile says nothing of it', () => {
    return worstRow.freeLater > 0 && worstRow.freeLaterWorst < 0 && worstRow.mayBeShortLater === true && worstRow.attention === false && worstOnly.visibleRows.length === 1 && worstOnly.visibleRows[0].PopulationID === 7 && shortTile.value === '0 now, 0 in 10 y' && /1 more may be short at worst/.test(shortTile.note) && worstRow.r.workersLaterWorst.status !== 'unavailable' && worstRow.r.workersLaterWorst.value.free < 0 && fineRow.mayBeShortLater === false && fine.visibleRows.length === 0 && fineTile.value === '0 now, 0 in 10 y' && !/may be short/.test(fineTile.note)
  })

  const comp = (extra) => projectRow({ ProductionType: 3, ProductionID: 0, Amount: 1, ProdPerUnit: 1, Duranium: 1, StockDuranium: 1, ...extra })
  const holders = [10, 20, 10, 20, 20, 20].map((percentage, index) => comp({ ID: index + 1, Name: `Holder ${index + 1}`, Percentage: percentage, StockDuranium: 4 }))
  const untried = await open({ InstallationWorkers: 20 }, [...holders, projectRow({ ID: 7, Name: 'Queued factory', ProductionID: 1, Amount: 1, ProdPerUnit: 1, Duranium: 0, StockDuranium: 4, Percentage: 100, Queue: 1 })])
  const [untriedEvent] = untried.rows[0].events

  holds('maybeLabel', 'PAGE the status of a queued project that the forecast could only sample (six holders, none of the orders tried starts a factory at 100%) is worded as a possibility ("May start, adds nothing certain"), never as an observed start in some orders', () => {
    return untriedEvent.status === 'maybe' && /^May start/.test(untried.eventStatus(untriedEvent)) && !/Starts in/.test(untried.eventStatus(untriedEvent))
  })

  // 200 factories of 0.2 M workers that the colony builds within the horizon: 20 M employed fit the workers it has today and 60 M do not fit at the horizon, a certain shortage.
  const later = await open({ InstallationWorkers: 20 }, [projectRow({ ID: 9, Amount: 200, ProductionID: 2, Duranium: 1 })])
  const [laterRow] = later.rows
  const [laterTile] = later.tiles.filter((tile) => tile.label === 'Colonies short of workers')

  holds('laterTile', 'PAGE a colony with workers to spare today and a certain shortage at the horizon (200 factories that finish) reads "0 now, 1 in 10 y" and the tile carries the warning icon in the warning colour, not the success tick', () => {
    return laterRow.attention === true && laterTile.value === '0 now, 1 in 10 y' && laterTile.icon === 'mdi-account-alert' && laterTile.iconColor === 'warning' && fineTile.icon !== 'mdi-account-alert'
  })

  // 20 factories of 0.05 M workers that finish on the first day at a colony with 38 M employed: the free workers are short in the first months (the 1 M the factories need) and enough again as the population grows, so both ends are healthy.
  const factories = (extra) => projectRow({ ID: 9, Amount: 20, ProductionID: 1, ProdPerUnit: 1, ...extra })
  const recovers = await open({ InstallationWorkers: 38 }, [factories()], { attentionOnly: true })
  const ample = await open({ InstallationWorkers: 20 }, [factories()], { attentionOnly: true })
  const [recoversRow] = recovers.rows
  const [recoversTile] = recovers.tiles.filter((tile) => tile.label === 'Colonies short of workers')
  const [ampleTile] = ample.tiles.filter((tile) => tile.label === 'Colonies short of workers')

  holds('duringCertain', 'PAGE a colony short of workers for some months on the dates the forecast supports and with enough again at the horizon (38 M employed and 20 factories finishing on day 1) is kept by the attention filter, has both endpoints healthy ("0 now, 0 in 10 y" and its attention flag false), says in its row from which month it is short and when it is back, is counted in the tile as short on the way and never as one that may be short, and the tile carries the warning icon; one with workers to spare all along is filtered out and the tile says nothing of it', () => {
    return recoversRow.freeNow > 0 && recoversRow.freeLater > 0 && recoversRow.committed.firstShort.best === 1 && recoversRow.committed.recovery.best > 1 && recoversRow.shortInBetween === true && recoversRow.mayBeShortDuring === false && recoversRow.attention === false && recovers.visibleRows.length === 1 && recoversTile.value === '0 now, 0 in 10 y' && /1 short on the way, back by 10 y/.test(recoversTile.note) && !/more may be short/.test(recoversTile.note) && recoversTile.icon === 'mdi-account-alert' && recoversTile.iconColor === 'warning' && /^Short of workers from month 1, back by month \d+$/.test(recoversRow.duringNote) && ample.rows[0].shortInBetween === false && ample.visibleRows.length === 0 && !/short on the way/.test(ampleTile.note) && ampleTile.icon !== 'mdi-account-alert'
  })

  // The same 20 factories queued behind two construction projects that compete for 1 t of Duranium (40% and 60%): the order the forecast keeps leaves them queued and the other starts them, so they are in the higher demand only.
  const alternative = await open({ InstallationWorkers: 38 }, [comp({ ID: 1, Percentage: 40 }), comp({ ID: 2, Percentage: 60 }), projectRow({ ID: 3, Name: 'Queued factories', ProductionID: 1, Amount: 20, ProdPerUnit: 1, Duranium: 0, StockDuranium: 1, Percentage: 60, Queue: 1 })], { attentionOnly: true })
  const [alternativeRow] = alternative.rows
  const [alternativeTile] = alternative.tiles.filter((tile) => tile.label === 'Colonies short of workers')

  holds('duringPossible', 'PAGE a colony short of workers for some months only if completions an alternative order of the forecast makes happen do, with enough again at the horizon in the worst case too, is kept by the attention filter, is not counted as short at either end ("0 now, 0 in 10 y"), says in its row that it may be short at worst and from which month, is counted in the tile as one that may be short and never as short on the way, and the tile carries the warning icon', () => {
    return alternativeRow.freeNow > 0 && alternativeRow.freeLater > 0 && alternativeRow.freeLaterWorst > 0 && alternativeRow.committed.firstShort.best === null && alternativeRow.committed.firstShort.worst >= 1 && alternativeRow.mayBeShortDuring === true && alternativeRow.mayBeShortLater === false && alternativeRow.shortInBetween === false && alternativeRow.attention === false && alternative.visibleRows.length === 1 && alternativeTile.value === '0 now, 0 in 10 y' && /1 more may be short at worst/.test(alternativeTile.note) && !/short on the way/.test(alternativeTile.note) && alternativeTile.icon === 'mdi-account-alert' && alternativeTile.iconColor === 'warning' && /^May be short of workers at worst from month \d+, back by month \d+$/.test(alternativeRow.duringNote)
  })

  // The same early completion of 20 factories (1 M of workers, certain) at a colony that also has a continual upgrade of a yard queued (12 M of workers if it runs to its target, possible only): the supported dates have the colony short in month 1 and healthy again from month 3, and the worst case has it short for good.
  const mixed = await open({ InstallationWorkers: 38 }, [factories()], { attentionOnly: true, yardActivities: [yardRow({ UpgradeTaskType: 8, CapacityTarget: 34000 })] })
  const [mixedRow] = mixed.rows
  const [mixedTile] = mixed.tiles.filter((tile) => tile.label === 'Colonies short of workers')
  // A smaller continual upgrade (0.5 M of workers): the worst case is short for longer and is healthy again later than the supported dates have it.
  const smaller = await open({ InstallationWorkers: 38 }, [factories()], { attentionOnly: true, yardActivities: [yardRow({ UpgradeTaskType: 8, CapacityTarget: 11000 })] })
  const [smallerRow] = smaller.rows

  holds('mixedRecovery', 'PAGE a colony short in month 1 on the supported dates and healthy again from month 3, but still short at the horizon in the worst case (a certain early completion and a possible continual yard upgrade), says in its row that it is back by that month at best and still short at worst at the horizon, never that it is back by it without qualification, and the tile counts it once, as short on the way "only at best", never also as one that may be short; one whose worst case recovers later says both months; one both cases recover in the same month is not qualified', () => {
    return mixedRow.committed.firstShort.best === 1 && mixedRow.committed.recovery.best > 1 && mixedRow.committed.recovery.worst === null && mixedRow.shortInBetween === true && mixedRow.mayBeShortDuring === false && mixedRow.mayBeShortLater === true && mixed.visibleRows.length === 1 && /^Short of workers from month 1, back by month \d+ at best; still short at worst at 10 y$/.test(mixedRow.duringNote) && /1 short on the way, back by 10 y \(1 of them only at best\)/.test(mixedTile.note) && !/more may be short/.test(mixedTile.note) && mixedTile.icon === 'mdi-account-alert' && smallerRow.committed.recovery.worst > smallerRow.committed.recovery.best && /^Short of workers from month 1, back by month \d+ at best, month \d+ at worst$/.test(smallerRow.duringNote) && recoversRow.recoveryAtBestOnly === false && /^Short of workers from month 1, back by month \d+$/.test(recoversRow.duringNote)
  })

  const mixedTiles = smaller.tiles.filter((tile) => tile.label === 'Colonies short of workers')

  holds('mixedLaterRecovery', 'PAGE a colony whose worst case first recovers later than the supported dates but has enough workers at the horizon in both cases (a certain early completion and a smaller possible continual yard upgrade) is worded in its row with both months and never as short again, and the tile does not call it one that is "only at best"', () => {
    return smallerRow.committed.recovery.worst > smallerRow.committed.recovery.best && smallerRow.recoveryAtBestOnly === true && smallerRow.shortInBetween === true && smallerRow.mayBeShortLater === false && smallerRow.freeLater > 0 && smallerRow.freeLaterWorst > 0 && !/short again|still short/.test(smallerRow.duringNote) && /1 short on the way, back by 10 y/.test(mixedTiles[0].note) && !/only at best/.test(mixedTiles[0].note)
  })

  // Linear monthly growth supplies 49.065720761 M workers at ten years. A 9.54 M slipway leaves demand at 49.04 M supported and 49.08 M possible, so only the latter is short again.
  const second = await open({ InstallationWorkers: 38.5 }, [factories()], { attentionOnly: true, yardActivities: [yardRow({ ShipyardID: 6, UpgradeTaskType: 8, CapacityTarget: 10080 }), yardRow({ ShipyardID: 7, UpgradeTaskType: 1, Slipways: 1, Capacity: 38160, RemainingProduction: 17300 })] })
  const [secondRow] = second.rows
  const [secondTile] = second.tiles.filter((tile) => tile.label === 'Colonies short of workers')

  holds('secondShortage', 'PAGE a colony that is short in month 1 and healthy again in the same month in both cases, but short again at the horizon in the worst case after a later dated addition (a certain early completion, a possible continual yard upgrade and a slipway added later), says in its row that it is back by that month and short again at worst at the horizon, never that it is back without qualification, and the tile counts it as short on the way "only at best"', () => {
    return secondRow.committed.firstShort.best === 1 && secondRow.committed.recovery.best > 1 && secondRow.committed.recovery.worst === secondRow.committed.recovery.best && secondRow.recoveryAtBestOnly === false && secondRow.shortInBetween === true && secondRow.mayBeShortLater === true && secondRow.freeLater > 0 && secondRow.freeLaterWorst < 0 && second.visibleRows.length === 1 && /^Short of workers from month 1, back by month \d+; short again at worst by 10 y$/.test(secondRow.duringNote) && /1 short on the way, back by 10 y \(1 of them only at best\)/.test(secondTile.note) && !/more may be short/.test(secondTile.note)
  })

  // Synthetic: a possible continual yard upgrade (1 M of workers from month 1 to its target) and, from month 14, a slipway that adds 4.88 M for certain. The upgrade alone puts the worst case short from month 1 until it recovers early; the slipway then puts both cases short from month 14.
  const episodes = (target) => open({ InstallationWorkers: 23.24, YardWorkers: 14.76 }, [], { horizon: 5, attentionOnly: true, yardActivities: [yardRow({ UpgradeTaskType: 8, CapacityTarget: target }), yardRow({ ShipyardID: 6, ShipyardName: 'Later slipway', UpgradeTaskType: 1, Capacity: 19520, RemainingProduction: 10000 })] })
  const [earlier, earlierThenShort] = [await episodes(12000), await episodes(12400)]
  const [earlierRow] = earlier.rows
  const [thenShortRow] = earlierThenShort.rows
  const [earlierTile] = earlier.tiles.filter((tile) => tile.label === 'Colonies short of workers')
  const [thenShortTile] = earlierThenShort.tiles.filter((tile) => tile.label === 'Colonies short of workers')

  holds('earlierWorstRecovery', 'PAGE the row names the recovery of the supported shortage at month 47 and its possible extension through month 59, not the earlier possible recovery at month 3', () => {
    return earlierRow.committed.firstShort.best === 14 && earlierRow.committed.firstShort.worst === 1 && earlierRow.committed.recovery.worst === 3 && earlierRow.committed.recovery.best === 47 && earlierRow.committed.recovery.worstAfterBest === 59 && earlierRow.shortInBetween === true && earlierRow.mayBeShortLater === false && earlier.visibleRows.length === 1 && /^Short of workers from month 14, back by month 47 at best, month 59 at worst$/.test(earlierRow.duringNote) && /1 short on the way, back by 5 y/.test(earlierTile.note) && !/only at best/.test(earlierTile.note)
  })

  holds('earlierWorstRecoveryThenShort', 'PAGE the same colony with a slightly larger possible upgrade, whose worst case is still short at the horizon from the month of the certain later addition, says in its row that the worst case is still short at the horizon, never that it is back in the month its earlier, separate shortage ended, and the tile counts it as "only at best"', () => {
    return thenShortRow.committed.firstShort.best === 14 && thenShortRow.committed.firstShort.worst === 1 && thenShortRow.committed.recovery.worst === 5 && thenShortRow.committed.recovery.best === 47 && thenShortRow.committed.recovery.worstAfterBest === null && thenShortRow.shortInBetween === true && thenShortRow.mayBeShortLater === true && earlierThenShort.visibleRows.length === 1 && /^Short of workers from month 14, back by month 47 at best; still short at worst at 5 y$/.test(thenShortRow.duringNote) && /1 short on the way, back by 5 y \(1 of them only at best\)/.test(thenShortTile.note)
  })

  return results
}

const COLONIES_FILE = 'colonies.js'
const DEMAND_FILE = 'workforce-demand.js'

const MUTANTS = [
  { name: 'a completion counted in the month before the one its day falls in (floor for ceil)', file: DEMAND_FILE, from: 'Math.ceil((day * MONTHS_PER_YEAR) / DAYS_PER_YEAR - EPSILON)', to: 'Math.floor((day * MONTHS_PER_YEAR) / DAYS_PER_YEAR - EPSILON)', fails: 'yardDate' },
  { name: 'a month that is 30 days long', file: DEMAND_FILE, from: 'const dayOfMonth = (month) => (month * DAYS_PER_YEAR) / MONTHS_PER_YEAR', to: 'const dayOfMonth = (month) => month * 30', fails: 'range' },
  { name: 'a conversion that adds the whole installation and takes nothing off for the one replaced', file: DEMAND_FILE, from: 'delta: row.Workers - (from ? from.Workers : 0) })', to: 'delta: row.Workers })', fails: 'conversion' },
  { name: 'a paused project that is counted as built', file: DEMAND_FILE, from: 'return event(\'paused\', 0, none, none)', to: 'return event(\'paused\', total, stepFrom(months, 1, total), stepFrom(months, 1, total))', fails: 'paused' },
  { name: 'a stalled project that is certain to be built (the lower demand takes it)', file: DEMAND_FILE, from: 'figure.delivered, none, maybe)', to: 'figure.delivered, maybe, maybe)', fails: 'stalled' },
  { name: 'a stalled project counted for all it was ordered rather than what its stock builds', file: DEMAND_FILE, from: 'figure.stall && figure.stall.reason === \'remainder\' ? total : 0)', to: 'figure.stall ? total : 0)', fails: 'stalled' },
  { name: 'a project with no date that is certain in the lower demand', file: DEMAND_FILE, from: 'return { ...event(\'unknown\', total, none, stepFrom(months, 1, total)), earliest: null, latest: null }', to: 'return { ...event(\'unknown\', total, stepFrom(months, 1, total), stepFrom(months, 1, total)), earliest: null, latest: null }', fails: 'unknownDate' },
  { name: 'a date from only some orders taken as a bound', file: DEMAND_FILE, from: 'const finishes = figure.outcome === \'finishes\' && exhaustive && figure.latest !== null', to: 'const finishes = figure.outcome === \'finishes\' && figure.latest !== null', fails: 'sampled' },
  { name: 'a yard upgrade counted from the first month', file: DEMAND_FILE, from: 'const from = monthOfDay(day)', to: 'const from = 1', fails: 'yardDate' },
  { name: 'a paused yard activity that is counted', file: DEMAND_FILE, from: 'if (paused === true) {', to: 'if (false) {', fails: 'yardPaused' },
  { name: 'a yard upgrade the stock cannot pay for that is counted as certain', file: DEMAND_FILE, from: 'stocks.some((stock) => stock < needed)', to: 'false', fails: 'yardShort' },
  { name: 'a yard with an unknown stock row that is counted as if it held enough', file: DEMAND_FILE, from: 'if (type !== 8 && !stocks.every(finite)) {', to: 'if (false) {', fails: 'yardShort' },
  { name: 'a yard activity of an unknown type that is counted as a change of nothing', file: DEMAND_FILE, from: '} else if (!YARD_ACTIVITIES[type]) {', to: '} else if (false) {', fails: 'yardType' },
  { name: 'a retool that raises the yard\'s workers', file: DEMAND_FILE, from: 'if (type === 7) {\n    return { delta: 0 }', to: 'if (type === 7) {\n    return { delta: 0.1 }', fails: 'retool' },
  { name: 'a colony of a spied empire that is worked out from its own stock', file: DEMAND_FILE, from: 'if (npr && (needs.installation.length || needs.yards.length)) {', to: 'if (false) {', fails: 'unavailable' },
  { name: 'a queue forecast still running that is read as nothing queued', file: DEMAND_FILE, from: 'gaps.push(\'the queue forecast (still running)\')', to: 'void 0', fails: 'unavailable' },
  { name: 'a light yard\'s workers counted at a tenth, as a commercial yard\'s', file: DEMAND_FILE, from: 'isFullCapacityYard(yardType) ? 1 : 0.1', to: 'yardType === 1 ? 1 : 0.1', fails: 'yardLight' },
  { name: 'a light yard not counted among the yards that need the whole capacity', file: 'shipyard-types.js', from: 'export const isFullCapacityYard = (type) => type === SHIPYARD_TYPE.NAVAL || type === SHIPYARD_TYPE.LIGHT', to: 'export const isFullCapacityYard = (type) => type === SHIPYARD_TYPE.NAVAL', fails: 'yardLight' },
  { name: 'the lower and the higher demand swapped', file: DEMAND_FILE, from: 'const [low, high] = requiredSeries(events, colony.InstallationWorkers + colony.YardWorkers, months)', to: 'const [high, low] = requiredSeries(events, colony.InstallationWorkers + colony.YardWorkers, months)', fails: 'bounds' },
  { name: 'workers needed today that leave the yards out', file: COLONIES_FILE, from: 'required = colony.InstallationWorkers + colony.YardWorkers', to: 'required = colony.InstallationWorkers', fails: 'currentSplit' },
  { name: 'orbital people omitted from the committed worker split', file: DEMAND_FILE, from: 'workerSplit(colony, population, value, required[month])', to: 'workerSplit({ ...colony, OrbitalPopulation: 0 }, population, value, required[month])', fails: 'ark' },
  { name: 'a committed split that does not equal the current one where nothing is queued (the horizon figure takes the yards off twice)', file: DEMAND_FILE, from: 'const [low, high] = requiredSeries(events, colony.InstallationWorkers + colony.YardWorkers, months)', to: 'const [low, high] = requiredSeries(events, colony.InstallationWorkers + 2 * colony.YardWorkers, months)', fails: 'zeroEvents' },
  { name: 'a first short month taken from the lower demand only', file: DEMAND_FILE, from: 'firstShort: { best: firstShort(free.best), worst: firstShort(free.worst) }', to: 'firstShort: { best: firstShort(free.best), worst: firstShort(free.best) }', fails: 'firstShort' },
  { name: 'a worst case recovery taken from its own first shortage, not from the one that holds the best case\'s', file: DEMAND_FILE, from: 'worstAfterBest: recoveryAfter(free.worst, firstShort(free.best))', to: 'worstAfterBest: recoveryOf(free.worst)', fails: 'recoveryEpisode' },
  { name: 'a project queued in the order the forecast kept, which another order starts, that adds nothing to the higher demand', file: DEMAND_FILE, from: 'return maybe.some((units) => units > 0) ? event(\'maybe\', 0, none, maybe) : event(\'queued\', 0, none, none)', to: 'return event(\'queued\', 0, none, none)', fails: 'queuedOrder' },
  { name: 'a project queued in some orders that is certain in the lower demand', file: DEMAND_FILE, from: 'event(\'maybe\', 0, none, maybe)', to: 'event(\'maybe\', 0, maybe, maybe)', fails: 'queuedOrder' },
  { name: 'a project queued where only some orders were tried, taken as one that never starts', file: DEMAND_FILE, from: 'const most = queued && !exhaustive ? total : ', to: 'const most = ', fails: 'queuedSampled' },
  { name: 'a continual upgrade whose completion is certain in the lower demand', file: DEMAND_FILE, from: 'event(\'approximate\', none, stepFrom(months, 1, 1)', to: 'event(\'approximate\', stepFrom(months, from, 1), stepFrom(months, 1, 1)', fails: 'continual' },
  { name: 'a continual upgrade with no stock whose completion is certain, as a finite one with no stock is not', file: DEMAND_FILE, from: 'event(\'approximate\', none, stepFrom(months, 1, 1)', to: 'event(\'approximate\', stepFrom(months, from, 1), stepFrom(months, 1, 1)', fails: 'continualZero' },
  { name: 'a continual upgrade with no capacity target taken as one that stops at today\'s capacity', file: DEMAND_FILE, from: 'type === 8 && flagOf(yard.Paused) !== true && !(yard.CapacityTarget > 0)', to: 'type === 8 && flagOf(yard.Paused) !== true && !finite(yard.CapacityTarget)', fails: 'continualNoTarget' },
  { name: 'a paused continual upgrade with no capacity target that makes the colony unavailable', file: DEMAND_FILE, from: 'type === 8 && flagOf(yard.Paused) !== true && !(yard.CapacityTarget > 0)', to: 'type === 8 && !(yard.CapacityTarget > 0)', fails: 'continualPausedNoTarget' },
]

const PAGE_MUTANTS = [
  { name: 'the page omits orbital people from the worker inputs', from: 'OrbitalPopulation: valueOrNull(orbital)', to: 'OrbitalPopulation: 0', fails: 'orbitalPage' },
  { name: 'an attention filter that hides a colony short only in the worst case', from: '(!this.attentionOnly || row.attention === true || row.shortInBetween === true || row.mayBeShortDuring === true)', to: '(!this.attentionOnly || row.attention === true || row.shortInBetween === true)', fails: 'attentionPossible' },
  { name: 'a tile that does not say how many colonies may be short', from: '$' + '{possible ? `$' + '{possible} more may be short at worst · ` : \'\'}', to: '', fails: 'attentionPossible' },
  { name: 'a tile that counts the worst case as the certain shortage at the horizon', from: 'const shortLater = countOf(\'workersLater\', isShort)', to: 'const shortLater = countOf(\'workersLaterWorst\', isShort)', fails: 'attentionPossible' },
  { name: 'an attention flag that takes the worst case as certain', from: 'attention: attentionResult(results.workersNow, bestLater, results.projection)', to: 'attention: attentionResult(results.workersNow, worstResult, results.projection)', fails: 'attentionPossible' },
  { name: 'a queued project the forecast may start labelled as an observed start in some orders', from: 'maybe: \'May start, adds nothing certain\'', to: 'maybe: \'Starts in some orders\'', fails: 'maybeLabel' },
  { name: 'a tile with a certain shortage at the horizon that shows the success tick (icon)', from: 'icon: shortNowValue > 0 || shortLaterValue > 0 || recovered > 0 || possible > 0', to: 'icon: shortNowValue > 0 || recovered > 0 || possible > 0', fails: 'laterTile' },
  { name: 'a tile with a certain shortage at the horizon that shows the success tick (colour)', from: 'iconColor: shortNowValue > 0 || shortLaterValue > 0 || recovered > 0 || possible > 0', to: 'iconColor: shortNowValue > 0 || recovered > 0 || possible > 0', fails: 'laterTile' },
  { name: 'an attention filter that keeps a colony short in between only for the worst case at the horizon', from: 'row.shortInBetween === true || row.mayBeShortDuring === true)', to: 'row.shortInBetween === true || row.mayBeShortLater === true)', fails: 'duringPossible' },
  { name: 'an attention filter that hides a colony short for some months and enough again at the horizon', from: 'row.attention === true || row.shortInBetween === true ||', to: 'row.attention === true ||', fails: 'duringCertain' },
  { name: 'a tile that does not say how many colonies were short on the way', from: '$' + '{recovered ? `', to: '$' + '{false ? `', fails: 'duringCertain' },
  { name: 'a tile with a colony short on the way that shows the success tick (icon)', from: 'icon: shortNowValue > 0 || shortLaterValue > 0 || recovered > 0 || possible > 0', to: 'icon: shortNowValue > 0 || shortLaterValue > 0 || possible > 0', fails: 'duringCertain' },
  { name: 'a colony short in between taken as one that may be short', from: 'mayBeShortDuring: committed !== null && committed.firstShort.best === null && ', to: 'mayBeShortDuring: committed !== null && ', fails: 'duringCertain' },
  { name: 'a row that does not say from which month it is short', from: 'row.duringNote = committed ? this.duringNote(row) : \'\'', to: 'row.duringNote = \'\'', fails: 'duringCertain' },
  { name: 'a possible shortage on the way, said as certain', from: 'return `May be short of workers at worst from', to: 'return `Short of workers from', fails: 'duringPossible' },
  { name: 'a recovery that holds only in the best case worded as one both cases support (row)', from: 'if (row.shortInBetween && row.mayBeShortLater) {', to: 'if (false) {', fails: 'mixedRecovery' },
  { name: 'a recovery that holds only in the best case counted in the tile as one both cases support', from: '$' + '{atBest ? ` ($' + '{atBest} of them only at best)` : \'\'}', to: '', fails: 'mixedRecovery' },
  { name: 'a recovery taken as one both cases support whatever the worst case does', from: 'committed.recovery.worstAfterBest !== committed.recovery.best', to: 'false', fails: 'mixedRecovery' },
  { name: 'a tile that counts a colony as one that recovers only at best from the first-recovery months, not from the horizon balance', from: 'rows.filter((row) => row.shortInBetween && row.mayBeShortLater).length', to: 'rows.filter((row) => row.shortInBetween && row.recoveryAtBestOnly).length', fails: 'mixedLaterRecovery' },
  { name: 'a row short again at worst at the horizon that is worded as one that is back for good', from: '; short again at worst by $' + '{this.horizon} y', to: '', fails: 'secondShortage' },
  { name: 'a row that pairs the worst case\'s recovery from an earlier shortage of its own with the named shortage (recovering branch)', from: '$' + '{month(committed.recovery.worstAfterBest)} at worst', to: '$' + '{month(committed.recovery.worst)} at worst', fails: 'earlierWorstRecovery' },
  { name: 'a row that pairs the worst case\'s recovery from an earlier shortage of its own with the named shortage (short at the horizon)', from: 'const { best, worstAfterBest: worst } = committed.recovery', to: 'const { best, worst } = committed.recovery', fails: 'earlierWorstRecoveryThenShort' },
]

// The colonies, projects, yards and installation types the page reads, against counts of the rows in the save.
const saveCases = async (database, save, pageOptions, apps, productionOptions, store) => {
  const name = database.file
  const reads = ['colonies', 'inbound', 'populationProductionModifiers', 'arks']
  const vm = instantiate(pageOptions, { ...store, database, GameID: save.game, RaceID: save.race })

  for (const read of reads) {
    await vm.runAsync(read)
  }

  const queriesFor = (pattern) => database.queries.filter((sql) => pattern.test(sql)).length

  database.queries.length = 0
  await vm.runAsync('industry')
  await vm.runAsync('yardActivities')
  await vm.runAsync('installationTypes')

  check(`${name}: on the current basis the page reads nothing extra: no project, shipyard activity or installation type is queried, and the forecast has no colony to run`, vm.industry.length === 0 && vm.yardActivities.length === 0 && Object.keys(vm.installationTypes).length === 0 && queriesFor(/FCT_IndustrialProjects|FCT_Shipyard|DIM_PlanetaryInstallation/) === 0 && vm.forecastRunInput.colonies.length === 0)

  const reference = apps.colonies.outlookColonies(vm.rows, vm.inbound, vm.horizon)
  const rows = vm.rows
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  check(`${name}: on the current basis every one of the ${rows.length} rows is the Outlook's own, value for value: the worker splits now and at the horizon, the attention flag and the population projection`, rows.length === reference.length && rows.length > 0 && rows.every((row, index) => same(row.r.workersNow, reference[index].results.workersNow) && same(row.r.workersLater, reference[index].results.workersLater) && same(row.r.attention, reference[index].results.attention) && same(row.r.projection, reference[index].results.projection) && row.events.length === 0 && row.committedResult === null && row.laterRange === false))

  const production = instantiate(productionOptions, { ...store, database, GameID: save.game, RaceID: save.race })

  vm.workerBasis = 'committed'
  await vm.runAsync('industry')
  await vm.runAsync('yardActivities')
  await vm.runAsync('installationTypes')
  await production.runAsync('industry')

  const [{ projects: projectCount }] = await rowsOf(database, `select count(*) as projects from FCT_IndustrialProjects where GameID = ${save.game} and RaceID = ${save.race}`)
  const [{ yards: yardCount }] = await rowsOf(database, `select count(*) as yards from FCT_Shipyard where TaskType <> 0 and GameID = ${save.game} and RaceID = ${save.race} and not exists (select 1 from FCT_Ship where FCT_Ship.ShipID = FCT_Shipyard.ParentShipID and FCT_Ship.GameID = FCT_Shipyard.GameID)`)
  const [{ types: typeCount }] = await rowsOf(database, 'select count(*) as types from DIM_PlanetaryInstallation')
  const order = (list) => list.map((project) => `${project.PopulationID}:${project.ID}`).join()

  check(`${name}: with the queue counted the page reads every industrial project (${projectCount}), every activity of a shipyard no ship holds (${yardCount}) and every installation type (${typeCount}) of the save, the projects in the order the Production page reads them`, vm.industry.length === projectCount && vm.yardActivities.length === yardCount && Object.keys(vm.installationTypes).length === typeCount && order(vm.industry) === order(production.industry) && vm.industry.every((project) => 'ProductionID' in project))

  const emptied = instantiate(pageOptions, { ...store, database, GameID: save.game, RaceID: save.race, data: { workerBasis: 'committed', colonies: vm.colonies, inbound: vm.inbound, populationProductionModifiers: vm.populationProductionModifiers, arks: vm.arks, industry: [], yardActivities: [], installationTypes: {} } })

  check(`${name}: on the committed basis with nothing queued every row's worker split at the horizon and its attention flag are the current basis's, value for value`, emptied.rows.length === rows.length && emptied.rows.every((row, index) => same(row.workersLater, rows[index].workersLater) && same(row.workersNow, rows[index].workersNow) && row.attention === rows[index].attention && row.committed && row.events.length === 0 && row.laterRange === false))

  await vm.startForecast()

  const committedRows = vm.rows
  const plans = vm.industryPlans
  const forecasts = vm.forecastCurrent
  const needsBy = vm.workforceNeedsByColony
  const withQueue = committedRows.filter((row) => row.events.length)
  const installationEvents = committedRows.flatMap((row) => row.events.filter((event) => event.kind === 'installation').map((event) => ({ row, event })))
  const yardEvents = committedRows.flatMap((row) => row.events.filter((event) => event.kind === 'yard').map((event) => ({ row, event })))
  const forecastCount = Object.keys(plans).length

  check(`${name}: the queue forecast ran for the ${forecastCount} colonies whose installations change the workers, kept with the key of the input it was for and without an error`, forecasts !== null && forecasts.error === null && (forecastCount === 0 || (forecasts.colonies !== null && Object.keys(plans).every((id) => plans[id].gaps || forecasts.colonies[id]))))

  check(`${name}: with the queue counted each row is a result: a colony is unavailable only where a gap says why, and the rows' worker split now, population and projection are unchanged`, committedRows.length === rows.length && committedRows.every((row, index) => same(row.workersNow, rows[index].workersNow) && same(row.r.projection, rows[index].r.projection) && row.committedResult !== null && (row.committed !== null || row.committedResult.inputs.missing.length > 0)))

  const aligned = Object.keys(needsBy).every((id) => {
    const forecast = forecasts && forecasts.colonies ? forecasts.colonies[id] : null

    return !forecast || forecast.gaps || needsBy[id].installation.every(({ index, project }) => forecast.figures[index].forecast.ID === project.ID)
  })
  const dated = installationEvents.filter(({ event }) => event.status === 'dated' && event.delta > 0)
  const wrongMonth = dated.filter(({ event, row }) => {
    const month = Math.max(1, Math.ceil((event.earliest * 12) / 365 - 1e-9))
    const series = row.committed.required.low
    const before = series[month - 1]

    return month <= row.committed.months && series[month] - before < event.delta * event.units - 1e-9
  })

  if (!installationEvents.length) {
    unsupportedNote(`${name}: installation events from the queue`, 'no queued project of the race changes the workers')
  } else {
    check(`${name}: every installation event of the ${installationEvents.length} is a project of its colony in the forecast's own order (the figure of its index is that project), carries the project's name, and a dated one raises the lower demand at the month its day falls in (${dated.length} checked)`, aligned && installationEvents.every(({ row, event }) => event.id.startsWith('project-') && vm.industry.some((project) => project.PopulationID === row.PopulationID && `project-${project.ID}` === event.id && project.Name === event.name)) && wrongMonth.length === 0, wrongMonth.slice(0, 2).map(({ event }) => event.id).join())

    const phantom = installationEvents.filter(({ event }) => {
      const flat = (series) => series.every((change) => change === 0)

      return (['paused', 'queued'].includes(event.status) && !(flat(event.low) && flat(event.high))) || (['stalled', 'later', 'unknown', 'sampled', 'maybe', 'approximate'].includes(event.status) && event.delta > 0 && !flat(event.low))
    })

    check(`${name}: no phantom installation: a paused project, and a queued one every order of the forecast leaves queued, add nothing, and a stalled, unresolved, beyond-the-horizon, sampled or queued-in-some-orders one adds nothing to the lower demand (${installationEvents.filter(({ event }) => ['paused', 'queued', 'stalled', 'later', 'unknown', 'sampled', 'maybe'].includes(event.status)).length} of them here)`, phantom.length === 0, phantom.slice(0, 2).map(({ event }) => event.id).join())
  }

  if (!yardEvents.length) {
    unsupportedNote(`${name}: yard events from the activities`, 'no shipyard activity of the race changes its workers')
  } else {
    const bad = yardEvents.filter(({ event, row }) => !event.id.startsWith('yard-') || !vm.yardActivities.some((yard) => yard.PopulationID === row.PopulationID && `yard-${yard.ShipyardID}` === event.id) || (event.status === 'paused' && event.high.some((change) => change !== 0)))

    check(`${name}: every one of the ${yardEvents.length} yard events is an activity of its colony, and a paused one adds nothing`, bad.length === 0)
  }

  const bounded = committedRows.filter((row) => row.committed).every((row) => row.committed.required.low.every((workers, month) => workers <= row.committed.required.high[month] + TOLERANCE) && row.committed.free.best.every((free, month) => free >= row.committed.free.worst[month] - TOLERANCE) && row.workersLater && near(row.workersLater.free, row.committed.later.best.free) && row.workersLaterWorst.free <= row.workersLater.free + TOLERANCE)

  check(`${name}: on every row the lower demand stays within the higher, the best case has at least the worst case's free workers, and the row's horizon figure is the best case`, bounded)

  const arkRows = committedRows.filter((row) => row.ark && row.committed)
  const arkLeak = committedRows.filter((row) => row.committed && !near(row.workersLater.population, row.final))

  if (!arkRows.some((row) => valueOrZero(row.ark.occupied) > 0)) {
    unsupportedNote(`${name}: a colony with people aboard Arks`, 'no Ark of the race is at a colony with a known population aboard')
  }

  check(`${name}: orbital people stay out of surface growth while remaining in the total workforce population (${committedRows.filter((row) => row.committed).length} rows, ${arkRows.length} of them with an Ark)`, arkLeak.length === 0 && committedRows.filter((row) => row.committed).every((row) => near(row.workersLater.totalPopulation, row.final + row.OrbitalPopulation)))

  console.log(`  ${name}: ${withQueue.length} colonies with events, ${installationEvents.length} installation events (${dated.length} dated), ${yardEvents.length} yard events, ${committedRows.filter((row) => row.laterRange).length} with a range at the horizon, ${committedRows.filter((row) => !row.committed).length} unavailable`)
}

// ---------- the species growth modifier ----------

// The save whose own colonies are run through the growth rule: the interim 3.1 fixture (a game of the earlier line migrated to the 3.1 schema, race 784 of game 141). Its tables are read by hand rather than through the Outlook's colonies read, which is of the earlier schema; a save that is not there reads UNSUPPORTED.
const GROWTH_SAVES = [fixtureSave()]

// The faults planted in the growth rule, each with the worked case and the save case that must fail with it.
const GROWTH_MUTANTS = [
  { name: 'a species growth modifier applied to growth that is not positive, as the earlier line did', file: COLONIES_FILE, from: '(growth > 0 ? growth * colony.PopulationGrowthModifier : growth)', to: '(growth * colony.PopulationGrowthModifier)', fails: 'growthModifier', save: 'growthSaveUnscaled' },
  { name: 'a species growth modifier left out of growth that is positive', file: COLONIES_FILE, from: 'growth > 0 ? growth * colony.PopulationGrowthModifier : growth', to: 'growth', fails: 'growthModifier', save: 'growthSaveScaled' },
]

// Species scaling is isolated on saved populations at a hypothetical zero colony cost, so no infrastructure shortfall masks the branch: radiation is subtracted before positive crowding, while negative growth and an empty population are not crowded.
const growthSaveCases = async (database, save, apps) => {
  const name = database.file
  const colonies = await rowsOf(database, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.SystemBodyID, FCT_Population.ReqInf, FCT_Species.PopulationGrowthModifier, FCT_Species.PopulationDensityModifier, FCT_SystemBody.Radius, FCT_SystemBody.HydroExt, FCT_SystemBody.TidalLock, FCT_SystemBody.BodyClass, FCT_SystemBody.RadiationLevel from FCT_Population inner join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${save.game} and FCT_Population.RaceID = ${save.race} and FCT_Population.Population > 0 order by FCT_Population.PopulationID`)
  const bodies = new Map((await rowsOf(database, `select SystemBodyID, sum(Population) as Population from FCT_Population where GameID = ${save.game} and RaceID = ${save.race} group by SystemBodyID`)).map((row) => [row.SystemBodyID, row.Population]))
  // The installations the page's own colonies read sums, so that a colony's infrastructure cap is the one the Outlook works with.
  const installations = new Map((await rowsOf(database, `select FCT_PopulationInstallations.PopID, sum(DIM_PlanetaryInstallation.InfrastructureValue * FCT_PopulationInstallations.Amount) as Infrastructure, sum(DIM_PlanetaryInstallation.LGInfrastructureValue * FCT_PopulationInstallations.Amount) as LGInfrastructure, sum(DIM_PlanetaryInstallation.Workers * FCT_PopulationInstallations.Amount) as Workers from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${save.game} group by FCT_PopulationInstallations.PopID`)).map((row) => [row.PopID, row]))
  const rows = colonies.map((colony) => {
    const built = installations.get(colony.PopulationID) || { Infrastructure: 0, LGInfrastructure: 0, Workers: 0 }

    return { ...colony, BodyPopulation: bodies.get(colony.SystemBodyID), CurrentColonyCost: 0, MaximumColonyCost: 0, OrbitalPopulation: 0, PopulationGrowthBonus: 1, Infrastructure: built.Infrastructure, LGInfrastructure: built.LGInfrastructure, InstallationWorkers: built.Workers, YardWorkers: 0, InfrastructureCost: 0, LowGravity: 0 }
  })
  const capacityOf = (row) => apps.colonies.bodyCapacity(row)
  const crowdOf = (row) => apps.colonies.crowdingFactor(row.BodyPopulation, capacityOf(row))
  const rateOf = (row) => apps.colonies.growthRate(row, row.Population, row.BodyPopulation, capacityOf(row))
  const rateWith = (row, change) => {
    const changed = { ...row, ...change }

    return apps.colonies.growthRate(changed, changed.Population, changed.BodyPopulation, capacityOf(changed))
  }
  const baseOf = (row) => Math.min(0.1, 0.2 / Math.cbrt(row.Population))
  // The share of a rate the species modifier takes: the rate without radiation over the base rate and the crowding factor. It is the species modifier where the modifier is applied, 1 where growth is positive and the modifier is not, and -1 where the growth itself is negative and the modifier is not.
  const shareOf = (rate, row) => (rate / crowdOf(row) + Math.round(row.RadiationLevel * 0.25) / 10000) / baseOf(row)

  if (!rows.length) {
    return { cases: [], unsupported: [`${name}: the species growth modifier`, 'the race holds no colony with people'], discriminates: { growthSaveScaled: false, growthSaveUnscaled: false } }
  }

  const scalable = rows.filter((row) => row.PopulationGrowthModifier !== 1 && crowdOf(row) > 0)
  // Whether the save can tell a growth mutant apart: a colony whose species modifier is not 1, whose crowding factor is positive, and whose growth the case runs has the sign the mutant changes — positive where the modifier must be applied, negative where it must be left off. The stock save's colonies all read 1, so it credits neither mutant and its save case is unsupported for both.
  const discriminates = {
    growthSaveScaled: scalable.some((row) => baseOf(row) * row.PopulationGrowthBonus > 0),
    growthSaveUnscaled: scalable.some((row) => baseOf(row) * -1 < 0),
  }
  const lossShare = (row) => (rateWith(row, { PopulationGrowthBonus: -1 }) + Math.round(row.RadiationLevel * 0.25) / 10000) / baseOf(row)
  const wrongScaled = scalable.filter((row) => !near(shareOf(rateOf(row), row), row.PopulationGrowthModifier))
  const wrongUnscaled = scalable.filter((row) => !near(lossShare(row), -1) || near(lossShare(row), -row.PopulationGrowthModifier))
  const wrongLoss = scalable.filter((row) => !near(rateWith(row, { PopulationGrowthBonus: -1 }), -baseOf(row) - Math.round(row.RadiationLevel * 0.25) / 10000))
  const wrongZero = rows.filter((row) => !near(rateWith(row, { Population: 0 }), 0))
  const entries = apps.colonies.outlookColonies(rows, [], YEARS)
  // The first projected month takes one linear one-twelfth-year increment at that annual rate.
  const wrongOutlook = rows.filter((row, index) => {
    const { growth, projection } = entries[index].results

    if (growth.value === null || projection.value === null) {
      return true
    }

    const rate = rateOf(row)
    const grown = Math.max(0, row.Population * (1 + rate / 12))

    return !near(growth.value, rate) || !near(projection.value.series[0], row.Population) || !near(projection.value.series[1], grown)
  })
  const cases = [
    [`${name}: each of the ${rows.length} colonies grows at its own species modifier over the base rate and the crowding factor (${scalable.length} of them with a modifier other than 1)`, wrongScaled.length === 0, 'growthSaveScaled'],
    [`${name}: a governor bonus that takes a colony's growth below zero is not species-scaled: the loss is the base rate and the crowding factor, with no modifier of the ${scalable.length} colonies`, wrongUnscaled.length === 0 && wrongLoss.length === 0, 'growthSaveUnscaled'],
    [`${name}: a colony with no people grows at 0 whatever its species modifier or radiation reads`, wrongZero.length === 0, 'growthSaveZero'],
    [`${name}: the Outlook's growth figure and its first projected month are that rate on all ${rows.length} colonies`, wrongOutlook.length === 0, 'growthSaveOutlook'],
  ]

  return { cases, unsupported: scalable.length ? [] : [[`${name}: a colony whose species growth modifier is not 1`, 'no colony of the race has one']], discriminates }
}

// ---------- the yards aboard a ship ----------

const PAGE_FILE = path.join('src', 'renderer', 'pages', 'colony-outlook.vue')
// The page's two filters of the yards no ship holds: in the colonies read and in the shipyard activities read.
const COLONY_YARDS_FILTER = ' and coalesce(FCT_Shipyard.ParentShipID, 0) <= 0 group by FCT_Shipyard.PopulationID'
const ACTIVITIES_FILTER = 'where FCT_Shipyard.TaskType <> 0 and coalesce(FCT_Shipyard.ParentShipID, 0) <= 0 and'

// The faults planted in the page's reads, each with the checks that must fail by a value on every save that holds the case.
const SHIP_YARD_FAULTS = [
  { name: 'the yards aboard a ship counted in the workers a colony needs', from: COLONY_YARDS_FILTER, to: ' group by FCT_Shipyard.PopulationID', fails: ['yards-colony'] },
  { name: 'the activity of a yard aboard a ship read with the colony\'s', from: ACTIVITIES_FILTER, to: 'where FCT_Shipyard.TaskType <> 0 and', fails: ['yards-activity'] },
]

// Both filters said another way, as a parenthesised condition: every check of the yards aboard a ship must still hold.
const SHIP_YARD_REWRITE = [
  [COLONY_YARDS_FILTER, ' and (FCT_Shipyard.ParentShipID is null or FCT_Shipyard.ParentShipID <= 0) group by FCT_Shipyard.PopulationID'],
  [ACTIVITIES_FILTER, 'where FCT_Shipyard.TaskType <> 0 and (FCT_Shipyard.ParentShipID is null or FCT_Shipyard.ParentShipID <= 0) and'],
]

// `work()` on a copy of the save in which each table of `edits` ({ [table]: [statement] }) is a temporary table made from the save's own and changed by its statements; the copies are dropped afterwards.
const onCopy = async (database, edits, work) => {
  const tables = Object.keys(edits)

  for (const statement of tables.flatMap((table) => [`create temp table ${table} as select * from main.${table}`, ...edits[table]])) {
    await database.run(statement)
  }

  try {
    return await work()
  } finally {
    for (const table of tables) {
      await database.run(`drop table temp.${table}`)
    }
  }
}

// What the race's yards need, worked out here from the save's rows the way the game counts them: a yard counts at its colony unless its ParentShipID names a ship of the game, with capacity x slipways / 4,000 at a naval yard (type 1) or a Light yard (type 4) and a tenth of that at any other. { workers: { [PopulationID]: M workers }, aboard: { [PopulationID]: [ShipyardID] }, activities: [ShipyardID] of the yards no ship holds that have an activity, in order }.
const yardOracle = async (database, save) => {
  const yards = await rowsOf(database, `select ShipyardID, PopulationID, SYType, Slipways, Capacity, TaskType, ParentShipID from FCT_Shipyard where GameID = ${save.game} and RaceID = ${save.race}`)
  const ships = new Set((await rowsOf(database, `select ShipID from FCT_Ship where GameID = ${save.game}`)).map((row) => row.ShipID))
  const workers = {}
  const aboard = {}

  yards.forEach((yard) => {
    if (ships.has(yard.ParentShipID)) {
      (aboard[yard.PopulationID] = aboard[yard.PopulationID] || []).push(yard.ShipyardID)
    } else {
      workers[yard.PopulationID] = (workers[yard.PopulationID] || 0) + (yard.Capacity * yard.Slipways * (yard.SYType === 1 || yard.SYType === 4 ? 1 : 0.1)) / 4000
    }
  })

  return { workers, aboard, activities: yards.filter((yard) => Number.isFinite(yard.TaskType) && yard.TaskType !== 0 && !ships.has(yard.ParentShipID)).map((yard) => yard.ShipyardID).sort((a, b) => a - b) }
}

// The checks of one save that holds yards aboard a ship, as { id, name, run } for `runChecks` (scripts/lib/fault-credit.js): the page runs behind its `boundary`, so a read that throws is told apart from a wrong value.
const shipYardChecks = (database, save) => {
  const named = Object.entries(save.named).map(([id, workers]) => `${id} at ${workers} M`).join(', ')
  const checks = [{
    id: 'yards-colony',
    name: `${database.file}: each colony's shipyards need the workers of the yards no ship holds: the page's colonies read gives every colony the sum over its yards whose ParentShipID names no ship of the game (capacity x slipways / 4,000 at a naval yard, a tenth of it at any other), and the colonies that hold a yard aboard a ship read ${named}`,
    run: ({ pageOptions, store }) => onCopy(database, {}, async () => {
      const oracle = await yardOracle(database, save)
      const vm = instantiate(pageOptions, { ...store, database, GameID: save.game, RaceID: save.race, boundary })
      const colonies = await vm.runAsync('colonies')
      const read = new Map(colonies.map((colony) => [colony.PopulationID, colony.YardWorkers]))
      const wrong = colonies.filter((colony) => !near(colony.YardWorkers, oracle.workers[colony.PopulationID] || 0)).map((colony) => `${colony.PopName} (${colony.PopulationID}) reads ${colony.YardWorkers} M, its yards need ${oracle.workers[colony.PopulationID] || 0} M`)
      const ids = Object.keys(save.named).map(Number)

      assert.ok(ids.every((id) => (oracle.aboard[id] || []).length > 0 && near(oracle.workers[id] || 0, save.named[id])), `the save no longer holds the case: ${ids.map((id) => `${id} has ${(oracle.aboard[id] || []).length} yards aboard a ship and ${oracle.workers[id] || 0} M of its own`).join('; ')}`)
      assert.ok(colonies.length > 0, 'the page reads no colony')
      assert.ok(wrong.length === 0, `${wrong.length} of ${colonies.length} colonies: ${wrong.slice(0, 3).join('; ')}`)
      assert.ok(ids.every((id) => read.has(id) && near(read.get(id), save.named[id])), `the named colonies read ${ids.map((id) => `${id}: ${read.has(id) ? `${read.get(id)} M` : 'no row'}`).join(', ')}`)
    }),
  }]

  if (save.activity) {
    checks.push({
      id: 'yards-activity',
      name: `${database.file}: with the queue counted, an activity of a yard aboard a ship adds no workers to its colony: on a copy in which the ship's yard ${save.activity} is adding a slipway, no yard aboard a ship is among the activities that change a colony's workers, and the page's shipyard activities read holds exactly the activities of the yards no ship holds`,
      run: ({ pageOptions, store }) => onCopy(database, { FCT_Shipyard: [`update FCT_Shipyard set TaskType = 1, RequiredBP = 1000, CompletedBP = 0, PauseActivity = 0 where ShipyardID = ${save.activity}`] }, async () => {
        const oracle = await yardOracle(database, save)
        const aboard = new Set(Object.values(oracle.aboard).flat())
        const vm = instantiate(pageOptions, { ...store, database, GameID: save.game, RaceID: save.race, boundary })

        vm.workerBasis = 'committed'
        await vm.runAsync('colonies')

        const activities = (await vm.runAsync('yardActivities')).map((yard) => yard.ShipyardID).sort((a, b) => a - b)
        const changing = Object.values(vm.workforceNeedsByColony).flatMap((needs) => needs.yards).filter(({ yard }) => aboard.has(yard.ShipyardID)).map(({ yard, delta }) => `yard ${yard.ShipyardID} at ${yard.PopulationID} adds ${delta} M`)

        assert.ok(aboard.has(save.activity), `the copy does not hold the case: yard ${save.activity} is aboard no ship`)
        assert.deepStrictEqual(changing, [], `yards aboard a ship change a colony's workers: ${changing.join('; ')}`)
        assert.deepStrictEqual(activities, oracle.activities, `the activities read are yards ${activities.join(', ') || 'none'}, those of the yards no ship holds ${oracle.activities.join(', ') || 'none'}`)
      }),
    })
  }

  return checks
}

// The yards aboard a ship on the saves that hold them: the head checks and, in a full run, the rewrite that must leave them green and each fault, which must fail its checks by a value on every save that holds the case.
const shipYardCases = async (pageOptions, store) => {
  const opened = []

  for (const save of SHIP_YARD_SAVES) {
    const database = await openSave(save.file)

    if (database) {
      opened.push({ database, save })
    } else {
      unsupportedNote(`${save.file}: the yards aboard a ship`, 'the save is not there')
    }
  }

  try {
    const list = opened.flatMap(({ database, save }) => shipYardChecks(database, save))
    const head = await runChecks(list, { pageOptions, store })

    head.forEach((result) => check(result.name, result.ok, result.detail))

    if (!mutating() || !list.length) {
      return
    }

    const text = fs.readFileSync(path.join(root, PAGE_FILE), 'utf8')
    const load = (source) => loadPage('pages/colony-outlook', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB }, sources: { 'pages/colony-outlook': source } })
    const rewritten = judged(await runChecks(list, { pageOptions: await load(SHIP_YARD_REWRITE.reduce((source, [from, to]) => patched(PAGE_FILE, source, from, to), text)), store }), 'the rewrite of the filters')

    check('both filters of the yards aboard a ship, rewritten as a parenthesised condition, leave every check of them green', rewritten.length === 0, rewritten.map((result) => `${result.id}: ${result.detail}`).join('; '))

    for (const fault of SHIP_YARD_FAULTS) {
      const own = (results) => results.filter((result) => fault.fails.includes(result.id))
      const results = await runChecks(list, { pageOptions: await load(plantedPatch(PAGE_FILE, text, fault.from, fault.to)), store })

      judged(results, fault.name)
      check(`${fault.name} fails ${fault.fails.join(', ')} by a value on each save that holds the case`, own(head).length > 0 && own(head).every((result) => result.ok) && caughtAll(own(results), fault), own(results).map((result) => `${result.name.split(':')[0]} ${result.id}: ${result.detail || 'holds'}`).join('; '))
    }
  } finally {
    opened.forEach(({ database }) => database.close())
  }
}

const valueOrZero = (result) => (result && result.status !== 'unavailable' ? result.value : 0)

// The species growth modifier on the worked cases and on the saves that hold colonies: the cases printed, and in a full run each planted fault, which must fail its worked case and the save case beside it.
const growthSection = async (apps, capacities, results) => {
  console.log('\n== the species growth modifier ==')
  const opened = []

  for (const save of GROWTH_SAVES) {
    const database = await openSave(save.file)

    if (database) {
      opened.push({ database, save })
    } else {
      unsupportedNote(`${save.file}: the species growth modifier`, 'the save is not there')
    }
  }

  try {
    for (const { database, save } of opened) {
      const grown = await growthSaveCases(database, save, apps)

      grown.unsupported.forEach(([statement, detail]) => unsupportedNote(statement, detail))
      grown.cases.forEach(([statement, held]) => check(statement, held))
    }

    for (const mutant of mutating() ? GROWTH_MUTANTS : []) {
      const mutated = await mutatedUtilities(mutant.file, mutant.from, mutant.to)
      const broken = syntheticCases(mutated, capacities).filter(([, held]) => !held).map(([, , key]) => key)
      const telling = []

      for (const { database, save } of opened) {
        const grown = await growthSaveCases(database, save, mutated)

        broken.push(...grown.cases.filter(([, held]) => !held).map(([, , key]) => key))

        if (!Object.hasOwn(grown.discriminates, mutant.save)) {
          throw new Error(`${database.file}: the growth mutants name no save case "${mutant.save}"`)
        }

        if (grown.discriminates[mutant.save]) {
          telling.push(database.file)
        }
      }

      const named = results.find(([, , key]) => key === mutant.fails)
      const keys = [...new Set(broken)]

      check(`${mutant.name} fails the check "${named[0].slice(0, 90)}..." and, on a save that can tell it apart, the save's growth case beside it`, named[1] && keys.includes(mutant.fails) && (!telling.length || keys.includes(mutant.save)), `${keys.length} cases fail: ${keys.join(', ')}; saves that can tell it apart: ${telling.join(', ') || 'none'}`)
    }
  } finally {
    opened.forEach(({ database }) => database.close())
  }
}

const main = async () => {
  const saves = parseArguments(process.argv.slice(2))
  const explicitSaves = process.argv.includes('--save')
  const quickDefault = !explicitSaves && !mutating()
  const representative = DEFAULT_SAVES[0]

  if (quickDefault && !fs.existsSync(path.resolve(root, representative.file))) {
    throw new Error(`quick mode requires its representative save: ${representative.file}`)
  }

  const ordinarySaves = quickDefault ? [representative] : saves
  const apps = await loadUtilities(UTILITIES, { stubs: STUBS })
  const pageOptions = await loadPage('pages/colony-outlook', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB } })
  const productionOptions = await loadPage('pages/production', { stubs: STUBS })
  const store = { $store: { getters: { 'capabilities/blockedBonuses': new Set(), 'capabilities/report': () => null }, state: { RaceNPR: false }, dispatch: async () => {} } }
  const synthetic = instantiate(pageOptions, { ...store, data: { populationProductionModifiers: { 7: MODIFIERS } } })
  const capacities = Object.fromEntries(['construction', 'ordnance', 'fighter'].map((kind) => [kind, synthetic.populationCapacityResult(7, kind)]))

  check('the synthetic colony\'s construction capacity is the 36,500 BP a year its rates give', capacities.construction.status !== 'unavailable' && Math.abs(capacities.construction.value - 36500) < 1e-6, String(capacities.construction.value))

  console.log('\n== the committed workforce: worked cases ==')
  const results = syntheticCases(apps, capacities)

  results.forEach(([statement, held]) => check(statement, held))

  for (const mutant of mutating() ? MUTANTS : []) {
    const mutated = syntheticCases(await mutatedUtilities(mutant.file, mutant.from, mutant.to), capacities)
    const named = results.find(([, , key]) => key === mutant.fails)
    const broken = mutated.filter(([, held]) => !held).map(([, , key]) => key)

    check(`${mutant.name} fails the check "${named[0].slice(0, 90)}..."`, named[1] && broken.includes(mutant.fails), `${broken.length} cases fail: ${[...new Set(broken)].join(', ')}`)
  }

  const pageResults = await pageCases(pageOptions, store)

  pageResults.forEach(([statement, held]) => check(statement, held))

  for (const mutant of mutating() ? PAGE_MUTANTS : []) {
    const mutated = await pageCases(await loadPage('pages/colony-outlook', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB }, mutate: replacing(mutant.from, mutant.to) }), store)
    const named = pageResults.find(([, , key]) => key === mutant.fails)
    const broken = mutated.filter(([, held]) => !held).map(([, , key]) => key)

    check(`${mutant.name} fails the check "${named[0].slice(0, 90)}..."`, named[1] && broken.includes(mutant.fails), `${broken.length} cases fail: ${[...new Set(broken)].join(', ')}`)
  }

  await growthSection(apps, capacities, results)

  for (const save of ordinarySaves) {
    const database = await openSave(save.file)

    if (!database) {
      console.log(`SKIP  ${save.file}: not there (not run)`)
      continue
    }

    try {
      console.log(`\n== ${database.file} ==`)
      await saveCases(database, save, pageOptions, apps, productionOptions, store)
    } finally {
      database.close()
    }
  }

  console.log('\n== the yards aboard a ship ==')
  await shipYardCases(pageOptions, store)

  console.log(`\n${checks - failures}/${checks} checks passed; ${unsupported} unsupported (the save holds no case)`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
