/*
  Checks scripts/lib/fault-credit.js, the one policy of the checks that plant a fault in the code under test and credit it only when a check named for it fails by an assertion of its own.

  Run: node scripts/check-fault-credit.js [--no-mutations]

  Each case is a piece that is as it should be, paired with the piece that goes wrong:
  - an assertion of a check carries the mark, and one that holds passes; an AssertionError nothing marked (the code under test threw it) carries none and is a result of kind 'error', which credits nothing and stops the run when a fault is judged;
  - a call of the code under test (`through`, `subjectModule`) that throws, rejects or hands back a getter that throws is a marked failure that names the call and keeps what was thrown, an AssertionError included; a call that returns gives its result; a HarnessError passes through as it is;
  - a callback of the harness (`harnessOwn`) that throws or rejects is a HarnessError, also inside a call of the code under test, and one that returns gives its value;
  - a store of the harness (`harnessStore`) that is malformed (no getters, a getter of another kind than the page reads it as, no dispatch), that has a getter or a dispatch that throws, or that hands over a function that throws, is a HarnessError, and a store that is whole gives the page what it reads; the getters named `raw` are handed over as they are;
  - `runChecks` gives a result with the kind of each check, and a HarnessError a check throws stops the run; `judged` stops the run for any result of kind 'error' and gives the failed results otherwise; `caughtBy` and `caughtAll` credit assertions only;
  - a check that failed because a call of the code under test threw is a result that says so (`threw`), and a fault whose named checks failed only that way is never credited: `caughtBy` and `caughtAll` stop the run with a HarnessError that names the fault and the throw. A value a check read credits the fault, beside a throw too, a fault that declares a throw as how it is caught is credited by one, and a check that holds credits nothing;
  - an observation of scripts/lib/browser-observe.js (made by the helper itself over a stand-in of a browser) whose context did not close, or whose work threw, is `unobserved` even where a value was kept, with or without an error the page raised; one that closed, and one whose page raised an error no check named, are observed.
  - a group of faults planted together and observed once (`judgedGroup`) credits each member by its own checks alone, and stops the run for a check no member names that failed, a check a member names that was not run, a check that ended in an exception, a member credited only by a throw and a declaration that shares a check between members, has fewer than two members or mixes faults with rewrites; and its edits are made together in the sources by scripts/lib/mutant-source.js (`patchedGroup`, `plantedGroup`): each anchor occurs once, members of one file never replace overlapping text, every source still parses and a quick run plants no group.
  Each planted fault rewrites one line of a copy of the module (of mutant-source.js for the group edits) and must make a named case fail on an assertion.

  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { patched } = require('./lib/mutant-source')

const DIRECTORY = path.join(__dirname, 'lib')
const options = { mutations: !process.argv.includes('--no-mutations') }

let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

// The module with the helpers it needs from the folder it stands in: the HarnessError of that folder's browser-observe is the one the module throws.
const loaded = (folder) => ({ lib: require(path.join(folder, 'fault-credit.js')), observation: require(path.join(folder, 'browser-observe.js')), source: require(path.join(folder, 'mutant-source.js')) })

const stopped = async (call) => {
  try {
    await call()
  } catch (error) {
    return error
  }

  return null
}

const stranger = () => new assert.AssertionError({ message: 'thrown by the code under test' })

// A stand-in of a browser for `observe`: a context that opens, a page that keeps its listeners, and a close that does what `close` does. `raise` is a page error the page raises while the work runs.
const watched = (observation, close, { raise = null, work = async () => ({ done: true }) } = {}) => {
  const listeners = []
  const page = { on: (event, listener) => listeners.push([event, listener]), waitForTimeout: async () => {} }

  return observation.observe({ newContext: async () => ({ newPage: async () => page, close }) }, async () => {
    if (raise) {
      listeners.forEach(([event, listener]) => event === 'pageerror' && listener(new Error(raise)))
    }

    return work()
  })
}

const CASES = {
  verdict: async ({ lib }) => {
    const own = await lib.runChecks([{ id: 'own', name: 'own', run: () => lib.assert.equal(1, 2) }], {})
    const holds = await lib.runChecks([{ id: 'holds', name: 'holds', run: () => lib.assert.equal(1, 1) }], {})
    const failing = await lib.runChecks([{ id: 'own', name: 'own', run: () => lib.assert.ok(false, 'it does not hold') }], {})

    assert.ok(lib.isMarked(await stopped(() => lib.assert.equal(1, 2))), 'the failure of an assertion carries the mark')
    assert.equal(own[0].kind, 'assertion')
    assert.equal(failing[0].kind, 'assertion')
    assert.equal(holds[0].ok, true)
    assert.equal(holds[0].kind, null)
    assert.ok(lib.caughtBy(own, ['own']))
    assert.ok(!lib.caughtBy(holds, ['holds']))
  },

  foreign: async ({ lib, observation }) => {
    const results = await lib.runChecks([{ id: 'sync', name: 'sync', run: () => { throw stranger() } }, { id: 'async', name: 'async', run: async () => { throw stranger() } }, { id: 'crash', name: 'crash', run: () => { throw new TypeError('crash') } }], {})

    assert.ok(!lib.isMarked(stranger()), 'an AssertionError nothing marked carries no mark')
    assert.ok(results.every((result) => !result.ok && result.kind === 'error'), JSON.stringify(results))
    assert.ok(!lib.caughtBy(results, ['sync', 'async', 'crash']), 'an exception that is no assertion credits nothing')
    assert.ok((await stopped(() => lib.judged(results))) instanceof observation.HarnessError, 'judging it stops the run')
  },

  judge: async ({ lib, observation }) => {
    const results = await lib.runChecks([{ id: 'holds', name: 'holds', run: () => {} }, { id: 'fails', name: 'fails', run: () => lib.assert.equal(1, 2) }], {})
    const failed = lib.judged(results)

    assert.deepEqual(failed.map((result) => result.id), ['fails'])
    assert.ok(lib.caughtAll(failed))
    assert.ok(!lib.caughtAll(results), 'a check that holds does not credit the fault')
    assert.ok(!lib.caughtAll([]), 'a fault no check was named for is not caught')
    assert.ok((await stopped(() => lib.runChecks([{ id: 'stop', name: 'stop', run: () => { throw new observation.HarnessError('the harness is not whole') } }], {}))) instanceof observation.HarnessError, 'a HarnessError a check throws is no result')
    assert.ok(/these checks do not fail by an assertion: holds/.test(lib.notCaught(results.filter((result) => result.id === 'holds'))))
  },

  'through-throw': async ({ lib }) => {
    const thrown = await stopped(() => lib.through('the utility probe', () => { throw new RangeError('inside') }))
    const rejected = await stopped(() => lib.through('the read probe', () => Promise.reject(new RangeError('inside'))))
    const asserting = await stopped(() => lib.through('the utility probe', () => { throw stranger() }))
    const value = new RangeError('kept')
    const kept = await stopped(() => lib.through('the utility probe', () => { throw value }))

    for (const failure of [thrown, rejected, asserting]) {
      assert.ok(lib.isMarked(failure), `${failure} carries the mark`)
    }

    assert.ok(/^the utility probe threw RangeError: inside/.test(thrown.message), thrown.message)
    assert.ok(/^the read probe threw RangeError: inside/.test(rejected.message), rejected.message)
    assert.ok(/^the utility probe threw AssertionError/.test(asserting.message), asserting.message)
    assert.equal(kept.original, value)
    assert.equal(lib.through('the utility probe', () => 5), 5)
    assert.equal(await lib.through('the read probe', async () => 6), 6)
  },

  'through-getter': async ({ lib }) => {
    const trap = { get x() { throw new Error('a getter') } }
    const failure = await stopped(() => lib.through('the utility probe', () => ({ inner: [trap] })))
    const whole = lib.through('the utility probe', () => ({ inner: [{ x: 1 }], map: new Map([[1, { y: 2 }]]) }))

    assert.ok(lib.isMarked(failure) && /^the utility probe threw Error: a getter/.test(failure.message), String(failure))
    assert.equal(whole.inner[0].x, 1)
  },

  'through-harness': async ({ lib, observation }) => {
    const own = new observation.HarnessError('the harness is not whole')
    const thrown = await stopped(() => lib.through('the utility probe', () => { throw own }))
    const rejected = await stopped(() => lib.through('the read probe', () => Promise.reject(own)))
    const callback = await stopped(() => lib.through('the utility probe', () => lib.harnessOwn(() => { throw new Error('the callback') })()))

    assert.equal(thrown, own)
    assert.equal(rejected, own)
    assert.ok(callback instanceof observation.HarnessError && !lib.isMarked(callback), String(callback))
  },

  module: async ({ lib }) => {
    const wrapped = lib.subjectModule({ add: (a, b) => a + b, boom: () => { throw new Error('inside') }, VALUE: 3 })
    const failure = await stopped(() => wrapped.boom())

    assert.equal(wrapped.add(2, 3), 5)
    assert.equal(wrapped.VALUE, 3)
    assert.ok(lib.isMarked(failure) && /^the utility boom threw Error: inside/.test(failure.message), String(failure))
    assert.ok(/^the page boom threw/.test((await stopped(() => lib.subjectModule({ boom: () => { throw new Error('inside') } }, 'page').boom())).message))
  },

  callback: async ({ lib, observation }) => {
    const thrown = await stopped(() => lib.harnessOwn(() => { throw new Error('the callback') })())
    const rejected = await stopped(() => lib.harnessOwn(async () => { throw new Error('the callback') })())
    const own = new observation.HarnessError('already told')

    assert.ok(thrown instanceof observation.HarnessError && /the callback/.test(thrown.message), String(thrown))
    assert.ok(rejected instanceof observation.HarnessError, String(rejected))
    assert.equal(await stopped(() => lib.harnessOwn(() => { throw own })()), own)
    assert.equal(lib.harnessOwn((a, b) => a + b)(2, 3), 5)
    assert.equal(await lib.harnessOwn(async (a) => a)(4), 4)
    assert.equal(lib.boundary.harness(() => 7), 7)
    assert.ok((await stopped(() => lib.boundary.harness(() => { throw new Error('the getter') }))) instanceof observation.HarnessError)
    assert.ok(lib.isMarked(await stopped(() => lib.boundary.subject('the computed value x', () => { throw new Error('inside') }))))
  },

  store: async ({ lib, observation }) => {
    const shape = { report: ['function'], blocked: ['object'], GameID: ['number'] }
    const whole = () => ({ getters: { report: () => null, blocked: new Set(), GameID: 1, database: { query: () => { throw new Error('a query that fails') } }, config: { get: (_name, fallback) => fallback } }, state: { a: 1 }, dispatch: async (name) => name, commit: () => {} })
    const over = (getters) => ({ ...whole(), getters: { ...whole().getters, ...getters } })
    const read = (store, key) => () => lib.harnessStore(store, shape, { raw: ['database'] }).getters[key]
    const isHarness = async (call) => (await stopped(call)) instanceof observation.HarnessError
    const good = lib.harnessStore(whole(), shape, { raw: ['database'] })

    assert.equal(good.getters.report(), null)
    assert.equal(good.getters.GameID, 1)
    assert.ok('report' in good.getters)
    assert.equal(good.state.a, 1)
    assert.equal(await good.dispatch('go'), 'go')
    assert.equal(good.getters.config.get('x', 9), 9)
    assert.ok(await isHarness(read(over({ report: null }), 'report')), 'a getter of another kind than the page reads it as')
    assert.ok(await isHarness(read(over({ GameID: '1' }), 'GameID')), 'a number that is a string')
    assert.ok(await isHarness(read({ getters: null, state: {} }, 'GameID')), 'no getters')
    assert.ok(await isHarness(() => lib.harnessStore({ getters: {}, state: null }, shape).state), 'no state')
    assert.ok(await isHarness(() => lib.harnessStore({ getters: {}, state: {} }, shape).dispatch('go')), 'no dispatch')
    assert.ok(await isHarness(() => lib.harnessStore(null, shape).getters.GameID), 'no store')
    assert.ok(await isHarness(() => lib.harnessStore(over({ report: () => { throw new Error('the getter') } }), shape).getters.report()), 'a function that throws')
    assert.ok(await isHarness(() => lib.harnessStore(over({ config: { get: () => { throw new Error('the member') } } }), shape).getters.config.get()), 'a member that throws')
    assert.ok(await isHarness(() => lib.harnessStore({ ...whole(), dispatch: async () => { throw new Error('the dispatch') } }, shape).dispatch('go')), 'a dispatch that rejects')
    assert.ok(await isHarness(() => lib.harnessStore(Object.defineProperty(whole(), 'getters', { get() { throw new Error('the store') } }), shape).getters.GameID), 'a store that throws')
    assert.ok(!(await isHarness(() => good.getters.database.query())), 'the database is handed over as it is: its failures are data')
    assert.ok((await stopped(() => good.getters.database.query())).message === 'a query that fails')
  },

  observation: async ({ lib, observation }) => {
    const closed = await watched(observation, async () => {})
    const failed = await watched(observation, async () => { throw new Error('planted cleanup failure') })
    const raised = await watched(observation, async () => {}, { raise: 'planted page error' })
    const failedRaising = await watched(observation, async () => { throw new Error('planted cleanup failure') }, { raise: 'planted page error' })
    const threw = await watched(observation, async () => {}, { work: async () => { throw new Error('the work threw') } })
    const unopened = await observation.observe({ newContext: async () => { throw new Error('no browser process') } }, async () => ({}))

    assert.ok(failed.value !== null && failed.error !== null, 'the record keeps the screen and says the observation failed')
    assert.ok(!lib.infrastructureFailure(closed) && !lib.unobserved(closed), 'a context that closed')
    assert.ok(lib.infrastructureFailure(failed) && lib.unobserved(failed), 'a context that did not close, where a value was kept')
    assert.ok(lib.infrastructureFailure(failedRaising) && lib.unobserved(failedRaising), 'a context that did not close, and an error the page raised besides')
    assert.ok(raised.error !== null && raised.unexpected.length === 1 && !lib.infrastructureFailure(raised) && !lib.unobserved(raised), 'an error the page raised that no check named is behaviour, not a failed observation')
    assert.ok(lib.infrastructureFailure(threw) && lib.unobserved(threw), 'work that threw')
    assert.ok(lib.unobserved(unopened), 'a context that did not open')
    assert.ok(lib.unobserved(observation.failedObservation('the page did not open')), 'an observation that did not happen')
    assert.ok(!lib.unobserved(observation.completedObservation({})), 'a completed observation')
  },

  'subject-throw': async ({ lib, observation }) => {
    const crash = () => lib.through('the utility probe', () => { throw new TypeError('crash') })
    const results = await lib.runChecks([{ id: 'crashed', name: 'crashed', run: () => crash() }, { id: 'valued', name: 'valued', run: () => lib.assert.equal(lib.through('the utility probe', () => 1), 2) }, { id: 'holds', name: 'holds', run: () => {} }], {})
    const failed = lib.judged(results)
    const [crashed, valued, holds] = results
    const isHarness = (error) => error instanceof observation.HarnessError
    // What a judgement of credit gives, or the error it stopped with, so a control that stops is a failed assertion of this case.
    const credit = async (call) => {
      try {
        return await call()
      } catch (error) {
        return `stopped: ${error.message}`
      }
    }
    const alone = await stopped(() => lib.caughtBy(failed, ['crashed'], { name: 'the planted crash' }))
    const all = await stopped(() => lib.caughtAll(failed, { name: 'the planted crash' }))

    assert.ok(crashed.kind === 'assertion' && crashed.threw === true && /^the utility probe threw TypeError: crash/.test(crashed.detail), JSON.stringify(crashed))
    assert.ok(valued.kind === 'assertion' && valued.threw === false && holds.threw === false, JSON.stringify([valued, holds]))
    assert.ok(lib.isSubjectThrow(await stopped(crash)) && lib.isSubjectThrow(await stopped(() => lib.through('the read probe', () => Promise.reject(new RangeError('rejected'))))) && !lib.isSubjectThrow(await stopped(() => lib.assert.equal(1, 2))), 'a call that threw or rejected says so, and an assertion of a check does not')
    assert.ok(isHarness(alone) && alone.message.includes('the planted crash') && alone.message.includes('threw TypeError: crash'), `a fault credited only by a throw: ${alone}`)
    assert.ok(isHarness(all) && all.message.includes('the planted crash') && all.message.includes('threw TypeError: crash'), `every check named, one of them by a throw: ${all}`)
    assert.equal(await credit(() => lib.caughtBy(failed, ['valued'], { name: 'a value' })), true)
    assert.equal(await credit(() => lib.caughtBy(failed, ['crashed', 'valued'], { name: 'a value beside a throw' })), true)
    assert.equal(await credit(() => lib.caughtAll(failed.filter((result) => result.id === 'valued'), { name: 'a value' })), true)
    assert.equal(await credit(() => lib.caughtBy(failed, ['crashed'], { name: 'a declared throw', throws: true })), true)
    assert.equal(await credit(() => lib.caughtAll(failed, { name: 'a declared throw', throws: true })), true)
    assert.equal(await credit(() => lib.caughtBy(failed, ['holds'], { name: 'a check that holds' })), false)
  },

  // A group of faults planted together and observed once: the checks are fed by what is planted (`on`), as a screen is by the faults in its sources.
  'group-judged': async ({ lib, observation }) => {
    const isHarness = (error) => error instanceof observation.HarnessError
    const list = [
      { id: 'a', name: 'a', run: ({ on }) => lib.assert.equal(on.includes('a'), false, 'the value of a') },
      { id: 'b', name: 'b', run: ({ on }) => lib.assert.equal(on.includes('b'), false, 'the value of b') },
      { id: 'c', name: 'c', run: ({ on }) => lib.assert.equal(on.includes('c'), false, 'the value of c') },
      { id: 'd', name: 'd', run: ({ on }) => on.includes('d') && lib.through('the utility probe', () => { throw new TypeError('crash') }) },
    ]
    const one = { name: 'the fault of one', fails: ['a'] }
    const two = { name: 'the fault of two', fails: ['b'] }
    const judge = async (on, members, extra = list, options = {}) => lib.judgedGroup(await lib.runChecks(extra, { on }), members.map((member, at) => ({ key: `m${at}`, ...member })), { what: 'the group probe', ...options })
    const attempt = (call) => Promise.resolve().then(call).catch((error) => error)
    const rows = (verdicts, pick) => {
      assert.ok(Array.isArray(verdicts), `the verdicts of the group: ${verdicts}`)

      return verdicts.map(pick)
    }
    const both = await attempt(() => judge(['a', 'b'], [one, two]))
    const alone = await attempt(() => judge(['a'], [one, two]))
    const unseen = await attempt(() => judge([], [one, two]))
    const collateral = await stopped(() => judge(['a', 'c'], [one, two]))
    const hidden = await stopped(() => judge(['a', 'b', 'c'], [one, two]))
    const crash = await stopped(() => judge(['d'], [{ name: 'the planted crash', fails: ['d'] }, two]))
    const declared = await attempt(() => judge(['d'], [{ name: 'the declared crash', fails: ['d'], throws: true }, two]))
    const overlap = await stopped(() => judge(['a'], [one, { name: 'the fault of three', fails: ['a', 'b'] }]))
    const lone = await stopped(() => judge(['a'], [one]))
    const soloed = await attempt(() => judge(['a'], [one], list, { alone: true }))
    const soloedCollateral = await stopped(() => judge(['a', 'c'], [one], list, { alone: true }))
    const absent = await stopped(() => judge(['a'], [one, { name: 'the fault of four', fails: ['nowhere'] }]))
    const strange = await stopped(() => judge(['a'], [one, two], [...list, { id: 'e', name: 'e', run: () => { throw new Error('a check of its own failed in an exception') } }]))
    const strangeNamed = await stopped(() => judge(['a'], [{ name: 'the fault of five', fails: ['e'] }, two], [...list, { id: 'e', name: 'e', run: () => { throw new Error('a check of its own failed in an exception') } }]))
    const rewrites = await attempt(() => judge([], [{ name: 'the rewrite of one', fails: [] }, { name: 'the rewrite of two', fails: [] }]))
    const changed = await stopped(() => judge(['a'], [{ name: 'the rewrite of one', fails: [] }, { name: 'the rewrite of two', fails: [] }]))
    const mixed = await stopped(() => judge([], [one, { name: 'the rewrite of two', fails: [] }]))

    assert.deepEqual(rows(both, (verdict) => [verdict.member.name, verdict.caught, verdict.failed.map((result) => result.id)]), [['the fault of one', true, ['a']], ['the fault of two', true, ['b']]], 'each member is credited by its own check')
    assert.deepEqual(rows(alone, (verdict) => [verdict.caught, verdict.failed.map((result) => result.id)]), [[true, ['a']], [false, []]], 'the check of one failing credits one and not two')
    assert.deepEqual(rows(unseen, (verdict) => verdict.caught), [false, false], 'a member none of whose checks fails is not credited')
    assert.ok(isHarness(collateral) && collateral.message.includes('the group probe') && collateral.message.includes('c: ') && collateral.message.includes('the value of c') && !collateral.message.includes('a: '), `a check no member names failed: ${collateral}`)
    assert.ok(isHarness(hidden) && hidden.message.includes('c: '), `a member credited by its own check does not hide the collateral of the group: ${hidden}`)
    assert.ok(isHarness(crash) && crash.message.includes('the planted crash') && crash.message.includes('threw TypeError: crash'), `a member credited only by a throw: ${crash}`)
    assert.deepEqual(rows(declared, (verdict) => verdict.caught), [true, false], 'a member that declares a throw is credited by one')
    assert.ok(isHarness(overlap) && overlap.message.includes('a') && overlap.message.includes('the fault of one') && overlap.message.includes('the fault of three'), `members that name one check: ${overlap}`)
    assert.ok(isHarness(lone) && /fewer than two members/.test(lone.message), `a group of one: ${lone}`)
    assert.deepEqual(rows(soloed, (verdict) => [verdict.caught, verdict.failed.map((result) => result.id)]), [[true, ['a']]], 'one member run alone by --solo is judged as it is in the group')
    assert.ok(isHarness(soloedCollateral) && soloedCollateral.message.includes('c: '), `one member run alone: the collateral of the run stops it all the same: ${soloedCollateral}`)
    assert.ok(isHarness(absent) && absent.message.includes('nowhere'), `a check no result has: ${absent}`)
    assert.ok(isHarness(strange) && strange.message.includes('e: '), `a check that ended in an exception of its own: ${strange}`)
    assert.ok(isHarness(strangeNamed) && strangeNamed.message.includes('e: '), `a check a member names that ended in an exception of its own: ${strangeNamed}`)
    assert.deepEqual(rows(rewrites, (verdict) => [verdict.caught, verdict.failed.length]), [[false, 0], [false, 0]], 'rewrites that leave every check green credit nothing')
    assert.ok(isHarness(changed) && changed.message.includes('a: '), `a rewrite that makes a check fail: ${changed}`)
    assert.ok(isHarness(mixed) && /all faults or all rewrites/.test(mixed.message), `faults and rewrites in one group: ${mixed}`)
  },

  // The edits of a group made together in the sources the page serves, by scripts/lib/mutant-source.js.
  'group-anchors': async ({ source }) => {
    const texts = { one: 'alpha beta gamma delta', two: 'epsilon zeta', code: 'const a = 1\nconst b = 2\n', twice: 'beta and beta' }
    const edit = (name, file, find, to) => ({ name, file, find, to })
    const first = edit('the first', 'one', 'beta', 'BETA, longer')
    const second = edit('the second', 'one', 'delta', 'D')
    const other = edit('the other file', 'two', 'zeta', 'ZETA')
    const planted = source.patchedGroup(texts, [first, second, other])
    const reversed = source.patchedGroup(texts, [other, second, first])
    const touching = await Promise.resolve().then(() => source.patchedGroup(texts, [edit('the front', 'one', 'alpha', 'ALPHA'), edit('the back', 'one', ' beta', ' BETA')])).catch((error) => error)
    const meets = await stopped(() => source.patchedGroup(texts, [edit('the long one', 'one', 'alpha beta', 'x'), edit('the other long one', 'one', 'beta gamma', 'y')]))
    const same = await stopped(() => source.patchedGroup(texts, [first, edit('the same text', 'one', 'beta', 'B')]))
    const inside = await stopped(() => source.patchedGroup(texts, [edit('the whole', 'one', 'beta gamma', 'x'), edit('the part', 'one', 'gamma', 'y')]))
    const many = await stopped(() => source.patchedGroup(texts, [edit('beta twice', 'twice', 'beta', 'B'), other]))
    const none = await stopped(() => source.patchedGroup(texts, [edit('beta nowhere', 'one', 'omega', 'B'), other]))
    const broken = await stopped(() => source.patchedGroup(texts, [edit('breaks the syntax', 'code', 'const a = 1', 'const a ='), other], (file) => (file === 'code' ? 'code.js' : file)))
    const parsed = source.patchedGroup(texts, [edit('still parses', 'code', 'const a = 1', 'const a = 3'), edit('and here', 'code', 'const b = 2', 'const b = 4')], (file) => (file === 'code' ? 'code.js' : file))
    const unknown = await stopped(() => source.patchedGroup(texts, [first, edit('a file the group has not', 'three', 'x', 'y')]))
    const quick = process.env.CHECK_NO_MUTATIONS

    assert.deepEqual(planted, { ...texts, one: 'alpha BETA, longer gamma D', two: 'epsilon ZETA' }, 'every member makes its edit, in its own file or beside the others in one')
    assert.equal(texts.one, 'alpha beta gamma delta', 'the sources it was given are left as they were')
    assert.deepEqual(reversed, planted, 'the order of the members is of no matter')
    assert.equal(touching.one, 'ALPHA BETA gamma delta', 'members that touch end to end do not meet')
    assert.ok(meets instanceof Error && meets.message.includes('the long one') && meets.message.includes('the other long one'), `anchors that overlap: ${meets}`)
    assert.ok(same instanceof Error && same.message.includes('the first') && same.message.includes('the same text'), `one anchor twice: ${same}`)
    assert.ok(inside instanceof Error && inside.message.includes('the whole') && inside.message.includes('the part'), `an anchor inside another: ${inside}`)
    assert.ok(many instanceof Error && many.message.includes('beta twice') && /2 matches/.test(many.message), `an anchor that occurs twice: ${many}`)
    assert.ok(none instanceof Error && none.message.includes('beta nowhere') && /0 matches/.test(none.message), `an anchor that is not there: ${none}`)
    assert.ok(broken instanceof Error && /code\.js does not parse/.test(broken.message), `a source that no longer parses: ${broken}`)
    assert.deepEqual(parsed.code, 'const a = 3\nconst b = 4\n', 'a source that still parses is changed')
    assert.ok(unknown instanceof Error && unknown.message.includes('a file the group has not') && unknown.message.includes('three'), `a member of a file the group has not: ${unknown}`)

    if (options.mutations) {
      process.env.CHECK_NO_MUTATIONS = '1'

      try {
        const refused = await stopped(() => source.plantedGroup(texts, [first, second]))

        assert.ok(refused instanceof Error && /a fault is planted in a quick run/.test(refused.message), `a quick run plants no group: ${refused}`)
      } finally {
        if (quick === undefined) {
          delete process.env.CHECK_NO_MUTATIONS
        } else {
          process.env.CHECK_NO_MUTATIONS = quick
        }
      }

      assert.deepEqual(source.plantedGroup(texts, [first, second]).one, 'alpha BETA, longer gamma D', 'outside a quick run the group is planted')
    }
  },
}

// The module and the helpers it needs, in the folder of a fault: the sources of scripts/lib, and mutant-source with the acorn it requires found by its path in this checkout.
const SIBLINGS = ['bounded-assert.js', 'browser-observe.js', 'suite-runner.js', 'check-pool.js', 'no-mutations.js']
const libOf = (file) => fs.readFileSync(path.join(DIRECTORY, file), 'utf8').replace("require('acorn')", `require(${JSON.stringify(require.resolve('acorn'))})`)

const WORDS = {
  verdict: 'a failed assertion of a check carries the mark and credits a fault, and one that holds passes',
  foreign: 'an AssertionError or any other error the code under test threw, where no adapter named it, is no assertion, credits nothing and stops the run when a fault is judged',
  judge: 'a result of kind error stops the run, the failed results are the ones judged, a HarnessError a check throws is no result, and only assertions credit a fault',
  'through-throw': 'a call of the code under test that throws or rejects, with any error, an AssertionError included, is a marked failure that names the call and keeps what was thrown, and a call that returns gives its result',
  'through-getter': 'a getter that throws in what a call returned is the failure of the call',
  'through-harness': 'a HarnessError and a callback of the harness that throws, inside a call of the code under test, are the harness\'s: they pass through as they are and carry no mark',
  module: 'the functions of a module of the code under test are each a call that names the function, and the rest of the module is as it is',
  callback: 'a callback of the harness that throws or rejects is a HarnessError and one that returns gives its value, and the boundary of the page loader tells the page\'s from the harness\'s',
  store: 'a store of the harness that is malformed, or has a getter, a function or a dispatch that throws, is a HarnessError, a store that is whole gives the page what it reads, and the database is handed over as it is',
  observation: 'an observation whose context did not close or open, or whose work threw, is unobserved even where a value was kept, and one that closed, or whose page raised an error no check named, is observed',
  'subject-throw': 'a fault whose named checks failed only because a call of the code under test threw is a HarnessError naming the fault and the throw, and a value read, beside a throw too, or a throw the fault declares credits it',
  'group-judged': 'a group of faults planted together and observed once credits each member by its own checks only, stops the run for a check no member names that fails (naming it), a check that was not run, an exception of a check, a member credited only by a throw (unless it declares one), and a declaration whose members share a check or number fewer than two or mix faults with rewrites; rewrites credit nothing and every check must hold',
  'group-anchors': 'the edits of a group are made together in the sources: each anchor occurs once, no two members of one file replace overlapping text (touching end to end is no meeting), the order of the members is of no matter, every source still parses, a member of an unknown file is refused, and a quick run plants no group',
}

// [name, text replaced in a copy of the module, replacement, the case that must fail on an assertion].
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  ['the failure of an assertion is not marked', 'error[MARK] = true', 'error[MARK] = false', 'verdict'],
  ['an AssertionError nothing marked is an assertion', 'const kindOf = (error) => (isMarked(error) ? \'assertion\' : \'error\')', 'const kindOf = (error) => (isMarked(error) || error instanceof rawAssert.AssertionError ? \'assertion\' : \'error\')', 'foreign'],
  ['a result of kind error does not stop the run', 'if (broken.length) {', 'if (false) {', 'foreign'],
  ['a fault is credited by any failed check', 'ids.includes(result.id) && result.kind === \'assertion\'', 'ids.includes(result.id) && !result.ok', 'foreign'],
  ['a fault no check was named for is caught', 'results.length > 0 && results.every', 'results.every', 'judge'],
  ['a HarnessError a check throws is a result', 'if (error instanceof HarnessError) {\n        throw error\n      }\n\n      out.push', 'out.push', 'judge'],
  ['a failure of a call is not marked', 'const error = marked(new rawAssert.AssertionError({ message }))', 'const error = new rawAssert.AssertionError({ message })', 'through-throw'],
  ['what was thrown is not kept', 'error.original = original', 'void original', 'through-throw'],
  ['a getter in what a call returned is not read', 'if (value === null || typeof value !== \'object\' || seen.has(value)) {\n    return value\n  }', 'return value', 'through-getter'],
  ['a HarnessError inside a call is marked as the code\'s', 'if (error instanceof HarnessError || isMarked(error)) {', 'if (isMarked(error)) {', 'through-harness'],
  ['a callback of the harness that throws is the code\'s', 'throw error instanceof HarnessError ? error : new HarnessError(', 'throw error instanceof HarnessError ? error : new Error(', 'callback'],
  ['a callback of the harness that rejects is not told', 'result.then((value) => value, own)', 'result', 'callback'],
  ['the functions of a module are not adapters', '(...args) => through(`the ${noun} ${name}`, () => mod[name](...args))', '(...args) => mod[name](...args)', 'module'],
  ['a store of another kind is handed to the page', 'if (!kinds.includes(kindName(value))) {', 'if (false) {', 'store'],
  ['a getter of the store that throws is the code\'s', 'const read = (call) => harnessOwn(call)()', 'const read = (call) => call()', 'store'],
  ['the functions a store hands over are the code\'s', '(typeof value === \'function\' ? harnessOwn(value) :', '(typeof value === \'function\' ? value :', 'store'],
  ['the database is wrapped like the rest', 'return raw.includes(key) ? value : owned(value)', 'return owned(value)', 'store'],
  ['a context that did not close is not an infrastructure failure', 'const infrastructureFailure = (seen) => seen.error !== null && seen.error !==', 'const infrastructureFailure = (seen) => seen.value === null && seen.error !== null && seen.error !==', 'observation'],
  ['an error the page raised is an infrastructure failure', 'seen.error !== `the page raised ${seen.unexpected.length} unexpected error${seen.unexpected.length === 1 ? \'\' : \'s\'}, the first: ${seen.unexpected[0]}`', 'true', 'observation'],
  ['a screen that was kept is observed whatever failed', 'const unobserved = (seen) => seen.value === null || infrastructureFailure(seen)', 'const unobserved = (seen) => seen.value === null', 'observation'],
  ['a call that threw is not told as one', 'thrown[THREW] = true', 'void THREW', 'subject-throw'],
  ['an assertion of a check is told as a call that threw', 'const isSubjectThrow = (error) => isMarked(error) && error[THREW] === true', 'const isSubjectThrow = (error) => isMarked(error)', 'subject-throw'],
  ['the results do not say which check failed by a throw', 'threw: isSubjectThrow(error),', 'threw: false,', 'subject-throw'],
  ['a fault is credited by a call that threw', 'return named.some((result) => !result.threw) || (named.length > 0 && creditedByThrow(named, fault))', 'return named.length > 0', 'subject-throw'],
  ['a fault every named check catches is credited whatever threw', 'return thrown.length === 0 || creditedByThrow(thrown, fault)', 'return true', 'subject-throw'],
  ['a fault that declares a throw is stopped all the same', 'if (!throws) {', 'if (true) {', 'subject-throw'],
  ['a group credits a member by the checks of the others', 'caught: caughtBy(failed, member.fails, { name: member.name, throws: member.throws })', 'caught: caughtBy(failed, [...named], { name: member.name, throws: member.throws })', 'group-judged'],
  ['a check no member names may fail', 'if (collateral.length) {', 'if (false) {', 'group-judged'],
  ['a check a member names need not have run', 'if (missing.length) {', 'if (false) {', 'group-judged'],
  ['a group is not declared before it is judged', '    declaredGroup(what, members, alone)\n', '    void members\n', 'group-judged'],
  ['a member run alone is refused as a group of one', '    declaredGroup(what, members, alone)\n', '    declaredGroup(what, members)\n', 'group-judged'],
  ['a result of kind error does not stop a group', 'const failed = judged(results, what)\n  const named', 'const failed = results.filter((result) => !result.ok)\n  const named', 'group-judged'],
  ['the fault of a group is not named in what stops the run', 'name: member.name, throws: member.throws }', 'throws: member.throws }', 'group-judged'],
  ['a member that declares a throw is stopped all the same', 'name: member.name, throws: member.throws }', 'name: member.name }', 'group-judged'],
  ['a member is given the failures of the others', 'failed: failed.filter((result) => member.fails.includes(result.id)) }', 'failed }', 'group-judged'],
  ['members of one file may replace the same text', 'const meets = taken.find((other) => start < other.end && other.start < end)', 'const meets = null', 'group-anchors', 'mutant-source.js'],
  ['an anchor of a group that occurs twice is taken at the first', 'const count = text.split(member.find).length - 1\n\n    if (count !== 1) {\n      throw new Error(`The anchor of the member', 'const count = 1\n\n    if (count !== 1) {\n      throw new Error(`The anchor of the member', 'group-anchors', 'mutant-source.js'],
  ['members that touch end to end meet', 'start < other.end && other.start < end', 'start <= other.end && other.start <= end', 'group-anchors', 'mutant-source.js'],
  ['the edits of a file are made front to back', '.sort((a, b) => b.start - a.start)', '.sort((a, b) => a.start - b.start)', 'group-anchors', 'mutant-source.js'],
  ['a source a group changed need not parse', 'assertParses(label(file), result[file])', 'void label', 'group-anchors', 'mutant-source.js'],
  ['a member of a file the group has not is taken for one', "if (typeof text !== 'string') {", 'if (false) {', 'group-anchors', 'mutant-source.js'],
  ['a quick run plants a group', 'refusePlanting(members.map((member) => member.name).join(\'; \'))', 'void members', 'group-anchors', 'mutant-source.js'],
]
/* eslint-enable no-template-curly-in-string */

const main = async () => {
  const folders = []

  try {
    console.log('The module as it is')

    const standing = loaded(DIRECTORY)

    for (const [name, run] of Object.entries(CASES)) {
      try {
        await run(standing)
        check(`${name}: ${WORDS[name]}`, true)
      } catch (error) {
        check(`${name}: ${WORDS[name]}`, false, String(error && error.message).split('\n')[0])
      }
    }

    if (options.mutations) {
      console.log('\nPlanted faults')

      for (const [name, from, to, caught, file = 'fault-credit.js'] of FAULTS) {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-fault-credit-'))

        folders.push(folder)

        for (const sibling of ['fault-credit.js', 'mutant-source.js', ...SIBLINGS]) {
          fs.writeFileSync(path.join(folder, sibling), sibling === file ? patched(path.join(DIRECTORY, sibling), libOf(sibling), from, to) : libOf(sibling))
        }

        let thrown = null

        try {
          await CASES[caught](loaded(folder))
        } catch (error) {
          thrown = error
        }

        check(`planted: ${name}: caught by ${caught}`, thrown instanceof assert.AssertionError, thrown ? `${thrown.name}: ${String(thrown.message).split('\n')[0]}` : 'nothing failed')
      }
    }
  } finally {
    folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true }))
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
