/*
  Checks scripts/lib/browser-observe.js, the one policy of the checks that drive a page of the real renderer in a browser: what the page did and what went wrong while it did it, in a record of the same shape whether the observation went through or not.

  Run: bun scripts/check-browser-observe.js [--no-mutations]

  Each case drives a page served from memory in Chromium (no application, no database) and looks at the record `observe` returns:
  - a quiet page gives a whole record with no error;
  - an exception nothing caught, a rejection nothing handled and a console error (where a framework logs the exceptions it catches in a handler, a watcher or a render) each make the observation fail, with the error kept, also when the work went through and its value is there;
  - an error the check names, by its exact text, is kept and does not fail the observation, and another error still does; the whole text decides, so a message of more than 500 characters is named by all of it (and one that only starts like it is not), a part of a message names nothing, the names are a list of strings (a string or another entry is a HarnessError) and the list is the one at the start of the observation;
  - an error raised just after the work ended is seen;
  - work that throws gives the whole message (the lines after the first included), the last step named, the value null and what the page raised before;
  - a failed request and a response of 400 or more are kept;
  - a context that does not close, or does not open, fails the observation, and work that failed together with a context that did not close tells both;
  - one observation never sees the errors of another;
  - `validate` accepts the records the helper makes and throws a HarnessError for every other shape.
  Each planted fault rewrites one line of a copy of the helper and must make a named case fail on an assertion.

  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { patched } = require('./lib/mutant-source')

const HELPER = path.join(__dirname, 'lib', 'browser-observe.js')
const HOST = 'http://observe.test'
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

// A page served from memory at HOST: the index is `html`, a path of `routes` is its answer ({ status, contentType, body }) or 'abort', any other path is a 404.
const serve = async (page, html, routes = {}) => {
  await page.route(`${HOST}/**`, (route) => {
    const { pathname } = new URL(route.request().url())
    const answer = pathname === '/' ? { status: 200, contentType: 'text/html', body: html } : routes[pathname] || { status: 404, contentType: 'text/plain', body: 'missing' }

    return answer === 'abort' ? route.abort() : route.fulfill(answer)
  })
  await page.goto(`${HOST}/`)
}

const watching = (lib, browser, html, options, routes) => lib.observe(browser, async ({ page, step }) => {
  step('serving the page')
  await serve(page, html, routes)

  return { served: true }
}, options)

const CASES = {
  quiet: async (lib, browser) => {
    const seen = await watching(lib, browser, '<p>fine</p>')

    assert.deepEqual(seen, { value: { served: true }, error: null, phase: 'serving the page', errors: [], console: [], failed: [], unexpected: [] })
    assert.equal(lib.validate(seen), seen)
  },

  uncaught: async (lib, browser) => {
    const seen = await watching(lib, browser, '<script>setTimeout(() => { throw new Error("thrown later") }, 10)</script>')

    assert.deepEqual(seen.errors, ['thrown later'])
    assert.deepEqual(seen.unexpected, ['page error: thrown later'])
    assert.ok(seen.error && seen.error.includes('thrown later'), String(seen.error))
    assert.deepEqual(seen.value, { served: true })
    lib.validate(seen)
  },

  rejection: async (lib, browser) => {
    const seen = await watching(lib, browser, '<script>Promise.reject(new Error("never handled"))</script>')

    assert.ok(seen.errors.some((text) => text.includes('never handled')), JSON.stringify(seen.errors))
    assert.ok(seen.error && seen.error.includes('never handled'), String(seen.error))
  },

  console: async (lib, browser) => {
    const seen = await watching(lib, browser, '<script>console.error("caught and logged by the framework")</script>')

    assert.deepEqual(seen.errors, [])
    assert.deepEqual(seen.console, ['caught and logged by the framework'])
    assert.deepEqual(seen.unexpected, ['console error: caught and logged by the framework'])
    assert.ok(seen.error && seen.error.includes('caught and logged by the framework'), String(seen.error))
    assert.deepEqual(seen.value, { served: true })
  },

  'expected-named': async (lib, browser) => {
    const seen = await watching(lib, browser, '<script>setTimeout(() => { throw new Error("named") }, 10); console.error("named too")</script>', { expected: ['named', 'named too'] })

    assert.deepEqual(seen.errors, ['named'])
    assert.deepEqual(seen.console, ['named too'])
    assert.deepEqual(seen.unexpected, [])
    assert.equal(seen.error, null)
    lib.validate(seen)
  },

  'only-named': async (lib, browser) => {
    const seen = await watching(lib, browser, '<script>setTimeout(() => { throw new Error("named") }, 10); console.error("other")</script>', { expected: ['named'] })

    assert.deepEqual(seen.unexpected, ['console error: other'])
    assert.ok(seen.error && seen.error.includes('other'), String(seen.error))
  },

  late: async (lib, browser) => {
    const seen = await watching(lib, browser, '<script>setTimeout(() => console.error("raised late"), 100)</script>')

    assert.deepEqual(seen.console, ['raised late'])
    assert.ok(seen.error)
  },

  'work-throws': async (lib, browser) => {
    const seen = await lib.observe(browser, async ({ page, step }) => {
      step('first')
      await serve(page, '<script>console.error("before")</script>')
      step('second')
      throw new Error('line one\nline two')
    })

    assert.equal(seen.error, 'line one\nline two')
    assert.equal(seen.phase, 'second')
    assert.equal(seen.value, null)
    assert.deepEqual(seen.console, ['before'])
    lib.validate(seen)
  },

  'failed-requests': async (lib, browser) => {
    const seen = await watching(lib, browser, '<img src="/missing.png"><script src="/blocked.js"></script>', {}, { '/blocked.js': 'abort' })

    assert.ok(seen.failed.some((text) => text.includes('/missing.png') && text.includes('404')), JSON.stringify(seen.failed))
    assert.ok(seen.failed.some((text) => text.includes('/blocked.js')), JSON.stringify(seen.failed))
  },

  'close-failure': async (lib) => {
    const page = { on () {}, waitForTimeout: async () => {} }
    const browser = { newContext: async () => ({ newPage: async () => page, close: async () => { throw new Error('the browser is gone') } }) }
    const seen = await lib.observe(browser, async () => ({ done: true }))

    assert.ok(seen.error && seen.error.includes('did not close') && seen.error.includes('the browser is gone'), String(seen.error))
    assert.deepEqual(seen.value, { done: true })
  },

  isolated: async (lib, browser) => {
    const first = await watching(lib, browser, '<script>console.error("only the first")</script>')
    const second = await watching(lib, browser, '<p>quiet</p>')

    assert.deepEqual(first.console, ['only the first'])
    assert.deepEqual(second.console, [])
    assert.equal(second.error, null)
  },

  validate: async (lib, browser) => {
    const whole = await watching(lib, browser, '<p>fine</p>')
    const records = [whole, lib.failedObservation('did not start'), lib.completedObservation({}), { ...whole, error: 'failed', value: null }]

    records.forEach((record) => assert.equal(lib.validate(record), record))

    for (const [what, record] of [['nothing', undefined], ['a string', 'seen'], ['an array', []], ['no error key', { ...whole, error: undefined }], ['no phase', { ...whole, phase: undefined }], ['no console list', { ...whole, console: undefined }], ['a list of numbers', { ...whole, failed: [1] }], ['a value that is a string', { ...whole, value: 'x' }], ['no error and no value', { ...whole, value: null }], ['no error and an unexpected error', { ...whole, unexpected: ['page error: x'] }]]) {
      assert.throws(() => lib.validate(record), (thrown) => thrown instanceof lib.HarnessError, what)
    }
  },

  'long-exact': async (lib, browser) => {
    const message = 'c'.repeat(700)
    const thrown = 'p'.repeat(700)
    const seen = await watching(lib, browser, `<script>console.error("${message}"); setTimeout(() => { throw new Error("${thrown}") }, 10)</script>`, { expected: [message, thrown] })

    assert.deepEqual(seen.unexpected, [])
    assert.equal(seen.error, null)
    assert.deepEqual([seen.console.length, seen.console[0].length, seen.errors.length, seen.errors[0].length], [1, 500, 1, 500])
    lib.validate(seen)
  },

  'long-prefix': async (lib, browser) => {
    const seen = await watching(lib, browser, `<script>console.error("${'c'.repeat(500)}tail"); setTimeout(() => { throw new Error("${'p'.repeat(500)}tail") }, 10)</script>`, { expected: ['c'.repeat(500), 'p'.repeat(500)] })

    assert.equal(seen.unexpected.length, 2, JSON.stringify(seen.unexpected.map((text) => text.length)))
    assert.ok(seen.error, String(seen.error))
  },

  'string-expected': async (lib, browser) => {
    for (const expected of ['named', [1], [null], 'named and more']) {
      await assert.rejects(() => watching(lib, browser, '<p>fine</p>', { expected }), (thrown) => thrown instanceof lib.HarnessError, JSON.stringify(expected))
    }

    const seen = await watching(lib, browser, '<script>console.error("named and more")</script>', { expected: ['named'] })

    assert.deepEqual(seen.unexpected, ['console error: named and more'])
    assert.ok(seen.error)
  },

  'allowlist-snapshot': async (lib, browser) => {
    const expected = ['one']
    const seen = await lib.observe(browser, async ({ page }) => {
      expected.push('two')
      await serve(page, '<script>console.error("two")</script>')
    }, { expected })

    assert.deepEqual(seen.unexpected, ['console error: two'])
    assert.ok(seen.error)
  },

  'both-failures-long': async (lib) => {
    const page = { on () {}, waitForTimeout: async () => {} }
    const browser = { newContext: async () => ({ newPage: async () => page, close: async () => { throw new Error('the browser is gone') } }) }
    const seen = await lib.observe(browser, async () => { throw new Error('w'.repeat(6000)) })

    assert.ok(seen.error && seen.error.includes('did not close') && seen.error.includes('the browser is gone'), String(seen.error).slice(-200))
    assert.ok(seen.error.startsWith('w'.repeat(4000)) && !seen.error.startsWith('w'.repeat(4001)), 'the work message is kept up to its limit')
    lib.validate(seen)
  },

  'both-failures': async (lib) => {
    const page = { on () {}, waitForTimeout: async () => {} }
    const browser = { newContext: async () => ({ newPage: async () => page, close: async () => { throw new Error('the browser is gone') } }) }
    const seen = await lib.observe(browser, async () => { throw new Error('the work failed') })

    assert.ok(seen.error && seen.error.includes('the work failed') && seen.error.includes('did not close') && seen.error.includes('the browser is gone'), String(seen.error))
    assert.equal(seen.value, null)
    lib.validate(seen)
  },

  'context-failure': async (lib) => {
    let ran = false
    const browser = { newContext: async () => { throw new Error('no browser process') } }
    const seen = await lib.observe(browser, async () => { ran = true }).then((record) => record, (thrown) => assert.fail(`the observation threw: ${thrown.message}`))

    assert.equal(ran, false)
    assert.ok(seen.error && seen.error.includes('did not open') && seen.error.includes('no browser process'), String(seen.error))
    assert.equal(seen.value, null)
    lib.validate(seen)
  },
}

const WORDS = {
  quiet: 'a quiet page gives a whole record, with no error',
  uncaught: 'an exception nothing caught fails the observation and is kept, with the value of the work',
  rejection: 'a rejection nothing handled fails the observation',
  console: 'a console error, where a framework logs what it catches, fails the observation although the work went through',
  'expected-named': 'an error named by its exact text is kept and does not fail the observation',
  'only-named': 'an error that is not named still fails the observation, and only that one is unexpected',
  late: 'an error raised just after the work ended is seen',
  'work-throws': 'work that throws gives its whole message, the last step named, no value, and what the page raised before',
  'failed-requests': 'a failed request and a response of 404 are kept',
  'close-failure': 'a context that does not close fails the observation',
  isolated: 'one observation never sees the errors of another',
  validate: 'validate accepts the records the helper makes and throws a HarnessError for every other shape',
  'long-exact': 'an error is named by its whole text, also past the 500 characters that are shown of it',
  'long-prefix': 'an error that starts like a named one, past the 500 characters that are shown, is still unexpected',
  'string-expected': 'the named errors are a list of strings: a string or another entry is a HarnessError, and a part of a message names nothing',
  'allowlist-snapshot': 'the named errors are those at the start of the observation, whatever the work does to the list',
  'both-failures': 'work that throws and a context that does not close are both told',
  'both-failures-long': 'a work message as long as the helper keeps does not take the place of the failure of the close',
  'context-failure': 'a context that does not open gives a record of a failed observation instead of a thrown error',
}

// [name, text replaced in a copy of the helper, replacement, the case that must fail on an assertion].
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  ['console errors are not recorded', "if (message.type() === 'error') {", 'if (false) {', 'console'],
  ['page errors are not recorded', "page.on('pageerror', (error) => record.errors.push(String(error.message)))", "page.on('pageerror', () => {})", 'uncaught'],
  ['a console error is never unexpected', 'record.console.filter((text) => !named.has(text))', '[]', 'console'],
  ['a page error is never unexpected', 'record.errors.filter((text) => !named.has(text))', '[]', 'uncaught'],
  ['an error that is named is unexpected all the same', 'record.errors.filter((text) => !named.has(text))', 'record.errors', 'expected-named'],
  ['an unexpected error does not fail the observation', 'if (!problems.length && unnamed.length) {', 'if (!problems.length && false) {', 'uncaught'],
  ['an error raised after the work ended is not waited for', 'await page.waitForTimeout(flush)', 'void flush', 'late'],
  ['the last step is not kept', 'step: (phase) => { record.phase = phase }', 'step: () => {}', 'work-throws'],
  ['the message of a failed work is cut to its first line', 'problems.push(clip(thrown && thrown.message ? thrown.message : thrown, MESSAGE_LIMIT))', "problems.push(clip(thrown && thrown.message ? String(thrown.message).split('\\n')[0] : thrown, MESSAGE_LIMIT))", 'work-throws'],
  ['failed requests are not recorded', "page.on('requestfailed', (request) => record.failed.push(", "page.on('requestfailed', (request) => [].push(", 'failed-requests'],
  ['a context that does not close is not told', '(thrown) => `the context did not close: ${clip(thrown && thrown.message ? thrown.message : thrown, 500)}`', '() => null', 'close-failure'],
  ['a record with a list missing is accepted', 'if (!isStrings(seen[key])) {', 'if (false) {', 'validate'],
  ['a record with no error and no value is accepted', '(seen.value === null || seen.unexpected.length)', 'seen.unexpected.length', 'validate'],
  ['a console error is named by its cut message', 'record.console.filter((text) => !named.has(text))', 'record.console.filter((text) => !named.has(clip(text, TEXT_LIMIT)))', 'long-exact'],
  ['a page error is named by its cut message', 'record.errors.filter((text) => !named.has(text))', 'record.errors.filter((text) => !named.has(clip(text, TEXT_LIMIT)))', 'long-exact'],
  ['a console error is named by the start of its message', 'record.console.filter((text) => !named.has(text))', 'record.console.filter((text) => ![...named].some((item) => text.startsWith(item)))', 'long-prefix'],
  ['a page error is named by the start of its message', 'record.errors.filter((text) => !named.has(text))', 'record.errors.filter((text) => ![...named].some((item) => text.startsWith(item)))', 'long-prefix'],
  ['a message is named by a part of it', 'record.console.filter((text) => !named.has(text))', 'record.console.filter((text) => ![...named].some((item) => text.includes(item)))', 'string-expected'],
  ['the named errors follow the list the caller keeps', 'return new Set(expected)', 'return { has: (text) => expected.includes(text) }', 'allowlist-snapshot'],
  ['a string is accepted as the named errors', "if (!Array.isArray(expected) || expected.some((text) => typeof text !== 'string')) {", 'if (false) {', 'string-expected'],
  ['a failed context close is hidden when the work failed too', 'if (closing) {', 'if (closing && !problems.length) {', 'both-failures'],
  ['a context that does not open is thrown', 'problems.push(`the context did not open: ${clip(', 'throw thrown; problems.push(`the context did not open: ${clip(', 'context-failure'],
  ['the failures are cut together, so a long one hides the others', "error: problems.length ? problems.join('\\n') : null", "error: problems.length ? clip(problems.join('\\n'), MESSAGE_LIMIT) : null", 'both-failures-long'],
]
/* eslint-enable no-template-curly-in-string */

const main = async () => {
  const browser = await require('playwright').chromium.launch()
  const folders = []

  try {
    console.log('The helper as it is')

    const lib = require(HELPER)

    for (const [name, run] of Object.entries(CASES)) {
      try {
        await run(lib, browser)
        check(`${name}: ${WORDS[name]}`, true)
      } catch (error) {
        check(`${name}: ${WORDS[name]}`, false, String(error.message).split('\n')[0])
      }
    }

    if (options.mutations) {
      console.log('\nPlanted faults')

      const source = fs.readFileSync(HELPER, 'utf8')

      for (const [name, from, to, caught] of FAULTS) {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-browser-observe-'))
        const file = path.join(folder, 'browser-observe.js')

        folders.push(folder)
        fs.writeFileSync(file, patched(HELPER, source, from, to))

        let thrown = null

        try {
          await CASES[caught](require(file), browser)
        } catch (error) {
          thrown = error
        }

        check(`planted: ${name}: caught by ${caught}: ${WORDS[caught]}`, thrown instanceof assert.AssertionError, thrown ? `${thrown.name}: ${String(thrown.message).split('\n')[0]}` : 'nothing failed')
      }
    }
  } finally {
    await browser.close()
    folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true }))
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
