// One runner for every browser observation a check suite makes. A spec opens the page once, is watched by scripts/lib/browser-observe.js (page errors, console errors including those Vue catches, failed requests and the step it reached), and gives back a value; the runner runs a bounded number of specs at a time, keeps the results in the order the specs were declared, bounds each spec by a deadline, and never lets one spec's failure or hang stop the others.
//
// The page server is the other half: a process may start one (scripts/lib/page-server.js keeps the save it was loaded for), so the runner starts one only when the caller gives no endpoint and no server, and stops what it started. A browser and an endpoint are injectable, which is what lets a suite test this runner in-process with scripts/lib/pretend-browser.js; a suite that reads a real page passes neither, or passes its own already-started server.
//
// const { runE2e, workersOf } = require('./lib/e2e-runner')
// const results = await runE2e([
//   { key: 'colonies', name: 'the colony list shows one row for each colony', route: '/colonies', run: async ({ page, read }) => read.rows('data-colony') }
// ], { save: 'AuroraDB.db', workers: 3 })
// const failed = results.filter(({ ok }) => !ok)

const os = require('os')
const { observe } = require('./browser-observe')

const DEFAULT_WORKERS = 3
const DEFAULT_LIMIT = 120000
const TIMED_OUT = Symbol('the spec passed its deadline')

// How many specs may open a page at once. A width is a positive integer, never more than the processors this machine gives a process; the default keeps three, because a browser costs far more than a check's own work.
const cores = () => Math.max(1, (os.cpus() || []).length)

const workersOf = (width) => {
  if (width === undefined || width === null) {
    return Math.min(DEFAULT_WORKERS, cores())
  }

  const wanted = Number(width)

  if (!Number.isInteger(wanted) || wanted < 1) {
    throw new Error(`a run width is a positive integer, not ${width}`)
  }

  return Math.min(wanted, cores())
}

const limitOf = (limit) => {
  if (limit === undefined || limit === null) {
    return DEFAULT_LIMIT
  }

  const wanted = Number(limit)

  if (!Number.isInteger(wanted) || wanted < 1) {
    throw new Error(`a spec deadline is a positive number of milliseconds, not ${limit}`)
  }

  return wanted
}

const BOUND = Symbol('the close of a page did not settle')
const CLOSE_LIMIT = 2000

// A close that never settles must not hold the lane: it is raced against a bound, and a close that times out counts as a page not closed.
const closeWithin = async (context, limit) => {
  let timer = null
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve(BOUND), limit) })

  try {
    const outcome = await Promise.race([context.close(), bound])

    if (outcome === BOUND) {
      throw new Error('the close of the page did not settle')
    }
  } finally {
    clearTimeout(timer)
  }
}

// One spec, watched and bounded. A spec is `{ key, name, route, expected?, run }`: `run` receives `{ page, step, base, route }` and its value is the result's `value`. Nothing a spec does is thrown out of here: a throw, a page error and a missed deadline are all findings about that spec, and the others still run.
const one = async (spec, browser, base, limit, opened) => {
  const made = []
  let abandoned = false
  const watched = {
    ...browser,
    newContext: async (options) => {
      const context = await browser.newContext(options)

      opened.contexts += 1

      // The spec was given up while this page was opening: it is closed here rather than handed to work that will not be watched, so a late context can neither run the abandoned spec nor count against the next one's width.
      if (abandoned) {
        await closeWithin(context, CLOSE_LIMIT).catch(() => {})

        throw new Error('the spec was given up while its page was opening')
      }

      made.push(context)

      return context
    },
  }
  const seen = observe(watched, async ({ page, step }) => spec.run({ page, step, base, route: spec.route }), { expected: spec.expected || [] })
  let timer = null
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), limit) })

  let outcome = null

  try {
    outcome = await Promise.race([seen, deadline])
  } finally {
    clearTimeout(timer)
  }

  if (outcome === TIMED_OUT) {
    // An abandoned spec keeps awaiting its own work: its page is closed here, so it never counts against the width of the next spec. The work it may still do is why a spec's own steps must not touch state a later spec reads, and why `closed` counts closes that returned rather than closes that were asked for.
    abandoned = true

    let closed = 0

    for (const context of made) {
      try {
        await closeWithin(context, CLOSE_LIMIT)
        closed += 1
      } catch {
        // A page that will not close is reported as leaked below, because the lane is reused and the next spec must not be told the width was kept when it was not.
      }
    }

    return { key: spec.key, name: spec.name, ok: false, timedOut: true, threw: false, detail: `the spec passed its ${limit} ms deadline`, phase: 'bounded by its deadline', value: null, error: null, base, contexts: opened.contexts, closed, leaked: made.length - closed }
  }

  return { key: spec.key, name: spec.name, ok: !outcome.error, timedOut: false, threw: Boolean(outcome.error), detail: outcome.error || '', phase: outcome.phase, value: outcome.value, error: outcome.error, base, contexts: opened.contexts, closed: 0, leaked: 0 }
}

const runE2e = async (specs, { save, root, server = null, chrome = null, base = null, workers = null, limit = null } = {}) => {
  if (!Array.isArray(specs) || !specs.length) {
    throw new Error('a run needs at least one spec')
  }

  if (specs.some((spec) => !spec || typeof spec.key !== 'string' || !spec.key)) {
    throw new Error('every spec needs a key')
  }

  if (new Set(specs.map((spec) => spec.key)).size !== specs.length) {
    throw new Error('two specs share a key')
  }

  if (specs.some((spec) => typeof spec.run !== 'function')) {
    throw new Error('every spec needs a run')
  }

  const width = workersOf(workers)
  const perSpec = limitOf(limit)
  const started = []
  let address = base

  try {
    if (!address) {
      const { startPageServer } = require('./page-server')
      const pageServer = server || (await startPageServer({ save, root }))

      if (!server) {
        started.push(() => pageServer.stop())
      }

      address = pageServer.url
    }

    const browser = chrome || (await require('playwright').chromium.launch())

    if (!chrome) {
      started.push(() => browser.close())
    }

    const results = new Array(specs.length)
    const opened = specs.map(() => ({ contexts: 0 }))
    let next = 0
    const lane = async () => {
      for (;;) {
        const index = next
        next += 1

        if (index >= specs.length) {
          return
        }

        results[index] = await one(specs[index], browser, address, perSpec, opened[index])
      }
    }

    await Promise.all(Array.from({ length: Math.min(width, specs.length) }, lane))

    return results
  } finally {
    for (const stop of started.reverse()) {
      try {
        await stop()
      } catch {
        // A close that fails does not change what the specs found.
      }
    }
  }
}

module.exports = { runE2e, workersOf, limitOf, DEFAULT_WORKERS, DEFAULT_LIMIT }
