/*
  Checks the Yards and Growth views of the Shipyards page: the price and the time of growing a shipyard (src/renderer/utilities/shipyard-growth.js), the task rows the yard read carries (src/renderer/utilities/refits.js `loadYards`), the views themselves (src/renderer/pages/shipyards.vue) and the named links to a yard from the Production Recap, the yard warnings and the Tech Tree.

  bun scripts/check-shipyard-growth.js [--no-mutations]

  The utility is run on yards worked by hand: upgrade prices follow the capacity, slipways and the race's lowest held operations factor, with the commercial/repair discount; continual upgrades are priced on tons added and timed by the Recap's construction-period rule. The script/computed contracts run through page-loader on four independent yards. The actual app also runs in Chromium through page-server and browser-observe: visible titles, prose, view controls, task columns, capacity sort order and player-usable Production/Warnings/Tech Tree links are read with the shared opacity-aware readers. A disposable copy of the real save supplies three yards with low, high and unknown capacities; the owner's saves are never changed. The real persisted-view mixin and an in-memory settings store prove storage keys, scope and validation. Source/template syntax is not mutation credit; only a named check's own marked comparison of an observed value is.

  The loaders run on an in-memory save built in this script, and on the fixture save (scripts/lib/fixtures.js, read-only), whether or not the save is there: a save that is not there is skipped. On a save that holds activities, the stored build points of every yard activity of types 1 to 6 (the slipway and the five capacity steps) are compared with the rules' price; the stored build points of a continual activity are 0, so the continual price has no stored comparison. The fixture holds no activity of types 1 to 6, so the stored comparisons and the totals pinned from two 2.7 saves (64 of 64 equal once the race's operations factor applies, 63 of them at a factor of 1) are printed as needs tier b. No save holds an activity of the 500 or 2,000 ton steps, so those two rest on the pattern of the others.
  A mapped mutation is rejected if a required save fixture is absent; it never drops that mapping. Page faults share one warm browser/server within their child section, and restore every source override before the next variant. Unreachable one-panel summary attributes and malformed-template compiler failures have been replaced with visible prose/title faults; their original classes are explicitly retired in the batch-two catalog ledger, not claimed retained.

  A Light yard (type 4: 1,000 t, five slipways, no tooling) and a task that repeats (NumShips 3) are worked by hand. The Light yard is offered the slipway alone, priced and timed at the full weight of a naval yard; a repeating task's date is its balance plus the whole cost of each later ship over the rate, worked here from the seconds of the game's own date (Population.cs `RefreshShipyardTasksListView`: |TotalBP - CompletedBP| / BuildRate x SecondsPerYear, plus |TotalBP| / BuildRate x SecondsPerYear x (NumShips - 1)) and the class weight of its rate (Shipyard.cs `RecalculateBuildRateForClass`), never from the utility. The fixture's own Light yards are read as they are, and a copy of the fixture in the OS temp directory holds a task of three ships at its naval yard and a task of two ships moved to one of the Light yards; the owner's saves are never changed. The mineral projection of a task of three ships is its ship in hand's alone (MineralData.cs: the ship's minerals times the share of its build points left), so planting the count changes no colony's need.

  Each mutation of the utility, the loader, the page or the other sources must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const Vue = require('vue')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')
const { observe, validate, HarnessError, installScreen, settled } = require('./lib/browser-observe')
const { FIXTURE } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const renderer = path.join(root, 'src', 'renderer')
const FILES = {
  G: path.join(renderer, 'utilities', 'shipyard-growth.js'),
  R: path.join(renderer, 'utilities', 'refits.js'),
  D: path.join(renderer, 'utilities', 'deep-links.js'),
  P: path.join(renderer, 'pages', 'shipyards.vue'),
  PR: path.join(renderer, 'pages', 'production.vue'),
  W: path.join(renderer, 'utilities', 'warnings', 'industry.js'),
  L: path.join(renderer, 'components', 'research', 'LinesView.vue'),
  PV: path.join(renderer, 'components', 'research', 'PathView.vue'),
  PD: path.join(renderer, 'utilities', 'production.js'),
  T: path.join(renderer, 'utilities', 'shipyard-types.js'),
  CM: path.join(renderer, 'utilities', 'colony-minerals.js'),
}
const { G, R, D, P, PR, W, L, PV, PD, T, CM } = Object.fromEntries(Object.keys(FILES).map((key) => [key, key]))
const NAMES = ['shipyard-growth', 'refits', 'production', 'provenance', 'deep-links', 'shipyard-types', 'colony-minerals']
const SAVES = [FIXTURE.file]
// The checks of the saves that a save with no case for them leaves out, by the reason (the fixture holds no stored activity of types 1 to 6): needs tier b. The head prints them and a mutation is not required to fail them.
const NO_CASE = new Map()
const NO_ACTIVITY = 'the fixture holds no stored shipyard activity of types 1 to 6, so the counts and prices pinned from two 2.7 saves have no case in it'
const NO_LIGHT = 'the save holds no light yard, so the slipway-only offer and the full naval weight of a light yard have no case in it'
// The yards of each save that belong to a ship (FCT_Shipyard.ParentShipID above 0), read by hand from the saves: two yards of race 784 in the fixture (24, 25).
const SHIP_BASED_YARDS = { [path.basename(FIXTURE.file)]: [24, 25] }

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
}

// A stand-in for the production-modifiers mixin, which needs the app: the modifiers are the page's data.
const MIXIN_STUB = 'export default { methods: { populationCapacityResult(id, kind) { return { id, kind } } }, asyncComputed: { populationProductionModifiers: { get() { return {} }, default: {} } } }'

// The real persisted-view mixin, for the checks of what the page keeps when it is left and opened again.
const PERSISTED_VIEW_SOURCE = fs.readFileSync(path.join(renderer, 'mixins', 'persisted-view.js'), 'utf8')

// An in-memory stand-in for the settings store: values are kept as text, as the file keeps them, and `reopened` is a restart (another store over what the file holds).
class MemoryConfig {
  constructor(entries = []) {
    this.values = new Map(entries)
  }

  get(key, fallback) {
    return this.values.has(key) ? JSON.parse(this.values.get(key)) : fallback
  }

  set(key, value) {
    this.values.set(key, JSON.stringify(value))
  }

  reopened() {
    return new MemoryConfig([...this.values])
  }
}

const flush = async () => {
  await Vue.nextTick()
  await Vue.nextTick()
}

// The asynchronous computed values a page declares, as the data that holds their defaults.
const asyncDefaults = (options) => {
  const flat = (part) => [...(part.mixins || []).flatMap(flat), part]

  return Object.fromEntries(flat(options).flatMap((part) => Object.entries(part.asyncComputed || {})).map(([name, read]) => [name, typeof read.default === 'function' ? read.default.call({}) : read.default]))
}

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const SHORT_LIMIT = Number(process.env.SHORT_LIMIT) || 300
const DROPPED = new Set(['rule', 'inputs', 'assumptions'])

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))
// Only call these at comparisons of returned, rendered or persisted values.
const same = (actual, expected) => { assert.deepEqual(actual, expected); return true }
const sameNumber = (actual, expected) => { assert.ok(near(actual, expected), `${short(actual)} != ${short(expected)}`); return true }
const sameNumbers = (actual, expected) => { assert.equal(actual.length, expected.length); actual.forEach((value, index) => sameNumber(value, expected[index])); return true }
const finiteAll = (value) => (typeof value === 'number' ? Number.isFinite(value) : Array.isArray(value) ? value.every(finiteAll) : value !== null && typeof value === 'object' ? Object.values(value).every(finiteAll) : true)
const BROWSER_KEYS = new Set(['page-template', 'named-links', 'labels', 'rendered-light', 'rendered-repeat'])
const browserFault = (fault) => fault.fails.some((key) => BROWSER_KEYS.has(key))
const PAGE_TIMEOUT = 60000
let pageSession = null

const closeBrowser = async () => {
  const held = pageSession

  pageSession = null

  if (held) {
    try {
      if (held.browser) await held.browser.close()
    } finally {
      try {
        if (held.server) {
          try {
            for (const file of held.replaced) held.server.replace(file, null)
          } finally {
            await held.server.stop()
          }
        }
      } finally {
        fs.rmSync(held.folder, { recursive: true, force: true })
      }
    }
  }
}

// Three real yards on a disposable copy give the table known low/high and
// unknown capacities. No app value or component is substituted in the browser.
const browserSession = async () => {
  if (pageSession) return pageSession

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-screen-'))
  const file = path.join(folder, 'save.db')
  const held = { folder, browser: null, server: null, current: null, replaced: [] }

  pageSession = held

  try {
    const source = path.join(root, SAVES[0])

    if (!fs.existsSync(source)) throw new HarnessError(`Required rendered-page fixture is absent: ${SAVES[0]}`)
    fs.copyFileSync(source, file)

    const raw = await new Promise((resolve, reject) => {
      const database = new sqlite3.Database(file, (error) => error ? reject(error) : resolve(database))
    })
    const database = { query: rawQuery(raw) }

    try {
      const yards = await rowsOf(database, `select ShipyardID from FCT_Shipyard where GameID = ${FIXTURE.gameId} and RaceID = ${FIXTURE.raceId} order by ShipyardID limit 3`)

      if (yards.length !== 3) throw new HarnessError('The rendered inventory fixture needs three own yards')

      for (const [index, yard] of yards.entries()) {
        await execOf(raw, `update FCT_Shipyard set ShipyardName = 'Growth probe ${['low', 'high', 'unknown'][index]}', Capacity = ${[1000, 2000, 'null'][index]} where ShipyardID = ${yard.ShipyardID}`)
      }

      const [task] = await rowsOf(database, `select t.TaskID, t.UnitName, t.ShipyardID, t.PopulationID, y.ShipyardName from FCT_ShipyardTask t join FCT_Shipyard y on y.ShipyardID = t.ShipyardID where t.GameID = ${FIXTURE.gameId} and t.RaceID = ${FIXTURE.raceId} and t.TaskTypeID = 0 and t.Paused = 0 and (select sum(s.Slipways) from FCT_Shipyard s where s.PopulationID = t.PopulationID) > (select count(*) from FCT_ShipyardTask s where s.PopulationID = t.PopulationID) order by t.TaskID limit 1`)
      const [tech] = await rowsOf(database, `select t.TechSystemID from FCT_TechSystem t join FCT_RaceTech r on r.TechID = t.TechSystemID where r.GameID = ${FIXTURE.gameId} and r.RaceID = ${FIXTURE.raceId} and t.TechTypeID = 30 order by t.TechSystemID limit 1`)
      const obsoleteYards = () => rowsOf(database, `select count(*) as n from FCT_Shipyard y join FCT_ShipClass c on c.ShipClassID = y.BuildClassID where y.GameID = ${FIXTURE.gameId} and y.RaceID = ${FIXTURE.raceId} and c.Obsolete = 1`)

      if (!(await obsoleteYards())[0].n) {
        // The fixture holds no obsolete class on a yard: the class of the first tooled yard is marked obsolete on the disposable copy, as a player would on the Ship Classes page.
        await execOf(raw, `update FCT_ShipClass set Obsolete = 1 where ShipClassID = (select BuildClassID from FCT_Shipyard where GameID = ${FIXTURE.gameId} and RaceID = ${FIXTURE.raceId} and BuildClassID > 0 order by ShipyardID limit 1)`)
      }

      const [obsolete] = await obsoleteYards()

      if (!task || !tech || !obsolete.n) throw new HarnessError('The named-link fixture needs a construction task, idle capacity, an obsolete yard and researched build-rate tech')

      // Yard names repeat across colonies, so the search for the yard of the task would open the first of several: the yard gets a name of its own on the disposable copy.
      task.ShipyardName = 'Growth task probe'
      await execOf(raw, `update FCT_Shipyard set ShipyardName = 'Growth task probe' where ShipyardID = ${task.ShipyardID}`)

      // Two plants on the disposable copy, as a player's own play would make them: the task of the named links makes three ships (the count the game stores for a repeat), and two classes a light yard lists take the sizes of 900 t and 1,100 t (18 and 22 hull spaces).
      const listed = await rowsOf(database, `select c.ShipClassID, c.ClassName from FCT_ShipClass c where c.GameID = ${FIXTURE.gameId} and c.RaceID = ${FIXTURE.raceId} and c.Obsolete = 0 and c.ClassShippingLineID = 0 and c.OtherRaceClassID = 0 and c.Commercial = 0 and not exists (select 1 from FCT_ClassComponent cc join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where cc.ClassID = c.ShipClassID and d.Prototype > 0) order by c.ShipClassID limit 2`)

      if (listed.length !== 2) throw new HarnessError('The light yard fixture needs two classes a light yard lists')

      await execOf(raw, `update FCT_ShipyardTask set NumShips = 3 where TaskID = ${task.TaskID}; update FCT_ShipClass set Size = 18 where ShipClassID = ${listed[0].ShipClassID}; update FCT_ShipClass set Size = 22 where ShipClassID = ${listed[1].ShipClassID}`)
      held.truth = { task, tech, nine: listed[0], eleven: listed[1] }
    } finally {
      await new Promise((resolve, reject) => raw.close((error) => error ? reject(error) : resolve()))
    }

    const { startPageServer } = require('./lib/page-server')
    const { chromium } = require('playwright')

    held.server = await startPageServer({ save: file })
    held.browser = await chromium.launch({ headless: true })
    await held.server.warm(held.browser, { routes: ['/shipyards', '/production', '/warnings', '/technologies'] })

    return held
  } catch (error) {
    await closeBrowser()
    throw error
  }
}

// Runs in Chromium. Hooks select elements; all prose and figures come through
// the shared opacity-aware reader, and destinations are the anchors a player uses.
const readRendered = ({ kind }) => {
  const { visible, visibleText } = window.__screen
  const routes = (node) => [...node.querySelectorAll('a[href]')].filter(visible).map((link) => {
    const href = new URL(link.getAttribute('href'), window.location.href)
    const url = href.hash.startsWith('#/') ? new URL(href.hash.slice(1), href) : href

    return { path: url.pathname, query: Object.fromEntries(url.searchParams) }
  }).filter((link) => link.path === '/shipyards' || link.path === '/production')
  const panels = (root) => [...root.querySelectorAll('.panel')].filter(visible)

  if (kind === 'panels') {
    const root = document.querySelector('.shipyards-page')

    return {
      titles: panels(root).map((panel) => {
        const title = panel.querySelector('.panel-head').firstElementChild

        return visible(title) ? [...title.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim() : ''
      }),
      note: panels(root).map((panel) => visibleText(panel.querySelector('.panel-foot'))).join(' '),
    }
  } else if (kind === 'recap') {
    const root = document.querySelector('.production-page')
    const cards = panels(root)
    const job = cards[0].querySelector('tbody tr')
    const idle = cards.find((card) => visibleText(card.querySelector('.panel-head')).startsWith('Idle capacity by colony'))

    return { job: { text: visibleText(job), links: job ? routes(job) : [] }, idleLinks: routes(idle).filter((link) => link.path === '/shipyards') }
  } else if (kind === 'class-rows') {
    const table = [...document.querySelectorAll('.shipyards-page .v-data-table')].filter(visible).find((node) => [...node.querySelectorAll('thead th')].some((cell) => visibleText(cell).includes('Retool to the class')))

    return { headers: [...table.querySelectorAll('thead th')].map((cell) => visibleText(cell).trim()), rows: [...table.querySelectorAll('tbody > tr')].filter(visible).map((row) => [...row.querySelectorAll('td')].map((cell) => visibleText(cell).replace(/\s+/g, ' ').trim())) }
  } else if (kind === 'warnings') {
    return Object.fromEntries(['idle-slipways', 'obsolete-shipyards'].map((key) => [key, [...document.querySelectorAll(`[data-check="${key}"] tr[data-row]`)].filter(visible).map((row) => ({ id: row.dataset.row, text: visibleText(row), links: routes(row) }))]))
  } else if (kind === 'lines' || kind === 'path') {
    return routes(document.querySelector(`.${kind}-view`))
  }

  throw new Error(`Unknown rendered read ${kind}`)
}

const observeScreen = async (ctx, kind) => {
  const held = await browserSession()

  if (held.current !== ctx) {
    for (const file of held.replaced) held.server.replace(file, null)
    held.replaced = []
    await held.server.reset()

    const real = sourcesOf(null)

    for (const [key, file] of Object.entries(FILES)) {
      if (ctx.sourceText[key] !== real[key]) {
        const relative = path.relative(root, file).replace(/\\/g, '/')

        held.replaced.push(relative)
        held.server.replace(relative, ctx.sourceText[key])
      }
    }

    held.current = ctx
  }

  const seen = await observe(held.browser, async ({ page, step }) => {
    step(`opening the real ${kind} surface`)
    await page.goto(held.server.url, { timeout: PAGE_TIMEOUT })
    await installScreen(page)
    await page.waitForFunction(() => Boolean(window.$app && window.$app.$store && window.$app.$store.getters.database) && window.$app.$store.state.empires.games.length > 0, null, { timeout: PAGE_TIMEOUT })
    await page.evaluate(({ gameId, raceId }) => {
      const store = window.$app.$store
      const game = store.state.empires.games.find((entry) => entry.GameID === gameId)

      return store.dispatch('changeGame', { game, race: game.Races.find((entry) => entry.RaceID === raceId) })
    }, { gameId: FIXTURE.gameId, raceId: FIXTURE.raceId })
    await page.waitForFunction(() => Boolean(window.$app.$store.getters.racePrefix), null, { timeout: PAGE_TIMEOUT })

    const settlePage = () => settled(page, {
      limit: PAGE_TIMEOUT,
      loading: () => {
        const match = window.$app.$route.matched[0]
        const vm = match && match.instances.default

        return !vm || vm.ready === false || Object.values(vm.$asyncComputed || {}).some((state) => state.updating)
      },
    })
    const visit = async (target) => {
      step(`reading ${target}`)
      await page.evaluate((to) => window.$app.$router.push(to, () => {}, () => {}), target)
      await page.waitForFunction((to) => window.$app.$route.path === to, target.split('?')[0], { timeout: PAGE_TIMEOUT })
      await settlePage()
    }
    const read = (what) => page.evaluate(readRendered, { kind: what })

    if (kind === 'yards') {
      await visit('/shipyards')

      const controls = page.locator('.shipyards-page > .row .v-btn-toggle').first()
      const defaultView = await controls.locator('.v-btn--active').evaluate((button) => window.__screen.visibleText(button))
      const views = await controls.locator('button').evaluateAll((buttons) => buttons.map((button) => window.__screen.visibleText(button)))

      await controls.getByRole('button', { name: 'Yards', exact: true }).click()
      await settlePage()

      const yards = await read('panels')
      const search = page.locator('.shipyards-page').getByLabel('Search', { exact: true })

      await search.fill('Growth probe')
      await settlePage()

      const table = page.locator('.shipyards-page .v-data-table').first()
      const headers = await table.locator('thead th').evaluateAll((cells) => cells.map((cell) => window.__screen.visibleText(cell)))

      await table.locator('thead th').filter({ hasText: 'Capacity (t)' }).click()
      await settlePage()

      const sortedNames = await table.locator('tbody > tr').evaluateAll((rows) => rows.map((row) => window.__screen.visibleText(row.querySelector('td:nth-child(2) .font-weight-medium'))))

      await search.fill(held.truth.task.ShipyardName)
      await settlePage()
      await table.locator('.v-data-table__expand-icon').first().click()
      await page.locator('.yard-detail').waitFor()

      const taskHeaders = await page.locator('.yard-detail .v-data-table').first().locator('thead th').evaluateAll((cells) => cells.map((cell) => window.__screen.visibleText(cell)))
      const result = { defaultView: defaultView.trim(), views: views.map((text) => text.trim()), yards, headers, sortedNames, taskHeaders }

      for (const [view, label] of [['growth', 'Growth'], ['refits', 'Refits'], ['classes', 'Class to yards']]) {
        await controls.getByRole('button', { name: label, exact: true }).click()
        await settlePage()
        result[view] = await read('panels')
      }

      return result
    } else if (kind === 'recap') {
      await visit(`/production?colony=${held.truth.task.PopulationID}`)
      await page.locator('.production-page').getByLabel('Search', { exact: true }).fill(held.truth.task.UnitName)
      await settlePage()

      return read('recap')
    } else if (kind === 'nine' || kind === 'eleven') {
      await visit(`/shipyards?view=classes&to=${held.truth[kind].ShipClassID}`)

      return read('class-rows')
    } else if (kind === 'warnings') {
      await visit('/warnings')

      return read('warnings')
    } else if (kind === 'tech') {
      await visit('/technologies?view=lines')

      const toggle = page.locator('.lines-view .v-input--switch')

      if (await toggle.locator('input').isChecked()) {
        await toggle.getByText('Hide finished lines', { exact: true }).click()
        await settlePage()
      }

      const lines = await read('lines')

      await visit(`/technologies?tech=${held.truth.tech.TechSystemID}`)

      return { lines, path: await read('path') }
    }

    throw new HarnessError(`Unknown screen ${kind}`)
  })

  validate(seen, `the ${kind} observation`)

  if (seen.error) throw new HarnessError(`${kind}, ${seen.phase}: ${seen.error}\n${seen.scene || ''}`)

  return seen.value
}

const screenOf = (ctx, kind) => {
  ctx.screens = ctx.screens || {}

  if (!ctx.screens[kind]) ctx.screens[kind] = observeScreen(ctx, kind)

  return ctx.screens[kind]
}

// ---------- the fixtures worked by hand ----------

const MODIFIERS = { ShipyardBuildRate: 1000, ShipyardOperations: 0.8, MinConstructionPeriod: 864000 }

// The days of a task's date by the game's own arithmetic, worked from its seconds: the balance over the build rate of the class (Shipyard.cs `RecalculateBuildRateForClass`: half of one plus the size, a quarter of it for a commercial class, over 100, times the colony's rate), and for a task of more than one ship the whole cost of each later ship over the same rate (Population.cs `RefreshShipyardTasksListView`). The game's year is 31,536,000 s and its day 86,400 s.
const gameDays = ({ total, completed, ships, buildRate, size, commercial = false }) => {
  const rate = buildRate * (1 + ((commercial ? size * 0.25 : size) / 100 - 1) / 2)
  const seconds = (Math.abs(total - completed) / rate) * 31536000 + (ships > 1 ? (Math.abs(total) / rate) * 31536000 * (ships - 1) : 0)

  return seconds / 86400
}

const ZERO_MINERALS = Object.fromEntries(['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite'].map((name) => [name, 0]))
// A class as the eligibility reads it, for the Light yard's cases: 18 hull spaces are 900 t and 22 are 1,100 t.
const classRecord = (id, sizeHS, extra = {}) => ({ id, name: id, sizeHS, cost: 500, commercial: false, obsolete: false, shippingLine: false, otherRace: false, prototype: false, counts: { 1: 4 }, ...extra })
const eligibilityContext = (...classes) => ({ classesById: Object.fromEntries(classes.map((shipClass) => [shipClass.id, shipClass])), components: { 1: { id: 1, name: 'part 1', typeId: 1, cost: 10, minerals: ZERO_MINERALS } }, version: '3.2.0', cache: new Map() })
const HELD = [{ id: 1, name: 'Level 1', multiplier: 1 }, { id: 2, name: 'Level 2', multiplier: 0.8 }]
const version = '2.7.x'

// The yards: A, a naval yard of 4 slipways and 5,000 t with a construction task (class of 2,000 size units, 5,250 BP left) and a refit (10,500 BP left); B, a commercial yard of 2 slipways with a construction task (3,000 BP left) adding 1,000 t (800 BP, 200 done); C, a repair yard with nothing; D, a naval yard of 3 slipways, all working, retooling for class 101 (1,000 BP).
const task = (id, over = {}) => ({ id, taskType: 0, classId: 100, className: 'Alpha class', refitId: null, name: `Unit ${id}`, totalBP: 6000, completedBP: 750, remaining: 5250, hulls: 1, paused: false, size: 2000, commercial: false, targetSize: null, targetCommercial: null, ...over })
const yardA = { id: 1, populationId: 7, colony: 'Alpha', name: 'Yard A', type: 1, slipways: 4, capacity: 5000, tooledId: 100, retoolId: null, taskType: 0, requiredBP: 0, completedBP: 0, paused: false, capacityTarget: 0, tasks: 2, taskRows: [task(11), task(12, { taskType: 2, refitId: 101, remaining: 10500, totalBP: 10500, completedBP: 0, targetSize: 2000, targetCommercial: false })], shipBased: false }
const yardB = { id: 2, populationId: 7, colony: 'Alpha', name: 'Yard B', type: 2, slipways: 2, capacity: 5000, tooledId: null, retoolId: null, taskType: 3, requiredBP: 800, completedBP: 200, paused: false, capacityTarget: 0, tasks: 1, taskRows: [task(21, { remaining: 3000, totalBP: 3000, completedBP: 0, commercial: true })], shipBased: false }
const yardC = { id: 3, populationId: 8, colony: 'Beta', name: 'Yard C', type: 3, slipways: 1, capacity: 1000, tooledId: 100, retoolId: null, taskType: 0, requiredBP: 0, completedBP: 0, paused: false, capacityTarget: 0, tasks: 0, taskRows: [], shipBased: false }
const yardD = { id: 4, populationId: 8, colony: 'Beta', name: 'Yard D', type: 1, slipways: 3, capacity: 5000, tooledId: 100, retoolId: 101, taskType: 7, requiredBP: 1000, completedBP: 0, paused: false, capacityTarget: 0, tasks: 3, taskRows: [task(41), task(42), task(43)], shipBased: false }
// E, a Light yard of 5 slipways and 1,000 t, tooled for no class, with a task of three ships (a class of 18 hull spaces, 250 of 1,000 BP done).
const yardE = { id: 5, populationId: 8, colony: 'Beta', name: 'Yard E', type: 4, slipways: 5, capacity: 1000, tooledId: null, retoolId: null, taskType: 0, requiredBP: 0, completedBP: 0, paused: false, capacityTarget: 0, tasks: 1, taskRows: [task(51, { className: 'Light class', totalBP: 1000, completedBP: 250, remaining: 750, hulls: 3, size: 18 })], shipBased: false }
const YARDS = [yardA, yardB, yardC, yardD]
const CLASSES = [{ id: 100, name: 'Alpha class', obsolete: true }, { id: 101, name: 'Beta class', obsolete: false }]

const fixtures = (m) => {
  const { provenance: p, g } = m
  const operations = g.shipyardOperations(HELD, version)
  const factorOne = p.ofRule({ rule: 'shipyardGrowth.operations', value: 1, inputs: { present: ['the Shipyard Operations levels the race holds'] }, units: '' })
  const none = g.shipyardOperations([], version)
  const price = (yard, over = {}) => g.slipwayPrice({ yard, operations, version, ...over })
  const step = (yard, tons) => g.capacityStepPrice({ yard, step: g.CAPACITY_STEPS.find((candidate) => candidate.tons === tons), operations, version })

  return { operations, factorOne, none, price, step }
}

const pure = (ctx) => {
  const { m } = ctx
  const { g, provenance: p, production } = m
  const f = fixtures(m)
  const { operations, none } = f
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const ruleOf = (result) => (result && result.rule ? result.rule.id : null)
  const missing = (result) => (result && result.inputs ? result.inputs.missing : null)
  const value = p.valueOrNull

  add('rules: the five rules are registered, 2.7.x, with the kind of check each is', () => {
    const expected = { 'shipyardGrowth.operations': 'confirmed', 'shipyardGrowth.slipwayPrice': 'confirmed', 'shipyardGrowth.capacityStep': 'confirmed', 'shipyardGrowth.capacityStepPattern': 'estimated', 'shipyardGrowth.continualPrice': 'estimated' }
    const bad = Object.entries(expected).filter(([id, verification]) => { const rule = p.getRule(id); return !rule || rule.verification !== verification || !rule.versions.includes('2.7.x') || rule.units !== (id === 'shipyardGrowth.operations' ? '' : 'BP') }).map(([id]) => id)

    return same(bad, [])
  })

  // ----- the operations factor -----
  add('operations: the factor is the lowest multiplier of the levels held, a confirmed result of its rule', () => same([value(operations), operations.status, ruleOf(operations)], [0.8, 'confirmed', 'shipyardGrowth.operations']))
  add('operations: the order the levels are held in does not matter', () => same(value(g.shipyardOperations([...HELD].reverse(), version)), 0.8))
  add('operations: a race holding no level, or whose levels were not read, has no factor: unavailable and named, never 1 or 0', () => {
    const noRead = g.shipyardOperations(null, version)

    return same([none.status, value(none), missing(none).length > 0, noRead.status, value(noRead), missing(noRead).length > 0], ['unavailable', null, true, 'unavailable', null, true])
  })
  add('operations: a held level with no multiplier makes the factor unavailable and names the level', () => {
    const open = g.shipyardOperations([...HELD, { id: 3, name: 'Level 3', multiplier: null }], version)

    return same([open.status, value(open), missing(open)], ['unavailable', null, ['the multiplier of Level 3']])
  })
  add('operations: a save version the rule does not cover makes the factor estimated, not confirmed', () => same(g.shipyardOperations(HELD, '9.9').status, 'estimated'))

  // ----- the prices -----
  const naval = { type: 1, capacity: 5000, slipways: 4 }
  const commercial = { type: 2, capacity: 5000, slipways: 4 }
  const repair = { type: 3, capacity: 5000, slipways: 4 }
  const TONS = [500, 1000, 2000, 5000, 10000]

  add('price: a slipway is the capacity over 500 tons times 120 times the operations: 960 BP at a naval yard, a tenth of it at a commercial or repair yard', () => sameNumbers([naval, commercial, repair].map((yard) => value(f.price(yard))), [960, 96, 96]))
  add('price: a slipway follows the yard\'s capacity (1,000 t costs 19.2 BP at a repair yard, 12,000 t 2,304 BP at a naval yard)', () => sameNumbers([value(f.price({ type: 3, capacity: 1000, slipways: 1 })), value(f.price({ type: 1, capacity: 12000, slipways: 1 }))], [19.2, 2304]))
  add('price: the five capacity steps cost the slipways times 120 times the operations times 1, 2, 4, 10 and 20: 384, 768, 1,536, 3,840 and 7,680 BP at a naval yard of 4 slipways', () => sameNumbers(TONS.map((tons) => value(f.step(naval, tons))), [384, 768, 1536, 3840, 7680]))
  add('price: a commercial or repair yard pays a tenth for each step, and a step follows the slipways, not the capacity', () => sameNumbers([...TONS.map((tons) => value(f.step(commercial, tons))), value(f.step({ type: 1, capacity: 99999, slipways: 4 }, 1000)), value(f.step({ type: 1, capacity: 5000, slipways: 1 }, 1000))], [38.4, 76.8, 153.6, 384, 768, 768, 192]))
  add('price: the 500 and 2,000 ton steps are estimated results of the pattern rule, the others and the slipway confirmed', () => {
    const rows = g.upgradePrices({ yard: naval, operations, version })

    return same(rows.map((row) => [row.taskType, ruleOf(row.price), row.price.status]), [[1, 'shipyardGrowth.slipwayPrice', 'confirmed'], [2, 'shipyardGrowth.capacityStepPattern', 'estimated'], [3, 'shipyardGrowth.capacityStep', 'confirmed'], [4, 'shipyardGrowth.capacityStepPattern', 'estimated'], [5, 'shipyardGrowth.capacityStep', 'confirmed'], [6, 'shipyardGrowth.capacityStep', 'confirmed']])
  })
  add('price: a step is labelled with the upgrade of its type and a slipway with the yard\'s type unpriced where the rules do not cover it', () => {
    const rows = g.upgradePrices({ yard: naval, operations, version })

    return same(rows.map((row) => row.label), [1, 2, 3, 4, 5, 6].map((type) => g.SHIPYARD_UPGRADE_TYPES[type]))
  })
  add('price: a yard type the rules do not cover is unavailable and says so; a yard with no type, capacity or slipways names that input', () => {
    const other = f.price({ type: 5, capacity: 5000, slipways: 4 })
    const typeless = f.price({ type: null, capacity: 5000, slipways: 4 })
    const noCapacity = f.price({ type: 1, capacity: null, slipways: 4 })
    const noSlipways = f.step({ type: 1, capacity: 5000, slipways: null }, 1000)

    return same([other.status, missing(other), typeless.status, missing(typeless), noCapacity.status, missing(noCapacity), noSlipways.status, missing(noSlipways), value(other)], ['unavailable', ['the rules for yard type 5'], 'unavailable', ['the yard\'s type'], 'unavailable', ['the yard\'s capacity'], 'unavailable', ['the yard\'s slipways'], null])
  })
  add('price: a price that needs no slipways is not held up by a yard that has none stored, and a step with no capacity stored still prices', () => same([f.price({ type: 1, capacity: 5000, slipways: null }).status, f.step({ type: 1, capacity: null, slipways: 4 }, 1000).status], ['confirmed', 'confirmed']))
  add('price: a yard that belongs to a ship has no price and no time, naming that it cannot be modified, in the slipway, every step and the continual upgrade; a yard whose ship link is not stored names that; a yard of no ship prices as before', () => {
    const shipBased = { ...naval, shipBased: true }
    const unknown = { ...naval, shipBased: null }
    const rows = g.upgradePrices({ yard: shipBased, operations, version })
    const continual = g.continualPrice({ yard: shipBased, target: 15000, operations, version })
    const times = [...rows.map((row) => g.upgradeTime(MODIFIERS, shipBased, row.taskType, row.price).result), g.continualTime(MODIFIERS, shipBased, 15000, continual).result]
    const gaps = g.upgradePrices({ yard: unknown, operations, version }).map((row) => missing(row.price))

    return same([rows.every((row) => row.price.status === 'unavailable' && value(row.price) === null && missing(row.price).includes(g.SHIP_BASED_GAP)), continual.status, missing(continual).includes(g.SHIP_BASED_GAP), times.every((result) => result.status === 'unavailable' && value(result) === null), gaps.every((list) => list.includes('whether the yard belongs to a ship')), value(f.price({ ...naval, shipBased: false }))], [true, 'unavailable', true, true, true, 960])
  })
  add('price: with no operations factor every price is unavailable and carries what the factor lacks, never a price of 0', () => {
    const rows = g.upgradePrices({ yard: naval, operations: none, version })
    const continual = g.continualPrice({ yard: naval, target: 9000, operations: none, version })

    return same([rows.every((row) => row.price.status === 'unavailable' && value(row.price) === null && missing(row.price).includes('a Shipyard Operations level the race holds')), continual.status, missing(continual).includes('a Shipyard Operations level the race holds')], [true, 'unavailable', true])
  })
  add('price: no price of any yard is NaN, infinite or below 0', () => {
    const rows = [naval, commercial, repair, { type: 1, capacity: 0, slipways: 0 }].flatMap((yard) => g.upgradePrices({ yard, operations, version }).map((row) => value(row.price)).filter((item) => item !== null))

    return same([rows.length > 0, finiteAll(rows), rows.every((item) => item >= 0)], [true, true, true])
  })

  // ----- the Light yard -----
  const lightYard = { type: 4, capacity: 1000, slipways: 5 }
  const GROW_GAP = 'a yard whose capacity can grow (a light yard adds slipways only)'

  add('light: a slipway at a light yard of 1,000 t costs the capacity over 500 t times 120 times the operations, at the full weight of a naval yard: 192 BP at 0.8 and 240 BP at 1, a confirmed result of its rule', () => same([value(f.price(lightYard)), value(g.slipwayPrice({ yard: lightYard, operations: f.factorOne, version })), value(f.price({ type: 1, capacity: 1000, slipways: 5 })), f.price(lightYard).status, ruleOf(f.price(lightYard))].map((item) => (typeof item === 'number' ? Math.round(item * 1000) / 1000 : item)), [192, 240, 192, 'confirmed', 'shipyardGrowth.slipwayPrice']))
  add('light: a light yard is offered the slipway alone: its upgrade rows are the slipway, and no capacity step and no continual upgrade is priced, each unavailable and naming a yard whose capacity can grow', () => {
    const rows = g.upgradePrices({ yard: lightYard, operations, version })
    const steps = g.CAPACITY_STEPS.map((step) => g.capacityStepPrice({ yard: lightYard, step, operations, version }))
    const continual = g.continualPrice({ yard: lightYard, target: 6000, operations, version })

    return same([rows.map((row) => row.key), steps.map((result) => [result.status, value(result), missing(result)]), continual.status, value(continual), missing(continual)], [['slipway'], steps.map(() => ['unavailable', null, [GROW_GAP]]), 'unavailable', null, [GROW_GAP]])
  })
  add('light: a naval yard keeps the capacity steps and the continual upgrade a light yard is not offered (the six fixed rows and a continual price of the same capacity)', () => same([g.upgradePrices({ yard: { ...lightYard, type: 1 }, operations, version }).length, g.continualPrice({ yard: { ...lightYard, type: 1 }, target: 6000, operations, version }).status], [6, 'estimated']))
  add('light: the slipway of a light yard is timed at the modification rate of a naval yard of its capacity: 600 BP a year at 1,000 t (510 at a tenth of the capacity), so 192 BP take 116.8 days', () => {
    const time = g.upgradeTime(MODIFIERS, lightYard, 1, f.price(lightYard))

    return sameNumbers([value(g.modificationRate(MODIFIERS, lightYard)), value(time.result)], [600, (192 / 600) * 365])
  })
  add('light: a light yard of 1,000 t lists a class of 900 t with no tooling (capable, listed, a no-retool verdict that holds) and refuses one of 1,100 t, naming the capacity and that it can be neither retooled nor given more capacity', () => {
    const nine = classRecord('Nine', 18)
    const eleven = classRecord('Eleven', 22)
    const yard = { type: 4, capacity: 1000, slipways: 5, tasks: 0, tooledId: null }
    const takes = m.refits.yardEligibility(yard, nine, 'build', eligibilityContext(nine))
    const over = m.refits.yardEligibility(yard, eleven, 'build', eligibilityContext(eleven))

    return same([takes.state, takes.tooling.kind, takes.tooling.check.ok, over.state, over.tooling, over.blockers.some((text) => text.includes('capacity')), over.blockers.some((text) => text.includes('neither retooled nor given more capacity'))], ['capable', 'listed', true, 'ineligible', null, true, true])
  })
  add('light: a light yard needs no retool where a naval yard of the same capacity and no tooled class takes the 900 t class after a retool, and it ignores the class it is said to be tooled for', () => {
    const nine = classRecord('Nine', 18)
    const yard = { type: 4, capacity: 1000, slipways: 5, tasks: 0 }
    const light = [null, 'Gone', undefined].map((tooledId) => m.refits.yardEligibility({ ...yard, tooledId }, nine, 'build', eligibilityContext(nine)))
    const naval = m.refits.yardEligibility({ ...yard, type: 1, tooledId: null }, nine, 'build', eligibilityContext(nine))

    return same([light.map((result) => [result.state, result.tooling.kind]), naval.state, naval.tooling.kind], [[['capable', 'listed'], ['capable', 'listed'], ['capable', 'listed']], 'retool', 'unassigned'])
  })
  add('light: a light yard does not list another race\'s class, an obsolete one, a shipping line\'s or one with prototype components, each ineligible for its own reason', () => {
    const yard = { type: 4, capacity: 1000, slipways: 5, tasks: 0, tooledId: null }
    const verdicts = ['otherRace', 'obsolete', 'shippingLine', 'prototype'].map((flag) => { const shipClass = classRecord('F', 18, { [flag]: true }); return m.refits.yardEligibility(yard, shipClass, 'build', eligibilityContext(shipClass)) })

    return same([verdicts.map((result) => result.state), verdicts[0].blockers.some((text) => text.includes('another race')), verdicts[1].blockers.some((text) => text.includes('obsolete'))], [['ineligible', 'ineligible', 'ineligible', 'ineligible'], true, true])
  })
  add('light: a light yard is busy with every slipway working, and its verdict is decided on the 3.2 line and unknown for a line the rule does not cover', () => {
    const nine = classRecord('Nine', 18)
    const yard = { type: 4, capacity: 1000, slipways: 5, tasks: 0, tooledId: null }
    const at = (over, version) => m.refits.yardEligibility({ ...yard, ...over }, nine, 'build', { ...eligibilityContext(nine), version })

    return same([at({ tasks: 5 }, '3.2.0').state, at({ tasks: 4 }, '3.2.0').state, at({}, '3.2.0').result.assumptions.length, at({}, '3.0.0').state, at({}, '2.7.1').state], ['busy', 'capable', 0, 'unknown', 'capable'])
  })
  add('rules: the finish rule of a shipyard task covers the 3.2 line and names the repeat count it reads, and the yard\'s no-retool and eligibility rules cover both lines', () => same([p.getRule('production.shipFinish').versions, p.getRule('production.shipFinish').structure.some((text) => text.includes('NumShips')), ['refit.noRetool', 'refit.yardEligibility'].map((id) => p.getRule(id).versions)], [['2.7.x', '3.2.x'], true, [['2.7.x', '3.2.x'], ['2.7.x', '3.2.x']]]))

  // ----- the continual upgrade -----
  add('continual: the price is the tons added over 500 times the slipways times 120 times the operations: 7,680 BP for 10,000 t at a naval yard of 4 slipways, a tenth at a commercial yard, an estimated result of its rule', () => {
    const naval7680 = g.continualPrice({ yard: naval, target: 15000, operations, version })
    const commercial768 = g.continualPrice({ yard: commercial, target: 15000, operations, version })

    return same([value(naval7680), naval7680.status, ruleOf(naval7680), near(value(commercial768), 768)], [7680, 'estimated', 'shipyardGrowth.continualPrice', true])
  })
  add('continual: the price per ton is the fixed steps\' (10,000 t costs what the 10,000 ton step does)', () => sameNumber(value(g.continualPrice({ yard: naval, target: 15000, operations, version })), value(f.step(naval, 10000))))
  add('continual: no target, or a target at or below the capacity, is unavailable and names the target', () => {
    const none1 = g.continualPrice({ yard: naval, target: null, operations, version })
    const equal = g.continualPrice({ yard: naval, target: 5000, operations, version })
    const below = g.continualPrice({ yard: naval, target: 100, operations, version })

    return same([none1.status, missing(none1), equal.status, missing(equal), below.status, value(below)], ['unavailable', ['a target capacity'], 'unavailable', ['a target capacity above the yard\'s capacity'], 'unavailable', null])
  })
  add('continual: a target one ton above the capacity takes one construction period (10 days), a result of the Recap\'s stepping rule', () => {
    const target = 5001
    const priced = g.continualPrice({ yard: naval, target, operations, version })
    const time = g.continualTime(MODIFIERS, naval, target, priced)

    return same([value(time.result), time.idle, ruleOf(time.result)], [10, false, 'production.shipyardContinual'])
  })
  add('continual: a farther target takes the Recap\'s days exactly, and more days than the nearer one', () => {
    const target = 15000
    const priced = g.continualPrice({ yard: naval, target, operations, version })
    const time = g.continualTime(MODIFIERS, naval, target, priced)
    const recap = production.shipyardContinualDays(MODIFIERS, { SYType: 1, Capacity: 5000, Slipways: 4, CapacityTarget: target })
    const nearer = g.continualTime(MODIFIERS, naval, 6000, g.continualPrice({ yard: naval, target: 6000, operations, version }))

    assert.ok(value(time.result) > value(nearer.result) && value(nearer.result) > 10, `the days do not grow with the target: ${value(nearer.result)}, ${value(time.result)}`)

    return sameNumber(value(time.result), value(recap.result))
  })
  add('continual: a target that would take more than the most construction periods is refused at once, naming the limit, not stepped', () => {
    const began = Date.now()
    const target = 1e12
    const time = g.continualTime(MODIFIERS, naval, target, g.continualPrice({ yard: naval, target, operations, version }))

    if (Date.now() - began >= 2000) return `${Date.now() - began} ms, ${short(time.result)}`

    return same([time.result.status, missing(time.result).some((text) => text.includes('construction periods'))], ['unavailable', true])
  })
  add('continual: a target of a few hundred periods is timed, not refused', () => {
    const target = 15000
    const time = g.continualTime(MODIFIERS, naval, target, g.continualPrice({ yard: naval, target, operations, version }))

    return same([time.result.status !== 'unavailable', value(time.result) > 100], [true, true])
  })
  add('continual: with no price or no modifiers the time is unavailable and names what is missing', () => {
    const priceless = g.continualTime(MODIFIERS, naval, null, g.continualPrice({ yard: naval, target: null, operations, version }))
    const modifierless = g.continualTime(undefined, naval, 9000, g.continualPrice({ yard: naval, target: 9000, operations, version }))

    return same([priceless.result.status, modifierless.result.status, missing(modifierless.result).length > 0], ['unavailable', 'unavailable', true])
  })

  // ----- the times -----
  add('time: a fixed upgrade takes its price over the yard\'s modification rate (960 BP at 1,000 BP a year: 350.4 days), a result of the Recap\'s activity finish', () => {
    const time = g.upgradeTime(MODIFIERS, naval, 1, f.price(naval))

    return same([value(time.result), time.idle, ruleOf(time.result)], [350.4, false, 'production.shipyardUpgradeFinish'])
  })
  add('time: the modification rate rises with the capacity and a commercial yard\'s is lower (1,000 and 550 BP a year at 5,000 t)', () => sameNumbers([value(g.modificationRate(MODIFIERS, naval)), value(g.modificationRate(MODIFIERS, commercial)), value(g.modificationRate(MODIFIERS, { ...naval, capacity: 10000 }))], [1000, 550, 1500]))
  add('time: an upgrade with no price or no colony modifiers is unavailable and names the input, never a time of 0', () => {
    const priceless = g.upgradeTime(MODIFIERS, naval, 1, none)
    const modifierless = g.upgradeTime(undefined, naval, 1, f.price(naval))

    return same([priceless.result.status, value(priceless.result), modifierless.result.status, missing(modifierless.result).length > 0], ['unavailable', null, 'unavailable', true])
  })
  add('time: a yard\'s own activity takes its build points left over its rate (600 BP at 550 a year: 398.18 days); a retool is shared among the slipways; a paused activity has no time and is idle', () => {
    const upgrade = g.activityFinish(MODIFIERS, yardB)
    const retool = g.activityFinish(MODIFIERS, yardD)
    const paused = g.activityFinish(MODIFIERS, { ...yardB, paused: true })

    return sameNumbers([value(upgrade.result), value(retool.result)], [(600 / 550) * 365, (1000 / 1000) * 365 / 3]) === true && paused.idle === true && value(paused.result) === null ? true : short([upgrade, retool, paused])
  })
  add('time: a continual activity is the Recap\'s stepping rule, a result of production.shipyardContinual', () => {
    const yard = { ...yardA, taskType: 8, capacityTarget: 5001, requiredBP: 0 }

    return same([value(g.activityFinish(MODIFIERS, yard).result), ruleOf(g.activityFinish(MODIFIERS, yard).result)], [10, 'production.shipyardContinual'])
  })
  add('time: a task takes its remaining build points over the colony\'s rate for its class, the quarter weight the class\'s own flag: 5,250 BP at 10,500 a year is 182.5 days for a military class, 3,000 BP at 3,000 a year 365 days for a commercial one', () => {
    const naval1 = g.taskFinish(MODIFIERS, yardA.taskRows[0])
    const commercial1 = g.taskFinish(MODIFIERS, yardB.taskRows[0])

    return sameNumbers([value(naval1.result), value(commercial1.result)], [182.5, 365]) === true && ruleOf(naval1.result) === 'production.shipFinish' ? true : short([naval1, commercial1])
  })
  add('time: a paused task is idle with no time, a task whose pause flag is not stored is unavailable', () => {
    const paused = g.taskFinish(MODIFIERS, { ...yardA.taskRows[0], paused: true })
    const unknown = g.taskFinish(MODIFIERS, { ...yardA.taskRows[0], paused: null })

    return same([paused.idle, value(paused.result), unknown.idle, unknown.result.status], [true, null, false, 'unavailable'])
  })
  add('time: a task of a class with no size, or whose commercial flag is not stored, is unavailable and named', () => {
    const sizeless = g.taskFinish(MODIFIERS, { ...yardA.taskRows[0], size: null })
    const flagless = g.taskFinish(MODIFIERS, { ...yardA.taskRows[0], commercial: null })

    return same([sizeless.result.status, flagless.result.status, missing(sizeless.result).includes('the class\'s size'), missing(flagless.result).includes('the class\'s commercial flag')], ['unavailable', 'unavailable', true, true])
  })

  // ----- a task that repeats -----
  const repeating = yardE.taskRows[0]
  const sixHundred = gameDays({ total: 1000, completed: 250, ships: 3, buildRate: 1000, size: 18 })

  add('time: a task of three ships at a light yard takes its balance and the whole cost of each later ship over the rate, as the game dates it: (750 + 2 x 1,000) BP at 590 BP a year is 1,701.27 days', () => {
    const finish = g.taskFinish(MODIFIERS, repeating)

    return sameNumbers([value(finish.rate), value(finish.result), sixHundred], [590, sixHundred, ((750 + 2 * 1000) / 590) * 365])
  })
  add('time: a later ship counts at the stored task\'s cost, not at its balance, and a task of one ship is dated to the current ship alone (750 BP at 590 a year is 464.07 days); a balance past the cost counts as its size', () => {
    const days = (over, completed = 250, ships = 3) => value(g.taskFinish(MODIFIERS, { ...repeating, ...over }).result) - gameDays({ total: 1000, completed, ships, buildRate: 1000, size: 18 })

    return same([near(days({ hulls: 1 }, 250, 1), 0), near(days({ hulls: 2 }, 250, 2), 0), near(days({ completedBP: 1100, remaining: -100, hulls: 2 }, 1100, 2), 0), near(value(g.taskFinish(MODIFIERS, { ...repeating, hulls: 1 }).result), (750 / 590) * 365)], [true, true, true, true])
  })
  add('time: a task whose count of ships or build points is not stored is unavailable and names it, never the current ship alone; one ship needs no count of build points', () => {
    const unknown = g.taskFinish(MODIFIERS, { ...repeating, hulls: null })
    const cost = g.taskFinish(MODIFIERS, { ...repeating, totalBP: null })
    const single = g.taskFinish(MODIFIERS, { ...repeating, totalBP: null, hulls: 1 })

    return same([unknown.result.status, missing(unknown.result), cost.result.status, missing(cost.result), value(single.result) !== null], ['unavailable', ['the number of ships the task builds'], 'unavailable', ['the task\'s build points'], true])
  })
  add('time: a refit dates by its target class, as the game does (Population.cs RefreshShipyardTasksListView): 2,000 BP left to a class of 40 hull spaces is 1,042.86 days at the target\'s 700 BP a year, where a construction task of the same row would take 1,237.29 at the source class\'s 590', () => {
    const row = task(60, { taskType: 2, refitId: 103, size: 18, commercial: false, targetSize: 40, targetCommercial: false, remaining: 2000, totalBP: 2000, completedBP: 0 })
    const finish = g.taskFinish(MODIFIERS, row)
    const source = g.taskFinish(MODIFIERS, { ...row, taskType: 0, targetSize: null, targetCommercial: null })
    const worked = gameDays({ total: 2000, completed: 0, ships: 1, buildRate: 1000, size: 40 })

    return sameNumbers([value(finish.rate), value(finish.result), worked, value(source.rate), value(source.result)], [700, worked, (2000 / 700) * 365, 590, (2000 / 590) * 365]) === true && value(finish.result) !== value(source.result) ? true : short([finish, source])
  })
  add('time: a refit whose target class is not read is unavailable and names the target\'s size, never dated by its source class', () => {
    const row = task(61, { taskType: 2, refitId: 103, size: 18, commercial: false, targetSize: null, targetCommercial: null, remaining: 2000, totalBP: 2000, completedBP: 0 })
    const finish = g.taskFinish(MODIFIERS, row)

    return same([finish.result.status, missing(finish.result).includes('the class\'s size'), value(finish.result)], ['unavailable', true, null])
  })

  // ----- the labels -----
  add('labels: the task and upgrade labels the Recap and the yards share', () => same([g.SHIPYARD_TASK_TYPES, g.SHIPYARD_UPGRADE_TYPES], [{ 0: 'Construction', 1: 'Repair', 2: 'Refit', 3: 'Scrap', 4: 'Auto refit' }, { 1: 'Add slipway', 2: 'Add 500 ton capacity', 3: 'Add 1,000 ton capacity', 4: 'Add 2,000 ton capacity', 5: 'Add 5,000 ton capacity', 6: 'Add 10,000 ton capacity', 7: 'Retool', 8: 'Continual capacity upgrade', 9: 'Spacemaster modification' }]))
  add('labels: the Recap renders the shared construction task label beside its ship job', async () => {
    const seen = await screenOf(ctx, 'recap')

    return same(seen.job.text.includes('Construction'), true)
  })

  // ----- the Tech Tree lines -----
  add('techtree: the build rate line (Improved Shipbuilding Rate, 30) opens Yards and the Shipyard Operations line (158) opens Growth', () => same([g.SHIPYARD_TECH_VIEWS[30], g.SHIPYARD_TECH_VIEWS[158], g.OPERATIONS_TECH_TYPE, Object.keys(g.SHIPYARD_TECH_VIEWS)], ['yards', 'growth', 158, ['30', '158']]))

  return statements
}

// ---------- the loaders, on an in-memory save that is always there ----------

const rawQuery = (raw) => (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
  const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
  const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

  raw.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve([rows])))
})

const execOf = (raw, sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))

// Race 1 of game 1: yard 1 (naval) with three tasks (a construction of class 10, a refit of class 10 to 11 that is paused and a construction of class 11 whose pause flag is not stored), an activity of 800 BP with 200 done, and yard 2 (repair) with nothing; yard 3 belongs to race 2. The race holds Shipyard Operations levels 1 (1.0) and 2 (0.8) and another tech type; race 2 holds level 3. The task table, the activity columns and the levels come whole or are left out.
const loaderSql = (shape) => `
create table FCT_Population (PopulationID integer, PopName text);
insert into FCT_Population values (7, 'Alpha'), (8, 'Beta');
create table FCT_ShipClass (ShipClassID integer, ClassName text, Size real, Commercial integer);
insert into FCT_ShipClass values (10, 'Ten', 2000, 0), (11, 'Eleven', 3000, 0);
create table FCT_Shipyard (ShipyardID integer, GameID integer, RaceID integer, PopulationID integer, ShipyardName text, SYType integer, Slipways integer, Capacity real, BuildClassID integer, TaskType integer${shape === 'plain' ? '' : ', RetoolClassID integer, RequiredBP real, CompletedBP real, PauseActivity integer, CapacityTarget real, ParentShipID integer'});
${shape === 'plain' ? 'insert into FCT_Shipyard values (1, 1, 1, 7, \'Yard 1\', 1, 4, 5000, 10, 3), (2, 1, 1, 8, \'Yard 2\', 3, 1, 1000, 0, 0), (3, 1, 2, 8, \'Yard 3\', 1, 1, 100, 0, 0);' : 'insert into FCT_Shipyard values (1, 1, 1, 7, \'Yard 1\', 1, 4, 5000, 10, 3, 0, 800, 200, 0, 0, 0), (2, 1, 1, 8, \'Yard 2\', 3, 1, 1000, 0, 0, 0, 0, 0, null, 0, 5), (3, 1, 2, 8, \'Yard 3\', 1, 1, 100, 0, 0, 0, 0, 0, 0, 0, 0);'}
${shape === 'notasks' ? '' : `create table FCT_ShipyardTask (TaskID integer, GameID integer, RaceID integer, ShipyardID integer, TaskTypeID integer, ClassID integer, RefitID integer, UnitName text, TotalBP real, CompletedBP real, Paused integer${shape === 'norepeat' ? '' : ', NumShips integer'});`}
${shape === 'notasks' ? '' : `insert into FCT_ShipyardTask values (101, 1, 1, 1, 0, 10, 0, 'First', 6000, 750, 0${shape === 'norepeat' ? '' : ', 3'}), (102, 1, 1, 1, 2, 10, 11, null, 10500, 500, 1${shape === 'norepeat' ? '' : ', 1'}), (103, 1, 2, 3, 0, 11, 0, 'Other race', 100, 0, 0${shape === 'norepeat' ? '' : ', 1'}), (104, 1, 1, 1, 0, 11, 0, 'Third', 300, 0, null${shape === 'norepeat' ? '' : ', null'});`}
create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer);
insert into FCT_RaceTech values (1, 1, 1), (1, 1, 2), (1, 1, 3), (1, 1, 4), (1, 2, 5), (2, 1, 6);
create table FCT_TechSystem (TechSystemID integer, Name text, TechTypeID integer, AdditionalInfo real);
insert into FCT_TechSystem values (1, 'Operations A', 158, 1.0), (2, 'Operations B', 158, 0.8), (3, 'Operations C', 158, null), (4, 'Build rate', 30, 2.0), (5, 'Operations D', 158, 0.5), (6, 'Operations E', 158, 0.1);
`

const loadedYards = async (m, shape) => {
  const raw = new sqlite3.Database(':memory:')

  try {
    await execOf(raw, loaderSql(shape))

    return { yards: await m.refits.loadYards({ query: rawQuery(raw) }, { GameID: 1, RaceID: 1 }), levels: await m.g.loadShipyardOperations({ query: rawQuery(raw) }, { GameID: 1, RaceID: 1 }) }
  } finally {
    raw.close()
  }
}

const loader = (ctx) => {
  const { m } = ctx
  const statements = []
  const reads = {}
  const read = (shape = 'full') => (reads[shape] = reads[shape] || loadedYards(m, shape))
  const add = (name, test) => statements.push([name, test])

  add('loader: the levels the race holds are its Shipyard Operations techs only (not another type, race or game), cheapest multiplier first, a multiplier the save leaves out as null', async () => same((await read()).levels, [{ id: 3, name: 'Operations C', multiplier: null }, { id: 2, name: 'Operations B', multiplier: 0.8 }, { id: 1, name: 'Operations A', multiplier: 1 }]))
  add('loader: the yards of the race only, each with its tasks as rows: a yard with three tasks has all, a yard with none a real empty list and a count of 0', async () => {
    const { yards } = await read()

    return same([yards.map((yard) => yard.id), yards.map((yard) => yard.tasks), yards.map((yard) => yard.taskRows.length)], [[1, 2], [3, 0], [3, 0]])
  })
  add('loader: a task row carries its type, class, refit target, name, build points, what is left, its pause flag, the count of ships it makes, the class\'s size and flag and its refit target\'s size and flag', async () => {
    const { yards } = await read()

    return same(yards[0].taskRows.map((row) => [row.id, row.taskType, row.classId, row.className, row.refitId, row.name, row.totalBP, row.completedBP, row.remaining, row.paused, row.hulls, row.size, row.commercial, row.targetSize, row.targetCommercial]), [[101, 0, 10, 'Ten', null, 'First', 6000, 750, 5250, false, 3, 2000, false, null, null], [102, 2, 10, 'Ten', 11, null, 10500, 500, 10000, true, 1, 2000, false, 3000, false], [104, 0, 11, 'Eleven', null, 'Third', 300, 0, 300, null, null, 3000, false, null, null]])
  })
  add('loader: a save whose task table has no count of ships gives null for it on every task, never 1', async () => same((await read('norepeat')).yards[0].taskRows.map((row) => row.hulls), [null, null, null]))
  add('loader: the activity is read with the yard: its type, the build points and what is done, the pause flag (0 and 1 as false and true) and the capacity target', async () => {
    const { yards } = await read()

    return same([yards[0].taskType, yards[0].requiredBP, yards[0].completedBP, yards[0].paused, yards[0].capacityTarget, yards[1].paused], [3, 800, 200, false, 0, null])
  })
  add('loader: the rows and the task rows are frozen', async () => {
    const { yards } = await read()

    return Object.isFrozen(yards) && Object.isFrozen(yards[0]) && Object.isFrozen(yards[0].taskRows) && Object.isFrozen(yards[0].taskRows[0]) ? true : 'a row or the list can be changed'
  })
  add('loader: a save with no task table gives no task rows (null, not an empty list) and no count', async () => {
    const { yards } = await read('notasks')

    return same([yards.map((yard) => yard.taskRows), yards.map((yard) => yard.tasks)], [[null, null], [null, null]])
  })
  add('loader: a save whose yards lack the activity columns gives null for each, never 0, and still lists the tasks', async () => {
    const { yards } = await read('plain')

    return same([yards[0].requiredBP, yards[0].completedBP, yards[0].paused, yards[0].capacityTarget, yards[0].taskRows.length, yards[0].taskType], [null, null, null, null, 3, 3])
  })

  return statements
}

// ---------- the page ----------

const page = (ctx) => {
  const { m, pageOptions, persistedOptions } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const make = (data = {}) => instantiate(pageOptions, {
    $store: { getters: {} },
    database: null,
    GameID: 1,
    RaceID: 1,
    data: { yards: YARDS, refitData: { classes: CLASSES, components: {} }, formulaVersion: version, shipyardOperationsHeld: HELD, populationProductionModifiers: { 7: MODIFIERS, 8: MODIFIERS }, shipCounts: {}, refitTasks: [], retoolTasks: [], platformSources: { extras: {}, colonies: {}, researched: null }, setUnsaved(name, value) { this[name] = value }, ...data },
  })
  const rowOf = (vm, id) => vm.inventoryRows.find((row) => row.id === id)
  const value = m.provenance.valueOrNull

  add('page-rows: every own yard is one row, in the order read, the zero-task yard among them', () => same(make().inventoryRows.map((row) => row.id), [1, 2, 3, 4]))
  add('page-rows: a yard\'s tasks are lines with their label, subject and time left as the Recap times them (182.5 and 365 days at yard A; the refit names its target class)', () => {
    const lines = rowOf(make(), 1).taskLines

    return same([lines.map((line) => line.label), lines.map((line) => line.subject), lines.map((line) => line.days)], [['Construction', 'Refit'], ['Alpha class', 'Alpha class to Beta class'], [182.5, 365]])
  })
  add('page-rows: a task line carries the Recap\'s task rate in BP a year (10,500 at the naval yard, a quarter weight at the commercial one) with its result, the shared rate of the class and the yard type', () => {
    const rate = (size, modifier) => m.production.shipRate(MODIFIERS, { Size: size, CommercialModifier: modifier })
    const naval = rowOf(make(), 1).taskLines[0]
    const commercial = rowOf(make(), 2).taskLines[0]

    return same([naval.rate, commercial.rate, naval.rateResult.rule.id, naval.rateResult.status], [value(rate(2000, 1)), value(rate(2000, 0.25)), 'production.shipRate', rate(2000, 1).status]) === true && naval.rate === 10500 && commercial.rate === 3000 ? true : short([naval.rate, commercial.rate])
  })
  add('page-rows: a yard that belongs to a ship stays a row, marked, with no add-slipway price and no price or time in its growth rows; a yard of no ship is not marked', () => {
    const vm = make({ yards: [{ ...yardA, shipBased: true }, yardB] })
    const [ship, plain] = vm.inventoryRows
    const growth = vm.growthOf(vm.yards[0], 15000)

    return same([vm.inventoryRows.length, ship.shipBased, plain.shipBased, ship.slipwayBP, ship.slipwayResult.status, growth.rows.length, growth.rows.every((row) => row.price.status === 'unavailable' && row.days === null)], [2, true, false, null, 'unavailable', 7, true])
  })
  add('page-rows: the free slipways are the slipways less the tasks, as the yard eligibility counts them, and a yard with every slipway working shows 0', () => same(make().inventoryRows.map((row) => [row.freeSlipways, row.slipwaysText]), [[2, '2 of 4'], [1, '1 of 2'], [1, '1 of 1'], [0, '0 of 3']]))
  add('page-rows: a yard\'s own activity is its label, what it is for and its time: an upgrade at yard B, a retool for class 101 at yard D, nothing at A and C', () => {
    const rows = make().inventoryRows

    return same([rows.map((row) => (row.activity ? row.activity.label : null)), rows.map((row) => (row.activity ? row.activity.detail : null)), sameNumbers([rows[1].activity.days, rows[3].activity.days], [(600 / 550) * 365, 365 / 3])], [[null, 'Add 1,000 ton capacity', null, 'Retool'], [null, '25% done', null, 'to Beta class · 0% done'], true])
  })
  add('page-rows: the price to add a slipway is on every row, 960 BP at yard A, 96 at the commercial yard B, 19.2 at the repair yard C', () => {
    const rows = make().inventoryRows

    return sameNumbers(rows.slice(0, 3).map((row) => row.slipwayBP), [960, 96, 19.2])
  })
  add('page-rows: the tooled class is named and its obsolete mark shown; a yard with none tooled says none, a yard whose class is not read is not known', () => {
    const rows = make({ yards: [yardA, yardB, { ...yardC, tooledId: undefined }] }).inventoryRows

    return same([rows[0].tooledName, rows[0].tooled.obsolete, rows[1].tooled, rows[2].tooled], ['Alpha class', true, null, undefined])
  })
  add('page-rows: a yard with no task table shows the tasks as not known, with a result naming what is missing, not as none', () => {
    const row = make({ yards: [{ ...yardA, tasks: null, taskRows: null }] }).inventoryRows[0]

    return same([row.taskCount, row.taskLines, row.slipwaysText, row.taskGap.status, row.slipwaysGap.status], [null, null, '', 'unavailable', 'unavailable'])
  })
  add('page-rows: the free-slipway filter leaves out only the yards with every slipway working, not the yards with no task', () => same(make({ idleOnly: true }).inventoryRows.map((row) => row.id), [1, 2, 3]))
  add('page-rows: the colony filter and the search limit the rows (colony 8 gives yards C and D; "beta" the same; "yard b" one)', () => same([make({ colonyId: 8 }).inventoryRows.map((row) => row.id), make({ yardSearch: 'beta' }).inventoryRows.map((row) => row.id), make({ yardSearch: ' yard b ' }).inventoryRows.map((row) => row.id)], [[3, 4], [3, 4], [2]]))
  add('page-rows: with no yard the list is empty with the hint that the race has none; a colony of no yard has its own hint', () => {
    const none = make({ yards: [] })
    const colony = make({ colonyId: 99 })

    return same([none.inventoryRows.length, none.inventoryHint, colony.inventoryRows.length, colony.inventoryHint], [0, 'The race has no shipyard.', 0, 'The colony named by the link has no shipyard of the race.'])
  })
  add('page-rows: no figure of any row is NaN or infinite', () => (finiteAll(make().inventoryRows.map((row) => [row.slipwayBP, row.freeSlipways, row.activitySort, row.taskLines.map((line) => line.days)])) ? true : 'a figure is NaN or infinite'))
  add('page-rows: a light yard is one row typed Light, tooled for no class, with its free slipways, its slipway priced and a task of three ships shown as "1 of 3 left" and dated to all of them', () => {
    const [row] = make({ yards: [yardE] }).inventoryRows
    const [line] = row.taskLines

    return same([row.type, row.untooled, row.slipwaysText, near(row.slipwayBP, 192), line.hullsText, line.hulls, line.remaining, near(line.days, gameDays({ total: 1000, completed: 250, ships: 3, buildRate: 1000, size: 18 }))], ['Light', true, '4 of 5', true, '1 of 3 left', 3, 750, true])
  })
  add('page-rows: the class\'s flag sets the task\'s rate, not the yard\'s type: a commercial class of 18 hull spaces in the naval yard\'s task takes 3,000 BP at 522.5 a year and a military class in the commercial yard\'s at 590, the figures the yard type alone would swap', () => {
    const row = (commercial) => task(90, { remaining: 3000, totalBP: 3000, completedBP: 0, size: 18, commercial, hulls: 1 })
    const days = (yard, commercial) => make({ yards: [{ ...yard, taskRows: [row(commercial)] }] }).inventoryRows[0].taskLines[0].days

    return sameNumbers([days(yardA, true), days(yardB, false)], [gameDays({ total: 3000, completed: 0, ships: 1, buildRate: 1000, size: 18, commercial: true }), gameDays({ total: 3000, completed: 0, ships: 1, buildRate: 1000, size: 18 })]) === true && days(yardA, true) !== days(yardA, false) ? true : short([days(yardA, true), days(yardB, false)])
  })
  add('page-rows: a task of one ship, or one whose count is not stored, shows no "n of m"', () => same(make({ yards: [yardA, { ...yardE, taskRows: [{ ...yardE.taskRows[0], hulls: null }] }] }).inventoryRows.flatMap((row) => row.taskLines).map((line) => line.hullsText), ['', '', '']))
  add('page-rows: a light yard\'s retool cell for a class it lists says no retool is needed, with no cost', () => {
    const nine = classRecord('Nine', 18)
    const result = m.refits.yardEligibility({ ...yardE, tooledId: null }, nine, 'build', eligibilityContext(nine))
    const cell = make({ yards: [yardE] }).retoolOf(yardE, result, nine, MODIFIERS, '3.2.x')

    return same([result.tooling.kind, cell.state, cell.label, cell.cost], ['listed', 'listed', 'No retool needed', null])
  })
  add('growth: a light yard\'s Growth view prices the slipway alone, with no continual row for a target and the continual target disabled for it, where a naval yard keeps all seven rows', () => {
    const vm = make({ yards: [yardE, yardA], yardId: 5 })
    const rows = vm.growthOf(yardE, 6000).rows

    return same([rows.map((row) => row.key), near(value(rows[0].price), 192), vm.growthLight, vm.growthOf(yardA, 15000).rows.length, make({ yardId: 1 }).growthLight], [['slipway'], true, true, 7, false])
  })

  add('growth: the rows are the slipway, the five steps and the continual upgrade, with the prices and times worked by hand at yard A', () => {
    const growth = make().growthOf(yardA, 15000)
    const recap = m.production.shipyardContinualDays(MODIFIERS, { SYType: 1, Capacity: 5000, Slipways: 4, CapacityTarget: 15000 })

    return same(growth.rows.map((row) => row.key), ['slipway', 'step-500', 'step-1000', 'step-2000', 'step-5000', 'step-10000', 'continual']) === true && sameNumbers(growth.rows.map((row) => value(row.price)), [960, 384, 768, 1536, 3840, 7680, 7680]) === true && sameNumbers(growth.rows.map((row) => row.days), [350.4, 140.16, 280.32, 560.64, 1401.6, 2803.2, value(recap.result)]) === true ? true : short(growth.rows.map((row) => [row.key, value(row.price), row.days]))
  })
  add('growth: only the continual row is approximate, and the rate is the yard\'s modification rate', () => {
    const growth = make().growthOf(yardA, 15000)

    return same([growth.rows.map((row) => row.approx), value(growth.rate)], [[false, false, false, false, false, false, true], 1000])
  })
  add('growth: with no target the continual row is left out, and the longest time is the longest of the rows', () => {
    const growth = make().growthOf(yardA)

    return same([growth.rows.length, near(growth.longest, 2803.2)], [6, true])
  })
  add('growth: the target starts at the capacity and 10,000 t, a target typed replaces it, and a blank, 0, a negative or a non-number is none', () => {
    const vm = make()
    const start = vm.growthTargetFor(yardA)

    vm.setTarget('12000')
    const typed = vm.growthTarget

    const rejected = ['', '  ', '0', '-5', 'abc', null].map((text) => { vm.setTarget(text); return vm.growthTarget })

    return same([start, typed, rejected, vm.growthTargetFor(yardA)], [15000, 12000, [null, null, null, null, null, null], 15000])
  })
  add('growth: the Growth view prices the yard picked, the first yard while none is picked, and says so for a yard the race does not have', () => {
    const picked = make({ yardId: 2 })
    const first = make({ yardId: null })
    const stale = make({ yardId: 99 })

    assert.equal(first.growthYard.id, 1, 'with no pick the Growth panel prices the first yard')

    return same([picked.growthYard.id, first.growthYard.id, stale.growthYard, stale.growth, stale.growthHint, make({ yards: [], yardId: null }).growthHint], [2, 1, null, null, 'The yard named by the link is not one of the race\'s yards.', 'The race has no shipyard.'])
  })
  add('growth: with no operations factor the prices are unavailable and the rows say so, with no time of 0', () => {
    const growth = make({ shipyardOperationsHeld: [] }).growthOf(yardA, 15000)

    return same(growth.rows.map((row) => [row.price.status, row.days]), growth.rows.map(() => ['unavailable', null]))
  })

  add('tiles: the Yards and Growth views\' tiles are the counts of the yards: 4 yards (2 naval, 0 light, 1 commercial, 1 repair), 4 of 10 slipways free, 6 tasks and 2 activities, operations 0.8', () => {
    const tiles = make().yardTiles

    return same([tiles.map((tile) => tile.label), tiles.map((tile) => tile.value), tiles[0].note, tiles[2].note], [['Shipyards', 'Free slipways', 'Work running', 'Shipyard operations'], ['4', '4 of 10', '6 tasks', '0.8'], '2 naval, 0 light, 1 commercial, 1 repair', '2 yard activities (upgrades and retools)'])
  })
  add('tiles: a light yard is counted among the yards by its own type, its slipways among the free ones', () => {
    const tiles = make({ yards: [yardA, yardE] }).yardTiles

    return same([tiles[0].value, tiles[0].note, tiles[1].value], ['2', '1 naval, 1 light, 0 commercial, 0 repair', '6 of 9'])
  })
  add('tiles: the operations tile is a dash with its result unavailable when the race holds no level, and the tiles are the same on the Growth view', () => {
    const tiles = make({ shipyardOperationsHeld: [] }).yardTiles
    const vm = make({ view: 'growth' })

    return same([tiles[3].value, tiles[3].result.status, vm.tiles.map((tile) => tile.label)], ['—', 'unavailable', ['Shipyards', 'Free slipways', 'Work running', 'Shipyard operations']])
  })
  add('tiles: a yard whose slipway or task count is not known is not counted in the free slipways, and the note says how many', () => {
    const tile = make({ yards: [yardA, { ...yardB, tasks: null, taskRows: null }] }).yardTiles[1]

    return same([tile.value, tile.note], ['2 of 4', '1 yard with a slipway or task count not known, not counted'])
  })

  // ----- the link keys -----
  const shape = (vm) => [vm.view, vm.yardId, vm.colonyId, vm.fromId, vm.toId, vm.operation, vm.expanded]
  const apply = (query, data = {}) => { const vm = make(data); vm.applyLink(query); return vm }

  add('links: a yard link opens Yards with the yard picked and opened; a colony alone opens Yards limited to the colony', () => same([shape(apply({ yard: '2' })), shape(apply({ colony: '7' }))], [['yards', 2, null, null, null, 'build', [{ id: 2 }]], ['yards', null, 7, null, null, 'build', []]]))
  add('links: a yard the link names stays in the list under the saved free-slipway filter (a full yard) and the saved search (another yard\'s name), and only that yard; the saved filters are left as they were', () => {
    const full = apply({ yard: '4' }, { idleOnly: true })
    const searched = apply({ yard: '2' }, { yardSearch: 'beta' })
    const other = apply({ yard: '1' }, { idleOnly: true })

    const later = apply({ yard: '4' }, { idleOnly: true })

    later.applyLink({ colony: '8' })

    return same([full.inventoryRows.map((row) => row.id), searched.inventoryRows.map((row) => row.id), other.inventoryRows.map((row) => row.id), [full.idleOnly, searched.yardSearch], make({ idleOnly: true }).inventoryRows.map((row) => row.id), later.inventoryRows.map((row) => row.id)], [[1, 2, 3, 4], [2, 3, 4], [1, 2, 3], [true, 'beta'], [1, 2, 3], [3]])
  })
  add('links: view=growth opens Growth with the yard picked, and keeps the pick when the link names none (a Tech Tree link)', () => same([shape(apply({ view: 'growth', yard: '3' })), shape(apply({ view: 'growth' }, { yardId: 2 }))], [['growth', 3, null, null, null, 'build', [{ id: 3 }]], ['growth', 2, null, null, null, 'build', []]]))
  add('links: a pair opens Refits as it did, and view=classes keeps its operation and class (from only for a refit)', () => same([shape(apply({ from: '100', to: '101' })), shape(apply({ view: 'classes', operation: 'repair', to: '101' })), shape(apply({ view: 'classes', operation: 'bogus', to: '101' }))], [['refits', null, null, 100, 101, 'build', []], ['classes', null, null, null, 101, 'repair', []], ['classes', null, null, null, 101, 'build', []]]))
  add('links: a named view wins over a yard (view=refits with a yard is Refits), a repeated or unknown view is read as the router gives it', () => same([apply({ view: 'refits', yard: '3' }).view, apply({ view: ['growth', 'yards'] }).view, apply({ view: 'nonsense' }).view, apply({ view: 'nonsense', yard: '3' }).view], ['refits', 'growth', 'refits', 'yards']))
  add('links: an id that is not a whole number above 0 is no yard, no colony and no class', () => same(shape(apply({ yard: 'x', colony: '-1', from: '0', to: '1.5' })), ['refits', null, null, null, null, 'build', []]))
  add('links: each view writes its own query and applying it gives the view back with its focus', () => {
    const cases = [{ view: 'yards', yardId: 2, colonyId: 7 }, { view: 'growth', yardId: 3 }, { view: 'refits', fromId: 100, toId: 101 }, { view: 'classes', operation: 'refit', fromId: 100, toId: 101 }]
    const bad = cases.filter((data) => {
      const written = make(data).linkQuery
      const back = apply(m.deepLinks.cleanQuery(written), { yardId: null })
      const again = back.linkQuery

      return m.deepLinks.sameQuery(written, again) !== true || back.view !== data.view
    })

    return same(bad, [])
  })
  add('links: the page is labelled by its focus: the yard of the Yards and Growth views', () => same([make({ view: 'growth', yardId: 2 }).linkLabel, make({ view: 'yards', yardId: 3 }).linkLabel, make({ view: 'yards', yardId: null }).linkLabel], ['Growth of Yard B', 'Yard C', null]))
  add('links: linkTo.shipyards writes the view, yard, colony, operation, from and to, class as the Class to yards view, and nothing for what is left out', () => {
    const { linkTo } = m.deepLinks

    return same([linkTo.shipyards({ yard: 5 }), linkTo.shipyards({ colony: 7 }), linkTo.shipyards({ view: 'growth' }), linkTo.shipyards({ from: 1, to: 2 }), linkTo.shipyards({ class: 9 }), linkTo.shipyards({ class: 9, operation: 'repair' }), linkTo.shipyards({ view: 'classes', operation: 'refit', from: 1, to: 2 }), linkTo.shipyards()], [{ path: '/shipyards', query: { yard: '5' } }, { path: '/shipyards', query: { colony: '7' } }, { path: '/shipyards', query: { view: 'growth' } }, { path: '/shipyards', query: { from: '1', to: '2' } }, { path: '/shipyards', query: { view: 'classes', to: '9' } }, { path: '/shipyards', query: { view: 'classes', operation: 'repair', to: '9' } }, { path: '/shipyards', query: { view: 'classes', operation: 'refit', from: '1', to: '2' } }, { path: '/shipyards', query: {} }])
  })

  // These comparisons read the real renderer, not the spelling of its template.
  add('page-template: Yards opens by default and the four view controls are in order', async () => {
    const seen = await screenOf(ctx, 'yards')

    return same([seen.defaultView, seen.views], ['Yards', ['Yards', 'Growth', 'Refits', 'Class to yards']])
  })
  add('page-template: the Yards panel has its own visible title without a figure', async () => {
    const seen = await screenOf(ctx, 'yards')

    return same(seen.yards.titles[0], 'Shipyards')
  })
  add('page-template: Growth has its visible title and an impersonal note that gives the commercial price factor', async () => {
    const seen = await screenOf(ctx, 'yards')

    return same([seen.growth.titles[0], /\b(I|me|my|mine|you|your|we|our)\b/i.test(seen.growth.note), seen.growth.note.includes('A commercial or repair yard pays a tenth.')], ['Yard growth', false, true])
  })
  add('page-template: the eligibility panel is absent from Yards and Growth and shown for Refits and Class to yards', async () => {
    const seen = await screenOf(ctx, 'yards')

    return same([seen.yards.titles.length, seen.growth.titles.length, seen.refits.titles.some((title) => title.startsWith('Yards for')), seen.classes.titles.some((title) => title.startsWith('Yards for'))], [1, 1, true, true])
  })
  add('page-template: the inventory draws its columns and sorts the unknown capacity after both known capacities', async () => {
    const seen = await screenOf(ctx, 'yards')

    return same([seen.headers, seen.sortedNames], [['', 'Yard', 'Type', 'Free slipways', 'Capacity (t)', 'Tooled for', 'Tasks', 'Activity', 'Add slipway'], ['Growth probe low', 'Growth probe high', 'Growth probe unknown']])
  })
  add('page-template: an expanded task draws the Rate (BP/yr) column', async () => {
    const seen = await screenOf(ctx, 'yards')

    return same(seen.taskHeaders, ['Task', 'Subject', 'Left (BP)', 'Rate (BP/yr)', 'Time left'])
  })
  add('page-persist: the yard pick is stored for its race and the inventory sort under its own app key', async () => {
    const mounted = mountPersisted()

    mounted.vm.yardId = 2
    mounted.vm.yardsList = { ...mounted.vm.yardsList, sortBy: ['capacity'], sortDesc: [true] }
    await flush()

    const saved = [mounted.config.get(`${KEY}.shipyardsYard`, null), mounted.config.get('shipyardsYardsList', null)]

    mounted.store.getters.racePrefix = OTHER
    mounted.store.getters.RaceID = 2
    await flush()

    const otherYard = mounted.vm.yardId

    mounted.vm.$destroy()

    return same([saved[0], saved[1] && saved[1].sortBy, saved[1] && saved[1].sortDesc, otherYard], [2, ['capacity'], [true], null])
  })
  add('page-persist: invalid stored yard and class IDs and a nonpositive target restore as none', async () => {
    const config = new MemoryConfig()

    for (const [key, value] of [['shipyardsYard', -1], ['shipyardsFromClass', -2], ['shipyardsToClass', 0], ['shipyardsGrowthTarget', -3]]) {
      config.set(`${KEY}.${key}`, value)
    }

    const mounted = mountPersisted({ config })
    const restored = [mounted.vm.yardId, mounted.vm.fromId, mounted.vm.toId, mounted.vm.growthTarget]

    mounted.vm.$destroy()

    return same(restored, [null, null, null, null])
  })

  // ----- the class picks of Refits and Class to yards, over the real persisted-view mixin and an in-memory settings store -----
  const KEY = 'campaign.c1.race.1'
  const OTHER = 'campaign.c1.race.2'
  const THREE = [...CLASSES, { id: 102, name: 'Gamma class', obsolete: false }]
  const mountPersisted = ({ config = new MemoryConfig(), prefix = KEY } = {}) => {
    const store = Vue.observable({ getters: { racePrefix: prefix, config, database: null, GameID: 1, RaceID: 1 }, state: {} })
    const vm = new Vue({
      mixins: [persistedOptions],
      data: () => ({ ...asyncDefaults(persistedOptions), refitData: { classes: [], components: {} } }),
      beforeCreate() {
        this.$store = store
      },
    })

    return { vm, store, config }
  }
  const readClasses = async (mounted, classes = CLASSES) => {
    mounted.vm.refitData = { classes, components: {} }
    await flush()

    return mounted
  }
  // A page left with its picks made: `change` sets them, and the settings are what the store then holds.
  const left = async (change, { prefix = KEY, config = new MemoryConfig() } = {}) => {
    const mounted = mountPersisted({ config, prefix })

    change(mounted.vm)
    await flush()
    mounted.vm.$destroy()

    return config
  }
  const picks = (vm) => [vm.fromId, vm.toId]
  const storedPicks = (config, prefix = KEY) => [config.get(`${prefix}.shipyardsFromClass`, 'none'), config.get(`${prefix}.shipyardsToClass`, 'none')]

  add('page-persist: the Refits picks come back when the page is opened again (through its tab, or after a restart) and are the race\'s classes', async () => {
    const config = await left((vm) => { vm.view = 'refits'; vm.fromId = 100; vm.toId = 101 })
    const reopened = await readClasses(mountPersisted({ config }))
    const restarted = await readClasses(mountPersisted({ config: config.reopened() }))

    return same([[reopened.vm.view, ...picks(reopened.vm)], [restarted.vm.view, ...picks(restarted.vm)], reopened.vm.pair && [reopened.vm.pair.from.name, reopened.vm.pair.to.name]], [['refits', 100, 101], ['refits', 100, 101], ['Alpha class', 'Beta class']])
  })
  add('page-persist: the Class to yards picks come back when the page is opened again (through its tab, or after a restart)', async () => {
    const config = await left((vm) => { vm.view = 'classes'; vm.operation = 'refit'; vm.fromId = 100; vm.toId = 101 })
    const reopened = await readClasses(mountPersisted({ config }))
    const restarted = await readClasses(mountPersisted({ config: config.reopened() }))
    const shown = (mounted) => [mounted.vm.view, mounted.vm.operation, ...picks(mounted.vm), mounted.vm.linkQuery]
    const expected = ['classes', 'refit', 100, 101, { view: 'classes', operation: 'refit', from: 100, to: 101 }]

    return same([shown(reopened), shown(restarted)], [expected, expected])
  })
  add('page-persist: a cleared pick is kept cleared, and a page never picked on opens with none', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 101 })
    const cleared = await left((vm) => { vm.fromId = null }, { config })
    const reopened = await readClasses(mountPersisted({ config: cleared }))
    const fresh = await readClasses(mountPersisted())

    return same([picks(reopened.vm), picks(fresh.vm)], [[null, 101], [null, null]])
  })
  add('page-persist: the picks are the race\'s: another race opens with its own and the first race gets its own back', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 101 })

    await left((vm) => { vm.fromId = 101; vm.toId = 100 }, { prefix: OTHER, config })

    const mounted = await readClasses(mountPersisted({ config }))
    const first = picks(mounted.vm)

    mounted.store.getters.racePrefix = OTHER
    mounted.store.getters.RaceID = 2
    await flush()

    const other = picks(mounted.vm)

    mounted.store.getters.racePrefix = KEY
    mounted.store.getters.RaceID = 1
    await flush()

    return same([first, other, picks(mounted.vm), storedPicks(config), storedPicks(config, OTHER)], [[100, 101], [101, 100], [100, 101], [100, 101], [101, 100]])
  })
  add('page-persist: a pick that is not one of the race\'s classes is dropped once the classes are read (and saved as none), and is kept while no class is read yet', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 999 })
    const mounted = mountPersisted({ config })
    const before = picks(mounted.vm)

    await readClasses(mounted)

    return same([before, picks(mounted.vm), storedPicks(config)], [[100, 999], [100, null], [100, null]])
  })
  add('page-persist: the classes of a link win for the visit, are not saved, and a link\'s class the race does not have stays to be named; a pick made after it is saved', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 101 })
    const mounted = mountPersisted({ config })

    mounted.vm.applyLink({ from: '555', to: '100' })
    await readClasses(mounted, THREE)

    const visit = [mounted.vm.view, ...picks(mounted.vm), mounted.vm.pairHint, ...storedPicks(config)]

    mounted.vm.fromId = 102
    await flush()

    return same([visit, storedPicks(config)], [['refits', 555, 100, 'A class named by the link is not one of the race\'s classes.', 100, 101], [102, 101]])
  })
  add('page-persist: a link to Yards or Growth, or one that names no class, leaves the picks as they were', async () => {
    const config = await left((vm) => { vm.fromId = 100; vm.toId = 101 })
    const mounted = await readClasses(mountPersisted({ config }))
    const after = (query) => {
      mounted.vm.applyLink(query)

      return [mounted.vm.view, ...picks(mounted.vm)]
    }

    const yards = after({ yard: '2' })
    const growth = after({ view: 'growth', yard: '3' })
    const classes = after({ view: 'classes', operation: 'repair', to: '100' })

    await flush()

    return same([yards, growth, classes, storedPicks(config)], [['yards', 100, 101], ['growth', 100, 101], ['classes', null, 100], [100, 101]])
  })

  return statements
}

// ---------- the named links from the other pages ----------

const links = (ctx) => [
  ['named-links: the rendered Production ship job links to its yard and its idle capacity links to the colony yards', async () => {
    const seen = await screenOf(ctx, 'recap')
    const { task } = (await browserSession()).truth

    return same([seen.job.links, seen.idleLinks], [[{ path: '/shipyards', query: { yard: String(task.ShipyardID) } }], [{ path: '/shipyards', query: { colony: String(task.PopulationID) } }]])
  }],
  ['named-links: the rendered idle and obsolete warnings link to their own yards', async () => {
    const seen = await screenOf(ctx, 'warnings')

    for (const key of ['idle-slipways', 'obsolete-shipyards']) {
      assert.ok(seen[key].length > 0, `${key} draws a warning row`)
      seen[key].forEach((row) => assert.deepEqual(row.links, [{ path: '/shipyards', query: { yard: row.id.split(':')[1] } }], `${key} ${row.id}`))
    }

    return true
  }],
  ['named-links: the rendered Tech Tree lines and build-rate path link to the appropriate Shipyards view', async () => {
    const seen = await screenOf(ctx, 'tech')

    return same([seen.lines.map((link) => link.query.view).sort(), seen.path], [['growth', 'yards'], [{ path: '/shipyards', query: { view: 'yards' } }]])
  }],
  ['rendered-light: the rendered Classes view shows each light yard of the fixture as type Light, with its five free slipways, 1,000 t and no tooling, the 900 t class it lists with no retool and the 1,100 t class it cannot take, neither retooled nor given more capacity', async () => {
    for (const [kind, taken] of [['nine', true], ['eleven', false]]) {
      const seen = await screenOf(ctx, kind)
      const lights = seen.rows.filter((cells) => cells[1] === 'Light')

      assert.equal(lights.length, 4, `${kind}: the four light yards of the fixture draw a row`)

      lights.forEach((cells) => {
        assert.deepEqual([cells[2], cells[3].replace(/\D/g, ''), cells[4]], ['5 of 5', '1000', 'Not needed'], `${kind} ${cells[0]}`)

        if (taken) {
          assert.ok(cells[5].includes('Can take it') && cells[6].includes('No retool needed'), `${kind} ${cells[0]}: ${cells[5]} / ${cells[6]}`)
        } else {
          assert.ok(cells[5].includes('Cannot') && cells[5].includes('neither retooled nor given more capacity'), `${kind} ${cells[0]}: ${cells[5]}`)
        }
      })
    }

    return true
  }],
  ['rendered-repeat: the rendered Production ship job of a task of three ships reads "1 of 3 ships left"', async () => {
    const seen = await screenOf(ctx, 'recap')

    return same(seen.job.text.includes('1 of 3 ships left'), true)
  }],
]

// ---------- the saves ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)
    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve({ file: path.basename(resolved), query: rawQuery(raw), close: () => raw.close() })))
})

// A disposable copy of the fixture with `plantSql` applied, handed to `use` as a read handle: the copy lives in the OS temp directory and its folder is removed after, the same way as the browser copy (the owner's saves are never changed).
const withPlanted = async (file, plantSql, use) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-repeat-'))
  const copy = path.join(folder, 'save.db')

  fs.copyFileSync(path.resolve(root, file), copy)

  const raw = await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(copy, (error) => (error ? reject(error) : resolve(database)))
  })

  try {
    await execOf(raw, plantSql)

    return await use({ query: rawQuery(raw) })
  } finally {
    await new Promise((resolve) => raw.close(() => resolve()))
    fs.rmSync(folder, { recursive: true, force: true })
  }
}

const rowsOf = async (database, sql, replacements = {}) => (await database.query(sql, { replacements }))[0]

// Every stored activity of types 1 to 6 of a save with the price the rules give at the race's own operations factor and at a factor of 1.
const activitiesOf = async (ctx, database) => {
  const { g, provenance: p } = ctx.m
  const rows = await rowsOf(database, 'select ShipyardID, GameID, RaceID, SYType, Slipways, Capacity, TaskType, RequiredBP from FCT_Shipyard where TaskType between 1 and 6 order by ShipyardID')
  const factorOne = p.ofRule({ rule: 'shipyardGrowth.operations', value: 1, inputs: { present: ['the levels'] }, units: '' })
  const held = {}
  const priced = []

  for (const row of rows) {
    const key = `${row.GameID}/${row.RaceID}`

    held[key] = held[key] || g.shipyardOperations(await g.loadShipyardOperations(database, { GameID: row.GameID, RaceID: row.RaceID }), '2.7.x')

    const yard = { type: row.SYType, capacity: row.Capacity, slipways: row.Slipways }
    const priceAt = (operations) => (row.TaskType === g.SLIPWAY_ACTIVITY ? g.slipwayPrice({ yard, operations, version: '2.7.x' }) : g.capacityStepPrice({ yard, step: g.CAPACITY_STEPS.find((step) => step.taskType === row.TaskType), operations, version: '2.7.x' }))

    priced.push({ ...row, held: p.valueOrNull(held[key]), expected: p.valueOrNull(priceAt(held[key])), atOne: p.valueOrNull(priceAt(factorOne)) })
  }

  return priced
}

const saveStatements = async (ctx, file) => {
  const database = await openSave(file)

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const { m } = ctx
  const label = path.basename(file)
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const activities = await activitiesOf(ctx, database)
  const races = await rowsOf(database, 'select distinct GameID, RaceID from FCT_Shipyard')
  const equal = (row, figure) => near(row.RequiredBP, figure)

  if (activities.length === 0) {
    NO_CASE.set('save-stored', NO_ACTIVITY)
  } else {
    add(`save-stored: ${label}: every stored activity of types 1 to 6 has the build points the rules give once the race's operations factor applies`, () => {
      const bad = activities.filter((row) => !equal(row, row.expected))

      return same(bad.map((row) => [row.ShipyardID, row.TaskType, row.RequiredBP, row.expected]), [])
    })
    add(`save-stored: ${label}: the activities that differ at a factor of 1 are those of a race that holds a better level, and only then`, () => {
      const bad = activities.filter((row) => !equal(row, row.atOne) && !(row.held < 1 && equal(row, row.expected)))

      return same(bad.map((row) => [row.ShipyardID, row.TaskType, row.RequiredBP, row.atOne]), [])
    })
  }

  add(`save-operations: ${label}: the race's stored operations column is the lowest multiplier among the levels it holds`, async () => {
    const bad = []

    for (const { GameID, RaceID } of races) {
      const held = m.g.shipyardOperations(await m.g.loadShipyardOperations(database, { GameID, RaceID }), '2.7.x')
      const [race] = await rowsOf(database, 'select ShipyardOperations from FCT_Race where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })

      if (held.status !== 'unavailable' && race && race.ShipyardOperations !== null && !near(race.ShipyardOperations, held.value)) {
        bad.push([GameID, RaceID, race.ShipyardOperations, held.value])
      }
    }

    return same(bad, [])
  })
  add(`save-continual: ${label}: a stored continual activity (type 8) stores no build points, so the continual price has no stored comparison`, async () => {
    const rows = await rowsOf(database, 'select ShipyardID, RequiredBP from FCT_Shipyard where TaskType = 8')
    const bad = rows.filter((row) => row.RequiredBP !== 0 && row.RequiredBP !== null)

    return same(bad, [])
  })
  add(`save-yards: ${label}: every yard of every race is read once with a task count that is the number of its task rows, and the tasks of the race are the stored ones`, async () => {
    const bad = []

    for (const { GameID, RaceID } of races) {
      const yards = await m.refits.loadYards(database, { GameID, RaceID })
      const [{ n: yardCount }] = await rowsOf(database, 'select count(*) as n from FCT_Shipyard where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })
      const [{ n: taskCount }] = await rowsOf(database, 'select count(*) as n from FCT_ShipyardTask where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })

      if (yards.length !== yardCount || yards.some((yard) => yard.tasks !== yard.taskRows.length)) {
        bad.push([GameID, RaceID])
      }

      if (yards.reduce((total, yard) => total + yard.taskRows.length, 0) > taskCount) {
        bad.push([GameID, RaceID, 'more tasks than stored'])
      }
    }

    return same(bad, [])
  })
  add(`save-ship-based: ${label}: the yards that belong to a ship are read as such and every price and time of each is unavailable and names why, while the yard stays a row`, async () => {
    const bad = []
    const found = []

    for (const { GameID, RaceID } of races) {
      const yards = await m.refits.loadYards(database, { GameID, RaceID })
      const operations = m.g.shipyardOperations(await m.g.loadShipyardOperations(database, { GameID, RaceID }), '2.7.x')

      yards.filter((yard) => yard.shipBased === true).forEach((yard) => {
        const target = yard.capacity + 5000
        const rows = m.g.upgradePrices({ yard, operations, version: '2.7.x' })
        const continual = m.g.continualPrice({ yard, target, operations, version: '2.7.x' })
        const prices = [...rows.map((row) => row.price), continual]
        const times = [...rows.map((row) => m.g.upgradeTime(MODIFIERS, yard, row.taskType, row.price).result), m.g.continualTime(MODIFIERS, yard, target, continual).result]

        found.push(yard.id)

        if (![...prices, ...times].every((result) => result.status === 'unavailable' && m.provenance.valueOrNull(result) === null) || !prices.every((price) => price.inputs.missing.includes(m.g.SHIP_BASED_GAP))) {
          bad.push(yard.id)
        }
      })
    }

    same(bad, [])

    return same(found.sort((a, b) => a - b), SHIP_BASED_YARDS[label])
  })
  const compareTasks = async (wanted, least) => {
    const { g, production: pr, provenance: p } = m
    const bad = []
    let compared = 0

    for (const { GameID, RaceID } of races) {
      const yards = await m.refits.loadYards(database, { GameID, RaceID })
      // The class the game dates a task by: a refit's target, the class it builds otherwise (Population.cs RefreshShipyardTasksListView turns to gclass22_1 for a refit and gclass22_0 for a build). Its size and `Commercial` flag are read from the save here, not through the utility's loader, and the rate is worked from the game's arithmetic.
      const recap = await rowsOf(database, 'select t.TaskID as ID, t.TaskTypeID, t.TotalBP, t.NumShips as Hulls, t.TotalBP - t.CompletedBP as RemainingProduction, t.Paused, bc.Size as BuildSize, bc.Commercial as BuildCommercial, rc.Size as TargetSize, rc.Commercial as TargetCommercial from FCT_ShipyardTask t left join FCT_ShipClass bc on bc.ShipClassID = t.ClassID left join FCT_ShipClass rc on rc.ShipClassID = t.RefitID where t.GameID = :GameID and t.RaceID = :RaceID', { GameID, RaceID })
      const byId = Object.fromEntries(recap.map((row) => [row.ID, row]))
      const rateOf = (row) => {
        const refit = [2, 4].includes(row.TaskTypeID)
        const size = refit ? row.TargetSize : row.BuildSize
        const commercial = refit ? row.TargetCommercial : row.BuildCommercial

        return MODIFIERS.ShipyardBuildRate * (1 + ((commercial === 1 ? size * 0.25 : size) / 100 - 1) / 2)
      }

      yards.forEach((yard) => yard.taskRows.filter((row) => wanted(byId[row.id])).forEach((row) => {
        const expected = byId[row.id]
        const rate = p.ofRule({ rule: 'production.shipRate', value: rateOf(expected), inputs: { present: ['the class\'s size and commercial flag'] }, units: 'BP/yr' })
        const finish = pr.finishDays({ rule: 'production.shipFinish', rate, remaining: expected.RemainingProduction + (expected.Hulls > 1 ? (expected.Hulls - 1) * Math.abs(expected.TotalBP) : 0), remainingName: 'the task\'s remaining build points', paused: pr.flagOf(expected.Paused) })
        const actual = g.taskFinish(MODIFIERS, row)

        compared++

        if (p.valueOrNull(actual.result) !== p.valueOrNull(finish.result) || actual.idle !== finish.idle || p.valueOrNull(actual.rate) !== p.valueOrNull(rate)) {
          bad.push([row.id, p.valueOrNull(actual.result), p.valueOrNull(finish.result)])
        }
      }))
    }

    return same([bad, compared >= least], [[], true])
  }

  add(`save-tasks: ${label}: the time left of every stored task is the Production Recap's, the build points left over the colony's rate for the class (a refit's target, with the quarter weight of a commercial class)`, () => compareTasks(() => true, 0))

  add(`save-flag: ${label}: a refit task whose target class is commercial sits at a naval yard and is dated at a quarter of the target's size, as the class's flag gives it, not at the full size the yard's type would give`, async () => {
    const plant = `update FCT_ShipyardTask set TaskTypeID = 2, RefitID = (select min(ShipClassID) from FCT_ShipClass where GameID = ${FIXTURE.gameId} and RaceID = ${FIXTURE.raceId}) where TaskID = 1; update FCT_ShipClass set Commercial = 1 where ShipClassID = (select RefitID from FCT_ShipyardTask where TaskID = 1)`

    return withPlanted(file, plant, async (copy) => {
      const [stored] = await rowsOf(copy, 'select t.TotalBP, t.CompletedBP, t.NumShips, c.Size, c.Commercial, y.SYType from FCT_ShipyardTask t join FCT_ShipClass c on c.ShipClassID = t.RefitID join FCT_Shipyard y on y.ShipyardID = t.ShipyardID where t.TaskID = 1')
      const [row] = (await m.refits.loadRefitTasks(copy, { GameID: FIXTURE.gameId, RaceID: FIXTURE.raceId })).filter((task) => task.ID === 1)
      const work = { total: stored.TotalBP, completed: stored.CompletedBP, buildRate: MODIFIERS.ShipyardBuildRate, size: stored.Size }
      const rate = m.production.shipRate(MODIFIERS, row)
      const finish = m.production.shipTaskFinish({ rate, task: { remaining: row.RemainingProduction, totalBP: row.TotalBP, hulls: row.Hulls }, paused: m.production.flagOf(row.Paused) })
      const days = m.provenance.valueOrNull(finish.result)

      return same([stored.SYType, stored.Commercial, row.Size, row.CommercialModifier, near(days, gameDays({ ...work, ships: stored.NumShips, commercial: true })), !near(days, gameDays({ ...work, ships: stored.NumShips, commercial: false }))], [1, 1, stored.Size, 0.25, true, true])
    })
  })

  if ((await rowsOf(database, 'select count(*) as n from FCT_Shipyard where SYType = 4'))[0].n === 0) {
    NO_CASE.set('save-light', NO_LIGHT)
  } else {
    add(`save-light: ${label}: every light yard is read as type 4, offered the slipway alone at the full weight of a naval yard (capacity over 500 t times 120 times the race's operations) with no capacity step and no continual upgrade, and rated at the modification rate of a naval yard of its capacity`, async () => {
      const bad = []
      let seen = 0

      for (const { GameID, RaceID } of races) {
        const operations = m.g.shipyardOperations(await m.g.loadShipyardOperations(database, { GameID, RaceID }), '2.7.x')

        for (const yard of (await m.refits.loadYards(database, { GameID, RaceID })).filter((candidate) => candidate.type === 4)) {
          const rows = m.g.upgradePrices({ yard, operations, version: '2.7.x' })
          const steps = m.g.CAPACITY_STEPS.map((step) => m.g.capacityStepPrice({ yard, step, operations, version: '2.7.x' }))
          const continual = m.g.continualPrice({ yard, target: yard.capacity + 5000, operations, version: '2.7.x' })
          const rate = (1 + (yard.capacity / 5000 - 1) / 2) * MODIFIERS.ShipyardBuildRate

          seen++

          if (rows.length !== 1 || !near(m.provenance.valueOrNull(rows[0].price), (yard.capacity / 500) * 120 * m.provenance.valueOrNull(operations)) || !steps.every((step) => step.status === 'unavailable') || continual.status !== 'unavailable' || !near(m.provenance.valueOrNull(m.g.modificationRate(MODIFIERS, yard)), rate)) {
            bad.push(yard.id)
          }
        }
      }

      return same([bad, seen > 0], [[], true])
    })
  }

  add(`save-repeat: ${label}: a task of three ships planted on a copy of the save is dated at the game's own seconds (its balance plus the whole cost of each later ship over the build rate its class gives), at a naval yard and at a light yard, and the loader reads the count`, async () => {
    const plant = 'update FCT_ShipyardTask set NumShips = 3 where TaskID = 1; update FCT_ShipyardTask set NumShips = 2, ShipyardID = (select min(ShipyardID) from FCT_Shipyard where SYType = 4 and GameID = 141 and RaceID = 784) where TaskID = 2'

    return withPlanted(file, plant, async (copy) => {
      const yards = await m.refits.loadYards(copy, { GameID: FIXTURE.gameId, RaceID: FIXTURE.raceId })
      const bad = []

      for (const [taskId, ships] of [[1, 3], [2, 2]]) {
        const [stored] = await rowsOf(copy, 'select t.TotalBP, t.CompletedBP, t.NumShips, c.Size, c.Commercial, y.SYType from FCT_ShipyardTask t join FCT_ShipClass c on c.ShipClassID = t.ClassID join FCT_Shipyard y on y.ShipyardID = t.ShipyardID where t.TaskID = :id and t.TaskTypeID not in (2, 4)', { id: taskId })
        const yard = yards.find((candidate) => candidate.taskRows.some((row) => row.id === taskId))
        const row = yard.taskRows.find((candidate) => candidate.id === taskId)
        const finish = m.g.taskFinish(MODIFIERS, row)
        const work = { total: stored.TotalBP, completed: stored.CompletedBP, buildRate: MODIFIERS.ShipyardBuildRate, size: stored.Size, commercial: stored.Commercial === 1 }

        if (stored.NumShips !== ships || row.hulls !== ships || yard.type !== stored.SYType || !near(m.provenance.valueOrNull(finish.result), gameDays({ ...work, ships })) || near(m.provenance.valueOrNull(finish.result), gameDays({ ...work, ships: 1 }))) {
          bad.push([taskId, row.hulls, yard.type, m.provenance.valueOrNull(finish.result), gameDays({ ...work, ships })])
        }
      }

      return same([bad, yards.filter((yard) => yard.type === 4).some((yard) => yard.taskRows.length === 1)], [[], true])
    })
  })
  add(`save-repeat: ${label}: the mineral projection of a task of three ships is its ship in hand's alone, as in the game (the ship's minerals times the share of its build points left): planting the count changes no colony's need`, async () => {
    const scope = { GameID: FIXTURE.gameId, RaceID: FIXTURE.raceId }
    const before = await m.minerals.loadQueueNeeds(database, scope)

    return withPlanted(file, 'update FCT_ShipyardTask set NumShips = 3 where TaskID = 1', async (copy) => {
      const after = await m.minerals.loadQueueNeeds(copy, scope)
      const [{ populationId, ship }] = (await copy.query('select PopulationID as populationId, Duranium * (TotalBP - CompletedBP) / TotalBP as ship from FCT_ShipyardTask where TaskID = 1'))[0]

      return same([after, ship > 0 && !near(after[populationId].Duranium, before[populationId].Duranium + 2 * ship)], [before, true])
    })
  })

  return { skipped: false, statements, activities, close: () => database.close() }
}

// The counts over the two 2.7 saves this check was written on: 64 activities of types 1 to 6 (types 1, 3, 5, 6 in the saves; 2 and 4 in none), all 64 equal once the operations factor applies, 63 at a factor of 1. The fixture holds none, so the counts have no case in it: needs tier b.
const totalStatements = (reads) => {
  const all = reads.flatMap((read) => read.activities || [])
  const byType = (type) => all.filter((row) => row.TaskType === type).length
  const statements = []
  const add = (name, test) => statements.push([name, test])

  if (all.length === 0) {
    NO_CASE.set('save-stored', NO_ACTIVITY)
    NO_CASE.set('save-types', NO_ACTIVITY)

    return statements
  }

  add('save-stored: both saves: 64 stored activities of types 1 to 6, and all 64 equal the rules\' price once the operations factor applies, 63 of them at a factor of 1 and the one other (yard 6746, 192 stored against 240) at the race\'s 0.8', () => {
    const exact = all.filter((row) => near(row.RequiredBP, row.expected)).length
    const atOne = all.filter((row) => near(row.RequiredBP, row.atOne)).length
    const other = all.filter((row) => !near(row.RequiredBP, row.atOne))

    return same([all.length, exact, atOne, other.map((row) => [row.ShipyardID, row.RequiredBP, row.atOne, row.held])], [64, 64, 63, [[6746, 192, 240, 0.8]]])
  })
  add('save-types: both saves: the activities stored are the slipway (type 1), the 1,000, 5,000 and 10,000 ton steps (3, 5, 6); the 500 and 2,000 ton steps (2, 4) occur in no save, so their prices rest on the pattern', () => same([byType(1), byType(2), byType(3), byType(4), byType(5), byType(6)], [29, 0, 25, 0, 2, 8]))

  return statements
}

// ---------- the mutations ----------

const MUTATIONS = [
  { name: 'a slipway priced on 5,000 tons to the unit', file: G, find: 'export const UPGRADE_UNIT_TONS = 500', replace: 'export const UPGRADE_UNIT_TONS = 5000', fails: ['price', 'continual', 'growth', 'page-rows', 'save-stored'] },
  { name: 'the unit price 120 changed', file: G, find: 'export const UPGRADE_UNIT_COST = 120', replace: 'export const UPGRADE_UNIT_COST = 100', fails: ['price', 'continual', 'save-stored'] },
  { name: 'a commercial yard paying in full', file: G, find: 'export const COMMERCIAL_UPGRADE_FACTOR = 0.1', replace: 'export const COMMERCIAL_UPGRADE_FACTOR = 1', fails: ['price', 'save-stored'] },
  { name: 'a repair yard left outside the rules', file: G, find: 'type === SHIPYARD_TYPE.COMMERCIAL || type === SHIPYARD_TYPE.REPAIR ? COMMERCIAL_UPGRADE_FACTOR', replace: 'type === SHIPYARD_TYPE.COMMERCIAL ? COMMERCIAL_UPGRADE_FACTOR', fails: ['price'] },
  { name: 'the 1,000 ton step at one unit', file: G, find: 'taskType: 3, tons: 1000, units: 2', replace: 'taskType: 3, tons: 1000, units: 1', fails: ['price', 'save-stored'] },
  { name: 'the 5,000 ton step at five units', file: G, find: 'taskType: 5, tons: 5000, units: 10', replace: 'taskType: 5, tons: 5000, units: 5', fails: ['price', 'save-stored'] },
  { name: 'the 10,000 ton step at ten units', file: G, find: 'taskType: 6, tons: 10000, units: 20', replace: 'taskType: 6, tons: 10000, units: 10', fails: ['price', 'save-stored'] },
  { name: 'the 2,000 ton step passed off as confirmed', file: G, find: 'taskType: 4, tons: 2000, units: 4, pattern: true', replace: 'taskType: 4, tons: 2000, units: 4, pattern: false', fails: ['price'] },
  { name: 'the 500 ton step passed off as confirmed', file: G, find: 'taskType: 2, tons: 500, units: 1, pattern: true', replace: 'taskType: 2, tons: 500, units: 1, pattern: false', fails: ['price'] },
  { name: 'the operations factor taken as the highest multiplier', file: G, find: 'value: Math.min(...held.map((level) => level.multiplier))', replace: 'value: Math.max(...held.map((level) => level.multiplier))', fails: ['operations', 'price', 'page-rows', 'save-stored'] },
  { name: 'a race holding no level given a factor of 1', file: G, find: '} else if (!held.length) {', replace: '} else if (!held.length) {\n    return figure({ rule, value: 1, present: [], units: \'\', version })\n  } else if (false) {', fails: ['operations', 'price', 'growth'] },
  { name: 'a level with no multiplier counted as 0', file: G, find: 'const unknown = held.filter((level) => !isNumber(level.multiplier))', replace: 'const unknown = []', fails: ['operations'] },
  { name: 'the type rejection of a price removed', file: G, find: '  if (!isNumber(yard.type)) {\n    missing.push(\'the yard\\\'s type\')\n  } else if (factorOf(yard.type) === null) {\n    missing.push(`the rules for yard type $' + '{yard.type}`)\n  } else if (capacityGrowth', replace: '  if (false) {\n  } else if (capacityGrowth', fails: ['price'] },
  { name: 'a linked yard hidden by the free-slipway filter', file: P, find: 'idleOnly && yard.id !== linkedYardId && full(yard)', replace: 'idleOnly && full(yard)', fails: ['links'] },
  { name: 'a linked yard hidden by the saved search', file: P, find: '(yard.id === linkedYardId || !search || ', replace: '(!search || ', fails: ['links'] },
  { name: 'a link that names no yard keeping the last linked yard', file: P, find: '      this.linkedYardId = yardId\n', replace: '', fails: ['links'] },
  { name: 'the continual price from the target, not the tons added', file: G, find: '((isNumber(target) ? target : 0) - yard.capacity) / UPGRADE_UNIT_TONS', replace: '(isNumber(target) ? target : 0) / UPGRADE_UNIT_TONS', fails: ['continual', 'growth'] },
  { name: 'a target at or below the capacity priced', file: G, find: 'isAvailable(price) && !(target > yard.capacity)', replace: 'false', fails: ['continual'] },
  { name: 'the most construction periods cut to 100', file: G, find: 'export const MAX_CONTINUAL_PERIODS = 100000', replace: 'export const MAX_CONTINUAL_PERIODS = 100', fails: ['continual', 'growth'] },
  { name: 'a fixed upgrade timed on no build points', file: G, find: 'remaining: price.value, target: null', replace: 'remaining: 0, target: null', fails: ['time', 'growth'] },
  { name: 'the rate weighted by the yard\'s type rather than the class\'s flag', file: R, find: '(case when TargetClass.Commercial = 0 then 1.0 when TargetClass.Commercial is null then null else 0.25 end)', replace: '(case when FCT_Shipyard.SYType in (1, 4) then 1.0 when FCT_Shipyard.SYType is null then null else 0.25 end)', fails: ['save-flag'] },
  { name: 'a refit task dated by its source class', file: G, find: 'Size: refit ? task.targetSize : task.size,', replace: 'Size: refit ? task.size : task.size,', fails: ['time'] },
  { name: 'a task row\'s refit target taken from the class it refits', file: R, find: 'TargetClass.Size as TargetSize', replace: 'TaskClass.Size as TargetSize', fails: ['loader'] },
  { name: 'a task\'s own class flag read from its refit target', file: R, find: 'commercial: flagOf(row.Commercial),', replace: 'commercial: flagOf(row.TargetCommercial),', fails: ['loader'] },
  { name: 'an activity timed on all its build points, not what is left', file: G, find: 'isNumber(yard.requiredBP) && isNumber(yard.completedBP) ? yard.requiredBP - yard.completedBP : null', replace: 'isNumber(yard.requiredBP) ? yard.requiredBP : null', fails: ['time', 'page-rows'] },
  { name: 'the levels read for every race', file: G, find: 'where FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID and', replace: 'where FCT_RaceTech.GameID = :GameID and', fails: ['loader'] },
  { name: 'the Shipyard Operations tech type read as another', file: G, find: 'export const OPERATIONS_TECH_TYPE = 158', replace: 'export const OPERATIONS_TECH_TYPE = 30', fails: ['loader', 'techtree', 'save-operations', 'save-stored'] },
  { name: 'the tech lines swapped between the views', file: G, find: '{ 30: \'yards\', [OPERATIONS_TECH_TYPE]: \'growth\' }', replace: '{ 30: \'growth\', [OPERATIONS_TECH_TYPE]: \'yards\' }', fails: ['techtree'] },
  { name: 'the refit labelled as a repair', file: G, find: '2: \'Refit\',', replace: '2: \'Repair\',', fails: ['labels'] },
  { name: 'a task\'s balance taken the wrong way round', file: R, find: 'remaining: isNumber(row.TotalBP) && isNumber(row.CompletedBP) ? row.TotalBP - row.CompletedBP : null', replace: 'remaining: isNumber(row.TotalBP) && isNumber(row.CompletedBP) ? row.CompletedBP - row.TotalBP : null', fails: ['loader'] },
  { name: 'a task\'s pause flag not stored taken as running', file: R, find: 'paused: flagOf(row.Paused),\n  size: numberOf(row.Size),', replace: 'paused: Boolean(row.Paused),\n  size: numberOf(row.Size),', fails: ['loader'] },
  { name: 'a save with no task table given an empty list of tasks', file: R, find: 'taskRows: hasTasks ? Object.freeze(taskRows[row.ShipyardID] || []) : null', replace: 'taskRows: Object.freeze(taskRows[row.ShipyardID] || [])', fails: ['loader'] },
  { name: 'a stored pause flag of an activity taken as 0 when it is not there', file: R, find: 'paused: flagOf(row.PauseActivity),', replace: 'paused: Boolean(row.PauseActivity),', fails: ['loader'] },
  { name: 'a class link that opens Refits', file: D, find: 'classId ? { view: \'classes\', operation, from, to: classId }', replace: 'classId ? { view: \'refits\', operation, from, to: classId }', fails: ['links'] },
  { name: 'the yard key left out of the link', file: D, find: '{ view, yard, colony, operation, from, to }', replace: '{ view, colony, operation, from, to }', fails: ['links'] },
  { name: 'a yard link that opens Refits', file: P, find: 'yardId || this.colonyId ? \'yards\' : \'refits\'', replace: '\'refits\'', fails: ['links'] },
  { name: 'the yard of a link not taken', file: P, find: 'this.setUnsaved(\'yardId\', yardId)', replace: 'void yardId', fails: ['links'] },
  { name: 'a colony link that keeps the stored colony', file: P, find: 'this.colonyId = queryId(query.colony)', replace: 'this.colonyId = this.colonyId', fails: ['links'] },
  { name: 'the free-slipway filter leaving out yards with no task', file: P, find: '!(idleOnly && yard.id !== linkedYardId && full(yard))', replace: '!(idleOnly && yard.tasks === 0)', fails: ['page-rows'] },
  { name: 'the yards with no task left out of the list', file: P, find: 'matches(yard) && !(idleOnly && yard.id !== linkedYardId && full(yard))', replace: 'matches(yard) && yard.tasks > 0 && !(idleOnly && yard.id !== linkedYardId && full(yard))', fails: ['page-rows'] },
  { name: 'a retool holding a slipway', file: P, find: 'const free = isNumber(yard.slipways) && isNumber(yard.tasks) ? yard.slipways - yard.tasks : null', replace: 'const free = isNumber(yard.slipways) && isNumber(yard.tasks) ? yard.slipways - yard.tasks - (yard.taskType === RETOOL_ACTIVITY ? 1 : 0) : null', fails: ['page-rows'] },
  { name: 'the default target 1,000 t above the capacity', file: P, find: 'const DEFAULT_GROWTH_TONS = 10000', replace: 'const DEFAULT_GROWTH_TONS = 1000', fails: ['growth'] },
  { name: 'a target of 0 accepted', file: P, find: 'Number.isFinite(number) && number > 0 ? number : null\n    },', replace: 'Number.isFinite(number) && number >= 0 ? number : null\n    },', fails: ['growth'] },
  { name: 'the last yard shown while none is picked', file: P, find: 'return pickedYard || (yardId === null && yards.length ? yards[0] : null)', replace: 'return pickedYard || (yardId === null && yards.length ? yards[yards.length - 1] : null)', fails: ['growth'] },
  { name: 'the continual row not marked approximate', file: P, find: 'idle: time.idle, approx: true })', replace: 'idle: time.idle, approx: false })', fails: ['growth'] },
  { name: 'the continual row priced to the capacity, not the target', file: P, find: 'const price = continualPrice({ yard, target, operations, version: formulaVersion })', replace: 'const price = continualPrice({ yard, target: yard.capacity, operations, version: formulaVersion })', fails: ['growth'] },
  { name: 'the free slipways tile counting every slipway', file: P, find: 'known.reduce((total, yard) => total + yard.slipways - yard.tasks, 0)', replace: 'known.reduce((total, yard) => total + yard.slipways, 0)', fails: ['tiles'] },
  { name: 'the operations tile a figure with no factor', file: P, find: 'value: operationsValue === null ? UNKNOWN_TEXT : this.count(operationsValue, 2)', replace: 'value: this.count(operationsValue || 1, 2)', fails: ['tiles'] },
  { name: 'Refits the default view', file: P, find: 'default: \'yards\', valid: oneOf(VIEW_OPTIONS', replace: 'default: \'refits\', valid: oneOf(VIEW_OPTIONS', fails: ['page-template'] },
  { name: 'the yard pick kept for the app, not the race', file: P, find: 'yardId: { key: \'shipyardsYard\', default: null, scope: \'race\', valid', replace: 'yardId: { key: \'shipyardsYard\', default: null, valid', fails: ['page-persist'] },
  { name: 'the yards table kept under the eligibility table\'s key', file: P, find: 'tableView(\'shipyardsYardsList\'', replace: 'tableView(\'shipyardsYardsTable\'', fails: ['page-persist'] },
  { name: 'the yard pick accepted as any number', file: P, find: 'yardId: { key: \'shipyardsYard\', default: null, scope: \'race\', valid: (value) => value === null || (Number.isInteger(value) && value > 0) },', replace: 'yardId: { key: \'shipyardsYard\', default: null, scope: \'race\', valid: (value) => true },', fails: ['page-persist'] },
  { name: 'the Yards title with a figure', file: P, find: '<span>Shipyards<provenance-mark', replace: '<span>Shipyards 1<provenance-mark', fails: ['page-template'] },
  { name: 'the Growth panel without its visible title', file: P, find: '<span>Yard growth<provenance-mark', replace: '<span><provenance-mark', fails: ['page-template'] },
  { name: 'the Growth note in the second person', file: P, find: 'Use it to compare the upgrades and to size a continual target.', replace: 'Use it to compare your upgrades and to size a continual target.', fails: ['page-template'] },
  { name: 'the eligibility panel on every view', file: P, find: '<v-card v-if="view === \'refits\' || view === \'classes\'" class="panel" :data-summary="yardsSummary"', replace: '<v-card class="panel" :data-summary="yardsSummary"', fails: ['page-template'] },
  { name: 'the yard table\'s unknown not sorted last', file: P, find: ':items="inventoryRows" item-key="id" :custom-sort="sortNullLast"', replace: ':items="inventoryRows" item-key="id"', fails: ['page-template'] },
  { name: 'the Growth note gives the commercial yard a full price', file: P, find: 'A commercial or repair yard pays a tenth.', replace: 'A commercial or repair yard pays the full price.', fails: ['page-template'] },
  { name: 'the Recap\'s yard link dropped', file: PR, find: '<page-link v-if="item.ShipyardID" class="ml-1" :to="linkTo.shipyards({ yard: item.ShipyardID })" :name="item.yardName" />', replace: '', fails: ['named-links'] },
  { name: 'the Recap\'s ship jobs read without their yard', file: PR, find: 'FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.ShipyardID, FCT_ShipyardTask.UnitName as Name', replace: 'FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.UnitName as Name', fails: ['named-links'] },
  { name: 'the Recap\'s slipway link dropped', file: PR, find: '<page-link v-if="column.key === \'slipways\'" class="ml-1" :to="linkTo.shipyards({ colony: item.PopulationID })" :name="item.colonyName" />', replace: '', fails: ['named-links'] },
  { name: 'the Recap defining the labels again', file: PR, find: 'import { SHIPYARD_TASK_TYPES, SHIPYARD_UPGRADE_TYPES } from \'../utilities/shipyard-growth\'', replace: 'const SHIPYARD_TASK_TYPES = {}\nconst SHIPYARD_UPGRADE_TYPES = {}', fails: ['labels'] },
  { name: 'the idle-slipway warning linking the colony', file: W, find: 'link: linkTo.shipyards({ yard: shipyard.ShipyardID }),\n          signature: signatureOf(bandOf(isKnownNumber(shipyard.Slipways)', replace: 'link: linkTo.production(shipyard.PopulationID),\n          signature: signatureOf(bandOf(isKnownNumber(shipyard.Slipways)', fails: ['named-links'] },
  { name: 'the obsolete-yard warning linking the colony', file: W, find: 'caption: shipyard.PopName || undefined,\n          link: linkTo.shipyards({ yard: shipyard.ShipyardID }),', replace: 'caption: shipyard.PopName || undefined,\n          link: shipyard.PopulationID ? linkTo.production(shipyard.PopulationID) : undefined,', fails: ['named-links'] },
  { name: 'the Tech Tree lines view linking Yards for every line', file: L, find: ':to="linkTo.shipyards({ view: techViews[line.typeId] })"', replace: ':to="linkTo.shipyards({ view: \'yards\' })"', fails: ['named-links'] },
  { name: 'the Tech Tree path view linking the wrong line', file: PV, find: ':to="linkTo.shipyards({ view: techViews[tech.typeId] })"', replace: ':to="linkTo.shipyards({ view: \'growth\' })"', fails: ['named-links'] },
  { name: 'a yard that belongs to a ship priced', file: G, find: '  if (yard.shipBased === true) {\n    missing.push(SHIP_BASED_GAP)\n  } else if (yard.shipBased === null) {\n    missing.push(\'whether the yard belongs to a ship\')\n  }\n\n', replace: '', fails: ['price', 'save-ship-based'] },
  { name: 'a yard whose ship link is not stored priced', file: G, find: '  } else if (yard.shipBased === null) {\n    missing.push(\'whether the yard belongs to a ship\')\n  }\n', replace: '  }\n', fails: ['price'] },
  { name: 'the task rate left out of a task line', file: P, find: 'rate: valueOrNull(finish.rate), rateResult: finish.rate, ', replace: 'rate: null, rateResult: finish.rate, ', fails: ['page-rows'] },
  { name: 'the task rate column left out of the task table', file: P, find: '<th class="text-right">Rate (BP/yr)</th>', replace: '', fails: ['page-template'] },
  { name: 'a yard\'s ship link not carried to its row', file: P, find: '          shipBased: yard.shipBased,\n', replace: '', fails: ['page-rows'] },
  { name: 'the class picks kept for the app, not the race', file: P, find: 'fromId: { key: \'shipyardsFromClass\', default: null, scope: \'race\', valid', replace: 'fromId: { key: \'shipyardsFromClass\', default: null, valid', fails: ['page-persist'] },
  { name: 'the stored class pick never restored', file: P, find: 'toId: { key: \'shipyardsToClass\', default: null, scope: \'race\', valid: (value) => value === null || (Number.isInteger(value) && value > 0) },', replace: 'toId: { key: \'shipyardsToClass\', default: null, scope: \'race\', valid: () => false },', fails: ['page-persist'] },
  { name: 'the class pick accepted as any value', file: P, find: 'fromId: { key: \'shipyardsFromClass\', default: null, scope: \'race\', valid: (value) => value === null || (Number.isInteger(value) && value > 0) },', replace: 'fromId: { key: \'shipyardsFromClass\', default: null, scope: \'race\', valid: () => true },', fails: ['page-persist'] },
  { name: 'the classes of a link saved as the picks', file: P, find: 'this.setUnsaved(\'fromId\', fromId)', replace: 'this.fromId = fromId', fails: ['page-persist'] },
  { name: 'a link to Yards clearing the picks of the visit', file: P, find: 'if (this.view === \'refits\' || this.view === \'classes\') {\n        const fromId', replace: 'if (true) {\n        const fromId', fails: ['page-persist'] },
  { name: 'a pick the race no longer has kept', file: P, find: 'if (id && !this.classById[id] && !this.linkedClassIds.includes(id)) {', replace: 'if (false) {', fails: ['page-persist'] },
  { name: 'a class the link names dropped with the stale picks', file: P, find: ' && !this.linkedClassIds.includes(id)', replace: '', fails: ['page-persist'] },
  { name: 'the picks cleared when the race changes', file: P, find: '      this.linkedClassIds = []\n      this.expanded = []', replace: '      this.linkedClassIds = []\n      this.fromId = null\n      this.toId = null\n      this.expanded = []', fails: ['page-persist'] },
  { name: 'a light yard listing a class asking a retool', file: R, find: 'tooling = { kind: \'listed\', tooled: null', replace: 'tooling = { kind: \'unassigned\', tooled: null', fails: ['light', 'page-rows'] },
  { name: 'a light yard not told from the others', file: R, find: 'const light = yard.type === SHIPYARD_TYPE.LIGHT', replace: 'const light = false', fails: ['light'] },
  { name: 'another race\'s class listed by a light yard', file: R, find: 'flagged(hard, gaps, target.otherRace,', replace: 'void (hard, gaps, target.otherRace,', fails: ['light'] },
  { name: 'a class over a light yard\'s capacity taken', file: R, find: 'blockers.push(\'A light yard can be neither retooled nor given more capacity\')', replace: 'void 0', fails: ['light'] },
  { name: 'the yard rules left out of the 3.2 line', file: R, find: 'const YARD_VERSIONS = [\'2.7.x\', \'3.2.x\']', replace: 'const YARD_VERSIONS = [\'2.7.x\']', fails: ['light', 'rules'] },
  { name: 'a task\'s count of ships read as 1', file: R, find: 'hulls: numberOf(row.NumShips),', replace: 'hulls: 1,', fails: ['loader', 'save-repeat'] },
  { name: 'a light yard offered the capacity steps', file: G, find: '...(yard.type === SHIPYARD_TYPE.LIGHT ? [] : CAPACITY_STEPS.map(', replace: '...(false ? [] : CAPACITY_STEPS.map(', fails: ['light', 'save-light'] },
  { name: 'a light yard priced for growing its capacity', file: G, find: 'else if (capacityGrowth && !growsInCapacity(yard.type)) {', replace: 'else if (false) {', fails: ['light', 'save-light'] },
  { name: 'a light yard left out of the price rules', file: G, find: '(isFullCapacityYard(type) ? 1 :', replace: '(type === SHIPYARD_TYPE.NAVAL ? 1 :', fails: ['light', 'save-light'] },
  { name: 'a task dated to its current ship alone', file: G, find: 'hulls: task.hulls }, paused: task.paused })', replace: 'hulls: 1 }, paused: task.paused })', fails: ['time', 'page-rows', 'save-repeat'] },
  { name: 'a task of several ships dated to the first alone', file: PD, find: 'later > 0 ? later * Math.abs(task.totalBP) : 0', replace: '0', fails: ['time', 'page-rows', 'save-repeat'] },
  { name: 'a later ship counted at the balance, not the whole cost', file: PD, find: 'later * Math.abs(task.totalBP)', replace: 'later * Math.abs(task.remaining)', fails: ['time', 'page-rows', 'save-repeat'] },
  { name: 'a light yard\'s modification rate at a tenth of a naval yard\'s', file: PD, find: 'isFullCapacityYard(shipyard.SYType) ? 1 : 0.1', replace: 'shipyard.SYType === 1 ? 1 : 0.1', fails: ['light', 'save-light'] },
  { name: 'a task with no count of ships dated as a single ship', file: PD, find: '  } else if (!isNumber(task.hulls)) {\n    return { value: null, missing: \'the number of ships the task builds\' }\n', replace: '', fails: ['time'] },
  { name: 'a light yard not counted a full-capacity yard', file: T, find: 'export const isFullCapacityYard = (type) => type === SHIPYARD_TYPE.NAVAL || type === SHIPYARD_TYPE.LIGHT', replace: 'export const isFullCapacityYard = (type) => type === SHIPYARD_TYPE.NAVAL', fails: ['light', 'save-light'] },
  { name: 'a light yard offered capacity growth', file: T, find: 'export const growsInCapacity = (type) => type !== SHIPYARD_TYPE.LIGHT', replace: 'export const growsInCapacity = () => true', fails: ['light', 'growth'] },
  { name: 'the light yard type numbered as another', file: T, find: 'LIGHT: 4', replace: 'LIGHT: 5', fails: ['light', 'save-light'] },
  { name: 'a light yard typed by no name', file: P, find: ', [SHIPYARD_TYPE.LIGHT]: \'Light\' }', replace: ' }', fails: ['page-rows'] },
  { name: 'a continual row for a yard whose capacity cannot grow', file: P, find: 'if (target !== null && growsInCapacity(yard.type)) {', replace: 'if (target !== null) {', fails: ['growth'] },
  { name: 'the continual target left open for a light yard', file: P, find: 'return this.growthYard !== null && !growsInCapacity(this.growthYard.type)', replace: 'return false', fails: ['growth'] },
  { name: 'a repeating task\'s count of ships left off its line', file: P, find: 'hullsText: repeats ? `1 of $' + '{this.count(task.hulls)} left` : \'\'', replace: 'hullsText: \'\'', fails: ['page-rows'] },
  { name: 'the light yards left out of the type tile', file: P, find: '$' + '{this.count(typed(SHIPYARD_TYPE.LIGHT))} light, ', replace: '', fails: ['tiles'] },
  { name: 'the tooled-for cell of a light yard naming none', file: P, find: '                <span v-if="item.untooled" class="text--secondary" title="A light yard lists the classes that fit it, with no tooling">Not needed</span>', replace: '                <span v-if="item.untooled" class="text--secondary" title="A light yard lists the classes that fit it, with no tooling">None</span>', fails: ['rendered-light'] },
  { name: 'the retool of a class a light yard lists left unread', file: P, find: '      } else if (tooling.kind === \'listed\') {\n        return none(\'listed\', \'No retool needed\', \'A light yard lists the class, so it needs no tooling\')\n', replace: '', fails: ['page-rows'] },
  { name: 'the count of ships left off a repeating job', file: PR, find: 'ship.Hulls > 1 ? `1 of $' + '{this.count(ship.Hulls)} ships left` : \'\'', replace: '\'\'', fails: ['rendered-repeat'] },
  { name: 'the mineral projection of a task of several ships taken for each ship', file: CM, find: '/ FCT_ShipyardTask.TotalBP end as $' + '{name}', replace: '/ FCT_ShipyardTask.TotalBP * FCT_ShipyardTask.NumShips end as $' + '{name}', fails: ['save-repeat'] },
]

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]))

  if (mutant) {
    sources[mutant.file] = patched(FILES[mutant.file], sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

const contextOf = async (sources) => {
  const real = sourcesOf(null)
  const changed = (key) => sources[key] !== real[key]
  const utilityNames = { G: 'shipyard-growth', R: 'refits', D: 'deep-links', PD: 'production', T: 'shipyard-types', CM: 'colony-minerals' }
  const planted = Object.fromEntries(Object.entries(utilityNames).filter(([key]) => changed(key)).map(([key, name]) => [name, sources[key]]))
  const pagePlanted = Object.fromEntries(Object.entries(planted).map(([name, text]) => [`utilities/${name}`, text]))
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: planted })
  const pageSources = { 'pages/shipyards': sources.P, ...pagePlanted }
  const pageOptions = await loadPage('pages/shipyards', { stubs: STUBS, modules: { 'mixins/production-modifiers': MIXIN_STUB }, sources: pageSources })
  const persistedOptions = await loadPage('pages/shipyards', { stubs: STUBS, modules: { 'mixins/production-modifiers': MIXIN_STUB, 'mixins/persisted-view': PERSISTED_VIEW_SOURCE }, sources: pageSources })

  return { m: { g: loaded['shipyard-growth'], refits: loaded.refits, production: loaded.production, provenance: loaded.provenance, deepLinks: loaded['deep-links'], minerals: loaded['colony-minerals'] }, pageOptions, persistedOptions, pageText: sources.P, sourceText: sources }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result
    let valueFailure = false

    try {
      result = await test()
    } catch (error) {
      result = `threw ${error.message}`
      valueFailure = kindOf(error) === 'assertion' && !isSubjectThrow(error)
    }

    results.push([name, result, valueFailure])
  }

  return results
}

const statementsOf = async (ctx, withSaves, keys = null) => {
  const statements = [...pure(ctx), ...loader(ctx), ...page(ctx), ...links(ctx)]
  const opened = []
  const skipped = []

  if (withSaves) {
    const reads = []

    for (const file of SAVES) {
      const wanted = keys === null || keys.some((key) => key.startsWith('save-'))
      const read = wanted ? await saveStatements(ctx, file) : { skipped: false, statements: [] }

      if (read.skipped) {
        skipped.push(file)
      } else {
        statements.push(...read.statements)
        reads.push(read)

        if (read.close) {
          opened.push(read)
        }
      }
    }

    if (reads.length === SAVES.length && reads.every((read) => read.activities)) {
      statements.push(...totalStatements(reads))
    }
  }

  return { statements, opened, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, opened, skipped } = await statementsOf(ctx, true)

  console.log('\nShipyard growth: the prices and times on yards worked by hand, the loaders, the Yards and Growth views, the named links and the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  for (const reason of new Set(NO_CASE.values())) {
    console.log(`SKIP  ${[...NO_CASE].filter(([, text]) => text === reason).map(([key]) => key).sort().join(', ')}: needs tier b: ${reason}`)
  }

  for (const [name, result] of await runStatements(statements)) {
    check(name, result)
  }

  opened.forEach((read) => read.close())
}

const checkMutant = async (mutant) => {
  const began = Date.now()
  let sources

  try {
    sources = sourcesOf(mutant)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `invalid mutant: ${error.message}`)

    return
  }

  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  const { statements, opened, skipped } = await statementsOf(ctx, mutant.fails.some((key) => key.startsWith('save-')), mutant.fails)
  const required = mutant.fails.filter((key) => !NO_CASE.has(key))
  const absent = required.filter((key) => !statements.some(([name]) => keyOf(name) === key))
  const results = await runStatements(statements, required)
  const missed = required.filter((key) => !results.some(([name, result, valueFailure]) => keyOf(name) === key && result !== true && valueFailure))

  opened.forEach((read) => read.close())
  check(`mutation caught: ${mutant.name}`, skipped.length ? `required fixture absent: ${skipped.join(', ')}` : absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    try {
      if (options.part === 'head') {
        await checkHead()
      } else if (options.part === 'browser') {
        for (const fault of MUTANTS.filter(browserFault)) {
          await checkMutant(fault)
        }
      } else if (mutant) {
        await checkMutant(mutant)
      } else {
        throw new Error(`No part is named ${options.part}`)
      }
    } finally {
      await closeBrowser()
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const browserFaults = wanted.filter(browserFault)
  const sections = await runSections(__filename, [{ args: ['--part', 'head'], weight: 30 }, ...(browserFaults.length ? [{ args: ['--part', 'browser'], weight: 90 }] : []), ...wanted.filter((fault) => !browserFault(fault)).map(({ id }) => ({ args: ['--part', id], weight: 3 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names')
    sections.slice(1).forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
