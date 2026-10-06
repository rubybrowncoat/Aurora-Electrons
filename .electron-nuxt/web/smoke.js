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

const SETTLE_MS = 1500
const PAGE_TIMEOUT_MS = 90000

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
  await page.locator('.v-navigation-drawer').getByText(GAME, { exact: true }).first().click({ timeout: PAGE_TIMEOUT_MS })

  const raceItem = page.locator('.v-navigation-drawer .v-list-group__items').getByText(RACE, { exact: true })

  if (await raceItem.count()) {
    await raceItem.first().click()
  }

  await settle()

  const setupProblems = problems
  const results = []

  for (const route of PAGES) {
    problems = []
    lastActivity = Date.now()

    await page.evaluate((target) => window.$nuxt.$router.push(target), route)
    await settle()

    const name = route === '/' ? 'production' : route.slice(1)
    const screenshot = path.join(OUT, `${name}.png`)

    await page.screenshot({ path: screenshot })

    const stats = await page.evaluate(() => ({
      rows: document.querySelectorAll('.v-data-table tbody tr').length,
      text: document.querySelector('.v-main, .v-content') ? document.querySelector('.v-main, .v-content').innerText.length : 0,
    }))

    results.push({ route, ...stats, problems, screenshot })
  }

  await browser.close()

  notes.forEach((note) => console.log(`note: ${note}`))

  if (setupProblems.length) {
    console.log('setup:')
    setupProblems.forEach((problem) => console.log(`  ${problem}`))
  }

  results.forEach(({ route, rows, text, problems: pageProblems, screenshot }) => {
    console.log(`${pageProblems.length ? 'FAIL' : 'ok  '} ${route.padEnd(15)} rows=${String(rows).padEnd(5)} text=${String(text).padEnd(7)} ${screenshot}`)
    pageProblems.slice(0, 5).forEach((problem) => console.log(`       ${problem.slice(0, 300)}`))
  })

  process.exitCode = setupProblems.length || results.some((result) => result.problems.length) ? 1 : 0
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
