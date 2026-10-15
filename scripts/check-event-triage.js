/*
  Checks the Game Log's triage (src/renderer/utilities/event-triage.js and log-visit.js) against the DIM_EventType export (.github/exports/DIM_EventType.csv).

  node scripts/check-event-triage.js

  - categories: every type of the export is in exactly one category, every `AttackEvent` type is in Combat, no category lists a type the export lacks, and a type the export lacks falls into Other;
  - groups: the selector's groups come in the categories' order with Other last and present when the log holds no unknown type; a group is chosen or cleared as a whole;
  - presets: what a stored value must hold to be a preset, names, a preset's types keep every unknown type visible, keywords match any, as a case-insensitive substring, and no keyword matches everything;
  - visit: the Game Log's last look by branch (a number from before the branches is read through the ledger, a branch with no entry takes the lesser of its parent's look and the fork, an event is new when later than the look).
  - game-master-only events (`SMOnly`): the page's query, the archive list, the conflicts and the pins of the Game Log leave them out of every player-facing row and count, a row of one cannot be pinned, the Archive panel counts them without listing them, and the failed captures are listed newest first. Each gate is also planted out of the source, and the check that names it must fail.
  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const os = require('os')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate, replacing } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')

const rows = fs.readFileSync(path.resolve(__dirname, '..', '.github', 'exports', 'DIM_EventType.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((line) => line.split(','))
const EXPORT = rows.map(([id, , , , attack]) => ({ id: Number(id), attack: attack === '1' }))

const checks = []
const check = (name, run) => checks.push({ name, run })

check('every type of the export is in exactly one category', ({ triage }) => {
  const seen = new Map()

  triage.CATEGORIES.forEach((category) => category.types.forEach((type) => {
    assert.ok(!seen.has(type), `type ${type} is in ${seen.get(type)} and ${category.id}`)
    seen.set(type, category.id)
  }))
  EXPORT.forEach(({ id }) => assert.ok(seen.has(id), `type ${id} is in no category`))
  seen.forEach((_category, type) => assert.ok(EXPORT.some(({ id }) => id === type), `type ${type} is not in the export`))
})

check('every attack type is in Combat', ({ triage }) => {
  EXPORT.filter(({ attack }) => attack).forEach(({ id }) => assert.equal(triage.categoryOfType(id), 'combat', `type ${id}`))
})

check('a type the export lacks falls into Other', ({ triage }) => {
  assert.equal(triage.categoryOfType(9999), 'other')
  assert.equal(triage.categoryOfType(-1), 'other')
  assert.equal(triage.categoryOfType(12), 'combat')
})

check('groups keep the order and the fallback last, present when empty', ({ triage }) => {
  const groups = triage.groupTypes([{ value: 12, text: 'Targeting', count: 1 }, { value: 60, text: 'Research Completed', count: 2 }])

  assert.deepEqual(groups.map(({ id }) => id), [...triage.CATEGORIES.map(({ id }) => id), 'other'])
  assert.deepEqual(groups.find(({ id }) => id === 'other').types, [])
  assert.deepEqual(groups.find(({ id }) => id === 'combat').types.map(({ value }) => value), [12])

  const unknown = triage.groupTypes([{ value: 9999, text: 'Event type 9999', count: 1 }])

  assert.deepEqual(unknown.find(({ id }) => id === 'other').types.map(({ value }) => value), [9999])
})

check('a group is chosen or cleared as a whole', ({ triage }) => {
  assert.deepEqual(triage.toggledGroup([1, 2], [2, 3], true).sort(), [1, 2, 3])
  assert.deepEqual(triage.toggledGroup([1, 2, 3], [2, 3], false), [1])
})

check('presets read from a stored value drop what is not a preset', ({ triage }) => {
  const stored = [
    { id: 'a', name: ' Combat ', keywords: [' Hit ', 'hit', '', 3], types: [12, 12, 15] },
    { id: 'a', name: 'Duplicate id', keywords: [], types: null },
    { id: 'b', name: '', keywords: [], types: null },
    { id: 'c', name: 'Bad types', keywords: [], types: ['x'] },
    { id: 'd', name: 'All', keywords: [], types: null },
    null,
    'text',
  ]

  assert.deepEqual(triage.readPresets(stored), [{ id: 'a', name: 'Combat', keywords: ['Hit'], types: [12, 15] }, { id: 'd', name: 'All', keywords: [], types: null }])
  assert.deepEqual(triage.readPresets(undefined), [])
  assert.deepEqual(triage.readPresets({}), [])
})

check('preset names', ({ triage }) => {
  const presets = [{ id: 'a', name: 'Combat', keywords: [], types: null }]

  assert.ok(triage.nameProblem('', presets))
  assert.ok(triage.nameProblem(' combat ', presets))
  assert.equal(triage.nameProblem('combat', presets, 'a'), null)
  assert.equal(triage.nameProblem('Research', presets), null)
  assert.ok(triage.nameProblem('x'.repeat(61), presets))

  const saved = triage.withPreset(presets, { name: ' Research ', keywords: ['lab', 'Lab'], types: [60] })

  assert.equal(saved.length, 2)
  assert.deepEqual({ ...saved[1], id: null }, { id: null, name: 'Research', keywords: ['lab'], types: [60] })
  assert.equal(triage.withRenamedPreset(saved, 'a', 'Fights')[0].name, 'Fights')
  assert.deepEqual(triage.withoutPreset(saved, 'a').map(({ name }) => name), ['Research'])
})

check('a preset keeps the unknown types visible', ({ triage }) => {
  assert.equal(triage.presetTypes({ types: null }, [12, 9999]), null)
  assert.deepEqual(triage.presetTypes({ types: [60] }, [12, 60, 9999]).sort((a, b) => a - b), [60, 9999])
  assert.deepEqual(triage.presetTypes({ types: [60] }, [12, 60]), [60])
})

check('keywords match any, case-insensitively, as substrings, in memory', ({ triage }) => {
  const test = triage.keywordTest([' Hostile ', 'lab'])

  assert.ok(test('a hostile contact'))
  assert.ok(test('inactive laboratory'))
  assert.ok(!test('friendly contact'))
  assert.equal(triage.keywordTest([]), null)
  assert.equal(triage.keywordTest(['', '  ']), null)
  assert.ok(triage.keywordTest(["'; drop table fct_gamelog; --"])("an '; drop table fct_gamelog; -- message"))
})

check('a stored last look: a number from before the branches', ({ visit }) => {
  const ledger = new Map([[10, [10, 100, 20]], [11, [11, 120, 30]]])

  assert.deepEqual(visit.readLook(10, 'b', ledger, {}), { t: 120, converted: true })
  assert.deepEqual(visit.readLook(99, 'b', ledger, {}), { t: null, converted: false })
  assert.deepEqual(visit.readLook(10, 'b', null, {}), { t: null, converted: false, waiting: true })
})

check('a branch with an entry keeps it; one without takes the lesser of its parent and the fork', ({ visit }) => {
  const lineage = { main: { parent: null, t: null }, fork: { parent: 'main', t: 500 }, deep: { parent: 'fork', t: 300 }, loose: { parent: 'main', t: null } }
  const look = { main: { t: 800 }, fork: { t: 450 } }

  assert.deepEqual(visit.readLook(look, 'fork', null, lineage), { t: 450, converted: false })
  assert.deepEqual(visit.readLook({ main: { t: 800 } }, 'fork', null, lineage), { t: 500, converted: false })
  assert.deepEqual(visit.readLook({ main: { t: 400 } }, 'fork', null, lineage), { t: 400, converted: false })
  assert.deepEqual(visit.readLook(look, 'deep', null, lineage), { t: 300, converted: false })
  assert.deepEqual(visit.readLook({ main: { t: 800 } }, 'loose', null, lineage), { t: 800, converted: false })
  assert.deepEqual(visit.readLook({ main: { t: 800 } }, 'main', null, lineage), { t: 800, converted: false })
  assert.deepEqual(visit.readLook({}, 'fork', null, lineage), { t: null, converted: false })
  assert.deepEqual(visit.readLook(undefined, 'main', null, lineage), { t: null, converted: false })
  assert.deepEqual(visit.readLook({ fork: { t: 'x' } }, 'fork', null, lineage), { t: null, converted: false })
})

check('a walk through a loop in the lineage ends', ({ visit }) => {
  const lineage = { a: { parent: 'b', t: 5 }, b: { parent: 'a', t: 5 } }

  assert.deepEqual(visit.readLook({}, 'a', null, lineage), { t: null, converted: false })
})

check('the new mark compares the event time with the look', ({ visit }) => {
  assert.equal(visit.isNewEvent({ Time: 101 }, 100), true)
  assert.equal(visit.isNewEvent({ Time: 100 }, 100), false)
  assert.equal(visit.isNewEvent({ Time: 101 }, null), false)
})

check('the visit written is the save\'s newest increment, whatever was seen before', ({ visit }) => {
  const ledger = new Map([[10, [10, 100, 20]], [12, [12, 140, 30]], [11, [11, 120, 20]]])

  assert.equal(visit.newestEnd(ledger), 170)
  assert.equal(visit.newestEnd(new Map()), null)
  assert.equal(visit.newestEnd(null), null)
  assert.deepEqual(visit.withLook(5, 'b', 170), { b: { t: 170 } })
  assert.deepEqual(visit.withLook({ a: { t: 1 }, b: { t: 9 } }, 'b', 170), { a: { t: 1 }, b: { t: 170 } })
  assert.deepEqual(visit.withLook('junk', 'b', 170), { b: { t: 170 } })
})

// ---- Game-master-only events -------------------------------------------------------------------------------------------

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')
const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// What the utilities and the page import from packages: the stores and the date library the history utilities need.
const STUBS = {
  'electron-store': 'export default class Config { get store () { return {} } }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

// An event as the archive keeps it: [Time, EventType, MessageText, SystemID, PopulationID, Xcor, Ycor, IDType, SMOnly].
const fieldsOf = (message, SMOnly) => [105, 3, message, 0, 0, 0, 0, 0, SMOnly]

const RECORD = {
  increments: [[5, 100, 10, [[...fieldsOf('plain event', 0), 2], [...fieldsOf('secret event', 1), 3]]]],
  spans: [[100, 110]],
  captures: [],
  revision: 1,
  conflicts: [
    { at: 1, t: 110, increment: [5, 100, 10], reason: 'more', group: fieldsOf('plain conflict', 0), stored: 1, read: 2 },
    { at: 1, t: 110, increment: [5, 100, 10], reason: 'more', group: fieldsOf('secret conflict', 1), stored: 1, read: 2 },
    { at: 1, t: 110, increment: [5, 100, 10], reason: 'ledger' },
  ],
  failures: [{ at: 10, t: 120, reason: 'first failure' }, { at: 20, t: 130, reason: 'second failure' }],
}

const NAMES = { types: new Map(), colours: new Map(), systems: new Map(), colonies: new Map() }

// The utilities, the Archive panel and the page as the app ships them, or with one fault planted in a utility (`utility` { file, find, replace }), in the panel (`panel` { find, replace }) or in the page (`page`, a `replacing` of its script).
const loadGameMaster = async ({ utility = null, panel = null, page = null } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-event-triage-'))

  try {
    fs.cpSync(path.join(rendererDirectory, 'utilities'), path.join(directory, 'utilities'), { recursive: true })
    fs.cpSync(path.join(rendererDirectory, 'mixins'), path.join(directory, 'mixins'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'pages'))
    fs.copyFileSync(path.join(rendererDirectory, 'pages', 'log.vue'), path.join(directory, 'pages', 'log.vue'))

    if (utility) {
      const file = path.join(directory, 'utilities', utility.file)

      fs.writeFileSync(file, patched(utility.file, fs.readFileSync(file, 'utf8'), utility.find, utility.replace))
    }

    const panelFile = path.join(rendererDirectory, 'components', 'log', 'ArchivePanel.vue')
    const original = fs.readFileSync(panelFile, 'utf8').replace(/\r\n/g, '\n').replace(/from '\.\.\/\.\.\//g, "from '../")
    const source = panel ? patched('ArchivePanel.vue', original, panel.find, panel.replace) : original

    fs.writeFileSync(path.join(directory, 'pages', 'Panel.vue'), source)

    const { 'log-archive-view': view, 'event-pins': pins } = await loadUtilities(['log-archive-view', 'event-pins'], { stubs: STUBS, directory: path.join(directory, 'utilities') })

    return {
      view,
      pins,
      panelSource: source,
      panelOptions: await loadPage('pages/Panel', { directory, stubs: STUBS }),
      pageOptions: await loadPage('pages/log', { directory, stubs: STUBS, mutate: page }),
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const pinOf = (id, SMOnly) => ({ id, branch: 'b1', from: 'b1', at: 1, increment: [5, 100, 10], fields: fieldsOf(`pin ${id}`, SMOnly), count: 1, names: {}, note: '' })

const rowOf = (SMOnly) => ({ IncrementID: 5, Time: 105, EventType: 3, MessageText: 'row', SystemID: 0, PopulationID: 0, Xcor: 0, Ycor: 0, IDType: 0, SMOnly, archived: true, increment: [5, 100, 10], copies: 1, TypeName: 'Type' })

const pageOn = (m, { saved = [], database = null, data = {}, stored = undefined } = {}) => instantiate(m.pageOptions, {
  $store: { getters: { StartYear: 2000, config: { get: () => stored, set: (key, value) => saved.push([key, value]) } }, state: {} },
  database,
  GameID: 1,
  RaceID: 2,
  data: { pinStore: { key: 'k', store: { version: 1, seeded: {}, pins: [pinOf('a', 0), pinOf('b', 1)] } }, branchId: 'b1', logEvents: [], logWindow: { first: [1, 0, 1], ledger: new Map([[5, [5, 100, 10]]]) }, pinsKey: 'k', pinMessage: '', ...data },
})

const panelOn = (m, record) => instantiate(m.panelOptions, { $store: { getters: {}, state: {} }, data: { ...Object.fromEntries(['status', 'reason', 'cap', 'startYear', 'source'].map((name) => [name, undefined])), record, startYear: 2000 } })

const gameMasterChecks = [
  ['the live query leaves out game-master-only events', async (m) => {
    const queries = []
    const vm = pageOn(m, { database: { query: async (sql) => { queries.push(sql); return [[]] } } })

    await vm.runAsync('logEvents')
    assert.ok(queries.some((sql) => /from FCT_GameLog/.test(sql) && /coalesce\(L\.SMOnly, 0\) = 0/.test(sql)), 'the query of the log does not filter SMOnly')
  }],
  ['the archive list leaves out game-master-only events', (m) => {
    const messages = m.view.archiveEvents(RECORD, NAMES, 2000).map((row) => row.MessageText)

    assert.deepEqual([...new Set(messages)], ['plain event'])
    assert.equal(messages.length, 2, 'the identical rows of the event listed are each a row')
  }],
  ['the conflicts leave out those that quote a game-master-only event, in the list and in every count', (m) => {
    const vm = panelOn(m, RECORD)

    assert.equal(vm.shownConflicts.length, 2)
    assert.equal(vm.conflicts.length, 2)
    assert.ok(!vm.conflicts.some((conflict) => conflict.group && conflict.group[2].includes('secret')), 'a conflict quotes a game-master-only event')
    assert.equal(vm.hiddenConflicts, 1)
    assert.ok(!/record\.conflicts/.test(m.panelSource.slice(0, m.panelSource.indexOf('<script>'))), 'the template counts the conflicts of the record, not the listed ones')
  }],
  ['the panel counts game-master-only events without listing them', (m) => {
    assert.equal(panelOn(m, RECORD).hidden, 3)
    assert.equal(panelOn(m, { ...RECORD, increments: [[5, 100, 10, [[...fieldsOf('plain', 0), 2]]]] }).hidden, 0)
  }],
  ['failed captures are listed newest first and only when there are some', (m) => {
    assert.deepEqual(panelOn(m, RECORD).failures.map((failure) => failure.reason), ['second failure', 'first failure'])
    assert.deepEqual(panelOn(m, { ...RECORD, failures: undefined }).failures, [])
    assert.deepEqual(panelOn(m, { ...RECORD, failures: [] }).failures, [])
  }],
  ['the pins leave out a pin on a game-master-only event', (m) => {
    const entries = pageOn(m).pinEntries

    assert.deepEqual(entries.map((entry) => entry.message), ['pin a'])
  }],
  ['a row of a game-master-only event cannot be pinned, and any other can', (m) => {
    const saved = []
    const vm = pageOn(m, { saved })

    vm.togglePin(rowOf(1))
    assert.equal(saved.length, 0, 'a game-master-only row was pinned')
    assert.ok(vm.pinMessage.length > 0, 'the refusal is not said')
    vm.togglePin(rowOf(0))
    assert.equal(saved.length, 1, 'a player row was not pinned')
    assert.equal(vm.pinMessage, '')
  }],
  ['a dialog left open over a refresh that dropped its group cannot pin it, and the store stays readable', (m) => {
    const saved = []
    const gone = { ...rowOf(0), archived: false, increment: undefined, MessageText: 'gone group', id: 1 }
    const kept = { ...rowOf(0), archived: false, increment: undefined, MessageText: 'kept group', id: 2 }
    const store = { version: 1, seeded: {}, pins: [pinOf('a', 0), pinOf('c', 0)] }
    const vm = pageOn(m, { saved, stored: store, data: { logEvents: [kept], pinStore: { key: 'k', store } } })

    vm.togglePin(gone)
    assert.equal(saved.length, 0, 'a pin on a group the save no longer holds was written')
    assert.ok(/no longer holds/.test(vm.pinMessage), 'the refusal is not said: ' + vm.pinMessage)
    assert.equal(m.pins.readPins(vm.pinStore.store).pins.length, 2)
    vm.togglePin(kept)
    assert.equal(saved.length, 1, 'a group the save holds was not pinned')
    assert.equal(saved[0][1].pins.length, 3)
    assert.ok(m.pins.readPins(saved[0][1]), 'the store written is not readable')
  }],
  ['a pin the store would reject is never added', (m) => {
    const store = { version: 1, seeded: {}, pins: [pinOf('a', 0)] }
    const row = rowOf(0)
    const options = { increment: [5, 100, 10], count: 0, names: {}, at: 1, id: 'z' }

    assert.throws(() => m.pins.withPin(store, 'b1', row, options), /cannot be pinned/)
    assert.throws(() => m.pins.withPin(store, 'b1', row, { ...options, count: 1, increment: [5, 100] }), /cannot be pinned/)
    assert.equal(m.pins.readPins(m.pins.withPin(store, 'b1', row, { ...options, count: 1 })).pins.length, 2)
  }],
]

const GAME_MASTER_MUTANTS = [
  { name: 'the live query keeps game-master-only events', load: { page: replacing(' and coalesce(L.SMOnly, 0) = 0', '') }, fails: ['the live query'] },
  { name: 'the archive list keeps game-master-only events', load: { utility: { file: 'log-archive-view.js', find: '.filter((row) => !row.SMOnly)', replace: '' } }, fails: ['the archive list'] },
  { name: 'the conflicts quoting a game-master-only event are listed', load: { utility: { file: 'log-archive-view.js', find: 'record.conflicts.filter((conflict) => !(conflict.group && conflict.group[GAME_MASTER]))', replace: 'record.conflicts' } }, fails: ['the conflicts leave out'] },
  { name: 'the panel lists the conflicts of the record', load: { panel: { find: 'return this.shownConflicts.slice(-SHOWN).reverse()', replace: 'return this.record.conflicts.slice(-SHOWN).reverse()' } }, fails: ['the conflicts leave out'] },
  { name: 'the panel counts the conflicts of the record', load: { panel: { find: '<div class="archive-value">{{ count(shownConflicts.length) }}</div>', replace: '<div class="archive-value">{{ count(record.conflicts.length) }}</div>' } }, fails: ['the conflicts leave out'] },
  { name: 'the panel does not count the game-master-only events', load: { utility: { file: 'log-archive-view.js', find: 'count + (group[GAME_MASTER] ? group[EVENT_FIELDS.length] : 0)', replace: 'count + 0' } }, fails: ['the panel counts game-master-only'] },
  { name: 'the failed captures are listed oldest first', load: { panel: { find: 'this.record.failures.slice(-SHOWN).reverse()', replace: 'this.record.failures.slice(-SHOWN)' } }, fails: ['failed captures'] },
  { name: 'the pins on a game-master-only event are listed', load: { page: replacing('const pins = playerPins(this.branchPins)', 'const pins = this.branchPins') }, fails: ['the pins leave out'] },
  { name: 'the pins are not filtered by their fields', load: { utility: { file: 'log-archive-view.js', find: 'pins.filter((pin) => !pin.fields[GAME_MASTER])', replace: 'pins' } }, fails: ['the pins leave out'] },
  { name: 'a game-master-only row is pinned', load: { page: replacing('if (!pinnableRow(event)) {', 'if (false) {') }, fails: ['a row of a game-master-only'] },
  { name: 'every row is refused a pin', load: { utility: { file: 'log-archive-view.js', find: 'export const pinnableRow = (row) => !row.SMOnly', replace: 'export const pinnableRow = () => false' } }, fails: ['a row of a game-master-only'] },
  { name: 'a pin on a group the save no longer holds is attempted', load: { page: replacing('if (!pin && this.groupCount(event) < 1) {', 'if (false) {') }, fails: ['a dialog left open'] },
  { name: 'a pin the store would reject is added', load: { utility: { file: 'event-pins.js', find: 'if (!validPin(pin)) {', replace: 'if (false) {' } }, fails: ['a pin the store would reject'] },
]

const failedOf = async (m) => {
  const failed = []

  for (const [name, body] of gameMasterChecks) {
    try {
      await body(m)
    } catch (error) {
      failed.push({ name, message: error.message })
    }
  }

  return failed
}

const run = async () => {
  const { 'event-triage': triage, 'log-visit': visit } = await loadUtilities(['event-triage', 'log-visit'])
  let passed = 0
  let total = checks.length

  for (const { name, run: body } of checks) {
    try {
      await body({ triage, visit })
      passed++
    } catch (error) {
      console.log(`FAIL ${name}\n     ${error.message.split('\n').join('\n     ')}`)
    }
  }

  const real = await loadGameMaster()
  const realFailed = await failedOf(real)

  total += gameMasterChecks.length
  passed += gameMasterChecks.length - realFailed.length
  realFailed.forEach(({ name, message }) => console.log(`FAIL ${name}\n     ${message.split('\n').join('\n     ')}`))

  for (const mutant of GAME_MASTER_MUTANTS) {
    total++

    try {
      const failed = await failedOf(await loadGameMaster(mutant.load))
      const missing = mutant.fails.filter((start) => !failed.some(({ name }) => name.startsWith(start)))

      if (missing.length) {
        throw new Error(`the check does not fail: ${missing.join(', ')}`)
      }

      passed++
    } catch (error) {
      console.log(`FAIL mutant: ${mutant.name}\n     ${error.message}`)
    }
  }

  console.log(`${passed} of ${total} checks passed`)
  process.exitCode = passed === total ? 0 : 1
}

run()
