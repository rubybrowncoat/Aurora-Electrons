/*
  Checks what a player sees when the save now open is not an Aurora 2.7 save (src/renderer/components/page/UnsupportedSave.vue, shown by src/renderer/layouts/default.vue on the report routes and by src/renderer/pages/index.vue on the Empires page): the app is served by scripts/lib/page-server.js over copies of a save, opened in Chromium, and what is on screen is read back.

  Run: bun scripts/check-unsupported-save-page.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The decision (utilities/capabilities.js `lineResult`, the store's `refused` getter) is checked by scripts/check-capabilities.js; this script proves that it reaches the screen. It reads the screen through the shared readers of scripts/lib/browser-observe.js (`installScreen`): hooks the templates carry only identify an element, and every decision is read from the text the element draws, through the module's own words (utilities/capabilities.js `REFUSALS`), against what SQL written here says of each copy of the save. Three copies of one save are served one after another: a copy with the fourteen columns Aurora 2.7 added dropped (refused), the save as it is (accepted), and a copy with only FCT_Game.AncientRelics dropped (damaged: still of the 2.7 line, never refused).
  - on the refused copy the Empires page draws the notice, in the words of the reason SQL gives, with the version of the package, the line the app reads, the release that read older saves (its text and its link) and every column the copy lacks, each once, and no list of empires; the Save panel stays on screen and can be used;
  - on the refused copy a report route (Logistics) draws the same notice in place of the page, none of the page's panels; Settings and About draw their panels and no notice; the status line of the app says the save is refused in the words of the module; the button that checks the save again asks the database for its schema again, and the notice is there afterwards;
  - on the accepted copy and on the damaged copy the Empires page lists the games of the save and the Save panel is there, and a report route draws its panels and no notice, and the status line says nothing of a refusal;
  - the page raises no error on any of them.
  Every planted fault is served in place of the files of the app and the app is read again: each must fail the checks it names (a notice that is not displayed, one shown on a save that is not refused, the empire list left beside the notice, the Save panel hidden under it, a save with a column missing refused as a save of an older line, the status line saying nothing of the refusal, a button that does nothing, the notice drawn on Settings and About as well). Rewrites that say the same thing (the longhand of an event, a condition in parentheses, a synonym in the prose, a title with its words in another order, a condition written the other way round) must pass every check and draw the same screen. No rewrite of a `v-model` is made: the page has none.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2. It needs Playwright's Chromium (`bunx playwright install chromium` once). The heads and every fault and rewrite (`fault:N`, `benign:N`) run through scripts/lib/suite-runner.js, on one page server for each worker, and the run adds the control of the warm page server: a fault, then the head, which must pass every check.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { runSuite } = require('./lib/suite-runner')
const { observe, validate, failedObservation, failureLine, describe, HarnessError, installScreen, pairedBy, labelKey } = require('./lib/browser-observe')
const { caughtAll, notCaught, unobserved } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const SAVE = 'saves/AuroraDB_271_skoormit_saved.db'
const NAMES = { game: 'EggSample', race: 'EggSample' }
const TIMEOUT = 120000
const RELEASE = '0.11.0'
const COMPONENT = 'src/renderer/components/page/UnsupportedSave.vue'
const LAYOUT = 'src/renderer/layouts/default.vue'
const INDEX = 'src/renderer/pages/index.vue'
const STATUS = 'src/renderer/components/navigation/SaveStatus.vue'
const STORE = 'src/renderer/store/capabilities.js'
const FILES = [COMPONENT, LAYOUT, INDEX, STATUS, STORE]
// The fourteen columns Aurora 2.7 added over 2.6, written here (the oracle of the copy that is refused).
const LINE_COLUMNS = [
  'FCT_Game.AllowCMC',
  'FCT_Game.AncientRelics',
  'FCT_DesignPhilosophy.MaintenanceModules',
  'FCT_Fleet.AutoLP',
  'FCT_Population.AcademyNameThemeID',
  'FCT_Population.BuildReplacements',
  'FCT_Population.ReplacementCapacity',
  'FCT_Population.UseAcademyNameTheme',
  'FCT_Race.RandomClassName',
  'FCT_Race.chkCometNames',
  'FCT_Race.chkComets',
  'FCT_Ship.MaxActiveResolution',
  'FCT_Ship.SLRetire',
  'FCT_ShipClassTemplate.CrewDesignEfficiency',
]
const dropStatements = (fields) => fields.map((field) => `alter table ${field.split('.')[0]} drop column ${field.split('.')[1]}`)
// The copies served, in the order they are read.
const SCENES = [
  { key: 'refused', what: 'the copy without the fourteen columns', statements: dropStatements(LINE_COLUMNS) },
  { key: 'accepted', what: 'the save as it is', statements: [] },
  { key: 'damaged', what: 'the copy without FCT_Game.AncientRelics', statements: dropStatements(['FCT_Game.AncientRelics']) },
]
const DETAIL = process.argv.includes('--detail')

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

// ---------- what each copy holds, in SQL written here ----------

const all = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))

// A copy of the save in a folder of its own, with `statements` run on it.
const saveCopy = async (prefix, statements) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const file = path.join(folder, 'save.db')

  fs.copyFileSync(path.join(root, SAVE), file)

  const raw = await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(file, (error) => (error ? reject(error) : resolve(database)))
  })

  try {
    for (const statement of statements) {
      await new Promise((resolve, reject) => raw.run(statement, (error) => (error ? reject(error) : resolve())))
    }
  } finally {
    await new Promise((resolve) => raw.close(resolve))
  }

  return { folder, file }
}

// What the copy is: whether it has FCT_Game, which of the fourteen columns it lacks, the reason SQL gives for refusing it (null when it is not refused: a save with FCT_Game that lacks fewer than all fourteen) and the games it lists.
const truthOf = async (file) => {
  const raw = await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(database)))
  })

  try {
    const hasGame = (await all(raw, "select name from sqlite_master where type = 'table' and name = 'FCT_Game'")).length === 1
    const absent = []

    for (const field of LINE_COLUMNS) {
      const [table, column] = field.split('.')
      const rows = await all(raw, `select name from pragma_table_xinfo('${table}')`)

      if (!rows.some((row) => row.name.toLowerCase() === column.toLowerCase())) {
        absent.push(field)
      }
    }

    const games = hasGame ? (await all(raw, 'select GameName from FCT_Game')).map((row) => row.GameName) : []

    return { hasGame, absent, reason: !hasGame ? 'not-aurora' : absent.length === LINE_COLUMNS.length ? 'pre-2.7' : null, games }
  } finally {
    raw.close()
  }
}

// ---------- the app in a browser ----------

// What the screen shows; runs in the page, through the shared readers of scripts/lib/browser-observe.js (`installScreen`). Only hooks the templates carry, each with the text its element draws and whether it is on screen (`hooked`).
const readScreen = () => {
  const { visible, visibleText, hooked } = window.__screen
  const button = (selector) => {
    const element = document.querySelector(selector)

    return element ? { visible: visible(element), disabled: element.matches(':disabled') } : { visible: false, disabled: true }
  }
  const release = document.querySelector('[data-unsupported-release]')

  return {
    path: window.$app.$route.path,
    card: hooked(document.body, 'data-unsupported-save'),
    reason: hooked(document.body, 'data-unsupported-reason'),
    version: hooked(document.body, 'data-unsupported-version'),
    line: hooked(document.body, 'data-unsupported-line'),
    release: release ? { on: visible(release), text: visibleText(release), href: release.getAttribute('href') } : null,
    columns: hooked(document.body, 'data-unsupported-column'),
    retry: button('[data-unsupported-retry]'),
    savePanel: button('[data-save-choose]'),
    games: [...document.querySelectorAll('.empire-list__game')].map((element) => ({ on: visible(element), text: visibleText(element) })),
    status: hooked(document.body, 'data-save-status'),
    panels: [...document.querySelectorAll('.panel[data-summary]')].filter((element) => visible(element)).length,
  }
}

// The reads the page makes of the database, counted: the requests in flight and when the last one began or ended (the app is settled once none is out and none has been for a while), and how many asked for the schema of the save.
const track = (page) => {
  const state = { inFlight: 0, last: Date.now(), schemaReads: 0 }
  const isDatabaseCall = (request) => request.url().includes('/__aurora-db/') && !new URL(request.url()).pathname.endsWith('/stat')

  page.on('request', (request) => {
    if (isDatabaseCall(request)) {
      state.inFlight++
      state.last = Date.now()

      if (/pragma_table_xinfo/.test(request.postData() || '')) {
        state.schemaReads++
      }
    }
  })
  page.on('requestfinished', (request) => {
    if (isDatabaseCall(request)) {
      state.inFlight--
      state.last = Date.now()
    }
  })

  return state
}

// The page the route mounted is still working, or none is mounted (the layout draws the notice in its place) and nothing is: pageLoading says a missing page is working, so it is asked only of a mounted one.
const MOUNTED_LOADING = `(() => { const match = window.$app.$route.matched[0]; return Boolean(match && match.instances.default) && (${pageLoading})() })()`

const settle = async (page, state) => {
  const started = Date.now()

  while (state.inFlight > 0 || Date.now() - state.last < 1500 || await page.evaluate(MOUNTED_LOADING)) {
    if (Date.now() - started > TIMEOUT) {
      throw new Error(`the app did not settle (${state.inFlight} database calls in flight, ${Date.now() - state.last} ms since the last)`)
    }

    await page.waitForTimeout(250)
  }
}

// The screen as the check judges it: what the page draws, with the status line read part by part back to the reason whose words it says (the time of the last read it carries changes, so the words themselves are not kept), and the card of the notice as whether it is on screen (its prose is not a decision).
const read = async (page, t) => {
  const screen = await page.evaluate(readScreen)

  return { ...screen, card: screen.card.map((entry) => ({ on: entry.on })), status: screen.status.filter((entry) => entry.on).flatMap((entry) => entry.text.split(' · ')).map((part) => labelKey(part, t.statuses)).filter((key) => key !== null) }
}

// The route opened by the app's own router, until it is there and either its page is mounted or the layout has drawn the notice in its place.
const visit = async (page, state, target, t, step) => {
  step(`opening ${target}`)
  await page.evaluate((to) => window.$app.$router.push(to, () => {}, () => {}), target)
  await page.waitForFunction((to) => window.$app.$route.path === to, target, { timeout: TIMEOUT })
  await page.waitForFunction(`(${pageLoading.arrived})(${JSON.stringify(target)}) || document.querySelector('[data-unsupported-save]') !== null`, null, { timeout: TIMEOUT })
  await settle(page, state)

  return read(page, t)
}

// Resolves once `test` holds, or after `ms` either way.
const until = async (test, ms) => {
  const started = Date.now()

  while (!test() && Date.now() - started < ms) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

// One copy of the save opened in a browser and read: the Empires page as it opens, then the Logistics page once a race is picked; on the refused copy the button that checks the save again, and Settings and About.
const observeScene = (browser, url, scene, t) => observe(browser, async ({ page, step }) => {
  const state = track(page)
  step('opening the app')
  await page.goto(url, { timeout: TIMEOUT })
  await installScreen(page)
  step('waiting for the check of the save')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.database) && window.$app.$store.getters['capabilities/line'] !== null, null, { timeout: TIMEOUT })
  await settle(page, state)

  const seen = { home: await read(page, t) }

  // The Empires page lists the games of a save that is not refused: the player picks the game and the race there. Where the list is not drawn (a refused save, and a copy a fault refuses) no race can be picked, so the report routes, which the race guard sends back to the Empires page while no race is picked, are reached by a player who had a race open when the save was replaced: the same action the pick of the list dispatches, on the game of the open save.
  if (seen.home.games.some((entry) => entry.on)) {
    const picker = page.locator('.empire-list').first()

    step('picking the game')
    await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: TIMEOUT })

    if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
      step('picking the race')
      await picker.getByText(NAMES.race, { exact: true }).last().click({ timeout: TIMEOUT })
    }
  } else {
    step('selecting the race the way the pick of the list does')
    await page.evaluate(({ game, race }) => {
      const store = window.$app.$store
      const found = store.state.empires.games.find((entry) => entry.GameName === game)

      return store.dispatch('changeGame', { game: found, race: found.Races.find((entry) => entry.RaceTitle === race) || found.Races[0] })
    }, { game: NAMES.game, race: NAMES.race })
  }

  step('waiting for the save of the race')
  // The recorder holds off while the save is refused, so no campaign is settled and no settings prefix is made for the race: a refused save is waited for by the race alone.
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && (Boolean(window.$app.$store.getters.racePrefix) || window.$app.$store.getters['capabilities/refused']), null, { timeout: TIMEOUT })
  await settle(page, state)
  seen.page = await visit(page, state, '/logistics', t, step)

  if (scene.truth.reason === null) {
    return seen
  }

  // The button is pressed where the screen shows it: a notice that is not drawn has no button to press.
  const before = state.schemaReads

  if (seen.page.retry.visible && !seen.page.retry.disabled) {
    step('asking for the save to be checked again')
    await page.locator('[data-unsupported-retry]').click({ timeout: 30000 })
    await until(() => state.schemaReads > before, 15000)
    await page.waitForFunction(() => window.$app.$store.getters['capabilities/status'] !== 'checking', null, { timeout: TIMEOUT })
    await settle(page, state)
  }

  seen.retry = { asked: state.schemaReads > before, screen: await read(page, t) }
  seen.settings = await visit(page, state, '/settings', t, step)
  seen.about = await visit(page, state, '/about', t, step)

  return seen
})

// The records of the copies joined into one whose value holds the screens of all of them; the first that did not get through is returned as it is.
const joined = (records) => {
  records.forEach(([name, seen]) => validate(seen, `the ${name}`))

  const broken = records.find(([, seen]) => unobserved(seen))

  if (broken) {
    return broken[1]
  }

  return { value: Object.fromEntries(records.map(([name, seen]) => [name, seen.value])), error: null, phase: 'finished', scene: null, errors: records.flatMap(([, seen]) => seen.errors), console: records.flatMap(([, seen]) => seen.console), failed: records.flatMap(([, seen]) => seen.failed), unexpected: records.flatMap(([, seen]) => seen.unexpected) }
}

// ---------- the checks of one observation ----------

const verdict = (ok, evidence) => (ok ? true : short(evidence))
const shown = (entries) => entries.filter((entry) => entry.on)
const same = (found, wanted) => JSON.stringify(found) === JSON.stringify(wanted)

// What a screen draws of the notice against what the copy is (`scene`, the SQL's truth of it): [] when there is one notice, in the words of the reason SQL gives (read back through the module's words), with the version of the package, the line the app reads, the release and its link, and each column the copy lacks once; else the problems found.
const noticeProblems = (screen, scene, t) => {
  const problems = []
  const cards = shown(screen.card).length
  const reasons = shown(screen.reason).map((entry) => labelKey(entry.text, t.notices))
  const columns = pairedBy('the columns listed', shown(screen.columns), scene.absent, (entry) => entry.text, (column) => t.words(column))
  const release = screen.release

  if (cards !== 1) {
    problems.push(['the notice', `${cards} on screen`])
  }

  if (!same(reasons, [scene.reason])) {
    problems.push(['the reason', reasons, scene.reason])
  }

  if (!same(shown(screen.version).map((entry) => entry.text), [t.version])) {
    problems.push(['the version', shown(screen.version).map((entry) => entry.text), t.version])
  }

  if (!same(shown(screen.line).map((entry) => entry.text), [t.line])) {
    problems.push(['the line', shown(screen.line).map((entry) => entry.text), t.line])
  }

  if (!release || !release.on || release.text !== RELEASE || !String(release.href).endsWith(`/releases/tag/v${RELEASE}`)) {
    problems.push(['the release', release])
  }

  return [...problems, ...columns.problems]
}

// What a screen draws of a copy that is not refused: no notice, no refusal in the status line, and (`home`) the games of the save with the Save panel, or (`page`) the panels of the page.
const acceptedProblems = (o, scene) => {
  const problems = []

  for (const [name, screen] of [['the Empires page', o.home], ['the page', o.page]]) {
    if (shown(screen.card).length) {
      problems.push([name, 'a notice is on screen'])
    }

    if (screen.status.length) {
      problems.push([name, 'the status line says the save is refused', screen.status])
    }
  }

  const games = pairedBy('the games listed', shown(o.home.games), scene.games, (entry) => entry.text.split(' ·')[0], (name) => name)

  problems.push(...games.problems)

  if (!o.home.savePanel.visible || o.home.savePanel.disabled) {
    problems.push(['the Save panel', o.home.savePanel])
  }

  if (o.page.panels === 0) {
    problems.push(['the page', 'no panel is on screen'])
  }

  return problems
}

const CHECKS = [
  ['refused-notice', 'the Empires page of a copy without the fourteen columns draws one notice, in the words of the reason SQL gives, with the version, the line, the release and each missing column', (o, t) => verdict(noticeProblems(o.refused.home, t.scenes.refused, t).length === 0, noticeProblems(o.refused.home, t.scenes.refused, t))],
  ['refused-no-list', 'the Empires page of that copy lists no empire', (o) => verdict(shown(o.refused.home.games).length === 0, shown(o.refused.home.games))],
  ['refused-save-panel', 'the Save panel stays on screen under the notice and can be used', (o) => verdict(o.refused.home.savePanel.visible && !o.refused.home.savePanel.disabled, o.refused.home.savePanel)],
  ['refused-page', 'a report route of that copy draws the same notice in place of its panels', (o, t) => verdict(noticeProblems(o.refused.page, t.scenes.refused, t).length === 0 && o.refused.page.path === '/logistics' && o.refused.page.panels === 0, { problems: noticeProblems(o.refused.page, t.scenes.refused, t), path: o.refused.page.path, panels: o.refused.page.panels })],
  ['open-pages', 'Settings and About draw their panels and no notice', (o) => verdict(['settings', 'about'].every((name) => shown(o.refused[name].card).length === 0 && o.refused[name].panels > 0 && o.refused[name].path === `/${name}`), ['settings', 'about'].map((name) => ({ name, path: o.refused[name].path, cards: shown(o.refused[name].card).length, panels: o.refused[name].panels })))],
  ['refused-status', 'the status line says the save is refused, in the words of the reason SQL gives', (o, t) => verdict(same(o.refused.home.status, [t.scenes.refused.reason]) && same(o.refused.page.status, [t.scenes.refused.reason]), [o.refused.home.status, o.refused.page.status])],
  ['refused-retry', 'the button that checks the save again asks the database for the schema again and the notice is there afterwards', (o, t) => verdict(o.refused.retry.asked && noticeProblems(o.refused.retry.screen, t.scenes.refused, t).length === 0, { asked: o.refused.retry.asked, problems: noticeProblems(o.refused.retry.screen, t.scenes.refused, t) })],
  ['accepted-home', 'the Empires page of the save as it is lists its games with the Save panel and no notice', (o, t) => verdict(acceptedProblems(o.accepted, t.scenes.accepted).filter(([name]) => name !== 'the page').length === 0, acceptedProblems(o.accepted, t.scenes.accepted))],
  ['accepted-page', 'a report route of the save as it is draws its panels, no notice and no refusal in the status line', (o, t) => verdict(acceptedProblems(o.accepted, t.scenes.accepted).length === 0, acceptedProblems(o.accepted, t.scenes.accepted))],
  ['damaged-home', 'the Empires page of the copy without FCT_Game.AncientRelics lists its games with the Save panel and no notice', (o, t) => verdict(acceptedProblems(o.damaged, t.scenes.damaged).filter(([name]) => name !== 'the page').length === 0, acceptedProblems(o.damaged, t.scenes.damaged))],
  ['damaged-page', 'a report route of that copy draws its panels, no notice and no refusal in the status line', (o, t) => verdict(acceptedProblems(o.damaged, t.scenes.damaged).length === 0, acceptedProblems(o.damaged, t.scenes.damaged))],
  ['no-errors', 'the app raises no error on any copy', (o) => verdict(o.unexpected.length === 0, o.unexpected.slice(0, 3))],
]

// The results of the checks over the record of an observation: { id, name, result, kind }. A check fails by an assertion of its own, its verdict on what the screen showed (`kind` is 'assertion'); only such a failure credits a fault. A record with no screen to judge fails every check in the baseline (`kind` is 'unobserved', which credits nothing), and `strict` (a fault, a rewrite) stops the run as a defect of the harness.
const resultsOf = (seen, truth, { ids = null, strict = true, label = 'the observation', list = CHECKS } = {}) => {
  validate(seen, label)

  const chosen = list.filter(([id]) => !ids || ids.includes(id))

  if (unobserved(seen)) {
    if (strict) {
      throw new HarnessError(`${label} did not get through: ${failureLine(seen)}`)
    }

    return chosen.map(([id, name]) => ({ id, name, result: failureLine(seen), kind: 'unobserved' }))
  }

  const o = { ...seen.value, unexpected: seen.unexpected }

  return chosen.map(([id, name, test]) => {
    let result = null

    try {
      result = test(o, truth)
    } catch (error) {
      throw new HarnessError(`the check ${id} threw on ${label}: ${error && error.message ? error.message : error}`)
    }

    return { id, name, result, kind: result === true ? null : 'assertion' }
  })
}

// ---------- the variants of the app ----------

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new Error(`The variant must apply exactly once to the file: ${from}`)
  }

  return text.replace(from, () => to)
}

const REFUSAL_ANYWAY = swap('return this.line ? REFUSALS[this.line.reason] : undefined', 'return this.line ? (REFUSALS[this.line.reason] || REFUSALS[\'pre-2.7\']) : undefined')

const FAULTS = [
  { name: 'the notice is not displayed', changes: [[COMPONENT, swap('<v-card v-if="refusal" class="unsupported-save"', '<v-card v-if="refusal" v-show="false" class="unsupported-save"')]], fails: ['refused-notice', 'refused-page', 'refused-retry'] },
  { name: 'the notice is shown on a report route of a save that is not refused', changes: [[LAYOUT, swap('return this.refused && this.$route.path !== \'/\' && REPORT_ROUTES.includes(this.$route.path)', 'return this.$route.path !== \'/\' && REPORT_ROUTES.includes(this.$route.path)')], [COMPONENT, REFUSAL_ANYWAY]], fails: ['accepted-page', 'damaged-page'] },
  { name: 'the empire list is drawn beside the notice', changes: [[INDEX, swap('<v-card v-else class="game-picker"', '<v-card class="game-picker"')]], fails: ['refused-no-list'] },
  { name: 'the Save panel is not drawn on a refused save', changes: [[INDEX, swap('<save-panel />', '<save-panel v-if="!refused" />')]], fails: ['refused-save-panel'] },
  { name: 'a save with a column missing is refused as a save of an older line', changes: [[STORE, swap('return getters.line !== null && getters.line.status === \'refused\'', 'return getters.line !== null && getters.line.missing.length > 0')], [COMPONENT, REFUSAL_ANYWAY]], fails: ['damaged-home', 'damaged-page'] },
  { name: 'the status line says nothing of the refusal', changes: [[STATUS, swap('capabilityText () {\n      if (this.refusal) {', 'capabilityText () {\n      if (false) {')]], fails: ['refused-status'] },
  { name: 'the button that checks the save again does nothing', changes: [[COMPONENT, swap('@click="retry"', '@click="() => {}"')]], fails: ['refused-retry'] },
  { name: 'the notice is drawn on every route, Settings and About as well', changes: [[LAYOUT, swap('return this.refused && this.$route.path !== \'/\' && REPORT_ROUTES.includes(this.$route.path)', 'return this.refused && this.$route.path !== \'/\'')]], fails: ['open-pages'] },
]

const BENIGN = [
  { name: 'the button listening by the longhand of the event', changes: [[COMPONENT, swap('@click="retry"', 'v-on:click="retry"')]] },
  { name: 'the layout\'s condition in parentheses', changes: [[LAYOUT, swap('<unsupported-save v-if="refusedHere" />', '<unsupported-save v-if="(refusedHere)" />')]] },
  { name: 'the Empires page\'s condition in parentheses', changes: [[INDEX, swap('<unsupported-save v-if="refused" />', '<unsupported-save v-if="(refused)" />')]] },
  { name: 'a synonym in the prose of the notice', changes: [[COMPONENT, swap('a save of any other Aurora version is not read, and', 'a save of any other Aurora version is never read, and')]] },
  { name: 'the title with its words in another order', changes: [[COMPONENT, swap('</v-icon>Unsupported save</v-card-title>', '</v-icon>Save unsupported</v-card-title>')]] },
  { name: 'the report held back by the condition written the other way round', changes: [[LAYOUT, swap('return this.refused ? null : this.reportOf(this.$route.path)', 'return !this.refused ? this.reportOf(this.$route.path) : null')]] },
]

// ---------- the run ----------

let ENV = null
const cleanups = []

// What a worker sets up once before its first variant: a copy of the save for each scene with what SQL says of it, the module's words, the text of the files the faults change, and one page server, warmed, with one Chromium.
const setUp = async () => {
  const { startPageServer } = require('./lib/page-server')
  const { capabilities, provenance } = await loadUtilities(['capabilities', 'provenance'])
  const scenes = {}

  for (const scene of SCENES) {
    const copy = await saveCopy(`ae-unsupported-${scene.key}-`, scene.statements)

    cleanups.push(async () => fs.rmSync(copy.folder, { recursive: true, force: true }))
    scenes[scene.key] = { ...scene, file: copy.file, truth: await truthOf(copy.file) }
  }

  const reasons = Object.keys(capabilities.REFUSALS)
  const truth = {
    scenes: Object.fromEntries(Object.entries(scenes).map(([key, scene]) => [key, scene.truth])),
    notices: Object.fromEntries(reasons.map((reason) => [reason, capabilities.REFUSALS[reason].notice])),
    statuses: Object.fromEntries(reasons.map((reason) => [reason, capabilities.REFUSALS[reason].status])),
    version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    line: capabilities.STATED_FORMULA_VERSION,
    words: provenance.fieldWords,
  }
  const env = { scenes, truth, originals: Object.fromEntries(FILES.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')])), baseline: null }

  env.server = await startPageServer({ save: scenes.accepted.file })
  cleanups.push(() => env.server.stop())
  env.chrome = await require('playwright').chromium.launch()
  cleanups.push(() => env.chrome.close())

  const warmed = await env.server.warm(env.chrome, { routes: ['/', '/logistics', '/settings', '/about'] })

  console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)

  return env
}

// An observation that did not get through is told whole where it is met, in the output of its variant: the step, the message with Playwright's call log, and what the page showed then. Its checks say it in one line.
const told = (label, seen) => {
  if (seen.error !== null) {
    console.error(describe(label, seen))
  }

  return seen
}

// The app with `changes` made to it ([[file, change], ...], none for the app as it is), each copy of the save opened and read as a player does.
const view = async (changes) => {
  for (const [file, change] of changes) {
    ENV.server.replace(file, change(ENV.originals[file]))
  }

  try {
    const records = []

    for (const scene of Object.values(ENV.scenes)) {
      await ENV.server.useSave(scene.file)
      records.push([scene.key, told(`${scene.what}${changes.length ? ' with a variant of the app' : ''}`, await observeScene(ENV.chrome, ENV.server.url, scene, ENV.truth))])
    }

    return joined(records)
  } finally {
    for (const [file] of changes) {
      ENV.server.replace(file, null)
    }
  }
}

let checks = 0
let failures = 0

const report = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

// A fault's results reported as caught or not, with what each check named for it said under `--detail`.
const reportFault = (fault, results) => {
  report(`fault caught: ${fault.name}`, caughtAll(results, { name: fault.name }) ? true : notCaught(results), `fails ${fault.fails.join(', ')}`)

  if (DETAIL) {
    results.forEach(({ id, result }) => console.log(`         ${id}: ${result === true ? 'holds' : result}`))
  }
}

// Controls of the harness, with no browser but a stand-in of one for the record of `observe`: each shows that the judgement of a record is what the rule says it is.
const controls = async (truth) => {
  const whole = (value, unexpected = []) => ({ value, error: unexpected.length ? `the page raised ${unexpected.length} unexpected error${unexpected.length === 1 ? '' : 's'}, the first: ${unexpected[0]}` : null, phase: 'finished', errors: [], console: [], failed: [], unexpected })
  const stopped = (call) => {
    try {
      call()
    } catch (error) {
      return error
    }

    return null
  }
  const broken = failedObservation('the page did not open')
  const baselineOfBroken = resultsOf(broken, truth, { strict: false, ids: ['refused-notice'] })
  const throwing = [['boom', 'a check that throws', () => { throw new Error('the check broke') }]]
  const closeFailed = { ...whole({}), error: 'the context did not close: planted' }
  const raised = resultsOf(whole({}, ['console error: the render threw']), truth, { ids: ['no-errors'] })

  report('control: an observation that did not get through fails the checks of the baseline, naming where it stopped, and stops the run when a fault or a rewrite is judged', baselineOfBroken.length === 1 && baselineOfBroken[0].result !== true && stopped(() => resultsOf(broken, truth, { ids: ['refused-notice'] })) instanceof HarnessError ? true : short(baselineOfBroken))
  report('control: a check that throws stops the run as a defect of the harness, and one that returns passes', stopped(() => resultsOf(whole({}), truth, { list: throwing })) instanceof HarnessError && resultsOf(whole({}), truth, { list: [['fine', 'a check that holds', () => true]] })[0].result === true ? true : 'a throwing check was judged as a failed check, or a passing one failed')
  report('control: a record that is not whole stops the run as a defect of the harness', stopped(() => resultsOf({ value: {} }, truth)) instanceof HarnessError ? true : 'a record of another shape was judged')
  report('control: an error the page raised that no check named fails no-errors by an assertion, and a page that raised none passes it', raised[0].result !== true && raised[0].kind === 'assertion' && resultsOf(whole({}), truth, { ids: ['no-errors'] })[0].result === true ? true : 'the verdict of no-errors does not follow the errors of the record')
  report('control: a check that fails by its own verdict credits a fault named for it, and neither a check that holds nor a check of a page that was never observed credits one', caughtAll(resultsOf(whole({}), truth, { list: [['fails', 'a check that fails', () => 'what was seen']] })) && !caughtAll(resultsOf(whole({}), truth, { list: [['holds', 'a check that holds', () => true]] })) && !caughtAll(baselineOfBroken) && !caughtAll([]) ? true : 'the credit of a fault does not follow the kind of the result')
  report('control: a context that did not close, where the screen was kept, fails the checks of the baseline as an observation that did not get through and stops the run when a fault or a rewrite is judged', (() => {
    const results = resultsOf(closeFailed, truth, { strict: false, ids: ['refused-notice'] })

    return results.length === 1 && results[0].kind === 'unobserved' && !caughtAll(results) && stopped(() => resultsOf(closeFailed, truth, { ids: ['no-errors'] })) instanceof HarnessError
  })() ? true : 'a record whose context did not close was judged')
  report('control: the notice is read back to a reason only through the module\'s words, and words that are no reason\'s read back to none', labelKey(truth.notices['pre-2.7'], truth.notices) === 'pre-2.7' && labelKey('The save is old.', truth.notices) === null ? true : 'the words did not read back as they should')
}

// The head: the controls of the harness, then the app as it is, read afresh on the worker's server every time the head runs (the control of the warm page server runs it after a fault), and the controls of the oracle that the three copies are what the checks take them for.
const checkHead = async () => {
  const { truth } = ENV

  await controls(truth)

  const baseline = await view([])

  resultsOf(baseline, truth, { strict: false, label: 'the app' }).forEach(({ name, result }) => report(name, result))
  report('control: the copies are what the checks take them for: the first has FCT_Game and lacks all fourteen columns, the second lacks none, the third lacks FCT_Game.AncientRelics only', truth.scenes.refused.hasGame && truth.scenes.refused.reason === 'pre-2.7' && truth.scenes.refused.absent.length === LINE_COLUMNS.length && truth.scenes.accepted.reason === null && truth.scenes.accepted.absent.length === 0 && truth.scenes.damaged.reason === null && same(truth.scenes.damaged.absent, ['FCT_Game.AncientRelics']) && truth.scenes.accepted.games.includes(NAMES.game) ? true : short(truth.scenes))
}

const checkFault = async (fault) => {
  reportFault(fault, resultsOf(await view(fault.changes), ENV.truth, { ids: fault.fails, label: `the app with the fault "${fault.name}"` }))
}

// A rewrite must pass every check and draw the screens of the app as it is, read by the setup of its worker before the first variant (`baseline`), whichever that is, so that a rewrite reads only its own change.
const checkBenign = async (variant) => {
  if (unobserved(ENV.baseline)) {
    throw new HarnessError(`the app as it is was not observed, so the rewrite has no screen to be set against: ${failureLine(ENV.baseline)}`)
  }

  const seen = await view(variant.changes)
  const wrong = resultsOf(seen, ENV.truth, { label: `the app rewritten as "${variant.name}"` }).filter(({ result }) => result !== true).map(({ id }) => id)
  const alike = JSON.stringify(seen.value) === JSON.stringify(ENV.baseline.value)

  report(`variant passes: ${variant.name}`, wrong.length === 0 && alike ? true : wrong.length ? `fails ${wrong.join(', ')}` : 'the screen it draws is not the app\'s')
}

// The deadlines, in seconds: three copies are opened for each variant, the refused one through five pages; the setup copies the save three times and starts and warms the page server, the one cold start of Vite being the longest wait.
const DEADLINES = { head: 600, view: 600, setup: 900 + 180 }
// The planted fault the control runs before the head: one the head's reading of the app catches.
const CONTROL_FAULT = 'the notice is not displayed'

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the app on three copies of a save, and the controls of the harness', head: true, heading: 'The refusal of a save of another Aurora line in a browser (scripts/lib/page-server.js over copies of a save)', pool: 'suite', deadline: DEADLINES.head, run: checkHead },
  ...(mutating ? FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults', pool: 'suite', deadline: DEADLINES.view, run: () => checkFault(fault) })) : []),
  ...(mutating ? BENIGN.map((variant, index) => ({ key: `benign:${index}`, name: `variant passes: ${variant.name}`, heading: '\nvariants that say the same thing', pool: 'suite', deadline: DEADLINES.view, baseline: true, run: () => checkBenign(variant) })) : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SAVE],
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      ENV = await setUp()

      if (queue.some((variant) => variant.baseline)) {
        ENV.baseline = await view([])
      }
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
    control: mutating ? { fault: `fault:${FAULTS.findIndex((fault) => fault.name === CONTROL_FAULT)}`, head: 'head', heading: '\nthe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
