/*
  Checks the warning snoozes (src/renderer/utilities/warnings/snoozes.js, the signatures the 24 checks of the classes B, C and K declare in utilities/warnings/*.js, and the wiring of pages/warnings.vue) against worked fixtures and against what the saves hold, read-only.

  node scripts/check-warning-snoozes.js [--no-mutations] [--all] [--only=key,key]

  --all lists the checks each mutation breaks, not only the ones it names; --only runs the checks of those keys and the mutations that name one.

  Groups, each check numbered and keyed (a mutation names the keys it must break):
  - unit: when a snooze ends and when it holds (a game date at and after its expiry and the guards before it, a declared change, an episode that is seen to end and a return that is a new one), what a failed read, a row that could not be evaluated, an id listed twice, a signature or an identity that cannot be read, an unknown clock, changed options and a save earlier than the snooze leave alone, a snooze of the whole check, what a record is made of and refused for, the stored form and the ended records kept apart, a restart, the isolation of races and campaigns, the seeding of a branch at a fork whatever the parent did since, the dates of the game, the bands and the signatures, the 24 checks that declare a material change, the signature of a damaged ship made of ids, the condition told in words, a Settings reset keeping the snoozes, the wording;
  - page: the real options of pages/warnings.vue run in Vue 2.7 without a template, over the real checks on AuroraDB.db and a store that is a plain object (a permanent mute outranks a snooze, the clock of the save, the guards of an evaluation, the store that cannot be read or written, a retry, the words of a snooze);
  - reads: the real checks on the saves AuroraDB.db (game 140, race 784), saves/AuroraDB_271_skoormit_saved.db (game 138, race 785) and the eight saves of artifacts/falryx-sequential-and-rollback (game 141, race 791): the signatures of every row, every row snoozed and held, the identity stamps against SQL written here, a failed read, a save earlier than the snooze;
  - forks: the same eight saves through the real recorder into in-memory stores, so the registry gives the branches (a rollback and three forks); the snoozes of one branch seeded to the next and judged on the real rows of the child, against the identity of each object read independently.
  A save that is not there skips its group and says so (a skip is never agreement); only SELECTs are issued to a save, which is opened read only.

  Each mutation is planted in an isolated copy of the source (scripts/lib/mutant-source.js) and must break every check it names. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const { format } = require('util')
const sqlite3 = require('sqlite3')
const Vue = require('vue')
const { parse: parseComponent } = require('vue/compiler-sfc')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { loadPage } = require('./lib/page-loader')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')
const { chunksOf, spread } = require('./lib/mutant-chunks')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pagesDirectory = path.join(root, 'src', 'renderer', 'pages')
const FALRYX = path.join(root, 'artifacts', 'falryx-sequential-and-rollback')
const FALRYX_TIMES = ['2398452450', '2590429565', '2713949950', '2740177930', '2794985390', '2810693885', '2904201340', '2930673230']

const SAVES = {
  modded: { file: path.join(root, 'AuroraDB.db'), game: 140, race: 784 },
  stock: { file: path.join(root, 'saves', 'AuroraDB_271_skoormit_saved.db'), game: 138, race: 785 },
  ...Object.fromEntries(FALRYX_TIMES.map((time) => [`f${time}`, { file: path.join(FALRYX, `AuroraDB-${time}.db`), game: 141, race: 791 }])),
}
const SAVE_KEYS = Object.keys(SAVES).filter((key) => fs.existsSync(SAVES[key].file))
const FAST_SAVES = ['modded', 'f2904201340'].filter((key) => SAVE_KEYS.includes(key))
const DEFAULT_OPTIONS = { idleFleetsAtColonies: false, maintenanceThreshold: 100, maintenanceExclusions: [] }

const MATERIAL_KEYS = ['undermanned-ships', 'damaged-ships', 'armor-damaged-ships', 'low-morale-crews', 'low-maintenance-ships', 'misconfigured-supply-classes', 'misconfigured-tanker-classes', 'free-construction-capacity', 'free-ordnance-capacity', 'free-fighter-capacity', 'idle-ground-training', 'projects-short-of-minerals', 'idle-slipways', 'low-efficiency-populations', 'wasted-mining-capacity', 'mass-driver-orphans', 'idle-research-labs', 'stalled-research-projects', 'mismatched-research-fields', 'stranded-miners', 'intruders', 'dangerous-rifts', 'active-lifepods', 'known-unexploited-constructs']

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The stores of the history folder, kept in one map by folder and name, as the recorder reads and writes them.
const STORE_STUB = `const files = (globalThis.__warningSnoozeStores = globalThis.__warningSnoozeStores || new Map())
export default class Config {
  constructor ({ cwd = '', name = 'config' } = {}) { this.key = cwd + '/' + name }
  get store () { return JSON.parse(JSON.stringify(files.get(this.key) || {})) }
  set store (value) { files.set(this.key, JSON.parse(JSON.stringify(value))) }
  get path () { return this.key }
  get (key, fallback) { return key.split('.').reduce((value, part) => (value === undefined || value === null ? undefined : value[part]), this.store) ?? fallback }
}`

const STUBS = {
  'electron-store': STORE_STUB,
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const NAMES = ['warnings/common', 'warnings/index', 'warnings/snoozes', 'history-milestones', 'campaign', 'remembered-views']
const NAMES_WITH_HISTORY = [...NAMES, 'history', 'recording-owner']

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// The text of each file of the utilities, read once for all the loads of the process: the folder does not change while the checks run, and a mutation's own text is given as `sources`.
const texts = new Map()

const loadModules = async (sources, names = NAMES, pageEdits = []) => {
  const loaded = await loadUtilities(names, { stubs: STUBS, directory: utilitiesDirectory, sources, texts })

  return { common: loaded['warnings/common'], index: loaded['warnings/index'], snoozes: loaded['warnings/snoozes'], milestones: loaded['history-milestones'], campaign: loaded.campaign, remembered: loaded['remembered-views'], history: loaded.history, pages: pagesDirectory, pageEdits }
}

// ---------- the saves, read only ----------

const handles = new Map()

const handleOf = (file) => {
  if (!handles.has(file)) {
    handles.set(file, new Promise((resolve, reject) => {
      const handle = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(handle)))
    }))
  }

  return handles.get(file)
}

const databases = new Map()

const databaseOf = (file) => {
  if (!databases.has(file)) {
    databases.set(file, {
      transaction: (work) => work({ id: 'transaction' }),
      query: async (sql) => {
        assert.ok(/^\s*select\b/i.test(sql), `only SELECTs are issued to a save: ${sql.slice(0, 60)}`)

        const handle = await handleOf(file)

        return [await new Promise((resolve, reject) => handle.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))]
      },
    })
  }

  return databases.get(file)
}

// A save as the check reads it: every check of the page read as the page reads it, with the game time of the save.
const readSave = async (m, key) => {
  const save = SAVES[key]
  const database = databaseOf(save.file)
  const [[{ GameTime }]] = await database.query(`select FCT_Game.GameTime from FCT_Game where FCT_Game.GameID = ${save.game}`)
  const reads = {}

  for (const check of m.index.CHECKS) {
    const options = Object.fromEntries((check.options || []).map((name) => [name, DEFAULT_OPTIONS[name]]))

    try {
      const rows = await check.read({ database, GameID: save.game, RaceID: save.race, RaceNPR: false, separator: ',', count: m.common.counter(','), options, GameTime })

      reads[check.key] = Object.freeze({ ok: true, rows: m.common.normalizeRows(rows, check), GameTime, options: Object.freeze({ ...options }) })
    } catch (error) {
      reads[check.key] = Object.freeze({ ok: false, error: error.message, rows: [], GameTime, options })
    }
  }

  return { key, save, database, GameTime, reads }
}

// ---------- the branches, from the real recorder into in-memory stores ----------

const installation = () => {
  const files = new Map()
  let ids = 1000
  let clock = 1000000

  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      files.set(name, clone(value))
    },
    update (change) {
      this.store = change(this.store)

      return this.store
    },
  })

  return {
    files,
    newId: () => `c${++ids}`,
    now: () => ++clock,
    io: { registry: store('registry'), migration: store('migration'), settings: store('settings'), backup: store('backup'), file: (name) => store(`file:${name}`) },
  }
}

const forksOf = async (m) => {
  const keys = FALRYX_TIMES.map((time) => `f${time}`)

  if (!keys.every((key) => SAVE_KEYS.includes(key))) {
    return null
  }

  const inst = installation()
  const saves = []

  for (const key of keys) {
    const resolved = []
    const database = databaseOf(SAVES[key].file)
    const run = await m.history.recordHistory({ transaction: (work) => work({ id: 'transaction' }), query: database.query }, { storage: inst.io, path: `C:/saves/${path.basename(SAVES[key].file)}`, now: inst.now, newId: inst.newId, onResolved: (GameID, resolution) => resolved.push({ GameID, ...resolution }) })
    const mine = resolved.find((entry) => entry.GameID === SAVES[key].game)
    const [[{ GameTime }]] = await database.query(`select FCT_Game.GameTime from FCT_Game where FCT_Game.GameID = ${SAVES[key].game}`)

    assert.deepEqual(run.failed, [], `the recorder failed on ${key}`)
    saves.push({ key, GameTime, campaignId: mine.campaignId, branchId: mine.branchId, relation: mine.relation })
  }

  const campaignId = saves[0].campaignId
  const registry = clone(inst.files.get('registry'))

  return { saves, campaignId, lineage: m.milestones.branchLineage(registry.campaigns[campaignId]) }
}

// ---------- worked fixtures ----------

const CHECK = Object.freeze({ key: 'test-check', material: 'the figure crossing a band', columns: [{ key: 'name', text: 'Name' }], provenance: 'warnings.test' })
const PLAIN = Object.freeze({ key: 'plain-check', columns: [{ key: 'name', text: 'Name' }], provenance: 'warnings.test' })

const rowsOf = (m, list) => m.common.normalizeRows(list.map(({ id, signature, unevaluated }) => ({ id, cells: { name: id }, ...(signature !== undefined ? { signature } : {}), ...(unevaluated ? { unevaluated: { status: 'unavailable' } } : {}) })), CHECK)

const readOf = (m, list, over = {}) => Object.freeze({ ok: true, rows: rowsOf(m, list), GameTime: 1000, options: {}, ...over })

const rec = (over = {}) => ({ id: 'b1|test-check|item|fleet:1', check: 'test-check', scope: 'item', rowId: 'fleet:1', stamp: null, setAt: 100, branch: 'b1', from: null, reason: '', options: {}, until: { kind: 'clear' }, ...over })

const checkRec = (over = {}) => rec({ id: 'b1|test-check|check|', scope: 'check', rowId: null, ...over })

const stateOf = (result, id) => (result.rows.has(id) ? result.rows.get(id).state : null)

const reasons = (result) => result.ended.map((entry) => entry.reason)

const entriesOf = (result) => ({ failed: result.failed, ended: result.ended.map((entry) => [entry.record.id, entry.reason]), rows: [...result.rows.entries()].map(([id, entry]) => [id, entry.state, entry.record.id, entry.notes]), check: result.check ? result.check.id : null })

const memoryConfig = () => {
  const data = {}

  return {
    get: (key, fallback) => clone(key.split('.').reduce((value, part) => (value === undefined || value === null ? undefined : value[part]), data) ?? fallback),
    set: (key, value) => {
      const parts = key.split('.')
      const last = parts.pop()
      const holder = parts.reduce((object, part) => { object[part] = object[part] || {}; return object[part] }, data)

      holder[last] = clone(value)
    },
    delete: (key) => {
      const parts = key.split('.')
      const last = parts.pop()
      const holder = parts.reduce((object, part) => (object === undefined ? undefined : object[part]), data)

      if (holder) {
        delete holder[last]
      }
    },
  }
}

const mockDatabase = (rowsByTable, calls = []) => ({
  query: async (sql) => {
    calls.push(sql)

    const table = /from (FCT_\w+)/.exec(sql)[1]
    const rows = rowsByTable[table]

    if (rows instanceof Error) {
      throw rows
    }

    return [rows || []]
  },
})

const checks = []
const check = (key, name, needs, run) => checks.push({ key, name, needs, run })

// ---------- unit ----------

check('date', 'a game date holds the snooze until the game time reaches it and brings the warning back at it, and after it, whether or not the row is still there', 'unit', ({ m }) => {
  const { evaluate } = m.snoozes
  const r = rec({ until: { kind: 'date', expiresAt: 500 } })
  const at = (now, list = [{ id: 'fleet:1' }]) => evaluate([r], readOf(m, list, { GameTime: now }))

  assert.equal(stateOf(at(499), 'fleet:1'), 'snoozed')
  assert.deepEqual(reasons(at(499)), [])
  assert.deepEqual(reasons(at(500)), ['expired'])
  assert.equal(at(500).rows.size, 0)
  assert.deepEqual(reasons(at(501)), ['expired'])
  assert.deepEqual(reasons(at(9999)), ['expired'])
  assert.deepEqual(reasons(at(9999, [])), ['expired'])
  assert.deepEqual(reasons(at(499, [])), ['absent'])
})

check('material', 'a declared change brings the warning back at once, a change of nothing declared does not, and a signature that cannot be read neither ends the snooze nor is stored over', 'unit', ({ m }) => {
  const { evaluate } = m.snoozes
  const r = rec({ until: { kind: 'material', signature: 'a|0' } })
  const rows = (signature) => readOf(m, [{ id: 'fleet:1', signature }])

  assert.equal(stateOf(evaluate([r], rows('a|0')), 'fleet:1'), 'snoozed')
  assert.deepEqual(reasons(evaluate([r], rows('a|0'))), [])
  assert.deepEqual(reasons(evaluate([r], rows('a|1'))), ['changed'])
  assert.equal(evaluate([r], rows('a|1')).rows.size, 0)

  const unknown = evaluate([r], rows(null))

  assert.deepEqual(reasons(unknown), [])
  assert.equal(stateOf(unknown, 'fleet:1'), 'shown')
  assert.deepEqual(unknown.rows.get('fleet:1').notes, [m.snoozes.NOTES.signature])
  assert.equal(r.until.signature, 'a|0')
  assert.equal(stateOf(evaluate([r], rows('')), 'fleet:1'), 'shown')
  assert.equal(stateOf(evaluate([r], readOf(m, [{ id: 'fleet:1' }])), 'fleet:1'), 'shown')
})

check('clear', 'a row seen to be gone from a read that succeeded ends its episode, and its return is a new episode that shows', 'unit', ({ m }) => {
  const { evaluate, addRecord, endRecords, emptyStore, forBranch } = m.snoozes
  const r = rec()
  const present = readOf(m, [{ id: 'fleet:1' }])
  const gone = readOf(m, [{ id: 'fleet:2' }])

  assert.equal(stateOf(evaluate([r], present), 'fleet:1'), 'snoozed')

  const out = evaluate([r], gone)

  assert.deepEqual(reasons(out), ['absent'])

  const pruned = endRecords(addRecord(emptyStore(), r), out.ended.map((entry) => ({ id: entry.record.id, at: 1000, reason: entry.reason })))
  const back = evaluate(forBranch(pruned, 'b1'), present)

  assert.equal(pruned.records.length, 0)
  assert.equal(back.rows.size, 0)
  assert.deepEqual(back.ended, [])
})

check('failed', 'a read that failed changes no record: nothing ends, not a date past its expiry, not a row that is absent, and nothing is read as an empty list', 'unit', ({ m }) => {
  const { evaluate } = m.snoozes
  const records = [rec({ until: { kind: 'date', expiresAt: 5 } }), rec({ id: 'x', rowId: 'fleet:9' }), checkRec(), checkRec({ id: 'y', until: { kind: 'material', signatures: { 'fleet:1': 'a' } } })]
  const failures = [{ ok: false, rows: [], GameTime: 9999, options: {} }, { ok: false, error: 'disk I/O error', rows: [], GameTime: 9999, options: {} }, { ok: false }, null, undefined, { ok: true }, { ok: true, rows: null }]

  failures.forEach((read, index) => {
    const out = evaluate(records, read)

    assert.equal(out.failed, true, `failure ${index}`)
    assert.deepEqual(out.ended, [], `failure ${index}`)
    assert.equal(out.rows.size, 0, `failure ${index}`)
    assert.equal(out.check, null, `failure ${index}`)
  })

  const genuine = evaluate(records, readOf(m, [], { GameTime: 9999 }))

  assert.equal(genuine.failed, false)
  assert.ok(genuine.ended.length > 0)
})

check('unevaluated', 'a row that could not be evaluated keeps its snooze and shows with a note, and a check whose only rows could not be evaluated is not cleared', 'unit', ({ m }) => {
  const { evaluate, NOTES } = m.snoozes
  const read = readOf(m, [{ id: 'fleet:1', unevaluated: true }, { id: 'fleet:2', unevaluated: true }])
  const item = evaluate([rec(), rec({ id: 'z', rowId: 'fleet:2', until: { kind: 'material', signature: 'a' } })], read)

  assert.deepEqual(item.ended, [])
  assert.equal(stateOf(item, 'fleet:1'), 'shown')
  assert.deepEqual(item.rows.get('fleet:1').notes, [NOTES.unevaluated])
  assert.equal(stateOf(item, 'fleet:2'), 'shown')

  const whole = evaluate([checkRec()], read)

  assert.deepEqual(whole.ended, [])
  assert.equal(whole.check.id, 'b1|test-check|check|')
  assert.equal(whole.rows.size, 0)
})

check('ambiguous', 'an id the check lists twice cannot be snoozed, and a snooze already held keeps its record and shows both rows with a note', 'unit', ({ m }) => {
  const { evaluate, makeRecord, NOTES } = m.snoozes
  const read = readOf(m, [{ id: 'fleet:1' }, { id: 'fleet:1' }, { id: 'fleet:2' }])
  const [first, second, third] = read.rows

  assert.deepEqual([first.ambiguous, second.ambiguous, third.ambiguous], [true, true, false])
  assert.deepEqual([first.raw, second.raw, first.id, second.id], ['fleet:1', 'fleet:1', 'fleet:1', 'fleet:1#2'])
  assert.equal(makeRecord({ check: CHECK, scope: 'item', kind: 'clear', row: first, read, branch: 'b1' }).ok, false)
  assert.equal(makeRecord({ check: CHECK, scope: 'item', kind: 'clear', row: third, read, branch: 'b1' }).ok, true)

  const out = evaluate([rec()], read)

  assert.deepEqual(out.ended, [])
  assert.equal(stateOf(out, 'fleet:1'), 'shown')
  assert.equal(stateOf(out, 'fleet:1#2'), 'shown')
  assert.deepEqual(out.rows.get('fleet:1').notes, [NOTES.ambiguous])
})

check('stamp', 'a snooze of an object holds only while the identity stamp is the one it was made with: another object under the id ends it, a stamp that cannot be read keeps it and shows the row', 'unit', ({ m }) => {
  const { evaluate, NOTES } = m.snoozes
  const r = rec({ id: 'b1|test-check|item|ship:1', rowId: 'ship:1', stamp: 'ship:5,10' })
  const read = readOf(m, [{ id: 'ship:1' }])

  assert.equal(stateOf(evaluate([r], read, new Map([['ship:1', 'ship:5,10']])), 'ship:1'), 'snoozed')
  assert.deepEqual(reasons(evaluate([r], read, new Map([['ship:1', 'ship:5,11']]))), ['different'])

  ;[new Map([['ship:1', null]]), new Map()].forEach((stamps) => {
    const out = evaluate([r], read, stamps)

    assert.deepEqual(out.ended, [])
    assert.deepEqual(out.rows.get('ship:1').notes, [NOTES.stamp])
    assert.equal(stateOf(out, 'ship:1'), 'shown')
  })

  assert.deepEqual(reasons(evaluate([r], readOf(m, []), new Map())), ['absent'])
})

check('clock', 'a game time that is not known never expires a date: the row shows with a note and the record stays, and no snooze is made without one', 'unit', ({ m }) => {
  const { evaluate, makeRecord, NOTES } = m.snoozes
  const r = rec({ until: { kind: 'date', expiresAt: 500 } })

  ;[null, undefined, NaN, 'x'].forEach((GameTime) => {
    const out = evaluate([r], readOf(m, [{ id: 'fleet:1' }], { GameTime }))

    assert.deepEqual(out.ended, [])
    assert.equal(stateOf(out, 'fleet:1'), 'shown')
    assert.deepEqual(out.rows.get('fleet:1').notes, [NOTES.clock])
    assert.equal(makeRecord({ check: CHECK, scope: 'item', kind: 'clear', row: readOf(m, [{ id: 'fleet:1' }]).rows[0], read: readOf(m, [{ id: 'fleet:1' }], { GameTime }), branch: 'b1' }).ok, false)
  })

  assert.equal(stateOf(evaluate([rec()], readOf(m, [{ id: 'fleet:1' }], { GameTime: null })), 'fleet:1'), 'snoozed')
})

check('options', 'a changed set of options never makes a change material: the snooze holds until the row clears with a note, and a date is unaffected', 'unit', ({ m }) => {
  const { evaluate, sameOptions, NOTES } = m.snoozes
  const r = rec({ options: { threshold: 100, list: [1, 2] }, until: { kind: 'material', signature: 'a' } })
  const changed = evaluate([r], readOf(m, [{ id: 'fleet:1', signature: 'b' }], { options: { threshold: 50, list: [1, 2] } }))

  assert.deepEqual(changed.ended, [])
  assert.equal(stateOf(changed, 'fleet:1'), 'snoozed')
  assert.deepEqual(changed.rows.get('fleet:1').notes, [NOTES.options])
  assert.deepEqual(reasons(evaluate([r], readOf(m, [{ id: 'fleet:1', signature: 'b' }], { options: { list: [1, 2], threshold: 100 } }))), ['changed'])
  assert.equal(sameOptions({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true)
  assert.equal(sameOptions({ a: [1, 2] }, { a: [2, 1] }), false)
  assert.equal(sameOptions(undefined, {}), true)
  assert.deepEqual(reasons(evaluate([rec({ options: { threshold: 100 }, until: { kind: 'date', expiresAt: 500 } })], readOf(m, [{ id: 'fleet:1' }], { options: { threshold: 50 }, GameTime: 600 }))), ['expired'])
})

check('ahead', 'a snooze set later than the game time of the open save ends nothing: a date and a clear still hold, and what would end the others shows the row with a note and keeps the record', 'unit', ({ m }) => {
  const { evaluate, NOTES } = m.snoozes
  const late = (over) => rec({ setAt: 2000, ...over })
  const now = (list, over) => readOf(m, list, { GameTime: 1000, ...over })

  assert.deepEqual(evaluate([late({ rowId: 'fleet:9', id: 'a' })], now([{ id: 'fleet:1' }])).ended, [])

  const changed = evaluate([late({ until: { kind: 'material', signature: 'a' } })], now([{ id: 'fleet:1', signature: 'b' }]))

  assert.deepEqual(changed.ended, [])
  assert.equal(stateOf(changed, 'fleet:1'), 'shown')
  assert.deepEqual(changed.rows.get('fleet:1').notes, [NOTES.ahead])

  const different = evaluate([late({ id: 'b1|test-check|item|ship:1', rowId: 'ship:1', stamp: 's1' })], now([{ id: 'ship:1' }]), new Map([['ship:1', 's2']]))

  assert.deepEqual(different.ended, [])
  assert.deepEqual(different.rows.get('ship:1').notes, [NOTES.ahead])
  assert.equal(stateOf(evaluate([late({ until: { kind: 'date', expiresAt: 5000 } })], now([{ id: 'fleet:1' }])), 'fleet:1'), 'snoozed')
  assert.equal(stateOf(evaluate([late()], now([{ id: 'fleet:1' }])), 'fleet:1'), 'snoozed')
  assert.deepEqual(evaluate([checkRec({ setAt: 2000 })], now([])).ended, [])
  assert.deepEqual(reasons(evaluate([rec({ setAt: 500 })], now([{ id: 'fleet:2' }]))), ['absent'])
})

check('check-scope', 'a snooze of the whole check holds every row until the check lists nothing, a declared change of any row or a row new to it ends a material one, and a row whose signature cannot be read shows apart', 'unit', ({ m }) => {
  const { evaluate, NOTES } = m.snoozes
  const clear = checkRec()
  const material = checkRec({ until: { kind: 'material', signatures: { 'fleet:1': 'a', 'fleet:2': 'b' } } })
  const list = (a, b) => readOf(m, [{ id: 'fleet:1', signature: a }, { id: 'fleet:2', signature: b }])

  const held = evaluate([clear], readOf(m, [{ id: 'fleet:1' }, { id: 'fleet:3' }, { id: 'fleet:4', unevaluated: true }]))

  assert.equal(held.check.id, clear.id)
  assert.deepEqual([stateOf(held, 'fleet:1'), stateOf(held, 'fleet:3'), stateOf(held, 'fleet:4')], ['snoozed', 'snoozed', null])
  assert.deepEqual(reasons(evaluate([clear], readOf(m, []))), ['cleared'])
  assert.deepEqual(reasons(evaluate([checkRec({ until: { kind: 'date', expiresAt: 1000 } })], readOf(m, []))), ['expired'])
  assert.deepEqual(reasons(evaluate([checkRec({ until: { kind: 'date', expiresAt: 1000 } })], readOf(m, [{ id: 'fleet:1' }]))), ['expired'])

  assert.deepEqual([stateOf(evaluate([material], list('a', 'b')), 'fleet:1'), stateOf(evaluate([material], list('a', 'b')), 'fleet:2')], ['snoozed', 'snoozed'])
  assert.deepEqual(reasons(evaluate([material], list('a', 'c'))), ['changed'])
  assert.deepEqual(reasons(evaluate([material], readOf(m, [{ id: 'fleet:1', signature: 'a' }, { id: 'fleet:2', signature: 'b' }, { id: 'fleet:3', signature: 'a' }]))), ['changed'])
  assert.deepEqual(reasons(evaluate([material], readOf(m, [{ id: 'fleet:1', signature: 'a' }]))), [])

  const unknown = evaluate([material], list('a', null))

  assert.deepEqual(unknown.ended, [])
  assert.equal(stateOf(unknown, 'fleet:1'), 'snoozed')
  assert.deepEqual([stateOf(unknown, 'fleet:2'), unknown.rows.get('fleet:2').notes], ['shown', [NOTES.signature]])

  const twice = evaluate([material], readOf(m, [{ id: 'fleet:1', signature: 'a' }, { id: 'fleet:1', signature: 'a' }]))

  assert.deepEqual(twice.ended, [])
  assert.deepEqual(twice.rows.get('fleet:1').notes, [NOTES.ambiguous])
})

check('precedence', 'a row held by an item snooze and by the check is hidden, and a row only shown by one is not held back by the other', 'unit', ({ m }) => {
  const { evaluate } = m.snoozes
  const read = readOf(m, [{ id: 'fleet:1' }, { id: 'fleet:2' }])
  const item = rec({ from: 'b0' })
  const both = evaluate([item, checkRec()], read)

  assert.equal(stateOf(both, 'fleet:1'), 'snoozed')
  assert.equal(both.rows.get('fleet:1').record.scope, 'check')
  assert.equal(stateOf(evaluate([item], read), 'fleet:1'), 'shown')
})

check('make', 'a snooze is made only with a game time, a later date, a declared change whose signature is known, a row the check lists once and an identity that can be read, and keeps what it needs to be judged later', 'unit', ({ m }) => {
  const { makeRecord, readStore, emptyStore, addRecord, REASON_LENGTH, isStamped } = m.snoozes
  const read = readOf(m, [{ id: 'fleet:1', signature: 'a|0' }, { id: 'fleet:2' }, { id: 'ship:3', signature: 's' }, { id: 'fleet:4', unevaluated: true }, { id: 'fleet:5', signature: 'x' }, { id: 'fleet:5', signature: 'x' }], { options: { threshold: 100 } })
  const [one, two, ship, unread, twin] = read.rows
  const make = (over) => makeRecord({ check: CHECK, scope: 'item', kind: 'clear', row: one, read, branch: 'b1', ...over })
  const error = (result) => (result.ok ? null : result.error)

  const ok = make({ kind: 'material', reason: '  waiting for the refit  ' })

  assert.equal(ok.ok, true)
  assert.deepEqual(ok.record, { id: 'b1|test-check|item|fleet:1', check: 'test-check', scope: 'item', rowId: 'fleet:1', stamp: null, setAt: 1000, branch: 'b1', from: null, reason: 'waiting for the refit', options: { threshold: 100 }, until: { kind: 'material', signature: 'a|0' } })
  assert.equal(readStore(addRecord(emptyStore(), ok.record)).dropped, 0)
  assert.equal(make({ kind: 'date', expiresAt: 1001 }).ok, true)
  assert.deepEqual(make({ kind: 'date', expiresAt: 1001 }).record.until, { kind: 'date', expiresAt: 1001 })
  assert.ok(error(make({ kind: 'date', expiresAt: 1000 })))
  assert.ok(error(make({ kind: 'date', expiresAt: 999 })))
  assert.ok(error(make({ kind: 'date', expiresAt: NaN })))
  assert.ok(error(make({ kind: 'date', expiresAt: null })))
  assert.ok(error(make({ check: PLAIN, kind: 'material' })))
  assert.ok(error(make({ kind: 'material', row: two })))
  assert.ok(error(make({ row: unread })))
  assert.ok(error(make({ row: twin })))
  assert.ok(error(make({ row: null })))
  assert.ok(error(make({ branch: null })))
  assert.ok(error(make({ read: readOf(m, [], { GameTime: null }) })))
  assert.ok(error(make({ kind: 'forever' })))
  assert.ok(error(make({ scope: 'race' })))
  assert.equal(make({ reason: 'x'.repeat(REASON_LENGTH + 50) }).record.reason.length, REASON_LENGTH)
  assert.equal(make({ reason: undefined }).record.reason, '')

  assert.equal(isStamped('ship:3'), true)
  assert.equal(isStamped('fleet:3'), false)
  assert.ok(error(make({ row: ship })))
  assert.ok(error(make({ row: ship, stamps: new Map([['ship:3', null]]) })))
  assert.equal(make({ row: ship, stamps: new Map([['ship:3', 'ship:1,2']]) }).record.stamp, 'ship:1,2')

  const whole = (over) => makeRecord({ check: CHECK, scope: 'check', kind: 'material', read: readOf(m, [{ id: 'fleet:1', signature: 'a' }, { id: 'fleet:2', signature: 'b' }]), branch: 'b1', ...over })

  assert.deepEqual(whole().record.until, { kind: 'material', signatures: { 'fleet:1': 'a', 'fleet:2': 'b' } })
  assert.equal(whole().record.rowId, null)
  assert.ok(error(whole({ read: readOf(m, [{ id: 'fleet:1', signature: 'a' }, { id: 'fleet:2' }]) })))
  assert.ok(error(whole({ read: readOf(m, [{ id: 'fleet:1', signature: 'a' }, { id: 'fleet:1', signature: 'a' }]) })))
  assert.ok(error(whole({ read: readOf(m, []), kind: 'clear' })))
  assert.ok(error(whole({ read: readOf(m, [{ id: 'fleet:1', unevaluated: true }]) })))
  assert.equal(whole({ kind: 'clear', read: readOf(m, [{ id: 'fleet:1', unevaluated: true }]) }).ok, true)
})

check('store', 'a stored value is read for what it is: missing is empty, another form is refused and never written over, an invalid record is left out and counted, and a record is held once', 'unit', ({ m }) => {
  const { readStore, emptyStore, VERSION } = m.snoozes
  const good = rec()

  assert.deepEqual(readStore(undefined), { ok: true, store: emptyStore(), dropped: 0 })
  assert.deepEqual(readStore(null), { ok: true, store: emptyStore(), dropped: 0 })
  ;[{ version: VERSION + 1, seeded: {}, records: [] }, [], 'x', 3, { version: VERSION, seeded: {} }, { version: VERSION, records: [] }, { version: VERSION, seeded: {}, records: {} }].forEach((value, index) => {
    const read = readStore(value)

    assert.equal(read.ok, false, `value ${index}`)
    assert.ok(read.reason, `value ${index}`)
  })

  const bad = [{ ...good, id: 'b' }, rec({ id: 'c', scope: 'moon' }), rec({ id: 'd', setAt: NaN }), rec({ id: 'e', until: { kind: 'date' } }), rec({ id: 'f', until: { kind: 'material' } }), rec({ id: 'g', rowId: null }), rec({ id: 'h', stamp: 5 }), rec({ id: 'i', options: [] }), 7, null, rec({ id: 'j', branch: '' }), rec({ id: 'k', until: { kind: 'material', signature: '' } })]
  const read = readStore({ version: VERSION, seeded: { b2: { from: 'b1', t: 5 }, b3: 'x' }, records: [good, good, ...bad.slice(1), { ...good, id: 'b' }] })

  assert.equal(read.ok, true)
  assert.deepEqual(read.store.records.map((record) => record.id), ['b1|test-check|item|fleet:1', 'b'])
  assert.equal(read.dropped, 2 + bad.length - 1 - 1)
  assert.deepEqual(Object.keys(read.store.seeded), ['b2'])
})

check('persist', 'a restart keeps every snooze with its reason and expiry, and the records judge the same read the same way after it', 'unit', ({ m }) => {
  const { readStore, emptyStore, addRecord, evaluate, makeRecord } = m.snoozes
  const read = readOf(m, [{ id: 'fleet:1', signature: 'a' }, { id: 'fleet:2', signature: 'b' }])
  const made = [makeRecord({ check: CHECK, scope: 'item', kind: 'date', expiresAt: 4000.5, reason: 'après la refonte — 修理', row: read.rows[0], read, branch: 'b1' }), makeRecord({ check: CHECK, scope: 'item', kind: 'material', row: read.rows[1], read, branch: 'b1', reason: 'waiting' }), makeRecord({ check: CHECK, scope: 'check', kind: 'material', read, branch: 'b1' })]

  assert.ok(made.every((result) => result.ok))

  const store = made.reduce((held, result) => addRecord(held, result.record), emptyStore())
  const restored = readStore(JSON.parse(JSON.stringify(store)))

  assert.equal(restored.ok, true)
  assert.equal(restored.dropped, 0)
  assert.deepEqual(restored.store, store)
  assert.equal(restored.store.records[0].reason, 'après la refonte — 修理')
  assert.equal(restored.store.records[0].until.expiresAt, 4000.5)
  assert.deepEqual(entriesOf(evaluate(restored.store.records, read)), entriesOf(evaluate(store.records, read)))
  assert.deepEqual(entriesOf(evaluate(restored.store.records, readOf(m, [{ id: 'fleet:1', signature: 'a' }, { id: 'fleet:2', signature: 'c' }], { GameTime: 5000 }))), entriesOf(evaluate(store.records, readOf(m, [{ id: 'fleet:1', signature: 'a' }, { id: 'fleet:2', signature: 'c' }], { GameTime: 5000 }))))
})

check('isolation', 'a race and a campaign each keep their own snoozes, a branch sees only its own records, and a permanent mute is neither read nor written by a snooze', 'unit', ({ m }) => {
  const { readStore, emptyStore, addRecord, forBranch } = m.snoozes
  const { raceKeyPrefix } = m.campaign
  const config = memoryConfig()
  const key = (campaignId, RaceID) => `${raceKeyPrefix(campaignId, RaceID)}.warningsSnoozed`
  const muted = { checks: ['intruders'], items: { 'idle-fleets': ['fleet:1'] } }

  config.set(`${raceKeyPrefix('c1', 784)}.warningsMuted`, muted)
  config.set(key('c1', 784), addRecord(addRecord(emptyStore(), rec()), rec({ id: 'b2|test-check|item|fleet:1', branch: 'b2' })))

  assert.equal(readStore(config.get(key('c1', 784))).store.records.length, 2)
  assert.deepEqual(readStore(config.get(key('c1', 785))).store.records, [])
  assert.deepEqual(readStore(config.get(key('c2', 784))).store.records, [])
  assert.notEqual(key('c1', 784), key('c1', 785))
  assert.notEqual(key('c1', 784), key('c2', 784))
  assert.notEqual(key('c1', 784), `${raceKeyPrefix('c1', 784)}.warningsMuted`)
  assert.deepEqual(config.get(`${raceKeyPrefix('c1', 784)}.warningsMuted`), muted)

  const store = readStore(config.get(key('c1', 784))).store

  assert.deepEqual(forBranch(store, 'b1').map((record) => record.branch), ['b1'])
  assert.deepEqual(forBranch(store, 'b2').map((record) => record.branch), ['b2'])
  assert.deepEqual(forBranch(store, 'b3'), [])
  assert.deepEqual(forBranch(store, 'b1', 'other-check'), [])
  assert.equal(new Set(store.records.map((record) => record.id)).size, 2)
})

check('seed', 'a branch is seeded once from its parent with the records set up to the fork and none later, down a chain of forks, with the origin kept, and nothing is merged back or copied again', 'unit', ({ m }) => {
  const { seeded, emptyStore, addRecord, endRecords, forBranch } = m.snoozes
  const lineage = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 100 }, b3: { parent: 'b2', t: 300 }, b4: { parent: 'b3', t: null }, bx: { parent: 'gone', t: 5 } }
  const on = (id, setAt, over = {}) => rec({ id: `b1|test-check|item|fleet:${id}`, rowId: `fleet:${id}`, setAt, ...over })
  const parent = [on(1, 50), on(2, 100), on(3, 101), on(4, 10, { scope: 'check', rowId: null, id: 'b1|test-check|check|' }), on(5, 20, { stamp: 'ship:1', rowId: 'ship:5', id: 'b1|test-check|item|ship:5' })]
  const store = parent.reduce((held, record) => addRecord(held, record), emptyStore())

  assert.equal(seeded(store, 'b1', lineage), store)

  const second = seeded(store, 'b2', lineage)
  const copies = forBranch(second, 'b2')

  assert.deepEqual(copies.map((record) => record.rowId), ['fleet:1', 'fleet:2', null, 'ship:5'])
  assert.ok(copies.every((record) => record.branch === 'b2' && record.from === 'b1' && record.id.startsWith('b2|')))
  assert.deepEqual(copies.map((record) => record.setAt), [50, 100, 10, 20])
  assert.equal(copies.find((record) => record.rowId === 'ship:5').stamp, 'ship:1')
  assert.deepEqual(forBranch(second, 'b1'), forBranch(store, 'b1'))
  assert.deepEqual(second.seeded.b2, { from: 'b1', t: 100 })
  assert.equal(seeded(second, 'b2', lineage), second)

  const cancelled = endRecords(second, [{ id: copies[0].id, at: 500, reason: 'cancelled' }])

  assert.equal(seeded(cancelled, 'b2', lineage), cancelled)
  assert.deepEqual(forBranch(cancelled, 'b2').map((record) => record.rowId), ['fleet:2', null, 'ship:5'])

  const own = addRecord(second, rec({ id: 'b2|test-check|item|fleet:7', rowId: 'fleet:7', branch: 'b2', setAt: 200 }))
  const third = seeded(own, 'b3', lineage)

  assert.deepEqual(forBranch(third, 'b3').map((record) => [record.rowId, record.from]), [['fleet:1', 'b1'], ['fleet:2', 'b1'], [null, 'b1'], ['ship:5', 'b1'], ['fleet:7', 'b2']])
  assert.deepEqual(forBranch(third, 'b2'), forBranch(own, 'b2'))
  assert.equal(third.seeded.b2.from, 'b1')

  const chain = seeded(addRecord(store, rec({ id: 'b1|test-check|item|fleet:8', rowId: 'fleet:8', setAt: 60 })), 'b3', lineage)

  assert.ok(forBranch(chain, 'b3').some((record) => record.rowId === 'fleet:8' && record.from === 'b1'))
  assert.ok(chain.seeded.b2 && chain.seeded.b3)

  const fourth = seeded(third, 'b4', lineage)

  assert.deepEqual(forBranch(fourth, 'b4'), [])
  assert.deepEqual(fourth.seeded.b4, { from: 'b3', t: null })
  assert.equal(seeded(store, 'bx', lineage), store)
  assert.equal(seeded(store, 'b9', lineage), store)
  assert.equal(seeded(store, 'b2', null), store)
  assert.ok(seeded(store, 'b2', { b1: { parent: 'b2', t: 1 }, b2: { parent: 'b1', t: 1 } }))
})

check('fork-rules', 'a copied snooze of an object applies only on a matching stamp, one with no stamp shows the row with a note and does not hide it, a snooze of the whole check applies, and an observed disappearance still ends a copy', 'unit', ({ m }) => {
  const { seeded, emptyStore, addRecord, forBranch, evaluate, makeRecord, NOTES } = m.snoozes
  const read = readOf(m, [{ id: 'fleet:1', signature: 'a' }, { id: 'ship:2', signature: 'a' }, { id: 'fleet:3', signature: 'a' }])
  const stamps = new Map([['ship:2', 'ship:1,1']])
  const made = (over) => makeRecord({ check: CHECK, scope: 'item', kind: 'clear', read, stamps, branch: 'b1', ...over }).record
  const records = [made({ row: read.rows[0] }), made({ row: read.rows[1] }), made({ row: read.rows[2], kind: 'date', expiresAt: 5000 }), makeRecord({ check: CHECK, scope: 'check', kind: 'clear', read, branch: 'b1' }).record]
  const lineage = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 5000 } }
  const child = forBranch(seeded(records.reduce((held, record) => addRecord(held, record), emptyStore()), 'b2', lineage), 'b2')
  const [stampless, stamped, dated, whole] = child
  const childRead = (list, over) => readOf(m, list, { GameTime: 1500, ...over })
  const evaluated = (items, list, map = stamps) => evaluate(items, childRead(list), map)

  assert.equal(child.length, 4)

  const hidden = evaluated([stampless], [{ id: 'fleet:1' }])

  assert.deepEqual(hidden.ended, [])
  assert.equal(stateOf(hidden, 'fleet:1'), 'shown')
  assert.deepEqual(hidden.rows.get('fleet:1').notes, [NOTES.branch])
  assert.equal(stateOf(evaluated([dated], [{ id: 'fleet:3' }]), 'fleet:3'), 'shown')
  assert.deepEqual(evaluated([stampless], [{ id: 'fleet:2' }]).ended.map((entry) => entry.reason), ['absent'])

  assert.equal(stateOf(evaluated([stamped], [{ id: 'ship:2' }]), 'ship:2'), 'snoozed')
  assert.deepEqual(reasons(evaluated([stamped], [{ id: 'ship:2' }], new Map([['ship:2', 'ship:1,2']]))), ['different'])
  assert.equal(stateOf(evaluated([stamped], [{ id: 'ship:2' }], new Map([['ship:2', null]])), 'ship:2'), 'shown')
  assert.deepEqual(reasons(evaluated([stamped], [{ id: 'fleet:9' }])), ['absent'])

  const wholeCheck = evaluated([whole], [{ id: 'fleet:1' }, { id: 'fleet:4' }])

  assert.deepEqual([stateOf(wholeCheck, 'fleet:1'), stateOf(wholeCheck, 'fleet:4')], ['snoozed', 'snoozed'])
  assert.equal(wholeCheck.check.from, 'b1')

  const material = forBranch(seeded(addRecord(emptyStore(), made({ row: read.rows[1], kind: 'material' })), 'b2', lineage), 'b2')

  assert.deepEqual(reasons(evaluated(material, [{ id: 'ship:2', signature: 'b' }])), ['changed'])
  assert.equal(stateOf(evaluated(material, [{ id: 'ship:2', signature: 'a' }]), 'ship:2'), 'snoozed')
})

check('seed-order', 'a branch inherits what its parent had in force at the fork, whatever the parent did since and whenever the branch is first seeded: a snooze cancelled, replaced or ended on the parent after the fork is still inherited, one that ended before the fork or was set after it is not, and the order of the records and the chain of forks change nothing', 'unit', ({ m }) => {
  const { seeded, emptyStore, addRecord, endRecords, forBranch, PAST_LIMIT } = m.snoozes
  const CUT = 15
  const lineage = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: CUT }, b3: { parent: 'b2', t: 30 } }
  const inherited = (store, branch) => forBranch(seeded(store, branch, lineage), branch).map((record) => [record.rowId, record.setAt, record.from, record.until.kind === 'date' ? record.until.expiresAt : record.until.kind])
  const first = (setAt) => rec({ setAt, until: { kind: 'date', expiresAt: 1000 } })
  const second = (setAt) => rec({ setAt, until: { kind: 'date', expiresAt: 2000 } })
  let cases = 0

  for (const setAt of [10, 14, 15, 16, 40]) {
    for (const endAt of [null, 12, 15, 16, 20, 40, 100]) {
      for (const how of ['cancelled', 'absent', 'replaced']) {
        if (endAt === null ? how !== 'cancelled' : endAt < setAt) {
          continue
        }

        const built = addRecord(emptyStore(), first(setAt))
        const store = endAt === null ? built : how === 'replaced' ? addRecord(built, second(endAt)) : endRecords(built, [{ id: first(setAt).id, at: endAt, reason: how }])
        const later = addRecord(store, rec({ id: 'b1|test-check|item|fleet:9', rowId: 'fleet:9', setAt: 90 }))
        const wanted = [...(setAt <= CUT && (endAt === null || endAt > CUT) ? [['fleet:1', setAt, 'b1', 1000]] : []), ...(how === 'replaced' && endAt !== null && endAt <= CUT ? [['fleet:1', endAt, 'b1', 2000]] : [])]

        assert.deepEqual(inherited(store, 'b2'), wanted, `set ${setAt}, ${how} at ${endAt}`)
        assert.deepEqual(inherited(later, 'b2'), wanted, `set ${setAt}, ${how} at ${endAt}, with later activity`)
        cases++
      }
    }
  }

  assert.ok(cases > 40)

  const unknown = endRecords(addRecord(emptyStore(), first(10)), [{ id: first(10).id, at: null, reason: 'cancelled' }])

  assert.equal(unknown.past.length, 0)
  assert.deepEqual(inherited(unknown, 'b2'), [])

  const viaB2 = seeded(addRecord(emptyStore(), first(10)), 'b2', lineage)
  const copy = 'b2|test-check|item|fleet:1'

  assert.deepEqual(forBranch(seeded(endRecords(viaB2, [{ id: copy, at: 40, reason: 'cancelled' }]), 'b3', lineage), 'b3').map((record) => [record.rowId, record.from]), [['fleet:1', 'b1']])
  assert.deepEqual(forBranch(seeded(endRecords(viaB2, [{ id: copy, at: 25, reason: 'cancelled' }]), 'b3', lineage), 'b3'), [])

  const { pruned } = m.snoozes
  const TOTAL = PAST_LIMIT + 5
  const known = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: CUT } }
  const full = { ...known, b3: { parent: 'b2', t: 17 }, b4: { parent: 'b1', t: 25 } }
  const ids = Array.from({ length: TOTAL }, (_unused, index) => `b1|test-check|item|fleet:${index}`)
  const other = rec({ id: 'b2|test-check|item|fleet:other', rowId: 'fleet:other', branch: 'b2', setAt: 16 })
  const filled = addRecord(ids.reduce((store, id, index) => addRecord(store, rec({ id, rowId: `fleet:${index}`, setAt: 10 })), emptyStore()), other)
  const ends = [...ids.map((id) => ({ id, at: 20, reason: 'cancelled' })), { id: other.id, at: 18, reason: 'cancelled' }]
  const finish = (store, lineageOf) => ends.reduce((current, end) => pruned(endRecords(current, [end]), lineageOf), store)
  const heldBy = (store, branch) => forBranch(seeded(store, branch, full), branch).map((record) => record.rowId).sort()
  const truth = endRecords(filled, ends)
  const early = finish(seeded(filled, 'b2', known), () => known)
  const late = finish(filled, () => known)

  assert.equal(heldBy(truth, 'b2').length, TOTAL)
  assert.equal(heldBy(truth, 'b3').length, TOTAL + 1)
  assert.equal(late.past.length, PAST_LIMIT)
  assert.equal(early.past.length, PAST_LIMIT)
  ;['b2', 'b3', 'b4'].forEach((branch) => {
    assert.deepEqual(heldBy(late, branch), heldBy(truth, branch), `${branch} seeded after the cut`)
    assert.deepEqual(heldBy(early, branch), heldBy(truth, branch), `${branch} seeded before the cut`)
  })
  assert.equal(finish(filled, () => null).past.length, TOTAL + 1, 'a registry that cannot be read cuts nothing')
  assert.equal(forBranch(seeded(late, 'b5', { ...full, b5: { parent: 'b1', t: CUT } }), 'b5').length, PAST_LIMIT - 1, 'a branch the registry gave later inherits what was kept')
})

check('past-store', 'a snooze that ended or was replaced is kept apart from the ones in force with the game time it ended at, validated on reading and kept through a restart, and a store with none is still read', 'unit', ({ m }) => {
  const { readStore, emptyStore, addRecord, endRecords, forBranch, seeded, VERSION } = m.snoozes
  const good = rec()
  const gone = { ...good, ended: { at: 50, reason: 'cancelled' } }
  const read = readStore({ version: VERSION, seeded: {}, records: [], past: [gone, gone, { ...good, ended: { at: null, reason: 'cancelled' } }, { ...good, ended: { at: 5 } }, { ...good }, 3, { ...gone, setAt: 101 }] })

  assert.equal(read.ok, true)
  assert.equal(read.store.past.length, 2)
  assert.equal(read.dropped, 5)
  assert.deepEqual(readStore({ version: VERSION, seeded: {}, records: [] }).store.past, [])
  assert.equal(readStore({ version: VERSION, seeded: {}, records: [], past: {} }).ok, false)

  const held = addRecord(emptyStore(), good)
  const replaced = addRecord(held, rec({ setAt: 300 }))

  assert.equal(held.past.length, 0)
  assert.deepEqual([replaced.records.length, replaced.records[0].setAt], [1, 300])
  assert.deepEqual(replaced.past.map((entry) => [entry.setAt, entry.ended]), [[100, { at: 300, reason: 'replaced' }]])
  assert.equal(endRecords(held, [{ id: 'nobody', at: 5, reason: 'cancelled' }]), held)

  const ended = endRecords(held, [{ id: good.id, at: 400, reason: 'absent' }])

  assert.deepEqual([ended.records.length, ended.past.length, forBranch(ended, 'b1').length], [0, 1, 0])
  assert.deepEqual(ended.past[0].ended, { at: 400, reason: 'absent' })
  assert.deepEqual(readStore(JSON.parse(JSON.stringify(ended))).store, ended)

  const fork = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 15 } }
  const marks = (store) => forBranch(seeded(store, 'b2', fork), 'b2').map((record) => record.until.expiresAt)
  const date = (expiresAt) => ({ kind: 'date', expiresAt })
  const cancelled = addRecord(endRecords(addRecord(emptyStore(), rec({ setAt: 10, until: date(1000) })), [{ id: good.id, at: 10, reason: 'cancelled' }]), rec({ setAt: 10, until: date(2000) }))
  const replacedAtOnce = addRecord(addRecord(emptyStore(), rec({ setAt: 10, until: date(1000) })), rec({ setAt: 10, until: date(2000) }))

  ;[[cancelled, 'cancelled and made again at one game time'], [replacedAtOnce, 'replaced at one game time']].forEach(([built, how]) => {
    const second = endRecords(built, [{ id: good.id, at: 20, reason: 'absent' }])
    const stored = readStore(JSON.parse(JSON.stringify(second)))

    assert.equal(second.past.length, 2, how)
    assert.equal(stored.dropped, 0, how)
    assert.deepEqual(stored.store, second, how)
    assert.deepEqual(marks(stored.store), [2000], how)
  })
})

check('expiry-guards', 'a date that has come ends a snooze only once the row can be judged: an unevaluated row, an id listed twice and an identity that cannot be read keep the record and show the row, a check whose rows are all unevaluated keeps its record, and a row that is gone or judged ends it', 'unit', ({ m }) => {
  const { evaluate, NOTES } = m.snoozes
  const due = (over) => rec({ until: { kind: 'date', expiresAt: 500 }, ...over })
  const at = (list, over = {}) => readOf(m, list, { GameTime: 600, ...over })
  const notesOf = (out) => [...out.rows.values()].map((entry) => entry.notes)
  const unevaluated = evaluate([due()], at([{ id: 'fleet:1', unevaluated: true }]))

  assert.deepEqual(unevaluated.ended, [])
  assert.deepEqual(notesOf(unevaluated), [[NOTES.unevaluated]])

  const twice = evaluate([due()], at([{ id: 'fleet:1' }, { id: 'fleet:1' }]))

  assert.deepEqual(twice.ended, [])
  assert.ok(notesOf(twice).length >= 1 && notesOf(twice).every((notes) => notes.length === 1 && notes[0] === NOTES.ambiguous))

  const stamped = due({ id: 'b1|test-check|item|ship:1', rowId: 'ship:1', stamp: 'ship:5,10' })

  ;[new Map(), new Map([['ship:1', null]])].forEach((stamps) => {
    const out = evaluate([stamped], at([{ id: 'ship:1' }]), stamps)

    assert.deepEqual(out.ended, [])
    assert.deepEqual(notesOf(out), [[NOTES.stamp]])
  })

  assert.deepEqual(reasons(evaluate([stamped], at([{ id: 'ship:1' }]), new Map([['ship:1', 'ship:5,10']]))), ['expired'])
  assert.deepEqual(reasons(evaluate([stamped], at([{ id: 'ship:1' }]), new Map([['ship:1', 'ship:5,11']]))), ['different'])
  assert.deepEqual(reasons(evaluate([due()], at([{ id: 'fleet:2' }]))), ['expired'])
  assert.deepEqual(reasons(evaluate([due()], at([{ id: 'fleet:1' }]))), ['expired'])
  assert.deepEqual(reasons(evaluate([due({ from: 'b0' })], at([{ id: 'fleet:1' }]))), ['expired'])
  assert.deepEqual(evaluate([due()], at([{ id: 'fleet:1', unevaluated: true }], { GameTime: 400 })).ended, [])

  const whole = checkRec({ until: { kind: 'date', expiresAt: 500 } })
  const unread = evaluate([whole], at([{ id: 'fleet:1', unevaluated: true }, { id: 'fleet:2', unevaluated: true }]))

  assert.deepEqual(unread.ended, [])
  assert.equal(unread.check.id, whole.id)
  assert.deepEqual(reasons(evaluate([whole], at([{ id: 'fleet:1', unevaluated: true }, { id: 'fleet:2' }]))), ['expired'])
  assert.deepEqual(reasons(evaluate([whole], at([]))), ['expired'])
  assert.deepEqual(reasons(evaluate([whole], at([{ id: 'fleet:2' }]))), ['expired'])
  assert.deepEqual(reasons(evaluate([whole], at([{ id: 'fleet:2' }], { GameTime: 500 }))), ['expired'])
  assert.deepEqual(reasons(evaluate([whole], at([{ id: 'fleet:2' }], { GameTime: 499 }))), [])
})

check('dates', 'the game date typed for a snooze is the game time of the save\'s calendar for starts in the year 1, 2050 and 4427, leap days included, and a snooze set to it ends exactly when the game time reaches it', 'unit', ({ m }) => {
  const { gameDateText, gameSecondsOf } = m.milestones
  const { evaluate } = m.snoozes
  const DAY = 86400

  ;[1, 2050, 4427].forEach((year) => {
    ;[0, 1, 59, 60, 365, 366, 1461, 4000].forEach((days) => {
      const seconds = days * DAY
      const text = gameDateText(year, seconds).slice(0, 10)
      const typed = gameSecondsOf(year, text)

      assert.equal(typed.ok, true, `${year} ${text}`)
      assert.equal(typed.seconds, seconds, `${year} ${text}`)
    })
  })

  assert.equal(gameDateText(2052, 59 * DAY).slice(0, 10), '2052-02-29')
  assert.equal(gameSecondsOf(2052, '2052-02-29').seconds, 59 * DAY)
  assert.equal(gameSecondsOf(2051, '2051-02-29').ok, false)
  assert.equal(gameSecondsOf(2050, '2049-12-31').ok, false)
  assert.equal(gameSecondsOf(2050, 'next week').ok, false)
  assert.equal(gameSecondsOf(2050, '2050-01-01 06:30').seconds, 6.5 * 3600)

  const expiresAt = gameSecondsOf(2050, '2050-03-01').seconds
  const r = rec({ until: { kind: 'date', expiresAt } })
  const read = (GameTime) => readOf(m, [{ id: 'fleet:1' }], { GameTime })

  assert.equal(stateOf(evaluate([r], read(expiresAt - 1)), 'fleet:1'), 'snoozed')
  assert.deepEqual(reasons(evaluate([r], read(expiresAt))), ['expired'])
})

check('bands', 'a band, a category and a signature are never made of an input that is not known: an unknown figure is no band, an unknown token makes no signature, and a real 0 is a band', 'unit', ({ m }) => {
  const { bandOf, categoriesOf, signatureOf, QUARTER } = m.common

  ;[null, undefined, NaN, 'x', {}].forEach((value) => assert.equal(bandOf(value, [0.75]), null, String(value)))
  assert.equal(bandOf(0, [0.75]), 0)
  assert.equal(bandOf(0.74, [0.75]), 0)
  assert.equal(bandOf(0.75, [0.75]), 1)
  assert.equal(bandOf(1, [0.25, 0.75]), 2)
  assert.equal(QUARTER, 0.25)
  assert.equal(categoriesOf(null), null)
  assert.equal(categoriesOf(undefined), null)
  assert.equal(categoriesOf('x'), null)
  assert.equal(categoriesOf(['b', 'a', 'b']), 'a,b')
  assert.equal(signatureOf('a', 0), 'a|0')
  ;[[null], [undefined], [''], ['a', null], ['a', undefined], ['a', '']].forEach((tokens) => assert.equal(signatureOf(...tokens), null, JSON.stringify(tokens)))
})

check('normalize', 'a row id the query gave twice keeps its raw id, marks both rows ambiguous and is made unique on the page, and a row given once is not ambiguous', 'unit', ({ m }) => {
  const rows = rowsOf(m, [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'a' }])

  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'a#2', 'a#3'])
  assert.deepEqual(rows.map((row) => row.raw), ['a', 'b', 'a', 'a'])
  assert.deepEqual(rows.map((row) => row.ambiguous), [true, false, true, true])
  assert.ok(rows.every((row) => Object.isFrozen(row)))
})

check('sig-mock', 'a signature is the band or the category of a declared field: a figure that grows inside a band changes nothing, a crossing does, and an input that is not stored makes none, never band 0', 'unit', async ({ m }) => {
  const read = async (key, rows, extra = {}) => m.common.normalizeRows(await m.index.CHECKS.find((entry) => entry.key === key).read({ GameID: 1, RaceID: 1, RaceNPR: false, separator: ',', options: DEFAULT_OPTIONS, count: m.common.counter(','), database: { query: async () => [rows] }, ...extra }), m.index.CHECKS.find((entry) => entry.key === key))
  const colony = (PopulationID, Efficiency) => ({ PopulationID, PopName: `Colony ${PopulationID}`, Efficiency, Population: 5, Verdict: 1 })
  const rows = await read('low-efficiency-populations', [colony(1, 0.5), colony(2, 0.6), colony(3, 0.8), colony(4, 0), colony(5, null), colony(6, 0.74), colony(7, 0.75)])
  const signatures = Object.fromEntries(rows.map((row) => [row.id, row.signature]))

  assert.equal(signatures['colony:1'], signatures['colony:2'])
  assert.notEqual(signatures['colony:1'], signatures['colony:3'])
  assert.equal(signatures['colony:4'], signatures['colony:1'])
  assert.equal(signatures['colony:6'], signatures['colony:1'])
  assert.equal(signatures['colony:7'], signatures['colony:3'])
  assert.equal(typeof signatures['colony:1'], 'string')
  assert.equal(signatures['colony:5'], null)
  assert.ok(rows.every((row) => !String(row.signature).includes('Colony')))
})

check('material-set', 'exactly the 24 checks of the classes B, C and K declare what a material change of a row is, and the other 20 declare none', 'unit', ({ m }) => {
  const declared = m.index.CHECKS.filter((entry) => entry.material).map((entry) => entry.key).sort()

  assert.deepEqual(declared, [...MATERIAL_KEYS].sort())
  assert.equal(m.index.CHECKS.length, 44)
  assert.ok(m.index.CHECKS.filter((entry) => entry.material).every((entry) => typeof entry.material === 'string' && entry.material.length > 10))
  assert.ok(m.index.CHECKS.filter((entry) => !entry.material).every((entry) => entry.material === undefined))
})

check('rename-stable', 'the damaged-ships signature is made of component ids, not names: renaming a component, or listing the same ones in another order, changes nothing, another component ends a material snooze and an id that cannot be read gives no signature', 'unit', async ({ m }) => {
  const entry = m.index.CHECKS.find((item) => item.key === 'damaged-ships')
  const rows = (items) => items.map(({ ComponentID, ComponentName }) => ({ ShipID: 7, FleetID: 1, ShipName: 'Ship', FleetName: 'Fleet', ShippingLineID: 0, Verdict: 1, ComponentID, ComponentName, ComponentCost: 10 }))
  const read = async (items) => m.common.normalizeRows(await entry.read({ GameID: 1, RaceID: 1, RaceNPR: false, separator: ',', options: DEFAULT_OPTIONS, count: m.common.counter(','), database: { query: async () => [rows(items)] } }), entry)
  const [original] = await read([{ ComponentID: 5, ComponentName: 'Original engine' }, { ComponentID: 6, ComponentName: 'Gun' }])
  const [renamed] = await read([{ ComponentID: 5, ComponentName: 'Renamed engine' }, { ComponentID: 6, ComponentName: 'Gun' }])
  const [reordered] = await read([{ ComponentID: 6, ComponentName: 'Gun' }, { ComponentID: 5, ComponentName: 'Original engine' }])
  const [other] = await read([{ ComponentID: 5, ComponentName: 'Original engine' }, { ComponentID: 8, ComponentName: 'Gun' }])
  const [unread] = await read([{ ComponentID: 5, ComponentName: 'Original engine' }, { ComponentID: null, ComponentName: 'Gun' }])

  assert.equal(typeof original.signature, 'string')
  assert.equal(original.signature, renamed.signature)
  assert.equal(original.signature, reordered.signature)
  assert.notEqual(original.signature, other.signature)
  assert.equal(unread.signature, null)

  const record = rec({ id: 'b1|test-check|item|fleet:7', rowId: 'fleet:7', until: { kind: 'material', signature: original.signature } })
  const judged = (row) => m.snoozes.evaluate([record], Object.freeze({ ok: true, rows: [{ ...row, raw: 'fleet:7', id: 'fleet:7' }], GameTime: 1000, options: {} }))

  assert.deepEqual(reasons(judged(renamed)), [])
  assert.deepEqual(reasons(judged(other)), ['changed'])
})

check('described', 'a signature is told in words from the check that made it: a band, a category list, a fixed word and the prerequisites of a mining site each read in the words of their band edges, a token that no reader knows shows as itself, never as a guess, and each of the 24 checks declares a reader per token', 'unit', ({ m }) => {
  const { describeSignature } = m.common
  const by = (key) => m.index.CHECKS.find((entry) => entry.key === key)

  assert.equal(describeSignature(by('low-morale-crews'), '0'), 'morale under 75%')
  assert.equal(describeSignature(by('low-morale-crews'), '1'), 'morale at 75% or more')
  assert.equal(describeSignature(by('low-morale-crews'), '7'), '7')
  assert.equal(describeSignature(by('armor-damaged-ships'), '0'), 'armour layer breached')
  assert.equal(describeSignature(by('armor-damaged-ships'), '1'), 'thinnest layer under 75% of the class thickness')
  assert.equal(describeSignature(by('armor-damaged-ships'), '2'), 'thinnest layer at 75% or more of the class thickness')
  assert.equal(describeSignature(by('idle-slipways'), '0'), 'idle share under 25% of the slipways')
  assert.equal(describeSignature(by('idle-slipways'), '1'), 'idle share at 25% or more of the slipways')
  assert.equal(describeSignature(by('damaged-ships'), '5'), '1 damaged component kind')
  assert.equal(describeSignature(by('damaged-ships'), '5,6'), '2 damaged component kinds')
  assert.equal(describeSignature(by('stalled-research-projects'), 'paused'), 'paused')
  assert.equal(describeSignature(by('mismatched-research-fields'), '3|4'), 'research field 3, specialty 4')
  assert.equal(describeSignature(by('known-unexploited-constructs'), 'dormant|unpopulated'), 'dormant, no colony of the race there')
  assert.equal(describeSignature(by('intruders'), 'hostile ships,neutral colonies'), 'hostile ships, neutral colonies')
  assert.equal(describeSignature(by('wasted-mining-capacity'), 'colony:deposit,colony:staffing'), 'no mineral deposit on the body, no workforce for the manned mines')
  assert.equal(describeSignature(by('wasted-mining-capacity'), 'weird:thing'), 'weird:thing')
  assert.equal(describeSignature(by('dangerous-rifts'), 'CivilianFleets,GroundUnitBases'), 'civilian fleets, ground unit bases')
  assert.equal(describeSignature(by('active-lifepods'), 'adrift'), 'adrift')
  assert.equal(describeSignature(by('low-morale-crews'), null), null)
  assert.equal(describeSignature(by('low-morale-crews'), ''), null)
  assert.equal(describeSignature({ key: 'none' }, '4'), '4')

  MATERIAL_KEYS.forEach((key) => assert.ok(Array.isArray(by(key).captured) && by(key).captured.length >= 1 && by(key).captured.every((reader) => typeof reader === 'function'), key))
  assert.ok(m.index.CHECKS.filter((entry) => !entry.material).every((entry) => entry.captured === undefined))
})

check('reset', 'a reset of the views keeps the snoozes with the permanent mutes, and clears the other views of the same empire', 'unit', ({ m }) => {
  const { empireViews, withoutViews } = m.remembered
  const store = { campaign: { c1: { race: { 784: { warningsSnoozed: { version: 1, seeded: {}, records: [] }, warningsMuted: { checks: ['intruders'], items: {} }, warningsFilters: { severity: null }, warningsShowSnoozed: true } } } } }

  assert.deepEqual(empireViews(store)[0].keys.sort(), ['warningsFilters', 'warningsShowSnoozed'])

  const cleared = withoutViews(store, [], { campaignId: 'c1', RaceID: 784 })

  assert.deepEqual(Object.keys(cleared.campaign.c1.race[784]).sort(), ['warningsMuted', 'warningsSnoozed'])
  assert.deepEqual(cleared.campaign.c1.race[784].warningsSnoozed, store.campaign.c1.race[784].warningsSnoozed)
  assert.deepEqual(Object.keys(withoutViews(store, []).campaign.c1.race[784]).sort(), ['warningsMuted', 'warningsSnoozed'])
})

check('stamps-read', 'the identity stamp of an object is its class and construction time (a ship), body (a colony), career and species (a commander) or class and place (a wreck), floats cut to six decimals, and unknown while a column, the object or the read is missing', 'unit', async ({ m }) => {
  const { readStamps, isStamped, namespaceOf, stampSql } = m.snoozes
  const calls = []
  const database = mockDatabase({
    FCT_Ship: [{ StampKey: 1, ShipClassID: 5, Constructed: 10.1234567891 }, { StampKey: 2, ShipClassID: 5, Constructed: 20 }, { StampKey: 3, ShipClassID: 5, Constructed: null }, { StampKey: 5, ShipClassID: 5, Constructed: 10.1234571 }, { StampKey: 6, ShipClassID: 6, Constructed: 10.123457 }],
    FCT_Population: [{ StampKey: 7, SystemBodyID: 9 }, { StampKey: 9, SystemBodyID: 9 }],
    FCT_Commander: [{ StampKey: 11, CareerStart: 0, Female: 0, SpeciesID: 3 }, { StampKey: 12, CareerStart: 0, Female: 1, SpeciesID: 3 }],
    FCT_Wrecks: [{ StampKey: 21, ShipID: 4, SystemID: 5, ClassID: 6 }, { StampKey: 22, ShipID: 4, SystemID: 5, ClassID: 7 }],
  }, calls)
  const ids = ['ship:1', 'ship:2', 'ship:3', 'ship:4', 'ship:5', 'ship:6', 'ship:x', 'colony:7', 'colony:8', 'colony:9', 'commander:11', 'commander:12', 'wreck:21', 'wreck:22', 'fleet:1', 'system:2', 'ship:1']
  const stamps = await readStamps(database, 141, ids)

  assert.equal(typeof stamps.get('ship:1'), 'string')
  assert.notEqual(stamps.get('ship:1'), stamps.get('ship:2'))
  assert.equal(stamps.get('ship:1'), stamps.get('ship:5'))
  assert.notEqual(stamps.get('ship:1'), stamps.get('ship:6'))
  assert.equal(stamps.get('ship:3'), null)
  assert.equal(stamps.get('ship:4'), null)
  assert.equal(stamps.get('ship:x'), null)
  assert.equal(stamps.get('colony:7'), stamps.get('colony:9'))
  assert.equal(stamps.get('colony:8'), null)
  assert.notEqual(stamps.get('commander:11'), stamps.get('commander:12'))
  assert.notEqual(stamps.get('wreck:21'), stamps.get('wreck:22'))
  assert.equal(stamps.has('fleet:1'), false)
  assert.equal(stamps.has('system:2'), false)
  assert.ok(calls.length >= 4 && calls.every((sql) => /^select /.test(sql) && sql.includes('GameID = 141')))
  assert.ok(calls.every((sql) => !/[^0-9, ()]\s*x\b/.test(sql.split(' in ')[1])))
  assert.equal(namespaceOf('rift:1:2:3'), 'rift')
  assert.equal(isStamped('rift:1:2:3'), false)
  assert.ok(stampSql('ship', 7, [1, 2]).includes('FCT_Ship.ShipID in (1, 2)'))

  const failing = await readStamps(mockDatabase({ FCT_Ship: new Error('disk I/O error'), FCT_Population: [{ StampKey: 7, SystemBodyID: 9 }] }), 141, ['ship:1', 'colony:7'])

  assert.equal(failing.get('ship:1'), null)
  assert.equal(typeof failing.get('colony:7'), 'string')
  assert.deepEqual([...(await readStamps(mockDatabase({}), 141, ['fleet:1', 'project:2'])).keys()], [])
})

check('voice', 'what the page says of a snooze is impersonal: no I, me, my, mine, you, your, we or our in a note, an ended reason or the page\'s text', 'unit', ({ m }) => {
  const pronoun = /\b(I|me|my|mine|you|your|yours|we|our|ours)\b/i
  const strings = [...Object.values(m.snoozes.NOTES), ...Object.values(m.snoozes.ENDED), m.snoozes.untilText(rec(), String), m.snoozes.untilText(checkRec(), String), m.snoozes.untilText(rec({ until: { kind: 'date', expiresAt: 5 } }), (seconds) => `day ${seconds}`), m.snoozes.untilText(rec({ until: { kind: 'material', signature: 'a' } }), String)]
  const page = fs.readFileSync(path.join(m.pages, 'warnings.vue'), 'utf8')
  const template = page.slice(page.indexOf('<template>'), page.indexOf('</template>\n\n<script>'))
  const shown = [...template.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((match) => match[1]).concat([...template.matchAll(/(?:label|title|aria-label)="([^"]+)"/g)].map((match) => match[1]), [...template.matchAll(/'([^']+)'/g)].map((match) => match[1]))
  const scripted = [...page.slice(page.indexOf('<script>')).matchAll(/`([^`]*)`|'([^'\n]{12,})'/g)].map((match) => match[1] || match[2])

  assert.ok(strings.length >= 12 && shown.length > 20 && scripted.length > 20)
  ;[...strings, ...shown, ...scripted].forEach((text) => assert.ok(!pronoun.test(text), text))
})

// ---------- the page, run for real ----------

// The page's own options (its mixins, its computed values, its watchers and its reads, through the real load tracking and the async computed plugin) in Vue 2.7 without a template, over the real checks on a real save, with a store that is a plain object: nothing here is a copy of what the page does.
Vue.config.productionTip = false
Vue.config.devtools = false
Vue.config.silent = true
Vue.use(require('vue-async-computed').default, { errorHandler: () => {} })

const pageErrors = []

Vue.config.errorHandler = (error) => pageErrors.push(error)
process.on('unhandledRejection', (error) => pageErrors.push(error))

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (test, what, limit = 60000) => {
  const began = Date.now()

  for (;;) {
    const value = test()

    if (value) {
      return value
    }

    if (Date.now() - began > limit) {
      throw new Error(`the page did not reach: ${what}`)
    }

    await pause()
  }
}

const readNameOf = (entry) => `read${entry.key.replace(/(^|-)(\w)/g, (_match, _dash, letter) => letter.toUpperCase())}`

const pageScript = () => {
  const parsed = parseComponent({ source: fs.readFileSync(path.join(pagesDirectory, 'warnings.vue'), 'utf8') })

  return (parsed.descriptor || parsed).script.content
}

const pageOptionsOf = (m) => {
  if (!m.pageOptions) {
    // The loader reads a utility by its file, so the folder of the checks is named by its index.
    const mutate = (text) => m.pageEdits.reduce((current, [from, to]) => patched('warnings.js', current, from, to), text.replace('from \'../utilities/warnings\'', 'from \'../utilities/warnings/index\''))

    m.pageOptions = loadPage('pages/warnings', { stubs: STUBS, modules: { 'mixins/load-state': null }, mutate })
  }

  return m.pageOptions
}

const mountPage = async (m, { save = 'modded', world: overrides = {}, config = memoryConfig() } = {}) => {
  const spec = SAVES[save]
  const real = databaseOf(spec.file)
  const control = { broken: false, gates: [], held: 0, inflight: 0, hold: null }

  const wrap = () => Object.freeze({
    transaction: real.transaction,
    query: async (sql) => {
      control.inflight++

      try {
        if (control.broken) {
          // The page's modules are loaded from data: URLs, so a formatted stack of an error made here is tens of megabytes, and the async-computed plugin formats every one it catches.
          const failure = new Error('disk I/O error')

          failure.stack = 'Error: disk I/O error'
          throw failure
        }

        if (control.hold && sql.includes(control.hold.match)) {
          await control.hold.gate
        }

        if (sql.includes('StampKey') && control.gates.length) {
          const gate = control.gates.shift()

          control.held++
          await gate
        }

        return await real.query(sql)
      } finally {
        control.inflight--
      }
    },
  })

  const [[game]] = await real.query(`select FCT_Game.GameTime, FCT_Game.StartYear from FCT_Game where FCT_Game.GameID = ${spec.game}`)
  const prefix = m.campaign.raceKeyPrefix('c1', spec.race)
  const world = Vue.observable({ GameTime: game.GameTime, StartYear: game.StartYear, branchId: 'b1', generation: 1, prefix, database: wrap(), ...overrides })
  const getters = {}
  const define = (name, get) => Object.defineProperty(getters, name, { get, enumerable: true })

  define('config', () => config)
  define('database', () => world.database)
  define('GameID', () => spec.game)
  define('RaceID', () => spec.race)
  define('GameTime', () => world.GameTime)
  define('StartYear', () => world.StartYear)
  define('racePrefix', () => world.prefix)
  define('campaignId', () => 'c1')
  define('history/campaign', () => ({ branchId: world.branchId }))

  const $store = { getters, state: { RaceNPR: false, get freshness () { return { generation: world.generation, inputs: {} } } }, commit: () => {}, dispatch: () => {} }
  const options = await pageOptionsOf(m)
  const vm = new Vue({ ...options, beforeCreate () { this.$store = $store } })

  // No template is mounted (there is no DOM), and the plugin refreshes a read on request only once its mounted hook has run, so the flag that hook sets is set here.
  vm._asyncComputedIsMounted = true

  return { m, vm, world, control, config, prefix, key: `${prefix}.warningsSnoozed`, rewire: () => { world.database = wrap() } }
}

const withPage = async (m, options, work) => {
  pageErrors.length = 0

  const page = await mountPage(m, options)

  try {
    await work(page)
    await pause(30)
    assert.deepEqual(pageErrors.map(String), [], 'the page raised errors')
  } finally {
    page.vm.$destroy()
  }
}

const loaded = async (page) => {
  await until(() => page.vm.ready, 'every read settled')
  await until(() => page.control.inflight === 0, 'the reads to end')
  await pause(60)
}

const pickRow = (page, { stamped = false, material = false, count = 1 } = {}) => {
  for (const state of page.vm.checkStates) {
    if (state.failure || (material && !state.check.material)) {
      continue
    }

    const usable = state.rows.filter((row) => !row.ambiguous && (!stamped || page.m.snoozes.isStamped(row.raw)) && (!material || typeof row.signature === 'string'))

    if (usable.length >= count) {
      return { check: state.check, rows: usable }
    }
  }

  return null
}

const snooze = async (page, check, row, kind = 'clear', reason = '') => {
  await page.vm.openSnooze(check, row)

  if (!page.vm.snoozing) {
    return 'the dialog did not open'
  }

  page.vm.snoozing.kind = kind
  page.vm.snoozing.reason = reason
  page.vm.submitSnooze()

  return page.vm.snoozing === null ? null : page.vm.snoozing.error
}

const storedOf = (page) => page.m.snoozes.readStore(page.config.get(page.key))

const sectionOf = (page, check) => page.vm.sections.find((entry) => entry.check === check)

check('page-mute', 'on the page a permanent mute outranks a snooze: a muted row or a muted check is not held, counted or shown as snoozed, and the snooze comes back with the unmute', 'page', async ({ m }) => {
  await withPage(m, {}, async (page) => {
    await loaded(page)

    const picked = pickRow(page, { count: 2 })

    assert.ok(picked, 'no check lists two rows on the save')

    const { check, rows: [first, second] } = picked

    assert.equal(await snooze(page, check, first), null)
    assert.equal(await snooze(page, check, second), null)
    await until(() => page.vm.summary.snoozedRows === 2, 'two snoozed rows')
    assert.deepEqual([...sectionOf(page, check).snoozedIds].sort(), [first.id, second.id].sort())

    page.vm.toggleRowMuted(check.key, first.id)
    assert.deepEqual([...sectionOf(page, check).snoozedIds], [second.id])
    assert.equal(page.vm.summary.snoozedRows, 1)
    page.vm.toggleRowMuted(check.key, first.id)
    assert.equal(sectionOf(page, check).snoozedIds.size, 2)

    page.vm.toggleCheckMuted(check.key)
    assert.equal(sectionOf(page, check).snoozedIds.size, 0)
    assert.equal(page.vm.summary.snoozedRows, 0)
    page.vm.toggleCheckMuted(check.key)
    assert.equal(page.vm.summary.snoozedRows, 2)
    assert.equal(storedOf(page).store.records.length, 2)
    assert.deepEqual(page.config.get(`${page.prefix}.warningsMuted`), { checks: [], items: {} })
  })
})

check('page-clock', 'on the page a game time or a start year that is not read is never a date: with either unread no date can be chosen and no snooze is made, and with both read a date snooze is made at the game time of the save', 'page', async ({ m }) => {
  for (const world of [{ StartYear: 1, GameTime: null }, { StartYear: 1, GameTime: undefined }, { StartYear: 1, GameTime: '' }, { StartYear: 0 }]) {
    await withPage(m, { world }, async (page) => {
      await loaded(page)
      assert.equal(page.vm.clockTime, null, JSON.stringify(world))
      assert.ok(page.vm.dateRefusal, JSON.stringify(world))

      const picked = pickRow(page)

      assert.ok(picked, JSON.stringify(world))
      await page.vm.openSnooze(picked.check, picked.rows[0])
      assert.equal(page.vm.snoozing.kind, 'clear')

      for (const [kind, dateText] of [['date', '0001-01-31'], ['clear', '']]) {
        page.vm.snoozing.kind = kind
        page.vm.snoozing.dateText = dateText
        page.vm.submitSnooze()
        assert.ok(page.vm.snoozing && page.vm.snoozing.error, `${kind} with ${JSON.stringify(world)}`)
      }

      assert.deepEqual(storedOf(page).store.records, [])
    })
  }

  await withPage(m, {}, async (page) => {
    await loaded(page)
    assert.equal(page.vm.clockTime, Number(page.world.GameTime))
    assert.equal(page.vm.dateRefusal, null)

    const picked = pickRow(page)

    assert.equal(await snooze(page, picked.check, picked.rows[0], 'date'), null)

    const [record] = storedOf(page).store.records

    assert.equal(record.setAt, Number(page.world.GameTime))
    assert.ok(record.until.expiresAt > record.setAt && record.until.expiresAt <= record.setAt + 31 * 86400)
  })
})

check('page-guards', 'on the page an evaluation that the save, the branch, the campaign or the read has moved past while the identity of the objects was being read changes nothing, and the same evaluation with nothing moved applies', 'page', async ({ m }) => {
  await withPage(m, {}, async (page) => {
    await loaded(page)

    const picked = pickRow(page, { stamped: true })

    assert.ok(picked, 'no check lists a ship, colony, commander or wreck row on the save')

    const { check, rows: [row] } = picked
    const name = readNameOf(check)

    assert.equal(await snooze(page, check, row), null)
    await until(() => page.vm.summary.snoozedRows === 1 && page.vm.evaluations[check.key], 'the snooze to apply')
    await pause(60)

    const held = async (act) => {
      const release = []

      page.control.held = 0
      page.control.gates = [0, 1].map(() => new Promise((resolve) => release.push(resolve)))

      const pending = page.vm.evaluateSnoozes()

      await until(() => page.control.held === 1, 'the identity read of the evaluation')
      await act(release)
      await pause(40)

      const before = page.vm.evaluations

      release.forEach((resolve) => resolve())
      await pending
      await pause(60)
      page.control.gates = []

      return { before, after: page.vm.evaluations }
    }

    const settled = async () => {
      await page.vm.evaluateSnoozes()
      await until(() => page.vm.summary.snoozedRows === 1, 'the snooze to apply again')
    }

    const plain = await held(async () => {})

    assert.notEqual(plain.after, plain.before, 'an evaluation that nothing moved past was not applied')

    const generation = await held(async () => { page.world.generation += 1 })

    assert.equal(generation.after, generation.before, 'applied after the save was read again')

    const branch = await held(async () => { page.world.branchId = 'b2' })

    assert.equal(branch.after, branch.before, 'applied on another branch')
    page.world.branchId = 'b1'
    await settled()

    const campaign = await held(async () => { page.world.prefix = `${page.prefix}-other` })

    assert.equal(campaign.after, campaign.before, 'applied in another campaign')
    page.world.prefix = page.prefix
    await pause(40)
    await settled()

    const replaced = await held(async (release) => {
      page.vm.$asyncComputed[name].update()
      await until(() => page.control.held >= 2, 'the evaluation of the newer read to reach its identity read')
      release[1]()
      await pause(60)
    })

    assert.equal(replaced.after, replaced.before, 'an evaluation of a replaced read was applied after the newer one')
    assert.equal(page.vm.evaluations[check.key].read, page.vm[name])
    assert.equal(page.vm.summary.snoozedRows, 1, 'the row came back from a replaced read')
  })
})

check('page-store', 'on the page a store of snoozes that cannot be read is shown as unavailable with its reason and is never written over, by a new snooze or a cancel, and one that cannot be written says so', 'page', async ({ m }) => {
  const unreadable = { version: 99, seeded: {}, records: [{ keep: 'me' }] }
  const config = memoryConfig()

  config.set(`${m.campaign.raceKeyPrefix('c1', SAVES.modded.race)}.warningsSnoozed`, unreadable)

  await withPage(m, { config }, async (page) => {
    await loaded(page)
    assert.ok(page.vm.snoozeProblem)

    const picked = pickRow(page)

    assert.ok(await snooze(page, picked.check, picked.rows[0]))
    page.vm.cancelSnooze({ id: 'nobody' })
    await page.vm.evaluateSnoozes()
    assert.deepEqual(page.config.get(page.key), unreadable)
  })

  await withPage(m, {}, async (page) => {
    await loaded(page)
    assert.equal(page.vm.snoozeProblem, null)

    const picked = pickRow(page)
    const set = page.config.set

    page.config.set = () => { throw new Error('disk full') }

    const error = await snooze(page, picked.check, picked.rows[0])

    page.config.set = set
    assert.match(error, /could not be written/)
    assert.deepEqual(storedOf(page).store.records, [])
    assert.equal(await snooze(page, picked.check, picked.rows[0]), null)
    assert.equal(storedOf(page).store.records.length, 1)
  })
})

check('page-retry', 'on the page a check that failed to read and reads again through Retry has its snoozes applied again with no other action, and the stored snooze is untouched while it failed', 'page', async ({ m }) => {
  await withPage(m, {}, async (page) => {
    await loaded(page)

    const picked = pickRow(page, { stamped: true }) || pickRow(page)
    const { check, rows: [row] } = picked

    assert.equal(await snooze(page, check, row), null)
    await until(() => page.vm.summary.snoozedRows === 1 && sectionOf(page, check).snoozedIds.has(row.id), 'the row to be snoozed')

    page.control.broken = true
    page.rewire()
    await until(() => page.vm.ready && page.vm.checkStates.every((state) => state.failure), 'every read to fail')
    await pause(60)
    assert.equal(storedOf(page).store.records.length, 1)

    page.control.broken = false
    page.vm.retryFailedInputs()
    await until(() => page.vm.failedInputs.length === 0, 'the retry to settle')
    await until(() => page.vm.summary.snoozedRows === 1 && sectionOf(page, check).snoozedIds.has(row.id), 'the snooze to apply again', 15000)
    assert.equal(storedOf(page).store.records.length, 1)
  })
})

check('page-refresh', 'on the page a save read again keeps its snoozes applied whichever read settles last: with the ship classes the last to come in, the snoozes are judged once every read is in', 'page', async ({ m }) => {
  await withPage(m, {}, async (page) => {
    await loaded(page)

    const picked = pickRow(page)

    assert.ok(picked, 'no check lists a row on the save')

    const { check, rows: [row] } = picked

    assert.equal(await snooze(page, check, row), null)
    await until(() => page.vm.summary.snoozedRows === 1 && sectionOf(page, check).snoozedIds.has(row.id), 'the row to be snoozed')

    let release = null
    const others = () => Object.entries(page.vm.loadErrors).filter(([key]) => key !== 'shipClasses').every(([, value]) => value === null)

    page.control.hold = { match: 'FCT_ShipClass.ClassShippingLineID = 0 order by', gate: new Promise((resolve) => { release = resolve }) }
    page.rewire()
    await until(() => page.vm.loadErrors.shipClasses === undefined && page.control.inflight === 1 && others(), 'every read but the ship classes to settle')
    await pause(100)
    assert.equal(page.vm.ready, false, 'the page was ready with a read in flight')
    assert.ok(others(), 'a read was not settled')

    page.control.hold = null
    release()
    await until(() => page.vm.ready, 'the ship classes to settle')
    await until(() => page.vm.summary.snoozedRows === 1 && sectionOf(page, check).snoozedIds.has(row.id), 'the snooze to apply again', 15000)
    assert.equal(storedOf(page).store.records.length, 1)
  })
})

check('page-prune', 'on the page a store whose ended snoozes pass the limit is cut to it when the next snooze is written', 'page', async ({ m }) => {
  await withPage(m, {}, async (page) => {
    await loaded(page)

    const { PAST_LIMIT, addRecord, emptyStore, endRecords } = m.snoozes
    const ids = Array.from({ length: PAST_LIMIT + 5 }, (_unused, index) => `b1|test-check|item|fleet:${index}`)
    const big = ids.reduce((store, id, index) => endRecords(addRecord(store, { ...rec({ id, rowId: `fleet:${index}`, setAt: 1 }) }), [{ id, at: 2, reason: 'cancelled' }]), emptyStore())

    assert.equal(big.past.length, PAST_LIMIT + 5)
    page.config.set(page.key, big)

    const picked = pickRow(page)

    assert.ok(picked, 'no check lists a row on the save')
    assert.equal(await snooze(page, picked.check, picked.rows[0]), null)
    assert.equal(storedOf(page).store.past.length, PAST_LIMIT)
    assert.equal(storedOf(page).store.records.length, 1)
  })
})

check('page-text', 'on the page a snooze until a material change shows the change it ends on and the condition it was set under in the words of its check, for a row and for each row of the whole check', 'page', async ({ m }) => {
  await withPage(m, {}, async (page) => {
    await loaded(page)

    const picked = pickRow(page, { material: true })

    assert.ok(picked, 'no check with a declared change lists a row with a signature on the save')

    const { check, rows: [row] } = picked

    assert.equal(await snooze(page, check, row, 'material', 'waiting for the refit'), null)

    const [record] = storedOf(page).store.records
    const text = page.vm.snoozeText(record)
    const words = m.common.describeSignature(check, record.until.signature)

    assert.ok(text.includes(check.material), text)
    assert.ok(text.includes(words), text)
    assert.notEqual(words, record.until.signature)
    assert.ok(text.includes('waiting for the refit'), text)
    page.vm.cancelSnooze(record)
    assert.equal(storedOf(page).store.records.length, 0)

    const whole = page.vm.checkStates.find((state) => !state.failure && state.check.material && state.rows.length && state.rows.every((item) => !item.ambiguous && typeof item.signature === 'string'))

    assert.ok(whole, 'no check with a declared change has every row signed on the save')
    assert.equal(await snooze(page, whole.check, null, 'material'), null)

    const named = page.vm.snoozeText(storedOf(page).store.records[0])
    const [one] = whole.rows

    assert.ok(named.includes(`${page.vm.cellText(one, whole.check.columns[0])}: ${m.common.describeSignature(whole.check, one.signature)}`), named)

    if (whole.rows.length > 5) {
      assert.ok(named.includes(`and ${whole.rows.length - 5} more`), named)
    }
  })
})

// ---------- the saves ----------

const eligible = (read) => (read.ok ? read.rows.filter((row) => !row.unevaluated && !row.ambiguous) : [])

const STAMP_TABLES = { ship: ['FCT_Ship', 'ShipID', 'ShipClassID, Constructed'], colony: ['FCT_Population', 'PopulationID', 'SystemBodyID'], commander: ['FCT_Commander', 'CommanderID', 'CareerStart, Female, SpeciesID'], wreck: ['FCT_Wrecks', 'WreckID', 'ShipID, SystemID, ClassID'] }

// The tuple that tells one object from another under an id, as SQL written here reads it (the table and the columns named in the snooze evidence, not the module's), by the id of the row: { 'ship:12': '[5,1.5]' }.
const tuplesOf = async (database, GameID) => {
  const tuples = {}

  for (const [namespace, [table, key, columns]] of Object.entries(STAMP_TABLES)) {
    const [rows] = await database.query(`select ${table}.${key} as K, ${columns.split(', ').map((column) => `${table}.${column} as ${column}`).join(', ')} from ${table} where ${table}.GameID = ${GameID}`)

    rows.forEach((row) => {
      const { K, ...rest } = row

      tuples[`${namespace}:${K}`] = Object.values(rest).includes(null) ? null : JSON.stringify(Object.values(rest).map((value) => (typeof value === 'number' ? Math.round(value * 1000000) / 1000000 : value)))
    })
  }

  return tuples
}

const rowIds = (read) => (read.ok ? read.rows.map((row) => row.raw) : [])

check('sig-real', 'on every save each row of the 24 checks carries a signature that is a non-empty text or null, and in words a reader of its check tells each of its tokens; a check that is not read, and checks that list nothing, are said and never counted as agreement', 'reads', async ({ m, ctx }) => {
  await ctx.saves(ctx.keys)

  const signed = {}
  let rowsSeen = 0

  for (const key of ctx.keys) {
    const { reads } = await ctx.save(key)

    for (const checkKey of MATERIAL_KEYS) {
      const read = reads[checkKey]

      assert.equal(read.ok, true, `${key} ${checkKey}: ${read.error}`)
      read.rows.filter((row) => !row.unevaluated).forEach((row) => {
        rowsSeen++
        assert.ok(row.signature === null || (typeof row.signature === 'string' && row.signature !== ''), `${key} ${checkKey} ${row.id}: ${JSON.stringify(row.signature)}`)

        if (typeof row.signature === 'string') {
          const entry = m.index.CHECKS.find((item) => item.key === checkKey)
          const tokens = row.signature.split('|')

          assert.equal(entry.captured.length, tokens.length, `${key} ${checkKey} ${row.signature}`)
          tokens.forEach((token, index) => assert.ok(typeof entry.captured[index](token) === 'string' && entry.captured[index](token) !== '', `${key} ${checkKey} token ${token}`))
        }

        if (row.signature !== null) {
          signed[checkKey] = (signed[checkKey] || 0) + 1
        }
      })
    }
  }

  console.log(`         ${rowsSeen} rows; signed rows by check: ${Object.entries(signed).map(([name, count]) => `${name} ${count}`).join(', ')}`)
  assert.ok(Object.keys(signed).length >= ctx.minSigned, `only ${Object.keys(signed).length} of the checks list a row with a signature`)
})

check('sig-stable', 'a second read of a save gives every row the same signature, so nothing that moves by itself between two reads is in one', 'reads', async ({ m, ctx }) => {
  for (const key of ctx.fast) {
    const first = (await ctx.save(key)).reads
    const second = (await readSave(m, key)).reads

    MATERIAL_KEYS.forEach((checkKey) => assert.deepEqual(second[checkKey].rows.map((row) => [row.id, row.signature]), first[checkKey].rows.map((row) => [row.id, row.signature]), `${key} ${checkKey}`))
  }
})

check('sig-names', 'no signature is made of the name of the row it describes', 'reads', async ({ ctx }) => {
  await ctx.saves(ctx.keys)

  let compared = 0

  for (const key of ctx.keys) {
    const { reads } = await ctx.save(key)

    MATERIAL_KEYS.forEach((checkKey) => reads[checkKey].rows.filter((row) => typeof row.signature === 'string').forEach((row) => {
      const cell = row.cells[Object.keys(row.cells)[0]]
      const name = String(cell !== null && typeof cell === 'object' ? cell.text : cell)

      compared++

      if (name.length >= 6) {
        assert.ok(!row.signature.includes(name), `${key} ${checkKey}: ${row.signature}`)
      }
    }))
  }

  assert.ok(compared > 0)
})

check('stamps-real', 'on the saves the identity stamp of every ship, colony, commander and wreck a check lists is read, and two objects have one stamp exactly when SQL written here reads one tuple for them', 'reads', async ({ m, ctx }) => {
  let objects = 0
  const keys = ctx.keys.filter((key) => ctx.fast.includes(key) || key.startsWith('f29') || key === 'stock')

  await ctx.saves(keys)

  const byStamp = new Map()
  const byTuple = new Map()

  for (const key of keys) {
    const { reads, save, database } = await ctx.save(key)
    const ids = [...new Set(Object.values(reads).flatMap(rowIds))].filter(m.snoozes.isStamped)
    const stamps = await m.snoozes.readStamps(database, save.game, ids)
    const tuples = await tuplesOf(database, save.game)

    for (const id of ids) {
      const stamp = stamps.get(id)

      if (tuples[id] === undefined || tuples[id] === null) {
        assert.equal(stamp, null, `${key} ${id}: no tuple is stored, so no stamp`)
        continue
      }

      objects++
      assert.equal(typeof stamp, 'string', `${key} ${id}`)
      assert.ok(!byStamp.has(stamp) || byStamp.get(stamp) === tuples[id], `${key} ${id}: one stamp, two tuples`)
      assert.ok(!byTuple.has(tuples[id]) || byTuple.get(tuples[id]) === stamp, `${key} ${id}: one tuple, two stamps`)
      byStamp.set(stamp, tuples[id])
      byTuple.set(tuples[id], stamp)
    }
  }

  console.log(`         ${objects} objects stamped on ${keys.length} saves`)
  assert.ok(objects > ctx.minObjects, `${objects} objects`)
})

check('real-hide', 'on every save every row of every check that can be snoozed is held by a snooze to clear, to a date and to a declared change, a row that cannot be evaluated or is listed twice cannot be snoozed, and the date ends them all when it comes', 'reads', async ({ m, ctx }) => {
  const { makeRecord, evaluate, readStamps } = m.snoozes
  await ctx.saves(ctx.keys)

  let held = 0
  let refused = 0

  for (const key of ctx.keys) {
    const { reads, save, database } = await ctx.save(key)
    const checkOf = (checkKey) => m.index.CHECKS.find((entry) => entry.key === checkKey)
    let savedHeld = 0

    for (const [checkKey, read] of Object.entries(reads)) {
      if (!read.ok) {
        continue
      }

      const stamps = await readStamps(database, save.game, rowIds(read))
      const records = []
      const snoozable = eligible(read).filter((row) => !m.snoozes.isStamped(row.raw) || typeof stamps.get(row.raw) === 'string')

      eligible(read).forEach((row) => {
        ;[{ kind: 'clear' }, { kind: 'date', expiresAt: read.GameTime + 86400 * 30 }, ...(checkOf(checkKey).material && typeof row.signature === 'string' ? [{ kind: 'material' }] : [])].forEach((over) => {
          const made = makeRecord({ check: checkOf(checkKey), scope: 'item', row, read, stamps, branch: 'b1', ...over })

          if (made.ok) {
            records.push(made.record)
          } else {
            refused++
          }
        })
      })

      read.rows.filter((row) => row.unevaluated || row.ambiguous).forEach((row) => assert.equal(makeRecord({ check: checkOf(checkKey), scope: 'item', kind: 'clear', row, read, stamps, branch: 'b1' }).ok, false, `${key} ${checkKey} ${row.id}`))

      const out = evaluate(records, read, stamps)

      assert.deepEqual(out.ended, [], `${key} ${checkKey}`)
      assert.deepEqual([...out.rows.values()].filter((entry) => entry.state !== 'snoozed'), [], `${key} ${checkKey}`)
      assert.equal(out.rows.size, snoozable.length, `${key} ${checkKey}: ${out.rows.size} held, ${snoozable.length} snoozable`)
      held += out.rows.size
      savedHeld += out.rows.size

      const later = evaluate(records, Object.freeze({ ...read, GameTime: read.GameTime + 86400 * 30 }), stamps)

      assert.deepEqual([...new Set(reasons(later))], records.some((record) => record.until.kind === 'date') ? ['expired'] : [], `${key} ${checkKey}`)
      assert.equal(reasons(later).length, records.filter((record) => record.until.kind === 'date').length, `${key} ${checkKey}`)
    }

    console.log(`         ${key}: ${savedHeld} rows held`)
    assert.ok(savedHeld > 0 || key === 'stock', `${key}: no row to hold`)
  }

  assert.ok(held > ctx.minHeld, `${held} rows held`)
  console.log(`         ${refused} records refused: a stamped row whose stamp was not read`)
})

check('real-fail', 'a read that fails leaves every snooze of the check alone, whatever the rows of the save say, and the reads of the page that fail are the ones the page marks as failed', 'reads', async ({ m, ctx }) => {
  const { evaluate, makeRecord } = m.snoozes

  await ctx.saves(ctx.fast)

  for (const key of ctx.fast) {
    const { reads, save } = await ctx.save(key)
    const broken = { query: async () => { throw new Error('disk I/O error') } }
    let failed = 0
    let guarded = 0

    for (const entry of m.index.CHECKS) {
      const read = reads[entry.key]

      try {
        await entry.read({ database: broken, GameID: save.game, RaceID: save.race, RaceNPR: false, separator: ',', count: m.common.counter(','), options: DEFAULT_OPTIONS, GameTime: read.GameTime })
      } catch (error) {
        failed++

        const records = eligible(read).slice(0, 20).map((row) => makeRecord({ check: entry, scope: 'item', kind: 'clear', row, read, stamps: new Map(eligible(read).filter((listed) => m.snoozes.isStamped(listed.raw)).map((listed) => [listed.raw, 's'])), branch: 'b1' })).filter((made) => made.ok).map((made) => made.record)
        const out = evaluate([...records, ...(eligible(read).length ? [makeRecord({ check: entry, scope: 'check', kind: 'clear', read, branch: 'b1' }).record] : [])], { ok: false, rows: [], GameTime: read.GameTime + 1e9, options: {} })

        assert.equal(out.failed, true)
        assert.deepEqual(out.ended, [])
        assert.equal(out.rows.size, 0)
        guarded += records.length
      }
    }

    assert.ok(failed >= 40, `${key}: only ${failed} checks failed on a broken save`)
    console.log(`         ${key}: ${failed} reads failed, ${guarded} item snoozes left alone`)
  }
})

check('rewind-real', 'a snooze set at a later save and judged on an earlier one of the same game ends nothing, on every check', 'reads', async ({ m, ctx }) => {
  const { makeRecord, evaluate, readStamps } = m.snoozes
  const pairs = [['f2930673230', 'f2904201340'], ['f2740177930', 'f2398452450'], ['f2794985390', 'f2740177930']].filter(([later, earlier]) => ctx.keys.includes(later) && ctx.keys.includes(earlier))

  assert.ok(pairs.length >= (ctx.keys.some((key) => key.startsWith('f')) ? 2 : 0))

  await ctx.saves(pairs.flat())

  let kept = 0
  let shown = 0

  for (const [laterKey, earlierKey] of pairs) {
    const later = await ctx.save(laterKey)
    const earlier = await ctx.save(earlierKey)

    assert.ok(later.GameTime > earlier.GameTime)

    for (const entry of m.index.CHECKS) {
      const newer = later.reads[entry.key]
      const older = earlier.reads[entry.key]

      if (!newer.ok || !older.ok) {
        continue
      }

      const newerStamps = await readStamps(later.database, later.save.game, rowIds(newer))
      const olderStamps = await readStamps(earlier.database, earlier.save.game, rowIds(older))
      const records = eligible(newer).flatMap((row) => [makeRecord({ check: entry, scope: 'item', kind: 'clear', row, read: newer, stamps: newerStamps, branch: 'b1' }), makeRecord({ check: entry, scope: 'item', kind: 'date', expiresAt: newer.GameTime + 1000, row, read: newer, stamps: newerStamps, branch: 'b1' })]).filter((made) => made.ok).map((made) => made.record)
      const out = evaluate(records, older, olderStamps)

      assert.deepEqual(out.ended, [], `${laterKey} on ${earlierKey}: ${entry.key}`)
      kept += records.length
      shown += [...out.rows.values()].filter((entryRow) => entryRow.state === 'shown').length
    }
  }

  console.log(`         ${kept} snoozes kept on ${pairs.length} rewinds, ${shown} rows shown with a note`)
  assert.ok(kept > 0 || !pairs.length)
})

check('fork-real', 'across each fork of the real saves a snooze of one branch seeded into the next is judged on the real rows of the child exactly as the identity of each object says: the same object holds, another one under the id ends it, a row with no stamp shows with a note, a row that is gone ends it, and a snooze set after the fork is not copied', 'forks', async ({ m, ctx }) => {
  const { makeRecord, seeded, emptyStore, addRecord, forBranch, evaluate, readStamps, isStamped } = m.snoozes
  const { forks } = ctx
  const [first] = forks.saves
  const branchOf = (key) => forks.saves.find((entry) => entry.key === key).branchId
  const pairs = [
    { name: 'b1 to b2, the rollback', parent: 'f2590429565', child: 'f2794985390' },
    { name: 'b2 to b3', parent: 'f2794985390', child: 'f2904201340' },
    { name: 'b3 to b4, the fork after increment 361910', parent: 'f2904201340', child: 'f2930673230' },
  ].filter((pair) => ctx.keys.includes(pair.parent) && ctx.keys.includes(pair.child))

  await ctx.saves([...new Set([...pairs.flatMap(({ parent, child }) => [parent, child]), 'f2740177930'].filter((key) => ctx.keys.includes(key)))])

  assert.equal(pairs.length, 3)
  assert.equal(first.relation, 'new')
  assert.deepEqual(forks.saves.map((entry) => entry.branchId), ['b1', 'b1', 'b1', 'b1', 'b2', 'b2', 'b3', 'b4'])
  assert.deepEqual(forks.saves.slice(1).map((entry) => entry.relation), ['continues', 'continues', 'continues', 'fork', 'continues', 'fork', 'fork'])

  const totals = { copied: 0, snoozed: 0, branch: 0, absent: 0, different: 0, other: 0, late: 0 }

  for (const pair of pairs) {
    const parentBranch = branchOf(pair.parent)
    const childBranch = branchOf(pair.child)
    const cut = forks.lineage[childBranch].t
    const parent = await ctx.save(pair.parent)
    const child = await ctx.save(pair.child)
    const tuples = { parent: await tuplesOf(parent.database, parent.save.game), child: await tuplesOf(child.database, child.save.game) }
    const expected = new Map()
    let store = emptyStore()

    assert.equal(forks.lineage[childBranch].parent, parentBranch, pair.name)

    for (const entry of m.index.CHECKS) {
      const read = parent.reads[entry.key]

      if (!read.ok) {
        continue
      }

      const stamps = await readStamps(parent.database, parent.save.game, rowIds(read))

      for (const row of eligible(read)) {
        const made = makeRecord({ check: entry, scope: 'item', kind: 'clear', row, read: Object.freeze({ ...read, GameTime: Math.min(read.GameTime, cut) }), stamps, branch: parentBranch })

        if (made.ok) {
          store = addRecord(store, made.record)
          expected.set(made.record.id.replace(`${parentBranch}|`, `${childBranch}|`), { entry, row })
        }
      }
    }

    const seededStore = seeded(store, childBranch, forks.lineage)
    const copies = forBranch(seededStore, childBranch)

    assert.equal(copies.length, store.records.length, pair.name)
    assert.ok(copies.every((record) => record.from === parentBranch && record.branch === childBranch), pair.name)
    assert.deepEqual(forBranch(seededStore, parentBranch), store.records, pair.name)
    totals.copied += copies.length

    for (const entry of m.index.CHECKS) {
      const mine = copies.filter((record) => record.check === entry.key)
      const read = child.reads[entry.key]

      if (!mine.length || !read.ok) {
        continue
      }

      const stamps = await readStamps(child.database, child.save.game, mine.filter((record) => record.stamp !== null).map((record) => record.rowId))
      const out = evaluate(mine, read, stamps)
      const ended = new Map(out.ended.map((item) => [item.record.id, item.reason]))
      const listed = new Map()

      read.rows.forEach((row) => listed.set(row.raw, [...(listed.get(row.raw) || []), row]))

      for (const record of mine) {
        const rows = listed.get(record.rowId) || []
        const tuple = isStamped(record.rowId) ? { was: tuples.parent[record.rowId], now: tuples.child[record.rowId] } : null
        let want

        if (!rows.length) {
          want = 'ended:absent'
        } else if (rows.length > 1 || rows[0].unevaluated) {
          want = 'shown'
        } else if (!tuple) {
          want = 'shown'
        } else if (tuple.now === null || tuple.now === undefined) {
          want = 'shown'
        } else {
          want = tuple.was === tuple.now ? 'snoozed' : 'ended:different'
        }

        const got = ended.has(record.id) ? `ended:${ended.get(record.id)}` : stateOf(out, rows.length ? rows[0].id : '')

        assert.equal(got, want, `${pair.name}: ${record.id} (${record.check}) wants ${want}`)

        if (want === 'shown' && !tuple && rows.length === 1 && !rows[0].unevaluated) {
          assert.deepEqual(out.rows.get(rows[0].id).notes, [m.snoozes.NOTES.branch], `${pair.name}: ${record.id}`)
          totals.branch++
        } else if (want === 'snoozed') {
          totals.snoozed++
        } else if (want === 'ended:absent') {
          totals.absent++
        } else if (want === 'ended:different') {
          totals.different++
        } else {
          totals.other++
        }
      }
    }

    if (pair.parent === 'f2590429565' && ctx.keys.includes('f2740177930')) {
      const later = await ctx.save('f2740177930')
      const lateStore = Object.values(later.reads).reduce((held, read, index) => {
        const entry = m.index.CHECKS[index]

        return eligible(read).slice(0, 5).reduce((inner, row) => {
          const made = makeRecord({ check: entry, scope: 'item', kind: 'clear', row, read, stamps: new Map(), branch: parentBranch })

          return made.ok ? addRecord(inner, made.record) : inner
        }, held)
      }, emptyStore())

      assert.ok(lateStore.records.length > 0 && lateStore.records.every((record) => record.setAt > cut))
      assert.deepEqual(forBranch(seeded(lateStore, childBranch, forks.lineage), childBranch), [])
      totals.late += lateStore.records.length
    }
  }

  console.log(`         ${JSON.stringify(totals)}`)
  assert.ok(totals.snoozed > 0 && totals.branch > 0 && totals.absent > 0 && totals.late > 0)
})

// ---------- the mutations ----------

const U = 'warnings/snoozes.js'

const MUTATIONS = [
  { name: 'a date ends a snooze only after it, not at it', edits: [[U, 'const expired = until.kind === \'date\' && now !== null && now >= until.expiresAt', 'const expired = until.kind === \'date\' && now !== null && now > until.expiresAt'], [U, 'now >= until.expiresAt ? ended(\'expired\') : snoozed()', 'now > until.expiresAt ? ended(\'expired\') : snoozed()']], fails: ['date', 'dates'] },
  { name: 'a whole check ends after its date, not at it', edits: [[U, 'now >= until.expiresAt ? ended(\'expired\') : snoozed()', 'now > until.expiresAt ? ended(\'expired\') : snoozed()']], fails: ['expiry-guards'] },
  { name: 'a whole check that lists nothing is cleared at its date, not expired', edits: [[U, 'return { end: until.kind === \'date\' && now !== null && now >= until.expiresAt ? \'expired\' : \'cleared\' }', 'return { end: \'cleared\' }']], fails: ['expiry-guards'] },
  { name: 'a declared change does not bring the warning back', edits: [[U, 'return row.signature === until.signature ? snoozed() : ended(\'changed\')', 'return snoozed()']], fails: ['material', 'options'] },
  { name: 'a signature that cannot be read ends the snooze', edits: [[U, 'return shown(NOTES.signature)\n    }\n\n    return row.signature === until.signature', 'return ended(\'changed\')\n    }\n\n    return row.signature === until.signature']], fails: ['material'] },
  { name: 'a signature of a whole check that cannot be read ends it', edits: [[U, 'return [row, shown(NOTES.signature)]', 'return [row, ended(\'changed\')]']], fails: ['check-scope'] },
  { name: 'a changed signature of a row of a whole check holds', edits: [[U, 'hasOwn(until.signatures, row.raw) && until.signatures[row.raw] === row.signature ? snoozed() : ended(\'changed\')', 'snoozed()']], fails: ['check-scope'] },
  { name: 'a failed read is read as a list with no row', edits: [[U, 'if (!read || read.ok !== true || !Array.isArray(read.rows)) {', 'if (!read) {']], fails: ['failed', 'real-fail'] },
  { name: 'a row seen to be gone does not end its episode', edits: [[U, 'return ended(expired ? \'expired\' : \'absent\')', 'return snoozed()']], fails: ['clear', 'date', 'stamp', 'fork-rules'] },
  { name: 'a row that could not be evaluated ends the snooze', edits: [[U, 'if (row.unevaluated) {\n    return shown(NOTES.unevaluated)\n  }', 'if (row.unevaluated) {\n    return ended(\'absent\')\n  }']], fails: ['unevaluated'] },
  { name: 'a check whose only rows could not be evaluated is cleared', edits: [[U, 'const verdicts = evaluable(read).map((row) => {\n    if (until.kind === \'date\') {', 'if (!evaluable(read).length) {\n    return { end: \'cleared\' }\n  }\n\n  const verdicts = evaluable(read).map((row) => {\n    if (until.kind === \'date\') {']], fails: ['unevaluated'] },
  { name: 'a check whose only rows could not be evaluated expires at its date', edits: [[U, 'const verdicts = evaluable(read).map((row) => {\n    if (until.kind === \'date\') {', 'if (!evaluable(read).length && until.kind === \'date\' && now !== null && now >= until.expiresAt) {\n    return { end: \'expired\' }\n  }\n\n  const verdicts = evaluable(read).map((row) => {\n    if (until.kind === \'date\') {']], fails: ['expiry-guards'] },
  { name: 'a date ends the snooze of a row before the row can be judged', edits: [[U, 'if (!found.length) {\n    return ended(expired ? \'expired\' : \'absent\')\n  }', 'if (expired) {\n    return ended(\'expired\')\n  }\n\n  if (!found.length) {\n    return ended(\'absent\')\n  }']], fails: ['expiry-guards'] },
  { name: 'an id listed twice is held per item', edits: [[U, 'if (found.length > 1) {\n    return shown(NOTES.ambiguous)\n  }', 'if (found.length > 1 && false) {\n    return shown(NOTES.ambiguous)\n  }']], fails: ['ambiguous'] },
  { name: 'an id listed twice can be snoozed', edits: [[U, 'if (row.ambiguous) {\n      return { ok: false, error: \'The check lists this id more than once', 'if (false) {\n      return { ok: false, error: \'The check lists this id more than once']], fails: ['ambiguous', 'make'] },
  { name: 'another object under the id keeps the snooze', edits: [[U, 'if (current !== record.stamp) {\n      return ended(\'different\')\n    }', 'if (false) {\n      return ended(\'different\')\n    }']], fails: ['stamp', 'fork-rules', 'fork-real'] },
  { name: 'a stamp that cannot be read hides the row', edits: [[U, 'if (typeof current !== \'string\') {\n      return shown(NOTES.stamp)\n    }', 'if (typeof current !== \'string\') {\n      return snoozed()\n    }']], fails: ['stamp', 'fork-rules'] },
  { name: 'a snooze with no stamp is applied across a fork', edits: [[U, 'if (record.stamp === null && record.from) {', 'if (false) {']], fails: ['fork-rules', 'precedence', 'fork-real'] },
  { name: 'a copied snooze forgets the branch it came from', edits: [[U, 'from: record.from || record.branch,', 'from: null,']], fails: ['seed', 'fork-rules', 'fork-real'] },
  { name: 'a snooze made after the fork is copied to the branch', edits: [[U, 'record.branch === parent && record.setAt <= t', 'record.branch === parent']], fails: ['seed', 'seed-order', 'fork-real'] },
  { name: 'a snooze that ended before the fork is copied to the branch', edits: [[U, ' && entry.ended.at > t', '']], fails: ['seed-order'] },
  { name: 'a snooze set after the fork and since ended is copied to the branch', edits: [[U, 'entry.branch === parent && entry.setAt <= t', 'entry.branch === parent']], fails: ['seed-order'] },
  { name: 'a snooze replaced on the parent is lost to the branch', edits: [[U, 'past: [...store.past, ...replaced.map((stored) => ({ ...stored, ended: { at: record.setAt, reason: \'replaced\' } }))] }', 'past: store.past }']], fails: ['past-store', 'seed-order'] },
  { name: 'a snooze ended or cancelled on the parent is lost to the branch', edits: [[U, 'past: [...store.past, ...entries] }', 'past: store.past }']], fails: ['past-store', 'seed-order'] },
  { name: 'the ended snoozes are cut before the branches are seeded', edits: [[U, 'const every = Object.keys(known).reduce((current, branch) => seeded(current, branch, known), store)', 'const every = store']], fails: ['seed-order'] },
  { name: 'the ended snoozes are cut while the registry cannot be read', edits: [[U, 'if (!isObject(known)) {\n    return store\n  }', 'if (!isObject(known)) {\n    return { ...store, past: store.past.slice(-PAST_LIMIT) }\n  }']], fails: ['seed-order'] },
  { name: 'the ended snoozes are kept without a cap', edits: [[U, 'past: every.past.slice(-PAST_LIMIT)', 'past: every.past']], fails: ['seed-order'] },
  { name: 'two episodes of a snooze at one game time are one', edits: [[U, '@$' + '{entry.setAt}@$' + '{entry.ended.at}`', '@$' + '{entry.setAt}`']], fails: ['past-store'] },
  { name: 'a snooze that ended at an unknown game time is kept', edits: [[U, '.filter(({ end }) => isFiniteNumber(end.at))', '']], fails: ['seed-order'] },
  { name: 'a branch is seeded again after a copy is cancelled', edits: [[U, 'hasOwn(store.seeded, branch) || walked.has(branch)', 'walked.has(branch)']], fails: ['seed'] },
  { name: 'a branch is seeded without its parent being seeded first', edits: [[U, 'const base = seeded(store, parent, lineage, walked)', 'const base = store']], fails: ['seed'] },
  { name: 'a fork time that is not recorded copies everything', edits: [[U, 'const copies = t === null ? [] : [', 'const copies = ['], [U, 'record.branch === parent && record.setAt <= t', 'record.branch === parent && (t === null || record.setAt <= t)']], fails: ['seed'] },
  { name: 'a changed option set is a material change', edits: [[U, 'return snoozed(NOTES.options)\n    }', 'return ended(\'changed\')\n    }']], fails: ['options'] },
  { name: 'a snooze set later than the save ends on a change', edits: [[U, 'if (verdict.end && !ahead) {\n      result.ended.push({ record, reason: verdict.end })\n    } else if (verdict.end) {', 'if (verdict.end) {\n      result.ended.push({ record, reason: verdict.end })\n    } else if (false) {']], fails: ['ahead', 'rewind-real'] },
  { name: 'an unknown game time expires a date', edits: [[U, '(now === null ? shown(NOTES.clock) :', '(now === null ? ended(\'expired\') :']], fails: ['clock'] },
  { name: 'a stored value of another version is read', edits: [[U, '|| value.version !== VERSION || !Array.isArray(value.records)', '|| !Array.isArray(value.records)']], fails: ['store'] },
  { name: 'an invalid record is kept', edits: [[U, 'const records = value.records.filter(validRecord)', 'const records = value.records']], fails: ['store'] },
  { name: 'a date in the past is accepted', edits: [[U, 'isFiniteNumber(expiresAt) && expiresAt > read.GameTime', 'isFiniteNumber(expiresAt)']], fails: ['make'] },
  { name: 'a material change is offered by a check that declares none', edits: [[U, 'if (kind === \'material\' && !check.material) {', 'if (false) {']], fails: ['make'] },
  { name: 'a row whose signature cannot be read is snoozed until it changes', edits: [[U, 'if (!isText(row.signature)) {\n        return { ok: false, error: \'An input of the declared change cannot be read, so the row cannot be snoozed until it changes.\' }', 'if (false) {\n        return { ok: false, error: \'x\' }']], fails: ['make'] },
  { name: 'an object whose identity cannot be read is snoozed', edits: [[U, 'if (!isText(stamp)) {', 'if (false) {']], fails: ['make'] },
  { name: 'a reason is not cut', edits: [[U, '.trim().slice(0, REASON_LENGTH)', '.trim()']], fails: ['make'] },
  { name: 'a ship is stamped by its class only', edits: [[U, 'columns: Object.freeze([\'ShipClassID\', \'Constructed\'])', 'columns: Object.freeze([\'ShipClassID\'])']], fails: ['stamps-read'] },
  { name: 'a stamp is made of a column that is not stored', edits: [[U, 'values.every((value) => value !== null && value !== undefined)', 'true']], fails: ['stamps-read'] },
  { name: 'a stamp is read without the game', edits: [[U, 'where $' + '{table}.GameID = $' + '{Number(GameID)} and ', 'where ']], fails: ['stamps-read'] },
  { name: 'a note speaks in the first person', edits: [[U, 'Snoozed on another branch of the campaign;', 'I snoozed this on another branch of the campaign;']], fails: ['voice'] },
  { name: 'a band of an unknown figure is band 0', rereads: true, edits: [['warnings/common.js', 'edges.filter((edge) => Number(value) >= edge).length : null)', 'edges.filter((edge) => Number(value) >= edge).length : 0)']], fails: ['bands', 'sig-mock'] },
  { name: 'a signature is made from an unknown token', rereads: true, edits: [['warnings/common.js', 'tokens.some((token) => token === null || token === undefined || token === \'\') ? null', 'false ? null']], fails: ['bands', 'sig-mock'] },
  { name: 'a repeated id is not marked ambiguous', rereads: true, edits: [['warnings/common.js', 'ambiguous: totals.get(row.id) > 1,', 'ambiguous: false,']], fails: ['normalize', 'ambiguous'] },
  { name: 'a growing figure is in a signature', rereads: true, edits: [['warnings/colonies.js', 'signature: (population) => signatureOf(bandOf(population.Efficiency, [1 - QUARTER])),', 'signature: (population) => signatureOf(population.Efficiency),']], fails: ['sig-mock'] },
  { name: 'a name is in a signature', rereads: true, edits: [['warnings/ships.js', 'signature: signatureOf(bandOf(level, [1 - QUARTER])) })', 'signature: signatureOf(bandOf(level, [1 - QUARTER]), ship.ShipName) })']], fails: ['sig-names'] },
  { name: 'a check of class P declares a material change', rereads: true, edits: [['warnings/space.js', 'key: \'known-wrecks\',\n    group: group.key,\n    severity: \'info\',', 'key: \'known-wrecks\',\n    group: group.key,\n    severity: \'info\',\n    material: \'the wreck changing\',']], fails: ['material-set'] },
  { name: 'a check of class K loses its declaration', rereads: true, edits: [['warnings/space.js', 'material: \'the lifepod expiring\',\n', '']], fails: ['material-set'] },
  { name: 'a signature of damaged components is made of their names', rereads: true, edits: [['warnings/ships.js', 'signatureOf(categoriesOf(ship.ComponentIDs))', 'signatureOf(categoriesOf(ship.Components))']], fails: ['rename-stable'] },
  { name: 'a signature is told as its raw token', rereads: true, edits: [['warnings/common.js', '(readers[index] && readers[index](token)) || token', 'token']], fails: ['described'] },
  { name: 'the bands of the morale are told the wrong way round', rereads: true, edits: [['warnings/ships.js', 'captured: [bandWords(\'morale under 75%\', \'morale at 75% or more\')],', 'captured: [bandWords(\'morale at 75% or more\', \'morale under 75%\')],']], fails: ['described'] },
  { name: 'a check loses the reader of its signature', rereads: true, edits: [['warnings/ships.js', '    captured: [countWords(\'damaged component kind\', \'damaged component kinds\')],\n', '']], fails: ['described'] },
  { name: 'a mute does not outrank a snooze on the page', edits: [['@page', 'if (!view || this.mutedCheckSet.has(check.key)) {', 'if (!view) {']], fails: ['page-mute'] },
  { name: 'a muted row is held by its snooze on the page', edits: [['@page', '!mutedIds.has(row.id) && view.rows.has(row.id)', 'view.rows.has(row.id)']], fails: ['page-mute'] },
  { name: 'a game time that is not read is read as 0 on the page', edits: [['@page', 'isKnownNumber(this.GameTime)', 'Number.isFinite(Number(this.GameTime))']], fails: ['page-clock'] },
  { name: 'a date is chosen while the start year is unread', edits: [['@page', 'this.StartYear > 0 && isKnownNumber', 'isKnownNumber']], fails: ['page-clock'] },
  { name: 'an evaluation is applied after the save was read again', edits: [['@page', ' || generation !== this.$store.state.freshness.generation', '']], fails: ['page-guards'] },
  { name: 'an evaluation is applied on another branch', edits: [['@page', ' || branch !== this.branchId', '']], fails: ['page-guards'] },
  { name: 'an evaluation is applied in another campaign', edits: [['@page', ' || key !== this.contextKey', ''], ['@page', 'run !== this.snoozeRun || ', '']], fails: ['page-guards'] },
  { name: 'an evaluation is applied after the read was replaced', edits: [['@page', 'run !== this.snoozeRun || ', ''], ['@page', ' || !reads.every(({ name, read }) => this[name] === read)', '']], fails: ['page-guards'] },
  { name: 'a store that cannot be read is written over', edits: [['@page', 'const stored = readStore(this.config.get(key))', 'const read = readStore(this.config.get(key))\n      const stored = read.ok ? read : { ok: true, store: emptyStore(), dropped: 0 }']], fails: ['page-store'] },
  { name: 'a snooze is not applied again when a failed check reads again', edits: [['@page', 'this.$nextTick(() => this.markVisit())', 'this.$nextTick(() => { this.markVisit(); this.evaluateSnoozes() })'], ['@page', '    inputsSeen() {\n      this.$nextTick(() => this.evaluateSnoozes())\n    },', '']], fails: ['page-retry'] },
  { name: 'a snooze is not applied again when the last read to settle is not a check', edits: [['@page', 'return [this.ready, ...CHECKS.map(', 'return [...CHECKS.map(']], fails: ['page-refresh'] },
  { name: 'the ended snoozes are not cut when a snooze is written', edits: [['@page', 'const next = pruned(change(stored.store), () => this.lineage())', 'const next = change(stored.store)']], fails: ['page-prune'] },
  { name: 'a material snooze does not say what it ends on', edits: [['@page', 'parts.push(this.materialText(record))', '']], fails: ['page-text'] },
  { name: 'a material snooze says the raw signature it was set under', edits: [['@page', '$' + '{describeSignature(check, signature)}', '$' + '{signature}']], fails: ['page-text'] },
  { name: 'a Settings reset drops the snoozes', edits: [['@settings', '\'warningsSnoozed\', ', '']], fails: ['reset'] },
]

// ---------- running ----------

let failures = 0
let total = 0

const show = (label, result, detail = '') => {
  const ok = result === true

  total++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

const memo = (work) => {
  let held = null

  return () => {
    held = held || work()

    return held
  }
}

// What a check runs on for one set of modules. The reads and the branches are those of the unmodified modules unless a mutation changes what is read; each is made once.
const contextOf = (m, { shared = null, keys = SAVE_KEYS } = {}) => {
  const saves = new Map()
  const forks = memo(() => (shared ? shared.forks() : forksOf(m)))
  const save = (key) => {
    if (shared) {
      return shared.save(key)
    }

    if (!saves.has(key)) {
      saves.set(key, readSave(m, key))
    }

    return saves.get(key)
  }

  return {
    keys,
    fast: FAST_SAVES.filter((key) => keys.includes(key)),
    minSigned: 10,
    minObjects: 100,
    minHeld: 500,
    save,
    saves: (list) => Promise.all(list.map((key) => save(key))),
    forks,
  }
}

const runEntry = async (m, context, entry) => {
  if ((entry.needs === 'reads' && !context.keys.length) || (entry.needs === 'page' && !SAVE_KEYS.includes('modded'))) {
    return 'skip'
  }

  const extra = {}

  if (entry.needs === 'forks') {
    extra.forks = await context.forks()

    if (!extra.forks) {
      return 'skip'
    }
  }

  return entry.run({ m, ctx: { ...context, ...extra } })
}

const outcomeOf = async (m, context, entry) => {
  try {
    return (await runEntry(m, context, entry)) === 'skip' ? 'skip' : true
  } catch (error) {
    return String((error && error.stack) || error).split('\n').slice(0, 8).join('\n         ')
  }
}

// What a mutation plants: `sources` is the text of each module it changes by the name the loader knows it by, with every edit made (the others are read from the folder, so no copy of it is made), and `pageEdits` the edits of the page's script.
const planted = (mutation) => {
  const sources = {}
  const pageEdits = []

  for (const [name, one, two] of mutation.edits) {
    if (name === '@page') {
      patched('warnings.js', pageEdits.reduce((text, [from, to]) => patched('warnings.js', text, from, to), pageScript()), one, two)
      pageEdits.push([one, two])

      continue
    }

    const relative = name === '@settings' ? 'remembered-views.js' : name
    const module = relative.replace(/\.js$/, '')

    sources[module] = patched(relative, sources[module] !== undefined ? sources[module] : fs.readFileSync(path.join(utilitiesDirectory, relative), 'utf8'), one, two)
  }

  return { sources, pageEdits }
}

const ARGS = process.argv.slice(2)
const ONLY = (ARGS.find((argument) => argument.startsWith('--only=')) || '').slice('--only='.length).split(',').filter(Boolean)
const ALL = ARGS.includes('--all')
const RESULT = 'RESULT '

const selectedChecks = checks.filter((item) => !ONLY.length || ONLY.includes(item.key))

// What the baseline and each mutation print, as entries a child hands to the parent: a line of text (what a check prints as it runs, and a skip), or the arguments of `show`. The entries of a check carry its number, `at`, which is its place among the checks run.
const baselineEntries = async (entries, keys) => {
  const real = await loadModules({}, NAMES_WITH_HISTORY)
  const context = contextOf(real)
  let at = 0

  console.log = (...parts) => entries.push({ at, log: format(...parts) })

  for (const entry of selectedChecks.filter((item) => keys.includes(item.key))) {
    at = selectedChecks.indexOf(entry) + 1

    const began = Date.now()
    const outcome = await outcomeOf(real, context, entry)

    if (outcome === 'skip') {
      entries.push({ at, log: `  skip   ${at}. ${entry.key}: the saves it reads are not here (a skip is not agreement)` })
      continue
    }

    entries.push({ at, show: [`${at}. ${entry.key}: ${entry.name}`, outcome, entry.needs === 'unit' ? '' : `${((Date.now() - began) / 1000).toFixed(1)} s`] })
  }
}

// The checks of the baseline in the groups that run in a process each: the reads and the forks of the saves (which share what they read), the checks of the page in two (each loads the page), and the rest.
const baselineGroups = () => {
  const of = (...needs) => selectedChecks.filter((entry) => needs.includes(entry.needs)).map((entry) => entry.key)
  const page = of('page')

  return [of('reads', 'forks'), ...chunksOf(page.length, 2).map((list) => list.map((index) => page[index])), of('unit')].filter((keys) => keys.length)
}

// The reads and the branches of the unmodified modules, made when a mutation first asks for them, in the process of that mutation (and kept for the next mutation of the process): what a mutation that is not about the reads is judged on.
const baselineOf = () => {
  let held = null
  const context = () => {
    held = held || loadModules({}, NAMES_WITH_HISTORY).then((real) => contextOf(real))

    return held
  }

  return { save: async (key) => (await context()).save(key), forks: async () => (await context()).forks() }
}

const baseline = baselineOf()

// A mutation that is judged on the reads or the branches of the unmodified modules, and so is run with the others that are, to make them once.
const readsBaseline = (mutation) => !mutation.rereads && (ALL || mutation.fails.some((key) => ['reads', 'forks'].includes((checks.find((entry) => entry.key === key) || {}).needs)))

const mutationEntries = async (entries, mutation) => {
  const began = Date.now()
  let planting = null

  try {
    planting = planted(mutation)

    const mutant = await loadModules(planting.sources, NAMES, planting.pageEdits)
    const reread = contextOf(mutant, { keys: FAST_SAVES })
    const mutantContext = mutation.rereads ? { ...reread, minSigned: 0, minObjects: 0, minHeld: 0 } : contextOf(mutant, { shared: baseline, keys: SAVE_KEYS })
    const named = checks.filter((entry) => mutation.fails.includes(entry.key))
    const absent = mutation.fails.filter((key) => !named.some((entry) => entry.key === key))
    const missed = []
    const skipped = []
    const broke = []

    for (const entry of ALL ? checks : named) {
      const outcome = await outcomeOf(mutant, mutantContext, entry)

      if (outcome === 'skip') {
        skipped.push(entry.key)
      } else if (outcome !== true) {
        broke.push(entry.key)
      } else if (named.includes(entry)) {
        missed.push(entry.key)
      }
    }

    const ran = named.length - skipped.length

    entries.push({ show: [`mutation caught: ${mutation.name}`, absent.length ? `no check is keyed ${absent.join(', ')}` : !ran ? `none of the named checks could run (${skipped.join(', ')}), so nothing is shown` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${ALL ? `breaks ${broke.join(', ')}` : mutation.fails.join(', ')}${skipped.length ? `; not run: ${skipped.join(', ')}` : ''}; ${((Date.now() - began) / 1000).toFixed(1)} s`] })
  } catch (error) {
    entries.push({ show: [`mutation caught: ${mutation.name}`, `does not apply or load: ${error.message}`] })
  }
}

// A child runs a group of the baseline (`--baseline --checks=key,key`) or some mutations in turn (`--mutants=<i>,<i>`) in a process of its own, so no group or chunk shares the modules, the stores or the reads of another, and prints its entries as JSON on its last line: those of the group, or the list of the entries of each mutation.
const childMain = async () => {
  const given = ARGS.find((argument) => argument.startsWith('--mutants='))
  const checked = ARGS.find((argument) => argument.startsWith('--checks='))
  const entries = []

  if (given) {
    for (const index of given.slice('--mutants='.length).split(',')) {
      const own = []

      console.log = (...parts) => own.push({ log: format(...parts) })
      await mutationEntries(own, MUTATIONS[Number(index)])
      entries.push(own)
    }
  } else {
    await baselineEntries(entries, checked.slice('--checks='.length).split(','))
  }

  process.stdout.write(`${RESULT}${JSON.stringify(entries)}\n`, () => process.exit(0))
}

const main = async () => {
  if (ARGS.includes('--baseline') || ARGS.some((argument) => argument.startsWith('--mutants='))) {
    return childMain()
  }

  const groups = baselineGroups()
  const mutations = ARGS.includes('--no-mutations') ? [] : MUTATIONS.filter((item) => !ONLY.length || item.fails.some((key) => ONLY.includes(key)))
  const indexes = mutations.map((_mutation, index) => index)
  const withReads = indexes.filter((index) => readsBaseline(mutations[index]))
  const rest = indexes.filter((index) => !withReads.includes(index))
  const chunks = [withReads, ...chunksOf(rest.length).map((list) => list.map((index) => rest[index]))].filter((list) => list.length)
  const tasks = [...groups.slice(0, 1).map((_keys, at) => ({ group: at })), ...chunks.slice(0, 1).map((_list, at) => ({ chunk: at })), ...groups.slice(1).map((_keys, at) => ({ group: at + 1 })), ...chunks.slice(1).map((_list, at) => ({ chunk: at + 1 }))]
  const argsOf = (task) => (task.group !== undefined ? ['--baseline', `--checks=${groups[task.group].join(',')}`, ...ARGS] : [`--mutants=${chunks[task.chunk].map((index) => MUTATIONS.indexOf(mutations[index])).join(',')}`, ...ARGS])
  const outcomes = await inParallel(tasks, async (task) => lastJson(await runChild(__filename, argsOf(task)), RESULT))
  const groupOutcomes = groups.map((_keys, at) => outcomes[tasks.findIndex((task) => task.group === at)])
  const replay = (entries) => entries.forEach((entry) => (entry.log !== undefined ? console.log(entry.log) : show(...entry.show)))
  const failed = groupOutcomes.find((outcome) => outcome instanceof Error)

  if (failed) {
    throw failed
  }

  if (!SAVE_KEYS.length) {
    console.log('  skip   no save is here, so the reads and the forks are not run')
  }

  console.log('The warning snoozes')
  replay(groupOutcomes.flat().sort((a, b) => a.at - b.at))

  if (!ARGS.includes('--no-mutations')) {
    console.log('\nMutations: each must break every check it names')
  }

  spread(chunks, chunks.map((_list, at) => outcomes[tasks.findIndex((task) => task.chunk === at)])).forEach((outcome, index) => (outcome instanceof Error ? show(`mutation caught: ${mutations[index].name}`, `does not run: ${outcome.message}`) : replay(outcome)))

  console.log(`\n${total - failures} of ${total} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
