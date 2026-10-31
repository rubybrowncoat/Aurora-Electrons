/*
  Checks that each utility or page load owns its complete ESM tree, including unchanged registries and stubs, while repeated imports within one tree retain one identity and generated text stays stable.

  bun scripts/check-loader-isolation.js [--no-mutations] [--only=<id>,<id>] [--detail]

  Every fault is a rewrite of one loader in a private layout. Only a named assertion on a wrong value credits it; load errors, subject throws, missing results and nonzero child exits are uncredited harness failures. The provenance fault changes only module sharing, never a calculation or its output.
*/
const fs = require('fs')
const path = require('path')
const { fileURLToPath } = require('url')
const ROOT = process.env.LOADER_SUBJECT_ROOT || path.resolve(__dirname, '..')
const { assert, runChecks, judged, caughtBy } = require(path.join(ROOT, 'scripts/lib/fault-credit'))
const { patched } = require(path.join(ROOT, 'scripts/lib/mutant-source'))
const { runChild } = require(path.join(ROOT, 'scripts/lib/check-pool'))
const { mutating, refusePlanting } = require(path.join(ROOT, 'scripts/lib/no-mutations'))
const { moduleTree } = require('./lib/module-files')
const { loadUtilities } = require('./lib/utilities')
const { loadModule } = require('./lib/page-loader')
const LIBRARY = path.join(__dirname, 'lib')
const WORK = path.join(ROOT, '.check-runs')
const PREFIX = '@@loader-isolation '
const DETAIL = process.argv.includes('--detail')
const rule = { id: 'isolation.fixture', versions: ['test'], note: 'independent fixture', verification: 'estimated' }
const STUB = 'export const cache = { value: 0 }\n'
const UTILITY_SOURCES = {
  'isolation/root': "import { state as left } from './left'\nimport { state as right } from './right'\nexport { state } from './state'\nexport const same = left === right\n",
  'isolation/left': "export { state } from './state'\n",
  'isolation/right': "export { state } from './state'\n",
  'isolation/state': 'export const state = { value: 0 }\n',
  'isolation/other': 'export const state = { value: 0 }\n',
  'isolation/stub': "export { cache } from 'isolation-package'\n",
  'isolation/two-stubs': "import { cache as first } from 'isolation-package'\nimport { cache as repeated } from 'isolation-package'\nimport { cache as other } from 'other-package'\nexport { first, repeated, other }\n",
}
const utilityOptions = { directory: path.join(ROOT, 'src/renderer/utilities'), sources: UTILITY_SOURCES, stubs: { 'isolation-package': STUB, 'other-package': STUB }, texts: new Map() }
const PAGE = "<script>\nimport Child from '../components/IsolationChild.vue'\nimport state from '../mixins/isolation'\nimport repeated from '../mixins/isolation'\nimport { cache } from 'isolation-package'\nexport { registerRule, getRule } from '../utilities/provenance'\nexport { state, cache }\nexport const same = state === repeated\nexport default { components: { Child } }\n</script>"
const pageOptions = { directory: path.join(ROOT, 'src/renderer'), sources: { 'pages/isolation': PAGE }, modules: { 'mixins/isolation': 'export default { value: 0 }\n' }, stubs: { 'isolation-package': STUB }, texts: new Map() }

const CHECKS = [
  {
    id: 'registry',
    name: 'an unchanged provenance module has an independent rule registry in each loaded tree',
    run: async () => {
      const first = (await loadUtilities(['provenance'], { directory: path.join(ROOT, 'src/renderer/utilities') })).provenance
      const second = (await loadUtilities(['provenance'], { directory: path.join(ROOT, 'src/renderer/utilities') })).provenance

      first.registerRule(rule)
      assert.equal(second.getRule(rule.id), null, 'the second tree saw the first tree rule')
      assert.notStrictEqual(first, second, 'two calls returned one provenance namespace')
    },
  },
  {
    id: 'state',
    name: 'unchanged utility state is independent between trees',
    run: async () => {
      const first = await loadUtilities(['isolation/root', 'isolation/state'], utilityOptions)
      const second = await loadUtilities(['isolation/root', 'isolation/state'], utilityOptions)

      first['isolation/state'].state.value = 7
      assert.equal(second['isolation/state'].state.value, 0, 'a utility cache leaked between trees')
      assert.equal(second['isolation/root'].state.value, 0, 'a transitive import saw another tree state')
    },
  },
  {
    id: 'identity',
    name: 'a tree preserves diamond and repeated identity while distinct logical modules remain distinct',
    run: async () => {
      const loaded = await loadUtilities(['isolation/root', 'isolation/state', './isolation/state', 'isolation/other'], utilityOptions)

      assert.equal(loaded['isolation/root'].same, true, 'the diamond imported two state objects')
      assert.strictEqual(loaded['isolation/root'].state, loaded['isolation/state'].state, 'the root and requested leaf disagree')
      assert.strictEqual(loaded['./isolation/state'], loaded['isolation/state'], 'an equivalent path loaded a second module')
      assert.notStrictEqual(loaded['isolation/state'].state, loaded['isolation/other'].state, 'equal source collapsed distinct module names')
    },
  },
  {
    id: 'stubs',
    name: 'package stubs are private per tree and repeated package imports share one stub',
    run: async () => {
      const first = await loadUtilities(['isolation/stub', 'isolation/two-stubs'], utilityOptions)
      const second = await loadUtilities(['isolation/stub', 'isolation/two-stubs'], utilityOptions)

      first['isolation/stub'].cache.value = 9
      assert.equal(second['isolation/stub'].cache.value, 0, 'a package stub leaked between trees')
      assert.strictEqual(first['isolation/stub'].cache, first['isolation/two-stubs'].first, 'one package had two instances')
      assert.strictEqual(first['isolation/two-stubs'].first, first['isolation/two-stubs'].repeated, 'a repeated package import changed identity')
      assert.notStrictEqual(first['isolation/two-stubs'].first, first['isolation/two-stubs'].other, 'equal text collapsed different packages')
    },
  },
  {
    id: 'pages',
    name: 'page trees isolate unchanged provenance, module overrides, package stubs and component stubs',
    run: async () => {
      const first = await loadModule('pages/isolation', pageOptions)
      const second = await loadModule('pages/isolation', pageOptions)

      first.state.value = 3
      first.cache.value = 5
      first.default.components.Child.changed = true
      first.registerRule(rule)
      assert.equal(second.state.value, 0, 'a module override leaked between page trees')
      assert.equal(second.cache.value, 0, 'a page package stub leaked between trees')
      assert.equal(second.default.components.Child.changed, undefined, 'a component stub leaked between trees')
      assert.equal(second.getRule(rule.id), null, 'unchanged page provenance leaked between trees')
      assert.equal(first.same, true, 'repeated module overrides changed identity')
    },
  },
  {
    id: 'generated',
    name: 'private tree paths produce equal generated text and distinct module instances',
    run: async () => {
      const trees = [moduleTree(), moduleTree()]
      const snapshots = []
      const loaded = []

      for (const url of trees) {
        const leaf = url('export const value = 17\n', 'leaf')
        const root = url(`import { value } from '${leaf}'\nexport default value\n`, 'root')

        snapshots.push([leaf, root].map((given) => ({ name: path.basename(fileURLToPath(given)), text: fs.readFileSync(fileURLToPath(given), 'utf8') })))
        loaded.push(await import(root))
      }

      assert.deepEqual(snapshots[0], snapshots[1], 'a private tree path leaked into generated text or its content name')
      assert.ok(snapshots.every((list) => list.every(({ text }) => !text.includes('ae-modules-') && !text.includes('file:///'))), 'generated text holds a private absolute path')
      assert.equal(loaded[0].default, 17)
      assert.equal(loaded[1].default, 17)
      assert.notStrictEqual(loaded[0], loaded[1], 'private file paths returned one ESM namespace')
    },
  },
]

// Each declaration names only the behavioral check that must reject the rewrite.
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { key: 'registry-leak', name: 'only the unchanged provenance instance is shared across utility trees', file: 'utilities.js', edits: [["const { moduleTree } = require('./module-files')", "const { moduleTree, urlOfSource: sharedSource } = require('./module-files')"], ['urls.set(name, urlOfSource(stubbed, `utility:${name}`))', "urls.set(name, name === 'provenance' ? sharedSource(stubbed) : urlOfSource(stubbed, `utility:${name}`))"]], fails: ['registry'] },
  { key: 'state-leak', name: 'only the unchanged utility state instance is shared across trees', file: 'utilities.js', edits: [["const { moduleTree } = require('./module-files')", "const { moduleTree, urlOfSource: sharedSource } = require('./module-files')"], ['urls.set(name, urlOfSource(stubbed, `utility:${name}`))', "urls.set(name, name === 'isolation/state' ? sharedSource(stubbed) : urlOfSource(stubbed, `utility:${name}`))"]], fails: ['state'] },
  { key: 'stub-leak', name: 'package stubs use shared text identity', file: 'utilities.js', edits: [["const { moduleTree } = require('./module-files')", "const { moduleTree, urlOfSource: sharedSource } = require('./module-files')"], ['urlOfSource(stub, `package:${specifier}`)', 'sharedSource(stub)']], fails: ['stubs'] },
  { key: 'page-override-leak', name: 'a page module override uses shared text identity', file: 'page-loader.js', edits: [["const { moduleTree } = require('./module-files')", "const { moduleTree, urlOfSource: sharedSource } = require('./module-files')"], ['urlOfSource(modules[name], `module:${name}`)', 'sharedSource(modules[name])']], fails: ['pages'] },
  { key: 'page-stub-leak', name: 'a page package stub uses shared text identity', file: 'page-loader.js', edits: [["const { moduleTree } = require('./module-files')", "const { moduleTree, urlOfSource: sharedSource } = require('./module-files')"], ['urlOfSource(stub, `package:${specifier}`)', 'sharedSource(stub)']], fails: ['pages'] },
  { key: 'page-component-leak', name: 'a page component stub uses shared text identity', file: 'page-loader.js', edits: [["const { moduleTree } = require('./module-files')", "const { moduleTree, urlOfSource: sharedSource } = require('./module-files')"], ['urlOfSource(VUE_STUB(specifier, namedComponents), `component:${path.posix.join(path.posix.dirname(name), specifier)}`)', 'sharedSource(VUE_STUB(specifier, namedComponents))']], fails: ['pages'] },
  { key: 'logical-identity', name: 'equal text collapses distinct logical module names', file: 'module-files.js', edits: [[".update(name).update('\\0').update(text)", '.update(text)']], fails: ['identity'] },
  { key: 'generated-path', name: 'generated text retains the private absolute tree path', file: 'module-files.js', edits: [["const text = source.split(prefix).join('./')", 'const text = source']], fails: ['generated'] },
]
/* eslint-enable no-template-curly-in-string */

const faultResults = async (fault) => {
  refusePlanting(fault.name)
  fs.mkdirSync(WORK, { recursive: true })

  const folder = fs.mkdtempSync(path.join(WORK, 'loader-isolation-'))
  const scripts = path.join(folder, 'scripts')

  if (!path.resolve(folder).startsWith(`${path.resolve(WORK)}${path.sep}`)) {
    throw new Error('the loader fixture escaped its workspace')
  }

  try {
    fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true })
    fs.copyFileSync(__filename, path.join(scripts, 'check-loader-isolation.js'))

    for (const file of ['module-files.js', 'utilities.js', 'page-loader.js']) {
      const source = fs.readFileSync(path.join(LIBRARY, file), 'utf8')
      const text = file === fault.file ? fault.edits.reduce((given, [from, to]) => patched(file, given, from, to), source) : source

      fs.writeFileSync(path.join(scripts, 'lib', file), text)
    }

    const run = await runChild(path.join(scripts, 'check-loader-isolation.js'), ['--no-mutations', `--only=${fault.fails.join(',')}`], { env: { LOADER_SUBJECT_ROOT: ROOT }, limit: 30000 })
    const markers = run.stdout.split(/\r?\n/).filter((line) => line.startsWith(PREFIX))

    if (run.timedOut || markers.length !== 1 || ![0, 1].includes(run.code)) {
      throw new Error(`the loader fault ${fault.key} gave no trustworthy results (code ${run.code}, timedOut ${run.timedOut}): ${run.stderr.slice(0, 500)}`)
    }

    return JSON.parse(markers[0].slice(PREFIX.length))
  } finally {
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

const main = async () => {
  const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean)
  const wanted = CHECKS.filter(({ id }) => !only.length || only.includes(id))

  if (!wanted.length || only.some((id) => !CHECKS.some((check) => check.id === id))) {
    throw new Error(`unknown loader case: ${only.join(',')}`)
  }

  const results = await runChecks(wanted, {})
  let total = results.length
  let failures = results.filter(({ ok }) => !ok).length

  results.forEach(({ id, name, ok, detail }) => console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${name}${detail ? `: ${detail}` : ''}`))

  if (mutating()) {
    for (const fault of FAULTS.filter(({ fails }) => !only.length || fails.every((id) => only.includes(id)))) {
      const observed = await faultResults(fault)
      const failed = judged(observed, fault.name)
      const credited = caughtBy(failed, fault.fails, { name: fault.name })

      if (!fault.fails.every((id) => observed.some((result) => result.id === id))) {
        throw new Error(`${fault.key} did not run its named check`)
      }

      total++
      failures += credited ? 0 : 1
      console.log(`${credited ? 'PASS' : 'FAIL'} fault ${fault.key}: ${fault.name}: ${failed.map(({ id, detail }) => DETAIL ? `${id}: ${detail}` : id).join('; ') || 'all named checks held'}`)
    }
  }

  console.log(`${PREFIX}${JSON.stringify(results)}`)
  console.log(`${total - failures} of ${total} checks passed`)
  process.exitCode = failures ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 2
})
