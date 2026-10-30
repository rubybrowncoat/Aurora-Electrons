/*
  Checks scripts/lib/browser-observe.js, the one policy of the checks that drive a page of the real renderer in a browser: what the page did and what went wrong while it did it, in a record of the same shape whether the observation went through or not; and the one way they read the screen as the player sees it.

  Run: bun scripts/check-browser-observe.js [--no-mutations]

  Each case of the record drives a page served from memory in Chromium (no application, no database) and looks at the record `observe` returns:
  - a quiet page gives a whole record with no error;
  - an exception nothing caught, a rejection nothing handled and a console error (where a framework logs the exceptions it catches in a handler, a watcher or a render) each make the observation fail, with the error kept, also when the work went through and its value is there;
  - an error the check names, by its exact text, is kept and does not fail the observation, and another error still does; the whole text decides, so a message of more than 500 characters is named by all of it (and one that only starts like it is not), a part of a message names nothing, the names are a list of strings (a string or another entry is a HarnessError) and the list is the one at the start of the observation;
  - an error raised just after the work ended is seen;
  - work that throws gives the whole message (the lines after the first included), the last step named, the value null and what the page raised before;
  - a failed request and a response of 400 or more are kept;
  - a context that does not close, or does not open, fails the observation, and work that failed together with a context that did not close tells both;
  - one observation never sees the errors of another;
  - `validate` accepts the records the helper makes and throws a HarnessError for every other shape.
  Each case of the readers sets a page of fixtures in Chromium, puts the readers in it with `installScreen` and reads it, every hidden fixture beside one that is drawn the same but seen:
  - visible: an element at `display: none` (a `v-show` that hides it) or under one, at `visibility: hidden`, at an opacity of 0 or under one, under `content-visibility: hidden`, of no area, cut away by an ancestor whose overflow hides it, or positioned in an ancestor of no area that contains it (by its position, by a transform, or by a filter on an inline box, for an absolute and a fixed box alike), is not visible; the same at `display: inline`, visible under a hidden ancestor, at an opacity of 1 or one half, of an area, in an ancestor that scrolls or is tall enough, moved by a transform out of an inline box whose overflow is hidden (overflow does not apply to it), positioned absolute out of an ancestor that does not contain it, fixed, or positioned out of an ancestor under size containment or of an inline box with a transform (neither contains it), is;
  - text: only the text of the elements that draw it is read (not a child at `display: none`, `visibility: hidden` or an opacity of 0, cut away by an overflow, of no area with its overflow hidden), and a child at an opacity of 1, of no area with its overflow shown, or moved by a transform out of an inline box whose overflow is hidden, is read; the ASCII whitespace the browser collapses is one space and none at the ends, and the spaces of Unicode (U+2003, U+00A0, U+202F) are kept where they are, at the ends too;
  - hooked: each element of a hook gives its role, the text it draws and whether it is on screen (by its box, or by the text it draws out of a box of no area), in the order of the document, and a reader given no element throws; read by role, a role drawn out of a box of no area counts and a hidden one does not;
  - figures: the 90 texts the page's own formatter (countText and thousandsSeparator of src/renderer/utilities/math.js) writes of 18 numbers in each of the five settings read back as the number rounded as the page rounds it; with a plus, with the Unicode minus for the hyphen, with a trailing .0 they are the same number, with the sign turned over or in the grouping of another setting they are not; a list of texts that are no figure is refused and a list that are is read; a grouping that is no name of the setting, and a value or places `rounded` cannot round, are a HarnessError;
  - roles: a region read by role passes when each role is drawn once, on screen, with the value expected, in any order and beside an element of the role that is off screen; a value under another role, a role drawn twice, missing or only off screen, a role that is none but drawn and a role not expected fail; a list paired by identity pairs in any order and tells a missing, a doubled and a foreign line and two rows of one identity; a word reads back to the key of its label and a word of two labels or none to null.
  Each case of the wait for a page to finish its reads serves a page from memory with the real count of its database calls (scripts/web/shims/pending-reads.js) and drives `settled`:
  - the count holds a call from its start to its answer or failure and ends it before the caller goes on with the answer, counts every start, says when none is out and cuts a long label;
  - a chain of reads, each started by the answer of the one before (by a microtask, two frames and a task later, the last instantly answered), is waited for to its last read, and a page that says it is still loading is waited for with no call out;
  - a call that never answers and a page that never stops loading end the wait at its limit with a failure of the page, no HarnessError, that names the calls out and the loading, and so does a page whose frames never come; a page with no count of its calls, and a limit or a loading of another shape, are a HarnessError.
  Each planted fault rewrites one line of a copy of the helper (or, for the count of a page's calls, of a copy of its file) and must make a named case fail on an assertion; each equivalent rewrite of a copy must keep its case passing.

  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { patched } = require('./lib/mutant-source')
const { loadUtilities } = require('./lib/utilities')

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

// A page of `markup` in a context of its own, with the readers of `lib` put in it, and what `read` gives, run in the page with `arg`.
const onScreen = async (lib, browser, markup, read, arg) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } })

  try {
    const page = await context.newPage()

    await page.setContent(`<!doctype html><html><body>${markup}</body></html>`)
    await lib.installScreen(page)

    return await page.evaluate(read, arg)
  } finally {
    await context.close()
  }
}

// [id, whether the player sees the element, its markup]: each way to hide an element beside markup drawn the same that is seen.
const VISIBLE = [
  ['v-plain', true, '<span id="v-plain">12</span>'],
  ['v-display', false, '<span id="v-display" style="display: none">12</span>'],
  ['v-display-up', false, '<div style="display: none"><span id="v-display-up">12</span></div>'],
  ['v-display-inline', true, '<span id="v-display-inline" style="display: inline">12</span>'],
  ['v-visibility', false, '<span id="v-visibility" style="visibility: hidden">12</span>'],
  ['v-visibility-child', true, '<div style="visibility: hidden"><span id="v-visibility-child" style="visibility: visible">12</span></div>'],
  ['v-opacity', false, '<span id="v-opacity" style="opacity: 0">12</span>'],
  ['v-opacity-up', false, '<div style="opacity: 0"><span id="v-opacity-up">12</span></div>'],
  ['v-opacity-one', true, '<span id="v-opacity-one" style="opacity: 1">12</span>'],
  ['v-opacity-half', true, '<div style="opacity: 0.5"><span id="v-opacity-half">12</span></div>'],
  ['v-content', false, '<div style="content-visibility: hidden"><span id="v-content">12</span></div>'],
  ['v-zero', false, '<span id="v-zero" style="display: inline-block; width: 0; height: 0; overflow: hidden">12</span>'],
  ['v-sized', true, '<span id="v-sized" style="display: inline-block; width: 40px; height: 20px; overflow: hidden">12</span>'],
  ['v-zero-up', false, '<div style="height: 0; overflow: hidden"><span id="v-zero-up">12</span></div>'],
  ['v-tall-up', true, '<div style="height: 40px; overflow: hidden"><span id="v-tall-up">12</span></div>'],
  ['v-cut-away', false, '<div style="height: 20px; overflow: hidden"><div style="height: 30px"></div><span id="v-cut-away">12</span></div>'],
  ['v-scrolled', true, '<div style="height: 20px; overflow: auto"><div style="height: 30px"></div><span id="v-scrolled">12</span></div>'],
  ['v-held', false, '<div style="position: relative; height: 0; overflow: hidden"><span id="v-held" style="position: absolute">12</span></div>'],
  ['v-escaped', true, '<div style="height: 0; overflow: hidden"><span id="v-escaped" style="position: absolute">12</span></div>'],
  ['v-fixed', true, '<div style="position: relative; height: 0; overflow: hidden"><span id="v-fixed" style="position: fixed; right: 0; bottom: 0">12</span></div>'],
  ['v-transform-absolute', false, '<div style="transform: translate(0); height: 0; overflow: hidden"><span id="v-transform-absolute" style="position: absolute; top: 0">12</span></div>'],
  ['v-transform-fixed', false, '<div style="transform: translate(0); height: 0; overflow: hidden"><span id="v-transform-fixed" style="position: fixed; top: 0">12</span></div>'],
  ['v-inline-wrap', true, '<span style="overflow: hidden"><span id="v-inline-wrap" style="display: inline-block; transform: translateX(100px)">12</span></span>'],
  ['v-inline-block-wrap', false, '<span style="display: inline-block; width: 20px; height: 20px; overflow: hidden"><span id="v-inline-block-wrap" style="display: inline-block; transform: translateX(100px)">12</span></span>'],
  ['v-size-absolute', true, '<div style="container-type: size; height: 0; overflow: hidden"><span id="v-size-absolute" style="position: absolute; top: 0">12</span></div>'],
  ['v-size-fixed', true, '<div style="container-type: size; height: 0; overflow: hidden"><span id="v-size-fixed" style="position: fixed; top: 0">12</span></div>'],
  ['v-inline-transform-fixed', true, '<div style="height: 0; overflow: hidden"><span style="transform: translate(0)"><span id="v-inline-transform-fixed" style="position: fixed; top: 0">12</span></span></div>'],
  ['v-inline-filter-fixed', false, '<div style="position: relative; height: 0; overflow: hidden"><span style="filter: blur(0)"><span id="v-inline-filter-fixed" style="position: fixed; top: 0">12</span></span></div>'],
  ['v-contents-filter-fixed', true, '<div style="height: 0; overflow: hidden"><span style="display: contents; filter: blur(0)"><span id="v-contents-filter-fixed" style="position: fixed; top: 0">12</span></span></div>'],
]

// [id, the text the player sees, the markup]: each way to hide a part of a text beside markup drawn the same that is seen, and the whitespace the browser collapses beside the spaces it keeps.
const TEXTS = [
  ['t-plain', 'Firenze Khanate', '<div id="t-plain">Firenze Khanate</div>'],
  ['t-padding', 'Firenze Khanate', '<div id="t-padding">  Firenze \n\t  Khanate  </div>'],
  ['t-em-space', 'Firenze\u2003\u2003Khanate', '<div id="t-em-space">Firenze\u2003\u2003Khanate</div>'],
  ['t-unicode-ends', '\u00A0Firenze\u202F', '<div id="t-unicode-ends">\u00A0Firenze\u202F</div>'],
  ['t-display-child', '12 t', '<div id="t-display-child">12<span style="display: none">34</span> t</div>'],
  ['t-visibility-child', '12 t', '<div id="t-visibility-child">12<span style="visibility: hidden">34</span> t</div>'],
  ['t-opacity-child', '12 t', '<div id="t-opacity-child">12<span style="opacity: 0">34</span> t</div>'],
  ['t-opacity-one', '1234 t', '<div id="t-opacity-one">12<span style="opacity: 1">34</span> t</div>'],
  ['t-zero-child', '12 t', '<div id="t-zero-child">12<span style="display: inline-block; width: 0; height: 0; overflow: hidden">34</span> t</div>'],
  ['t-overflow-hidden', '', '<div id="t-overflow-hidden"><div style="height: 0; overflow: hidden">34</div></div>'],
  ['t-overflow-shows', '34', '<div id="t-overflow-shows"><div style="height: 0">34</div></div>'],
  ['t-cut-away', '12', '<div id="t-cut-away" style="height: 20px; overflow: hidden">12<div style="height: 30px"></div>34</div>'],
  ['t-tall', '1234', '<div id="t-tall" style="height: 80px; overflow: hidden">12<div style="height: 30px"></div>34</div>'],
  ['t-inline-wrap', '1234', '<div id="t-inline-wrap"><span style="overflow: hidden">12<span style="display: inline-block; transform: translateX(100px)">34</span></span></div>'],
]

// A region of hooks: two figures by role, one with a child at `display: none`, an element of a role at an opacity of 0, and one of no area that draws its text out of its box.
const HOOKED = '<div id="h-root">Mass <span data-figure="mass">5\'749</span> t, the largest bay <span data-figure="largest">4<i style="display: none">0</i>\'477</span> t<span data-figure="spare" style="opacity: 0">1</span><span data-figure="drawn-out" style="display: block; height: 0">7</span></div>'

// The numbers the page's formatter is tried on (decimals, thousands, halves, negatives, a residue of arithmetic), each in each setting: 90 texts.
const VALUES = [0, 1, 10, 995.0000000000045, 1.9e-14, 0.04, 0.05, 0.15, 1.25, 1.95, 999.95, 1000, 1234567.89, -1, -0.05, -0.15, -1.25, -1234567.89]
const SETTINGS = ['Tick', 'Comma', 'Dash', 'Space', 'None']
// Texts that are no figure in the setting given.
const REFUSED = [['1000', 'Tick'], ['1,000', 'Tick'], ["1'000", 'Comma'], ["1'000", 'None'], ["1'00", 'Tick'], ["12'3456", 'Tick'], ['1.2.3', 'None'], ['', 'None'], ['-', 'None'], ['-0', 'None'], ['\u22120.0', 'None'], ['--1', 'None'], ['1 000', 'Tick'], ['01', 'None'], ["0'001", 'Tick'], ['1e3', 'None'], ['1.', 'None'], ['.5', 'None'], ['\u0661\u0662', 'None'], ['+-1', 'None'], ['++1', 'None'], ['+', 'None'], ["+1'00", 'Tick'], ['+\u22121', 'None'], ['\u2212\u22121', 'None'], ['-\u0661', 'None'], ['\u20131', 'None'], ['\u22481', 'None'], ['(1)', 'None'], ['x12', 'None'], ['10 t', 'None'], [' 1', 'None'], ['1 ', 'None'], ['1\u00A0000', 'Space'], ['1\u202F000', 'Space'], [null, 'None'], [1, 'None']]
// Texts that are figures, with the number of each.
const READ = [['+1', 'None', 1], ["+1'000", 'Tick', 1000], ['+1-000.5', 'Dash', 1000.5], ['1 000', 'Space', 1000], ['1,000.5', 'Comma', 1000.5], ['1-000', 'Dash', 1000], ['-1-000', 'Dash', -1000], ['\u22121-000', 'Dash', -1000], ['-5', 'Dash', -5], ['\u22121', 'None', -1], ["\u22121'000", 'Tick', -1000], ['1000', 'None', 1000], ['995.0', 'Tick', 995], ['0', 'Comma', 0], ['+0', 'None', 0], ['0.5', 'None', 0.5]]

const TRACKER = path.join(__dirname, 'web', 'shims', 'pending-reads.js')
// A page that has the page's count of its database calls and `tracked`, which a call counts through, as globals.
const COUNTED = '<script type="module">import { tracked } from "/pending-reads.js"; window.tracked = tracked</script>'

// A page of `html` in a context of its own, served with the count of its database calls from the file `tracker` at /pending-reads.js, and what `work` does with the page.
const counting = async (browser, tracker, html, work) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } })

  try {
    const page = await context.newPage()

    await serve(page, html, { '/pending-reads.js': { status: 200, contentType: 'text/javascript', body: fs.readFileSync(tracker, 'utf8') } })

    return await work(page)
  } finally {
    await context.close()
  }
}

// What `call` gives ({ value }) or throws ({ error }); a call that has not ended in `ms` is { late: true }, a failure of the case that does not hold the run.
const outcome = async (call, ms = 20000) => {
  let timer = null
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, { late: true })
  })

  try {
    return await Promise.race([call.then((value) => ({ value }), (error) => ({ error })), late])
  } finally {
    clearTimeout(timer)
  }
}

// Whether a call stops with the HarnessError of `lib`.
const stopsRun = (lib, call) => {
  try {
    call()
  } catch (error) {
    return error instanceof lib.HarnessError
  }

  return false
}

const CASES = {
  quiet: async (lib, browser) => {
    const seen = await watching(lib, browser, '<p>fine</p>')

    assert.deepEqual(seen, { value: { served: true }, error: null, phase: 'serving the page', scene: null, errors: [], console: [], failed: [], unexpected: [] })
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
    assert.ok(typeof seen.scene === 'string' && seen.scene.includes(`address: ${HOST}/`) && seen.scene.includes('loaded 1 times') && seen.scene.includes('requests out: none') && seen.scene.includes('error: before') && seen.scene.includes('"readyState":"complete"'), String(seen.scene))
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

  visible: async (lib, browser) => {
    const seen = await onScreen(lib, browser, VISIBLE.map(([, , markup]) => markup).join(''), (ids) => ids.map((id) => window.__screen.visible(document.getElementById(id))), VISIBLE.map(([id]) => id))

    assert.deepEqual(VISIBLE.map(([id], index) => [id, seen[index]]), VISIBLE.map(([id, shown]) => [id, shown]))
  },

  text: async (lib, browser) => {
    const seen = await onScreen(lib, browser, TEXTS.map(([, , markup]) => markup).join(''), (ids) => ids.map((id) => window.__screen.visibleText(document.getElementById(id))), TEXTS.map(([id]) => id))

    assert.deepEqual(TEXTS.map(([id], index) => [id, seen[index]]), TEXTS.map(([id, text]) => [id, text]))
  },

  hooked: async (lib, browser) => {
    const seen = await onScreen(lib, browser, HOOKED, () => {
      const refused = (read) => {
        try {
          read()
        } catch (error) {
          return error instanceof TypeError
        }

        return false
      }

      return { entries: window.__screen.hooked(document.getElementById('h-root'), 'data-figure'), refused: [() => window.__screen.visible(null), () => window.__screen.visibleText(document.createTextNode('12')), () => window.__screen.hooked(undefined, 'data-figure')].map(refused) }
    })

    assert.deepEqual(seen, { entries: [{ role: 'mass', text: '5\'749', on: true }, { role: 'largest', text: '4\'477', on: true }, { role: 'spare', text: '', on: false }, { role: 'drawn-out', text: '7', on: true }], refused: [true, true, true] })

    // The region read by role from what the page drew: the text drawn out of a box of no area is a role on screen, unexpected unless the oracle names it, and the hidden spare is no role on screen.
    const read = (expected) => lib.rolesRead('the carry', seen.entries, expected, (text) => lib.readFigure(text, 'Tick')).map(([, role, said]) => [role, said])

    assert.deepEqual([read({ mass: 5749, largest: 4477, 'drawn-out': 7 }), read({ mass: 5749, largest: 4477, spare: null })], [[], [['drawn-out', 'is drawn and not expected here']]])
  },

  figures: async (lib) => {
    const { math } = await loadUtilities(['math'])
    const problems = []

    VALUES.forEach((value) => SETTINGS.forEach((setting) => {
      const places = Number.isInteger(value) ? 0 : 1
      const page = math.countText(value, places, math.thousandsSeparator(setting))
      const number = lib.rounded(value, places)
      const read = (text, grouping = setting) => lib.readFigure(text, grouping)

      if (read(page) !== number) {
        problems.push([setting, value, page, read(page), number])
      }

      // The same number with a plus, with the Unicode minus for the hyphen and with a trailing .0; another with the sign turned over, and none in the grouping of another setting.
      if ((number > 0 && read(`+${page}`) !== number) || (page.startsWith('-') && read(`\u2212${page.slice(1)}`) !== number) || (Number.isInteger(number) && read(`${page}.0`) !== number)) {
        problems.push([setting, value, page, 'with a plus, the Unicode minus or a trailing .0'])
      }

      if (number !== 0 && read(page.startsWith('-') ? page.slice(1) : `-${page}`) === number) {
        problems.push([setting, value, page, 'with the sign turned over'])
      }

      if (Math.abs(number) >= 1000 && SETTINGS.some((other) => other !== setting && read(page, other) !== null)) {
        problems.push([setting, value, page, 'in the grouping of another setting'])
      }
    }))

    const refused = REFUSED.filter(([text, grouping]) => lib.readFigure(text, grouping) !== null)
    const misread = READ.filter(([text, grouping, number]) => lib.readFigure(text, grouping) !== number)
    const unguarded = [['readFigure', '1', 'tick'], ['readFigure', '1', undefined], ['readFigure', '1', 'toString'], ['rounded', null, 0], ['rounded', Infinity, 0], ['rounded', '1', 0], ['rounded', 1, -1], ['rounded', 1, 0.5]].filter(([name, ...args]) => !stopsRun(lib, () => lib[name](...args)))

    assert.deepEqual({ problems, refused, misread, unguarded }, { problems: [], refused: [], misread: [], unguarded: [] })
  },

  roles: async (lib) => {
    const entry = (role, text, on = true) => ({ role, text, on })
    const drawn = [entry('mass', '5\'749'), entry('largest', '4\'477')]
    const read = (entries, expected) => lib.rolesRead('the carry', entries, expected, (text) => lib.readFigure(text, 'Tick'))
    const rolesOf = (problems) => problems.map(([, role]) => role)
    const both = { mass: 5749, largest: 4477 }

    assert.deepEqual([read(drawn, both), read([...drawn].reverse(), both), read([...drawn, entry('mass', '1', false), entry('spare', '1', false)], both), read(drawn, { ...both, spare: null }), lib.rolesRead('the names', [entry('colony', 'Earth Prime')], { colony: 'Earth Prime' })], [[], [], [], [], []], 'a region drawn as expected')
    assert.deepEqual([read(drawn, { mass: 4477, largest: 5749 }), read([...drawn, entry('mass', '5\'749')], both), read([drawn[0]], both), read([entry('mass', '5\'749', false), drawn[1]], both), read(drawn, { mass: 5749, largest: null }), read(drawn, { mass: 5749 })].map(rolesOf), [['mass', 'largest'], ['mass'], ['largest'], ['mass'], ['largest'], ['largest']], 'a region drawn otherwise')

    const rows = [{ id: 1 }, { id: 2 }]
    const line = (id) => ({ id, text: `line ${id}` })
    const pair = (lines, list = rows) => lib.pairedBy('the list', lines, list, (one) => one.id, (row) => row.id)
    const reordered = pair([line(2), line(1)])

    assert.deepEqual([reordered.problems, reordered.pairs.map(([row, one]) => [row.id, one.id])], [[], [[1, 1], [2, 2]]], 'a list in another order')
    assert.deepEqual([pair([line(1)]), pair([line(1), line(2), line(2)]), pair([line(1), line(2), line(3)]), pair([line(1), line(2)], [...rows, { id: 2 }])].map(({ problems }) => problems.length), [1, 1, 1, 1], 'a line missing, doubled or foreign, and two rows of one identity')

    const labels = { fits: 'Fits', over: 'Too large', unknown: 'Not known' }

    assert.deepEqual([lib.labelKey('Too large', labels), lib.labelKey('Fits', labels), lib.labelKey('too large', labels), lib.labelKey('X', { a: 'X', b: 'X' })], ['over', 'fits', null, null], 'a word read back through its table')
    assert.deepEqual([() => lib.rolesRead('x', [{ role: 1 }], {}), () => lib.rolesRead('x', [], []), () => lib.rolesRead('x', [], {}, 'read'), () => lib.pairedBy('x', null, [], String, String), () => lib.labelKey('x', null)].map((call) => stopsRun(lib, call)), [true, true, true, true, true], 'arguments of another shape stop the run')
  },

  // The page's own count of its database calls, as the file `tracker` keeps it (the real scripts/web/shims/pending-reads.js, or a copy with a fault in it): one call out, its answer, a failure, the wait for no call out, and the cut of a label.
  tracked: async (_lib, browser, tracker = TRACKER) => counting(browser, tracker, COUNTED, async (page) => {
    const seen = await page.evaluate(async () => {
      const reads = window.__auroraReads
      const stuck = new Promise((resolve) => setTimeout(resolve, 1000, 'stuck'))
      const idleNone = await Promise.race([reads.idle().then(() => 'idle'), stuck])
      const first = window.tracked('first', () => new Promise((resolve) => setTimeout(resolve, 50, 'answer')))
      const whileOut = { size: reads.pending.size, started: reads.started, labels: [...reads.pending.values()] }
      const idle = reads.idle().then(() => 'idle')
      const answered = await first.then((value) => ({ value, size: reads.pending.size }))
      const idleOut = await Promise.race([idle, stuck])
      const failure = await window.tracked('failing', () => Promise.reject(new Error('boom'))).then(() => 'answered', (error) => ({ message: error.message, size: reads.pending.size }))

      window.tracked('x'.repeat(500), () => new Promise(() => {}))

      const [long] = [...reads.pending.values()]

      return { idleNone, whileOut, answered, idleOut, failure, started: reads.started, clipped: long.length < 500 }
    })

    assert.deepEqual(seen, { idleNone: 'idle', whileOut: { size: 1, started: 1, labels: ['first'] }, answered: { value: 'answer', size: 0 }, idleOut: 'idle', failure: { message: 'boom', size: 0 }, started: 3, clipped: true })
  }),

  // A read that ends, one that a watcher starts a microtask after it, one that starts two frames after that, and one that starts a task after it, each longer than the last started: the wait ends when the last is answered, not when the first is.
  'settled-chain': async (lib, browser, tracker = TRACKER) => counting(browser, tracker, `${COUNTED}<script>
    window.log = []
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const read = (name, work) => tracked(name, work).then(() => window.log.push(name))
    window.start = () => read('A', () => wait(300)).then(() => read('B', () => wait(200))).then(frames).then(() => read('C', () => wait(150))).then(() => wait(0)).then(() => read('D', () => wait(100))).then(() => read('E', () => Promise.resolve()))
  </script>`, async (page) => {
    await page.evaluate(() => {
      window.start()
    })

    const out = await outcome(lib.settled(page, { limit: 20000 }), 8000)

    assert.ok('value' in out, out.late ? 'the wait did not end' : String(out.error))
    assert.deepEqual(await page.evaluate(() => window.log), ['A', 'B', 'C', 'D', 'E'], 'the wait ended before the reads of the chain did')
  }),

  'settled-loading': async (lib, browser, tracker = TRACKER) => counting(browser, tracker, `${COUNTED}<p>page</p>`, async (page) => {
    await page.evaluate(() => {
      window.busy = true
      setTimeout(() => { window.busy = false }, 600)
    })

    const out = await outcome(lib.settled(page, { limit: 20000, loading: () => window.busy }), 8000)

    assert.ok('value' in out, out.late ? 'the wait did not end' : String(out.error))
    assert.equal(await page.evaluate(() => window.busy), false, 'the wait ended while the page was still loading')
  }),

  // A read that is out when the wait begins is answered during its first round (by the first animation frame the round asks for), and what its answer sets going, a second read two frames later, runs after that round: a round that began with a call out does not settle the page, so the wait goes on to the second read's end.
  'settled-late-answer': async (lib, browser, tracker = TRACKER) => counting(browser, tracker, COUNTED, async (page) => {
    await page.evaluate(() => {
      const frame = window.requestAnimationFrame.bind(window)
      const frames = () => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
      let answer = null
      let first = true

      window.log = []
      window.tracked('A', () => new Promise((resolve) => {
        answer = resolve
      })).then(() => {
        window.log.push('A')

        return frames()
      }).then(() => window.tracked('B', () => new Promise((resolve) => setTimeout(resolve, 150)))).then(() => window.log.push('B'))
      window.requestAnimationFrame = (callback) => frame((time) => {
        callback(time)

        if (first) {
          first = false
          answer()
        }
      })
    })

    const out = await outcome(lib.settled(page, { limit: 20000 }), 8000)

    assert.ok('value' in out, out.late ? 'the wait did not end' : String(out.error))
    assert.deepEqual(await page.evaluate(() => window.log), ['A', 'B'], 'the wait ended after a round that began with a call out')
  }),

  // A page whose frames never come (its animation-frame callbacks never run) has not finished a round of its own work: the wait ends at its limit with a failure, never as a page that has settled.
  'settled-frozen': async (lib, browser, tracker = TRACKER) => counting(browser, tracker, `${COUNTED}<p>page</p>`, async (page) => {
    await page.evaluate(() => {
      window.requestAnimationFrame = () => 0
    })

    const out = await outcome(lib.settled(page, { limit: 700 }), 10000)

    assert.ok(out.error, out.late ? 'the wait did not end at its limit' : 'the wait ended at its limit as a page that has settled')
    assert.ok(!(out.error instanceof lib.HarnessError) && out.error.message.includes('700 ms'), out.error.message)
  }),

  // A call that never answers and a page that never stops loading: the wait ends at its limit with a failure that is no HarnessError, and names what was out.
  'settled-timeout': async (lib, browser, tracker = TRACKER) => counting(browser, tracker, `${COUNTED}<p>page</p>`, async (page) => {
    await page.evaluate(() => {
      window.busy = true
      window.tracked('/query select 1 from the_stuck_table', () => new Promise(() => {}))
    })

    const began = Date.now()
    const out = await outcome(lib.settled(page, { limit: 700, loading: () => window.busy }), 10000)

    assert.ok(out.error, out.late ? 'the wait did not end at its limit' : 'the wait ended at its limit without a failure')
    assert.ok(!(out.error instanceof lib.HarnessError), 'a page that does not settle is no failure of the harness')
    assert.ok(Date.now() - began < 8000, 'the wait outlasted its limit')
    assert.deepEqual(['700 ms', '1 database calls', '/query select 1 from the_stuck_table', 'still loading'].filter((part) => !out.error.message.includes(part)), [], out.error.message)
  }),

  'settled-no-count': async (lib, browser, tracker = TRACKER) => counting(browser, tracker, '<p>a page of the app that is not served by the web shims</p>', async (page) => {
    const out = await outcome(lib.settled(page, { limit: 700 }))

    assert.ok(out.error instanceof lib.HarnessError, 'a page with no count of its calls is a HarnessError, not a page that has settled')
    assert.ok(out.error.message.includes('__auroraReads'), out.error.message)
  }),

  'settled-arguments': async (lib, browser, tracker = TRACKER) => counting(browser, tracker, `${COUNTED}<p>page</p>`, async (page) => {
    const calls = [{ limit: 0 }, { limit: Number.NaN }, { limit: '5' }, { limit: -1 }, { loading: 'yes' }]
    const outs = await Promise.all(calls.map((given) => outcome(lib.settled(page, given))))

    assert.deepEqual(outs.map((out) => out.error instanceof lib.HarnessError), calls.map(() => true), 'an argument of another shape stops the run')
  }),
}

const WORDS = {
  quiet: 'a quiet page gives a whole record, with no error',
  uncaught: 'an exception nothing caught fails the observation and is kept, with the value of the work',
  rejection: 'a rejection nothing handled fails the observation',
  console: 'a console error, where a framework logs what it catches, fails the observation although the work went through',
  'expected-named': 'an error named by its exact text is kept and does not fail the observation',
  'only-named': 'an error that is not named still fails the observation, and only that one is unexpected',
  late: 'an error raised just after the work ended is seen',
  'work-throws': 'work that throws gives its whole message, the last step named, no value, what the page raised before, and what the page showed then: its address and loads, the requests out, its console and the state of the document',
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
  visible: 'an element hidden by display, visibility, content-visibility, an opacity of 0 on it or an ancestor, no area, or the overflow of an ancestor that contains it is not visible, and the same drawn to be seen is',
  text: 'the text read is only what the elements that draw it show, its ASCII whitespace collapsed as the browser collapses it and its spaces of Unicode kept',
  hooked: 'each element of a hook gives its role, the text it draws and whether it is on screen by its box or its text, in the order of the document, and a reader given no element throws',
  figures: 'the 90 texts of the page\'s own formatter read back, signed and in their grouping, as the numbers rounded as the page rounds them, and every text that is no figure is refused',
  roles: 'a region is read by role and a list by identity, never by place or as a set, and a word is read back through its table',
  tracked: 'the page\'s count of its database calls holds a call from its start to its answer or failure, ends it before the caller goes on with the answer, counts every start, says when none is out and cuts a long label',
  'settled-chain': 'the wait for the page ends when the last read is answered, through a read that a watcher starts a microtask, two frames and a task after another, not when the first is',
  'settled-loading': 'the wait for the page goes on while the page says it is still loading, with no call out',
  'settled-timeout': 'a wait that is not over at its limit fails there, as a failure of the page and not of the harness, and names the calls still out and that the page was loading',
  'settled-no-count': 'a page with no count of its database calls is a HarnessError, never a page that has settled',
  'settled-arguments': 'a limit that is no positive number and a loading that is no function stop the run',
  'settled-frozen': 'a page whose frames never come is no page that has settled: the wait ends at its limit with a failure',
  'settled-late-answer': 'a round that began with a call out does not settle the page, so a read that the answer of that call starts two frames later is waited for',
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
  ['the last step is not kept', 'step: (phase) => { record.phase = phase; at(record, phase) }', 'step: (phase) => { at(record, phase) }', 'work-throws'],
  ['what the page showed when the work threw is not read', 'scene = page ? await sceneOf(page, seen)', 'scene = null && page ? await sceneOf(page, seen)', 'work-throws'],
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
  ['an element at an opacity of 0 is visible', 'element.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true })', 'element.checkVisibility({ checkVisibilityCSS: true })', 'visible'],
  ['an element of no area is visible', 'return shown(element) && drawn(element.getBoundingClientRect(), element.parentElement, getComputedStyle(element).position)', 'return shown(element)', 'visible'],
  ['no ancestor cuts a box', 'if (CLIPS.includes(style.overflowY)) {', 'if (false) {', 'visible'],
  ['an overflow that scrolls cuts a box', "const CLIPS = ['hidden', 'clip']", "const CLIPS = ['hidden', 'clip', 'auto', 'scroll']", 'visible'],
  ['an absolute box is cut by the ancestors that do not contain it', "out === 'absolute' ? style.position !== 'static' || holds(style) : true", 'true', 'visible'],
  ['a fixed box is cut by its ancestors', "(out === 'fixed' ? holds(style) : out === 'absolute'", "(out === 'absolute'", 'visible'],
  ['a fixed box is contained by no ancestor', "out === 'fixed' ? holds(style)", "out === 'fixed' ? false", 'visible'],
  ['a transformed ancestor contains no out-of-flow box', "['transform', 'translate', 'rotate', 'scale', 'perspective'].some((name) => (style[name] || 'none') !== 'none') || ", '', 'visible'],
  ['a filtered ancestor contains no out-of-flow box', "['filter', 'backdropFilter'].some((name) => (style[name] || 'none') !== 'none') || ", '', 'visible'],
  ['an inline box holds out-of-flow boxes by a transform', "(style.display !== 'inline' && ", '(', 'visible'],
  ['a box of display: contents holds out-of-flow boxes by a filter', "const holds = (style) => style.display !== 'contents' && (", 'const holds = (style) => (', 'visible'],
  ['size containment holds out-of-flow boxes', '/\\b(layout|paint|strict|content)\\b/.test(style.contain)', '/\\b(layout|paint|strict|content|size)\\b/.test(style.contain) || /size/.test(style.containerType)', 'visible'],
  ['the overflow of an inline box cuts what it holds', "const clips = (style) => style.display !== 'inline' && ", 'const clips = (style) => ', 'visible'],
  ['every text node counts, as in textContent', "if (parent && shown(parent) && [...range.getClientRects()].some((rect) => drawn(rect, parent, 'static'))) {", 'if (parent) {', 'text'],
  ['the text of an element at an opacity of 0 counts', 'if (parent && shown(parent) && ', 'if (parent && ', 'text'],
  ['the text of an element of no area is not read where it is drawn', 'if (parent && shown(parent) && ', 'if (parent && visible(parent) && ', 'text'],
  ['the text itself is not looked at', "[...range.getClientRects()].some((rect) => drawn(rect, parent, 'static'))", 'true', 'text'],
  ['a text is cut only by the ancestors above its element', "drawn(rect, parent, 'static')", 'drawn(rect, parent.parentElement, getComputedStyle(parent).position)', 'text'],
  ['the spaces of Unicode are collapsed', "text.replace(/[ \\t\\n\\r]+/g, ' ')", "text.replace(/\\s+/g, ' ')", 'text'],
  ['the spaces of Unicode are cut from the ends', ".replace(/^ | $/g, '')", '.trim()', 'text'],
  ['the whitespace the browser collapses is kept', "return text.replace(/[ \\t\\n\\r]+/g, ' ').replace(/^ | $/g, '')", 'return text', 'text'],
  ['a hooked element is on screen whatever it draws', "on: visible(element) || text !== '' }", 'on: true }', 'hooked'],
  ['a hooked element is on screen only by its box', "on: visible(element) || text !== '' }", 'on: visible(element) }', 'hooked'],
  ['the text of a hooked element is all of its text', 'const text = visibleText(element)', 'const text = element.textContent', 'hooked'],
  ['the Unicode minus is no sign', "'\\u2212': -1, ", '', 'figures'],
  ['a plus is no sign', ", '+': 1 })", ' })', 'figures'],
  ['the sign is dropped', 'return sign < 0 ? -value : value', 'return value', 'figures'],
  ['the groups are of any size', '{1,3}(?:${patternOf(separator)}\\\\d{3})*', '+(?:${patternOf(separator)}\\\\d+)*', 'figures'],
  ['the grouping is taken from the text', 'const separator = GROUPINGS[grouping]', "const separator = /[',\\- ]/.exec(text.slice(1)) ? /[',\\- ]/.exec(text.slice(1))[0] : GROUPINGS[grouping]", 'figures'],
  ['a figure is read from the digits at its end, whatever is before them', 'new RegExp(`^(', 'new RegExp(`(', 'figures'],
  ['a figure is read from the digits at its start, whatever is after them', '(?:\\\\.(\\\\d+))?$`)', '(?:\\\\.(\\\\d+))?`)', 'figures'],
  ['a leading zero is read', '/^0\\d/.test(digits) || ', '', 'figures'],
  ['a minus before a zero is read', ' || (sign < 0 && value === 0)', '', 'figures'],
  ['a grouping that is no name of the setting is read as none', "if (typeof grouping !== 'string' || !has(GROUPINGS, grouping)) {", 'if (false) {', 'figures'],
  ['halves are rounded away from zero', 'return Math.round(value * 10 ** decimals) / 10 ** decimals', 'return Math.sign(value) * Math.round(Math.abs(value) * 10 ** decimals) / 10 ** decimals', 'figures'],
  ['a number is rounded by toFixed', 'return Math.round(value * 10 ** decimals) / 10 ** decimals', 'return Number(value.toFixed(decimals))', 'figures'],
  ['a value that is no finite number is rounded', "if (typeof value !== 'number' || !Number.isFinite(value) || ", 'if (', 'figures'],
  ['entries of another shape are read', 'if (!Array.isArray(entries) || !entries.every(isEntry) || ', 'if (false && ', 'roles'],
  ['an element off screen is read', 'entries.filter((entry) => entry.on).forEach', 'entries.forEach', 'roles'],
  ['the roles read are those drawn, not those expected', 'Object.keys(expected).forEach', ';[...byRole.keys()].forEach', 'roles'],
  ['a role drawn twice is read once', '} else if (found.length !== 1) {', '} else if (found.length === 0) {', 'roles'],
  ['a figure is read under any role', '} else if (read(found[0].text) !== wanted) {', '} else if (!entries.some((entry) => entry.on && read(entry.text) === wanted)) {', 'roles'],
  ['a role that is none may be drawn', 'if (found.length) {', 'if (false) {', 'roles'],
  ['a role drawn and not expected is not told', ';[...byRole.keys()].filter((role) => !has(expected, role))', ';[].filter((role) => !has(expected, role))', 'roles'],
  ['a line is paired by its place', 'const found = byIdentity.get(ids[index]) || []', 'const found = lines[index] ? [lines[index]] : []', 'roles'],
  ['a line no row has is not told', ';[...byIdentity.keys()].filter((id) => !ids.includes(id))', ';[].filter((id) => !ids.includes(id))', 'roles'],
  ['two rows of one identity are not told', 'if (new Set(ids).size !== ids.length) {', 'if (false) {', 'roles'],
  ['a word of two labels reads as the first', 'return keys.length === 1 ? keys[0] : null', 'return keys.length ? keys[0] : null', 'roles'],
  ['a wait that is over at its limit is a page that settled', 'return { signal: true, settled: false, pending: [...reads.pending.values()], working: Boolean(loading && loading()), stage }', 'return { signal: true, settled: true, pending: [...reads.pending.values()], working: Boolean(loading && loading()), stage }', 'settled-timeout'],
  ['the limit of a wait that is under way is no failure', 'throw EXPIRED', 'stage = stage', 'settled-frozen'],
  ['a page that has settled never gives the wait back', 'return { signal: true, settled: true }', 'await new Promise(() => {})', 'settled-chain'],
  ['a round that began with a call out settles the page', 'if (!open && !working && reads.started === before) {', 'if (!working && reads.started === before) {', 'settled-late-answer'],
  ['a call that started during the round does not hold the wait', 'if (!open && !working && reads.started === before) {', 'if (!open && !working) {', 'settled-chain'],
  ['the wait for a page does not let it run what an answer sets going', "await within(frames(), 'two frames')", 'void frames', 'settled-chain'],
  ['the wait for a page does not look at its loading', 'const working = Boolean(loading && loading())', 'const working = false', 'settled-loading'],
  ['a wait for a page that is over its limit does not say what was out', "const named = seen.pending.slice(0, SETTLE_NAMED).join('; ')", "const named = ''", 'settled-timeout'],
  ['a page with no count of its calls has settled', 'if (!seen.signal) {', 'if (false) {', 'settled-no-count'],
  ['a limit of any kind is a limit', "if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {", 'if (false) {', 'settled-arguments'],
  ['a call is not counted when it fails', 'return work().finally(() => {', 'return work().then(() => {', 'tracked', TRACKER],
  ['a call is counted from its answer, after the caller goes on', 'pending.delete(id)', 'setTimeout(() => pending.delete(id), 0)', 'tracked', TRACKER],
  ['the calls that have started are not counted', 'const id = ++started', 'const id = started', 'tracked', TRACKER],
  ['the wait for no call out never ends', 'done.forEach((resolve) => resolve())', 'done.forEach(() => {})', 'tracked', TRACKER],
  ['a label is not cut', 'String(label).slice(0, LABEL_LIMIT)', 'String(label)', 'tracked', TRACKER],
]

// [name, text replaced in a copy of the helper, a replacement that says the same, the case that must keep passing].
const REWRITES = [
  ['the options of checkVisibility in another order', 'element.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true })', 'element.checkVisibility({ opacityProperty: true, checkVisibilityCSS: true })', 'visible'],
  ['the whitespace the browser collapses as a class in another order', "text.replace(/[ \\t\\n\\r]+/g, ' ')", "text.replace(/[\\r\\n\\t ]+/g, ' ')", 'text'],
  ['ten to the places by Math.pow', 'return Math.round(value * 10 ** decimals) / 10 ** decimals', 'return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals)', 'figures'],
  ['an element on screen told by a comparison', 'entries.filter((entry) => entry.on).forEach', 'entries.filter((entry) => entry.on === true).forEach', 'roles'],
  ['a page that is loading told by a conditional', 'const working = Boolean(loading && loading())', 'const working = loading ? Boolean(loading()) : false', 'settled-loading'],
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
      // What the named case threw over a copy of `target` (the helper, or the file of the count of a page's calls) with `from` replaced by `to`, or null when it held.
      const over = async (from, to, name, target = HELPER) => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-browser-observe-'))
        const file = path.join(folder, path.basename(target))

        folders.push(folder)
        fs.writeFileSync(file, patched(target, fs.readFileSync(target, 'utf8'), from, to))

        // The modules the helper loads, beside the copy as beside the helper.
        for (const sibling of ['suite-runner.js', 'check-pool.js']) {
          fs.copyFileSync(path.join(path.dirname(HELPER), sibling), path.join(folder, sibling))
        }

        try {
          await (target === HELPER ? CASES[name](require(file), browser) : CASES[name](lib, browser, file))
        } catch (error) {
          return error
        }

        return null
      }

      console.log('\nPlanted faults')

      for (const [name, from, to, caught, target] of FAULTS) {
        const thrown = await over(from, to, caught, target)

        check(`planted: ${name}: caught by ${caught}: ${WORDS[caught]}`, thrown instanceof assert.AssertionError, thrown ? `${thrown.name}: ${String(thrown.message).split('\n')[0]}` : 'nothing failed')
      }

      console.log('\nEquivalent rewrites')

      for (const [name, from, to, kept, target] of REWRITES) {
        const thrown = await over(from, to, kept, target)

        check(`rewrite: ${name}: ${kept} still holds`, thrown === null, thrown ? `${thrown.name}: ${String(thrown.message).split('\n')[0]}` : '')
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
