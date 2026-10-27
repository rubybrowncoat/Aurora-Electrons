/*
  Checks that a restore of a history backup accepts the records of every kind of scenario record the app defines, in a session where no planner page has registered anything (src/renderer/utilities/scenario-adapters.js, the registration of the backup in `backupAnnotations` of src/renderer/pages/history.vue).

  Run: CHECK_JOBS=1 bun scripts/check-history-restore.js [--no-mutations] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The statements:
  - list: the list registers into one registry without a kind twice, and every adapter the utilities define is in it, whether it is an exported adapter or what a function named `register...` hands to the function it is given, so a planner added later is never left out of a restore, however its registrar is written;
  - fixtures: a record of each kind the list registers is made by the repository that has every adapter, and no kind is without a record here, so the restore below holds one record of each kind;
  - cold-restore: the real History page, loaded fresh with nothing registered, previews the bundle of those records with its own `backupAnnotations`: each kind is accepted and none is rejected, and the import stores every record with its payload and policy as they were;
  - cold-bare: a repository with no adapter registered rejects every kind, so that what the restore accepts turns on the registration.

  The kinds the restore must hold are the kinds the list registers (read by registering it, never a list kept here); only the payload of each kind is a fixture. The adapters the utilities define are found by loading every module of the utilities and taking each exported object of the shape of an adapter and each adapter an exported `register...` function hands to a recording function, so neither the spelling of a registrar nor the name of its parameter matters. Every planted fault is a copy of one source loaded in place of it or a module added: a registration dropped from the list (one fault for each entry of the list, read from the list), an adapter defined and not listed in three spellings (a registrar written as an arrow, a registrar written as a function declaration with another parameter name, an exported adapter with no registrar), the page's call dropped and the page registering with a function that is not the app's. Each must fail the checks it names by a wrong value of its own, never because a call threw (scripts/lib/fault-credit.js), and the drop of an entry must leave rejected exactly the kinds that entry registers. Each benign rewrite (the list in another order, the registration written as a loop, the page registering through a wrapper, a module whose registrar and object are of another shape) must leave every statement green, and all of them together too. No statement reads source text or prose: the sources are read only to plant a fault. Prints `N of N checks passed`; a failed check, a fault no named check catches and a rewrite that changes a verdict each set exit code 1. The suite runs through scripts/lib/suite-runner.js.
*/
const fs = require('fs')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { runSuite } = require('./lib/suite-runner')
const { assert, runChecks, judged, caughtBy, subjectModule, harnessStore, boundary } = require('./lib/fault-credit')

const root = path.resolve(__dirname, '..')
const inRenderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)
const UTILITIES = inRenderer('utilities')

const FILES = {
  adapters: path.join(UTILITIES, 'scenario-adapters.js'),
  history: inRenderer('pages', 'history.vue'),
}

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
  './notices/solaris-theme-license.txt?raw': "export default ''",
  './notices/t2d-theme-license.txt?raw': "export default ''",
}

// The store of a session of the page: the files of the scenario records are kept, so that what a restore imports can be read back. Each session has a store of its own.
const sessionStore = (tag) => `// ${tag}\nconst files = new Map()\nconst clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))\nexport default class Config {\n  constructor (options) { this.name = options.name }\n  get store () { return clone(files.get(this.name)) || {} }\n  set store (value) { files.set(this.name, clone(value)) }\n  update (change) { const next = change(this.store); this.store = next; return next }\n}`

// The scenario records of a loaded History page as a module of their own, so the adapters one session registers are not the registry of another.
const recordsOf = (tag) => ({ 'utilities/scenario-records': `${fs.readFileSync(inRenderer('utilities', 'scenario-records.js'), 'utf8')}\n// ${tag}\n` })

// The store the History page is given is the harness's: a read of it that fails stops the run, where the page's own code runs behind the boundary of scripts/lib/fault-credit.js.
const PAGE_STORE = harnessStore({ getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100000 }, state: { history: { revision: 0 } }, dispatch: async () => {} }, { 'history/campaign': ['object'], GameTime: ['number'] })

const options = { mutations: !process.argv.includes('--no-mutations') }

let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  [${String(detail).slice(0, 600)}]` : ''}`)
}

// ---- The fixtures: the payload of one record of each kind ------------------------------------------------------------------

const RACE = 7
const ORIGIN = { campaignId: 'c1', branchId: 'b1' }
const SCOPE = { campaignId: 'c1', RaceID: RACE, branchId: 'b1', gameTime: 100 }
const TARGET = { campaignId: 'c2', RaceID: RACE, branch: 'b1' }
const body = { type: 'body', id: 1, name: 'A', systemId: 1, systemName: 'S', origin: ORIGIN }

// A kind with no entry here fails the check of the fixtures, so the restore always holds a record of each kind the list registers.
const FIXTURES = {
  'economy.note': { payload: { title: 'a', status: 'idea', next: '', target: { ...body } } },
  'fleet.station': { policy: 'branch', payload: { fleet: { type: 'fleet', id: 30, name: 'N', systemId: 1, systemName: 'Sol', origin: ORIGIN, confirmed: { fingerprint: 'fleet|1', name: 'N', classes: [5], gameTime: 10 } }, station: null, base: null, note: '' } },
  'history.milestone': { payload: { t: 0, type: 'other', text: 'a' } },
  'planner.missileDesign': { policy: 'branch', payload: { name: 'Anti-ship', baselineId: null, alternatives: [], scenario: { targetSpeed: '10000', jammer: '0', modifier: '1', pd: '0', targetSignature: '' }, tech: { choices: {} } } },
  'planner.missionBrief': { payload: { name: 'Blank', preset: null, requirements: { maxSizeHS: null, minSpeedKmS: null, minRangeKm: null, minEnduranceDays: null, minPayloadHS: null, minCargoTons: null, minHangarHS: null, minDeploymentMonths: null, classification: null }, cruiseShare: null, axes: [], unmodelled: [] } },
  'planner.techChoice': { policy: 'branch', payload: { choices: {} } },
  'resource.reserve': { policy: 'branch', payload: { source: { type: 'colony', id: 1, name: 'Colony', systemId: 1, systemName: 'Sol', origin: ORIGIN, confirmed: { fingerprint: 'colony|1|1|1', name: 'Colony', classes: null, gameTime: 0 } }, scenario: 'Plan', reserves: {}, plans: [], note: '' } },
  'route.desire': { payload: { name: 'A', cargo: 'minerals', yearly: null, note: '', from: { id: 101, name: 'Alpha', systemId: 1, systemName: 'System 1', origin: ORIGIN }, to: { id: 102, name: 'Beta', systemId: 2, systemName: 'System 2', origin: ORIGIN } } },
  'world.tag': { payload: { tag: 'ok', target: { ...body } } },
}

// ---- The sources and the faults planted in them ----------------------------------------------------------------------------

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

// What a variant loads in place of the files: the source of the list, the source of the page, and modules the app does not have (by name, with their source).
const HEAD = { adapters: read(FILES.adapters), history: read(FILES.history), extras: {} }

const LIST = /export const SCENARIO_ADAPTERS = Object\.freeze\(\[([^\]]*)\]\)/

const literalOf = (text) => LIST.exec(text)[0]

// The functions the list holds, read from the literal of the list in a source.
const entriesOf = (text) => LIST.exec(text)[1].split(',').map((entry) => entry.trim()).filter(Boolean)

const listWith = (entries) => `export const SCENARIO_ADAPTERS = Object.freeze([${entries.join(', ')}])`

const PAGE_CALL = 'adapters.registerScenarioAdapters(records.registerAdapter)'

const REGISTER_LOOP = 'SCENARIO_ADAPTERS.forEach((registerAdapter) => registerAdapter(register))'

const ADAPTER_OF_EXTRA = "{ kind: 'planner.extra', schema: 1, validate: () => [] }"

// Modules the app does not have, each defining an adapter of a kind of its own that the list lacks, written three ways: a registrar written as an arrow, a registrar written as a function declaration whose parameter has another name, and an exported adapter with no registrar at all.
const EXTRAS = {
  arrow: `export const registerExtraPlanner = (register) => register(${ADAPTER_OF_EXTRA})\n`,
  declaration: `export function registerExtraPlanner (add) {\n  add(${ADAPTER_OF_EXTRA})\n}\n`,
  object: `export const extraAdapter = Object.freeze(${ADAPTER_OF_EXTRA})\n`,
}

// A module whose names look like a registrar and an adapter and are neither: it registers a text, and its object has no schema.
const NOT_ADAPTERS = "export const registerWidget = (register) => register('a widget')\nexport const widget = Object.freeze({ kind: 'widget', validate: () => [] })\n"

// The sources with each patch `[file, find, to]` applied in turn, `find` occurring once in the source it is applied to, and the modules of `extras` added.
const sourcesOf = ({ patches = [], extras = {} }, base = HEAD) => ({ ...patches.reduce((current, [file, find, to]) => ({ ...current, [file]: patched(path.basename(FILES[file]), current[file], find, to) }), base), extras: { ...base.extras, ...extras } })

// The planted faults: { name, key, patches or extras, fails, drops }. The entries of the list are read from the source, so a fault is planted for each registration the list holds. `drops` is the entry whose kinds the restore must reject, or null for every kind.
const faultsOf = () => [
  ...entriesOf(HEAD.adapters).map((entry) => ({ name: `the list leaves out ${entry}`, key: `drop:${entry}`, patches: [['adapters', literalOf(HEAD.adapters), listWith(entriesOf(HEAD.adapters).filter((other) => other !== entry))]], fails: ['cold-restore'], drops: entry })),
  { name: 'a registrar written as an arrow is defined and not listed', key: 'unlisted:arrow', extras: { 'planner-extra': EXTRAS.arrow }, fails: ['list'] },
  { name: 'a registrar written as a function declaration with another parameter name is defined and not listed', key: 'unlisted:declaration', extras: { 'planner-extra': EXTRAS.declaration }, fails: ['list'] },
  { name: 'an adapter is exported with no registrar and is not listed', key: 'unlisted:object', extras: { 'planner-extra': EXTRAS.object }, fails: ['list'] },
  { name: 'the page does not register the adapters', key: 'page-no-call', patches: [['history', `        ${PAGE_CALL}\n`, '']], fails: ['cold-restore'], drops: null },
  { name: 'the page registers the adapters with a function that is not the app\'s registry', key: 'page-other-registry', patches: [['history', PAGE_CALL, 'adapters.registerScenarioAdapters(() => {})']], fails: ['cold-restore'], drops: null },
]

// Rewrites that say the same thing: each must leave every statement green. `family` names the kind of rewrite.
const rewritesOf = () => [
  { name: 'the list in the other order', key: 'benign:order', family: 'list order', patches: [['adapters', literalOf(HEAD.adapters), listWith(entriesOf(HEAD.adapters).reverse())]] },
  { name: 'the registration written as a loop', key: 'benign:loop', family: 'loop', patches: [['adapters', REGISTER_LOOP, 'for (const registerKind of SCENARIO_ADAPTERS) {\n    registerKind(register)\n  }']] },
  { name: 'the page registering through a wrapper', key: 'benign:wrapper', family: 'wrapper', patches: [['history', PAGE_CALL, 'adapters.registerScenarioAdapters((adapter) => records.registerAdapter(adapter))']] },
  { name: 'a module that defines a registrar of something else and an object of another shape', key: 'benign:widget', family: 'other module', extras: { 'planner-widget': NOT_ADAPTERS } },
]

// ---- What is observed -----------------------------------------------------------------------------------------------------

const texts = new Map()

let serial = 0

const isAdapter = (value) => value !== null && typeof value === 'object' && typeof value.kind === 'string' && Number.isInteger(value.schema) && value.schema >= 1 && typeof value.validate === 'function'

// The kinds of adapter the app defines and the kinds its list registers, from the sources given. Every module of the utilities is loaded; an adapter is found as an exported object of the shape `register` takes, and as what an exported function named `register...` hands to the function it is given, so neither the way a registrar is written nor the name of its parameter matters. A function that takes something else is no registrar of adapters and hands nothing over.
const kindsIn = async (sources) => {
  const names = [...fs.readdirSync(UTILITIES).filter((name) => name.endsWith('.js')).map((name) => name.slice(0, -3)), ...Object.keys(sources.extras)]
  const loaded = await loadUtilities(names, { stubs: STUBS, sources: { 'scenario-adapters': sources.adapters, ...sources.extras }, texts })
  const defined = new Set()
  const take = (value) => {
    if (isAdapter(value)) {
      defined.add(value.kind)
    }
  }

  for (const exported of Object.values(loaded)) {
    for (const [name, value] of Object.entries(exported)) {
      take(value)

      if (typeof value === 'function' && name.startsWith('register')) {
        try {
          value((adapter) => take(adapter))
        } catch (error) {
          // a function named like a registrar that takes something else: nothing to take
        }
      }
    }
  }

  const registry = loaded['scenario-records'].createAdapterRegistry()

  loaded['scenario-adapters'].registerScenarioAdapters(registry.register)

  return { defined: [...defined].sort(), listed: registry.kinds().slice().sort() }
}

const memory = () => {
  const files = new Map()
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      files.set(name, clone(value))
    },
    update (change) {
      const next = change(this.store)

      this.store = next

      return next
    },
  })

  return { storage: { open: (campaignId) => store(`campaign-${campaignId}`), registry: () => ({}), writable: () => Promise.resolve(true) } }
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// The repository that has every adapter the list registers, and a record of each kind in it, from the sources as they are: the backup the restore reads. Made once.
let warmed = null

const warm = () => {
  if (!warmed) {
    warmed = (async () => {
      const loaded = await loadUtilities(['scenario-records', 'scenario-adapters'], { stubs: STUBS, texts })
      const records = subjectModule(loaded['scenario-records'])
      const registry = records.createAdapterRegistry()

      loaded['scenario-adapters'].registerScenarioAdapters(registry.register)

      const kinds = registry.kinds().slice().sort()
      const byEntry = Object.fromEntries(loaded['scenario-adapters'].SCENARIO_ADAPTERS.map((register) => {
        const own = records.createAdapterRegistry()

        register(own.register)

        return [register.name, own.kinds().slice().sort()]
      }))
      let ids = 0
      let clock = 1000
      const repository = records.createRepository({ storage: memory().storage, adapters: registry, newId: () => uuid(++ids), now: () => ++clock })
      const made = {}
      const refused = {}

      for (const kind of kinds) {
        if (!FIXTURES[kind]) {
          continue
        }

        try {
          made[kind] = repository.create(SCOPE, { kind, payload: FIXTURES[kind].payload, links: [], policy: FIXTURES[kind].policy || 'campaign' })
        } catch (error) {
          refused[kind] = String(error && error.message).split('\n')[0]
        }
      }

      const bare = records.createRepository({ storage: memory().storage, adapters: records.createAdapterRegistry(), newId: () => uuid(900), now: () => 5000 }).previewImport(repository.exportRecords(SCOPE), TARGET, { restore: true })

      return { kinds, listed: loaded['scenario-adapters'].SCENARIO_ADAPTERS.length, made: Object.keys(made).sort(), refused, bundle: repository.exportRecords(SCOPE), bare: { rejected: bare.rejected, importable: bare.importable }, byEntry }
    })()
  }

  return warmed
}

// The History page loaded fresh, with nothing registered, previewing the bundle of the warm repository and importing it, all through its own `backupAnnotations`.
const coldOf = async (sources, bundle) => {
  const tag = `session ${++serial}`
  const overrides = { 'pages/history': sources.history, ...(sources.adapters !== HEAD.adapters ? { 'utilities/scenario-adapters': sources.adapters } : {}), ...recordsOf(tag) }
  const page = await loadPage('pages/history', { stubs: { ...STUBS, 'electron-store': sessionStore(tag) }, dynamicImports: true, sources: overrides })
  const { adapter, error } = await instantiate(page, { boundary, $store: PAGE_STORE, database: null, GameID: 1, RaceID: RACE, data: {} }).backupAnnotations()

  if (!adapter) {
    return { error, status: {}, rejected: [], importable: 0, imported: null, stored: [] }
  }

  const preview = adapter.preview(bundle, TARGET, { restore: true })
  const status = Object.fromEntries(preview.items.map((item) => [item.kind, item.status]))
  const rejected = preview.items.filter((item) => item.status === 'rejected').map((item) => item.kind).sort()
  const imported = preview.importable && !preview.rejected ? adapter.import(bundle, TARGET, { preview, restore: true }).imported.length : null
  const stored = imported === null ? [] : adapter.export({ campaignId: TARGET.campaignId, RaceID: RACE, branchId: TARGET.branch, gameTime: 0 }).records.map((record) => ({ kind: record.kind, payload: record.payload, policy: record.association.policy })).sort((a, b) => (a.kind < b.kind ? -1 : 1))

  return { error, status, rejected, importable: preview.importable, imported, stored }
}

// ---- The checks ------------------------------------------------------------------------------------------------------------

const CHECKS = [
  {
    id: 'list',
    name: 'the list registers into one registry without a kind twice, and every function the utilities define to register an adapter is in it',
    run: ({ world, found }) => {
      const missing = found.defined.filter((kind) => !found.listed.includes(kind))

      assert.equal(world.kinds.length, world.listed, 'each function of the list registers one kind of its own')
      assert.deepEqual(missing, [], `defined and not listed: ${missing.join(', ')}`)
    },
  },
  {
    id: 'fixtures',
    name: 'a record of each kind the list registers is made by the repository that has every adapter, and no kind is without one',
    run: ({ world }) => {
      assert.deepEqual(Object.keys(world.refused), [], `refused: ${Object.entries(world.refused).map(([kind, why]) => `${kind} (${why})`).join('; ')}`)
      assert.deepEqual(world.made, world.kinds, `the kinds with a record: ${world.made.join(', ')}`)
      assert.deepEqual(Object.keys(FIXTURES).filter((kind) => !world.kinds.includes(kind)), [], 'a fixture of a kind the list does not register')
    },
  },
  {
    id: 'cold-restore',
    name: 'the History page, loaded fresh with nothing registered, accepts a record of each kind on a restore and imports each as it was',
    run: ({ world, cold }) => {
      assert.equal(cold.error, null, 'the page opens the records for the backup')

      for (const kind of world.kinds) {
        assert.equal(cold.status[kind], 'import', `the restore accepts ${kind}`)
      }

      assert.deepEqual(cold.rejected, [], `rejected on the restore: ${cold.rejected.join(', ')}`)
      assert.equal(cold.imported, world.kinds.length, 'every record is imported')
      assert.deepEqual(cold.stored.map((record) => record.kind), world.kinds, 'the kinds stored by the restore')

      for (const record of cold.stored) {
        assert.deepEqual(record.payload, FIXTURES[record.kind].payload, `the payload of ${record.kind} as it was`)
        assert.equal(record.policy, FIXTURES[record.kind].policy || 'campaign', `the policy of ${record.kind} as it was`)
      }
    },
  },
  {
    id: 'cold-bare',
    name: 'a repository with no adapter registered rejects every kind, so what the restore accepts turns on the registration',
    run: ({ world }) => {
      assert.equal(world.bare.rejected, world.kinds.length, 'every kind is rejected')
      assert.equal(world.bare.importable, 0, 'none can be imported')
    },
  },
]

const HEAD_IDS = CHECKS.map((item) => item.id)

// Runs the checks over the sources: the observations are made once and every check reads them.
const resultsOf = async (sources) => {
  const world = await warm()
  const found = await kindsIn(sources)
  const cold = await coldOf(sources, world.bundle)

  return { results: await runChecks(CHECKS, { world, found, cold }), world, cold }
}

const detail = (results) => results.map((result) => `${result.id}: ${result.kind}: ${String(result.detail).split('\n').slice(0, 3).join(' ')}`).join('; ')

// ---- The variants ----------------------------------------------------------------------------------------------------------

const runHead = async () => {
  console.log('\nHistory restore: a backup of every kind of scenario record restored in a fresh session')

  const { results } = await resultsOf(HEAD)

  for (const result of results) {
    check(`${result.id}: ${result.name}`, result.ok, `${result.kind}: ${result.detail}`)
  }

  const lost = []

  ;[...faultsOf(), ...rewritesOf()].forEach((edit) => {
    try {
      if (JSON.stringify(sourcesOf(edit)) === JSON.stringify(HEAD)) {
        lost.push(`${edit.name} changes nothing`)
      }
    } catch (error) {
      lost.push(`${edit.name}: ${String(error && error.message).split('\n')[0]}`)
    }
  })
  check('faults: every planted fault and rewrite changes a source, and its anchor is found once', lost.length === 0, lost.join('; '))
  check('faults: every fault names checks that exist', faultsOf().every((fault) => fault.fails.every((id) => HEAD_IDS.includes(id))), 'a fault names a check this suite does not have')
}

const runFault = async (key) => {
  const fault = faultsOf().find((item) => item.key === key)
  const { results, world, cold } = await resultsOf(sourcesOf(fault))
  const failed = judged(results, `the fault "${fault.name}"`)

  check(`fault caught: ${fault.name}: credited by ${failed.filter((result) => fault.fails.includes(result.id) && result.kind === 'assertion').map((result) => result.id).join(', ') || 'nothing'}`, caughtBy(failed, fault.fails, { name: fault.name }), failed.length ? detail(failed) : 'every check held')

  if (fault.drops !== undefined) {
    const dropped = fault.drops === null ? world.kinds : world.byEntry[fault.drops]

    check(`fault caught: ${fault.name}: the restore rejects the kinds it no longer registers, and no other`, JSON.stringify(cold.rejected) === JSON.stringify(dropped), `rejected ${JSON.stringify(cold.rejected)}, expected ${JSON.stringify(dropped)}`)
  }
}

const runRewrite = async (key) => {
  const edit = rewritesOf().find((item) => item.key === key)
  const { results } = await resultsOf(sourcesOf(edit))
  const failed = results.filter((result) => !result.ok)

  check(`benign rewrite (${edit.family}): ${edit.name}: no check fails`, failed.length === 0, detail(failed))
}

const runRewritesTogether = async () => {
  const { results } = await resultsOf(rewritesOf().reduce((current, edit) => sourcesOf(edit, current), HEAD))
  const failed = results.filter((result) => !result.ok)

  check('benign rewrites together: no check fails', failed.length === 0, detail(failed))
}

const DEADLINES = { head: 180, fault: 120 }
const HEADING = '\nPlanted faults and benign rewrites'

const variantsOf = () => [
  { key: 'head', name: 'the head: every kind restored in a fresh session, from the sources as they are', head: true, pool: 'memory', deadline: DEADLINES.head, run: runHead },
  ...(options.mutations ? [
    ...faultsOf().map((fault) => ({ key: fault.key, name: `planted fault: ${fault.name}`, heading: HEADING, pool: 'memory', deadline: DEADLINES.fault, run: () => runFault(fault.key) })),
    ...rewritesOf().map((edit) => ({ key: edit.key, name: `benign rewrite: ${edit.name}`, heading: HEADING, pool: 'memory', deadline: DEADLINES.fault, run: () => runRewrite(edit.key) })),
    { key: 'benign:together', name: 'every benign rewrite together', heading: HEADING, pool: 'memory', deadline: DEADLINES.fault, run: runRewritesTogether },
  ] : []),
]

const run = async () => {
  const totals = await runSuite({ script: __filename, variants: variantsOf(), counts: () => ({ checks, failures }) })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
