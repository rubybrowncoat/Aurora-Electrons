/*
  Regression check of long labels and numeric layout under the typeface families and text scales, in a browser.

  BASE_URL=http://127.0.0.1:9081 bun scripts/check-typography.js

  It needs the web mode running (`bun run web`, the dev server) with a save the page can open.

  Per page, typeface and scale it previews the typeface and scale, scans the page and fails on: text cut without an ellipsis (a clipped number, label or button), a number or a short label wrapping, a control outside the window or lying over another, a navigation rail label outside the rail, and a page scrolling sideways. Every element that ends in an ellipsis is then reached twice: with the pointer, where its title or an ancestor's must hold its complete text, and, when a control holds it, with the keyboard, where focusing the control must show a popup with the complete text, tied to the control by aria-describedby only while it shows (and not when the control's own name holds the whole text), and inside the window, that is gone when focus leaves. For a select the menu is also opened with the keyboard: the popup must not be there, nor cover an option, while the menu is open, and must be back when Escape closes the menu with the focus kept. A failure a page is known to have is listed in KNOWN by route, kind, text and the place it shows (its panel, its table and its column: the same place in every save); that failure alone is reported, once per place and text, and does not fail the run, and every other problem, on that page or in another place on it, still does.

  A page counts as read only when it rendered: the main area must hold the routed view with content, and an error the page reports while it is read (an uncaught error, or anything written to the console as an error, which is where Vue writes the error of a render) is a failure, named with the route or step it was observed in (not the one that started an asynchronous read: a read begun on one page that settles on the next is tagged with the next) (the palette step included) and drained at the end of every step, so none is left unreported. A scan of a page that rendered nothing finds nothing, and would pass.

  Once per run it mounts fixtures in the page and proves that the check itself notices: a number clipped inside a table, a title that holds only a part of the text; and that the plugin behaves: the full text under the pointer, a title of the page kept next to it, a title the page took over left alone, an element changed under a pointer that does not move (shorter text, longer text, wider, narrower), an element that fits and comes to be cut under a pointer that does not move; the keyboard popup (shown, tied, dismissed by Escape, followed through a change, followed through a change of a child's size only in a field of a fixed size, suspended while the field's menu is open and back with it, no tie to a popup that is not shown, no description by a popup when the control's name already holds the text, removed on blur); and that a KNOWN entry excuses only its own place: a wrapped number with its unit in another table of the same page is reported.

  At 1280x720 it also opens the page palette in each combination and fails when it does not fit the window.

  What it does not cover, and was measured once by hand for the task that added it (docs/plans/backlog/evidence/AE-015-01.md): the other dialogs, the navigation flyouts and the help drawer, chart axes and ticks, canvas and Cytoscape labels, and the fallback of a typeface that is not installed.

  FULL=1 runs a pairwise matrix of typeface, scale and viewport, plus every family at the largest scale on 1280x720; the default is a short matrix on 1280x720. PAGES=/production,/finances narrows the pages.
  VIEWPORTS=1920x1080 selects a focused viewport. --part=pages omits fixtures; --part=web-address runs the address regression; --part=matrix runs the matrix invariants, faults and reordered rewrite; --part=open-failure proves a required dependency's HTTP 504 stops the first step; --part=reader-failure proves a reader that throws after the first page opened leaves the other steps running. TYPOGRAPHY_TIMING=1 reports measured phases of each page read.
*/
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const Module = require('module')
const { chromium } = require('playwright')
const assert = require('./lib/bounded-assert')
const { patched } = require('./lib/mutant-source')
const { inParallel, jobs, runChild, startChild, lastJson } = require('./lib/check-pool')

const BASE = process.env.BASE_URL || 'http://127.0.0.1:9080'
const FULL = process.env.FULL === '1'
const FULL_VIEWPORTS = [[1280, 720], [1920, 1080], [2560, 1440]]
const VIEWPORTS = process.env.VIEWPORTS ? process.env.VIEWPORTS.split(',').map((size) => size.split('x').map(Number)) : FULL ? FULL_VIEWPORTS : [[1280, 720]]
const FAMILIES = ['roboto', 'roboto-condensed', 'system', 'verdana', 'monospace']
const SCALES = [0.9, 1, 1.1, 1.25]
const COMBOS = FULL ? FAMILIES.flatMap((family) => SCALES.map((scale) => [family, scale])) : [['roboto', 1], ['roboto-condensed', 1.25], ['system', 0.9], ['verdana', 1.25], ['monospace', 1.25]]
const FULL_MATRIX = {
  '1280x720': [
    ['roboto', 0.9],
    ['roboto', 1.25],
    ['roboto-condensed', 1.1],
    ['roboto-condensed', 1.25],
    ['system', 1],
    ['system', 1.25],
    ['verdana', 0.9],
    ['verdana', 1.25],
    ['monospace', 1.1],
    ['monospace', 1.25],
  ],
  '1920x1080': [
    ['roboto', 1],
    ['roboto-condensed', 0.9],
    ['roboto-condensed', 1.25],
    ['system', 1.1],
    ['verdana', 1],
    ['monospace', 0.9],
    ['monospace', 1.25],
  ],
  '2560x1440': [
    ['roboto', 1.1],
    ['roboto-condensed', 1],
    ['system', 0.9],
    ['system', 1.25],
    ['verdana', 1.1],
    ['monospace', 1],
  ],
}

const missingPairs = (expected, actual) => {
  const seen = new Set(actual)

  return expected.filter((pair) => !seen.has(pair))
}

const MATRIX_CHECKS = [
  ['matrix-count', (rows) => rows.length === 23 && new Set(rows.map(({ viewport, family, scale }) => `${viewport}/${family}/${scale}`)).size === 23 ? [] : ['the matrix does not hold exactly 23 unique combinations']],
  ['matrix-family-scale', (rows) => missingPairs(FAMILIES.flatMap((family) => SCALES.map((scale) => `${family}/${scale}`)), rows.map(({ family, scale }) => `${family}/${scale}`))],
  ['matrix-family-viewport', (rows) => missingPairs(FAMILIES.flatMap((family) => FULL_VIEWPORTS.map((size) => `${family}/${size.join('x')}`)), rows.map(({ family, viewport }) => `${family}/${viewport}`))],
  ['matrix-scale-viewport', (rows) => missingPairs(SCALES.flatMap((scale) => FULL_VIEWPORTS.map((size) => `${scale}/${size.join('x')}`)), rows.map(({ scale, viewport }) => `${scale}/${viewport}`))],
  ['matrix-extremes', (rows) => missingPairs(FAMILIES, rows.filter(({ viewport, scale }) => viewport === '1280x720' && scale === 1.25).map(({ family }) => family))],
]

const matrixChecks = () => {
  const rows = Object.entries(FULL_MATRIX).flatMap(([viewport, combos]) => combos.map(([family, scale]) => ({ viewport, family, scale })))
  let passed = 0
  const check = (name, missing, fault = false) => {
    const ok = fault ? missing.length > 0 : missing.length === 0

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${missing.length ? ` [${missing.join(', ')}]` : ''}`)
    assert.ok(ok, name)
    passed++
  }

  MATRIX_CHECKS.forEach(([name, inspect]) => check(name, inspect(rows)))

  const faults = [
    ['matrix-count', [...rows, rows[0]]],
    ['matrix-family-scale', rows.filter(({ family, scale }) => !(family === 'roboto' && scale === 0.9))],
    ['matrix-family-viewport', rows.filter(({ family, viewport }) => !(family === 'monospace' && viewport === '2560x1440'))],
    ['matrix-scale-viewport', rows.filter(({ scale, viewport }) => !(scale === 1 && viewport === '1920x1080'))],
    ['matrix-extremes', rows.filter(({ family, scale, viewport }) => !(family === 'roboto-condensed' && scale === 1.25 && viewport === '1280x720'))],
  ]

  faults.forEach(([name, changed]) => check(`${name}: planted fault`, MATRIX_CHECKS.find(([key]) => key === name)[1](changed), true))
  check('matrix: reordered benign rewrite', MATRIX_CHECKS.flatMap(([, inspect]) => inspect([...rows].reverse())))
  console.log(`${passed}/${MATRIX_CHECKS.length + faults.length + 1} matrix checks passed`)
}
const PAGES = (process.env.PAGES || '/production,/warnings,/finances,/colony-outlook,/habitability,/logistics,/information,/map,/commanders,/technologies,/designed-tech,/shipyards,/minerals,/settings,/about').split(',')
const PART = process.argv.find((arg) => arg.startsWith('--part='))?.slice(7) || 'all'
const TIMING = process.env.TYPOGRAPHY_TIMING === '1'
const WEB_FILE = path.join(__dirname, 'web.js')
const WEB_VARIANTS = [
  { key: 'head' },
  { key: 'printed-hostname', fault: true, patch: ["const url = server.resolvedUrls.local[0].replace(/\\/$/, '')", 'const url = `http://localhost:$' + '{server.httpServer.address().port}`'] },
  { key: 'bound-hostname', fault: true, patch: ['host: HOST', "host: 'localhost'"] },
  { key: 'parenthesized-host', patch: ['host: HOST', 'host: (HOST)'] },
]

const webAddressChild = (key, folder, keepAlive = false) => {
  const variant = key === 'dependency-504' || key === 'healthy' ? { key } : WEB_VARIANTS.find((entry) => entry.key === key)

  assert.ok(variant, `unknown web address variant: ${key}`)

  let source = fs.readFileSync(WEB_FILE, 'utf8')

  if (variant.patch) {
    source = patched(WEB_FILE, source, ...variant.patch)
  }

  source = patched(WEB_FILE, source, 'const PORT = Number(process.env.PORT) || 9080', 'const PORT = 0')
  source = patched(WEB_FILE, source, "cacheDir: path.join(__dirname, '..', '.vite-web')", `cacheDir: ${JSON.stringify(path.join(folder, 'vite-cache'))}`)

  if (key === 'dependency-504') {
    source = patched(WEB_FILE, source, 'server.middlewares.use(guardHost)', "server.middlewares.use((request, response, next) => {\n        if (request.url.split('?')[0].endsWith('/deps/vue.js')) {\n          response.statusCode = 504\n          response.end('planted dependency failure')\n          return\n        }\n        next()\n      })\n      server.middlewares.use(guardHost)")
  }

  source = patched(WEB_FILE, source, 'console.log(`[web] Renderer ready at $' + '{url}`)', `console.log('WEB_ADDRESS ' + JSON.stringify({ url, address: server.httpServer.address(), cacheDir: server.config.cacheDir }))${keepAlive ? '' : '\n  await server.close()\n  process.exit(0)'}`)

  const subject = new Module(WEB_FILE, module)

  subject.filename = WEB_FILE
  subject.paths = module.paths
  subject._compile(source, WEB_FILE)
}

const webAddressChecks = async () => {
  let passed = 0

  for (const variant of WEB_VARIANTS) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-typography-address-'))
    let result

    try {
      result = await runChild(__filename, ['--web-address-child', variant.key, folder], { limit: 120000 })
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }

    assert.equal(result.timedOut, false, `web-address ${variant.key}: the child exceeded its deadline`)
    assert.equal(result.code, 0, `web-address ${variant.key}: ${result.stderr}`)

    const seen = lastJson(result, 'WEB_ADDRESS ')
    const url = new URL(seen.url)
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
    const detail = net.isIP(host) !== 4 || host !== seen.address.address || Number(url.port) !== seen.address.port ? `printed ${seen.url}, listening on ${seen.address.address}:${seen.address.port}` : ''
    const ok = variant.fault ? Boolean(detail) : !detail

    console.log(`${ok ? 'PASS' : 'FAIL'}  web-one-address: ${variant.key}${detail ? ` [${detail}]` : ''}`)
    passed += Number(ok)
  }

  assert.equal(passed, WEB_VARIANTS.length, 'the web address head and benign rewrite pass, and each planted fault fails by value')
  console.log(`${passed}/${WEB_VARIANTS.length} web address checks passed`)
}

// Runs the pages part for /about then /settings on 1280x720 against a private-cache web server of the variant `key`, and gives the child's outcome with its step lines.
const pagesAgainstServer = async (key, childArgs) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), `ae-typography-${key}-`))
  let server
  let stopped
  let result

  try {
    const ready = new Promise((resolve, reject) => {
      server = startChild(__filename, ['--web-server', key, folder], {
        limit: 120000,
        onLine: (line) => {
          if (line.startsWith('WEB_ADDRESS ')) {
            try {
              resolve(JSON.parse(line.slice('WEB_ADDRESS '.length)))
            } catch (error) {
              reject(error)
            }
          }
        },
      })
      server.done.then((ended) => reject(new Error(`the ${key} server ended before the probe: ${ended.code}, ${ended.stderr}`)), reject)
    })
    const seen = await ready

    result = await runChild(__filename, childArgs, { limit: 120000, env: { BASE_URL: seen.url, FULL: '1', VIEWPORTS: '1280x720', PAGES: '/about,/settings', TYPOGRAPHY_TIMING: '' } })
  } finally {
    try {
      if (server) {
        server.kill()
        stopped = await server.done
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  }

  assert.equal(stopped.timedOut, false, `the ${key} server must not expire`)
  assert.equal(result.timedOut, false, 'the failure must be reported before the child watchdog')
  assert.equal(result.code, 1, 'the failure fails the page check')

  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/)
  const tagged = (tag) => lines.filter((line) => line.startsWith(`${tag} `)).map((line) => JSON.parse(line.slice(tag.length + 1)))

  return { starts: tagged('STEP_START'), failed: tagged('STEP_FAILURE'), read: tagged('READER_DONE') }
}

const openingFailureCheck = async () => {
  const { starts, failed } = await pagesAgainstServer('dependency-504', ['--part=pages'])

  assert.equal(starts.length, 1, 'the unavailable app must not open each remaining step')
  assert.equal(starts[0].route, '/about', 'the first route is identified')
  assert.equal(failed.length, 1, 'the failed first step is reported immediately')
  assert.equal(failed[0].route, '/about', 'the failed route is identified')
  assert.ok(failed[0].failedRequests.some(({ url, status }) => status === 504 && new URL(url).pathname.endsWith('/deps/vue.js')), 'the failed dependency and HTTP status are reported')
  console.log(`PASS  startup-dependency-failure [${JSON.stringify(failed[0])}]`)
  console.log('1/1 dependency-failure checks passed')
}

// This script with a planted fault: the /about step's reader throws in its page once the page opened; every other step reports that its reader finished. The anchors are split so that they occur in this script only where they are replaced.
const readerFaultChild = () => {
  let source = fs.readFileSync(__filename, 'utf8')

  source = patched(__filename, source, 'const value = await work(held.page, ' + 'fail, drain)', "const value = route === '/about' ? await held.page.evaluate(() => { throw new Error('planted reader failure') }) : await work(held.page, fail, drain)\n      console.log('READER_DONE ' + JSON.stringify({ route }))")
  source = patched(__filename, source, "if (process.argv[2] === '--reader-" + "fault-child') {", 'if (false) {')

  const subject = new Module(__filename, module)

  subject.filename = __filename
  subject.paths = module.paths
  subject._compile(source, __filename)
}

const readerFailureCheck = async () => {
  const { starts, failed, read } = await pagesAgainstServer('healthy', ['--reader-fault-child', '--part=pages'])

  assert.equal(starts[0]?.route, '/about', 'the planted step runs first')
  assert.ok(starts.some(({ route }) => route === '/settings'), 'the step after the failed reader still starts')
  assert.ok(read.some(({ route }) => route === '/settings'), 'the reader after the failed one still finishes')
  assert.equal(failed.length, 1, 'only the planted step fails')
  assert.equal(failed[0].route, '/about', 'the failed route is identified')
  assert.match(failed[0].message, /planted reader failure/, 'the reader exception is kept with its step')
  console.log(`PASS  reader-failure-after-open [${starts.length} steps started, ${read.length} readers finished, ${JSON.stringify(failed[0])}]`)
  console.log('1/1 reader-failure checks passed')
}

// The renderer's font module as the dev server serves it to the page; the page imports it to preview a typeface and size.
const FONT_MODULE = '/utilities/appearance-font.js'
const failures = []
// What a page is known to fail, until it is fixed: the route, the kind, a pattern for the text and the place (`at`, as `scan` names it, exactly). The text depends on the figures in the save, so an entry that does not show is not an error.
const KNOWN = [
  { route: '/warnings', kind: 'numberWrap', text: /^"-?[\d'.,]+ MSP" /, at: 'Ships > table(Ship|Damaged components|Repair|) > column Repair', reason: 'the repair cost with its unit wraps in a narrow cell when the save has one' },
]
// What a control may hold the cut text of, to be focused and read: itself, or the first control in its field.
const FOCUSABLE = 'button, a[href], input:not([type=hidden]), [tabindex]:not([tabindex="-1"])'
const CUT = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'

// Runs in the page. Every problem is [kind, description]; a cut text with an ellipsis is marked with data-ae-cut and checked after the pointer was over it.
const scan = (focusable) => {
  const problems = []
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  // Where an element is, in words that hold in every save: its panel's title without figures, and its table's heads and column, or else its ancestors.
  const at = (element) => {
    const panel = element.closest('.panel')
    const head = panel && panel.querySelector('.panel-head')
    const title = head ? head.textContent.replace(/\s+/g, ' ').trim().replace(/\s*\d.*$/, '') : ''
    const cell = element.closest('td, th')

    if (cell) {
      const heads = [...cell.closest('table').querySelectorAll('thead th')].map((th) => th.textContent.replace(/\s+/g, ' ').trim())
      const column = [...cell.parentElement.children].indexOf(cell)

      return `${title} > table(${heads.join('|')}) > column ${heads[column] || column + 1}`
    }

    const path = []

    for (let current = element; current && current.tagName !== 'BODY' && path.length < 4; current = current.parentElement) {
      const own = [...current.classList].find((name) => !/^(v-|theme)/.test(name))

      path.unshift(current.tagName.toLowerCase() + (own ? `.${own}` : ''))
    }

    return `${title} > ${path.join(' > ')}`
  }
  const label = (element) => `${element.tagName.toLowerCase()} "${(element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 28)}"`
  const visible = (element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()

    return style.display !== 'none' && style.visibility !== 'hidden' && +style.opacity !== 0 && box.width > 0 && box.height > 0
  }
  // The part of the element that shows: its box cut by every clipping ancestor.
  const shown = (element) => {
    const box = element.getBoundingClientRect()
    let { left, top, right, bottom } = box

    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const clip = parent.getBoundingClientRect()

      if (style.overflowX !== 'visible') {
        left = Math.max(left, clip.left)
        right = Math.min(right, clip.right)
      }

      if (style.overflowY !== 'visible') {
        top = Math.max(top, clip.top)
        bottom = Math.min(bottom, clip.bottom)
      }
    }

    return right - left > 1 && bottom - top > 1 ? { left, top, right, bottom } : null
  }
  const root = document.querySelector('.v-application')
  const skip = (element) => element.closest('.v-tooltip__content, [aria-hidden="true"], .v-menu__content:not(.menuable__content__active), canvas, svg, .map-minimap, .app-footer, .rail, .help__drawer, .truncated-text-tip')
  const clips = (value) => value !== 'visible' && value !== 'auto' && value !== 'scroll'
  const scrolled = '.v-slide-group__wrapper, .v-slide-group__content'
  const main = document.querySelector('.v-main')
  let cut = 0

  document.querySelectorAll('[data-ae-cut], [data-ae-focus]').forEach((element) => {
    element.removeAttribute('data-ae-cut')
    element.removeAttribute('data-ae-focus')
  })

  if (document.documentElement.scrollWidth > vw + 1 || (main && main.scrollWidth > main.clientWidth + 1)) {
    problems.push(['overflow', `the page is wider than the window (${vw} px)`, ''])
  }

  root.querySelectorAll('*').forEach((element) => {
    if (!visible(element) || skip(element)) {
      return
    }

    const style = getComputedStyle(element)
    const texts = [...element.childNodes].filter((node) => node.nodeType === 3 && node.textContent.trim())

    if ((texts.length || element.matches('.v-btn__content, .v-chip__content, .v-label, input, button')) && shown(element)) {
      const clipX = element.scrollWidth > element.clientWidth + 1 && clips(style.overflowX)
      const clipY = element.scrollHeight > element.clientHeight + 2 && clips(style.overflowY)
      const clamped = style.webkitLineClamp && style.webkitLineClamp !== 'none'

      if ((clipX && style.textOverflow === 'ellipsis') || (clipY && clamped)) {
        const field = element.closest('.v-input')
        const control = element.closest('button, a[href], [tabindex]:not([tabindex="-1"])') || (field && field.querySelector(focusable))

        element.setAttribute('data-ae-cut', String(cut))

        if (control && !control.disabled) {
          control.setAttribute('data-ae-focus', String(cut))
        }

        cut++
      } else if ((clipX || clipY) && !element.matches(scrolled)) {
        problems.push([clipX ? 'clipX' : 'clipY', label(element), at(element)])
      }
    }

    if (texts.length) {
      const text = texts.map((node) => node.textContent).join(' ').trim().replace(/\s+/g, ' ')
      const lines = new Set(texts.flatMap((node) => {
        const range = document.createRange()

        range.selectNodeContents(node)

        return [...range.getClientRects()].filter((box) => box.width > 0).map((box) => Math.round(box.top / 4))
      })).size
      const number = text.length <= 24 && /^[+\u2212\-\u2013]?\d[\d'.,\u202F\u00A0]*(?:\s?[A-Za-z\u00B5%/\u00B7^\u00B2\u00B3]{1,8})?$/.test(text)

      if (lines > 1 && number) {
        problems.push(['numberWrap', `"${text}" on ${lines} lines`, at(element)])
      } else if (lines > 1 && text.length <= 22 && element.matches('th, label, .v-btn__content, .v-chip__content, .v-tab, .v-label, .v-list-item__title')) {
        problems.push(['wrap', `"${text}" on ${lines} lines`, at(element)])
      }
    }
  })

  const boxes = [...root.querySelectorAll('button, a[href], input:not([type=hidden]), [role=button], [role=tab], [role=link], .v-btn, .v-chip--link, .v-tab, .v-select')].filter((element) => visible(element) && !skip(element) && !element.disabled).map((element) => ({ element, box: shown(element) })).filter((entry) => entry.box)
  const area = ({ box }) => (box.right - box.left) * (box.bottom - box.top)

  boxes.forEach((entry) => {
    if (entry.box.right > vw + 1 || entry.box.left < -1) {
      problems.push(['offscreen', `${label(entry.element)} ${Math.round(entry.box.left)}..${Math.round(entry.box.right)} of ${vw}`, at(entry.element)])
    }
  })

  boxes.forEach((a, index) => boxes.slice(index + 1).forEach((b) => {
    const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left)
    const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)

    if (!a.element.contains(b.element) && !b.element.contains(a.element) && width > 4 && height > 4 && (width * height) / Math.min(area(a), area(b)) > 0.3) {
      problems.push(['overlap', `${label(a.element)} / ${label(b.element)}`, at(a.element)])
    }
  }))

  document.querySelectorAll('.rail__label').forEach((element) => {
    const box = element.getBoundingClientRect()

    if (box.left < -0.5 || box.right > 80.5 || (element.textContent.trim() === 'About' && box.bottom > vh)) {
      problems.push(['rail', `${element.textContent.trim()} ${Math.round(box.left)}..${Math.round(box.right)}`, ''])
    }
  })

  return { problems, cut }
}

const normal = (text) => (text || '').replace(/\s+/g, ' ').trim()

// Whether a title holds the complete text: all of it, and in a longer title, among other words.
const covers = (title, text) => Boolean(title) && normal(title).includes(normal(text))

// The same for an accessible name, which the browser gives in the case the control is drawn in (a Vuetify button's text-transform makes `Save every design` the name `SAVE EVERY DESIGN`): the whole text is still required, in either case.
const covered = (name, text) => Boolean(name) && normal(name).toLowerCase().includes(normal(text).toLowerCase())

// Runs in the page. Whether the requested page rendered: the routed view has a root element with content in the main area, besides the section navigation and the notice that a save cannot show the page. A component whose render failed or returned nothing leaves only an empty comment node there, and a scan of that finds no problem because there is nothing to find.
const rendered = () => {
  const root = document.querySelector('.v-main .container--fluid')

  return Boolean(root) && [...root.children].some((child) => {
    const box = child.getBoundingClientRect()

    return !child.matches('.section-nav-root, .capability-state') && box.width > 0 && box.height > 0 && (child.textContent || '').trim() !== ''
  })
}

// What the page reported while it ran: errors the page did not catch, and every error written to the console (Vue writes the error of a render or of a hook there), except that a resource failed to load. Each is kept with the phase it came in (`page.aePhase`: the route being opened or read, `open`, or the palette) until a read or the end of a step takes it, so a failure says where it happened and none is left behind.
const watch = (page) => {
  const note = (message) => page.aeErrors.push({ phase: page.aePhase || 'start', message: message.split('\n')[0].slice(0, 300) })

  page.aeErrors = []
  page.aeFailedRequests = []
  page.aePending = 0
  page.on('request', () => page.aePending++)
  page.on('requestfinished', () => page.aePending--)
  page.on('requestfailed', (request) => {
    page.aePending--
    page.aeFailedRequests.push({ url: request.url(), resource: request.resourceType(), error: request.failure()?.errorText, phase: page.aePhase || 'open' })
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      page.aeFailedRequests.push({ url: response.url(), resource: response.request().resourceType(), status: response.status(), phase: page.aePhase || 'open' })
    }
  })
  page.on('pageerror', (error) => note(`uncaught: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/^Failed to load resource/.test(message.text())) {
      note(message.text())
    }
  })
}

// Everything reported since the last take, once per message and phase, as problems of the kind `runtime`.
const errorsOf = (page) => [...new Set(page.aeErrors.splice(0).map(({ phase, message }) => `${message} [during ${phase}]`))].map((text) => ['runtime', text])

// Runs in the page. Resolves once nothing has changed for `quiet` ms and two frames have been drawn since: no change to the document (a node, an attribute, a text) and no transition or animation with an end still running; endless animations (a spinner) do not count. Resolves at `max` ms at the latest, so a page that never stops changing is read after the same time a fixed wait would have given it.
const quietPage = ([quiet, max]) => new Promise((resolve) => {
  let last = performance.now()
  let frames = 0
  const observer = new MutationObserver(() => {
    last = performance.now()
    frames = 0
  })
  const stop = () => {
    observer.disconnect()
    clearTimeout(cap)
    resolve()
  }
  const cap = setTimeout(stop, max)
  const tick = () => {
    frames++

    if (document.getAnimations().some((animation) => animation.playState === 'running' && animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime))) {
      last = performance.now()
      frames = 0
    }

    if (frames >= 2 && performance.now() - last >= quiet) {
      stop()
    } else {
      requestAnimationFrame(tick)
    }
  }

  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  requestAnimationFrame(tick)
})

// Waits until the page has settled (see `quietPage`) and has no request in flight, for `max` ms at most: what a fixed wait of `max` ms stood for, ending as soon as the page is still.
const settle = async (page, quiet, max) => {
  const deadline = Date.now() + max

  do {
    await page.evaluate(quietPage, [quiet, Math.max(deadline - Date.now(), 1)])
  } while (page.aePending > 0 && Date.now() < deadline)
}

// The pointer over the centre of the start of a selector's element, scrolled into view, after it was parked in the corner.
const hoverOn = async (page, selector) => {
  const { x, y } = await page.evaluate((query) => {
    const element = document.querySelector(query)

    element.scrollIntoView({ block: 'center' })

    const box = element.getBoundingClientRect()

    return { x: box.left + Math.min(box.width, 40) / 2, y: box.top + box.height / 2 }
  }, selector)

  await page.mouse.move(page.viewportSize().width - 2, 2)
  await page.mouse.move(x, y)
  await settle(page, 40, 120)

  return { x, y }
}

// The title the browser would show at a point: the nearest one at or above the element there.
const titleAt = (page, { x, y }) => page.evaluate(([px, py]) => {
  for (let element = document.elementFromPoint(px, py); element; element = element.parentElement) {
    if (element.hasAttribute('title')) {
      return element.getAttribute('title')
    }
  }

  return null
}, [x, y])

const textOf = (page, selector) => page.evaluate((query) => (document.querySelector(query).textContent || '').replace(/\s+/g, ' ').trim(), selector)

// With the pointer: the title of a cut element holds its complete text.
const reach = async (page, index) => {
  const selector = `[data-ae-cut="${index}"]`
  const text = await textOf(page, selector)

  return { text, title: await titleAt(page, await hoverOn(page, selector)) }
}

// What the keyboard gets once `control` has focus: the popup, its text, whether it is tied to the control and inside the window.
const popupOf = (page, selector) => page.evaluate((query) => {
  const control = document.querySelector(query)
  const popup = document.querySelector('.truncated-text-tip[role="tooltip"]')
  const box = popup && popup.getBoundingClientRect()

  if (!control) {
    throw new Error(`the page reloaded during the run: ${query} is gone`)
  }

  return {
    text: popup ? (popup.textContent || '').replace(/\s+/g, ' ').trim() : null,
    parts: popup ? popup.textContent.split('\n').map((part) => part.replace(/\s+/g, ' ').trim()) : [],
    id: popup ? popup.id : null,
    tied: Boolean(popup) && (control.getAttribute('aria-describedby') || '').split(/\s+/).includes(popup.id),
    inside: Boolean(box) && box.left >= 0 && box.top >= 0 && box.right <= document.documentElement.clientWidth && box.bottom <= document.documentElement.clientHeight,
    described: control.getAttribute('aria-describedby'),
  }
}, selector)

// Whether the text is still cut now: a label that floats up when its field has focus is shown in full, and then there is nothing left to say.
const stillCut = (page, index) => page.evaluate((i) => {
  const element = document.querySelector(`[data-ae-cut="${i}"]`)
  const { textOverflow, webkitLineClamp } = getComputedStyle(element)

  return (textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1) || (webkitLineClamp !== 'none' && element.scrollHeight > element.clientHeight + 1)
}, index)

// The name and the description the browser gives a control in its accessibility tree: what a screen reader is told, not what the attributes say.
const accessibleOf = async (page, selector) => {
  const session = page.aeSession || (page.aeSession = await page.context().newCDPSession(page))
  const { root } = await session.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  const { nodes } = await session.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })

  return { name: normal(nodes[0].name && nodes[0].name.value), description: normal(nodes[0].description && nodes[0].description.value) }
}

// What is wrong with how a control is tied to its popup, if anything. The popup describes the control unless the control's own name already holds every text the popup shows, in which case it would only say it twice; and the control's own description (`before`, as the page wrote it) is kept in either case. `shown` is `popupOf` while the popup is up, `ax` is `accessibleOf` then.
const ariaProblems = ({ shown, ax, before }) => {
  const problems = []
  const wantsTie = !shown.parts.every((part) => covered(ax.name, part))
  const expected = (wantsTie ? [before, shown.id].filter(Boolean).join(' ') : before) || null

  if (shown.tied !== wantsTie) {
    problems.push(wantsTie ? `the control is not described by the popup, and its name ${JSON.stringify(ax.name)} does not hold the text` : `the control is described by the popup, and its name ${JSON.stringify(ax.name)} already holds the text`)
  }

  if ((shown.described || null) !== expected) {
    problems.push(`aria-describedby is ${JSON.stringify(shown.described)}, expected ${JSON.stringify(expected)}`)
  }

  if (wantsTie && !covers(ax.description, shown.text)) {
    problems.push(`the accessible description ${JSON.stringify(ax.description)} does not hold the text of the popup`)
  }

  return problems
}

// With the keyboard: a control that holds the cut text shows it all in a popup while it has focus and takes it away when focus leaves.
const keyboardReach = async (page, index) => {
  const control = `[data-ae-focus="${index}"]`
  const text = await textOf(page, `[data-ae-cut="${index}"]`)
  const before = await page.evaluate((query) => document.querySelector(query).getAttribute('aria-describedby'), control)

  await page.evaluate((query) => {
    const element = document.querySelector(query)

    element.scrollIntoView({ block: 'center' })
    element.focus()
  }, control)
  await settle(page, 100, 400)

  const shown = await popupOf(page, control)
  const ax = shown.text === null ? null : await accessibleOf(page, control)
  const cut = await stillCut(page, index)

  await page.evaluate((query) => document.querySelector(query).blur(), control)
  await settle(page, 30, 80)
  await page.keyboard.press('Escape')

  const left = await popupOf(page, control)

  return { text, before, shown, ax, cut, left }
}

// Opens the app and picks the race. A hot update that reloads the page in the middle of it starts it again, up to three times.
const open = async (page) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await opened(page)
    } catch (error) {
      if (attempt === 3) {
        throw error
      }
    }
  }
}

const waitForApp = async (page, failedFrom) => {
  const deadline = Date.now() + 60000

  while (Date.now() < deadline) {
    const failed = page.aeFailedRequests.slice(failedFrom).find(({ url, resource }) => resource === 'script' && url.startsWith(`${BASE}/`))

    if (failed) {
      throw new Error(`the app could not open because ${failed.url} failed (${failed.status || failed.error})`)
    }

    try {
      return await page.waitForFunction(() => window.$app && window.$app.$store, null, { timeout: Math.min(1000, Math.max(1, deadline - Date.now())) })
    } catch (error) {
      if (error.name !== 'TimeoutError' || Date.now() >= deadline) {
        throw error
      }
    }
  }

  throw new Error('the app did not expose its store within 60000 ms')
}

const opened = async (page) => {
  page.aePhase = 'open'
  const failedFrom = page.aeFailedRequests.length

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await waitForApp(page, failedFrom)
  await page.waitForFunction(() => window.$app.$store.getters.RaceID || document.querySelector('.empire-list__game'), null, { timeout: 60000 })

  if (!(await page.evaluate(() => window.$app.$store.getters.RaceID))) {
    const game = page.locator('.empire-list__game:has-text("Aurelian Empire")').first()

    await game.waitFor({ timeout: 120000 })
    await game.click()
    await page.waitForFunction(() => window.$app.$store.getters.RaceID, null, { timeout: 60000 })
    await settle(page, 400, 1500)
  }
}

// Opens a page by the router. A hot update of the dev server that reloads the page during the move sends the page back to the start, so the move is made again on the page opened afresh, up to three times.
const go = async (page, route) => {
  for (let attempt = 1; ; attempt++) {
    try {
      page.aePhase = route
      await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), route)
      await page.waitForFunction((target) => window.$app && window.$app.$route.path === target, route, { timeout: 20000 })
      await settle(page, 500, 1800)

      return
    } catch (error) {
      if (attempt === 3) {
        throw error
      }

      await open(page)
    }
  }
}

// Previews a typeface and size in the page through the renderer's own font module and waits for the faces to load.
const previewFont = (page, family, scale) => page.evaluate(async ([f, s, url]) => {
  const fonts = await import(url)

  fonts.previewFont({ family: f, scale: s })
  await fonts.whenFontsReady()
  window.__typography = `${f}:${s}`
}, [family, scale, FONT_MODULE])

// The KNOWN entry a failure is the failure of: the route it was read on, its kind, its text and its place.
const knownFor = ({ where, kind, text, at }) => KNOWN.find((item) => where.includes(` ${item.route} `) && item.kind === kind && item.text.test(text) && item.at === at)

// Mounts the fixtures: elements that end in an ellipsis in the ways the pages do, and two that the check must flag.
const mount = (cut) => {
  document.getElementById('ae-fixture')?.remove()

  const holder = document.createElement('div')

  holder.id = 'ae-fixture'
  holder.setAttribute('style', 'position:fixed;left:120px;top:90px;width:560px;z-index:9000;background:#fff;color:#000;padding:8px')
  holder.innerHTML = `
    <div id="fx-plain" style="width:60px;${cut}">Critical columns of the report</div>
    <div id="fx-note" title="Estimated: from the survey of twelve systems"><div id="fx-note-value" style="width:60px;${cut}">12'345'678 BP/yr</div></div>
    <div id="fx-page" title="Critical col" style="width:60px;${cut}">Critical columns of the report</div>
    <div id="fx-live" style="width:60px;${cut}">Counter 1234567890</div>
    <div class="v-data-table__wrapper" style="width:200px;overflow:auto"><table><tbody><tr><td><span id="fx-signed" style="display:inline-block;width:14px;overflow:hidden;white-space:nowrap;vertical-align:bottom">-123456789 MSP</span></td></tr></tbody></table></div>
    <div class="v-input"><div class="v-input__slot"><div class="v-select__selections"><div id="fx-select" style="width:60px;${cut}">Long selected value text</div><input id="fx-input" readonly></div></div></div>
    <div id="fx-fit" style="width:400px;${cut}">Fits for now</div>
    <div class="v-input" id="fx-fixed" style="width:240px;height:34px;overflow:hidden;display:flex"><div class="v-input__slot" style="display:flex;width:240px;height:34px"><div id="fx-child" style="flex:none;width:60px;${cut}">Text inside a box of one size</div><input id="fx-fixed-input" style="width:10px" readonly></div></div>
    <div class="v-input" id="fx-menu"><div class="v-input__slot" aria-haspopup="listbox" aria-expanded="false"><div id="fx-menu-text" style="width:60px;${cut}">Value of a field with a menu</div><input id="fx-menu-input" readonly></div></div>
    <div class="v-input" id="fx-fits-field"><div class="v-input__slot"><div id="fx-fits-text" style="width:300px;${cut}">Fits</div><input id="fx-fits-input" readonly aria-describedby="fx-note-other"></div></div>
    <button id="fx-named" style="display:block;width:70px;overflow:hidden"><span id="fx-named-text" style="display:block;width:70px;${cut}">Save everything now</span></button>
    <button id="fx-labelled" aria-label="Save" style="display:block;width:70px;overflow:hidden"><span style="display:block;width:70px;${cut}">Save everything now</span></button>
  `
  document.querySelector('.v-application').appendChild(holder)
}

// The check and the plugin on the fixtures, in the page's current typeface.
const fixtures = async (page) => {
  const found = []
  const expect = (name, ok, detail = '') => {
    if (!ok) {
      found.push([name, detail])
    }
  }

  await page.evaluate(mount, CUT)
  await page.waitForTimeout(300)

  const plain = await textOf(page, '#fx-plain')

  expect('pointer: a cut element takes its complete text as its title', (await titleAt(page, await hoverOn(page, '#fx-plain'))) === plain)

  const note = await titleAt(page, await hoverOn(page, '#fx-note-value'))
  const value = await textOf(page, '#fx-note-value')

  expect('pointer: a cut value under a title of the page shows the value and keeps the page title', Boolean(note) && note.startsWith(value) && note.includes('Estimated: from the survey of twelve systems'), JSON.stringify(note))

  const own = await titleAt(page, await hoverOn(page, '#fx-page'))

  expect('pointer: a title of the page on the cut element itself is left as written', own === 'Critical col', JSON.stringify(own))
  expect('check: a title that holds only a part of the text is not accepted', !covers(own, await textOf(page, '#fx-page')))

  await page.evaluate(() => {
    document.getElementById('fx-plain').title = 'Page note'
  })
  await hoverOn(page, '#fx-live')
  await hoverOn(page, '#fx-plain')

  expect('pointer: a title the page took over from the plugin is not overwritten', (await titleAt(page, await hoverOn(page, '#fx-plain'))) === 'Page note')

  const live = await hoverOn(page, '#fx-live')
  const wait = () => page.waitForTimeout(250)

  await page.evaluate(() => {
    document.getElementById('fx-live').textContent = 'Short'
  })
  await wait()
  expect('pointer, not moved: shorter text drops the title', (await titleAt(page, live)) === null)
  await page.evaluate(() => {
    document.getElementById('fx-live').textContent = 'A longer counter 9876543210'
  })
  await wait()
  expect('pointer, not moved: longer text takes its new full text as the title', (await titleAt(page, live)) === 'A longer counter 9876543210', JSON.stringify(await titleAt(page, live)))
  await page.evaluate(() => {
    document.getElementById('fx-live').style.width = '400px'
  })
  await wait()
  expect('pointer, not moved: widening until the text fits drops the title', (await titleAt(page, live)) === null)
  await page.evaluate(() => {
    document.getElementById('fx-live').style.width = '60px'
  })
  await wait()
  expect('pointer, not moved: narrowing again brings the title back', (await titleAt(page, live)) === 'A longer counter 9876543210')

  const { problems } = await page.evaluate(scan, FOCUSABLE)

  expect('check: a signed number clipped inside a table is reported', problems.some(([kind, text]) => kind === 'clipX' && text.includes('-123456789 MSP')), JSON.stringify(problems.slice(0, 5)))

  await page.mouse.move(page.viewportSize().width - 2, 2)
  await page.evaluate(() => document.getElementById('fx-input').focus())
  await page.waitForTimeout(100)

  const popup = await popupOf(page, '#fx-input')

  expect('keyboard: focus shows the complete text in a popup tied to the control and inside the window', popup.text === 'Long selected value text' && popup.tied && popup.inside, JSON.stringify(popup))
  await page.keyboard.press('Escape')
  expect('keyboard: Escape dismisses the popup', (await popupOf(page, '#fx-input')).text === null)
  await page.evaluate(() => {
    document.getElementById('fx-select').textContent = 'Long selected value text, again'
  })
  await wait()
  expect('keyboard: a change of the text does not bring a dismissed popup back', (await popupOf(page, '#fx-input')).text === null)
  await page.evaluate(() => {
    document.getElementById('fx-input').blur()
    document.getElementById('fx-input').focus()
  })
  await page.waitForTimeout(100)
  expect('keyboard: focus comes back, so does the popup', (await popupOf(page, '#fx-input')).text === 'Long selected value text, again')
  await page.evaluate(() => {
    document.getElementById('fx-select').textContent = 'Another selected value, longer than before'
  })
  await wait()
  expect('keyboard: the popup follows a change of the text', (await popupOf(page, '#fx-input')).text === 'Another selected value, longer than before')
  await page.evaluate(() => {
    document.getElementById('fx-select').style.width = '500px'
  })
  await wait()
  expect('keyboard: the popup goes once the text fits', (await popupOf(page, '#fx-input')).text === null)
  await page.evaluate(() => {
    document.getElementById('fx-select').style.width = '60px'
  })
  await wait()
  await page.evaluate(() => document.getElementById('fx-input').blur())
  await page.waitForTimeout(100)

  const left = await popupOf(page, '#fx-input')

  expect('keyboard: blur removes the popup and the tie to the control', left.text === null && left.described === null, JSON.stringify(left))

  const tip = (selector) => popupOf(page, selector)

  await hoverOn(page, '#fx-fit')

  const fit = await hoverOn(page, '#fx-fit')

  expect('pointer: an element that fits has no title', (await titleAt(page, fit)) === null)
  await page.evaluate(() => {
    document.getElementById('fx-fit').textContent = 'Now a text that is far too long for the box it is in, and so is cut'
  })
  await wait()
  expect('pointer, not moved: an element that fitted and comes to be cut takes its title', (await titleAt(page, fit)) === 'Now a text that is far too long for the box it is in, and so is cut', JSON.stringify(await titleAt(page, fit)))
  await page.mouse.move(page.viewportSize().width - 2, 2)

  await page.evaluate(() => document.getElementById('fx-fixed-input').focus())
  await page.waitForTimeout(150)
  expect('keyboard: a field of a fixed size shows its cut child', (await tip('#fx-fixed-input')).text === 'Text inside a box of one size')
  await page.evaluate(() => {
    document.getElementById('fx-child').style.width = '230px'
  })
  await wait()
  expect('keyboard: the popup goes when only the child widens until its text fits', (await tip('#fx-fixed-input')).text === null)
  await page.evaluate(() => {
    document.getElementById('fx-child').style.width = '60px'
  })
  await wait()
  expect('keyboard: the popup comes back when only the child narrows', (await tip('#fx-fixed-input')).text === 'Text inside a box of one size')
  await page.evaluate(() => document.getElementById('fx-fixed-input').blur())

  await page.evaluate(() => document.getElementById('fx-menu-input').focus())
  await page.waitForTimeout(150)
  expect('keyboard: a field with a menu closed shows the popup', (await tip('#fx-menu-input')).text === 'Value of a field with a menu')
  await page.evaluate(() => document.querySelector('#fx-menu .v-input__slot').setAttribute('aria-expanded', 'true'))
  await wait()

  const open = await tip('#fx-menu-input')

  expect('keyboard: the popup is not shown while the field\'s menu is open, nor tied to the control', open.text === null && open.described === null, JSON.stringify(open))
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.querySelector('#fx-menu .v-input__slot').setAttribute('aria-expanded', 'false'))
  await wait()
  expect('keyboard: Escape that closes the menu leaves the popup to come back with it', (await tip('#fx-menu-input')).text === 'Value of a field with a menu')
  await page.evaluate(() => document.getElementById('fx-menu-input').blur())

  await page.evaluate(() => document.getElementById('fx-fits-input').focus())
  await page.waitForTimeout(150)

  const fits = await tip('#fx-fits-input')

  expect('keyboard: a control that holds no cut text gets no popup and keeps its own description', fits.text === null && fits.described === 'fx-note-other', JSON.stringify(fits))
  await page.evaluate(() => {
    document.getElementById('fx-fits-text').textContent = 'A text that is much too long for the box it has been given here'
  })
  await wait()

  const cutNow = await tip('#fx-fits-input')

  expect('keyboard: the popup is tied to the control next to its own description once the text is cut', cutNow.tied && cutNow.described.startsWith('fx-note-other '), JSON.stringify(cutNow))
  await page.keyboard.press('Escape')

  const gone = await tip('#fx-fits-input')

  expect('keyboard: after Escape the control is described as the page wrote it, with no tie to a popup that is not there', gone.text === null && gone.described === 'fx-note-other', JSON.stringify(gone))
  await page.evaluate(() => document.getElementById('fx-fits-input').blur())

  await page.evaluate(() => document.getElementById('fx-named').focus())
  await page.waitForTimeout(150)

  const named = await tip('#fx-named')

  expect('keyboard: a button whose own name holds the whole text shows the popup but is not described by it', named.text === 'Save everything now' && !named.tied && named.described === null, JSON.stringify(named))
  await page.evaluate(() => document.getElementById('fx-named').blur())
  await page.evaluate(() => document.getElementById('fx-labelled').focus())
  await page.waitForTimeout(150)

  const labelled = await tip('#fx-labelled')

  expect('keyboard: a button named by a shorter label is described by the popup', labelled.text === 'Save everything now' && labelled.tied, JSON.stringify(labelled))
  await page.evaluate(() => document.getElementById('fx-labelled').blur())

  await page.evaluate(() => document.getElementById('ae-fixture').remove())

  return found
}

// Fixtures that go through the same reads as a page's own controls (readPage): a clipped button, the same drawn as a Vuetify button (its text-transform makes the accessible name upper case) and two native-labelled inputs whose own name holds the whole text (the popup is shown and does not describe them), a button named by a shorter label (it does), and a select with its own description and a menu (the popup is absent while the menu is open, the description is the page's, and the popup returns when the menu closes). The menu answers Enter and closes on Escape one microtask after the key, as a framework updates a field.
const mountPageFixture = (cut) => {
  document.getElementById('ae-fixture')?.remove()

  const holder = document.createElement('div')

  holder.id = 'ae-fixture'
  holder.setAttribute('style', 'position:fixed;left:120px;top:80px;width:560px;z-index:9000;background:#fff;color:#000;padding:8px')
  holder.innerHTML = `
    <button id="pf-button" style="display:block;width:70px;overflow:hidden;margin-bottom:12px"><span style="display:block;width:70px;${cut}">Save every selected design</span></button>
    <button id="pf-vuetify" class="v-btn v-btn--has-bg theme--light v-size--default" style="display:block;width:70px;min-width:0;padding:0;margin-bottom:12px"><span class="v-btn__content" style="display:block;width:70px;${cut}">Save every selected design</span></button>
    <button id="pf-named" aria-label="Save" style="display:block;width:70px;overflow:hidden;margin-bottom:12px"><span style="display:block;width:70px;${cut}">Save every selected design</span></button>
    <div class="v-input" style="margin-bottom:12px"><div class="v-input__slot"><label class="v-label" for="pf-for-input" style="display:block;width:70px;${cut}">Long label of a native field</label><input id="pf-for-input" readonly></div></div>
    <div class="v-input" style="margin-bottom:12px"><div class="v-input__slot"><label class="v-label" style="display:block;position:relative;width:70px;${cut}">Wrapping label of a native field<input id="pf-wrapped-input" readonly style="position:absolute;left:0;top:0;width:1px;height:1px;opacity:0"></label></div></div>
    <span id="pf-description" style="display:none">Page description</span>
    <div class="v-input"><div class="v-input__slot" aria-haspopup="listbox" aria-expanded="false"><div style="width:70px;${cut}">Value of a select with a menu</div><input id="pf-select-input" readonly aria-label="Field" aria-describedby="pf-description"></div></div>
  `
  document.querySelector('.v-application').appendChild(holder)

  const input = document.getElementById('pf-select-input')
  const slot = input.closest('.v-input__slot')

  input.addEventListener('keydown', (event) => {
    const expanded = slot.getAttribute('aria-expanded') === 'true'

    if (event.key === 'Enter' && !expanded) {
      const box = slot.getBoundingClientRect()
      const menu = document.createElement('div')

      slot.setAttribute('aria-expanded', 'true')
      menu.id = 'pf-menu'
      menu.className = 'menuable__content__active'
      menu.setAttribute('style', `position:fixed;z-index:9001;left:${box.left}px;top:${box.bottom}px;width:240px;background:#fff;color:#000`)
      menu.innerHTML = '<div class="v-list-item" style="height:32px">One</div><div class="v-list-item" style="height:32px">Two</div><div class="v-list-item" style="height:32px">Three</div>'
      holder.appendChild(menu)
    } else if (event.key === 'Escape' && expanded) {
      Promise.resolve().then(() => {
        slot.setAttribute('aria-expanded', 'false')
        document.getElementById('pf-menu').remove()
      })
    }
  })
}

// The fixtures above read like a page: what readPage finds on them, and that it found all six.
const pageFixture = async (page) => {
  await page.evaluate(mountPageFixture, CUT)
  await page.waitForTimeout(300)

  const result = await readPage(page, 'page fixture', 'roboto', 1)
  const upper = await page.evaluate(() => getComputedStyle(document.getElementById('pf-vuetify')).textTransform)

  await page.evaluate(() => document.getElementById('ae-fixture').remove())

  if (upper !== 'uppercase') {
    result.found.push(['fixture', `the Vuetify button of the page fixture is drawn with text-transform ${upper}, not uppercase: it would not exercise a name in another case`])
  }

  if (result.keyboard < 6 || result.menus < 1) {
    result.found.push(['fixture', `readPage read ${result.keyboard} controls with the keyboard and ${result.menus} menus, expected 6 and 1`])
  }

  return { found: result.found, keyboard: result.keyboard, menus: result.menus }
}

// A table whose cell wraps a signed number with its unit, in a panel of the page, where the check must report it and no KNOWN entry may excuse it.
const knownFixture = async (page) => {
  await previewFont(page, 'roboto', 1)
  await settle(page, 250, 700)
  await page.evaluate(() => {
    document.getElementById('ae-fixture')?.remove()

    const holder = document.createElement('div')

    holder.id = 'ae-fixture'
    holder.className = 'panel'
    holder.setAttribute('style', 'position:fixed;left:120px;top:90px;width:300px;z-index:9000;background:#fff;color:#000;padding:8px')
    holder.innerHTML = '<div class="panel-head">Fixture 1 check</div><table><thead><tr><th>Name</th><th>Cost</th></tr></thead><tbody><tr><td>Part</td><td style="width:30px"><span>-987654 MSP</span></td></tr></tbody></table>'
    document.querySelector('.v-application').appendChild(holder)
  })

  const { problems } = await page.evaluate(scan, FOCUSABLE)
  const wrapped = problems.filter(([kind, text]) => kind === 'numberWrap' && text.includes('-987654 MSP'))

  await page.evaluate(() => document.getElementById('ae-fixture').remove())

  return { wrapped, known: wrapped.filter(([kind, text, at]) => knownFor({ where: '1280x720 /warnings roboto 1', kind, text, at })) }
}

// A field with a menu (a select) that holds cut text: opens its menu from the keyboard and reads what shows, then closes the menu with Escape, the focus kept. While the menu is open the popup must be absent, so it covers no option, and the control must have its own description again, as the page wrote it; once the menu is closed the popup must be back and tied as it was, and after blur the control's own description is as the page wrote it.
const menuReach = async (page, index) => {
  const control = `[data-ae-focus="${index}"]`

  if (!(await page.evaluate((query) => Boolean(document.querySelector(query).closest('.v-input__slot[aria-haspopup]')), control))) {
    return null
  }

  const before = await page.evaluate((query) => document.querySelector(query).getAttribute('aria-describedby'), control)

  await page.evaluate((query) => {
    const element = document.querySelector(query)

    element.scrollIntoView({ block: 'center' })
    element.focus()
  }, control)
  await settle(page, 40, 120)
  await page.keyboard.press('Enter')
  await settle(page, 120, 300)

  const opened = await page.evaluate((query) => document.querySelector(query).closest('.v-input__slot').getAttribute('aria-expanded') === 'true', control)
  const shown = await page.evaluate((query) => {
    const tip = document.querySelector('.truncated-text-tip')
    const menu = document.querySelector('.menuable__content__active')
    const box = tip && tip.getBoundingClientRect()
    const covered = box && menu ? [...menu.querySelectorAll('.v-list-item')].some((item) => {
      const option = item.getBoundingClientRect()

      return box.left < option.right && option.left < box.right && box.top < option.bottom && option.top < box.bottom
    }) : false

    return { tip: tip ? tip.textContent : null, described: document.querySelector(query).getAttribute('aria-describedby'), covered }
  }, control)

  await page.keyboard.press('Escape')
  await settle(page, 120, 300)

  const back = await popupOf(page, control)
  const ax = back.text === null ? null : await accessibleOf(page, control)
  const cut = await stillCut(page, index)

  await page.evaluate((query) => document.querySelector(query).blur(), control)
  await settle(page, 30, 80)

  const end = await page.evaluate((query) => document.querySelector(query).getAttribute('aria-describedby'), control)

  return { opened, before, tip: shown.tip, described: shown.described, covered: shown.covered, back, ax, cut, end }
}

// A page in a typeface and size: what the scan finds and how many cut texts were read with the pointer and with the keyboard.
const readPage = async (page, where, family, scale, renderWait = 5000) => {
  const timing = TIMING ? { started: performance.now() } : null
  const found = []
  let pointer = 0
  let keyboard = 0
  let menus = 0

  await previewFont(page, family, scale)
  await settle(page, 250, 700)

  if (!(await page.evaluate(([f, s]) => window.__typography === `${f}:${s}` && Boolean(document.querySelector('.v-application')), [family, scale]))) {
    throw new Error(`${where}: the page reloaded during the run`)
  }

  if (timing) timing.font = performance.now()

  const shown = await page.waitForFunction(rendered, null, { timeout: renderWait }).then(() => true, (error) => {
    if (error.name !== 'TimeoutError') {
      throw error
    }

    return false
  })

  if (timing) timing.render = performance.now()

  if (!shown) {
    found.push(['render', 'the requested page did not render: the main area has no routed view with content (the root of its component is empty), so nothing on it was checked'], ...errorsOf(page))

    if (timing) console.log(`TIMING ${JSON.stringify({ where, font: timing.font - timing.started, render: timing.render - timing.font, total: performance.now() - timing.started, unrendered: true })}`)

    return { found, pointer, keyboard, menus }
  }

  const { problems, cut } = await page.evaluate(scan, FOCUSABLE)

  if (timing) timing.scan = performance.now()

  console.error(`EQ ${where} cut=${cut} problems=${problems.length} ${JSON.stringify(problems).length}`)

  found.push(...problems)

  for (let index = 0; index < cut; index++) {
    const { text, title } = await reach(page, index)

    pointer++

    if (!covers(title, text)) {
      found.push(['ellipsis', `"${text.slice(0, 40)}" has no title with its complete text (title: ${JSON.stringify(title)})`])
    }
  }

  if (timing) timing.pointer = performance.now()

  for (const index of await page.evaluate(() => [...document.querySelectorAll('[data-ae-focus]')].map((element) => element.getAttribute('data-ae-focus')))) {
    const { text, before, shown, ax, cut, left } = await keyboardReach(page, index)

    keyboard++

    if (cut && (!covers(shown.text, text) || !shown.inside)) {
      found.push(['ellipsis', `"${text.slice(0, 40)}" is not shown in full when its control has focus (${JSON.stringify(shown)})`])
    } else if (cut) {
      ariaProblems({ shown, ax, before }).forEach((problem) => found.push(['ellipsis', `"${text.slice(0, 40)}": ${problem}`]))
    }

    if (left.text !== null || (left.described || null) !== (before || null)) {
      found.push(['ellipsis', `the popup of "${text.slice(0, 40)}" or its tie stays after focus left (${JSON.stringify(left)}, described before: ${JSON.stringify(before)})`])
    }

    const menu = await menuReach(page, index)

    if (menu) {
      menus++

      if (!menu.opened) {
        found.push(['ellipsis', `the menu of the field of "${text.slice(0, 40)}" did not open`])
      } else if (menu.tip !== null || (menu.described || null) !== (menu.before || null) || menu.covered) {
        found.push(['ellipsis', `the popup of "${text.slice(0, 40)}" stays while the field's menu is open, or the control is not described as the page wrote it (${JSON.stringify(menu)})`])
      } else if (menu.cut && !covers(menu.back.text, text)) {
        found.push(['ellipsis', `the popup of "${text.slice(0, 40)}" does not come back when the field's menu closes with the focus kept (${JSON.stringify(menu)})`])
      } else if (menu.cut) {
        ariaProblems({ shown: menu.back, ax: menu.ax, before: menu.before }).forEach((problem) => found.push(['ellipsis', `"${text.slice(0, 40)}" after its menu closed: ${problem}`]))
      }

      if ((menu.end || null) !== (menu.before || null)) {
        found.push(['ellipsis', `the control of "${text.slice(0, 40)}" is not described as the page wrote it after focus left (${JSON.stringify(menu.end)} instead of ${JSON.stringify(menu.before)})`])
      }
    }
  }

  if (timing) timing.keyboard = performance.now()

  await page.evaluate(() => {
    window.scrollTo(0, 0)
    document.querySelectorAll('*').forEach((element) => {
      element.scrollTop = 0
      element.scrollLeft = 0
    })
  })

  found.push(...errorsOf(page))

  if (timing) console.log(`TIMING ${JSON.stringify({ where, font: timing.font - timing.started, render: timing.render - timing.font, scan: timing.scan - timing.render, pointer: timing.pointer - timing.scan, keyboard: timing.keyboard - timing.pointer, cleanup: performance.now() - timing.keyboard, total: performance.now() - timing.started, pointerCount: pointer, keyboardCount: keyboard, menuCount: menus })}`)

  return { found, pointer, keyboard, menus }
}

// The component of a real route swapped for one that fails to render (`throws`), renders nothing (`empty`), or put back (`original`).
const swapRoute = (page, route, mode) => page.evaluate(([path, kind]) => {
  const record = window.$app.$router.getRoutes().find((item) => item.path === path)

  window.__aeRoutes = window.__aeRoutes || {}
  window.__aeRoutes[path] = window.__aeRoutes[path] || record.components.default
  record.components.default = kind === 'throws' ? { render() { throw new Error('ae-render-throws') } } : kind === 'empty' ? { render: () => undefined } : window.__aeRoutes[path]
}, [route, mode])

// The two reports of the render that threw, as `errorsOf` words them: what Vue writes and the error itself, on that route and no other. Compared whole, never by a part of the text.
const thrownAt = (route) => [`[Vue warn]: Error in render: "Error: ae-render-throws" [during ${route}]`, `Error: ae-render-throws [during ${route}]`]

// The component of a real page, in the real layout, swapped for one that fails to render: one whose render throws and one that renders nothing. The page read of each must say so (a scan of an empty page finds no problem, and would pass), and the first must report its error as well. Only those two reports of the thrown error are expected: anything else the page reported while it ran, or before, is a failure. The page is put back afterwards.
const renderFixture = async (page) => {
  const found = []

  try {
    for (const [mode, kinds] of [['throws', ['render', 'runtime']], ['empty', ['render']]]) {
      await go(page, '/about')
      await swapRoute(page, '/information', mode)
      await go(page, '/information')

      if (!(await page.evaluate(() => Boolean(window.__aeRoutes && window.__aeRoutes['/information'])))) {
        throw new Error(`render fixture ${mode}: the page reloaded during the run`)
      }

      const read = await readPage(page, `render fixture ${mode}`, 'roboto', 1, 2000)
      const foreign = read.found.filter(([kind, text]) => kind === 'runtime' && !(mode === 'throws' && thrownAt('/information').includes(text)))
      const own = read.found.filter((entry) => !foreign.includes(entry))
      const seen = [...new Set(own.map(([kind]) => kind))].sort()

      foreign.forEach(([, text]) => found.push(['render', `the page reported an error the fixture did not cause: ${text}`]))

      if (JSON.stringify(seen) !== JSON.stringify(kinds)) {
        found.push(['render', `a page whose render ${mode === 'throws' ? 'threw' : 'returned nothing'} was read as ${JSON.stringify(own)}, expected only the kinds ${JSON.stringify(kinds)}`])
      }

      if (mode === 'throws' && own.filter(([kind]) => kind === 'runtime').length !== 2) {
        found.push(['render', `the two reports of the render that threw were not both found: ${JSON.stringify(own)}`])
      }
    }
  } finally {
    await swapRoute(page, '/information', 'original')
  }

  await go(page, '/about')
  found.push(...errorsOf(page).map(([kind, text]) => [kind, `back on a page that renders: ${text}`]))

  return found
}

// An error of another page, reported just before the render fixture runs, must not be taken for the fixture's own.
const foreignFixture = async (page) => {
  await page.evaluate(() => console.error(new Error('ae-foreign-before-fixture')))

  const found = await renderFixture(page)

  return found.length === 1 && found[0][1] === 'the page reported an error the fixture did not cause: Error: ae-foreign-before-fixture [during /about]' ? [] : [['render', `an error reported on /about before the render fixture was not reported as the one of another page: ${JSON.stringify(found)}`]]
}

// The palette of one typeface and size, opened on a page of the app: its box inside the window, and what the page reported meanwhile.
const paletteCheck = async (page, width, height, family, scale) => {
  const found = []

  await go(page, '/technologies')
  page.aePhase = `palette ${family} ${scale} on /technologies`
  await previewFont(page, family, scale)
  await page.keyboard.press('Control+k')
  await settle(page, 150, 700)

  const box = await page.evaluate(() => {
    const dialog = document.querySelector('.page-palette')
    const rect = dialog && dialog.getBoundingClientRect()

    return rect ? [rect.left, rect.top, rect.right, rect.bottom] : null
  })

  if (!box || box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height) {
    found.push(['dialog', box ? `box ${box.map(Math.round)} outside the window` : 'did not open'])
  }

  await page.keyboard.press('Escape')
  await settle(page, 120, 300)

  return [...found, ...errorsOf(page)]
}

// A page that throws while the palette is open must be reported by the palette's own step, which reads no page, as exactly the two reports of that error. Everything else is a problem, whenever it was queued: what the page reported before the fixture, a finding of the palette step that is not the thrown error, and what it reported once the page was put back.
const paletteFixture = async (page) => {
  await go(page, '/about')

  const found = errorsOf(page).map(([, text]) => ['palette', `the page reported an error before the palette fixture: ${text}`])

  await swapRoute(page, '/technologies', 'throws')

  let read

  try {
    read = await paletteCheck(page, 1280, 720, 'roboto', 1)
  } finally {
    await swapRoute(page, '/technologies', 'original')
  }

  const expected = thrownAt('/technologies')
  const own = read.filter(([kind, text]) => kind === 'runtime' && expected.includes(text)).map(([, text]) => text)

  read.filter(([kind, text]) => !(kind === 'runtime' && expected.includes(text))).forEach(([kind, text]) => found.push(['palette', `the palette step reported something that is not the thrown error (${kind}): ${text}`]))

  if (JSON.stringify([...own].sort()) !== JSON.stringify([...expected].sort())) {
    found.push(['palette', `the two reports of the error thrown while the palette was open were not both found, once each: ${JSON.stringify(read)}`])
  }

  await go(page, '/about')
  found.push(...errorsOf(page).map(([, text]) => ['palette', `back on a page that renders: ${text}`]))

  return found
}

// An error reported just before the palette fixture, on the page the fixture starts from, must be reported as such and as nothing else; its text holds the whole of an expected report, which a comparison by a part of the text would take for the fixture's own.
const foreignPaletteFixture = async (page) => {
  await page.evaluate(() => console.error(new Error('ae-foreign-before-palette Error: ae-render-throws [during /technologies]')))

  const found = await paletteFixture(page)

  return found.length === 1 && found[0][1] === 'the page reported an error before the palette fixture: Error: ae-foreign-before-palette Error: ae-render-throws [during /technologies] [during /about]' ? [] : [['palette', `an error reported on /about before the palette fixture was not reported as the one of another page: ${JSON.stringify(found)}`]]
}

// Runs `task`, and again on the page opened afresh when a hot update of the dev server reloaded the page under it, up to three times.
const settled = async (page, route, task) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task()
    } catch (error) {
      if (attempt === 3 || !/Execution context was destroyed|reloaded during the run/.test(error.message)) {
        throw error
      }

      await open(page)
      await go(page, route)
    }
  }
}

// A page of its own in a window of its own (a context, so the fonts, the scale and the storage of one page never reach another), opened on the app with the race picked. What it reported while it opened goes with the first step that takes the page.
const openPage = async (browser, width, height, name) => {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage()

  try {
    watch(page)
    await open(page)
  } catch (error) {
    error.aeFailure = { step: name, phase: page.aePhase, url: page.url(), message: error.message, failedRequests: page.aeFailedRequests, errors: errorsOf(page) }
    await page.context().close().catch(() => {})

    throw error
  }

  return { page, opening: errorsOf(page).map(([kind, text]) => ({ where: `${width}x${height} open`, kind, text, at: '' })) }
}

// The steps of one window, each on a page of its own while it runs: the fixtures (the first on a page opened afresh, in the typeface it opens in; the others set the typeface they read in), every route with all its combinations, and every palette. The failures of a step are kept with it and put together in the order of the steps, whichever finished first.
const stepsOf = (width, height) => {
  const size = `${width}x${height}`
  const combos = FULL ? FULL_MATRIX[size] || COMBOS : COMBOS
  const steps = []
  const step = (fresh, name, work, route = null, combinations = []) => steps.push({ width, height, fresh, name: `${size} ${name}`, route, combinations, work })

  if (PART !== 'pages' && width === 1280) {
    step(true, '/about pointer and keyboard fixtures', async (page, fail, drain) => {
      await go(page, '/about')

      const found = await settled(page, '/about', () => fixtures(page))

      found.forEach(([name, detail]) => fail('fixtures', name, detail))
      drain('fixtures')
    })
    step(false, '/about real-page reader fixture', async (page, fail) => {
      await go(page, '/about')

      const read = await settled(page, '/about', () => pageFixture(page))

      read.found.forEach(([kind, text]) => fail('page fixture', kind, text))

      return { fixtureReads: read }
    })
    step(false, '/about render fixture', async (page, fail) => {
      await go(page, '/about')

      const rendering = await settled(page, '/about', () => renderFixture(page))

      rendering.forEach(([name, detail]) => fail('render fixture', name, detail))
    })
    step(false, '/about foreign-error fixture', async (page, fail) => {
      await go(page, '/about')

      const foreign = await settled(page, '/about', () => foreignFixture(page))

      foreign.forEach(([name, detail]) => fail('render fixture', name, detail))
    })
    step(false, '/about palette-error fixture', async (page, fail) => {
      await go(page, '/about')

      const palette = await settled(page, '/about', () => paletteFixture(page))

      palette.forEach(([name, detail]) => fail('palette fixture', name, detail))
    })
    step(false, '/about foreign-palette-error fixture', async (page, fail) => {
      await go(page, '/about')

      const foreignPalette = await settled(page, '/about', () => foreignPaletteFixture(page))

      foreignPalette.forEach(([name, detail]) => fail('palette fixture', name, detail))
    })
    step(false, '/warnings known-exception fixture', async (page, fail, drain) => {
      await go(page, '/warnings')

      const { wrapped, known } = await settled(page, '/warnings', () => knownFixture(page))

      if (!wrapped.length) {
        fail('fixtures', 'check: a wrapped signed number with its unit is reported', 'the fixture "-987654 MSP" was not reported')
      }

      drain('known fixture')

      if (known.length) {
        fail('fixtures', 'check: a KNOWN entry excuses only its own place', `the fixture "-987654 MSP" in another place on /warnings was excused: ${JSON.stringify(known)}`)
      }
    })
  }

  for (const route of PAGES) {
    step(false, `${route} combinations ${combos.map(([family, scale]) => `${family}:${scale}`).join(',')}`, async (page, fail) => {
      const counts = { pointer: 0, keyboard: 0, menus: 0, scans: 0 }

      await go(page, route)

      for (const [family, scale] of combos) {
        const where = `${size} ${route} ${family} ${scale}`
        page.aeCombo = where
        const result = await settled(page, route, () => readPage(page, where, family, scale))

        result.found.forEach(([kind, text, at]) => fail(where, kind, text, at))
        counts.pointer += result.pointer
        counts.keyboard += result.keyboard
        counts.menus += result.menus
        counts.scans++
      }

      return counts
    }, route, combos)
  }

  if (width === 1280) {
    for (const [family, scale] of COMBOS) {
      step(false, `palette ${family}:${scale}`, async (page, fail) => {
        const where = `${size} palette ${family} ${scale}`
        const found = await paletteCheck(page, width, height, family, scale)

        found.forEach(([kind, text]) => fail(where, kind, text))

        return { palettes: 1 }
      })
    }
  }

  return steps
}

// How many pages are open side by side: the pool's share of the machine, and no more than the dev server and the browser take without the timing of the page's own observers drifting.
const PAGES_AT_ONCE = 8

const run = async () => {
  const browser = await chromium.launch()
  const idle = new Map(VIEWPORTS.map(([width, height]) => [`${width}x${height}`, []]))
  let scansChecked = 0
  let palettesChecked = 0
  let pointerChecked = 0
  let keyboardChecked = 0
  let menusChecked = 0
  let fixtureReads = { keyboard: 0, menus: 0 }

  // Runs a step on an idle page of its window (or a page opened afresh), and keeps the page for the next step unless the step wanted a fresh page or failed. A step whose page could not open is marked, so that the first one stops the run (the app is not there for the others); a step that failed after its page opened is kept with its step while the others run.
  const execute = async ({ width, height, fresh, name, route, combinations, work }) => {
    const key = `${width}x${height}`
    let held

    console.log(`STEP_START ${JSON.stringify({ step: name, route, combinations })}`)

    try {
      held = (!fresh && idle.get(key).pop()) || await openPage(browser, width, height, name)
      held.page.aeCombo = null

      const failed = held.opening.splice(0)
      const fail = (where, kind, text, at = '') => failed.push({ where, kind, text, at })
      const drain = (where) => errorsOf(held.page).forEach(([kind, text]) => fail(where, kind, text))
      const value = await work(held.page, fail, drain)

      drain(`${key} end of run`)

      if (fresh) {
        await held.page.context().close()
      } else {
        idle.get(key).push(held)
      }

      return { failed, ...value }
    } catch (error) {
      const failure = { ...(error.aeFailure || { step: name, combo: held?.page.aeCombo, phase: held?.page.aePhase, message: error.message, failedRequests: held?.page.aeFailedRequests || [] }), route, combinations }

      console.error(`STEP_FAILURE ${JSON.stringify(failure)}`)

      if (!held) {
        error.aeOpenFailure = true
      } else {
        await held.page.context().close().catch(() => {})
      }

      throw error
    }
  }

  try {
    const steps = VIEWPORTS.flatMap(([width, height]) => stepsOf(width, height))
    const first = await execute(steps[0]).catch((error) => {
      if (error.aeOpenFailure) {
        throw error
      }

      return error
    })
    const remaining = steps.slice(1)
    const results = [first, ...await inParallel(remaining, execute, Math.min(PAGES_AT_ONCE, jobs(), remaining.length))]

    results.forEach((result) => {
      if (result instanceof Error) {
        throw result
      }

      failures.push(...result.failed)
      pointerChecked += result.pointer || 0
      keyboardChecked += result.keyboard || 0
      menusChecked += result.menus || 0
      scansChecked += result.scans || 0
      palettesChecked += result.palettes || 0
      fixtureReads = result.fixtureReads || fixtureReads
    })
  } finally {
    await browser.close()
  }

  const known = new Map()
  const fresh = failures.filter((failure) => {
    const entry = knownFor(failure)

    if (entry) {
      const key = `${entry.route}  ${failure.kind}  ${failure.text}  at ${failure.at}`

      known.set(key, { entry, where: [...((known.get(key) || {}).where || []), failure.where] })
    }

    return !entry
  })

  known.forEach(({ entry, where }, key) => console.log(`KNOWN  ${key}  (${where.length} of the combinations read: ${entry.reason})`))

  if (fresh.length) {
    console.log(fresh.map(({ where, kind, text }) => `${where}  ${kind}  ${text}`).join('\n'))
    console.log(`\nFAIL  ${fresh.length} problem${fresh.length === 1 ? '' : 's'}`)
    process.exit(1)
  }

  console.log(`PASS  ${PAGES.length} pages; ${scansChecked} typeface/scale/viewport scans; ${palettesChecked} palettes; ${pointerChecked} cut texts read with the pointer, ${keyboardChecked} with the keyboard, ${menusChecked} selects opened; fixtures (the page fixture read ${fixtureReads.keyboard} controls with the keyboard and ${fixtureReads.menus} menu)`)
}

const main = async () => {
  if (process.argv[2] === '--web-address-child') {
    webAddressChild(process.argv[3], process.argv[4])
    return
  }

  if (process.argv[2] === '--web-server') {
    webAddressChild(process.argv[3], process.argv[4], true)
    return
  }

  if (process.argv[2] === '--reader-fault-child') {
    readerFaultChild()
    return
  }

  assert.ok(['all', 'pages', 'web-address', 'matrix', 'open-failure', 'reader-failure'].includes(PART), `unknown typography part: ${PART}`)

  if (PART === 'all' || PART === 'web-address') {
    await webAddressChecks()
  }

  if (PART === 'all' || PART === 'matrix') {
    matrixChecks()
  }

  if (PART === 'all' || PART === 'open-failure') {
    await openingFailureCheck()
  }

  if (PART === 'all' || PART === 'reader-failure') {
    await readerFailureCheck()
  }

  if (PART === 'all' || PART === 'pages') {
    await run()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
