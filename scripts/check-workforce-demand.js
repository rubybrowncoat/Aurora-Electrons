/*
  Checks the committed workforce of the Colony Outlook (utilities/workforce-demand.js, mixins/queue-forecast.js and the page's "With the queue" basis): the workers a colony needs once the installations in its queue and the shipyard upgrades under way are done, month by month along the population series.

  node scripts/check-workforce-demand.js [--save <save.db> <GameID> <RaceID>]...

  With no options it runs on the repository's modded save (AuroraDB.db, game 140, race 784) and the stock 2.7.1 save one folder up (AuroraDB_271_skoormit_saved.db, game 138, race 785), read-only.

  Worked cases on synthetic rows (labelled so) run the real functions: a factory or a yard upgrade that finishes raises the demand from the month its date falls in (a date on a month's last day counts in that month, the day after in the next), a paused, queued or stalled job adds nothing that is certain and a stalled one at most what its stock builds, a job with no date adds nothing to the lower demand and everything to the higher, a conversion adds the difference of the two installations (and lowers the demand where the new one needs fewer), a retool adds nothing, a shipyard activity the model does not know and a colony of a spied empire are unavailable and name what is missing, population orbiting aboard Arks never reaches the workers, and a colony with nothing queued gives the Outlook's own figure.

  The saves are read through the page's own reads and checked against counts of the rows in the save: on the current basis nothing extra is read and every row is the Outlook's own, value for value; on the committed basis with nothing queued it is the same; with the queue every event is one of the colony's projects or yards, in the forecast's order, dated the way the rules above say, with no phantom installation from a paused, queued or stalled job. A check that needs a case the save does not hold prints UNSUPPORTED and is in neither the passes nor the failures.

  The mutants load a temp copy of the utilities folder with one thing changed; each must fail the check named with it.
*/
const path = require('path')
const fs = require('fs')
const os = require('os')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate, replacing } = require('./lib/page-loader')

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
    } else {
      console.error(`Unknown option ${argv[index]}`)
      process.exit(2)
    }
  }

  return saves.length ? saves : DEFAULT_SAVES
}

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does, and counts the queries that name each table it is asked about.
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
      close: () => raw.close(),
    }

    resolve(database)
  })
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

// The utilities loaded from a temp copy of the folder in which `from`, which must occur once in `file`, is replaced by `to`: a mutant that must fail the check named with it.
const mutatedUtilities = async (file, from, to) => {
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

const MODIFIERS = { PopName: 'Test colony', ConstructionProduction: 36500, OverallProductionModifier: 1, ConstructionPower: 1, EngineerProductionModifier: 0, GroundConstructionPower: 0, OrdnanceProduction: 0, OrdnanceProductionPower: 0, FighterProduction: 0, FighterProductionPower: 0, MinConstructionPeriod: 86400, ShipyardBuildRate: 3650, ShipyardOperations: 1 }
const INSTALLATIONS = { 1: { Workers: 0.05 }, 2: { Workers: 0.2 }, 3: { Workers: 0 }, 4: { Workers: 0.1 } }

// A colony of 100 million people of which 20 million are employed by installations, the way the page reads one.
const colonyRow = (extra = {}) => ({ PopulationID: 7, PopName: 'Test colony', Population: 100, ReqInf: 0, SpeciesID: 1, PopulationGrowthModifier: 1, PopulationGrowthBonus: 1, PopulationDensityModifier: 1, SystemBodyID: 70, BodyClass: 1, Radius: 6400, HydroExt: 0.5, TidalLock: 0, RadiationLevel: 0, LowGravity: 0, LegacyLowGravity: 0, Infrastructure: 0, LGInfrastructure: 0, InstallationWorkers: 20, YardWorkers: 0, BodyPopulation: 100, InfrastructureCost: 0, ...extra })

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

  // The factory of four that the engine finishes on day 40 (a unit every 10 days).
  holds('dated', 'a factory of four, which the engine finishes on day 40, raises the workers needed by 4 x 0.05 M from the second month on (day 40 falls in it) and not before in the lower demand; the higher one agrees from then on (the units built sooner may count before), and the horizon figure is the colony\'s workers needed then', () => {
    const { value, events, entry } = scene({ projects: [factory()] })
    const [event] = events

    return events.length === 1 && event.status === 'dated' && event.kind === 'installation' && event.earliest === 40 && event.latest === 40 && near(value.required.low[1], 20) && near(value.required.low[2], 20.2) && near(value.required.low[MONTHS], 20.2) && value.required.low.every((workers, month) => workers <= value.required.high[month] + TOLERANCE && (month < 2 || near(workers, value.required.high[month]))) && near(value.later.best.required, 20.2) && near(value.later.best.free, entry.results.workersLater.value.available - 20.2) && near(value.later.worst.free, value.later.best.free)
  })

  holds('monthEdge', 'a completion on day 30 counts in month 1 (which ends on day 30.4), one on day 31 in month 2, and one on day 365 in month 12 and not month 11', () => {
    const on = (amount, id) => scene({ projects: [factory({ Amount: amount, ProdPerUnit: 100, ProductionID: id })] }).value.required.low
    const thirty = on(30, 4)
    const thirtyOne = on(31, 4)
    const year = on(365, 1)

    return near(thirty[0], 20) && near(thirty[1], 23) && near(thirtyOne[1], 20) && near(thirtyOne[2], 23.1) && near(year[11], 20) && near(year[12], 38.25)
  })

  holds('paused', 'a paused project adds nothing in either demand, and a project queued behind it that never starts adds nothing either: no installation appears from a job that is not building', () => {
    const paused = scene({ projects: [factory({ ID: 8, Paused: 1 }), factory({ Queue: 1 })] })
    const none = (event) => event.low.every((change) => change === 0) && event.high.every((change) => change === 0)
    const byId = (id) => paused.events.find((event) => event.id === id)

    return paused.events.length === 2 && byId('project-8').status === 'paused' && none(byId('project-8')) && byId('project-9').status === 'queued' && none(byId('project-9')) && near(paused.value.later.best.required, 20) && near(paused.value.later.worst.required, 20)
  })

  holds('queuedStarts', 'a project queued behind one that finishes starts when it ends and is dated by the engine (day 80 here), counted from the month it falls in', () => {
    const { events, value } = scene({ projects: [factory({ ID: 8 }), factory({ Queue: 1 })] })
    const second = events.find((event) => event.id === 'project-9')

    return second.status === 'dated' && second.earliest === 80 && near(value.required.low[2], 20.2) && near(value.required.low[3], 20.4) && near(value.required.low[MONTHS], 20.4)
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

  holds('ark', 'population aboard Ark ships never becomes surface workforce: the committed split of a colony is the split of its surface projection whatever orbits it', () => {
    const { value, entry, committed } = scene({ projects: [factory()], colony: { OrbitalPopulation: 5, ArkOccupied: 5 } })
    const surface = entry.results.projection.value

    return committed.status !== 'unavailable' && near(value.later.best.population, surface.final) && near(value.later.worst.population, surface.final)
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

  holds('recoveryEpisode', 'the month a colony\'s worst case is back, as `recovery.worstAfterBest`, is the end of the worst case\'s shortage that holds the best case\'s first short month, not the end of an earlier shortage of the worst case alone: a possible yard upgrade puts the worst case short from month 1 to 3 and a certain slipway puts both short from month 14 (the best case is back in month 48, the worst case in month 60 or not within the 5 years), while `recovery.worst` stays the worst case\'s own first recovery', () => {
    const yards = (target) => [yardRow({ UpgradeTaskType: 8, CapacityTarget: target }), yardRow({ ShipyardID: 6, ShipyardName: 'Later slipway', UpgradeTaskType: 1, Capacity: 19520, RemainingProduction: 10000 })]
    const colony = { InstallationWorkers: 23.24, YardWorkers: 14.76 }
    const [back, short] = [12000, 12200].map((target) => scene({ years: 5, colony, yards: yards(target) }).value)

    return back.firstShort.best === 14 && back.firstShort.worst === 1 && back.recovery.best === 48 && back.recovery.worst === 3 && back.recovery.worstAfterBest === 60 && short.recovery.worst === 4 && short.recovery.worstAfterBest === null && short.recovery.best === 48
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

  // The early completion and a possible continual upgrade (0.04 M of workers) as above, then a slipway added on a later day (a certain 9 M of workers): both cases are healthy again in month 9 and the worst case is short again at the horizon.
  const second = await open({ InstallationWorkers: 38.5 }, [factories()], { attentionOnly: true, yardActivities: [yardRow({ ShipyardID: 6, UpgradeTaskType: 8, CapacityTarget: 10080 }), yardRow({ ShipyardID: 7, UpgradeTaskType: 1, Slipways: 1, Capacity: 37560, RemainingProduction: 17300 })] })
  const [secondRow] = second.rows
  const [secondTile] = second.tiles.filter((tile) => tile.label === 'Colonies short of workers')

  holds('secondShortage', 'PAGE a colony that is short in month 1 and healthy again in the same month in both cases, but short again at the horizon in the worst case after a later dated addition (a certain early completion, a possible continual yard upgrade and a slipway added later), says in its row that it is back by that month and short again at worst at the horizon, never that it is back without qualification, and the tile counts it as short on the way "only at best"', () => {
    return secondRow.committed.firstShort.best === 1 && secondRow.committed.recovery.best > 1 && secondRow.committed.recovery.worst === secondRow.committed.recovery.best && secondRow.recoveryAtBestOnly === false && secondRow.shortInBetween === true && secondRow.mayBeShortLater === true && secondRow.freeLater > 0 && secondRow.freeLaterWorst < 0 && second.visibleRows.length === 1 && /^Short of workers from month 1, back by month \d+; short again at worst by 10 y$/.test(secondRow.duringNote) && /1 short on the way, back by 10 y \(1 of them only at best\)/.test(secondTile.note) && !/more may be short/.test(secondTile.note)
  })

  // Synthetic: a possible continual yard upgrade (1 M of workers from month 1 to its target) and, from month 14, a slipway that adds 4.88 M for certain. The upgrade alone puts the worst case short from month 1 until it recovers early; the slipway then puts both cases short from month 14.
  const episodes = (target) => open({ InstallationWorkers: 23.24, YardWorkers: 14.76 }, [], { horizon: 5, attentionOnly: true, yardActivities: [yardRow({ UpgradeTaskType: 8, CapacityTarget: target }), yardRow({ ShipyardID: 6, ShipyardName: 'Later slipway', UpgradeTaskType: 1, Capacity: 19520, RemainingProduction: 10000 })] })
  const [earlier, earlierThenShort] = [await episodes(12000), await episodes(12200)]
  const [earlierRow] = earlier.rows
  const [thenShortRow] = earlierThenShort.rows
  const [earlierTile] = earlier.tiles.filter((tile) => tile.label === 'Colonies short of workers')
  const [thenShortTile] = earlierThenShort.tiles.filter((tile) => tile.label === 'Colonies short of workers')

  holds('earlierWorstRecovery', 'PAGE a colony whose worst case has a shortage of its own that recovers early (a possible yard upgrade, month 1 to 3) and then both cases are short from the month of a certain later addition (a slipway, month 14) is worded with the recovery of the shortage the row names: the worst case is back when that shortage ends (month 60), never in the month the earlier one did', () => {
    return earlierRow.committed.firstShort.best === 14 && earlierRow.committed.firstShort.worst === 1 && earlierRow.committed.recovery.worst === 3 && earlierRow.committed.recovery.best === 48 && earlierRow.committed.recovery.worstAfterBest === 60 && earlierRow.shortInBetween === true && earlierRow.mayBeShortLater === false && earlier.visibleRows.length === 1 && /^Short of workers from month 14, back by month 48 at best, month 60 at worst$/.test(earlierRow.duringNote) && /1 short on the way, back by 5 y/.test(earlierTile.note) && !/only at best/.test(earlierTile.note)
  })

  holds('earlierWorstRecoveryThenShort', 'PAGE the same colony with a slightly larger possible upgrade, whose worst case is still short at the horizon from the month of the certain later addition, says in its row that the worst case is still short at the horizon, never that it is back in the month its earlier, separate shortage ended, and the tile counts it as "only at best"', () => {
    return thenShortRow.committed.firstShort.best === 14 && thenShortRow.committed.firstShort.worst === 1 && thenShortRow.committed.recovery.worst === 4 && thenShortRow.committed.recovery.best === 48 && thenShortRow.committed.recovery.worstAfterBest === null && thenShortRow.shortInBetween === true && thenShortRow.mayBeShortLater === true && earlierThenShort.visibleRows.length === 1 && /^Short of workers from month 14, back by month 48 at best; still short at worst at 5 y$/.test(thenShortRow.duringNote) && /1 short on the way, back by 5 y \(1 of them only at best\)/.test(thenShortTile.note)
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
  { name: 'the lower and the higher demand swapped', file: DEMAND_FILE, from: 'const [low, high] = requiredSeries(events, colony.InstallationWorkers + colony.YardWorkers, months)', to: 'const [high, low] = requiredSeries(events, colony.InstallationWorkers + colony.YardWorkers, months)', fails: 'bounds' },
  { name: 'workers needed today that leave the yards out', file: COLONIES_FILE, from: 'required = colony.InstallationWorkers + colony.YardWorkers', to: 'required = colony.InstallationWorkers', fails: 'currentSplit' },
  { name: 'population orbiting aboard Arks that is added to the people who can work', file: DEMAND_FILE, from: 'workerSplit(colony, population, value, required[month])', to: 'workerSplit(colony, population + (colony.ArkOccupied || 0), value, required[month])', fails: 'ark' },
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

  const reference = apps.colonies.outlookColonies(vm.colonies, vm.inbound, vm.horizon)
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
  const [{ yards: yardCount }] = await rowsOf(database, `select count(*) as yards from FCT_Shipyard where TaskType <> 0 and GameID = ${save.game} and RaceID = ${save.race}`)
  const [{ types: typeCount }] = await rowsOf(database, 'select count(*) as types from DIM_PlanetaryInstallation')
  const order = (list) => list.map((project) => `${project.PopulationID}:${project.ID}`).join()

  check(`${name}: with the queue counted the page reads every industrial project (${projectCount}), every shipyard activity (${yardCount}) and every installation type (${typeCount}) of the save, the projects in the order the Production page reads them`, vm.industry.length === projectCount && vm.yardActivities.length === yardCount && Object.keys(vm.installationTypes).length === typeCount && order(vm.industry) === order(production.industry) && vm.industry.every((project) => 'ProductionID' in project))

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

  check(`${name}: population aboard Arks never reaches the workers: every committed row's people at the horizon are the surface projection's final population (${committedRows.filter((row) => row.committed).length} rows, ${arkRows.length} of them with an Ark)`, arkLeak.length === 0)

  console.log(`  ${name}: ${withQueue.length} colonies with events, ${installationEvents.length} installation events (${dated.length} dated), ${yardEvents.length} yard events, ${committedRows.filter((row) => row.laterRange).length} with a range at the horizon, ${committedRows.filter((row) => !row.committed).length} unavailable`)
}

const valueOrZero = (result) => (result && result.status !== 'unavailable' ? result.value : 0)

const main = async () => {
  const saves = parseArguments(process.argv.slice(2))
  const apps = await loadUtilities(UTILITIES, { stubs: STUBS })
  const pageOptions = await loadPage('pages/colony-outlook', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB } })
  const productionOptions = await loadPage('pages/production', { stubs: STUBS })
  const store = { $store: { getters: { 'capabilities/blockedBonuses': new Set() }, state: { RaceNPR: false }, dispatch: async () => {} } }
  const synthetic = instantiate(pageOptions, { ...store, data: { populationProductionModifiers: { 7: MODIFIERS } } })
  const capacities = Object.fromEntries(['construction', 'ordnance', 'fighter'].map((kind) => [kind, synthetic.populationCapacityResult(7, kind)]))

  check('the synthetic colony\'s construction capacity is the 36,500 BP a year its rates give', capacities.construction.status !== 'unavailable' && Math.abs(capacities.construction.value - 36500) < 1e-6, String(capacities.construction.value))

  console.log('\n== the committed workforce: worked cases ==')
  const results = syntheticCases(apps, capacities)

  results.forEach(([statement, held]) => check(statement, held))

  for (const mutant of MUTANTS) {
    const mutated = syntheticCases(await mutatedUtilities(mutant.file, mutant.from, mutant.to), capacities)
    const named = results.find(([, , key]) => key === mutant.fails)
    const broken = mutated.filter(([, held]) => !held).map(([, , key]) => key)

    check(`${mutant.name} fails the check "${named[0].slice(0, 90)}..."`, named[1] && broken.includes(mutant.fails), `${broken.length} cases fail: ${[...new Set(broken)].join(', ')}`)
  }

  const pageResults = await pageCases(pageOptions, store)

  pageResults.forEach(([statement, held]) => check(statement, held))

  for (const mutant of PAGE_MUTANTS) {
    const mutated = await pageCases(await loadPage('pages/colony-outlook', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB }, mutate: replacing(mutant.from, mutant.to) }), store)
    const named = pageResults.find(([, , key]) => key === mutant.fails)
    const broken = mutated.filter(([, held]) => !held).map(([, , key]) => key)

    check(`${mutant.name} fails the check "${named[0].slice(0, 90)}..."`, named[1] && broken.includes(mutant.fails), `${broken.length} cases fail: ${[...new Set(broken)].join(', ')}`)
  }

  for (const save of saves) {
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

  console.log(`\n${checks - failures}/${checks} checks passed; ${unsupported} unsupported (the save holds no case)`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
