// What the reserves panel shows and does in the real app: the renderer served by Vite (scripts/lib/page-server.js) with the real Vue and the real Vuetify, in Chromium, over a copy of a save. Where the panel is mounted, whether it can be seen, which component the page resolved, the props it was given, the classes of its root element the effect of a real click on each of its buttons and every cell of its table (as the text it draws, taken from the text nodes whose element is on screen, and each quantity from the element that draws it, by its role in `data-reserve-value`, with whether that element is on screen, an opacity of nought on it or on an ancestor included) are read from the page in the browser, and none of it is worked out from the template or from the virtual nodes it renders.
//
// const { observeScreen } = require('./lib/reserve-screen')
// const seen = await observeScreen(browser, server.url, { logistics: true, hauling: true, actions: true, cells: [fixtureSpec, ...] })
//
// `seen` is the record of scripts/lib/browser-observe.js `observe`: its `value` is { logistics, hauling, actions, cells } for the parts asked for, `cells` keyed by the fixture's name, and the page errors, the console errors (those Vue catches included) and the failed requests are in it. No error is named in advance, so a page that raises one has an observation that says so.
const pageLoading = require('../page-loading')
const { observe } = require('./browser-observe')

const TIMEOUT = 120000
// The first request of a server that was just started (Vite transforms and bundles the app for this process alone) may take minutes on a busy machine; what follows is bounded by TIMEOUT.
const OPEN_TIMEOUT = 300000
const LOADING_LIMIT = 45000
const NAMES = { game: 'Aurelian Empire', race: 'Aurelian Empire' }
// A control that is not on screen is not pressed: a click waits this long for a control to be visible, enabled and still before it gives up.
const CLICK_WAIT = 6000

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
    const box = element.getBoundingClientRect()
    const card = element.parentElement ? element.parentElement.closest('.v-card') : null
    const plan = element.closest('[data-hauling-plan]')
    const same = (name, hostName) => Boolean(vm) && vm[name] === host[hostName || name] && vm[name] !== undefined && vm[name] !== null

    return {
      resolved: Boolean(vm),
      visible: box.width > 0 && box.height > 0 && element.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true }),
      classes: [...element.classList],
      summary: element.getAttribute('data-summary'),
      vmSummary: vm ? vm.summary : null,
      kind: vm ? vm.kind : null,
      embedded: vm ? vm.embedded : null,
      is: { colonies: same('colonies'), place: same('place'), modifierOf: same('modifierOf'), plan: same('plan'), timed: same('timed', 'plannedDays') },
      timedCount: vm && Array.isArray(vm.timed) ? vm.timed.length : null,
      planCount: host.plan && Array.isArray(host.plan.hauls) ? host.plan.hauls.length : null,
      inPlanCard: Boolean(plan),
      planCardOnScreen: plan ? window.__onScreen(plan) : false,
      cardSummary: card ? card.getAttribute('data-summary') : null,
    }
  })
}

// Run in the page, once. The panel's component instance, and the test of what is on screen: a layout box that display, visibility, content-visibility and opacity of the element and of its ancestors leave drawn.
const defineHandle = () => {
  window.__onScreen = (element) => {
    const box = element.getBoundingClientRect()

    return box.width > 0 && box.height > 0 && element.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true })
  }
  // The text an element draws and nothing else: each text node counts when the element it sits in is on screen (a layout box for the text itself, and display, visibility, content-visibility and opacity of that element and of its ancestors leave it drawn). A hidden descendant adds nothing to the text of a visible container. Spaces are collapsed.
  window.__visibleText = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let text = ''

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement

      range.selectNodeContents(node)

      if (parent && parent.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true }) && [...range.getClientRects()].some((box) => box.width > 0 && box.height > 0)) {
        text += node.data
      }
    }

    return text.replace(/\s+/g, ' ').trim()
  }
  // The elements that draw a quantity, each with its role (`data-reserve-value`), the text it draws and whether it is on screen.
  window.__names = (element) => [...element.querySelectorAll('[data-reserve-name]')].map((one) => ({ name: one.getAttribute('data-reserve-name'), text: window.__visibleText(one), on: window.__onScreen(one) }))
  window.__values = (element) => [...element.querySelectorAll('[data-reserve-value]')].map((one) => ({ role: one.getAttribute('data-reserve-value'), text: window.__visibleText(one), on: window.__onScreen(one) }))
  window.__reservePanel = () => {
    let vm = document.querySelector('[data-reserve-panel]').__vue__

    while (vm && vm.$options.name !== 'ResourceReserves') {
      vm = vm.$parent
    }

    return vm
  }
}

const boot = async (page, url) => {
  const isDatabaseCall = (request) => request.url().includes('/__aurora-db/') && !request.url().endsWith('/stat')
  let inFlight = 0
  let last = Date.now()

  page.on('request', (request) => {
    if (isDatabaseCall(request)) {
      inFlight++
      last = Date.now()
    }
  })
  page.on('requestfinished', (request) => {
    if (isDatabaseCall(request)) {
      inFlight--
      last = Date.now()
    }
  })
  page.on('requestfailed', (request) => {
    if (isDatabaseCall(request)) {
      inFlight--
      last = Date.now()
    }
  })

  // The page is settled when no database call is out and none has been made for a second, and its loading has ended or has had this long to end: a panel that waits on a prop it was never given stays loading for good (and the page goes on reading), which is what the page then shows and what the checks read.
  const settle = async () => {
    const began = Date.now()
    const loading = async () => Date.now() - began < LOADING_LIMIT && await page.evaluate(pageLoading)

    // `inFlight` and `last` are changed by the request listeners above, not in this loop.
    // eslint-disable-next-line no-unmodified-loop-condition
    while (inFlight > 0 || Date.now() - last < 1000 || await loading()) {
      if (Date.now() - began > TIMEOUT) {
        throw new Error(`the page did not settle: ${inFlight} database calls in flight`)
      }

      await page.waitForTimeout(200)
    }

    await page.evaluate(async () => { await window.$app.$nextTick() })
  }
  const go = async (route) => {
    await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), route)
    await page.waitForFunction(pageLoading.arrived, route, { timeout: TIMEOUT })
    await settle()
  }

  await page.goto(url, { timeout: OPEN_TIMEOUT })

  const picker = page.locator('.empire-list').first()

  await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: OPEN_TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    await picker.getByText(NAMES.race, { exact: true }).last().click()
  }

  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID), null, { timeout: OPEN_TIMEOUT })
  await settle()
  await page.evaluate(defineHandle)

  return { page, settle, go }
}

const logisticsPart = async ({ page, settle, go }) => {
  await go('/logistics')

  const views = await page.evaluate(() => [...document.querySelectorAll('.v-btn-toggle .v-btn')].map((button) => button.getAttribute('value')))
  const byView = {}

  for (const view of [...views].reverse()) {
    await page.locator(`.v-btn-toggle .v-btn[value="${view}"]`).first().click({ timeout: TIMEOUT })
    await page.waitForTimeout(300)
    await settle()
    byView[view] = { shown: await page.evaluate(() => window.$app.$route.matched[0].instances.default.view), panels: await page.evaluate(panelsOfPage) }
  }

  return { views, byView }
}

// The Hauling page: the panels, and the Fill reserves switch clicked twice.
const haulingPart = async ({ page, settle, go }) => {
  await go('/hauling')

  const panels = await page.evaluate(panelsOfPage)
  const read = () => page.evaluate(() => window.$app.$route.matched[0].instances.default.planReserves)
  // The switch is the one the page marks with its hook, and its control is the switch element around that input.
  const switches = page.locator('.v-input--switch').filter({ has: page.locator('[data-hauling-fill-reserves]') })
  const switchCount = await page.locator('[data-hauling-fill-reserves]').count()
  const visible = switchCount === 1 && (await switches.count()) === 1 ? await switches.first().evaluate((element) => window.__onScreen(element)) : false
  const flips = [await read()]

  if (visible) {
    for (let time = 0; time < 2; time++) {
      await switches.first().locator('.v-input--selection-controls__input').click({ timeout: TIMEOUT })
      await page.waitForTimeout(200)
      await settle()
      flips.push(await read())
    }
  }

  return { panels, switchCount, switchVisible: visible, flips }
}

// The buttons of the panel on the Hauling page, pressed by a click in the browser in the states that show them. `press` is false for a control that is not on screen or not enabled; `shown` counts the controls on screen.
const actionsPart = async ({ page, settle, go }) => {
  await go('/hauling')

  const shown = (selector) => page.locator(selector).evaluateAll((elements) => elements.filter((element) => window.__onScreen(element)).length)
  const press = async (selector) => {
    try {
      await page.waitForFunction((css) => [...document.querySelectorAll(css)].some((element) => window.__onScreen(element)), selector, { timeout: CLICK_WAIT })
      await page.locator(selector).first().click({ timeout: CLICK_WAIT })
    } catch (error) {
      // A control that is not on screen or not enabled for this long is not pressed: that is what is observed. Anything else is a failure of the observation.
      if (error.name !== 'TimeoutError') {
        throw error
      }

      return false
    }

    await page.evaluate(async () => { await window.$app.$nextTick() })
    await page.waitForTimeout(150)

    return true
  }
  // Setup written through the panel's own repository and then told to the panel, as the panel does after a write of its own.
  const act = (body, arg) => page.evaluate(body, arg)
  const reasons = () => page.evaluate(() => [...document.querySelectorAll('[data-reserve-reason]')].filter((element) => window.__onScreen(element)).map((element) => window.__visibleText(element)))
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

    // The state the save ended in, not its words: the kind of the message, and whether the alert that carries it is on screen with it.
    return { type: vm.messageType, said: vm.message !== '', shown: Boolean(alert) && window.__onScreen(alert) && window.__visibleText(alert).includes(vm.message) }
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

  await new Promise((resolve) => setTimeout(resolve, 150))

  return { ready, problems, separator: spec.setting || getters.config.get('selectedSeparator', 'Tick'), statusWords: { ...vm.statusWords }, timingWords: { ...vm.timingWords }, listed: vm.items.length }
}

// Run in the page. What the table of a fixture shows: for each row, each cell as the text it draws (only the text of elements that are on screen) and whether it is on screen, the quantities in it each from the element that draws it, with its role, the marks of the cells with the rule each stands for, and the status chips with their words.
const readFixture = (name) => {
  const container = document.querySelector(`[data-cells-fixture="${name}"]`)
  const drawn = (element) => ({ text: window.__visibleText(element), on: window.__onScreen(element), values: window.__values(element), names: window.__names(element) })
  const cells = (row, attribute) => [...row.querySelectorAll(`[${attribute}]`)].map((element) => ({ ...drawn(element), state: element.getAttribute(attribute) }))
  const marks = (row, attribute) => [...row.querySelectorAll(`[${attribute}]`)].flatMap((element) => [...element.closest('td').querySelectorAll('.provenance-mark')].map((mark) => ({ rule: mark.__vue__ ? mark.__vue__.rule : null, on: window.__onScreen(mark) })))
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
    root: panel ? { summary: panel.getAttribute('data-summary'), on: window.__onScreen(panel) } : null,
    headers: [...container.querySelectorAll('thead th')].map(drawn),
    rows,
    shortfalls: [...container.querySelectorAll('[data-reserve-shortfall]')].map((line) => ({ id: line.getAttribute('data-reserve-shortfall'), ...drawn(line) })),
    count: [...container.querySelectorAll('[data-reserve-count]')].map(drawn),
  }
}

// Run in the page. What the detail of an expanded row shows: the lines of the run and of the timeline, each as its text, its quantities with their roles, and whether it is on screen.
const readDetail = ({ name, key }) => {
  const container = document.querySelector(`[data-cells-fixture="${name}"]`)
  const detail = container.querySelector(`[data-reserve-detail="${key}"]`)

  if (!detail) {
    return null
  }

  const drawn = (element) => ({ text: window.__visibleText(element), on: window.__onScreen(element), values: window.__values(element), names: window.__names(element) })
  const lines = (selector) => [...detail.querySelectorAll(selector)].map((line) => ({ id: line.getAttribute('data-reserve-event-id'), kind: line.getAttribute('data-reserve-event'), ...drawn(line) }))

  return { on: window.__onScreen(detail), run: lines('[data-reserve-run] > .resource-reserves__line'), events: lines('[data-reserve-event]') }
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
const cellsPart = async ({ page }, specs) => {
  const out = {}

  for (const spec of specs) {
    const opened = await page.evaluate(mountFixture, spec)
    const read = opened.ready ? await page.evaluate(readFixture, spec.name) : null
    const details = {}

    for (const key of opened.ready ? spec.expand : []) {
      const toggle = page.locator(`[data-cells-fixture="${spec.name}"] tr`).filter({ has: page.locator(`[data-reserve-source="${key}"]`) }).locator('.v-data-table__expand-icon').first()

      try {
        await toggle.click({ timeout: CLICK_WAIT })
      } catch (error) {
        // A toggle that is not on screen is not clicked, and the detail is not read: that is what is observed.
        if (error.name !== 'TimeoutError') {
          throw error
        }

        details[key] = null
        continue
      }

      await page.evaluate(async () => { await window.$app.$nextTick() })
      await page.waitForTimeout(150)
      details[key] = await page.evaluate(readDetail, { name: spec.name, key })
    }

    await page.evaluate(unmountFixture, spec.name)
    out[spec.name] = { ...opened, ...read, details }
  }

  return out
}

const observeScreen = (browser, url, parts) => observe(browser, async ({ page, step }) => {
  step('opening the app')

  const session = await boot(page, url)
  const seen = {}

  if (parts.hauling) {
    step('reading the Hauling page')
    seen.hauling = await haulingPart(session)
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
