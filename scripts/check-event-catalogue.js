/*
  Checks the Game Log's event catalogue and the interrupt mark it draws: every event type of the fixture's log and of the played save's log is named by its event table and drawn with an icon, a planted row of each type the line split or added is named from the save it is read from, and a type the open save flags in `DIM_EventType.PlayerInterrupt` carries (I) while one it does not flag carries none (src/renderer/utilities/event-icons.js, src/renderer/utilities/log-diagnostics.js `readInterruptTypes`, src/renderer/pages/log.vue).

  bun scripts/check-event-catalogue.js [--no-mutations]

  - names and icons: every event type of the fixture's log (saves/AuroraDB-310-spookyerol-migrated.db, game 141, race 784) and of the played save's log (saves/AuroraDB-320-fetterkrolle-1.db, game 161, race 909) is a row of the save's `DIM_EventType` with the description the export gives it (.github/exports/DIM_EventType.csv, the Aurora 3.2.0 export) and is drawn with an icon, read by SQL written here; the split events keep the icon of the type they split from;
  - planted rows: a copy of the played save with one log row of each type the line split or added (143, 211, 233, 373 to 382) is read by the page's own statement, so every row is named from the copy's own event table and drawn with the icon of its type;
  - interrupt mark: a type the copy flags carries the mark and a type it does not flag carries none, and the flag of a second opening of the copy, changed here, changes the mark, so the flags are read per opened save and never kept from the first; an event table that cannot be read marks no row;
  - the page: the list and the event dialog draw the mark under the gate, and the footer says what it means.
  Every planted fault (the icon of the neutral alien ship kept on the earlier type, the flags kept from the first save read, the gate or the read ignoring the flag) is credited only when the check named for it fails by an assertion of its own.
  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate, replacing } = require('./lib/page-loader')
const { plantedPatch } = require('./lib/mutant-source')
const { FIXTURE, PLAYED } = require('./lib/fixtures')
const { mutating, refusePlanting } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`
const rendererDirectory = path.join(root, 'src', 'renderer')

// What the page and the utilities it loads import from packages: the stores and the date library.
const STUBS = {
  'electron-store': 'export default class Config { get store () { return {} } set store (value) {} get path () { return \'\' } get (key, fallback) { return fallback } }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

// The types the line split or added, planted in a copy of the played save: the four alien-ship events, the two civilian mining colony events, the minerals and the ground survey the milestone names, and the nine rows the line added.
const PLANTED = Object.freeze([143, 211, 233, 373, 374, 375, 376, 377, 378, 379, 380, 381, 382])
const PLANTED_PREFIX = 'Event catalogue: '
const FIELDS = Object.freeze(['IncrementID', 'GameID', 'RaceID', 'SMOnly', 'Time', 'EventType', 'MessageText', 'SystemID', 'Xcor', 'Ycor', 'IDType', 'PopulationID'])
const PLANTED_INCREMENT = 999999

// The events the line split, every type each became, and the icon the release/2.7 branch drew for the one event (release/2.7 src/renderer/utilities/event-icons.js): the one alien ship became hostile, neutral, friendly and allied; the one civilian mining colony became the colony and its update; the one mineral exhausted became the mineral and all minerals. The line's IDs and names are held against `.github/exports/DIM_EventType.csv`, the icon against this table rather than the module's own mapping, so a mapping that does not keep the old icon fails here even when the module and its reader agree.
const SPLITS = Object.freeze([
  { old: { id: 233, name: 'New Alien Ship' }, icon: 'mdi-rocket', types: [[233, 'New Hostile Alien Ship'], [377, 'New Neutral Alien Ship'], [378, 'New Friendly Alien Ship'], [379, 'New Allied Alien Ship']] },
  { old: { id: 211, name: 'Civilian Mining Colony' }, icon: 'mdi-mine', types: [[211, 'Civilian Mining Colony'], [380, 'Mining Colony Update']] },
  { old: { id: 66, name: 'Mineral Exhausted' }, icon: 'mdi-diamond-outline', types: [[66, 'Mineral Exhausted'], [376, 'All Minerals Exhausted']] },
])

// The icon the release/2.7 branch drew for the ground survey the milestone names beside the splits (release/2.7 src/renderer/utilities/event-icons.js); its ID did not change, so it is no split group.
const KEPT_ICONS = Object.freeze({ 143: 'mdi-radar' })

// The statement that reads the flags, written out so the planted fault that keeps them from the first save names the source's own line.
const FLAGS_SQL = 'select DIM_EventType.EventTypeID from DIM_EventType where coalesce(DIM_EventType.PlayerInterrupt, 0) = 1'

// One CSV cell per column, a quoted cell kept whole (the export writes `"a,b"` for a value that holds a comma).
const cellsOf = (line) => {
  const cells = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < line.length; index++) {
    const character = line[index]

    if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      cells.push(cell)
      cell = ''
    } else {
      cell += character
    }
  }

  cells.push(cell)

  return cells
}

const EXPORT = new Map(fs.readFileSync(path.join(root, '.github', 'exports', 'DIM_EventType.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((line) => {
  const cells = cellsOf(line)

  return [Number(cells[0]), { name: cells[1].trim(), playerInterrupt: cells[5] === '1' }]
}))

const open = (file, mode) => new Promise((resolve, reject) => {
  const handle = new sqlite3.Database(file, mode, (error) => (error ? reject(error) : resolve(handle)))
})

const all = (handle, sql, params = []) => new Promise((resolve, reject) => handle.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))))

const run = (handle, sql, params = []) => new Promise((resolve, reject) => handle.run(sql, params, (error) => (error ? reject(error) : resolve())))

const close = (handle) => new Promise((resolve) => handle.close(resolve))

// The event types of one race's log, the rows it holds, and the save's own event table.
const catalogueOf = async (file, GameID, RaceID) => {
  const handle = await open(file, sqlite3.OPEN_READONLY)

  try {
    const rows = await all(handle, 'select count(*) as rows from FCT_GameLog as L where L.GameID = ? and L.RaceID = ?', [GameID, RaceID])
    const types = (await all(handle, 'select L.EventType as type from FCT_GameLog as L where L.GameID = ? and L.RaceID = ? group by L.EventType order by L.EventType', [GameID, RaceID])).map((row) => Number(row.type))
    const named = new Map((await all(handle, 'select EventTypeID, Description from DIM_EventType')).map((row) => [Number(row.EventTypeID), String(row.Description === null ? '' : row.Description).trim()]))

    return { rows: rows[0].rows, types, named }
  } finally {
    await close(handle)
  }
}

// The flags of the planted types, as the save's event table holds them.
const flagsOf = async (file) => {
  const handle = await open(file, sqlite3.OPEN_READONLY)

  try {
    return new Map((await all(handle, `select EventTypeID, PlayerInterrupt from DIM_EventType where EventTypeID in (${PLANTED.join(', ')})`)).map((row) => [Number(row.EventTypeID), row.PlayerInterrupt === 1]))
  } finally {
    await close(handle)
  }
}

const startYearOf = async (file) => {
  const handle = await open(file, sqlite3.OPEN_READONLY)

  try {
    return (await all(handle, 'select StartYear from FCT_Game where GameID = ?', [PLAYED.gameId]))[0].StartYear
  } finally {
    await close(handle)
  }
}

// The descriptions of the copy's own event table, by type.
const namesOf = async (file) => {
  const handle = await open(file, sqlite3.OPEN_READONLY)

  try {
    return new Map((await all(handle, 'select EventTypeID, Description from DIM_EventType')).map((row) => [Number(row.EventTypeID), String(row.Description === null ? '' : row.Description)]))
  } finally {
    await close(handle)
  }
}

// A copy of the played save with one log row of each planted type, newest first in the list: { folder, file, startYear }.
const makeSave = async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-event-catalogue-'))
  const file = path.join(folder, 'save.db')

  fs.copyFileSync(path.join(root, PLAYED.file), file)

  const handle = await open(file, sqlite3.OPEN_READWRITE)

  try {
    const tip = (await all(handle, 'select max(Time) as tip from FCT_GameLog where GameID = ?', [PLAYED.gameId]))[0].tip || 0

    for (const [index, type] of PLANTED.entries()) {
      const values = [PLANTED_INCREMENT, PLAYED.gameId, PLAYED.raceId, 0, Number(tip) + 1000 + index, type, `${PLANTED_PREFIX}${type}`, 0, 0, 0, 0, 0]

      await run(handle, `insert into FCT_GameLog (${FIELDS.join(', ')}) values (${FIELDS.map(() => '?').join(', ')})`, values)
    }
  } finally {
    await close(handle)
  }

  return { folder, file, startYear: await startYearOf(file) }
}

// The page's own read of the save, through a database that answers the statements it sends: the rows, the hidden types, the flags and the log's window.
const openPage = async (file, pageOptions, startYear) => {
  const handle = await open(file, sqlite3.OPEN_READONLY)
  const database = { query: async (sql) => [await all(handle, sql)] }
  const vm = instantiate(pageOptions, { $store: { getters: { StartYear: startYear }, state: {} }, database, GameID: PLAYED.gameId, RaceID: PLAYED.raceId })

  await vm.runAsync('logEvents')

  return { vm, close: () => close(handle) }
}

const plantedRows = (vm) => vm.logEvents.filter((row) => String(row.MessageText === null ? '' : row.MessageText).startsWith(PLANTED_PREFIX))

const rowOf = (rows, type) => rows.find((row) => Number(row.EventType) === type)

const CHECKS = [
  {
    name: 'every event type of the fixture\'s log is named by its event table and drawn with an icon',
    run: async ({ icons }) => {
      const { rows, types, named } = await catalogueOf(path.join(root, FIXTURE.file), FIXTURE.gameId, FIXTURE.raceId)

      assert.ok(rows > 0 && types.length > 0, 'the fixture\'s log holds no event')
      const unnamed = types.filter((type) => !named.get(type))
      const undrawn = types.filter((type) => !icons.EVENT_ICONS[type])
      const foreign = types.filter((type) => named.get(type) && named.get(type) !== (EXPORT.get(type) || {}).name)

      assert.deepEqual(unnamed, [], `the fixture's log holds types its event table does not name: ${unnamed.join(', ')}`)
      assert.deepEqual(undrawn, [], `the fixture's log holds types drawn with no icon: ${undrawn.join(', ')}`)
      assert.deepEqual(foreign, [], `the fixture's event table gives a type a name the export does not: ${foreign.map((type) => `${type} is ${named.get(type)}`).join(', ')}`)
    },
  },
  {
    name: 'every event type of the played save\'s log is named and drawn, Game Saved among them',
    run: async ({ icons }) => {
      const { rows, types, named } = await catalogueOf(path.join(root, PLAYED.file), PLAYED.gameId, PLAYED.raceId)

      assert.ok(rows > 0 && types.length > 0, 'the played save\'s log holds no event')
      assert.ok(types.includes(382), 'the played save\'s log holds no Game Saved row')
      const unnamed = types.filter((type) => !named.get(type))
      const undrawn = types.filter((type) => !icons.EVENT_ICONS[type])
      const foreign = types.filter((type) => named.get(type) && named.get(type) !== (EXPORT.get(type) || {}).name)

      assert.deepEqual(unnamed, [], `the played save's log holds types its event table does not name: ${unnamed.join(', ')}`)
      assert.deepEqual(undrawn, [], `the played save's log holds types drawn with no icon: ${undrawn.join(', ')}`)
      assert.deepEqual(foreign, [], `the played save's event table gives a type a name the export does not: ${foreign.map((type) => `${type} is ${named.get(type)}`).join(', ')}`)
    },
  },
  {
    name: 'the split events keep the icon of the event they split from',
    run: ({ icons }) => {
      SPLITS.forEach(({ old, icon, types }) => {
        assert.ok(types.length >= 2, `earlier type ${old.id} (${old.name}) became ${types.length} line type(s)`)

        types.forEach(([type, name]) => {
          assert.equal((EXPORT.get(type) || {}).name, name, `type ${type} is not ${name} in the line export`)
          assert.equal(icons.EVENT_ICONS[type], icon, `type ${type} (${name}) does not keep the ${icon} of earlier type ${old.id} (${old.name})`)
        })
      })

      assert.equal(icons.EVENT_ICONS[143], KEPT_ICONS[143], 'type 143 (Geo Survey Complete) does not keep the icon the release/2.7 branch drew for it')
    },
  },
  {
    name: 'a planted row of each split or added type is named from the open save and drawn with an icon',
    run: async ({ pageOptions, save }) => {
      const named = await namesOf(save.file)
      const opened = await openPage(save.file, pageOptions, save.startYear)

      try {
        const planted = plantedRows(opened.vm)

        assert.equal(planted.length, PLANTED.length, `the read left out rows: ${PLANTED.filter((type) => !rowOf(planted, type)).join(', ')}`)
        PLANTED.forEach((type) => {
          const row = rowOf(planted, type)

          assert.ok(row, `type ${type} is not in the read`)
          assert.equal(row.TypeName, named.get(type), `type ${type} is named ${row.TypeName}`)
          assert.ok(opened.vm.eventIcons[type], `type ${type} is drawn with no icon`)
        })
      } finally {
        await opened.close()
      }
    },
  },
  {
    name: 'a type the open save flags carries the mark and one it does not carries none',
    run: async ({ pageOptions, save }) => {
      const flags = await flagsOf(save.file)
      const opened = await openPage(save.file, pageOptions, save.startYear)

      try {
        const planted = plantedRows(opened.vm)
        const flagged = planted.filter((row) => flags.get(Number(row.EventType)))
        const unflagged = planted.filter((row) => !flags.get(Number(row.EventType)))

        assert.ok(flagged.length > 0 && unflagged.length > 0, 'the planted rows hold no pair of a flagged and an unflagged type')
        flagged.forEach((row) => assert.equal(opened.vm.isInterrupting(row), true, `type ${row.EventType} is flagged and carries no mark`))
        unflagged.forEach((row) => assert.equal(opened.vm.isInterrupting(row), false, `type ${row.EventType} is not flagged and carries a mark`))
      } finally {
        await opened.close()
      }
    },
  },
  {
    name: 'the mark follows the open save: a flag changed between two openings changes the mark',
    run: async ({ pageOptions, save }) => {
      const first = await openPage(save.file, pageOptions, save.startYear)

      try {
        const planted = plantedRows(first.vm)

        assert.equal(first.vm.isInterrupting(rowOf(planted, 380)), false, 'type 380 is not flagged and carries a mark')
        assert.equal(first.vm.isInterrupting(rowOf(planted, 376)), true, 'type 376 is flagged and carries no mark')
      } finally {
        await first.close()
      }

      const writer = await open(save.file, sqlite3.OPEN_READWRITE)

      try {
        await run(writer, 'update DIM_EventType set PlayerInterrupt = 0 where EventTypeID = 376')
        await run(writer, 'update DIM_EventType set PlayerInterrupt = 1 where EventTypeID = 380')
      } finally {
        await close(writer)
      }

      const flags = await flagsOf(save.file)

      assert.deepEqual([flags.get(376), flags.get(380)], [false, true], 'the copy\'s flags did not change')

      const second = await openPage(save.file, pageOptions, save.startYear)

      try {
        const planted = plantedRows(second.vm)

        assert.equal(second.vm.isInterrupting(rowOf(planted, 380)), true, 'a type the save now flags carries no mark')
        assert.equal(second.vm.isInterrupting(rowOf(planted, 376)), false, 'a type the save no longer flags still carries the mark')
      } finally {
        await second.close()
      }
    },
  },
  {
    name: 'an event table that cannot be read marks no row',
    run: async ({ pageOptions, save }) => {
      const handle = await open(save.file, sqlite3.OPEN_READONLY)
      const database = {
        query: async (sql) => {
          if (/PlayerInterrupt/.test(sql)) {
            throw new Error('no such column: PlayerInterrupt')
          }

          return [await all(handle, sql)]
        },
      }

      try {
        const vm = instantiate(pageOptions, { $store: { getters: { StartYear: save.startYear }, state: {} }, database, GameID: PLAYED.gameId, RaceID: PLAYED.raceId })

        await vm.runAsync('logEvents')
        assert.equal(vm.interruptTypes, null, 'an event table that could not be read is told from none')
        assert.ok(vm.logEvents.every((row) => !vm.isInterrupting(row)), 'a row is marked from an event table that could not be read')
      } finally {
        await close(handle)
      }
    },
  },
  {
    name: 'the list and the event dialog draw the mark under the gate, and the footer says what it is',
    run: () => {
      const source = fs.readFileSync(path.join(rendererDirectory, 'pages', 'log.vue'), 'utf8')
      const template = source.slice(0, source.indexOf('<script>'))

      assert.equal((template.match(/v-if="isInterrupting\([^)]*\)"/g) || []).length, 2, 'the mark is not drawn under the gate in the list and in the event dialog')
      assert.equal((template.match(/class="interrupt-mark"/g) || []).length, 2, 'the mark is drawn without its own element in the list and the event dialog')
      assert.equal((template.match(/>\(I\)<\/span>/g) || []).length, 2, 'the mark is not the game\'s own (I)')
      assert.ok(/A type the game flags as interrupting carries \(I\), read from the open save\./.test(template), 'the footer does not say what the mark means')
    },
  },
]

const MUTANTS = [
  {
    name: 'the icon of the neutral alien ship kept on the earlier type',
    utility: { file: 'event-icons.js', find: "  377: 'mdi-rocket', // New Neutral Alien Ship", replace: "  233: 'mdi-rocket', // New Neutral Alien Ship" },
    fails: ['a planted row of each split or added type'],
  },
  {
    name: 'the allied alien ship given a different icon than the one it split from',
    utility: { file: 'event-icons.js', find: "  379: 'mdi-rocket', // New Allied Alien Ship", replace: "  379: 'mdi-account-multiple', // New Allied Alien Ship" },
    fails: ['the split events keep the icon'],
  },
  {
    name: 'the interrupt flags kept from the first save read',
    utility: {
      file: 'log-diagnostics.js',
      find: `    const [rows] = await database.query('${FLAGS_SQL}')\n\n    return new Set(rows.map((row) => Number(row.EventTypeID)))`,
      replace: `    const [rows] = await (globalThis.__eventCatalogueFlags = globalThis.__eventCatalogueFlags || database.query('${FLAGS_SQL}'))\n\n    return new Set(rows.map((row) => Number(row.EventTypeID)))`,
    },
    fails: ['the mark follows the open save'],
  },
  {
    name: 'every type marked as interrupting',
    page: replacing('return !!this.interruptTypes && this.interruptTypes.has(Number(event.EventType))', 'return true'),
    fails: ['a type the open save flags carries the mark'],
  },
  {
    name: 'the interrupt read ignores the flag',
    utility: { file: 'log-diagnostics.js', find: ' where coalesce(DIM_EventType.PlayerInterrupt, 0) = 1', replace: '' },
    fails: ['a type the open save flags carries the mark'],
  },
]

// The page and the icons as the app ships them, or with one fault planted in a utility (`utility` { file, find, replace }) or in the page's script (`page`, a `replacing` of it).
const candidateOf = async ({ utility = null, page = null } = {}) => {
  const sources = {}

  if (utility) {
    refusePlanting(`${utility.file}: ${utility.find}`)

    const text = fs.readFileSync(path.join(rendererDirectory, 'utilities', utility.file), 'utf8')
    const mutated = plantedPatch(utility.file, text, utility.find, utility.replace)
    const name = utility.file.replace(/\.js$/, '')

    sources[`utilities/${name}`] = mutated
    sources[name] = mutated
  }

  if (page) {
    refusePlanting('the page\'s interrupt gate')
  }

  return {
    pageOptions: await loadPage('pages/log', { stubs: STUBS, sources, mutate: page }),
    icons: (await loadUtilities(['event-icons'], { sources }))['event-icons'],
  }
}

const failedOf = async (context) => {
  const failed = []

  for (const { name, run: body } of CHECKS) {
    try {
      await body(context)
    } catch (error) {
      failed.push({ name, error, message: error.message, valueFailure: kindOf(error) === 'assertion' && !isSubjectThrow(error) })
    }
  }

  return failed
}

const main = async () => {
  let passed = 0
  let total = 0

  const base = await candidateOf()
  const save = await makeSave()

  try {
    const failed = await failedOf({ ...base, save })

    total += CHECKS.length
    passed += CHECKS.length - failed.length
    failed.forEach(({ name, message }) => console.log(`FAIL ${name}\n     ${message.split('\n').join('\n     ')}`))
  } finally {
    fs.rmSync(save.folder, { recursive: true, force: true })
  }

  for (const mutant of mutating() ? MUTANTS : []) {
    total++

    const save = await makeSave()

    try {
      const candidate = await candidateOf(mutant)
      const failed = await failedOf({ ...candidate, save })
      const invalid = failed.find(({ valueFailure }) => !valueFailure)

      if (invalid) {
        throw invalid.error
      }

      const missing = mutant.fails.filter((start) => !failed.some((failure) => failure.valueFailure && failure.name.startsWith(start)))

      if (missing.length) {
        const said = failed.map((failure) => `${failure.name}: ${failure.message.split('\n')[0]}`).join(' | ') || 'no check failed'

        throw new Error(`the check does not fail: ${missing.join(', ')} (${said})`)
      }

      passed++
    } catch (error) {
      console.log(`FAIL mutant: ${mutant.name}\n     ${error.message}`)
    } finally {
      fs.rmSync(save.folder, { recursive: true, force: true })
    }
  }

  console.log(`${passed} of ${total} checks passed`)
  process.exitCode = passed === total ? 0 : 1
}

main()
