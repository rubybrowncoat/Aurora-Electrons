/*
  Checks the Commanders page (src/renderer/pages/commanders.vue) as a browser draws it: the page is served by scripts/lib/page-server.js over a copy of a save, opened in Chromium, and what a player sees and can do is read back: the Post, Rank and age controls of the roster, the roster rows each of them leaves, and the command structure with its holder column, its Shipping lines switch and its two downloads.

  Run: bun scripts/check-commanders-page.js [--no-mutations]

  The data behind the page (the model, the exports, the filters against SQL) is checked by scripts/check-hierarchy-export.js; this script proves that the page puts them on the screen. It reads only hooks the template carries (data attributes) and what a browser reports as visible, never a heading or other wording:
  - the roster's Post control is visible and offers the posts the save's serving naval officers hold, and choosing one leaves exactly the officers of that post (names compared with SQL written here); the Rank control offers choices and narrows the roster; the two age controls bound it by the age worked out in SQL here; each choice can be cleared again;
  - the command structure panel is visible, lists rows each with a name and a holder cell naming commanders of the save, and its CSV download holds one record for each entry with every record as wide as its header;
  - the Shipping lines switch adds the shipping lines' fleets and ships to the table and to the download, marked in a column of their own, and taking it off removes them;
  - while the structure is read again (the answer held back) the table shows no row of the earlier model and both downloads are off, and the rows of the new read come when it is answered;
  - a save without the species or the ranks the age and rank filters rest on, with a bound of each stored, still lists the roster of the save as it is, with the age controls off and the rank control not offered (a child of this script serves a copy of the save with FCT_Species and FCT_Ranks dropped).
  Every planted fault is served in place of the page's file and the page is read again: each must fail the checks it names (a hidden Post control, a Post control without choices, a Holder cell that throws, a slot nothing consumes, a structure panel that is not displayed, a structure shown from the model of an earlier read, the age and rank filters applied to a save that lacks their columns). A fault is credited only when every check named for it fails by an assertion of its own, its verdict on what the page showed (scripts/lib/fault-credit.js); a page that could not be driven (an observation that failed in itself, a context that did not close included where a screen was kept), or a check that throws, stops the run (HarnessError, exit status 2) and credits nothing. Variants that say the same thing in another way (a control bound by an explicit value and event, the longhand of an event, a native click listener, components named in PascalCase, a control registered under an alias of the page) are served the same way and must pass every check with the screen they draw equal to the page's.

  Prints `N of N checks passed`; any failed check sets exit code 1. It needs Playwright's Chromium (`bunx playwright install chromium` once). Vite starts with a cold cache of its own on every run, so a run takes minutes.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { runChild, lastJson } = require('./lib/check-pool')
const { observe, validate, failedObservation, failureLine, describe, HarnessError } = require('./lib/browser-observe')
const { caughtAll, notCaught, unobserved } = require('./lib/fault-credit')
const { strictRecords } = require('./lib/csv-records')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const PAGE_FILE = 'src/renderer/pages/commanders.vue'
const SAVE = 'saves/AuroraDB_271_skoormit_saved.db'
const IDS = { GameID: 138, RaceID: 785 }
const NAMES = { game: 'EggSample', race: 'EggSample' }
const TIMEOUT = 120000
const RESULT = 'RESULT '
const YEAR = 31536000
const ROSTER_ROWS = 25
const STORED = { commandersAgeMin: 30, commandersAgeMax: 90, commandersRank: 2 }

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

// ---------- what the save holds, in SQL written here ----------

const openRaw = (file) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(raw)))
})

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

const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

// The post to pick (the item of the control whose post a few serving officers hold) and the age bound to type (one that leaves a few officers; never at a rounding tie), with the names SQL says each leaves.
const picksOf = (truth, postItems) => {
  const counts = new Map()

  truth.serving.forEach((row) => counts.set(row.post, (counts.get(row.post) || 0) + 1))

  const index = postItems.map((item, at) => ({ at, value: item.value, count: counts.get(item.value) || 0 })).filter((item) => item.count >= 2 && item.count <= ROSTER_ROWS).sort((a, b) => b.count - a.count)[0]
  const aged = truth.serving.filter((row) => row.age !== null).sort((a, b) => b.age - a.age)
  const bound = Math.floor(aged[Math.min(9, aged.length - 1)].age) + 0.55
  const left = aged.filter((row) => Math.abs(row.age - bound) > 0.001 && row.age >= bound)

  return {
    post: index ? { index: index.at, names: truth.serving.filter((row) => row.post === index.value).map((row) => row.name) } : null,
    age: { bound, names: left.map((row) => row.name) },
  }
}

// ---------- the page in a browser ----------

// What the page on screen shows; runs in the page. Only hooks the template carries and what the browser reports visible: an element counts when it takes room and no style hides it.
const readScreen = () => {
  const visible = (element) => {
    if (!element) {
      return false
    }

    const box = element.getBoundingClientRect()

    return element.checkVisibility({ checkVisibilityCSS: true }) && box.width > 0 && box.height > 0
  }
  const plain = (text) => text.replace(/\s+/g, ' ').trim()
  // A hook on a Vuetify field lands on its input: the control is the field that holds it.
  const field = (selector) => {
    const element = document.querySelector(selector)

    return element ? element.closest('.v-input') : null
  }
  const control = (selector) => {
    const element = field(selector)

    return element ? { present: true, visible: visible(element), disabled: element.classList.contains('v-input--is-disabled') } : { present: false, visible: false, disabled: false }
  }
  const button = (selector) => {
    const element = document.querySelector(selector)

    return element ? { visible: visible(element), disabled: element.disabled || element.classList.contains('v-btn--disabled') } : { visible: false, disabled: true }
  }
  const items = (selector) => {
    const element = field(selector)

    return element && element.__vue__ ? element.__vue__.items.map((item) => ({ text: item.text, value: item.value })) : []
  }
  const rows = [...document.querySelectorAll('[data-structure-table] tbody tr')].filter(visible).map((row) => {
    const name = row.querySelector('[data-structure-name]')
    const holder = row.querySelector('[data-structure-holder]')

    return { name: name && visible(name) ? plain(name.textContent) : null, holder: holder && visible(holder) ? plain(holder.textContent) : null }
  })

  return {
    post: control('[data-roster-post]'),
    rank: control('[data-roster-rank]'),
    ageMin: control('[data-roster-age-min]'),
    ageMax: control('[data-roster-age-max]'),
    postItems: items('[data-roster-post]'),
    rankItems: items('[data-roster-rank]'),
    ageUnavailable: visible(document.querySelector('[data-age-unavailable]')),
    roster: [...document.querySelectorAll('[data-roster-name]')].filter(visible).map((name) => plain(name.textContent)),
    structurePanel: visible(document.querySelector('[data-structure]')),
    switch: control('[data-structure-shipping-lines]'),
    csv: button('[data-structure-csv]'),
    markdown: button('[data-structure-markdown]'),
    structure: rows,
  }
}

// The page that `observe` (scripts/lib/browser-observe.js) opens, made ready: what the app's settings hold before it starts (`seed`, the stored view of the page), the race picked on the Empires page, the Commanders page opened and settled. `holding` makes the reads of the naval structure wait in `held` until they are let go. The page and console errors are the helper's.
const prepare = async (page, url, seed) => {
  const state = { held: [], holding: false, inFlight: 0, last: Date.now() }
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

  await page.goto(url, { timeout: TIMEOUT })

  const picker = page.locator('.empire-list').first()

  await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    await picker.getByText(NAMES.race, { exact: true }).last().click()
  }

  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
  // The page the race opens is not the one under test, and on a save without species it may never report itself as loaded: only its database calls are waited for.
  while (state.inFlight > 0 || Date.now() - state.last < 1500) {
    await page.waitForTimeout(250)
  }

  await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), '/commanders')
  await page.waitForFunction(pageLoading.arrived, '/commanders', { timeout: TIMEOUT })
  await page.waitForSelector('[data-roster-name]', { state: 'attached', timeout: TIMEOUT }).catch(() => {})
  await settle()

  return { state, settle }
}

// Runs in the page.
const read = (page) => page.evaluate(readScreen)

const nudge = async (page, wait = 600) => {
  await page.evaluate(async () => { await window.$app.$nextTick() })
  await page.waitForTimeout(wait)
}

const downloadOf = async (page, selector) => {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator(selector).click({ timeout: 30000 })])
  const records = strictRecords(fs.readFileSync(await file.path(), 'utf8'))

  return { count: records.length - 1, wide: records.every((record) => record.length === records[0].length), header: records[0], rows: records.slice(1) }
}

const chooseItem = async (page, selector, index) => {
  await page.locator(`.v-input:has(${selector}) .v-select__slot`).click({ timeout: 30000 })
  await page.waitForSelector('.menuable__content__active .v-list-item', { timeout: 30000 })
  await page.locator('.menuable__content__active .v-list-item').nth(index).click({ timeout: 30000 })
  await nudge(page)
}

const clearItem = async (page, selector) => {
  await page.locator(`.v-input:has(${selector}) .v-input__icon--clear button`).click({ timeout: 30000 })
  await nudge(page)
}

// Everything a player does on the page, and what the screen shows after each step: the record of `observe` (scripts/lib/browser-observe.js) whose value is { initial, csvOff, post, postCleared, age, ageCleared, rank, rankCleared, reread, linesOn, csvOn, linesOff }. The page and console errors are in the record, not in the value.
const observePage = (browser, url, truth) => observe(browser, async ({ page, step }) => {
  const began = Date.now()
  const at = (name) => {
    step(name)

    if (process.env.CHECK_TRACE) {
      console.error(`[${Math.round((Date.now() - began) / 1000)} s] ${name}`)
    }
  }

  const { state, settle } = await prepare(page, url, {})
  const seen = { initial: await read(page) }
  const first = seen.initial
  const picks = first.postItems.length ? picksOf(truth, first.postItems) : null

  if (first.structurePanel && first.csv.visible && !first.csv.disabled) {
    at('the structure is downloaded')
    seen.csvOff = await downloadOf(page, '[data-structure-csv]')
  }

  if (picks && picks.post && first.post.visible && !first.post.disabled) {
    at('a post is chosen')
    await chooseItem(page, '[data-roster-post]', picks.post.index)
    seen.post = (await read(page)).roster
    at('the post is cleared')
    await clearItem(page, '[data-roster-post]')
    seen.postCleared = (await read(page)).roster
  }

  if (first.ageMin.visible && !first.ageMin.disabled && picks) {
    at('an age is typed')
    await page.locator('[data-roster-age-min]').fill(String(picks.age.bound), { timeout: 30000 })
    await nudge(page, 900)
    seen.age = (await read(page)).roster
    await page.locator('[data-roster-age-min]').fill('', { timeout: 30000 })
    await nudge(page, 900)
    seen.ageCleared = (await read(page)).roster
  }

  if (first.rank.visible && first.rankItems.length) {
    at('a rank is chosen')
    await chooseItem(page, '[data-roster-rank]', 0)
    seen.rank = (await read(page)).roster
    at('the rank is cleared')
    await clearItem(page, '[data-roster-rank]')
    seen.rankCleared = (await read(page)).roster
  }

  if (first.switch.visible) {
    // A write through the app's connection drops what the cache kept of the table, so the read the switch asks for goes to the database; its answer is held back, then let go.
    at('the shipping lines are turned on while the structure read is held')
    await page.evaluate(() => window.$app.$store.state.database.query('update FCT_NavalAdminCommand set AdminCommandName = AdminCommandName where 1 = 0'))
    state.held.length = 0
    state.holding = true
    await page.locator('.v-input--selection-controls__input:has([data-structure-shipping-lines])').click({ timeout: 30000 })
    await page.waitForTimeout(2500)

    const during = await read(page)

    seen.reread = { held: state.held.length, structure: during.structure, csv: during.csv, markdown: during.markdown }
    state.holding = false

    for (const route of state.held.splice(0)) {
      await route.continue()
    }

    at('the read is answered')
    await settle()
    seen.linesOn = await read(page)

    if (seen.linesOn.csv.visible && !seen.linesOn.csv.disabled) {
      at('the structure with the shipping lines is downloaded')
      seen.csvOn = await downloadOf(page, '[data-structure-csv]')
    }

    at('the shipping lines are turned off')
    await page.locator('.v-input--selection-controls__input:has([data-structure-shipping-lines])').click({ timeout: 30000 })
    await nudge(page, 900)
    await settle()
    seen.linesOff = await read(page)
  }

  return seen
})

// ---------- the checks of one observation ----------

const markedColumn = (table) => table.header.findIndex((_name, at) => table.rows.some((row) => row[at] === 'yes') && table.rows.every((row) => row[at] === 'yes' || row[at] === ''))

// A check's answer: true, or the evidence of what was seen.
const verdict = (ok, evidence) => (ok ? true : short(evidence))

const CHECKS = [
  ['panels', 'the roster and the command structure are on screen', (o) => verdict(o.initial.structurePanel && o.initial.roster.length > 0, [o.initial.structurePanel, o.initial.roster.length])],
  ['post-control', 'the Post control of the roster is visible and can be used', (o) => verdict(o.initial.post.visible && !o.initial.post.disabled, o.initial.post)],
  ['post-choices', 'the Post control offers posts, each with a name, and every post is one a serving naval officer holds', (o, t) => verdict(o.initial.postItems.length >= 2 && o.initial.postItems.every((item) => typeof item.text === 'string' && item.text.trim() !== '' && t.serving.some((row) => row.post === item.value)), o.initial.postItems)],
  ['post-filter', 'choosing a post leaves the officers of that post and clearing the choice brings the roster back', (o, t) => {
    const { post } = picksOf(t, o.initial.postItems)

    return verdict(Boolean(post) && o.post !== undefined && sameList(o.post, post.names) && sameList(o.postCleared, o.initial.roster), { after: o.post && o.post.length, expected: post && post.names.length })
  }],
  ['age-controls', 'the two age controls are visible and can be used', (o) => verdict(o.initial.ageMin.visible && !o.initial.ageMin.disabled && o.initial.ageMax.visible && !o.initial.ageMax.disabled, [o.initial.ageMin, o.initial.ageMax])],
  ['age-filter', 'an age to bound the roster from below leaves the officers of that age or more, and clearing it brings the roster back', (o, t) => {
    const { age } = picksOf(t, o.initial.postItems)

    return verdict(o.age !== undefined && sameList(o.age, age.names) && sameList(o.ageCleared, o.initial.roster), { after: o.age && o.age.length, expected: age.names.length })
  }],
  ['rank-control', 'the Rank control of the roster is visible, offers ranks and narrows the roster', (o) => verdict(o.initial.rank.visible && !o.initial.rank.disabled && o.initial.rankItems.length > 0 && o.rank !== undefined && !sameList(o.rank, o.initial.roster) && o.rank.length > 0 && sameList(o.rankCleared, o.initial.roster), { control: o.initial.rank, items: o.initial.rankItems.length, rows: o.rank && o.rank.length })],
  ['structure-rows', 'every row of the command structure shows a name and a holder cell, and the holders named are commanders of the save', (o, t) => {
    const rows = o.initial.structure

    return verdict(rows.length > 0 && rows.every((row) => row.name !== null && row.holder !== null) && rows.some((row) => row.holder !== '—') && rows.every((row) => row.holder === '—' || [...t.names].some((name) => row.holder.includes(name))), rows.slice(0, 3))
  }],
  ['structure-csv', 'the download of the structure holds one record for each entry, every record as wide as its header, and no shipping line while the switch is off', (o) => {
    const table = o.csvOff

    return verdict(Boolean(table) && table.count >= o.initial.structure.length && table.wide && markedColumn(table) === -1, table && { count: table.count, wide: table.wide })
  }],
  ['shipping-lines', 'the Shipping lines switch adds the shipping lines to the table and to the download, marked in a column of their own, and taking it off removes them', (o) => {
    const { csvOff, csvOn } = o

    if (!o.initial.switch.visible || o.initial.switch.disabled || !csvOff || !csvOn || !o.linesOn || !o.linesOff) {
      return short({ switch: o.initial.switch, off: Boolean(csvOff), on: Boolean(csvOn) })
    }

    const column = markedColumn(csvOn)
    const marked = column === -1 ? 0 : csvOn.rows.filter((row) => row[column] === 'yes').length

    return verdict(column !== -1 && csvOn.wide && csvOn.count > csvOff.count && marked === csvOn.count - csvOff.count && o.linesOn.structure.length > 0 && JSON.stringify(o.linesOff.structure) === JSON.stringify(o.initial.structure), { off: csvOff.count, on: csvOn.count, column })
  }],
  ['structure-reread', 'while the structure is read again for the shipping lines the table shows no row of the earlier read and both downloads are off, and the rows of the shipping lines come when the read is answered', (o) => {
    const { reread } = o

    return verdict(Boolean(reread) && reread.held > 0 && reread.structure.length === 0 && reread.csv.disabled && reread.markdown.disabled && o.linesOn.structure.length > 0 && !o.linesOn.csv.disabled, reread && { held: reread.held, rows: reread.structure.length, csv: reread.csv, markdown: reread.markdown })
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
  { name: 'the structure is read without the shipping lines whatever the switch says', change: swap('RaceID: this.RaceID, shippingLines: this.shippingLines }', 'RaceID: this.RaceID, shippingLines: false }'), fails: ['shipping-lines', 'structure-reread'] },
]

const BENIGN = [
  { name: 'the Post control bound by an explicit value and event', change: swap('<v-select v-model="postFilter" ', '<v-select :value="postFilter" @input="postFilter = $event" ') },
  { name: 'the CSV button listening by the longhand of the event', change: swap('@click="downloadStructure(\'csv\')"', 'v-on:click="downloadStructure(\'csv\')"') },
  { name: 'the Markdown button listening natively', change: swap('@click="downloadStructure(\'markdown\')"', '@click.native="downloadStructure(\'markdown\')"') },
  { name: 'the Rank and age controls named in PascalCase', change: (text) => swap('<v-text-field :value="ageMin"', '<VTextField :value="ageMin"')(swap('<v-select v-model="rankFilter" ', '<VSelect v-model="rankFilter" ')(text)) },
  { name: 'the Post control registered under an alias of the page', change: (text) => swap('<v-select v-model="postFilter" ', '<post-choice v-model="postFilter" ')(swap('components: { LoadState, PageLink, ProvenanceMark, StatTiles },', "components: { LoadState, PageLink, ProvenanceMark, StatTiles, PostChoice: Vue.component('VSelect') },")(swap("import { mapGetters } from 'vuex'", "import Vue from 'vue'\nimport { mapGetters } from 'vuex'")(text))) },
]

// The faults of the filters for a save that lacks their columns: the age bounds and the rank still applied.
const LACKING_FAULTS = [
  { name: 'the age bounds are applied to a save without species', change: swap('ageMin: this.ageAvailable ? this.ageMin : null, ageMax: this.ageAvailable ? this.ageMax : null', 'ageMin: this.ageMin, ageMax: this.ageMax'), fails: ['lacking-roster'] },
  { name: 'the rank is applied to a save without ranks', change: swap('rank: this.rankItems.length ? this.rankFilter : null', 'rank: this.rankFilter'), fails: ['lacking-roster'] },
  { name: 'the age controls stay on for a save without species', change: swap(':disabled="!!focusCommanderId || !ageAvailable" data-roster-age-min', ':disabled="!!focusCommanderId" data-roster-age-min'), fails: ['lacking-controls'] },
]
/* eslint-enable no-template-curly-in-string */

// ---------- the save without species and ranks ----------

const lackingCopy = async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-commanders-lacking-'))
  const file = path.join(folder, 'lacking.db')

  fs.copyFileSync(path.join(root, SAVE), file)

  const raw = await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(file, (error) => (error ? reject(error) : resolve(database)))
  })

  try {
    for (const table of ['FCT_Species', 'FCT_Ranks']) {
      await new Promise((resolve, reject) => raw.run(`drop table ${table}`, (error) => (error ? reject(error) : resolve())))
    }
  } finally {
    await new Promise((resolve) => raw.close(resolve))
  }

  return { folder, file }
}

// The roster of the lacking save with the bounds stored, against the roster of the same save with nothing stored (`known`, the screen of an earlier read, when the caller has it): one record of `observe` for each page, joined into one whose value holds both screens. A record that did not get through is returned as it is.
const observeLacking = async (browser, url, known) => {
  const read1 = (seed) => observe(browser, async ({ page, step }) => {
    step('the page is opened')
    await prepare(page, url, seed)

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
  ['lacking-roster', 'a save without species and ranks with an age range and a rank stored still lists its roster as it lists it with nothing stored', (o) => (o.withBounds.roster.length > 0 && sameList(o.withBounds.roster, o.without.roster)) || short({ stored: o.withBounds.roster.length, plain: o.without.roster.length })],
  ['lacking-controls', 'a save without species has its age controls off and says so, and a save without ranks offers no Rank control', (o) => (o.withBounds.ageMin.disabled && o.withBounds.ageMax.disabled && o.withBounds.ageUnavailable && !o.withBounds.rank.present) || short({ min: o.withBounds.ageMin, max: o.withBounds.ageMax, said: o.withBounds.ageUnavailable, rank: o.withBounds.rank })],
]

const lackingChild = async () => {
  const { startPageServer } = require('./lib/page-server')
  const { folder, file } = await lackingCopy()
  const original = pageText()
  const entries = []
  let server = null
  let chrome = null

  try {
    server = await startPageServer({ save: file })
    chrome = await require('playwright').chromium.launch()

    let known = null

    const run = async (variant) => {
      server.replace(PAGE_FILE, variant ? variant.change(original) : null)

      try {
        const seen = await observeLacking(chrome, server.url, known)

        if (!variant && !unobserved(seen)) {
          known = seen.value.without
        }

        return resultsOf(seen, null, { ids: variant ? variant.fails : null, strict: variant !== null, label: variant ? `the save without species with the fault "${variant.name}"` : 'the save without species', list: LACKING_CHECKS })
      } finally {
        server.replace(PAGE_FILE, null)
      }
    }

    entries.push({ variant: null, results: await run(null) })

    for (const fault of LACKING_FAULTS) {
      entries.push({ variant: fault.name, fails: fault.fails, results: await run(fault) })
    }
  } finally {
    if (chrome) {
      await chrome.close().catch(() => {})
    }

    if (server) {
      await server.stop()
    }

    fs.rmSync(folder, { recursive: true, force: true })
  }

  fs.writeSync(1, `${RESULT}${JSON.stringify(entries)}\n`)
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

// The child that serves the save without species and ranks, its checks and faults reported here.
const checkLacking = async (mutating) => {
  console.log('\nA save without species and ranks (a copy of the save with FCT_Species and FCT_Ranks dropped)')

  const child = await runChild(__filename, ['--lacking'])
  let entries = null

  try {
    entries = lastJson(child, RESULT)
  } catch (error) {
    entries = error
  }

  if (entries instanceof Error) {
    report('the save without species and ranks is read', `does not run: ${entries.message}`)

    return
  }

  for (const entry of entries) {
    if (entry.variant === null) {
      entry.results.forEach(({ name, result }) => report(name, result))
    } else if (mutating) {
      report(`fault caught: ${entry.variant}`, caughtAll(entry.results) ? true : notCaught(entry.results), `fails ${entry.fails.join(', ')}`)
    }
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

const main = async () => {
  if (process.argv.includes('--lacking')) {
    await lackingChild()

    return
  }

  const { startPageServer } = require('./lib/page-server')
  const mutating = !process.argv.includes('--no-mutations')
  const original = pageText()
  const truth = await truthOf(path.join(root, SAVE))
  const cleanups = []
  let outcome = null

  console.log('The Commanders page in a browser (scripts/lib/page-server.js over a copy of a save)')
  await controls(truth)

  try {
    const server = await startPageServer({ save: SAVE })

    cleanups.push(() => server.stop())

    const chrome = await require('playwright').chromium.launch()

    cleanups.push(() => chrome.close())

    const view = async (change) => {
      server.replace(PAGE_FILE, change ? change(original) : null)

      try {
        return await observePage(chrome, server.url, truth)
      } finally {
        server.replace(PAGE_FILE, null)
      }
    }

    const baseline = await view(null)

    if (baseline.error !== null) {
      console.error(describe('the page', baseline))
    }

    resultsOf(baseline, truth, { strict: false, label: 'the page' }).forEach(({ name, result }) => report(name, result))

    if (mutating && !unobserved(baseline)) {
      console.log('\nplanted faults')

      for (const fault of FAULTS) {
        const failed = resultsOf(await view(fault.change), truth, { ids: fault.fails, label: `the page with the fault "${fault.name}"` })

        report(`fault caught: ${fault.name}`, caughtAll(failed) ? true : notCaught(failed), `fails ${fault.fails.join(', ')}`)
      }

      console.log('\nvariants that say the same thing')

      for (const variant of BENIGN) {
        const seen = await view(variant.change)
        const wrong = resultsOf(seen, truth, { label: `the page rewritten as "${variant.name}"` }).filter(({ result }) => result !== true).map(({ id }) => id)
        const same = JSON.stringify(seen.value) === JSON.stringify(baseline.value)

        report(`variant passes: ${variant.name}`, wrong.length === 0 && same ? true : wrong.length ? `fails ${wrong.join(', ')}` : 'the screen it draws is not the page\'s')
      }
    }

    outcome = 'ran'
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch(() => {})
    }
  }

  if (!process.argv.includes('--no-lacking')) {
    await checkLacking(mutating)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(outcome === 'ran' && failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
