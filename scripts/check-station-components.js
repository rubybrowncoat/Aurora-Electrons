/*
  Checks what the Industry tab shows of the stored components of a Light Naval or Space Station project and of a shipyard task's Use Components box, and the floor of every projected mineral balance: the credit lines under a Light Naval or Space Station job (utilities/production.js `componentCredit`, `creditLines`, `useOf`), the box lines under a construction, refit or automatic refit task (`taskUseComponents`, `boxLines`), the page that draws them (pages/production.vue) and the cycle forecast's debit of the minerals (utilities/industry-cycle.js `buildCycle`).

  Run: bun scripts/check-station-components.js [--no-mutations]

  The rules are the game's, read from the 3.1.0 source and written here, never read from the modules, and every figure is source-derived: no played save holds a Light Naval or Space Station project made from stored components with its Use Components box known (the owner's decision Q7 of AE-31: game-shaped planted cases stand in), so each case plants rows into in-memory copies of the migrated fixture (scripts/lib/fixtures.js, game 141, race 784), as scripts/check-industry-projects.js does, with the project made by an oracle of the game's own creation (`Population.method_147`, Population.cs:7104-7198, and `Population.method_37`, Population.cs:3059-3104):
  - the project's cost a unit starts as the class's cost and its minerals as the class's, and each component the class mounts is looked at in the colony's stock against the whole batch (`NumComponent * Amount`); a component of technology the race holds (a RaceTech row) is taken only when the Use Components box is Checked and the stock covers the batch, a component of alien technology is taken whenever the stock covers it and refuses the project when it does not (Population.cs:3066-3082);
  - each component taken lowers the cost a unit by its cost times its count and the minerals by its minerals times its count, and takes the batch from the stock (Population.cs:3083-3092);
  - a unit never costs less than 1 BP (Population.cs:3093-3095);
  - `Population.ProcessIndustrialProjects` builds a project at its share of the capacity of its kind, a Space Station on construction and a Light Naval project on its own light naval capacity;
  - `MineralData.SubtractIndustrialProjectMinerals` (MineralData.cs:994-1011) floors each mineral balance at 0 after the debit (the helper `MineralData.method_0`, MineralData.cs:37), as `SubtractShipyardTaskMinerals` (MineralData.cs:1017) and `SubtractScaledMinerals` (MineralData.cs:1043) do;
  - a shipyard task stores the box as the player left it (`Shipyard.cs:287`) and a repeat or an automatic refit copies it (Population.cs:2020 and 1921).
  The checks:
  - `credit`: `componentCredit`, `creditedCost` and `creditLines` on hand-worked classes: the credit is the class's cost less the stored cost, held at the 1 BP floor, and what the stored cost shows of the box (components of researched technology taken where the credit goes past the components alien now, which a research made since explains as well as a ticked box; the box untold at the alien-only cost; nothing for the box to decide where the class mounts nothing of researched technology; unexplained for a cost the components cannot give; unknown where the save leaves a count, a cost or the research of a component) with the minerals credited;
  - `stations`: the Production page on a copy with Space Station projects made by the oracle (box ticked with alien components and a partly covered stock, box not ticked, every component in stock so the unit costs the floor, an alien component the stock does not cover so the game refuses the project): the lines under each job, its rate and its date, against what the oracle stored;
  - `lights`: the same for Light Naval projects (alien crew quarters, box ticked and not, every component so the floor holds);
  - `plain`: classes with no alien component, a stock a hair under a whole batch, and a ticked box credited only as far as the stock covers;
  - `transition`: a project of 80 BP whose one component of 20 was alien when the box was off and is researched now: the stored 60 reads as components of researched technology taken, which a research since explains as well as a ticked box, and never as a box ticked, since the box was off;
  - `odd`: a stored cost above the class's, which no components give, is shown with both costs and no credit to tell, its box line saying the box cannot be told, and a class the save lacks is said so;
  - `box`: the box of a construction, refit and automatic refit task as stored (1 ticked, 0 not, a NULL or other value not stored) and no line for a repair or a scrap;
  - `render`: the name cell of the jobs draws each line in an element marked data-use-components and none for a job without one;
  - `cycle`: the forecast leaves 0, never a negative balance, of a mineral whose stock a rounded build overran (and the next arrival lands on 0);
  - `floors`: the stock projection of the Minerals page, the free stock of a colony and the MSP run on a stock it exhausts never go below 0;
  - `registry`: the rules of the credit and the box are of the line and the finish of an industrial project is too;
  - `text`: the panel foot, the lines and the rule notes are in the impersonal voice with no release number.
  Where the source does not give a rule the check does not guess it: the Use Components box of an industrial project is not stored (FCT_IndustrialProjects has no such column) and the race's research is read as it now stands, so a component that was alien when the project was made and is researched since cannot be told from one researched then; what a project's stored cost shows of the box is checked only as far as it proves which components were taken, never as the box's setting.

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { renderTree, treeOf, attrsOf } = require('./lib/vue-render')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { FIXTURE } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const SAVE = FIXTURE.file
const GAME = FIXTURE.gameId
const RACE = FIXTURE.raceId
const NEAR = 1e-9
const DAYS_PER_YEAR = 365

const renderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)
const FILES = {
  production: renderer('utilities', 'production.js'),
  cycle: renderer('utilities', 'industry-cycle.js'),
  minerals: renderer('utilities', 'minerals.js'),
  glossary: renderer('utilities', 'glossary.js'),
  productionPage: renderer('pages', 'production.vue'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

// The utilities each text stands for, by the name `loadUtilities` loads them under, and the pages with the utilities they import, by the name `loadPage` loads them under.
const UTILITY_NAMES = { production: 'production', cycle: 'industry-cycle', minerals: 'minerals', glossary: 'glossary' }
const PAGE_SOURCES = { productionPage: 'pages/production' }

// The packages the utilities and pages import, as the least the checks need of them: no date or numeral is formatted here. The store of a page is the one of its tests (the namespaced getters of the capability store included).
const VUEX = `
  const pairs = (list) => (Array.isArray(list) ? list.map((name) => [name, name]) : Object.entries(list))
  export const mapGetters = (namespace, list) => { const prefix = typeof namespace === 'string' ? namespace + '/' : ''; const map = typeof namespace === 'string' ? list : namespace; return Object.fromEntries(pairs(map).map(([key, name]) => [key, function () { return this.$store.getters[prefix + name] }])) }
  export const mapState = (namespace, list) => (typeof namespace === 'string' ? Object.fromEntries(pairs(list).map(([key, name]) => [key, function () { return this.$store.state[namespace][name] }])) : Object.fromEntries(pairs(namespace).map(([key, name]) => [key, function () { return this.$store.state[name] }])))
  export const mapActions = (list) => Object.fromEntries(pairs(list).map(([key, name]) => [key, function (...args) { return this.$store.dispatch(name, ...args) }]))
`
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
  vuex: VUEX,
}
const PAGE_MODULES = {
  'components/navigation/section-style': 'export const sectionStyle = () => ({})',
  'components/research/status-style': 'export const statusStyle = () => ({})',
  'mixins/persisted-view': 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults }); export default (fields) => ({ data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) })',
  'mixins/load-state': null,
}
const STORE = { $store: { getters: { 'capabilities/blockedBonuses': new Set() }, state: { empires: { games: [] } }, dispatch: async () => {} } }

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= NEAR * Math.max(1, Math.abs(a), Math.abs(b))

const adapterOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })

// ---- The modules and the page as shipped, or with edits planted ----------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

// The Production page on a planted copy, its own reads run and its forecast started, with the capacity of every colony of the fixture given (the page reads it through the capability report of the app).
const MODIFIERS = { ConstructionProduction: 100, OverallProductionModifier: 1, ConstructionPower: 1, GroundConstructionPower: 0, OrdnanceProduction: 10, OrdnanceProductionPower: 1, FighterProduction: 40, FighterProductionPower: 1, MinConstructionPeriod: 86400 }
const CAPACITY = { construction: 100, fighter: 40 }
const COLONIES = [48977, 48979, 48980, 48981, 48982, 49051]

const worldOf = (texts = { ...ORIGINALS }) => {
  const utilitySources = Object.fromEntries(Object.entries(UTILITY_NAMES).map(([key, name]) => [name, texts[key]]))
  const pageSources = { ...Object.fromEntries(Object.entries(PAGE_SOURCES).map(([key, name]) => [name, texts[key]])), ...Object.fromEntries(Object.entries(UTILITY_NAMES).map(([key, name]) => [`utilities/${name}`, texts[key]])) }
  const production = memo(() => loadPage('pages/production', { stubs: STUBS, modules: PAGE_MODULES, sources: pageSources }))
  const vms = new Map()

  return {
    texts,
    modules: memo(() => loadUtilities([...Object.values(UTILITY_NAMES), 'provenance', 'decimal', 'colony-minerals', 'msp-supply', 'production-types'], { stubs: STUBS, sources: utilitySources })),
    production,
    async pageOn (copy) {
      if (!vms.has(copy)) {
        vms.set(copy, (async () => {
          const options = await production()
          const populations = Object.fromEntries(COLONIES.map((id) => [id, { PopName: `Colony ${id}`, ...MODIFIERS }]))
          const vm = instantiate(options, { ...STORE, database: adapterOf(copyOf(copy).database), GameID: GAME, RaceID: RACE, data: { populationProductionModifiers: populations, arrivals: [] } })

          await vm.runAsync('industry')
          await vm.runAsync('componentSources')
          await vm.runAsync('ships')
          await vm.startForecast()

          return vm
        })())
      }

      return await vms.get(copy)
    },
  }
}

// ---- The fixture, as in-memory copies -------------------------------------------------------------------------------
const MINERAL_NAMES = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']

const literal = (value) => (typeof value === 'string' ? `'${value.replace(/'/g, '\'\'')}'` : String(value))

// A copy of the row of `table` with `key` equal to `from`, every column kept but those of `over`.
const cloneRow = (database, table, key, from, over) => {
  const names = database.query(`select name from pragma_table_info('${table}')`).all().map((row) => row.name)
  const select = names.map((name) => (Object.prototype.hasOwnProperty.call(over, name) ? literal(over[name]) : `"${name}"`)).join(', ')

  database.run(`insert into ${table} (${names.map((name) => `"${name}"`).join(', ')}) select ${select} from ${table} where ${key} = ${from}`)
}

// The wealth use `Population.method_147` (Population.cs:7104-7198) gives a project: GEnum90 const_2 (DIM_WealthUse 3, Fighter Production) for Light Naval and const_24 (45, Orbital Habitat Construction) for a Space Station. The type of each by `AuroraProductionType`.
const LIGHT_NAVAL = 2
const SPACE_STATION = 4
const WEALTH_OF = { [LIGHT_NAVAL]: 3, [SPACE_STATION]: 45 }
const KIND_OF = { [LIGHT_NAVAL]: 'fighter', [SPACE_STATION]: 'construction' }
const TYPE_NAMES = { [LIGHT_NAVAL]: 'Light Naval', [SPACE_STATION]: 'Space station' }

// What the save holds of a class, the way the game's own lists hold it: its cost and its components with the cost and minerals each, and whether the race holds the component (a RaceTech row).
const classOf = (database, classId) => {
  const head = database.query(`select ClassName, Cost from FCT_ShipClass where ShipClassID = ${classId}`).get()
  const parts = database.query(`select FCT_ClassComponent.ComponentID as id, FCT_ClassComponent.NumComponent as count, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.Cost, ${MINERAL_NAMES.map((name) => `FCT_ShipDesignComponents.${name}`).join(', ')}, (select count(*) from FCT_RaceTech where FCT_RaceTech.TechID = FCT_ClassComponent.ComponentID and FCT_RaceTech.RaceID = ${RACE}) as researched from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = ${classId} order by FCT_ClassComponent.ComponentID`).all()
  const minerals = Object.fromEntries(MINERAL_NAMES.map((name) => [name, parts.reduce((sum, part) => sum + part.count * part[name], 0)]))

  return { ...head, parts, minerals }
}

const stockOf = (database, population, id) => {
  const row = database.query(`select Amount from FCT_PopComponent where PopulationID = ${population} and ComponentID = ${id}`).get()

  return row ? row.Amount : 0
}

// The game's creation of a Light Naval or Space Station project from the colony's stock (`Population.method_37`, Population.cs:3059-3104): null where it refuses (a component of alien technology the stock does not cover for the whole batch), otherwise what the project stores and what it took from the stock, which the copy's stock then holds. `ticked`: the Use Components box.
const createProject = (database, { population, classId, amount, ticked }) => {
  const cls = classOf(database, classId)
  const taken = []

  for (const part of cls.parts) {
    const covered = stockOf(database, population, part.id) >= part.count * amount

    if (part.researched > 0) {
      if (ticked && covered) {
        taken.push(part)
      }
    } else if (covered) {
      taken.push(part)
    } else {
      return null
    }
  }

  let cost = cls.Cost
  const minerals = { ...cls.minerals }

  for (const part of taken) {
    cost -= part.Cost * part.count
    MINERAL_NAMES.forEach((name) => { minerals[name] -= part[name] * part.count })

    const left = stockOf(database, population, part.id) - part.count * amount

    database.run(`delete from FCT_PopComponent where PopulationID = ${population} and ComponentID = ${part.id}`)

    if (left > 0) {
      database.run(`insert into FCT_PopComponent (ComponentID, PopulationID, GameID, Amount) values (${part.id}, ${population}, ${GAME}, ${left})`)
    }
  }

  const floored = cost < 1

  return {
    class: cls,
    classCost: cls.Cost,
    storedCost: floored ? 1 : cost,
    floored,
    minerals: Object.fromEntries(MINERAL_NAMES.map((name) => [name, Math.abs(minerals[name]) < 1e-9 ? 0 : minerals[name]])),
    tookResearched: taken.some((part) => part.researched > 0),
    alien: cls.parts.filter((part) => part.researched === 0).reduce((sum, part) => sum + part.Cost * part.count, 0),
  }
}

// A project row as `Game.SaveIndustrialProjects` writes it (Game.cs:11479-11546: the 28 columns ProjectID, GameID, RaceID, PopulationID, SpeciesID, Percentage, ProductionType, ProductionID, RefitClassID, WealthUse, Amount, PartialCompletion, ProdPerUnit, Description, Pause, Queue, FuelRequired and the eleven minerals), the ProductionID the class (`Population.method_147`), nothing built yet and the colony's species.
const insertProject = (database, row) => {
  const species = database.query(`select SpeciesID from FCT_Population where PopulationID = ${row.population}`).get().SpeciesID
  const columns = ['ProjectID', 'GameID', 'RaceID', 'PopulationID', 'SpeciesID', 'Percentage', 'ProductionType', 'ProductionID', 'RefitClassID', 'WealthUse', 'Amount', 'PartialCompletion', 'ProdPerUnit', 'Description', 'Pause', 'Queue', 'FuelRequired', ...MINERAL_NAMES]
  const values = [row.id, GAME, RACE, row.population, species, row.percentage, row.type, row.item, 0, WEALTH_OF[row.type], row.amount, 0, row.perUnit, row.description, 0, 0, 0, ...MINERAL_NAMES.map((name) => row.minerals[name] || 0)]

  database.run(`insert into FCT_IndustrialProjects (${columns.join(', ')}) values (${values.map(literal).join(', ')})`)
}

// The projects of a copy: the components of alien technology (their RaceTech rows deleted), each case's stock put in the colony (every component the class mounts reset to what the case says), and the project made by the game's creation. A case the game refuses leaves no project. Gives the case with what the oracle stored.
const plantCases = (database, { alien = [], cases }) => {
  alien.forEach((id) => database.run(`delete from FCT_RaceTech where RaceID = ${RACE} and TechID = ${id}`))

  return cases.map((spec) => {
    const cls = classOf(database, spec.classId)
    const stock = spec.stock === 'all' ? Object.fromEntries(cls.parts.map((part) => [part.id, part.count * spec.amount])) : spec.stock

    cls.parts.forEach((part) => database.run(`delete from FCT_PopComponent where PopulationID = ${spec.population} and ComponentID = ${part.id}`))
    Object.entries(stock).forEach(([id, amount]) => database.run(`insert into FCT_PopComponent (ComponentID, PopulationID, GameID, Amount) values (${id}, ${spec.population}, ${GAME}, ${amount})`))

    const made = createProject(database, spec)

    if (made) {
      insertProject(database, { id: spec.id, population: spec.population, type: spec.type, item: spec.classId, percentage: spec.percentage, amount: spec.amount, perUnit: made.storedCost, description: cls.ClassName, minerals: made.minerals })
    }

    return { ...spec, made }
  })
}

const PROBE = 63063
const STATION = 63078
const PROBE_SHELL = 0.100397705773427 * 3
// The component ids of the two classes the cases use.
const BRIDGE = 18
const ENGINEERING = 25147
const CREW_FIGHTER = 62453
const CREW_SMALL = 26265
const DEFLECTOR = 500410
const REFLECTOR = 500457

const CASES = {
  stations: {
    alien: [DEFLECTOR, REFLECTOR],
    cases: [
      { id: 9601, population: 48977, type: SPACE_STATION, classId: STATION, amount: 2, percentage: 50, ticked: true, stock: { [DEFLECTOR]: 3, [REFLECTOR]: 10, [ENGINEERING]: 94, [CREW_SMALL]: 8, [BRIDGE]: 1 }, note: 'ticked, a batch of 2: the alien Deflector Array and Solar Reflectors, the Engineering Spaces and the Crew Quarters that the stock covers, and a Bridge it does not' },
      { id: 9602, population: 48979, type: SPACE_STATION, classId: STATION, amount: 2, percentage: 100, ticked: false, stock: { [DEFLECTOR]: 2, [REFLECTOR]: 10, [ENGINEERING]: 94, [CREW_SMALL]: 8, [BRIDGE]: 2 }, note: 'not ticked, the same stock: only the alien components are credited' },
      { id: 9603, population: 48981, type: SPACE_STATION, classId: STATION, amount: 1, percentage: 100, ticked: true, stock: 'all', note: 'ticked with every component in stock: the unit costs the 1 BP floor' },
      { id: 9604, population: 48982, type: SPACE_STATION, classId: STATION, amount: 2, percentage: 50, ticked: true, stock: { [DEFLECTOR]: 1, [ENGINEERING]: 94 }, refused: true, note: 'an alien Deflector Array the stock does not cover for the batch: the game refuses the project' },
    ],
  },
  lights: {
    alien: [CREW_FIGHTER],
    cases: [
      { id: 9611, population: 48979, type: LIGHT_NAVAL, classId: PROBE, amount: 3, percentage: 50, ticked: true, stock: { [BRIDGE]: 3, [CREW_FIGHTER]: 3 }, note: 'ticked: the Bridge and the alien Crew Quarters' },
      { id: 9612, population: 48980, type: LIGHT_NAVAL, classId: PROBE, amount: 3, percentage: 50, ticked: false, stock: { [BRIDGE]: 3, [CREW_FIGHTER]: 3, [ENGINEERING]: 3 }, note: 'not ticked: only the alien Crew Quarters, the stock of the others left alone' },
      { id: 9613, population: 48977, type: LIGHT_NAVAL, classId: PROBE, amount: 3, percentage: 50, ticked: true, stock: 'all', note: 'ticked with every component in stock: the unit costs the 1 BP floor' },
    ],
  },
  plain: {
    alien: [],
    cases: [
      { id: 9621, population: 48977, type: LIGHT_NAVAL, classId: PROBE, amount: 3, percentage: 50, ticked: true, stock: { [BRIDGE]: 3 }, note: 'ticked, no alien component: the Bridge alone is credited' },
      { id: 9622, population: 48979, type: LIGHT_NAVAL, classId: PROBE, amount: 3, percentage: 50, ticked: false, stock: { [BRIDGE]: 3, [ENGINEERING]: 3 }, note: 'not ticked, no alien component: nothing is credited' },
      { id: 9623, population: 48981, type: SPACE_STATION, classId: STATION, amount: 1, percentage: 50, ticked: true, stock: { [BRIDGE]: 1, [ENGINEERING]: 47, [REFLECTOR]: 5 }, note: 'a station, ticked: the Bridge, the Engineering Spaces and the Solar Reflectors' },
      { id: 9624, population: 48980, type: LIGHT_NAVAL, classId: PROBE, amount: 3, percentage: 50, ticked: true, stock: { [BRIDGE]: 2.9999 }, note: 'ticked, a Bridge stock a hair under the batch: nothing is credited' },
      { id: 9625, population: 48982, type: LIGHT_NAVAL, classId: PROBE, amount: 3, percentage: 50, ticked: true, stock: { [BRIDGE]: 3, [ENGINEERING]: 3, [CREW_FIGHTER]: 3, 65275: PROBE_SHELL }, note: 'ticked, every component to the last fraction of the Structural Shell: the unit costs the 1 BP floor' },
    ],
  },
}

// What the page says of a project that no components explain or whose class the save lacks.
const ODD_UNEXPLAINED = 9631
const ODD_MISSING = 9632

// Terra's example: a class of 80 BP with one component of 20, alien and taken when the project was made with the box off, and researched since.
const TRANSITION_CLASS = 63099
const TRANSITION = 9641
const TRANSITION_POPULATION = 48977

const PLANTS = {
  intact: () => ({}),
  stations: (database) => ({ planted: plantCases(database, CASES.stations) }),
  lights: (database) => ({ planted: plantCases(database, CASES.lights) }),
  plain: (database) => ({ planted: plantCases(database, CASES.plain) }),
  transition: (database) => {
    // The Probe's class with its other components dropped costs 80 BP and mounts one component of 20 (the Bridge). Its research row is deleted first, so the Bridge is alien when the project is made with the box off, whose stock covers the batch: the game takes an alien component whatever the box says and stores 60. The research row then comes back, as if the race had researched the Bridge while the project waited.
    cloneRow(database, 'FCT_ShipClass', 'ShipClassID', PROBE, { ShipClassID: TRANSITION_CLASS, ClassName: 'Transition Probe', Cost: 80 })
    cloneRow(database, 'FCT_ClassComponent', 'ClassID', PROBE, { ClassID: TRANSITION_CLASS })
    database.run(`delete from FCT_ClassComponent where ClassID = ${TRANSITION_CLASS} and ComponentID <> ${BRIDGE}`)
    database.run(`delete from FCT_RaceTech where RaceID = ${RACE} and TechID = ${BRIDGE}`)
    database.run(`delete from FCT_PopComponent where PopulationID = ${TRANSITION_POPULATION} and ComponentID = ${BRIDGE}`)
    database.run(`insert into FCT_PopComponent (ComponentID, PopulationID, GameID, Amount) values (${BRIDGE}, ${TRANSITION_POPULATION}, ${GAME}, 3)`)

    const made = createProject(database, { population: TRANSITION_POPULATION, classId: TRANSITION_CLASS, amount: 3, ticked: false })

    if (made) {
      insertProject(database, { id: TRANSITION, population: TRANSITION_POPULATION, type: LIGHT_NAVAL, item: TRANSITION_CLASS, percentage: 50, amount: 3, perUnit: made.storedCost, description: 'Transition Probe', minerals: made.minerals })
    }

    database.run(`insert into FCT_RaceTech (GameID, TechID, RaceID, Obsolete) values (${GAME}, ${BRIDGE}, ${RACE}, 0)`)

    return { made, ticked: false }
  },
  odd: (database) => {
    const station = classOf(database, STATION)

    insertProject(database, { id: ODD_UNEXPLAINED, population: 48977, type: SPACE_STATION, item: STATION, percentage: 50, amount: 1, perUnit: 12000, description: station.ClassName, minerals: station.minerals })
    insertProject(database, { id: ODD_MISSING, population: 48979, type: LIGHT_NAVAL, item: 99999999, percentage: 50, amount: 2, perUnit: 40, description: 'Gone', minerals: {} })

    return { station }
  },
  tasks: (database) => {
    // The fixture's four construction tasks (ids 1 to 4) take the box and the task type; five more are cloned from the first: a repair and a scrap with a box ticked, a construction with no box stored and one with a value that is no flag, and a refit with the box ticked.
    database.run('update FCT_ShipyardTask set UseComponents = 1 where TaskID = 1')
    database.run('update FCT_ShipyardTask set TaskTypeID = 2, UseComponents = 0 where TaskID = 2')
    database.run('update FCT_ShipyardTask set TaskTypeID = 4, UseComponents = 1 where TaskID = 3')
    database.run('update FCT_ShipyardTask set TaskTypeID = 4, UseComponents = 0 where TaskID = 4')
    cloneRow(database, 'FCT_ShipyardTask', 'TaskID', 1, { TaskID: 5, TaskTypeID: 1, UseComponents: 1 })
    cloneRow(database, 'FCT_ShipyardTask', 'TaskID', 1, { TaskID: 6, TaskTypeID: 3, UseComponents: 0 })
    cloneRow(database, 'FCT_ShipyardTask', 'TaskID', 1, { TaskID: 7, TaskTypeID: 0 })
    database.run('update FCT_ShipyardTask set UseComponents = null where TaskID = 7')
    cloneRow(database, 'FCT_ShipyardTask', 'TaskID', 1, { TaskID: 8, TaskTypeID: 0, UseComponents: 2 })
    cloneRow(database, 'FCT_ShipyardTask', 'TaskID', 1, { TaskID: 9, TaskTypeID: 2, UseComponents: 1 })

    return {}
  },
}
let BYTES = null
const COPIES = new Map()

const copyOf = (name) => {
  if (!PLANTS[name]) {
    throw new Error(`no planted copy named ${name}`)
  }

  if (!COPIES.has(name)) {
    BYTES = BYTES || fs.readFileSync(path.join(root, SAVE))

    const database = Database.deserialize(BYTES)
    const facts = PLANTS[name](database) || {}

    COPIES.set(name, { database, facts })
  }

  return COPIES.get(name)
}

const closeCopies = () => {
  COPIES.forEach(({ database }) => database.close())
  COPIES.clear()
}

// ---- What the page should say, from what the oracle stored ---------------------------------------------------------
// The figure as the page words it: whole numbers as they are, others to two decimals, in the page's own numerals.
const figureOf = (vm) => (value) => vm.count(value, Number.isInteger(value) ? 0 : 2)

const BOX_RESEARCHED = 'Components of researched technology were taken: a ticked Use Components box allows that, and a component researched after the project was made explains the same credit, so the box\'s state cannot be told from the cost'
const BOX_UNTOLD_NONE = 'The Use Components box is not stored with the project: with nothing credited, the cost cannot tell whether the box was not ticked or the stock did not cover a whole batch of a component of researched technology'

// The lines the page shows under a project the oracle made: the credit against the class's cost, the minerals, what it saves at the project's rate and what it says of the box.
const expectedLines = (vm, fact, rate) => {
  const figure = figureOf(vm)
  const { made } = fact
  const credit = made.classCost - made.storedCost
  const lines = []

  lines.push(credit > 0 ? `Stored components credited ${figure(credit)} BP of the class's ${figure(made.classCost)} BP a unit, so the project costs ${figure(made.storedCost)} BP a unit${made.floored ? ', held at the 1 BP floor' : ''}` : `No stored components credited: the project costs the class's ${figure(made.classCost)} BP a unit`)

  const credited = MINERAL_NAMES.map((name) => ({ name, tonnes: made.class.minerals[name] - made.minerals[name] })).filter((mineral) => mineral.tonnes > 1e-6)

  if (credited.length) {
    lines.push(`Minerals credited a unit: ${credited.map((mineral) => `${mineral.name} ${figure(mineral.tonnes)} t`).join(', ')}`)
  }

  if (credit > 0) {
    lines.push(`At the project's rate the credit saves ${figure(credit * fact.amount)} BP over the ${figure(fact.amount)} units left, ${vm.duration(credit * fact.amount / rate * DAYS_PER_YEAR)}`)
  }

  if (made.tookResearched) {
    lines.push(made.alien > 0 ? `The credit goes beyond the ${figure(made.alien)} BP a unit that the class's alien components give alone, so components of researched technology were taken: a ticked Use Components box allows that, and a component researched after the project was made explains the same credit, so the box's state cannot be told from the cost` : BOX_RESEARCHED)
  } else if (made.alien > 0) {
    lines.push(`The Use Components box is not stored with the project: the credit is what the class's alien components give (${figure(made.alien)} BP a unit), taken whether the box is ticked or not, so the box's state cannot be told from the cost`)
  } else {
    lines.push(BOX_UNTOLD_NONE)
  }

  return lines
}

// The days the game takes to build `amount` units of `perUnit` BP at `perYear` BP a year with the colony's cycle of one day and no stock short: each cycle builds the units its share buys (`perYear` over the 365 days, over the cost of a unit) rounded to 4 decimals (`Population.ProcessIndustrialProjects` keeps the build to 4 decimals), so a unit that costs much more than a cycle buys is built in a coarse step; Infinity where a cycle builds nothing.
const gameDays = (amount, perUnit, perYear) => {
  const units = Math.round(perYear / DAYS_PER_YEAR / perUnit * 1e4) / 1e4

  return units > 0 ? Math.ceil(amount / units - 1e-9) : Infinity
}

// The planted projects of a copy against the page: every made project is a job named by its type that builds at its share of the capacity of its kind, with the lines the oracle's figures give, and the date the game's rounded build gives for its stored cost, no later than the class's own cost would give; a project the game refused is no job.
const checkPlanted = async (w, copy, { credited }) => {
  const vm = await w.pageOn(copy)
  const { planted } = copyOf(copy).facts

  for (const fact of planted) {
    const job = vm.industryJobs.find((one) => one.key === `industry-${fact.id}`)
    const where = `${copy} ${fact.id} (${fact.note})`

    if (fact.refused) {
      assert.equal(fact.made, null, `${where}: the game refuses the project`)
      assert.ok(!job, `${where}: no job is shown`)
      continue
    }

    assert.ok(fact.made, `${where}: the game makes the project`)
    assert.ok(job, `${where}: the project is a job`)
    assert.equal(job.detail, TYPE_NAMES[fact.type], `${where}: named by its type`)

    const rate = CAPACITY[KIND_OF[fact.type]] * fact.percentage / 100

    assert.ok(near(job.rateResult.value, rate), `${where}: builds ${rate} BP/yr, not ${job.rateResult.value}`)
    assert.deepEqual(job.components, expectedLines(vm, fact, rate), `${where}: the lines under the job`)

    const credit = fact.made.classCost - fact.made.storedCost

    assert.ok(job.componentResult && near(job.componentResult.value, credit), `${where}: the mark of the credit says ${credit} BP, not ${job.componentResult && job.componentResult.value}`)
    assert.equal(job.componentResult.rule.id, 'production.componentCredit', `${where}: the mark names the rule of the credit`)
    assert.ok(job.useResult && job.useResult.rule.id === 'production.useComponents', `${where}: the box line is marked with the rule of the box`)
    assert.equal(job.useResult.status, 'unavailable', `${where}: and no figure, since the stored cost never tells the box`)
    assert.ok(job.useResult.assumptions.some((assumption) => /the race's current research/.test(assumption)), `${where}: with the research it cannot date named`)

    const expected = gameDays(fact.amount, fact.made.storedCost, rate)

    assert.ok(Number.isFinite(expected) && Math.abs(job.finishResult.value - expected) <= 1, `${where}: finishes in ${expected} days (${fact.amount} units of ${fact.made.storedCost.toFixed(4)} BP at ${rate} BP/yr), not ${job.finishResult.value}`)

    if (credit > 0) {
      const uncredited = gameDays(fact.amount, fact.made.classCost, rate)

      assert.ok(job.finishResult.value <= uncredited, `${where}: the credit never lengthens the ${uncredited} days the class's own cost takes, not ${job.finishResult.value}`)
    }
  }

  for (const [label, test] of Object.entries(credited || {})) {
    assert.ok(planted.some(test), `${copy}: a case of ${label}`)
  }
}

// ---- The checks -----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('credit', 'the credit of the stored components is the class\'s cost less the stored cost, the stored cost never below the 1 BP floor, and what it says of the Use Components box follows the stored cost: ticked only where the credit goes past the alien components, not told at the alien-only cost, moot for a class of alien components, unexplained for a cost the components cannot give, no credit to tell where the stored cost is above the class\'s cost, and unknown where the save leaves a count, a cost or the research of a component; the minerals credited are what the components need less what the project stores', async (w) => {
  const { production: p, provenance } = await w.modules()
  const minerals = (Duranium) => ({ ...Object.fromEntries(MINERAL_NAMES.map((name) => [name, 0])), Duranium })
  const part = (name, count, cost, researched, Duranium = 0) => ({ name, count, cost, researched, minerals: minerals(Duranium) })

  // A class of 80 BP: a component of alien technology of 20 BP (2 t of Duranium), three of 10 BP of researched technology (1 t each) and one of 30 BP of researched technology (4 t).
  const parts = [part('Alien drive', 1, 20, 0, 2), part('Crew quarters', 3, 10, 1, 1), part('Bridge', 1, 30, 1, 4)]
  const classCost = 80
  const credit = (storedCost, storedDuranium = 9, over = {}) => p.componentCredit({ classCost, parts, storedCost, storedMinerals: minerals(storedDuranium), ...over })

  assert.equal(p.UNIT_COST_FLOOR, 1, 'a unit costs at least 1 BP')
  assert.equal(p.creditedCost(100, 40), 60, 'a credit of 40 off 100 leaves 60')
  assert.equal(p.creditedCost(100, 100), 1, 'a credit of the whole cost leaves the floor')
  assert.equal(p.creditedCost(100, 99.5), 1, 'a cost of 0.5 is held at the floor')
  assert.equal(p.creditedCost(0.5, 0), 1, 'a class below the floor costs the floor with nothing credited')

  const none = credit(80, 9)

  assert.equal(none.credit, 0, 'a stored cost at the class\'s cost credits nothing')
  assert.equal(none.use.state, 'unexplained', 'a class with an alien component always credits it: the full cost cannot be a stored one')

  const alien = credit(60, 7)

  assert.equal(alien.credit, 20, 'the alien component alone credits its 20 BP')
  assert.equal(alien.use.state, 'untold', 'a cost at the alien-only cost does not tell the box')
  assert.equal(alien.use.credited, 'alien', 'and says the alien components were credited')
  assert.equal(alien.use.alien, 20, 'by 20 BP')
  assert.equal(alien.use.result.rule.id, 'production.useComponents', 'the box line\'s own result is of the box rule')
  assert.equal(alien.use.result.status, 'unavailable', 'and no figure')
  assert.ok(alien.use.result.inputs.missing.some((text) => /the project stores none/.test(text)), 'and names the box the project does not store')
  assert.ok(alien.use.result.assumptions.some((text) => /the race's current research/.test(text)), 'with the research as it now stands named')
  assert.deepEqual(alien.minerals, [{ name: 'Duranium', tonnes: 2 }], 'the minerals credited are the alien drive\'s 2 t of Duranium')
  assert.equal(alien.floored, false, 'a cost above the floor is not held at it')
  assert.equal(provenance.isAvailable(alien.result), true, 'the credit is a figure')
  assert.equal(alien.result.value, 20, 'of 20 BP')
  assert.equal(alien.result.rule.id, 'production.componentCredit', 'of its rule')

  const ticked = credit(30, 4)

  assert.equal(ticked.credit, 50, 'the alien component and a Bridge credit 50 BP')
  assert.equal(ticked.use.state, 'researched', 'a cost below the alien-only cost means components of researched technology were taken, never that the box was ticked')
  assert.deepEqual(ticked.minerals, [{ name: 'Duranium', tonnes: 5 }], 'and the minerals credited are what the class mounts (9 t of Duranium) less what the project stores (4 t)')

  const whole = credit(1, 0)

  assert.equal(whole.credit, 79, 'every component credits all but the floor')
  assert.equal(whole.floored, true, 'the stored cost is the 1 BP floor')
  assert.equal(whole.use.state, 'researched', 'a cost at the floor with components of researched technology in the class shows they were taken')

  assert.equal(credit(0.5).use.state, 'unexplained', 'a stored cost under the floor is one the game never writes')

  const above = credit(100)

  assert.equal(above.aboveClass, true, 'a stored cost above the class\'s is no credit of its components')
  assert.equal(above.credit, null, 'so the credit is not told')
  assert.equal(provenance.isAvailable(above.result), false, 'and its mark is no figure')
  assert.ok(above.result.inputs.missing.some((text) => /stored cost of 100 BP a unit is above the class's 80 BP a unit/.test(text)), 'naming the stored cost and the class\'s')
  assert.equal(above.floored, false, 'and a cost above the class\'s is not the floor')
  assert.equal(above.minerals, null, 'nor are minerals credited off a cost the components cannot give')
  assert.equal(above.use.state, 'above', 'nor is the box told from a cost the class\'s components cannot give')

  const aliens = p.componentCredit({ classCost: 80, parts: [part('Alien hull', 1, 80, 0, 1)], storedCost: 1, storedMinerals: minerals(0) })

  assert.equal(aliens.use.state, 'moot', 'a class of alien components only leaves the box no say')
  assert.equal(aliens.floored, true, 'its cost is the floor')
  assert.equal(p.componentCredit({ classCost: 80, parts: [part('Alien hull', 1, 80, 0, 1)], storedCost: 80, storedMinerals: minerals(1) }).use.state, 'unexplained', 'an alien component not credited is no stored project')

  const researched = [part('Crew quarters', 3, 10, 1, 1), part('Bridge', 1, 30, 1, 4)]
  const plainCost = (storedCost) => p.componentCredit({ classCost: 60, parts: researched, storedCost, storedMinerals: minerals(7) })

  assert.equal(plainCost(60).use.state, 'untold', 'a class of researched components at its own cost does not tell the box')
  assert.equal(plainCost(60).use.credited, 'none', 'and says nothing was credited')
  assert.equal(plainCost(30).use.state, 'researched', 'a credit with components of researched technology only shows they were taken, never that the box was ticked')
  assert.equal(plainCost(30).use.alien, 0, 'beyond no alien component')

  const unknown = p.componentCredit({ classCost, parts: [part('Alien drive', 1, 20, null, 2), ...parts.slice(1)], storedCost: 60, storedMinerals: minerals(7) })

  assert.equal(unknown.credit, 20, 'the credit is still the class\'s cost less the stored one where the research of a component is not in the save')
  assert.equal(unknown.use.state, 'unknown', 'but the box is not told')
  assert.ok(unknown.use.missing.some((text) => /whether the race has researched Alien drive/.test(text)), 'and the gap is named')

  const uncounted = p.componentCredit({ classCost, parts: [{ ...parts[0], count: null }, ...parts.slice(1)], storedCost: 60, storedMinerals: minerals(7) })

  assert.equal(uncounted.use.state, 'unknown', 'a component without a count leaves the box unknown')

  const lacking = p.componentCredit({ classCost: null, parts, storedCost: 60, storedMinerals: minerals(7) })

  assert.equal(provenance.isAvailable(lacking.result), false, 'a class without a cost has no credit')
  assert.equal(lacking.credit, null, 'no figure')
  assert.ok(lacking.result.inputs.missing.includes('the class\'s cost'), 'and names it')
  assert.equal(p.componentCredit({ classCost, parts: undefined, storedCost: 60, storedMinerals: minerals(7) }).credit, null, 'a class with no components has no credit')
  assert.equal(p.componentCredit({ classCost, parts, storedCost: null, storedMinerals: minerals(7) }).credit, null, 'a project with no stored cost has no credit')
  assert.equal(credit(60, 7, { storedMinerals: undefined }).minerals, null, 'a project with no stored minerals has no mineral credit')

  const figure = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2))
  const duration = (days) => `${days.toFixed(1)} d`
  const lines = (stored, over = {}) => p.creditLines({ credit: credit(stored, stored === 60 ? 7 : 4), classCost, storedCost: stored, units: 2, perYear: 36.5, format: figure, duration, ...over })

  assert.deepEqual(lines(60), [
    'Stored components credited 20 BP of the class\'s 80 BP a unit, so the project costs 60 BP a unit',
    'Minerals credited a unit: Duranium 2 t',
    'At the project\'s rate the credit saves 40 BP over the 2 units left, 400.0 d',
    'The Use Components box is not stored with the project: the credit is what the class\'s alien components give (20 BP a unit), taken whether the box is ticked or not, so the box\'s state cannot be told from the cost',
  ], 'the lines of an alien-only credit')
  assert.ok(lines(30)[3] === 'The credit goes beyond the 20 BP a unit that the class\'s alien components give alone, so components of researched technology were taken: a ticked Use Components box allows that, and a component researched after the project was made explains the same credit, so the box\'s state cannot be told from the cost', 'the line of a cost that only components of researched technology explain')
  assert.equal(lines(60, { perYear: null }).length, 3, 'a project at no known rate has no line of time')
  assert.equal(lines(60, { perYear: 0 }).length, 3, 'nor one at no rate')
  assert.equal(lines(30, { npr: true }).length, 3, 'a spied empire\'s research is not in the save, so no line says what the credit shows of the box')

  // The band of one part in a million: a stored cost a rounding above the class's counts as the class's cost, so a class of 1,000,000 BP and a project stored at 1,000,000.5 BP credits 0, never the negative the difference gives (Terra's r2 probe).
  const bandParts = [part('Hull', 1, 1000000, 1, 1)]
  const band = (storedCost) => p.componentCredit({ classCost: 1000000, parts: bandParts, storedCost, storedMinerals: minerals(1) })
  const equalCost = band(1000000)
  const nearAbove = band(1000000.5)
  const farAbove = band(1000002)

  assert.equal(equalCost.credit, 0, 'a stored cost at the class\'s own cost credits nothing')
  assert.equal(nearAbove.aboveClass, false, 'a stored cost of 1,000,000.5 BP against a class of 1,000,000 BP is within the band, so not above it')
  assert.equal(nearAbove.credit, 0, 'and credits exactly 0, never the class\'s cost less the stored one, which is negative here')
  assert.equal(nearAbove.floored, false, 'a cost above the floor is not held at it')
  assert.equal(nearAbove.use.state, equalCost.use.state, 'the box reads as at the class\'s own cost')
  assert.equal(nearAbove.use.state, 'untold', 'which for a class of researched components alone does not tell it')
  assert.equal(provenance.isAvailable(nearAbove.result), true, 'the credit is a figure')
  assert.equal(nearAbove.result.value, 0, 'of 0 BP')
  assert.deepEqual(p.creditLines({ credit: nearAbove, classCost: 1000000, storedCost: 1000000.5, units: 1, perYear: 1, format: figure, duration }), [
    'No stored components credited: the project costs the class\'s 1000000 BP a unit',
    BOX_UNTOLD_NONE,
  ], 'a stored cost within the band gives the equal-cost line, not both costs and no negative credit')

  assert.equal(farAbove.aboveClass, true, 'a stored cost of 1,000,002 BP against a class of 1,000,000 BP is beyond the band, so above it')
  assert.equal(farAbove.credit, null, 'so the credit is not told')
  assert.equal(farAbove.use.state, 'above', 'nor is the box')
  assert.deepEqual(p.creditLines({ credit: farAbove, classCost: 1000000, storedCost: 1000002, units: 1, perYear: 1, format: figure, duration }), [
    'Credit of the stored components not known: the project\'s stored cost of 1000002 BP a unit is above the class\'s 1000000 BP a unit',
    'The Use Components box is not stored with the project: the stored cost is above the class\'s cost, so the box\'s state cannot be told from it',
  ], 'a stored cost beyond the band gives both costs, no credit to tell and the box line after it')

  // Terra's example: a class of 80 BP with one component of 20, alien and taken when the project was made with the box off (the unit stored at 60), researched since. The cost is the one a ticked box would leave, so the box is never read from it.
  const transitioned = p.componentCredit({ classCost: 80, parts: [part('Alien drive', 1, 20, 1, 2)], storedCost: 60, storedMinerals: minerals(7) })

  assert.equal(transitioned.credit, 20, 'the component credits its 20 BP whether it was alien then or researched since')
  assert.equal(transitioned.use.state, 'researched', 'the cost shows components of researched technology were taken')
  assert.equal(transitioned.use.alien, 0, 'and no component is alien as the race now stands, so the cost alone would read as a ticked box')
  assert.equal(transitioned.use.result.status, 'unavailable', 'the box is no figure')

  const transitionedLines = p.creditLines({ credit: transitioned, classCost: 80, storedCost: 60, units: 1, perYear: 20, format: figure, duration })

  assert.equal(transitionedLines[transitionedLines.length - 1], BOX_RESEARCHED, 'the line says a research since explains the credit as well as a ticked box, so the box cannot be told')
  assert.ok(!transitionedLines.some((line) => /was ticked/.test(line)), 'and no line says the box was ticked of a project whose box was off')

  assert.equal(p.creditLines({ credit: aliens, classCost: 80, storedCost: 1, units: 1, perYear: null, format: figure, duration })[2], 'The class mounts no component of researched technology, so the Use Components box changed nothing for the project and the cost says nothing of it', 'a class of alien components only says the box had nothing to decide')

  assert.ok(/^Credit of the stored components not known: missing the class's cost/.test(p.creditLines({ credit: lacking, classCost: null, storedCost: 60, units: 1, perYear: 1, format: figure, duration })[0]), 'a credit not known is said so')

  assert.deepEqual(p.creditLines({ credit: above, classCost, storedCost: 100, units: 1, perYear: 1, format: figure, duration }), [
    'Credit of the stored components not known: the project\'s stored cost of 100 BP a unit is above the class\'s 80 BP a unit',
    'The Use Components box is not stored with the project: the stored cost is above the class\'s cost, so the box\'s state cannot be told from it',
  ], 'a cost above the class\'s gives both costs, no credit to tell and the box line after it')

  const floor = p.creditLines({ credit: whole, classCost, storedCost: 1, units: 1, perYear: 79, format: figure, duration })

  assert.ok(/so the project costs 1 BP a unit, held at the 1 BP floor$/.test(floor[0]), `a cost at the floor is said so: ${floor[0]}`)
  assert.deepEqual(p.creditLines({ credit: none, classCost, storedCost: 80, units: 1, perYear: 1, format: figure, duration }), ['No stored components credited: the project costs the class\'s 80 BP a unit', 'The stored cost is not one the class\'s components give: the class or its components differ from the ones the project was made from'], 'a cost at the class\'s is no stored cost where an alien component is mandatory, and is said so')
})

check('stations', 'the Production page on a copy with Space Station projects made by the game\'s creation from the colony\'s stock shows, under each job, the credit against the class\'s cost, the minerals, what it saves at the share of construction capacity and what it says of the box, and its date follows the stored cost: a ticked box credits the researched components the stock covers beside the alien ones, a box not ticked only the alien ones, a stock of everything leaves the 1 BP floor, and a project the game refuses is no job', async (w) => {
  await checkPlanted(w, 'stations', { credited: { 'a ticked box with alien components': (fact) => fact.made && fact.ticked && fact.made.tookResearched && fact.made.alien > 0, 'a box not ticked': (fact) => fact.made && !fact.ticked, 'the floor': (fact) => fact.made && fact.made.floored, 'a refusal': (fact) => fact.refused } })

  const { planted } = copyOf('stations').facts
  const [first] = planted

  assert.ok(Math.abs(first.made.classCost - first.made.storedCost - (160 + 5000 + 470 + 8)) < 1e-6, 'the ticked batch credits the Deflector Array (160), the 5 Solar Reflectors (5000), 47 Engineering Spaces (470) and 4 Crew Quarters (8) and no Bridge: the stock held one of the two the batch needs')
  assert.ok(Math.abs(planted[1].made.classCost - planted[1].made.storedCost - 5160) < 1e-6, 'the box not ticked credits the alien Deflector Array and Solar Reflectors only (5160)')
  assert.ok(planted[2].made.storedCost === 1 && planted[2].made.floored, 'every component in stock leaves a cost of 1')
})

check('lights', 'the Production page on a copy with Light Naval projects made by the game\'s creation shows the same lines at the light naval capacity: the alien crew quarters are credited whether the box is ticked or not, a ticked box adds the components the stock covers, a stock of everything leaves the 1 BP floor', async (w) => {
  await checkPlanted(w, 'lights', { credited: { 'a ticked box with an alien component': (fact) => fact.made && fact.ticked && fact.made.tookResearched && fact.made.alien > 0, 'a box not ticked': (fact) => fact.made && !fact.ticked, 'the floor': (fact) => fact.made && fact.made.floored } })

  const { planted } = copyOf('lights').facts

  assert.ok(Math.abs(planted[0].made.classCost - planted[0].made.storedCost - 20.4) < 1e-6, 'the ticked batch credits the Bridge (20) and the alien Crew Quarters (0.4)')
  assert.ok(Math.abs(planted[1].made.classCost - planted[1].made.storedCost - 0.4) < 1e-6, 'the box not ticked credits the alien Crew Quarters only')
  assert.equal(planted[2].made.storedCost, 1, 'every component in stock leaves 1 BP')
})

check('plain', 'on a copy with no component of alien technology a ticked box credits only the components the stock covers for the whole batch (a Bridge stock a hair under it credits nothing), a box not ticked nothing, and the credit never says the box was ticked of a project that credited nothing', async (w) => {
  await checkPlanted(w, 'plain', { credited: { 'a ticked box with no alien component': (fact) => fact.made && fact.ticked && fact.made.tookResearched && fact.made.alien === 0, 'a box not ticked': (fact) => fact.made && !fact.ticked, 'a stock short of the batch': (fact) => fact.made && fact.ticked && !fact.made.tookResearched, 'the floor': (fact) => fact.made && fact.made.floored } })

  const { planted } = copyOf('plain').facts

  assert.ok(Math.abs(planted[0].made.storedCost - 10.5003977057734) < 1e-6, 'the ticked Bridge credits 20 BP off the Probe\'s 30.5')
  assert.equal(planted[1].made.storedCost, planted[1].made.classCost, 'a box not ticked leaves the class\'s cost')
  assert.equal(planted[3].made.storedCost, planted[3].made.classCost, 'a Bridge stock under the batch leaves the class\'s cost')

  const vm = await w.pageOn('plain')
  const short = vm.industryJobs.find((job) => job.key === 'industry-9624')

  assert.ok(!short.components.some((line) => /was ticked/.test(line)), 'a project that credited nothing never says the box was ticked')
})

check('transition', 'a project of 80 BP whose one component of 20 was alien and taken when the box was off, and is researched now, stores 60 and its lines say components of researched technology were taken, which a research since explains as well as a ticked box, and never that the box was ticked', async (w) => {
  const vm = await w.pageOn('transition')
  const { made, ticked } = copyOf('transition').facts
  const job = vm.industryJobs.find((one) => one.key === `industry-${TRANSITION}`)

  assert.ok(made, 'the game makes the project: an alien component the stock covers for the batch is taken whether the box is ticked or not')
  assert.equal(ticked, false, 'the box was off')
  assert.equal(made.classCost, 80, 'the class costs 80 BP')
  assert.equal(made.storedCost, 60, 'and the alien component of 20 leaves 60')
  assert.equal(made.tookResearched, false, 'nothing of researched technology was credited then')
  assert.ok(job, 'the project is a job')
  assert.equal(job.components.length, 4, 'with the credit, the minerals, the time saved and the box')
  assert.equal(job.components[0], 'Stored components credited 20 BP of the class\'s 80 BP a unit, so the project costs 60 BP a unit', 'the stored cost read against the class\'s')
  assert.equal(job.components[job.components.length - 1], BOX_RESEARCHED, 'the box line says a research since explains the credit as well as a ticked box, so the box cannot be told')
  assert.ok(!job.components.some((line) => /was ticked/.test(line)), 'and no line says the box was ticked, which it was not')

  const { production } = await w.modules()
  const current = production.componentCredit({ classCost: 80, parts: vm.componentSources.parts[TRANSITION_CLASS], storedCost: made.storedCost, storedMinerals: made.minerals })

  assert.equal(current.credit, 20, 'the credit is the component\'s 20 BP, taken then as alien and stored as credited')
  assert.equal(current.use.alien, 0, 'as the race now stands no component is alien')
  assert.equal(current.use.state, 'researched', 'so the cost alone would read as a ticked box, which is why the line says it cannot be told')
  assert.equal(current.use.result.rule.id, 'production.useComponents', 'the box line\'s mark is the box rule')
  assert.equal(job.useResult && job.useResult.rule.id, 'production.useComponents', 'and the page marks it so')
  assert.equal(job.useResult.status, 'unavailable', 'with no figure')
})

check('odd', 'a stored cost far above the class\'s, which no components give, gives both costs and no credit to tell, with the box line after it saying the box cannot be told from the cost, and a project whose class the save lacks says what is missing instead of a credit', async (w) => {
  const vm = await w.pageOn('odd')
  const figure = figureOf(vm)
  const { station } = copyOf('odd').facts
  const unexplained = vm.industryJobs.find((job) => job.key === `industry-${ODD_UNEXPLAINED}`)
  const missing = vm.industryJobs.find((job) => job.key === `industry-${ODD_MISSING}`)

  assert.ok(unexplained && missing, 'both projects are jobs')
  assert.deepEqual(unexplained.components, [`Credit of the stored components not known: the project's stored cost of ${figure(12000)} BP a unit is above the class's ${figure(station.Cost)} BP a unit`, 'The Use Components box is not stored with the project: the stored cost is above the class\'s cost, so the box\'s state cannot be told from it'], 'the stored cost above the class\'s is no credit of the components: both costs are given and the box line follows')
  assert.equal(unexplained.componentResult.rule.id, 'production.componentCredit', 'the credit line carries the credit rule\'s mark')
  assert.equal(unexplained.componentResult.status, 'unavailable', 'with no figure')
  assert.ok(unexplained.componentResult.inputs.missing.some((text) => text.includes(`12000 BP a unit is above the class's ${station.Cost} BP a unit`)), 'naming the stored cost and the class\'s')
  assert.equal(unexplained.useResult.rule.id, 'production.useComponents', 'and the box line carries the box rule\'s mark')
  assert.equal(unexplained.useResult.status, 'unavailable', 'with no figure either')
  assert.deepEqual(missing.components, ['Credit of the stored components not known: missing the class\'s cost, the components of the class'], 'a class the save lacks is named as missing')
  assert.equal(missing.componentResult.status, 'unavailable', 'and its mark is no figure')
})

const BOX_LINES = {
  on: { 0: 'Use Components on: components in stock of researched and alien technology are credited to the task, and to the tasks a repeat makes after it', 2: 'Use Components on: components in stock that the refit adds are credited, researched technology included', 4: 'Use Components on: components in stock that the refit adds are credited to the task and to each task it makes for the next ship' },
  off: { 0: 'Use Components off: only components in stock of alien technology are credited to the task, and to the tasks a repeat makes after it', 2: 'Use Components off: only components in stock of alien technology that the refit adds are credited', 4: 'Use Components off: only alien components that the refit adds are credited to the task, and the tasks it makes for the next ships credit none' },
}

check('box', 'the Industry tab reads a construction, refit or automatic refit task\'s Use Components box as stored (1 ticked, 0 not), says so where the save holds none (a NULL or a value that is no flag) instead of taking it as ticked, shows no line for a repair or a scrap, and marks the box with the rule of the stored flag', async (w) => {
  const vm = await w.pageOn('tasks')
  const { provenance } = await w.modules()
  const stored = copyOf('tasks').database.query('select TaskID, TaskTypeID, UseComponents from FCT_ShipyardTask order by TaskID').all()

  assert.equal(stored.length, 9, 'the copy holds nine tasks')

  for (const task of stored) {
    const job = vm.shipJobs.find((one) => one.key === `ship-${task.TaskID}`)
    const where = `task ${task.TaskID} (type ${task.TaskTypeID}, box ${task.UseComponents})`

    assert.ok(job, `${where} is a job`)

    if (![0, 2, 4].includes(task.TaskTypeID)) {
      assert.deepEqual(job.components, [], `${where}: a repair or a scrap takes no component, so no line`)
      assert.equal(job.componentResult, null, `${where}: and no mark`)
    } else if (task.UseComponents === 0 || task.UseComponents === 1) {
      assert.deepEqual(job.components, [BOX_LINES[task.UseComponents ? 'on' : 'off'][task.TaskTypeID]], `${where}: the box as stored`)
      assert.ok(job.componentResult, `${where}: the box line carries a mark`)
      assert.equal(job.componentResult.rule.id, 'production.useComponents', `${where}: marked with the rule of the stored flag`)
      assert.equal(job.componentResult.value, task.UseComponents, `${where}: the mark says ${task.UseComponents}`)
      assert.equal(provenance.isAvailable(job.componentResult), true, `${where}: a figure`)
    } else {
      assert.deepEqual(job.components, ['Use Components is not stored for the task'], `${where}: a box the save does not hold is not taken as ticked`)
      assert.ok(job.componentResult, `${where}: the line carries a mark`)
      assert.equal(provenance.isAvailable(job.componentResult), false, `${where}: and its mark is no figure`)
    }
  }

  const fixture = await (async () => {
    const intact = await w.pageOn('intact')

    return intact.shipJobs
  })()

  assert.equal(fixture.length, 4, 'the fixture holds four tasks')
  assert.ok(fixture.every((job) => job.components.length === 1 && job.components[0] === BOX_LINES.off[0]), 'the fixture\'s tasks, stored with the box off, say so')
})

check('render', 'the name cell of the jobs draws each line of a credit or a box in an element marked data-use-components, one for each line, the mark of the rule after the first, and none for a job without a line (a repair task)', async (w) => {
  const text = w.texts.productionPage
  const cell = text.match(/<template #\[`item\.name`\]="\{ item \}">([\s\S]*?)\n {12}<\/template>/)

  assert.ok(cell, 'the page has a name cell for its jobs')

  const component = `<template><div>${cell[1]}</div></template>`
  const draw = (job) => renderTree(component, { item: job, typeColors: {}, typeLabels: { industry: 'Industry', ship: 'Ship' }, linkTo: { techTree: () => ({}), shipyards: () => ({}) }, focusId: null })
  const linesOf = (job) => treeOf(draw(job).tree).filter((node) => attrsOf(node)['data-use-components'] !== undefined)
  const industry = await w.pageOn('stations')
  const credited = industry.industryJobs.find((job) => job.key === 'industry-9601')

  assert.equal(credited.components.length, 4, 'the first station has four lines')
  assert.equal(linesOf(credited).length, 4, 'and draws four elements')
  credited.components.forEach((line) => assert.ok(draw(credited).texts.includes(line), `the job draws "${line}"`))
  assert.equal(treeOf(draw(credited).tree).filter((node) => node.tag === 'provenance-mark').length, 2, 'the credit line and the box line each carry a provenance mark')

  const tasks = await w.pageOn('tasks')
  const box = tasks.shipJobs.find((job) => job.key === 'ship-1')
  const repair = tasks.shipJobs.find((job) => job.key === 'ship-5')

  assert.equal(linesOf(box).length, 1, 'a construction task draws its box line')
  assert.ok(draw(box).texts.includes(box.components[0]), 'with its words')
  assert.equal(repair.components.length, 0, 'a repair has no line')
  assert.equal(linesOf(repair).length, 0, 'and draws no element')
})

check('cycle', 'the cycle forecast floors every mineral balance at 0 after a build is debited: a stock of 10.00008 t at 3 t a build point is cut to 3.3334 BP (3.33336 rounded to 4 decimals), which takes 10.0002 t, so the balance is 0 and not -0.00012, and an arrival of 3.00015 t then lands on 0.00015 t and not 0.00003', async (w) => {
  const { 'industry-cycle': engine } = await w.modules()
  const point = { ID: 1, Percentage: 100, Amount: 5, PartialCompletion: 0, ProdPerUnit: 1, Queue: 0, Paused: 0, category: 'construction', needs: { Boronide: 3 }, source: null }
  const run = (extra) => engine.forecastColony({ capacities: { construction: 3650 }, stock: { Boronide: 10.00008 }, cycleDays: 1, projects: [point], horizonDays: 30, ...extra })
  const plain = run({})

  assert.equal(plain.projects[1].built, 3.3334, 'the build is cut to the stock, rounded to 4 decimals')
  assert.ok(plain.left.Boronide === 0, `the balance is floored at 0, not ${plain.left.Boronide}`)

  const arrival = run({ arrivals: [{ resource: 'Boronide', day: 2, quantity: 3.00015 }] })

  assert.ok(near(arrival.left.Boronide, 0.00015), `the arrival lands on 0, so 0.00015 t are left, not ${arrival.left.Boronide}`)

  const exact = run({ stock: { Boronide: 9.9999 } })

  assert.ok(exact.left.Boronide === 0 && exact.projects[1].built === 3.3333, `a stock that the rounded build does not overrun is left exactly: ${exact.left.Boronide}, ${exact.projects[1].built}`)
})

check('floors', 'the stock projection of the Minerals page never goes below 0 (a drain of 100 t a year on 10 t leaves 0 from the first sample after the stock runs out), the free stock of a colony below its reserve is 0, never negative, and the MSP run on a stock it exhausts leaves no balance below 0', async (w) => {
  const { minerals, 'colony-minerals': colonyMinerals, 'msp-supply': msp } = await w.modules()
  const projection = minerals.stockProjection({ start: 10, otherNet: -100, deposits: [], steps: [0, 0.2, 0.5, 1, 2] })

  assert.deepEqual(projection.stock, [10, 0, 0, 0, 0], 'the projected stock runs out and stays at 0')
  assert.ok(Math.abs(projection.runOut - 0.1) < 1e-6, `and runs out in a tenth of a year, not ${projection.runOut}`)

  const [duranium] = colonyMinerals.colonyMinerals({ Duranium: 5, ReserveDuranium: 8 }, {}, {}, false)

  assert.equal(duranium.name, 'Duranium', 'the first mineral is Duranium')
  assert.equal(duranium.free, 0, 'a stock below its reserve has 0 free, not -3')

  const run = msp.simulate({ production: 100000, stock: Object.fromEntries(minerals.MINERALS.map((mineral) => [mineral.name, 10])), days: 100 })

  assert.ok(run.lost > 0, 'the MSP run uses up its stock and loses output')
  assert.ok(Object.values(run.final).length > 0 && Object.values(run.final).every((tonnes) => tonnes >= 0), `no balance of the exhausted MSP run is below 0: ${JSON.stringify(run.final)}`)
})

check('registry', 'the rules of the credit and of the stored box are of the line the game is played on, the credit estimated (what a project\'s stored cost shows of the box) and the box confirmed (read as stored), the finish of an industrial project is too, their structure names the columns read, and their notes and assumptions name the research the cost cannot date', async (w) => {
  const { provenance } = await w.modules()

  for (const [id, verification] of [['production.componentCredit', 'estimated'], ['production.useComponents', 'confirmed'], ['production.industryFinish', 'estimated']]) {
    const rule = provenance.getRule(id)

    assert.ok(rule, `the rule ${id} is registered`)
    assert.deepEqual(rule.versions, ['3.2.x'], `${id} holds on the line`)
    assert.equal(rule.verification, verification, `${id} is ${verification}`)
  }

  assert.ok(provenance.getRule('production.useComponents').structure.includes('FCT_ShipyardTask.UseComponents, TaskTypeID'), 'the box rule names its columns')
  assert.ok(provenance.getRule('production.componentCredit').structure.includes('FCT_ShipClass.Cost'), 'the credit rule names the class\'s cost')
  assert.ok(/leaves no balance below 0/.test(provenance.getRule('production.industryFinish').note), 'the finish rule says the debit leaves no balance below 0')
  assert.ok(/the credit does not tell it/.test(provenance.getRule('production.componentCredit').note), 'the credit rule says the stored cost does not tell the box')
  assert.ok(/never whether the box was ticked/.test(provenance.getRule('production.useComponents').note), 'the box rule says an industrial project\'s box is never told')
  assert.ok(provenance.getRule('production.componentCredit').assumptions.includes('The research is the race\'s current research, not the one it held when the project was made'), 'the credit rule names the research it cannot date')
})

check('text', 'the Industry panel foot says what the lines of a Light Naval or Space Station job and of a task\'s box hold, and the foot, the lines and the rule notes are in the impersonal voice with no release number', async (w) => {
  const { provenance, glossary } = await w.modules()
  const help = glossary.PAGE_HELP['/production'].usage.join('\n')
  const production = w.texts.productionPage
  const foot = production.slice(production.indexOf('<div class="panel-foot caption text--secondary">\n            Use it to spot stalled work and shortages.'))

  assert.ok(foot.startsWith('<div class="panel-foot caption text--secondary">'), 'the Industry panel has a foot that opens "Use it to"')
  assert.ok(/A Light Naval or Space Station project takes the components in the colony's stock when it is made, a whole batch of each; the lines under it give what they credited a unit against the class's cost, the minerals they took off, what that saves at the project's rate and what the credit says of the Use Components box, which an industrial project does not store, while a construction, refit or automatic refit task shows its box as stored\./.test(foot.slice(0, 3600)), 'the foot says what the lines hold and that a task shows its box as stored')
  assert.ok(/A Light Naval or Space Station project lists what the components in stock credited it when it was made \(the cost and minerals a unit, held at the 1 BP floor, and the time saved\) and what the credit says of the Use Components box, which an industrial project does not store; a construction, refit or automatic refit task shows its box as stored\./.test(help), 'the page help of Production says the same')

  const lines = []

  for (const copy of ['stations', 'lights', 'plain', 'odd', 'tasks']) {
    const vm = await w.pageOn(copy)

    ;[...vm.industryJobs, ...vm.shipJobs].forEach((job) => lines.push(...job.components))
  }

  assert.ok(lines.length > 30, `the cases show ${lines.length} lines`)

  const notes = ['production.componentCredit', 'production.useComponents', 'production.industryFinish'].map((id) => provenance.getRule(id).note)
  const sentences = [foot.slice(0, 3600).replace(/<[^>]*>/g, ''), help, ...new Set(lines), ...notes]

  for (const sentence of sentences) {
    assert.ok(!/\b(I|we|you|your|our|us)\b/i.test(sentence.replace(/Use it to/g, '')), `in the impersonal voice: ${sentence.slice(0, 120)}`)
    assert.ok(!/\b[23]\.[012](\.\d+|\.x)?\b/.test(sentence.replace(/\d[\d'.,]*/g, '#')), `with no release number: ${sentence.slice(0, 120)}`)
  }
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
const CREDITED_COST = 'export const creditedCost = (classCost, credit) => Math.max(UNIT_COST_FLOOR, classCost - credit)'
const FLOOR_LINE = 'left[resource] = resource !== FUEL && negative(after) ? ZERO : after'
const FLAG_LINE = 'const flag = flagOf(task.UseComponents)'
const COMPONENTS_LINE = 'components: credit.lines,'
const BOX_LINE = 'components: box,'
const ELEMENT = 'class="caption text--secondary" data-use-components>'
const FOOT_SENTENCE = 'A Light Naval or Space Station project takes the components in the colony\'s stock when it is made, a whole batch of each; the lines under it give what they credited a unit against the class\'s cost, the minerals they took off, what that saves at the project\'s rate and what the credit says of the Use Components box, which an industrial project does not store, while a construction, refit or automatic refit task shows its box as stored. '

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the 1 BP floor of a unit is dropped', target: 'production', from: CREDITED_COST, to: 'export const creditedCost = (classCost, credit) => classCost - credit', fails: ['credit'] },
  { name: 'the floor of a unit is 0', target: 'production', from: 'export const UNIT_COST_FLOOR = 1', to: 'export const UNIT_COST_FLOOR = 0', fails: ['credit', 'stations', 'lights', 'plain'] },
  { name: 'a cost at the floor is not said to be held there', target: 'production', from: 'floored: credit > 0 && nearly(storedCost, UNIT_COST_FLOOR),', to: 'floored: false,', fails: ['credit', 'stations', 'lights', 'plain'] },
  { name: 'the credit is the stored cost less the class\'s', target: 'production', from: 'const credit = aboveClass ? null : nearly(storedCost, classCost) ? 0 : classCost - storedCost', to: 'const credit = aboveClass ? null : storedCost - classCost', fails: ['credit', 'stations', 'lights', 'plain'] },
  { name: 'the credit is held at 0 where the stored cost is above the class\'s', target: 'production', from: 'const credit = aboveClass ? null : nearly(storedCost, classCost) ? 0 : classCost - storedCost', to: 'const credit = Math.max(0, classCost - storedCost)', fails: ['credit', 'odd'] },
  { name: 'the credit within the band is the class\'s cost less the stored one', target: 'production', from: 'const credit = aboveClass ? null : nearly(storedCost, classCost) ? 0 : classCost - storedCost', to: 'const credit = aboveClass ? null : classCost - storedCost', fails: ['credit'] },
  { name: 'the alien sum counts the researched components', target: 'production', from: 'alien += part.researched === 0 ? part.cost * part.count : 0', to: 'alien += part.researched === 1 ? part.cost * part.count : 0', fails: ['credit', 'stations', 'lights', 'plain'] },
  { name: 'a cost below the alien-only cost says the box is not told', target: 'production', from: 'if (beyond(mandatory, storedCost)) {', to: 'if (beyond(storedCost, mandatory)) {', fails: ['credit', 'stations', 'lights', 'plain'] },
  { name: 'a class of alien components only tells the box', target: 'production', from: 'if (!parts.some((part) => part.researched === 1)) {', to: 'if (false) {', fails: ['credit'] },
  { name: 'a cost above the alien-only cost is no stored one', target: 'production', from: 'if (beyond(storedCost, mandatory) || beyond(least, storedCost)) {', to: 'if (beyond(least, storedCost)) {', fails: ['credit'] },
  { name: 'a cost under every component credited is accepted', target: 'production', from: 'if (beyond(storedCost, mandatory) || beyond(least, storedCost)) {', to: 'if (beyond(storedCost, mandatory)) {', fails: ['credit'] },
  { name: 'the minerals credited are left out', target: 'production', from: 'if (beyond(mounted, stored[name])) {', to: 'if (false) {', fails: ['credit', 'stations', 'lights', 'plain'] },
  { name: 'a mineral\'s credit is counted once for a batch of components', target: 'production', from: 'total + part.count * part.minerals[name]', to: 'total + part.minerals[name]', fails: ['credit', 'stations', 'plain'] },
  { name: 'the time saved is for one unit', target: 'production', from: 'format(credit.credit * units)} BP over the ${format(units)} units left, ${duration(credit.credit * units / perYear * DAYS_PER_YEAR)}', to: 'format(credit.credit)} BP over the ${format(units)} units left, ${duration(credit.credit / perYear * DAYS_PER_YEAR)}', fails: ['credit', 'stations', 'lights', 'plain'] },
  { name: 'the line of time is for a project of any rate', target: 'production', from: 'isNumber(perYear) && perYear > 0) {', to: 'isNumber(perYear)) {', fails: ['credit'] },
  { name: 'the box is said ticked of a spied empire', target: 'production', from: '} else if (!npr && use.state === \'researched\') {', to: '} else if (use.state === \'researched\') {', fails: ['credit'] },
  { name: 'the credit of a component researched since is told as a box ticked at creation', target: 'production', from: '} else if (!npr && use.state === \'researched\') {', to: '} else if (!npr && use.state === \'researched\') {\n    lines.push(\'Use Components was ticked when the project was made: the credit is of components of researched technology\')\n  } else if (false) {', fails: ['credit', 'transition', 'stations', 'lights', 'plain'] },
  { name: 'a credit of components of researched technology alone leaves the box untold', target: 'production', from: 'if (beyond(mandatory, storedCost)) {', to: 'if (beyond(mandatory, storedCost) && alien > 0) {', fails: ['credit', 'transition', 'plain'] },
  { name: 'the box of a project is given a figure', target: 'production', from: 'const boxResult = (missing = []) => unavailable({ rule: \'production.useComponents\', missing: [BOX_UNTOLD, ...missing], units: \'flag\', assumptions: [BOX_LIMIT] })', to: 'const boxResult = () => ofRule({ rule: \'production.useComponents\', value: 1, inputs: { present: [\'the stored cost a unit\'] }, units: \'flag\' })', fails: ['credit', 'transition', 'stations', 'lights', 'plain'] },
  { name: 'the note of the credit tells the box from its cost', target: 'production', from: 'The box is not stored with an industrial project and the credit does not tell it', to: 'The box is not stored with an industrial project, so it is told from the credit', fails: ['registry'] },
  { name: 'a stored cost no components give is not said so', target: 'production', from: 'lines.push(\'The stored cost is not one the class\\\'s components give: the class or its components differ from the ones the project was made from\')', to: 'void use', fails: ['credit'] },
  { name: 'the stored box is always ticked', target: 'production', from: FLAG_LINE, to: 'const flag = true', fails: ['box'] },
  { name: 'the stored box is never ticked', target: 'production', from: FLAG_LINE, to: 'const flag = false', fails: ['box'] },
  { name: 'a box the save does not hold is taken as off', target: 'production', from: 'export const flagOf = (value) => (value === 0 || value === 1 ? Boolean(value) : null)', to: 'export const flagOf = (value) => Boolean(value)', fails: ['box'] },
  { name: 'the box line swaps its words', target: 'production', from: '${flag ? \'on\' : \'off\'}: ${flag ? words.on : words.off}', to: '${flag ? \'on\' : \'off\'}: ${flag ? words.off : words.on}', fails: ['box'] },
  { name: 'a repair is given the construction words', target: 'production', from: 'const words = BOX_WORDS[task.ShipyardTaskType]', to: 'const words = BOX_WORDS[task.ShipyardTaskType] || BOX_WORDS[0]', fails: ['box', 'render'] },
  { name: 'the rule of the credit is of another line', target: 'production', from: 'id: \'production.componentCredit\',\n  versions: LINE_VERSIONS,', to: 'id: \'production.componentCredit\',\n  versions: [\'3.0.x\'],', fails: ['registry'] },
  { name: 'the rule of the box is not confirmed', target: 'production', from: 'id: \'production.useComponents\',\n  versions: LINE_VERSIONS,\n  units: \'flag\',\n  verification: \'confirmed\',', to: 'id: \'production.useComponents\',\n  versions: LINE_VERSIONS,\n  units: \'flag\',\n  verification: \'estimated\',', fails: ['registry'] },
  { name: 'the finish of an industrial project is of another line', target: 'production', from: 'id: \'production.industryFinish\',\n  versions: LINE_VERSIONS,', to: 'id: \'production.industryFinish\',\n  versions: [\'3.0.x\'],', fails: ['registry'] },
  { name: 'the cycle leaves a negative balance', target: 'cycle', from: FLOOR_LINE, to: 'left[resource] = after', fails: ['cycle'] },
  { name: 'the minerals projection leaves a negative level', target: 'minerals', from: 'stock: levels.map((level) => Math.max(0, level)), output, runOut', to: 'stock: levels, output, runOut', fails: ['floors'] },
  { name: 'the page shows no line for a credit', target: 'productionPage', from: COMPONENTS_LINE, to: 'components: [],', fails: ['stations', 'lights', 'plain', 'odd', 'render'] },
  { name: 'the page shows no line for a box', target: 'productionPage', from: BOX_LINE, to: 'components: [],', fails: ['box', 'render'] },
  { name: 'the page reads the components of the class by the project', target: 'productionPage', from: 'parts: this.componentSources.parts[project.ItemID]', to: 'parts: this.componentSources.parts[project.ID]', fails: ['stations', 'lights', 'plain', 'odd'] },
  { name: 'the page takes the project\'s cost for the class\'s', target: 'productionPage', from: 'classCost: project.ClassCost, parts', to: 'classCost: project.ProdPerUnit, parts', fails: ['stations', 'lights', 'plain', 'odd'] },
  { name: 'the page reads the minerals of no project', target: 'productionPage', from: 'storedMinerals: project })', to: 'storedMinerals: null })', fails: ['stations', 'lights', 'plain'] },
  { name: 'the page reads the class of a Light Naval project only', target: 'productionPage', from: 'in (${PRODUCTION_TYPE.LIGHT_NAVAL}, ${PRODUCTION_TYPE.SPACE_STATION})', to: 'in (${PRODUCTION_TYPE.LIGHT_NAVAL})', fails: ['stations', 'plain'] },
  { name: 'the page reads no box of a task', target: 'productionPage', from: 'FCT_ShipyardTask.UseComponents, FCT_Shipyard.ShipyardName', to: 'FCT_ShipyardTask.ShipyardID as UseComponents, FCT_Shipyard.ShipyardName', fails: ['box'] },
  { name: 'the page treats every empire as spied', target: 'productionPage', from: 'duration: (days) => this.duration(days), npr: this.RaceNPR }', to: 'duration: (days) => this.duration(days), npr: true }', fails: ['stations', 'lights', 'plain'] },
  { name: 'the mark of a task is left off', target: 'productionPage', from: 'componentResult: box.length ? taskUseComponents(ship).result : null,', to: 'componentResult: null,', fails: ['box'] },
  { name: 'the box line of a project carries no mark', target: 'productionPage', from: '<provenance-mark v-else-if="index === item.components.length - 1 && item.useResult" :result="item.useResult" />', to: '', fails: ['render'] },
  { name: 'the lines are not marked', target: 'productionPage', from: ELEMENT, to: 'class="caption text--secondary">', fails: ['render'] },
  { name: 'the foot says nothing of the lines', target: 'productionPage', from: FOOT_SENTENCE, to: '', fails: ['text'] },
  { name: 'the page help of Production says nothing of the stored components', target: 'glossary', from: 'A Light Naval or Space Station project lists what the components in stock credited it when it was made (the cost and minerals a unit, held at the 1 BP floor, and the time saved) and what the credit says of the Use Components box, which an industrial project does not store; a construction, refit or automatic refit task shows its box as stored.', to: 'Projects are listed.', fails: ['text'] },
]
/* eslint-enable no-template-curly-in-string */

// Rewrites that say the same thing: the test of a cost beyond another written as a difference, the flag of a column written as two tests, the days saved multiplied before they are divided, the zero floor written with the test turned round.
const BENIGN = [
  { name: 'a cost beyond another written as a difference', target: 'production', from: 'const beyond = (a, b) => a > b && !nearly(a, b)', to: 'const beyond = (a, b) => a - b > CREDIT_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))' },
  { name: 'the flag of a column written as two tests', target: 'production', from: 'export const flagOf = (value) => (value === 0 || value === 1 ? Boolean(value) : null)', to: 'export const flagOf = (value) => (value === 1 ? true : value === 0 ? false : null)' },
  { name: 'the days saved multiplied before they are divided', target: 'production', from: 'credit.credit * units / perYear * DAYS_PER_YEAR', to: 'credit.credit * units * DAYS_PER_YEAR / perYear' },
  { name: 'the zero floor written with the test turned round', target: 'cycle', from: FLOOR_LINE, to: 'left[resource] = resource !== FUEL && !positive(after) ? ZERO : after' },
  { name: 'the lines keyed by position', target: 'productionPage', from: '<div v-for="(line, index) in item.components" :key="line"', to: '<div v-for="(line, index) in item.components" :key="index"' },
]

// ---- Run ------------------------------------------------------------------------------------------------------------
const run = async (checks, world) => {
  const failures = []

  for (const { name, run: body } of checks) {
    try {
      await body(world)
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

// The fixtures each check needs: a check whose fixture is not there is left out and said so.
const NEEDS = Object.fromEntries(CHECKS.map((one) => [one.name, ['credit', 'cycle', 'floors', 'registry'].includes(one.name) ? [] : [SAVE]]))
const absent = (one) => (NEEDS[one.name] || []).filter((file) => !fs.existsSync(path.join(root, file)))

const main = async () => {
  const available = CHECKS.filter((one) => !absent(one).length)

  CHECKS.filter((one) => absent(one).length).forEach((one) => console.log(`UNSUPPORTED  ${one.name}: the fixture ${absent(one).join(', ')} is not there`))

  const failures = await run(available, worldOf())
  let passed = available.length - failures.length
  let total = available.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutating()) {
    const known = new Set(available.map(({ name }) => name))

    FAULTS.forEach(({ name, fails }) => fails.forEach((id) => assert.ok(CHECKS.some((one) => one.name === id), `${name}: no check named ${id}`)))

    const benignOnly = await run(available, worldOf(textWith(BENIGN)))

    total += 1

    if (benignOnly.length) {
      console.log(`FAIL every rewrite applied: ${benignOnly.map(describeFailure).join('; ')}`)
    } else {
      passed += 1
    }

    const attempts = FAULTS.flatMap((fault) => [[fault, []], [fault, BENIGN]])
    const outcomes = await inParallel(attempts, async ([fault, benign]) => {
      const texts = textWith()

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

      // The rewrites go onto the faulty source where their text is still there exactly once: a fault may replace the very text a rewrite says again.
      benign.filter((edit) => texts[edit.target].split(edit.from).length === 2).forEach((edit) => {
        texts[edit.target] = patched(FILES[edit.target], texts[edit.target], edit.from, edit.to)
      })

      const world = worldOf(texts)
      const named = fault.fails.filter((id) => known.has(id))
      const missed = []

      for (const id of named) {
        const [failed] = await run(CHECKS.filter((one) => one.name === id), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(id)
        }
      }

      return { label: `${fault.name}${benign.length ? ', on the source with every rewrite' : ''}`, missed, named: named.length }
    })

    outcomes.forEach((outcome) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault: ${outcome.message}`)
      } else if (!outcome.named) {
        console.log(`FAIL planted fault ${outcome.label}: none of its checks can run here`)
      } else if (outcome.missed.length) {
        console.log(`FAIL planted fault ${outcome.label}: still passes ${outcome.missed.join(', ')}`)
      } else {
        passed += 1
      }
    })
  }

  console.log(`${passed} of ${total} checks passed`)

  return passed === total
}

main()
  .then((green) => {
    closeCopies()
    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    closeCopies()
    process.exit(2)
  })
