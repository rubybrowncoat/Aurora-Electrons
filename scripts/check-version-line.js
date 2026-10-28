/*
  Checks that the version of the app names the Aurora line it supports, and that the About page says so.

  bun scripts/check-version-line.js [--no-mutations] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]] [--detail]

  A release is numbered <Aurora major>.<Aurora minor>.<count of releases for that line> (2.7.10 is the first of the 2.7 line), so the first two numbers of the version in package.json and the first two of the line the app states for the saves it reads (STATED_FORMULA_VERSION of utilities/capabilities.js, `2.7.x`) are one statement made in two places. The head reads both as the app does (package.json as JSON, the constant from the module) and proves:
  - version-form: the package version is a plain three-part version (numbers without a leading zero) and the stated one a line `major.minor.x`;
  - version-line: from 2.7.10 on, the major.minor of the package version is the stated line's. A version before 2.7.10 is numbered the old way (0.x) and states no line, so it passes with a note; the check applies from the bump commit that makes the version 2.7.10 or later.
  Planted faults are states of the two files, never a change of this script's own logic, each naming both values so that a move of the real line changes none of them: a package version one minor or one major ahead of the line, the stated line moved to 3.0.x or 2.8.x with the package left at 2.7.10, a package version of two parts or with a leading zero, a stated line that names a patch. Each must fail the check named for it by a wrong value. The rewrites that must pass: the next count of the line (2.7.11), the 3.0 line once both move (3.0.0 against 3.0.x), and the old numbering (0.11.0).

  The About page (src/renderer/pages/about.vue) is served by scripts/lib/page-server.js over a copy of AuroraDB.db and read in Chromium as a player sees it (the shared readers of scripts/lib/browser-observe.js): a `data-aurora-line` hook only finds the element. Each page is read at its usual size twice, with the stated line as it is and with the constant of the served module moved to another line (3.0.x, or 4.1.x when the real line is 3.0.x), so a line that does not come from the constant fails by a value:
  - about-line: the line on screen reads "For Aurora <stated line> saves", the sentence the release notes and the refusal notice repeat, with the line the served constant holds;
  - about-beside: the line is on screen, on the row of the version chip and right of it;
  - about-version: the version chip reads v<package version>, the text the launch check of a release waits for;
  - about-quiet: the page raises no error, in any of the three views;
  - about-narrow: in a third view, a window of 960 x 720 with Verdana at the text scale 1.25 stored in the settings before the app starts, each chip of the head is inside the panel's box and the width its text needs (scrollWidth) is no more than the width it has (clientWidth). The title and its chips wrap there; a group that does not wrap pushes the line chip past the card, where the card's overflow clips it.
  Faults in the served page: the line written out (as the current stated line, so that only the moved serving shows it) instead of read from the constant, the package version in its place, the line not displayed, the line below the row of the chip, the title and chips that do not wrap, the version chip without its v, a console error when the page opens. Rewrites that must pass: the sentence drawn through v-text, the hook on an inner element, the line bound through a computed property instead of data, and the chip under a parenthesised condition that always holds.

  Prints `N of N checks passed`; a failed check sets exit code 1, a defect of the harness 2. It needs Playwright's Chromium. The head and every fault and rewrite run through scripts/lib/suite-runner.js, with the control `control:warm-reset`.
*/
const fs = require('fs')
const path = require('path')
const { runSuite } = require('./lib/suite-runner')
const { observe, validate, describe, HarnessError, installScreen } = require('./lib/browser-observe')
const { assert, runChecks, judged, caughtBy, unobserved } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const PACKAGE_FILE = 'package.json'
const CAPABILITIES_FILE = 'src/renderer/utilities/capabilities.js'
const ABOUT_FILE = 'src/renderer/pages/about.vue'
const SAVE = 'AuroraDB.db'
const TIMEOUT = 90000
// The line the served constant is moved to, so that a page which does not read it shows the line it was built with: the first of these the real line is not.
const MOVED = ['3.0.x', '4.1.x']
// The first version of the rule: a package version before it is numbered the old way (0.x) and states no line.
const RULE_STARTS = [2, 7, 10]
const NUMBER = '(0|[1-9]\\d*)'
const PACKAGE_FORM = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`)
const STATED_FORM = new RegExp(`^${NUMBER}\\.${NUMBER}\\.x$`)
const DETAIL = process.argv.includes('--detail')

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const partsOf = (version, form) => {
  const match = typeof version === 'string' ? form.exec(version) : null

  return match ? match.slice(1).map(Number) : null
}

const before = (version, start) => {
  const at = version.findIndex((part, index) => part !== start[index])

  return at !== -1 && version[at] < start[at]
}

// ---------- the two statements of the line ----------

const constantLine = (text) => `export const STATED_FORMULA_VERSION = '${text}'`

// The package version and the stated line of the two files with `version` and `constant` put in their places (null keeps the file as it is): the package version as the JSON says it, the line as the loaded module holds it.
const stateOf = async ({ version = null, constant = null }) => {
  const packageText = read(PACKAGE_FILE)
  const current = JSON.parse(packageText).version
  const swapped = version === null ? packageText : patched(PACKAGE_FILE, packageText, `"version": ${JSON.stringify(current)}`, `"version": ${JSON.stringify(version)}`)
  const capabilities = read(CAPABILITIES_FILE)
  const { capabilities: real } = await loadUtilities(['capabilities'])
  const source = constant === null ? capabilities : patched(CAPABILITIES_FILE, capabilities, constantLine(real.STATED_FORMULA_VERSION), constantLine(constant))
  const { capabilities: module } = constant === null ? { capabilities: real } : await loadUtilities(['capabilities'], { sources: { capabilities: source } })

  return { packageVersion: JSON.parse(swapped).version, stated: module.STATED_FORMULA_VERSION }
}

const check = (id, name, run) => ({ id, name, run })

const VERSION_CHECKS = [
  check('version-form', 'the package version is a plain three-part version and the stated one a line major.minor.x', ({ packageVersion, stated }) => {
    assert.ok(partsOf(packageVersion, PACKAGE_FORM) !== null, `the package version ${JSON.stringify(packageVersion)} is not major.minor.patch`)
    assert.ok(partsOf(stated, STATED_FORM) !== null, `the stated version ${JSON.stringify(stated)} is not a line major.minor.x`)
  }),
  check('version-line', 'from 2.7.10 on, the major.minor of the package version is the stated line\'s', ({ packageVersion, stated }) => {
    const own = partsOf(packageVersion, PACKAGE_FORM)
    const line = partsOf(stated, STATED_FORM)

    if (own === null || line === null || before(own, RULE_STARTS)) {
      return
    }

    assert.deepEqual(own.slice(0, 2), line.slice(0, 2), `the package version ${packageVersion} is not of the stated line ${stated}`)
  }),
]

// States of the two files that break the rule, each with the checks that name it, and states that keep it. Each names both values, so that a move of the real line (the 3.0 trunk) changes none of them.
const VERSION_FAULTS = [
  { name: 'the package version is a minor ahead of the stated line (2.8.0 against 2.7.x)', state: { version: '2.8.0', constant: '2.7.x' }, fails: ['version-line'] },
  { name: 'the package version is a major ahead of the stated line (3.7.10 against 2.7.x)', state: { version: '3.7.10', constant: '2.7.x' }, fails: ['version-line'] },
  { name: 'the stated line moves to 3.0.x and the package version stays 2.7.10', state: { version: '2.7.10', constant: '3.0.x' }, fails: ['version-line'] },
  { name: 'the stated line moves to 2.8.x and the package version stays 2.7.10', state: { version: '2.7.10', constant: '2.8.x' }, fails: ['version-line'] },
  { name: 'the package version has two parts (2.7)', state: { version: '2.7', constant: '2.7.x' }, fails: ['version-form'] },
  { name: 'the package version has a leading zero (2.07.10)', state: { version: '2.07.10', constant: '2.7.x' }, fails: ['version-form'] },
  { name: 'the stated version names a patch (2.7.1)', state: { version: '2.7.10', constant: '2.7.1' }, fails: ['version-form'] },
]

const VERSION_BENIGN = [
  { name: 'the next count of the line (2.7.11 against 2.7.x)', state: { version: '2.7.11', constant: '2.7.x' } },
  { name: 'the first count of the line (2.7.10 against 2.7.x)', state: { version: '2.7.10', constant: '2.7.x' } },
  { name: 'both move to the 3.0 line (3.0.0 against 3.0.x)', state: { version: '3.0.0', constant: '3.0.x' } },
  { name: 'the old numbering (0.11.0 against 2.7.x)', state: { version: '0.11.0', constant: '2.7.x' } },
]

// ---------- the About page, as a player sees it ----------

// What the page draws; runs in the page through the shared readers (`installScreen`): the chips of the head of the first panel, each with the text it draws, whether it is on screen, its box and the width its text needs against the width it has, each element the hook names, the box of the panel and the text scale in force.
const readAbout = () => {
  const { visible, visibleText } = window.__screen
  const box = (element) => {
    const { left, right, top, bottom } = element.getBoundingClientRect()

    return { left, right, top, bottom }
  }
  const entry = (element) => {
    const text = visibleText(element)
    const content = element.querySelector('.v-chip__content') || element

    return { text, on: visible(element) || text !== '', ...box(element), needs: content.scrollWidth, has: content.clientWidth }
  }
  const head = document.querySelector('.about-page .panel-head')
  const panel = document.querySelector('.about-page .panel')

  return { chips: head ? [...head.querySelectorAll('.v-chip')].map(entry) : [], line: [...document.querySelectorAll('[data-aurora-line]')].map(entry), panel: panel ? box(panel) : null, scale: getComputedStyle(document.querySelector('.about-page')).getPropertyValue('--ae-font-scale').trim() }
}

// The narrow card of the second view: a window of 960 x 720 with Verdana at the text scale 1.25, which the app reads from its stored settings before it starts.
const NARROW = { viewport: { width: 960, height: 720 }, stored: { appearanceFont: { family: 'verdana', scale: 1.25 } } }

// The About page open, read and left; one record of `observe`. `narrow` opens it as NARROW says.
const observeAbout = (browser, url, narrow = false) => observe(browser, async ({ page, step }) => {
  step('opening the app')

  if (narrow) {
    await page.context().addInitScript((stored) => {
      const key = 'aurora-electrons:config'

      if (!sessionStorage.getItem('aurora-check-seeded')) {
        localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), ...stored }))
        sessionStorage.setItem('aurora-check-seeded', '1')
      }
    }, NARROW.stored)
  }

  await installScreen(page)
  await page.goto(url, { timeout: TIMEOUT })
  await page.waitForFunction(() => Boolean(window.$app && window.$app.$store), null, { timeout: TIMEOUT })
  step('opening About')
  await page.evaluate(() => window.$app.$router.push('/about', () => {}, () => {}))
  await page.waitForFunction(pageLoading.arrived, '/about', { timeout: TIMEOUT })
  await page.waitForSelector('.about-page .panel-head', { state: 'attached', timeout: TIMEOUT })
  await page.evaluate(async () => { await window.$app.$nextTick(); await document.fonts.ready })

  return page.evaluate(readAbout)
}, narrow ? { viewport: NARROW.viewport } : {})

// The runs of the page at its usual size, one for each serving of the constant.
const aboutRuns = (ctx) => {
  assert.ok(ctx.observation.value !== null && !unobserved(ctx.observation), `the page did not get through: ${ctx.observation.error}`)

  return ctx.observation.value.runs.filter((run) => !run.narrow)
}

const narrowRun = (ctx) => {
  assert.ok(ctx.observation.value !== null && !unobserved(ctx.observation), `the page did not get through: ${ctx.observation.error}`)

  return ctx.observation.value.runs.find((run) => run.narrow)
}

const ABOUT_CHECKS = [
  check('about-line', 'About says "For Aurora <line> saves" with the line the stated constant holds, whatever it holds', (ctx) => {
    for (const run of aboutRuns(ctx)) {
      const lines = run.seen.line.filter((entry) => entry.on)

      assert.equal(lines.length, 1, `the page with the stated line ${run.stated} draws ${lines.length} lines of the supported saves`)
      assert.equal(lines[0].text, `For Aurora ${run.stated} saves`, `the page with the stated line ${run.stated} says something else`)
    }
  }),
  check('about-beside', 'the line is on screen, on the row of the version chip and right of it', (ctx) => {
    for (const run of aboutRuns(ctx)) {
      const lines = run.seen.line.filter((entry) => entry.on)
      const [chip] = run.seen.chips

      assert.ok(chip !== undefined && chip.on && lines.length === 1, `the page with the stated line ${run.stated} has no version chip beside a line`)
      assert.ok(lines[0].left >= chip.right && lines[0].top < chip.bottom && lines[0].bottom > chip.top, `the line (${Math.round(lines[0].left)},${Math.round(lines[0].top)}) is not beside the version chip (${Math.round(chip.right)},${Math.round(chip.top)})`)
    }
  }),
  check('about-version', 'the version chip reads v<package version>', (ctx) => {
    for (const run of aboutRuns(ctx)) {
      assert.equal(run.seen.chips.length > 0 ? run.seen.chips[0].text : null, `v${ctx.packageVersion}`, 'the first chip of the head is not the version')
    }
  }),
  check('about-quiet', 'the page raises no error', (ctx) => {
    for (const run of [...aboutRuns(ctx), narrowRun(ctx)]) {
      assert.deepEqual(run.unexpected, [], 'the page raised errors')
    }
  }),
  check('about-narrow', 'in a narrow card (960 x 720, Verdana, text scale 1.25) each chip of the head is inside the panel and its text has the width it needs', (ctx) => {
    const { seen } = narrowRun(ctx)

    assert.equal(seen.scale, String(NARROW.stored.appearanceFont.scale), 'the text scale of the stored setting is not in force')
    assert.ok(seen.panel !== null && seen.chips.length === 2, `the narrow page has ${seen.chips.length} chips in its head`)

    for (const chip of seen.chips) {
      assert.ok(chip.left >= seen.panel.left && chip.right <= seen.panel.right, `the chip "${chip.text}" (${Math.round(chip.left)} to ${Math.round(chip.right)}) is not inside the panel (${Math.round(seen.panel.left)} to ${Math.round(seen.panel.right)})`)
      assert.ok(chip.needs <= chip.has, `the text of the chip "${chip.text}" needs ${chip.needs} px and has ${chip.has}`)
    }
  }),
]

/* eslint-disable no-template-curly-in-string */
const swap = (from, to) => (text) => patched(ABOUT_FILE, text, from, to)
const compose = (...changes) => (text) => changes.reduce((given, change) => change(given), text)

const ABOUT_FAULTS = [
  { name: 'the line is written out as the current stated line instead of read from the constant', change: (text) => swap('For Aurora {{ auroraLine }} saves', `For Aurora ${ENV.stated} saves`)(text), fails: ['about-line'] },
  { name: 'the package version stands in place of the line', change: swap('For Aurora {{ auroraLine }} saves', 'For Aurora {{ version }} saves'), fails: ['about-line'] },
  { name: 'the line is not displayed, its hook left as it is', change: swap('class="ml-2" data-aurora-line', 'class="ml-2 d-none" data-aurora-line'), fails: ['about-line', 'about-beside'] },
  { name: 'the line is pushed below the row of the version chip', change: swap('class="ml-2" data-aurora-line', 'class="ml-2 mt-16" data-aurora-line'), fails: ['about-beside'] },
  { name: 'the title and chips do not wrap in a narrow card', change: swap('<span class="d-flex align-center flex-wrap">\n                <span>Aurora Electrons', '<span class="d-flex align-center">\n                <span>Aurora Electrons'), fails: ['about-narrow'] },
  { name: 'the version chip draws the bare number', change: swap('v{{ version }}', '{{ version }}'), fails: ['about-version'] },
  { name: 'the page logs a console error when it opens', change: swap("  name: 'AboutPage',", "  name: 'AboutPage',\n  mounted() {\n    console.error('planted console error')\n  },"), fails: ['about-quiet'] },
]

const ABOUT_BENIGN = [
  { name: 'the sentence drawn through v-text', change: swap('data-aurora-line>For Aurora {{ auroraLine }} saves</v-chip>', 'data-aurora-line v-text="\'For Aurora \' + auroraLine + \' saves\'"></v-chip>') },
  { name: 'the hook on an inner element of the chip', change: swap('class="ml-2" data-aurora-line>For Aurora {{ auroraLine }} saves</v-chip>', 'class="ml-2"><span data-aurora-line>For Aurora {{ auroraLine }} saves</span></v-chip>') },
  { name: 'the line bound through a computed property instead of data', change: compose(swap('      auroraLine: STATED_FORMULA_VERSION,\n', ''), swap('    settingsPath() {', '    auroraLine() {\n      return STATED_FORMULA_VERSION\n    },\n\n    settingsPath() {')) },
  { name: 'the chip under a parenthesised condition that always holds', change: swap('class="ml-2" data-aurora-line', 'class="ml-2" v-if="(auroraLine)" data-aurora-line') },
]
/* eslint-enable no-template-curly-in-string */

// ---------- the run ----------

let checks = 0
let failures = 0
let ENV = null
const cleanups = []

const report = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

const reportResults = (results) => results.forEach(({ id, name, ok, detail }) => report(`${id}: ${name}`, ok ? true : detail))

// A fault is caught when a check named for it fails by a value; what each check named for it said is told under --detail.
const reportFault = (fault, failed) => {
  const credited = failed.filter((result) => fault.fails.includes(result.id) && result.kind === 'assertion')

  report(`fault caught: ${fault.name}`, caughtBy(failed, fault.fails, { name: fault.name }) ? true : `no check named for it failed by a value (${fault.fails.join(', ')}); failed: ${failed.map((result) => result.id).join(', ') || 'none'}`, `fails ${credited.map((result) => result.id).join(', ')}`)

  if (DETAIL) {
    failed.forEach((result) => console.log(`         ${result.id}: ${result.detail}`))
  }
}

const setUp = async (queue) => {
  const env = { about: read(ABOUT_FILE), capabilities: read(CAPABILITIES_FILE), packageVersion: JSON.parse(read(PACKAGE_FILE)).version, server: null, chrome: null, stated: null, moved: null }

  env.stated = (await loadUtilities(['capabilities'])).capabilities.STATED_FORMULA_VERSION
  env.moved = MOVED.find((line) => line !== env.stated)

  // The synthesized control (the head run after a fault) needs the browser its two variants need.
  if (queue.some((variant) => variant.browser || (variant.control && (variant.control.fault.browser || variant.control.head.browser)))) {
    const { startPageServer } = require('./lib/page-server')

    env.server = await startPageServer({ save: SAVE })
    cleanups.push(() => env.server.stop())
    env.chrome = await require('playwright').chromium.launch()
    cleanups.push(() => env.chrome.close())

    const warmed = await env.server.warm(env.chrome, { routes: ['/about'] })

    console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
  }

  return env
}

// A page that did not get through is told whole where it is met; an error the page raised is behaviour, judged by `about-quiet`.
const told = (label, seen) => {
  if (unobserved(seen)) {
    console.error(describe(label, seen))
  }

  return seen
}

// The About page with `change` made to it (null for the page as it is), read twice: with the stated line as it is and with the served constant moved to another line (`env.moved`). A record of either that did not get through is returned as it is.
const view = async (change, label) => {
  const runs = []
  let first = null

  for (const { stated, narrow } of [{ stated: ENV.stated, narrow: false }, { stated: ENV.moved, narrow: false }, { stated: ENV.stated, narrow: true }]) {
    ENV.server.replace(ABOUT_FILE, change ? change(ENV.about) : null)
    ENV.server.replace(CAPABILITIES_FILE, stated === ENV.stated ? null : patched(CAPABILITIES_FILE, ENV.capabilities, constantLine(ENV.stated), constantLine(stated)))

    try {
      const seen = told(`${label} with the stated line ${stated}${narrow ? ' in the narrow window' : ''}`, await observeAbout(ENV.chrome, ENV.server.url, narrow))

      validate(seen, `${label} with the stated line ${stated}`)

      if (unobserved(seen)) {
        return seen
      }

      first = first || seen
      runs.push({ stated, narrow, seen: seen.value, unexpected: seen.unexpected })
    } finally {
      ENV.server.replace(ABOUT_FILE, null)
      ENV.server.replace(CAPABILITIES_FILE, null)
    }
  }

  return { ...first, value: { runs } }
}

const judgeAbout = async (change, what) => {
  const observation = await view(change, what)

  // A page that did not get through is judged by nothing when a fault or a rewrite is read; the head says it through its checks.
  if (change && unobserved(observation)) {
    throw new HarnessError(`${what} did not get through: ${observation.error}`)
  }

  return runChecks(ABOUT_CHECKS, { observation, packageVersion: ENV.packageVersion })
}

const checkVersionHead = async () => {
  const state = await stateOf({})

  if (before(partsOf(state.packageVersion, PACKAGE_FORM) || [0, 0, 0], RULE_STARTS)) {
    console.log(`INFO  the package version ${state.packageVersion} is numbered the old way, so the line check starts at 2.7.10`)
  }

  reportResults(await runChecks(VERSION_CHECKS, state))
}

const checkVersionFault = async (fault) => {
  reportFault(fault, judged(await runChecks(VERSION_CHECKS, await stateOf(fault.state)), `the fault "${fault.name}"`))
}

const checkVersionBenign = async (variant) => {
  const failed = judged(await runChecks(VERSION_CHECKS, await stateOf(variant.state)), `the rewrite "${variant.name}"`)

  report(`variant passes: ${variant.name}`, failed.length === 0 ? true : `fails ${failed.map((result) => `${result.id}: ${result.detail}`).join('; ')}`)
}

const checkAboutHead = async () => {
  reportResults(await judgeAbout(null, 'the page'))
}

const checkAboutFault = async (fault) => {
  reportFault(fault, judged(await judgeAbout(fault.change, `the page with the fault "${fault.name}"`), `the fault "${fault.name}"`))
}

const checkAboutBenign = async (variant) => {
  const failed = judged(await judgeAbout(variant.change, `the page rewritten as "${variant.name}"`), `the rewrite "${variant.name}"`)

  report(`variant passes: ${variant.name}`, failed.length === 0 ? true : `fails ${failed.map((result) => `${result.id}: ${result.detail}`).join('; ')}`)
}

// The deadlines, in seconds, at least two minutes: a version variant loads one module; an About variant reads the page twice on a warm server. The setup starts and warms the page server, the one cold start of the run.
const DEADLINES = { version: 120, about: 180, setup: 900 + 120 }
const CONTROL_FAULT = 'the line is not displayed, its hook left as it is'

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the package version and the stated line', head: true, heading: 'The version of the app and the Aurora line it states (package.json, utilities/capabilities.js)', pool: 'suite', deadline: DEADLINES.version, run: checkVersionHead },
  ...(mutating ? VERSION_FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults of the version and the line', pool: 'suite', deadline: DEADLINES.version, run: () => checkVersionFault(fault) })) : []),
  ...(mutating ? VERSION_BENIGN.map((variant, index) => ({ key: `benign:${index}`, name: `variant passes: ${variant.name}`, heading: '\nversions that keep the rule', pool: 'suite', deadline: DEADLINES.version, run: () => checkVersionBenign(variant) })) : []),
  { key: 'about', name: 'the head: the About page as it is', head: true, browser: true, heading: '\nThe About page in a browser (scripts/lib/page-server.js over a copy of a save)', pool: 'suite', deadline: DEADLINES.about, run: checkAboutHead },
  ...(mutating ? ABOUT_FAULTS.map((fault, index) => ({ key: `about-fault:${index}`, name: `fault caught: ${fault.name}`, browser: true, heading: '\nplanted faults of the page', pool: 'suite', deadline: DEADLINES.about, run: () => checkAboutFault(fault) })) : []),
  ...(mutating ? ABOUT_BENIGN.map((variant, index) => ({ key: `about-benign:${index}`, name: `variant passes: ${variant.name}`, browser: true, heading: '\nrewrites of the page that say the same thing', pool: 'suite', deadline: DEADLINES.about, run: () => checkAboutBenign(variant) })) : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SAVE],
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      ENV = await setUp(queue)
    },
    afterEach: async () => {
      if (ENV && ENV.server) {
        await ENV.server.reset()
      }
    },
    close: async () => {
      const problems = []

      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch((error) => problems.push(String(error && error.message ? error.message : error).split('\n')[0]))
      }

      if (problems.length) {
        throw new Error(`cleanups failed: ${problems.join(' | ')}`)
      }
    },
    control: mutating ? { fault: `about-fault:${ABOUT_FAULTS.findIndex((fault) => fault.name === CONTROL_FAULT)}`, head: 'about', heading: '\nthe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
