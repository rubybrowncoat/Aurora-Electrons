/*
  Checks the Commanders page (src/renderer/pages/commanders.vue) as a browser draws it: the page is served by scripts/lib/page-server.js over a copy of a save, opened in Chromium, and what a player sees and can do is read back: the Post, Rank and age controls of the roster, the roster rows each of them leaves, and the command structure with its holder column, its Shipping lines switch and its two downloads.

  Run: bun scripts/check-commanders-page.js [--no-mutations] [--no-lacking] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The data behind the page (the model, the exports, the filters against SQL) is checked by scripts/check-hierarchy-export.js; this script proves that the page puts them on the screen. It reads the screen through the shared readers of scripts/lib/browser-observe.js (`installScreen`): hooks the template carries (data attributes) say what an element is, an element counts when it is on screen with its opacity and its ancestors', its text is the text it draws, a control takes input when the browser's own element of it is enabled, and never a heading or other wording is read as a decision. The choices of a select are the words its menu draws, read back to the post each stands for through the module's own table of posts (utilities/commanders.js `POSTS`, `labelKey`), and each line of the roster is set against the officers SQL gives by the CommanderID its hook carries (`pairedBy`), never by place or by name, and must draw that officer's name. The save is served as a copy in which two serving officers share one name (`NAMESAKES`), so that the checks meet two lines of one name on every roster they compare; a control says that they did:
  - the roster's Post control is visible and offers the posts the save's serving naval officers hold, and choosing one leaves exactly the officers of that post (compared with SQL written here); the Rank control offers choices and narrows the roster; the two age controls bound it by the age worked out in SQL here; each choice can be cleared again;
  - the command structure panel is visible, lists rows each with a name and a holder cell naming commanders of the save, and its CSV download holds one record for each entry with every record as wide as its header;
  - the Shipping lines switch adds the shipping lines' fleets and ships to the table and to the download, marked in a column of their own, and taking it off removes them: the rows drawn again are set against the first ones by the key of each row (the hook of its name) and draw the same name and holder, their order checked on its own;
  - while the structure is read again (the answer held back) the table shows no row of the earlier model and both downloads are off, and the rows of the new read come when it is answered;
  - a save without the species or the ranks the age and rank filters rest on, with a bound of each stored, still lists the roster of the save as it is, with the age controls off, the note on screen read back through the module's own words (utilities/commanders.js `AGE_NOTES`) as the note that the ages cannot be worked out, and the rank control not on screen (the same page server serves a copy of the save with FCT_Species and FCT_Ranks dropped, `useSave`, until the reset after the variant).
  Every planted fault is served in place of the page's file and the page is read again: each must fail the checks it names (a hidden Post control, a Post control without choices, a Post control whose choices draw the words of another post, hidden age fields, a hidden Rank control, a roster line of one of two officers of one name that carries the other's identity, a Post control and the name and holder of each structure row drawn at opacity 0, a Holder cell that throws, a slot nothing consumes, a structure panel that is not displayed, a structure shown from the model of an earlier read, a structure read without the shipping lines, the age filter applied and the age controls left on for a save that lacks its columns, a note on the ages that draws other words); one fault stands for each way the page can be wrong, each named check has one, and the rank filter applied to a save without ranks is planted in scripts/check-hierarchy-export.js (`page-rank-gate`). A fault is credited only when every check named for it fails by an assertion of its own, its verdict on what the page showed (scripts/lib/fault-credit.js); a page that could not be driven (an observation that failed in itself, a context that did not close included where a screen was kept), or a check that throws, stops the run (HarnessError, exit status 2) and credits nothing. Variants that say the same thing in another way (a control bound by an explicit value and event, the longhand of an event, a native click listener, a control registered under an alias of the page, the words of a choice drawn through a function, a control drawn at opacity 1, the note on the ages drawn through v-text) are served the same way and must pass every check, those of the save with all its tables with the screen they draw equal to the page's.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2. It needs Playwright's Chromium (`bunx playwright install chromium` once). The heads (`head`, `lacking`) and every fault and rewrite (`fault:N`, `benign:N`, `lacking-fault:N`, `lacking-benign:N`) run through scripts/lib/suite-runner.js: one after another in a worker that copies the save, starts one page server and one browser and warms them first, each with a deadline, with a record that --resume continues and the control `control:warm-reset`, which runs a planted fault and then the head on the same server. --only=<text> runs the heads and the variants whose names hold the text (a focused run while working; the run that counts has none).
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { runSuite } = require('./lib/suite-runner')
const { observe, validate, failedObservation, failureLine, describe, HarnessError, installScreen, pairedBy, labelKey } = require('./lib/browser-observe')
const { caughtAll, notCaught, unobserved } = require('./lib/fault-credit')
const { strictRecords } = require('./lib/csv-records')
const { loadUtilities } = require('./lib/utilities')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const PAGE_FILE = 'src/renderer/pages/commanders.vue'
const SAVE = 'saves/AuroraDB_271_skoormit_saved.db'
const IDS = { GameID: 138, RaceID: 785 }
const NAMES = { game: 'EggSample', race: 'EggSample' }
const TIMEOUT = 120000
const YEAR = 31536000
const ROSTER_ROWS = 25
const STORED = { commandersAgeMin: 30, commandersAgeMax: 90, commandersRank: 2 }
// Two serving naval officers of the save whose post, age and rank put both on every roster the checks compare (the roster as it opens, the post chosen, the age bound): every copy of the save served gives the second the name of the first.
const NAMESAKES = [624163, 624519]
const NAMESAKE_RENAME = `update FCT_Commander set Name = (select Name from FCT_Commander where CommanderID = ${NAMESAKES[0]}) where CommanderID = ${NAMESAKES[1]}`
// The packages the commanders module imports, for reading its table of posts.
const STUBS = {
  dayjs: `import { createRequire } from 'node:module'\nexport default createRequire(${JSON.stringify(path.join(root, 'package.json'))})('dayjs')`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default createRequire(${JSON.stringify(path.join(root, 'package.json'))})('dayjs/plugin/utc.js')`,
  romanum: 'export default { toNumeral: String }',
}
// `--detail` prints what each check named for a fault said.
const DETAIL = process.argv.includes('--detail')

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

// ---------- what the save holds, in SQL written here ----------

const openRaw = (file) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(raw)))
})

// A copy of the save in a folder of its own, with `statements` run on it (the names of the namesakes made one, tables dropped): the copy a page server serves and the SQL here reads.
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

const pageText = () => fs.readFileSync(path.join(root, PAGE_FILE), 'utf8')

const all = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))

// The serving naval officers of the race with their post and age, and the names of every commander of the race.
const truthOf = async (file) => {
  const raw = await openRaw(file)

  try {
    const serving = await all(raw, `select c.CommanderID as id, c.Name as name, c.CommandType as post, s.GraduationAge + (g.GameTime - c.CareerStart) / ${YEAR}.0 as age from FCT_Commander c inner join FCT_Game g on g.GameID = c.GameID left join FCT_Species s on s.SpeciesID = c.SpeciesID where c.GameID = ${IDS.GameID} and c.RaceID = ${IDS.RaceID} and c.CommanderType = 0 and c.RetireStatus = 0 and c.Prisoner = 0`)
    const everyone = await all(raw, `select Name as name from FCT_Commander where GameID = ${IDS.GameID} and RaceID = ${IDS.RaceID}`)

    return { serving, names: new Set(everyone.map((row) => row.name)) }
  } finally {
    raw.close()
  }
}

// The lines of a roster on screen (`rosterOn`) set against the officers of `rows` ({ id, name }) by the CommanderID each line's hook carries, never by place or by name (scripts/lib/browser-observe.js `pairedBy`), and each line paired with an officer checked to draw that officer's name: [] when each officer has exactly one line, no line is of an identity no officer has, and every line draws its officer's name.
const sameRoster = (lines, rows) => {
  const { pairs, problems } = pairedBy('the roster', lines, rows, (line) => line.id, (row) => row.id)

  return [...problems, ...pairs.filter(([row, line]) => line.name !== row.name).map(([row, line]) => ['the roster', row.id, `draws ${JSON.stringify(line.name)}`, row.name])]
}
// The lines of a roster on screen, each with the CommanderID its hook carries and the name it draws.
const rosterOn = (entries) => entries.filter((entry) => entry.on).map((entry) => ({ id: entry.role, name: entry.text }))
// An officer of the SQL written here, with the identity a line of the roster carries.
const officer = (row) => ({ id: String(row.id), name: row.name })

// The post to pick (the choice of the control whose post a few serving officers hold; its words are the ones the menu draws) and the age bound to type (one that leaves a few officers; never at a rounding tie), with the officers SQL says each leaves.
const picksOf = (truth, postItems) => {
  const counts = new Map()

  truth.serving.forEach((row) => counts.set(row.post, (counts.get(row.post) || 0) + 1))

  const choice = postItems.map((item) => ({ text: item.text, value: item.value, count: counts.get(item.value) || 0 })).filter((item) => item.count >= 2 && item.count <= ROSTER_ROWS).sort((a, b) => b.count - a.count)[0]
  const aged = truth.serving.filter((row) => row.age !== null).sort((a, b) => b.age - a.age)
  const bound = Math.floor(aged[Math.min(9, aged.length - 1)].age) + 0.55
  const left = aged.filter((row) => Math.abs(row.age - bound) > 0.001 && row.age >= bound)

  return {
    post: choice ? { text: choice.text, rows: truth.serving.filter((row) => row.post === choice.value).map(officer) } : null,
    age: { bound, rows: left.map(officer) },
  }
}

// The choices of a select as the menu draws them, each read back to the post it stands for through the module's table of posts (null for words that are no post of the table).
const postChoices = (texts, posts) => texts.map((text) => {
  const key = labelKey(text, posts)

  return { text, value: key === null ? null : Number(key) }
})

// ---------- the page in a browser ----------

// What the page on screen shows; runs in the page, through the shared readers of scripts/lib/browser-observe.js (`installScreen`). Only hooks the template carries, each with the text its element draws and whether it is on screen (`hooked`): the controls (on screen when their field is; taking input when the browser's own element of the control is not disabled, as the player meets it), the lines of the roster (each hook carrying the CommanderID of its line), the note that the ages cannot be worked out, the structure panel, its switch and downloads, and the rows of the structure, each row with the parts it holds. Nothing is judged here.
const readScreen = () => {
  const { visible, hooked } = window.__screen
  // A hook on a Vuetify field lands on its input: the control is the field that holds it.
  const control = (selector) => {
    const element = document.querySelector(selector)
    const box = element ? element.closest('.v-input') : null

    return box ? { visible: visible(box), disabled: element.matches(':disabled') } : { visible: false, disabled: false }
  }
  const button = (selector) => {
    const element = document.querySelector(selector)

    return element ? { visible: visible(element), disabled: element.matches(':disabled') } : { visible: false, disabled: true }
  }
  const panel = document.querySelector('[data-structure]')
  const table = document.querySelector('[data-structure-table]')
  const rows = table ? [...table.querySelectorAll('tr')].filter((row) => row.querySelector('[data-structure-name], [data-structure-holder]')).map((row) => ({ on: visible(row), name: hooked(row, 'data-structure-name'), holder: hooked(row, 'data-structure-holder') })) : []

  return {
    post: control('[data-roster-post]'),
    rank: control('[data-roster-rank]'),
    ageMin: control('[data-roster-age-min]'),
    ageMax: control('[data-roster-age-max]'),
    ageUnavailable: hooked(document.body, 'data-age-unavailable'),
    roster: hooked(document.body, 'data-roster-name'),
    structurePanel: panel ? visible(panel) : false,
    switch: control('[data-structure-shipping-lines]'),
    csv: button('[data-structure-csv]'),
    markdown: button('[data-structure-markdown]'),
    structure: rows,
  }
}

// The page that `observe` (scripts/lib/browser-observe.js) opens, made ready: what the app's settings hold before it starts (`seed`, the stored view of the page), the shared readers of the screen installed, the race picked on the Empires page, the Commanders page opened and settled, each step named through `step` and bounded by TIMEOUT. `holding` makes the reads of the naval structure wait in `held` until they are let go, and `onHeld`, when set, is called as one is held. The page and console errors are the helper's.
const prepare = async (page, url, seed, step) => {
  const state = { held: [], holding: false, inFlight: 0, last: Date.now(), onHeld: null }
  const isDatabaseCall = (request) => request.url().includes('/__aurora-db/') && !new URL(request.url()).pathname.endsWith('/stat')

  await page.context().addInitScript((stored) => {
    const key = 'aurora-electrons:config'

    if (Object.keys(stored).length && !sessionStorage.getItem('aurora-check-seeded')) {
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), ...stored }))
      sessionStorage.setItem('aurora-check-seeded', '1')
    }
  }, seed)
  page.on('request', (request) => {
    if (isDatabaseCall(request)) {
      state.inFlight++
      state.last = Date.now()
    }
  })
  page.on('requestfinished', (request) => {
    if (isDatabaseCall(request)) {
      state.inFlight--
      state.last = Date.now()
    }
  })
  await page.route('**/__aurora-db/query', async (route) => {
    if (state.holding && /FCT_NavalAdminCommand/.test(route.request().postData() || '')) {
      state.held.push(route)

      if (state.onHeld) {
        state.onHeld()
      }
    } else {
      await route.continue()
    }
  })

  const settle = async () => {
    const started = Date.now()

    while ((state.inFlight > 0 && !state.holding) || Date.now() - state.last < 1500 || await page.evaluate(pageLoading)) {
      if (Date.now() - started > TIMEOUT) {
        const where = await page.evaluate(() => { const match = window.$app.$route.matched[0]; const view = match && match.instances.default; return { path: window.$app.$route.path, updating: Object.entries((view && view.$asyncComputed) || {}).filter(([, s]) => s.updating).map(([key]) => key) } })

        throw new Error(`the page did not settle (${state.inFlight} database calls in flight, ${Date.now() - state.last} ms since the last, loading ${await page.evaluate(pageLoading)}, ${JSON.stringify(where)})`)
      }

      await page.waitForTimeout(250)
    }
  }

  step('opening the app')
  await page.goto(url, { timeout: TIMEOUT })
  await installScreen(page)

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(NAMES.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  step('waiting for the save of the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
  step('waiting for the reads that the picking of the race starts')

  const picked = Date.now()

  // The page the race opens is not the one under test, and on a save without species it may never report itself as loaded: only its database calls are waited for.
  while (state.inFlight > 0 || Date.now() - state.last < 1500) {
    if (Date.now() - picked > TIMEOUT) {
      throw new Error(`the reads that the picking of the race starts did not finish (${state.inFlight} database calls in flight, ${Date.now() - state.last} ms since the last)`)
    }

    await page.waitForTimeout(250)
  }

  step('opening /commanders')
  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), '/commanders')
  await page.waitForFunction(pageLoading.arrived, '/commanders', { timeout: TIMEOUT })
  // The first roster name drawn, or the page's reads done with none drawn (a roster a fault leaves empty): either ends the wait, and the screen of an empty roster is judged by the checks.
  await page.waitForFunction(`document.querySelector('[data-roster-name]') !== null || !(${pageLoading})()`, null, { timeout: TIMEOUT }).catch(() => {})
  step('waiting for the page to settle')
  await settle()

  return { state }
}

// Runs in the page.
const read = (page) => page.evaluate(readScreen)

// The render that follows a change the check made: the change is committed by the event the click or the typing dispatched, and Vue's next tick is the flush of every update and watcher it queued.
const rendered = (page) => page.evaluate(async () => { await window.$app.$nextTick() })

const downloadOf = async (page, selector) => {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator(selector).click({ timeout: 30000 })])
  const records = strictRecords(fs.readFileSync(await file.path(), 'utf8'))

  return { count: records.length - 1, wide: records.every((record) => record.length === records[0].length), header: records[0], rows: records.slice(1) }
}

// The menu of a select opened, and what its items draw once each is on screen (the wait is bounded and resolves either way: an item that never comes on screen is read as it is).
const openMenu = async (page, selector) => {
  await page.locator(`.v-input:has(${selector}) .v-select__slot`).click({ timeout: 30000 })
  await page.waitForSelector('.menuable__content__active .v-list-item', { timeout: 30000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.menuable__content__active .v-list-item')].every((item) => window.__screen.visible(item)), null, { timeout: 5000 }).catch(() => {})

  return page.evaluate(() => [...document.querySelectorAll('.menuable__content__active .v-list-item')].map((item) => ({ text: window.__screen.visibleText(item), on: window.__screen.visible(item) })))
}

// The words of the choices a select offers, as its menu draws them on screen; the menu is closed again.
const menuOf = async (page, selector) => {
  const items = await openMenu(page, selector)

  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.menuable__content__active'), null, { timeout: 30000 })

  return items.filter((item) => item.on).map((item) => item.text)
}

// The choice of a select whose words are `text`, picked by the player from its menu.
const chooseItem = async (page, selector, text) => {
  const at = (await openMenu(page, selector)).findIndex((item) => item.on && item.text === text)

  if (at === -1) {
    throw new Error(`the menu of ${selector} draws no choice "${text}"`)
  }

  await page.locator('.menuable__content__active .v-list-item').nth(at).click({ timeout: 30000 })
  await rendered(page)
}

const clearItem = async (page, selector) => {
  await page.locator(`.v-input:has(${selector}) .v-input__icon--clear button`).click({ timeout: 30000 })
  await rendered(page)
}

// Resolves true once `promise` does, or false when `ms` have passed first.
const within = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ms)

  promise.then(() => {
    clearTimeout(timer)
    resolve(true)
  })
})

// The reads of the page done: none of its async-computed reads is updating and no progress bar of it runs (scripts/page-loading.js), waited for after a change that started one of them.
const readsDone = (page) => page.waitForFunction(`!(${pageLoading})()`, null, { timeout: TIMEOUT })

// Everything a player does on the page, and what the screen shows after each step: the record of `observe` (scripts/lib/browser-observe.js) whose value is { initial, csvOff, post, postCleared, age, ageCleared, rank, rankCleared, reread, linesOn, csvOn, linesOff }; `initial` holds the words of the choices each select's menu draws, the Post choices each read back to its post through `posts` (the module's table of posts). The page and console errors are in the record, not in the value.
const observePage = (browser, url, truth, posts) => observe(browser, async ({ page, step }) => {
  const began = Date.now()
  const at = (name) => {
    step(name)

    if (process.env.CHECK_TRACE) {
      console.error(`[${Math.round((Date.now() - began) / 1000)} s] ${name}`)
    }
  }

  const { state } = await prepare(page, url, {}, at)
  const screen = await read(page)

  at('the choices of the Post and Rank controls are read from their menus')

  const postTexts = screen.post.visible && !screen.post.disabled ? await menuOf(page, '[data-roster-post]') : []
  const rankTexts = screen.rank.visible && !screen.rank.disabled ? await menuOf(page, '[data-roster-rank]') : []
  const seen = { initial: { ...screen, postItems: postChoices(postTexts, posts), rankItems: rankTexts } }
  const first = seen.initial
  const picks = picksOf(truth, first.postItems)

  if (first.structurePanel && first.csv.visible && !first.csv.disabled) {
    at('the structure is downloaded')
    seen.csvOff = await downloadOf(page, '[data-structure-csv]')
  }

  if (picks.post && first.post.visible && !first.post.disabled) {
    at('a post is chosen')
    await chooseItem(page, '[data-roster-post]', picks.post.text)
    seen.post = (await read(page)).roster
    at('the post is cleared')
    await clearItem(page, '[data-roster-post]')
    seen.postCleared = (await read(page)).roster
  }

  if (first.ageMin.visible && !first.ageMin.disabled) {
    at('an age is typed')
    await page.locator('[data-roster-age-min]').fill(String(picks.age.bound), { timeout: 30000 })
    await rendered(page)
    seen.age = (await read(page)).roster
    await page.locator('[data-roster-age-min]').fill('', { timeout: 30000 })
    await rendered(page)
    seen.ageCleared = (await read(page)).roster
  }

  if (first.rank.visible && first.rankItems.length) {
    at('a rank is chosen')
    await chooseItem(page, '[data-roster-rank]', first.rankItems[0])
    seen.rank = (await read(page)).roster
    at('the rank is cleared')
    await clearItem(page, '[data-roster-rank]')
    seen.rankCleared = (await read(page)).roster
  }

  if (first.switch.visible) {
    // A write through the app's connection drops what the cache kept of the table, so the read the switch asks for goes to the database; its answer is held back, then let go. The screen is read once that read is held (or, when the switch asks for none, once 10 s have passed), after the render it set off.
    at('the shipping lines are turned on while the structure read is held')
    await page.evaluate(() => window.$app.$store.state.database.query('update FCT_NavalAdminCommand set AdminCommandName = AdminCommandName where 1 = 0'))
    state.held.length = 0
    state.holding = true

    const held = new Promise((resolve) => { state.onHeld = resolve })

    await page.locator('.v-input--selection-controls__input:has([data-structure-shipping-lines])').click({ timeout: 30000 })
    await within(held, 10000)
    await rendered(page)

    const during = await read(page)

    seen.reread = { held: state.held.length, structure: during.structure, csv: during.csv, markdown: during.markdown }
    state.holding = false
    state.onHeld = null

    for (const route of state.held.splice(0)) {
      await route.continue()
    }

    at('the read is answered')
    await readsDone(page)
    seen.linesOn = await read(page)

    if (seen.linesOn.csv.visible && !seen.linesOn.csv.disabled) {
      at('the structure with the shipping lines is downloaded')
      seen.csvOn = await downloadOf(page, '[data-structure-csv]')
    }

    at('the shipping lines are turned off')
    await page.locator('.v-input--selection-controls__input:has([data-structure-shipping-lines])').click({ timeout: 30000 })
    await rendered(page)
    await readsDone(page)
    seen.linesOff = await read(page)
  }

  return seen
})

// ---------- the checks of one observation ----------

const markedColumn = (table) => table.header.findIndex((_name, at) => table.rows.some((row) => row[at] === 'yes') && table.rows.every((row) => row[at] === 'yes' || row[at] === ''))

// A check's answer: true, or the evidence of what was seen.
const verdict = (ok, evidence) => (ok ? true : short(evidence))

// The one element of a part that is on screen, or null when none is or several are.
const oneOf = (entries) => {
  const on = entries.filter((entry) => entry.on)

  return on.length === 1 ? on[0] : null
}

// The text of the one element of a part that is on screen, or null.
const oneOn = (entries) => {
  const entry = oneOf(entries)

  return entry ? entry.text : null
}

// The rows of the structure table a player sees (each row on screen itself), in the order of the table: the key its name hook gives (the row's identity), the name and the holder it draws (null for a part it does not draw on screen).
const structureLines = (rows) => rows.filter((row) => row.on).map((row) => {
  const name = oneOf(row.name)

  return { key: name ? name.role : null, name: name ? name.text : null, holder: oneOn(row.holder) }
})

// What the structure drawn again (`after`) shows otherwise than the structure drawn first (`before`): its rows set against the first ones by key, each drawing the same name and holder, and then the order of the keys on its own; [] when it is the same structure.
const restoredProblems = (before, after) => {
  const { pairs, problems } = pairedBy('the structure drawn again', after, before, (line) => line.key, (line) => line.key)
  const order = JSON.stringify(after.map((line) => line.key)) === JSON.stringify(before.map((line) => line.key)) ? [] : [['the structure drawn again', 'the rows are in another order']]

  return [...problems, ...pairs.filter(([first, again]) => first.name !== again.name || first.holder !== again.holder).map(([first, again]) => ['the structure drawn again', first.key, again, first]), ...order]
}

const CHECKS = [
  ['panels', 'the roster and the command structure are on screen', (o) => verdict(o.initial.structurePanel && rosterOn(o.initial.roster).length > 0, [o.initial.structurePanel, rosterOn(o.initial.roster).length])],
  ['post-control', 'the Post control of the roster is visible and can be used', (o) => verdict(o.initial.post.visible && !o.initial.post.disabled, o.initial.post)],
  ['post-choices', 'the Post control offers posts, each drawn in the words of the module\'s table for its post, and every post is one a serving naval officer holds', (o, t) => verdict(o.initial.postItems.length >= 2 && o.initial.postItems.every((item) => item.value !== null && t.serving.some((row) => row.post === item.value)), o.initial.postItems)],
  ['post-filter', 'choosing a post by the words its menu draws leaves the officers of that post and clearing the choice brings the roster back', (o, t) => {
    const { post } = picksOf(t, o.initial.postItems)
    const chosen = post && o.post !== undefined ? sameRoster(rosterOn(o.post), post.rows) : null
    const cleared = o.postCleared !== undefined ? sameRoster(rosterOn(o.postCleared), rosterOn(o.initial.roster)) : null

    return verdict(chosen !== null && chosen.length === 0 && cleared !== null && cleared.length === 0, { chosen: post && post.text, after: chosen, cleared })
  }],
  ['age-controls', 'the two age controls are visible and can be used', (o) => verdict(o.initial.ageMin.visible && !o.initial.ageMin.disabled && o.initial.ageMax.visible && !o.initial.ageMax.disabled, [o.initial.ageMin, o.initial.ageMax])],
  ['age-filter', 'an age to bound the roster from below leaves the officers of that age or more, and clearing it brings the roster back', (o, t) => {
    const { age } = picksOf(t, o.initial.postItems)
    const bounded = o.age !== undefined ? sameRoster(rosterOn(o.age), age.rows) : null
    const cleared = o.ageCleared !== undefined ? sameRoster(rosterOn(o.ageCleared), rosterOn(o.initial.roster)) : null

    return verdict(bounded !== null && bounded.length === 0 && cleared !== null && cleared.length === 0, { after: bounded, cleared })
  }],
  ['rank-control', 'the Rank control of the roster is visible, offers ranks and narrows the roster', (o) => verdict(o.initial.rank.visible && !o.initial.rank.disabled && o.initial.rankItems.length > 0 && o.rank !== undefined && rosterOn(o.rank).length > 0 && sameRoster(rosterOn(o.rank), rosterOn(o.initial.roster)).length > 0 && sameRoster(rosterOn(o.rankCleared), rosterOn(o.initial.roster)).length === 0, { control: o.initial.rank, items: o.initial.rankItems.length, rows: o.rank && rosterOn(o.rank).length })],
  ['structure-rows', 'every row of the command structure shows a name and a holder cell, and each holder named is a commander of the save', (o, t) => {
    const rows = structureLines(o.initial.structure)

    return verdict(rows.length > 0 && rows.every((row) => row.name !== null && row.holder !== null) && rows.some((row) => row.holder !== '—') && rows.every((row) => row.holder === '—' || row.holder.split('; ').every((name) => t.names.has(name))), rows.slice(0, 3))
  }],
  ['structure-csv', 'the download of the structure holds one record for each entry, every record as wide as its header, and no shipping line while the switch is off', (o) => {
    const table = o.csvOff

    return verdict(Boolean(table) && table.count >= structureLines(o.initial.structure).length && table.wide && markedColumn(table) === -1, table && { count: table.count, wide: table.wide })
  }],
  ['shipping-lines', 'the Shipping lines switch adds the shipping lines to the table and to the download, marked in a column of their own, and taking it off removes them', (o) => {
    const { csvOff, csvOn } = o

    if (!o.initial.switch.visible || o.initial.switch.disabled || !csvOff || !csvOn || !o.linesOn || !o.linesOff) {
      return short({ switch: o.initial.switch, off: Boolean(csvOff), on: Boolean(csvOn) })
    }

    const column = markedColumn(csvOn)
    const marked = column === -1 ? 0 : csvOn.rows.filter((row) => row[column] === 'yes').length

    const restored = restoredProblems(structureLines(o.initial.structure), structureLines(o.linesOff.structure))

    return verdict(column !== -1 && csvOn.wide && csvOn.count > csvOff.count && marked === csvOn.count - csvOff.count && structureLines(o.linesOn.structure).length > 0 && restored.length === 0, { off: csvOff.count, on: csvOn.count, column, restored })
  }],
  ['structure-reread', 'while the structure is read again for the shipping lines the table shows no row of the earlier read and both downloads are off, and the rows of the shipping lines come when the read is answered', (o) => {
    const { reread } = o

    return verdict(Boolean(reread) && reread.held > 0 && structureLines(reread.structure).length === 0 && reread.csv.disabled && reread.markdown.disabled && structureLines(o.linesOn.structure).length > 0 && !o.linesOn.csv.disabled, reread && { held: reread.held, rows: structureLines(reread.structure).length, csv: reread.csv, markdown: reread.markdown })
  }],
  ['no-errors', 'the page raises no error', (o) => verdict(o.unexpected.length === 0, o.unexpected.slice(0, 3))],
]

// The results of the checks over the record of an observation: { id, name, result, kind }. A check fails by an assertion of its own, its verdict on what the page showed (`kind` is 'assertion'); only such a failure credits a fault. A record with no screen to judge (the work gave no value, or the observation failed in itself, the context not closing included, where a value was kept) has nothing the checks may trust: in the baseline it fails every check, naming where it stopped (`kind` is 'unobserved', which credits nothing), and `strict` (a fault, a variant, a save without species) stops the run with a HarnessError, so that a page that could not be driven is never credited with a fault. An error the page raised that no check named is not such a failure: it is the page's behaviour, judged by the checks. A check that throws is a defect of the harness and stops the run the same way (scripts/lib/fault-credit.js).
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

// ---------- the variants of the page ----------

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new Error(`The variant must apply exactly once to the page: ${from}`)
  }

  return text.replace(from, () => to)
}

const NAVAL_GATE = " || this.loadErrors[this.structureView === 'naval' ? 'navalTree' : 'groundTree'] !== null"

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the Post control is not displayed', change: swap('<v-select v-model="postFilter" ', '<v-select v-show="false" v-model="postFilter" '), fails: ['post-control', 'post-filter'] },
  { name: 'the Post control has no choices', change: swap(':items="postItems"', ':items="[]"'), fails: ['post-choices', 'post-filter'] },
  { name: 'the Holder cell reads a property that is not there', change: swap('{{ item.Holder }}</span>', '{{ item.Holder.missing.deeper }}</span>'), fails: ['structure-rows', 'no-errors'] },
  { name: 'the slot of the Holder column is one nothing consumes', change: swap('<template #[`item.Holder`]="{ item }">', '<template #[`item.Holders`]="{ item }">'), fails: ['structure-rows'] },
  { name: 'the command structure panel is not displayed', change: swap('elevation="1" data-structure>', 'elevation="1" data-structure style="display: none">'), fails: ['panels', 'structure-rows', 'structure-csv'] },
  { name: 'the structure is shown from the model of the earlier read', change: swap(NAVAL_GATE, ''), fails: ['structure-reread'] },
  { name: 'the age fields are not displayed', change: swap('<v-text-field :value="ageMin" ', '<v-text-field v-show="false" :value="ageMin" '), fails: ['age-controls', 'age-filter'] },
  { name: 'the Rank control is not displayed', change: swap('<v-select v-model="rankFilter" ', '<v-select v-show="false" v-model="rankFilter" '), fails: ['rank-control'] },
  { name: 'the roster line of one of two officers of one name carries the identity of the other, its name left as it is', change: swap(':data-roster-name="item.CommanderID"', `:data-roster-name="item.CommanderID === ${NAMESAKES[0]} ? ${NAMESAKES[1]} : item.CommanderID"`), fails: ['post-filter', 'age-filter'] },
  { name: 'the structure is read without the shipping lines whatever the switch says', change: swap('RaceID: this.RaceID, shippingLines: this.shippingLines }', 'RaceID: this.RaceID, shippingLines: false }'), fails: ['shipping-lines', 'structure-reread'] },
  { name: 'the Post control draws the words of the next post on each choice, its values left as they are', change: swap(':items="postItems" item-text="text"', ':items="postItems" :item-text="(item) => postItems[(postItems.indexOf(item) + 1) % postItems.length].text"'), fails: ['post-filter'] },
  { name: 'the Post control is drawn at opacity 0', change: swap('<v-select v-model="postFilter" ', '<v-select v-model="postFilter" style="opacity: 0" '), fails: ['post-control', 'post-filter'] },
  { name: 'the name and the holder of each structure row are drawn at opacity 0, the rows left as they are', change: (text) => swap('<span v-else class="text--secondary" data-structure-holder>', '<span v-else class="text--secondary" style="opacity: 0" data-structure-holder>')(swap('<span v-if="item.Holder" data-structure-holder>', '<span v-if="item.Holder" style="opacity: 0" data-structure-holder>')(swap(':data-structure-name="item.key">', ':data-structure-name="item.key" style="opacity: 0">')(text))), fails: ['structure-rows'] },
]

const BENIGN = [
  { name: 'the Post control bound by an explicit value and event', change: swap('<v-select v-model="postFilter" ', '<v-select :value="postFilter" @input="postFilter = $event" ') },
  { name: 'the CSV button listening by the longhand of the event', change: swap('@click="downloadStructure(\'csv\')"', 'v-on:click="downloadStructure(\'csv\')"') },
  { name: 'the Markdown button listening natively', change: swap('@click="downloadStructure(\'markdown\')"', '@click.native="downloadStructure(\'markdown\')"') },
  { name: 'the Post control registered under an alias of the page', change: (text) => swap('<v-select v-model="postFilter" ', '<post-choice v-model="postFilter" ')(swap('components: { LoadState, PageLink, ProvenanceMark, StatTiles },', "components: { LoadState, PageLink, ProvenanceMark, StatTiles, PostChoice: Vue.component('VSelect') },")(swap("import { mapGetters } from 'vuex'", "import Vue from 'vue'\nimport { mapGetters } from 'vuex'")(text))) },
  { name: 'the Post control drawing the words of each choice through a function', change: swap(':items="postItems" item-text="text"', ':items="postItems" :item-text="(item) => item.text"') },
  { name: 'the Post control drawn at opacity 1', change: swap('<v-select v-model="postFilter" ', '<v-select v-model="postFilter" style="opacity: 1" ') },
]

// The faults of the page for a save that lacks the columns of its filters: a filter still applied (the age bounds; the rank gate is planted in scripts/check-hierarchy-export.js, `page-rank-gate`), a control still on, and a note that draws other words.
const LACKING_FAULTS = [
  { name: 'the age bounds are applied to a save without species', change: swap('ageMin: this.ageAvailable ? this.ageMin : null, ageMax: this.ageAvailable ? this.ageMax : null', 'ageMin: this.ageMin, ageMax: this.ageMax'), fails: ['lacking-roster'] },
  { name: 'the age controls stay on for a save without species', change: swap(':disabled="!!focusCommanderId || !ageAvailable" data-roster-age-min', ':disabled="!!focusCommanderId" data-roster-age-min'), fails: ['lacking-controls'] },
  { name: 'the note that the ages cannot be worked out draws other words, its hook left as it is', change: swap('data-age-unavailable>{{ ageNotes.unavailable }}</div>', 'data-age-unavailable>The age range is on.</div>'), fails: ['lacking-controls'] },
]

// Rewrites of the page that draw the save without species the same way.
const LACKING_BENIGN = [
  { name: 'the note that the ages cannot be worked out drawn through v-text', change: swap('data-age-unavailable>{{ ageNotes.unavailable }}</div>', 'data-age-unavailable v-text="ageNotes.unavailable"></div>') },
]
/* eslint-enable no-template-curly-in-string */

// ---------- the save without species and ranks ----------

// The roster of the lacking save with the bounds stored, against the roster of the same save with nothing stored (`known`, the screen of an earlier read, when the caller has it): one record of `observe` for each page, joined into one whose value holds both screens. A record that did not get through is returned as it is.
const observeLacking = async (browser, url, known) => {
  const read1 = (seed) => observe(browser, async ({ page, step }) => {
    await prepare(page, url, seed, step)

    return read(page)
  })
  const [stored, plain] = await Promise.all([read1(STORED), known ? null : read1({})])

  validate(stored, 'the save without species, bounds stored')

  if (plain) {
    validate(plain, 'the save without species, nothing stored')
  }

  if (unobserved(stored)) {
    return stored
  }

  if (plain && unobserved(plain)) {
    return plain
  }

  return { ...stored, value: { withBounds: stored.value, without: plain ? plain.value : known } }
}

const LACKING_CHECKS = [
  ['lacking-roster', 'a save without species and ranks with an age range and a rank stored still lists its roster as it lists it with nothing stored', (o) => {
    const stored = rosterOn(o.withBounds.roster)
    const plain = rosterOn(o.without.roster)
    const problems = sameRoster(stored, plain)

    return (stored.length > 0 && problems.length === 0) || short({ stored: stored.length, plain: plain.length, problems })
  }],
  ['lacking-controls', 'a save without species has its age controls off and says so on screen in the words of the module\'s note, and a save without ranks shows no Rank control', (o, t) => {
    const said = o.withBounds.ageUnavailable.filter((entry) => entry.on).map((entry) => labelKey(entry.text, t.ageNotes))

    return (o.withBounds.ageMin.disabled && o.withBounds.ageMax.disabled && JSON.stringify(said) === JSON.stringify(['unavailable']) && !o.withBounds.rank.visible) || short({ min: o.withBounds.ageMin, max: o.withBounds.ageMax, said: o.withBounds.ageUnavailable, rank: o.withBounds.rank })
  }],
]

// What a worker sets up once before its first variant (`setUp`, run by the runner): a copy of the save with the namesakes made one, what SQL here reads of it, the module's tables of words, and one page server over the copy, warmed, with one Chromium. The variants of the save without species and ranks have the same server serve a copy of the save with FCT_Species and FCT_Ranks dropped as well (`useSave`, the copy made the first time one needs it), and the reset after each puts the first copy back.
let ENV = null
const cleanups = []

const setUp = async () => {
  const { startPageServer } = require('./lib/page-server')
  const { commanders } = await loadUtilities(['commanders'], { stubs: STUBS })
  const copy = await saveCopy('ae-commanders-', [NAMESAKE_RENAME])

  cleanups.push(async () => fs.rmSync(copy.folder, { recursive: true, force: true }))

  // The module's own words: the posts, which the choices of the Post control are read back through, and the notes of the age range, which the note on screen is.
  const env = { original: pageText(), posts: { ...commanders.POSTS }, ageNotes: { ...commanders.AGE_NOTES }, truth: await truthOf(copy.file), lackingFile: null, baseline: null, known: null }

  env.server = await startPageServer({ save: copy.file })
  cleanups.push(() => env.server.stop())
  env.chrome = await require('playwright').chromium.launch()
  cleanups.push(() => env.chrome.close())

  const warmed = await env.server.warm(env.chrome, { routes: ['/commanders'] })

  console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)

  return env
}

// A page that did not get through is told whole where it is met, in the output of its variant: the step, the message with Playwright's call log, and what the page showed then. Its checks say it in one line.
const told = (label, seen) => {
  if (seen.error !== null) {
    console.error(describe(label, seen))
  }

  return seen
}

// The page with `change` made to it (null for the page as it is), read as a player uses it.
const view = async (change) => {
  ENV.server.replace(PAGE_FILE, change ? change(ENV.original) : null)

  try {
    return told(change ? 'a variant of the page' : 'the page', await observePage(ENV.chrome, ENV.server.url, ENV.truth, ENV.posts))
  } finally {
    ENV.server.replace(PAGE_FILE, null)
  }
}

// The save without species and ranks, served from now until the reset after the variant: the results of LACKING_CHECKS over the page with `variant` made to it (null for the page as it is). The roster with nothing stored is read once by the head of that save and kept for the variants after it (`known`); a variant in a worker the head has not run in reads it too.
const lackingResults = async (variant) => {
  if (!ENV.lackingFile) {
    const lacking = await saveCopy('ae-commanders-lacking-', [NAMESAKE_RENAME, 'drop table FCT_Species', 'drop table FCT_Ranks'])

    cleanups.push(async () => fs.rmSync(lacking.folder, { recursive: true, force: true }))
    ENV.lackingFile = lacking.file
  }

  await ENV.server.useSave(ENV.lackingFile)
  ENV.server.replace(PAGE_FILE, variant ? variant.change(ENV.original) : null)

  try {
    const seen = told(variant ? `the save without species with "${variant.name}"` : 'the save without species', await observeLacking(ENV.chrome, ENV.server.url, variant ? ENV.known : null))

    if (!variant && !unobserved(seen)) {
      ENV.known = seen.value.without
    }

    return resultsOf(seen, { ageNotes: ENV.ageNotes }, { ids: variant ? variant.fails || null : null, strict: variant !== null, label: variant ? `the save without species ${variant.fails ? 'with the fault' : 'rewritten as'} "${variant.name}"` : 'the save without species', list: LACKING_CHECKS })
  } finally {
    ENV.server.replace(PAGE_FILE, null)
  }
}

// ---------- the run ----------

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

// Controls of the harness, with no browser but a stand-in of one for the record of `observe`: each paired with the case that is as it should be. They show that the judgement of a record is what the rule above says it is.
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
  const baselineOfBroken = resultsOf(broken, truth, { strict: false, ids: ['panels'] })
  const throwing = [['boom', 'a check that throws', () => { throw new Error('the check broke') }]]
  const closeFailed = { ...whole({}), error: 'the context did not close: planted' }
  const closeFailedRaising = { ...whole({}, ['console error: planted']), error: 'the context did not close: planted' }
  const unobservedAtBaseline = [closeFailed, closeFailedRaising].map((seen) => resultsOf(seen, truth, { strict: false, ids: ['panels'] }))
  const raised = resultsOf(whole({}, ['console error: the render threw']), truth, { ids: ['no-errors'] })
  const seenWith = async (close, raise = null) => {
    const listeners = []
    const page = { on: (event, listener) => listeners.push([event, listener]), waitForTimeout: async () => {} }

    return observe({ newContext: async () => ({ newPage: async () => page, close }) }, async () => {
      if (raise) {
        listeners.forEach(([event, listener]) => event === 'pageerror' && listener(new Error(raise)))
      }

      return {}
    })
  }
  const real = { closed: await seenWith(async () => {}), failed: await seenWith(async () => { throw new Error('planted') }), raised: await seenWith(async () => {}, 'planted'), failedRaising: await seenWith(async () => { throw new Error('planted') }, 'planted') }

  report('control: an observation that did not get through fails the checks of the baseline, naming where it stopped, and stops the run when a fault, a rewrite or another save is judged', baselineOfBroken.length === 1 && baselineOfBroken[0].result !== true && stopped(() => resultsOf(broken, truth, { ids: ['panels'] })) instanceof HarnessError ? true : short(baselineOfBroken))
  report('control: a check that throws stops the run as a defect of the harness, and one that returns passes', stopped(() => resultsOf(whole({}), truth, { list: throwing })) instanceof HarnessError && resultsOf(whole({}), truth, { list: [['fine', 'a check that holds', () => true]] })[0].result === true ? true : 'a throwing check was judged as a failed check, or a passing one failed')
  report('control: a record that is not whole stops the run as a defect of the harness', stopped(() => resultsOf({ value: {} }, truth)) instanceof HarnessError ? true : 'a record of another shape was judged')
  report('control: an error the page raised that no check named fails no-errors by an assertion, and a page that raised none passes it', raised[0].result !== true && raised[0].kind === 'assertion' && resultsOf(whole({}), truth, { ids: ['no-errors'] })[0].result === true ? true : 'the verdict of no-errors does not follow the errors of the record')
  report('control: a check that fails by its own verdict credits a fault named for it, and neither a check that holds nor a check of a page that was never observed credits one', caughtAll(resultsOf(whole({}), truth, { list: [['fails', 'a check that fails', () => 'what was seen']] })) && !caughtAll(resultsOf(whole({}), truth, { list: [['holds', 'a check that holds', () => true]] })) && !caughtAll(baselineOfBroken) && !caughtAll([]) ? true : 'the credit of a fault does not follow the kind of the result')
  report('control: a context that did not close, where the screen was kept, fails the checks of the baseline as an observation that did not get through, with or without an error the page raised, and credits no fault', unobservedAtBaseline.every((results) => results.length === 1 && results[0].kind === 'unobserved' && results[0].result !== true && !caughtAll(results)) ? true : short(unobservedAtBaseline))
  report('control: a context that did not close, where the screen was kept, stops the run when a fault, a rewrite or another save is judged, with or without an error the page raised, and one that closed does not', stopped(() => resultsOf(closeFailed, truth, { ids: ['no-errors'] })) instanceof HarnessError && stopped(() => resultsOf(closeFailedRaising, truth, { ids: ['no-errors'] })) instanceof HarnessError && stopped(() => resultsOf(whole({}), truth, { ids: ['no-errors'] })) === null ? true : 'a record whose context did not close was judged')
  report('control: the record of the observation tells a context that did not close, and the work that threw, from a page that raised an error no check named, as the helper makes it', unobserved(real.failed) && unobserved(real.failedRaising) && !unobserved(real.closed) && !unobserved(real.raised) && real.raised.unexpected.length === 1 && real.raised.error !== null ? true : short({ closed: real.closed.error, failed: real.failed.error, raised: real.raised.error, failedRaising: real.failedRaising.error }))
}

// The head: the controls of the harness, then the page as it is, read afresh on the worker's server every time the head runs (the control of the warm page server runs it after a fault), and the valid case of two officers of one name.
const checkHead = async () => {
  const { truth } = ENV

  await controls(truth)

  const baseline = await view(null)

  resultsOf(baseline, truth, { strict: false, label: 'the page' }).forEach(({ name, result }) => report(name, result))

  // The valid case of two officers of one name: the copy gives the namesakes one name, and each roster the checks compare draws both, under that name and each by its own identity.
  const namesakes = truth.serving.filter((row) => NAMESAKES.includes(row.id)).map(officer)
  const rosters = unobserved(baseline) ? [] : [baseline.value.initial.roster, baseline.value.post, baseline.value.age]
  const drawsBoth = (entries) => Boolean(entries) && NAMESAKES.every((id) => rosterOn(entries).filter((line) => line.id === String(id) && line.name === namesakes[0].name).length === 1)

  report('control: two serving officers of the save share one name, and the roster as it opens, the roster the chosen post leaves and the roster the age bound leaves each draw both under that name, each by its own identity', namesakes.length === 2 && namesakes[0].name === namesakes[1].name && rosters.length === 3 && rosters.every(drawsBoth) ? true : short({ namesakes, drawn: rosters.map((entries) => entries && rosterOn(entries).filter((line) => NAMESAKES.map(String).includes(line.id))) }))
}

const checkFault = async (fault) => {
  reportFault(fault, resultsOf(await view(fault.change), ENV.truth, { ids: fault.fails, label: `the page with the fault "${fault.name}"` }))
}

// A rewrite must pass every check and draw the screen of the page as it is, read by the setup of its worker before the first variant (`baseline`), whichever that is, so that a rewrite reads only its own page.
const checkBenign = async (variant) => {
  if (unobserved(ENV.baseline)) {
    throw new HarnessError(`the page as it is was not observed, so the rewrite has no screen to be set against: ${failureLine(ENV.baseline)}`)
  }

  const seen = await view(variant.change)
  const wrong = resultsOf(seen, ENV.truth, { label: `the page rewritten as "${variant.name}"` }).filter(({ result }) => result !== true).map(({ id }) => id)
  const same = JSON.stringify(seen.value) === JSON.stringify(ENV.baseline.value)

  report(`variant passes: ${variant.name}`, wrong.length === 0 && same ? true : wrong.length ? `fails ${wrong.join(', ')}` : 'the screen it draws is not the page\'s')
}

const checkLackingHead = async () => {
  (await lackingResults(null)).forEach(({ name, result }) => report(name, result))
}

const checkLackingBenign = async (rewrite) => {
  const wrong = (await lackingResults(rewrite)).filter(({ result }) => result !== true).map(({ id }) => id)

  report(`variant passes: ${rewrite.name}`, wrong.length === 0 ? true : `fails ${wrong.join(', ')}`)
}

// The deadlines, in seconds: five times the slowest time measured (the head 9 s, a variant 19 s), at least two minutes, and at least a minute past the longest step a variant takes (TIMEOUT, 120 s for a click or a wait of the page), so that a step that does not end fails by its own timeout, named, before the deadline runs out. The head reads the page through every control and both downloads; a variant reads it once more; the setup copies the save and starts and warms the page server, the one cold start of the run (900 s), and reads the page as it is when a rewrite of its queue is set against it (a variant's 180 s).
const DEADLINES = { head: 180, view: 180, setup: 900 + 180 }
// The planted fault the control runs before the head: one the head's reading of the page catches.
const CONTROL_FAULT = 'the Post control has no choices'
const LACKING_HEADING = '\nA save without species and ranks (a copy of the save with FCT_Species and FCT_Ranks dropped)'

const variantsOf = (mutating, lacking) => [
  { key: 'head', name: 'the head: the Commanders page as it is, and the controls of the harness', head: true, heading: 'The Commanders page in a browser (scripts/lib/page-server.js over a copy of a save)', pool: 'suite', deadline: DEADLINES.head, run: checkHead },
  ...(mutating ? FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault.name}`, heading: '\nplanted faults', pool: 'suite', deadline: DEADLINES.view, run: () => checkFault(fault) })) : []),
  ...(mutating ? BENIGN.map((variant, index) => ({ key: `benign:${index}`, name: `variant passes: ${variant.name}`, heading: '\nvariants that say the same thing', pool: 'suite', deadline: DEADLINES.view, baseline: true, run: () => checkBenign(variant) })) : []),
  ...(lacking ? [{ key: 'lacking', name: 'the head: a save without species and ranks', head: true, heading: LACKING_HEADING, pool: 'suite', deadline: DEADLINES.view, run: checkLackingHead }] : []),
  ...(lacking && mutating ? LACKING_FAULTS.map((fault, index) => ({ key: `lacking-fault:${index}`, name: `fault caught: ${fault.name}`, heading: LACKING_HEADING, pool: 'suite', deadline: DEADLINES.view, run: async () => reportFault(fault, await lackingResults(fault)) })) : []),
  ...(lacking && mutating ? LACKING_BENIGN.map((rewrite, index) => ({ key: `lacking-benign:${index}`, name: `variant passes: ${rewrite.name}`, heading: LACKING_HEADING, pool: 'suite', deadline: DEADLINES.view, run: () => checkLackingBenign(rewrite) })) : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: [SAVE],
    variants: variantsOf(mutating, !process.argv.includes('--no-lacking')),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      ENV = await setUp()

      if (queue.some((variant) => variant.baseline)) {
        ENV.baseline = await view(null)
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
