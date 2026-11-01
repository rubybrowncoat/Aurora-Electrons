/*
  Checks the one runner every browser observation goes through (scripts/lib/e2e-runner.js): that it never opens more pages at once than its width, that each spec is run once and opens one page, that a failing spec is reported as a finding while the others still run, that a spec past its deadline is reported as a timeout rather than hanging the run, that the results keep the order the specs were declared, and that every spec reads the endpoint the caller gave.

  bun scripts/check-e2e-runner.js [--no-mutations] [--only=<id>,<id>] [--detail]

  The browser here is scripts/lib/pretend-browser.js, so the runner is proved in-process: every page call resolves at once and no page is loaded. Every fault is a rewrite of scripts/lib/e2e-runner.js in a private copy under .check-runs. Only a named check that fails on an observed value credits it; a throw, a timeout, a missing marker or a nonzero child exit is an uncredited harness failure.
*/
const fs = require('fs')
const path = require('path')
const ROOT = process.env.E2E_RUNNER_ROOT || path.resolve(__dirname, '..')
const { assert, runChecks, judged, caughtBy } = require(path.join(ROOT, 'scripts/lib/fault-credit'))
const { patched } = require(path.join(ROOT, 'scripts/lib/mutant-source'))
const { runChild } = require(path.join(ROOT, 'scripts/lib/check-pool'))
const { mutating, refusePlanting } = require(path.join(ROOT, 'scripts/lib/no-mutations'))
const { pretendBrowser } = require('./lib/pretend-browser')
const { runE2e, workersOf } = require('./lib/e2e-runner')

const WORK = path.join(ROOT, '.check-runs')
const PREFIX = '@@e2e-runner '
const DETAIL = process.argv.includes('--detail')
const BASE = 'http://pretend.test/'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A spec that holds its lane for a while and returns its own key.
const holding = (key, ms, live) => ({
  key,
  name: `the spec ${key}`,
  run: async () => {
    live.now += 1
    live.peak = Math.max(live.peak, live.now)
    await wait(ms)
    live.now -= 1
    return key
  },
})

const run = (specs, options = {}) => runE2e(specs, { base: BASE, chrome: pretendBrowser(), ...options })

const CHECKS = [
  {
    id: 'width',
    name: 'no more specs open a page at once than the width names, and the width is used',
    run: async () => {
      const live = { now: 0, peak: 0 }
      const results = await run(['a', 'b', 'c', 'd', 'e'].map((key) => holding(key, 15, live)), { workers: 2 })

      assert.equal(results.length, 5, 'the specs run')
      assert.equal(live.peak, 2, 'the pages open at once')
    },
  },
  {
    id: 'once',
    name: 'a spec is run once and opens one page',
    run: async () => {
      const calls = {}
      const specs = ['a', 'b', 'c'].map((key) => ({ key, name: key, run: () => { calls[key] = (calls[key] || 0) + 1; return key } }))
      const results = await run(specs, { workers: 3 })

      assert.deepEqual(calls, { a: 1, b: 1, c: 1 }, 'the calls of each spec')
      assert.deepEqual(results.map((result) => result.contexts), [1, 1, 1], 'the page each spec opened')
    },
  },
  {
    id: 'failure',
    name: 'a failing spec is reported with its own message and the others still run',
    run: async () => {
      const specs = [
        { key: 'good', name: 'a spec that holds', run: () => 'held' },
        { key: 'bad', name: 'a spec that throws', run: () => { throw new Error('the read failed') } },
        { key: 'also', name: 'a spec after it', run: () => 'also held' },
      ]
      const results = await run(specs, { workers: 1 })
      const byKey = Object.fromEntries(results.map((result) => [result.key, result]))

      assert.equal(results.length, 3, 'the specs run')
      assert.equal(byKey.good.ok, true, 'the spec before the failure')
      assert.equal(byKey.bad.ok, false, 'the spec that threw')
      assert.ok(byKey.bad.detail.includes('the read failed'), `the message of the failure: ${byKey.bad.detail}`)
      assert.equal(byKey.also.ok, true, 'the spec after the failure')
    },
  },
  {
    id: 'deadline',
    name: 'a spec past its deadline is a timeout, and the run ends without it',
    run: async () => {
      const specs = [
        { key: 'slow', name: 'a spec past its deadline', run: async () => { await wait(1200); return 'late' } },
        { key: 'quick', name: 'a spec within it', run: () => 'in time' },
      ]
      const started = Date.now()
      const results = await run(specs, { workers: 2, limit: 600 })
      const byKey = Object.fromEntries(results.map((result) => [result.key, result]))

      assert.equal(Date.now() - started < 5000, true, 'the run ended')
      assert.equal(byKey.slow.timedOut, true, 'the spec past the deadline')
      assert.equal(byKey.slow.ok, false, 'a timed out spec is not a pass')
      assert.equal(byKey.quick.ok, true, 'the spec within the deadline')
    },
  },
  {
    id: 'order',
    name: 'the results keep the order the specs were declared, whatever finishes first',
    run: async () => {
      const live = { now: 0, peak: 0 }
      const results = await run(['first', 'second', 'third'].map((key, index) => holding(key, 30 - index * 10, live)), { workers: 3 })

      assert.deepEqual(results.map((result) => result.key), ['first', 'second', 'third'], 'the order of the results')
    },
  },
  {
    id: 'closure',
    name: 'a spec past its deadline has its page closed, so no live page outlives the width',
    run: async () => {
      const live = { now: 0, peak: 0, closed: 0 }
      const page = { on: () => {}, addInitScript: async () => {}, goto: async () => null, evaluate: async () => null, locator: () => ({ click: async () => {}, filter: () => ({ click: async () => {} }) }), getByText: () => ({ click: async () => {} }), close: async () => {} }
      const browser = {
        newContext: async () => {
          live.now += 1
          live.peak = Math.max(live.peak, live.now)
          let open = true

          return { newPage: async () => page, close: async () => { if (open) { open = false; live.now -= 1; live.closed += 1 } } }
        },
      }
      let seenBySecond = null
      const specs = [
        { key: 'slow', name: 'a spec past its deadline', run: () => new Promise(() => {}) },
        { key: 'next', name: 'the spec after it', run: () => { seenBySecond = live.now; return 'ran' } },
      ]
      const results = await runE2e(specs, { base: BASE, chrome: browser, workers: 1, limit: 60 })
      const byKey = Object.fromEntries(results.map((result) => [result.key, result]))

      assert.equal(byKey.slow.timedOut, true, 'the spec past its deadline')
      assert.equal(byKey.slow.closed, 1, 'the page it held, closed at its deadline')
      assert.equal(live.peak, 1, 'the pages open at once')
      assert.equal(seenBySecond, 1, 'the pages open when the next spec began: its own alone')
      assert.equal(live.now, 0, 'the pages open after the run')
    },
  },
  {
    id: 'base',
    name: 'every spec reads the endpoint the caller gave',
    run: async () => {
      const results = await run([{ key: 'a', name: 'a spec', run: () => 'read' }])

      assert.deepEqual(results.map((result) => result.base), [BASE], 'the endpoint of each spec')
    },
  },
  {
    id: 'refuses',
    name: 'a run refuses no spec, a spec without a key, two of one key, and an impossible width',
    run: async () => {
      const refusals = []

      for (const attempt of [
        () => run([]),
        () => run([{ name: 'no key', run: () => 'x' }]),
        () => run([{ key: 'a', name: 'one', run: () => 'x' }, { key: 'a', name: 'two', run: () => 'x' }]),
        () => run([{ key: 'a', name: 'one', run: () => 'x' }], { workers: 0 }),
      ]) {
        try {
          await attempt()
          refusals.push('accepted')
        } catch (error) {
          refusals.push(error.message.slice(0, 40))
        }
      }

      assert.equal(refusals.filter((answer) => answer === 'accepted').length, 0, `the refusals: ${refusals.join(' | ')}`)
      assert.equal(workersOf(2), 2, 'a width within the machine')
    },
  },
]

// Each declaration names only the behavioral check that must reject the rewrite.
const FAULTS = [
  { key: 'no-width', name: 'every spec opens its page at once', file: 'e2e-runner.js', edits: [['Array.from({ length: Math.min(width, specs.length) }, lane)', 'Array.from({ length: specs.length }, lane)']], fails: ['width'] },
  { key: 'run-twice', name: 'each spec is run twice', file: 'e2e-runner.js', edits: [['        results[index] = await one(specs[index], browser, address, perSpec, opened[index])', '        await one(specs[index], browser, address, perSpec, opened[index])\n        results[index] = await one(specs[index], browser, address, perSpec, opened[index])']], fails: ['once'] },
  { key: 'swallow', name: 'a spec that failed is reported as a pass', file: 'e2e-runner.js', edits: [['ok: !outcome.error,', 'ok: true,']], fails: ['failure'] },
  { key: 'no-deadline', name: 'a spec is awaited past its deadline instead of bounded', file: 'e2e-runner.js', edits: [['    outcome = await Promise.race([seen, deadline])', '    outcome = await seen']], fails: ['deadline'] },
  { key: 'reverse', name: 'the results are kept in the reverse of the declared order', file: 'e2e-runner.js', edits: [['        results[index] = await one(specs[index], browser, address, perSpec, opened[index])', '        results[specs.length - 1 - index] = await one(specs[index], browser, address, perSpec, opened[index])']], fails: ['order'] },
  { key: 'wrong-base', name: 'every spec reads an endpoint of the runner instead of the caller', file: 'e2e-runner.js', edits: [['        results[index] = await one(specs[index], browser, address, perSpec, opened[index])', "        results[index] = await one(specs[index], browser, 'http://127.0.0.1:1', perSpec, opened[index])"]], fails: ['base'] },
  { key: 'keep-context', name: 'a timed out spec keeps its page open', file: 'e2e-runner.js', edits: [['        await context.close()', '        void context']], fails: ['closure'] },
]

const faultResults = async (fault) => {
  refusePlanting(fault.name)
  fs.mkdirSync(WORK, { recursive: true })

  const folder = fs.mkdtempSync(path.join(WORK, 'e2e-runner-'))
  const scripts = path.join(folder, 'scripts')

  if (!path.resolve(folder).startsWith(`${path.resolve(WORK)}${path.sep}`)) {
    throw new Error('the runner fixture escaped its workspace')
  }

  try {
    fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true })
    fs.copyFileSync(__filename, path.join(scripts, 'check-e2e-runner.js'))

    // Every library file, so the runner's own imports resolve inside the fixture: only the subject carries the rewrite.
    for (const file of fs.readdirSync(path.join(__dirname, 'lib'))) {
      const source = fs.readFileSync(path.join(__dirname, 'lib', file))
      const text = file === fault.file ? fault.edits.reduce((given, [from, to]) => patched(file, given, from, to), source.toString('utf8')) : source

      fs.writeFileSync(path.join(scripts, 'lib', file), text)
    }

    const run = await runChild(path.join(scripts, 'check-e2e-runner.js'), ['--no-mutations', `--only=${fault.fails.join(',')}`], { env: { E2E_RUNNER_ROOT: ROOT }, limit: 30000 })
    const markers = run.stdout.split(/\r?\n/).filter((line) => line.startsWith(PREFIX))

    if (run.timedOut || markers.length !== 1 || ![0, 1].includes(run.code)) {
      throw new Error(`the runner fault ${fault.key} gave no trustworthy results (code ${run.code}, timedOut ${run.timedOut}): ${run.stderr.slice(0, 500)}`)
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
    throw new Error(`unknown runner case: ${only.join(',')}`)
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
