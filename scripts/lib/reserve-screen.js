// What the reserves panel shows and does in the real app: the renderer served by Vite (scripts/lib/page-server.js) with the real Vue and the real Vuetify, in Chromium, over a copy of a save. Where the panel is mounted, whether it can be seen, which component the page resolved, the props it was given, the classes of its root element the effect of a real click on each of its buttons and every cell of its table are read from the page in the browser, and none of it is worked out from the template or from the virtual nodes it renders. What is on screen and the text a part draws are read by the shared readers of scripts/lib/browser-observe.js (`installScreen`: `visible`, `visibleText` and, for each quantity by its role in `data-reserve-value` and each name by its role in `data-reserve-name`, `hooked`).
//
// const { observeScreen } = require('./lib/reserve-screen')
// const seen = await observeScreen(browser, server.url, { logistics: true, hauling: true, actions: true, cells: [fixtureSpec, ...] })
//
// `seen` is the record of scripts/lib/browser-observe.js `observe`: its `value` is { logistics, hauling, actions, cells } for the parts asked for, `cells` keyed by the fixture's name, and the page errors, the console errors (those Vue catches included) and the failed requests are in it. No error is named in advance, so a page that raises one has an observation that says so.
const pageLoading = require('../page-loading')
const { observe, installScreen, settled } = require('./browser-observe')

// Every step of an observation (opening the app, picking the game and the race, the wait for the save of the race, each settling, each click and wait for a page) is bounded by TIMEOUT, below the deadline the runner gives a variant that reads the screen (DEADLINES in scripts/check-resource-ledger.js), so a step that does not end fails by its own timeout and is named by the step it was at. The page server is warmed before the first observation (`warm` of scripts/lib/page-server.js), so no step meets a cold start.
const TIMEOUT = 120000
// How long a panel that stays loading is waited for.
const LOADING_LIMIT = 45000
const NAMES = { game: 'Aurelian Empire', race: 'Aurelian Empire' }
// A control is pressed when it is on screen and enabled once the panel's own work is done (no write of the panel in progress); one that is not is not pressed, at once, and that is what is observed. Only the wait for that work and the click itself are bounded, by TIMEOUT, and either running out is a failure of the observation, never a control that was not pressed.
const idle = (page) => page.waitForFunction(() => !document.querySelector('[data-reserve-panel]') || !window.__reservePanel().busy, null, { timeout: TIMEOUT })

// Run in the page. The panels the page draws, as the page and the browser have them.
const panelsOfPage = () => {
  const host = window.$app.$route.matched[0].instances.default
  const instanceOf = (element) => {
    let vm = element.__vue__

    while (vm && vm.$options.name !== 'ResourceReserves') {
      vm = vm.$parent
    }

    return vm
  }

  return [...document.querySelectorAll('[data-reserve-panel]')].map((element) => {
    const vm = instanceOf(element)
    const card = element.parentElement ? element.parentElement.closest('.v-card') : null
    const plan = element.closest('[data-hauling-plan]')
    const same = (name, hostName) => Boolean(vm) && vm[name] === host[hostName || name] && vm[name] !== undefined && vm[name] !== null

    return {
      resolved: Boolean(vm),
      visible: window.__screen.visible(element),
      classes: [...element.classList],
      summary: element.getAttribute('data-summary'),
      vmSummary: vm ? vm.summary : null,
      kind: vm ? vm.kind : null,
      embedded: vm ? vm.embedded : null,
      is: { colonies: same('colonies'), place: same('place'), modifierOf: same('modifierOf'), plan: same('plan'), timed: same('timed', 'plannedDays') },
      timedCount: vm && Array.isArray(vm.timed) ? vm.timed.length : null,
      planCount: host.plan && Array.isArray(host.plan.hauls) ? host.plan.hauls.length : null,
      inPlanCard: Boolean(plan),
      planCardOnScreen: plan ? window.__screen.visible(plan) : false,
      cardSummary: card ? card.getAttribute('data-summary') : null,
    }
  })
}

// Run in the page, once. The panel's component instance.
const defineHandle = () => {
  window.__reservePanel = () => {
    let vm = document.querySelector('[data-reserve-panel]').__vue__

    while (vm && vm.$options.name !== 'ResourceReserves') {
      vm = vm.$parent
    }

    return vm
  }
}

const boot = async (page, url, step) => {
  // The page is settled when the reads it has out are answered and no round of its own work starts another (`settled` of scripts/lib/browser-observe.js), and its loading has ended or has had LOADING_LIMIT to end: a panel that waits on a prop it was never given stays loading for good (and the page goes on reading), which is what the page then shows and what the checks read.
  const settle = async () => {
    await settled(page, { limit: TIMEOUT })
    await page.waitForFunction(`!(${pageLoading})()`, null, { timeout: LOADING_LIMIT }).catch(() => {})
    await settled(page, { limit: TIMEOUT })
  }
  const go = async (route) => {
    step(`opening ${route}`)
    await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), route)
    await page.waitForFunction(pageLoading.arrived, route, { timeout: TIMEOUT })
    await settle()
  }

  step('opening the app')
  await page.goto(url, { timeout: TIMEOUT })

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(NAMES.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  step('waiting for the save of the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID), null, { timeout: TIMEOUT })
  step('waiting for the app to settle')
  await settled(page, { limit: TIMEOUT })
  await installScreen(page)
  await page.evaluate(defineHandle)

  return { page, settle, go, step }
}

const logisticsPart = async ({ page, settle, go, step }) => {
  await go('/logistics')

  const views = await page.evaluate(() => [...document.querySelectorAll('.v-btn-toggle .v-btn')].map((button) => button.getAttribute('value')))
  const byView = {}

  for (const view of [...views].reverse()) {
    step(`showing the view ${view} of Logistics`)
    await page.locator(`.v-btn-toggle .v-btn[value="${view}"]`).first().click({ timeout: TIMEOUT })
    await settle()
    byView[view] = { shown: await page.evaluate(() => window.$app.$route.matched[0].instances.default.view), panels: await page.evaluate(panelsOfPage) }
  }

  return { views, byView }
}

// The Hauling page: the panels, and where `flipping` the Fill reserves switch clicked twice (each click has the page work out its plan again, which takes seconds).
const haulingPart = async ({ page, settle, go }, flipping) => {
  await go('/hauling')

  const panels = await page.evaluate(panelsOfPage)
  const read = () => page.evaluate(() => window.$app.$route.matched[0].instances.default.planReserves)
  // The switch is the one the page marks with its hook, and its control is the switch element around that input.
  const switches = page.locator('.v-input--switch').filter({ has: page.locator('[data-hauling-fill-reserves]') })
  const switchCount = await page.locator('[data-hauling-fill-reserves]').count()
  const visible = switchCount === 1 && (await switches.count()) === 1 ? await switches.first().evaluate((element) => window.__screen.visible(element)) : false
  const flips = [await read()]

  if (visible && flipping) {
    for (let time = 0; time < 2; time++) {
      await switches.first().locator('.v-input--selection-controls__input').click({ timeout: TIMEOUT })
      await settle()
      flips.push(await read())
    }
  }

  return { panels, switchCount, switchVisible: visible, ...(flipping ? { flips } : {}) }
}

// The buttons of the panel on the Hauling page, pressed by a click in the browser in the states that show them. `press` is false for a control that is not on screen or not enabled; `shown` counts the controls on screen.
const actionsPart = async ({ page, settle, go, step }) => {
  await go('/hauling')

  const shown = (selector) => page.locator(selector).evaluateAll((elements) => elements.filter((element) => window.__screen.visible(element)).length)
  const press = async (selector) => {
    step(`pressing ${selector}`)
    await idle(page)

    if (!(await page.evaluate((css) => [...document.querySelectorAll(css)].some((element) => window.__screen.visible(element) && !element.disabled), selector))) {
      return false
    }

    await page.locator(selector).first().click({ timeout: TIMEOUT })
    await page.evaluate(async () => { await window.$app.$nextTick() })
    await settle()

    return true
  }
  // Setup written through the panel's own repository and then told to the panel, as the panel does after a write of its own.
  const act = (body, arg) => page.evaluate(body, arg)
  const reasons = () => page.evaluate(() => [...document.querySelectorAll('[data-reserve-reason]')].filter((element) => window.__screen.visible(element)).map((element) => window.__screen.visibleText(element)))
  const entryOf = (scenario) => act((name) => {
    const entry = window.__reservePanel().entries.find((one) => one.scenario === name)

    return entry ? { uuid: entry.uuid, applied: entry.applied, ahead: entry.ahead, reason: entry.reason, state: entry.source.verdict.state, duranium: entry.reserves.Duranium } : null
  }, scenario)
  const state = () => act(() => {
    const vm = window.__reservePanel()

    return { open: vm.draft.open, deleting: vm.deleting, conflict: vm.conflict !== null, entries: vm.entries.length, ready: Boolean(vm.repository && vm.scope && vm.reserveContext && vm.colonyChoices.length) }
  })
  // A record written with the panel's form, as a person fills it in (the colony pick, the scenario and the reserve), and then saved by the panel.
  const keep = (scenario, reserve) => act(async ({ name, amount }) => {
    const vm = window.__reservePanel()

    vm.startNew()
    vm.draft.colonyPick = vm.colonyChoices[0]
    vm.draft.scenario = name
    vm.draft.reserves.Duranium = String(amount)
    await vm.save(false)
    await vm.$nextTick()

    const alert = document.querySelector('[data-reserve-message]')

    // The kind of the message as the panel holds it, whether the alert that carries the message is on screen, and the words the alert draws beside the panel's own words for a write (`saveWords`), which the check reads them back through.
    return { type: vm.messageType, said: vm.message !== '', shown: Boolean(alert) && window.__screen.visible(alert), text: alert ? window.__screen.visibleText(alert) : null, words: { ...(vm.saveWords || {}) } }
  }, { name: scenario, amount: reserve })
  // A record written under another identity of the colony, or at a later game time, through the repository, as a save of another game would have left it.
  const write = (scenario, how) => act(async ({ name, how: mode }) => {
    // eslint-disable-next-line import/no-absolute-path
    const rr = await import('/utilities/resource-reserves.js')
    const vm = window.__reservePanel()
    const context = vm.reserveContext
    const row = vm.colonyChoices[0].row
    const other = { ...row, name: `${row.name} (another)`, systemId: (row.systemId || 0) + 1000, systemName: 'Elsewhere', bodyId: (row.bodyId || 0) + 1000, speciesId: (row.speciesId || 0) + 1000 }
    const doctored = mode === 'review' ? { ...context, objects: { ...context.objects, colony: new Map([[row.id, other]]) } } : context
    const scope = mode === 'ahead' ? { ...vm.scope, gameTime: (vm.scope.gameTime || 0) + 200000 } : vm.scope
    const outcome = await rr.saveReserve(vm.repository, scope, { source: { type: 'colony', row: mode === 'review' ? other : row }, scenario: name, resources: ['Duranium'], reserves: { Duranium: 40 }, context: doctored })

    vm.reservesChanged()
    await vm.$nextTick()

    return outcome.ok ? 'ok' : outcome.message
  }, { name: scenario, how })
  const clear = () => act(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const rr = await import('/utilities/resource-reserves.js')
    const vm = window.__reservePanel()

    for (const entry of [...vm.entries]) {
      await rr.deleteReserve(vm.repository, vm.scope, entry)
    }

    vm.resetDraft()
    vm.deleting = null
    vm.conflict = null
    vm.reservesChanged()
    await vm.$nextTick()
  })

  const seen = { ready: (await state()).ready }

  if (!seen.ready) {
    return seen
  }

  seen.newThere = (await shown('[data-reserve-new]')) === 1 && (await state()).open === false
  seen.opened = (await press('[data-reserve-new]')) && (await state()).open === true && (await shown('[data-reserve-new]')) === 0
  const saved = await keep('Alpha', 1)
  const stored = await entryOf('Alpha')

  seen.kept = { ...saved, persisted: Boolean(stored) && stored.duranium === 1 && stored.applied === true }

  seen.quiet = (await reasons()).length === 0 && (await shown('[data-reserve-confirm]')) === 0 && (await shown('[data-reserve-rebase]')) === 0
  seen.asked = (await press('[data-reserve-delete]')) && (await state()).deleting === (stored && stored.uuid) && (await shown('[data-reserve-delete]')) === 0 && (await shown('[data-reserve-delete-confirm]')) === 1 && (await state()).entries === 1
  seen.deleted = (await press('[data-reserve-delete-confirm]')) && (await state()).entries === 0
  await clear()

  // A stale edit: another write lands between the form opening and the save.
  await keep('Beta', 1)
  await act(async () => {
    // eslint-disable-next-line import/no-absolute-path
    const rr = await import('/utilities/resource-reserves.js')
    const vm = window.__reservePanel()
    const entry = vm.entries.find((one) => one.scenario === 'Beta')

    vm.startEdit(entry)
    await rr.saveReserve(vm.repository, vm.scope, { entry, resources: ['Duranium'], reserves: { Duranium: 2 }, context: vm.reserveContext })
    vm.reservesChanged()
    await vm.$nextTick()
    vm.draft.reserves.Duranium = '3'
    await vm.save(false)
    await vm.$nextTick()
  })
  seen.conflicted = (await state()).conflict === true && (await shown('[data-reserve-overwrite]')) === 1 && (await entryOf('Beta')).duranium === 2
  seen.overwritten = (await press('[data-reserve-overwrite]')) && (await state()).conflict === false && (await entryOf('Beta')).duranium === 3 && (await shown('[data-reserve-overwrite]')) === 0
  await clear()

  // A record made for another colony under this ID is under review until the player confirms the colony.
  seen.reviewWritten = await write('Gamma', 'review')

  const held = await entryOf('Gamma')

  seen.underReview = Boolean(held) && held.state === 'review' && held.applied === false && held.reason !== '' && (await reasons()).length === 1 && (await reasons())[0].includes(held.reason) && (await shown('[data-reserve-confirm]')) === 1 && (await shown('[data-reserve-rebase]')) === 0
  seen.confirmed = (await press('[data-reserve-confirm]')) && (await entryOf('Gamma')).applied === true && (await shown('[data-reserve-confirm]')) === 0 && (await reasons()).length === 0
  await clear()

  // A record made at a later game time applies to nothing until it is moved to the save.
  seen.aheadWritten = await write('Delta', 'ahead')

  const late = await entryOf('Delta')

  seen.ahead = Boolean(late) && late.ahead === true && (await shown('[data-reserve-rebase]')) === 1 && (await shown('[data-reserve-confirm]')) === 0 && (await reasons()).length === 1
  seen.rebased = (await press('[data-reserve-rebase]')) && (await entryOf('Delta')).ahead === false && (await entryOf('Delta')).applied === true && (await shown('[data-reserve-rebase]')) === 0
  await settle()

  return seen
}

// Run in the page. One fixture of the panel mounted by the app's own Vue, Vuetify, store and router, in a container on the page: the panel as a host would give it its colonies, with the reads it makes of the save given as the fixture has them, and the records the fixture keeps written through the panel's own repository. What it gives is how the mount came out; the table is read by `readFixture`.
const mountFixture = async (spec) => {
  // eslint-disable-next-line import/no-absolute-path
  const component = (await import('/components/logistics/ResourceReserves.vue')).default
  // eslint-disable-next-line import/no-absolute-path
  const reserves = await import('/utilities/resource-reserves.js')
  // eslint-disable-next-line import/no-absolute-path
  const { thousandsSeparator } = await import('/utilities/math.js')
  const app = window.$app
  const getters = app.$store.getters
  const held = { database: getters.database, GameID: getters.GameID, RaceID: getters.RaceID }
  // Lazy as the mixin's own reads are: the plugin registers a lazy read as a computed property of the constructor's options, and a read that is not lazy beside it is a name defined twice.
  const fixed = (value) => ({ get: async () => value, default: value, lazy: true })
  const packets = Object.freeze({ packets: spec.packets, ...held })
  const supply = spec.supply ? Object.freeze({ colonies: spec.supply, ...held }) : null
  const objects = Object.freeze({ objects: Object.freeze({ colony: new Map(spec.colonyEntries) }), ...held })
  const classes = Object.freeze({ classes: spec.classes, ...held })
  const wrap = document.createElement('div')

  wrap.className = 'v-application v-application--is-ltr theme--light'
  wrap.setAttribute('data-cells-fixture', spec.name)
  // Over the app: the page does not scroll, so a fixture below its content could not be brought into view to be clicked.
  wrap.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 99999; width: 1200px; max-height: 100vh; overflow: auto; background: white;'

  const slot = document.createElement('div')

  wrap.appendChild(slot)
  document.body.appendChild(wrap)

  const Ctor = app.constructor.extend(component)
  const vm = new Ctor({
    parent: app,
    // A setting of the thousands separator of the fixture's own, as the page would write it were the setting that.
    computed: spec.setting ? { separator: () => thousandsSeparator(spec.setting) } : {},
    propsData: { kind: spec.kind, colonies: spec.colonies, plan: spec.plan, timed: spec.timed, embedded: spec.embedded },
    data: { ...(spec.showAll ? { showAll: true } : {}), loadErrors: spec.waiting ? {} : { reserveObjects: null, reserveClasses: null, reservePackets: null, reserveSupply: null, populationProductionModifiers: null } },
    asyncComputed: { reserveObjects: fixed(spec.waiting ? null : objects), reserveClasses: fixed(classes), reservePackets: fixed(packets), reserveSupply: fixed(supply), populationProductionModifiers: fixed(spec.modifiers) },
  })

  vm.$mount(slot)
  window.__fixtures = window.__fixtures || {}
  window.__fixtures[spec.name] = { vm, wrap }

  const began = Date.now()

  // A panel that waits on its reads has no view and no context: it is ready when its repository is.
  const settled = () => Boolean(vm.repository && vm.scope && (spec.waiting || (vm.view && vm.reserveContext)))

  while (!settled() && Date.now() - began < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const problems = []
  const ready = settled()

  for (const record of ready ? spec.records : []) {
    const outcome = await reserves.saveReserve(vm.repository, vm.scope, { source: { type: 'colony', row: vm.reserveContext.objects.colony.get(record.colonyId) }, scenario: record.scenario, resources: record.resources, reserves: record.reserves, plans: record.plans, note: record.note, context: vm.reserveContext })

    if (!outcome.ok) {
      problems.push(outcome.message)
    }

    vm.reservesChanged()
    await vm.$nextTick()
  }

  // The render that the records written start: a task and two frames, as the wait for the page to settle counts a round of the page's own work.
  await new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  return { ready, problems, separator: spec.setting || getters.config.get('selectedSeparator', 'Tick'), statusWords: { ...vm.statusWords }, timingWords: { ...vm.timingWords }, minimumWords: JSON.parse(JSON.stringify(vm.minimumWords || {})), listed: vm.items.length }
}

// Run in the page. What the table of a fixture shows: for each row, each cell as the text it draws (only the text of elements that are on screen) and whether it is on screen, the quantities and the names in it each from the element that draws it, with its role, the marks of the cells with the rule each stands for, and the status chips with their words.
const readFixture = (name) => {
  const container = document.querySelector(`[data-cells-fixture="${name}"]`)
  const { visible, visibleText, hooked } = window.__screen
  const drawn = (element) => ({ text: visibleText(element), on: visible(element), values: hooked(element, 'data-reserve-value'), names: hooked(element, 'data-reserve-name') })
  const cells = (row, attribute) => [...row.querySelectorAll(`[${attribute}]`)].map((element) => ({ ...drawn(element), state: element.getAttribute(attribute) }))
  const marks = (row, attribute) => [...row.querySelectorAll(`[${attribute}]`)].flatMap((element) => [...element.closest('td').querySelectorAll('.provenance-mark')].map((mark) => ({ rule: mark.__vue__ ? mark.__vue__.rule : null, on: visible(mark) })))
  const isChip = (element) => element.getAttributeNames().some((attribute) => /^data-reserve-.+-chip$/.test(attribute))
  const rows = [...container.querySelectorAll('[data-reserve-source]')].map((source) => {
    const row = source.closest('tr')

    return {
      key: source.getAttribute('data-reserve-source'),
      source: drawn(source),
      stock: cells(row, 'data-reserve-stock'),
      game: cells(row, 'data-reserve-game'),
      class: cells(row, 'data-reserve-class'),
      player: cells(row, 'data-reserve-player'),
      lowest: cells(row, 'data-reserve-lowest'),
      marks: { game: marks(row, 'data-reserve-game'), class: marks(row, 'data-reserve-class'), player: marks(row, 'data-reserve-player') },
      chips: [...row.querySelectorAll('.v-chip')].filter(isChip).map((chip) => ({ hook: chip.getAttributeNames().find((attribute) => /^data-reserve-.+-chip$/.test(attribute)), ...drawn(chip) })),
    }
  })

  const panel = container.querySelector('[data-reserve-panel]')

  return {
    root: panel ? { summary: panel.getAttribute('data-summary'), on: visible(panel) } : null,
    headers: [...container.querySelectorAll('thead th')].map(drawn),
    rows,
    shortfalls: [...container.querySelectorAll('[data-reserve-shortfall]')].map((line) => ({ id: line.getAttribute('data-reserve-shortfall'), ...drawn(line) })),
    count: [...container.querySelectorAll('[data-reserve-count]')].map(drawn),
  }
}

// Run in the page. What the detail of an expanded row shows: the lines of the run and of the timeline, each as its text, its quantities and names with their roles, and whether it is on screen.
const readDetail = ({ name, key }) => {
  const container = document.querySelector(`[data-cells-fixture="${name}"]`)
  const detail = container.querySelector(`[data-reserve-detail="${key}"]`)

  if (!detail) {
    return null
  }

  const { visible, visibleText, hooked } = window.__screen
  const drawn = (element) => ({ text: visibleText(element), on: visible(element), values: hooked(element, 'data-reserve-value'), names: hooked(element, 'data-reserve-name') })
  const lines = (selector) => [...detail.querySelectorAll(selector)].map((line) => ({ id: line.getAttribute('data-reserve-event-id'), kind: line.getAttribute('data-reserve-event'), ...drawn(line) }))

  return { on: visible(detail), run: lines('[data-reserve-run] > .resource-reserves__line'), events: lines('[data-reserve-event]') }
}

// Run in the page. The fixture taken away, with the records it kept.
const unmountFixture = async (name) => {
  const held = window.__fixtures[name]

  if (!held) {
    return
  }

  // eslint-disable-next-line import/no-absolute-path
  const reserves = await import('/utilities/resource-reserves.js')

  if (held.vm.repository && held.vm.scope) {
    for (const entry of [...held.vm.entries]) {
      await reserves.deleteReserve(held.vm.repository, held.vm.scope, entry)
    }
  }

  held.vm.$destroy()
  held.wrap.remove()
  delete window.__fixtures[name]
}

// The fixtures of the panel, each mounted on the page of the app, read, with the rows given in `expand` opened by a click on their toggle, and taken away.
const cellsPart = async ({ page, step }, specs) => {
  const out = {}

  for (const spec of specs) {
    step(`mounting the fixture ${spec.name}`)

    const opened = await page.evaluate(mountFixture, spec)
    const read = opened.ready ? await page.evaluate(readFixture, spec.name) : null
    const details = {}

    for (const key of opened.ready ? spec.expand : []) {
      const toggle = page.locator(`[data-cells-fixture="${spec.name}"] tr`).filter({ has: page.locator(`[data-reserve-source="${key}"]`) }).locator('.v-data-table__expand-icon').first()

      // A toggle that is not on screen once the fixture is mounted is not clicked, and the detail is not read: that is what is observed.
      if (!(await toggle.count()) || !(await toggle.evaluate((element) => window.__screen.visible(element)))) {
        details[key] = null
        continue
      }

      step(`opening the row ${key} of the fixture ${spec.name}`)
      await toggle.click({ timeout: TIMEOUT })
      // The table's own expansion of the row (the panel's `expanded` holds it once the click is handled), then the render it schedules: the detail is read once both are done, never after a fixed pause that a loaded machine can outrun. Whether the detail is then drawn, and how, is what the read observes.
      await page.waitForFunction(({ name, key }) => window.__fixtures[name].vm.expanded.some((item) => item.key === key), { name: spec.name, key }, { timeout: TIMEOUT })
      await page.evaluate(async () => { await window.$app.$nextTick() })
      details[key] = await page.evaluate(readDetail, { name: spec.name, key })
    }

    await page.evaluate(unmountFixture, spec.name)
    out[spec.name] = { ...opened, ...read, details }
  }

  return out
}

const observeScreen = (browser, url, parts) => observe(browser, async ({ page, step }) => {
  const session = await boot(page, url, step)
  const seen = {}

  if (parts.hauling) {
    step('reading the Hauling page')
    seen.hauling = await haulingPart(session, Boolean(parts.flips))
  }

  if (parts.logistics) {
    step('reading the Logistics page')
    seen.logistics = await logisticsPart(session)
  }

  if (parts.actions) {
    step('pressing the buttons of the panel')
    seen.actions = await actionsPart(session)
  }

  if (parts.cells) {
    step('reading the table of the panel')
    seen.cells = await cellsPart(session, parts.cells)
  }

  return seen
})

module.exports = { observeScreen }
