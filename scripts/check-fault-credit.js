/*
  Checks scripts/lib/fault-credit.js, the one policy of the checks that plant a fault in the code under test and credit it only when a check named for it fails by an assertion of its own.

  Run: node scripts/check-fault-credit.js [--no-mutations]

  Each case is a piece that is as it should be, paired with the piece that goes wrong:
  - an assertion of a check carries the mark, and one that holds passes; an AssertionError nothing marked (the code under test threw it) carries none and is a result of kind 'error', which credits nothing and stops the run when a fault is judged;
  - a call of the code under test (`through`, `subjectModule`) that throws, rejects or hands back a getter that throws is a marked failure that names the call and keeps what was thrown, an AssertionError included; a call that returns gives its result; a HarnessError passes through as it is;
  - a callback of the harness (`harnessOwn`) that throws or rejects is a HarnessError, also inside a call of the code under test, and one that returns gives its value;
  - a store of the harness (`harnessStore`) that is malformed (no getters, a getter of another kind than the page reads it as, no dispatch), that has a getter or a dispatch that throws, or that hands over a function that throws, is a HarnessError, and a store that is whole gives the page what it reads; the getters named `raw` are handed over as they are;
  - `runChecks` gives a result with the kind of each check, and a HarnessError a check throws stops the run; `judged` stops the run for any result of kind 'error' and gives the failed results otherwise; `caughtBy` and `caughtAll` credit assertions only;
  - an observation of scripts/lib/browser-observe.js (made by the helper itself over a stand-in of a browser) whose context did not close, or whose work threw, is `unobserved` even where a value was kept, with or without an error the page raised; one that closed, and one whose page raised an error no check named, are observed.
  Each planted fault rewrites one line of a copy of the module and must make a named case fail on an assertion.

  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { patched } = require('./lib/mutant-source')

const DIRECTORY = path.join(__dirname, 'lib')
const MODULE = path.join(DIRECTORY, 'fault-credit.js')
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
const loaded = (folder) => ({ lib: require(path.join(folder, 'fault-credit.js')), observation: require(path.join(folder, 'browser-observe.js')) })

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
}

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

      const source = fs.readFileSync(MODULE, 'utf8')

      for (const [name, from, to, caught] of FAULTS) {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-fault-credit-'))

        folders.push(folder)
        fs.writeFileSync(path.join(folder, 'fault-credit.js'), patched(MODULE, source, from, to))

        for (const sibling of ['bounded-assert.js', 'browser-observe.js']) {
          fs.copyFileSync(path.join(DIRECTORY, sibling), path.join(folder, sibling))
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
