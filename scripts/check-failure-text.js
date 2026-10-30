/*
  Checks that a read that fails shows the player no table or column name: the text each screen takes from a failed database read is in words, whichever page, panel or status line shows it.

  bun scripts/check-failure-text.js [--no-mutations] [--part mutant:<N>|head]

  Each producer is run on a database that fails as SQLite does (a real message of a missing column, of a missing table and of an ambiguous column, taken from an in-memory database): the tracked reads of a page (utilities/load-tracking.js), the object loaders of the notes, the fleet stations, the recovery ledger, the desired routes and the milestones, the empire list, the freshness probe, the capability preflight, the body pickers of the notebook, the world tags and the fleet stations, the observation note of Survey Progress, the Game Log diagnostic, and the refused-save notice with its list of absent data. What each says must carry no `FCT_`, `DIM_` or `VIR_` name, no `Table.Column`, no column name in camel case and no SQLite code, and it must still say what is lacking.

  Each mutation puts the raw message back at one producer and must fail the check of that producer. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { loadModule, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const RENDERER = path.join(root, 'src', 'renderer')
const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

let failures = 0
let checks = 0

const check = (name, result) => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

// The error of a save whose schema is damaged: the text of a table is changed in the file, so that SQLite reads `malformed database schema (FCT_Broken) - near "TABLX": syntax error` when it opens the table.
const brokenSchemaError = () => {
  const file = path.join(require('os').tmpdir(), `ae-broken-${process.pid}-${Date.now()}.db`)
  const made = new Database(file)

  made.exec('create table FCT_Broken (a integer)')
  made.close()

  const bytes = fs.readFileSync(file)

  bytes.write('TABLX', bytes.indexOf('CREATE TABLE FCT_Broken') + 7)
  fs.writeFileSync(file, bytes)

  const database = new Database(file)

  try {
    database.query('select * from FCT_Broken').all()
  } catch (error) {
    return error
  } finally {
    database.close()
    fs.rmSync(file, { force: true })
  }

  throw new Error('The damaged save did not fail')
}

// The errors of SQLite as the database gives them: a missing column and an ambiguous one, and a missing table.
const sqliteErrors = () => {
  const database = new Database(':memory:')
  const attempt = (sql) => {
    try {
      database.query(sql).all()
    } catch (error) {
      return error
    }

    throw new Error(`The read did not fail: ${sql}`)
  }

  const broken = brokenSchemaError()

  database.exec('create table FCT_Ship (ShipID integer, RaceID integer); create table FCT_Fleet (FleetID integer, RaceID integer); create table Other (Id integer); create trigger Rule before update on Other begin select * from FCT_Ship join Other using (RaceID); end; create view Joined as select * from FCT_Ship join Other using (RaceID);')

  const errors = { column: attempt('select FCT_Ship.CurrentCrew from FCT_Ship'), table: attempt('select 1 from FCT_Colony'), ambiguous: attempt('select RaceID from FCT_Ship join FCT_Fleet'), trigger: attempt('update Other set Id = 1'), joined: attempt('select * from Joined'), broken }

  database.close()

  return errors
}

const ERRORS = sqliteErrors()
// A name of a table or a column as the screen must never show it, or the code of a SQLite error.
const NAMED = /\b(?:FCT|DIM|VIR)_|\b[A-Za-z]+\.[A-Za-z]+\b|\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|SQLITE_|SQLITE/
const failing = (error) => ({ query: () => Promise.reject(error), close: () => {} })

// The text is in words: something is said, and no name of the save is in it.
const inWords = (text) => (typeof text !== 'string' || !text ? `says "${text}"` : NAMED.test(text) ? `says "${NAMED.exec(text)[0]}" in "${text}"` : true)

const FILES = {
  'utilities/load-tracking': 'utilities/load-tracking.js',
  'utilities/economy-notes': 'utilities/economy-notes.js',
  'utilities/fleet-stations': 'utilities/fleet-stations.js',
  'utilities/recovery-ledger': 'utilities/recovery-ledger.js',
  'utilities/route-desires': 'utilities/route-desires.js',
  'utilities/history-milestones': 'utilities/history-milestones.js',
  'utilities/log-diagnostics': 'utilities/log-diagnostics.js',
  'utilities/capabilities': 'utilities/capabilities.js',
  'store/empires': 'store/empires.js',
  'store/freshness': 'store/freshness.js',
  'store/capabilities': 'store/capabilities.js',
  'mixins/world-tags': 'mixins/world-tags.js',
  'pages/notebook': 'pages/notebook.vue',
  'pages/survey-progress': 'pages/survey-progress.vue',
  'pages/map': 'pages/map.vue',
  'components/fleets/FleetStations': 'components/fleets/FleetStations.vue',
  'components/page/UnsupportedSave': 'components/page/UnsupportedSave.vue',
  'components/log/ArchivePanel': 'components/log/ArchivePanel.vue',
  'utilities/provenance': 'utilities/provenance.js',
  'web-error': '../../scripts/web/shims/web-error.js',
  'utilities/database': 'utilities/database.js',
  'web-middleware': '../../scripts/web/database-middleware.js',
}

const textsOf = () => Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(path.join(RENDERER, file), 'utf8')]))

// The map page's packages and its theme, as stand-ins that draw nothing.
const MAP_STUBS = {
  vue: 'export default { observable: (value) => value }',
  cytoscape: 'const cytoscape = () => ({}); cytoscape.use = () => {}; export default cytoscape',
  'cytoscape-cxtmenu': 'export default {}',
  'cytoscape-fcose': 'export default {}',
  'cytoscape-cola': 'export default {}',
  'lodash/groupBy': 'export default () => ({})',
}
const MAP_MODULES = {
  'utilities/appearance': 'export const activeAppearance = () => ({})\nexport const MAP_MENU = { fillAlpha: 0.88, activeSlot: 2, activeAlpha: 0.9 }',
  'utilities/appearance-font': 'export const fontRoles = () => ({})\nexport const whenFontsReady = () => Promise.resolve()',
  'components/charts/theme': 'export const chartTheme = () => ({}); export const mapFont = () => ({}); export const markerPoints = () => null; export const seriesIdentity = () => null; export const withAlpha = (color) => color',
}

const load = (name, sources) => loadModule(name, { stubs: { ...STUBS, ...MAP_STUBS }, sources, modules: { '../../package.json': 'export const version = "0.0.0"', ...MAP_MODULES } })

// The statements of one run: [key, label, test], each test a function giving true or a text of what is wrong.
const statementsOf = async (sources) => {
  const statements = []
  const add = (key, label, test) => statements.push([key, label, test])
  const loaded = {}
  const get = async (name) => (loaded[name] = loaded[name] || (await load(name, sources)))
  const params = { GameID: 1, RaceID: 1 }
  const each = Object.entries(ERRORS)

  add('tracked', 'a tracked read that fails is kept in words', async () => {
    const { tracked } = await get('utilities/load-tracking')
    const problems = []

    for (const [kind, error] of each) {
      const host = { loadErrors: {}, $set: (target, key, value) => { target[key] = value } }

      await tracked('read', () => Promise.reject(error)).call(host).catch(() => {})

      const said = inWords(host.loadErrors.read)

      if (said !== true) {
        problems.push(`${kind}: ${said}`)
      }
    }

    return problems.length ? problems.join('; ') : true
  })

  const loaders = [
    ['notes', 'utilities/economy-notes', 'loadNoteObjects'],
    ['stations', 'utilities/fleet-stations', 'loadStationObjects'],
    ['recovery', 'utilities/recovery-ledger', 'loadRecoveryObjects'],
    ['desires', 'utilities/route-desires', 'loadDesireObjects'],
    ['milestones', 'utilities/history-milestones', 'loadObjects'],
  ]

  for (const [key, name, loader] of loaders) {
    add(key, `${name}: an object read that fails names what the save lacks in words`, async () => {
      const module = await get(name)
      const problems = []

      for (const [kind, error] of each) {
        const { failed } = await module[loader](failing(error), params)
        const texts = Object.values(failed)

        if (!texts.length) {
          problems.push(`${kind}: no failure is kept`)
        }

        texts.forEach((text) => {
          const said = inWords(text)

          if (said !== true) {
            problems.push(`${kind}: ${said}`)
          }
        })
      }

      return problems.length ? [...new Set(problems)].join('; ') : true
    })
  }

  add('wrapped-file', 'a file error that Sequelize wraps is shown as it is, by the empire list and by a tracked read', async () => {
    const { actions } = await get('store/empires')
    const { tracked } = await get('utilities/load-tracking')
    const { ConnectionError, DatabaseError } = require('sequelize')
    const text = "EACCES: permission denied, open 'P:/Saves/FCT_Fleet.db'"
    const file = Object.assign(new Error(text), { code: 'EACCES' })
    const problems = []
    const logged = console.error

    console.error = () => {}

    try {
      for (const [kind, error] of [['a connection error', new ConnectionError(file)], ['a database error', new DatabaseError(file)]]) {
        const committed = []

        await actions.load({ commit: (...args) => committed.push(args), dispatch: async () => true, state: { games: [] }, rootState: { database: failing(error) }, rootGetters: { config: { get: () => false } } })

        const host = { loadErrors: {}, $set: (target, key, value) => { target[key] = value } }

        await tracked('read', () => Promise.reject(error)).call(host).catch(() => {})

        if (!committed.length || committed[0][1] !== text) {
          problems.push(`${kind}: the list says "${committed.length ? committed[0][1] : 'nothing'}"`)
        }

        if (host.loadErrors.read !== text) {
          problems.push(`${kind}: the read says "${host.loadErrors.read}"`)
        }
      }
    } finally {
      console.error = logged
    }

    return problems.length ? problems.join('; ') : true
  })

  // The web mode carries an error over HTTP: the middleware answers with a body (`errorBody`) and the page's shim throws a new error from it (`webError`).
  add('web-transport', 'the web mode words a database error and keeps a file error, as the app does', async () => {
    const Module = require('module')
    const middleware = new Module(path.join(root, 'scripts', 'web', 'database-middleware.js'), module)

    middleware.filename = middleware.id
    middleware.paths = Module._nodeModulePaths(path.dirname(middleware.filename))
    middleware._compile(sources['web-middleware'], middleware.filename)

    const { webError } = await loadModule('web-error', { directory: path.join(root, 'scripts', 'web', 'shims'), sources: { 'web-error': sources['web-error'] } })
    const { failureWords } = await get('utilities/provenance')
    const { ConnectionError } = require('sequelize')
    const problems = []
    const logged = console.error
    const over = (error) => webError('/query', JSON.parse(JSON.stringify(middleware.exports.errorBody(error))))
    const file = Object.assign(new Error("EACCES: permission denied, open 'P:/Saves/FCT_Fleet.db'"), { code: 'EACCES' })

    console.error = () => {}

    try {
      for (const [kind, error] of each) {
        const said = inWords(failureWords(over(error)))

        if (said !== true) {
          problems.push(`${kind}: ${said}`)
        }
      }

      const sent = failureWords(over(new ConnectionError(file)))

      if (sent !== `[web] /query: ${file.message}`) {
        problems.push(`a file error says "${sent}"`)
      }

      const stored = failureWords('[web] /query: SQLITE_ERROR: cannot join using column RaceID - column not present in both tables')
      const said = inWords(stored)

      if (said !== true) {
        problems.push(`a reason kept from before: ${said}`)
      }
    } finally {
      console.error = logged
    }

    return problems.length ? problems.join('; ') : true
  })

  // A save that is full or locked: SQLite says so without a name, and the map's save shows it in words.
  add('map-save-full', 'the map: positions that cannot be saved because the disk is full or a table is locked say so', async () => {
    const options = (await get('pages/map')).default
    const logged = console.error
    const cases = [['SQLITE_FULL', 'database or disk is full', 'the save or its disk is full'], ['SQLITE_LOCKED', 'database table is locked', 'a table of the save is locked by a read that has not ended']]

    console.error = () => {}

    try {
      for (const [code, message, words] of cases) {
        const shown = []
        const failure = Object.assign(new Error(`${code}: ${message}`), { code })
        const database = { transaction: (work) => work(null), query: () => Promise.reject(failure) }
        const vm = instantiate(options, { $store: { getters: {}, state: {} }, database, GameID: 1, RaceID: 1, data: { movedIds: [7], graphPositions: () => ({ 7: { x: 5, y: 5 } }), activateSnackbar: (snack) => shown.push(snack), saveDialog: true, systems: [] } })

        await vm.savePositions()

        if (shown.length !== 1 || shown[0].text !== `Couldn't save the positions: ${words}`) {
          return `${code} shows ${JSON.stringify(shown)}`
        }
      }
    } finally {
      console.error = logged
    }

    return true
  })

  // A read that the save does not answer in time: the notice carries no statement, which names tables and columns; the statement goes to the console.
  add('timeout', 'a read that the save does not answer in time is stopped without naming its statement, on the page and over the web', async () => {
    const Module = require('module')
    const { resetDatabase } = await loadModule('utilities/database', { stubs: { ...STUBS, ...MAP_STUBS, sequelize: `import { createRequire } from 'module'; const sequelize = createRequire(${JSON.stringify(`${root}/`)})('sequelize'); export const Model = sequelize.Model; export const Sequelize = sequelize.Sequelize; export default sequelize` }, sources: { 'utilities/database': sources['utilities/database'] } })
    const { tracked } = await get('utilities/load-tracking')
    const { failureWords } = await get('utilities/provenance')
    const { webError } = await loadModule('web-error', { directory: path.join(root, 'scripts', 'web', 'shims'), sources: { 'web-error': sources['web-error'] } })
    const middleware = new Module(path.join(root, 'scripts', 'web', 'database-middleware.js'), module)
    const file = path.join(require('os').tmpdir(), `ae-timeout-${process.pid}-${Date.now()}.db`)
    const made = new Database(file)

    made.exec('create table FCT_System (SystemID integer)')
    made.close()
    middleware.filename = middleware.id
    middleware.paths = Module._nodeModulePaths(path.dirname(middleware.filename))
    middleware._compile(sources['web-middleware'], middleware.filename)

    const timers = []
    const { setTimeout: realTimeout } = globalThis
    const logged = console.error
    const log = console.log
    const kept = []
    let database

    console.log = () => {}
    console.error = (...said) => kept.push(said.join(' '))
    globalThis.setTimeout = (callback, delay, ...rest) => (delay === 60000 ? timers.push(callback) : realTimeout(callback, delay, ...rest))

    try {
      database = resetDatabase(file)

      const host = { loadErrors: {}, $set: (target, key, value) => { target[key] = value } }
      const pending = tracked('systems', () => database.query('select FCT_System.SystemID from FCT_System')).call(host).catch((error) => error)

      timers[0]()

      const error = await pending
      const over = failureWords(webError('/query', JSON.parse(JSON.stringify(middleware.exports.errorBody(error)))))
      const said = [host.loadErrors.systems, over].map(inWords).find((result) => result !== true)

      if (/FCT_|select/i.test(`${host.loadErrors.systems} ${over}`)) {
        return `the notice says "${host.loadErrors.systems}" and over the web "${over}"`
      }

      if (!/took longer than 60 s/.test(String(host.loadErrors.systems))) {
        return `the notice says "${host.loadErrors.systems}"`
      }

      if (!kept.some((text) => /select FCT_System.SystemID from FCT_System/.test(text))) {
        return 'the statement is not on the console'
      }

      return said === undefined ? true : said
    } finally {
      globalThis.setTimeout = realTimeout
      console.error = logged
      console.log = log
      await database.close().catch(() => {})
      fs.rmSync(file, { force: true })
    }
  })

  add('empires', 'the empire list that cannot be read says so in words', async () => {
    const { actions } = await get('store/empires')
    const problems = []
    const logged = console.error

    console.error = () => {}

    try {
      for (const [kind, error] of each) {
        const committed = []

        await actions.load({ commit: (...args) => committed.push(args), dispatch: async () => true, state: { games: [] }, rootState: { database: failing(error) }, rootGetters: { config: { get: () => false } } })

        const said = committed.length === 1 && committed[0][0] === 'failed' ? inWords(committed[0][1]) : `commits ${JSON.stringify(committed)}`

        if (said !== true) {
          problems.push(`${kind}: ${said}`)
        }
      }
    } finally {
      console.error = logged
    }

    return problems.length ? problems.join('; ') : true
  })

  add('freshness', 'the probe of the save that fails says so in words', async () => {
    const { actions } = await get('store/freshness')
    const problems = []

    for (const [kind, error] of each) {
      const committed = []

      await actions.probe({ commit: (...args) => committed.push(args), state: { generation: 1 }, rootState: { database: failing(error) } })

      const said = committed.length === 1 && committed[0][0] === 'refreshFailed' ? inWords(committed[0][1].message) : `commits ${JSON.stringify(committed)}`

      if (said !== true) {
        problems.push(`${kind}: ${said}`)
      }
    }

    return problems.length ? problems.join('; ') : true
  })

  add('preflight', 'the capability check of the save that fails says so in words', async () => {
    const { actions } = await get('store/capabilities')
    const problems = []
    const logged = console.error

    console.error = () => {}

    try {
      for (const [kind, error] of each) {
        const committed = []
        const database = failing(error)

        await actions.retry({ commit: (...args) => committed.push(args), rootState: { database, freshness: { generation: 1 } } })

        const failed = committed.find(([mutation]) => mutation === 'failed')
        const said = failed ? inWords(failed[1].message) : `commits ${JSON.stringify(committed.map(([mutation]) => mutation))}`

        if (said !== true) {
          problems.push(`${kind}: ${said}`)
        }
      }
    } finally {
      console.error = logged
    }

    return problems.length ? problems.join('; ') : true
  })

  const pickers = [
    ['world-tags', 'the world tags', 'mixins/world-tags', 'tagBodiesRead', { tagBodyIds: [], tagSystemId: 1 }],
    ['notebook', 'the notebook', 'pages/notebook', 'bodiesRead', { bodyIds: [], pickedSystemId: 1 }],
  ]

  for (const [key, label, name, read, data] of pickers) {
    add(key, `${label}: a body read that fails keeps its error in words`, async () => {
      const options = (await get(name)).default
      const problems = []

      for (const [kind, error] of each) {
        const vm = instantiate(options, { $store: { getters: {}, state: {} }, database: failing(error), GameID: 1, RaceID: 1, data })
        const bundle = await vm.runAsync(read)
        const said = bundle && bundle.bodies === null ? inWords(bundle.error) : `reads ${JSON.stringify(bundle && bundle.bodies)}`

        if (said !== true) {
          problems.push(`${kind}: ${said}`)
        }
      }

      return problems.length ? problems.join('; ') : true
    })
  }

  add('stations-picker', 'the fleet stations: a body picker that fails says so in words', async () => {
    const options = (await get('components/fleets/FleetStations')).default
    const problems = []

    for (const [kind, error] of each) {
      const vm = instantiate(options, { $store: { getters: {}, state: {} }, database: failing(error), GameID: 1, RaceID: 1, data: { gameId: 1, raceId: 1, database: failing(error) } })

      await vm.loadPicker(1)

      const said = inWords(vm.pickerError)

      if (said !== true) {
        problems.push(`${kind}: ${said}`)
      }
    }

    return problems.length ? problems.join('; ') : true
  })

  add('observation-note', 'Survey Progress: an open save that cannot be read for the observation says so in words', async () => {
    const options = (await get('pages/survey-progress')).default
    const problems = []

    for (const [kind, error] of each) {
      const vm = instantiate(options, { $store: { getters: {}, state: {} }, database: null, GameID: 1, RaceID: 1, data: { observationFile: { status: 'ok', record: null }, observationRead: { failed: error } } })
      const said = inWords(vm.observationNote)

      if (said !== true) {
        problems.push(`${kind}: ${said}`)
      }
    }

    return problems.length ? problems.join('; ') : true
  })

  add('log-diagnostic', 'the Game Log diagnostic of a log that cannot be read says so in words', async () => {
    const { diagnose } = await get('utilities/log-diagnostics')
    const problems = []

    for (const [kind, error] of each) {
      const said = inWords(diagnose({ capture: null, failed: error, archive: null, hidden: null, listed: null, GameTime: 1000 }, 86400).failed)

      if (said !== true) {
        problems.push(`${kind}: ${said}`)
      }
    }

    return problems.length ? problems.join('; ') : true
  })

  add('archive-failures', 'the Game Log archive: a failed capture stored before, with the raw message of the database, is listed in words', async () => {
    const options = (await get('components/log/ArchivePanel')).default
    const stored = each.map(([, error]) => ({ t: 100, at: 1, reason: `${error.code || 'SQLITE_ERROR'}: ${error.message}` }))
    const vm = instantiate(options, { $store: { getters: {}, state: {} }, data: { record: { failures: stored } } })
    const problems = vm.failures.map(({ reason }) => inWords(reason)).filter((said) => said !== true)

    return vm.failures.length === stored.length ? (problems.length ? problems.join('; ') : true) : `lists ${vm.failures.length} of ${stored.length} failures`
  })

  // The write of Save Positions on saves that cannot take it: the columns are not there, or a rule of the table refuses the value.
  add('map-save', 'the map: positions that cannot be saved say so in words', async () => {
    const options = (await get('pages/map')).default
    const logged = console.error
    const problems = []
    const saves = [
      ['a missing column', 'create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer);'],
      ['a rule of the table', 'create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer, Xcor integer check (Xcor < 100), Ycor integer); insert into FCT_RaceSysSurvey values (1, 1, 7, 5, 5);'],
      ['a missing table', 'create table Other (Id integer);'],
      ['two columns that must differ', 'create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer, Xcor integer, Ycor integer, unique (Xcor, Ycor)); insert into FCT_RaceSysSurvey values (1, 1, 2, 500, 500); insert into FCT_RaceSysSurvey values (1, 1, 7, 5, 5);'],
      ['a column the save computes', 'create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer, Xcor integer generated always as (1) virtual, Ycor integer); insert into FCT_RaceSysSurvey (GameID, RaceID, SystemID, Ycor) values (1, 1, 7, 5);'],
      ['a survey that is a view', 'create table Base (GameID integer, RaceID integer, SystemID integer, Xcor integer, Ycor integer); create view FCT_RaceSysSurvey as select * from Base;'],
      ['a trigger that joins on a column', 'create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer, Xcor integer, Ycor integer); create table Other (Id integer); insert into FCT_RaceSysSurvey values (1, 1, 7, 5, 5); create trigger Rule before update on FCT_RaceSysSurvey begin select * from FCT_RaceSysSurvey join Other using (RaceID); end;'],
      ['a link that does not match', 'create table FCT_System (SystemID integer, Name text); create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer, Xcor integer references FCT_System (SystemID), Ycor integer); insert into FCT_RaceSysSurvey values (1, 1, 7, null, 5); pragma foreign_keys = on;'],
    ]

    console.error = () => {}

    try {
      for (const [kind, schema] of saves) {
        const raw = new Database(':memory:')

        raw.exec(schema)

        const database = { transaction: (work) => work(null), query: async (sql) => [raw.query(sql).all()] }
        const shown = []
        const vm = instantiate(options, { $store: { getters: {}, state: {} }, database, GameID: 1, RaceID: 1, data: { movedIds: [7], graphPositions: () => ({ 7: { x: 500, y: 500 } }), activateSnackbar: (snack) => shown.push(snack), saveDialog: true, systems: [] } })

        await vm.savePositions()
        raw.close()

        const said = shown.length === 1 && shown[0].color === 'error' ? inWords(shown[0].text.replace("Couldn't save the positions: ", '')) : `shows ${JSON.stringify(shown)}`

        if (said !== true) {
          problems.push(`${kind}: ${said}`)
        }
      }
    } finally {
      console.error = logged
    }

    return problems.length ? problems.join('; ') : true
  })

  add('refused', 'a save that is refused says what it lacks in words', async () => {
    const { REFUSALS } = await get('utilities/capabilities')
    const options = (await get('components/page/UnsupportedSave')).default
    const problems = []

    for (const [reason, refusal] of Object.entries(REFUSALS)) {
      for (const [part, text] of Object.entries(refusal)) {
        const said = inWords(text)

        if (said !== true) {
          problems.push(`${reason} ${part}: ${said}`)
        }
      }
    }

    const vm = instantiate(options, { $store: { getters: {}, state: {} }, data: { line: { reason: 'pre-2.7', missing: ['FCT_Ship.ShippingLineID', 'FCT_Fleet.NoMovement'] }, status: 'ready' } })
    const listed = vm.missingWords

    if (!Array.isArray(listed) || listed.length !== 2) {
      problems.push(`lists ${JSON.stringify(listed)}`)
    } else {
      listed.forEach((text) => {
        const said = inWords(text)

        if (said !== true) {
          problems.push(`the list: ${said}`)
        }
      })
    }

    return problems.length ? problems.join('; ') : true
  })

  return statements
}

const MUTATIONS = [
  { name: 'a tracked read keeps the message of the database', file: 'utilities/load-tracking', find: 'settle(failureWords(error))', replace: 'settle((error && error.message) || String(error))', fails: ['tracked'] },
  { name: 'the notes keep the message of the database', file: 'utilities/economy-notes', find: 'failed[key] = failureWords(error)', replace: 'failed[key] = error.message', fails: ['notes'] },
  { name: 'the fleet stations keep the message of the database', file: 'utilities/fleet-stations', find: 'failed[key] = failureWords(error)', replace: 'failed[key] = error.message', fails: ['stations'] },
  { name: 'the recovery ledger keeps the message of the database', file: 'utilities/recovery-ledger', find: 'failed[type] = failureWords(error)', replace: 'failed[type] = error.message', fails: ['recovery'] },
  { name: 'the desired routes keep the message of the database', file: 'utilities/route-desires', find: 'failed.colony = failureWords(error)', replace: 'failed.colony = error.message', fails: ['desires'] },
  { name: 'the milestones keep the message of the database', file: 'utilities/history-milestones', find: 'failed[type] = failureWords(error)', replace: 'failed[type] = error.message', fails: ['milestones'] },
  { name: 'the empire list keeps the message of the database', file: 'store/empires', find: "commit('failed', failureWords(error))", replace: "commit('failed', error.message)", fails: ['empires'] },
  { name: 'the freshness probe keeps the message of the database', file: 'store/freshness', find: 'message: failureWords(error) })', replace: 'message: error.message })', fails: ['freshness'] },
  { name: 'the capability check keeps the message of the database', file: 'store/capabilities', find: "settle('failed', { message: failureWords(error) })", replace: "settle('failed', { message: error.message })", fails: ['preflight'] },
  { name: 'the world tags keep the message of the database', file: 'mixins/world-tags', find: 'bodies: null, error: failureWords(error)', replace: 'bodies: null, error: error.message', fails: ['world-tags'] },
  { name: 'the notebook keeps the message of the database', file: 'pages/notebook', find: 'bodies: null, error: failureWords(error)', replace: 'bodies: null, error: error.message', fails: ['notebook'] },
  { name: 'the fleet stations picker keeps the message of the database', file: 'components/fleets/FleetStations', find: 'this.pickerError = failureWords(error)', replace: 'this.pickerError = error.message', fails: ['stations-picker'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the observation note keeps the message of the database', file: 'pages/survey-progress', find: '(${failureWords(this.observationRead.failed)})', replace: '(${this.observationRead.failed.message})', fails: ['observation-note'] },
  { name: 'the Game Log diagnostic keeps the message of the database', file: 'utilities/log-diagnostics', find: 'failed: failed ? failureWords(failed) : null,', replace: 'failed: failed ? failed.message : null,', fails: ['log-diagnostic'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the web mode sends no code of the error', file: 'web-middleware', find: '...(code === undefined ? {} : { code })', replace: '...{}', fails: ['web-transport'] },
  { name: 'the web mode throws a new error without the code', file: 'web-error', find: 'if (body && body.code !== undefined && body.code !== null) {', replace: 'if (false) {', fails: ['web-transport'] },
  { name: 'a database error whose schema is damaged keeps the words of its inner message', file: 'utilities/provenance', find: 'const form = DATABASE_FORMS.find(([pattern]) => pattern.test(text))', replace: 'const form = DATABASE_FORMS.find(([pattern]) => pattern.test(text.replace(/^.* - /, "")))', fails: ['tracked', 'stations-picker'] },
  { name: 'a disk that is full is the unknown error of the database', file: 'utilities/provenance', find: "  [/^database or disk is full$/, () => 'the save or its disk is full'],\n", replace: '', fails: ['map-save-full'] },
  { name: 'a table that is locked is the unknown error of the database', file: 'utilities/provenance', find: "  [/^database table is locked$/, () => 'a table of the save is locked by a read that has not ended'],\n", replace: '', fails: ['map-save-full'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the notice of a read that took too long carries its statement', file: 'utilities/database', find: 'and the read was stopped`))', replace: 'and the read was stopped: ${String(sql)}`))', fails: ['timeout'] },
  { name: 'a file error that Sequelize wraps is worded as a database error', file: 'utilities/provenance', find: 'if (codesOf(error).some((code) => !/^SQLITE/.test(code))) {', replace: 'if (false) {', fails: ['wrapped-file'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'a database error of a form the app does not know keeps its message', file: 'utilities/provenance', find: 'return UNKNOWN_DATABASE_ERROR', replace: 'return text', fails: ['tracked', 'map-save', 'stations-picker'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the map reports a failed save of positions as the database worded it', file: 'pages/map', find: 'text: `Couldn\'t save the positions: ${failureWords(error)}`', replace: 'text: `Couldn\'t save the positions: ${error.message}`', fails: ['map-save'] },
  { name: 'the archive lists a stored failure as the database worded it', file: 'components/log/ArchivePanel', find: 'reason: failureWords(failure.reason) }', replace: 'reason: failure.reason }', fails: ['archive-failures'] },
  { name: 'the refusal of a file with no game table names the table', file: 'utilities/capabilities', find: "notice: 'The file has no game table, so it is not an Aurora save.'", replace: "notice: 'The file has no FCT_Game table, so it is not an Aurora save.'", fails: ['refused'] },
  { name: 'the refusal lists the absent columns as stored', file: 'components/page/UnsupportedSave', find: 'return this.line.missing.map(fieldWords)', replace: 'return this.line.missing', fails: ['refused'] },
]
const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

const run = async (sources, keys) => {
  const results = []

  for (const [key, label, test] of await statementsOf(sources)) {
    if (!keys || keys.includes(key)) {
      results.push([key, label, await test().catch((error) => `throws ${error.message}`)])
    }
  }

  return results
}

const checkHead = async () => {
  console.log('\nFailure text: what a read that fails says on screen, on a database that fails as SQLite does')

  for (const [, label, result] of await run(textsOf(), null)) {
    check(label, result)
  }
}

const checkMutant = async (mutant) => {
  const sources = textsOf()

  try {
    sources[mutant.file] = patched(FILES[mutant.file], sources[mutant.file], mutant.find, mutant.replace)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `invalid mutant: ${error.message}`)

    return
  }

  const results = await run(sources, mutant.fails)
  const missed = mutant.fails.filter((key) => !results.some(([name, , result]) => name === key && result !== true))

  check(`mutation caught: ${mutant.name}`, missed.length ? `these checks did not fail: ${missed.join(', ')}` : true)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--no-saves') {
      continue
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))

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
  const sections = await runSections(__filename, [{ args: ['--part', 'head'], weight: 10 }, ...wanted.map(({ id }) => ({ args: ['--part', id], weight: 3 }))])
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

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
