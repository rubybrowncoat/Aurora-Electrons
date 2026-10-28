/*
  Checks the Transport and Colonization Planner lines of the section flyout (src/renderer/utilities/peeks.js, with the store that keeps them, src/renderer/store/peeks.js).

  node scripts/check-peeks.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>] [--budget <ms>] [--laps <n>] [--no-mutations] [--only=<text>[|<text>...]]

  The synthetic checks need no save: they build a small database in memory with two games, several races, a shipping line, a ship that cannot move, a warship, classes with no recorded cargo or colonist capacity, and colonies and outposts of the race and of other races and games, among them two records on one body, outposts with no people, a body of a class and a body of a type the planner leaves out, and a colony in a system the race has not surveyed. They prove: the Transport line counts only the selected race's own ships that can move and carry cargo or colonists, in the selected game, with the capacity summed (hand-written lines for each race); a race with no such ship reads "No transport ships"; a capacity that is not recorded makes the line unknown (null), never 0; the Colonization line counts, as the planner's Colonies view does, the bodies of surveyed systems that hold a colony or outpost of the race (one body once however many records it has, an outpost with no people as one), and the surveyed systems that hold one, never a body of another race or game, one in a system the race has not surveyed, or one of a class or type the planner leaves out; a race that knows no system reads "No known systems"; a read that gives no row, or a figure that is null, leaves the line null; the lines read FCT_SystemBody only by primary key from the race's own population records (never a scan of it) and every statement they send is scoped by GameID and RaceID; a line shown again reuses the cached read (the underlying database sees no statement), the Galaxy Map line and the Colonization line share one read of the known systems, and a write to a table they read drops the kept read; and the store keeps a line until the database, game, race, history revision or separator changes, loads nothing a second time and leaves a failing peek's line null. A value is compared with its expectation part by part (an array item by item, an object key by key, whatever order its keys were added in), so the store's lines are compared route by route and the order the lines finish loading in cannot change a result; two controls force each order on a game change (the database sends one line's statements only once the store has set the other line) and must pass. Then each of the mutations below, one fault planted in a copy of the sources, must make at least one check fail, so that the checks cannot pass by checking nothing; a mutation that names a check counts only when that check fails by a wrong value, never by a throw. Exit code 1 when a check fails.

  With a save (by default the repository's modded save, AuroraDB.db game 140 race 784, and the stock 2.7.1 save in saves/, game 138 race 785; one that is not there is reported as not run) it also compares, for every race of the game, the Transport numbers with a direct reading of the same tables (the rows summed here in JavaScript, not by the peek's SQL), and the Colonization numbers with the planner's own `loadBodies` (colonised bodies, and the systems they are in, of the bodies whose `OwnPopulations` is not empty), for every race with a population record and the selected race; it checks that the race's figures are not the whole game's and that another game's data does not reach them, that the save holds outposts with no people (and reports bodies with several records), and measures the cold cost of each line (the median of --laps fresh connections, default 7, each timing the first statements of a connection; a median over the budget is measured again, up to three rounds, for the other work on the machine) against --budget (default 20 ms, the flyout's budget in docs/ARCHITECTURE.md), and the warm cost, which must reach the database not at all.

  The store holds off while the save is refused as a save of another Aurora line (store/capabilities.js `refused`): a refused copy loads no line, sends no statement and drops the lines of an earlier copy, and the lines load again once it is no longer refused (one synthetic check, and a mutation that leaves the hold out).

  The timings are wall time, so they run on a machine with no other heavy job (scripts/check-all.js runs this script after the others, alone, and the lane brief names it a run-alone suite); a run beside one fails the budget with medians several times the quiet ones (36 ms against 4.6 ms). Each timing therefore states, whether it passes or fails, the machine's condition over the time since the timings began (scripts/lib/machine-load.js): the share of all the processors that was busy, this check's own part of it and that of every other process. The condition is only reported, never used to skip or relax the budget.

  --no-mutations leaves the mutations out. --only=<text>[|<text>...] runs only the synthetic checks and the mutations whose names hold one of the texts, and reads no save: a focused run while working (the run that counts has neither).
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { watchLoad, loadShare, describeLoad, processorTimes } = require('./lib/machine-load')
const { routes: routeTable } = require('./lib/store-routes')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')
const MODULES = ['peeks', 'query-cache', 'math', 'minerals', '../store/peeks']
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/groupBy': 'export default (list, key) => list.reduce((groups, item) => { (groups[item[key]] = groups[item[key]] || []).push(item); return groups }, {})',
}

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

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Whether `actual` is `expected`: an array item by item, an object key by key (the same keys, each with an equal value, whatever order they were added in), anything else by its JSON text.
const equal = (actual, expected) => {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, index) => equal(item, expected[index]))
  }

  if (isRecord(actual) && isRecord(expected)) {
    const keys = Object.keys(expected)

    return Object.keys(actual).length === keys.length && keys.every((key) => Object.hasOwn(actual, key) && equal(actual[key], expected[key]))
  }

  return JSON.stringify(actual) === JSON.stringify(expected)
}

const same = (actual, expected) => (equal(actual, expected) ? true : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

// A database that answers raw reads like Sequelize's (a promise of [rows, metadata]) and keeps every statement that reached it in `log`.
const wrapDatabase = (raw) => {
  const log = []

  return {
    log,
    query: (sql) => new Promise((resolve, reject) => {
      log.push(sql)
      raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows, {}])))
    }),
    rows: (sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)))),
    close: () => new Promise((resolve) => raw.close(resolve)),
  }
}

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(wrapDatabase(raw))))
})

const SCHEMA = `
  create table FCT_ShipClass (ShipClassID integer primary key, CargoCapacity integer, ColonistCapacity integer, MaxSpeed integer);
  create table FCT_Fleet (FleetID integer primary key, GameID integer, RaceID integer, ShippingLine integer);
  create table FCT_Ship (ShipID integer primary key, GameID integer, RaceID integer, FleetID integer, ShipClassID integer);
  create table FCT_RaceSysSurvey (GameID integer, RaceID integer, SystemID integer);
  create table FCT_SystemBody (SystemBodyID integer primary key, GameID integer, SystemID integer, BodyClass integer, BodyTypeID integer);
  create table FCT_Population (PopulationID integer primary key, GameID integer, RaceID integer, SystemID integer, SystemBodyID integer, Population real);
`

// Game 1 has races 10 (the one asked about), 11, 12, 13 and 15; game 2 has race 10 too, under its own ids. Race 14 has nothing.
// Bodies are (id, game, system, class, type): body 10 is of a class and body 11 of a type the planner leaves out, body 12 is an asteroid.
// Race 10 (game 1) has records 1 and 2 on body 1, outposts with no people on bodies 2, 3 and 12, and records on bodies 6 (a system it has not surveyed), 7 (surveyed only in game 2), 10 and 11 (left out). Race 11 has records 10 and 11 on body 4, one on body 5 and one on body 13, in a system race 10 has surveyed.
const DATA = `
  insert into FCT_ShipClass values (1, 12500, 0, 100), (2, 0, 500, 100), (3, 5000, 0, 1), (4, 0, 0, 100), (5, null, 50, 100), (6, 5000, null, 100);
  insert into FCT_Fleet values (1, 1, 10, 0), (2, 1, 10, 1), (3, 1, 11, 0), (4, 2, 10, 0), (5, 1, 12, 0), (7, 1, 13, 1), (8, 1, 15, 0);
  insert into FCT_Ship values
    (1, 1, 10, 1, 1), (2, 1, 10, 1, 1), (3, 1, 10, 1, 2), (4, 1, 10, 1, 3), (5, 1, 10, 1, 4),
    (6, 1, 10, 2, 1), (7, 1, 10, 2, 1), (8, 1, 10, 2, 1),
    (9, 1, 11, 3, 1), (10, 1, 11, 3, 1), (11, 1, 11, 3, 1), (12, 1, 11, 3, 1),
    (13, 2, 10, 4, 1),
    (14, 1, 12, 5, 5),
    (15, 1, 13, 7, 1),
    (16, 1, 15, 8, 6);
  insert into FCT_RaceSysSurvey values (1, 10, 1), (1, 10, 2), (1, 10, 3), (1, 11, 1), (1, 11, 4), (1, 11, 5), (1, 11, 6), (1, 11, 7), (1, 11, 8), (2, 10, 9), (1, 12, 20);
  insert into FCT_SystemBody values (1, 1, 1, 1, 10), (2, 1, 1, 1, 10), (3, 1, 2, 1, 10), (4, 1, 4, 1, 10), (5, 1, 5, 1, 10), (6, 1, 8, 1, 10), (7, 1, 9, 1, 10), (8, 2, 9, 1, 10), (9, 2, 1, 1, 10), (10, 1, 3, 4, 10), (11, 1, 3, 1, 4), (12, 1, 3, 3, 10), (13, 1, 1, 1, 10);
  insert into FCT_Population values
    (1, 1, 10, 1, 1, 100), (2, 1, 10, 1, 1, 50), (3, 1, 10, 1, 2, 0), (4, 1, 10, 2, 3, 0), (5, 1, 10, 8, 6, 10), (6, 1, 10, 9, 7, 4), (7, 1, 10, 3, 10, 5), (8, 1, 10, 3, 11, 5), (9, 1, 10, 3, 12, 0),
    (10, 1, 11, 4, 4, 20), (11, 1, 11, 4, 4, 5), (12, 1, 11, 5, 5, 1), (13, 1, 11, 1, 13, 9),
    (14, 2, 10, 9, 8, 7), (15, 2, 10, 1, 9, 3);
`

const syntheticDatabase = () => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(':memory:')

  raw.exec(`${SCHEMA}${DATA}`, (error) => (error ? reject(error) : resolve(wrapDatabase(raw))))
})

const context = (database, GameID, RaceID, extra = {}) => ({ database, GameID, RaceID, separator: '\'', StartYear: 2000, historyRecorded: false, snapshotSummary: () => null, ...extra })

// A database whose every read gives `rows`.
const fixedDatabase = (rows) => ({ query: () => Promise.resolve([rows.map((item) => ({ ...item })), {}]) })

// The store's state, mutations and action driven the way Vuex would, over a database and the root state's moving parts. `finished` lists the routes of the lines the store set, in the order it set them, and `onSet(route)`, which a check may replace, runs after each. `dispatch` and `commit` answer as a namespaced module's do, by the table of calls (scripts/lib/store-routes.js): the module's own actions and mutations by their names with no options, and the root's `capabilities/preflight` only with `{ root: true }`; any other call is recorded as not accepted, not applied, and answered with undefined. `dispatched` and `committed` are the records; `rejected()` lists the calls not accepted.
const storeOver = (store) => {
  const state = store.state()
  const finished = []
  const driven = { onSet: () => {}, preflight: async () => {} }
  const dispatches = routeTable([...Object.keys(store.actions).map((type) => ({ type, root: false })), { type: 'capabilities/preflight', root: true }])
  const commits = routeTable(Object.keys(store.mutations).map((type) => ({ type, root: false })))
  const dispatch = (type, _payload, options) => {
    if (!dispatches.take(type, options)) {
      return undefined
    }

    return options ? driven.preflight() : Promise.resolve()
  }
  const commit = (name, payload, options) => {
    if (!commits.take(name, options)) {
      return
    }

    store.mutations[name](state, payload)

    if (name === 'set') {
      finished.push(payload.route)
      driven.onSet(payload.route)
    }
  }

  Object.assign(driven, { dispatched: dispatches.calls, committed: commits.calls, rejected: () => [...dispatches.rejected(), ...commits.rejected()], forgive: () => { dispatches.forgive(); commits.forgive() } })
  const separators = { value: 'Tick' }
  const rootState = { database: null, GameID: 1, RaceID: 10, StartYear: 2000, history: { revision: 0 } }
  const rootGetters = { config: { get: () => separators.value }, historyRecorded: false, 'history/snapshotSummary': () => null, 'capabilities/refused': false }

  return Object.assign(driven, {
    state,
    root: rootState,
    separators,
    finished,
    getters: rootGetters,
    visible: () => store.getters.visible(state, {}, rootState, rootGetters),
    dispatch,
    commit,
    load: (routes) => store.actions.load({ state, commit, dispatch, rootState, rootGetters }, routes),
  })
}

const ROUTES = ['/information', '/habitability']

// `database` with the order of the Transport and Colonization lines forced: once `hold()` is called, a statement of the line that is not `first` is sent only after `store` (of storeOver) has set the line of `first`. A statement belongs to the Transport line ('/information') when it reads FCT_Ship and to the Colonization line ('/habitability') otherwise.
const finishingFirst = (database, store, first) => {
  let held = null

  return {
    query: (sql) => (held && (/\bFCT_Ship\b/.test(sql) ? '/information' : '/habitability') !== first ? held.then(() => database.query(sql)) : database.query(sql)),
    hold: () => {
      held = new Promise((resolve) => {
        store.onSet = (route) => route === first && resolve()
      })
    },
  }
}

// How long a load with statements held back may take: the reads of the database in memory answer in milliseconds, so only a statement held back for good reaches it.
const HOLD_LIMIT_MS = 10000

// A statement may name FCT_SystemBody only to join it by primary key to the race's own population records.
const BODY_JOIN = /inner join FCT_SystemBody on FCT_SystemBody\.SystemBodyID = FCT_Population\.SystemBodyID/
const readsBodies = (sql) => /FCT_SystemBody/.test(sql)
const scansBodies = (sql) => /\bfrom\s+FCT_SystemBody\b/i.test(sql) || (readsBodies(sql) && !BODY_JOIN.test(sql))

// The checks that need no save, over the modules `m` ({ peeks, 'query-cache', math, minerals, '../store/peeks' }): [[name, async () => true or a message]]. Run on the real modules and again on each mutated copy, where one at least must fail.
const synthetic = (m) => {
  const all = []
  const add = (name, run) => all.push([name, run])
  const { peeks, transportTotals, settlementTotals } = m.peeks
  const line = async (route, GameID, RaceID, database, extra) => peeks[route](context(database, GameID, RaceID, extra))
  const withDatabase = (run) => async () => {
    const database = await syntheticDatabase()

    try {
      return await run(database)
    } finally {
      await database.close()
    }
  }

  add('Transport: race 10 has 3 ships that move and carry, 25 kt of cargo and 500 colonists', withDatabase(async (database) => same(await line('/information', 1, 10, database), '3 ships, 25 kt cargo, 500 colonists')))
  add('Transport: its numbers are 3 ships, 25,000 t and 500 colonists', withDatabase(async (database) => same(await transportTotals(database, { GameID: 1, RaceID: 10 }), { ships: 3, cargo: 25000, colonists: 500 })))
  add('Transport: race 11 has its own 4 ships and no colony bays, so no colonists are named', withDatabase(async (database) => same(await line('/information', 1, 11, database), '4 ships, 50 kt cargo')))
  add('Transport: the same race id in game 2 has only that game\'s one ship', withDatabase(async (database) => same(await line('/information', 2, 10, database), '1 ship, 12.5 kt cargo')))
  add('Transport: a race whose only ship sails for a shipping line, and a race with no ship, read "No transport ships"', withDatabase(async (database) => same([await line('/information', 1, 13, database), await line('/information', 1, 14, database)], ['No transport ships', 'No transport ships'])))
  add('Transport: a class with no recorded cargo capacity makes the line null, and the cargo of its totals null, not 0', withDatabase(async (database) => same([await line('/information', 1, 12, database), await transportTotals(database, { GameID: 1, RaceID: 12 })], [null, { ships: 1, cargo: null, colonists: 50 }])))
  add('Transport: a class with no recorded colonist capacity makes the line null, and the colonists of its totals null, not 0', withDatabase(async (database) => same([await line('/information', 1, 15, database), await transportTotals(database, { GameID: 1, RaceID: 15 })], [null, { ships: 1, cargo: 5000, colonists: null }])))
  add('Transport: the separator comes from the context', withDatabase(async (database) => {
    await database.rows('update FCT_ShipClass set ColonistCapacity = 1200 where ShipClassID = 2')

    return same(await line('/information', 1, 10, database, { separator: ',' }), '3 ships, 25 kt cargo, 1,200 colonists')
  }))
  add('Colonization: race 10 has 4 colonised bodies (one body with two records once, the outposts with no people, an asteroid) in 3 of 3 known systems, and not a body of an unsurveyed system, of a system surveyed only in game 2, of a class or a type the planner leaves out, or another race\'s or game\'s', withDatabase(async (database) => same([await line('/habitability', 1, 10, database), await settlementTotals(database, { GameID: 1, RaceID: 10 })], ['4 colonised bodies in 3 of 3 known systems', { known: 3, bodies: 4, settled: 3 }])))
  add('Colonization: race 11 has its own 3 colonised bodies (two records on one) in 3 of its 6 known systems', withDatabase(async (database) => same([await line('/habitability', 1, 11, database), await settlementTotals(database, { GameID: 1, RaceID: 11 })], ['3 colonised bodies in 3 of 6 known systems', { known: 6, bodies: 3, settled: 3 }])))
  add('Colonization: the same race id in game 2 counts only its own game: 1 colonised body in 1 of 1 known system', withDatabase(async (database) => same(await line('/habitability', 2, 10, database), '1 colonised body in 1 of 1 known system')))
  add('Colonization: a race that knows a system and has no colony reads 0 colonised bodies in 0 of 1 known system', withDatabase(async (database) => same(await line('/habitability', 1, 12, database), '0 colonised bodies in 0 of 1 known system')))
  add('Colonization: a race that knows no system reads "No known systems"', withDatabase(async (database) => same([await line('/habitability', 1, 13, database), await line('/habitability', 1, 14, database)], ['No known systems', 'No known systems'])))
  add('Colonization: the separator comes from the context', withDatabase(async (database) => {
    await database.rows('with recursive seq(id) as (select 1 union all select id + 1 from seq where id < 1500) insert into FCT_RaceSysSurvey select 1, 10, 100 + id from seq')

    return same(await line('/habitability', 1, 10, database, { separator: ',' }), '4 colonised bodies in 3 of 1,503 known systems')
  }))
  add('Unknown is not zero: no row, a null figure and a null known count each leave the lines null', async () => {
    const figures = { Ships: 2, Cargo: 100, Colonists: 0, Systems: 4, Bodies: 1, Settled: 1 }
    const shapes = [
      ['no row at all', [], null, null],
      ['every figure null', [{ Ships: null, Cargo: null, Colonists: null, Systems: null, Bodies: null, Settled: null }], null, null],
      ['the known systems null', [{ ...figures, Systems: null }], '2 ships, 100 t cargo', null],
      ['the cargo null', [{ ...figures, Cargo: null }], null, '1 colonised body in 1 of 4 known systems'],
      ['the colonists null', [{ ...figures, Colonists: null }], null, '1 colonised body in 1 of 4 known systems'],
      ['the colonised bodies null', [{ ...figures, Bodies: null }], '2 ships, 100 t cargo', null],
      ['the settled systems null', [{ ...figures, Settled: null }], '2 ships, 100 t cargo', null],
    ]
    const wrong = []

    for (const [name, rows, transport, settlement] of shapes) {
      const got = [await line('/information', 1, 10, fixedDatabase(rows)), await line('/habitability', 1, 10, fixedDatabase(rows))]

      if (JSON.stringify(got) !== JSON.stringify([transport, settlement])) {
        wrong.push(`${name}: ${JSON.stringify(got)}`)
      }
    }

    return wrong.length === 0 ? true : wrong.join('; ')
  })
  add('The lines read FCT_SystemBody only by primary key from the race\'s own population records, and every statement is scoped by GameID and RaceID', withDatabase(async (database) => {
    for (const route of ROUTES) {
      await line(route, 1, 10, database)
    }

    const unscoped = database.log.filter((sql) => !/GameID = 1\b/.test(sql) || !/RaceID = 10\b/.test(sql))

    return database.log.some(scansBodies) ? `a statement scans FCT_SystemBody: ${database.log.find(scansBodies).slice(0, 120)}` : database.log.length === 0 ? 'no statement was sent' : unscoped.length ? `not scoped: ${unscoped[0].slice(0, 120)}` : true
  }))
  add('A line shown again reuses the cached read: the database sees no statement', withDatabase(async (database) => {
    m['query-cache'].cacheQueries(database)

    for (const route of ROUTES) {
      await line(route, 1, 10, database)
    }

    const sent = database.log.length
    const again = await Promise.all(ROUTES.map((route) => line(route, 1, 10, database)))

    return sent > 0 && database.log.length === sent ? same(again, ['3 ships, 25 kt cargo, 500 colonists', '4 colonised bodies in 3 of 3 known systems']) : `${database.log.length - sent} statements on the second opening, ${sent} on the first`
  }))
  add('The Galaxy Map line and the Colonization line share one read of the known systems', withDatabase(async (database) => {
    m['query-cache'].cacheQueries(database)

    await line('/map', 1, 10, database)

    const afterMap = database.log.length

    await line('/habitability', 1, 10, database)

    const known = database.log.filter((sql) => /count\(\*\) as Systems from FCT_RaceSysSurvey/.test(sql))

    return known.length === 1 && database.log.length === afterMap + 1 ? true : `${known.length} reads of the known systems, ${database.log.length - afterMap} new statements after the map line`
  }))
  add('A write to a table a line reads drops the kept read, so the next line shows the new count', withDatabase(async (database) => {
    m['query-cache'].cacheQueries(database)

    const before = [await line('/habitability', 1, 10, database), await line('/information', 1, 10, database)]

    await database.query('delete from FCT_Population where PopulationID = 9')
    await database.query('delete from FCT_Ship where ShipID = 1')

    const after = [await line('/habitability', 1, 10, database), await line('/information', 1, 10, database)]

    return same([before, after], [['4 colonised bodies in 3 of 3 known systems', '3 ships, 25 kt cargo, 500 colonists'], ['3 colonised bodies in 2 of 3 known systems', '2 ships, 12.5 kt cargo, 500 colonists']])
  }))

  const gameTwo = { '/information': '1 ship, 12.5 kt cargo', '/habitability': '1 colonised body in 1 of 1 known system' }

  const storeChecks = [
    ['lines are kept: a second load of the same routes sends nothing', async (store, database) => {
      await store.load(ROUTES)

      const sent = database.log.length
      const lines = { ...store.state.lines }

      await store.load(ROUTES)

      return sent > 0 && database.log.length === sent ? same(lines, { '/information': '3 ships, 25 kt cargo, 500 colonists', '/habitability': '4 colonised bodies in 3 of 3 known systems' }) : `${database.log.length - sent} statements on the second load, ${sent} on the first`
    }],
    ['a race change loads the lines again, with the other race\'s figures', async (store) => {
      await store.load(ROUTES)
      store.root.RaceID = 11
      await store.load(ROUTES)

      return same(store.state.lines, { '/information': '4 ships, 50 kt cargo', '/habitability': '3 colonised bodies in 3 of 6 known systems' })
    }],
    ['a game change loads the lines again', async (store) => {
      await store.load(ROUTES)
      store.root.GameID = 2
      await store.load(ROUTES)

      return same(store.state.lines, gameTwo)
    }],
    // The controls of the order: the same game change with each line made to finish first, both of which must pass.
    ...ROUTES.map((first) => [`a game change loads the lines again with the ${first} line finishing first (the order forced through the database)`, async (store, database) => {
      const ordered = finishingFirst(database, store, first)

      store.root.database = ordered
      await store.load(ROUTES)
      store.root.GameID = 2
      ordered.hold()

      const before = store.finished.length
      let timer
      const loaded = await Promise.race([store.load(ROUTES).then(() => true), new Promise((resolve) => { timer = setTimeout(resolve, HOLD_LIMIT_MS, false) })])

      clearTimeout(timer)

      const order = store.finished.slice(before)

      return !loaded ? `the load did not end within ${HOLD_LIMIT_MS} ms with the other line's statements held back` : order[0] !== first ? `the lines finished in the order ${JSON.stringify(order)}, not with ${first} first` : same(store.state.lines, gameTwo)
    }]),
    ['a new database (a save that changed) loads the lines again', async (store) => {
      await store.load(ROUTES)

      const fresh = await syntheticDatabase()

      try {
        await fresh.rows('delete from FCT_Ship')
        store.root.database = fresh
        await store.load(ROUTES)

        return same(store.state.lines, { '/information': 'No transport ships', '/habitability': '4 colonised bodies in 3 of 3 known systems' })
      } finally {
        await fresh.close()
      }
    }],
    ['a recorded snapshot (the history revision) loads the lines again', async (store, database) => {
      await store.load(ROUTES)

      const sent = database.log.length

      store.root.history.revision += 1
      await store.load(ROUTES)

      return database.log.length > sent ? true : 'no statement after the revision changed'
    }],
    ['a refused save loads no line, sends no statement and drops the lines of an earlier copy, and the lines load again once it is no longer refused', async (store, database) => {
      await store.load(ROUTES)

      const loaded = Object.keys(store.state.lines).length
      const sent = database.log.length

      store.getters['capabilities/refused'] = true
      await store.load(ROUTES)

      const held = same([loaded, Object.keys(store.state.lines).length, store.state.key, database.log.length - sent], [ROUTES.length, 0, null, 0])

      store.getters['capabilities/refused'] = false
      await store.load(ROUTES)

      return held === true && Object.keys(store.state.lines).length === ROUTES.length ? true : `loaded ${loaded}, then lines ${Object.keys(store.state.lines).length}, key ${store.state.key}, statements ${database.log.length - sent}, then ${Object.keys(store.state.lines).length} (held: ${held})`
    }],
    ['the lines of the flyout are none once the copy is refused, though they were published before, and are those published again once it is not refused', async (store, database) => {
      await store.load(ROUTES)

      const published = store.visible()

      store.getters['capabilities/refused'] = true

      const masked = store.visible()

      store.getters['capabilities/refused'] = false

      return same([Object.keys(published).sort(), masked, store.visible() === store.state.lines, database.log.length > 0], [[...ROUTES].sort(), {}, true, true])
    }],
    ['the section flyout takes its lines from the getter that hides them while the copy is refused, and not from the state', async () => {
      const layout = fs.readFileSync(path.join(rendererDirectory, 'layouts', 'default.vue'), 'utf8')
      const viaGetter = /\.\.\.mapGetters\('peeks', \{\s+peekLines: 'visible',\s+\}\)/.test(layout)
      const viaState = /mapState\('peeks'/.test(layout) || /:peeks="(?!peekLines")/.test(layout)

      return viaGetter && !viaState ? true : `getter ${viaGetter}, state or another source ${viaState}`
    }],
    ['a refusal that is known only after the capability check answers, while the lines wait for it, loads no line and sends no statement', async (store, database) => {
      let answer = () => {}

      store.preflight = () => new Promise((resolve) => { answer = resolve })

      const sent = database.log.length
      const pending = store.load(ROUTES)

      store.getters['capabilities/refused'] = true
      answer()
      await pending

      return same([Object.keys(store.state.lines).length, database.log.length - sent], [0, 0])
    }],
    ['a refusal that is known while a line is being read publishes none of the lines read', async (store, database) => {
      let open = null
      let started = null
      const gate = new Promise((resolve) => { open = resolve })
      const reading = new Promise((resolve) => { started = resolve })

      const slow = async (sql, options) => {
        started()
        await gate

        return database.query(sql, options)
      }

      store.root.database = { query: slow }

      const pending = store.load(ROUTES)

      await reading
      store.getters['capabilities/refused'] = true
      open()
      await pending

      return same(store.state.lines, {})
    }],
    ['the capability check is asked for through the root route, as a namespaced module reaches the capabilities module, and the call is accepted', async (store) => {
      await store.load(ROUTES)

      return same(store.dispatched, [{ type: 'capabilities/preflight', options: { root: true }, accepted: true }])
    }],
    ['the adapter of the store records and rejects, answering undefined, the capability check asked for without the root route, a name that is not an action, a prefixed name, a root call of an action it does not know or of one of the module\'s own, and accepts the routed one and the module\'s own', async (store) => {
      const calls = [['capabilities/preflight'], ['capabilities/preflight', null, {}], ['capabilities/preflight', null, { root: false }], ['capabilities/preflight', null, { root: true, extra: 1 }], ['capabilities/unknown', null, { root: true }], ['not-an-action'], ['peeks/capabilities/preflight'], ['peeks/capabilities/preflight', null, { root: true }], ['load', null, { root: true }], ['capabilities/preflight', null, { root: true }], ['load']]
      const answers = calls.map(([type, payload, options]) => store.dispatch(type, payload, options))
      const recorded = store.dispatched.map(({ type, options, accepted }) => [type, options, accepted])

      store.forgive()

      return same([answers.map((answer) => answer !== undefined), recorded.map(([, , accepted]) => accepted), recorded.slice(5, 7).map(([type]) => type), store.rejected()], [[false, false, false, false, false, false, false, false, false, true, true], [false, false, false, false, false, false, false, false, false, true, true], ['not-an-action', 'peeks/capabilities/preflight'], []])
    }],
    ['the adapter of the store applies a mutation of the module only by its own name and with no options, and records and applies none sent to the root, under another name or under a prefixed one', async (store) => {
      store.commit('reset', 'wrong-root', { root: true })
      store.commit('not-the-module/reset', 'wrong-namespace')
      store.commit('not-an-action', 'unknown')
      store.commit('peeks/reset', 'prefixed')

      const wrong = store.state.key
      const recorded = store.committed.map(({ type, accepted }) => [type, accepted])

      store.forgive()
      store.commit('reset', 'right')

      return same([wrong, store.state.key, recorded, store.rejected()], [null, 'right', [['reset', false], ['not-the-module/reset', false], ['not-an-action', false], ['peeks/reset', false]], []])
    }],
    ['the thousands separator setting loads the lines again with the new separator', async (store, database) => {
      await database.rows('update FCT_ShipClass set ColonistCapacity = 1200 where ShipClassID = 2')
      await store.load(['/information'])

      const first = store.state.lines['/information']

      store.separators.value = 'Comma'
      await store.load(['/information'])

      return same([first, store.state.lines['/information']], ['3 ships, 25 kt cargo, 1\'200 colonists', '3 ships, 25 kt cargo, 1,200 colonists'])
    }],
    ['a peek that fails leaves its line null and the load resolves', async (store) => {
      const warn = console.warn
      let warned = 0

      console.warn = () => { warned += 1 }

      try {
        store.root.database = { query: () => Promise.reject(new Error('no such table')) }
        await store.load(ROUTES)
      } finally {
        console.warn = warn
      }

      return same([store.state.lines['/information'], store.state.lines['/habitability'], warned], [null, null, 2])
    }],
  ]

  storeChecks.forEach(([name, run]) => add(`Store: ${name}`, withDatabase(async (database) => {
    const store = storeOver(m['../store/peeks'])

    store.root.database = database

    const result = await run(store, database)

    return result === true && store.rejected().length ? `the run made calls the store does not answer: ${JSON.stringify(store.rejected())}` : result
  })))

  return all
}

// A copy of the utilities and store folders in the temp folder in which `file` ('utilities/peeks.js') has `from` replaced by `to`.
const mutatedCopy = (file, from, to) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-peeks-mutant-'))

  ;['utilities', 'store'].forEach((folder) => fs.cpSync(path.join(rendererDirectory, folder), path.join(directory, folder), { recursive: true }))

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')

  if (source.split(from).length !== 2) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation of ${file} does not apply exactly once: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

/* eslint-disable no-template-curly-in-string */
// The source text the mutations replace: [label, file, from, to], each caught by at least one synthetic check, or [label, file, from, to, check] for one that counts only when the synthetic check named `check` fails by a wrong value, never by a throw.
const TRANSPORT_WHERE = 'where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Fleet.ShippingLine = 0 and FCT_ShipClass.MaxSpeed > 1 and (FCT_ShipClass.CargoCapacity > 0 or FCT_ShipClass.ColonistCapacity > 0)'
const SETTLEMENT = 'inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID}\n      where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_SystemBody.GameID = ${GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5) and FCT_SystemBody.BodyTypeID not in (0, 4, 5)'
const KNOWN = 'where FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}`)\n\n  return found ? found.Systems : null'

const MUTATIONS = [
  ['the Transport read leaves out the race of the ships', 'utilities/peeks.js', TRANSPORT_WHERE, TRANSPORT_WHERE.replace(' and FCT_Ship.RaceID = ${RaceID}', '')],
  ['the Transport read leaves out the game of the ships', 'utilities/peeks.js', TRANSPORT_WHERE, TRANSPORT_WHERE.replace('FCT_Ship.GameID = ${GameID} and ', '')],
  ['the Transport read counts a shipping line\'s ships', 'utilities/peeks.js', TRANSPORT_WHERE, TRANSPORT_WHERE.replace(' and FCT_Fleet.ShippingLine = 0', '')],
  ['the Transport read counts a ship that cannot move', 'utilities/peeks.js', TRANSPORT_WHERE, TRANSPORT_WHERE.replace(' and FCT_ShipClass.MaxSpeed > 1', '')],
  ['the Transport read counts ships with no hold and no colony bay', 'utilities/peeks.js', TRANSPORT_WHERE, TRANSPORT_WHERE.replace(' and (FCT_ShipClass.CargoCapacity > 0 or FCT_ShipClass.ColonistCapacity > 0)', '')],
  ['the Transport cargo of an unrecorded capacity is 0, not unknown', 'utilities/peeks.js', 'case when count(FCT_ShipClass.CargoCapacity) = count(*) then coalesce(sum(FCT_ShipClass.CargoCapacity), 0) else null end as Cargo', 'coalesce(sum(FCT_ShipClass.CargoCapacity), 0) as Cargo'],
  ['the Transport colonists of an unrecorded capacity are 0, not unknown', 'utilities/peeks.js', 'case when count(FCT_ShipClass.ColonistCapacity) = count(*) then coalesce(sum(FCT_ShipClass.ColonistCapacity), 0) else null end as Colonists', 'coalesce(sum(FCT_ShipClass.ColonistCapacity), 0) as Colonists'],
  ['the Transport line shows an unknown cargo as a line', 'utilities/peeks.js', '!isKnownNumber(totals.cargo) || ', ''],
  ['the Transport line shows no ships as "0 ships"', 'utilities/peeks.js', '    if (totals.ships === 0) {\n      return \'No transport ships\'\n    }\n\n', ''],
  ['the Colonization read counts the records, not the bodies that hold them', 'utilities/peeks.js', 'count(distinct FCT_Population.SystemBodyID) as Bodies', 'count(FCT_Population.SystemBodyID) as Bodies'],
  ['the Colonization read counts the records, not the systems that hold the bodies', 'utilities/peeks.js', 'count(distinct FCT_SystemBody.SystemID) as Settled', 'count(FCT_SystemBody.SystemID) as Settled'],
  ['the Colonization read counts only the records with people', 'utilities/peeks.js', SETTLEMENT, SETTLEMENT.replace('not in (0, 4, 5)', 'not in (0, 4, 5) and FCT_Population.Population > 0')],
  ['the Colonization read leaves out the race of the surveyed systems', 'utilities/peeks.js', SETTLEMENT, SETTLEMENT.replace('FCT_RaceSysSurvey.RaceID = ${RaceID} and ', '')],
  ['the Colonization read leaves out the game of the surveyed systems', 'utilities/peeks.js', SETTLEMENT, SETTLEMENT.replace(' and FCT_RaceSysSurvey.GameID = ${GameID}', '')],
  ['the Colonization read leaves out the game of the records and of the bodies', 'utilities/peeks.js', SETTLEMENT, SETTLEMENT.replace('FCT_Population.GameID = ${GameID} and ', '').replace(' and FCT_SystemBody.GameID = ${GameID}', '')],
  ['the Colonization read leaves out the race of the records', 'utilities/peeks.js', SETTLEMENT, SETTLEMENT.replace(' and FCT_Population.RaceID = ${RaceID}', '')],
  ['the Colonization read counts a body of a class the planner leaves out', 'utilities/peeks.js', SETTLEMENT, SETTLEMENT.replace(' and FCT_SystemBody.BodyClass in (1, 2, 3, 5)', '')],
  ['the Colonization read counts a body of a type the planner leaves out', 'utilities/peeks.js', SETTLEMENT, SETTLEMENT.replace(' and FCT_SystemBody.BodyTypeID not in (0, 4, 5)', '')],
  ['the Colonization read scans the system bodies', 'utilities/peeks.js', SETTLEMENT, SETTLEMENT.replace('where FCT_Population.GameID', 'where exists (select 1 from FCT_SystemBody) and FCT_Population.GameID')],
  ['the known systems are counted for every race', 'utilities/peeks.js', KNOWN, KNOWN.replace(' and FCT_RaceSysSurvey.RaceID = ${RaceID}', '')],
  ['the known systems are counted for every game', 'utilities/peeks.js', KNOWN, KNOWN.replace('FCT_RaceSysSurvey.GameID = ${GameID} and ', '')],
  ['the Colonization line shows an unknown known-system count', 'utilities/peeks.js', 'return found && isKnownNumber(known) ? {', 'return found ? {'],
  ['the Colonization line shows no known system as "0 colonised bodies in 0 of 0"', 'utilities/peeks.js', 'totals.known === 0 ? \'No known systems\' : ', ''],
  ['the Galaxy Map line stops sharing the known-systems read', 'utilities/peeks.js', 'const Systems = await knownSystems(database, GameID, RaceID)', 'const { Systems } = await row(database, `select count(*) as Systems from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID} and 1 = 1`)'],
  ['the store keeps a line whatever the route (it loads every time)', 'store/peeks.js', '!(route in state.lines) && ', ''],
  ['the store ignores the race', 'store/peeks.js', '${GameID}:${RaceID}:${rootState', '${GameID}:${rootState'],
  ['the store ignores the game', 'store/peeks.js', '${databaseId(database)}:${GameID}:', '${databaseId(database)}:'],
  ['the store ignores a new database', 'store/peeks.js', '`${databaseId(database)}:', '`'],
  ['the store ignores the history revision', 'store/peeks.js', '${rootState.history.revision}:${separator}', '${separator}'],
  ['the store ignores the separator', 'store/peeks.js', '${rootState.history.revision}:${separator}`', '${rootState.history.revision}`'],
  ['the store lets a failing peek reject the load', 'store/peeks.js', 'console.warn(`Menu line for ${route} failed`, error)', 'throw error'],
  ['the store drops one route\'s line (each line set replaces the lines before it)', 'store/peeks.js', 'state.lines = { ...state.lines, [route]: line }', 'state.lines = { [route]: line }', 'Store: a game change loads the lines again'],
  ['the store loads the lines of a refused save', 'store/peeks.js', 'if (rootGetters[\'capabilities/refused\']) {', 'if (false) {', 'Store: a refused save loads no line, sends no statement and drops the lines of an earlier copy, and the lines load again once it is no longer refused'],
  ['the store does not wait for the capability check', 'store/peeks.js', "await dispatch('capabilities/preflight', null, { root: true })", '', 'Store: a refusal that is known only after the capability check answers, while the lines wait for it, loads no line and sends no statement'],
  ['the store asks for the capability check without the root route', 'store/peeks.js', "dispatch('capabilities/preflight', null, { root: true })", "dispatch('capabilities/preflight')", 'Store: the capability check is asked for through the root route, as a namespaced module reaches the capabilities module, and the call is accepted'],
  ['the store publishes the lines read after the save is refused', 'store/peeks.js', "&& !rootGetters['capabilities/refused']) {\n          commit('set', { route, line })", ") {\n          commit('set', { route, line })", 'Store: a refusal that is known while a line is being read publishes none of the lines read'],
  ['the store shows the lines published before the copy was refused', 'store/peeks.js', "return rootGetters['capabilities/refused'] ? {} : state.lines", 'return state.lines', 'Store: the lines of the flyout are none once the copy is refused, though they were published before, and are those published again once it is not refused'],
]
/* eslint-enable no-template-curly-in-string */

// The synthetic checks over `modules` whose names `wanted` takes, each with its result: true, or what went wrong.
const runChecks = async (modules, wanted = () => true) => {
  const results = []

  for (const [name, run] of synthetic(modules).filter(([title]) => wanted(title))) {
    let result

    try {
      result = await run()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

const failedChecks = async (modules) => (await runChecks(modules)).filter(([, result]) => result !== true)

const parseArguments = (argv) => {
  const options = { modded: ['AuroraDB.db', 140, 784], stock: ['saves/AuroraDB_271_skoormit_saved.db', 138, 785], budget: 20, laps: 7, mutations: true, only: [] }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock' || argv[index] === '--modded') {
      options[argv[index].slice(2)] = [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]
      index += 3
    } else if (argv[index] === '--budget' || argv[index] === '--laps') {
      options[argv[index].slice(2)] = Number(argv[index + 1])
      index += 1
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index].startsWith('--only=')) {
      options.only = argv[index].slice('--only='.length).split('|').filter(Boolean)
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  if (!(options.budget > 0) || !Number.isInteger(options.laps) || options.laps < 1) {
    console.error('--budget needs a number of milliseconds above 0 and --laps a whole number of at least 1')
    process.exit(2)
  }

  return options
}

// What the Transport numbers are, worked out here from the rows of the same tables read apart and summed in JavaScript, for one race of one game.
const directTransport = async (database, GameID, RaceID) => {
  const ships = await database.rows(`select FCT_Ship.FleetID, FCT_Ship.ShipClassID from FCT_Ship where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID}`)
  const fleets = new Map((await database.rows(`select FCT_Fleet.FleetID, FCT_Fleet.ShippingLine from FCT_Fleet where FCT_Fleet.GameID = ${GameID} and FCT_Fleet.RaceID = ${RaceID}`)).map((fleet) => [fleet.FleetID, fleet.ShippingLine]))
  const classes = new Map((await database.rows('select FCT_ShipClass.ShipClassID, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ColonistCapacity, FCT_ShipClass.MaxSpeed from FCT_ShipClass')).map((shipClass) => [shipClass.ShipClassID, shipClass]))
  const carriers = ships.map((ship) => classes.get(ship.ShipClassID)).filter((shipClass, index) => fleets.has(ships[index].FleetID) && !fleets.get(ships[index].FleetID) && shipClass && shipClass.MaxSpeed > 1 && (shipClass.CargoCapacity > 0 || shipClass.ColonistCapacity > 0))
  const sum = (column) => (carriers.some((shipClass) => shipClass[column] === null || shipClass[column] === undefined) ? null : carriers.reduce((total, shipClass) => total + shipClass[column], 0))

  return { ships: carriers.length, cargo: sum('CargoCapacity'), colonists: sum('ColonistCapacity') }
}

// What the planner's own read says of the race's settled bodies: `loadBodies` gives each body of a surveyed system its own population records, and a body with any is settled (the Colonies view; `settled: colonies > 0`). `records` are those population records, `quiet` those with no people, `shared` the bodies with several.
const plannerSettlement = async (database, GameID, RaceID, loadBodies) => {
  const bodies = await loadBodies(database, { GameID, RaceID })
  const settled = bodies.filter((body) => body.OwnPopulations.length > 0)

  return {
    bodies: settled.length,
    settled: new Set(settled.map((body) => body.SystemID)).size,
    records: settled.reduce((total, body) => total + body.OwnPopulations.length, 0),
    quiet: settled.reduce((total, body) => total + body.OwnPopulations.filter((population) => !(population.Population > 0)).length, 0),
    shared: settled.filter((body) => body.OwnPopulations.length > 1).length,
  }
}

const timed = async (run) => {
  const start = process.hrtime.bigint()

  await run()

  return Number(process.hrtime.bigint() - start) / 1e6
}

const compareSave = async (label, [file, GameID, RaceID], m, planner) => {
  console.log(`\n${label} save: ${file} (game ${GameID}, race ${RaceID})`)

  const database = await openSave(file)

  if (!database) {
    console.log(`SKIP  ${file} is not there`)

    return
  }

  const { peeks, transportTotals, settlementTotals } = m.peeks
  const { separatedNumber } = m.math
  const { compact } = m.minerals
  const separator = '\''
  const counted = (count, one, many) => `${separatedNumber(count, separator)} ${count === 1 ? one : many}`
  const races = (await database.rows(`select FCT_Race.RaceID from FCT_Race where FCT_Race.GameID = ${GameID}`)).map((item) => item.RaceID)
  const withRecords = new Set((await database.rows(`select distinct FCT_Population.RaceID from FCT_Population where FCT_Population.GameID = ${GameID}`)).map((item) => item.RaceID))

  check(`${label}: the selected race is in the game`, races.includes(RaceID), `${races.length} races`)

  const lines = {}
  const wrong = { transport: [], transportLine: [], settlement: [], settlementLine: [] }
  let compared = 0

  for (const race of races) {
    const expected = { transport: await directTransport(database, GameID, race) }
    const transport = await transportTotals(database, { GameID, RaceID: race })
    const settlement = await settlementTotals(database, { GameID, RaceID: race })
    const transportLine = await peeks['/information'](context(database, GameID, race))
    const settlementLine = await peeks['/habitability'](context(database, GameID, race))
    const wantedTransport = expected.transport.cargo === null || expected.transport.colonists === null ? null : expected.transport.ships === 0 ? 'No transport ships' : [counted(expected.transport.ships, 'ship', 'ships'), expected.transport.cargo > 0 ? `${compact(expected.transport.cargo)} cargo` : null, expected.transport.colonists > 0 ? `${separatedNumber(expected.transport.colonists, separator)} colonists` : null].filter(Boolean).join(', ')

    lines[race] = { transport: transportLine, settlement: settlementLine, expected }

    if (same(transport, expected.transport) !== true) {
      wrong.transport.push(`race ${race}: ${JSON.stringify(transport)} against ${JSON.stringify(expected.transport)}`)
    }

    if (transportLine !== wantedTransport) {
      wrong.transportLine.push(`race ${race}: "${transportLine}" against "${wantedTransport}"`)
    }

    if (withRecords.has(race) || race === RaceID) {
      const planned = await plannerSettlement(database, GameID, race, planner.loadBodies)
      const wantedSettlement = settlement.known === 0 ? 'No known systems' : `${counted(planned.bodies, 'colonised body', 'colonised bodies')} in ${separatedNumber(planned.settled, separator)} of ${counted(settlement.known, 'known system', 'known systems')}`

      compared += 1
      lines[race].planner = planned

      if (settlement.bodies !== planned.bodies || settlement.settled !== planned.settled) {
        wrong.settlement.push(`race ${race}: ${settlement.bodies} bodies in ${settlement.settled} systems against the planner's ${planned.bodies} in ${planned.settled}`)
      }

      if (settlementLine !== wantedSettlement) {
        wrong.settlementLine.push(`race ${race}: "${settlementLine}" against "${wantedSettlement}"`)
      }
    } else if (settlement.bodies !== 0 || settlement.settled !== 0) {
      wrong.settlement.push(`race ${race} has no population record, yet ${settlement.bodies} bodies in ${settlement.settled} systems`)
    }
  }

  const subjectLines = lines[RaceID]
  const verdict = (problems) => (problems.length === 0 ? true : `${problems.length} races differ: ${problems.slice(0, 3).join('; ')}`)

  check(`${label}: for each of the ${races.length} races, the Transport totals equal the direct reading`, verdict(wrong.transport), `race ${RaceID}: ${JSON.stringify(subjectLines.expected.transport)}`)
  check(`${label}: for each race, the Transport line is written from those totals`, verdict(wrong.transportLine), `race ${RaceID}: "${subjectLines.transport}"`)
  check(`${label}: for each of the ${compared} races compared with the planner, the colonised bodies and the systems that hold them equal the planner's`, verdict(wrong.settlement), `race ${RaceID}: ${JSON.stringify(subjectLines.planner)}`)
  check(`${label}: for each of those races, the Colonization line is written from the planner's figures`, verdict(wrong.settlementLine), `race ${RaceID}: "${subjectLines.settlement}"`)

  const planned = subjectLines.planner

  check(`${label}: the selected race holds outposts with no people, which the planner counts as settled bodies, and the line counts them`, planned.quiet > 0 ? true : 'the race has no population record with no people, so the save does not show it', `${planned.records} records on ${planned.bodies} bodies, ${planned.quiet} with no people, ${planned.shared} bodies with several records`)

  const [total] = await database.rows(`select count(*) as Records from FCT_Population where FCT_Population.GameID = ${GameID}`)
  const [own] = await database.rows(`select count(*) as Records from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`)
  const [ships] = await database.rows(`select count(*) as Ships from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${GameID} and FCT_Fleet.ShippingLine = 0 and FCT_ShipClass.MaxSpeed > 1 and (FCT_ShipClass.CargoCapacity > 0 or FCT_ShipClass.ColonistCapacity > 0)`)
  const shipSum = races.reduce((total, race) => total + lines[race].expected.transport.ships, 0)

  check(`${label}: the races' transport ships add up to the game's, so no race counts another's`, same(shipSum, ships.Ships), `${ships.Ships} ships`)
  check(`${label}: the selected race's figures are its own, not the game's`, ships.Ships > lines[RaceID].expected.transport.ships || total.Records > own.Records ? true : 'the race holds every ship and population record of the game, so scoping is not shown here', `${lines[RaceID].expected.transport.ships} of ${ships.Ships} ships, ${own.Records} of ${total.Records} population records`)
  check(`${label}: the selected race has something to count`, lines[RaceID].expected.transport.ships > 0 && planned.bodies > 0)

  const [elsewhere] = (await database.rows('select distinct FCT_Game.GameID from FCT_Game')).map((item) => item.GameID).filter((id) => id !== GameID)

  if (elsewhere === undefined) {
    console.log(`SKIP  ${label}: the save holds one game only, so no other game's rows are tried`)
  } else {
    const other = [await peeks['/information'](context(database, elsewhere, RaceID)), await peeks['/habitability'](context(database, elsewhere, RaceID))]

    check(`${label}: the race asked about in game ${elsewhere}, which it does not belong to, reads nothing`, same(other, ['No transport ships', 'No known systems']))
  }

  const recorder = wrapDatabase({ all: (sql, done) => database.rows(sql).then((rows) => done(null, rows), done) })

  for (const route of ROUTES) {
    await peeks[route](context(recorder, GameID, RaceID))
  }

  const scoped = (sql) => new RegExp(`GameID = ${GameID}\\b`).test(sql) && new RegExp(`RaceID = ${RaceID}\\b`).test(sql)
  const bad = recorder.log.find((sql) => scansBodies(sql) || !scoped(sql))

  check(`${label}: the lines read FCT_SystemBody only by primary key from the race's own population records, and every statement is scoped by GameID and RaceID`, recorder.log.length > 0 && !bad ? true : bad, `${recorder.log.length} statements`)

  await database.close()
}

// The cold and warm cost of each line on the save, measured before the heavier reads of `compareSave` so that their garbage does not weigh on the timings. `load` is the window of the machine's condition (scripts/lib/machine-load.js) since the timings began, read as each line's cold laps end and reported with their result: a median over the budget with another heavy job running is that job's, not the code's.
const measureSave = async (label, [file, GameID, RaceID], options, m, load) => {
  const { peeks } = m.peeks

  if (!fs.existsSync(path.resolve(root, file))) {
    return
  }

  console.log(`\n${label} save: ${file}, cost of the lines`)

  for (const route of ROUTES) {
    let colds = []
    let rounds = 0

    // A median over the budget is measured again, up to three rounds, for the other work on the machine; the last round is the one reported.
    while (rounds < 3 && (rounds === 0 || median(colds) > options.budget)) {
      colds = []
      rounds += 1

      for (let lap = 0; lap < options.laps; lap++) {
        const fresh = await openSave(file)

        await fresh.rows('select 1')
        colds.push(await timed(() => peeks[route](context(fresh, GameID, RaceID))))
        await fresh.close()
      }
    }

    const condition = load.read().text

    const cached = await openSave(file)

    m['query-cache'].cacheQueries(cached)

    await cached.rows('select 1')

    const first = await timed(() => peeks[route](context(cached, GameID, RaceID)))
    const sent = cached.log.length
    const warms = []

    for (let lap = 0; lap < options.laps; lap++) {
      warms.push(await timed(() => peeks[route](context(cached, GameID, RaceID))))
    }

    check(`${label}: ${route} cold cost is within ${options.budget} ms`, median(colds) <= options.budget ? true : `median ${median(colds).toFixed(1)} ms in every one of ${rounds} rounds; ${condition}`, `cold median ${median(colds).toFixed(1)} ms, min ${Math.min(...colds).toFixed(1)}, max ${Math.max(...colds).toFixed(1)} over ${options.laps} fresh connections${rounds > 1 ? ` (round ${rounds}; the earlier rounds ran over the budget on a busy machine)` : ''}; first on one kept connection ${first.toFixed(1)} ms; warm median ${median(warms).toFixed(2)} ms; ${sent} statements, ${cached.log.length - sent} on the warm laps; ${condition}`)
    check(`${label}: ${route} shown again reaches the database not at all`, cached.log.length === sent ? true : `${cached.log.length - sent} statements on warm laps`)

    await cached.close()
  }
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))
  const selected = (name) => options.only.length === 0 || options.only.some((text) => name.includes(text))
  const modules = await loadUtilities(MODULES, { stubs: STUBS })

  for (const [name, result] of await runChecks(modules, selected)) {
    check(name, result)
  }

  // The machine-load report is itself a measurement, so it is checked on windows of known processor times (50% of the processors busy, 10% of them by this process) and on a real window in which this process spins.
  if (selected('machine load')) {
    const share = loadShare({ at: 1000, processors: 4, busy: 100, total: 400, own: 10 }, { at: 3000, processors: 4, busy: 300, total: 800, own: 50 })

    check('machine load: a window of known processor times gives its machine, own and other shares', same(share, { seconds: 2, processors: 4, machine: 50, own: 10, others: 40 }))
    check('machine load: the interrupt time is counted once on Windows, where kernel time holds it, and on its own elsewhere', same([processorTimes(Array(2).fill({ times: { user: 200, nice: 0, sys: 300, irq: 100, idle: 500 } }), 'win32'), processorTimes(Array(2).fill({ times: { user: 200, nice: 0, sys: 300, irq: 100, idle: 500 } }), 'linux')], [{ busy: 1000, total: 2000 }, { busy: 1200, total: 2200 }]))
    check('machine load: a window that tells the machine less busy than this process is never negative', same(loadShare({ at: 0, processors: 2, busy: 0, total: 0, own: 0 }, { at: 1000, processors: 2, busy: 10, total: 200, own: 30 }), { seconds: 1, processors: 2, machine: 5, own: 5, others: 0 }))
    check('machine load: a window with no processor time says so', loadShare({ at: 0, processors: 2, busy: 5, total: 50, own: 0 }, { at: 1, processors: 2, busy: 5, total: 50, own: 0 }) === null && describeLoad(null).includes('not readable'))
    check('machine load: the text names the figures of the window', ['50%', '2.0 s', '4 logical', '10%', '40%'].every((text) => describeLoad(share).includes(text)) ? true : describeLoad(share))

    const before = process.cpuUsage()
    const spinning = watchLoad()

    for (const until = Date.now() + 300; Date.now() < until;) {
      Math.sqrt(Math.random())
    }

    const spun = spinning.read().share
    const used = process.cpuUsage(before)

    // The expectation is this process's CPU time over the wall time of the window on every processor, which the report takes from the system's processor times instead.
    const expected = spun === null ? 0 : ((used.user + used.system) / 1000 / (spun.seconds * 1000 * spun.processors)) * 100

    check('machine load: a window in which this process spins reads it as its own', spun !== null && spun.own > 0 && Math.abs(spun.own - expected) <= 0.35 * expected + 1.5 && spun.machine >= spun.own && spun.others >= 0 && spun.machine <= 100 ? true : `${JSON.stringify(spun)}, expected own ${expected.toFixed(1)}%`)
  }

  const mutations = options.mutations ? MUTATIONS.filter(([label]) => selected(label)) : []

  for (const [label, file, from, to, named] of mutations) {
    let directory

    try {
      directory = mutatedCopy(file, from, to)

      const mutants = await loadUtilities(MODULES, { stubs: STUBS, directory: path.join(directory, 'utilities') })
      const failed = await failedChecks(mutants)
      const own = failed.find(([name]) => name === named)
      const caught = named ? Boolean(own) && !String(own[1]).startsWith('threw ') : failed.length > 0

      check(`mutation caught: ${label}`, caught ? true : named ? `${named} ${own ? own[1] : 'still passes'}` : 'every check still passes', `${failed.length} checks fail${own ? `; ${named}: ${own[1]}` : ''}`)
    } catch (error) {
      check(`mutation caught: ${label}`, error.message)
    } finally {
      if (directory) {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  }

  // A focused run (--only) reads no save: neither the comparisons nor the timings, which need a quiet machine.
  if (options.only.length === 0) {
    const planner = (await loadUtilities(['colonization-data'], { stubs: STUBS }))['colonization-data']

    const load = watchLoad()

    await measureSave('modded', options.modded, options, modules, load)
    await measureSave('stock', options.stock, options, modules, load)
    await compareSave('modded', options.modded, modules, planner)
    await compareSave('stock', options.stock, modules, planner)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
