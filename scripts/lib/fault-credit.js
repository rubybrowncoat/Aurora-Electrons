/*
  One policy for every check of the checks that plants faults in the code under test (a mutant, a rewrite that says the same thing) and credits a fault only when a check named for it fails by an assertion of its own.

  const { assert, through, harnessOwn, harnessStore, boundary, subjectModule, runChecks, judged, caughtBy, caughtAll } = require('./lib/fault-credit')

  Who failed. A check fails by an assertion of its own: `assert` (the functions of scripts/lib/bounded-assert.js) and `failure` mark what they throw with a symbol only this file holds, and a fault is credited only when a check named for it failed with a marked assertion. Nothing the code under test throws carries the mark, an AssertionError included.
  - The code under test runs only through explicit adapters (`through`, `subjectModule`, the `boundary` of scripts/lib/page-loader.js, and the adapters a check writes for its own subject out of `through`). An adapter turns what the call throws or rejects into a marked failure that names the call: the contract of a call is that it returns, and a call that throws has broken it. That failure also carries a second mark, that the subject threw (`isSubjectThrow`), and `runChecks` gives it as `threw` on the result.
  - Anything else the check meets is the harness's own and stops the run (HarnessError) when a fault or a rewrite is judged: a lookup the harness gets wrong, a fixture it cannot build, a callback or store of the harness that throws or is malformed (`harnessOwn`, `harnessStore`), a record of another shape. A call that failed this way is never credited to the fault.
  - `runChecks` runs a list of checks and gives { id, name, ok, kind, threw, detail } for each: `kind` is null for a pass, 'assertion' for a verdict or the failure of an adapter and 'error' for any other exception; `threw` is true when that failure is a call of the code under test that threw. `judged` throws a HarnessError for any 'error' and gives the failed results otherwise; `caughtBy` and `caughtAll` say whether the checks named for a fault failed by assertion.
  - A fault is never credited by a crash of the code under test. When the checks `caughtBy` or `caughtAll` would credit a fault with failed only because a call of the code under test threw, the fault crashes the subject instead of changing a value a check reads: that is a HarnessError that names the fault and the throw, and it stops the run, unless the fault declares that a throw is how it is caught (`{ throws: true }`). Results not made by `runChecks` carry no `threw` and are judged as assertions.
  - An observation of scripts/lib/browser-observe.js that carries a failure of the observation itself (the context did not open or close, the work threw) is `unobserved` even when a value is there: what the page showed cannot be trusted, and nothing is credited with it. An error the page raised that the check did not name stays behaviour, judged by the checks.

  Checked by scripts/check-fault-credit.js.
*/
const rawAssert = require('./bounded-assert')
const { HarnessError } = require('./browser-observe')

const MARK = Symbol('the failure of a check')
const THREW = Symbol('a call of the code under test that threw')

const marked = (error) => {
  if (error instanceof rawAssert.AssertionError) {
    error[MARK] = true
  }

  return error
}

const isMarked = (error) => Boolean(error) && error[MARK] === true

// Whether a failure is the one an adapter made of a call of the code under test that threw or rejected.
const isSubjectThrow = (error) => isMarked(error) && error[THREW] === true

// The failure of a check, marked, with what was thrown (when it was something) in `original`, for a check whose contract is to throw.
const failure = (message, original) => {
  const error = marked(new rawAssert.AssertionError({ message }))

  if (original !== undefined) {
    error.original = original
  }

  return error
}

const settled = (result) => (result && typeof result.then === 'function' ? result.then((value) => value, (error) => { throw marked(error) }) : result)

// The assertion helper of the checks: every failure of one of its functions carries the mark.
const assert = Object.fromEntries(Object.entries(rawAssert).map(([name, member]) => [name, typeof member === 'function' && name !== 'AssertionError' ? (...args) => {
  try {
    return settled(member(...args))
  } catch (error) {
    throw marked(error)
  }
} : member]))

// What the code under test returned is read through here, the getters of what it returned included, so that a getter that throws is the failure of the call and not of the check.
const readAll = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return value
  }

  seen.add(value)

  if (value instanceof Map) {
    value.forEach((item, key) => { readAll(key, seen); readAll(item, seen) })
  } else if (value instanceof Set) {
    value.forEach((item) => readAll(item, seen))
  } else {
    Object.keys(value).forEach((key) => readAll(value[key], seen))
  }

  return value
}

let entered = 0

// A call of the code under test: what it returns (read whole when it is the outermost call and `read` is on), or a failure marked as the check's that names the call and says that the subject threw. A HarnessError and a failure already marked pass as they are.
const through = (label, call, { read = true } = {}) => {
  const fail = (error) => {
    if (error instanceof HarnessError || isMarked(error)) {
      throw error
    }

    const thrown = failure(`${label} threw ${error && error.name ? error.name : 'a value that is no error'}: ${error && error.message ? error.message : error}`, error)

    thrown[THREW] = true
    throw thrown
  }

  entered++

  try {
    const result = call()

    return result && typeof result.then === 'function' ? Promise.resolve(result).then((value) => (read ? readAll(value) : value)).catch(fail) : read && entered === 1 ? readAll(result) : result
  } catch (error) {
    return fail(error)
  } finally {
    entered--
  }
}

// A piece of the harness that the code under test calls back into: what it throws or rejects with is the harness's, never the code's.
const harnessOwn = (piece) => (...args) => {
  const own = (error) => {
    throw error instanceof HarnessError ? error : new HarnessError(`a callback of the harness threw: ${error && error.message ? error.message : error}`)
  }

  try {
    const result = piece(...args)

    return result && typeof result.then === 'function' ? result.then((value) => value, own) : result
  } catch (error) {
    return own(error)
  }
}

// Where the page's own code runs and where the harness's does, for scripts/lib/page-loader.js `instantiate`.
const boundary = { subject: through, harness: (call) => harnessOwn(call)() }

// The functions of a module of the code under test, each behind `through`; the rest as it is.
const subjectModule = (mod, noun = 'utility') => Object.fromEntries(Object.keys(mod).map((name) => [name, typeof mod[name] === 'function' ? (...args) => through(`the ${noun} ${name}`, () => mod[name](...args)) : mod[name]]))

const kindName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

// A store the harness gives the page: every read of it and every call into it is the harness's, so a getter, a dispatch or a function it hands over that throws stops the run, and a store whose parts are not what the page reads them as (`shape`: the kinds each named getter may have, among 'function', 'object', 'number', 'string', 'boolean', 'array', 'null', 'undefined') stops it too, instead of showing up as a failure of the page that reads them. The members of the getters named in `raw` are handed over as they are (the database, whose failures are data the page has to handle).
const harnessStore = (store, shape = {}, { raw = [] } = {}) => {
  const read = (call) => harnessOwn(call)()
  const need = (value, kinds, what) => {
    if (!kinds.includes(kindName(value))) {
      throw new HarnessError(`the store's ${what} is ${kindName(value)}; the page reads it as ${kinds.join(' or ')}`)
    }

    return value
  }
  const owned = (value) => (typeof value === 'function' ? harnessOwn(value) : value && Object.getPrototypeOf(value) === Object.prototype ? new Proxy(value, { get: (target, key) => (typeof target[key] === 'function' ? harnessOwn(target[key].bind(target)) : target[key]) }) : value)
  const getters = new Proxy({}, {
    get: (_target, key) => read(() => {
      const value = need(store.getters, ['object'], 'getters')[key]

      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(shape, key)) {
        need(value, shape[key], `getter ${key}`)
      }

      return raw.includes(key) ? value : owned(value)
    }),
    has: (_target, key) => read(() => key in need(store.getters, ['object'], 'getters')),
  })

  return new Proxy({}, {
    get: (_target, key) => {
      if (key === 'getters') {
        return getters
      }

      if (key === 'state') {
        return read(() => need(store.state, ['object'], 'state'))
      }

      if (key === 'dispatch' || key === 'commit') {
        return (...args) => read(() => { need(store[key], ['function'], key); return store[key](...args) })
      }

      return read(() => store[key])
    },
  })
}

// How a check ended: 'assertion' when what it threw carries the mark (its own verdict, or the failure of a call that an adapter named), 'error' for anything else.
const kindOf = (error) => (isMarked(error) ? 'assertion' : 'error')

// The results of a list of checks `{ id, name, run }` over `ctx`: { id, name, ok, kind, threw, detail }, `kind` being null for a pass and `threw` true when the check failed because a call of the code under test threw. A HarnessError a check throws is not a result, and stops the run.
const runChecks = async (list, ctx) => {
  const out = []

  for (const item of list) {
    try {
      await item.run(ctx)
      out.push({ id: item.id, name: item.name, ok: true, kind: null, threw: false, detail: '' })
    } catch (error) {
      if (error instanceof HarnessError) {
        throw error
      }

      out.push({ id: item.id, name: item.name, ok: false, kind: kindOf(error), threw: isSubjectThrow(error), detail: process.env.CHECK_VERBOSE ? String(error && error.message).slice(0, 1500) : String(error && error.message).split('\n')[0] })
    }
  }

  return out
}

// The failed results of the checks over a fault or a rewrite. An exception that is no marked assertion (`error`) says nothing about what was planted: it is a defect of the harness, told as one, and nothing is credited with it.
const judged = (results, what = 'a fault or a rewrite') => {
  const broken = results.filter((result) => result.kind === 'error')

  if (broken.length) {
    throw new HarnessError(`a check ended in an exception of its own while ${what} was judged: ${broken.map((result) => `${result.id}: ${result.detail}`).join('; ')}`)
  }

  return results.filter((result) => !result.ok)
}

// A fault whose credit rests on calls of the code under test that threw (`thrown`, the failed results of them) crashed the subject rather than changed a value a check reads: a HarnessError naming the fault and the throws, unless the fault declares that a throw is how it is caught.
const creditedByThrow = (thrown, { name = 'a fault', throws = false }) => {
  if (!throws) {
    throw new HarnessError(`the fault '${name}' is caught only by a call of the code under test that threw, not by a value a check read: ${thrown.map((result) => `${result.id}: ${result.detail}`).join('; ')}`)
  }

  return true
}

// A fault is caught when one of the checks named for it failed by assertion, and by assertion only. When those that did all failed because a call of the code under test threw, see `creditedByThrow`. `fault` is { name, throws }: the fault's name, and whether a throw is how it is caught.
const caughtBy = (failed, ids, fault = {}) => {
  const named = failed.filter((result) => ids.includes(result.id) && result.kind === 'assertion')

  return named.some((result) => !result.threw) || (named.length > 0 && creditedByThrow(named, fault))
}

// A fault is caught when every check of the results (the ones named for it) failed by assertion. When any of them failed because a call of the code under test threw, see `creditedByThrow`.
const caughtAll = (results, fault = {}) => {
  if (!(results.length > 0 && results.every(({ kind }) => kind === 'assertion'))) {
    return false
  }

  const thrown = results.filter((result) => result.threw)

  return thrown.length === 0 || creditedByThrow(thrown, fault)
}

// What a fault that is not caught says: the checks that still hold, or the ones that failed by no assertion.
const notCaught = (results) => `these checks do not fail by an assertion: ${results.filter(({ kind }) => kind !== 'assertion').map(({ id }) => id).join(', ') || 'none was named'}`

// The observation itself failed (the context did not open or close, the work threw), as opposed to a page that raised errors no check named: when only the page's unexpected errors failed the observation, `error` is the line that counts them and nothing else.
const infrastructureFailure = (seen) => seen.error !== null && seen.error !== `the page raised ${seen.unexpected.length} unexpected error${seen.unexpected.length === 1 ? '' : 's'}, the first: ${seen.unexpected[0]}`

// An observation with no screen to judge: the work gave no value, or the observation failed in itself even where a value is there.
const unobserved = (seen) => seen.value === null || infrastructureFailure(seen)

module.exports = { MARK, marked, isMarked, isSubjectThrow, failure, assert, readAll, through, harnessOwn, harnessStore, boundary, subjectModule, kindOf, runChecks, judged, caughtBy, caughtAll, notCaught, infrastructureFailure, unobserved }
