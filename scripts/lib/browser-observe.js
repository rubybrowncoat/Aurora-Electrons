// One policy for every check that drives a page of the real renderer in a browser: what the page did, and what went wrong while it did it, in a record that has the same shape whether the observation went through or not.
//
// const { observe, validate, failureLine, report } = require('./lib/browser-observe')
// const seen = await observe(browser, async ({ page, step }) => { step('opening the page'); await page.goto(url); return page.evaluate(read) }, { expected: ['the exact text of an error the check names'] })
//
// `observe` opens a context of its own, runs `work({ page, step })` (`step(name)` says where the work is, for the failure that is told afterwards), waits a moment for what the page raises late, closes the context, and returns { value, error, phase, errors, console, failed, unexpected }:
// - value: what `work` returned, or null when it threw;
// - error: null, or why the observation failed: the context did not open or close, `work` threw (the whole message, the call log of a locator included), or the page raised an error the check did not name; when more than one of these happened they are all in it, each cut to its own limit, so that a long message of one never takes the place of another;
// - phase: the last step named;
// - errors: every page error, an exception nothing caught or a rejection nothing handled;
// - console: every console error. Vue catches the exceptions of a handler, a watcher or a render and logs them there, so they are never page errors, and a record without this list would call such a page clean;
// - failed: the requests that failed and the responses with a status of 400 or more, for diagnosis (a failed load that matters is also a console error);
// - unexpected: the page errors and the console errors the check did not name, each prefixed with its kind.
// The lists of messages are for display: a message is cut to 500 characters there. Whether an error is named is decided on the whole message, never on the cut one, and only by an exact match with an entry of `expected`, a list of strings that is copied and checked when the observation starts, so that nothing the caller does to the list or the page afterwards names an error. A part of a message names nothing; a string given in place of the list, or an entry that is not a string, is a HarnessError.
// The record is complete when the work went through as well as when it did not, and an observation with an unexpected renderer error has an `error`: a check names the exact error it expects, or the page raises none.
//
// `validate` throws a HarnessError for a record of another shape: a check that is handed such a record is itself broken, and that is told as a failure of the run, never as a page that failed or a fault that was caught.
const MESSAGE_LIMIT = 4000
const TEXT_LIMIT = 500
const FLUSH = 250

class HarnessError extends Error {
  constructor (message) {
    super(message)
    this.name = 'HarnessError'
  }
}

const clip = (text, size) => String(text).slice(0, size)

const listen = (page, record) => {
  page.on('pageerror', (error) => record.errors.push(String(error.message)))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      record.console.push(message.text())
    }
  })
  page.on('requestfailed', (request) => record.failed.push(`${request.method()} ${clip(request.url(), 200)}: ${request.failure() ? request.failure().errorText : 'failed'}`))
  page.on('response', (response) => {
    if (response.status() >= 400) {
      record.failed.push(`${response.request().method()} ${clip(response.url(), 200)}: ${response.status()}`)
    }
  })
}

const namedList = (expected) => {
  if (!Array.isArray(expected) || expected.some((text) => typeof text !== 'string')) {
    throw new HarnessError('`expected` is a list of the exact messages of the errors the check names; anything else names none')
  }

  return new Set(expected)
}

const observe = async (browser, work, { viewport = { width: 1920, height: 1080 }, expected = [], flush = FLUSH } = {}) => {
  const named = namedList(expected)
  const record = { phase: 'opening the page', errors: [], console: [], failed: [] }
  const problems = []
  let context = null
  let value = null

  try {
    context = await browser.newContext({ viewport })
  } catch (thrown) {
    problems.push(`the context did not open: ${clip(thrown && thrown.message ? thrown.message : thrown, 500)}`)
  }

  if (context) {
    try {
      const page = await context.newPage()

      listen(page, record)
      value = await work({ page, step: (phase) => { record.phase = phase } })
      await page.waitForTimeout(flush)
    } catch (thrown) {
      problems.push(clip(thrown && thrown.message ? thrown.message : thrown, MESSAGE_LIMIT))
    }

    const closing = await context.close().then(() => null, (thrown) => `the context did not close: ${clip(thrown && thrown.message ? thrown.message : thrown, 500)}`)

    if (closing) {
      problems.push(closing)
    }
  }

  const unnamed = [...record.errors.filter((text) => !named.has(text)).map((text) => `page error: ${clip(text, TEXT_LIMIT)}`), ...record.console.filter((text) => !named.has(text)).map((text) => `console error: ${clip(text, TEXT_LIMIT)}`)]

  if (!problems.length && unnamed.length) {
    problems.push(`the page raised ${unnamed.length} unexpected error${unnamed.length === 1 ? '' : 's'}, the first: ${unnamed[0]}`)
  }

  return { value, error: problems.length ? problems.join('\n') : null, phase: record.phase, errors: record.errors.map((text) => clip(text, TEXT_LIMIT)), console: record.console.map((text) => clip(text, TEXT_LIMIT)), failed: record.failed, unexpected: unnamed }
}

// An observation that did not happen, as the record of one: a server that did not start, a child that ended badly.
const failedObservation = (message, phase = 'starting') => ({ value: null, error: clip(message, MESSAGE_LIMIT), phase, errors: [], console: [], failed: [], unexpected: [] })

// An observation that went through and saw nothing wrong, with the value given.
const completedObservation = (value) => ({ value, error: null, phase: 'finished', errors: [], console: [], failed: [], unexpected: [] })

const isStrings = (list) => Array.isArray(list) && list.every((item) => typeof item === 'string')

const validate = (seen, label = 'the observation') => {
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) {
    throw new HarnessError(`${label} is not a record of an observation`)
  }

  const wrong = []

  if (seen.error !== null && typeof seen.error !== 'string') {
    wrong.push('error')
  }

  if (typeof seen.phase !== 'string') {
    wrong.push('phase')
  }

  for (const key of ['errors', 'console', 'failed', 'unexpected']) {
    if (!isStrings(seen[key])) {
      wrong.push(key)
    }
  }

  if (seen.value !== null && (typeof seen.value !== 'object' || Array.isArray(seen.value))) {
    wrong.push('value')
  }

  if (!wrong.length && seen.error === null && (seen.value === null || seen.unexpected.length)) {
    wrong.push('value and error disagree')
  }

  if (wrong.length) {
    throw new HarnessError(`${label} is not a whole record of an observation (${wrong.join(', ')})`)
  }

  return seen
}

// What a failed observation says in one line, as a check's detail shows only the first line of a message.
const failureLine = (seen) => `${seen.phase ? `at ${seen.phase}: ` : ''}${String(seen.error).split('\n')[0]}`

// The lines of a list of reports, each once with how many times it came (a handler that throws on every click reports the same error on each).
const list = (items) => {
  const counts = new Map()

  items.forEach((item) => counts.set(String(item), (counts.get(String(item)) || 0) + 1))

  return counts.size ? [...counts].map(([item, count]) => `\n    ${count > 1 ? `(${count} times) ` : ''}${item.replace(/\n/g, '\n    ')}`).join('') : ' none'
}

// The whole record of a failed observation, printed where the failure is first met: the phase, the message with the call log, and what the page and the browser reported.
const describe = (label, seen) => `BROWSER ${label} did not get through\n  phase: ${seen.phase}\n  error: ${String(seen.error).replace(/\n/g, '\n    ')}\n  page errors:${list(seen.errors)}\n  console errors:${list(seen.console)}\n  failed requests:${list(seen.failed)}`

const report = (label, seen) => {
  if (seen.error !== null) {
    console.error(describe(label, seen))
  }
}

module.exports = { observe, validate, failedObservation, completedObservation, failureLine, describe, report, HarnessError }
