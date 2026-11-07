/*
  Checks the Mineral Outlook's model of the uses a save without a mineral ledger cannot show (utilities/legacy-consumption.js, through utilities/mineral-outlook.js and the real page) against the mineral ledger the saves hold, read-only.

  node scripts/check-legacy-consumption.js [--no-mutations] [--save <save.db> <GameID> <RaceID>]...

  With no options a run checks the fixture save (scripts/lib/fixtures.js: its game and race). Explicit --save arguments are always used as given. A save is never written: the fallback is run on a copy of the save in the temp folder whose mineral ledger is emptied, deleted afterwards.

  What is compared. The ledger logs, once per production tick and colony, the tonnes each purpose used: fuel refining (MineralDataType 14, Sorium), maintenance supplies (16, Duranium, Uridium and Gallicite), shipbuilding (5) and shipyard activities (9). For the last production tick (the years between the last two ticks of the ledger's construction rows) the check sets what the model gives a colony, worked out from the save's installations, tasks and race rates alone, against what the ledger logged for it: the fuel and maintenance rules as the page applies them, and the shipbuilding and activity rules at one tick (a task's build points rounded to 4 decimals each tick, as the game does; the utility's year is a forecast and is compared with the tick within the rounding bound). A task with no build points done may have been added after the tick and is left out of the comparison, said so. The ledger's continual-upgrade rows are compared as estimates (the saved capacity is the one after the tick's growth).

  The page. A save without a ledger (the emptied copy) gets every use as a modelled forecast, never as observed; switching a use off removes exactly its contribution to every mineral's use and lengthens the runway of a mineral that use takes; an input a use lacks leaves the use, the mineral's use and its runway unknown, with the reason, and switching that use off makes them known again; ground unit training is missing with its reason. A save with a ledger shows the uses as observed, adds no modelled use on top of them even when the model's rows are loaded, and a switched-off use subtracts its observed flow; the page's modelled reads are not even run on it.

  Synthetic cases (labelled SYNTHETIC) pin the arithmetic where the saves hold no case: refineries and facilities cut to a whole number, status off, a missing switch, the remaining build points, paused and scrap tasks, retool slipways, a continual upgrade. A case the saves cannot show is printed as UNSUPPORTED and never counts as agreement.

  Mutants. Each mutation changes a copy of the renderer's sources in the temp folder, runs the checks it names in a Node process of their own (the rule registry is module state) and counts as caught when every check it names fails. --no-mutations plants none and starts no child: the checks of the real sources run alone.

  Maintenance is held to the minerals at the colony (the scarcest of Duranium, Uridium and Gallicite over a year, spent once by all the colonies that draw on one stock: an NPR's colonies draw on the capital's). A mine on a body whose deposit of the mineral still holds some is not quantified, so where the stock cannot cover a year the figure is unknown, never unlimited; a mine on an exhausted deposit adds nothing. A colony whose saved stock is below a year's need is compared only as at most the rate at the tick, because the saved stock is the one after the tick. An installation row whose amount or type the save does not give makes the count unknown, never 0 (checked on a database in memory through the real query).
*/
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const v8 = require('v8')
const sqlite3 = require('sqlite3')
const { createOwnedTemp, removeOwnedTemp } = require('./lib/owner-temp')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { inParallel, runChild } = require('./lib/check-pool')
const { fixtureSave } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')
const DEFAULT_SAVES = [{ key: 'fixture', ...fixtureSave() }]
const SECONDS_PER_YEAR = 365 * 86400
const FUEL_LEDGER_TYPE = 14
const MAINTENANCE_LEDGER_TYPE = 16
const SHIPBUILDING_LEDGER_TYPE = 5
const ACTIVITY_LEDGER_TYPE = 9
const CONSTRUCTION_LEDGER_TYPE = 4
// The ledger types of each use the page switches: construction and ordnance make the industry use, shipbuilding the tasks and the yard activities, fuel the refineries' Sorium and maintenance the facilities' supplies (utilities/minerals.js FLOW_GROUPS).
const USE_LEDGER_TYPES = { industry: [2, 3, CONSTRUCTION_LEDGER_TYPE, 40, 45], fuel: [FUEL_LEDGER_TYPE], maintenance: [MAINTENANCE_LEDGER_TYPE], shipbuilding: [SHIPBUILDING_LEDGER_TYPE, ACTIVITY_LEDGER_TYPE] }
const SORIUM = 8
const CONTINUAL_TOLERANCE = 0.005
const FUEL_TOLERANCE = 1e-3
const PER_MSP = { Duranium: 0.1, Uridium: 0.05, Gallicite: 0.1 }

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}
const PAGE_MODULES = { 'components/charts/theme': 'export const chartTheme = () => ({}); export const flowColor = () => ""; export const withAlpha = (color) => color' }
const UTILITIES = ['legacy-consumption', 'mineral-outlook', 'minerals', 'logistics', 'production', 'provenance']
const COPIED = ['utilities', 'mixins', path.join('pages', 'mineral-outlook.vue')]
const READS = ['game', 'stockpile', 'cargo', 'packets', 'ledger', 'surfaceMining', 'orbitalMining', 'navalAdmins', 'industrialProjects', 'populationProductionModifiers', 'legacyColonies', 'shipyardTasks', 'shipyardActivities']

let failures = 0
let checks = 0

const check = (name, ok, detail = '') => {
  checks++

  if (ok !== true) {
    failures++
  }

  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}${ok !== true && typeof ok === 'string' ? `  [${ok}]` : detail ? `  [${detail}]` : ''}`)
}

const near = (actual, expected, relative = 1e-9, absolute = 1e-9) => typeof actual === 'number' && Math.abs(actual - expected) <= Math.max(absolute, relative * Math.abs(expected))

const round4 = (value) => Math.round(value * 10000) / 10000

// A check that has no case to run: shown as SKIP with its reason, never counted as a pass.
const skip = (reason) => ({ skip: reason })
const isSkip = (result) => Boolean(result) && typeof result === 'object' && typeof result.skip === 'string'

const measured = []

const storeStub = () => ({ getters: { 'capabilities/blockedBonuses': new Set(), 'capabilities/result': {}, 'capabilities/report': () => null }, state: {}, dispatch: async () => {} })

// The ledger's own use of each mineral a year, worked out from the page's ledger rows (transfers aside), leaving out the flow groups named in `disabled`.
const spentBy = (vm, minerals, disabled = []) => {
  const { perYear } = vm

  return minerals.MINERALS.map((mineral) => vm.ledger.filter((row) => row.MaterialID === mineral.id && !minerals.TRANSFER_TYPES.has(row.MineralDataType)).reduce((total, row) => {
    const group = minerals.flowGroupOf(row.MineralDataType)

    return group && !group.income && !disabled.includes(group.key) ? total + row.Amount * perYear : total
  }, 0))
}

const parseArguments = (argv) => {
  const saves = []

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--save') {
      saves.push({ key: `save${saves.length + 1}`, file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
    } else if (argv[index] === '--no-mutations') {
      continue
    } else {
      console.error(`Unknown option ${argv[index]}`)
      process.exit(2)
    }
  }

  if (saves.length) {
    return saves
  }

  if (!mutating() && !fs.existsSync(path.resolve(root, DEFAULT_SAVES[0].file))) {
    throw new Error(`quick representative save is missing: ${DEFAULT_SAVES[0].file}`)
  }

  return DEFAULT_SAVES
}

// The rows of the saves' queries are kept for the length of one run, in a folder the first process makes (LEGACY_CACHE, which the processes it starts inherit) and removes at its end: a mutation re-reads the same save with the same statements, and a save does not change under a run. An entry is named by the save (path, size and time of last change) and the exact statement, so a statement a mutation changes never meets another's rows; a process without the folder queries the save every time.
const cacheDirectory = () => process.env.LEGACY_CACHE || null

const entryOf = (identity, sql) => path.join(cacheDirectory(), `${crypto.createHash('sha1').update(`${identity}\n${sql}`).digest('hex')}.rows`)

const keptRows = (identity, sql) => {
  try {
    return v8.deserialize(fs.readFileSync(entryOf(identity, sql)))
  } catch (error) {
    return null
  }
}

let entries = 0

const keepRows = (identity, sql, rows) => {
  const target = entryOf(identity, sql)
  const scratch = `${target}.${process.pid}.${entries++}.tmp`

  try {
    fs.writeFileSync(scratch, v8.serialize(rows))
    fs.renameSync(scratch, target)
  } catch (error) {
    fs.rmSync(scratch, { force: true })
  }
}

const identityOf = (file) => {
  const { size, mtimeMs } = fs.statSync(file)

  return `${path.resolve(file)}|${size}|${mtimeMs}`
}

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does. `queries` keeps every statement run.
const openSave = (file) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)
      return
    }

    const queries = []
    const identity = cacheDirectory() ? identityOf(file) : null

    resolve({
      queries,
      query: (sql) => new Promise((resolve, reject) => {
        queries.push(sql)

        const kept = identity === null ? null : keptRows(identity, sql)

        if (kept !== null) {
          resolve([kept])

          return
        }

        raw.all(sql, (queryError, rows) => {
          if (queryError) {
            reject(queryError)

            return
          }

          if (identity !== null) {
            keepRows(identity, sql, rows)
          }

          resolve([rows])
        })
      }),
      close: () => new Promise((resolve) => raw.close(resolve)),
    })
  })
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

// The rows `sql` reads from a database in memory that `statements` build.
const sqlRows = (statements, sql) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(':memory:', (error) => {
    if (error) {
      reject(error)
      return
    }

    raw.serialize(() => {
      statements.forEach((statement) => raw.run(statement, (statementError) => {
        if (statementError) {
          reject(statementError)
        }
      }))
      raw.all(sql, (queryError, rows) => {
        raw.close()

        if (queryError) {
          reject(queryError)
        } else {
          resolve(rows)
        }
      })
    })
  })
})

// A copy of a save in the temp folder whose mineral ledger is emptied: a save with no ledger entries as far as the page can tell.
const ledgerlessCopy = async (file, directory) => {
  const target = path.join(directory, 'ledgerless.db')

  fs.copyFileSync(file, target)
  await new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(target, (error) => {
      if (error) {
        reject(error)
        return
      }

      raw.run('delete from FCT_RaceMineralData', (runError) => (runError ? reject(runError) : raw.close(resolve)))
    })
  })

  return target
}

// A copy of a save in the temp folder whose first new-build shipyard task is a refit of another class (the saves tried hold none): { file, task, from, to } with the class the task named and the class of another size it now becomes, or null when the save holds no such task or class.
const refitCopy = async (file, directory, { game, race }) => {
  const target = path.join(directory, 'refit.db')

  fs.copyFileSync(file, target)

  const raw = await new Promise((resolve, reject) => {
    const opened = new sqlite3.Database(target, (error) => (error ? reject(error) : resolve(opened)))
  })
  const one = (sql) => new Promise((resolve, reject) => raw.get(sql, (error, row) => (error ? reject(error) : resolve(row || null))))
  const run = (sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))

  try {
    const from = await one(`select FCT_ShipyardTask.TaskID as task, FCT_ShipClass.ShipClassID as id, FCT_ShipClass.Size as size, FCT_ShipClass.Commercial as commercial from FCT_ShipyardTask inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID where FCT_ShipyardTask.GameID = ${game} and FCT_ShipyardTask.RaceID = ${race} and FCT_ShipyardTask.TaskTypeID = 0 order by FCT_ShipyardTask.TaskID limit 1`)
    const to = from && (await one(`select ShipClassID as id, Size as size, Commercial as commercial from FCT_ShipClass where GameID = ${game} and Size <> ${from.size} order by (Commercial <> ${from.commercial || 0}) desc, ShipClassID limit 1`))

    if (!from || !to) {
      return null
    }

    await run(`update FCT_ShipyardTask set TaskTypeID = 2, RefitID = ${to.id} where TaskID = ${from.task}`)

    return { file: target, task: from.task, from, to }
  } finally {
    await new Promise((resolve) => raw.close(resolve))
  }
}

// The emptied copy of a save: made once for the run in its cache folder when there is one (the first process to need it makes it, the others open that), else made in `directory`.
const ledgerlessOf = async (file, directory) => {
  if (!cacheDirectory()) {
    return await ledgerlessCopy(file, directory)
  }

  const shared = path.join(cacheDirectory(), `ledgerless-${crypto.createHash('sha1').update(identityOf(file)).digest('hex')}.db`)

  if (!fs.existsSync(shared)) {
    const made = await ledgerlessCopy(file, directory)

    try {
      fs.renameSync(made, shared)
    } catch (error) {
      return made
    }
  }

  return shared
}

// The checks of one tree of the renderer's sources (the real one, or a mutated copy): [{ id, name, run }] where run resolves to true or what is wrong. `unsupported` collects the cases a save cannot show.
const suite = (tree, saves, unsupported) => {
  const memo = (build) => {
    let value = null

    return () => {
      value = value || build()

      return value
    }
  }

  const opened = []
  const cleanup = []
  const utilities = memo(() => loadUtilities(UTILITIES, { stubs: STUBS, directory: path.join(tree, 'utilities') }))
  const pageOptions = memo(() => loadPage('pages/mineral-outlook', { directory: tree, stubs: STUBS, modules: PAGE_MODULES }))
  const noteUnsupported = (text) => {
    if (!unsupported.includes(text)) {
      unsupported.push(text)
    }
  }

  const present = (save) => {
    const resolved = path.resolve(root, save.file)

    return fs.existsSync(resolved) ? resolved : null
  }

  // A save opened with the page's reads run on it: { database, vm, ledger ticks, the model's input rows }.
  const environment = (save, file = present(save), { ledger = true } = {}) => memo(async () => {
    const database = await openSave(file)

    opened.push(database)

    const [{ valueOrNull }, options] = [(await utilities()).provenance, await pageOptions()]
    const vm = instantiate(options, { $store: storeStub(), database, GameID: save.game, RaceID: save.race, nested: true })

    vm.loadErrors = {}

    for (const name of READS) {
      await vm.runAsync(name)
    }

    const readQueries = database.queries.slice()

    vm.inputsLoaded = true
    vm.focusMineralId = SORIUM

    const ticks = ledger ? (await rowsOf(database, `select distinct Time from FCT_RaceMineralData where GameID = ${save.game} and RaceID = ${save.race} and MineralDataType = ${CONSTRUCTION_LEDGER_TYPE} order by Time desc limit 2`)).map((row) => row.Time) : []
    const years = ticks.length === 2 ? (ticks[0] - ticks[1]) / SECONDS_PER_YEAR : null
    const { legacyColoniesQuery, shipyardTasksQuery, shipyardActivitiesQuery } = (await utilities())['legacy-consumption']
    const query = { GameID: save.game, RaceID: save.race }
    const inputs = { colonies: await rowsOf(database, legacyColoniesQuery(query)), tasks: await rowsOf(database, shipyardTasksQuery(query)), activities: await rowsOf(database, shipyardActivitiesQuery(query)) }
    const modelledQueries = [legacyColoniesQuery(query), shipyardTasksQuery(query), shipyardActivitiesQuery(query)]

    // The ledger's amounts of a type at the last production tick, by `population:mineral`.
    const logged = async (type) => {
      if (!ticks.length) {
        return new Map()
      }

      const rows = await rowsOf(database, `select FCT_RaceMineralData.PopulationID, FCT_RaceMineralData.MineralID, sum(FCT_RaceMineralData.Amount) as Amount from FCT_RaceMineralData where FCT_RaceMineralData.GameID = ${save.game} and FCT_RaceMineralData.RaceID = ${save.race} and FCT_RaceMineralData.Time = ${ticks[0]} and FCT_RaceMineralData.MineralDataType = ${type} group by FCT_RaceMineralData.PopulationID, FCT_RaceMineralData.MineralID`)

      return new Map(rows.map((row) => [`${row.PopulationID}:${row.MineralID}`, row.Amount]))
    }

    return { database, vm, years, inputs, logged, readQueries, modelledQueries, modifiers: vm.populationProductionModifiers, valueOrNull }
  })

  const environments = Object.fromEntries(saves.map((save) => [save.key, present(save) ? environment(save) : null]))

  // The emptied copy of the first save that is there, as a page that has no ledger.
  const fallbackSource = saves.find((save) => present(save))
  const fallback = memo(async () => {
    const directory = createOwnedTemp('ae-legacy-copy-')

    cleanup.push(() => removeOwnedTemp(directory))

    return await environment(fallbackSource, await ledgerlessOf(present(fallbackSource), directory), { ledger: false })()
  })

  const list = []
  const add = (id, name, run) => list.push({ id, name, run })

  // ---- What the model gives a colony, as the page applies it, against the ledger ----------------------------------------------------------------
  saves.forEach((save) => {
    const label = `${save.key} (${path.basename(save.file)}, game ${save.game})`

    if (!environments[save.key]) {
      add(`absent:${save.key}`, `${label} is not there`, async () => skip(`${label}: the save is not there, so nothing is compared against its ledger`))

      return
    }

    const modelOf = async (env, populationRows) => {
      const { legacyModels } = (await utilities())['legacy-consumption']

      return legacyModels({ ...populationRows, modifiers: env.modifiers })
    }

    add(`fuel-ledger:${save.key}`, `${label}: a colony's Sorium for refining over the last tick is the ledger's`, async () => {
      const env = await environments[save.key]()
      const logged = await env.logged(FUEL_LEDGER_TYPE)
      const colonies = new Set(env.inputs.colonies.map((colony) => colony.PopulationID))
      const unknown = [...logged.keys()].filter((key) => !colonies.has(Number(key.split(':')[0])))
      let working = 0

      for (const colony of env.inputs.colonies) {
        const model = (await modelOf(env, { colonies: [colony], tasks: [], activities: [] })).fuel.byMineral.Sorium
        const expected = env.valueOrNull(model)
        const observed = logged.get(`${colony.PopulationID}:${SORIUM}`) || 0

        if (expected === null) {
          return `colony ${colony.PopulationID} has no figure: ${model.inputs.missing.join(', ')}`
        } else if (!near(expected * env.years, observed, FUEL_TOLERANCE, 1e-9)) {
          return `colony ${colony.PopulationID} (${colony.Refineries} refineries): model ${(expected * env.years).toFixed(6)} t, ledger ${observed.toFixed(6)} t`
        }

        working += observed > 0 ? 1 : 0
      }

      if (unknown.length) {
        return `the ledger has fuel refining at colonies the model does not read: ${unknown.join(', ')}`
      } else if (!working) {
        noteUnsupported(`${label}: no colony refined fuel at the last tick, so the fuel rule has no case there`)
      }

      return true
    })

    if (save.key === 'fixture') {
      add(`loader-refit:${save.key}`, `${label}: a refit task builds the class it becomes: on a copy whose first shipyard task is a refit, the task's class size and commercial flag are those of the class it becomes and not of the one it names`, async () => {
        const directory = createOwnedTemp('ae-legacy-copy-')

        cleanup.push(() => removeOwnedTemp(directory))

        const planted = await refitCopy(present(save), directory, save)

        if (!planted) {
          return skip(`${label}: the save holds no new-build shipyard task, so no refit can be planted on it`)
        }

        const env = await environment(save, planted.file, { ledger: false })()
        const row = env.inputs.tasks.find((task) => task.TaskID === planted.task)

        return row && row.ClassSize === planted.to.size && Number(row.ClassCommercial || 0) === Number(planted.to.commercial || 0) && row.ClassSize !== planted.from.size ? true : `task ${planted.task}: the read gives size ${row && row.ClassSize} and commercial ${row && row.ClassCommercial}, the class it becomes has ${planted.to.size} and ${planted.to.commercial}, the one it names ${planted.from.size}`
      })
    }

    add(`msp-ledger:${save.key}`, `${label}: a colony's Duranium, Uridium and Gallicite for maintenance supplies over the last tick are the ledger's (a colony whose stock cannot cover a year makes the rate at the tick, the year's use is held to the stock)`, async () => {
      const env = await environments[save.key]()
      const logged = await env.logged(MAINTENANCE_LEDGER_TYPE)
      const { minerals: { MINERALS } } = await utilities()
      const colonies = new Set(env.inputs.colonies.map((colony) => colony.PopulationID))
      const unknown = [...logged.keys()].filter((key) => !colonies.has(Number(key.split(':')[0])))
      const plenty = { Duranium: 1e12, Uridium: 1e12, Gallicite: 1e12 }
      let working = 0
      let held = 0
      let mined = 0

      for (const colony of env.inputs.colonies) {
        const model = (await modelOf(env, { colonies: [colony], tasks: [], activities: [] })).maintenance.byMineral
        const rate = (await modelOf(env, { colonies: [{ ...colony, ...plenty }], tasks: [], activities: [] })).maintenance.byMineral
        const supplies = env.valueOrNull(rate.Duranium) / PER_MSP.Duranium
        const stocks = Object.keys(PER_MSP).map((name) => ({ low: colony[name] / PER_MSP[name], open: (colony.Mines === null || colony.Mines > 0) && (colony[`Deposit${name}`] > 0 || colony[`DepositUnread${name}`] > 0) }))
        const lowest = Math.min(supplies, ...stocks.map(({ low }) => low))
        const allowed = Math.min(supplies, ...stocks.filter(({ low, open }) => !open || low >= supplies).map(({ low }) => low))
        const binds = Boolean(colony.MaintProdStatus) && allowed < supplies * (1 - 1e-9)
        const unsettled = Boolean(colony.MaintProdStatus) && allowed > lowest

        if (unsettled) {
          if (Object.values(model).some((result) => result.status !== 'unavailable' || !/own mines/.test(result.inputs.missing.join(' ')))) {
            return `colony ${colony.PopulationID} mines a mineral its stock cannot cover, no other mineral settles its output, and the model does not say that figure is unknown`
          }

          mined++
          continue
        }

        held += binds ? 1 : 0

        for (const name of Object.keys(model)) {
          const expected = env.valueOrNull(model[name])
          const observed = logged.get(`${colony.PopulationID}:${MINERALS.find((mineral) => mineral.name === name).id}`) || 0
          const atRate = env.valueOrNull(rate[name]) * env.years

          if (expected === null) {
            return `colony ${colony.PopulationID} has no ${name} figure: ${model[name].inputs.missing.join(', ')}`
          } else if (binds && !near(expected, allowed * PER_MSP[name], 1e-9, 1e-9)) {
            return `colony ${colony.PopulationID} (${colony.MaintenanceFacilities} facilities), ${name}: the stock allows ${(allowed * PER_MSP[name]).toFixed(6)} t a year, the model gives ${expected.toFixed(6)} t`
          } else if (binds ? observed > atRate * (1 + FUEL_TOLERANCE) + 1e-9 : !near(expected * env.years, observed, FUEL_TOLERANCE, 1e-9)) {
            return `colony ${colony.PopulationID} (${colony.MaintenanceFacilities} facilities), ${name}: model ${(expected * env.years).toFixed(6)} t, ledger ${observed.toFixed(6)} t${binds ? ` (the rate alone gives ${atRate.toFixed(6)} t)` : ''}`
          }

          working += observed > 0 ? 1 : 0
        }
      }

      if (unknown.length) {
        return `the ledger has maintenance at colonies the model does not read: ${unknown.join(', ')}`
      } else if (!working) {
        noteUnsupported(`${label}: no colony made maintenance supplies at the last tick, so the maintenance rule has no case there`)
      }

      if (held) {
        noteUnsupported(`${label}: ${held} colonies hold less of an input mineral than a year of maintenance needs: the ledger is compared only as at most the rate (the saved stock is the one after the tick), so the stock limit is not checked against a tick where it binds`)
      }

      if (mined) {
        noteUnsupported(`${label}: ${mined} colonies mine a mineral on their own body that their stock cannot cover for a year: what the mines add is not quantified, so the model gives no figure there and the ledger has nothing to be compared with`)
      }

      return true
    })

    add(`ship-ledger:${save.key}`, `${label}: the shipyard tasks' minerals over the last tick are the ledger's, and the year's forecast agrees within the rounding of a tick`, async () => {
      const env = await environments[save.key]()
      const logged = await env.logged(SHIPBUILDING_LEDGER_TYPE)
      const { production, minerals: { MINERALS } } = await utilities()
      const populations = [...new Set(env.inputs.tasks.map((task) => task.PopulationID))]
      const added = env.inputs.tasks.filter((task) => !task.Paused && task.TaskTypeID !== 3 && task.CompletedBP === 0)
      let working = 0

      if (!env.inputs.tasks.length || !logged.size) {
        return skip(`${label}: ${env.inputs.tasks.length ? 'the ledger holds no shipbuilding' : 'the save holds no shipyard task'}, so the shipbuilding rule has no case there`)
      }

      for (const population of populations) {
        // Paused and scrap tasks use nothing; a task with nothing done may have come after the tick, which the ledger cannot hold.
        const running = env.inputs.tasks.filter((task) => task.PopulationID === population && !task.Paused && task.TaskTypeID !== 3 && task.CompletedBP > 0)
        const model = (await modelOf(env, { colonies: [], tasks: env.inputs.tasks.filter((task) => task.PopulationID === population && !(task.CompletedBP === 0 && !task.Paused && task.TaskTypeID !== 3)), activities: [] })).shipbuilding.byMineral

        for (const mineral of MINERALS) {
          const rates = running.map((task) => env.valueOrNull(production.shipRate(env.modifiers[population], { Size: task.ClassSize, CommercialModifier: task.ClassCommercial ? 0.25 : 1 })))

          if (rates.includes(null)) {
            return `colony ${population} has a task without a build rate`
          }

          const tick = running.reduce((total, task, index) => total + task[mineral.name] * round4(round4(rates[index] * env.years) / task.TotalBP), 0)
          const observed = logged.get(`${population}:${mineral.id}`) || 0

          if (!near(tick, observed, 1e-9, 1e-9)) {
            return `colony ${population}, ${mineral.name}: the rule gives ${tick.toFixed(6)} t, the ledger ${observed.toFixed(6)} t`
          }

          // The forecast holds for a task that is not near its end: the year's use over the tick is the same product without the rounding, within what rounding a tick's fraction can take.
          const unbound = running.every((task, index) => task.TotalBP - task.CompletedBP >= rates[index])
          const bound = running.reduce((total, task) => total + task[mineral.name] * 1e-4, 0) + 1e-9
          const forecast = env.valueOrNull(model[mineral.name])

          if (forecast === null) {
            return `colony ${population}, ${mineral.name}: the forecast has no figure: ${model[mineral.name].inputs.missing.join(', ')}`
          } else if (unbound && Math.abs(forecast * env.years - observed) > bound) {
            return `colony ${population}, ${mineral.name}: the forecast ${(forecast * env.years).toFixed(6)} t over the tick is more than ${bound.toFixed(6)} t from the ledger's ${observed.toFixed(6)} t`
          }

          working += observed > 0 ? 1 : 0
        }

        // The page's own figure of each task, run through the game's rounding of a tick, gives the ledger's amounts exactly, scrap and paused tasks included. The task is widened (its build points and mineral columns times a million, nothing done) so that the figure is its build rate, not what is left to build.
        const everyone = env.inputs.tasks.filter((task) => task.PopulationID === population && !(task.CompletedBP === 0 && !task.Paused && task.TaskTypeID !== 3))
        const ticks = {}

        for (const item of everyone) {
          const lead = MINERALS.reduce((top, mineral) => (Math.abs(item[mineral.name]) > Math.abs(item[top.name]) ? mineral : top), MINERALS[0])
          const wide = { ...item, TotalBP: item.TotalBP * 1e6, CompletedBP: 0, ...Object.fromEntries(MINERALS.map((mineral) => [mineral.name, item[mineral.name] * 1e6])) }
          const yearly = env.valueOrNull((await modelOf(env, { colonies: [], tasks: [wide], activities: [] })).shipbuilding.byMineral[lead.name])

          if (yearly === null) {
            return `colony ${population}: task ${item.TaskID} has no figure`
          } else if (yearly !== 0 && item[lead.name] !== 0) {
            const points = (yearly * item.TotalBP) / item[lead.name]

            MINERALS.forEach((mineral) => {
              ticks[mineral.id] = (ticks[mineral.id] || 0) + item[mineral.name] * round4(round4(points * env.years) / item.TotalBP)
            })
          }
        }

        for (const mineral of MINERALS) {
          if (!near(ticks[mineral.id] || 0, logged.get(`${population}:${mineral.id}`) || 0, 1e-9, 1e-9)) {
            return `colony ${population}, ${mineral.name}: the page's tasks through the tick's rounding give ${(ticks[mineral.id] || 0).toFixed(6)} t, the ledger ${(logged.get(`${population}:${mineral.id}`) || 0).toFixed(6)} t`
          }
        }
      }

      if (added.length) {
        noteUnsupported(`${label}: ${added.length} running task${added.length === 1 ? ' has' : 's have'} no build points done (task ${added.map((task) => task.TaskID).join(', ')}), possibly added after the last tick, and are left out of the comparison`)
      }

      return working > 0 ? true : 'no colony has shipbuilding in the ledger to compare'
    })

    add(`activity-ledger:${save.key}`, `${label}: the shipyard activities' Duranium and Neutronium over the last tick are the ledger's`, async () => {
      const env = await environments[save.key]()
      const logged = await env.logged(ACTIVITY_LEDGER_TYPE)
      const { production, minerals: { MINERALS } } = await utilities()
      const populations = [...new Set([...env.inputs.activities.map((yard) => yard.PopulationID), ...[...logged.keys()].map((key) => Number(key.split(':')[0]))])]
      const duranium = MINERALS.find((mineral) => mineral.name === 'Duranium').id
      const neutronium = MINERALS.find((mineral) => mineral.name === 'Neutronium').id
      let working = 0

      if (!logged.size) {
        return skip(`${label}: the ledger holds no shipyard activity, so the activity rule has no case there`)
      }

      for (const population of populations) {
        const yards = env.inputs.activities.filter((yard) => yard.PopulationID === population && !yard.PauseActivity)
        const continual = yards.some((yard) => yard.TaskType === 8)
        const points = yards.reduce((total, yard) => {
          const rate = env.valueOrNull(production.shipyardUpgradeRate(env.modifiers[population], yard)) * (yard.TaskType === 7 ? yard.Slipways : 1)
          const built = rate * env.years
          // The saved progress is after the tick: restore that tick's work before capping the historical interval. An unfinished activity's remaining work is not a cap on the preceding tick.
          const leftBeforeTick = yard.RequiredBP - yard.CompletedBP + built

          return total + (yard.TaskType === 8 ? built : Math.min(built, leftBeforeTick))
        }, 0)

        for (const id of [duranium, neutronium]) {
          const observed = logged.get(`${population}:${id}`) || 0
          const expected = points / 2

          if (continual ? Math.abs(expected - observed) > CONTINUAL_TOLERANCE * Math.max(observed, 1e-9) : !near(expected, observed, 1e-6, 1e-9)) {
            return `colony ${population}: the rule gives ${expected.toFixed(6)} t of ${id === duranium ? 'Duranium' : 'Neutronium'}, the ledger ${observed.toFixed(6)} t${continual ? ' (a continual upgrade)' : ''}`
          }

          working += observed > 0 ? 1 : 0
        }

        // The utility's year, from the rows alone.
        const model = (await modelOf(env, { colonies: [], tasks: [], activities: yards })).shipbuilding.byMineral
        const yearly = yards.reduce((total, yard) => {
          const rate = env.valueOrNull(production.shipyardUpgradeRate(env.modifiers[population], yard)) * (yard.TaskType === 7 ? yard.Slipways : 1)

          return total + (yard.TaskType === 8 ? rate : Math.min(rate, yard.RequiredBP - yard.CompletedBP)) / 2
        }, 0)

        if (!near(env.valueOrNull(model.Duranium), yearly) || !near(env.valueOrNull(model.Neutronium), yearly)) {
          return `colony ${population}: the year's activity use is not half its build points of each mineral`
        }
      }

      if (env.inputs.activities.some((yard) => yard.TaskType === 8)) {
        noteUnsupported(`${label}: a continual upgrade is compared as an estimate (${CONTINUAL_TOLERANCE * 100}%): the saved capacity is the one after the tick's growth, which the ledger's tick did not have`)
      }

      return working > 0 ? true : 'no colony has a shipyard activity in the ledger to compare'
    })

    // ---- A save with a ledger: observed, nothing modelled on top, the switches subtract the observed flow -------------------------------------------
    add(`ledger-no-model:${save.key}`, `${label}: a save with a ledger shows the uses as observed, adds no modelled use even where the model's rows are loaded, and runs none of the modelled reads`, async () => {
      const env = await environments[save.key]()
      const { vm, inputs } = env
      const { minerals } = await utilities()

      if (vm.legacyUse !== null) {
        return 'the page builds a model for a save with a ledger'
      }

      const ran = env.readQueries.filter((sql) => env.modelledQueries.includes(sql))

      if (ran.length) {
        return `the modelled reads ran on a save with a ledger (${ran.length} queries)`
      } else if (vm.legacyColonies.length || vm.shipyardTasks.length || vm.shipyardActivities.length) {
        return 'the modelled reads hold rows on a save with a ledger'
      }

      // The ledger's own use of each mineral, worked out from its rows, annualised.
      const spent = (disabled = []) => spentBy(vm, minerals, disabled)

      // The model's rows loaded as if the reads had run: the page still adds nothing.
      vm.legacyColonies = inputs.colonies
      vm.shipyardTasks = inputs.tasks
      vm.shipyardActivities = inputs.activities

      try {
        const expected = spent()
        const used = vm.mineralRows.map((row) => row.used)

        if (!used.every((value, index) => near(value, expected[index], 1e-9, 1e-9))) {
          return `the use of a mineral is not the ledger's: ${used.map((value, index) => `${minerals.MINERALS[index].name} ${value} against ${expected[index]}`).find((_text, index) => !near(used[index], expected[index], 1e-9, 1e-9))}`
        }

        const rows = vm.categoryTable.filter((row) => row.toggle || row.key === 'ground')

        if (!rows.every((row) => row.coverage === 'observed' && !row.forecast && vm.sourceLabel(row) === 'Observed')) {
          return `a use is not shown as observed: ${rows.filter((row) => row.coverage !== 'observed').map((row) => `${row.key} ${row.coverage}`).join(', ')}`
        }

        const groups = { industry: ['construction', 'ordnance'], fuel: ['fuel'], maintenance: ['maintenance'], shipbuilding: ['shipbuilding'] }

        for (const [key, off] of Object.entries(groups)) {
          vm.toggleCategory(key, false)

          const reduced = vm.mineralRows.map((row) => row.used)
          const want = spent(off)

          if (!reduced.every((value, index) => near(value, want[index], 1e-9, 1e-9))) {
            return `switching ${key} off does not subtract its observed flow`
          } else if (vm.disabledCategories.join() !== key) {
            return `switching ${key} off leaves ${vm.disabledCategories.join()} switched off`
          }

          vm.toggleCategory(key, true)
        }

        return vm.disabledCategories.length === 0 ? true : 'switching the uses back on leaves some off'
      } finally {
        vm.legacyColonies = []
        vm.shipyardTasks = []
        vm.shipyardActivities = []
        vm.disabledCategories = []
      }
    })
  })

  // ---- A save without a ledger: modelled, switchable, never a silent 0 --------------------------------------------------------------------------------
  if (fallbackSource) {
    const fallbackLabel = `the ledger-less copy of ${fallbackSource.key}`
    // A positive forecast has no saved case only when both its figure and its use's flow at the last production tick are absent. The other assertions still run, including the zero-use switch and the all-off state.
    const flowing = memo(async () => {
      const env = await environments[fallbackSource.key]()
      const keys = Object.keys(USE_LEDGER_TYPES)
      const counts = await Promise.all(keys.map((key) => Promise.all(USE_LEDGER_TYPES[key].map(async (type) => (await env.logged(type)).size))))

      return Object.fromEntries(keys.map((key, index) => [key, counts[index].some((count) => count > 0)]))
    })

    // Return only absent uses without a recorded flow; an empty use with a ledger row must still fail, even alongside an unsupported use.
    const uncased = async (empty) => {
      const seen = empty.length ? await flowing() : {}

      return empty.filter((key) => !seen[key])
    }
    const uncasedReason = (keys) => `${fallbackLabel}: the save's ledger logs no ${keys.join(' or ')} flow at the last production tick, so the page's ${keys.join(' or ')} forecast has no case here`

    add('fallback-modelled', `${fallbackLabel}: every use that can be switched is a modelled forecast and none is observed, ground unit training is missing with its reason`, async () => {
      const env = await fallback()
      const { vm } = env
      const rows = vm.categoryTable
      const switchable = rows.filter((row) => row.toggle)

      if (vm.hasLedger || vm.legacyUse === null) {
        return 'the copy still has a ledger or the page builds no model for it'
      } else if (!vm.legacyColonies.length || !vm.shipyardTasks.length) {
        return 'the modelled reads returned nothing for a save that has refineries and shipyard tasks'
      } else if (switchable.length !== 4) {
        return `${switchable.length} switchable uses`
      }

      const uncasedUses = await uncased(switchable.filter((row) => !(row.total > 0)).map((row) => row.key))

      for (const row of switchable) {
        if (row.coverage !== 'modelled' || !row.forecast || vm.sourceLabel(row) !== 'Modelled forecast' || (!(row.total > 0) && !uncasedUses.includes(row.key))) {
          return `${row.key} is ${row.coverage}, label ${vm.sourceLabel(row)}, total ${row.total}`
        } else if (row.result.status === 'confirmed' && (row.key === 'industry' || row.key === 'shipbuilding')) {
          return `${row.key}, a queue or task forecast, is called confirmed`
        }
      }

      const ground = rows.find((row) => row.key === 'ground')

      if (!ground || ground.coverage !== 'missing' || ground.total !== null || ground.toggle || !ground.reason || vm.sourceLabel(ground) !== 'Missing') {
        return `ground unit training: ${JSON.stringify(ground && { coverage: ground.coverage, total: ground.total, reason: ground.reason })}`
      }

      if (uncasedUses.length) {
        noteUnsupported(`${uncasedReason(uncasedUses)} (positive forecast subcase only)`)
      }

      return true
    })

    add('fallback-switches', `${fallbackLabel}: switching a use off removes exactly its contribution to every mineral's use, and switching all of them off leaves none`, async () => {
      const env = await fallback()
      const { vm, valueOrNull } = env
      const { minerals } = await utilities()
      const names = minerals.MINERALS.map((mineral) => mineral.name)
      const all = vm.mineralRows.map((row) => row.used)

      if (!vm.legacyUse) {
        return 'the page builds no model for a copy without a ledger'
      }

      const contribution = (key, name) => (vm.legacyUse[key].byMineral[name] ? valueOrNull(vm.legacyUse[key].byMineral[name]) : 0)
      const uses = ['industry', 'fuel', 'maintenance', 'shipbuilding']

      if (all.includes(null)) {
        return `a mineral's use is not known on the real rows: ${names[all.indexOf(null)]}`
      }

      const uncasedUses = await uncased(uses.filter((key) => !names.some((name) => contribution(key, name) > 0)))

      try {
        for (const key of uses) {
          vm.toggleCategory(key, false)

          const without = vm.mineralRows.map((row) => row.used)

          if (vm.categoryTable.find((row) => row.key === key).enabled) {
            return `${key} still shows as counted`
          }

          for (let index = 0; index < names.length; index++) {
            if (!near(all[index] - without[index], contribution(key, names[index]), 1e-9, 1e-6)) {
              return `${key}, ${names[index]}: use fell by ${all[index] - without[index]}, the use's contribution is ${contribution(key, names[index])}`
            }
          }

          if (!names.some((name) => contribution(key, name) > 0) && !uncasedUses.includes(key)) {
            return `${key} takes no mineral in this save, so nothing is shown to change`
          }

          vm.toggleCategory(key, true)
        }

        uses.forEach((key) => vm.toggleCategory(key, false))

        const none = vm.mineralRows.map((row) => row.used)

        if (!none.every((value) => value === 0)) {
          return `uses remain with every use switched off: ${none.join(', ')}`
        }

        if (uncasedUses.length) {
          noteUnsupported(`${uncasedReason(uncasedUses)} (nonzero switch contribution subcase only)`)
        }

        return true
      } finally {
        vm.disabledCategories = []
      }
    })

    add('fallback-runway', `${fallbackLabel}: switching off a use that takes a mineral lengthens that mineral's runway (the mines emptied so that it is finite)`, async () => {
      const env = await fallback()
      const { vm, valueOrNull } = env
      const { minerals } = await utilities()
      const surface = vm.surfaceMining
      const orbital = vm.orbitalMining

      if (!vm.legacyUse) {
        return 'the page builds no model for a copy without a ledger'
      }

      vm.surfaceMining = []
      vm.orbitalMining = []

      try {
        const rowsOf = () => Object.fromEntries(vm.mineralRows.map((row) => [row.name, row]))
        const before = rowsOf()
        const uses = ['industry', 'fuel', 'maintenance', 'shipbuilding']
        const names = minerals.MINERALS.map((mineral) => mineral.name)
        const positive = (key) => names.filter((name) => vm.legacyUse[key].byMineral[name] && valueOrNull(vm.legacyUse[key].byMineral[name]) > 0)
        const uncasedUses = await uncased(uses.filter((key) => !positive(key).length))

        for (const key of uses) {
          const taken = positive(key).filter((name) => before[name].stock > 0)

          if (!taken.length) {
            if (uncasedUses.includes(key)) {
              continue
            }

            return `${key}: no mineral it takes has a stock in this save`
          }

          // Select the case from its inputs, never from the runway calculation being checked.
          const invalid = taken.filter((name) => !(before[name].used > 0) || !Number.isFinite(before[name].runwaySort) || !(before[name].runwaySort > 0))

          if (invalid.length) {
            return `${key}: positive stock and use give no finite positive runway for ${invalid.join(', ')}`
          }

          vm.toggleCategory(key, false)

          const after = rowsOf()
          const failed = taken.filter((name) => !(after[name].runwaySort > before[name].runwaySort))

          vm.toggleCategory(key, true)

          if (failed.length) {
            return `${key}: the runway of ${failed.join(', ')} does not lengthen`
          }
        }

        if (uncasedUses.length) {
          noteUnsupported(`${uncasedReason(uncasedUses)} (runway-lengthening subcase only)`)
        }

        return true
      } finally {
        vm.surfaceMining = surface
        vm.orbitalMining = orbital
        vm.disabledCategories = []
      }
    })

    add('fallback-unknown', `${fallbackLabel}: a use that lacks an input is missing with the reason, its minerals' use and runway are unknown, and switching it off makes them known`, async () => {
      const env = await fallback()
      const { vm } = env
      const colonies = vm.legacyColonies
      const tasks = vm.shipyardTasks
      const refining = colonies.find((colony) => colony.Refineries > 0)
      const running = tasks.findIndex((item) => !item.Paused && item.TaskTypeID !== 3)
      const sorium = () => vm.mineralRows.find((row) => row.name === 'Sorium')
      const row = (key) => vm.categoryTable.find((item) => item.key === key)

      if (!refining && running < 0) {
        return skip(`${fallbackLabel}: no colony with refineries and no running shipyard task, so neither missing-input subcase is available`)
      }

      try {
        if (refining) {
          vm.legacyColonies = colonies.map((colony) => (colony === refining ? { ...colony, FuelProdStatus: null } : colony))

          const fuel = row('fuel')

          if (fuel.coverage !== 'missing' || fuel.total !== null || !/whether fuel production is on/.test(fuel.reason) || vm.sourceLabel(fuel) !== 'Missing') {
            return `a refining colony without its switch gives ${fuel.coverage}, total ${fuel.total}, reason "${fuel.reason}"`
          } else if (sorium().used !== null || sorium().runway !== null || sorium().status !== 'unknown') {
            return `the Sorium use is ${sorium().used}, runway ${sorium().runway}, status ${sorium().status} with a use unknown`
          } else if (row('maintenance').coverage !== 'modelled' || vm.mineralRows.find((item) => item.name === 'Duranium').used === null) {
            return 'the missing fuel input leaves the maintenance supplies unknown'
          }

          vm.toggleCategory('fuel', false)

          if (sorium().used === null || row('fuel').enabled) {
            return 'switching the unknown use off does not make the Sorium use known'
          }

          vm.toggleCategory('fuel', true)
          vm.legacyColonies = colonies
        } else {
          noteUnsupported(`${fallbackLabel}: no colony with refineries, so the missing fuel input subcase is unavailable`)
        }

        if (running >= 0) {
          // A task whose class is not in the save lacks the size: shipbuilding is missing, naming it, and the other uses are untouched.
          vm.shipyardTasks = tasks.map((task, index) => (index === running ? { ...task, ClassSize: null } : task))

          const shipbuilding = row('shipbuilding')

          if (shipbuilding.coverage !== 'missing' || shipbuilding.total !== null || !/size and type of the class/.test(shipbuilding.reason)) {
            return `a task without its class gives ${shipbuilding.coverage}, total ${shipbuilding.total}, reason "${shipbuilding.reason}"`
          } else if (row('fuel').coverage !== 'modelled') {
            return 'a task without its class leaves the fuel use unknown'
          }
        } else {
          noteUnsupported(`${fallbackLabel}: no running shipyard task, so the missing class input subcase is unavailable`)
        }

        return true
      } finally {
        vm.legacyColonies = colonies
        vm.shipyardTasks = tasks
        vm.disabledCategories = []
      }
    })
  } else {
    add('fallback-absent', 'a save with ground to run the ledger-less page on is present', async () => {
      noteUnsupported('no save with shipyard tasks is present, so the page without a ledger is not run')

      return true
    })
  }

  // ---- Synthetic cases: the arithmetic written out, where the saves hold no case ------------------------------------------------------------------------
  const colony = (over = {}) => ({ PopulationID: 1, RaceID: 1, Capital: 0, NPR: 0, PopName: 'A', FuelProdStatus: 1, MaintProdStatus: 1, Sorium: 500, Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6, Mines: 0, DepositDuranium: 0, DepositUridium: 0, DepositGallicite: 0, DepositUnreadDuranium: 0, DepositUnreadUridium: 0, DepositUnreadGallicite: 0, FuelProduction: 10, MSPProduction: 5, Refineries: 20, MaintenanceFacilities: 40, ...over })
  const modifiers = (over = {}) => ({ 1: { OverallProductionModifier: 1.5, ShipyardBuildRate: 200, ...over } })
  const task = (over = {}) => ({ TaskID: 1, PopulationID: 1, TaskTypeID: 0, TotalBP: 1000, CompletedBP: 100, Paused: 0, Duranium: 600, Neutronium: 400, Corbomite: 0, Tritanium: 0, Boronide: 0, Mercassium: 0, Vendarite: 0, Sorium: 0, Uridium: 0, Corundium: 0, Gallicite: 0, ClassSize: 200, ClassCommercial: 0, ...over })
  const yard = (over = {}) => ({ ShipyardID: 1, PopulationID: 1, SYType: 1, Slipways: 3, Capacity: 5000, TaskType: 8, RequiredBP: 0, CompletedBP: 0, PauseActivity: 0, ...over })
  const model = async (rows, mods = modifiers()) => {
    const { 'legacy-consumption': legacy, provenance } = await utilities()

    return { ...legacy.legacyModels({ colonies: [], tasks: [], activities: [], ...rows, modifiers: mods }), provenance }
  }
  const synthetic = (id, name, run) => add(id, `SYNTHETIC ${name}`, run)

  synthetic('synthetic-fuel', 'refineries at a colony with production on: 20 x 10 x 1.5 / 2000 t of Sorium a year, confirmed; production off or no refineries: 0; under 1 t of Sorium: 0', async () => {
    const on = await model({ colonies: [colony()] })
    const { valueOrNull } = on.provenance
    const sorium = on.fuel.byMineral.Sorium

    if (!near(valueOrNull(sorium), (20 * 10 * 1.5) / 2000) || sorium.status !== 'confirmed') {
      return `${valueOrNull(sorium)} ${sorium.status}`
    }

    const results = await Promise.all([colony({ FuelProdStatus: 0 }), colony({ Refineries: 0 }), colony({ Sorium: 0.5 }), colony({ Refineries: 0, FuelProdStatus: null })].map(async (item) => valueOrNull((await model({ colonies: [item] })).fuel.byMineral.Sorium)))

    return results.every((value) => value === 0) ? true : `status off, no refineries, little Sorium, no refineries and no switch: ${results.join(', ')}`
  })

  synthetic('synthetic-maintenance', 'facilities with production on: 40 x 5 x 4 x 1.5 MSP a year at 0.1, 0.05 and 0.1 t of Duranium, Uridium and Gallicite; production off: 0', async () => {
    const { maintenance, provenance } = await model({ colonies: [colony()] })
    const msp = 40 * 5 * 4 * 1.5
    const off = (await model({ colonies: [colony({ MaintProdStatus: 0 })] })).maintenance.byMineral
    const wrong = [['Duranium', msp * 0.1], ['Uridium', msp * 0.05], ['Gallicite', msp * 0.1]].filter(([name, expected]) => !near(provenance.valueOrNull(maintenance.byMineral[name]), expected) || provenance.valueOrNull(off[name]) !== 0)

    return wrong.length === 0 && Object.keys(maintenance.byMineral).length === 3 ? true : `wrong: ${wrong.map(([name]) => name).join(', ')}`
  })

  synthetic('synthetic-msp-stock', 'facilities make no more MSP than the scarcest input mineral at the colony allows: no Gallicite 0, 30 t of Gallicite 300 MSP a year (30, 15 and 30 t, an estimate that says so); a mine on a deposit that still holds the mineral leaves a short stock a lower bound only (unavailable, naming the mines, unless another mineral with a known supply already settles the output, at zero or above), never unlimited and never the stock alone; a mine on an exhausted deposit or on another mineral adds nothing; a mine at another colony of an NPR\'s pool counts; an unknown stock is unavailable; an NPR colony away from its capital draws on the capital\'s stock and says so', async () => {
    const { valueOrNull } = (await model({})).provenance
    const mods = { ...modifiers(), 2: { OverallProductionModifier: 1.5 } }
    const taken = async (over, rows = null) => (await model({ colonies: rows || [colony(over)] }, mods)).maintenance.byMineral
    const none = await taken({ Gallicite: 0 })
    const some = await taken({ Gallicite: 30 })
    const covered = await taken({ Mines: 10, DepositGallicite: 1 })
    const full = await taken({})
    const unknown = await taken({ Gallicite: null })
    const capital = colony({ PopulationID: 1, RaceID: 9, NPR: 1, Capital: 1, MaintenanceFacilities: 0, Gallicite: 30 })
    const away = colony({ PopulationID: 2, RaceID: 9, NPR: 1, Capital: 0, Gallicite: 0 })
    const shared = await taken({}, [capital, away])
    const lost = await taken({}, [away])
    const wrong = []

    if (valueOrNull(none.Duranium) !== 0 || valueOrNull(none.Gallicite) !== 0 || none.Duranium.status !== 'estimated' || !/minerals the colony holds/.test(none.Duranium.assumptions.join(' '))) {
      wrong.push(`no Gallicite: ${valueOrNull(none.Duranium)}, ${none.Duranium.status}`)
    }

    if (!near(valueOrNull(some.Duranium), 30) || !near(valueOrNull(some.Uridium), 15) || !near(valueOrNull(some.Gallicite), 30) || some.Gallicite.status !== 'estimated') {
      wrong.push(`30 t of Gallicite: ${valueOrNull(some.Duranium)}, ${valueOrNull(some.Uridium)}, ${valueOrNull(some.Gallicite)}`)
    }

    const heldNote = (result) => /minerals the colony holds/.test(result.assumptions.join(' '))

    if (!near(valueOrNull(covered.Duranium), 120) || heldNote(covered.Duranium) || !near(valueOrNull(full.Duranium), 120) || heldNote(full.Duranium)) {
      wrong.push(`a stock that covers the year: ${valueOrNull(covered.Duranium)} ${covered.Duranium.status}, ${valueOrNull(full.Duranium)} ${full.Duranium.status}`)
    }

    const mined = [
      ['a mine on a Gallicite deposit with no Gallicite in stock', { Gallicite: 0, Mines: 10, DepositGallicite: 1 }, 'unavailable'],
      ['a slow mine: 5 t of Gallicite in stock, 120 t needed', { Gallicite: 5, Mines: 1, DepositGallicite: 1 }, 'unavailable'],
      ['a mine on a deposit whose amount is not recorded', { Gallicite: 0, Mines: 1, DepositUnreadGallicite: 1 }, 'unavailable'],
      ['mines whose number is not recorded on a Gallicite deposit', { Gallicite: 0, Mines: null, DepositGallicite: 1 }, 'unavailable'],
      ['a mine on an exhausted Gallicite deposit', { Gallicite: 0, Mines: 1, DepositGallicite: 0 }, 0],
      ['a mine on a deposit of another mineral', { Gallicite: 0, Mines: 10, DepositDuranium: 1 }, 0],
      ['mines whose number is not recorded and no deposit of the mineral', { Gallicite: 0, Mines: null }, 0],
      ['a deposit of the mineral and no mine', { Gallicite: 0, Mines: 0, DepositGallicite: 1 }, 0],
    ]

    for (const [label, over, expected] of mined) {
      const result = (await taken(over)).Duranium

      if (expected === 'unavailable' ? (result.status !== 'unavailable' || !/Gallicite the colony's own mines/.test(result.inputs.missing.join(' '))) : valueOrNull(result) !== expected) {
        wrong.push(`${label}: ${valueOrNull(result)} ${result.status}`)
      }
    }

    const cross = [
      ['zero Gallicite settles the figure whatever the Duranium mine adds', { Gallicite: 0, Duranium: 5, Mines: 1, DepositDuranium: 1 }, [0, 0, 0]],
      ['equal known stocks of Duranium (mined) and Gallicite (not mined): Gallicite fixes 81.9 MSP', { Gallicite: 8.19460613484232, Duranium: 8.19460613484232, Mines: 1, DepositDuranium: 1 }, [8.19460613484232, 4.09730306742116, 8.19460613484232]],
      ['a mined Duranium stock above the Gallicite stock leaves the Gallicite figure', { Gallicite: 3, Duranium: 5, Mines: 1, DepositDuranium: 1 }, [3, 1.5, 3]],
    ]

    for (const [label, over, [duranium, uridium, gallicite]] of cross) {
      const result = await taken(over)

      if (!near(valueOrNull(result.Duranium), duranium) || !near(valueOrNull(result.Uridium), uridium) || !near(valueOrNull(result.Gallicite), gallicite)) {
        wrong.push(`${label}: ${valueOrNull(result.Duranium)}, ${valueOrNull(result.Uridium)}, ${valueOrNull(result.Gallicite)}`)
      }
    }

    const open = (await taken({ Gallicite: 100, Duranium: 5, Mines: 1, DepositDuranium: 1 })).Duranium

    if (open.status !== 'unavailable' || !/Duranium the colony's own mines/.test(open.inputs.missing.join(' '))) {
      wrong.push(`a mined Duranium stock below what the other minerals allow: ${valueOrNull(open)} ${open.status}`)
    }

    const bounded = [
      ['a mined Duranium stock a hair under the exact Gallicite cap (9.999999995 against 10 MSP)', { Gallicite: 1, Duranium: 0.9999999995, Mines: 1, DepositDuranium: 1 }, /Duranium the colony's own mines/],
      ['a tiny exact Gallicite cap and a Duranium stock that is not in the save', { Gallicite: 1e-12, Duranium: null }, /stock of Duranium/],
    ]

    for (const [label, over, reason] of bounded) {
      const result = (await taken(over)).Duranium

      if (result.status !== 'unavailable' || !reason.test(result.inputs.missing.join(' '))) {
        wrong.push(`${label}: ${valueOrNull(result)} ${result.status} ${result.inputs.missing.join(', ')}`)
      }
    }

    const pool = (over, awayOver) => taken({}, [colony({ PopulationID: 1, RaceID: 9, NPR: 1, Capital: 1, Gallicite: 0, ...over }), colony({ PopulationID: 2, RaceID: 9, NPR: 1, Capital: 0, MaintenanceFacilities: 0, ...awayOver })])
    const supplier = (await pool({}, { Mines: 4, DepositGallicite: 1 })).Duranium
    const idle = await pool({}, { Mines: 4, DepositGallicite: 0 })
    const unread = (await pool({}, { Mines: 4, DepositUnreadGallicite: 1 })).Duranium

    if (supplier.status !== 'unavailable' || !/Gallicite the mines of the colonies that share the stock/.test(supplier.inputs.missing.join(' '))) {
      wrong.push(`a Gallicite mine at another colony of the pool: ${valueOrNull(supplier)} ${supplier.status}`)
    } else if (valueOrNull(idle.Duranium) !== 0 || unread.status !== 'unavailable') {
      wrong.push(`another colony's mine on an exhausted deposit gives ${valueOrNull(idle.Duranium)}, on a deposit with no recorded amount ${unread.status}`)
    }

    if (unknown.Duranium.status !== 'unavailable' || !/Gallicite/.test(unknown.Duranium.inputs.missing.join(' '))) {
      wrong.push(`an unknown Gallicite stock is ${unknown.Duranium.status}`)
    }

    if (!near(valueOrNull(shared.Duranium), 30) || shared.Duranium.status !== 'estimated' || !/shared/.test(shared.Duranium.assumptions.join(' '))) {
      wrong.push(`the capital's stock: ${valueOrNull(shared.Duranium)} ${shared.Duranium.status}`)
    }

    if (lost.Duranium.status !== 'unavailable' || !/capital/.test(lost.Duranium.inputs.missing.join(' '))) {
      wrong.push(`without a capital row: ${lost.Duranium.status}`)
    }

    return wrong.length ? wrong.join('; ') : true
  })

  synthetic('synthetic-whole-facilities', 'refineries and facilities are cut to whole numbers (10.9 refineries make 10 refineries\' Sorium, 7.9 facilities 7 facilities\' MSP) and the result is an estimate that says so', async () => {
    const { fuel, maintenance, provenance } = await model({ colonies: [colony({ Refineries: 10.9, MaintenanceFacilities: 7.9 })] })
    const sorium = fuel.byMineral.Sorium
    const duranium = maintenance.byMineral.Duranium

    if (!near(provenance.valueOrNull(sorium), (10 * 10 * 1.5) / 2000) || !near(provenance.valueOrNull(duranium), 7 * 5 * 4 * 1.5 * 0.1)) {
      return `Sorium ${provenance.valueOrNull(sorium)}, Duranium ${provenance.valueOrNull(duranium)}`
    }

    return sorium.status === 'estimated' && duranium.status === 'estimated' && /whole number/.test(sorium.assumptions.join(' ')) ? true : `statuses ${sorium.status}, ${duranium.status}`
  })

  synthetic('synthetic-unknown-status', 'a refining or maintaining colony whose switch is not in the save, or whose modifier or Sorium is missing, is unavailable and names it, and one unknown colony makes the total unknown, never the others\' sum', async () => {
    const { provenance } = await model({})
    const cases = [
      [{ colonies: [colony({ FuelProdStatus: null })] }, 'fuel', 'Sorium', /whether fuel production is on/, modifiers()],
      [{ colonies: [colony({ MaintProdStatus: null })] }, 'maintenance', 'Duranium', /whether maintenance production is on/, modifiers()],
      [{ colonies: [colony()] }, 'fuel', 'Sorium', /production modifier/, {}],
      [{ colonies: [colony({ Sorium: null })] }, 'fuel', 'Sorium', /Sorium stock/, modifiers()],
      [{ colonies: [colony({ FuelProduction: null })] }, 'fuel', 'Sorium', /fuel production rate/, modifiers()],
      [{ colonies: [colony(), colony({ PopulationID: 2, FuelProdStatus: null })] }, 'fuel', 'Sorium', /whether fuel production is on/, { ...modifiers(), 2: { OverallProductionModifier: 1 } }],
    ]
    const wrong = []

    for (const [rows, use, mineral, reason, mods] of cases) {
      const result = (await model(rows, mods))[use].byMineral[mineral]

      if (result.status !== 'unavailable' || result.value !== null || !reason.test(result.inputs.missing.join(' '))) {
        wrong.push(`${use} ${reason}: ${result.status} ${provenance.valueOrNull(result)}`)
      }
    }

    return wrong.length ? wrong.join('; ') : true
  })

  synthetic('synthetic-tasks', 'a task builds at its colony\'s rate scaled by the class size and takes its mineral columns in proportion: 600 t of Duranium of 1,000 BP at 300 BP a year is 180 t; a commercial class counts a quarter of its size (150 BP, 90 t)', async () => {
    const { shipbuilding, provenance } = await model({ tasks: [task()] })
    const commercial = await model({ tasks: [task({ ClassCommercial: 1 })] })

    if (!near(provenance.valueOrNull(shipbuilding.byMineral.Duranium), 180) || !near(provenance.valueOrNull(shipbuilding.byMineral.Neutronium), 120) || provenance.valueOrNull(shipbuilding.byMineral.Sorium) !== 0) {
      return `Duranium ${provenance.valueOrNull(shipbuilding.byMineral.Duranium)}, Neutronium ${provenance.valueOrNull(shipbuilding.byMineral.Neutronium)}`
    }

    return near(provenance.valueOrNull(commercial.shipbuilding.byMineral.Duranium), 90) ? true : `commercial ${provenance.valueOrNull(commercial.shipbuilding.byMineral.Duranium)}`
  })

  synthetic('synthetic-task-cap', 'a task near its end takes only its remaining build points: 100 BP left of 1,000 takes 100 / 1000 of its Duranium column (60 t), not a year\'s 300 BP', async () => {
    const { shipbuilding, provenance } = await model({ tasks: [task({ CompletedBP: 900 })] })

    return near(provenance.valueOrNull(shipbuilding.byMineral.Duranium), 60) ? true : `${provenance.valueOrNull(shipbuilding.byMineral.Duranium)}`
  })

  synthetic('synthetic-scrap-paused', 'a scrap task and a paused task use nothing, and are counted as 0 only for that reason', async () => {
    const { shipbuilding, provenance } = await model({ tasks: [task(), task({ TaskID: 2, TaskTypeID: 3, Duranium: -500 }), task({ TaskID: 3, Paused: 1 })] })

    return near(provenance.valueOrNull(shipbuilding.byMineral.Duranium), 180) ? true : `${provenance.valueOrNull(shipbuilding.byMineral.Duranium)} of Duranium for one running task beside a scrap and a paused task`
  })

  synthetic('synthetic-task-unknown', 'a task lacking the class size, the build points, the pause flag or a mineral column is unavailable and names it (the other minerals of the task stay known)', async () => {
    const { provenance } = await model({})
    const cases = [[{ ClassSize: null }, 'Duranium', /size and type of the class/], [{ ClassCommercial: null }, 'Duranium', /size and type of the class/], [{ TotalBP: 0 }, 'Duranium', /build points/], [{ Paused: null }, 'Duranium', /paused/], [{ Duranium: null }, 'Duranium', /Duranium the task needs/]]
    const wrong = []

    for (const [over, mineral, reason] of cases) {
      const result = (await model({ tasks: [task(over)] })).shipbuilding.byMineral[mineral]

      if (result.status !== 'unavailable' || !reason.test(result.inputs.missing.join(' '))) {
        wrong.push(`${JSON.stringify(over)}: ${result.status}`)
      }
    }

    const partial = (await model({ tasks: [task({ Duranium: null })] })).shipbuilding.byMineral
    const missingMod = (await model({ tasks: [task()] }, {})).shipbuilding.byMineral.Duranium

    if (provenance.valueOrNull(partial.Neutronium) === null || missingMod.status !== 'unavailable') {
      wrong.push('a missing Duranium column makes the other minerals unknown, or a missing modifier row is a number')
    }

    return wrong.length ? wrong.join('; ') : true
  })

  synthetic('synthetic-activities', 'a yard activity takes half its build points of each of Duranium and Neutronium: a continual upgrade at 200 BP a year 100 t each, held at today\'s capacity and said so; a retool builds with all 3 slipways (300 t at 600 BP), capped by its remaining build points; a commercial yard at a tenth of the capacity; paused: 0', async () => {
    const value = async (rows) => (await model(rows)).provenance.valueOrNull((await model(rows)).shipbuilding.byMineral.Duranium)
    const continual = (await model({ activities: [yard()] })).shipbuilding.byMineral.Duranium
    const cases = [
      [await value({ activities: [yard()] }), 100],
      [await value({ activities: [yard({ TaskType: 7, RequiredBP: 1000 })] }), 300],
      [await value({ activities: [yard({ TaskType: 7, RequiredBP: 400 })] }), 200],
      [await value({ activities: [yard({ TaskType: 1, RequiredBP: 50, CompletedBP: 10 })] }), 20],
      [await value({ activities: [yard({ SYType: 2 })] }), 55],
      [await value({ activities: [yard({ PauseActivity: 1 })] }), 0],
    ]
    const wrong = cases.filter(([actual, expected]) => !near(actual, expected)).map(([actual, expected]) => `${actual} for ${expected}`)

    return wrong.length === 0 && /capacity today/.test(continual.assumptions.join(' ')) ? true : `wrong: ${wrong.join('; ') || 'the continual upgrade does not say it is held at today\'s capacity'}`
  })

  // ---- The flows and the table on results, with no page ------------------------------------------------------------------------------------------------
  synthetic('synthetic-flow-switches', 'a use switched off leaves the use (fallback: the other uses\' sum; ledger: its flow groups), a use unknown makes the use unknown, and one switched off makes it known again', async () => {
    const { 'mineral-outlook': outlook, provenance } = await utilities()
    const { valueOrNull, ofRule, unavailable } = provenance
    const known = (value) => ofRule({ rule: 'legacy.fuelUse', value })
    const lacking = unavailable({ rule: 'legacy.maintenanceUse', missing: ['the facilities'] })
    const use = (key, label, result, enabled = true, groups = [key]) => ({ key, label, groups, enabled, result })
    const base = { hasLedger: false, coverageDays: 0, ledger: {}, incomeGroups: [], spendGroups: [], mined: ofRule({ rule: 'mineral.miningRate', value: 0, inputs: { present: ['x'] } }) }
    const flows = (uses) => outlook.flowResults({ ...base, uses })
    const wrong = []

    if (valueOrNull(flows([use('industry', 'Industry queue', known(7)), use('fuel', 'Fuel refining', known(3))]).used) !== 10) {
      wrong.push('the sum of the uses switched on')
    }

    if (valueOrNull(flows([use('industry', 'Industry queue', known(7)), use('fuel', 'Fuel refining', known(3), false)]).used) !== 7) {
      wrong.push('a use switched off still counts')
    }

    const unknown = flows([use('industry', 'Industry queue', known(7)), use('maintenance', 'Maintenance supplies', lacking)])

    if (unknown.used.status !== 'unavailable' || valueOrNull(unknown.net) !== null || !/facilities/.test(unknown.used.inputs.missing.join(' '))) {
      wrong.push(`an unknown use is ${unknown.used.status}`)
    }

    if (valueOrNull(flows([use('industry', 'Industry queue', known(7)), use('maintenance', 'Maintenance supplies', lacking, false)]).used) !== 7) {
      wrong.push('an unknown use switched off still leaves the use unknown')
    }

    if (valueOrNull(flows([use('industry', 'Industry queue', known(7), false)]).used) !== 0 || valueOrNull(flows([use('fuel', 'Fuel refining', null)]).used) !== 0) {
      wrong.push('a mineral no use switched on takes is not a real 0')
    }

    if (!/switched off/.test(flows([use('fuel', 'Fuel refining', known(3), false)]).used.assumptions.join(' ')) || !/not measured/.test(flows([]).used.assumptions.join(' '))) {
      wrong.push('the assumptions do not say a use is switched off and that use is modelled, not measured')
    }

    const ledger = { mining: 0, fuel: 5, maintenance: 11, construction: 2 }
    const observed = (uses) => outlook.flowResults({ hasLedger: true, coverageDays: 365, ledger, incomeGroups: ['mining'], spendGroups: ['fuel', 'maintenance', 'construction'], mined: null, uses })

    if (valueOrNull(observed([]).used) !== 18 || valueOrNull(observed([use('fuel', 'Fuel refining', known(999), false, ['fuel'])]).used) !== 13 || valueOrNull(observed([use('fuel', 'Fuel refining', known(999), true, ['fuel'])]).used) !== 18) {
      wrong.push('with a ledger, a use switched off does not subtract its flow groups, or a modelled result is added')
    }

    return wrong.length ? wrong.join('; ') : true
  })

  synthetic('synthetic-category-rows', 'the uses table: observed with a ledger, modelled without, missing with the reason when a use or the ledger\'s days are unknown, ground unit training never modelled', async () => {
    const { 'mineral-outlook': outlook, 'legacy-consumption': legacy, minerals, provenance } = await utilities()
    const { ofRule, unavailable } = provenance
    const flow = { construction: 1, ordnance: 2, fuel: 3, maintenance: 4, shipbuilding: 5, ground: 6 }
    const ledgerFlows = { 1: flow, 2: flow }
    const mineralList = minerals.MINERALS.slice(0, 2)
    const rows = (over) => outlook.categoryRows({ hasLedger: true, coverageDays: 365, ledgerFlows, minerals: mineralList, modelled: null, disabled: [], focus: mineralList[0], ...over })
    const wrong = []
    const observed = rows({})

    if (observed.map((row) => row.total).join() !== '6,6,8,10,12' || observed.map((row) => row.focus).join() !== '3,3,4,5,6' || !observed.every((row) => row.coverage === 'observed' && !row.forecast)) {
      wrong.push(`observed ${observed.map((row) => `${row.key} ${row.coverage} ${row.total}`).join(', ')}`)
    }

    const noDays = rows({ coverageDays: 0 })

    if (!noDays.every((row) => row.coverage === 'missing' && row.total === null && /days the ledger covers/.test(row.reason))) {
      wrong.push('a ledger that covers no days is not missing with that reason')
    }

    const byMineral = (value) => Object.fromEntries(mineralList.map((mineral) => [mineral.name, ofRule({ rule: 'legacy.shipbuildingUse', value, inputs: { present: ['x'] } })]))
    const modelled = { industry: { byMineral: byMineral(1), basis: 'queue' }, fuel: { byMineral: { Sorium: unavailable({ rule: 'legacy.fuelUse', missing: ['whether fuel production is on'] }) }, basis: 'refineries' }, maintenance: { byMineral: byMineral(2), basis: 'facilities' }, shipbuilding: { byMineral: byMineral(3), basis: 'tasks' } }
    const without = rows({ hasLedger: false, coverageDays: 0, modelled, disabled: ['maintenance'] })
    const byKey = Object.fromEntries(without.map((row) => [row.key, row]))

    if (byKey.industry.coverage !== 'modelled' || !byKey.industry.forecast || byKey.industry.total !== 2 || byKey.industry.focus !== 1) {
      wrong.push('a modelled use is not a forecast with its total')
    }

    if (byKey.fuel.coverage !== 'missing' || byKey.fuel.total !== null || !/whether fuel production is on/.test(byKey.fuel.reason) || byKey.fuel.focus !== 0) {
      wrong.push(`an unknown use is ${byKey.fuel.coverage}, total ${byKey.fuel.total}, reason "${byKey.fuel.reason}", focus ${byKey.fuel.focus}`)
    }

    if (byKey.maintenance.enabled || !byKey.shipbuilding.enabled || byKey.ground.toggle || byKey.ground.coverage !== 'missing' || byKey.ground.total !== null || byKey.ground.reason !== legacy.UNMODELLED.reason) {
      wrong.push('a switch, or ground unit training, is wrong')
    }

    return wrong.length ? wrong.join('; ') : true
  })

  synthetic('synthetic-pool', 'an NPR\'s refineries away from its capital draw on the capital\'s Sorium (500 t, not their own 0): 20 x 10 x 1.5 / 2000 t a year, an estimate that says the stock is shared; a capital and a player\'s colony use their own stock; an NPR colony whose capital is not among the rows is unavailable and names it', async () => {
    const mods = { ...modifiers(), 2: { OverallProductionModifier: 1.5 } }
    const capital = colony({ PopulationID: 1, RaceID: 9, NPR: 1, Capital: 1, Refineries: 0, Sorium: 500 })
    const away = colony({ PopulationID: 2, RaceID: 9, NPR: 1, Capital: 0, Refineries: 20, Sorium: 0 })
    const shared = (await model({ colonies: [capital, away] }, mods)).fuel.byMineral.Sorium
    const { valueOrNull } = (await model({})).provenance
    const wrong = []

    if (!near(valueOrNull(shared), (20 * 10 * 1.5) / 2000) || shared.status !== 'estimated' || !/shared/.test(shared.assumptions.join(' '))) {
      wrong.push(`the shared stock gives ${valueOrNull(shared)}, ${shared.status}`)
    }

    const own = await model({ colonies: [colony({ PopulationID: 2, RaceID: 9, NPR: 1, Capital: 1, Refineries: 20, Sorium: 500 })] }, mods)
    const player = await model({ colonies: [colony({ PopulationID: 2, RaceID: 9, NPR: 0, Capital: 0, Refineries: 20, Sorium: 0 }), colony({ PopulationID: 3, RaceID: 9, NPR: 0, Capital: 1, Refineries: 0, Sorium: 500 })] }, { ...mods, 3: { OverallProductionModifier: 1 } })

    if (!near(valueOrNull(own.fuel.byMineral.Sorium), 0.15) || own.fuel.byMineral.Sorium.status !== 'confirmed') {
      wrong.push(`a capital's refineries give ${valueOrNull(own.fuel.byMineral.Sorium)}, ${own.fuel.byMineral.Sorium.status}`)
    } else if (valueOrNull(player.fuel.byMineral.Sorium) !== 0) {
      wrong.push('a colony of a race that is not an NPR draws on the capital\'s stock')
    }

    const lost = (await model({ colonies: [away] }, mods)).fuel.byMineral.Sorium

    if (lost.status !== 'unavailable' || !/capital/.test(lost.inputs.missing.join(' '))) {
      wrong.push(`without a capital row: ${lost.status}`)
    }

    return wrong.length ? wrong.join('; ') : true
  })

  synthetic('synthetic-pool-once', 'the maintenance of an NPR\'s colonies spends its capital\'s stock once: 30 t of Gallicite at the capital and facilities at the capital and at another colony make 300 MSP in all (30 t of Gallicite), not 300 MSP at each (60 t); a second NPR has a stock of its own, and two colonies of a player each their own', async () => {
    const mods = { ...modifiers(), 2: { OverallProductionModifier: 1.5 }, 3: { OverallProductionModifier: 1.5 }, 4: { OverallProductionModifier: 1.5 }, 5: { OverallProductionModifier: 1.5 } }
    const capital = colony({ PopulationID: 1, RaceID: 9, NPR: 1, Capital: 1, Gallicite: 30 })
    const away = colony({ PopulationID: 2, RaceID: 9, NPR: 1, Capital: 0, Gallicite: 0 })
    const otherCapital = colony({ PopulationID: 3, RaceID: 8, NPR: 1, Capital: 1, Gallicite: 30 })
    const otherAway = colony({ PopulationID: 4, RaceID: 8, NPR: 1, Capital: 0, Gallicite: 0 })
    const { valueOrNull } = (await model({})).provenance
    const wrong = []
    const pool = (await model({ colonies: [capital, away] }, mods)).maintenance.byMineral
    const twice = (await model({ colonies: [capital, away, otherCapital, otherAway] }, mods)).maintenance.byMineral
    const players = (await model({ colonies: [colony({ PopulationID: 1, Gallicite: 30 }), colony({ PopulationID: 2, Gallicite: 30 })] }, mods)).maintenance.byMineral

    if (!near(valueOrNull(pool.Gallicite), 30) || !near(valueOrNull(pool.Duranium), 30) || !near(valueOrNull(pool.Uridium), 15)) {
      wrong.push(`one pool: ${valueOrNull(pool.Duranium)}, ${valueOrNull(pool.Uridium)}, ${valueOrNull(pool.Gallicite)} t`)
    }

    if (pool.Gallicite.status !== 'estimated' || !/shared/.test(pool.Gallicite.assumptions.join(' '))) {
      wrong.push(`one pool is ${pool.Gallicite.status}`)
    }

    if (!near(valueOrNull(twice.Gallicite), 60)) {
      wrong.push(`two NPRs: ${valueOrNull(twice.Gallicite)} t of Gallicite`)
    }

    if (!near(valueOrNull(players.Gallicite), 60)) {
      wrong.push(`two colonies of a player: ${valueOrNull(players.Gallicite)} t of Gallicite`)
    }

    return wrong.length ? wrong.join('; ') : true
  })

  synthetic('synthetic-query-unread', 'the colony read keeps an installation row whose amount or type is not in the save apart from no row: no row is 0, a refinery, facility or mine count that rests on an unreadable row is null and makes the fuel and maintenance figures unavailable (naming it) until the colony\'s use is left out, a null amount of a type that adds nothing to a column leaves that column known, and a deposit with no recorded amount or with none left is told from one that holds some', async () => {
    const statements = [
      'create table FCT_Population (PopulationID integer, GameID integer, RaceID integer, PopName text, Capital integer, FuelProdStatus integer, MaintProdStatus integer, Sorium real, Duranium real, Uridium real, Gallicite real, SystemBodyID integer)',
      'create table FCT_Race (RaceID integer, NPR integer, FuelProduction real, MSPProduction real)',
      'create table FCT_PopulationInstallations (GameID integer, PopID integer, PlanetaryInstallationID integer, Amount real)',
      'create table DIM_PlanetaryInstallation (PlanetaryInstallationID integer, RefineryProductionValue real, MaintenanceValue real, MiningProductionValue real)',
      'create table FCT_MineralDeposit (GameID integer, SystemBodyID integer, MaterialID integer, Amount real)',
      'insert into FCT_Race values (1, 0, 10, 5)',
      'insert into DIM_PlanetaryInstallation values (1, 1, 1, 0), (2, 0, 0, 1), (3, 0, 1, 0)',
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((id) => `insert into FCT_Population values (${id}, 1, 1, 'P${id}', ${id === 1 ? 1 : 0}, 1, 1, 500, 1000000, 1000000, ${id <= 4 ? 1000000 : 0}, ${id})`),
      'insert into FCT_PopulationInstallations values (1, 1, 1, 20)',
      'insert into FCT_PopulationInstallations values (1, 2, 1, null)',
      'insert into FCT_PopulationInstallations values (1, 3, 99, 5)',
      'insert into FCT_PopulationInstallations values (1, 6, 1, 20), (1, 6, 2, null)',
      ...[5, 7, 8].map((id) => `insert into FCT_PopulationInstallations values (1, ${id}, 3, 40), (1, ${id}, 2, 1)`),
      'insert into FCT_MineralDeposit values (1, 5, 11, null), (1, 7, 11, 500), (1, 8, 11, 0)',
    ]
    const { 'legacy-consumption': legacy } = await utilities()
    const rows = await sqlRows(statements, legacy.legacyColoniesQuery({ GameID: 1, RaceID: 1 }))
    const row = (name) => rows.find((item) => item.PopName === name)
    const mods = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((id) => [id, { OverallProductionModifier: 1.5 }]))
    const { provenance } = await model({})
    const wrong = []
    const counts = (item) => [item.Refineries, item.MaintenanceFacilities, item.Mines]
    const expected = [['P1', [20, 20, 0]], ['P2', [null, null, 0]], ['P3', [null, null, null]], ['P4', [0, 0, 0]], ['P6', [20, 20, null]]]

    if (rows.length !== 8) {
      wrong.push(`${rows.length} colonies read`)
    }

    for (const [name, counted] of expected) {
      if (!row(name) || JSON.stringify(counts(row(name))) !== JSON.stringify(counted)) {
        wrong.push(`${name}: ${row(name) ? JSON.stringify(counts(row(name))) : 'not read'}, expected ${JSON.stringify(counted)}`)
      }
    }

    const deposits = (name) => [row(name).DepositGallicite, row(name).DepositUnreadGallicite]

    if (JSON.stringify([deposits('P5'), deposits('P7'), deposits('P8'), deposits('P4')]) !== JSON.stringify([[0, 1], [1, 0], [0, 0], [0, 0]])) {
      wrong.push(`Gallicite deposits of a body with an unrecorded amount, 500 t, none left and none: ${JSON.stringify([deposits('P5'), deposits('P7'), deposits('P8'), deposits('P4')])}`)
    }

    const by = async (names) => (await model({ colonies: names.map(row) }, mods))
    const sorium = async (names) => (await by(names)).fuel.byMineral.Sorium
    const duranium = async (names) => (await by(names)).maintenance.byMineral.Duranium

    const known = [['fuel of a colony with 20 refineries', await sorium(['P1']), 0.15], ['its maintenance Duranium', await duranium(['P1']), 60], ['fuel of a colony with no installation row', await sorium(['P4']), 0], ['its maintenance', await duranium(['P4']), 0], ['fuel of a colony whose mine amount is not recorded', await sorium(['P6']), 0.15], ['maintenance of a colony whose mines are not recorded, on a body with no Gallicite and no Gallicite in stock', await duranium(['P6']), 0]]

    known.forEach(([label, result, value]) => {
      if (!provenance.isAvailable(result) || !near(provenance.valueOrNull(result), value)) {
        wrong.push(`${label}: ${result.status} ${provenance.valueOrNull(result)}, expected ${value}`)
      }
    })

    const unknown = [['fuel of a colony with an installation amount not recorded', await sorium(['P2']), /refineries/], ['its maintenance', await duranium(['P2']), /maintenance facilities/], ['fuel of a colony with an installation of an unknown type', await sorium(['P3']), /refineries/], ['its maintenance', await duranium(['P3']), /maintenance facilities/], ['the fuel total with that colony among others', await sorium(['P1', 'P2']), /refineries/], ['the maintenance total with that colony among others', await duranium(['P1', 'P3']), /maintenance facilities/], ['maintenance with a mine on a deposit of no recorded amount', await duranium(['P5']), /Gallicite the colony's own mines/], ['maintenance with a mine on a deposit that holds 500 t', await duranium(['P7']), /Gallicite the colony's own mines/]]

    unknown.forEach(([label, result, reason]) => {
      if (result.status !== 'unavailable' || !reason.test(result.inputs.missing.join(' '))) {
        wrong.push(`${label}: ${result.status} ${provenance.valueOrNull(result)} ${result.inputs.missing.join(', ')}`)
      }
    })

    const exhausted = await duranium(['P8'])

    if (provenance.valueOrNull(exhausted) !== 0) {
      wrong.push(`maintenance of a colony whose mine is on an exhausted Gallicite deposit and with no Gallicite: ${exhausted.status} ${provenance.valueOrNull(exhausted)}`)
    }

    return wrong.length ? wrong.join('; ') : true
  })

  synthetic('synthetic-industry-basis', 'the industry queue\'s basis counts the projects, and for an NPR with an ordnance project adds that its ordnance is not charged to its minerals and has no saved case; a race that is not an NPR, or an NPR without ordnance, gets no such line', async () => {
    const { 'legacy-consumption': legacy } = await utilities()
    const ordnance = [{ ProductionType: 1 }, { ProductionType: 0 }]
    const noted = (text) => /ordnance/.test(text) && /no saved case/.test(text)
    const cases = [[legacy.industryBasis({ projects: ordnance, npr: true }), true], [legacy.industryBasis({ projects: ordnance, npr: false }), false], [legacy.industryBasis({ projects: [{ ProductionType: 0 }], npr: true }), false], [legacy.industryBasis({ projects: [], npr: true }), false]]
    const wrong = cases.filter(([text, expected]) => noted(text) !== expected).map(([text]) => text)

    return wrong.length === 0 && /^2 projects/.test(cases[0][0]) && /^0 projects/.test(cases[3][0]) ? true : `wrong: ${wrong.join('; ') || cases.map(([text]) => text).join('; ')}`
  })

  return {
    list,
    cleanup: async () => {
      for (const database of opened) {
        await database.close()
      }

      cleanup.forEach((remove) => remove())
    },
  }
}

const RESULT_PREFIX = 'LEGACY-RESULT '

// The mutations: [label, file, from, to, fails]. `fails` are the ids of the checks the mutation must break; only those are run, in a process of their own on a copy of the sources.
const MUTATIONS = [
  ['facilities are no longer cut to whole numbers', path.join('utilities', 'legacy-consumption.js'), '{ count: Math.trunc(value), fractional: Math.trunc(value) !== value }', '{ count: value, fractional: false }', ['synthetic-whole-facilities']],
  ['a scrap task takes its (negative) minerals', path.join('utilities', 'legacy-consumption.js'), 'task.TaskTypeID === TASK_TYPE_SCRAP) {\n    return idle', 'task.TaskTypeID === -1) {\n    return idle', ['synthetic-scrap-paused']],
  ['a paused task is built', path.join('utilities', 'legacy-consumption.js'), '} else if (task.Paused) {', '} else if (false) {', ['synthetic-scrap-paused']],
  ['a task builds past its remaining build points', path.join('utilities', 'legacy-consumption.js'), 'Math.min(values[\'the task\\\'s build rate\'], Math.max(0, task.TotalBP - task.CompletedBP))', 'values[\'the task\\\'s build rate\']', ['synthetic-task-cap']],
  ['a commercial class counts its full size', path.join('utilities', 'legacy-consumption.js'), 'task.ClassCommercial ? 0.25 : 1', '1', ['synthetic-tasks']],
  ['a refit builds the class it leaves, not the one it becomes', path.join('utilities', 'legacy-consumption.js'), 'FCT_ShipyardTask.TaskTypeID in (2, 4)', 'FCT_ShipyardTask.TaskTypeID in (-1)', ['loader-refit:fixture']],
  ['a retool ignores its slipways', path.join('utilities', 'legacy-consumption.js'), '(retool ? yard.Slipways : 1)', '1', ['synthetic-activities']],
  ['a colony with no maintenance switch makes nothing', path.join('utilities', 'legacy-consumption.js'), 'result = unavailable({ rule: MAINTENANCE, missing: [\'whether maintenance production is on\'], units: \'MSP/yr\' })', 'result = zero(MAINTENANCE, \'maintenance production is off\', \'MSP/yr\')', ['synthetic-unknown-status']],
  ['a refinery with its production off still refines', path.join('utilities', 'logistics.js'), '} else if (!colony.FuelProdStatus || colony.Refineries === 0) {', '} else if (colony.Refineries === 0) {', ['synthetic-fuel']],
  ['a use that lacks an input is counted as 0', path.join('utilities', 'mineral-outlook.js'), 'uses.filter((use) => use.enabled && use.result)', 'uses.filter((use) => use.enabled && use.result && use.result.value !== null)', ['synthetic-flow-switches', 'fallback-unknown']],
  ['a switched-off use still counts without a ledger', path.join('utilities', 'mineral-outlook.js'), 'uses.filter((use) => use.enabled && use.result)', 'uses.filter((use) => use.result)', ['synthetic-flow-switches', 'fallback-switches']],
  ['a switched-off use leaves the ledger\'s use alone', path.join('utilities', 'mineral-outlook.js'), 'spendGroups.filter((key) => !left.includes(key))', 'spendGroups', ['synthetic-flow-switches', 'ledger-no-model:fixture']],
  ['the page models the uses of a save that has a ledger', path.join('pages', 'mineral-outlook.vue'), 'if (this.hasLedger) {\n        return null\n      }\n\n      const { queueDemand, industrialProjects }', 'if (false) {\n        return null\n      }\n\n      const { queueDemand, industrialProjects }', ['ledger-no-model:fixture']],
  ['a modelled use is called observed', path.join('utilities', 'mineral-outlook.js'), 'known ? (hasLedger ? \'observed\' : \'modelled\') : \'missing\'', 'known ? \'observed\' : \'missing\'', ['synthetic-category-rows', 'fallback-modelled']],
  ['an NPR\'s colony away from its capital uses its own (empty) Sorium', path.join('utilities', 'legacy-consumption.js'), 'if (!colony.NPR || colony.Capital) {', 'if (true) {', ['synthetic-pool']],
  ['a shared stock is called as good as a measured one', path.join('utilities', 'legacy-consumption.js'), 'return pool.shared ? estimated(cut, SHARED_STOCK) : cut', 'return cut', ['synthetic-pool']],
  ['an NPR colony with no capital row uses its own stock', path.join('utilities', 'legacy-consumption.js'), 'shared: true } : null', 'shared: true } : { colony, shared: false }', ['synthetic-pool']],
  ['the NPR ordnance exception is not noted', path.join('utilities', 'legacy-consumption.js'), 'capacityKind(project.ProductionType) === \'ordnance\'', 'capacityKind(project.ProductionType) === \'none\'', ['synthetic-industry-basis']],
  ['the production modifier is ignored', path.join('utilities', 'legacy-consumption.js'), 'row && isNumber(row.OverallProductionModifier) ? row.OverallProductionModifier : null', 'row && isNumber(row.OverallProductionModifier) ? 1 : null', ['fuel-ledger:fixture']],
  ['a maintenance mineral takes ten times its tonnage', path.join('utilities', 'logistics.js'), '{ name: \'Uridium\', perMsp: 0.05 }', '{ name: \'Uridium\', perMsp: 0.5 }', ['msp-ledger:fixture']],
  ['maintenance is not held to the minerals at the colony', path.join('utilities', 'legacy-consumption.js'), 'const allowed = settled', 'const allowed = made.value', ['synthetic-msp-stock']],
  ['a mine on a deposit that holds the mineral is taken as an unlimited supply', path.join('utilities', 'legacy-consumption.js'), 'return { low, exact: low >= wanted || !mined,', 'return { low: mined ? Infinity : low, exact: true,', ['synthetic-msp-stock', 'synthetic-query-unread']],
  ['an uncertain mineral blocks a figure another mineral settles', path.join('utilities', 'legacy-consumption.js'), 'if (settled > lowest) {', 'if (supplies.some((supply) => !supply.exact && supply.low < made.value)) {', ['synthetic-msp-stock']],
  ['a tolerance settles a figure an uncertain mineral could still lower', path.join('utilities', 'legacy-consumption.js'), 'if (settled > lowest) {', 'if (settled - lowest > 1e-9 * Math.max(1, settled)) {', ['synthetic-msp-stock']],
  ['the mines of the other colonies that share a stock are ignored', path.join('utilities', 'legacy-consumption.js'), 'const mined = [...new Set([...members, stock])].some(mines)', 'const mined = mines(stock)', ['synthetic-msp-stock']],
  ['mines whose number is not recorded are taken as none', path.join('utilities', 'legacy-consumption.js'), '(!isNumber(member.Mines) || member.Mines > 0) &&', 'member.Mines > 0 &&', ['synthetic-msp-stock']],
  ['a deposit with none left still counts as a deposit of the mineral', path.join('utilities', 'legacy-consumption.js'), ' and FCT_MineralDeposit.Amount > 0 then 1', ' then 1', ['synthetic-query-unread']],
  ['a deposit with no recorded amount is not told from none', path.join('utilities', 'legacy-consumption.js'), ['const mines = (member) => (!isNumber(member.Mines) || member.Mines > 0) && [member[`Deposit', '{mineral.name}`], member[`DepositUnread', '{mineral.name}`]].some((amount) => !isNumber(amount) || amount > 0)'].join('$'), ['const mines = (member) => (!isNumber(member.Mines) || member.Mines > 0) && member[`Deposit', '{mineral.name}`] > 0'].join('$'), ['synthetic-msp-stock', 'synthetic-query-unread']],
  ['an installation amount that is not recorded counts as 0', path.join('utilities', 'legacy-consumption.js'), 'Unread > 0 then null else coalesce(', 'Unread > 0 then 0 else coalesce(', ['synthetic-query-unread']],
  ['an installation of a type the save does not define is dropped', path.join('utilities', 'legacy-consumption.js'), 'from FCT_PopulationInstallations left join DIM_PlanetaryInstallation', 'from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation', ['synthetic-query-unread']],
  ['a null amount of a type that adds nothing to a column makes that column unknown', path.join('utilities', 'legacy-consumption.js'), [' or (FCT_PopulationInstallations.Amount is null and DIM_PlanetaryInstallation.', '{value} <> 0)'].join('$'), ' or FCT_PopulationInstallations.Amount is null', ['synthetic-query-unread']],
  ['each colony of an NPR spends the whole capital stock on its own', path.join('utilities', 'legacy-consumption.js'), ['const key = colony.NPR ? `race ', '{colony.RaceID}` : `colony ', '{colony.PopulationID}`'].join('$'), ['const key = `colony ', '{colony.PopulationID}`'].join('$'), ['synthetic-pool-once']],
  ['an NPR\'s maintenance from a shared stock is not marked an estimate', path.join('utilities', 'legacy-consumption.js'), 'return away ? estimated(result, SHARED_STOCK) : result', 'return result', ['synthetic-msp-stock', 'synthetic-pool-once']],
]

const mutatedCopy = (file, from, to) => {
  refusePlanting(`${file}: ${from}`)

  const directory = createOwnedTemp('ae-legacy-mutant-')

  COPIED.forEach((entry) => {
    fs.mkdirSync(path.dirname(path.join(directory, entry)), { recursive: true })
    fs.cpSync(path.join(rendererDirectory, entry), path.join(directory, entry), { recursive: true })
  })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')

  if (source.split(from).length !== 2) {
    removeOwnedTemp(directory)
    throw new Error(`The mutation of ${file} does not apply exactly once: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

// The checks `only` names (every check when null) of one tree, run in a Node process of their own as [[id, true or what is wrong]]: the rule registry is module state, so a mutant's rules would stay for every tree run after it.
const checksInChild = async (tree, only) => {
  const { code, stdout, stderr } = await runChild(__filename, process.argv.slice(2), { env: { LEGACY_TREE: tree, LEGACY_ONLY: JSON.stringify(only) } })
  const line = stdout.split('\n').find((row) => row.startsWith(RESULT_PREFIX))

  if (code !== 0 || !line) {
    throw new Error(`The checks of ${tree} ended with ${code}: ${stderr.trim().slice(0, 400)}`)
  }

  return JSON.parse(line.slice(RESULT_PREFIX.length))
}

const runList = async (list, only) => {
  const results = []

  for (const { id, name, run } of list.filter((item) => !only || only.includes(item.id))) {
    let result

    try {
      result = await run()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([id, result, name])
  }

  return results
}

const tryMutation = async ([label, file, from, to, fails]) => {
  let directory

  try {
    directory = mutatedCopy(file, from, to)

    const results = await checksInChild(directory, fails)
    const survived = fails.filter((id) => !results.some(([name, result]) => name === id && result !== true && !isSkip(result)))
    const missing = fails.filter((id) => !results.some(([name]) => name === id))

    return [label, survived.length === 0 && missing.length === 0 ? true : `${missing.length ? `the checks ${missing.join(', ')} did not run; ` : ''}${survived.length ? `does not break ${survived.join(', ')}` : ''}`, `fails: [${fails.join(', ')}]`]
  } catch (error) {
    return [label, error.message, '']
  } finally {
    if (directory) {
      removeOwnedTemp(directory)
    }
  }
}

const run = async () => {
  const saves = parseArguments(process.argv.slice(2))
  const unsupported = []

  if (process.env.LEGACY_TREE) {
    const { list, cleanup } = suite(process.env.LEGACY_TREE, saves, unsupported)

    try {
      const results = await runList(list, JSON.parse(process.env.LEGACY_ONLY))

      console.log(RESULT_PREFIX + JSON.stringify(results.map(([id, result]) => [id, result])))
    } finally {
      await cleanup()
    }

    process.exit(0)
  }

  const cache = createOwnedTemp('ae-legacy-cache-')

  process.env.LEGACY_CACHE = cache
  process.on('exit', () => removeOwnedTemp(cache))

  const { list, cleanup } = suite(rendererDirectory, saves, unsupported)

  // A mutation that names a check with no case here (a save is not there) cannot be caught by it, and is left out.
  const hasNoCase = (id) => id.includes(':') && saves.some((save) => save.key === id.split(':')[1] && !fs.existsSync(path.resolve(root, save.file)))
  const planting = mutating()
  const [runnable, left] = planting ? [MUTATIONS.filter(([, , , , fails]) => !fails.some(hasNoCase)), MUTATIONS.filter(([, , , , fails]) => fails.some(hasNoCase))] : [[], []]
  const named = [...new Set(runnable.flatMap(([, , , , fails]) => fails))]
  // The checks run here, the control and each mutation in a child of its own, all of them side by side; what they say is told in the order of a run one after another. A quick run has neither the control nor a mutation: the control repeats the checks run here.
  const finished = await inParallel(planting ? [null, 'control', ...runnable] : [null], async (item) => {
    if (item === null) {
      try {
        return await runList(list, null)
      } finally {
        await cleanup()
      }
    }

    return item === 'control' ? checksInChild(rendererDirectory, named) : tryMutation(item)
  })
  let skipped = 0

  finished.slice(0, planting ? 2 : 1).forEach((outcome) => {
    if (outcome instanceof Error) {
      throw outcome
    }
  })

  for (const [, result, name] of finished[0]) {
    if (isSkip(result)) {
      skipped++
      console.log(`SKIP  ${name}  [${result.skip}]`)
      unsupported.push(result.skip)
    } else {
      check(name, result)
    }
  }

  left.forEach(([label]) => unsupported.push(`mutation not run: "${label}" names a check with no case here`))

  for (const [label, result, detail] of finished.slice(2)) {
    check(`mutation caught: ${label}`, result, detail)
  }

  if (planting) {
    const control = finished[1].filter(([, result]) => result !== true && !isSkip(result)).map(([id]) => id)

    check('a fresh process on the unchanged sources passes every check the mutations name', control.length === 0 ? true : `fails ${control.join('; ')}`)
  }

  measured.forEach((text) => console.log(`MEASURED  ${text}`))
  unsupported.forEach((text) => console.log(`UNSUPPORTED  ${text}`))
  console.log(`\n${checks - failures} of ${checks} checks passed; ${skipped} skipped and ${unsupported.length} cases UNSUPPORTED (not counted)`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
