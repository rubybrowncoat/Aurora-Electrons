/*
  The pages' own wiring of the capability result, for scripts/check-capabilities.js.

  The consumer checks of that script run on the utilities, mixins and store, which would pass with a page that never asks them. These run the real code of three pages (scripts/lib/page-loader.js: the page's script on a pseudo instance) over the capability results of real saves and altered copies:
  - /lagrange: the unconfirmed lookup rows and the missing ship columns withhold the stabilisation ships and the best ship, and the map's own computed values still evaluate;
  - /commanders: the roster's bonuses of a blocked ID are unknown, its text for one reads as unknown, and the roster queries wait for the check and take the parts for the columns the save has;
  - /production: the research read leaves a scientist's bonus figures unknown when the Research bonus is blocked and leaves the other projects alone, and the colony capacities of the mixin name a blocked Production bonus.
  The terraforming rate of a colony (bonus 9) is built in a computed value of the page that rests on every terraform and naval admin read, and is not driven here.

  Each statement is a check line. Cutting one gate out of one page's script (`MUTATIONS`, a replacement that must apply) must fail at least one statement of that page.
*/
const fs = require('fs')
const { loadPage, replacing, instantiate } = require('./page-loader')

const FLEET = { ShipID: 1, ShipName: 'Surveyor', FleetID: 1, Damaged: 0, CurrentCrew: 100, ClassCrew: 100, ProductionBonus: 1.2, CaptainName: 'Captain' }

const MODIFIERS = { PopulationID: 1, OrdnanceProduction: 2, OverallProductionModifier: 1.5, OrdnanceProductionPower: 3, ShipyardBuildRate: 4, OverallGroundUnitModifier: 6 }

const MUTATIONS = [
  ['lagrange', 'its unverified list is disconnected from the capability check', "return gateGaps(this.$store.getters['capabilities/gates'], { bonuses: [PRODUCTION_BONUS], components: [STABILISATION_COMPONENT] })", "return false ? gateGaps(this.$store.getters['capabilities/gates'], { bonuses: [PRODUCTION_BONUS], components: [STABILISATION_COMPONENT] }) : []"],
  // eslint-disable-next-line no-template-curly-in-string
  ['lagrange', 'its withheld list ignores the missing ship columns', 'return [...this.unverified, ...this.missingShipFields.map((field) => `the save lacks ${field}`)]', 'return [...this.unverified]'],
  ['commanders', 'its roster parses the bonuses without the blocked set', 'parseBonuses(commander.Bonuses, this.blockedBonuses)', 'parseBonuses(commander.Bonuses)'],
  ['logistics', 'its fuel total adds the harvesters that have no figure', 'production: refineries === null || harvesters === null ? null : refineries + harvesters', 'production: (refineries ?? 0) + harvestersKnown'],
  ['logistics', 'its fuel balance ignores an unknown harvested total', 'const fuelNet = fuel.production === null ? null : fuel.production - fuel.high', 'const fuelNet = fuel.refineries === null ? null : (fuel.refineries + fuel.harvestersKnown) - fuel.high'],
  ['logistics', 'its harvester rows are not gated by the blocked Mining bonus', '.then(([items]) => gateHarvesterRows(items, blocked))', '.then(([items]) => items)'],
  ['production', 'its research read leaves the blocked Research bonus alone', 'blocked.has(RESEARCH_BONUS) ? projects.map(', 'false ? projects.map('],
]

// The getters of store/capabilities.js over `result` as a page reads them ('capabilities/gates', ...), and a dispatch that records the actions and answers a check with `answer`.
const storeOver = (store, result, answer = null) => {
  const rootState = { freshness: { generation: 1 } }
  const state = store.state()
  const getters = {}
  const dispatched = []
  const settle = (value) => {
    store.mutations.started(state, { generation: 1, at: 0 })
    store.mutations.settled(state, { result: value, at: 0 })
  }
  const get = (name) => store.getters[name](state, new Proxy({}, { get: (_target, key) => get(key) }), rootState)

  if (result) {
    settle(result)
  }

  Object.keys(store.getters).forEach((name) => Object.defineProperty(getters, `capabilities/${name}`, { get: () => get(name), enumerable: true }))

  return {
    getters,
    dispatched,
    dispatch: async (action) => {
      dispatched.push(action)

      if (answer) {
        settle(answer)
      }

      return answer
    },
  }
}

// A connection that answers each read of a page with the rows `rows(sql)` gives, in the shape Sequelize's `query` has, and records what it was asked.
const cannedDatabase = (rows) => {
  const queries = []

  return { queries, query: async (sql) => { queries.push(sql); return [rows(sql)] } }
}

const lagrangeResults = async (context, fixtures, mutate) => {
  const options = await loadPage('pages/lagrange', { stubs: context.stubs, mutate })
  const results = []
  const holds = (statement, condition) => results.push([statement, Boolean(condition)])
  const page = (result, { database = null, data = {} } = {}) => instantiate(options, { $store: storeOver(context.store, result), database, GameID: 1, RaceID: 2, data: { ships: [FLEET], ...data } })
  const unavailable = (vm) => vm.best.result.status === 'unavailable' && vm.bestShip === null
  const names = (vm, text) => vm.unverified.some((gap) => gap.includes(text))

  const none = page(null)

  holds('with no assessment the lookup rows are unverified, and no best ship is given, naming the lookup', none.unverified.length > 0 && unavailable(none) && none.best.result.inputs.missing.join().includes('lookup rows'))

  const clean = page(fixtures.clean)

  holds('with a clean assessment nothing is unverified or withheld, and the quickest ship is given', clean.unverified.length === 0 && clean.withheld.length === 0 && clean.bestShip !== null && clean.bestShip.ShipName === 'Surveyor')

  const renamed = page(fixtures.renamed5)

  holds('a renamed Production bonus (5) is unverified by its row, and no best ship is given', names(renamed, 'Production') && renamed.unverified.length === 1 && unavailable(renamed))

  const retyped = page(fixtures.retyped29)

  holds('a retyped component type (29) is unverified by its row, and no best ship is given', names(retyped, 'Jump Gate Construction') && retyped.unverified.length === 1 && unavailable(retyped))

  const database = cannedDatabase(() => [])
  const crewless = page(fixtures.noCrew, { database })
  const read = await crewless.runAsync('ships')

  holds('a save without FCT_Ship.CurrentCrew names the field in the missing ship columns, and withholds the ships', crewless.missingShipFields.includes('FCT_Ship.CurrentCrew') && crewless.withheld.some((reason) => reason.includes('FCT_Ship.CurrentCrew')) && crewless.unverified.length === 0)
  holds('a save without FCT_Ship.CurrentCrew gives no best ship, and the ships are not read', unavailable(crewless) && Array.isArray(read) && read.length === 0 && database.queries.length === 0)
  holds('the map of the systems still evaluates while the ships are withheld', Array.isArray(crewless.mapNodes) && Array.isArray(renamed.mapNodes) && Array.isArray(none.mapNodes))

  const whole = cannedDatabase(() => [])

  await page(fixtures.clean, { database: whole }).runAsync('ships')
  holds('with a clean assessment the ships are read', whole.queries.length === 1)

  return results
}

const commandersResults = async (context, fixtures, mutate) => {
  const options = await loadPage('pages/commanders', { stubs: context.stubs, mutate })
  const commanders = context.commanders
  const results = []
  const holds = (statement, condition) => results.push([statement, Boolean(condition)])
  const roster = [{ CommanderID: 1, Name: 'A', CommanderType: 0, Bonuses: '5:1.2,6:1.1', Traits: '' }]
  const page = (result, { store = storeOver(context.store, result) } = {}) => instantiate(options, { $store: store, database: null, GameID: 1, RaceID: 2, data: { commanders: roster, bonusTypes: [] } })

  const blocked = page(fixtures.renamed5)
  const [person] = blocked.people

  holds('the roster has the bonus of a blocked ID (5) unknown, never its stored value, and another one as stored', person.bonuses[5] === null && person.bonuses[6] === 1.1)

  const clean = page(fixtures.clean)

  holds('the roster has the bonus of an ID as stored while no bonus is blocked', clean.people[0].bonuses[5] === 1.2 && clean.people[0].bonuses[6] === 1.1)

  const unknown = commanders.formatBonus(5, 1.2, new Set([5]))

  holds('the text of a blocked bonus reads as unknown, and the text of another one as its value', blocked.bonusText(5, 1.2).endsWith(unknown) && !blocked.bonusText(5, 1.2).includes('20%') && blocked.bonusText(6, 1.1).includes('+10%') && clean.bonusText(5, 1.2).includes('+20%'))

  holds('the roster groups are those of the report of the page, and none before the check answered', clean.rosterGroups.rank === true && clean.rosterGroups.age === true && page(null).rosterGroups === null && page(fixtures.noRank).rosterGroups.rank === false)

  const waitingStore = storeOver(context.store, null, fixtures.noRank)
  const waiting = page(null, { store: waitingStore })
  const parts = await waiting.partsFor(waiting.rosterGroups)
  const expected = commanders.rosterParts({ rank: false, age: true }, { GameID: 1, RaceID: 2 })

  holds('the roster queries wait for the capability check when it has not answered, and take the parts for the columns the save has', waitingStore.dispatched.join() === 'capabilities/preflight' && JSON.stringify(parts) === JSON.stringify(expected) && JSON.stringify(parts) !== JSON.stringify(commanders.rosterParts({ rank: true, age: true }, { GameID: 1, RaceID: 2 })))

  const answeredStore = storeOver(context.store, fixtures.noRank)
  const answered = page(fixtures.noRank, { store: answeredStore })
  const partsKnown = await answered.partsFor(answered.rosterGroups)

  holds('the roster queries do not ask for the check again when it has answered', answeredStore.dispatched.length === 0 && JSON.stringify(partsKnown) === JSON.stringify(expected))

  return results
}

const productionResults = async (context, fixtures, mutate) => {
  const options = await loadPage('pages/production', { stubs: context.stubs, mutate })
  const results = []
  const holds = (statement, condition) => results.push([statement, Boolean(condition)])
  const projects = [
    { ID: 1, PopulationID: 1, ScientistCommandID: 7, CommanderBonus: 1.5, ActualCommanderResearchBonus: 4 },
    { ID: 2, PopulationID: 1, ScientistCommandID: null, CommanderBonus: 1, ActualCommanderResearchBonus: 1 },
  ]
  const database = () => cannedDatabase((sql) => (/^select FCT_ResearchQueue/.test(sql) ? [] : projects.map((project) => ({ ...project }))))
  const page = (result, connection) => instantiate(options, { $store: storeOver(context.store, result), database: connection, GameID: 1, RaceID: 2 })

  const blocked = await page(fixtures.renamed3, database()).runAsync('researches')

  holds('with the Research bonus (3) blocked a project with a scientist has its bonus figures unknown', blocked.projects.length === 2 && blocked.projects[0].CommanderBonus === null && blocked.projects[0].ActualCommanderResearchBonus === null)
  holds('with the Research bonus (3) blocked a project without a scientist is as read', JSON.stringify(blocked.projects[1]) === JSON.stringify(projects[1]))

  const clean = await page(fixtures.clean, database()).runAsync('researches')

  holds('with no bonus blocked the research projects are as read', JSON.stringify(clean.projects) === JSON.stringify(projects))

  const withheld = await page(null, database()).runAsync('researches')

  holds('with no assessment a project with a scientist has its bonus figures unknown', withheld.projects[0].CommanderBonus === null)

  const capacity = (result) => page(result, null).populationCapacityResult(1, 'ordnance')
  const modifiers = { 1: MODIFIERS }
  const withModifiers = (result) => instantiate(options, { $store: storeOver(context.store, result), database: null, GameID: 1, RaceID: 2, data: { populationProductionModifiers: modifiers } }).populationCapacityResult(1, 'ordnance')

  holds('a colony capacity with the Production bonus (5) blocked is unavailable and names that bonus', withModifiers(fixtures.renamed5).status === 'unavailable' && withModifiers(fixtures.renamed5).inputs.missing.join().includes('commander bonus 5'))
  holds('a colony capacity with no bonus blocked is the product of its modifiers', withModifiers(fixtures.clean).value === 9)
  holds('a colony capacity of a colony the read does not cover is unavailable', capacity(fixtures.clean).status === 'unavailable')

  const modifierRead = cannedDatabase(() => [{ ...MODIFIERS }])
  const gated = await page(fixtures.renamed5, modifierRead).runAsync('populationProductionModifiers')

  holds('the page has the modifier column of a blocked bonus (5) unknown in the read of the colonies', gated[1].OverallProductionModifier === null && gated[1].ShipyardBuildRate === 4)

  return results
}

// A harvester at a surveyed deposit with room in its tanks, as the page's query gives it.
const HARVESTER = { ClassCrew: 100, CurrentCrew: 100, Harvesters: 10, ClassHarvesters: 10, FuelProduction: 40000, MiningBonus: 1, SoriumAccessibility: 1, SoriumAmount: 1000, Surveyed: 1, SystemBodyID: 1, Fuel: 0, FuelCapacity: 1000000, SystemID: 5, NavalAdminCommandID: 0, FleetName: 'Tankers', ShipName: 'Harvester' }

const logisticsResults = async (context, fixtures, mutate) => {
  const options = await loadPage('pages/logistics', { stubs: context.stubs, mutate })
  const results = []
  const holds = (statement, condition) => results.push([statement, Boolean(condition)])
  const ships = [{ ...HARVESTER, ShipID: 1 }, { ...HARVESTER, ShipID: 2, SystemBodyID: 2 }]
  const page = async (result) => {
    const vm = instantiate(options, { $store: storeOver(context.store, result), database: cannedDatabase((sql) => (/Harvesters/.test(sql) ? ships.map((ship) => ({ ...ship })) : [])), GameID: 1, RaceID: 2, data: { navalAdmins: {} } })

    await vm.runAsync('harvesters')

    return vm
  }
  const fuelTile = (vm) => vm.tiles.find((tile) => tile.label === 'Fuel per year')

  const clean = await page(fixtures.clean)

  holds('with no bonus blocked the harvesters make a fuel total, a net and a runway the page shows', clean.fuelTotals.harvestersUnknown === 0 && Number.isFinite(clean.fuelTotals.production) && clean.fuelTotals.production > 0 && /^[+−]/.test(fuelTile(clean).value))

  const renamed = await page(fixtures.renamed6)
  const totals = renamed.fuelTotals
  const tile = fuelTile(renamed)

  holds('with the Mining bonus (6) blocked every harvester is unknown, naming the lookup', totals.harvestersUnknown === 2 && totals.harvestersGaps.some((gap) => gap.includes('commander bonus 6')) && renamed.harvesterRows.every((row) => row.obtainableLitres === null))
  holds('with the Mining bonus (6) blocked the harvested fuel and the fuel made are unavailable, not the known share', totals.harvesters === null && totals.production === null && totals.harvestersKnown === 0)
  holds('with the Mining bonus (6) blocked the fuel balance has no net and no runway, and names the lookup', tile.value === '—' && !/lasts/.test(tile.note) && tile.note.includes('commander bonus 6'))
  holds('with the Mining bonus (6) blocked the stock and the burn are as without', renamed.fuelTotals.stock === clean.fuelTotals.stock && renamed.fuelTotals.high === clean.fuelTotals.high)

  return results
}

const PAGE_RESULTS = { lagrange: lagrangeResults, commanders: commandersResults, production: productionResults, logistics: logisticsResults }

// The pages' wiring on the real page code (every statement a check line) and, with one gate cut out of a page's script, on mutants that must fail. `context`: { mods: the utilities the script loaded, stubs, source, check, alteredCopy, preflightOf, capabilities }.
const pageChecks = async ({ mods, stubs, source, check, alteredCopy, preflightOf }) => {
  const copies = []
  const context = { stubs, store: mods['../store/capabilities'], commanders: mods.commanders }
  const copy = async (name, statements) => {
    const file = await alteredCopy(source, `page-${name}`, statements)

    copies.push(file)

    return (await preflightOf(mods.capabilities, file)).result
  }

  try {
    const fixtures = {
      clean: (await preflightOf(mods.capabilities, source)).result,
      renamed5: await copy('bonus5', ["update DIM_CommanderBonusType set Description = 'Output' where BonusID = 5"]),
      renamed3: await copy('bonus3', ["update DIM_CommanderBonusType set Description = 'Output' where BonusID = 3"]),
      retyped29: await copy('component29', ["update DIM_ComponentType set TypeDescription = 'Jump Gate Construction' where ComponentTypeID = 29"]),
      noCrew: await copy('crew', ['alter table FCT_Ship drop column CurrentCrew']),
      noRank: await copy('rank', ['alter table FCT_Commander drop column RankID']),
      renamed6: await copy('bonus6', ["update DIM_CommanderBonusType set Description = 'Mineral Extraction' where BonusID = 6"]),
    }

    for (const [page, run] of Object.entries(PAGE_RESULTS)) {
      for (const [statement, held] of await run(context, fixtures)) {
        check(`pages: /${page}: ${statement}`, held)
      }
    }

    for (const [page, label, from, to] of MUTATIONS) {
      const broken = (await PAGE_RESULTS[page](context, fixtures, replacing(from, to))).filter(([, held]) => !held).map(([statement]) => statement)

      check(`pages: a copy of ${page}.vue in which ${label} fails a page check`, broken.length > 0)
    }
  } finally {
    copies.forEach((file) => fs.rmSync(file, { force: true }))
  }
}

module.exports = { pageChecks }
