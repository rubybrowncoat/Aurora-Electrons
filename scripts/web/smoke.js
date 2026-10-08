/*
  Smoke test for web mode (`yarn web` must be running). Needs Playwright's
  Chromium: run `npx playwright install chromium` once locally; cloud
  containers already provide it through PLAYWRIGHT_BROWSERS_PATH.
  Selects a game/race, visits every page, and reports console errors, page
  errors, failed database calls, and a screenshot per page.

  Env: BASE_URL (http://localhost:9080), AURORA_GAME and AURORA_RACE (sample
  defaults), SMOKE_OUT (screenshot dir, default <tmp>/aurora-smoke),
  SMOKE_PAGES (comma-separated routes, default every tab plus settings; the
  hidden WIP /engines page is opt-in).
  SMOKE_VIEWPORTS (comma-separated WIDTHxHEIGHT sizes, for example
  1280x720,1920x1080,2560x1440) turns on the layout check: every page is
  visited at every size, screenshots are named <page>-<size>.png, and each page
  reports layout problems at each size (see LAYOUT_CHECK below). SMOKE_THEME=dark
  runs that check in the dark theme, and SMOKE_FULLPAGE=1 saves the whole scrolled
  page instead of the visible window. Without SMOKE_VIEWPORTS the run is unchanged.
  External requests the network blocks (fonts, CDNs) are reported as notes,
  not failures.
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')

const BASE_URL = process.env.BASE_URL || 'http://localhost:9080'
const GAME = process.env.AURORA_GAME || 'Aurelian Empire'
const RACE = process.env.AURORA_RACE || 'Aurelian Empire'
const OUT = process.env.SMOKE_OUT || path.join(os.tmpdir(), 'aurora-smoke')
const PAGES = process.env.SMOKE_PAGES ? process.env.SMOKE_PAGES.split(',') : require('../smoke-pages')

const VIEWPORTS = process.env.SMOKE_VIEWPORTS
  ? process.env.SMOKE_VIEWPORTS.split(',').map((size) => {
    const [width, height] = size.trim().toLowerCase().split('x').map(Number)

    if (!(width > 0 && height > 0)) {
      throw new Error(`SMOKE_VIEWPORTS: "${size}" is not WIDTHxHEIGHT`)
    }

    return { width, height, label: `${width}x${height}` }
  })
  : null
const DARK = process.env.SMOKE_THEME === 'dark'

const SETTLE_MS = 1500
const PAGE_TIMEOUT_MS = 90000

/*
  LAYOUT_CHECK runs in the page and returns what it can see of the window-size rule (docs/ARCHITECTURE.md, Layout):
  - overflow: the document, the body or .v-main scrolls sideways.
  - wide: an element in the content reaches past the window edge and no ancestor scrolls it.
  - clipped: an element with overflow hidden holds text wider than itself and doesn't ellipsise it.
  - small chart: a canvas under 240 x 120 px.
  - tight: a short label (a header, button, chip, tab or label of at most 24 characters) that wraps onto a second line.
  - island: from 1904 px up, the content stops short of 80% of the width, so the layout isn't filling the window.
  Also lists the containers that scroll sideways on their own, as information, never a problem.
 */
const LAYOUT_CHECK = () => {
  const root = document.documentElement
  const main = document.querySelector('.v-main')
  const container = main ? main.querySelector('.container') || main : document.body
  const width = root.clientWidth
  const problems = []
  const scrolls = new Set()
  const describe = (element) => {
    const text = (element.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30)

    return `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}${text ? ` "${text}"` : ''}`
  }

  if (root.scrollWidth > width) {
    problems.push(`overflow: page scrolls sideways (document ${root.scrollWidth} > ${width})`)
  }

  if (main && main.scrollWidth > main.clientWidth) {
    problems.push(`overflow: .v-main scrolls sideways (${main.scrollWidth} > ${main.clientWidth})`)
  }

  const reported = new Set()
  const clippedBy = (element) => {
    for (let node = element.parentElement; node && node !== document.body && !node.matches('.v-main__wrap'); node = node.parentElement) {
      const { overflowX } = getComputedStyle(node)

      if (overflowX !== 'visible') {
        return node
      }
    }

    return null
  }

  container.querySelectorAll('*').forEach((element) => {
    const style = getComputedStyle(element)

    if (style.display === 'none' || style.visibility === 'hidden' || element.closest('.v-menu__content, .v-overlay, .v-tooltip__content, [aria-hidden="true"]')) {
      return
    }

    const rect = element.getBoundingClientRect()

    if (rect.width === 0 && rect.height === 0) {
      return
    }

    if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
      if (element.scrollWidth > element.clientWidth + 1) {
        const card = element.closest('.v-card')

        scrolls.add(`${describe(element).replace(/ ".*"$/, '')} (${element.scrollWidth} in ${element.clientWidth} px)${card ? ` in "${card.innerText.trim().split('\n')[0].slice(0, 30)}"` : ''}`)
      }
    }

    if ((rect.right > width + 1 || rect.left < -1) && !clippedBy(element) && ![...reported].some((wide) => wide.contains(element))) {
      reported.add(element)
      problems.push(`wide: ${describe(element)} spans ${Math.round(rect.left)} to ${Math.round(rect.right)} of ${width}`)
    }

    if (style.overflowX === 'hidden' && element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0 && style.textOverflow !== 'ellipsis' && !element.closest('.v-tabs, .v-slide-group, .v-data-table__wrapper, canvas') && (element.innerText || '').trim()) {
      problems.push(`clipped: ${describe(element)} holds ${element.scrollWidth} px in ${element.clientWidth}`)
    }

    const text = (element.innerText || '').trim()

    if (text && text.length <= 24 && !text.includes('\n') && element.matches('th, label, .v-btn__content, .v-chip__content, .v-tab, .v-label, .v-list-item__title')) {
      const range = document.createRange()

      range.selectNodeContents(element)

      const tops = [...range.getClientRects()].filter((box) => box.width > 0).map((box) => box.top)

      if (tops.length > 1 && Math.max(...tops) - Math.min(...tops) > parseFloat(style.fontSize) * 0.8) {
        problems.push(`tight: "${text}" wraps (${Math.round(rect.width)} px wide)`)
      }
    }

    if (element.tagName === 'CANVAS' && (rect.width < 240 || rect.height < 120) && rect.width > 0) {
      problems.push(`small chart: canvas ${Math.round(rect.width)} x ${Math.round(rect.height)}`)
    }
  })

  if (width >= 1904) {
    let right = 0

    container.querySelectorAll('*').forEach((element) => {
      const style = getComputedStyle(element)
      const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())
      const drawn = ownText || ['canvas', 'svg', 'img'].includes(element.tagName.toLowerCase()) || style.boxShadow !== 'none' || style.borderRightWidth !== '0px' || style.backgroundColor !== 'rgba(0, 0, 0, 0)'
      const rect = element.getBoundingClientRect()

      if (drawn && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && !element.closest('.v-menu__content, .v-overlay')) {
        right = Math.max(right, rect.right)
      }
    })

    if (right < width * 0.8) {
      problems.push(`island: content ends at ${Math.round(right)} of ${width}`)
    }
  }

  return { problems: [...new Set(problems)], scrolls: [...scrolls] }
}

const run = async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })

  let problems = []
  const notes = new Set()
  let inFlight = 0
  let lastActivity = Date.now()

  const isDatabaseCall = (request) => request.url().includes('/__aurora-db/') && !request.url().endsWith('/stat')
  const isExternal = (request) => !request.url().startsWith(BASE_URL)

  page.on('console', (message) => {
    // Network-level failures are reported from `requestfailed` with their URL.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource: net::')) {
      problems.push(`console: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('request', (request) => {
    if (isDatabaseCall(request)) {
      inFlight += 1
      lastActivity = Date.now()
    }
  })
  page.on('requestfinished', async (request) => {
    if (!isDatabaseCall(request)) {
      return
    }

    inFlight -= 1
    lastActivity = Date.now()

    const response = await request.response()

    if (response && !response.ok()) {
      problems.push(`db ${response.status()}: ${request.url()} ${(await response.text()).slice(0, 200)}`)
    }
  })
  page.on('requestfailed', (request) => {
    if (isDatabaseCall(request)) {
      inFlight -= 1
      problems.push(`db failed: ${request.url()}`)
    } else if (isExternal(request)) {
      notes.add(`external request failed: ${request.url()} (${request.failure().errorText})`)
    } else {
      problems.push(`request failed: ${request.url()} (${request.failure().errorText})`)
    }
  })

  // inFlight/lastActivity are updated by the request listeners above.
  const isBusy = () => inFlight > 0 || Date.now() - lastActivity < SETTLE_MS

  const settle = async () => {
    const started = Date.now()

    while (isBusy()) {
      if (Date.now() - started > PAGE_TIMEOUT_MS) {
        problems.push(`timeout: ${inFlight} database calls still pending`)
        break
      }

      await page.waitForTimeout(250)
    }
  }

  fs.mkdirSync(OUT, { recursive: true })

  await page.goto(BASE_URL)
  // The app opens on the Empires page. A game with one race selects on click; otherwise the race is next.
  const picker = page.locator('.game-picker')

  await picker.getByText(GAME, { exact: true }).first().click({ timeout: PAGE_TIMEOUT_MS })

  const raceItem = picker.getByText(RACE, { exact: true })

  if (await raceItem.count()) {
    await raceItem.last().click()
  }

  await settle()

  const setupProblems = problems
  const results = []

  if (DARK) {
    await page.evaluate(() => { window.$app.$vuetify.theme.dark = true })
  }

  for (const viewport of VIEWPORTS || [null]) {
    if (viewport) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.waitForTimeout(500)
    }

    for (const route of PAGES) {
      problems = []
      lastActivity = Date.now()

      await page.evaluate((target) => window.$app.$router.push(target), route)
      await settle()

      const name = route === '/' ? 'empires' : route.slice(1)
      const suffix = viewport ? `-${viewport.label}${DARK ? '-dark' : ''}` : ''
      const screenshot = path.join(OUT, `${name}${suffix}.png`)

      await page.screenshot({ path: screenshot, fullPage: Boolean(viewport && process.env.SMOKE_FULLPAGE) })

      const stats = await page.evaluate(() => ({
        rows: document.querySelectorAll('.v-data-table tbody tr').length,
        text: document.querySelector('.v-main, .v-content') ? document.querySelector('.v-main, .v-content').innerText.length : 0,
      }))
      const layout = viewport ? await page.evaluate(LAYOUT_CHECK) : { problems: [], scrolls: [] }

      results.push({ route, viewport, ...stats, problems, layout, screenshot })
    }
  }

  await browser.close()

  notes.forEach((note) => console.log(`note: ${note}`))

  if (setupProblems.length) {
    console.log('setup:')
    setupProblems.forEach((problem) => console.log(`  ${problem}`))
  }

  results.forEach(({ route, viewport, rows, text, problems: pageProblems, layout, screenshot }) => {
    const status = pageProblems.length ? 'FAIL' : layout.problems.length ? 'LAYOUT' : 'ok'

    console.log(`${status.padEnd(6)} ${route.padEnd(15)} ${viewport ? `${viewport.label.padEnd(10)} ` : ''}rows=${String(rows).padEnd(5)} text=${String(text).padEnd(7)} ${screenshot}`)
    pageProblems.slice(0, 5).forEach((problem) => console.log(`       ${problem.slice(0, 300)}`))
    layout.problems.slice(0, 12).forEach((problem) => console.log(`       layout ${problem.slice(0, 300)}`))
    layout.scrolls.forEach((scroll) => console.log(`       scrolls inside ${scroll.slice(0, 200)}`))
  })

  if (VIEWPORTS) {
    console.log(`
layout problems per page${DARK ? ' (dark)' : ''}:`)
    console.log(`${'route'.padEnd(18)}${VIEWPORTS.map(({ label }) => label.padStart(11)).join('')}`)

    PAGES.forEach((route) => {
      const counts = VIEWPORTS.map((viewport) => results.find((result) => result.route === route && result.viewport === viewport).layout.problems.length)

      console.log(`${route.padEnd(18)}${counts.map((count) => String(count).padStart(11)).join('')}`)
    })
  }

  process.exitCode = setupProblems.length || results.some((result) => result.problems.length || result.layout.problems.length) ? 1 : 0
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
