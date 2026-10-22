/*
  Regression check of the appearance file import on the Settings page, in a browser.

  bun scripts/check-appearance-late-read.js [--no-mutations] [--only=<text>,<text>]

  The real renderer is served over a copy of AuroraDB.db (scripts/lib/page-server.js) and driven in Chromium, each variant in a context of its own (scripts/lib/browser-observe.js `observe`), so nothing it does to the settings outlasts it. The reading of a chosen file is held back (a file named slow-* is read once the check releases it), and the check waits on the end of each read it started, never on a quiet period. It proves: a read that ends after Settings was left starts no preview on the page that is open and leaves no draft behind; a read that a newer one superseded neither replaces the newer draft nor shows a failure beside it; the inks on the toolbar and snackbar fills, which an imported file can set, are reported as findings, and Apply waits for the confirmation; and a file whose snackbar ink is transparent, whose findings are known without measuring (that ink over a fill is the fill itself, 1:1, and the snackbar's message is the one use drawn in it, on each named fill of COLOUR_FILLS), is reported with exactly those findings and that many named by the summary and the confirmation.

  The screen is read the way every page check reads it (scripts/lib/browser-observe.js `installScreen`, `hooked`, `readFigure`, `rolesRead`, `labelKey`): the hooks only find the elements. A draft is the name its card draws, compared with the name the file gives; the preview is the colour the app is painted in; a failure is the alert on screen and whether the screen names the file; each finding is its whole label, read back to the use and the fill it stands for through the contrast module's own tables (NAMED_USES and FILL_LABELS of utilities/appearance-contrast.js); and Apply is what a click on it does, beside the confirmation it asks for, read whole through ACKNOWLEDGEMENT_WORDS with the number of findings it names, which must be the number the summary of the setting names.

  Planted faults in copies of the components and the report served to the browser, one for each way the code can be wrong (a name drawn from another field, a finding drawn with its relation negated and a confirmation naming one finding too many, each with its hook kept; a finding counted twice in the report; the name or the cards of the presets drawn with no opacity; a read that is no longer the latest not ignored; Apply not waiting for the confirmation), each of which must make a check named for it fail by an assertion on a value, never by a call of the code under test that threw (scripts/lib/fault-credit.js `caughtBy`); a variant whose page does not get through stops the run, as nothing may be credited with it. Benign rewrites, one of each family (a name drawn by v-text, full opacity on the cards, a test written the other way round), must make none fail, alone and together. Prints `N of N checks passed`; exit code 1 when a check fails. It needs Playwright's Chromium.
*/
const fs = require('fs')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { startPageServer } = require('./lib/page-server')
const { observe, failedObservation, report, HarnessError, installScreen, readFigure, rolesRead, labelKey } = require('./lib/browser-observe')
const { assert, runChecks, judged, caughtBy, unobserved } = require('./lib/fault-credit')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const FILES = {
  card: path.join(root, 'src', 'renderer', 'components', 'settings', 'PresetCard.vue'),
  settings: path.join(root, 'src', 'renderer', 'pages', 'settings.vue'),
  file: path.join(root, 'src', 'renderer', 'components', 'settings', 'AppearanceFile.vue'),
  report: path.join(root, 'src', 'renderer', 'utilities', 'appearance-file.js'),
}
const SAVE = { file: 'AuroraDB.db', game: 'Aurelian Empire', race: 'Aurelian Empire' }
const TIMEOUT = 90000
const KEY = 'aurora-electrons:config'
// The id the app gives the draft a file is previewed as: the identity of its card.
const DRAFT = 'custom-draft'

const argument = (name) => (process.argv.find((item) => item.startsWith(`${name}=`)) || '').slice(name.length + 1)
const options = { mutations: !process.argv.includes('--no-mutations') }

let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const appearanceFile = (patch = {}) => ({ format: 'aurora-electrons-appearance', version: 1, name: 'Probe', mode: 'dark', ...patch })
const upload = (name, value) => ({ name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) })

// ---------- the page ----------

// Holds the reading of a chosen file back; runs in the page. A file named slow-* is read once the check releases it (`window.__release[name]()`), any other at once; `window.__read[name]` settles when the text of that file is in and the page's handler, which runs on the text without waiting again, has run on it.
const holdReads = () => {
  const text = File.prototype.text

  window.__release = {}
  window.__read = {}
  File.prototype.text = function () {
    const name = this.name
    const read = /^slow/.test(name) ? new Promise((resolve) => { window.__release[name] = () => text.call(this).then(resolve) }) : text.call(this)

    window.__read[name] = read.then(() => new Promise((resolve) => setTimeout(resolve, 0)))

    return read
  }
}

// What the checks judge of the page open, read through the shared readers (`window.__screen`); runs in the page. The colour the app is painted in; the settings as stored; the "Thousands Separator" setting figures are grouped by; the preset cards by their ids (`data-preset`), each with whether it is on screen and the name it draws (`data-preset-name`); in the appearance file setting, the failure of a read (`data-appearance-errors`), the whole text drawn, the number of findings its summary names (`data-appearance-count`), the label of each finding (`data-appearance-finding`) and the line that says every measurement passes (`data-appearance-pass`); and the confirmation Apply asks for (`data-appearance-confirm`) by the label of its box, with whether that label is on screen and the text it draws.
const readScreen = (key) => {
  const { visible, visibleText, hooked } = window.__screen
  const file = document.querySelector('[data-appearance-file]')
  const confirm = document.querySelector('[data-appearance-confirm]')
  const label = confirm && (confirm.labels && confirm.labels.length ? confirm.labels[0] : confirm.querySelector('label'))

  return {
    colour: getComputedStyle(document.querySelector('.v-application')).backgroundColor,
    config: localStorage.getItem(key),
    grouping: window.$app.$store.getters.config.get('selectedSeparator', 'Tick'),
    cards: [...document.querySelectorAll('[data-preset]')].map((card) => ({ id: card.getAttribute('data-preset'), on: visible(card), names: hooked(card, 'data-preset-name') })),
    failures: file ? hooked(file, 'data-appearance-errors') : [],
    text: file && visible(file) ? visibleText(file) : '',
    findings: file ? hooked(file, 'data-appearance-finding') : [],
    count: file ? hooked(file, 'data-appearance-count') : [],
    passes: file ? hooked(file, 'data-appearance-pass') : [],
    confirm: label ? { on: visible(label), text: visibleText(label) } : null,
  }
}

const go = async (page, route, selector) => {
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), route)
  await page.waitForFunction(pageLoading.arrived, route, { timeout: TIMEOUT })
  await page.waitForSelector(selector, { state: 'attached', timeout: TIMEOUT })
  await page.evaluate(async () => { await window.$app.$nextTick() })
}

// A file chosen in the setting, once the page's handler has started its read.
const choose = async (page, file) => {
  await page.setInputFiles('[data-appearance-input]', file)
  await page.waitForFunction((name) => name in window.__read, file.name, { timeout: TIMEOUT })
}

// The end of the read of the file `name`: its text is in, the page's handler has run on it, and the page has drawn what it then holds.
const readDone = (page, name) => page.evaluate(async (file) => { await window.__read[file]; await window.$app.$nextTick() }, name)

const release = async (page, name) => {
  await page.evaluate((file) => window.__release[file](), name)
  await readDone(page, name)
}

const screen = (page) => page.evaluate(readScreen, KEY)

// The cases as a player meets them, each read where it ends; resolves to the record of `observe` with the screens read. Every wait is on the operation the check started: a route arrived, a read begun, a read ended, a click done.
const observeCases = (browser, url) => observe(browser, async ({ page, step }) => {
  const seen = {}

  step('opening the app')
  await installScreen(page)
  await page.goto(url, { timeout: TIMEOUT })
  await page.waitForFunction(() => Boolean(window.$app && window.$app.$store), null, { timeout: TIMEOUT })

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${SAVE.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(SAVE.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID), null, { timeout: TIMEOUT })
  step('opening Settings')
  await go(page, '/settings', '[data-preset="light"]')
  await page.evaluate(holdReads)
  seen.base = await screen(page)

  step('a read that ends after Settings was left')
  await choose(page, upload('slow-late.json', appearanceFile({ name: 'Late', roles: { surfaces: { background: '#202040' } } })))
  await go(page, '/about', '.v-main')
  await release(page, 'slow-late.json')
  seen.late = await screen(page)
  await go(page, '/settings', '[data-preset="light"]')
  seen.back = await screen(page)

  step('a read that a newer one superseded')
  await choose(page, upload('slow-old.json', appearanceFile({ name: 'Old', roles: { surfaces: { background: '#202040' } } })))
  await choose(page, upload('fast-new.json', appearanceFile({ name: 'New' })))
  await readDone(page, 'fast-new.json')
  seen.newer = await screen(page)
  await release(page, 'slow-old.json')
  seen.superseded = await screen(page)
  await page.click('[data-preset-action="cancel"]', { timeout: TIMEOUT })

  step('a failing read that a newer one superseded')
  await choose(page, upload('slow-bad.json', 'not json'))
  await choose(page, upload('fast-ok.json', appearanceFile({ name: 'Ok' })))
  await readDone(page, 'fast-ok.json')
  await release(page, 'slow-bad.json')
  seen.failed = await screen(page)
  await page.click('[data-preset-action="cancel"]', { timeout: TIMEOUT })

  step('a file whose inks are findings')
  await choose(page, upload('inks.json', appearanceFile({ name: 'Inks', base: 't2d', roles: { inks: { onColor: '#ffffff', onSnackbar: 'rgba(0, 0, 0, 0)' } } })))
  await readDone(page, 'inks.json')
  seen.inks = await screen(page)
  step('clicking Apply before the confirmation')
  await page.click('[data-preset-action="apply"]', { force: true, timeout: TIMEOUT })
  await page.evaluate(async () => { await window.$app.$nextTick() })
  seen.applied = await screen(page)
  // Cancel drops the draft Apply was to wait on before the next file is chosen. An Apply that did not wait has applied the draft and left none (its card is gone from the screen read after the click), so there is nothing to cancel and inks-apply judges what the click did; while the draft is there, Cancel must work as before.
  if (seen.applied.cards.some((card) => card.id === DRAFT)) {
    await page.click('[data-preset-action="cancel"]', { timeout: TIMEOUT })
  }

  step('a file whose snackbar ink is transparent')
  await choose(page, upload('snackbar.json', appearanceFile({ name: 'Snackbar', base: 't2d', roles: { inks: { onSnackbar: 'rgba(0, 0, 0, 0)' } } })))
  await readDone(page, 'snackbar.json')
  seen.snackbar = await screen(page)

  return seen
})

// ---------- the checks ----------

// A check: `run(ctx)` returns to pass and throws (assert) to fail. Who failed: scripts/lib/fault-credit.js.
const CHECKS = []
const add = (id, name, run) => CHECKS.push({ id, name, run })

// The screens of the variant under judgement, or a failure of the check that names why there are none.
const seenOf = (ctx) => {
  assert.ok(ctx.observation.value !== null && !unobserved(ctx.observation), `the page did not get through: ${ctx.observation.error}`)

  return ctx.observation.value
}

const onScreen = (entries) => entries.filter((entry) => entry.on)

// The names the cards on screen draw (each element of a card on screen that draws its name).
const namesDrawn = (screen) => onScreen(screen.cards).flatMap((card) => onScreen(card.names).map((entry) => entry.text))

// The draft as the screen shows it: one card of the draft on screen, which draws the name `name` (`rolesRead`: exactly one element of the card draws a name on screen, and it reads as the name the file gives).
const expectDraft = (screen, name, label) => {
  const drafts = onScreen(screen.cards).filter((card) => card.id === DRAFT)

  assert.equal(drafts.length, 1, `${label}: the cards of a draft on screen`)

  const problems = rolesRead(`${label}: the draft`, drafts[0].names, { '': name })

  assert.deepEqual(problems, [], `${label}: the name the draft draws: ${JSON.stringify(problems)}`)
}

// No failure of a read is drawn: no alert of one on screen, and the screen does not name the file.
const expectNoFailure = (screen, file, label) => {
  assert.deepEqual(onScreen(screen.failures).map((entry) => entry.text), [], `${label}: a failure is drawn`)
  assert.ok(!screen.text.includes(file), `${label}: the setting names ${file}: "${screen.text}"`)
}

// The use and the fill the label of a finding stands for, read back whole through the contrast module's own tables: the words of a use (NAMED_USES), a space, and the words that name a fill after it (FILL_LABELS, through `labelKey`). Exactly one use and fill must read the label; null for any other label.
const findingKind = (contrast, label) => {
  const read = contrast.NAMED_USES.filter(([what]) => label.startsWith(`${what} `)).map(([what, use]) => [use, labelKey(label.slice(what.length + 1), contrast.FILL_LABELS)]).filter(([, fill]) => fill !== null)

  return read.length === 1 ? `${read[0][0]} on ${read[0][1]}` : null
}

// The number of findings the confirmation names, read back whole through the contrast module's words for it (ACKNOWLEDGEMENT_WORDS): the words before the number, the number in the grouping of the setting, and the noun for one finding or for more that goes with it; null for a label of other words.
const confirmedCount = (words, text, grouping) => {
  if (!text.startsWith(`${words.before} `)) {
    return null
  }

  const rest = text.slice(words.before.length + 1)
  const read = [[words.one, (figure) => figure === 1], [words.many, (figure) => figure !== 1]].filter(([noun]) => rest.endsWith(` ${noun}`)).map(([noun, fits]) => [readFigure(rest.slice(0, -noun.length - 1), grouping), fits]).filter(([figure, fits]) => figure !== null && fits(figure))

  return read.length === 1 ? read[0][0] : null
}

add('late-preview', 'a read that ends after Settings was left starts no preview on the page that is open: the app is painted as it was', (ctx) => {
  const seen = seenOf(ctx)

  assert.equal(seen.late.colour, seen.base.colour, 'the colour the app is painted in after the late read')
})

add('late-draft', 'and when Settings opens again no draft is there, no card draws the name of the file read late, no failure is drawn and the settings are as they were', (ctx) => {
  const seen = seenOf(ctx)

  assert.deepEqual(onScreen(seen.back.cards).filter((card) => card.id === DRAFT).map((card) => card.id), [], 'a draft card on screen')
  assert.ok(!namesDrawn(seen.back).includes('Late'), `a card draws the name of the file read late: ${JSON.stringify(namesDrawn(seen.back))}`)
  expectNoFailure(seen.back, 'slow-late.json', 'Settings opened again')
  assert.equal(seen.back.config, seen.base.config, 'the settings as stored')
})

add('superseded-draft', 'a read that a newer one superseded does not replace the newer draft: the draft still draws the newer file\'s name and the app is painted as the newer draft paints it', (ctx) => {
  const seen = seenOf(ctx)

  expectDraft(seen.newer, 'New', 'the newer read')
  expectDraft(seen.superseded, 'New', 'after the superseded read')
  assert.equal(seen.superseded.colour, seen.newer.colour, 'the colour the app is painted in after the superseded read')
})

add('superseded-failure', 'a superseded read that would fail shows no failure beside the newer draft', (ctx) => {
  const seen = seenOf(ctx)

  expectNoFailure(seen.failed, 'slow-bad.json', 'after the superseded failing read')
  expectDraft(seen.failed, 'Ok', 'after the superseded failing read')
})

add('inks-findings', 'a white toolbar ink and a transparent snackbar ink are findings, each read back through the contrast tables to its use and fill, and the line that every measurement passes is not drawn', (ctx) => {
  const seen = seenOf(ctx)
  const kinds = onScreen(seen.inks.findings).map((entry) => findingKind(ctx.contrast, entry.text))

  ;['title on primary', 'message on primary'].forEach((kind) => assert.ok(kinds.includes(kind), `the findings drawn do not hold ${kind}: ${JSON.stringify(onScreen(seen.inks.findings).map((entry) => entry.text))}`))
  assert.deepEqual(onScreen(seen.inks.passes).map((entry) => entry.text), [], 'the line that every measurement passes is drawn')
})

add('inks-apply', 'and Apply waits for the confirmation: a click on it keeps the draft and writes nothing, and the confirmation is drawn naming as many findings as the summary of the setting does, the two inks among them', (ctx) => {
  const seen = seenOf(ctx)

  expectDraft(seen.applied, 'Inks', 'after a click on Apply')
  assert.equal(seen.applied.config, seen.inks.config, 'the settings as stored after a click on Apply')
  assert.ok(seen.inks.confirm && seen.inks.confirm.on, 'no confirmation is drawn')

  const named = confirmedCount(ctx.contrast.ACKNOWLEDGEMENT_WORDS, seen.inks.confirm.text, seen.inks.grouping)
  const counted = onScreen(seen.inks.count).map((entry) => readFigure(entry.text, seen.inks.grouping))

  assert.ok(named !== null && named >= 2, `the confirmation "${seen.inks.confirm.text}" does not read as the words of a confirmation naming at least the two inks`)
  assert.deepEqual(counted, [named], `the number of findings the summary names against the ${named} the confirmation names`)
})

// The findings a transparent snackbar ink makes on a base that has none, known without measuring: a transparent ink drawn over a fill is the fill itself, a ratio of exactly 1:1, under every minimum; the snackbar's message is the one use drawn in that ink, and it is drawn on each of the named fills (COLOUR_FILLS), so the findings are the message on each fill, and nothing else.
add('snackbar-count', 'a transparent snackbar ink is a finding on each named fill and nowhere else: each finding drawn is the snackbar message on one fill, each fill once, and the summary and the confirmation each name that many findings', (ctx) => {
  const seen = seenOf(ctx)
  const screen = seen.snackbar
  const expected = ctx.contrast.COLOUR_FILLS.map(([name]) => `message on ${name}`)
  const drawn = onScreen(screen.findings).map((entry) => findingKind(ctx.contrast, entry.text))

  expected.forEach((kind) => assert.equal(drawn.filter((item) => item === kind).length, 1, `the findings drawn holding ${kind}: ${JSON.stringify(onScreen(screen.findings).map((entry) => entry.text))}`))
  assert.deepEqual(drawn.filter((kind) => !expected.includes(kind)), [], 'findings drawn that the transparent snackbar ink does not make')
  assert.deepEqual(onScreen(screen.count).map((entry) => readFigure(entry.text, screen.grouping)), [expected.length], 'the number of findings the summary names')
  assert.ok(screen.confirm && screen.confirm.on, 'no confirmation is drawn')
  assert.equal(confirmedCount(ctx.contrast.ACKNOWLEDGEMENT_WORDS, screen.confirm.text, screen.grouping), expected.length, `the number of findings the confirmation "${screen.confirm.text}" names`)
})

add('no-page-error', 'no page error and no console error was raised', (ctx) => {
  assert.deepEqual(ctx.observation.unexpected, [], 'the errors the page raised')
})

// ---------- the faults and the rewrites ----------

// [name, file key, from, to, the ids of the checks one of which must fail by a value]. Anchors are code, keys and attributes.
const MUTANTS = [
  ['the card draws the id of the appearance for its name, its hook kept', 'card', '<span class="preset__name" data-preset-name>{{ appearance.name }}</span>', '<span class="preset__name" data-preset-name>{{ appearance.id }}</span>', ['superseded-draft', 'superseded-failure', 'inks-apply']],
  ['the name of a card is drawn with no opacity', 'card', '<span class="preset__name" data-preset-name>', '<span class="preset__name" data-preset-name style="opacity: 0">', ['superseded-draft', 'superseded-failure', 'inks-apply']],
  ['the cards of the presets are drawn with no opacity', 'settings', '<div class="presets" role="group" aria-label="Colour presets">', '<div class="presets" role="group" aria-label="Colour presets" style="opacity: 0">', ['superseded-draft', 'superseded-failure', 'inks-apply']],
  ['a read that is no longer the latest is not ignored', 'settings', 'if (read !== this.appearanceRead) {', 'if (false) {', ['late-preview', 'superseded-draft']],
  ['Apply does not wait for the confirmation', 'settings', ':disabled="applyBlocked" data-preset-action="apply"', ':disabled="false" data-preset-action="apply"', ['inks-apply']],
  ['the confirmation names one finding more than there are, its hook kept', 'settings', 'this.count(findings)', 'this.count(findings + 1)', ['inks-apply']],
  ['a finding is drawn with its relation negated, its hook kept', 'file', '<span data-appearance-finding>{{ group.label }}</span>', '<span data-appearance-finding>{{ group.label.replace(\' on the \', \' not on the \') }}</span>', ['inks-findings']],
  ['a finding counted twice in the report', 'report', 'const findings = labelled.filter((row) => !row.pass).map(', 'const findings = labelled.filter((row) => !row.pass).flatMap((row, index) => (index === 0 ? [row, row] : [row])).map(', ['snackbar-count']],
]

// Rewrites that change nothing the checks observe, one of each family: each must leave every check passing.
const BENIGN = [
  ['the name of a card drawn by v-text', 'card', '<span class="preset__name" data-preset-name>{{ appearance.name }}</span>', '<span class="preset__name" data-preset-name v-text="appearance.name" />'],
  ['full opacity on the cards of the presets', 'settings', '<div class="presets" role="group" aria-label="Colour presets">', '<div class="presets" role="group" aria-label="Colour presets" style="opacity: 1">'],
  ['the noun of the confirmation chosen with the test the other way round', 'settings', 'findings === 1 ? ACKNOWLEDGEMENT_WORDS.one : ACKNOWLEDGEMENT_WORDS.many', 'findings !== 1 ? ACKNOWLEDGEMENT_WORDS.many : ACKNOWLEDGEMENT_WORDS.one'],
]

const cleanups = []

const finish = async (code) => {
  let failed = 0

  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failed++
      console.error(`cleanup failed: ${error && error.message ? error.message : error}`)
    }
  }

  process.exit(code || (failed ? 4 : 0))
}

const main = async () => {
  const only = argument('--only').split(',').filter(Boolean)
  const wanted = (name) => only.length === 0 || only.some((text) => name.includes(text))
  const sources = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]))
  const variantOf = (edits) => edits.reduce((given, [key, from, to]) => ({ ...given, [key]: patched(FILES[key], given[key], from, to) }), { ...sources })
  const contrast = (await loadUtilities(['appearance-contrast']))['appearance-contrast']

  // Every fault and rewrite, and the rewrites together, apply exactly once and parse before anything runs, whatever runs: an anchor gone stale stops the run at once.
  if (options.mutations) {
    ;[...MUTANTS, ...BENIGN].forEach(([, key, from, to]) => variantOf([[key, from, to]]))
    variantOf(BENIGN.map(([, key, from, to]) => [key, from, to]))
  }

  let server = null
  let chrome = null
  let startFailure = null

  try {
    server = await startPageServer({ save: SAVE.file })
    cleanups.push(() => server.stop())
    chrome = await require('playwright').chromium.launch()
    cleanups.push(() => chrome.close())

    const warmed = await server.warm(chrome, { routes: ['/settings', '/about'] })

    console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
  } catch (error) {
    startFailure = String(error.message).split('\n')[0]
  }

  const observeVariant = async (given) => {
    if (startFailure) {
      return failedObservation(startFailure)
    }

    const own = Object.keys(FILES).every((key) => given[key] === sources[key])

    Object.entries(FILES).forEach(([key, file]) => server.replace(file, given[key] === sources[key] ? null : given[key]))

    try {
      const seen = await observeCases(chrome, server.url)

      report(own ? 'the page' : 'a variant of the page', seen)

      return seen
    } finally {
      Object.values(FILES).forEach((file) => server.replace(file, null))
    }
  }
  // A variant whose page did not get through is judged by nothing: it stops the run, as no check may be credited with it.
  const judge = async (given, what) => {
    const observation = await observeVariant(given)

    if (unobserved(observation)) {
      throw new HarnessError(`the page with ${what} did not get through: ${observation.error}`)
    }

    return judged(await runChecks(CHECKS, { observation, contrast }), what)
  }

  console.log('The appearance file import on the Settings page')

  const baseline = await runChecks(CHECKS, { observation: await observeVariant(sources), contrast })

  baseline.forEach((result) => check(`${result.id}: ${result.name}`, result.ok, result.ok ? '' : `${result.kind}: ${result.detail}`))

  if (options.mutations) {
    console.log('\nPlanted faults')

    for (const [name, key, from, to, caught] of MUTANTS.filter(([name]) => wanted(name))) {
      const failed = await judge(variantOf([[key, from, to]]), `the fault "${name}"`)
      const credited = failed.filter((result) => caught.includes(result.id) && result.kind === 'assertion')

      check(`planted: ${name}: caught by ${failed.map((result) => result.id).join(', ') || 'nothing'}; credited by ${credited.map((result) => `${result.id} (${result.threw ? 'a throw' : 'a value'})`).join(', ') || 'nothing'}`, caughtBy(failed, caught, { name }), credited.map((result) => `${result.id}: ${result.detail.slice(0, 200)}`).join('; ') || `expected an assertion of one of ${caught.join(', ')}`)
    }

    console.log('\nBenign rewrites')

    for (const [name, key, from, to] of BENIGN.filter(([name]) => wanted(name))) {
      const failed = await judge(variantOf([[key, from, to]]), `the rewrite "${name}"`)

      check(`benign: ${name}: no check fails`, failed.length === 0, failed.map((result) => `${result.id}: ${result.detail}`).join('; '))
    }

    if (wanted('every benign rewrite')) {
      const failed = await judge(variantOf(BENIGN.map(([, key, from, to]) => [key, from, to])), 'every benign rewrite together')

      check('benign: every benign rewrite together: no check fails', failed.length === 0, failed.map((result) => `${result.id}: ${result.detail}`).join('; '))
    }
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  await finish(failures ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await finish(2)
})
