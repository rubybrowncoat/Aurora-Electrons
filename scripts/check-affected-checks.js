/* Bounded controls for import-free anchor discovery. No existing check, browser or database is started. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const assert = require('./lib/bounded-assert')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const FILES = { library: 'scripts/lib/affected-checks.js', adapters: 'scripts/lib/affected-checks-adapters.js', cli: 'scripts/affected-checks.js' }
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(path.join(root, file), 'utf8')]))
const subject = (fault = null) => {
  const texts = { ...ORIGINALS }
  if (fault) texts[fault.file] = plantedPatch(FILES[fault.file], texts[fault.file], fault.from, fault.to)
  const cache = {}
  const load = (name) => {
    if (cache[name]) return cache[name].exports
    const file = path.join(root, FILES[name])
    const module = { exports: {} }
    cache[name] = module
    const real = createRequire(file)
    const requireSubject = (specifier) => specifier === './affected-checks' || specifier === './lib/affected-checks' ? load('library') : specifier === './affected-checks-adapters' ? load('adapters') : real(specifier)
    vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${texts[name]}\n})`, { filename: file })(requireSubject, module, module.exports, file, path.dirname(file))
    return module.exports
  }
  return { lib: load('library'), adapters: load('adapters'), cli: load('cli') }
}
const PAGE = 'src/renderer/pages/sample.vue'
const OTHER = 'src/renderer/utilities/other.js'
const SUITE = 'scripts/check-route-position.js'
const loaderSources = Object.fromEntries(['scripts/lib/utilities.js', 'scripts/lib/page-loader.js', 'scripts/lib/module-files.js', 'scripts/lib/owner-temp.js'].filter((file) => fs.existsSync(path.join(root, file))).map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]))
// This data uses the same tuple, generated-index, optional-field, aggregate and selector shapes as the real registry.
const registry = `
const FILES = { page: 'src/renderer/pages/sample.vue', other: 'src/renderer/utilities/other.js' }
const FAULTS = [['alpha fault', 'page', 'alpha', 'ALPHA', ['check']], ...['first', 'second'].flatMap((name) => ['a', 'b'].map((suffix) => [name + suffix, 'other', 'gamma', 'GAMMA', ['check']]))]
const BENIGN = [{ label: 'beta rewrite', target: 'page', at: /beta/, to: () => { globalThis.__fu51Callback = true; return 'BETA' } }].map((edit, index) => ({ ...edit, id: 'benign:' + index }))
const COMBINED = BENIGN.filter((edit) => !edit.alone)
const COMPOSED = new Set([1, 2])
const STANDALONE = new Set([])
throw new Error('a suite was imported')
`
const harnessSources = { ...loaderSources, 'scripts/lib/suite-runner.js': 'module.exports = {}' }
const inputs = (source = registry) => ({ ...harnessSources, [SUITE]: source, [PAGE]: 'alpha beta', [OTHER]: 'gamma' })
const plan = (api, sources = inputs(), extra = {}) => api.lib.planChanges({ root, sources: { ...harnessSources, ...sources }, changed: [PAGE], ...extra, ...(extra.baseline ? { baseline: { ...harnessSources, ...extra.baseline } } : {}) })
const selection = (value, suite = SUITE) => value.selections.find((entry) => entry.suite === suite)
const SINK_SUITE = 'scripts/check-sink-consumer.js'
const SINK_DIRECT = 'scripts/check-sink-direct.js'
const SINK_HIDDEN = 'src/renderer/utilities/sink-hidden.js'
const sinkInputs = (source) => ({
  ...loaderSources,
  [SINK_SUITE]: "const {loadUtilities}=require('./lib/utilities');" + source,
  [SINK_DIRECT]: "require('../src/renderer/utilities/sink-hidden')",
  'scripts/check-sink-unrelated.js': "const {loadUtilities}=require('./lib/utilities');loadUtilities(['other'])",
  [SINK_HIDDEN]: 'export default 1', [OTHER]: 'export default 2',
})
const sinkPlan = (api, source, extra = {}) => plan(api, sinkInputs(source), { changed: [SINK_HIDDEN], identity: { mode: 'working-tree' }, ...extra })
const CHECKS = [
  ['catalog', 'literal, regex, logical targets and generated entries select actual execution keys', async (api) => {
    const value = await plan(api)
    assert.equal(value.status, 'ready-for-runs')
    assert.deepEqual(selection(value).keys, ['head', 'fault:0', 'composed:1', 'composed:2', 'benign:all'])
    assert.equal(api.lib.declarations(registry, SUITE, root).valueOf('FAULTS').length, 5)
    assert.equal(globalThis.__fu51Callback, undefined)
    assert.ok(selection(value).commands[0].args[0].includes('fault:0|composed:1|composed:2|benign:all'))
  }],
  ['aggregate', 'composed executions inherit benign anchors on another principal target', async (api) => {
    const value = await plan(api)
    assert.ok(selection(value).keys.includes('composed:1'))
    assert.ok(selection(value).keys.includes('composed:2'))
    const records = api.adapters.catalogSuite(registry, SUITE, root, Object.keys(inputs()))
    assert.equal(records.variants.find((entry) => entry.key === 'composed:1').anchors.some((anchor) => anchor.file === PAGE), true)
  }],
  ['cardinality', 'zero and duplicate anchors refuse, while declared counts and first-match semantics remain', async (api) => {
    for (const text of ['beta', 'alpha alpha beta']) assert.equal((await plan(api, { ...inputs(), [PAGE]: text })).status, 'blocked')
    const source = "const PAGE = 'src/renderer/pages/sample.vue'; const FAULTS = [{ file: PAGE, change: swap('beta', 'B', 2) }]; const variantsOf = (mutating) => [{key:'head',head:true}, ...(mutating ? FAULTS.map((fault,index)=>({key:'fault:'+index,run:()=>checkFault(fault)})) : [])]; const {runSuite}=require('./lib/suite-runner')"
    const suite = 'scripts/check-counted.js'
    const sources = { [suite]: source, [PAGE]: 'beta beta' }
    assert.equal((await plan(api, sources)).status, 'ready-for-runs')
    assert.equal((await plan(api, { ...sources, [PAGE]: 'beta' })).status, 'blocked')
    const first = source.replace("change: swap('beta', 'B', 2)", "at: /beta/, first: true, to: () => 'B'")
    assert.equal((await plan(api, { ...sources, [suite]: first })).status, 'ready-for-runs')
    assert.ok((await api.lib.matches('a'.repeat(20000) + '!', { from: { regex: '^(a+)+$', flags: '' } }, 30)).error)
  }],
  ['unknown', 'unknown dynamic targets and procedural declaration callbacks block instead of disappearing', async (api) => {
    const dynamic = registry.replace("target: 'page'", 'target: process.env.FU51_TARGET')
    assert.equal((await plan(api, inputs(dynamic))).status, 'blocked')
    const procedural = registry.replace('!edit.alone', '(() => { globalThis.__fu51Callback = true; return true })()')
    assert.equal((await plan(api, inputs(procedural))).status, 'blocked')
    assert.equal(globalThis.__fu51Callback, undefined)
    const opaqueLocal = registry.replace('BENIGN.filter((edit) => !edit.alone)', 'BENIGN.map((edit) => { const state = unsupported(); return edit })')
    assert.equal((await plan(api, inputs(opaqueLocal))).status, 'blocked')
    const outside = api.lib.declarations("const fs = require('fs'); const found = fs.existsSync('/outside/fixture.db')", SUITE, root, [PAGE])
    assert.equal(api.lib.isUnknown(outside.valueOf('found')), true)
    const aliased = "const {plantedPatch: plant}=require('./lib/mutant-source'); const target=process.env.FU51_TARGET; plant(target, 'text', 'from', 'to')"
    assert.equal((await plan(api, { 'scripts/check-dynamic.js': aliased, [PAGE]: 'alpha beta' })).status, 'blocked')
    const unnamed = registry + "\nconst unregisteredEdits = [{ file: chooseTarget(), from: 'alpha', to: 'ALPHA' }]"
    assert.equal((await plan(api, inputs(unnamed))).status, 'blocked')
  }],
  ['union', 'baseline targets, deletions and removed suites cannot erase a landing obligation', async (api) => {
    const current = inputs(registry.replaceAll("'page'", "'other'").replace(PAGE, OTHER))
    const value = await plan(api, current, { baseline: inputs() })
    assert.ok(selection(value))
    assert.ok(selection(value).reasons.some((entry) => entry.reason === 'source anchor' && entry.file === PAGE))
    const removed = { [PAGE]: 'alpha beta', [OTHER]: 'gamma' }
    assert.equal((await plan(api, removed, { baseline: inputs() })).status, 'blocked')
    const missing = { ...inputs() }
    delete missing[PAGE]
    assert.equal((await plan(api, missing, { baseline: inputs() })).status, 'blocked')
  }],
  ['alias', 'logical and destructured aliases resolve to the actual target without requiring the suite', async (api) => {
    const source = registry.replace('const FAULTS =', 'const { page } = Object.fromEntries(Object.keys(FILES).map((key) => [key, key])); const FAULTS =').replace("'alpha fault', 'page'", "'alpha fault', page")
    const value = await plan(api, inputs(source))
    assert.equal(value.status, 'ready-for-runs')
    assert.ok(selection(value).keys.includes('fault:0'))
  }],
  ['dependencies', 'transitive helper and renderer-alias edges widen consumers with cycle protection', async (api) => {
    const sources = { ...inputs("const helper = require('./lib/one');\n" + registry), 'scripts/lib/one.js': "require('./two')", 'scripts/lib/two.js': "require('./one')" }
    const value = await plan(api, sources, { changed: ['scripts/lib/two.js'] })
    assert.ok(selection(value))
    assert.ok(selection(value).keys.includes('fault:2'))
    const relative = api.lib.dependencyGraph({ 'src/renderer/utilities/one.js': "import x from '@/utilities/two'", 'src/renderer/utilities/two.js': 'export default 1' })
    assert.ok(relative.graph.get('src/renderer/utilities/one.js').has('src/renderer/utilities/two.js'))
  }],
  ['opaque-rewrites', 'unsupported and mixed rewrite callbacks cannot disappear beside a recognized anchor', async (api) => {
    const suite = 'scripts/check-opaque.js'
    const make = (change) => `const PAGE='${PAGE}'; const FAULTS=[{file:PAGE,find:'alpha',replace:'BAD'}, {file:PAGE,change:${change}}]; const {runSuite}=require('./lib/suite-runner'); const variantsOf=()=>[{key:'head',head:true},...FAULTS.map((fault,index)=>({key:'fault:'+index,run:()=>checkFault(fault)}))]`
    for (const change of ["text=>text.replace('beta','BAD')", "text=>swap('alpha','BAD')(text).replace('beta','BAD')", "text=>{ const next=swap('alpha','BAD')(text); return next.replace('beta','BAD') }"]) {
      const sources = { [suite]: make(change), [PAGE]: 'alpha beta' }
      const catalog = api.adapters.catalogSuite(sources[suite], suite, root, Object.keys(sources))
      assert.notEqual(catalog.coverage, 'complete')
      assert.ok(catalog.variants.find((entry) => entry.key === 'fault:1').anchors.length)
      assert.equal((await plan(api, sources)).status, 'blocked')
    }
    for (const field of ['rewrite', 'transform', 'applySource', 'unreviewedCallback']) {
      const source = make("text=>text.replace('beta','BAD')").replace('change:', field + ':')
      const sources = { [suite]: source, [PAGE]: 'alpha beta' }
      const catalog = api.adapters.catalogSuite(source, suite, root, Object.keys(sources))
      assert.notEqual(catalog.coverage, 'complete')
      assert.ok(catalog.unknowns.some((message) => message.includes('FAULTS[1].' + field) && message.includes('line 1')))
      assert.equal((await plan(api, sources)).status, 'blocked')
    }
    for (const descriptor of ["{file:PAGE,find:'beta',replace:'BAD',unreviewedMode:'text'}", "{file:PAGE,label:()=> 'unknown behavior'}", "text=>text.replace('beta','BAD')", "{file:PAGE,find:'beta',replace:'BAD',count:()=>2}"]) {
      const source = make("text=>text.replace('beta','BAD')").replace("{file:PAGE,change:text=>text.replace('beta','BAD')}", descriptor)
      const sources = { [suite]: source, [PAGE]: 'alpha beta' }
      assert.equal((await plan(api, sources)).status, 'blocked')
    }
    const located = make("text=>text.replace('beta','BAD')").replace('change:', '\nrewrite:').replace(']; const {runSuite}', '].map(edit=>({...edit,id:"generated"})); const {runSuite}')
    const locatedCatalog = api.adapters.catalogSuite(located, suite, root, [suite, PAGE])
    assert.ok(locatedCatalog.unknowns.some((message) => message.includes('FAULTS[1].rewrite at line 2')))
    const supported = { [suite]: make("text=>swap('beta','B')(swap('alpha','A')(text))"), [PAGE]: 'alpha beta' }
    assert.equal((await plan(api, supported)).status, 'ready-for-runs')
  }],
  ['ingestion', 'every descriptor producer shares origin accounting and cannot erase unknown behavior', async (api) => {
    const suite = 'scripts/check-inline.js'
    const known = "{name:'known',file:PAGE,find:'alpha',replace:'BAD'}"
    const second = "{name:'second',file:PAGE,find:'beta',replace:'BAD'}"
    const opaque = "{name:'opaque',file:PAGE,rewrite:text=>text.replace('beta','BAD')}"
    const wrap = (declarations, variants) => `const {runSuite}=require('./lib/suite-runner'); const PAGE='${PAGE}'; ${declarations}; const variantsOf=()=>[{key:'head',head:true,run:()=>{}},${variants}]`
    const inline = (value) => wrap('', `{key:'fault:0',run:()=>checkFault(${known})},{key:'fault:1',run:()=>checkFault(${value})}`)
    const catalogOf = (source, file = suite) => api.adapters.catalogSuite(source, file, root, [file, PAGE])
    const consistent = (catalog) => {
      const proof = catalog.proof.descriptorAccounting
      assert.ok(catalog.variants.every((variant) => proof.ingestionOrigins.some((origin) => origin.location === 'variant:' + variant.key)))
      assert.ok(proof.descriptors > 0)
      return proof
    }
    const positive = inline(second)
    const complete = catalogOf(positive)
    assert.equal(complete.coverage, 'complete')
    assert.equal(consistent(complete).accounted, 2)
    assert.deepEqual(selection(await plan(api, { [suite]: positive, [PAGE]: 'alpha beta' }), suite).keys, ['head', 'fault:0', 'fault:1'])
    const producers = [
      inline(opaque),
      wrap(`const captured=${opaque}`, `{key:'fault:0',run:()=>checkFault(${known})},{key:'fault:1',run:()=>checkFault(captured)}`),
      wrap(`const edit=()=>(${opaque})`, `{key:'fault:0',run:()=>checkFault(${known})},{key:'fault:1',run:()=>checkFault(edit())}`),
      wrap('', `{key:'group:one',members:[${known},${opaque}]}`),
      wrap(`const BENIGN=[${known}]`, `{key:'benign:all',run:()=>checkRewrite(${opaque})}`),
      wrap(`const FAULTS=[${known}]`, "{key:'fault:0',run:()=>{checkFault(FAULTS[0]); unknownSideEffect()}}"),
      wrap('', "{key:'fault:0',run:()=>checkFault(unresolvedDescriptor)}"),
      wrap('', "{key:'fault:0',run:()=>unknownSideEffect()}"),
      wrap('', "{key:'fault:0',run:()=>{}}"),
      wrap('', `{key:'fault:0',run:()=>checkFault(${known},unresolvedDescriptor)}`),
      wrap('', `{key:'head-extra',head:true,run:()=>checkFault(${opaque})}`),
    ]
    for (const source of producers) {
      const catalog = catalogOf(source)
      assert.notEqual(catalog.coverage, 'complete')
      assert.equal((await plan(api, { [suite]: source, [PAGE]: 'alpha beta' })).status, 'blocked')
    }
    const families = [
      [SUITE, registry],
      ['scripts/check-route-time.js', `const PAGE='${PAGE}'; const MUTANTS=[{...${known},id:'fault:0'}]; const BENIGN=[${second}]; const COMPOSED=[{...${known},id:'composed:0'}]`],
      ['scripts/check-route-signatures.js', `const PAGE='${PAGE}'; const MUTATIONS=[${known}]; const BENIGN=[${second}]; const BROWSER_MUTATIONS=[{...${known},group:'g'}]; const BROWSER_BENIGN=[{...${second},reads:'read'}]`],
      ['scripts/check-fleet-profile.js', `const PAGE='${PAGE}'; const FAULTS=[${known}]; const BENIGN=[${second}]`],
    ]
    for (const [file, source] of families) {
      const catalog = api.adapters.catalogSuite(source, file, root, [file, PAGE, OTHER])
      assert.equal(catalog.coverage, 'complete')
      consistent(catalog)
    }
  }],
  ['computed-dependencies', 'computed imports, unknown imports and deleted helper targets retain obligations', async (api) => {
    const helper = 'scripts/lib/patch-driver.js'
    const suite = 'scripts/check-computed.js'
    const base = "const {runSuite}=require('./lib/suite-runner'); const PAGE='" + PAGE + "'; const FAULTS=[{file:PAGE,find:'alpha',replace:'BAD'}]; const variantsOf=()=>[{key:'head',head:true},...FAULTS.map((fault,index)=>({key:'fault:'+index,run:()=>checkFault(fault)}))]; "
    const literal = { [suite]: base + "require('./lib/patch-driver')", [helper]: 'module.exports=1', [PAGE]: 'alpha beta' }
    const computed = { ...literal, [suite]: base + "const name='patch-driver'; require('./lib/'+name)" }
    const ready = await plan(api, computed, { changed: [helper] })
    assert.equal(ready.status, 'ready-for-runs')
    assert.deepEqual(selection(ready, suite).keys, ['head', 'fault:0'])
    const dynamic = { ...literal, [suite]: base + 'require(process.env.FU51_MODULE)' }
    assert.equal((await plan(api, dynamic, { changed: [helper] })).status, 'blocked')
    assert.equal((await plan(api, dynamic, { changed: [OTHER] })).status, 'blocked')
    const shadowed = { ...literal, [suite]: base + "const name='patch-driver'; function load(name){return require('./lib/'+name)}" }
    assert.equal((await plan(api, shadowed, { changed: [helper] })).status, 'blocked')
    const retiredUnknown = { ...literal, [suite]: base }
    assert.equal((await plan(api, retiredUnknown, { baseline: dynamic, changed: [helper] })).status, 'blocked')
    const deleted = { ...literal }; delete deleted[helper]
    const result = await plan(api, deleted, { baseline: literal, changed: [helper] })
    assert.equal(result.status, 'blocked')
    assert.ok(result.blockers.some((entry) => entry.target === helper))
    const bridge = 'scripts/lib/re-export.js'
    for (const statement of ["export * from './patch-driver.js'", "export * as driver from './patch-driver.js'", "export { x } from './patch-driver.js'", "import { x } from './patch-driver.js'; export { x }"]) {
      const sources = { ...literal, [suite]: base + "require('./lib/re-export')", [bridge]: statement, [helper]: 'export const x=1' }
      const value = await plan(api, sources, { changed: [helper] })
      assert.equal(value.status, 'ready-for-runs')
      assert.ok(selection(value, suite))
      assert.ok(selection(value, suite).keys.includes('fault:0'))
      const retired = { ...sources, [bridge]: 'export const x=1' }
      assert.ok(selection(await plan(api, retired, { baseline: sources, changed: [helper] }), suite))
      const removed = { ...sources }; delete removed[helper]
      assert.equal((await plan(api, removed, { baseline: sources, changed: [helper] })).status, 'blocked')
    }
    assert.equal((await plan(api, { ...literal, [suite]: base + "const load=require; load('./lib/patch-driver')" }, { changed: [helper] })).status, 'ready-for-runs')
    for (const statement of ["require('./lib/absent.js')", 'require()', 'require(...targets)', 'export * from dynamicallyChosen', "import('file:///unknown-source.js')"]) {
      assert.equal((await plan(api, { ...literal, [suite]: base + statement }, { changed: [helper] })).status, 'blocked')
    }
  }],
  ['selectors', 'existing part syntax, runner keys and group lifting are emitted without guessed aliases', async (api) => {
    const entries = [{ key: 'head', head: true }, { key: 'mutant:0' }]
    assert.deepEqual(api.adapters.commandsFor({ family: 'part' }, entries).map((command) => command.args), [['--part', 'head'], ['--part', 'mutant:0']])
    const source = "const PAGE = 'src/renderer/pages/sample.vue'; const FAULTS = [{file:PAGE,find:'alpha',to:'ALPHA'}, {file:PAGE,find:'beta',to:'BETA'}]; const {runSuite}=require('./lib/suite-runner'); const variantsOf=()=>[{key:'head',head:true},{key:'group:one',members:FAULTS}]"
    const value = await plan(api, { 'scripts/check-grouped.js': source, [PAGE]: 'alpha beta' })
    assert.equal(value.status, 'ready-for-runs')
    assert.deepEqual(value.selections[0].keys, ['head', 'group:one'])
    assert.ok(value.selections[0].commands[0].args.includes('--variants=head,group:one'))
    assert.equal(value.selections[0].commands[0].args[0], '--detail')
  }],
  ['evidence', 'changed, missing or failed execution evidence cannot satisfy a sealed plan', async (api) => {
    const value = await plan(api)
    const records = value.selections.flatMap((entry) => entry.commands.map((command) => ({ suite: entry.suite, args: command.args, sourceHash: entry.sourceHash, keys: command.keys, code: 0 })))
    assert.equal(api.lib.verifyEvidence(value, records, value.fingerprints).passed, true)
    const full = [{ ...records[0], args: ['--detail'], keys: selection(value).defaultKeys, completeDefault: true }]
    assert.equal(api.lib.verifyEvidence(value, full, value.fingerprints).passed, true)
    assert.throws(() => api.lib.verifyEvidence(value, full.map((record) => ({ ...record, completeDefault: false })), value.fingerprints), /unsuccessful/)
    assert.throws(() => api.lib.verifyEvidence(value, records.map((record) => ({ ...record, keys: ['head'] })), value.fingerprints), /variant execution/)
    assert.throws(() => api.lib.verifyEvidence(value, records.map((record) => ({ ...record, code: 1 })), value.fingerprints), /unsuccessful/)
    assert.throws(() => api.lib.verifyEvidence(value, records, {}), /sources changed/)
    assert.throws(() => api.lib.verifyEvidence({ ...value, changed: [] }, records, value.fingerprints), /digest/)
  }],
  ['historical', 'the actual old Hauling panel regex refuses the added data hook', async (api) => {
    const source = registry.replace(/const BENIGN = [\s\S]*?const COMBINED/, "const BENIGN = [{ label:'panel',target:'page',at:/<v-card class=\"panel\" (data-summary=\"[^\"]*\") (elevation=\"1\")>((?:(?!<v-card class=\"panel\")[\\s\\S])*?:items=\"planRows\")/,to:()=>''}].map((edit,index)=>({...edit,id:'benign:'+index})); const COMBINED")
    const before = 'alpha <v-card class="panel" data-summary="Plan hauls" elevation="1"><table :items="planRows">'
    assert.equal((await plan(api, { ...inputs(source), [PAGE]: before })).status, 'ready-for-runs')
    assert.equal((await plan(api, { ...inputs(source), [PAGE]: before.replace('elevation="1">', 'elevation="1" data-hauling-plan>') })).status, 'blocked')
  }],
  ['terminal-edges', 'descriptor text reads do not execute the descriptor target imports', async (api) => {
    const target = 'scripts/lib/read-only.js'
    const dependency = 'scripts/lib/not-loaded.js'
    const sources = { ...inputs(registry.replace(PAGE, target)), [target]: "require('./not-loaded') // alpha beta", [dependency]: 'module.exports=1' }
    const result = await plan(api, sources, { changed: [dependency] })
    assert.equal(selection(result), undefined)
    assert.ok(selection(await plan(api, sources, { changed: [target] })))
    const quoted = "const FAULTS=[{file:'" + PAGE + "',from:\"require('./not-loaded')\",to:'BAD'}]"
    assert.equal(api.lib.dependencyGraph({ [SUITE]: quoted }).graph.get(SUITE).size, 0)
  }],
  ['loader-edges', 'named utilities, aliased page loaders and Vue imports reach non-obvious modules', async (api) => {
    const hidden = 'src/renderer/utilities/hidden.js'
    const consumer = 'scripts/check-indirect.js'
    const sources = { ...loaderSources, [consumer]: "const {loadUtilities}=require('./lib/utilities'); const {loadPage:mount}=require('./lib/page-loader'); const NAMES=['other']; loadUtilities(NAMES); mount('pages/sample')", [PAGE]: "<script>import hidden from '../utilities/hidden'; export default {}</script>", [OTHER]: "import hidden from './hidden'; export default hidden", [hidden]: 'export default 7' }
    const result = await plan(api, sources, { changed: [hidden], identity: { mode: 'working-tree' } })
    assert.deepEqual(result.selections.map((entry) => entry.suite), [consumer])
    assert.ok(selection(result, consumer).reasons.some((entry) => entry.file === hidden))
    const graph = api.lib.dependencyGraph(sources, root)
    assert.ok(graph.graph.get(consumer).has(PAGE))
    assert.ok(graph.graph.get(consumer).has(OTHER))
  }],
  ['audited-loader-domain', 'real audited loaders preserve caller domains without promoting mutable URL caches into import uncertainty', async (api) => {
    const utility = 'scripts/check-loader-utility.js'
    const page = 'scripts/check-loader-page.js'
    const direct = 'scripts/check-loader-direct.js'
    const unrelated = 'scripts/check-loader-unrelated.js'
    const hidden = 'src/renderer/utilities/hidden.js'
    const sources = { ...loaderSources, [utility]: "const {loadUtilities}=require('./lib/utilities');loadUtilities(['hidden'])", [page]: "const {loadPage}=require('./lib/page-loader');loadPage('pages/sample')", [direct]: "require('../src/renderer/utilities/hidden')", [unrelated]: "const {loadUtilities}=require('./lib/utilities');loadUtilities(['other'])", [PAGE]: "<script>import value from '../utilities/hidden';export default {}</script>", [hidden]: 'export default 1', [OTHER]: 'export default 2' }
    const service = 'scripts/lib/mutable-service.js'
    sources[service] = 'module.exports=read=>{const state=read();state.count=1;return state}'
    for (const file of [utility, page, direct, unrelated]) sources[file] = "require('./lib/mutable-service');" + sources[file]
    assert.ok(api.lib.declarations(sources[service]).mutationUncertainty.length)
    assert.deepEqual(api.lib.declarations(loaderSources['scripts/lib/module-files.js']).mutationUncertainty, [])
    const exported = api.lib.declarations("const PAGE='src/page.js';const FAULTS=[{file:PAGE}];module.exports={FAULTS}")
    assert.equal(exported.mutableNames.has('PAGE'), false)
    assert.equal(exported.mutableNames.has('FAULTS'), false)
    assert.deepEqual(api.lib.declarations('const holder={};holder.value=read()').mutationUncertainty, [])
    const graph = api.lib.dependencyGraph(sources, root)
    assert.deepEqual(graph.unresolved, [])
    for (const helper of ['scripts/lib/utilities.js', 'scripts/lib/page-loader.js']) {
      assert.equal(sources[helper], fs.readFileSync(path.join(root, helper), 'utf8'))
      assert.ok(graph.graph.get(helper).has('scripts/lib/module-files.js'))
      assert.ok(graph.contracts.some((entry) => entry.file === helper && entry.callerLoads?.length && entry.sourceHash === api.lib.hash(sources[helper].replace(/\r\n/g, '\n'))))
    }
    const changedCheck = await plan(api, sources, { changed: [utility], identity: { mode: 'working-tree' } })
    assert.deepEqual(changedCheck.selections.map((entry) => entry.suite), [utility])
    const changedLeaf = await plan(api, sources, { changed: [hidden], identity: { mode: 'working-tree' } })
    assert.deepEqual(changedLeaf.selections.map((entry) => entry.suite), [direct, page, utility].sort())
    assert.deepEqual(changedLeaf.widenings, [])
  }],
  ['setup-dependencies', 'untouched SFC setup consumers and direct consumers are both selected in working-tree and landing plans', async (api) => {
    const consumer = 'scripts/check-setup-consumer.js'
    const direct = 'scripts/check-setup-direct.js'
    const untouched = 'scripts/check-setup-unrelated.js'
    const hidden = 'src/renderer/pages/hidden.js'
    const normal = 'src/renderer/pages/normal.js'
    const head = "const {runSuite}=require('./lib/suite-runner');const variantsOf=()=>[{key:'head',head:true}];"
    for (const page of ["<script setup>import x from './hidden.js'</script>", "<script>import normal from './normal.js'</script><script setup>import x from './hidden.js'</script>"]) {
      const baseline = { ...harnessSources, [consumer]: head + "const {loadPage}=require('./lib/page-loader');loadPage('pages/sample')", [direct]: head + "require('../src/renderer/pages/hidden.js')", [untouched]: head, [PAGE]: page, [hidden]: 'export default 1', [normal]: 'export default 3' }
      const sources = { ...baseline, [hidden]: 'export default 2' }
      const graph = api.lib.dependencyGraph(sources, root)
      assert.equal(graph.unresolved.length, 0)
      assert.ok(graph.graph.get(PAGE).has(hidden))
      if (page.includes('normal.js')) assert.ok(graph.graph.get(PAGE).has(normal))
      for (const identity of [{ mode: 'working-tree' }, { mode: 'git-diff', landingGate: true }]) {
        const value = await plan(api, sources, { baseline, changed: [hidden], identity })
        assert.equal(value.status, 'ready-for-runs')
        assert.deepEqual(value.selections.map((entry) => entry.suite), [consumer, direct].sort())
        assert.equal(value.widenings.length, 0)
        assert.equal(sources[consumer], baseline[consumer])
      }
    }
    const invalid = { ...loaderSources, [consumer]: "const {loadPage}=require('./lib/page-loader');loadPage('pages/sample')", [PAGE]: '<script setup>import(process.env.UNKNOWN_SETUP_MODULE)</script>', [hidden]: 'export default 1', [direct]: "require('../src/renderer/pages/hidden.js')" }
    const widened = await plan(api, invalid, { changed: [hidden], identity: { mode: 'working-tree' } })
    assert.ok(selection(widened, consumer).reasons.some((reason) => reason.file === PAGE && reason.reason.includes('computed import')))
    const ambiguous = await plan(api, { ...invalid, [PAGE]: "<script>import x from './normal.js'</script><script setup>import x from './hidden.js'</script>" }, { changed: [hidden], identity: { mode: 'working-tree' } })
    assert.ok(selection(ambiguous, consumer).reasons.some((reason) => reason.file === PAGE && reason.reason.includes('syntax could not be parsed')))
  }],
  ['callback-uses', 'call, extracted aliases and computed require members discover edges while opaque callback uses widen', async (api) => {
    const file = 'scripts/check-callback-uses.js'
    const target = 'scripts/lib/hidden.js'
    const prelude = "const {createRequire}=require('module');const localRequire=createRequire(__filename);"
    for (const call of ["localRequire.call(null,'./lib/hidden')", "localRequire.apply(null,['./lib/hidden'])", "const read=localRequire;read('./lib/hidden')", "require['resolve']('./lib/hidden')"]) {
      const graph = api.lib.dependencyGraph({ [file]: prelude + call, [target]: 'module.exports=1' }, root)
      assert.equal(graph.unresolved.length, 0, call)
      assert.ok(graph.graph.get(file).has(target), call)
    }
    for (const call of ['localRequire.call(null,process.env.TARGET)', 'const read=localRequire;read(process.env.TARGET)', "require[process.env.METHOD]('./lib/hidden')", 'consume(localRequire)', "let read=localRequire;read=process.env.CALLBACK;read('./lib/hidden')"]) {
      const sources = { [file]: prelude + call, [target]: 'module.exports=1', 'scripts/check-mapped.js': "require('./lib/hidden')" }
      const value = await plan(api, sources, { changed: [target], identity: { mode: 'working-tree' } })
      assert.ok(selection(value, file)?.reasons.some((reason) => reason.reason.includes('widening to complete suite')), call)
    }
  }],
  ['mutable-dependencies', 'reassignment, conditional writes and aliased array/object mutation cannot retain only initializer dependencies', async (api) => {
    const file = 'scripts/check-mutable.js'
    const target = 'scripts/lib/hidden.js'
    const cases = [
      "let target='./lib/other';target='./lib/hidden';require(target)",
      "let target='./lib/other';if(process.env.CHANGE)target='./lib/hidden';require(target)",
      "const paths={target:'./lib/other'};paths.target='./lib/hidden';require(paths.target)",
      "const {loadUtilities}=require('./lib/utilities');const names=['other'];names.push('hidden');loadUtilities(names)",
      "const {loadUtilities}=require('./lib/utilities');const names=['other'];const alias=names;alias.push('hidden');loadUtilities(names)",
      "const {loadUtilities}=require('./lib/utilities');const names=['other'];const method=process.env.METHOD;names[method]('hidden');loadUtilities(names)",
      "const paths={target:'./lib/other'};Object.assign(paths,{target:'./lib/hidden'});require(paths.target)",
      "const path=require('path');const run=base=>{let file=path.join(base,'scripts','lib','other.js');file=path.join(base,'scripts','lib','hidden.js');require(file)}",
    ]
    for (const source of cases) {
      const sources = { ...loaderSources, [file]: source, [target]: 'module.exports=1', 'scripts/lib/other.js': 'module.exports=2', 'src/renderer/utilities/hidden.js': 'export default 1', 'src/renderer/utilities/other.js': 'export default 2', 'scripts/check-mapped.js': "require('./lib/hidden')" }
      const value = await plan(api, sources, { changed: [target], identity: { mode: 'working-tree' } })
      const binding = source.includes('loadUtilities') ? 'names' : source.includes('const paths=') ? 'paths' : source.includes('const run=base') ? 'file' : 'target'
      assert.ok(api.lib.declarations(source).mutableNames.has(binding), source)
      if (source.includes('loadUtilities')) assert.ok(api.lib.dependencyGraph(sources, root).unresolved.some((issue) => issue.reason === 'unknown loadUtilities call; target domain is unresolved'), source)
      assert.ok(selection(value, file)?.reasons.some((reason) => reason.reason.includes('widening to complete suite')), source)
    }
    const declarations = api.lib.declarations("let target='./lib/other';target='./lib/hidden'")
    assert.ok(api.lib.isUnknown(declarations.valueOf('target')))
    assert.ok(api.lib.isUnknown(declarations.evaluate({ type: 'Identifier', name: 'target' }, { target: './lib/other' })))
  }],
  ['assignment-alias-mutations', 'assignment aliases and extracted mutation methods retain hidden consumers and unresolved chains widen', async (api) => {
    const file = 'scripts/check-mutable-alias.js'
    const direct = 'scripts/check-mapped.js'
    const target = 'scripts/lib/hidden.js'
    const prefix = "const paths={target:'./lib/other'};"
    const cases = [
      ["let alias;alias=paths;alias.target='./lib/hidden';require(paths.target)", true],
      ["const assign=Object.assign;assign(paths,{target:'./lib/hidden'});require(paths.target)", true],
      ["let first;first=paths;let second;second=first;second.target='./lib/hidden';require(paths.target)", true],
      ["const assign=Object.assign;let again;again=assign;again(paths,{target:'./lib/hidden'});require(paths.target)", true],
      ["const {assign}=Object;assign(paths,{target:'./lib/hidden'});require(paths.target)", true],
      ["const namespace=Object;namespace.assign(paths,{target:'./lib/hidden'});require(paths.target)", true],
      ["const choose=()=>paths;const alias=choose();alias.target='./lib/hidden';require(paths.target)", false],
      ['const assign=Object.assign;consume(assign);require(paths.target)', false],
      ["const assign=Object[process.env.METHOD];assign(paths,{target:'./lib/hidden'});require(paths.target)", false],
      ["const holder={get value(){return paths}};const alias=holder.value;alias.target='./lib/hidden';require(paths.target)", false],
      ["for(const alias of [paths])alias.target='./lib/hidden';require(paths.target)", true],
      ["const holder={mutate(value){value.target='./lib/hidden'}};const fn=holder.mutate;fn(paths);require(paths.target)", false],
      ["const holder={mutate(value){value.target='./lib/hidden'}};const fn=holder.mutate;const again=fn;again(paths);require(paths.target)", false],
      ["const Map=class{constructor(){return paths}};const alias=new Map();alias.target='./lib/hidden';require(paths.target)", false],
      ["const holder={node:paths};holder.node.target='./lib/hidden';require(paths.target)", true],
      ["const holder={};holder.value=choose();holder.value.target='./lib/hidden';require(paths.target)", false],
      ["const rows=[paths];const alias=rows[0];alias.target='./lib/hidden';require(paths.target)", false],
    ]
    for (const [probe, resolved] of cases) {
      const source = prefix + probe
      const sources = { [file]: source, [direct]: "require('./lib/hidden')", 'scripts/check-unrelated.js': 'module.exports=0', [target]: 'module.exports=1', 'scripts/lib/other.js': 'module.exports=2' }
      const value = await plan(api, sources, { changed: [target], identity: { mode: 'working-tree' } })
      assert.deepEqual(value.selections.map((entry) => entry.suite), [direct, file].sort(), probe)
      assert.ok(selection(value, file).reasons.some((reason) => /mutable binding|mutation alias/.test(reason.reason)), probe)
      const data = api.lib.declarations(source)
      if (resolved) {
        assert.ok(data.mutableNames.has('paths'), probe)
        assert.deepEqual(data.mutationUncertainty, [], probe)
      } else {
        assert.ok(data.mutationUncertainty.length > 0, probe)
        const logged = []
        const previous = console.log
        try { console.log = (text) => logged.push(text); api.cli.printPlan(value) } finally { console.log = previous }
        const printed = JSON.parse(logged.join(''))
        assert.deepEqual(printed.selected.map((entry) => entry.suite), [direct, file].sort(), probe)
        assert.ok(printed.selected.find((entry) => entry.suite === file).reasons.some((reason) => reason.reason === 'widening to complete suite: mutation alias chain or mutation-method use is unresolved'), probe)
      }
    }
  }],
  ['fail-closed-loop', 'unmapped sources and uncertain imports retain full fallback commands with exact reasons', async (api) => {
    const second = 'scripts/check-second.js'
    const sources = { ...inputs(), [second]: 'module.exports=1' }
    const unmapped = await plan(api, sources, { changed: ['src/new-kind.bin'], identity: { mode: 'working-tree' } })
    assert.deepEqual(unmapped.selections.map((entry) => entry.suite), [SUITE, second].sort())
    assert.ok(unmapped.widenings.some((entry) => entry.reason.includes('unmapped source')))
    for (const statement of ['require(process.env.MODULE)', 'loadUtilities(process.env.MODULES)', "import('file:///unresolved.js')", 'import { invalid']) {
      const value = await plan(api, { ...sources, [second]: statement }, { changed: [OTHER], identity: { mode: 'working-tree' } })
      const chosen = selection(value, second)
      assert.ok(chosen, statement)
      assert.deepEqual(chosen.deepCommands[0].args, [])
      assert.ok(chosen.reasons.some((entry) => entry.reason.includes('widening to complete suite')), statement)
    }
  }],
  ['loop-modes', 'the default fast pass and explicit deep pass print separate runnable commands and selection reasons', async (api) => {
    assert.equal(api.cli.optionsOf([]).command, 'select')
    assert.equal(api.cli.optionsOf(['--changed', PAGE]).mode, 'fast')
    assert.equal(api.cli.optionsOf(['select', '--deep']).mode, 'deep')
    const fast = await plan(api, inputs(), { identity: { mode: 'working-tree', depth: 'fast' } })
    const deep = await plan(api, inputs(), { identity: { mode: 'working-tree', depth: 'deep' } })
    assert.deepEqual(selection(fast).commands[0].args, ['--no-mutations'])
    assert.ok(selection(deep).commands[0].args.some((arg) => arg.startsWith('--only=')))
    assert.ok(api.cli.runCommand(fast.selections, 'fastCommands').includes('bun ' + SUITE + ' --no-mutations'))
    const logged = []
    const previous = console.log
    try { console.log = (text) => logged.push(text); api.cli.printPlan(fast) } finally { console.log = previous }
    const printed = JSON.parse(logged.join(''))
    assert.ok(printed.selected[0].reasons.length)
    assert.ok(printed.fastCommand.includes('--no-mutations'))
    assert.ok(printed.deepCommand.includes('--only='))
    assert.ok(printed.sweep.includes('1 of 1 scripts'))
  }],
  ['implicit-source', 'an implicit descriptor target is bounded by named source constants, never replacement strings', async (api) => {
    const source = `const PAGE_FILE='${PAGE}'; const FAULTS=[{find:'alpha',replace:'BAD'}]; const {runSuite}=require('./lib/suite-runner');const variantsOf=()=>[{key:'head',head:true},{key:'fault:0',run:()=>checkFault(FAULTS[0])}]`
    const catalog = api.adapters.catalogSuite(source, 'scripts/check-shape.js', root, [PAGE])
    assert.equal(catalog.unknownDomain, false)
    assert.ok(catalog.variants.find((entry) => entry.key === 'fault:0').anchors.some((entry) => entry.file === PAGE))
  }],
  ['file-map', 'the FILE spelling of a finite source alias map resolves nested patch tuples', async (api) => {
    const source = `const FILE={page:'${PAGE}'};const FAULTS=[['a fault',[['page','alpha','BAD']],['checks']]]`
    const catalog = api.adapters.catalogSuite(source, 'scripts/check-shape.js', root, [PAGE])
    assert.ok(catalog.domain.includes(PAGE))
    assert.equal(catalog.unknownDomain, false)
  }],
  ['late-tuple', 'a tuple whose target follows its rewrite is a direct source edge', async (api) => {
    const source = `const FAULTS=[['a fault','alpha','BAD','${PAGE}',['checks']]]`
    const catalog = api.adapters.catalogSuite(source, 'scripts/check-shape.js', root, [PAGE])
    assert.ok(catalog.domain.includes(PAGE))
  }],
  ['multi-target', 'a rewrite with an explicit finite files list stays bounded even without a focused adapter', async (api) => {
    const source = `const FILES={page:'${PAGE}',other:'${OTHER}'};const FAULTS=[{files:['page','other'],rewrite:text=>text}];const {runSuite}=require('./lib/suite-runner');const variantsOf=()=>[{key:'head',head:true},{key:'fault:0',run:()=>checkFault(FAULTS[0])}]`
    const catalog = api.adapters.catalogSuite(source, 'scripts/check-shape.js', root, [PAGE, OTHER])
    assert.equal(catalog.unknownDomain, false)
    assert.notEqual(catalog.coverage, 'complete')
  }],
  ['literal-plants', 'literal patch, copy and group targets are recorded even outside named catalogs', async (api) => {
    for (const call of [`plantedPatch('${PAGE}','alpha','alpha','BAD')`, `plantedCopy('src','prefix','${PAGE}','alpha','BAD')`, `plantedGroup({'${PAGE}':'alpha'},[{file:'${PAGE}',find:'alpha',to:'BAD'}])`]) {
      const source = "const {plantedPatch,plantedCopy,plantedGroup}=require('./lib/mutant-source');" + call
      const catalog = api.adapters.catalogSuite(source, 'scripts/check-shape.js', root, [PAGE])
      assert.ok(catalog.domain.includes(PAGE), call)
      assert.ok(catalog.proof.anchorRecords > 0, call)
    }
  }],
  ['forwarded-loaders', 'finite callers, defaults and conditional module lists resolve without executing wrappers', async (api) => {
    const suite = 'scripts/check-forward.js'
    const source = "const {loadUtilities}=require('./lib/utilities');const names=['other'];const mount=(modules=names)=>loadUtilities(modules);mount();mount(unknownCondition?['other']:['hidden'])"
    const sources = { ...loaderSources, [suite]: source, [OTHER]: 'export default 1', 'src/renderer/utilities/hidden.js': 'export default 2' }
    const graph = api.lib.dependencyGraph(sources, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has(OTHER))
    assert.ok(graph.graph.get(suite).has('src/renderer/utilities/hidden.js'))
  }],
  ['computed-binding', 'a computed destructuring key is a read, not a shadowing declaration', async (api) => {
    const suite = 'scripts/check-computed-binding.js'
    const source = "const {loadUtilities}=require('./lib/utilities');const MODULE='other';const read=async()=>{const {[MODULE]:selected}=await loadUtilities([MODULE]);return selected}"
    const graph = api.lib.dependencyGraph({ ...loaderSources, [suite]: source, [OTHER]: 'export default 1' }, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has(OTHER))
  }],
  ['copied-source', 'a renamed temporary page retains the source read before its text transformations', async (api) => {
    const suite = 'scripts/check-copy.js'
    const source = `const fs=require('fs');const path=require('path');const {loadPage}=require('./lib/page-loader');const SOURCE=path.resolve(__dirname,'..','${PAGE}');const mount=()=>{const directory=process.env.TEMP;const original=fs.readFileSync(SOURCE,'utf8');const text=original.replace('alpha','beta');fs.writeFileSync(path.join(directory,'pages','Renamed.vue'),text);return loadPage('pages/Renamed',{directory})}`
    const graph = api.lib.dependencyGraph({ ...loaderSources, [suite]: source, [PAGE]: '<script>export default {}</script>' }, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has(PAGE))
  }],
  ['override-source', 'a source override keyed by a named component retains every matching repository origin', async (api) => {
    const suite = 'scripts/check-override.js'
    const source = "const {loadPage}=require('./lib/page-loader');const V='sample.vue';const mount=(sources)=>loadPage('pages/alias',{sources:{'pages/alias':loadable(sources[V])}})"
    const graph = api.lib.dependencyGraph({ ...loaderSources, [suite]: source, [PAGE]: '<script>export default {}</script>' }, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has(PAGE))
  }],
  ['virtual-source', 'in-memory loader fixtures are parsed and their real module imports are retained', async (api) => {
    const suite = 'scripts/check-virtual.js'
    const source = "const {loadUtilities}=require('./lib/utilities');loadUtilities(['inline'],{sources:{inline:\"import other from './other'; export default other\"}})"
    const graph = api.lib.dependencyGraph({ ...loaderSources, [suite]: source, [OTHER]: 'export default 1' }, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get('src/renderer/utilities/inline.js')?.has(OTHER))
  }],
  ['platform-imports', 'absolute checkout imports, Bun builtins and Vite raw imports resolve as their real source kinds', async (api) => {
    const suite = 'scripts/check-platform.js'
    const source = `require(${JSON.stringify(path.join(root, OTHER))});require('bun:sqlite');import other from '../src/renderer/utilities/other.js?raw'`
    const graph = api.lib.dependencyGraph({ [suite]: source, [OTHER]: 'export default 1' }, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has(OTHER))
  }],
  ['browser-subject', 'page-server checks execute mounted subjects and the app shell with eager store and plugin dependencies', async (api) => {
    const suite = 'scripts/check-browser-subject.js'
    const direct = 'scripts/check-shell-direct.js'
    const unrelated = 'scripts/check-shell-unrelated.js'
    const store = 'src/renderer/store/race.js'
    const plugin = 'src/renderer/utilities/plugin-state.js'
    const shell = {
      'src/renderer/index.html': '<script type="module" src="./main.js"></script>',
      'src/renderer/main.js': "import './app/store';import './app/router';import './plugins/database'",
      'src/renderer/app/store.js': "const modules=import.meta.glob('../store/*.js',{eager:true});export default modules",
      'src/renderer/app/router.js': "const routes=import.meta.glob('../pages/*.vue');export default routes",
      'src/renderer/store/index.js': 'export const state=()=>({})',
      [store]: 'export const state=()=>({race:1})',
      'src/renderer/plugins/database.js': "import value from '../utilities/plugin-state';export default value",
      [plugin]: 'export default 1',
      [PAGE]: '<script>export default {}</script>',
      'src/renderer/pages/unvisited.vue': '<script>export default {}</script>',
      'scripts/lib/page-server.js': '',
      [direct]: "require('../src/renderer/store/race');require('../src/renderer/utilities/plugin-state')",
      [unrelated]: 'module.exports=0',
    }
    for (const call of ["const {startPageServer}=require('./lib/page-server');startPageServer({})", "require('./lib/page-server').startPageServer({})"]) {
      const source = `const PAGE_FILE='${PAGE}';` + call
      const sources = { ...shell, [suite]: source }
      const graph = api.lib.dependencyGraph(sources, root)
      assert.deepEqual(graph.unresolved, [])
      assert.ok(graph.graph.get(suite).has(PAGE))
      assert.ok(graph.graph.get(suite).has('src/renderer/main.js'))
      assert.ok(graph.graph.get('src/renderer/app/store.js').has(store))
      assert.equal(graph.graph.get('src/renderer/app/router.js').has('src/renderer/pages/unvisited.vue'), false)
      for (const changed of [store, plugin]) {
        const value = await plan(api, sources, { changed: [changed], identity: { mode: 'working-tree' } })
        assert.deepEqual(value.selections.map((entry) => entry.suite), [suite, direct].sort())
        assert.deepEqual(value.widenings, [])
      }
      const unsupported = await plan(api, { ...sources, 'src/renderer/app/store.js': "const eager=choose();import.meta.glob('../store/*.js',{eager})" }, { changed: [store], identity: { mode: 'working-tree' } })
      assert.ok(selection(unsupported, suite).reasons.some((reason) => reason.reason.includes('Vite glob eagerness is unresolved')))
      const missing = await plan(api, { ...sources, 'src/renderer/index.html': '<script type="module">import "./main.js"</script>' }, { changed: [store], identity: { mode: 'working-tree' } })
      assert.ok(selection(missing, suite).reasons.some((reason) => reason.reason.includes('browser app entry script has no supported local source')))
      const foreign = await plan(api, { ...sources, [suite]: source.replace('({})', '({root:choose()})') }, { changed: [store], identity: { mode: 'working-tree' } })
      assert.ok(selection(foreign, suite).reasons.some((reason) => reason.reason.includes('browser app root override has no audited source domain')))
      const complex = await plan(api, { ...sources, 'src/renderer/app/store.js': "import.meta.glob('../store/**/*.js',{eager:true})" }, { changed: [store], identity: { mode: 'working-tree' } })
      assert.ok(selection(complex, suite).reasons.some((reason) => reason.reason.includes('eager Vite glob has no supported literal target domain')))
    }
  }],
  ['indirect-import', 'computed createRequire and module.require targets fail closed with a source line', async (api) => {
    const suite = 'scripts/check-indirect-import.js'
    for (const source of ["const {createRequire}=require('module');const local=createRequire(__filename);local(process.env.MODULE)", 'module.require(process.env.MODULE)', "const {createRequire:make}=require('module');const local=make(__filename);local(process.env.MODULE)"]) {
      const value = await plan(api, { ...inputs(), [suite]: source }, { changed: [OTHER], identity: { mode: 'working-tree' } })
      assert.ok(selection(value, suite)?.reasons.some((reason) => reason.line && reason.reason.includes('computed import')))
    }
  }],
  ['iterated-loader', 'a destructured finite iteration domain resolves forwarded page names', async (api) => {
    const suite = 'scripts/check-iteration.js'
    const source = "const {loadPage}=require('./lib/page-loader');const load=name=>loadPage(name);for(const [id,name] of [['sample','pages/sample']]){load(name)}"
    const graph = api.lib.dependencyGraph({ ...loaderSources, [suite]: source, [PAGE]: '<script>export default {}</script>' }, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has(PAGE))
    const shadowed = "const {loadPage}=require('./lib/page-loader');const name='pages/wrong';for(const name of ['pages/sample']){loadPage(name)}"
    const shadowGraph = api.lib.dependencyGraph({ ...loaderSources, [suite]: shadowed, [PAGE]: '<script>export default {}</script>' }, root)
    assert.equal(shadowGraph.unresolved.length, 0)
    assert.ok(shadowGraph.graph.get(suite).has(PAGE))
  }],
  ['loader-aliases', 'member-extracted, inline and ESM-aliased loaders keep their literal module edges', async (api) => {
    const suite = 'scripts/check-loader-alias.js'
    for (const source of ["const read=require('./lib/utilities').loadUtilities;read(['other'])", "require('./lib/utilities').loadUtilities(['other'])", "import {loadUtilities as read} from './lib/utilities.js';read(['other'])"]) {
      const graph = api.lib.dependencyGraph({ ...loaderSources, [suite]: source, [OTHER]: 'export default 1' }, root)
      assert.ok(graph.graph.get(suite).has(OTHER), source)
    }
    const hidden = 'src/renderer/utilities/hidden.js'
    const direct = 'scripts/check-loader-direct.js'
    const unrelated = 'scripts/check-loader-unrelated.js'
    for (const source of ["const {loadUtilities:load}=require('./lib/utilities');const alias=load;alias(['hidden'])", "const {loadUtilities:load}=require('./lib/utilities');const first=load;const alias=first;alias(['hidden'])"]) {
      const sources = { ...loaderSources, [suite]: source, [direct]: "require('../src/renderer/utilities/hidden')", [unrelated]: "const {loadUtilities}=require('./lib/utilities');loadUtilities(['other'])", [hidden]: 'export default 1', [OTHER]: 'export default 2' }
      const graph = api.lib.dependencyGraph(sources, root)
      assert.ok(graph.graph.get(suite).has(hidden), source)
      const value = await plan(api, sources, { changed: [hidden], identity: { mode: 'working-tree' } })
      assert.deepEqual(value.selections.map((entry) => entry.suite), [direct, suite].sort(), source)
      assert.deepEqual(value.widenings, [], source)
    }
  }],
  ['require-suffix', 'a computed require with a literal path suffix retains every possible repository target', async (api) => {
    const suite = 'scripts/check-require-suffix.js'
    const source = "const path=require('path');const {createRequire}=require('module');const read=createRequire(__filename);const run=base=>{const file=path.join(base,'scripts','lib','target.js');return read(file)}"
    const target = 'scripts/lib/target.js'
    const graph = api.lib.dependencyGraph({ [suite]: source, [target]: 'module.exports=1' }, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has(target))
    assert.ok(graph.contracts.some((entry) => entry.reason.includes('literal suffix')))
    const extensionless = api.lib.dependencyGraph({ [suite]: source.replace("'target.js'", "'target'"), [target]: 'module.exports=1' }, root)
    assert.equal(extensionless.unresolved.length, 0)
    assert.ok(extensionless.graph.get(suite).has(target))
  }],
  ['catalog-reuse', 'unchanged catalogs sharing a union target list are discovered once when files are added', async (api) => {
    const original = api.adapters.catalogSuite
    let calls = 0
    try {
      api.adapters.catalogSuite = (...args) => { calls++; return original(...args) }
      await plan(api, { ...inputs(), 'scripts/lib/added.js': 'module.exports=1' }, { baseline: inputs() })
      assert.equal(calls, 1)
    } finally { api.adapters.catalogSuite = original }
  }],
  ['named-fixtures', 'named saves with spaces and the root database are direct terminal dependencies', async (api) => {
    const suite = 'scripts/check-fixture.js'
    const save = 'saves/Aurora copy.db'
    const source = `const SAVE='${save}';const DEFAULT='AuroraDB.db'`
    for (const changed of [save, 'AuroraDB.db']) {
      const result = await plan(api, { ...inputs(), [suite]: source }, { changed: [changed], identity: { mode: 'working-tree' } })
      assert.ok(selection(result, suite), changed)
    }
  }],
  ['shared-output', 'a shared helper change explicitly recommends the sweep even below whole-suite coverage', async (api) => {
    const helper = 'scripts/lib/shared-output.js'
    const sources = { [helper]: 'module.exports=1' }
    for (let index = 0; index < 8; index++) sources[`scripts/check-shared-${index}.js`] = index < 4 ? "require('./lib/shared-output')" : 'module.exports=1'
    const value = await plan(api, sources, { changed: [helper], identity: { mode: 'working-tree' } })
    assert.equal(value.selections.length, 4)
    const logged = []
    const previous = console.log
    try { console.log = (text) => logged.push(text); api.cli.printPlan(value) } finally { console.log = previous }
    const printed = JSON.parse(logged.join(''))
    assert.ok(printed.sweep?.includes('4 of 8 scripts'))
    assert.equal(printed.suggestedFast, 'bun run check:quick')
    assert.equal(printed.preferredMode, 'deep (shared check infrastructure)')
  }],
  ['audited-versions', 'audited versions remain exact and page-loader forwarding rejects unknown source hashes', async (api) => {
    const contract = { sha256: [api.lib.hash('first'), api.lib.hash('second')] }
    assert.equal(api.lib.importContractMatches(contract, 'first'), true)
    assert.equal(api.lib.importContractMatches(contract, 'second'), true)
    assert.equal(api.lib.importContractMatches(contract, 'changed'), false)
    assert.equal(api.lib.importContractMatches(undefined, 'first'), false)
    const file = 'scripts/lib/page-loader.js'
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    const uncertain = (source) => api.lib.dependencyGraph({ [file]: source }, root, api.lib.repoFiles(root)).unresolved
    assert.deepEqual(uncertain(text), [])
    assert.ok(uncertain(text + '\n// unknown loader revision\n').length > 0)
  }],
  ['multi-loader', 'the imported multi-module API is distinct from a local wrapper of the same name', async (api) => {
    const suite = 'scripts/check-multi-loader.js'
    const sources = { ...loaderSources, [PAGE]: '<script>export default {}</script>', [OTHER]: 'export default 1' }
    const imported = "const {loadModules:load}=require('./lib/page-loader');load(['pages/sample','utilities/other'])"
    const graph = api.lib.dependencyGraph({ ...sources, [suite]: imported }, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has(PAGE))
    assert.ok(graph.graph.get(suite).has(OTHER))
    const local = "const {loadUtilities}=require('./lib/utilities');const loadModules=sources=>loadUtilities(['other'],{sources});loadModules({})"
    const localGraph = api.lib.dependencyGraph({ ...sources, [suite]: local }, root)
    assert.equal(localGraph.unresolved.length, 0)
    assert.ok(localGraph.graph.get(suite).has(OTHER))
    assert.ok(api.lib.dependencyGraph({ ...sources, [suite]: imported.replace("['pages/sample','utilities/other']", "'pages/sample'") }, root).unresolved.length > 0)
  }],
  ['conditional-loader', 'nested conditional lists and Set spreads retain every finite branch through initializers', async (api) => {
    const suite = 'scripts/check-conditional-loader.js'
    const hidden = 'src/renderer/utilities/hidden.js'
    const source = "const {loadUtilities}=require('./lib/utilities');const run=()=>{const names=[...new Set(['other',...(process.env.EXTRA?['hidden']:[])])];return loadUtilities(names)};run()"
    const graph = api.lib.dependencyGraph({ ...loaderSources, [suite]: source, [OTHER]: 'export default 1', [hidden]: 'export default 2' }, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has(OTHER))
    assert.ok(graph.graph.get(suite).has(hidden))
    assert.deepEqual(api.lib.declarations("const names=[...new Set(['other','other'])]").valueOf('names'), ['other'])
  }],
  ['encoded-source', 'a verified data-URL encoder retains its source origin but opaque encoders stay uncertain', async (api) => {
    const suite = 'scripts/check-encoded-source.js'
    const encoder = 'text=>`data:text/javascript;base64,' + '$' + "{Buffer.from(text).toString('base64')}`"
    const source = "const fs=require('fs');const encode=" + encoder + ';const source=fs.readFileSync(' + JSON.stringify(path.join(root, OTHER)) + ",'utf8');import(encode(source))"
    const graph = api.lib.dependencyGraph({ [suite]: source, [OTHER]: 'export default 1' }, root)
    assert.equal(graph.unresolved.length, 0)
    const joined = "const path=require('path');const run=base=>{" + source.replace(JSON.stringify(path.join(root, OTHER)), "path.join(base,'src','renderer','utilities','other.js')") + '}'
    const joinedGraph = api.lib.dependencyGraph({ [suite]: joined, [OTHER]: 'export default 1' }, root)
    assert.equal(joinedGraph.unresolved.length, 0)
    assert.ok(joinedGraph.graph.get(suite).has(OTHER))
    assert.ok(graph.graph.get(suite).has(OTHER))
    for (const opaque of ['text=>process.env.MODULE', 'text=>`data:text/javascript;base64,`']) {
      assert.ok(api.lib.dependencyGraph({ [suite]: source.replace(encoder, opaque), [OTHER]: 'export default 1' }, root).unresolved.length > 0)
    }
    const rewritten = source.replace(';import(', ".replace('export default 1', \"import './hidden'; export default 1\");import(")
    assert.ok(api.lib.dependencyGraph({ [suite]: rewritten, [OTHER]: 'export default 1', 'src/renderer/utilities/hidden.js': 'export default 2' }, root).unresolved.length > 0)
    const mutable = source.replace('const source=', 'let source=').replace(';import(', ';({source}={source:"import \\\'./hidden\\\'"});import(')
    assert.ok(api.lib.dependencyGraph({ [suite]: mutable, [OTHER]: 'export default 1', 'src/renderer/utilities/hidden.js': 'export default 2' }, root).unresolved.length > 0)
  }],
  ['package-callers', 'finite package-resolution callers select dependency metadata while opaque callers widen', async (api) => {
    const suite = 'scripts/check-package-callers.js'
    const source = "const resolve=specifier=>require.resolve(specifier);resolve('vue');resolve('@scope/package')"
    const sources = { [suite]: source, 'package.json': '{}', 'bun.lock': '{}' }
    const graph = api.lib.dependencyGraph(sources, root)
    assert.equal(graph.unresolved.length, 0)
    assert.ok(graph.graph.get(suite).has('package.json'))
    assert.ok(graph.graph.get(suite).has('bun.lock'))
    assert.ok(api.lib.dependencyGraph({ ...sources, [suite]: source + ';resolve(process.env.PACKAGE)' }, root).unresolved.length > 0)
  }],
  ['vm-callback-contract', 'an audited VM closure retains every module edge and unknown callback programs widen', async (api) => {
    const source = 'const callback=name=>localRequire(name)'
    const targets = ['scripts/lib/suite-runner.js', 'scripts/lib/suite-runner-fixture.js', 'scripts/lib/check-pool.js', 'scripts/lib/browser-observe.js']
    const contract = { sha256: [api.lib.hash(source)], expressions: { name: targets } }
    assert.deepEqual(api.lib.auditedImportTargets(contract, source, 'name'), targets)
    assert.equal(api.lib.auditedImportTargets(contract, source + ';unknown()', 'name'), null)
    assert.equal(api.lib.auditedImportTargets(contract, source, 'another'), null)
    const file = 'scripts/check-suite-runner.js'
    const code = "const {createRequire}=require('module');const localRequire=createRequire(__filename);const callback=name=>localRequire(name)"
    const sources = { [file]: code, ...Object.fromEntries(targets.map((target) => [target, 'module.exports={}'])) }
    const graph = api.lib.dependencyGraph(sources, root)
    assert.ok(graph.unresolved.some((issue) => issue.expression === 'localRequire(name)'))
  }],
  ['sink-irrelevance', 'opaque runtime bindings without a sink path are explained without selecting their suite', async (api) => {
    const source = "const names=['other'];const scratch=read();scratch.count=1;const method=scratch.run;method(scratch);loadUtilities(names,{stubs:scratch})"
    const value = await sinkPlan(api, source)
    assert.deepEqual(value.selections.map((entry) => entry.suite), [SINK_DIRECT])
    assert.ok(value.analysedBindings.some((entry) => entry.file === SINK_SUITE && entry.binding === 'scratch' && entry.reason.includes('no value path')))
    assert.ok(!value.analysedBindings.some((entry) => entry.file === SINK_SUITE && entry.binding === 'loadUtilities'))
    const changed = await sinkPlan(api, source + ';const unused=anotherRead()', { baseline: sinkInputs(source) })
    assert.ok(changed.analysedBindings.some((entry) => entry.file === SINK_SUITE && entry.binding === 'scratch' && entry.baseline))
    const logged = []
    const previous = console.log
    try { console.log = (text) => logged.push(text); api.cli.printPlan(changed) } finally { console.log = previous }
    assert.ok(JSON.parse(logged.join('')).analysedBindings.some((entry) => entry.binding === 'scratch' && entry.reason.includes('analysed-but-irrelevant')))
    const resolvedPath = "const path=require('path');const base=path.join(__dirname,'..');require(path.join(base,'src','renderer','utilities','other.js'));const scratch=read(base);scratch.count=1"
    assert.deepEqual((await sinkPlan(api, resolvedPath)).selections.map((entry) => entry.suite), [SINK_DIRECT])
  }],
  ['sink-fields', 'a statically chosen local module-name field does not taint neighbouring runtime fields', async (api) => {
    const source = "function run(){const scratch=read();scratch.count=1;const box={names:['other'],runtime:scratch};loadUtilities(box.names)}run()"
    const value = await sinkPlan(api, source)
    assert.deepEqual(value.selections.map((entry) => entry.suite), [SINK_DIRECT])
    assert.ok(value.analysedBindings.some((entry) => entry.file === SINK_SUITE && entry.binding === 'scratch'))
    const mutated = "function run(){const box={names:['other']};const alias=box.names;alias.push('sink-hidden');loadUtilities(box.names)}run()"
    assert.ok(selection(await sinkPlan(api, mutated), SINK_SUITE)?.reasons.some((entry) => entry.reason.includes('widening to complete suite')))
    const primitive = "const name='other';const scratch=read(name);scratch.count=1;loadUtilities([name])"
    assert.deepEqual((await sinkPlan(api, primitive)).selections.map((entry) => entry.suite), [SINK_DIRECT])
  }],
  ['sink-returns', 'returned identities and constructor returns keep opaque mutated module-name aliases tainted', async (api) => {
    for (const choose of ["const choose=()=>names;const alias=choose()", "function choose(){return names}const alias=choose()", "class Carrier{constructor(){return names}}const alias=new Carrier()", "class Carrier{constructor(value){return value}}const alias=new Carrier(names)"]) {
      const value = await sinkPlan(api, "const names=['other'];" + choose + ";alias.push('sink-hidden');loadUtilities(names)")
      assert.deepEqual(value.selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort(), choose)
      assert.ok(selection(value, SINK_SUITE).reasons.some((entry) => entry.expression?.includes('unresolved mutable alias alias')), choose)
      assert.ok(!value.analysedBindings.some((entry) => entry.file === SINK_SUITE && entry.binding === 'alias'), choose)
    }
    const sliced = "const names=['other'];const choose=()=>names;const alias=choose();alias.push('sink-hidden');loadUtilities(names.slice())"
    assert.deepEqual((await sinkPlan(api, sliced)).selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort())
    const native = "const path=require('path');const choose=()=>path;const alias=choose();alias.join=()=> '../src/renderer/utilities/sink-hidden';require(path.join(__dirname,'..','src','renderer','utilities','other.js'))"
    assert.ok(selection(await sinkPlan(api, native), SINK_SUITE)?.reasons.some((entry) => entry.expression?.includes('unresolved mutable alias alias')))
    const constructor = "const add=Set.prototype.add;const choose=()=>Set;const alias=choose();alias.prototype.add=function(value){return add.call(this,'sink-hidden')};loadUtilities([...new Set(['other'])])"
    assert.ok(selection(await sinkPlan(api, constructor), SINK_SUITE)?.reasons.some((entry) => entry.expression?.includes('unresolved mutable alias alias')))
  }],
  ['sink-forwarding', 'visible parameter forwarding retains writes to dependency-tainted arrays and objects', async (api) => {
    for (const change of ["value.push('sink-hidden')", "Object.assign(value,{0:'sink-hidden'})"]) {
      const value = await sinkPlan(api, "const names=['other'];const change=value=>{" + change + "};change(names);loadUtilities(names)")
      assert.deepEqual(value.selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort(), change)
      assert.ok(selection(value, SINK_SUITE).reasons.some((entry) => entry.expression?.includes('dependency-tainted binding can be mutated: value')), change)
    }
    const rest = "const names=['other'];const change=(...values)=>values[0].push('sink-hidden');change(names);loadUtilities(names)"
    assert.deepEqual((await sinkPlan(api, rest)).selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort())
  }],
  ['sink-escapes', 'unknown calls and computed methods cannot silently consume dependency-tainted values', async (api) => {
    for (const consume of ['consume(names)', 'names.forEach(external)', 'Object[process.env.METHOD](names)', "const Object={keys:value=>consume(value)};Object.keys(names)"]) {
      const value = await sinkPlan(api, "const names=['other'];" + consume + ';loadUtilities(names)')
      assert.deepEqual(value.selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort(), consume)
      assert.ok(selection(value, SINK_SUITE).reasons.some((entry) => entry.expression?.includes('escapes to an unresolved call')), consume)
    }
    const field = "function run(){const box={names:['other']};consume(box.names);loadUtilities(box.names)}run()"
    assert.ok(selection(await sinkPlan(api, field), SINK_SUITE)?.reasons.some((entry) => entry.expression?.includes('stored value')))
    const inert = "const names=['other'];Object.keys(names);loadUtilities(names)"
    assert.deepEqual((await sinkPlan(api, inert)).selections.map((entry) => entry.suite), [SINK_DIRECT])
  }],
  ['sink-known-values', 'known fields, immutable caller values and returned modules do not taint unrelated state', async (api) => {
    const sources = [
      "const MODULE='other';async function run(){const {[MODULE]:runtime}=await loadUtilities([MODULE]);runtime.count=1}run()",
      "const scratch=read();scratch.count=1;const choose=runtime=>({names:['other'],runtime});loadUtilities(choose(scratch).names)",
      "const pick=name=>({name,audit:inspect(name)});loadUtilities([pick('other').name])",
      "const path=require('path');const base=path.join(__dirname,'..');require(path.join(base,'src','renderer','utilities','other.js'));consume(path.sep)",
      "const path=require('path');const scratch=read();scratch.count=1;const inRenderer=(ignored,...parts)=>path.join(...parts);require(inRenderer(scratch,__dirname,'..','src','renderer','utilities','other.js'))",
      "const names=['other'];consume(...names);loadUtilities(names)",
    ]
    for (const source of sources) assert.deepEqual((await sinkPlan(api, source)).selections.map((entry) => entry.suite), [SINK_DIRECT], source)
  }],
  ['sink-callbacks', 'visible native array callbacks keep scalar elements separate and guard the shared array argument', async (api) => {
    for (const source of [
      "const names=['other'];loadUtilities(names.map(name=>name))",
      "const names=['other'];names.forEach((name,index,all)=>inspect(name,index));loadUtilities(names)",
      "const names=['other'];const keep=name=>name;loadUtilities(names.map(keep));consume(keep)",
      "const names=['other'];loadUtilities(names.map((name,index)=>({name:index?name:name,audit:inspect(index)}).name))",
    ]) assert.deepEqual((await sinkPlan(api, source)).selections.map((entry) => entry.suite), [SINK_DIRECT], source)
    for (const call of [
      "names.forEach((name,index,all)=>all.push('sink-hidden'))",
      'names.forEach((name,index,all)=>consume(all))',
      "names.forEach(function(){this.push('sink-hidden')},names)",
      "names.forEach((...args)=>args[2].push('sink-hidden'))",
      "names.forEach(()=>eval(\"names.push('sink-hidden')\"))",
    ]) assert.deepEqual((await sinkPlan(api, "const names=['other'];" + call + ';loadUtilities(names)')).selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort(), call)
  }],
  ['sink-contained-escapes', 'containers, returned closures and external stores cannot hide mutable dependency names', async (api) => {
    for (const call of ['consume({nested:names})', 'const holder={nested:names};consume(holder)', 'consume(()=>names)', 'new Foreign(names)', 'globalThis.saved=names']) {
      const value = await sinkPlan(api, "const names=['other'];" + call + ';loadUtilities(names)')
      assert.deepEqual(value.selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort(), call)
      assert.ok(selection(value, SINK_SUITE).reasons.some((entry) => entry.expression?.includes('escapes')), call)
    }
  }],
  ['sink-containment', 'fresh native results contain returned values, not their source containers or scalar derivations', async (api) => {
    const prefix = "const names=['other'];const loaded=loadUtilities(names);"
    for (const operation of [
      'consume(names.map(name=>loaded[name]))',
      'consume(Object.fromEntries(names.map(name=>[name,loaded[name]])))',
      'consume({[names]:loaded.other})',
      'consume(loaded[names[0]])',
      'const cache={};consume(cache[names]=loaded.other)',
      'consume(names?loaded.other:loaded.other)',
      'consume((names,loaded.other))',
      'consume(JSON.stringify(names))',
      'consume(JSON.stringify(names,null,2))',
      "consume(names.join(','))",
      'consume(names.length)',
      'consume(names.flatMap(name=>[loaded[name]]))',
      'consume(names.flatMap(()=>names))',
      'consume(names.some(()=>names))',
      'consume(names.every(()=>names))',
      'consume(names.findIndex(()=>names))',
      'consume(names.forEach(()=>names))',
    ]) assert.deepEqual((await sinkPlan(api, prefix + operation)).selections.map((entry) => entry.suite), [SINK_DIRECT], operation)
    const copied = "const entries=[['other',0]];const copied=Object.fromEntries(entries);copied.count=1;loadUtilities(entries.map(entry=>entry[0]))"
    assert.deepEqual((await sinkPlan(api, copied)).selections.map((entry) => entry.suite), [SINK_DIRECT])
    for (const source of [
      "const NAMES=['other'];async function run(){const pageModules=await loadUtilities([...NAMES.map(name=>name)]);const loaded=Object.fromEntries(NAMES.map(name=>[name,pageModules[name]]));consume({module:loaded.other})}run()",
      "async function load(){const names=['other'].map(name=>name);const loaded=await loadUtilities(names);return {module:loaded[names[0]]}}async function run(){const runtime=await load();runtime.count=1;consume(runtime)}run()",
    ]) assert.deepEqual((await sinkPlan(api, source)).selections.map((entry) => entry.suite), [SINK_DIRECT], source)
    for (const operation of [
      'consume(names.map(()=>names))',
      "consume(Object.fromEntries(names.map(name=>[name,names])))",
      'consume(names.flatMap(()=>[names]))',
      "const groups=[names];consume(groups.filter(()=>true))",
      "const groups=[names];consume(groups.find(()=>true))",
      'consume(JSON.stringify(names,external))',
      'const JSON={stringify:()=>names};consume(JSON.stringify())',
      'const custom={join:()=>names};consume(custom.join())',
      'const custom={length:names};consume(custom.length)',
      "names.map(()=>names)[0].push('sink-hidden')",
    ]) assert.deepEqual((await sinkPlan(api, prefix + operation)).selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort(), operation)
    const assigned = await sinkPlan(api, prefix + 'const cache={};consume(cache.value=names)')
    assert.ok(selection(assigned, SINK_SUITE)?.reasons.some((entry) => entry.expression?.includes('escapes to an unresolved call')), 'the assigned right-hand value reaches the opaque consumer')
    for (const source of [
      "const FILES={other:1};const choose=()=>Object;const alias=choose();alias.keys=()=>['sink-hidden'];loadUtilities(Object.keys(FILES))",
      "const names=['other'];const choose=()=>Array;const alias=choose();alias.prototype.map=()=>['sink-hidden'];loadUtilities(names.map(name=>name))",
    ]) assert.ok(selection(await sinkPlan(api, source), SINK_SUITE)?.reasons.some((entry) => entry.expression?.includes('unresolved mutable alias alias')), source)
  }],
  ['sink-path-factories', 'an inert native path factory isolates its parameters without trusting writes or a shadowed namespace', async (api) => {
    const prefix = "const path=require('path');function runtime(){const parts=read();parts.push('runtime')};"
    const factory = "const inRenderer=(...parts)=>path.join(...parts);const FILES={other:inRenderer('src','renderer','utilities','other.js')};const FAULTS=[{file:'other',find:'gamma',replace:'BAD'}]"
    const source = prefix + factory
    const declarations = api.lib.declarations(source, SINK_SUITE, root)
    assert.ok(declarations.mutableNames.has('parts'))
    assert.equal(typeof declarations.valueOf('FILES').other, 'string')
    assert.equal(api.lib.normalize(declarations.valueOf('FILES').other), OTHER)
    const catalog = api.adapters.catalogSuite(source, SINK_SUITE, root, [OTHER])
    assert.ok(catalog.domain.includes(OTHER))
    assert.equal(catalog.unknownDomain, false)
    for (const unsafe of [source.replace('path.join(...parts)', "{parts.push('changed');return path.join(...parts)}"), source.replace("require('path')", "{join:()=> 'not the native namespace'}")]) {
      assert.ok(api.lib.isUnknown(api.lib.declarations(unsafe, SINK_SUITE, root).valueOf('FILES').other))
    }
  }],
  ['sink-bounds', 'over-bound callable provenance widens instead of declaring a hidden return irrelevant', async (api) => {
    const chain = Array.from({ length: 70 }, (_, index) => `const fn${index}=${index ? 'fn' + (index - 1) : 'choose'};`).join('')
    const source = "const names=['other'];const choose=()=>names;" + chain + "const alias=fn69();alias.push('sink-hidden');loadUtilities(names)"
    const value = await sinkPlan(api, source)
    assert.deepEqual(value.selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort())
    assert.ok(selection(value, SINK_SUITE).reasons.some((entry) => entry.expression?.includes('provenance expansion exceeded its bound')))
    assert.ok(!value.analysedBindings.some((entry) => entry.file === SINK_SUITE && entry.binding === 'alias'))
  }],
  ['sink-counterexamples', 'computed require members, shared module storage, callback escape and unknown VM programs still widen', async (api) => {
    const target = '../src/renderer/utilities/sink-hidden'
    for (const source of [`require[process.env.METHOD]('${target}')`, `const box={name:'fs'};function store(){box.name='${target}'}function load(){require(box.name)}store();load()`, "const {createRequire}=require('module');const localRequire=createRequire(__filename);consume(localRequire)"]) {
      const value = await sinkPlan(api, source)
      assert.deepEqual(value.selections.map((entry) => entry.suite), [SINK_DIRECT, SINK_SUITE].sort(), source)
      assert.ok(selection(value, SINK_SUITE).reasons.some((entry) => entry.reason.includes('widening to complete suite')), source)
    }
    const file = 'scripts/check-suite-runner.js'
    const sources = { ...sinkInputs(''), [file]: "const {createRequire}=require('module');const localRequire=createRequire(__filename);const callback=name=>localRequire(name)" }
    const value = await plan(api, sources, { changed: [SINK_HIDDEN], identity: { mode: 'working-tree' } })
    assert.deepEqual(value.selections.map((entry) => entry.suite), [SINK_DIRECT, file].sort())
    assert.ok(selection(value, file).reasons.some((entry) => entry.expression === 'localRequire(name)'))
  }],
]

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'variant ingestion bypasses descriptor accounting', file: 'adapters', from: 'if (family) for (const { value, location } of ingestions) audit(value, location)', to: "if (family) for (const { value, location } of ingestions) if (!location.startsWith('variant:')) audit(value, location)", check: 'ingestion' },
  { name: 'composite inference erases harvested inline descriptors', file: 'adapters', from: 'if (/composite|together|stacked|all$/.test(variant.key)) edits.push(', to: 'if (/composite|together|stacked|all$/.test(variant.key)) edits.splice(0, edits.length, ', check: 'ingestion' },
  { name: 'unknown descriptor fields are presumed inert', file: 'adapters', from: 'descriptorIssues.add(', to: 'void (', check: 'opaque-rewrites' },
  { name: 'computed import uncertainty is only diagnostic', file: 'library', from: 'const importUncertainty = importIssues.length > 0 && paths.length > 0', to: 'const importUncertainty = false', check: 'computed-dependencies' },
  { name: 'repeated execution names stand in for missing variants', file: 'cli', from: 'observed.filter((one) => one === name).length !== 1', to: 'false', check: 'raw' },
  { name: 'export-star dependency edges disappear', file: 'library', from: "node.type?.startsWith('Export')", to: "node.type === 'ExportNamedDeclaration'", check: 'computed-dependencies' },
  { name: 'partial code0 summaries approve completion', file: 'cli', from: 'completed[1] !== completed[2]', to: 'false', check: 'raw' },
  { name: 'generated array entries remain nested', file: 'library', from: 'transformed.flat()', to: 'transformed', check: 'catalog' },
  { name: 'composed faults forget the benign anchors', file: 'adapters', from: 'add(`composed:${index}`, [...combined, fault], { timingWitness:', to: 'add(`composed:${index}`, fault, { timingWitness:', check: 'aggregate' },
  { name: 'stale cardinality is accepted', file: 'library', from: 'checked.count !== anchor.count', to: 'false', check: 'cardinality' },
  { name: 'an unresolved catalog is accepted', file: 'library', from: 'if (!iteration && catalogUncertainty) blockers.push(', to: 'if (false) blockers.push(', check: 'unknown' },
  { name: 'the baseline catalog is discarded', file: 'library', from: 'catalogs: current === before ? [current].filter(Boolean) : [current, before].filter(Boolean)', to: 'catalogs: [current].filter(Boolean)', check: 'union' },
  { name: 'logical file aliases are ignored', file: 'adapters', from: 'if (ownMap(value) && !seen.has(value)) {', to: 'if (false) {', check: 'alias' },
  { name: 'transitive helper changes are ignored', file: 'library', from: 'const helper = reachesChanged(suite)', to: 'const helper = false', check: 'dependencies' },
  { name: 'part selection uses an unsupported equals argument', file: 'adapters', from: "args: ['--part', key]", to: 'args: [`--part=${key}`]', check: 'selectors' },
  { name: 'missing variant witnesses count as success', file: 'library', from: 'command.keys.some((key) => !record.keys.includes(key))', to: 'false', check: 'evidence' },
  { name: 'the real catalog drops composed execution paths', file: 'adapters', from: 'if (composed.set.includes(index)) add', to: 'if (false) add', check: 'actual' },
  { name: 'supervised results may predate the plan', file: 'cli', from: 'Date.parse(status.started) >= Date.parse(plan.createdAt)', to: 'true', check: 'raw' },
  { name: 'full fallback can report only the head count', file: 'cli', from: 'full.checks !== head.checks + selection.expectedExtra', to: 'false', check: 'raw' },
  { name: 'unobserved input presence is assumed absent', file: 'library', from: "unknown('existence outside the source snapshot', node)", to: 'false', check: 'unknown' },
  { name: 'zero regex matches satisfy a first match', file: 'library', from: 'anchor.first ? checked.count < 1 : checked.count !== anchor.count', to: 'false', check: 'historical' },
  { name: 'descriptor targets execute their own imports', file: 'library', from: 'const helper = reachesChanged(suite)', to: 'const helper = reachesChanged(suite) || catalogs.some(catalog => catalog.domain.some(file => reachesChanged(file)))', check: 'terminal-edges' },
  { name: 'named loader calls are ignored', file: 'library', from: 'if (!loader) return', to: 'if (true) return', check: 'loader-edges' },
  { name: 'unmapped sources silently select nothing', file: 'library', from: '|| widenings.length > 0)', to: ')', check: 'fail-closed-loop' },
  { name: 'fast mode runs the deep variants instead', file: 'library', from: "iteration && identity.depth !== 'deep' ? fastCommands : deepCommands", to: 'false ? fastCommands : deepCommands', check: 'loop-modes' },
  { name: 'implicit descriptor sources disappear', file: 'adapters', from: 'if (value === null || value === undefined) return [...implicitTargets]', to: 'if (value === null || value === undefined) return []', check: 'implicit-source' },
  { name: 'FILE aliases are ignored', file: 'adapters', from: "data.bindings.has('FILES') ? get('FILES') : get('FILE')", to: "get('FILES')", check: 'file-map' },
  { name: 'late tuple targets disappear', file: 'adapters', from: 'return targets(entry[3]).map((file) => ({ file, from: entry[1], count: 1 }))', to: 'return []', check: 'late-tuple' },
  { name: 'finite multi-file targets are unbounded', file: 'adapters', from: "if (Array.isArray(value)) return value.every((entry) => typeof entry === 'string' && targets(entry).length) ? [...new Set(value.flatMap((entry) => targets(entry)))] : []", to: 'if (Array.isArray(value)) return []', check: 'multi-target' },
  { name: 'literal plant anchors disappear', file: 'adapters', from: 'const allAnchors = [...directPlantAnchors,', to: 'const allAnchors = [', check: 'literal-plants' },
  { name: 'planted-copy target uses its directory argument', file: 'adapters', from: "kind === 'plantedCopy' ? 2 : 0", to: "kind === 'plantedCopy' ? 0 : 0", check: 'literal-plants' },
  { name: 'finite wrapper callers stay unresolved', file: 'library', from: 'return resolved ? environments.map(', to: 'return false ? environments.map(', check: 'forwarded-loaders' },
  { name: 'conditional loader domains use only one branch', file: 'library', from: '...possibleValues(expression.alternate, at, active)', to: '...[]', check: 'forwarded-loaders' },
  { name: 'computed keys become local bindings', file: 'library', from: 'pattern.properties.forEach((entry) => take(entry.value || entry.argument))', to: 'pattern.properties.forEach((entry) => { take(entry.key); take(entry.value || entry.argument) })', check: 'computed-binding' },
  { name: 'copied page lineage disappears', file: 'library', from: '...copiedOrigins(relativeName)', to: '...[]', check: 'copied-source' },
  { name: 'override basename origins disappear', file: 'library', from: "return knownFiles.filter((candidate) => candidate.endsWith('/' + relative))", to: 'return []', check: 'override-source' },
  { name: 'virtual fixture import graphs disappear', file: 'library', from: 'for (const [target, dependencies] of generated.graph)', to: 'for (const [target, dependencies] of [])', check: 'virtual-source' },
  { name: 'Vite raw suffixes become missing files', file: 'library', from: "value.replace(/\\?(?:raw|url)$/, '')", to: 'value', check: 'platform-imports' },
  { name: 'Bun builtin imports become URLs', file: 'library', from: '/^(?:node|bun):/.test(value)', to: '/^node:/.test(value)', check: 'platform-imports' },
  { name: 'browser-mounted subjects become terminal reads', file: 'library', from: 'if (pageServerCaller && (', to: 'if (false && (', check: 'browser-subject' },
  { name: 'createRequire aliases hide imports', file: 'library', from: "if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'CallExpression' && (requireFactories.has(node.init.callee.name) || node.init.callee.property?.name === 'createRequire')) indirectRequires.add(node.id.name)", to: 'if (false) indirectRequires.add(node.id.name)', check: 'indirect-import' },
  { name: 'finite destructured iteration domains disappear', file: 'library', from: 'if (loopValues.length) {', to: 'if (false) {', check: 'iterated-loader' },
  { name: 'extracted loader members lose their names', file: 'library', from: 'loaderAliases.set(node.id.name, node.init.property.name)', to: 'void(node.id.name)', check: 'loader-aliases' },
  { name: 'inline loader members hide module targets', file: 'library', from: 'loaderNamespaces.has(node.callee.object.name) || LOADERS.has(node.callee.property.name)', to: 'loaderNamespaces.has(node.callee.object.name)', check: 'loader-aliases' },
  { name: 'ESM loader aliases lose module targets', file: 'library', from: 'loaderAliases.set(member.local.name, member.imported.name)', to: 'void(member.local.name)', check: 'loader-aliases' },
  { name: 'aliased createRequire factories hide computed imports', file: 'library', from: 'requireFactories.add(member.value.name)', to: 'void(member.value.name)', check: 'indirect-import' },
  { name: 'literal suffix import domains disappear', file: 'library', from: 'const suffixTargets = typeof value', to: 'const suffixTargets = true ? [] : typeof value', check: 'require-suffix' },
  { name: 'unchanged catalogs are needlessly rediscovered on additions', file: 'library', from: 'Object.keys(baseline).every((file) => own(sources, file))', to: 'false', check: 'catalog-reuse' },
  { name: 'copy destination indexing drops its source records', file: 'library', from: 'copiedSources.push({ tail, call: node })', to: 'void({ tail, call: node })', check: 'copied-source' },
  { name: 'local initializer indexing drops named records', file: 'library', from: 'variablesByName.get(name) || []', to: '[]', check: 'copied-source' },
  { name: 'for-of bindings leak the outer name', file: 'library', from: "'ArrowFunctionExpression', 'BlockStatement', 'ForOfStatement'].includes(scope.type)", to: "'ArrowFunctionExpression', 'BlockStatement'].includes(scope.type)", check: 'iterated-loader' },
  { name: 'root database paths have no consumers', file: 'library', from: "node.value === 'AuroraDB.db'", to: 'false', check: 'named-fixtures' },
  { name: 'spaces erase named save paths', file: 'library', from: '!/[\\r\\n]/.test(node.value)', to: '!/[\\r\\n ]/.test(node.value)', check: 'named-fixtures' },
  { name: 'shared helper changes look deceptively narrow', file: 'cli', from: 'const broad = sharedChange ||', to: 'const broad = false ||', check: 'shared-output' },
  { name: 'accepted version arrays become a single impossible hash', file: 'library', from: 'Array.isArray(contract?.sha256) ? contract.sha256 : [contract?.sha256]', to: '[contract?.sha256]', check: 'audited-versions' },
  { name: 'audited loader caller domains are mistaken for mutable cache targets', file: 'library', from: 'if (helperContract?.callerLoads && importContractMatches(helperContract, text)) {', to: 'if (false) {', check: 'audited-versions' },
  { name: 'multi-module API is mistaken for a scalar loader', file: 'library', from: "loader === 'loadUtilities' || loader === 'loadModules'", to: "loader === 'loadUtilities'", check: 'multi-loader' },
  { name: 'a local multi-module wrapper is mistaken for the page-loader API', file: 'library', from: '&& !localMultiWrapper ? called', to: '? called', check: 'multi-loader' },
  { name: 'Set spreads remain opaque', file: 'library', from: 'value && Array.isArray(value.set) ? [...new Set(value.set)] : value', to: 'value', check: 'conditional-loader' },
  { name: 'nested conditional domains remain opaque', file: 'library', from: 'if (conditional) {', to: 'if (false) {', check: 'conditional-loader' },
  { name: 'named conditional initializers are not followed', file: 'library', from: 'if (init && init !== expression) return possibleValues(init, at, next)', to: 'if (false) return possibleValues(init, at, next)', check: 'conditional-loader' },
  { name: 'extensionless computed imports lose their suffix targets', file: 'library', from: "const endings = [suffix, ...['.js', '.mjs', '.vue', '.json', '.ts', '/index.js'].map((extension) => suffix + extension)]", to: 'const endings = [suffix]', check: 'require-suffix' },
  { name: 'encoded source imports lose their original module', file: 'library', from: "const encodedTargets = node.type === 'ImportExpression'", to: "const encodedTargets = true ? [] : node.type === 'ImportExpression'", check: 'encoded-source' },
  { name: 'opaque encoders are trusted as pure base64 encoders', file: 'library', from: 'if (!validDataUrl || !rawSource(expression.arguments[0])) return []', to: 'if (!rawSource(expression.arguments[0])) return []', check: 'encoded-source' },
  { name: 'finite package callers remain opaque', file: 'library', from: "if (typeof value !== 'string' && resolvingPackage)", to: 'if (false)', check: 'package-callers' },
  { name: 'joined source paths are mistaken for string transformations', file: 'library', from: "if (propertyName === 'join' && expression.callee.object.name === 'path') return literalSuffixTargets(expression, at)", to: 'if (false) return []', check: 'encoded-source' },
  { name: 'opaque source rewrites inherit an incomplete physical import graph', file: 'library', from: 'if (!validDataUrl || !rawSource(expression.arguments[0])) return []', to: 'if (!validDataUrl) return []', check: 'encoded-source' },
  { name: 'VM contract targets disappear', file: 'library', from: 'return contract.expressions[expression]', to: 'return []', check: 'vm-callback-contract' },
  { name: 'unknown VM callback versions bypass the hash guard', file: 'library', from: '!importContractMatches(contract, source) || !own(contract.expressions, expression)', to: '!own(contract.expressions, expression)', check: 'vm-callback-contract' },
  { name: 'SFC setup script imports disappear', file: 'library', from: 'component.script?.content, component.scriptSetup?.content', to: 'component.script?.content', check: 'setup-dependencies' },
  { name: 'an ordinary script hides the setup block', file: 'library', from: '[component.script?.content, component.scriptSetup?.content]', to: '[component.script?.content || component.scriptSetup?.content]', check: 'setup-dependencies' },
  { name: 'require call uses its receiver as the module', file: 'library', from: "if (member === 'call' && node.arguments.length === 2) requireSource = node.arguments[1]", to: "if (member === 'call' && node.arguments.length === 2) requireSource = node.arguments[0]", check: 'callback-uses' },
  { name: 'extracted require aliases lose their callback identity', file: 'library', from: 'if (!indirectRequires.has(node.id.name)) { indirectRequires.add(node.id.name); changed = true }', to: 'if (false) { indirectRequires.add(node.id.name); changed = true }', check: 'callback-uses' },
  { name: 'computed require members have no static name', file: 'library', from: 'const member = callee.computed ? callee.property.value : callee.property.name', to: 'const member = callee.property.name', check: 'callback-uses' },
  { name: 'unrecognized callback uses are silently discarded', file: 'library', from: "if (node.type !== 'Identifier' || !indirectRequires.has(node.name) || handledCallbacks.has(node)) continue", to: 'if (true) continue', check: 'callback-uses' },
  { name: 'dependency reassignment is presumed inert', file: 'library', from: "if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) {\n      const target = node.left || node.argument", to: 'if (false) {\n      const target = node.left || node.argument', check: 'mutable-dependencies' },
  { name: 'array aliases do not carry mutation uncertainty', file: 'library', from: 'for (const [left, right] of aliases)', to: 'for (const [left, right] of [])', check: 'mutable-dependencies' },
  { name: 'direct dependency binding reads ignore writes', file: 'library', from: "if (mutableNames.has(name)) return unknown('dependency binding can be mutated: ' + name)", to: 'if (false) return null', check: 'mutable-dependencies' },
  { name: 'injected dependency bindings ignore writes', file: 'library', from: "if (mutableNames.has(node.name) && !readonlyParameterScopes.get(scope)?.has(node.name)) return unknown('dependency binding can be mutated: ' + node.name, node)", to: 'if (false) return null', check: 'mutable-dependencies' },
  { name: 'loader initializer following erases mutation uncertainty', file: 'library', from: "if (expression?.type === 'Identifier' && data?.mutableNames.has(expression.name)) return [unknown('dependency binding can be mutated: ' + expression.name)]", to: 'if (false) return []', check: 'mutable-dependencies' },
  { name: 'object property writes lose their binding root', file: 'library', from: "if (node.type === 'MemberExpression') return roots(node.object)\n    if (node.type === 'ObjectPattern') return node.properties.flatMap((entry) => roots(entry.value || entry.argument))", to: "if (node.type === 'MemberExpression') return []\n    if (node.type === 'ObjectPattern') return node.properties.flatMap((entry) => roots(entry.value || entry.argument))", check: 'mutable-dependencies' },
  { name: 'array mutations are presumed inert', file: 'library', from: "if (['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'add', 'set', 'delete', 'clear'].includes(member))", to: 'if (false)', check: 'mutable-dependencies' },
  { name: 'computed mutation methods are presumed inert', file: 'library', from: "if (node.callee.computed && typeof member !== 'string') mutate(node.callee.object)", to: 'if (false) mutate(node.callee.object)', check: 'mutable-dependencies' },
  { name: 'require apply loses its bounded argument', file: 'library', from: 'requireSource = node.arguments[1].elements[0]', to: 'requireSource = node.arguments[0]', check: 'callback-uses' },
  { name: 'object mutation utilities are presumed inert', file: 'library', from: "if (['Object', 'Reflect'].includes(node.callee.object.name) && ['assign', 'defineProperty', 'defineProperties', 'set'].includes(member))", to: 'if (false)', check: 'mutable-dependencies' },
  { name: 'parallel completion is mistaken for declaration order', file: 'cli', from: 'declared.some((key) => !completedKeys.has(key))', to: 'JSON.stringify(declared) !== JSON.stringify(rows.map((row) => row.key))', check: 'raw' },
  { name: 'progress key membership and uniqueness are discarded', file: 'cli', from: 'completedKeys.size !== rows.length || rows.length !== declared.length || declared.some((key) => !completedKeys.has(key))', to: 'false', check: 'raw' },
  { name: 'duplicate declared progress keys are accepted', file: 'cli', from: 'new Set(declared).size !== declared.length', to: 'false', check: 'raw' },
  { name: 'completion order replaces ordered variant identity', file: 'cli', from: 'keys = declared', to: 'keys = rows.map((row) => row.key)', check: 'raw' },
  { name: 'assignment aliases lose shared object identity', file: 'library', from: "if (node.type === 'AssignmentExpression' && node.operator === '=') recordAlias(node.left, node.right)", to: 'if (false) recordAlias(node.left, node.right)', check: 'assignment-alias-mutations' },
  { name: 'extracted mutators taint their source instead of their destination', file: 'library', from: "if (!node.arguments.length || node.arguments[0].type === 'SpreadElement') noteMutation(source.slice(node.start, node.end), node)\n      mutate(node.arguments[0])", to: "if (!node.arguments.length || node.arguments[0].type === 'SpreadElement') noteMutation(source.slice(node.start, node.end), node)\n      mutate(node.arguments[1])", check: 'assignment-alias-mutations' },
  { name: 'unresolved mutation aliases are silently discarded', file: 'library', from: 'if (provenance.uncertainty.length) unresolved.push(', to: 'if (false) unresolved.push(', check: 'assignment-alias-mutations' },
  { name: 'escaped mutation functions are presumed harmless', file: 'library', from: 'noteMutation(source.slice(parent?.start ?? node.start, parent?.end ?? node.end), node)', to: 'void(node)', check: 'assignment-alias-mutations' },
  { name: 'getter-derived aliases trust an unresolved member origin', file: 'library', from: 'const opaqueMember = !mutationNamespaces.has(node.object.name) || !utilityMethods.has(memberName(node))', to: 'const opaqueMember = false', check: 'assignment-alias-mutations' },
  { name: 'loop-bound aliases lose shared object identity', file: 'library', from: "if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {", to: 'if (false) {', check: 'assignment-alias-mutations' },
  { name: 'opaque extracted callables are presumed harmless', file: 'library', from: "noteMutation('opaque mutation callable ' + source.slice(node.start, node.end), node)", to: 'void(node)', check: 'assignment-alias-mutations' },
  { name: 'loader value aliases lose their callable identity', file: 'library', from: 'if (!loaderAliases.has(target.name)) { loaderAliases.set(target.name, loaderAliases.get(value.name)); changed = true }', to: 'if (false) { changed = true }', check: 'loader-aliases' },
  { name: 'changed helper programs bypass their audited hash', file: 'library', from: 'helperContract?.callerLoads && importContractMatches(helperContract, text)', to: 'helperContract?.callerLoads', check: 'audited-versions' },
  { name: 'native private collections are mistaken for opaque shared objects', file: 'library', from: "node.type === 'NewExpression' && node.callee.type === 'Identifier' && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(node.callee.name)", to: 'false', check: 'audited-loader-domain' },
  { name: 'a shadowed collection constructor is trusted as native', file: 'library', from: '!shadowedNatives.has(node.callee.name)', to: 'true', check: 'assignment-alias-mutations' },
  { name: 'binding reassignment is mistaken for mutation of an opaque object', file: 'library', from: "if (storageMutations.has(name)) noteMutation('unresolved mutable alias ' + name,", to: "if (mutableNames.has(name)) noteMutation('unresolved mutable alias ' + name,", check: 'audited-loader-domain' },
  { name: 'ordinary data mutation poisons literal dependency domains', file: 'library', from: 'const provenance = sinkProvenance(data, dependencyInputs)', to: 'const provenance = { uncertainty: data.mutationUncertainty, irrelevant: [], reaches: () => true }', check: 'audited-loader-domain' },
  { name: 'fresh containers are mistaken for aliases of their held values', file: 'library', from: '(container ? references : origin.projection ? projections : aliases).push', to: 'aliases.push', check: 'audited-loader-domain' },
  { name: 'stored opaque references lose nested mutation uncertainty', file: 'library', from: "if (nestedMutations.has(name)) noteMutation('unresolved mutable member alias ' + name,", to: "if (false) noteMutation('unresolved mutable member alias ' + name,", check: 'assignment-alias-mutations' },
  { name: 'opaque binding origins are discarded before sink slicing', file: 'library', from: 'mutationOrigins.push({ reason, nodes: nodes.filter(Boolean) })', to: 'void(reason)', check: 'sink-returns' },
  { name: 'sink slicing retains every unrelated mutation issue', file: 'library', from: 'data.mutationOrigins.filter(relevant)', to: 'data.mutationOrigins', check: 'sink-irrelevance' },
  { name: 'irrelevant binding explanations disappear from the sealed plan', file: 'library', from: 'analysedBindings.push(...provenance.irrelevant.filter', to: 'Array(...provenance.irrelevant.filter', check: 'sink-irrelevance' },
  { name: 'baseline irrelevant binding provenance disappears', file: 'library', from: '...prior.analysedBindings.map((binding) => ({ ...binding, baseline: true }))', to: '...[]', check: 'sink-irrelevance' },
  { name: 'the printed plan hides irrelevant binding provenance', file: 'cli', from: 'analysedBindings: plan.analysedBindings,', to: 'analysedBindings: [],', check: 'sink-irrelevance' },
  { name: 'a chosen module-name field inherits unrelated object fields', file: 'library', from: 'memberValue(node) ? [memberValue(node)] : [node.object,', to: 'false ? [memberValue(node)] : [node.object,', check: 'sink-fields' },
  { name: 'fresh provenance containers alias their contained runtime values', file: 'library', from: "if (['ObjectExpression', 'ArrayExpression'].includes(node.type)) return [node]", to: "if (['ObjectExpression', 'ArrayExpression'].includes(node.type)) return references(node)", check: 'sink-fields' },
  { name: 'primitive arguments alias an opaque returned object', file: 'library', from: 'for (const origin of identityOrigins(value)) if (!primitiveBinding(origin))', to: 'for (const origin of identityOrigins(value)) if (true)', check: 'sink-fields' },
  { name: 'opaque returns lose their shared identity with module-name arrays', file: 'library', from: 'identities.get(origin).add(binding)', to: 'void(binding)', check: 'sink-returns' },
  { name: 'visible returned aliases are not followed', file: 'library', from: 'visible.flatMap((fn) => children(fn).flatMap((value) => identityOrigins(value, next)))', to: '[]', check: 'sink-returns' },
  { name: 'constructor returns lose their shared dependency identity', file: 'library', from: "if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return node.body.body.filter", to: "if (false) return node.body.body.filter", check: 'sink-returns' },
  { name: 'forwarded dependency parameters ignore their writes', file: 'library', from: "for (const binding of writes) if (escapeReferences(binding).length) uncertainty.push(", to: 'for (const binding of []) if (escapeReferences(binding).length) uncertainty.push(', check: 'sink-forwarding' },
  { name: 'named parameter forwarding loses shared array identities', file: 'library', from: "fn.params.forEach((parameter, index) => forward(parameter, parameter.type === 'RestElement' ? { type: 'ArrayExpression', elements: node.arguments.slice(index) } : node.arguments[index]))", to: 'fn.params.forEach(() => {})', check: 'sink-forwarding' },
  { name: 'dependency-tainted array arguments may escape unseen code', file: 'library', from: 'if (!native && escaped.length) uncertainty.push(', to: 'if (false) uncertainty.push(', check: 'sink-escapes' },
  { name: 'stored module-name arrays disappear from escape analysis', file: 'library', from: 'const related = [...(links.get(node) || [])', to: "if (node.type === 'MemberExpression') continue\n      const related = [...(links.get(node) || [])", check: 'sink-escapes' },
  { name: 'computed and shadowed native method names are trusted blindly', file: 'library', from: "callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && !bindingOf(callee.object)", to: "callee.type === 'MemberExpression' && callee.object.type === 'Identifier'", check: 'sink-escapes' },
  { name: 'pure native inspections become spurious unknown calls', file: 'library', from: 'if (!native && escaped.length) uncertainty.push(', to: 'if (escaped.length) uncertainty.push(', check: 'sink-escapes' },
  { name: 'closed suffix domains inherit unknown prefix aliases', file: 'library', from: 'if (!suffixTargets.length && !encodedTargets.length) dependencyInputs.push(', to: 'if (!encodedTargets.length) dependencyInputs.push(', check: 'require-suffix' },
  { name: 'closed raw-source URL domains inherit opaque encoder aliases', file: 'library', from: 'if (!suffixTargets.length && !encodedTargets.length) dependencyInputs.push(', to: 'if (!suffixTargets.length) dependencyInputs.push(', check: 'encoded-source' },
  { name: 'module-level dependency storage loses its alias barrier', file: 'library', from: 'const storageBarrier = stored.size > 0', to: 'const storageBarrier = false', check: 'assignment-alias-mutations' },
  { name: 'over-bound provenance is declared irrelevant', file: 'library', from: "if (budget < 0 || resolutionOverflow) uncertainty.push('dependency provenance expansion exceeded its bound')", to: 'if (false) uncertainty.push()', check: 'sink-bounds' },
  { name: 'non-literal module-name bindings use the fresh-literal fast path', file: 'library', from: "node.type === 'Literal' || (node.type === 'TemplateLiteral'", to: "['Literal', 'Identifier'].includes(node.type) || (node.type === 'TemplateLiteral'", check: 'sink-returns' },
  { name: 'method receivers disappear from returned module-name values', file: 'library', from: "node.callee.type === 'MemberExpression' && !nativeNamespace(node.callee.object) ? [node.callee.object]", to: "false ? [node.callee.object]", check: 'sink-returns' },
  { name: 'proven scalar paths alias opaque runtime objects', file: 'library', from: 'const value = data.valueOf(binding.name)', to: 'const value = {}', check: 'sink-irrelevance' },
  { name: 'native namespace aliases bypass the callable identity guard', file: 'library', from: 'identityPending.push(...roots(node.callee.object))', to: 'void(node)', check: 'sink-returns' },
  { name: 'destructuring property names are mistaken for loaded object aliases', file: 'library', from: '? roots(node) : references(node)', to: '? references(node) : references(node)', check: 'sink-known-values' },
  { name: 'unused arguments taint a visible function return', file: 'library', from: 'return visible.length ? visible.flatMap(children) :', to: 'return visible.length ? [...node.arguments, ...visible.flatMap(children)] :', check: 'sink-known-values' },
  { name: 'visible returned object fields cannot be projected', file: 'library', from: "['Identifier', 'CallExpression'].includes(object.type)", to: "['Identifier'].includes(object.type)", check: 'sink-known-values' },
  { name: 'finite primitive caller arguments become mutable escapes', file: 'library', from: 'if (argument) parameterValues.get(binding).push(argument)', to: 'if (false) parameterValues.get(binding).push(argument)', check: 'sink-known-values' },
  { name: 'native scalar properties inherit mutable namespace provenance', file: 'library', from: 'const nativeScalar = (node) =>', to: 'const nativeScalar = (node) => false &&', check: 'sink-known-values' },
  { name: 'spread primitive elements are mistaken for a shared array argument', file: 'library', from: "if (node.type === 'SpreadElement') {\n        const elements = arrayElements(node.argument)", to: "if (false) {\n        const elements = arrayElements(node.argument)", check: 'sink-known-values' },
  { name: 'visible array callbacks remain opaque consumers', file: 'library', from: '|| handledIterations.has(node)) continue', to: ') continue', check: 'sink-callbacks' },
  { name: 'array callback function objects taint their returned names', file: 'library', from: 'if (handledIterations.has(node)) return [node.callee.object, ...localFunctions(node.arguments[0]).flatMap(children)]', to: 'if (false) return []', check: 'sink-callbacks' },
  { name: 'array callback scalar indices lose their type proof', file: 'library', from: 'scalarParameters.add(binding)', to: 'void(binding)', check: 'sink-callbacks' },
  { name: 'array callbacks lose their shared third parameter', file: 'library', from: 'if (fn.params[2]) forward(fn.params[2], node.callee.object)', to: 'if (false) forward(fn.params[2], node.callee.object)', check: 'sink-callbacks' },
  { name: 'unknown native array callback programs are trusted', file: 'library', from: '!elements || !callbacks.length || opaqueEvaluation', to: '!elements || opaqueEvaluation', check: 'sink-escapes' },
  { name: 'rest-array callbacks are mistaken for scalar callback parameters', file: 'library', from: "|| fn.params.some((parameter) => parameter.type === 'RestElement')", to: '', check: 'sink-callbacks' },
  { name: 'opaque callback evaluation bypasses the precision guard', file: 'library', from: "|| opaqueEvaluation || data.mutableNames.has('Array')", to: "|| data.mutableNames.has('Array')", check: 'sink-callbacks' },
  { name: 'external dependency-name storage is silently ignored', file: 'library', from: "&& !roots(node.left).length && escapeReferences(node.right).length) uncertainty.push(", to: '&& false) uncertainty.push(', check: 'sink-contained-escapes' },
  { name: 'function-returned mutable dependency names disappear during escape analysis', file: 'library', from: '...(node.type ? containedChildren(node) : [])]', to: '...(node.type && !isFunction(node) ? containedChildren(node) : [])]', check: 'sink-contained-escapes' },
  { name: 'inert path factory parameters inherit unrelated runtime writes', file: 'library', from: 'readonlyParameterScopes.set(scope, new Set(lambda.lambda.params.flatMap(roots)))', to: 'void(scope)', check: 'sink-path-factories' },
  { name: 'inert path factories accept a shadowed namespace', file: 'library', from: "if (own(scope, receiver.name) || imported?.type !== 'CallExpression' || imported.callee.name !== 'require' || ![receiver.name, 'node:' + receiver.name].includes(imported.arguments[0]?.value)) return unknown('unresolved module namespace', node)", to: "if (false) return unknown('unresolved module namespace', node)", check: 'sink-path-factories' },
  { name: 'native Set copies are mistaken for opaque mutable consumers', file: 'library', from: '|| nativeCollection(node) || handledIterations.has(node)', to: '|| handledIterations.has(node)', check: 'conditional-loader' },
  { name: 'empty finite array branches become an unknown collection domain', file: 'library', from: "(choices.length || expression.type === 'ArrayExpression')", to: 'choices.length', check: 'conditional-loader' },
  { name: 'native constructor aliases bypass their dependency identity guard', file: 'library', from: 'identityPending.push(nativeConstructor(node.callee))', to: 'void(node)', check: 'sink-returns' },
  { name: 'unused mutable arguments poison an independently returned module name', file: 'library', from: 'entry.bounded || entry.inputs.some(provenance.reaches)', to: 'true', check: 'sink-known-values' },
  { name: 'opaque escapes follow value derivation instead of containment', file: 'library', from: '...(node.type ? containedChildren(node) : [])]', to: '...(node.type ? children(node) : [])]', check: 'sink-containment' },
  { name: 'native map results retain their source array', file: 'library', from: "if (method === 'map') return localFunctions(expression.arguments[0]).flatMap(children)", to: "if (method === 'map') return [expression.callee.object]", check: 'sink-containment' },
  { name: 'native flatMap results retain returned array containers', file: 'library', from: 'return returned.flatMap((value) => arrayElements(value, next) || [value])', to: 'return returned', check: 'sink-containment' },
  { name: 'native filters lose their retained elements', file: 'library', from: "if (method === 'filter') return arrayElements(expression.callee.object, next)", to: "if (method === 'filter') return []", check: 'sink-containment' },
  { name: 'native find results lose their retained element', file: 'library', from: "if (method === 'find') return arrayElements(node.callee.object) || [node.callee.object]", to: "if (method === 'find') return []", check: 'sink-containment' },
  { name: 'fresh native objects alias their input collections', file: 'library', from: 'if (freshNativeResult(node)) return [node]', to: 'if (false) return [node]', check: 'sink-containment' },
  { name: 'fromEntries retains entry keys and arrays instead of only values', file: 'library', from: 'if (pairs?.every(Boolean)) return pairs.flatMap((pair) => pair.slice(1, 2))', to: 'if (pairs?.every(Boolean)) return node.arguments', check: 'sink-containment' },
  { name: 'computed object keys escape as mutable pointers', file: 'library', from: "if (node.type === 'Property') return [node.value]\n", to: "if (node.type === 'Property') return [node.value, node.key]\n", check: 'sink-containment' },
  { name: 'computed member keys escape as mutable pointers', file: 'library', from: "if (node.type === 'MemberExpression') return memberValue(node) ? [memberValue(node)] : [node.object]\n", to: "if (node.type === 'MemberExpression') return [node.object, node.property]\n", check: 'sink-containment' },
  { name: 'assignment results lose their right-hand value', file: 'library', from: "if (node.type === 'AssignmentExpression' && node.operator === '=') return [node.right]\n    if (node.type === 'ConditionalExpression')", to: "if (node.type === 'AssignmentExpression' && node.operator === '=') return []\n    if (node.type === 'ConditionalExpression')", check: 'sink-containment' },
  { name: 'conditional results retain their tests', file: 'library', from: "if (node.type === 'ConditionalExpression') return [node.consequent, node.alternate]", to: "if (node.type === 'ConditionalExpression') return [node.test,node.consequent,node.alternate]", check: 'sink-containment' },
  { name: 'sequence results retain earlier expressions', file: 'library', from: "if (node.type === 'SequenceExpression') return node.expressions.slice(-1)", to: "if (node.type === 'SequenceExpression') return node.expressions", check: 'sink-containment' },
  { name: 'native JSON formatting leaks its mutable input', file: 'library', from: 'if (nativeStringify(node)) return true', to: 'if (false) return true', check: 'sink-containment' },
  { name: 'unknown JSON replacers are trusted as native inspection', file: 'library', from: "(!node.arguments[1] || (node.arguments[1].type === 'Literal' && node.arguments[1].value === null))", to: 'true', check: 'sink-containment' },
  { name: 'native joins leak their mutable receivers', file: 'library', from: "return memberName(node.callee) === 'join' &&", to: "return false &&", check: 'sink-containment' },
  { name: 'native lengths leak their mutable receivers', file: 'library', from: "if (node.type === 'MemberExpression' && memberName(node) === 'length' && knownSequence(node.object)) return true", to: "if (false) return true", check: 'sink-containment' },
  { name: 'scalar native callback results retain their callback values', file: 'library', from: "if (method === 'find') return arrayElements(node.callee.object) || [node.callee.object]\n      return []", to: "if (method === 'find') return arrayElements(node.callee.object) || [node.callee.object]\n      return localFunctions(node.arguments[0]).flatMap(children)", check: 'sink-containment' },
  { name: 'Object namespace aliases bypass dependency identity', file: 'library', from: "['Object', 'Array', 'Math', 'JSON', 'Reflect'].map((name) => [name, { name }])", to: "['Array', 'Math', 'JSON', 'Reflect'].map((name) => [name, { name }])", check: 'sink-containment' },
  { name: 'native array callbacks bypass their global identity guard', file: 'library', from: "if (handledIterations.has(node)) identityPending.push(globals.get('Array'))", to: 'if (false) identityPending.push()', check: 'sink-containment' },
  { name: 'nested returned-array writes have no mutation target', file: 'library', from: '[target, ...roots(target), ...identityOrigins(target)', to: '[...roots(target), ...identityOrigins(target)', check: 'sink-containment' },
]
/* eslint-enable no-template-curly-in-string */

const actualRepository = async (api) => {
  const files = api.lib.repoFiles(root)
  const suite = 'scripts/check-route-position.js'
  const route = api.adapters.catalogSuite(fs.readFileSync(path.join(root, suite), 'utf8'), suite, root, files)
  assert.ok(route.variants.some((entry) => entry.key === 'benign:all'))
  const anchors = route.variants.filter((entry) => entry.anchors.some((anchor) => anchor.file === 'src/renderer/pages/hauling.vue'))
  assert.equal(anchors.filter((entry) => entry.key.startsWith('fault:')).length, 55)
  assert.equal(anchors.filter((entry) => entry.key.startsWith('composed:')).length, 140)
  return route
}
const rawControls = async (api) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-fu51-evidence-'))
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'ae-fu51-evidence-'))
  try {
    const folder = path.join(directory, '.check-runs', 'sample')
    fs.mkdirSync(folder, { recursive: true })
    const value = await plan(api)
    value.identity.root = directory
    const entry = { suite: SUITE, status: path.join(folder, 'status.json'), log: path.join(folder, 'log.txt') }
    const command = selection(value).commands[0]
    const status = { state: 'done', code: 0, script: SUITE, args: command.args, started: new Date(Date.now() + 1000).toISOString(), ended: new Date(Date.now() + 2000).toISOString(), summary: '10 of 10 checks passed' }
    assert.deepEqual(selection(value).timingWitnesses, { head: 'head', 'fault:0': 'planted fault alpha fault', 'composed:1': 'planted fault firsta, on the sources with every benign edit', 'composed:2': 'planted fault firstb, on the sources with every benign edit', 'fault:1': 'planted fault firsta', 'fault:2': 'planted fault firstb', 'fault:3': 'planted fault seconda', 'fault:4': 'planted fault secondb', 'benign:all': 'every benign edit applied: every check stays green' })
    const renderTimes = (keys) => keys.map((key) => 'TIME ' + selection(value).timingWitnesses[key] + ': 0.1 s').join('\n') + '\n10 of 10 checks passed\n'
    const log = renderTimes(command.keys)
    fs.writeFileSync(entry.status, JSON.stringify(status))
    fs.writeFileSync(entry.log, log)
    for (const family of ['only-keys', 'runner', 'part', 'full']) {
      fs.writeFileSync(entry.status, JSON.stringify({ ...status, summary: '9 of 10 checks passed' }))
      fs.writeFileSync(entry.log, log.replace('10 of 10 checks passed', '9 of 10 checks passed'))
      const partial = { ...value, selections: [{ ...selection(value), family }] }
      assert.throws(() => api.cli.rawEvidence(partial, [entry]), /authoritative completed summary/)
    }
    for (const [summary, ending] of [['0 of 0 checks passed', '0 of 0 checks passed'], ['10 of 10 checks passed', '9 of 10 checks passed']]) {
      fs.writeFileSync(entry.status, JSON.stringify({ ...status, summary }))
      fs.writeFileSync(entry.log, log + ending + '\n')
      assert.throws(() => api.cli.rawEvidence(value, [entry]), /authoritative completed summary/)
    }
    fs.writeFileSync(entry.status, JSON.stringify(status))
    fs.writeFileSync(entry.log, log)
    assert.deepEqual(api.cli.rawEvidence(value, [entry])[0].keys, command.keys)
    fs.writeFileSync(entry.status, JSON.stringify({ ...status, started: '2000-01-01T00:00:00.000Z' }))
    assert.throws(() => api.cli.rawEvidence(value, [entry]), /predates/)
    fs.writeFileSync(entry.status, JSON.stringify(status))
    fs.writeFileSync(entry.log, 'TIME head: 0.1 s\n10 of 10 checks passed')
    assert.throws(() => api.cli.rawEvidence(value, [entry]), /execution witnesses/)
    const fallbackSuite = 'scripts/check-fleet-profile.js'
    const fallback = { ...value, selections: [{ suite: fallbackSuite, family: 'full', sourceHash: 'fixture', expectedExtra: 7 }] }
    const full = { ...status, script: fallbackSuite, args: [], summary: '17 of 17 checks passed' }
    const headFolder = path.join(directory, '.check-runs', 'head')
    fs.mkdirSync(headFolder)
    const head = { suite: fallbackSuite, status: path.join(headFolder, 'status.json'), log: path.join(headFolder, 'log.txt') }
    fs.writeFileSync(head.status, JSON.stringify({ ...status, script: fallbackSuite, args: ['--no-mutations'] }))
    fs.writeFileSync(head.log, '10 of 10 checks passed')
    fs.writeFileSync(entry.status, JSON.stringify(full))
    fs.writeFileSync(entry.log, '17 of 17 checks passed')
    const fullEntry = { ...entry, suite: fallbackSuite }
    assert.equal(api.cli.rawEvidence(fallback, [head, fullEntry]).length, 2)
    fs.writeFileSync(entry.status, JSON.stringify({ ...full, summary: '10 of 10 checks passed' }))
    fs.writeFileSync(entry.log, '10 of 10 checks passed')
    assert.throws(() => api.cli.rawEvidence(fallback, [head, fullEntry]), /complete mutation/)
    const args = ['--detail', '--variants=head,fault:0']
    const runner = { ...value, selections: [{ suite: SUITE, family: 'runner', sourceHash: 'fixture' }] }
    const runnerStatus = { ...status, args, summary: '2 of 2 checks passed' }
    const header = { script: SUITE, args, began: status.started, variants: [['head', 'head'], ['fault:0', 'fault']] }
    const progress = path.join(folder, 'progress.jsonl')
    const rows = [{ key: 'head', checks: 1, failures: 0, harness: null }, { key: 'fault:0', checks: 1, failures: 0, harness: null }]
    fs.writeFileSync(entry.status, JSON.stringify(runnerStatus))
    fs.writeFileSync(entry.log, '2 of 2 checks passed')
    fs.writeFileSync(progress, [header, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n')
    assert.deepEqual(api.cli.rawEvidence(runner, [{ ...entry, progress }])[0].keys, ['head', 'fault:0'])
    fs.writeFileSync(progress, [header, ...[...rows].reverse()].map((row) => JSON.stringify(row)).join('\n') + '\n')
    let reversed
    assert.doesNotThrow(() => { reversed = api.cli.rawEvidence(runner, [{ ...entry, progress }]) })
    assert.deepEqual(reversed[0].keys, ['head', 'fault:0'])
    for (const invalid of [[rows[0], rows[0]], [{ ...rows[0], checks: 2 }], [rows[0], { ...rows[1], key: 'unknown' }]]) {
      fs.writeFileSync(progress, [header, ...invalid].map((row) => JSON.stringify(row)).join('\n') + '\n')
      assert.throws(() => api.cli.rawEvidence(runner, [{ ...entry, progress }]), /missing or repeats/)
    }
    fs.writeFileSync(progress, [{ ...header, variants: [['head', 'head'], ['head', 'duplicate']] }, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n')
    assert.throws(() => api.cli.rawEvidence(runner, [{ ...entry, progress }]), /missing or repeats/)
    fs.writeFileSync(progress, [{ ...header, args: ['--variants=fault:0,head', '--detail'] }, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n')
    assert.throws(() => api.cli.rawEvidence(runner, [{ ...entry, progress }]), /does not match supervisor/)
    fs.writeFileSync(progress, [{ ...header, began: '2000-01-01T00:00:00.000Z' }, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n')
    assert.throws(() => api.cli.rawEvidence(runner, [{ ...entry, progress }]), /progress predates/)
    const defaultStatus = { ...runnerStatus, args: [] }
    fs.writeFileSync(entry.status, JSON.stringify(defaultStatus))
    fs.writeFileSync(progress, [{ ...header, args: [] }, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n')
    runner.selections[0].defaultKeys = ['head', 'fault:0']
    assert.equal(api.cli.rawEvidence(runner, [{ ...entry, progress }])[0].completeDefault, true)
    const fullKeys = selection(value).defaultKeys
    fs.writeFileSync(entry.status, JSON.stringify({ ...status, args: ['--detail'] }))
    fs.writeFileSync(entry.log, renderTimes(fullKeys))
    assert.equal(api.cli.rawEvidence(value, [entry])[0].completeDefault, true)
    fs.writeFileSync(entry.log, renderTimes(fullKeys).replace('planted fault firsta:', 'planted fault alpha fault:'))
    assert.throws(() => api.cli.rawEvidence(value, [entry]), /execution witnesses/)
    fs.writeFileSync(entry.status, JSON.stringify(status))
    fs.writeFileSync(entry.log, log.replace('planted fault firsta, on the sources with every benign edit:', 'planted fault alpha fault:'))
    assert.throws(() => api.cli.rawEvidence(value, [entry]), /execution witnesses/)
    const parts = { ...value, selections: [{ suite: SUITE, family: 'part', sourceHash: 'fixture', defaultKeys: ['head', 'mutant:0', 'stacked'], partWitnesses: { 'mutant:0': 'mutation caught: original', stacked: 'benign edits: all of them together keep every fixture check green' } }] }
    fs.writeFileSync(entry.status, JSON.stringify({ ...status, args: [] }))
    fs.writeFileSync(entry.log, 'PASS mutation caught: original\nPASS benign edits: all of them together keep every fixture check green\n10 of 10 checks passed')
    assert.equal(api.cli.rawEvidence(parts, [entry])[0].completeDefault, true)
    fs.writeFileSync(entry.log, 'PASS mutation caught: original extended\nPASS benign edits: all of them together keep every fixture check green\n10 of 10 checks passed')
    assert.throws(() => api.cli.rawEvidence(parts, [entry]), /named mutation/)
    fs.writeFileSync(entry.log, 'PASS benign edits: all of them together keep every fixture check green\n10 of 10 checks passed')
    assert.throws(() => api.cli.rawEvidence(parts, [entry]), /named mutation/)
    const named = { ...value, selections: [{ suite: SUITE, family: 'full', sourceHash: 'fixture', expectedExtra: null, witnesses: { faults: ['first', 'first longer'], benign: ['rewrite', 'rewrite longer'] } }] }
    const namedLog = 'PASS  fault caught: first  [ordinary wrong value]\nPASS  fault caught: first longer\nPASS  rewrites pass together: rewrite; rewrite longer\n10 of 10 checks passed'
    fs.writeFileSync(entry.log, namedLog)
    assert.deepEqual(api.cli.rawEvidence(named, [entry])[0].keys, ['*'])
    fs.writeFileSync(entry.log, namedLog.replace('fault caught: first  [ordinary wrong value]', 'fault caught: first longer'))
    assert.throws(() => api.cli.rawEvidence(named, [entry]), /execution witnesses/)
    fs.writeFileSync(entry.log, namedLog.replace('rewrite; rewrite longer', 'rewrite longer'))
    assert.throws(() => api.cli.rawEvidence(named, [entry]), /execution witnesses/)
    fs.writeFileSync(entry.status, JSON.stringify({ ...status, args: ['--part', 'mutant:0'] }))
    fs.writeFileSync(entry.log, 'PASS mutation caught: original\n10 of 10 checks passed')
    assert.deepEqual(api.cli.rawEvidence(parts, [entry])[0].keys, ['mutant:0'])
    fs.writeFileSync(entry.log, 'PASS mutation caught: original extended\n10 of 10 checks passed')
    assert.throws(() => api.cli.rawEvidence(parts, [entry]), /execution witnesses/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
const run = async () => {
  let checks = 0
  let failures = 0
  const report = (name, result) => { checks++; failures += result === true ? 0 : 1; console.log(`${result === true ? 'PASS' : 'FAIL'} ${name}${result === true ? '' : ': ' + result}`) }
  const api = subject()
  for (const [, name, check] of CHECKS) {
    try { await check(api); report(name, true) } catch (error) { report(name, error.message) }
  }
  try { const value = await actualRepository(api); report(`the real route-position catalog accounts for ${value.variants.length} execution keys and Hauling anchors`, true) } catch (error) { report('the real repository Hauling catalog', error.message) }
  try { await rawControls(api); report('raw supervised records require fresh timestamps and complete selected execution witnesses', true) } catch (error) { report('raw supervised records', error.message) }
  if (mutating()) {
    for (const fault of FAULTS) {
      const check = fault.check === 'actual' ? actualRepository : fault.check === 'raw' ? rawControls : CHECKS.find(([key]) => key === fault.check)[2]
      let caught = false
      let problem = null
      try { await check(subject(fault)) } catch (error) { caught = error instanceof assert.AssertionError; problem = error }
      report(`fault caught: ${fault.name}`, caught ? true : problem ? `subject/harness threw ${problem.message}` : 'the check still passes')
    }
  }
  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exitCode = failures ? 1 : 0
}
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 2 })
module.exports = { CHECKS, FAULTS, subject, actualRepository, rawControls }
