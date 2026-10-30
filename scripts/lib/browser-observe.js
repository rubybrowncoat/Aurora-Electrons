// One policy for every check that drives a page of the real renderer in a browser: what the page did, and what went wrong while it did it, in a record that has the same shape whether the observation went through or not.
//
// const { observe, validate, failureLine, report } = require('./lib/browser-observe')
// const seen = await observe(browser, async ({ page, step }) => { step('opening the page'); await page.goto(url); return page.evaluate(read) }, { expected: ['the exact text of an error the check names'] })
//
// `observe` opens a context of its own, runs `work({ page, step })` (`step(name)` says where the work is, for the failure that is told afterwards, and to the runner of scripts/lib/suite-runner.js, whose deadline names, when it runs out, the step of every observation still open, so a step is said before the call it names), waits a moment for what the page raises late, closes the context, and returns { value, error, phase, scene, errors, console, failed, unexpected }:
// - value: what `work` returned, or null when it threw;
// - error: null, or why the observation failed: the context did not open or close, `work` threw (the whole message, the call log of a locator included), or the page raised an error the check did not name; when more than one of these happened they are all in it, each cut to its own limit, so that a long message of one never takes the place of another;
// - phase: the last step named;
// - scene: null, or, when `work` threw, what the page showed then, for diagnosis: its address and how often it loaded, the requests still out and for how long, the last messages of its console of every kind, and what the app holds (its route, its save, its race, the games it lists, the text on screen), read within SCENE_LIMIT;
// - errors: every page error, an exception nothing caught or a rejection nothing handled;
// - console: every console error. Vue catches the exceptions of a handler, a watcher or a render and logs them there, so they are never page errors, and a record without this list would call such a page clean;
// - failed: the requests that failed and the responses with a status of 400 or more, for diagnosis (a failed load that matters is also a console error);
// - unexpected: the page errors and the console errors the check did not name, each prefixed with its kind.
// The lists of messages are for display: a message is cut to 500 characters there. Whether an error is named is decided on the whole message, never on the cut one, and only by an exact match with an entry of `expected`, a list of strings that is copied and checked when the observation starts, so that nothing the caller does to the list or the page afterwards names an error. A part of a message names nothing; a string given in place of the list, or an entry that is not a string, is a HarnessError.
// The record is complete when the work went through as well as when it did not, and an observation with an unexpected renderer error has an `error`: a check names the exact error it expects, or the page raises none.
//
// `validate` throws a HarnessError for a record of another shape: a check that is handed such a record is itself broken, and that is told as a failure of the run, never as a page that failed or a fault that was caught.
//
// The screen as the player sees it, read the one way every page check reads it:
// const { installScreen, readFigure, rounded, rolesRead, pairedBy, labelKey } = require('./lib/browser-observe')
// await installScreen(page) puts the readers at `window.__screen` in the page: `visible(element)`, `visibleText(element)` and `hooked(root, attribute)`, each told where it is defined. A check reads the elements its hooks name with `hooked`, brings back their text and whether each is on screen, and judges them in the check: `readFigure` reads a number drawn in the grouping of the setting, `rounded` is the oracle's number as the page rounds it, `labelKey` reads a word back through the component's own table of words, `rolesRead` compares a region by the role of each element and `pairedBy` a list by the identity of each line. Checked by scripts/check-browser-observe.js.
//
// Waiting for the page to finish what a step set going:
// const { settled } = require('./lib/browser-observe')
// await settled(page, { limit: 120000, loading: require('../page-loading') }) waits, by the page's own count of the database calls it has out (scripts/web/shims/pending-reads.js) and never by a quiet period, until none is out, none starts in a round of the page's own work (a task and two frames) after the last answer and `loading` (a function run in the page) says the page is not working on what it read; a read that another read's answer makes a watcher start is waited for as the first is. It ends when the reads do, and past `limit` it throws what was still out; a page with no count is a HarnessError. What the page has only scheduled for later than that round (a debounce, a timer) is no call out: a step that sets one going waits first, in the check, for the condition that timer brings about (a `waitForFunction` on what the page shows), and then calls `settled` for the reads it starts. Checked by scripts/check-browser-observe.js.
const { step: reportStep } = require('./suite-runner')

const MESSAGE_LIMIT = 4000
const TEXT_LIMIT = 500
const FLUSH = 250
const SCENE_LIMIT = 5000
const RECENT = 15

class HarnessError extends Error {
  constructor (message) {
    super(message)
    this.name = 'HarnessError'
  }
}

const clip = (text, size) => String(text).slice(0, size)

const listen = (page, record, seen) => {
  page.on('pageerror', (error) => record.errors.push(String(error.message)))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      record.console.push(message.text())
    }

    seen.recent.push(`${message.type()}: ${clip(message.text(), 200)}`)
    seen.recent.splice(0, seen.recent.length - RECENT)
  })
  page.on('request', (request) => seen.out.set(request, Date.now()))
  page.on('requestfinished', (request) => seen.out.delete(request))
  page.on('requestfailed', (request) => seen.out.delete(request))
  page.on('requestfailed', (request) => record.failed.push(`${request.method()} ${clip(request.url(), 200)}: ${request.failure() ? request.failure().errorText : 'failed'}`))
  page.on('response', (response) => {
    if (response.status() >= 400) {
      record.failed.push(`${response.request().method()} ${clip(response.url(), 200)}: ${response.status()}`)
    }
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      seen.loads++
    }
  })
}

// Run in the page: what the app holds, each read on its own so that one that throws leaves the others.
const appState = () => {
  const read = (get) => {
    try {
      return get()
    } catch (error) {
      return `unread: ${error.message}`
    }
  }
  const store = () => window.$app.$store

  return {
    readyState: document.readyState,
    app: Boolean(window.$app),
    route: read(() => window.$app.$route.fullPath),
    database: read(() => Boolean(store().state.database)),
    databasePath: read(() => store().state.databasePath || null),
    GameID: read(() => store().getters.GameID || null),
    RaceID: read(() => store().getters.RaceID || null),
    empires: read(() => ({ loaded: store().state.empires.loaded, error: store().state.empires.error, games: store().state.empires.games.map((game) => game.GameName) })),
    text: read(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300)),
  }
}

// What the page showed when the work threw (see `scene` above), within SCENE_LIMIT: a page that does not answer says so.
const sceneOf = async (page, seen) => {
  const now = Date.now()
  const out = [...seen.out].map(([request, began]) => `${request.method()} ${clip(request.url(), 160)} (${((now - began) / 1000).toFixed(1)} s)`)
  let timer = null
  const app = await Promise.race([page.evaluate(appState).then((state) => JSON.stringify(state), (error) => `unread: ${clip(error.message, 200)}`), new Promise((resolve) => { timer = setTimeout(() => resolve(`the page did not answer in ${SCENE_LIMIT / 1000} s`), SCENE_LIMIT) })])

  clearTimeout(timer)

  return [`address: ${page.url()}, loaded ${seen.loads} times`, `requests out: ${out.length ? out.join('; ') : 'none'}`, `console: ${seen.recent.length ? seen.recent.join(' | ') : 'nothing'}`, `the app: ${app}`].join('\n')
}

const namedList = (expected) => {
  if (!Array.isArray(expected) || expected.some((text) => typeof text !== 'string')) {
    throw new HarnessError('`expected` is a list of the exact messages of the errors the check names; anything else names none')
  }

  return new Set(expected)
}

// The step of each observation open in this process, by its record, in the order they opened. The runner (scripts/lib/suite-runner.js) keeps the last step a worker says, so it is told where every open observation is, and once none is, that the last one is being judged: an observation that ends never leaves the runner naming its step while another is still at work.
const open = new Map()
const tell = () => reportStep(open.size ? [...open.values()].join('; ') : 'judging the observation')
const at = (record, phase) => {
  open.set(record, phase)
  tell()
}

const observe = async (browser, work, { viewport = { width: 1920, height: 1080 }, expected = [], flush = FLUSH } = {}) => {
  const named = namedList(expected)
  const record = { phase: 'opening the page', errors: [], console: [], failed: [] }

  at(record, record.phase)

  const problems = []
  let context = null
  let value = null
  let scene = null

  try {
    context = await browser.newContext({ viewport })
  } catch (thrown) {
    problems.push(`the context did not open: ${clip(thrown && thrown.message ? thrown.message : thrown, 500)}`)
  }

  if (context) {
    const seen = { recent: [], out: new Map(), loads: 0 }
    let page = null

    try {
      page = await context.newPage()
      listen(page, record, seen)
      value = await work({ page, step: (phase) => { record.phase = phase; at(record, phase) } })
      await page.waitForTimeout(flush)
    } catch (thrown) {
      problems.push(clip(thrown && thrown.message ? thrown.message : thrown, MESSAGE_LIMIT))
      scene = page ? await sceneOf(page, seen).catch((error) => `the scene was not read: ${clip(error && error.message ? error.message : error, 200)}`) : null
    }

    at(record, 'closing the context of the observation')

    const closing = await context.close().then(() => null, (thrown) => `the context did not close: ${clip(thrown && thrown.message ? thrown.message : thrown, 500)}`)

    if (closing) {
      problems.push(closing)
    }
  }

  open.delete(record)
  tell()

  const unnamed = [...record.errors.filter((text) => !named.has(text)).map((text) => `page error: ${clip(text, TEXT_LIMIT)}`), ...record.console.filter((text) => !named.has(text)).map((text) => `console error: ${clip(text, TEXT_LIMIT)}`)]

  if (!problems.length && unnamed.length) {
    problems.push(`the page raised ${unnamed.length} unexpected error${unnamed.length === 1 ? '' : 's'}, the first: ${unnamed[0]}`)
  }

  return { value, error: problems.length ? problems.join('\n') : null, phase: record.phase, scene, errors: record.errors.map((text) => clip(text, TEXT_LIMIT)), console: record.console.map((text) => clip(text, TEXT_LIMIT)), failed: record.failed, unexpected: unnamed }
}

// An observation that did not happen, as the record of one: a server that did not start, a child that ended badly.
const failedObservation = (message, phase = 'starting') => ({ value: null, error: clip(message, MESSAGE_LIMIT), phase, scene: null, errors: [], console: [], failed: [], unexpected: [] })

// An observation that went through and saw nothing wrong, with the value given.
const completedObservation = (value) => ({ value, error: null, phase: 'finished', scene: null, errors: [], console: [], failed: [], unexpected: [] })

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

// The whole record of a failed observation, printed where the failure is first met: the phase, the message with the call log, what the page showed when the work stopped, and what the page and the browser reported.
const describe = (label, seen) => `BROWSER ${label} did not get through\n  phase: ${seen.phase}\n  error: ${String(seen.error).replace(/\n/g, '\n    ')}${seen.scene ? `\n  the page then:\n    ${seen.scene.replace(/\n/g, '\n    ')}` : ''}\n  page errors:${list(seen.errors)}\n  console errors:${list(seen.console)}\n  failed requests:${list(seen.failed)}`

const report = (label, seen) => {
  if (seen.error !== null) {
    console.error(describe(label, seen))
  }
}

// ---------- the page has finished its reads ----------

// Run in the page by `settled`: `{ limit }` is the longest it waits in milliseconds, `loading` a function that says whether the page still works on what it read (or null). One round lets the page run what an answer sets going (a microtask, a task, then two frames of the renderer), and the page is settled when a round that began with no call out ends with none out, none started during it and `loading` saying no: a round that began with a call out does not count, as that call's answer may have come during it and what the answer sets going runs after the round has ended. A call that started during the round, or that is out after it, makes another round once the calls are in, so a read that a watcher starts when another finishes, and one that read starts in turn, is waited for to its end. It never waits on a quiet period: how long it takes is what the reads take. What the page has only scheduled for later than the round (a timer, a debounce) is not a call out: a step that sets one going waits for its effect first. At the limit the wait ends as a failure, whichever part of it was under way (`stage`), never as a page that has settled.
const settleInPage = async ({ limit }, loading) => {
  const reads = window.__auroraReads

  if (!reads) {
    return { signal: false }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const EXPIRED = {}
  let timer = null
  let stage = ''
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, limit, EXPIRED)
  })
  const within = async (promise, part) => {
    stage = part

    if ((await Promise.race([promise, expired])) === EXPIRED) {
      throw EXPIRED
    }
  }

  try {
    for (;;) {
      const open = reads.pending.size
      const before = reads.started

      await within(sleep(0), 'a task of its own')
      await within(frames(), 'two frames')

      const working = Boolean(loading && loading())

      if (!open && !working && reads.started === before) {
        return { signal: true, settled: true }
      }

      if (reads.pending.size) {
        await within(reads.idle(), 'the calls out')
      }
    }
  } catch (thrown) {
    if (thrown !== EXPIRED) {
      throw thrown
    }

    return { signal: true, settled: false, pending: [...reads.pending.values()], working: Boolean(loading && loading()), stage }
  } finally {
    clearTimeout(timer)
  }
}

const SETTLE_LIMIT = 120000
const SETTLE_NAMED = 5

// Waits until the reads the page has started are done, by the page's own count of its database calls (scripts/web/shims/pending-reads.js) and no quiet period, and until `loading`, a function run in the page (scripts/page-loading.js is one), says the page is done working on them. Bounded by `limit` (ms): past it the wait throws and names what was still out. A page with no count is a HarnessError, never a page that has settled.
const settled = async (page, { limit = SETTLE_LIMIT, loading = null } = {}) => {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new HarnessError(`the limit of a wait for the page to settle is a number of milliseconds above 0, not ${String(limit)}`)
  }

  if (loading !== null && typeof loading !== 'function') {
    throw new HarnessError('what says the page is still loading is a function run in the page, or null')
  }

  const seen = await page.evaluate(`(${settleInPage})(${JSON.stringify({ limit })}, ${loading ? `(${loading})` : 'null'})`)

  if (!seen.signal) {
    throw new HarnessError('the page has no count of its database calls (window.__auroraReads, put there by scripts/web/shims/pending-reads.js): it is not served by the web shims, and a wait for its reads would end at once')
  }

  if (!seen.settled) {
    const named = seen.pending.slice(0, SETTLE_NAMED).join('; ')

    throw new Error(`the page did not settle within ${limit} ms, while waiting for ${seen.stage}: ${seen.pending.length} database calls still out${seen.pending.length ? ` (${named}${seen.pending.length > SETTLE_NAMED ? `; and ${seen.pending.length - SETTLE_NAMED} more` : ''})` : ''}${seen.working ? ', and the page still loading' : ''}`)
  }
}

// ---------- the screen as the player sees it ----------

// Run in the page by `installScreen`: the readers, at `window.__screen`. Each takes an element and throws for anything else, which fails the observation; a check finds its elements by their hooks, so a fault that removes one shows as an element that is not there, never as a read of nothing.
// - visible(element): the element is drawn where the player can see it. It passes `checkVisibility` with the CSS visibility and the opacity of itself and of its ancestors (display, visibility, content-visibility, an opacity of 0), and its layout box has an area some of which the ancestors that clip it leave drawn: an ancestor whose overflow hides or clips an axis cuts the box to its own in that axis, where overflow applies (a block, flex or grid container, a table cell; never an inline box, a box of `display: contents` or a row or group of a table). A box positioned out of the flow is cut only by the ancestors that contain it: an absolute one by its containing block and those above it, a fixed one by the same but never by a block that is only positioned, and by none when there is no such block. Its containing block, as Chromium makes one, is the nearest ancestor that is positioned (for an absolute box) or that holds it: filtered on any box, or transformed, given a perspective or under layout or paint containment on a box that is not inline; size containment alone holds none. An overflow that scrolls cuts nothing, as what it hides can be scrolled to, and neither does the window.
// - visibleText(element): the text the element draws, from its text nodes and never from `textContent`: a text node counts when the element it sits in passes `checkVisibility` as above and some line of the text itself has an area that this element and the ancestors that clip it leave drawn. The text's own box stands for its element's: an element of no area whose overflow is hidden draws none of its text, and one whose overflow shows draws it, as the browser does (that element is not `visible` all the same). The whitespace the browser collapses under `white-space: normal` (runs of ASCII spaces, tabs and line breaks) is one space, and none at either end; every other character is kept as it is, the spaces of Unicode (U+00A0, U+202F, U+2003 and the like) included, as the browser draws them.
// - hooked(root, attribute): each element under `root` that carries `attribute`, in the order of the document, as { role, text, on }: the value of the attribute (the role or the identity the hook gives, never the decision a check asserts), the element's `visibleText`, and whether it is on screen: `visible`, or drawing text of its own (an element of no area whose overflow shows its text is seen by the text).
const screenReaders = () => {
  const CLIPS = ['hidden', 'clip']
  const elementOf = (value) => {
    if (!(value instanceof Element)) {
      throw new TypeError(`the screen readers read an element, not ${value === null ? 'null' : typeof value}`)
    }

    return value
  }
  const shown = (element) => element.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true })
  // Whether `will-change` promises one of `names`.
  const promised = (style, names) => String(style.willChange).split(', ').some((name) => names.includes(name))
  // Whether an ancestor is the containing block of the out-of-flow boxes below it whatever its position, as Chromium makes one: filtered, or promised a filter, whatever its box; transformed, given a perspective or under layout or paint containment, or promised one of them, only when its box is not inline. A box of `display: contents` has no box and holds nothing, and size containment alone (`contain: size`, `container-type`) makes none.
  const holds = (style) => style.display !== 'contents' && (['filter', 'backdropFilter'].some((name) => (style[name] || 'none') !== 'none') || promised(style, ['filter', 'backdrop-filter']) || (style.display !== 'inline' && (['transform', 'translate', 'rotate', 'scale', 'perspective'].some((name) => (style[name] || 'none') !== 'none') || /\b(layout|paint|strict|content)\b/.test(style.contain) || style.contentVisibility === 'auto' || promised(style, ['transform', 'translate', 'rotate', 'scale', 'perspective', 'contain']))))
  // Whether an ancestor contains a box positioned as `out`: an absolute one is contained by a positioned ancestor or one that holds it, a fixed one only by one that holds it, any other by its parent.
  const contains = (style, out) => (out === 'fixed' ? holds(style) : out === 'absolute' ? style.position !== 'static' || holds(style) : true)
  // Whether the overflow of an ancestor applies to its box: not to an inline box, a box of `display: contents` or a row, column or group of a table.
  const clips = (style) => style.display !== 'inline' && style.display !== 'contents' && !/^table-(row|column|header|footer)/.test(style.display)
  // Whether some of `rect` is left drawn by the ancestors from `from` up that contain a box positioned as `position`.
  const drawn = (rect, from, position) => {
    let [left, top, right, bottom] = [rect.left, rect.top, rect.right, rect.bottom]
    let out = position

    for (let element = from; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
      const style = getComputedStyle(element)

      if (!contains(style, out)) {
        continue
      }

      if (clips(style)) {
        const box = element.getBoundingClientRect()

        if (CLIPS.includes(style.overflowX)) {
          left = Math.max(left, box.left)
          right = Math.min(right, box.right)
        }

        if (CLIPS.includes(style.overflowY)) {
          top = Math.max(top, box.top)
          bottom = Math.min(bottom, box.bottom)
        }
      }

      out = style.position
    }

    return right > left && bottom > top
  }
  const visible = (value) => {
    const element = elementOf(value)

    return shown(element) && drawn(element.getBoundingClientRect(), element.parentElement, getComputedStyle(element).position)
  }
  const visibleText = (value) => {
    const walker = document.createTreeWalker(elementOf(value), NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let text = ''

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement

      range.selectNodeContents(node)

      if (parent && shown(parent) && [...range.getClientRects()].some((rect) => drawn(rect, parent, 'static'))) {
        text += node.data
      }
    }

    return text.replace(/[ \t\n\r]+/g, ' ').replace(/^ | $/g, '')
  }
  const hooked = (root, attribute) => [...elementOf(root).querySelectorAll(`[${CSS.escape(attribute)}]`)].map((element) => {
    const text = visibleText(element)

    return { role: element.getAttribute(attribute), text, on: visible(element) || text !== '' }
  })

  window.__screen = { visible, visibleText, hooked }
}

// Puts the readers at `window.__screen` in the page, now and in each document the page loads after.
const installScreen = async (page) => {
  await page.addInitScript(screenReaders)
  await page.evaluate(screenReaders)
}

// The character each name of the "Thousands Separator" setting puts between groups of three digits: the check's own table, which scripts/check-browser-observe.js tries against the page's formatter (thousandsSeparator and countText in src/renderer/utilities/math.js) and which is never built from it.
const GROUPINGS = Object.freeze({ Tick: '\'', Comma: ',', Dash: '-', Space: ' ', None: '' })
// The signs a figure may start with: the ASCII hyphen-minus and the minus sign U+2212 make it negative, a plus positive.
const SIGNS = Object.freeze({ '-': -1, '\u2212': -1, '+': 1 })

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const patternOf = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A number read back from the text an element draws, whole: one optional sign, digits grouped in threes by the character of the `grouping` (the name of the setting, Tick, Comma, Dash, Space or None, under which the digits are not grouped), and an optional decimal part after a point; a trailing .0 is the same number. Anything else is null, never the number of a part of the text: any other character anywhere (a unit, a space that is not the grouping's, a second sign or point, a digit of another script), a group of another size, a leading zero, a point with no digits on one side, a minus before a zero. A `grouping` that is not a name of the setting is a HarnessError.
const readFigure = (text, grouping) => {
  if (typeof grouping !== 'string' || !has(GROUPINGS, grouping)) {
    throw new HarnessError(`readFigure reads the groupings of the setting (${Object.keys(GROUPINGS).join(', ')}), not ${JSON.stringify(grouping)}`)
  }

  if (typeof text !== 'string') {
    return null
  }

  const sign = has(SIGNS, text.charAt(0)) ? SIGNS[text.charAt(0)] : 0
  const separator = GROUPINGS[grouping]
  const match = new RegExp(`^(${separator ? `\\d{1,3}(?:${patternOf(separator)}\\d{3})*` : '\\d+'})(?:\\.(\\d+))?$`).exec(sign ? text.slice(1) : text)

  if (!match) {
    return null
  }

  const digits = separator ? match[1].split(separator).join('') : match[1]
  const value = Number(`${digits}${match[2] === undefined ? '' : `.${match[2]}`}`)

  if (/^0\d/.test(digits) || (sign < 0 && value === 0)) {
    return null
  }

  return sign < 0 ? -value : value
}

// The number the page shows of `value` written to `decimals` places, rounded as the page's formatter rounds it (the value times ten to the places, to the nearest whole number with a half toward +∞, and back): the oracle's side of a figure, compared as a number with what `readFigure` reads. A value that is no finite number, or places that are no whole number from 0, are a HarnessError.
const rounded = (value, decimals = 0) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(decimals) || decimals < 0) {
    throw new HarnessError(`rounded takes a finite number and a whole number of places, not ${JSON.stringify([value, decimals])}`)
  }

  return Math.round(value * 10 ** decimals) / 10 ** decimals
}

const isEntry = (entry) => Boolean(entry) && typeof entry.role === 'string' && typeof entry.text === 'string' && typeof entry.on === 'boolean'

// What a region draws, read by the role of each element that draws a part of it (`entries` as `hooked` gives them), against `expected` ({ role: wanted }), never by the place of an element and never as a set. Only the elements on screen are read, as the player sees no other. A role whose wanted value is not null is drawn by exactly one element on screen, whose text `read` turns into the wanted value (compared with ===; `read` is the text itself when none is given); a role whose wanted value is null (or undefined) is drawn by none; a role `expected` does not name is drawn by none. Returns the problems, each [what, role, ...what was seen], none when the region draws what is expected. Entries of another shape, an `expected` that is no object or a `read` that is no function are a HarnessError.
const rolesRead = (what, entries, expected, read = (text) => text) => {
  if (!Array.isArray(entries) || !entries.every(isEntry) || !expected || typeof expected !== 'object' || Array.isArray(expected) || typeof read !== 'function') {
    throw new HarnessError(`rolesRead of ${what} reads entries { role, text, on } against an object of roles with a function to read each text`)
  }

  const byRole = new Map()
  const problems = []

  entries.filter((entry) => entry.on).forEach((entry) => byRole.set(entry.role, [...(byRole.get(entry.role) || []), entry]))
  Object.keys(expected).forEach((role) => {
    const found = byRole.get(role) || []
    const wanted = expected[role]

    if (wanted === null || wanted === undefined) {
      if (found.length) {
        problems.push([what, role, `is none and ${found.length} element${found.length === 1 ? ' draws' : 's draw'} it`, found.map((entry) => entry.text)])
      }
    } else if (found.length !== 1) {
      problems.push([what, role, `${found.length} elements on screen draw it`, entries.filter((entry) => entry.role === role).map((entry) => [entry.text, entry.on])])
    } else if (read(found[0].text) !== wanted) {
      problems.push([what, role, found[0].text, wanted])
    }
  })
  ;[...byRole.keys()].filter((role) => !has(expected, role)).forEach((role) => problems.push([what, role, 'is drawn and not expected here', byRole.get(role).map((entry) => entry.text)]))

  return problems
}

// The lines of a list the screen shows set against the oracle's rows by identity, never by place: each row has exactly one line of its identity, every line is a row's, and two rows of one identity cannot be told apart. `identityOfLine` and `identityOfRow` give the identity of each, compared as the keys of a Map. Returns { pairs: [[row, line]], problems }, each problem [what, ...what was seen]. Lists that are no arrays, or identities that are no functions, are a HarnessError.
const pairedBy = (what, lines, rows, identityOfLine, identityOfRow) => {
  if (!Array.isArray(lines) || !Array.isArray(rows) || typeof identityOfLine !== 'function' || typeof identityOfRow !== 'function') {
    throw new HarnessError(`pairedBy of ${what} pairs two lists by a function of identity for each`)
  }

  const byIdentity = new Map()
  const ids = rows.map(identityOfRow)
  const problems = []

  lines.forEach((line) => byIdentity.set(identityOfLine(line), [...(byIdentity.get(identityOfLine(line)) || []), line]))

  if (new Set(ids).size !== ids.length) {
    problems.push([what, 'two rows of the oracle have one identity', ids])
  }

  ;[...byIdentity.keys()].filter((id) => !ids.includes(id)).forEach((id) => problems.push([what, 'a line of an identity no row has', id]))

  const pairs = rows.flatMap((row, index) => {
    const found = byIdentity.get(ids[index]) || []

    if (found.length !== 1) {
      problems.push([what, ids[index], `${found.length} lines`])

      return []
    }

    return [[row, found[0]]]
  })

  return { pairs, problems }
}

// The key whose label in `labels` (a component's or a module's own table of words, { key: label }) is the text drawn: the kind a displayed word stands for, read back through that table and never through the hook. Null when no label, or more than one, is that text. `labels` that are no object are a HarnessError.
const labelKey = (text, labels) => {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new HarnessError('labelKey reads a text back through an object of labels')
  }

  const keys = Object.keys(labels).filter((key) => labels[key] === text)

  return keys.length === 1 ? keys[0] : null
}

module.exports = { observe, validate, failedObservation, completedObservation, failureLine, describe, report, HarnessError, settled, installScreen, GROUPINGS, readFigure, rounded, rolesRead, pairedBy, labelKey }
