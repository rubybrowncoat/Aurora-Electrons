/*
  Checks the acknowledged economic change digest (src/renderer/utilities/economy-digest.js, components/notebook/ChangeDigest.vue and its place on the Notebook page) without a save.

  Every statement runs on snapshots, colony rows and notes made here, on in-memory stores for the settings and for the history files the panel reads, and on the real utility, panel and page. Nothing is read from a save. The statements cover the acceptance of AE-065-01:
  - an acknowledged change does not come back after a reload (the digest's file is read again from what was written), and one that moves again does;
  - a stretch the app did not observe shows the net change between the two observed boundaries with its coverage gaps, never an event of its own, and a stock or build that began and ended inside it leaves no trace;
  - a rewind or a fork cannot bridge a comparison it was not made on, and no branch, race or campaign reads or repeats another's acknowledgment;
  - a save whose snapshot the recorder failed to write is never compared with the older snapshot of the same game time, and nothing is acknowledged for it (the recorder is the real one, over in-memory stores).

  Each planted fault (a copy of one source with one change, loaded in place of it) must fail the checks it names. Prints `N of N checks passed`; a check that fails, a fault that no named check catches and a fault whose anchor does not match each set exit code 1.

  The panel, the page and the template are checked by what they do: the compiled template's elements and bound expressions evaluated on figures, the page's bound props evaluated on an instance of it, the tracked read through the real load-state mixin, the coverage as data, and the recorder's failure through the real recorder. No statement matches source text or prose; only a planted fault names a source anchor.
*/
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const compiler = require('vue/compiler-sfc')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { routes: routeTable } = require('./lib/store-routes')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The history files the panel reads, kept in one map by name as electron-store's `cwd` and `name` give them.
const STORE_STUB = `const files = (globalThis.__economyDigestStores = globalThis.__economyDigestStores || new Map())
export default class Config {
  constructor ({ cwd = '', name = 'config' } = {}) { this.key = cwd + '/' + name }
  get store () { return JSON.parse(JSON.stringify(files.get(this.key) || {})) }
  set store (value) { if (globalThis.__economyDigestRefuse && globalThis.__economyDigestRefuse(this.key)) throw new Error('disk full'); files.set(this.key, JSON.parse(JSON.stringify(value))) }
  get path () { return this.key }
  update (change) { const between = globalThis.__economyDigestBetween; globalThis.__economyDigestBetween = null; if (between) between(); const next = change(this.store); this.store = next; return next }
  get (key, fallback) { return key.split('.').reduce((value, part) => (value === undefined || value === null ? undefined : value[part]), this.store) ?? fallback }
}`

const STUBS = {
  'electron-store': STORE_STUB,
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const stores = () => globalThis.__economyDigestStores || (globalThis.__economyDigestStores = new Map())

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const FILES = {
  digest: path.join(rendererDirectory, 'utilities', 'economy-digest.js'),
  vue: path.join(rendererDirectory, 'components', 'notebook', 'ChangeDigest.vue'),
  page: path.join(rendererDirectory, 'pages', 'notebook.vue'),
  plugin: path.join(rendererDirectory, 'plugins', 'history.js'),
  store: path.join(rendererDirectory, 'store', 'history.js'),
}

const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const texts = new Map()

// The web build's store as source text, for the panel loaded against it.
const SHIM_TEXT = fs.readFileSync(path.join(root, 'scripts', 'web', 'shims', 'electron-store.js'), 'utf8')

// The load-state mixin as shipped, its import of the tracking utilities pointing at the file.
const LOAD_STATE_TEXT = fs.readFileSync(path.join(rendererDirectory, 'mixins', 'load-state.js'), 'utf8').replace('../utilities/load-tracking', pathToFileURL(path.join(rendererDirectory, 'utilities', 'load-tracking.js')).href)

// The web build's settings store, loaded once from its own source (no fault is planted in it here).
let shimLoaded = null

const shimOf = () => shimLoaded || (shimLoaded = loadUtilities(['electron-store'], { directory: path.join(root, 'scripts', 'web', 'shims') }).then((loaded) => loaded['electron-store'].default))

// The notes, the milestones' adapter and the scenario repository, loaded once from their own sources.
let notesLoaded = null

const notesOf = () => notesLoaded || (notesLoaded = loadUtilities(['economy-notes', 'history-milestones', 'scenario-records'], { stubs: STUBS, texts }).then((loaded) => ({ notes: loaded['economy-notes'], milestones: loaded['history-milestones'], records: loaded['scenario-records'] })))

// The recorder as the app wires it (its plugin and store module) with the real recorder and campaign utilities, loaded from the shipped sources or, for a planted fault, from `text`.
let recorderLoaded = null

const loadRecorder = (text) => loadUtilities(['campaign', 'history', '../store/history', '../plugins/history'], { stubs: STUBS, sources: { '../store/history': text.store, '../plugins/history': text.plugin }, texts }).then((loaded) => ({ history: loaded.history, historyStore: loaded['../store/history'], plugin: loaded['../plugins/history'] }))

const recorderOf = (text, mutated) => (mutated ? loadRecorder(text) : recorderLoaded || (recorderLoaded = loadRecorder(ORIGINALS)))

// The utilities, the panel and the page as shipped, or with the one fault of `mutation` planted in one source.
const build = async (mutation = null) => {
  const text = { ...ORIGINALS }

  if (mutation) {
    text[mutation.target] = patched(FILES[mutation.target], text[mutation.target], mutation.find, mutation.replace)
  }

  const m = await loadUtilities(['economy-digest', 'colony-series'], { stubs: STUBS, sources: { 'economy-digest': text.digest }, texts })
  const sources = { 'utilities/economy-digest': text.digest, 'components/notebook/ChangeDigest': text.vue, 'pages/notebook': text.page }
  const memo = (work) => {
    let held = null

    return () => held || (held = work())
  }

  return { m: { d: m['economy-digest'], colony: m['colony-series'], ...(await notesOf()), ...(await recorderOf(text, Boolean(mutation) && ['plugin', 'store'].includes(mutation.target))) }, Shim: await shimOf(), text, component: memo(() => loadPage('components/notebook/ChangeDigest', { stubs: STUBS, sources, texts })), webComponent: memo(() => loadPage('components/notebook/ChangeDigest', { stubs: { ...STUBS, 'electron-store': SHIM_TEXT }, sources, texts })), page: memo(() => loadPage('pages/notebook', { stubs: STUBS, sources, texts })), trackedPage: memo(() => loadPage('pages/notebook', { stubs: STUBS, sources, texts, modules: { 'mixins/load-state': LOAD_STATE_TEXT } })) }
}

// ---- Fixtures ----------------------------------------------------------------------------------------------------------

const chain = (t, salt = 0) => ({ n: t / 100, digest: String(t + salt).padStart(16, '0') })

// A snapshot of the history file at game time `t`: a ledger witness of t / 100 increments.
const snap = (t, over = {}) => ({ t, wealth: 100, fuel: 1000, msp: 50, minerals: Array(11).fill(10), militaryShips: 5, commercialShips: 2, installations: { 1: 10, 2: 5 }, chain: chain(t), ...over })

const COLUMNS = ['population', 'fuel', 'msp', 'Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']

// A colony row of the series, [PopulationID, state, ...14 figures]: 1 million people and 5 of every stock, but for `over`.
const crow = (id, state = 0, over = {}) => [id, state, ...COLUMNS.map((column) => (column in over ? over[column] : column === 'population' ? 1 : 5))]

const rowsOf = (...rows) => Object.fromEntries(rows.map((row) => [row[0], row.slice(1)]))

// A note as `readNotes` lists it, with the link the Notebook finds intact unless `over` says otherwise.
const entry = (uuid, over = {}) => ({ uuid, title: `Note ${uuid}`, status: 'planned', next: 'Next', target: { type: 'body', id: 100, name: 'Body' }, link: { status: 'linked' }, ...over })

const colonyList = [{ id: 10, name: 'Alpha', bodyId: 100 }]

// The scenario repository on in-memory files, each a JSON value read and written whole.
const memory = () => {
  const files = new Map()
  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      files.set(name, clone(value))
    },
    update (change) {
      const next = change(this.store)

      files.set(name, clone(next))

      return next
    },
  })

  return { files, storage: { open: (campaignId) => store(`campaign-${campaignId}`), registry: () => ({}), writable: () => Promise.resolve(true) } }
}

const worldOf = (m, inst = memory()) => {
  const registry = m.records.createAdapterRegistry()
  let clock = 1000
  let ids = 0

  m.milestones.registerMilestones(registry.register)
  m.notes.registerEconomyNotes(registry.register)

  return { inst, repo: m.records.createRepository({ storage: inst.storage, adapters: registry, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, now: () => ++clock }) }
}

const bodyRow = (id, name, discovered) => ({ id, name, systemId: 1, systemName: 'Sol', planetNumber: 3, orbitNumber: 0, bodyClass: 1, bodyTypeId: 2, discovered })

// The objects of an open save as the Notebook hands them to the notes, on the branch `branchId` of the campaign c1, whose branch b2 left b1 at game time 1000.
const contextOf = (bodies, branchId = 'b1') => ({ objects: { body: new Map(bodies.map((row) => [row.id, row])), colony: new Map(), fleet: new Map(), tech: new Map(), design: new Map() }, GameID: 1, RaceID: 7, campaignId: 'c1', branchId, branches: { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 1000 } } })

const whereOf = (branchId = 'b1') => ({ campaignId: 'c1', RaceID: 7, branchId, gameTime: 100000 })

const keepNote = async (m, w, context, id, { title = `Plan for body ${id}`, entry: kept = null, relink = false, branchId = 'b1' } = {}) => {
  const outcome = await m.notes.saveNote(w.repo, whereOf(branchId), { entry: kept, title, status: 'planned', next: 'Next', ...(relink || !kept ? { target: { type: 'body', row: context.objects.body.get(id) } } : {}), context, policy: 'campaign' })

  assert.equal(outcome.ok, true, outcome.message)

  return outcome.record
}

const entriesOnBranch = (m, w, context, branchId = 'b1') => m.notes.readNotes(w.repo, whereOf(branchId), context).entries

// The browser's localStorage and Web Locks, as far as the web store and the digest use them: one holder at a time per lock name, the others queued in order.
const fakeLocalStorage = () => {
  const items = new Map()

  return { items, getItem: (key) => (items.has(key) ? items.get(key) : null), setItem: (key, value) => { items.set(key, String(value)) }, removeItem: (key) => { items.delete(key) } }
}

const fakeLocks = () => {
  const names = new Map()

  return {
    request: (name, callback) => new Promise((resolve, reject) => {
      const lock = names.get(name) || { held: false, queue: [] }

      names.set(name, lock)

      const grant = () => {
        lock.held = true
        let outcome

        try {
          outcome = Promise.resolve(callback())
        } catch (error) {
          outcome = Promise.reject(error)
        }

        outcome.then(resolve, reject).then(() => {
          lock.held = false

          const next = lock.queue.shift()

          if (next) {
            next()
          }
        })
      }

      if (lock.held) {
        lock.queue.push(grant)
      } else {
        grant()
      }
    }),
  }
}

// The digest of the open save, the boundary being `from` unless `record` is given. `series` is the colony series, [{ t, rows }].
const at = (m, { from: given = null, snapshots = null, record = undefined, gameTime = 3000, series = null, notes = [], colonies = [], names = {}, thinning = null, before = {}, notesAtAck = [] }) => {
  const from = given || (snapshots ? snapshots[0] : snap(1000))

  return m.d.buildDigest({
    record: record === undefined ? { at: 1, snapshot: m.d.pickSnapshot(from), colonies: before, notes: m.d.noteBaseline(notesAtAck), items: {} } : record,
    snapshots: snapshots || [from, snap(3000)],
    gameTime,
    colonyRecord: series ? { snapshots: series.map(({ t, rows }) => ({ t, n: t / 100, colonies: rows })) } : null,
    colonies,
    notes,
    names,
    thinning,
  })
}

const keysOf = (digest) => digest.items.map((item) => item.key).sort()

const shownKeys = (digest) => digest.groups.flatMap((group) => group.items.map((item) => item.key)).sort()

// A store document (the settings, or a digest file) as the app holds it: one value read and written whole, a write made over what is stored.
const settingsOf = (initial = {}) => {
  let content = clone(initial)

  return {
    get store () {
      return clone(content)
    },
    set store (value) {
      content = clone(value)
    },
    get: (key, fallback) => {
      const found = key.split('.').reduce((value, part) => (value === undefined || value === null ? undefined : value[part]), content)

      return found === undefined ? fallback : clone(found)
    },
    update (change) {
      const next = change(clone(content))

      content = clone(next)

      return next
    },
  }
}

const seed = ({ campaignId = 'c1', branchId = 'b1', RaceID = 7, snapshots, series = null }) => {
  const file = `history/campaign-${campaignId}-${branchId}`

  stores().set(file, { races: { ...(stores().get(file) || { races: {} }).races, [RaceID]: { snapshots } } })

  if (series) {
    stores().set(`history/campaign-${campaignId}-${branchId}-colonies`, { races: { [RaceID]: { snapshots: series.map(({ t, rows }) => ({ t, n: t / 100, colonies: rows })) } } })
  }
}

// The digest's file of a campaign as the panel's store wrote it, and the store of one race in it.
const digestDocument = (campaignId) => stores().get(`economy-digest/campaign-${campaignId}`)

const digestRace = (campaignId, RaceID) => (digestDocument(campaignId) || { races: {} }).races[RaceID]

const CAMPAIGN = { campaignId: 'c1', branchId: 'b1', generation: 1 }

const mounted = (options, { config, campaign = CAMPAIGN, raceId = 7, gameTime = 3000, notes = [], names = {}, recording = '' }) => instantiate(options, { $store: { getters: {}, state: {} }, data: { config, campaign, raceId, gameTime, notes, names, startYear: 2000, separator: ',', historyRevision: 0, recording } })

// ---- The checks --------------------------------------------------------------------------------------------------------

const checks = []
const check = (key, name, run) => checks.push({ key, name, run })

// The figures and statuses a change hands to the formatters, in the order told: what a sentence shows of it without the English around them.
const writtenOf = (m, item) => {
  const figures = []
  const statuses = []
  const text = m.d.itemText(item, (value) => { figures.push(value); return String(value) }, (value) => { statuses.push(value); return String(value) })

  return { figures, statuses, text }
}

check('production-net', 'finished production is the net difference of installations and ships between two boundaries; a type the later save lacks is none built, never unknown', ({ m }) => {
  const later = at(m, { snapshots: [snap(1000, { installations: { 1: 10, 2: 5 }, militaryShips: 5 }), snap(3000, { installations: { 1: 14, 3: 2 }, militaryShips: 3 })], names: { 1: 'Mines' } })

  assert.equal(later.state, 'ready')
  const byKey = Object.fromEntries(later.items.map((item) => [item.key, item]))

  assert.deepEqual(Object.keys(byKey).sort(), ['production:installation:1', 'production:installation:2', 'production:installation:3', 'production:ships:military'])
  assert.equal(byKey['production:installation:1'].change, 4)
  assert.equal(byKey['production:installation:1'].from, 10)
  assert.equal(byKey['production:installation:1'].to, 14)
  assert.equal(byKey['production:installation:1'].label, 'Mines')
  assert.equal(byKey['production:installation:1'].result.status, 'confirmed')
  assert.equal(byKey['production:installation:1'].result.rule.id, 'digest.installations')
  assert.equal(byKey['production:installation:2'].from, 5)
  assert.equal(byKey['production:installation:2'].to, 0)
  assert.equal(byKey['production:installation:2'].change, -5)
  assert.equal(byKey['production:installation:3'].from, 0)
  assert.equal(byKey['production:installation:3'].to, 2)
  assert.match(byKey['production:installation:3'].label, /\b3\b/)
  assert.equal(byKey['production:ships:military'].change, -2)
  assert.equal(byKey['production:ships:military'].kind, 'production')
  assert.equal(byKey['production:ships:military'].area, 'ships')
  assert.equal(byKey['production:ships:military'].from, 5)
  assert.equal(byKey['production:ships:military'].to, 3)
  assert.deepEqual(writtenOf(m, byKey['production:ships:military']).figures, [2, 5, 3], 'the change and the two figures are written, the change as its size')
  assert.ok(writtenOf(m, byKey['production:ships:military']).text.includes(byKey['production:ships:military'].label))
  assert.equal(later.unknown.length, 0)
})

check('production-unknown', 'a figure a snapshot does not hold leaves the change unknown, never 0', ({ m }) => {
  const from = snap(1000)
  const digest = at(m, { snapshots: [from, snap(3000, { installations: { 1: null, 2: 5 }, militaryShips: null })] })

  assert.equal(digest.state, 'ready')
  assert.ok(!digest.items.some((item) => item.key === 'production:installation:1' || item.key === 'production:ships:military'), 'an unknown figure became a change')
  assert.ok(digest.items.every((item) => Number.isFinite(item.change) && item.change !== 0))

  const unknown = Object.fromEntries(digest.unknown.map((entry) => [entry.key, entry]))

  assert.ok(unknown['production:ships:military'] && unknown['production:ships:military'].result.value === null && unknown['production:ships:military'].result.status === 'unavailable')
  assert.ok(unknown['production:installation:1'] && unknown['production:installation:1'].result.value === null)

  const bare = at(m, { snapshots: [from, snap(3000, { installations: undefined })] })

  assert.ok(!bare.items.some((item) => item.key.startsWith('production:installation')))
  assert.ok(bare.unknown.some((entry) => entry.key === 'production:installations' && entry.result.value === null))
})

check('bottleneck-flips', 'a stockpile or the treasury is a change only when it runs out or recovers; a fall that stays above none is not one', ({ m }) => {
  const from = snap(1000, { fuel: 0, msp: 50, wealth: 100, minerals: [10, 0, 10, 0, 10, 10, 10, 10, 10, 10, 10] })
  const to = snap(3000, { fuel: 1, msp: 0, wealth: -5, minerals: [0, 5, 3, 0, 10, 10, 10, 10, 10, 10, 10] })
  const digest = at(m, { snapshots: [from, to] })
  const byKey = Object.fromEntries(digest.items.filter((item) => item.kind === 'bottleneck').map((item) => [item.key, item]))

  assert.deepEqual(Object.keys(byKey).sort(), ['bottleneck:stock:fuel', 'bottleneck:stock:mineral:1', 'bottleneck:stock:mineral:2', 'bottleneck:stock:msp', 'bottleneck:treasury'])
  assert.equal(byKey['bottleneck:stock:mineral:1'].direction, 'emptied')
  assert.equal(byKey['bottleneck:stock:mineral:2'].direction, 'refilled')
  assert.equal(byKey['bottleneck:stock:fuel'].direction, 'refilled')
  assert.equal(byKey['bottleneck:stock:msp'].direction, 'emptied')
  assert.equal(byKey['bottleneck:treasury'].direction, 'overdrawn')

  const credit = at(m, { snapshots: [snap(1000, { wealth: -5 }), snap(3000, { wealth: 0 })] }).items.find((item) => item.key === 'bottleneck:treasury')

  assert.ok(credit && credit.direction === 'credit', 'a treasury back at nothing is no longer below it')
  assert.ok(!at(m, { snapshots: [snap(1000, { wealth: 100 }), snap(3000, { wealth: 50 })] }).items.some((item) => item.kind === 'bottleneck'))
  assert.ok(at(m, { snapshots: [snap(1000, { wealth: 0 }), snap(3000, { wealth: -1 })] }).items.some((item) => item.key === 'bottleneck:treasury'))
})

check('colony-changes', 'a followed colony is compared stock by stock, and a colony gone, regained or not read is one change, never a guess', ({ m }) => {
  const before = rowsOf(crow(10), crow(11), crow(12, 1), crow(13), crow(15, 2))
  const rows = [crow(10, 0, { fuel: 0, Neutronium: 0 }), crow(11, 1), crow(12), crow(13, 4), crow(14), crow(15, 2)]
  const digest = at(m, { before, series: [{ t: 3000, rows }], colonies: colonyList })
  const byKey = Object.fromEntries(digest.items.map((item) => [item.key, item]))

  assert.deepEqual(Object.keys(byKey).filter((key) => key.startsWith('colony:')).sort(), ['colony:10:stock:Neutronium', 'colony:10:stock:fuel', 'colony:11:state', 'colony:12:state'])
  assert.equal(byKey['colony:10:stock:fuel'].from, 5)
  assert.equal(byKey['colony:10:stock:fuel'].to, 0)
  assert.equal(byKey['colony:10:stock:fuel'].direction, 'emptied')
  assert.equal(byKey['colony:10:stock:fuel'].group.name, 'Alpha')
  assert.equal(byKey['colony:10:stock:Neutronium'].units, 't')
  assert.equal(byKey['colony:11:state'].direction, 'lost')
  assert.equal(byKey['colony:11:state'].state, 1)
  assert.equal(byKey['colony:11:state'].area, 'state')
  assert.deepEqual(writtenOf(m, byKey['colony:11:state']).figures, [])
  assert.equal(byKey['colony:12:state'].direction, 'regained')
  assert.equal(byKey['colony:12:state'].area, 'state')
  assert.notEqual(writtenOf(m, byKey['colony:12:state']).text, writtenOf(m, byKey['colony:11:state']).text, 'a colony that is regained is not told as one that is gone')
  assert.deepEqual(digest.unknown.map((entry) => entry.key), ['colony:13'])
  assert.equal(digest.unknown[0].result.value, null)
  assert.equal(digest.unknown[0].result.status, 'unavailable')
})

check('colony-unread', 'colonies the series does not hold at the open save, or holds on another ledger, are unknown, not unchanged', ({ m }) => {
  const before = rowsOf(crow(10))
  const none = at(m, { before, series: null, colonies: colonyList })

  assert.deepEqual(none.unknown.map((entry) => entry.key), ['colony:all'])
  assert.ok(!none.items.some((item) => item.key.startsWith('colony:')))

  const other = m.d.buildDigest({ record: { at: 1, snapshot: m.d.pickSnapshot(snap(1000)), colonies: before, notes: {}, items: {} }, snapshots: [snap(1000), snap(3000)], gameTime: 3000, colonyRecord: { snapshots: [{ t: 3000, n: 31, colonies: [crow(10, 0, { fuel: 0 })] }] }, colonies: colonyList, notes: [] })

  assert.deepEqual(other.unknown.map((entry) => entry.key), ['colony:all'])
  assert.ok(!other.items.some((item) => item.key.startsWith('colony:')), 'a snapshot of another ledger was compared')
  assert.equal(at(m, { before: {}, series: null }).unknown.length, 0)
})

check('notes-changes', 'a project note added, removed or edited is a change, matched by its uuid; a rename of its object is not one', ({ m }) => {
  const atAck = [entry('n1'), entry('n3'), entry('n4'), entry('n5'), entry('n6'), entry('n7', { title: 'T' })]
  const now = [entry('n1'), entry('n2'), entry('n4', { status: 'done' }), entry('n5', { target: { type: 'body', id: 101, name: 'Body' } }), entry('n6', { target: { type: 'body', id: 100, name: 'Renamed' } }), entry('n7', { title: 'T2' })]
  const digest = at(m, { notesAtAck: atAck, notes: now })
  const byKey = Object.fromEntries(digest.items.map((item) => [item.key, item]))

  assert.deepEqual(Object.keys(byKey).sort(), ['note:n2', 'note:n3', 'note:n4', 'note:n5', 'note:n7'])
  assert.equal(byKey['note:n2'].direction, 'added')
  assert.equal(byKey['note:n3'].direction, 'removed')
  assert.deepEqual(byKey['note:n4'].changes.map((change) => change.field), ['status'])
  assert.deepEqual(byKey['note:n5'].changes.map((change) => change.field), ['link'])
  assert.deepEqual(byKey['note:n7'].changes.map((change) => change.field), ['title'])
  assert.equal(byKey['note:n4'].direction, 'edited')
  assert.deepEqual(byKey['note:n4'].changes.map((change) => [change.field, change.from, change.to]), [['status', 'planned', 'done']])
  assert.deepEqual(writtenOf(m, byKey['note:n4']).statuses, ['planned', 'done'], 'the two statuses go through the status formatter')
  assert.ok(writtenOf(m, byKey['note:n4']).text.includes(byKey['note:n4'].label))
  assert.ok(writtenOf(m, byKey['note:n3']).text.includes(byKey['note:n3'].label))
  assert.notEqual(writtenOf(m, byKey['note:n3']).text, writtenOf(m, byKey['note:n4']).text)
  assert.equal(digest.unknown.length, 0)
})

check('notes-unknown', 'notes that could not be read at the boundary or now, or are too many to keep, leave their changes unknown', ({ m }) => {
  const unreadAtAck = at(m, { record: { at: 1, snapshot: m.d.pickSnapshot(snap(1000)), colonies: {}, notes: null, items: {} }, notes: [entry('n1')] })

  assert.deepEqual(unreadAtAck.unknown.map((one) => one.key), ['note:all'])
  assert.ok(!unreadAtAck.items.some((item) => item.kind === 'note'))

  const unreadNow = at(m, { notesAtAck: [entry('n1')], notes: null })

  assert.deepEqual(unreadNow.unknown.map((one) => one.key), ['note:all'])
  assert.equal(unreadNow.unknown[0].result.value, null)
  assert.equal(m.d.noteBaseline(null), null)
  assert.equal(m.d.noteBaseline(Array.from({ length: m.d.MAX_NOTES + 1 }, (_value, index) => entry(`n${index}`))), null)
  assert.deepEqual(m.d.noteBaseline([]), {})
})

check('groups', 'changes are grouped by the object they are about: the race, a followed colony with the notes about it and its body, and any other object of a note', ({ m }) => {
  const digest = at(m, {
    snapshots: [snap(1000), snap(3000, { installations: { 1: 12, 2: 5 } })],
    before: rowsOf(crow(10)),
    series: [{ t: 3000, rows: [crow(10, 0, { fuel: 0 })] }],
    colonies: colonyList,
    notes: [entry('a', { title: 'About the body' }), entry('b', { target: { type: 'body', id: 200, name: 'Other body' } }), entry('c', { target: { type: 'fleet', id: 5, name: 'Fleet' } })],
  })

  assert.deepEqual(digest.groups.map((group) => group.key), ['empire:0', 'colony:10', 'body:200', 'fleet:5'])

  const colony = digest.groups.find((group) => group.key === 'colony:10')

  assert.equal(colony.name, 'Alpha')
  assert.deepEqual(colony.items.map((item) => item.kind), ['bottleneck', 'note'])
  assert.deepEqual(colony.items.map((item) => item.key), ['colony:10:stock:fuel', 'note:a'])
  assert.deepEqual(digest.groups[0].items.map((item) => item.key), ['production:installation:1'])
})

check('acknowledge-item', 'an acknowledged change stays hidden after a reload of the stored acknowledgment, and the other changes still show', ({ m }) => {
  const from = snap(1000)
  const to = snap(3000, { installations: { 1: 12, 2: 5 }, militaryShips: 3 })
  const first = at(m, { from, snapshots: [from, to] })

  assert.deepEqual(keysOf(first), ['production:installation:1', 'production:ships:military'])

  const item = first.items.find((one) => one.key === 'production:installation:1')
  const written = m.d.withItem(m.d.withRecord(m.d.emptyStore(), 'b1', first.record), 'b1', item.key, item.signature)
  const reloaded = m.d.readStore(JSON.parse(JSON.stringify(written)))

  assert.ok(reloaded.ok)

  const second = at(m, { from, snapshots: [from, to], record: m.d.recordOf(reloaded.store, 'b1') })

  assert.equal(second.hidden, 1)
  assert.deepEqual(shownKeys(second), ['production:ships:military'])
  assert.deepEqual(keysOf(second), ['production:installation:1', 'production:ships:military'])
  assert.equal(second.items.find((one) => one.key === item.key).acknowledged, true)
  assert.deepEqual(shownKeys(at(m, { from, snapshots: [from, to], record: first.record })), ['production:installation:1', 'production:ships:military'])
})

check('acknowledge-signature', 'a change that moves again after it was acknowledged shows again; one that is the same stays hidden', ({ m }) => {
  const from = snap(1000)
  const to = snap(3000, { installations: { 1: 12, 2: 5 } })
  const first = at(m, { from, snapshots: [from, to] })
  const item = first.items[0]
  const record = m.d.recordOf(m.d.withItem(m.d.withRecord(m.d.emptyStore(), 'b1', first.record), 'b1', item.key, item.signature), 'b1')
  const same = at(m, { from, snapshots: [from, to, snap(4000, { installations: { 1: 12, 2: 5 } })], gameTime: 4000, record })
  const moved = at(m, { from, snapshots: [from, to, snap(4000, { installations: { 1: 15, 2: 5 } })], gameTime: 4000, record })

  assert.deepEqual(shownKeys(same), [])
  assert.equal(same.hidden, 1)
  assert.deepEqual(shownKeys(moved), ['production:installation:1'])
  assert.equal(moved.hidden, 0)
})

check('acknowledge-all', 'acknowledging the digest moves the boundary to the open save: nothing shows until something changes, and then only the change since', ({ m }) => {
  const from = snap(1000)
  const middle = snap(3000, { installations: { 1: 12, 2: 5 } })
  const rows = [crow(10)]
  const first = at(m, { from, snapshots: [from, middle], before: rowsOf(crow(10)), notesAtAck: [entry('n1')], series: [{ t: 3000, rows }], notes: [entry('n1')], colonies: colonyList })

  assert.deepEqual(keysOf(first), ['production:installation:1'])

  const record = m.d.recordFrom(first.now, 5)

  assert.deepEqual(record.items, {})
  assert.equal(record.snapshot.t, 3000)

  const same = at(m, { snapshots: [from, middle], record, series: [{ t: 3000, rows }], notes: [entry('n1')], colonies: colonyList })

  assert.equal(same.state, 'ready')
  assert.deepEqual(same.items, [])
  assert.deepEqual(same.unknown, [])
  assert.equal(same.coverage.seconds, 0)

  const later = snap(4000, { installations: { 1: 13, 2: 5 } })
  const next = at(m, { snapshots: [from, middle, later], gameTime: 4000, record, series: [{ t: 3000, rows }, { t: 4000, rows: [crow(10, 0, { fuel: 0 })] }], notes: [entry('n1', { status: 'done' })], colonies: colonyList })

  assert.deepEqual(keysOf(next), ['colony:10:stock:fuel', 'note:n1', 'production:installation:1'])
  assert.equal(next.items.find((item) => item.key === 'production:installation:1').from, 12)
  assert.deepEqual(next.unknown, [])
})

check('store-read', 'a stored value of another version or a damaged record is not read, and nothing stored is an empty store', ({ m }) => {
  assert.deepEqual(m.d.readStore(undefined), { ok: true, store: { version: 1, branches: {} } })
  assert.deepEqual(m.d.readStore(null), { ok: true, store: { version: 1, branches: {} } })
  assert.equal(m.d.readStore({ version: 2, branches: {} }).ok, false)
  assert.equal(m.d.readStore('x').ok, false)
  assert.equal(m.d.readStore({ version: 1, branches: { b1: { at: 1, snapshot: { t: 'x' }, colonies: {}, notes: null, items: {} } } }).ok, false)

  const good = { version: 1, branches: { b1: { at: 1, snapshot: snap(1000), colonies: rowsOf(crow(10)), notes: {}, items: { k: 's' } } } }

  assert.deepEqual(m.d.readStore(good), { ok: true, store: good })
})

check('store-save', 'a write goes to the race of the file only, in one update, keeps the other races, and a file or store that cannot be read is never written over', ({ m }) => {
  const keep7 = m.d.recordFrom({ snapshot: snap(500), colonies: {}, notes: {} }, 5)
  const file = settingsOf({ other: 1, races: { 8: m.d.withRecord(m.d.emptyStore(), 'b1', keep7) } })
  const record = m.d.recordFrom({ snapshot: snap(1000), colonies: {}, notes: {} }, 1)
  const written = m.d.saveDigest(file, 7, (store) => m.d.withRecord(store, 'b1', record))

  assert.deepEqual(written.branches.b1, record)

  const content = file.store

  assert.equal(content.other, 1)
  assert.deepEqual(content.races[7], written)
  assert.deepEqual(content.races[8].branches.b1, keep7)
  assert.deepEqual(Object.keys(content.races).sort(), ['7', '8'])

  const unreadable = settingsOf({ races: { 7: { version: 9, branches: {} } } })
  const before = JSON.stringify(unreadable.store)

  assert.throws(() => m.d.saveDigest(unreadable, 7, (store) => m.d.withRecord(store, 'b1', record)), (error) => error.name === 'DigestUnreadable')
  assert.equal(JSON.stringify(unreadable.store), before)

  const damaged = settingsOf({ races: 'x' })

  assert.throws(() => m.d.saveDigest(damaged, 7, (store) => m.d.withRecord(store, 'b1', record)), (error) => error.name === 'DigestUnreadable')
  assert.deepEqual(damaged.store, { races: 'x' })

  const refusing = settingsOf({})

  assert.throws(() => m.d.saveDigest(refusing, 7, () => { throw new Error('refused') }), /refused/)
  assert.deepEqual(refusing.store, {})
  assert.deepEqual(m.d.readRace(undefined, 7), { ok: true, store: m.d.emptyStore() })
  assert.equal(m.d.readRace('x', 7).ok, false)
  assert.deepEqual(m.d.readRace({ 8: keep7 }, 7), { ok: true, store: m.d.emptyStore() })
})

check('store-guard', 'an acknowledgment made on a record that has changed since it was read is refused and writes nothing', ({ m }) => {
  const record = m.d.recordFrom({ snapshot: snap(1000), colonies: {}, notes: {} }, 1)
  const other = m.d.recordFrom({ snapshot: snap(2000), colonies: {}, notes: {} }, 2)
  const file = settingsOf({})

  m.d.saveDigest(file, 7, m.d.guarded('b1', null, (store) => m.d.withRecord(store, 'b1', record)))
  assert.deepEqual(file.store.races[7].branches.b1, record)

  const before = JSON.stringify(file.store)

  assert.throws(() => m.d.saveDigest(file, 7, m.d.guarded('b1', null, (store) => m.d.withRecord(store, 'b1', other))), (error) => error.name === 'DigestChanged')
  assert.equal(JSON.stringify(file.store), before)
  m.d.saveDigest(file, 7, m.d.guarded('b1', record, (store) => m.d.withRecord(store, 'b1', other)))
  assert.deepEqual(file.store.races[7].branches.b1, other)
})

check('store-file', 'the record lives in a file of its own per campaign, never in the settings document and never in the history folder', ({ m }) => {
  const own = m.d.digestStore('c1')
  const again = m.d.digestStore('c1')
  const elsewhere = m.d.digestStore('c2')

  assert.equal(own.key, 'economy-digest/campaign-c1')
  assert.equal(again.key, own.key)
  assert.notEqual(elsewhere.key, own.key)
  assert.notEqual(own.key.split('/')[0], 'history')
  assert.notEqual(own.key, '/config')
  assert.ok(!own.key.startsWith('history/'))

  for (const bad of [undefined, null, 5, '', '../x', 'a/b', 'a.b']) {
    assert.throws(() => m.d.digestStore(bad), /need a campaign/)
  }

  const record = m.d.recordFrom({ snapshot: snap(1000), colonies: {}, notes: {} }, 1)

  stores().set('/config', { campaign: { c1: { race: { 7: { logPins: { keep: true } } } } } })
  m.d.saveDigest(own, 7, (store) => m.d.withRecord(store, 'b1', record))
  assert.deepEqual(stores().get('/config'), { campaign: { c1: { race: { 7: { logPins: { keep: true } } } } } })
  assert.deepEqual([...stores().keys()].sort(), ['/config', 'economy-digest/campaign-c1'])
  assert.deepEqual(stores().get('economy-digest/campaign-c1').races[7].branches.b1, record)
})

check('store-limit', 'the changes acknowledged one at a time are bounded, a known one can still change, and a shown-again change is dropped', ({ m }) => {
  const items = Object.fromEntries(Array.from({ length: m.d.MAX_ITEMS }, (_value, index) => [`k${index}`, 's']))
  const store = m.d.withRecord(m.d.emptyStore(), 'b1', { ...m.d.recordFrom({ snapshot: snap(1000), colonies: {}, notes: {} }, 1), items })

  assert.throws(() => m.d.withItem(store, 'b1', 'new', 's'), (error) => error.name === 'DigestLimit')
  assert.equal(m.d.recordOf(m.d.withItem(store, 'b1', 'k1', 'changed'), 'b1').items.k1, 'changed')
  assert.equal(Object.keys(m.d.recordOf(m.d.withoutItem(store, 'b1', 'k1'), 'b1').items).length, m.d.MAX_ITEMS - 1)
  assert.equal(m.d.withItem(m.d.emptyStore(), 'b1', 'k', 's').branches.b1, undefined)
})

check('gaps-coverage', 'the coverage counts the saves observed strictly between the boundaries, the gaps and the longest stretch, and the ledger increments the two witnesses span', ({ m }) => {
  const from = snap(1000)
  const to = snap(5000)
  const digest = at(m, { from, snapshots: [from, snap(2000), snap(2500), to], gameTime: 5000 })

  assert.equal(digest.state, 'ready')
  assert.equal(digest.coverage.observed, 2)
  assert.deepEqual(digest.coverage.gaps.map((gap) => gap.seconds), [1000, 500, 2500])
  assert.equal(digest.coverage.largest, 2500)
  assert.equal(digest.coverage.seconds, 4000)
  assert.equal(digest.coverage.increments, 40)
  assert.equal(digest.coverage.result.rule.id, 'digest.coverage')

  const unwitnessed = at(m, { from: snap(1000, { chain: undefined }), snapshots: [snap(1000, { chain: undefined }), to], gameTime: 5000 })

  assert.equal(unwitnessed.coverage.increments, null)
  assert.equal(unwitnessed.coverage.observed, 0)
  assert.equal(unwitnessed.coverage.largest, 4000)
})

check('gaps-net', 'what began and ended between two observations leaves no trace, and the text says that only the net change is shown', ({ m }) => {
  const from = snap(1000)
  const to = snap(5000)
  const observed = snap(2000, { minerals: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], wealth: -50, installations: { 1: 30, 2: 5 }, militaryShips: 9 })
  const withMiddle = at(m, { from, snapshots: [from, observed, to], gameTime: 5000 })
  const without = at(m, { from, snapshots: [from, to], gameTime: 5000 })

  assert.deepEqual(keysOf(withMiddle), [])
  assert.deepEqual(keysOf(without), [])
  assert.deepEqual(withMiddle.unknown, [])

  const net = at(m, { from, snapshots: [from, observed, snap(5000, { installations: { 1: 12, 2: 5 } })], gameTime: 5000 })

  assert.deepEqual(keysOf(net), ['production:installation:1'])
  assert.equal(net.items[0].from, 10)
  assert.equal(net.items[0].to, 12)

  const durations = []
  const parts = m.d.coverageParts(withMiddle.coverage, (seconds) => { durations.push(seconds); return `${seconds}s` })

  assert.deepEqual(parts.map((part) => part.kind), ['observed', 'ledger', 'net'])
  assert.ok(parts.every((part) => typeof part.text === 'string' && part.text.length > 0), 'a part of the coverage says nothing')
  assert.equal(parts[0].observed, 1)
  assert.equal(parts[0].seconds, 4000)
  assert.deepEqual(parts[0].widest, withMiddle.coverage.gaps[1])
  assert.equal(parts[0].widest.seconds, 3000)
  assert.deepEqual(durations, [4000, 3000])
  assert.equal(parts[1].increments, 40)
  assert.equal(m.d.coverageText(withMiddle.coverage, String), m.d.coverageParts(withMiddle.coverage, String).map((part) => part.text).join(' '))

  const partsOf = (digest) => m.d.coverageParts(digest.coverage, String)
  const bare = partsOf(without)

  assert.deepEqual(bare.map((part) => part.kind), ['observed', 'ledger', 'net'])
  assert.equal(bare[0].observed, 0)
  assert.equal(bare[0].widest.seconds, 4000)

  const unwitnessed = partsOf(at(m, { from: snap(1000, { chain: undefined }), snapshots: [snap(1000, { chain: undefined }), to], gameTime: 5000 }))

  assert.equal(unwitnessed.find((part) => part.kind === 'ledger').increments, null)
  assert.ok(unwitnessed.find((part) => part.kind === 'ledger').text.length > 0)

  for (const status of ['thinned', 'unknown']) {
    const thinning = partsOf(at(m, { from, snapshots: [from, to], gameTime: 5000, thinning: { status } })).filter((part) => part.kind === 'thinning')

    assert.deepEqual(thinning.map((part) => part.status), [status])
    assert.ok(thinning[0].text.length > 0)
  }

  assert.deepEqual(partsOf(at(m, { from, snapshots: [from, to], gameTime: 5000, thinning: { status: 'none' } })).filter((part) => part.kind === 'thinning'), [])

  const itself = partsOf(at(m, { from, snapshots: [from, snap(1000)], gameTime: 1000 }))

  assert.deepEqual(itself.map((part) => part.kind), ['boundary'])
  assert.equal(itself[0].seconds, 0)
})

check('rewound', 'an open save before the acknowledged boundary compares nothing, and the changes show again once the game passes it on the same history', ({ m }) => {
  const boundary = snap(5000)
  const rewound = at(m, { from: boundary, snapshots: [snap(3000), boundary], gameTime: 3000 })

  assert.equal(rewound.state, 'rewound')
  assert.deepEqual(rewound.items, [])
  assert.deepEqual(rewound.groups, [])
  assert.deepEqual(rewound.unknown, [])
  assert.equal(rewound.coverage, null)
  assert.ok(typeof rewound.reason === 'string' && rewound.reason.length > 0)
  assert.equal(rewound.now.snapshot.t, 3000)

  const passed = at(m, { from: boundary, snapshots: [snap(3000), boundary, snap(6000, { installations: { 1: 11, 2: 5 } })], gameTime: 6000 })

  assert.equal(passed.state, 'ready')
  assert.deepEqual(keysOf(passed), ['production:installation:1'])
})

check('diverged', 'a ledger that does not continue the boundary\'s is not compared, however late the save, and a new boundary can be taken from it', ({ m }) => {
  const from = snap(1000)
  const behind = at(m, { from, snapshots: [from, snap(3000, { chain: { n: 5, digest: '0000000000000005' } })], gameTime: 3000 })
  const forked = at(m, { from, snapshots: [from, snap(3000, { chain: { n: 10, digest: '00000000000000aa' } })], gameTime: 3000 })

  assert.equal(behind.state, 'diverged')
  assert.equal(forked.state, 'diverged')
  assert.deepEqual(behind.items, [])
  assert.deepEqual(forked.groups, [])
  assert.equal(forked.coverage, null)

  const record = m.d.recordFrom(forked.now, 9)
  const next = at(m, { from, snapshots: [from, snap(3000, { chain: { n: 10, digest: '00000000000000aa' } })], gameTime: 3000, record })

  assert.equal(next.state, 'ready')
  assert.deepEqual(next.items, [])
  assert.equal(m.d.judgeBoundary({ from: snap(1000), to: snap(3000), snapshots: [] }).ok, true)
})

check('boundary-witness', 'a history that holds another save at the boundary\'s time than the one acknowledged is not compared', ({ m }) => {
  const from = snap(1000)
  const replayed = at(m, { from, snapshots: [snap(1000, { chain: chain(1000, 7) }), snap(3000)], gameTime: 3000 })

  assert.equal(replayed.state, 'diverged')
  assert.deepEqual(replayed.items, [])
  assert.equal(at(m, { from, snapshots: [snap(1000), snap(3000)], gameTime: 3000 }).state, 'ready')
})

check('isolation-branch', 'a branch reads only its own record; a fork, a branch never acknowledged and a name of the object prototype read none, and a write goes to its own branch', ({ m }) => {
  const one = m.d.recordFrom({ snapshot: snap(1000), colonies: {}, notes: {} }, 1)
  const two = m.d.recordFrom({ snapshot: snap(2000), colonies: {}, notes: {} }, 2)
  const store = m.d.withRecord(m.d.withRecord(m.d.emptyStore(), 'b1', one), 'b2', two)

  assert.deepEqual(m.d.recordOf(store, 'b1'), one)
  assert.deepEqual(m.d.recordOf(store, 'b2'), two)
  assert.equal(m.d.recordOf(store, 'b3'), null)
  assert.equal(m.d.recordOf(store, 'constructor'), null)
  assert.equal(m.d.recordOf(store, null), null)
  assert.equal(m.d.recordOf(m.d.emptyStore(), 'b1'), null)

  const fork = at(m, { from: snap(1000), snapshots: [snap(1000), snap(3000)], record: m.d.recordOf(store, 'b3') })

  assert.equal(fork.state, 'none')
  assert.deepEqual(fork.items, [])

  const acknowledged = m.d.withItem(store, 'b2', 'k', 's')

  assert.deepEqual(m.d.recordOf(acknowledged, 'b1'), one)
  assert.equal(m.d.recordOf(acknowledged, 'b2').items.k, 's')
})

check('component-write', 'the panel writes the acknowledgment under the race and the branch in the file of the campaign, and not in the settings', async ({ component, m }) => {
  const options = await component()

  seed({ snapshots: [snap(1000), snap(3000, { installations: { 1: 12, 2: 5 } })] })

  const settings = settingsOf({ campaign: { c1: { race: { 7: { logPins: { keep: true } } } } } })
  const before = JSON.stringify(settings.store)
  const vm = mounted(options, { config: settings, gameTime: 1000 })

  assert.equal(vm.digest.state, 'none')
  assert.equal(vm.acknowledgeable, true)
  await vm.acknowledge()
  assert.equal(vm.message, '')

  const race = digestRace('c1', 7)

  assert.deepEqual(Object.keys(race.branches), ['b1'])
  assert.equal(race.branches.b1.snapshot.t, 1000)
  assert.equal(JSON.stringify(settings.store), before)
  assert.equal(vm.digest.state, 'ready')
  assert.ok(m.d.readStore(race).ok)
  assert.deepEqual([...stores().keys()].filter((key) => key.startsWith('economy-digest/')), ['economy-digest/campaign-c1'])
})

check('component-reload', 'an acknowledged change does not return when the panel is built again from the stored file, and Show them again brings it back', async ({ component }) => {
  const options = await component()

  seed({ snapshots: [snap(1000), snap(3000, { installations: { 1: 12, 2: 5 } })] })

  const settings = settingsOf({})

  await mounted(options, { config: settings, gameTime: 1000 }).acknowledge()

  const vm = mounted(options, { config: settings, gameTime: 3000 })

  assert.equal(vm.digest.state, 'ready')
  assert.deepEqual(keysOf(vm.digest), ['production:installation:1'])
  assert.equal(vm.shownCount, 1)
  assert.match(vm.caption, /\b1\b/, 'the caption carries the count of changes to show')
  await vm.acknowledgeItem(vm.digest.items[0])

  const reloaded = mounted(options, { config: settingsOf({}), gameTime: 3000 })

  assert.deepEqual(reloaded.digest.groups, [])
  assert.equal(reloaded.digest.hidden, 1)
  assert.equal(reloaded.shownCount, 0)
  assert.match(reloaded.caption, /\b0\b/, 'the caption carries the count of changes to show')

  const shown = mounted(options, { config: settings, gameTime: 3000 })

  await shown.showAcknowledged()
  assert.deepEqual(shownKeys(mounted(options, { config: settings, gameTime: 3000 }).digest), ['production:installation:1'])
})

check('component-isolation', 'another branch, race or campaign never reads or repeats an acknowledgment, and a branch without history compares nothing', async ({ component }) => {
  const options = await component()
  const snapshots = [snap(1000), snap(3000, { installations: { 1: 12, 2: 5 } })]

  seed({ snapshots })
  seed({ branchId: 'b2', snapshots })
  seed({ campaignId: 'c2', snapshots })
  seed({ RaceID: 8, snapshots: [snap(1000), snap(3000), snap(5000)] })

  const settings = settingsOf({})

  await mounted(options, { config: settings, gameTime: 1000 }).acknowledge()
  assert.equal(mounted(options, { config: settings, gameTime: 3000 }).digest.state, 'ready')

  const sibling = mounted(options, { config: settings, campaign: { campaignId: 'c1', branchId: 'b2', generation: 1 }, gameTime: 3000 })

  assert.equal(sibling.digest.state, 'none')
  assert.deepEqual(sibling.digest.items, [])

  const other = mounted(options, { config: settings, campaign: { campaignId: 'c2', branchId: 'b1', generation: 1 }, gameTime: 3000 })

  assert.equal(other.digest.state, 'none')

  const race = mounted(options, { config: settings, raceId: 8, gameTime: 5000 })

  assert.equal(race.digest.state, 'none')

  const empty = mounted(options, { config: settings, campaign: { campaignId: 'c1', branchId: 'b3', generation: 1 }, gameTime: 3000 })

  assert.equal(empty.digest.state, 'unrecorded')
  await sibling.acknowledge()
  assert.deepEqual(Object.keys(digestRace('c1', 7).branches).sort(), ['b1', 'b2'])
  assert.equal(digestDocument('c2'), undefined)
  assert.deepEqual(keysOf(mounted(options, { config: settings, gameTime: 3000 }).digest), ['production:installation:1'])
})

check('component-stale', 'an acknowledgment made on a digest another window has since changed is refused', async ({ component, m }) => {
  const options = await component()

  seed({ snapshots: [snap(1000), snap(3000)] })

  const vm = mounted(options, { config: settingsOf({}), gameTime: 3000 })
  const other = m.d.recordFrom({ snapshot: snap(2000), colonies: {}, notes: {} }, 2)

  assert.equal(vm.digest.state, 'none')
  // Another window acknowledges after this panel read the file and before it writes it.
  globalThis.__economyDigestBetween = () => m.d.saveDigest(m.d.digestStore('c1'), 7, (store) => m.d.withRecord(store, 'b1', other))
  await vm.acknowledge()
  assert.equal(vm.failureName, 'DigestChanged')
  assert.equal(vm.messageType, 'warning')
  assert.deepEqual(digestRace('c1', 7).branches.b1, other)
})

check('component-unreadable', 'a stored acknowledgment this version cannot read is shown as unreadable and never written over', async ({ component }) => {
  const options = await component()

  seed({ snapshots: [snap(1000), snap(3000)] })
  stores().set('economy-digest/campaign-c1', { races: { 7: { version: 9, branches: {} } } })

  const before = JSON.stringify(digestDocument('c1'))
  const vm = mounted(options, { config: settingsOf({}), gameTime: 3000 })

  assert.equal(vm.problemKind, 'file')
  assert.ok(vm.problem)
  assert.equal(vm.acknowledgeable, false)
  await vm.acknowledge()
  assert.equal(JSON.stringify(digestDocument('c1')), before)
  assert.equal(vm.failureName, 'DigestUnreadable')
})

// The elements of a compiled Vue template and the attribute a start tag carries (static or bound).
const elementsOf = (root) => {
  const found = []
  const walk = (node) => {
    found.push(node)
    node.children.filter((child) => child.type === 1).forEach(walk)
    ;(node.ifConditions || []).slice(1).forEach(({ block }) => walk(block))
    Object.values(node.scopedSlots || {}).forEach(walk)
  }

  walk(root)

  return found
}

const textNodesOf = (nodes) => nodes.flatMap((node) => node.children.filter((child) => child.type === 2 || child.type === 3).map((child) => child.text))

const attrOf = (node, name) => {
  const found = node.attrsList.find((attr) => attr.name === name || attr.name === `:${name}`)

  return found ? found.value : undefined
}

const templateOf = (source, filename) => {
  const descriptor = compiler.parse({ source, filename })

  return compiler.compileTemplate({ source: descriptor.template.content, filename, id: filename }).ast
}

// A bound expression of a template evaluated against the figures it names, as the template's own scope would.
// eslint-disable-next-line no-new-func
const evaluated = (expression, scope) => new Function('scope', `with (scope) { return (${expression}) }`)(scope)

check('template', 'the panel names what it is for in the page\'s voice, marks every figure with its provenance and keeps the unknown apart', ({ m, text }) => {
  const root = templateOf(text.vue, 'ChangeDigest.vue')
  const nodes = elementsOf(root)
  const panels = nodes.filter((node) => node.staticClass && JSON.parse(node.staticClass).split(' ').includes('panel'))

  assert.equal(panels.length, 1)
  assert.equal(panels[0], root)

  const summary = attrOf(root, 'data-summary')

  assert.equal(typeof summary, 'string', 'the panel carries a data-summary')
  assert.ok(summary.trim().length > 0 && summary.length < 600)
  assert.doesNotMatch(summary, /\b(I|me|my|we|our|you|your)\b/i)
  assert.doesNotMatch(summary, /\d/)
  assert.doesNotMatch(textNodesOf(nodes).join(' '), /\b(I|me|my|we|our|you|your)\b/)

  const digest = at(m, { snapshots: [snap(1000), snap(3000, { installations: { 1: 12, 2: 5 }, militaryShips: null })] })

  assert.equal(digest.state, 'ready')
  assert.ok(digest.items.length > 0 && digest.unknown.length > 0)

  const figures = {
    'data-digest-boundary': { scope: { digest }, expected: digest.coverage.result },
    'data-digest-item': { scope: { item: digest.items[0] }, expected: digest.items[0].result },
    'data-digest-unknown-item': { scope: { entry: digest.unknown[0] }, expected: digest.unknown[0].result },
  }

  for (const [marker, { scope, expected }] of Object.entries(figures)) {
    const carriers = nodes.filter((node) => attrOf(node, marker) !== undefined)

    assert.equal(carriers.length, 1, `${marker} is carried by one element`)

    const marks = elementsOf(carriers[0]).filter((node) => node.tag === 'provenance-mark')

    assert.equal(marks.length, 1, `${marker} carries one provenance mark`)

    const result = evaluated(attrOf(marks[0], 'result'), scope)

    assert.ok(result && result.rule && result.rule.id, `${marker}: the mark is bound to a provenance result`)
    assert.equal(result, expected, `${marker}: the mark shows the result of its own figure`)
  }
})

const camelized = (name) => name.replace(/-(\w)/g, (_match, letter) => letter.toUpperCase())

check('page-wiring', 'the Notebook hosts the panel with every prop bound to the value it names, and tracks the installation names it reads under one name that a failed read reports', async ({ m, text, component, trackedPage }) => {
  const options = await trackedPage()
  const declared = Object.keys((await component()).props).sort()

  assert.ok(options.components.ChangeDigest)
  assert.ok(options.asyncComputed.installationNames)

  const hosts = elementsOf(templateOf(text.page, 'notebook.vue')).filter((node) => node.tag === 'change-digest')

  assert.equal(hosts.length, 1)

  const bound = Object.fromEntries(hosts[0].attrsList.filter((attr) => attr.name.startsWith(':')).map((attr) => [camelized(attr.name.slice(1)), attr.value]))

  assert.deepEqual(Object.keys(bound).sort(), declared)

  const w = worldOf(m)

  await keepNote(m, w, contextOf([bodyRow(100, 'Earth', 2000)]), 100)

  const stateOf = (history, generation) => ({ history: { revision: 3, ...history }, freshness: { generation } })
  const pageOf = (database, state = stateOf({ failures: [{ GameID: 1, stage: 'write' }], passes: { 1: 5 } }, 5)) => instantiate(options, { $store: { getters: { config: { get: (_key, fallback) => fallback }, database, GameID: 1, GameTime: 100000, RaceID: 7, StartYear: 2000, 'history/campaign': CAMPAIGN }, state }, GameID: 1, RaceID: 7, data: { records: { repository: w.repo, error: null } } })
  const vm = pageOf({ query: async () => [[{ PlanetaryInstallationID: 1, Name: 'Mines' }]] })

  assert.deepEqual(await vm.runAsync('installationNames'), { 1: 'Mines' })
  assert.equal(vm.loadErrors.installationNames, null)
  assert.deepEqual(vm.failedInputs, [])
  assert.equal(vm.digestNotes.length, 1)

  const expected = { config: vm.config, campaign: CAMPAIGN, raceId: 7, gameTime: 100000, notes: vm.digestNotes, names: { 1: 'Mines' }, startYear: 2000, separator: '\'', historyRevision: 3, recording: 'write' }

  for (const [prop, expression] of Object.entries(bound)) {
    assert.deepEqual(evaluated(expression, vm), expected[prop], `${prop} is bound to ${expression}`)
  }

  // What the page tells the panel of the recorder: a failure first, then only a pass that wrote this game on this copy of the save.
  const recordingOn = (history, generation) => pageOf(null, stateOf(history, generation)).recording

  assert.equal(recordingOn({ failures: [], passes: { 1: 5 } }, 5), '')
  assert.equal(recordingOn({ failures: [], passes: { 1: 5 } }, 6), 'pending')
  assert.equal(recordingOn({ failures: [], passes: {} }, 5), 'pending')
  assert.equal(recordingOn({ failures: [{ GameID: 1, stage: 'registry' }], passes: { 1: 5 } }, 5), 'registry')

  const failing = pageOf({ query: async () => { throw new Error('no such table') } })

  await assert.rejects(() => failing.runAsync('installationNames'))
  assert.deepEqual(failing.failedInputs, ['installationNames'])
  assert.ok(failing.failedInputsText.length > 0, 'the failed read is named')
})

check('web-interleave', 'two tabs of the web build never write over each other: the one that read an older record is refused, and an acknowledgment of another race or campaign is not lost', async ({ m, Shim }) => {
  const recordA = m.d.recordFrom({ snapshot: snap(1000), colonies: {}, notes: {} }, 1)
  const recordB = m.d.recordFrom({ snapshot: snap(2000), colonies: {}, notes: {} }, 2)

  // Tab A writes; while its change is being made (after it read the file, before it writes it) tab B acknowledges too.
  const interleaved = async (second) => {
    const storage = fakeLocalStorage()

    globalThis.localStorage = storage

    try {
      const locks = fakeLocks()
      let pending = null

      await m.d.saveDigestSafely(m.d.digestStore('c1', Shim), 7, m.d.guarded('b1', null, (store) => {
        pending = m.d.saveDigestSafely(m.d.digestStore(second.campaignId, Shim), second.RaceID, m.d.guarded('b1', null, (other) => m.d.withRecord(other, 'b1', recordB)), locks).then(() => 'written', (error) => error.name)

        return m.d.withRecord(store, 'b1', recordA)
      }), locks)

      const outcome = await pending
      const file = (campaignId) => JSON.parse(storage.items.get(`aurora-electrons:economy-digest/campaign-${campaignId}`) || 'null')

      return { outcome, c1: file('c1'), c2: file('c2') }
    } finally {
      delete globalThis.localStorage
    }
  }

  const same = await interleaved({ campaignId: 'c1', RaceID: 7 })

  assert.equal(same.outcome, 'DigestChanged')
  assert.deepEqual(same.c1.races[7].branches.b1, recordA)

  const race = await interleaved({ campaignId: 'c1', RaceID: 8 })

  assert.equal(race.outcome, 'written')
  assert.deepEqual(race.c1.races[7].branches.b1, recordA)
  assert.deepEqual(race.c1.races[8].branches.b1, recordB)

  const other = await interleaved({ campaignId: 'c2', RaceID: 8 })

  assert.equal(other.outcome, 'written')
  assert.deepEqual(other.c1.races[7].branches.b1, recordA)
  assert.deepEqual(other.c2.races[8].branches.b1, recordB)
})

check('web-shared-document', 'a pin or a snooze written over an older copy of the shared settings document in the web build never takes an acknowledgment back, and the acknowledged change stays hidden after a reload', async ({ m, Shim }) => {
  const from = snap(1000)
  const to = snap(3000, { installations: { 1: 12, 2: 5 } })
  const first = at(m, { from, snapshots: [from, to] })
  const item = first.items[0]
  const pins = { version: 1, seeded: {}, pins: [{ id: 'p1', branch: 'b1' }] }
  const snoozed = { 'check:1': { until: 5 } }
  const storage = fakeLocalStorage()

  globalThis.localStorage = storage

  try {
    const settings = () => new Shim({})
    const race = (document) => document.campaign.c1.race[7]
    const withRace = (document, values) => ({ ...document, campaign: { ...document.campaign, c1: { ...document.campaign.c1, race: { ...document.campaign.c1.race, 7: { ...race(document), ...values } } } } })

    settings().store = { campaign: { c1: { race: { 7: { mapPinned: [1] } } } } }

    const pinsTab = settings()
    const snoozeTab = settings()
    const pinsRead = pinsTab.store
    const snoozeRead = snoozeTab.store

    await m.d.saveDigestSafely(m.d.digestStore('c1', Shim), 7, m.d.guarded('b1', null, (store) => m.d.withItem(m.d.withRecord(store, 'b1', first.record), 'b1', item.key, item.signature)), fakeLocks())

    pinsTab.store = withRace(pinsRead, { logPins: pins })
    snoozeTab.store = withRace(snoozeRead, { warningsSnoozed: snoozed })
    settings().set('campaign.c1.race.7.logPins', pins)
    settings().set('campaign.c1.race.7.warningsSnoozed', snoozed)

    const reloaded = m.d.readRace(m.d.digestStore('c1', Shim).get('races', undefined), 7)

    assert.ok(reloaded.ok)

    const record = m.d.recordOf(reloaded.store, 'b1')

    assert.deepEqual(record, m.d.recordOf(m.d.withItem(m.d.withRecord(m.d.emptyStore(), 'b1', first.record), 'b1', item.key, item.signature), 'b1'))
    assert.deepEqual(race(settings().store).logPins, pins)
    assert.deepEqual(race(settings().store).warningsSnoozed, snoozed)
    assert.equal(at(m, { from, snapshots: [from, to], record }).hidden, 1)
    assert.deepEqual(shownKeys(at(m, { from, snapshots: [from, to], record })), [])
    assert.deepEqual(settings().store, { campaign: { c1: { race: { 7: { mapPinned: [1], logPins: pins, warningsSnoozed: snoozed } } } } })
  } finally {
    delete globalThis.localStorage
  }
})

check('web-unprotected', 'with no Web Locks the web build writes nothing, and a store that is atomic itself is written directly', async ({ m, Shim }) => {
  const record = m.d.recordFrom({ snapshot: snap(1000), colonies: {}, notes: {} }, 1)
  const storage = fakeLocalStorage()

  globalThis.localStorage = storage

  try {
    await assert.rejects(() => m.d.saveDigestSafely(m.d.digestStore('c1', Shim), 7, (store) => m.d.withRecord(store, 'b1', record), null), (error) => error.name === 'DigestUnprotected')
    assert.equal(storage.items.size, 0)
  } finally {
    delete globalThis.localStorage
  }

  const plain = settingsOf({})
  const written = await m.d.saveDigestSafely(plain, 7, (store) => m.d.withRecord(store, 'b1', record), null)

  assert.deepEqual(plain.store.races[7], written)
})

check('component-web', 'the panel in the web build writes only under the lock, in its own file, and says so when the browser has none', async ({ webComponent }) => {
  const options = await webComponent()
  const storage = fakeLocalStorage()
  const navigatorWas = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const historyKey = 'aurora-electrons:history/campaign-c1-b1'

  storage.items.set(historyKey, JSON.stringify({ races: { 7: { snapshots: [snap(1000), snap(3000)] } } }))
  globalThis.localStorage = storage

  try {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })

    const vm = mounted(options, { config: settingsOf({}), gameTime: 1000 })

    await vm.acknowledge()
    assert.equal(vm.failureName, 'DigestUnprotected')
    assert.deepEqual([...storage.items.keys()], [historyKey])

    Object.defineProperty(globalThis, 'navigator', { value: { locks: fakeLocks() }, configurable: true, writable: true })

    const locked = mounted(options, { config: settingsOf({}), gameTime: 1000 })

    await locked.acknowledge()
    assert.equal(locked.message, '')
    assert.deepEqual(Object.keys(JSON.parse(storage.items.get('aurora-electrons:economy-digest/campaign-c1')).races[7].branches), ['b1'])
    assert.equal(storage.items.has('aurora-electrons:config'), false)
  } finally {
    delete globalThis.localStorage

    if (navigatorWas) {
      Object.defineProperty(globalThis, 'navigator', navigatorWas)
    } else {
      delete globalThis.navigator
    }
  }
})

check('component-queued', 'an acknowledgment that waits for the lock is made for the scope it was asked in: a panel that shows another branch, campaign or race when the turn comes writes nothing, for acknowledge-all, one change and show-again alike', async ({ webComponent, m }) => {
  const options = await webComponent()
  const snapshots = [snap(1000), snap(3000, { installations: { 1: 12, 2: 5 } })]
  const navigatorWas = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  const setup = async (operation) => {
    const storage = fakeLocalStorage()
    const locks = fakeLocks()

    for (const [campaignId, branchId, RaceID] of [['c1', 'b1', 7], ['c1', 'b2', 7], ['c2', 'b1', 7], ['c1', 'b1', 8]]) {
      const key = `aurora-electrons:history/campaign-${campaignId}-${branchId}`
      const document = JSON.parse(storage.items.get(key) || '{"races":{}}')

      document.races[RaceID] = { snapshots }
      storage.items.set(key, JSON.stringify(document))
    }

    globalThis.localStorage = storage
    Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true })
    await mounted(options, { config: settingsOf({}), gameTime: 1000 }).acknowledge()

    const vm = mounted(options, { config: settingsOf({}), gameTime: 3000 })

    if (operation === 'showAcknowledged') {
      await vm.acknowledgeItem(vm.digest.items[0])
    }

    return { storage, locks, vm }
  }

  // The operation is asked while another tab holds the lock; `change` moves the panel to another scope before the lock is released.
  const queued = async (operation, change) => {
    const { storage, locks, vm } = await setup(operation)
    let release = null
    const held = locks.request(m.d.DIGEST_LOCK, () => new Promise((resolve) => { release = resolve }))
    const files = () => JSON.stringify([...storage.items].filter(([key]) => key.startsWith('aurora-electrons:economy-digest/')))
    const before = files()
    const pending = operation === 'acknowledgeItem' ? vm.acknowledgeItem(vm.digest.items[0]) : vm[operation]()

    change(vm)
    release()
    await held
    await pending

    return { unchanged: files() === before, failureName: vm.failureName }
  }

  const changes = {
    branch: (vm) => { vm.campaign = { ...vm.campaign, branchId: 'b2' } },
    campaign: (vm) => { vm.campaign = { ...vm.campaign, campaignId: 'c2' } },
    race: (vm) => { vm.raceId = 8 },
  }

  try {
    for (const operation of ['acknowledge', 'acknowledgeItem', 'showAcknowledged']) {
      const control = await queued(operation, () => {})

      assert.equal(control.unchanged, false, `${operation} waiting for the lock was never written`)
      assert.equal(control.failureName, '')

      for (const [name, change] of Object.entries(changes)) {
        const outcome = await queued(operation, change)

        assert.equal(outcome.unchanged, true, `${operation} written after the ${name} changed while it waited`)
        assert.equal(outcome.failureName, 'DigestScopeChanged')
      }
    }
  } finally {
    delete globalThis.localStorage

    if (navigatorWas) {
      Object.defineProperty(globalThis, 'navigator', navigatorWas)
    } else {
      delete globalThis.navigator
    }
  }
})

check('component-damaged', 'a digest file that is not valid JSON is reported as unreadable by the panel in the web build, and no acknowledgment operation changes its bytes', async ({ webComponent, m, Shim }) => {
  const options = await webComponent()
  const storage = fakeLocalStorage()
  const fileKey = 'aurora-electrons:economy-digest/campaign-c1'
  const navigatorWas = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  storage.items.set('aurora-electrons:history/campaign-c1-b1', JSON.stringify({ races: { 7: { snapshots: [snap(1000), snap(3000)] } } }))
  storage.items.set(fileKey, '{broken')
  globalThis.localStorage = storage

  try {
    Object.defineProperty(globalThis, 'navigator', { value: { locks: fakeLocks() }, configurable: true, writable: true })

    const vm = mounted(options, { config: settingsOf({}), gameTime: 3000 })

    assert.equal(vm.problemKind, 'file')
    assert.ok(vm.problem)
    assert.equal(vm.acknowledgeable, false)

    for (const run of [() => vm.acknowledge(), () => vm.acknowledgeItem({ key: 'production:installation:1', signature: 's' }), () => vm.showAcknowledged()]) {
      await run()
      assert.equal(storage.items.get(fileKey), '{broken')
      assert.ok(vm.failureName && vm.failureName !== 'DigestChanged')
    }

    const record = m.d.recordFrom({ snapshot: snap(1000), colonies: {}, notes: {} }, 1)

    assert.throws(() => m.d.digestStore('c1', Shim).get('races', undefined))
    await assert.rejects(() => m.d.saveDigestSafely(m.d.digestStore('c1', Shim), 7, (store) => m.d.withRecord(store, 'b1', record), fakeLocks()))
    assert.equal(storage.items.get(fileKey), '{broken')
  } finally {
    delete globalThis.localStorage

    if (navigatorWas) {
      Object.defineProperty(globalThis, 'navigator', navigatorWas)
    } else {
      delete globalThis.navigator
    }
  }
})

check('notes-partial', 'a note this version cannot read, still stored, makes the project notes unknown on the page and in the boundary, never a removed note', async ({ m, page }) => {
  const options = await page()
  const inst = memory()
  const w = worldOf(m, inst)
  const context = contextOf([bodyRow(100, 'Earth', 2000), bodyRow(101, 'Mars', 2000)])

  await keepNote(m, w, context, 100)
  await keepNote(m, w, context, 101)

  const vm = instantiate(options, { $store: { getters: { config: { get: (_key, fallback) => fallback }, database: null, GameID: 1, GameTime: 100000, RaceID: 7, 'history/campaign': CAMPAIGN }, state: { history: { revision: 0, failures: [] } } }, GameID: 1, RaceID: 7, data: { records: { repository: w.repo, error: null } } })

  assert.equal(vm.digestNotes.length, 2)

  const baseline = vm.digestNotes
  const file = inst.files.get('campaign-c1')

  Object.values(file.records)[0].schema = 2
  inst.files.set('campaign-c1', file)
  assert.equal(vm.read.error, null)
  assert.equal(vm.read.entries.length, 1)
  assert.equal(vm.read.notes.length, 1)
  assert.equal(vm.digestNotes, null)

  const digest = at(m, { notesAtAck: baseline, notes: vm.digestNotes })

  assert.ok(!digest.items.some((item) => item.direction === 'removed'))
  assert.deepEqual(digest.unknown.map((one) => one.key), ['note:all'])
  assert.equal(digest.now.notes, null)
})

check('notes-relink', 'a relink to another object that reuses the ID, or to the same one from another branch, is an edit of the note; a rename of the same object is not', async ({ m }) => {
  const w = worldOf(m)
  const original = contextOf([bodyRow(100, 'Earth', 2000)], 'b1')

  await keepNote(m, w, original, 100)

  const [linked] = entriesOnBranch(m, w, original, 'b1')

  const renamed = contextOf([bodyRow(100, 'Terra', 2000)], 'b1')

  await keepNote(m, w, renamed, 100, { entry: linked, title: linked.title })

  const [afterRename] = entriesOnBranch(m, w, renamed, 'b1')

  assert.equal(afterRename.target.name, 'Terra')
  assert.deepEqual(keysOf(at(m, { notesAtAck: [linked], notes: [afterRename] })), [])

  const reused = contextOf([bodyRow(100, 'Earth', 3000)], 'b2')
  const [stale] = entriesOnBranch(m, w, reused, 'b2')

  assert.equal(stale.link.status, 'changed')
  assert.equal(stale.stale, true)
  assert.deepEqual(keysOf(at(m, { notesAtAck: [linked], notes: [stale] })), [])

  await keepNote(m, w, reused, 100, { entry: stale, title: stale.title, relink: true, branchId: 'b2' })

  const [relinked] = entriesOnBranch(m, w, reused, 'b2')

  assert.equal(relinked.link.status, 'linked')
  assert.notEqual(relinked.links[0].fingerprint, stale.links[0].fingerprint)
  assert.equal(relinked.target.id, stale.target.id)

  const digest = at(m, { notesAtAck: [stale], notes: [relinked] })

  assert.deepEqual(keysOf(digest), [`note:${stale.uuid}`])
  assert.deepEqual(digest.items[0].changes.map((change) => [change.field, change.sameId]), [['link', true]])
  assert.ok(digest.items[0].changes.every((change) => change.sameId === true))

  const other = worldOf(m)
  const early = contextOf([bodyRow(100, 'Earth', 500)], 'b1')

  await keepNote(m, other, early, 100)

  const [first] = entriesOnBranch(m, other, early, 'b1')

  await keepNote(m, other, contextOf([bodyRow(100, 'Earth', 500)], 'b2'), 100, { entry: first, title: first.title, relink: true, branchId: 'b2' })

  const [again] = entriesOnBranch(m, other, contextOf([bodyRow(100, 'Earth', 500)], 'b2'), 'b2')

  assert.equal(again.links[0].fingerprint, first.links[0].fingerprint)
  assert.deepEqual(keysOf(at(m, { notesAtAck: [first], notes: [again] })), [`note:${first.uuid}`])

  const same = worldOf(m)
  const before = contextOf([bodyRow(100, 'Earth', 2000)], 'b1')

  await keepNote(m, same, before, 100)

  const [made] = entriesOnBranch(m, same, before, 'b1')
  const reusedOnB1 = contextOf([bodyRow(100, 'Earth', 3000)], 'b1')

  assert.equal(entriesOnBranch(m, same, reusedOnB1, 'b1')[0].link.status, 'changed')
  await keepNote(m, same, reusedOnB1, 100, { entry: made, title: made.title, relink: true })

  const [swapped] = entriesOnBranch(m, same, reusedOnB1, 'b1')

  assert.equal(swapped.target.origin.branchId, made.target.origin.branchId)
  assert.notEqual(swapped.links[0].fingerprint, made.links[0].fingerprint)
  assert.deepEqual(keysOf(at(m, { notesAtAck: [made], notes: [swapped] })), [`note:${made.uuid}`])
})

check('groups-stale', 'a note whose link is stale, not checked or gone is never grouped with a live colony on the object the ID names now', async ({ m }) => {
  const w = worldOf(m)
  const original = contextOf([bodyRow(100, 'Earth', 2000)], 'b1')
  const replacement = [{ id: 10, name: 'Colony on replacement body', bodyId: 100 }]

  await keepNote(m, w, original, 100)

  const reused = contextOf([bodyRow(100, 'Earth', 3000)], 'b2')
  const [stale] = entriesOnBranch(m, w, reused, 'b2')
  const digest = at(m, { notes: [stale], colonies: replacement })

  assert.deepEqual(digest.groups.map((group) => group.key), ['body:100:stale'])
  assert.equal(digest.groups[0].stale, true)

  await keepNote(m, w, reused, 100, { entry: stale, title: stale.title, relink: true, branchId: 'b2' })

  const [relinked] = entriesOnBranch(m, w, reused, 'b2')

  assert.deepEqual(at(m, { notes: [relinked], colonies: replacement }).groups.map((group) => [group.key, group.stale]), [['colony:10', false]])
  assert.deepEqual(at(m, { notes: [entry('u', { link: { status: 'unknown' } })], colonies: replacement }).groups.map((group) => group.key), ['body:100:stale'])
  assert.deepEqual(at(m, { notesAtAck: [entry('r')], notes: [], colonies: replacement }).groups.map((group) => group.key), ['body:100:stale'])
})

// A save of game 1 whose ledger holds `n` increments (its game time is the last one's) and whose treasury is `wealth`.
const recordedSave = ({ n, wealth, raced = true }) => {
  const ledger = Array.from({ length: n }, (_, index) => ({ IncrementID: index + 1, GameTime: (index + 1) * 5 + 1000003 }))
  const anchor = Array.from({ length: 10 }, (_, index) => ({ SystemID: 100 + index, SystemNumber: index + 1, Age: Number((1.01 + index / 1000).toFixed(4)), AbundanceModifier: 1, Stars: 1, DustDensity: 1, SystemTypeID: 1 }))
  const t = ledger[n - 1].GameTime

  return {
    GameID: 1,
    t,
    transaction: async (work) => work({ id: 'transaction' }),
    query: async (sql) => {
      if (sql.startsWith('select FCT_Race.GameID')) {
        return [raced ? [{ GameID: 1, RaceID: 7, NPR: 0, SpecialNPRID: 0 }] : []]
      }

      if (sql.startsWith('select FCT_Game.GameID')) {
        return [[{ GameID: 1, GameName: 'Campaign', GameTime: t }]]
      }

      if (sql.startsWith('select FCT_System.SystemID')) {
        return [anchor]
      }

      if (sql.startsWith('select FCT_Increments.IncrementID')) {
        return [ledger]
      }

      if (sql.startsWith('select FCT_Game.GameTime')) {
        return [[{ GameTime: t, GameName: 'Campaign', RaceTitle: 'Race', WealthPoints: wealth, AnnualWealth: 0 }]]
      }

      if (sql.startsWith('select (select case when count(FCT_TechSystem')) {
        return [[{ Research: 0, Systems: 0, Commanders: 0 }]]
      }

      return [[]]
    },
  }
}

// The root store the recorder plugin runs against, by the table of calls of scripts/lib/store-routes.js: it answers the plugin's dispatch of `capabilities/preflight` with no options and its commits of the history module's mutations by their full names with no options; any other call is recorded as not accepted, not applied and answered with undefined. `rejected()` lists those calls, for the check to assert that its run made none.
const recorderStore = (state, mutations, { watch = () => {}, afterCommit = () => {} } = {}) => {
  const dispatches = routeTable([{ type: 'capabilities/preflight', root: false }])
  const commits = routeTable(Object.keys(mutations).map((name) => ({ type: `history/${name}`, root: false })))

  return {
    store: {
      state,
      getters: { config: { store: {}, get: () => undefined, set: () => {} } },
      watch: (_select, callback) => watch(callback),
      dispatch: async (type, _payload, options) => (dispatches.take(type, options) ? null : undefined),
      commit: (type, payload, options) => {
        if (!commits.take(type, options)) {
          return
        }

        const name = type.slice('history/'.length)

        mutations[name](state.history, payload)
        afterCommit(name)
      },
    },
    dispatched: dispatches.calls,
    committed: commits.calls,
    rejected: () => [...dispatches.rejected(), ...commits.rejected()],
  }
}

check('recording-routes', 'the recorder\'s store records and rejects, answering undefined, a dispatch or commit that is not an action or mutation of the root store, a prefixed name and a call with options, and answers the plugin\'s own calls', async ({ m }) => {
  const state = { history: m.historyStore.state() }
  const stub = recorderStore(state, m.historyStore.mutations)
  const answers = [await stub.store.dispatch('not-an-action'), await stub.store.dispatch('peeks/capabilities/preflight'), await stub.store.dispatch('capabilities/preflight', null, { root: true }), await stub.store.dispatch('capabilities/preflight')]

  stub.store.commit('not-an-action', 1)
  stub.store.commit('peeks/history/recorded', 2)
  stub.store.commit('history/recorded', 3, { root: true })

  const before = JSON.stringify(state.history)

  stub.store.commit('history/recorded', 4)

  assert.deepEqual(answers, [undefined, undefined, undefined, null])
  assert.deepEqual(stub.dispatched.map(({ type, accepted }) => [type, accepted]), [['not-an-action', false], ['peeks/capabilities/preflight', false], ['capabilities/preflight', false], ['capabilities/preflight', true]])
  assert.deepEqual(stub.committed.map(({ type, accepted }) => [type, accepted]), [['not-an-action', false], ['peeks/history/recorded', false], ['history/recorded', false], ['history/recorded', true]])
  assert.equal(stub.rejected().length, 6)
  assert.notEqual(JSON.stringify(state.history), before, 'the one accepted commit was not applied')
})

check('recording-gate', 'the digest compares and acknowledges only once the recorder has completed a pass that wrote the open save: while the pass runs, after a refused write and before any pass it is unconfirmed, and the older snapshot of the same game time is never taken for it', async ({ component, page, m }) => {
  const options = await component()
  const pageOptions = await page()

  assert.equal(options.props.recording.default, 'pending', 'a panel given no recorder state is not confirmed')

  // The recorder as the app wires it: the real plugin and store module over the stores of this check, the save a fake one that answers the recorder's reads.
  const state = { freshness: { generation: 0 }, database: null, savePath: 'C:/saves/a.db', GameID: 1, history: m.historyStore.state() }
  const watchers = []
  let ended = () => {}
  const { store, rejected } = recorderStore(state, m.historyStore.mutations, { watch: (callback) => { watchers.push(callback) }, afterCommit: (name) => { if (name === 'failures') { ended() } } })

  m.plugin.default({ store })

  const pageVm = instantiate(pageOptions, { $store: { getters: { GameID: 1 }, state }, GameID: 1, RaceID: 7 })
  const panel = mounted(options, { config: settingsOf({}), campaign: null, gameTime: null, recording: pageVm.recording })
  const digestFiles = () => JSON.stringify([...stores()].filter(([key]) => key.startsWith('economy-digest/')))
  const asked = []
  const observed = []

  // The panel as the page gives it what the store holds now.
  const sync = (save) => {
    const settled = state.history.campaigns[1]

    panel.campaign = settled ? { campaignId: settled.campaignId, branchId: settled.branchId, generation: 1 } : null
    panel.gameTime = save.t
    panel.recording = pageVm.recording

    return panel
  }

  // Opens `save` as a new copy of it and waits for the end of the pass the plugin starts. `refuse` has the history file's write fail as a full disk does. What the panel offers while the pass writes the history file (after the campaign is settled, before the pass ends) is recorded in `observed`.
  const open = async (save, { refuse = false } = {}) => {
    state.freshness.generation += 1
    state.database = save
    observed.length = 0
    globalThis.__economyDigestRefuse = (key) => {
      if (!key.startsWith('history/campaign-')) {
        return false
      }

      sync(save)
      observed.push({ recording: panel.recording, state: panel.digest.state, acknowledgeable: panel.acknowledgeable, scope: panel.scope() })
      asked.push(panel.acknowledge(), panel.acknowledgeItem({ key: 'bottleneck:treasury', signature: 's' }), panel.showAcknowledged())

      return refuse
    }

    const done = new Promise((resolve) => { ended = resolve })

    try {
      watchers[0](save)
      await done
    } finally {
      delete globalThis.__economyDigestRefuse
    }

    return sync(save)
  }

  const outcome = () => observed.map((one) => [one.recording, one.state, one.acknowledgeable, one.scope])

  // The boundary: recorded, confirmed, and acknowledged.
  const boundary = recordedSave({ n: 50, wealth: 100 })

  assert.equal(pageVm.recording, 'pending', 'before any pass')
  assert.equal((await open(boundary)).recording, '')
  assert.deepEqual(outcome(), [['pending', 'unconfirmed', false, null]], 'while the pass wrote the history file')
  assert.deepEqual(state.history.failures, [])
  await panel.acknowledge()
  assert.ok(digestRace(state.history.campaigns[1].campaignId, 7), 'the boundary was acknowledged once recorded')

  // The same game read at a later game time, recorded: compared, with the treasury at nothing.
  const read = recordedSave({ n: 100, wealth: 0 })

  assert.equal((await open(read)).recording, '')
  assert.deepEqual(outcome(), [['pending', 'unconfirmed', false, null]], 'a pass on the next copy of the save is pending until it ends')
  assert.equal(panel.digest.state, 'ready')

  const staleFigures = JSON.stringify(panel.digest.items)

  // The save is reloaded at the same game time with the treasury in debt, and the history write is refused.
  const live = recordedSave({ n: 100, wealth: -5 })

  assert.equal(live.t, read.t)
  await open(live, { refuse: true })
  assert.deepEqual(outcome(), [['pending', 'unconfirmed', false, null]], 'while the pass that fails runs, the pass of the previous copy confirms nothing')
  assert.deepEqual(state.history.failures, [{ GameID: 1, stage: 'write' }])
  assert.equal(panel.recording, 'write')
  assert.equal(panel.problemKind, 'recording')
  assert.ok(panel.problem, 'the panel reports that the open save is not recorded')
  assert.equal(panel.digest.state, 'unconfirmed')
  assert.equal(panel.digest.now, null)
  assert.deepEqual(panel.digest.items, [])
  assert.equal(panel.acknowledgeable, false)

  const before = digestFiles()

  await Promise.all(asked)
  await panel.acknowledge()
  await panel.acknowledgeItem({ key: 'bottleneck:treasury', signature: 's' })
  await panel.showAcknowledged()
  assert.equal(digestFiles(), before, 'nothing was written for an open save that is not recorded')
  assert.equal(panel.message, '')

  panel.recording = ''
  assert.equal(panel.digest.state, 'ready', 'without the gate the older snapshot of that time is what is compared')
  assert.equal(JSON.stringify(panel.digest.items), staleFigures)

  // The reload is recorded this time: after the pass it is compared, and an acknowledgment is written. While the pass runs, the failure of the previous pass stays in the store until this one ends, so the panel still reports it.
  asked.length = 0
  await open(live)
  assert.deepEqual(outcome(), [['write', 'unconfirmed', false, null]], 'while a pass that will succeed runs, the failure of the previous pass still gates')
  await Promise.all(asked)
  assert.equal(digestFiles(), before, 'nothing was written while the pass ran')
  assert.deepEqual(state.history.failures, [])
  assert.equal(panel.recording, '')
  assert.equal(panel.digest.state, 'ready')
  assert.notEqual(JSON.stringify(panel.digest.items), staleFigures, 'the treasury in debt shows once the save is recorded')
  assert.equal(panel.acknowledgeable, true)
  await panel.acknowledgeItem(panel.digest.items[0])
  assert.notEqual(digestFiles(), before, 'an acknowledgment is written once the save is recorded')

  // A pass that ends with no failure but wrote no snapshot of the game (no player race to take) confirms nothing for it.
  await open(recordedSave({ n: 100, wealth: -5, raced: false }))
  assert.deepEqual(state.history.failures, [])
  assert.equal(pageVm.recording, 'pending', 'a pass that wrote nothing of the game is not a recording of it')
  assert.equal(panel.digest.state, 'unconfirmed')
  assert.equal(panel.acknowledgeable, false)
  await open(live)
  assert.equal(pageVm.recording, '')

  // Another copy of the save, or another save, confirms nothing until its own pass ends.
  state.freshness.generation += 1
  assert.equal(pageVm.recording, 'pending')
  state.freshness.generation -= 1
  assert.equal(pageVm.recording, '')
  m.historyStore.mutations.reset(state.history)
  assert.equal(pageVm.recording, 'pending')

  assert.equal(m.d.recordingFailureOf([{ GameID: 1, stage: 'events' }], 1), '')
  assert.equal(m.d.recordingFailureOf([{ GameID: 2, stage: 'write' }], 1), '')
  assert.equal(m.d.recordingFailureOf([{ GameID: null, stage: 'readonly' }], 1), 'readonly')
  assert.equal(m.d.recordingFailureOf([{ GameID: 1, stage: 'events' }, { GameID: 1, stage: 'registry' }], '1'), 'registry')
  assert.equal(m.d.recordingFailureOf([], 1), '')
  assert.equal(m.d.recordingFailureOf(undefined, 1), '')

  assert.equal(m.d.recordingStateOf({ failures: [], passes: { 1: 3 } }, 1, 3), '')
  assert.equal(m.d.recordingStateOf({ failures: [], passes: { 1: 3 } }, '1', 3), '')
  assert.equal(m.d.recordingStateOf({ failures: [], passes: { 1: 3 } }, 1, 4), 'pending')
  assert.equal(m.d.recordingStateOf({ failures: [], passes: {} }, 1, 3), 'pending')
  assert.equal(m.d.recordingStateOf({ failures: [], passes: { 2: 3 } }, 1, 3), 'pending')
  assert.equal(m.d.recordingStateOf({ failures: [], passes: { 1: 3 } }, null, 3), 'pending')
  assert.equal(m.d.recordingStateOf({ failures: [], passes: { 1: 3 } }, 1, undefined), 'pending')
  assert.equal(m.d.recordingStateOf(null, 1, 3), 'pending')
  assert.equal(m.d.recordingStateOf({ failures: [{ GameID: 1, stage: 'write' }], passes: { 1: 3 } }, 1, 3), 'write')
  assert.equal(m.d.recordingStateOf({ failures: [{ GameID: 1, stage: 'events' }], passes: { 1: 3 } }, 1, 3), '')

  for (const recording of ['read', 'write', 'registry', 'readonly', 'pending']) {
    assert.equal(m.d.buildDigest({ record: null, snapshots: [snap(3000)], gameTime: 3000, recording }).state, 'unconfirmed')
  }

  assert.equal(m.d.buildDigest({ record: null, snapshots: [snap(3000)], gameTime: 3000, recording: '' }).state, 'none')
  assert.deepEqual(rejected(), [], 'the recorder made calls the root store does not answer')
})

// ---- The planted faults ------------------------------------------------------------------------------------------------

/* eslint-disable no-template-curly-in-string */
const MUTANTS = [
  { name: 'an unknown figure is read as 0', target: 'digest', find: 'isKnownNumber(value) ? ofRule({ rule, value: Number(value), inputs: { present: [label] } }) : unavailable({ rule, missing: [label] }))', replace: 'ofRule({ rule, value: Number(value) || 0, inputs: { present: [label] } }))', fails: ['production-unknown'] },
  { name: 'an installation type a snapshot lacks is unknown, not none built', target: 'digest', find: ': ofRule({ rule: \'digest.installations\', value: 0, inputs: { present: [`${label} installations`] } })', replace: ': unavailable({ rule: \'digest.installations\', missing: [`${label} installations`] })', fails: ['production-net'] },
  { name: 'an unavailable change is listed as a change', target: 'digest', find: 'if (change.value === null) {\n      unknown.push({ key, label,', replace: 'if (change.value === undefined) {\n      unknown.push({ key, label,', fails: ['production-unknown'] },
  { name: 'a stockpile above none is a flip as well', target: 'digest', find: '\n    } else if ((earlier.value > 0) !== (later.value > 0)) {', replace: '\n    } else if ((earlier.value >= 0) !== (later.value >= 0)) {', fails: ['bottleneck-flips'] },
  { name: 'a treasury at nothing is below it', target: 'digest', find: '(wealthBefore.value < 0) !== (wealthNow.value < 0)', replace: '(wealthBefore.value <= 0) !== (wealthNow.value <= 0)', fails: ['bottleneck-flips'] },
  { name: 'a colony stock is read one column off', target: 'digest', find: 'index: COLONY_COLUMNS.indexOf(column) + 1 }', replace: 'index: COLONY_COLUMNS.indexOf(column) }', fails: ['colony-changes'] },
  { name: 'a colony that is gone is not a change', target: 'digest', find: '(stateBefore === COLONY_STATES.OBSERVED) !== (stateNow === COLONY_STATES.OBSERVED)', replace: 'false', fails: ['colony-changes'] },
  { name: 'a colony not read is a colony gone', target: 'digest', find: 'if (stateBefore === COLONY_STATES.UNAVAILABLE || stateNow === COLONY_STATES.UNAVAILABLE) {', replace: 'if (false) {', fails: ['colony-changes'] },
  { name: 'a colony snapshot of another ledger is compared', target: 'digest', find: '(n !== null && snapshot.n !== n)', replace: 'false', fails: ['colony-unread'] },
  { name: 'a note edit ignores the status', target: 'digest', find: '...(old.status !== fields.status ? [{ field: \'status\', from: old.status, to: fields.status }] : []),', replace: '', fails: ['notes-changes'] },
  { name: 'a note is edited when the name of its object changes', target: 'digest', find: ' || old.origin !== fields.origin ? [', replace: ' || old.origin !== fields.origin || old.name !== fields.name ? [', fails: ['notes-changes', 'notes-relink'] },
  { name: 'a note is not found by its uuid', target: 'digest', find: 'if (!hasOwn(before, entry.uuid)) {', replace: 'if (!Object.values(before).some((old) => old.title === entry.title)) {', fails: ['notes-changes'] },
  { name: 'notes beyond the record\'s size are kept', target: 'digest', find: 'entries.length <= MAX_NOTES', replace: 'entries.length <= MAX_NOTES + 1000', fails: ['notes-unknown'] },
  { name: 'unreadable notes are compared', target: 'digest', find: 'if (before === null || entries === null) {', replace: 'if (before === undefined) {', fails: ['notes-unknown'] },
  { name: 'a note about a body is not grouped with its colony', target: 'digest', find: 'const target = colony ? { type: \'colony\', id: Number(colony.id), name: colony.name } : own', replace: 'const target = own', fails: ['groups'] },
  { name: 'an acknowledged change is never hidden', target: 'digest', find: 'acknowledged: hasOwn(record.items, item.key) && record.items[item.key] === signature', replace: 'acknowledged: false', fails: ['acknowledge-item', 'acknowledge-signature'] },
  { name: 'an acknowledged change is hidden whatever it moved to', target: 'digest', find: 'acknowledged: hasOwn(record.items, item.key) && record.items[item.key] === signature', replace: 'acknowledged: hasOwn(record.items, item.key)', fails: ['acknowledge-signature'] },
  { name: 'acknowledging the digest drops the colonies at the boundary', target: 'digest', find: 'colonies: now.colonies, notes: now.notes, items: {} })', replace: 'colonies: {}, notes: now.notes, items: {} })', fails: ['acknowledge-all'] },
  { name: 'acknowledging the digest drops the notes at the boundary', target: 'digest', find: 'colonies: now.colonies, notes: now.notes, items: {} })', replace: 'colonies: now.colonies, notes: null, items: {} })', fails: ['acknowledge-all'] },
  { name: 'acknowledging the digest records the open save at another time', target: 'digest', find: 'snapshot: now.snapshot, colonies: now.colonies', replace: 'snapshot: { ...now.snapshot, t: now.snapshot.t - 1 }, colonies: now.colonies', fails: ['acknowledge-all'] },
  { name: 'a store of another version is read', target: 'digest', find: '|| value.version !== DIGEST_VERSION || !isObject(value.branches)', replace: '|| !isObject(value.branches)', fails: ['store-read'] },
  { name: 'a damaged record is read', target: 'digest', find: 'const damaged = Object.entries(value.branches).find(([, record]) => !validRecord(record))', replace: 'const damaged = null', fails: ['store-read'] },
  { name: 'an unreadable store is written over', target: 'digest', find: 'if (!read.ok) {\n      throw new DigestUnreadable(read.reason)\n    }', replace: 'if (!read.ok) {\n      read.store = emptyStore()\n    }', fails: ['store-save', 'component-unreadable'] },
  { name: 'a write drops the other races of the file', target: 'digest', find: 'races: { ...document.races, [RaceID]: written }', replace: 'races: { [RaceID]: written }', fails: ['store-save', 'web-interleave'] },
  { name: 'a race is written under another race', target: 'digest', find: 'races: { ...document.races, [RaceID]: written }', replace: 'races: { ...document.races, [Number(RaceID) + 1]: written }', fails: ['store-save'] },
  { name: 'the record moves into the shared settings document', target: 'digest', find: 'return new Store({ cwd: DIGEST_FOLDER, name: `campaign-${campaignId}`, strict: true })', replace: 'return new Store({})', fails: ['store-file', 'web-shared-document', 'component-write', 'component-web'] },
  { name: 'the record moves into the history folder', target: 'digest', find: 'cwd: DIGEST_FOLDER,', replace: 'cwd: \'history\',', fails: ['store-file'] },
  { name: 'the files of two campaigns are one', target: 'digest', find: 'name: `campaign-${campaignId}`, strict', replace: 'name: \'campaign\', strict', fails: ['store-file', 'component-isolation'] },
  { name: 'a damaged file reads as an empty store', target: 'digest', find: ', strict: true })', replace: ' })', fails: ['component-damaged'] },
  { name: 'the recorder\'s failure for the open save is not taken as one', target: 'digest', find: '  if (recording) {\n    return emptyDigest(STATES.UNCONFIRMED, recordingText(recording))\n  }\n\n', replace: '', fails: ['recording-gate'] },
  { name: 'a failure of the event archive alone gates the digest', target: 'digest', find: 'RECORDING_STAGES.includes(failure.stage) && ', replace: '', fails: ['recording-gate'] },
  { name: 'a failure of another game gates the digest', target: 'digest', find: ' && (failure.GameID === null || failure.GameID === Number(GameID))', replace: '', fails: ['recording-gate'] },
  { name: 'a refused history write is not a recording failure', target: 'digest', find: 'Object.freeze([\'read\', \'write\', \'registry\', \'readonly\'])', replace: 'Object.freeze([\'read\', \'registry\', \'readonly\'])', fails: ['recording-gate'] },
  { name: 'the panel builds the digest without the recorder state', target: 'vue', find: 'recording: this.recording })', replace: 'recording: \'\' })', fails: ['recording-gate'] },
  { name: 'the panel acknowledges for an open save the recorder failed on', target: 'vue', find: ' && !this.recordingProblem ? { campaignId', replace: ' ? { campaignId', fails: ['recording-gate'] },
  { name: 'the panel does not report the recording failure', target: 'vue', find: ' || this.history.error || this.recordingProblem', replace: ' || this.history.error', fails: ['recording-gate'] },
  { name: 'the page drops what the recorder reported', target: 'page', find: 'recordingStateOf(this.$store.state.history, this.GameID, this.$store.state.freshness.generation)', replace: '\'\'', fails: ['page-wiring'] },
  { name: 'the page does not bind the recorder state', target: 'page', find: ' :recording="recording"', replace: '', fails: ['page-wiring'] },
  { name: 'no failure yet is taken as a successful recording', target: 'digest', find: ' && passes[GameID] === generation ? \'\' : RECORDING_PENDING', replace: ' ? \'\' : \'\'', fails: ['recording-gate'] },
  { name: 'a pass of another copy of the save confirms this one', target: 'digest', find: ' && passes[GameID] === generation ?', replace: ' ?', fails: ['recording-gate'] },
  { name: 'a failure does not come before a confirmed pass', target: 'digest', find: '  if (failure) {\n    return failure\n  }\n\n  const passes', replace: '  const passes', fails: ['recording-gate'] },
  { name: 'the recorder does not report the games it wrote', target: 'plugin', find: 'store.commit(\'history/passed\', { GameIDs: [...saved], generation })', replace: 'void saved', fails: ['recording-gate'] },
  { name: 'a pass confirms the games it never wrote', target: 'plugin', find: 'GameIDs: [...saved], generation })', replace: 'GameIDs: [store.state.GameID], generation })', fails: ['recording-gate'] },
  { name: 'a pass is reported as of the wrong copy of the save', target: 'store', find: '[GameID, generation]', replace: '[GameID, 0]', fails: ['recording-gate'] },
  { name: 'the store keeps what a save confirmed when another is opened', target: 'store', find: '    state.campaigns = {}\n    state.passes = {}', replace: '    state.campaigns = {}', fails: ['recording-gate'] },
  { name: 'a panel given no recorder state is taken as recorded', target: 'vue', find: 'default: RECORDING_PENDING,', replace: 'default: \'\',', fails: ['recording-gate'] },
  { name: 'the guard lets a changed record be written over', target: 'digest', find: 'if (JSON.stringify(recordOf(store, branchId)) !== JSON.stringify(expected)) {', replace: 'if (false) {', fails: ['store-guard', 'component-stale'] },
  { name: 'the items acknowledged one at a time have no limit', target: 'digest', find: 'Object.keys(record.items).length >= MAX_ITEMS', replace: 'Object.keys(record.items).length >= MAX_ITEMS + 1000000', fails: ['store-limit'] },
  { name: 'a change shown again is kept acknowledged', target: 'digest', find: 'if (!record || !hasOwn(record.items, key)) {\n    return store\n  }\n\n  const items = { ...record.items }\n\n  delete items[key]', replace: 'if (!record || !hasOwn(record.items, key)) {\n    return store\n  }\n\n  const items = { ...record.items }', fails: ['store-limit', 'component-reload'] },
  { name: 'the saves at the boundaries count as observed between them', target: 'digest', find: 'snapshot.t > from.t && snapshot.t < to.t', replace: 'snapshot.t >= from.t && snapshot.t <= to.t', fails: ['gaps-coverage', 'gaps-net'] },
  { name: 'the longest stretch is the shortest', target: 'digest', find: 'Math.max(...gaps.map((gap) => gap.seconds))', replace: 'Math.min(...gaps.map((gap) => gap.seconds))', fails: ['gaps-coverage', 'gaps-net'] },
  { name: 'the increments of the ledger are the later count', target: 'digest', find: 'increments: spans ? to.chain.n - from.chain.n : null', replace: 'increments: spans ? to.chain.n : null', fails: ['gaps-coverage', 'gaps-net'] },
  { name: 'the coverage no longer says that only the net change is shown', target: 'digest', find: 'text: \'Only the net change over each stretch is shown; anything that began and ended inside one is not.\' }', replace: 'text: \'\' }', fails: ['gaps-net'] },
  { name: 'a save without a ledger witness is not disclosed', target: 'digest', find: 'increments: coverage.increments, text:', replace: 'increments: coverage.increments ?? 0, text:', fails: ['gaps-net'] },
  { name: 'a thinned history is not disclosed', target: 'digest', find: 'if (coverage.thinning === \'unknown\') {', replace: 'if (false) {', fails: ['gaps-net'] },
  { name: 'an open save before the boundary is compared', target: 'digest', find: 'if (to.t < from.t) {', replace: 'if (false) {', fails: ['rewound'] },
  { name: 'a ledger with fewer increments is compared', target: 'digest', find: '(to.chain.n < from.chain.n || (to.chain.n === from.chain.n && to.chain.digest !== from.chain.digest))', replace: '(to.chain.n === from.chain.n && to.chain.digest !== from.chain.digest)', fails: ['diverged'] },
  { name: 'a ledger with the same increments and another digest is compared', target: 'digest', find: '(to.chain.n < from.chain.n || (to.chain.n === from.chain.n && to.chain.digest !== from.chain.digest))', replace: '(to.chain.n < from.chain.n)', fails: ['diverged'] },
  { name: 'the boundary\'s own witness is not checked against the history', target: 'digest', find: '(recorded.chain.n !== from.chain.n || recorded.chain.digest !== from.chain.digest)', replace: 'false', fails: ['boundary-witness'] },
  { name: 'a branch reads the first record of the store', target: 'digest', find: 'hasOwn(store.branches, branchId) ? store.branches[branchId] : null', replace: 'Object.values(store.branches)[0] || null', fails: ['isolation-branch', 'component-isolation'] },
  { name: 'a record is written under one branch whatever the branch', target: 'digest', find: 'branches: { ...store.branches, [branchId]: record } })', replace: 'branches: { ...store.branches, b1: record } })', fails: ['isolation-branch', 'component-isolation'] },
  { name: 'a branch name of the object prototype reads a record', target: 'digest', find: 'hasOwn(store.branches, branchId) ? store.branches[branchId] : null', replace: 'store.branches[branchId] || null', fails: ['isolation-branch'] },
  { name: 'the panel writes without the guard', target: 'vue', find: 'const change = guarded(scope.branchId, scope.record, next)', replace: 'const change = next', fails: ['component-stale'] },
  { name: 'the turn of a queued acknowledgment does not check the scope', target: 'vue', find: 'if (!this.inScope(scope)) {\n            throw new DigestScopeChanged()\n          }\n\n          return change(store)', replace: 'return change(store)', fails: ['component-queued'] },
  { name: 'a queued acknowledgment does not notice another campaign', target: 'vue', find: ' && this.campaign.campaignId === scope.campaignId', replace: '', fails: ['component-queued'] },
  { name: 'a queued acknowledgment does not notice another branch', target: 'vue', find: ' && this.campaign.branchId === scope.branchId && this.raceId', replace: ' && this.raceId', fails: ['component-queued'] },
  { name: 'a queued acknowledgment does not notice another race', target: 'vue', find: ' && this.raceId === scope.raceId', replace: '', fails: ['component-queued'] },
  { name: 'the panel reads the acknowledgments of one campaign whatever the open one', target: 'vue', find: 'digestStore(this.campaign.campaignId).get(\'races\', undefined)', replace: 'digestStore(\'c1\').get(\'races\', undefined)', fails: ['component-isolation'] },
  { name: 'the panel reads the record of one branch whatever the open one', target: 'vue', find: 'recordOf(this.stored.read.store, this.campaign.branchId)', replace: 'recordOf(this.stored.read.store, \'b1\')', fails: ['component-isolation'] },
  { name: 'the panel reads the history of one branch whatever the open one', target: 'vue', find: 'branchStore(this.campaign.campaignId, this.campaign.branchId)', replace: 'branchStore(this.campaign.campaignId, \'b1\')', fails: ['component-isolation'] },
  { name: 'the panel reads the history of another race', target: 'vue', find: 'branchStore(this.campaign.campaignId, this.campaign.branchId).get(`races.${this.raceId}`, null)', replace: 'branchStore(this.campaign.campaignId, this.campaign.branchId).get(\'races.7\', null)', fails: ['component-isolation'] },
  { name: 'the panel acknowledges the digest at the wrong game time', target: 'vue', find: 'recordFrom(now, Date.now())', replace: 'recordFrom({ ...now, snapshot: { ...now.snapshot, t: now.snapshot.t + 1 } }, Date.now())', fails: ['component-write'] },
  { name: 'the panel drops the summary', target: 'vue', find: 'data-summary="Changes to the economy shown by the saves', replace: 'data-x="Changes to the economy shown by the saves', fails: ['template'] },
  { name: 'the panel drops the mark of a change', target: 'vue', find: '<provenance-mark :result="item.result" />', replace: '', fails: ['template'] },
  { name: 'the panel drops the mark of an unknown figure', target: 'vue', find: '<provenance-mark :result="entry.result" />', replace: '', fails: ['template'] },
  { name: 'the panel drops the mark of the coverage', target: 'vue', find: '<provenance-mark :result="digest.coverage.result" />', replace: '', fails: ['template'] },
  { name: 'the page tracks the installation names under another name', target: 'page', find: 'get: tracked(\'installationNames\', ', replace: 'get: tracked(\'installNames\', ', fails: ['page-wiring'] },
  { name: 'the page labels the installation names under another name', target: 'page', find: '\n  installationNames: \'the installation types\',', replace: '\n  installNames: \'the installation types\',', fails: ['page-wiring'] },
  { name: 'the page does not host the panel', target: 'page', find: '<change-digest :config="config" :campaign="resolved"', replace: '<div :config="config" :campaign="resolved"', fails: ['page-wiring'] },
  { name: 'a relink to a reused ID is compared by type and ID alone', target: 'digest', find: ' || old.fingerprint !== fields.fingerprint', replace: '', fails: ['notes-relink'] },
  { name: 'a relink from another branch is not an edit', target: 'digest', find: ' || old.origin !== fields.origin ? [', replace: ' ? [', fails: ['notes-relink'] },
  { name: 'the baseline drops the link fingerprint', target: 'digest', find: 'fingerprint: Array.isArray(entry.links) && entry.links.length && typeof entry.links[0].fingerprint === \'string\' ? entry.links[0].fingerprint : \'\'', replace: 'fingerprint: \'\'', fails: ['notes-relink'] },
  { name: 'a stale note is grouped with a live colony', target: 'digest', find: 'const stale = item.kind === \'note\' && own.live === false', replace: 'const stale = false', fails: ['groups-stale'] },
  { name: 'a changed link counts as an intact one', target: 'digest', find: 'entry.link.status === \'linked\'', replace: 'entry.link.status !== \'missing\'', fails: ['groups-stale'] },
  { name: 'a removed note is grouped with a live colony', target: 'digest', find: 'group: groupOf(old.type, old.id, old.name, false)', replace: 'group: groupOf(old.type, old.id, old.name, true)', fails: ['groups-stale'] },
  { name: 'a note that cannot be read is taken as removed', target: 'page', find: ' && !this.read.notes.length', replace: '', fails: ['notes-partial'] },
  { name: 'the web build is written without the lock', target: 'digest', find: 'store.constructor.writesNeedOwner !== true', replace: 'true', fails: ['web-interleave', 'web-unprotected', 'component-web'] },
  { name: 'the web build is written when the browser has no locks', target: 'digest', find: 'if (!locks) {\n    throw new DigestUnprotected()\n  }', replace: 'if (!locks) {\n    return saveDigest(store, RaceID, change)\n  }', fails: ['web-unprotected', 'component-web'] },
  { name: 'the lock is not shared by the tabs', target: 'digest', find: 'locks.request(DIGEST_LOCK, ', replace: 'locks.request(DIGEST_LOCK + Math.random(), ', fails: ['web-interleave'] },
  { name: 'the panel writes without the lock', target: 'vue', find: 'await saveDigestSafely(', replace: 'await ((store, race, change) => Promise.resolve(store.update((document) => ({ ...document, races: { ...document.races, [race]: change(document.races?.[race] || { version: 1, branches: {} }) } }))))(', fails: ['component-web'] },
]
/* eslint-enable no-template-curly-in-string */

// ---- Running -----------------------------------------------------------------------------------------------------------

const failedOf = async (context) => {
  const failed = new Map()

  for (const { key, run } of checks) {
    stores().clear()

    try {
      await run(context)
    } catch (error) {
      failed.set(key, error)
    }
  }

  return failed
}

const main = async () => {
  const unique = new Set(checks.map((entry) => entry.key))

  if (unique.size !== checks.length) {
    throw new Error('Two checks share a key')
  }

  const results = []
  const base = await build()

  for (const { key, name, run } of checks) {
    stores().clear()

    try {
      await run(base)
      results.push({ ok: true, label: `${key}: ${name}` })
    } catch (error) {
      results.push({ ok: false, label: `${key}: ${name}`, detail: error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : String(error) })
    }
  }

  for (const mutant of MUTANTS) {
    const missing = mutant.fails.filter((key) => !unique.has(key))

    if (missing.length) {
      results.push({ ok: false, label: `fault "${mutant.name}"`, detail: `names checks that do not exist: ${missing.join(', ')}` })

      continue
    }

    let context

    try {
      context = await build(mutant)
    } catch (error) {
      results.push({ ok: false, label: `fault "${mutant.name}"`, detail: `invalid fault: ${error.message}` })

      continue
    }

    const failed = await failedOf(context)
    const caught = mutant.fails.filter((key) => failed.has(key))

    results.push(caught.length === mutant.fails.length ? { ok: true, label: `fault "${mutant.name}" fails ${mutant.fails.join(', ')}` } : { ok: false, label: `fault "${mutant.name}"`, detail: `expected to fail ${mutant.fails.join(', ')}; failed: ${[...failed.keys()].join(', ') || 'nothing'}` })
  }

  results.forEach((result) => {
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.label}`)

    if (!result.ok) {
      console.log(`     ${result.detail}`)
    }
  })

  const passed = results.filter((result) => result.ok).length

  console.log(`${passed} of ${results.length} checks passed`)

  if (passed !== results.length) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
