/*
  Regression check of the appearance file import on the Settings page, in a browser.

  BASE_URL=http://localhost:9081 node scripts/check-appearance-late-read.js

  It needs the web mode running (`bun run web`) with a save the page can open. It holds the reading of a chosen file back (a file named slow-* waits until the check releases it) and proves: a read that ends after Settings was left starts no preview on the page that is open and leaves no draft behind; a read that a newer one superseded neither replaces the newer draft nor shows a failure beside it; and the inks on the toolbar and snackbar fills, which an imported file can set, are reported as findings and make Apply wait for the confirmation. The settings are put back as they were. Exit code 1 when a check fails.
*/
const { chromium } = require('playwright')

const BASE = process.env.BASE_URL || 'http://localhost:9080'
const KEY = 'aurora-electrons:config'
const log = []

const check = (name, ok, detail = '') => {
  log.push({ ok, text: `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}` })
}

const document = (patch = {}) => ({ format: 'aurora-electrons-appearance', version: 1, name: 'Probe', mode: 'dark', ...patch })
const upload = (name, value) => ({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) })

const open = async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.$app && window.$app.$store, null, { timeout: 60000 })
  await page.waitForTimeout(800)

  if (!(await page.evaluate(() => window.$app.$store.getters.RaceID))) {
    const game = page.locator('.empire-list__game:has-text("Aurelian Empire")')

    if (await game.count()) {
      await game.first().click()
      await page.waitForTimeout(1500)
    }
  }
}

const go = async (page, route, selector) => {
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), route)
  await page.waitForSelector(selector, { timeout: 30000 })
  await page.waitForTimeout(300)
}

const style = (page) => page.evaluate(() => document.querySelector('.v-application').getAttribute('style'))
const store = (page) => page.evaluate((key) => localStorage.getItem(key), KEY)
const choose = (page, file) => page.setInputFiles('[data-appearance-input]', file)
const release = (page, name) => page.evaluate((file) => window.__release[file](), name)
const cancel = (page) => page.click('[data-preset-action="cancel"]')

const run = async () => {
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  const errors = []

  page.on('pageerror', (error) => errors.push(error.message))

  let original = null

  try {
    await open(page)
    original = await store(page)
    await go(page, '/settings', '[data-preset="light"]')

    await page.evaluate(() => {
      window.__release = {}

      const text = File.prototype.text

      File.prototype.text = function () {
        return /^slow/.test(this.name) ? new Promise((resolve) => { window.__release[this.name] = () => text.call(this).then(resolve) }) : text.call(this)
      }
    })

    const baseStyle = await style(page)
    const baseConfig = await store(page)

    await choose(page, upload('slow-late.json', document({ name: 'Late', roles: { surfaces: { background: '#202040' } } })))
    await page.waitForTimeout(200)
    await go(page, '/about', '.v-main')
    await release(page, 'slow-late.json')
    await page.waitForTimeout(600)
    check('a read that ends after Settings was left starts no preview on the page that is open', (await style(page)) === baseStyle)
    await go(page, '/settings', '[data-preset="light"]')
    check('and no draft, no failure and no change of the settings is there when Settings opens again', (await page.locator('[data-preset="custom-draft"]').count()) === 0 && (await page.locator('[data-appearance-errors]').count()) === 0 && (await store(page)) === baseConfig)

    await choose(page, upload('slow-old.json', document({ name: 'Old', roles: { surfaces: { background: '#202040' } } })))
    await page.waitForTimeout(200)
    await choose(page, upload('fast-new.json', document({ name: 'New' })))
    await page.waitForSelector('[data-preset="custom-draft"]')

    const newStyle = await style(page)

    await release(page, 'slow-old.json')
    await page.waitForTimeout(600)
    check('a read that a newer one superseded does not replace the newer draft', (await page.locator('[data-preset="custom-draft"]').count()) === 1 && /New/.test(await page.locator('[data-preset="custom-draft"]').innerText()) && (await style(page)) === newStyle)
    await cancel(page)

    await choose(page, upload('slow-bad.json', 'not json'))
    await page.waitForTimeout(200)
    await choose(page, upload('fast-ok.json', document({ name: 'Ok' })))
    await page.waitForSelector('[data-preset="custom-draft"]')
    await release(page, 'slow-bad.json')
    await page.waitForTimeout(500)
    check('a superseded read that would fail shows no failure beside the newer draft', (await page.locator('[data-appearance-errors]').count()) === 0 && (await page.locator('[data-preset="custom-draft"]').count()) === 1)
    await cancel(page)

    await choose(page, upload('inks.json', document({ name: 'Inks', base: 't2d', roles: { inks: { onColor: '#ffffff', onSnackbar: 'rgba(0, 0, 0, 0)' } } })))
    await page.waitForSelector('[data-preset="custom-draft"]')

    const findings = await page.locator('[data-appearance-findings]').innerText()

    check('a white toolbar ink and a transparent snackbar ink are findings, not a pass', /toolbar title on the primary fill/.test(findings) && /snackbar message on the primary fill/.test(findings) && !/All \d+ measured contrasts pass/.test(await page.locator('.appearance-file').innerText()))
    check('and Apply waits for the confirmation', (await page.getAttribute('[data-preset-action="apply"]', 'disabled')) !== null && (await page.locator('[data-appearance-confirm]').count()) === 1)
    await cancel(page)

    check('no page error', errors.length === 0, errors.slice(0, 3).join(' | '))
  } catch (error) {
    check('the check ran to the end', false, error.stack.split('\n').slice(0, 3).join(' '))
  } finally {
    try {
      await page.evaluate(([key, value]) => (value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value)), [KEY, original])
    } catch (error) {
      check('the settings were put back', false, error.message)
    }

    await browser.close()
  }

  log.forEach(({ text }) => console.log(text))
  process.exit(log.every(({ ok }) => ok) ? 0 : 1)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
