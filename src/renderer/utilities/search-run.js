// The lifecycle of a bounded search: one run of a search generator with a descriptor, a budget, a status and a reason it ended, so what was explored is always stated and a run that is no longer wanted never replaces the one that is.
//
// A search is a generator that, about every slice of its own work, yields `{ progress, counts, snapshot }` and returns its result, which carries `counts` and `termination`. It also yields wherever the `pace` it was given says its time is up (`pace.expired()`, looked at at every point where it could otherwise run long: between candidates, between the passes that size a package, and inside the table builds and package walks), so the work between two yields is bounded in work and, up to one such point, in time. `counts` is `{ total, evaluated, pruned, unexplored, feasible, retained, prunedBy }`: the candidates of the stated domain (`total`, null when the domain is too large to count exactly), those evaluated, those dropped without evaluation by a limit that proves them out (`pruned`, by reason in `prunedBy`), those not reached (`unexplored`: `total - evaluated - pruned`), those that meet every target (`feasible`) and the distinct results the search holds (`retained`). `pruned`, `unexplored` and `prunedBy` are null for a domain whose total cannot be counted exactly. `snapshot()` is the result so far, in the shape of the returned result with `termination` null. A search that stops at the candidate budget it was given returns `termination: 'candidate-budget'`; one that explored its whole domain returns 'exhausted'.
//
// A run steps the generator for a slice of elapsed time at a time (`advance`), so the caller hands the browser a turn between slices. It ends in one of the statuses below: 'complete' (the whole domain explored, whatever the output keeps of it), 'truncated' (a candidate or time budget ran out first), 'cancelled' (asked to stop), 'invalidated' (its input or the save changed) or 'failed'. Every status but 'complete' is incomplete, and the outcome of an incomplete run keeps the best result so far, labelled as such. A run that is invalidated is stale: its outcome is kept for inspection but a slot never publishes it.

export const RUN_STATUS = Object.freeze({ RUNNING: 'running', COMPLETE: 'complete', TRUNCATED: 'truncated', CANCELLED: 'cancelled', INVALIDATED: 'invalidated', FAILED: 'failed' })

export const TERMINATION = Object.freeze({ EXHAUSTED: 'exhausted', CANDIDATE_BUDGET: 'candidate-budget', TIME_BUDGET: 'time-budget', CANCELLED: 'cancelled', INPUT_CHANGED: 'input-changed', SAVE_CHANGED: 'save-changed', CLOSED: 'closed', ERROR: 'error' })

// The reasons a running run is invalidated for.
export const INVALIDATIONS = Object.freeze([TERMINATION.INPUT_CHANGED, TERMINATION.SAVE_CHANGED, TERMINATION.CLOSED])

// How long a run holds the thread: a slice of `sliceMs`, then the one step of the search that crosses it, so input and a cancel are served within `budgetMs`. The check scripts assert the work a step is bounded to; scripts/bench-tank-packing.js measures the milliseconds against this budget.
export const RESPONSIVENESS = Object.freeze({ sliceMs: 12, budgetMs: 50 })

const STATUS_OF = Object.freeze({
  [TERMINATION.EXHAUSTED]: RUN_STATUS.COMPLETE,
  [TERMINATION.CANDIDATE_BUDGET]: RUN_STATUS.TRUNCATED,
  [TERMINATION.TIME_BUDGET]: RUN_STATUS.TRUNCATED,
  [TERMINATION.CANCELLED]: RUN_STATUS.CANCELLED,
  [TERMINATION.INPUT_CHANGED]: RUN_STATUS.INVALIDATED,
  [TERMINATION.SAVE_CHANGED]: RUN_STATUS.INVALIDATED,
  [TERMINATION.CLOSED]: RUN_STATUS.INVALIDATED,
  [TERMINATION.ERROR]: RUN_STATUS.FAILED,
})

// The statuses whose outcome a slot publishes: a run that explored what it was asked to, stopped at a budget, was cancelled, or failed (the caller reports the error).
const PUBLISHED = new Set([RUN_STATUS.COMPLETE, RUN_STATUS.TRUNCATED, RUN_STATUS.CANCELLED, RUN_STATUS.FAILED])

const defaultNow = () => performance.now()

// The pace of a search that is not run in slices: its time is never up.
export const UNPACED = Object.freeze({ expired: () => false })

// A 53-bit hash of a text, to name a run by what it was given (the same input, domain and budget give the same name).
const hash = (text) => {
  let first = 0xdeadbeef
  let second = 0x41c6ce57

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)

    first = Math.imul(first ^ code, 2654435761)
    second = Math.imul(second ^ code, 1597334677)
  }

  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909)
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909)

  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(16)
}

const emptyCounts = (total) => Object.freeze({ total, evaluated: 0, pruned: total === null ? null : 0, unexplored: total, feasible: 0, retained: 0, prunedBy: total === null ? null : Object.freeze({}) })

// A run of a search for `input`, a plain serialisable object the run keeps as it was given. `search` is a function that is given the run's `pace` and returns the generator of the protocol above. `domain` is `{ signature, total, ... }`, what the run explores, from the search's own kind; `budget` is `{ candidates, ms }`, each null for no limit (the search stops itself at `candidates`; the run stops it at `ms` elapsed since the first `advance`, and the pace is up at that time too). `now` is the clock in milliseconds.
export const createRun = ({ kind, input, domain, budget = {}, search, now = defaultNow }) => {
  const limits = Object.freeze({ candidates: budget.candidates === undefined ? null : budget.candidates, ms: budget.ms === undefined ? null : budget.ms })
  const inputKey = hash(JSON.stringify(input))
  const descriptor = Object.freeze({ kind, id: `${kind}:${hash(`${inputKey}|${domain.signature}|${JSON.stringify(limits)}`)}`, input, inputKey, domain, budget: limits, responsiveness: RESPONSIVENESS })

  let status = RUN_STATUS.RUNNING
  let reason = null
  let last = null
  let final = null
  let result = null
  let failure = null
  let started = null
  let ended = null
  let deadline = Infinity

  const pace = { expired: () => now() >= deadline }
  const iterator = search(pace)

  const settle = (why) => {
    reason = why
    status = STATUS_OF[why]
    ended = now()

    if (why === TERMINATION.ERROR) {
      return status
    }

    if (final) {
      result = final
    } else if (last) {
      result = last.snapshot()
      iterator.return()
    } else {
      iterator.return()
    }

    return status
  }

  const run = {
    descriptor,

    get status() {
      return status
    },

    get running() {
      return status === RUN_STATUS.RUNNING
    },

    get progress() {
      return status === RUN_STATUS.COMPLETE ? 1 : last ? last.progress : 0
    },

    // Steps the search until `sliceMs` has elapsed, it ends or the time budget runs out, the search yielding at the pace's deadline (the end of the slice or of the budget, the sooner) wherever it could otherwise run on. Returns the status. A run that has ended does nothing.
    advance(sliceMs = RESPONSIVENESS.sliceMs) {
      if (status !== RUN_STATUS.RUNNING) {
        return status
      }

      if (started === null) {
        started = now()
      }

      const end = now() + sliceMs

      deadline = limits.ms === null ? end : Math.min(end, started + limits.ms)

      try {
        for (;;) {
          const step = iterator.next()

          if (step.done) {
            final = step.value

            return settle(final.termination)
          }

          last = step.value

          const time = now()

          if (limits.ms !== null && time - started >= limits.ms) {
            return settle(TERMINATION.TIME_BUDGET)
          }

          if (time >= end) {
            return status
          }
        }
      } catch (error) {
        failure = error

        return settle(TERMINATION.ERROR)
      }
    },

    // Stops the run where it is, keeping the best result so far as an incomplete outcome.
    cancel() {
      return status === RUN_STATUS.RUNNING ? settle(TERMINATION.CANCELLED) : status
    },

    // Ends the run because what it was run for changed (`reason` one of INVALIDATIONS). Its outcome is stale and is never published.
    invalidate(why = TERMINATION.INPUT_CHANGED) {
      if (!INVALIDATIONS.includes(why)) {
        throw new TypeError(`Unknown invalidation: ${why}`)
      }

      return status === RUN_STATUS.RUNNING ? settle(why) : status
    },

    // The run as it stands: { descriptor, status, incomplete, stale, termination, progress, counts, elapsedMs, error, result }. `result` is the search's result when it finished, its best so far when the run ended early (and while it runs), and null before it has produced one or when it failed.
    outcome() {
      const current = status === RUN_STATUS.RUNNING ? (last ? last.snapshot() : null) : result
      const elapsed = started === null ? 0 : (ended === null ? now() : ended) - started

      return Object.freeze({
        descriptor,
        status,
        incomplete: status !== RUN_STATUS.COMPLETE,
        stale: status === RUN_STATUS.INVALIDATED,
        termination: reason,
        progress: run.progress,
        counts: current ? current.counts : last ? last.counts : emptyCounts(domain.total),
        elapsedMs: elapsed,
        error: failure ? failure.message : null,
        result: current,
      })
    },
  }

  return run
}

// The one run whose result a caller keeps. `start` makes a run the current one and invalidates the run it replaces; `publish` accepts a run's outcome only while it is the current one and has a status worth keeping, so a run that has been replaced or invalidated cannot overwrite what is kept.
export const createRunSlot = () => {
  let current = null
  let published = null

  const slot = {
    get current() {
      return current
    },

    // The outcome last published, or null.
    get published() {
      return published
    },

    isCurrent(run) {
      return current === run
    },

    start(run, why = TERMINATION.INPUT_CHANGED) {
      slot.invalidate(why)
      current = run

      return run
    },

    // Invalidates the current run, if it is still running, and leaves no run current.
    invalidate(why = TERMINATION.INPUT_CHANGED) {
      if (current) {
        current.invalidate(why)
        current = null
      }
    },

    // Asks the current run to stop, keeping it current so its incomplete outcome can be published.
    cancel() {
      return current ? current.cancel() : null
    },

    // Keeps the run's outcome and returns it, or returns null when the run is not the current one or its status is not one to keep.
    publish(run) {
      if (current !== run || !PUBLISHED.has(run.status)) {
        return null
      }

      published = run.outcome()
      current = null

      return published
    },

    // Forgets what was published (the input can no longer be searched).
    clear() {
      published = null
    },
  }

  return slot
}

// The counts as one list, for a cell of data: each figure written by `format`, 'unknown' where the domain is too large to count exactly.
export const countText = (counts, format = String) => {
  const figure = (value) => (value === null ? 'unknown' : format(value))

  return `${format(counts.evaluated)} of ${figure(counts.total)} candidates evaluated, ${figure(counts.pruned)} dropped without evaluation, ${figure(counts.unexplored)} not explored, ${format(counts.feasible)} meet the targets`
}

// What a run explored, in words for a caption: one string. `format` writes a figure (the page's number format).
export const describeOutcome = (outcome, format = String) => {
  const { counts, status, termination, descriptor } = outcome
  const explored = counts.total === null ? `${format(counts.evaluated)} candidates evaluated, an unknown number dropped without evaluation or not explored (the domain is too large to count exactly)` : `${format(counts.evaluated)} of ${format(counts.total)} candidates evaluated${counts.pruned ? `, ${format(counts.pruned)} dropped without evaluation by limits that rule them out` : ''}`
  const unexplored = counts.unexplored === null ? '' : counts.unexplored > 0 ? `, ${format(counts.unexplored)} not explored` : ''
  const partial = 'The sets are the best of the part explored, not of the whole domain.'

  if (status === RUN_STATUS.COMPLETE) {
    return `Explored the whole domain: ${explored}, ${format(counts.feasible)} meet the targets.`
  }

  if (status === RUN_STATUS.TRUNCATED) {
    const budget = termination === TERMINATION.CANDIDATE_BUDGET ? `its budget of ${format(descriptor.budget.candidates)} candidates` : `its budget of ${format(descriptor.budget.ms / 1000)} seconds`

    return `Stopped at ${budget}: ${explored}${unexplored}, ${format(counts.feasible)} meet the targets. ${partial}`
  }

  if (status === RUN_STATUS.CANCELLED) {
    return `Stopped before it finished: ${explored}${unexplored}, ${format(counts.feasible)} meet the targets. ${partial}`
  }

  if (status === RUN_STATUS.INVALIDATED) {
    return `Discarded because the ${termination === TERMINATION.SAVE_CHANGED ? 'save' : termination === TERMINATION.CLOSED ? 'page' : 'input'} changed: ${explored}${unexplored}.`
  }

  if (status === RUN_STATUS.FAILED) {
    return `Failed: ${outcome.error}`
  }

  return `Running: ${explored}${unexplored}.`
}
