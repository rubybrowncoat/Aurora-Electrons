/*
  Checks the three development projects of the 3.2 line (Engineering, Ordnance and Ground Unit Projects, production types 5, 6 and 7) wherever the app reads them, and the race that starts no research projects (FCT_Race.NoResearchProjects): the capacity a project draws on (utilities/production-types.js, used by utilities/production.js `categoryOf`, utilities/minerals.js, utilities/legacy-consumption.js and utilities/warnings/industry.js), the Industry jobs of the Production page with the item, cost and minerals of each project (pages/production.vue, utilities/development-projects.js), the procurement manifest's count of them (utilities/procurement-data.js, utilities/procurement-manifest.js, components/production/ProcurementManifest.vue), and the Research page, the research warnings and the Commanders research suggestions for a race that starts no research projects (pages/technologies.vue, utilities/warnings/research.js, utilities/research-data.js, utilities/commanders.js, pages/commanders.vue).

  Run: bun scripts/check-industry-projects.js [--no-mutations]

  The rules are the game's, read from the 3.1.0 source and written here, never read from the modules, and every figure is source-derived: no save played under 3.1 holds a development project (the owner's decision Q7 of AE-31: none will be supplied), so each case plants rows into in-memory copies of the migrated fixture (scripts/lib/fixtures.js, game 141, race 784), as scripts/check-treasury-categories.js does. A planted project row is game-shaped: every column `Game.LoadIndustrialProjects` reads is set as `Game.SaveIndustrialProjects` writes it and `Population.method_147` makes it, on a design of the race that the game offers for a development project and the race has not researched (Population.method_178, method_179, method_180; Race.method_305), and the loader skips a row whose race, colony, species or wealth use the game does not hold, so the readers of the three kinds leave such a row out:
  - `Population.ProcessIndustrialProjects` (Population.cs:2202-2213) takes the build points of a cycle from the construction capacity for Engineering, Ground Unit, Component, Construction and Space Station projects and from the ordnance capacity for Ordnance and Ordnance Projects; Light Naval has its own (`Game.LoadIndustrialProjects`, Game.cs:18652-18779, sets the category of a project from its type);
  - a development project's cost is twice the stored development cost of its item's tech and its minerals the item's, scaled by that cost over the item's own (Population.cs:8388-8479; `Game.cs:11499-11517` says what ProductionID is: the component of types 3 and 5, the missile of types 1 and 6, the ground unit class of type 7);
  - a completed Engineering Project adds the component to the colony's stock and researches its tech (Population.cs:2288-2300); an Ordnance Project adds ordnance and a Ground Unit Project adds nothing but the research (Population.cs:2264-2271 and 2301-2308);
  - a race with No Research Projects gets no idle-facilities event (Population.cs:822) and its research buttons are hidden and refused (Economics.cs:1548, 3653, 3824, 3919 and 4144-4174).
  The checks:
  - `types`: the capacity of every production type from 0 to 7 (a type that is not a number is unknown) through `capacityKind`, `categoryOf` and the facility the mineral demand passes to its capacity callback, the names and items of the development types, and which types are development projects;
  - `warnings`: the free capacity checks of the Industry tab on a copy with the projects at 100% of their capacity, each colony list worked out here from SQL and the type lists of the source, and the capacity kind of paused projects;
  - `legacy`: the NPR ordnance note of the queue's basis stands for an Ordnance Project and not for an Engineering Project;
  - `jobs`: the Production page's own industry and developments reads and its `industryJobs` on the planted copy: a development project is named by its type, builds at its share of the capacity of its kind, and carries the line of its item, its cost (twice the development cost, or stated as stored when it is not), its minerals and what the save does not hold;
  - `render`: the name cell of the Industry jobs shows the line of a development project and no line for another job;
  - `manifest-read`: the procurement loader gives each component and development project its production type and leaves out the other types;
  - `manifest`: the manifest counts a component project and an Engineering Project as queued component supply and an Ordnance or Ground Unit Project never, an id that the component of another type shares included, and says how many of each it read, in the page's component, its CSV and its text;
  - `loader`: every planted row has the shape the game writes and loads, each planted design is the race's own with no RaceTech row, and the Production page's industry, development and procurement reads hold exactly the rows the loader loads (species 0, a species or colony the game does not hold and a wealth use DIM_WealthUse does not hold are skipped);
  - `no-research`: the warnings of idle research labs and of dead research projects are silent for a race with the setting on, unevaluated for a race whose setting is not stored (a missing column or a NULL) and as before for one with it off; the Research page says so and leaves the idle-lab flag off, the Commanders suggestions skip the race and say why;
  - `registry`: the capability registry no longer declares the column as unread, and the new reads are optional inputs that name their columns;
  - `text`: the panel feet, the page help and the new notices say what the code does, in the impersonal voice and with no release number.
  Where the source does not give a rule the check does not guess it: the game's own NoShieldTechnology filter of the research list, an NPR's treatment of an Ordnance Project's minerals and what a played 3.1 save holds are not modelled and are not asserted.

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
const SEPARATOR = '\''
const NEAR = 1e-9

const renderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)
const FILES = {
  types: renderer('utilities', 'production-types.js'),
  production: renderer('utilities', 'production.js'),
  minerals: renderer('utilities', 'minerals.js'),
  legacy: renderer('utilities', 'legacy-consumption.js'),
  industryWarn: renderer('utilities', 'warnings', 'industry.js'),
  researchWarn: renderer('utilities', 'warnings', 'research.js'),
  development: renderer('utilities', 'development-projects.js'),
  procData: renderer('utilities', 'procurement-data.js'),
  manifest: renderer('utilities', 'procurement-manifest.js'),
  researchData: renderer('utilities', 'research-data.js'),
  commandersUtil: renderer('utilities', 'commanders.js'),
  capabilities: renderer('utilities', 'capabilities.js'),
  glossary: renderer('utilities', 'glossary.js'),
  productionPage: renderer('pages', 'production.vue'),
  technologiesPage: renderer('pages', 'technologies.vue'),
  commandersPage: renderer('pages', 'commanders.vue'),
  manifestView: renderer('components', 'production', 'ProcurementManifest.vue'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

// The utilities each text stands for, by the name `loadUtilities` loads them under, and the pages with the utilities they import, by the name `loadPage` loads them under.
const UTILITY_NAMES = { types: 'production-types', production: 'production', minerals: 'minerals', legacy: 'legacy-consumption', industryWarn: 'warnings/industry', researchWarn: 'warnings/research', development: 'development-projects', procData: 'procurement-data', manifest: 'procurement-manifest', researchData: 'research-data', commandersUtil: 'commanders', capabilities: 'capabilities', glossary: 'glossary' }
const PAGE_SOURCES = { productionPage: 'pages/production', technologiesPage: 'pages/technologies', commandersPage: 'pages/commanders', manifestView: 'components/production/ProcurementManifest' }

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

// ---- The modules and the pages as shipped, or with edits planted ---------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => {
  const utilitySources = Object.fromEntries(Object.entries(UTILITY_NAMES).map(([key, name]) => [name, texts[key]]))
  const pageSources = { ...Object.fromEntries(Object.entries(PAGE_SOURCES).map(([key, name]) => [name, texts[key]])), ...Object.fromEntries(Object.entries(UTILITY_NAMES).map(([key, name]) => [`utilities/${name}`, texts[key]])) }
  const page = (name) => memo(() => loadPage(name, { stubs: STUBS, modules: PAGE_MODULES, sources: pageSources }))

  return {
    texts,
    modules: memo(() => loadUtilities([...Object.values(UTILITY_NAMES), 'warnings/common', 'provenance', 'research'], { stubs: STUBS, sources: utilitySources })),
    production: page('pages/production'),
    technologies: page('pages/technologies'),
    commanders: page('pages/commanders'),
    manifestView: page('components/production/ProcurementManifest'),
  }
}

// ---- The fixture, as in-memory copies ------------------------------------------------------------------------------
const MINERAL_NAMES = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']
const MISSILE_MINERALS = ['Corbomite', 'Tritanium', 'Boronide', 'Uridium', 'Gallicite']

// The planted projects, each on a design of the race that the game offers for a development project and the race has not researched. The game offers (Population.method_178, method_179 and method_180, Population.cs:8857-8909) the techs of `Race.method_305` (Race.cs:17146: a tech of the game whose race is the race, which the race holds no RaceTech row for), a component only when it is no prototype, no shipping line system and no missile engine; it takes a foreign design nowhere, and `Population.method_147` (Population.cs:7102-7195) makes the project the colony's own (its species the colony's). The fixture holds no such design (all 177 techs of the race are researched and it has no missile of its own), so each is a copy of a row of the fixture, every column kept, under a new id and name as the race's own tech of the game: the Engineering Project on a copy of the component 500250 (CAD025-P010), the Ordnance Project on a copy of the ship decoy 154002 (Dart Ship Decoy, a missile with no engine of another race to carry over) and the Ground Unit Project on a copy of the class 22445 (INF-REG Trooper - Rifle), at colonies of the race with factories (48977 Earth with a replicator, 48979 Aurelia with replicators and 200 assembly factories).
const SPECS = [
  { id: 9001, population: 48977, type: 5, source: 500250, percentage: 50 },
  { id: 9002, population: 48979, type: 6, source: 154002, percentage: 100 },
  { id: 9003, population: 48977, type: 7, source: 22445, percentage: 50 },
]
const FULL = [
  { id: 9001, population: 48977, type: 5, source: 500250, percentage: 100 },
  { id: 9002, population: 48979, type: 6, source: 154002, percentage: 100 },
  { id: 9003, population: 48979, type: 7, source: 22445, percentage: 100 },
]
const ITEM_SQL = {
  5: (id) => ({ item: `select Name, Cost, ${MINERAL_NAMES.join(', ')} from FCT_ShipDesignComponents where SDComponentID = ${id}`, tech: `select DevelopCost from FCT_TechSystem where TechSystemID = ${id}`, label: 'component' }),
  6: (id) => ({ item: `select Name, Cost, ${MISSILE_MINERALS.join(', ')} from FCT_MissileType where MissileID = ${id}`, tech: `select DevelopCost from FCT_TechSystem where TechSystemID = ${id}`, label: 'missile' }),
  7: (id) => ({ item: `select ClassName as Name, Cost, ${MINERAL_NAMES.join(', ')} from FCT_GroundUnitClass where GroundUnitClassID = ${id}`, tech: `select FCT_TechSystem.DevelopCost from FCT_TechSystem inner join FCT_GroundUnitClass on FCT_GroundUnitClass.TechSystemID = FCT_TechSystem.TechSystemID where FCT_GroundUnitClass.GroundUnitClassID = ${id}`, label: 'ground unit class' }),
}
const TYPE_NAMES = { 0: 'Construction', 1: 'Ordnance', 2: 'Light Naval', 3: 'Component', 4: 'Space station', 5: 'Engineering project', 6: 'Ordnance project', 7: 'Ground unit project' }
// The capacity each type draws on, written from Population.cs:2202-2213 and Game.cs:18652-18779.
const KIND_OF = { 0: 'construction', 1: 'ordnance', 2: 'fighter', 3: 'construction', 4: 'construction', 5: 'construction', 6: 'ordnance', 7: 'construction' }
const TYPES_OF = { construction: [0, 3, 4, 5, 7], ordnance: [1, 6], fighter: [2] }
// The wealth use `Population.method_147` (Population.cs:7119-7180) gives each type: GEnum90 const_20 (40, Ship Component Production) for Components and const_30, const_31 and const_32 (53, 54 and 55) for the three development projects.
const WEALTH_OF = { 3: 40, 5: 53, 6: 54, 7: 55 }

const literal = (value) => (typeof value === 'string' ? `'${value.replace(/'/g, '\'\'')}'` : String(value))

// A copy of the row of `table` with `key` equal to `from`, every column kept but those of `over`.
const cloneRow = (database, table, key, from, over) => {
  const names = database.query(`select name from pragma_table_info('${table}')`).all().map((row) => row.name)
  const select = names.map((name) => (Object.prototype.hasOwnProperty.call(over, name) ? literal(over[name]) : `"${name}"`)).join(', ')

  database.run(`insert into ${table} (${names.map((name) => `"${name}"`).join(', ')}) select ${select} from ${table} where ${key} = ${from}`)
}

// The next id of the tech sequence the components, missiles and techs of the game share (a component's and a missile's id is its tech's).
const nextTechId = (database) => database.query('select max(Id) as Id from (select max(TechSystemID) as Id from FCT_TechSystem union all select max(SDComponentID) from FCT_ShipDesignComponents union all select max(MissileID) from FCT_MissileType union all select max(TechSystemID) from FCT_GroundUnitClass)').get().Id + 1

// A design of the race the game offers for a development project: the copy of the fixture's design `source` of the kind of `type`, as the race's own tech of the game that the race has not researched. Gives the id of the item the project's ProductionID holds.
const plantDesign = (database, type, source) => {
  const techId = nextTechId(database)

  if (type === 5) {
    const name = `${database.query(`select Name from FCT_ShipDesignComponents where SDComponentID = ${source}`).get().Name} II`

    cloneRow(database, 'FCT_TechSystem', 'TechSystemID', source, { TechSystemID: techId, Name: name, RaceID: RACE, GameID: GAME })
    cloneRow(database, 'FCT_ShipDesignComponents', 'SDComponentID', source, { SDComponentID: techId, Name: name, GameID: GAME })

    return techId
  } else if (type === 6) {
    const name = `${database.query(`select Name from FCT_MissileType where MissileID = ${source}`).get().Name} II`

    cloneRow(database, 'FCT_TechSystem', 'TechSystemID', source, { TechSystemID: techId, Name: name, RaceID: RACE, GameID: GAME })
    cloneRow(database, 'FCT_MissileType', 'MissileID', source, { MissileID: techId, Name: name, GameID: GAME })

    return techId
  }

  const original = database.query(`select ClassName, TechSystemID from FCT_GroundUnitClass where GroundUnitClassID = ${source}`).get()
  const classId = database.query('select max(GroundUnitClassID) as Id from FCT_GroundUnitClass').get().Id + 1
  const name = `${original.ClassName} II`

  cloneRow(database, 'FCT_TechSystem', 'TechSystemID', original.TechSystemID, { TechSystemID: techId, Name: name, RaceID: RACE, GameID: GAME })
  cloneRow(database, 'FCT_GroundUnitClass', 'GroundUnitClassID', source, { GroundUnitClassID: classId, TechSystemID: techId, ClassName: name, GameID: GAME })

  return classId
}

// The queue a new project gets: `Population.method_138` (Population.cs:6917-6931) gives 0 while the colony's running projects of the capacity leave room for its share (100 less their shares at least the new share), else one past the highest queue among its projects of that capacity.
const queueOf = (database, population, type, percentage) => {
  const same = database.query(`select Queue, Percentage, ProductionType from FCT_IndustrialProjects where PopulationID = ${population}`).all().filter((row) => KIND_OF[row.ProductionType] === KIND_OF[type])

  return 100 - same.filter((row) => row.Queue === 0).reduce((sum, row) => sum + row.Percentage, 0) >= percentage ? 0 : Math.max(...same.map((row) => row.Queue)) + 1
}

// A project row as `Game.SaveIndustrialProjects` writes it (Game.cs:11479-11540: the 28 columns ProjectID, GameID, RaceID, PopulationID, SpeciesID, Percentage, ProductionType, ProductionID, RefitClassID, WealthUse, Amount, PartialCompletion, ProdPerUnit, Description, Pause, Queue, FuelRequired and the eleven minerals) with what `Population.method_147` sets on a new project (Population.cs:7102-7195): the colony's species, the type's wealth use, no refit class, no fuel for these types, the item's name for its description. `row` gives `id`, `population`, `type`, `item`, `percentage`, `amount`, `partial`, `perUnit`, `description`, `pause` and the item's `minerals`; `species`, `wealth` and `queue` default to the game's and are changed only to plant a row the loader skips.
const insertProject = (database, row) => {
  const species = row.species !== undefined ? row.species : database.query(`select SpeciesID from FCT_Population where PopulationID = ${row.population}`).get().SpeciesID
  const wealth = row.wealth !== undefined ? row.wealth : WEALTH_OF[row.type]
  const queue = row.queue !== undefined ? row.queue : queueOf(database, row.population, row.type, row.percentage)
  const columns = ['ProjectID', 'GameID', 'RaceID', 'PopulationID', 'SpeciesID', 'Percentage', 'ProductionType', 'ProductionID', 'RefitClassID', 'WealthUse', 'Amount', 'PartialCompletion', 'ProdPerUnit', 'Description', 'Pause', 'Queue', 'FuelRequired', ...MINERAL_NAMES]
  const values = [row.id, GAME, RACE, row.population, species, row.percentage, row.type, row.item, 0, wealth, row.amount, row.partial, row.perUnit, row.description, row.pause || 0, queue, 0, ...MINERAL_NAMES.map((name) => row.minerals[name] || 0)]

  database.run(`insert into FCT_IndustrialProjects (${columns.join(', ')}) values (${values.map(literal).join(', ')})`)

  return { species, wealth, queue }
}

// A development project on a design of the race, as the game makes it: its cost twice the stored development cost of the item's tech and its minerals the item's, scaled by that cost over the item's own cost (Population.cs:8388-8479), its amount 1 and nothing built yet, named "<item> Project". `over` changes what is stored (`perUnit`, `percentage`, `pause`, and for a row the loader skips `species`, `wealth`, `population`), `over.item` puts the project on a design already planted. Gives what the row says, for the checks to hold the app to.
const plantProject = (database, spec, over = {}) => {
  const item = over.item !== undefined ? over.item : plantDesign(database, spec.type, spec.source)
  const sql = ITEM_SQL[spec.type](item)
  const design = database.query(sql.item).get()
  const tech = database.query(sql.tech).get()

  assert.ok(design && tech, `the copy holds the design ${item} of the project ${spec.id} and its tech`)

  const perUnit = over.perUnit !== undefined ? over.perUnit : 2 * tech.DevelopCost
  const scale = 2 * tech.DevelopCost / design.Cost
  const minerals = Object.fromEntries(MINERAL_NAMES.map((name) => [name, (design[name] || 0) * scale]))
  const percentage = over.percentage !== undefined ? over.percentage : spec.percentage
  const population = over.population !== undefined ? over.population : spec.population
  const written = insertProject(database, { id: spec.id, population, type: spec.type, item, percentage, amount: 1, partial: 0, perUnit, description: `${design.Name} Project`, pause: over.pause, minerals, species: over.species, wealth: over.wealth })

  return { ...spec, population, item, percentage, name: design.Name, label: sql.label, perUnit, develop: tech.DevelopCost, minerals, species: written.species, wealth: written.wealth, queue: written.queue }
}

const plantAll = (database, specs, over = {}) => specs.map((spec) => plantProject(database, spec, over[spec.id] || {}))

// A component project of the same colony (type 3: ProductionID is the component), for the loader to read beside the others and for the type 2 projects the fixture holds to stay out of the read. The game gives it the component's own cost and minerals and its name (`Population.method_147`); 2 units are ordered and half of one is built.
const plantComponentProject = (database) => {
  const component = database.query(`select Name, Cost, ${MINERAL_NAMES.join(', ')} from FCT_ShipDesignComponents where SDComponentID = 500250`).get()

  insertProject(database, { id: 9004, population: 48977, type: 3, item: 500250, percentage: 25, amount: 2, partial: 0.5, perUnit: component.Cost, description: component.Name, minerals: component })
}

// Rows the loader skips (Game.LoadIndustrialProjects, Game.cs:18652-18679), each on a design of the planted projects and the race's own colony but for one thing: a species of 0, which is the column's default and the game's species list lacks (the earlier plants wrote it); a species the game does not hold; a wealth use `DIM_WealthUse` does not hold; and a colony the game does not hold.
const SKIPPED = [
  { id: 9011, why: 'species 0', flag: 'species', of: 9001, over: { species: 0 } },
  { id: 9012, why: 'a species the game does not hold', flag: 'species', of: 9002, over: { species: 99999 } },
  { id: 9013, why: 'a wealth use DIM_WealthUse does not hold', flag: 'wealth', of: 9003, over: { wealth: 9999 } },
  { id: 9014, why: 'a colony the game does not hold', flag: 'colony', of: 9001, over: { population: 99999999 } },
]

const plantSkipped = (database, planted) => SKIPPED.map((skip) => {
  const base = planted.find((fact) => fact.id === skip.of)
  const spec = SPECS.find((one) => one.id === skip.of)

  return { ...plantProject(database, { ...spec, id: skip.id }, { species: base.species, ...skip.over, item: base.item, percentage: 5, population: skip.over.population !== undefined ? skip.over.population : base.population }), why: skip.why, flag: skip.flag }
})

const NO_LABS = 48980
const LAB_COLONY = 48977
const plantLabs = (database, amount = 5) => database.run(`insert into FCT_PopulationInstallations (GameID, PopID, PlanetaryInstallationID, Amount) values (${GAME}, ${LAB_COLONY}, 8, ${amount})`)
const plantDeadProject = (database) => database.run(`insert into FCT_ResearchProject (ProjectID, GameID, TechID, RaceID, PopulationID, Facilities, ResSpecID, ResearchPointsRequired, Pause, AssignNew) values (9101, ${GAME}, 750, ${RACE}, ${NO_LABS}, 3, 3, 2000, 0, 0)`)
const setFlag = (database, value) => database.run(`update FCT_Race set NoResearchProjects = ${value} where GameID = ${GAME} and RaceID = ${RACE}`)

const PLANTS = {
  intact: () => ({}),
  projects: (database) => ({ planted: plantAll(database, SPECS) }),
  full: (database) => ({ planted: plantAll(database, FULL) }),
  paused: (database) => ({ planted: plantAll(database, SPECS, { 9001: { pause: 1 }, 9002: { pause: 1 }, 9003: { pause: 1 } }) }),
  skewed: (database) => ({ planted: plantAll(database, SPECS, { 9001: { perUnit: 800 } }) }),
  unread: (database) => {
    const planted = plantAll(database, SPECS)

    database.run('drop table FCT_MissileType')
    database.run('drop table FCT_GroundUnitClass')

    return { planted }
  },
  absent: (database) => {
    const planted = plantAll(database, SPECS)
    const itemOf = (type) => planted.find((fact) => fact.type === type).item

    database.run(`delete from FCT_ShipDesignComponents where SDComponentID = ${itemOf(5)}`)
    database.run(`delete from FCT_MissileType where MissileID = ${itemOf(6)}`)
    database.run(`delete from FCT_GroundUnitClass where GroundUnitClassID = ${itemOf(7)}`)

    return { planted }
  },
  loaded: (database) => {
    const planted = plantAll(database, SPECS)

    plantComponentProject(database)

    return { planted }
  },
  unloaded: (database) => {
    const planted = plantAll(database, SPECS)

    plantComponentProject(database)

    return { planted, skipped: plantSkipped(database, planted) }
  },
  idleLabs: (database) => { plantLabs(database) },
  setting: (database) => { plantLabs(database); plantDeadProject(database); setFlag(database, 1) },
  settingOff: (database) => { plantLabs(database); plantDeadProject(database) },
  settingNull: (database) => { plantLabs(database); plantDeadProject(database); setFlag(database, 'null') },
  settingText: (database) => { plantLabs(database); plantDeadProject(database); setFlag(database, '\'maybe\'') },
  settingAbsent: (database) => { plantLabs(database); plantDeadProject(database); database.run('alter table FCT_Race drop column NoResearchProjects') },
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

const adapterOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })

// ---- What the save says, in SQL written here --------------------------------------------------------------------------
// The colonies of the race that a free capacity check lists, from the installations of the capacity and the shares of the projects of its types that are not queued: the colonies with a factory whose projects leave more than `minimum` percent of the capacity unused.
const oracleFreeColonies = (database, { value, types, minimum }) => database.query(`select FCT_Population.PopulationID as ID, 100 - coalesce((select sum(FCT_IndustrialProjects.Percentage) from FCT_IndustrialProjects where FCT_IndustrialProjects.PopulationID = FCT_Population.PopulationID and FCT_IndustrialProjects.Queue = 0 and FCT_IndustrialProjects.ProductionType in (${types.join(', ')})), 0) as Free from FCT_Population where FCT_Population.GameID = ${GAME} and FCT_Population.RaceID = ${RACE} and (select coalesce(sum(FCT_PopulationInstallations.Amount), 0) from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and DIM_PlanetaryInstallation.${value} > 0) > 0 and Free > ${minimum} order by FCT_Population.PopulationID`).all().map((row) => row.ID)

const readWarning = async (w, group, key, database, extra = {}) => {
  const modules = await w.modules()
  const found = modules[`warnings/${group}`].checks.find((one) => one.key === key)

  assert.ok(found, `the ${group} warnings have a check keyed ${key}`)

  return await found.read({ GameID: GAME, RaceID: RACE, RaceNPR: false, database: adapterOf(database), separator: SEPARATOR, count: modules['warnings/common'].counter(SEPARATOR), options: {}, ...extra })
}

const idsOf = (rows) => rows.map((row) => Number(row.id.split(':')[1])).sort((a, b) => a - b)

// The figure as a page words it: whole numbers as they are, others to two decimals.
const figure = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2))

const MODIFIERS = { ConstructionProduction: 100, OverallProductionModifier: 1, ConstructionPower: 1, GroundConstructionPower: 0, OrdnanceProduction: 10, OrdnanceProductionPower: 1, FighterProduction: 0, FighterProductionPower: 0, MinConstructionPeriod: 86400 }
const CAPACITY = { construction: 100, ordnance: 10 }

// The Production page on a copy, its own reads run and its forecast started, with the capacity of every colony of the planted projects given (the page reads it through the capability report of the app).
const productionOn = async (w, database) => {
  const options = await w.production()
  const populations = Object.fromEntries([48977, 48979, 49051].map((id) => [id, { PopName: `Colony ${id}`, ...MODIFIERS }]))
  const vm = instantiate(options, { ...STORE, database: adapterOf(database), GameID: GAME, RaceID: RACE, data: { populationProductionModifiers: populations, arrivals: [] } })

  await vm.runAsync('industry')
  await vm.runAsync('developments')
  await vm.startForecast()

  return vm
}

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('types', 'every production type from 0 to 7 draws on the capacity the source gives it (Engineering, Ground Unit, Component, Construction and Space Station on construction, Ordnance and Ordnance Projects on ordnance, Light Naval on its own) through capacityKind, categoryOf and the capacity the mineral demand asks for, a type that is no number is unknown, and only 5, 6 and 7 are development projects with their names and items', async (w) => {
  const { 'production-types': t, production: p, minerals: m } = await w.modules()

  for (let type = 0; type <= 7; type++) {
    assert.equal(t.capacityKind(type), KIND_OF[type], `capacityKind of ${type}`)
    assert.equal(p.categoryOf(type), KIND_OF[type], `categoryOf of ${type}`)
    assert.equal(t.PRODUCTION_TYPE_NAMES[type], TYPE_NAMES[type], `the name of type ${type}`)
    assert.equal(t.isDevelopmentType(type), type >= 5, `type ${type} is ${type >= 5 ? '' : 'not '}a development project`)
  }

  for (const unknown of [null, undefined, 'x', NaN]) {
    assert.equal(p.categoryOf(unknown), 'unknown', `categoryOf of ${String(unknown)} is unknown, never construction`)
  }

  assert.equal(t.isDevelopmentType(8), false, 'a type above 7 is no development project')
  assert.equal(t.isDevelopmentType(undefined), false, 'no type is no development project')
  assert.deepEqual(Object.keys(TYPES_OF).map((kind) => t.typesOf(kind)), Object.values(TYPES_OF), 'the types of each capacity')
  assert.deepEqual([5, 6, 7].map((type) => t.DEVELOPMENT_ITEMS[type]), ['component', 'missile', 'ground unit class'], 'the item each development project develops')

  const row = (type) => ({ ProductionType: type, PopulationID: 1, Queue: 0, Amount: 1, ProdPerUnit: 10, Percentage: 100, ...Object.fromEntries(MINERAL_NAMES.map((name) => [name, 1])) })

  for (let type = 0; type <= 7; type++) {
    const asked = []

    m.annualQueueDemand([row(type)], (_population, facility) => { asked.push(facility); return 100 })
    assert.deepEqual(asked, [KIND_OF[type]], `the mineral demand of a type ${type} project asks for the ${KIND_OF[type]} capacity`)
  }

  const undecided = []

  m.annualQueueDemand([row(null)], (_population, facility) => { undecided.push(facility); return 100 })
  assert.deepEqual(undecided, [], 'a project without a type asks for no capacity')
})

check('warnings', 'the Industry free capacity checks on a copy with an Engineering Project at 100% of Earth\'s construction, a Ground Unit Project at 100% of Aurelia\'s and an Ordnance Project at 100% of its ordnance list the colonies the SQL and the type lists of the source give, and the paused list names the capacity of each project (Construction, Ordnance, Construction)', async (w) => {
  const cases = [
    ['free-construction-capacity', { value: 'ConstructionValue', minimum: 0.00006, types: TYPES_OF.construction }],
    ['free-ordnance-capacity', { value: 'OrdnanceProductionValue', minimum: 0, types: TYPES_OF.ordnance }],
    ['free-fighter-capacity', { value: 'FighterProductionValue', minimum: 0, types: TYPES_OF.fighter }],
  ]

  for (const copy of ['intact', 'projects', 'full']) {
    const { database } = copyOf(copy)

    for (const [key, oracle] of cases) {
      const shown = idsOf(await readWarning(w, 'industry', key, database))

      assert.deepEqual(shown, oracleFreeColonies(database, oracle), `${copy}: the colonies of ${key}`)
    }
  }

  const before = Object.fromEntries(await Promise.all(cases.map(async ([key]) => [key, idsOf(await readWarning(w, 'industry', key, copyOf('intact').database))])))
  const after = Object.fromEntries(await Promise.all(cases.map(async ([key]) => [key, idsOf(await readWarning(w, 'industry', key, copyOf('full').database))])))

  assert.ok(before['free-construction-capacity'].includes(48977) && before['free-construction-capacity'].includes(48979), 'the fixture lists Earth and Aurelia for free construction capacity')
  assert.ok(!after['free-construction-capacity'].includes(48977), 'an Engineering Project at 100% takes Earth off the free construction list')
  assert.ok(!after['free-construction-capacity'].includes(48979), 'a Ground Unit Project at 100% takes Aurelia off it')
  assert.ok(before['free-ordnance-capacity'].includes(48979) && !after['free-ordnance-capacity'].includes(48979), 'an Ordnance Project at 100% takes Aurelia off the free ordnance list')
  assert.deepEqual(after['free-fighter-capacity'], before['free-fighter-capacity'], 'no development project takes light naval capacity')

  const paused = await readWarning(w, 'industry', 'paused-industrial-projects', copyOf('paused').database)

  assert.equal(paused.length, 3, 'the three planted projects are paused')

  for (const [id, kind] of [[9001, 'Construction'], [9002, 'Ordnance'], [9003, 'Construction']]) {
    const found = paused.find((row) => row.id === `project:${id}`)

    assert.ok(found, `project ${id} is listed as paused`)
    assert.equal(found.cells.kind, kind, `project ${id} names its capacity as ${kind}`)
  }
})

check('legacy', 'the queue basis of the Legacy consumption notes an NPR\'s ordnance for an Ordnance Project (the category of its capacity is ordnance, Population.cs:2240) and not for an Engineering or a Ground Unit Project, and not for a race that is no NPR', async (w) => {
  const { 'legacy-consumption': legacy } = await w.modules()
  const basis = (type, npr) => legacy.industryBasis({ projects: [{ ProductionType: type }, { ProductionType: 0 }], npr })
  const note = /an NPR's ordnance is not charged to its minerals in the game/

  for (let type = 0; type <= 7; type++) {
    assert.equal(note.test(basis(type, true)), KIND_OF[type] === 'ordnance', `an NPR queue with a type ${type} project ${KIND_OF[type] === 'ordnance' ? 'carries' : 'carries no'} the ordnance note`)
    assert.ok(!note.test(basis(type, false)), `a race that is no NPR never carries the note (type ${type})`)
  }

  assert.equal(basis(6, false), '2 projects queued or running', 'the basis counts the projects')
})

check('jobs', 'the Production page\'s industry and developments reads and its industryJobs on the copy with the three projects name each by its type, build it at its share of the capacity of its kind (construction 100 BP/yr, ordnance 10) and word its item, cost and minerals; a stored cost that is not twice the development cost is stated as stored, and an item the save lacks is said so', async (w) => {
  const { database, facts } = copyOf('projects')
  const vm = await productionOn(w, database)
  const read = vm.developments

  assert.deepEqual(read.unread, [], 'every table of the three kinds is read')
  assert.deepEqual(Object.keys(read.items).map(Number).sort(), [9001, 9002, 9003], 'an entry for each project')

  for (const fact of facts.planted) {
    const entry = read.items[fact.id]

    assert.deepEqual([entry.type, entry.itemId, entry.name, entry.developCost], [fact.type, fact.item, fact.name, fact.develop], `the item of project ${fact.id}`)

    const job = vm.industryJobs.find((one) => one.key === `industry-${fact.id}`)

    assert.ok(job, `project ${fact.id} is a job`)
    assert.equal(job.detail, TYPE_NAMES[fact.type], `project ${fact.id} is named ${TYPE_NAMES[fact.type]}`)
    assert.ok(near(job.rateResult.value, CAPACITY[KIND_OF[fact.type]] * fact.percentage / 100), `project ${fact.id} builds ${CAPACITY[KIND_OF[fact.type]] * fact.percentage / 100} BP/yr, not ${job.rateResult.value}`)
    assert.equal(job.rateNote, `${fact.percentage}% of ${KIND_OF[fact.type]}`, `project ${fact.id} says which capacity it takes`)

    const head = `Develops ${fact.name} (${fact.label}): ${figure(fact.perUnit)} BP, twice its development cost of ${figure(fact.develop)} BP`

    assert.ok(job.terms.startsWith(head), `project ${fact.id}: "${job.terms}" does not open with "${head}"`)

    const listed = MINERAL_NAMES.filter((name) => fact.minerals[name] > 0)

    assert.ok(listed.length > 0, `project ${fact.id} has minerals`)
    assert.equal(job.terms, `${head} · ${listed.map((name) => `${name} ${figure(fact.minerals[name])} t`).join(', ')}`, `project ${fact.id}: the line of its item, cost and minerals`)
  }

  const light = vm.industryJobs.filter((job) => !job.key.match(/^industry-900\d$/) && job.key.startsWith('industry-'))

  assert.ok(light.length === 10 && light.every((job) => job.terms === '' && job.detail === 'Light Naval'), 'the fixture\'s ten Light Naval projects carry no line and are named by their type')

  const skewed = await productionOn(w, copyOf('skewed').database)
  const odd = skewed.industryJobs.find((job) => job.key === 'industry-9001')
  const plantedOf = (copy, type) => copyOf(copy).facts.planted.find((fact) => fact.type === type)
  const engineering = plantedOf('skewed', 5)
  const missile = plantedOf('skewed', 6)

  assert.ok(new RegExp(`: 800 BP, against its development cost of ${figure(engineering.develop)} BP`).test(odd.terms) && !/twice/.test(odd.terms), `a stored cost of 800 against a development cost of ${engineering.develop} is stated as stored: ${odd.terms}`)
  assert.ok(new RegExp(`twice its development cost of ${figure(missile.develop)} BP`).test(skewed.industryJobs.find((job) => job.key === 'industry-9002').terms), 'the others stay twice')

  const unread = await productionOn(w, copyOf('unread').database)
  const unreadEngineering = plantedOf('unread', 5)

  assert.deepEqual([...unread.developments.unread].sort(), [6, 7], 'a save without the missile and ground unit class tables leaves their kinds unread')
  assert.equal(unread.industryJobs.find((job) => job.key === 'industry-9002').terms, 'Develops a missile: the item and its development cost are not in the save\'s tables', 'the Ordnance Project says the table is missing')
  assert.equal(unread.industryJobs.find((job) => job.key === 'industry-9003').terms, 'Develops a ground unit class: the item and its development cost are not in the save\'s tables', 'and so does the Ground Unit Project')
  assert.ok(unread.industryJobs.find((job) => job.key === 'industry-9001').terms.startsWith(`Develops ${unreadEngineering.name} (component): ${figure(unreadEngineering.perUnit)} BP, twice its development cost of ${figure(unreadEngineering.develop)} BP`), 'the Engineering Project is still worded')

  const absent = await productionOn(w, copyOf('absent').database)
  const terms = (key) => absent.industryJobs.find((job) => job.key === key).terms
  const absentOf = (type) => plantedOf('absent', type)

  assert.ok(terms('industry-9001').startsWith(`Develops a component the save does not hold: ${figure(absentOf(5).perUnit)} BP, twice its development cost of ${figure(absentOf(5).develop)} BP`), `a component the save lacks: ${terms('industry-9001')}`)
  assert.ok(terms('industry-9002').startsWith(`Develops a missile the save does not hold: ${figure(absentOf(6).perUnit)} BP, twice its development cost of ${figure(absentOf(6).develop)} BP`), `a missile the save lacks: ${terms('industry-9002')}`)
  assert.ok(terms('industry-9003').startsWith(`Develops a ground unit class the save does not hold: ${figure(absentOf(7).perUnit)} BP, its development cost not stored`), `a class the save lacks (its tech is reached through it): ${terms('industry-9003')}`)
})

check('render', 'the name cell of the Industry jobs draws the line of a development project in an element marked data-industry-terms and none for a job without one', async (w) => {
  const text = w.texts.productionPage
  const cell = text.match(/<template #\[`item\.name`\]="\{ item \}">([\s\S]*?)\n {12}<\/template>/)

  assert.ok(cell, 'the page has a name cell for its jobs')

  const component = `<template><div>${cell[1]}</div></template>`
  const { database } = copyOf('projects')
  const vm = await productionOn(w, database)
  const draw = (job) => renderTree(component, { item: job, typeColors: {}, typeLabels: { industry: 'Industry' }, linkTo: { techTree: () => ({}), shipyards: () => ({}) }, focusId: null })
  const termsOf = (job) => treeOf(draw(job).tree).filter((node) => attrsOf(node)['data-industry-terms'] !== undefined)

  for (const key of ['industry-9001', 'industry-9002', 'industry-9003']) {
    const job = vm.industryJobs.find((one) => one.key === key)
    const [node] = termsOf(job)

    assert.ok(node, `the job ${key} has an element for its line`)
    assert.equal(termsOf(job).length, 1, `the job ${key} has one`)
    assert.ok(draw(job).texts.includes(job.terms), `the job ${key} draws "${job.terms}"`)
  }

  const ordinary = vm.industryJobs.find((job) => job.key === 'industry-2')

  assert.ok(ordinary && ordinary.terms === '', 'a Light Naval job has no line')
  assert.equal(termsOf(ordinary).length, 0, 'and draws no element for it')
})

check('manifest-read', 'the procurement loader gives each queued component, Engineering, Ordnance and Ground Unit Project its production type, component and colony as the table stores them, and leaves out every other type (the ten Light Naval projects of the fixture)', async (w) => {
  const { 'procurement-data': data } = await w.modules()
  const { database } = copyOf('loaded')
  const { projects, read } = await data.loadProcurementSources(adapterOf(database), { GameID: GAME, RaceID: RACE })
  const stored = database.query(`select ProjectID, ProductionType, PopulationID, ProductionID from FCT_IndustrialProjects where GameID = ${GAME} and RaceID = ${RACE} and ProductionType in (3, 5, 6, 7) order by ProjectID`).all()

  assert.equal(read.projects, true, 'the projects were read')
  assert.equal(data.COMPONENT_PROJECT, 3, 'a component project is type 3')
  assert.deepEqual(stored.map((row) => [row.ProjectID, row.ProductionType]), [[9001, 5], [9002, 6], [9003, 7], [9004, 3]], 'the copy holds the three development projects and one component project')
  assert.deepEqual(projects.map((project) => [project.id, project.productionType, project.populationId, project.componentId]), stored.map((row) => [row.ProjectID, row.ProductionType, row.PopulationID, row.ProductionID]), 'the loader reads exactly those rows, each with its type')
  assert.equal(database.query(`select count(*) as N from FCT_IndustrialProjects where GameID = ${GAME} and RaceID = ${RACE} and ProductionType = 2`).get().N, 10, 'the fixture holds ten Light Naval projects, none of them read')
})

// The columns `Game.LoadIndustrialProjects` reads of a project row (Game.cs:18652-18779): the 28 that `SaveIndustrialProjects` writes (Game.cs:11479-11540).
const LOADER_COLUMNS = ['ProjectID', 'GameID', 'RaceID', 'PopulationID', 'SpeciesID', 'Percentage', 'ProductionType', 'ProductionID', 'RefitClassID', 'WealthUse', 'Amount', 'PartialCompletion', 'ProdPerUnit', 'Description', 'Pause', 'Queue', 'FuelRequired', ...MINERAL_NAMES]

// What decides whether the game loads a row, in SQL written here: the loader looks the row's race, colony, species and wealth use up in the lists it has loaded (`LoadSpecies` reads the `FCT_Species` rows of the game, Game.cs:19940, and `LoadWealthUses` the rows of `DIM_WealthUse`) and skips the row when one is missing (Game.cs:18652-18679).
const FLAGS = 'exists (select 1 from FCT_Race where FCT_Race.GameID = p.GameID and FCT_Race.RaceID = p.RaceID) as race, exists (select 1 from FCT_Population where FCT_Population.GameID = p.GameID and FCT_Population.PopulationID = p.PopulationID) as colony, exists (select 1 from FCT_Species where FCT_Species.GameID = p.GameID and FCT_Species.SpeciesID = p.SpeciesID) as species, exists (select 1 from DIM_WealthUse where DIM_WealthUse.WealthUseID = p.WealthUse) as wealth'
const flagsOf = (database, id) => database.query(`select ${FLAGS} from FCT_IndustrialProjects as p where p.GameID = ${GAME} and p.ProjectID = ${id}`).get()
const loadedIds = (database) => database.query(`select ProjectID as ID from (select p.ProjectID, ${FLAGS} from FCT_IndustrialProjects as p where p.GameID = ${GAME} and p.RaceID = ${RACE}) where race and colony and species and wealth order by ProjectID`).all().map((row) => row.ID)
const byNumber = (a, b) => a - b

// The queue a project got when it was made, from the projects of its colony made before it (`Population.method_138`, Population.cs:6917-6931).
const queueBefore = (database, row) => {
  const same = database.query(`select Queue, Percentage, ProductionType from FCT_IndustrialProjects where PopulationID = ${row.PopulationID} and ProjectID < ${row.ProjectID}`).all().filter((one) => KIND_OF[one.ProductionType] === KIND_OF[row.ProductionType])
  const taken = same.filter((one) => one.Queue === 0).reduce((sum, one) => sum + one.Percentage, 0)

  return 100 - taken >= row.Percentage ? 0 : Math.max(...same.map((one) => one.Queue)) + 1
}

check('loader', 'every planted project row is a row of the shape the game writes and loads (all 28 columns it reads set, the colony\'s species, the wealth use of its type, the nothing-built values of a new project, the queue the game gives, minerals scaled to twice the development cost) on a design of the race that is its own, no prototype or shipping line system or missile engine and no RaceTech row; and the Production page\'s industry, development and procurement reads leave out exactly the rows the game\'s loader skips (a species of 0 or one the game does not hold, a wealth use DIM_WealthUse does not hold, a colony the game does not hold) and none it loads', async (w) => {
  const { 'procurement-data': data } = await w.modules()
  const missileEngine = copyOf('intact').database.query('select ComponentTypeID as ID from DIM_ComponentType where TypeDescription = \'Missile Engine\'').get().ID
  const kindOfProject = { 5: 'component', 6: 'missile', 7: 'ground unit class' }
  const rowOf = (database, id) => database.query(`select * from FCT_IndustrialProjects where ProjectID = ${id}`).get()

  for (const copy of ['projects', 'full', 'paused', 'skewed', 'loaded', 'unloaded']) {
    const { database, facts } = copyOf(copy)
    const facing = [...facts.planted, ...(facts.skipped || [])]

    for (const fact of facing) {
      const row = rowOf(database, fact.id)
      const where = `${copy}: project ${fact.id}`

      assert.ok(row, `${where} is in the copy`)

      for (const column of LOADER_COLUMNS) {
        assert.ok(row[column] !== null && row[column] !== undefined, `${where}: the column ${column} the loader reads is set`)
      }

      assert.deepEqual([row.GameID, row.RaceID, row.PopulationID, row.ProductionType, row.ProductionID], [GAME, RACE, fact.population, fact.type, fact.item], `${where}: its race, colony, type and item`)
      assert.deepEqual([row.RefitClassID, row.Amount, row.PartialCompletion, row.FuelRequired], [0, 1, 0, 0], `${where}: a new project has no refit class, one unit, nothing built and no fuel`)
      assert.equal(row.Description, `${fact.name} Project`, `${where}: named after its item`)
      assert.equal(row.Queue, queueBefore(database, row), `${where}: the queue the game gives`)
      assert.ok(near(row.ProdPerUnit, fact.perUnit), `${where}: its cost per unit is the planted one`)

      for (const name of MINERAL_NAMES) {
        assert.ok(near(row[name], fact.minerals[name]), `${where}: ${name} is the item's, scaled`)
      }

      const colonySpecies = database.query(`select SpeciesID from FCT_Population where PopulationID = ${fact.population}`).get()

      if (fact.flag === undefined) {
        assert.equal(row.SpeciesID, colonySpecies.SpeciesID, `${where}: the colony's species`)
        assert.equal(row.WealthUse, WEALTH_OF[fact.type], `${where}: the wealth use of its type`)
        assert.deepEqual(flagsOf(database, fact.id), { race: 1, colony: 1, species: 1, wealth: 1 }, `${where}: the loader finds its race, colony, species and wealth use`)
        assert.ok(loadedIds(database).includes(fact.id), `${where} is loaded`)
      } else {
        const flags = flagsOf(database, fact.id)

        assert.deepEqual(Object.entries(flags).filter(([, held]) => !held).map(([name]) => name), [fact.flag], `${where}: the loader skips it for ${fact.why} and for nothing else`)
      }

      const techId = fact.type === 7 ? database.query(`select TechSystemID as ID from FCT_GroundUnitClass where GroundUnitClassID = ${fact.item}`).get().ID : fact.item
      const tech = database.query(`select GameID, RaceID from FCT_TechSystem where TechSystemID = ${techId}`).get()

      assert.deepEqual(tech && [tech.GameID, tech.RaceID], [GAME, RACE], `${where}: its ${kindOfProject[fact.type]} is a tech of the race in this game, not a stock or foreign design`)
      assert.equal(database.query(`select count(*) as N from FCT_RaceTech where GameID = ${GAME} and RaceID = ${RACE} and TechID = ${techId}`).get().N, 0, `${where}: the race has not researched it (Race.method_305, Race.cs:17146)`)

      if (fact.type === 5) {
        const component = database.query(`select GameID, Prototype, ShippingLineSystem, ComponentTypeID from FCT_ShipDesignComponents where SDComponentID = ${fact.item}`).get()

        assert.deepEqual([component.GameID, component.Prototype, component.ShippingLineSystem], [GAME, 0, 0], `${where}: the component is no prototype and no shipping line system (Population.method_178)`)
        assert.notEqual(component.ComponentTypeID, missileEngine, `${where}: the component is no missile engine`)
      } else if (fact.type === 6) {
        const missile = database.query(`select GameID, EngineID from FCT_MissileType where MissileID = ${fact.item}`).get()
        const engine = missile.EngineID === 0 ? null : database.query(`select GameID, RaceID from FCT_TechSystem where TechSystemID = ${missile.EngineID}`).get()

        assert.equal(missile.GameID, GAME, `${where}: the missile is of this game`)
        assert.ok(engine === null || (engine.GameID === GAME && engine.RaceID === RACE), `${where}: the missile carries no other race's engine`)
      } else {
        assert.equal(database.query(`select GameID from FCT_GroundUnitClass where GroundUnitClassID = ${fact.item}`).get().GameID, GAME, `${where}: the class is of this game`)
      }
    }
  }

  const { database, facts } = copyOf('unloaded')
  const loaded = loadedIds(database)
  const skipped = facts.skipped.map((fact) => fact.id).sort(byNumber)
  const developments = (ids) => ids.filter((id) => rowOf(database, id).ProductionType >= 5)
  const queued = (ids) => ids.filter((id) => [3, 5, 6, 7].includes(rowOf(database, id).ProductionType))

  assert.deepEqual(skipped, [9011, 9012, 9013, 9014], 'four rows are planted for the loader to skip')
  assert.ok(skipped.every((id) => !loaded.includes(id)), 'the oracle skips them')
  assert.deepEqual(loaded.filter((id) => id >= 9000), [9001, 9002, 9003, 9004], 'and loads the planted projects')
  assert.equal(loaded.filter((id) => id < 9000).length, 10, 'and the fixture\'s ten projects')

  const vm = await productionOn(w, database)
  const { projects, read } = await data.loadProcurementSources(adapterOf(database), { GameID: GAME, RaceID: RACE })

  assert.deepEqual(vm.industry.map((row) => row.ID).sort(byNumber), loaded, 'the industry read holds the rows the loader loads and none it skips')
  assert.deepEqual(vm.industryJobs.filter((job) => job.key.startsWith('industry-')).map((job) => Number(job.key.slice('industry-'.length))).sort(byNumber), loaded, 'every loaded project is a job and no skipped row is')
  assert.deepEqual(Object.keys(vm.developments.items).map(Number).sort(byNumber), developments(loaded), 'the development items are those of the loaded development projects')
  assert.equal(read.projects, true, 'the procurement loader reads the projects')
  assert.deepEqual(projects.map((project) => project.id).sort(byNumber), queued(loaded), 'the procurement loader holds the loaded queued component and development projects')

  for (const id of skipped) {
    assert.ok(!vm.industry.some((row) => row.ID === id) && !(id in vm.developments.items) && !projects.some((project) => project.id === id), `no read counts the skipped row ${id}`)
  }
})

const PARTS = { 1: [{ componentId: 101, name: 'Engine', typeId: 1, count: 2, cost: 10, minerals: {}, prototype: 0, shippingLine: 0, researched: 1, obsolete: 0 }, { componentId: 102, name: 'Sensor', typeId: 2, count: 1, cost: 10, minerals: {}, prototype: 0, shippingLine: 0, researched: 1, obsolete: 0 }] }
const COLONIES = { 1: { id: 1, name: 'Target', systemId: 10, systemName: 'Home', yards: 1 }, 3: { id: 3, name: 'Near', systemId: 10, systemName: 'Home', yards: 0 } }
const STOCK = { 1: { 101: 1 } }
const COMPONENTS = { 101: { tons: 50 }, 102: { tons: 100 } }
const PLANS = [{ id: 1, classId: 1, className: 'Alpha', hulls: 2 }]
const queued = (id, productionType, populationId, componentId, amount, extra = {}) => ({ id, productionType, populationId, componentId, amount, partial: 0, percentage: 50, queue: 0, paused: 0, name: `Project ${id}`, ...extra })
const reconciled = (pm, projects) => pm.reconcile({ plans: PLANS, parts: PARTS, stock: STOCK, colonies: COLONIES, targetId: 1, projects, projectsRead: true, tasks: [], tasksRead: true, entered: [], components: COMPONENTS })
const rowOf = (result, componentId) => result.rows.find((row) => row.componentId === componentId)

check('manifest', 'a component project and an Engineering Project count as queued supply of their component (3 of the sensor here, 4 of the engine at another colony), an Ordnance and a Ground Unit Project never, even with the id of a component, a project without a type counts as a component project as before, and the manifest says how many of each kind it read in its page, its CSV and its text', async (w) => {
  const { 'procurement-manifest': pm } = await w.modules()
  const sensor = (result) => rowOf(result, 102).queued
  const engine = (result) => rowOf(result, 101).queued

  const none = reconciled(pm, [])

  assert.deepEqual([sensor(none).local, engine(none).remote], [0, 0], 'no project, no supply')

  const engineering = reconciled(pm, [queued(1, 5, 1, 102, 3), queued(2, 3, 3, 101, 4)])

  assert.equal(sensor(engineering).local, 3, 'an Engineering Project of 3 sensors at the build colony is 3 queued there')
  assert.equal(engine(engineering).remote, 4, 'a component project of 4 engines at another colony is 4 queued elsewhere')

  const collision = reconciled(pm, [queued(1, 6, 1, 102, 3), queued(2, 7, 1, 101, 5), queued(3, 6, 3, 101, 2)])

  assert.deepEqual([sensor(collision).local, engine(collision).local, engine(collision).remote], [0, 0, 0], 'an Ordnance Project on the missile 102 and Ground Unit Projects on the class 101 supply no component of those ids')
  assert.deepEqual(collision.projectKinds, { components: 0, engineering: 0, ordnance: 2, groundUnit: 1 }, 'they are counted by kind')

  const legacy = reconciled(pm, [{ id: 1, populationId: 1, componentId: 102, amount: 2, partial: 0, percentage: 50, queue: 0, paused: 0, name: 'Old' }])

  assert.equal(sensor(legacy).local, 2, 'a project read without its type is a component project')

  const mixed = reconciled(pm, [queued(1, 5, 1, 102, 3), queued(2, 3, 1, 102, 1), queued(3, 6, 1, 102, 7), queued(4, 6, 3, 101, 1), queued(5, 7, 1, 101, 1)])

  assert.equal(sensor(mixed).local, 4, 'the Engineering and the component project add up, the Ordnance Project adds nothing')
  assert.deepEqual(mixed.projectKinds, { components: 1, engineering: 1, ordnance: 2, groundUnit: 1 }, 'the manifest counts each kind')

  assert.equal(pm.developmentNote({ components: 3, engineering: 0, ordnance: 0, groundUnit: 0 }), null, 'component projects alone need no note')
  assert.equal(pm.developmentNote(pm.projectKinds([])), null, 'no project needs none either')
  assert.equal(pm.developmentNote(mixed.projectKinds), 'Development projects queued: 1 Engineering Project (counted as component supply), 2 Ordnance Projects (adds ordnance, not component supply), 1 Ground Unit Project (adds no unit, not component supply)', 'the note')

  const csv = pm.manifestCsv(mixed)
  const context = csv.split('\n').filter((line) => line.includes('Development projects queued'))

  assert.equal(context.length, 1, 'the CSV carries the note once')
  assert.ok(/^context,/.test(context[0]) || context[0].split(',').includes('context'), `as a context record: ${context[0]}`)
  assert.ok(pm.manifestText(mixed).split('\n').includes(pm.developmentNote(mixed.projectKinds)), 'the text carries it as a line')
  assert.ok(!pm.manifestCsv(none).includes('Development projects queued') && !pm.manifestText(none).includes('Development projects queued'), 'a manifest without development projects carries no note')
})

check('manifest-view', 'the manifest component of the Production page draws the note of the development projects in an element marked data-manifest-projects when the plans read some and no element without them', async (w) => {
  const options = await w.manifestView()
  const text = w.texts.manifestView
  const sources = { classes: [{ id: 1, name: 'Alpha', obsolete: false }], parts: PARTS, stock: STOCK, minerals: {} }
  const view = (projects) => instantiate(options, { ...STORE, data: { sources, procurement: { colonies: COLONIES, tasks: [], projects, components: COMPONENTS, read: { colonies: true, tasks: true, projects: true, components: true } }, plans: [{ id: 1, classId: 1, hulls: '2' }], chosenTarget: 1, entered: [], message: '', headers: [], moveHeaders: [] } })
  const drawn = (projects) => { const vm = view(projects); const { tree, texts } = renderTree(text, vm); return { nodes: treeOf(tree).filter((node) => attrsOf(node)['data-manifest-projects'] !== undefined), texts } }

  const some = [queued(1, 5, 1, 102, 3), queued(2, 6, 1, 102, 2), queued(3, 7, 3, 101, 1)]
  const withProjects = drawn(some)

  assert.equal(withProjects.nodes.length, 1, 'one element for the note')
  assert.ok(withProjects.texts.includes('Development projects queued: 1 Engineering Project (counted as component supply), 1 Ordnance Project (adds ordnance, not component supply), 1 Ground Unit Project (adds no unit, not component supply)'), `it draws the note: ${withProjects.texts.join(' | ')}`)
  assert.equal(drawn([queued(1, 3, 1, 102, 3)]).nodes.length, 0, 'a component project alone draws none')
  assert.equal(drawn([]).nodes.length, 0, 'no project draws none')
})

check('no-research', 'the idle research labs and dead research projects checks give no rows for a race whose No Research Projects setting is on, rows as before when it is off, rows listed apart as not evaluated when it is not stored (a NULL, a value that is no flag, no column), and the loader reads each as true, false or unknown', async (w) => {
  const { 'research-data': data } = await w.modules()
  const rowsOf = (copy, key) => readWarning(w, 'research', key, copyOf(copy).database)

  const expected = { settingOff: { read: true, value: false }, setting: { read: true, value: true }, settingNull: { read: true, value: null }, settingText: { read: true, value: null }, settingAbsent: { read: false, value: null } }

  for (const [copy, value] of Object.entries(expected)) {
    assert.deepEqual(await data.loadNoResearchProjects(adapterOf(copyOf(copy).database), { GameID: GAME, RaceID: RACE }), value, `the setting of ${copy}`)
  }

  assert.deepEqual(await data.loadNoResearchProjects(adapterOf(copyOf('intact').database), { GameID: GAME, RaceID: RACE }), { read: true, value: false }, 'the fixture\'s races start research projects')
  assert.deepEqual(await data.loadNoResearchProjects(adapterOf(copyOf('intact').database), { GameID: GAME, RaceID: 0 }), { read: false, value: null }, 'no race, no setting')
  assert.deepEqual([data.flagOfStored(1), data.flagOfStored(0), data.flagOfStored(true), data.flagOfStored('1'), data.flagOfStored('false'), data.flagOfStored(null), data.flagOfStored(2), data.flagOfStored('maybe')], [true, false, true, true, false, null, null, null], 'a stored flag is read as a flag or as not known')

  const labs = await rowsOf('settingOff', 'idle-research-labs')

  assert.deepEqual(labs.map((row) => row.id), [`colony:${LAB_COLONY}`], 'the planted colony has idle labs when the race starts research')
  assert.ok(!labs[0].unevaluated, 'and is evaluated')

  const dead = await rowsOf('settingOff', 'dead-research-projects')

  assert.deepEqual(dead.map((row) => row.id), ['project:9101'], 'the planted project is dead when the race starts research')
  assert.ok(!dead[0].unevaluated, 'and is evaluated')

  assert.deepEqual(await rowsOf('setting', 'idle-research-labs'), [], 'a race with the setting on has no idle labs to report')
  assert.deepEqual(await rowsOf('setting', 'dead-research-projects'), [], 'and no dead project')

  for (const copy of ['settingNull', 'settingText', 'settingAbsent']) {
    for (const [key, id] of [['idle-research-labs', `colony:${LAB_COLONY}`], ['dead-research-projects', 'project:9101']]) {
      const rows = await rowsOf(copy, key)

      assert.deepEqual(rows.map((row) => row.id), [id], `${copy}: ${key} still lists the row`)
      assert.ok(rows[0].unevaluated, `${copy}: ${key} lists it as not evaluated, never as a fault`)
      assert.ok(JSON.stringify(rows[0]).includes('No Research Projects setting'), `${copy}: ${key} names the setting it lacks`)
    }
  }

  const { 'warnings/research': warn, provenance } = await w.modules()
  const found = (key) => warn.checks.find((one) => one.key === key)

  for (const key of ['idle-research-labs', 'dead-research-projects']) {
    const { note } = provenance.getRule(found(key).provenance)

    assert.ok(/A race that starts no research projects is not checked\./.test(found(key).rule), `${key}: its rule says the race is not checked`)
    assert.ok(/No Research Projects setting is on is not checked/.test(note) && /setting is not stored is listed apart/.test(note), `${key}: its note says both`)
  }
})

check('no-research-pages', 'the Research page reads the setting, says so in a notice and leaves the idle-lab count and alert icon off for a race that starts no research projects (5 labs built and 3 assigned: "2 idle" and an alert for a race that does), says when the setting is not known, and the Commanders suggestions skip such a race with the reason and are unchanged for one that does not', async (w) => {
  const { 'research-data': data, commanders } = await w.modules()
  const options = await w.technologies()
  const text = w.texts.technologiesPage

  const pageOn = async (copy) => {
    const vm = instantiate(options, { ...STORE, database: adapterOf(copyOf(copy).database), GameID: GAME, RaceID: RACE, data: { ready: true } })

    for (const name of ['catalogue', 'researched', 'projects', 'queue', 'paused', 'labs', 'scientists', 'constructs', 'game', 'race', 'noResearch']) {
      await vm.runAsync(name)
    }

    return vm
  }

  const output = (vm) => vm.tiles.find((tile) => tile.label === 'Research output')

  for (const [copy, value, idle] of [['settingOff', false, true], ['setting', true, false], ['settingNull', null, true], ['settingAbsent', null, true]]) {
    const vm = await pageOn(copy)

    assert.equal(vm.noResearch.value, value, `${copy}: the page's setting`)
    assert.equal(/, 2 idle/.test(output(vm).note), idle, `${copy}: the research output ${idle ? 'counts' : 'leaves out'} the 2 idle labs: ${output(vm).note}`)
    assert.equal(output(vm).icon === 'mdi-alert', idle, `${copy}: the alert icon is ${idle ? 'on' : 'off'}`)
  }

  const alerts = text.match(/<v-alert v-if="noResearch\.value === true"[\s\S]*?<\/v-alert>\s*<v-alert v-else-if="noResearch\.value === null"[\s\S]*?<\/v-alert>/)

  assert.ok(alerts, 'the page has the two notices')

  const component = `<template><div>${alerts[0]}</div></template>`
  const noticesOf = (value) => treeOf(renderTree(component, { noResearch: { value }, noResearchWords: 'THE WORDS' }).tree).filter((node) => node.tag === 'v-alert').map((node) => Object.keys(attrsOf(node)).filter((name) => name.startsWith('data-')))

  assert.deepEqual(noticesOf(true), [['data-no-research']], 'a race with the setting on gets the notice')
  assert.deepEqual(noticesOf(false), [], 'a race with it off gets none')
  assert.deepEqual(noticesOf(null), [['data-no-research-unknown']], 'a race whose setting is not stored gets the notice that says so')
  assert.ok(renderTree(component, { noResearch: { value: true }, noResearchWords: 'THE WORDS' }).texts.includes('THE WORDS'), 'the notice draws the words')
  assert.ok(/The save does not say whether the race may start research projects/.test(alerts[0]), 'the unknown notice says the save does not say')

  const scientist = (id, bonuses, extra = {}) => ({ CommanderID: id, Name: `Scientist ${id}`, CommanderType: 3, CommandType: 0, ResSpecID: 1, bonuses, ...extra })
  const project = { ProjectID: 1, ProjectName: 'Lasers', ScientistID: 0, ResSpecID: 1, Facilities: 2 }
  const free = [scientist(1, { 3: 1.3, 27: 5 })]

  assert.equal(commanders.researchSuggestions([project], free).rows.length, 1, 'a faster scientist is suggested for a race that starts research')
  assert.equal(commanders.researchSuggestions([project], free, new Set(), { noResearch: false }).rows.length, 1, 'also when the setting is known to be off')
  assert.equal(commanders.researchSuggestions([project], free, new Set(), { noResearch: null }).rows.length, 1, 'and when it is not known')
  assert.equal(commanders.researchSuggestions([project], free).skipped, null, 'no reason is given then')

  const skipped = commanders.researchSuggestions([project], free, new Set(), { noResearch: true })

  assert.deepEqual([skipped.rows, skipped.unrated], [[], []], 'a race that starts no research projects gets no suggestion and no unrated project')
  assert.equal(skipped.skipped, data.NO_RESEARCH_WORDS, 'with the reason')
  assert.ok(/starts no research projects/.test(skipped.skipped) && /Engineering, Ordnance and Ground Unit Projects/.test(skipped.skipped), 'the reason names the projects the race uses instead')

  const commandersOptions = await w.commanders()
  const assessed = async (copy) => {
    const vm = instantiate(commandersOptions, { ...STORE, database: adapterOf(copyOf(copy).database), GameID: GAME, RaceID: RACE, data: { projects: [project], byType: { 3: free } } })

    await vm.runAsync('noResearch')

    return { setting: vm.noResearch, assessment: vm.researchAssessment }
  }

  const exempt = await assessed('setting')

  assert.deepEqual(exempt.setting, { read: true, value: true }, 'the Commanders page reads the setting')
  assert.deepEqual([exempt.assessment.rows.length, exempt.assessment.skipped], [0, data.NO_RESEARCH_WORDS], 'and skips the suggestions with the reason')

  for (const copy of ['settingOff', 'settingNull', 'settingAbsent']) {
    const other = await assessed(copy)

    assert.equal(other.assessment.rows.length, 1, `${copy}: the page still suggests the scientist`)
    assert.equal(other.assessment.skipped, null, `${copy}: and gives no reason`)
  }

  assert.ok(/:data-research-skipped="researchAssessment\.skipped \? 'true' : null">\{\{ researchAssessment\.skipped \? researchAssessment\.skipped :/.test(w.texts.commandersPage.replace(/\n\s*/g, ' ')), 'the Commanders table says the reason where it would list suggestions')
})

check('registry', 'the capability registry no longer declares the No Research column as unread, the reads of the setting (Research page, Commanders) and of the development items (Production) are optional inputs that name their columns, and the required reads stay required', async (w) => {
  const { capabilities: c } = await w.modules()

  assert.ok(!c.DECLARED.some((entry) => entry.table === 'FCT_Race' && entry.columns.includes('NoResearchProjects')), 'FCT_Race.NoResearchProjects is not declared as unread any more')
  assert.ok(c.LINE_SIGNATURE.includes('FCT_Race.NoResearchProjects'), 'it is still a column of the 3.2 line signature')

  const input = (route, key) => c.INPUTS[route].find((one) => one.key === key)

  for (const route of ['/technologies', '/commanders']) {
    const read = input(route, 'noResearch')

    assert.ok(read && read.optional === true, `${route} reads the setting as an optional input`)
    assert.deepEqual(read.reads.FCT_Race, ['GameID', 'NoResearchProjects', 'RaceID'], `${route}: the columns it reads`)
  }

  const developments = input('/production', 'developments')

  assert.ok(developments && developments.optional === true, '/production reads the development items as an optional input')
  assert.deepEqual(Object.keys(developments.reads).sort(), ['DIM_WealthUse', 'FCT_GroundUnitClass', 'FCT_IndustrialProjects', 'FCT_MissileType', 'FCT_Population', 'FCT_Race', 'FCT_ShipDesignComponents', 'FCT_Species', 'FCT_TechSystem'], 'the tables it reads, those that decide which project rows the game loads included')
  assert.ok(['SpeciesID', 'WealthUse', 'PopulationID', 'RaceID'].every((column) => developments.reads.FCT_IndustrialProjects.includes(column)), 'it names the project columns the game\'s loader checks')

  const industry = input('/production', 'industry')

  assert.ok(['DIM_WealthUse', 'FCT_Population', 'FCT_Race', 'FCT_Species'].every((table) => industry.reads[table]), 'the industry read names the tables of the loader\'s checks')
  assert.equal(industry.optional, false, 'the industry read stays required')
  assert.equal(input('/technologies', 'catalogue').optional, false, 'so does the catalogue of the Research page')
  assert.equal(input('/commanders', 'projects').optional, false, 'and the projects of the Commanders page')
})

check('text', 'the Industry panel foot says what the line under a development job holds and which capacity the projects draw on, the manifest foot says how the projects count, the page help of /production, /technologies and /commanders says the same, and each new sentence is in the impersonal voice with no release number', async (w) => {
  const production = w.texts.productionPage
  const foot = production.slice(production.indexOf('<div class="panel-foot caption text--secondary">\n            Use it to spot stalled work and shortages.'))

  assert.ok(foot.startsWith('<div class="panel-foot caption text--secondary">'), 'the Industry panel has a foot that opens "Use it to"')
  assert.ok(/An Engineering, Ordnance or Ground Unit Project develops a component, missile or ground unit class the race designed, for twice its stored development cost, and draws on construction capacity \(ordnance capacity for an Ordnance Project\); the line under the job gives the item, its cost and its minerals\./.test(foot.slice(0, 2400)), 'the foot says what a development project is and which capacity it draws on')

  const manifest = w.texts.manifestView

  assert.ok(/A queued Engineering Project counts as a component project, because each unit it completes goes into the colony's stock; an Ordnance Project and a Ground Unit Project are counted by kind above the table and are not supply\./.test(manifest), 'the manifest foot says how each project counts')

  const { glossary: g, 'research-data': data, 'procurement-manifest': pm } = await w.modules()
  const help = (route) => g.PAGE_HELP[route].usage.join('\n')

  assert.ok(/Engineering, Ordnance and Ground Unit Projects are listed with the item they develop, their cost \(twice its development cost\) and their minerals; the procurement manifest counts an Engineering Project as component supply and the other two by kind\./.test(help('/production')), 'the page help of Production')
  assert.ok(/A race that starts no research projects has no Research suggestions, and the table says so\./.test(help('/commanders')), 'the page help of Commanders')
  assert.ok(/A notice at the top says when the race starts no research projects: idle labs are then not flagged, and the race develops components, missiles and ground unit classes by Engineering, Ordnance and Ground Unit Projects on Production\./.test(help('/technologies')), 'the page help of the Research page')

  const sentences = [data.NO_RESEARCH_WORDS, pm.developmentNote({ components: 0, engineering: 1, ordnance: 1, groundUnit: 1 }), foot.slice(0, 2400), manifest.slice(manifest.indexOf('<div class="panel-foot caption')), help('/production'), help('/technologies'), help('/commanders'), text('technologiesPage', w), text('commandersPage', w)]

  for (const sentence of sentences) {
    assert.ok(!/\b(I|we|you|your|our|us)\b/i.test(sentence.replace(/<[^>]*>/g, '').replace(/Use it to/g, '')), `in the impersonal voice: ${sentence.slice(0, 120)}`)
  }

  for (const sentence of [data.NO_RESEARCH_WORDS, pm.developmentNote({ components: 0, engineering: 1, ordnance: 1, groundUnit: 1 })]) {
    assert.ok(!/\b[23]\.[012](\.\d+|\.x)?\b/.test(sentence), `with no release number: ${sentence}`)
  }
})

// The new notices of the two pages, as the text of their alert elements.
const text = (name, w) => (w.texts[name].match(/<v-alert[^>]*data-no-research[^>]*>[\s\S]*?<\/v-alert>/g) || []).join('\n')

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
const ORDNANCE_TYPES = 'const ORDNANCE_TYPES = Object.freeze([PRODUCTION_TYPE.ORDNANCE, PRODUCTION_TYPE.ORDNANCE_PROJECTS])'
const FIGHTER_TYPES = 'const FIGHTER_TYPES = Object.freeze([PRODUCTION_TYPE.LIGHT_NAVAL])'
const IDLE_EXEMPT = 'const exempt = await noResearchOf(ctx)\n\n      if (exempt === true) {\n        return []\n      }\n\n      const { GameID, RaceID } = ctx'
const DEAD_EXEMPT = 'const exempt = await noResearchOf(ctx)\n\n      if (exempt === true) {\n        return []\n      }\n\n      const projects = await rowsOf(ctx, researchProjectQuery(ctx, DEAD))'
const TERMS_LINE = 'terms: isDevelopmentType(project.ProductionType) ? this.developmentLine(project) : \'\','
const TERMS_ELEMENT = '<div v-if="item.terms" class="caption text--secondary" data-industry-terms>{{ item.terms }}</div>'
const FOOT_SENTENCE = 'An Engineering, Ordnance or Ground Unit Project develops a component, missile or ground unit class the race designed, for twice its stored development cost, and draws on construction capacity (ordnance capacity for an Ordnance Project); the line under the job gives the item, its cost and its minerals. '
const MANIFEST_ELEMENT = '<div v-if="developmentText" class="caption text--secondary" data-manifest-projects>'
const MANIFEST_FOOT = 'A queued Engineering Project counts as a component project, because each unit it completes goes into the colony\'s stock; an Ordnance Project and a Ground Unit Project are counted by kind above the table and are not supply. '

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'Ordnance Projects draw on construction capacity', target: 'types', from: ORDNANCE_TYPES, to: 'const ORDNANCE_TYPES = Object.freeze([PRODUCTION_TYPE.ORDNANCE])', fails: ['types', 'warnings', 'legacy', 'jobs'] },
  { name: 'Engineering Projects draw on ordnance capacity', target: 'types', from: ORDNANCE_TYPES, to: 'const ORDNANCE_TYPES = Object.freeze([PRODUCTION_TYPE.ORDNANCE, PRODUCTION_TYPE.ORDNANCE_PROJECTS, PRODUCTION_TYPE.ENGINEERING_PROJECTS])', fails: ['types', 'warnings', 'legacy', 'jobs'] },
  { name: 'Ground Unit Projects draw on light naval capacity', target: 'types', from: FIGHTER_TYPES, to: 'const FIGHTER_TYPES = Object.freeze([PRODUCTION_TYPE.LIGHT_NAVAL, PRODUCTION_TYPE.GROUND_UNIT_PROJECTS])', fails: ['types', 'warnings', 'jobs'] },
  { name: 'Components draw on ordnance capacity', target: 'types', from: ORDNANCE_TYPES, to: 'const ORDNANCE_TYPES = Object.freeze([PRODUCTION_TYPE.ORDNANCE, PRODUCTION_TYPE.ORDNANCE_PROJECTS, PRODUCTION_TYPE.COMPONENTS])', fails: ['types', 'legacy'] },
  { name: 'the Engineering Project is named a component project', target: 'types', from: '[PRODUCTION_TYPE.ENGINEERING_PROJECTS]: \'Engineering project\',', to: '[PRODUCTION_TYPE.ENGINEERING_PROJECTS]: \'Component project\',', fails: ['types', 'jobs'] },
  { name: 'every type from 3 on is a development project', target: 'types', from: 'Object.prototype.hasOwnProperty.call(DEVELOPMENT_ITEMS, productionType)', to: 'productionType >= 3', fails: ['types'] },
  { name: 'the Ordnance Project develops a rocket', target: 'types', from: '[PRODUCTION_TYPE.ORDNANCE_PROJECTS]: \'missile\',', to: '[PRODUCTION_TYPE.ORDNANCE_PROJECTS]: \'rocket\',', fails: ['types', 'jobs'] },
  { name: 'categoryOf keeps the old three-way split', target: 'production', from: '(!isNumber(productionType) ? \'unknown\' : capacityKind(productionType))', to: '(!isNumber(productionType) ? \'unknown\' : productionType === 1 ? \'ordnance\' : productionType === 2 ? \'fighter\' : \'construction\')', fails: ['types', 'jobs'] },
  { name: 'the mineral demand keeps the old facility split', target: 'minerals', from: '(!recorded(productionType) ? null : capacityKind(productionType))', to: '(!recorded(productionType) ? null : productionType === 1 ? \'ordnance\' : productionType === 2 ? \'fighter\' : \'construction\')', fails: ['types'] },
  { name: 'the NPR ordnance note is for type 1 only', target: 'legacy', from: 'capacityKind(project.ProductionType) === \'ordnance\'', to: 'project.ProductionType === 1', fails: ['legacy'] },
  { name: 'the free construction list leaves the development types out', target: 'industryWarn', from: 'IN (${typesOf(kind).join(\',\')})', to: 'IN (${typesOf(kind).filter((type) => type < 5).join(\',\')})', fails: ['warnings'] },
  { name: 'a paused project names its capacity by type 1 only', target: 'industryWarn', from: 'PRODUCTION_KINDS[capacityKind(project.ProductionType)]', to: 'PRODUCTION_KINDS[project.ProductionType === 1 ? \'ordnance\' : \'construction\']', fails: ['warnings'] },
  { name: 'the line says a stored cost is twice the development cost whatever it is', target: 'development', from: 'twice ? \'twice\' : \'against\'', to: '\'twice\'', fails: ['jobs'] },
  { name: 'the line compares the cost with the development cost, not twice it', target: 'development', from: 'Math.abs(project.ProdPerUnit - 2 * developCost)', to: 'Math.abs(project.ProdPerUnit - developCost)', fails: ['jobs'] },
  { name: 'the development cost of a ground unit class is read from the tech of the same id as the project\'s item', target: 'development', from: 'FCT_TechSystem.TechSystemID = FCT_GroundUnitClass.TechSystemID', to: 'FCT_TechSystem.TechSystemID = FCT_IndustrialProjects.ProductionID', fails: ['jobs'] },
  { name: 'the Ordnance Projects are read as Engineering Projects', target: 'development', from: 'and FCT_IndustrialProjects.ProductionType = ${PRODUCTION_TYPE.ORDNANCE_PROJECTS}', to: 'and FCT_IndustrialProjects.ProductionType = ${PRODUCTION_TYPE.ENGINEERING_PROJECTS}', fails: ['jobs'] },
  { name: 'a table the save lacks is said to be read', target: 'development', from: 'unread.push(kind.type)', to: 'unread.push(-1)', fails: ['jobs'] },
  { name: 'the line says nothing of the minerals', target: 'development', from: 'const needed = stored.filter((mineral) => project[mineral.name] > 0)', to: 'const needed = stored.filter((mineral) => project[mineral.name] > 1e12)', fails: ['jobs'] },
  { name: 'the page words no line for a development job', target: 'productionPage', from: TERMS_LINE, to: 'terms: \'\',', fails: ['jobs', 'render'] },
  { name: 'the page words a line for every job', target: 'productionPage', from: TERMS_LINE, to: 'terms: this.developmentLine(project),', fails: ['jobs', 'render'] },
  { name: 'the page looks the item up by the project\'s ProductionID', target: 'productionPage', from: 'this.developments.items[project.ID]', to: 'this.developments.items[project.ProductionID]', fails: ['jobs'] },
  { name: 'the page never says a table is unread', target: 'productionPage', from: 'if (this.developments.unread.includes(project.ProductionType)) {', to: 'if (false) {', fails: ['jobs'] },
  { name: 'the page names a development job by the Industry label', target: 'productionPage', from: 'detail: PRODUCTION_TYPE_NAMES[project.ProductionType],', to: 'detail: \'Industry\',', fails: ['jobs'] },
  { name: 'the page reads the development items of no race', target: 'productionPage', from: 'return await loadDevelopmentItems(this.database, { GameID: this.GameID, RaceID: this.RaceID })', to: 'return await loadDevelopmentItems(this.database, { GameID: this.GameID, RaceID: 0 })', fails: ['jobs'] },
  { name: 'the element of the line is not marked', target: 'productionPage', from: TERMS_ELEMENT, to: '<div v-if="item.terms" class="caption text--secondary">{{ item.terms }}</div>', fails: ['render'] },
  { name: 'the element of the line is drawn for every job', target: 'productionPage', from: TERMS_ELEMENT, to: '<div class="caption text--secondary" data-industry-terms>{{ item.terms }}</div>', fails: ['render'] },
  { name: 'the Industry foot leaves the development projects out', target: 'productionPage', from: FOOT_SENTENCE, to: '', fails: ['text'] },
  { name: 'the procurement loader leaves the Engineering Projects out', target: 'procData', from: 'const PROJECT_TYPES = [COMPONENT_PROJECT, PRODUCTION_TYPE.ENGINEERING_PROJECTS, ', to: 'const PROJECT_TYPES = [COMPONENT_PROJECT, ', fails: ['manifest-read'] },
  { name: 'the procurement loader leaves the Ground Unit Projects out', target: 'procData', from: ', PRODUCTION_TYPE.GROUND_UNIT_PROJECTS]', to: ']', fails: ['manifest-read'] },
  { name: 'the procurement loader drops the production type of a row', target: 'procData', from: 'productionType: numberOrNull(row.ProductionType), ', to: '', fails: ['manifest-read'] },
  { name: 'the manifest takes no supply from an Engineering Project', target: 'manifest', from: 'Object.freeze([PRODUCTION_TYPE.COMPONENTS, PRODUCTION_TYPE.ENGINEERING_PROJECTS])', to: 'Object.freeze([PRODUCTION_TYPE.COMPONENTS])', fails: ['manifest'] },
  { name: 'the manifest takes supply from an Ordnance Project', target: 'manifest', from: 'Object.freeze([PRODUCTION_TYPE.COMPONENTS, PRODUCTION_TYPE.ENGINEERING_PROJECTS])', to: 'Object.freeze([PRODUCTION_TYPE.COMPONENTS, PRODUCTION_TYPE.ENGINEERING_PROJECTS, PRODUCTION_TYPE.ORDNANCE_PROJECTS])', fails: ['manifest'] },
  { name: 'the manifest takes supply from a Ground Unit Project', target: 'manifest', from: 'Object.freeze([PRODUCTION_TYPE.COMPONENTS, PRODUCTION_TYPE.ENGINEERING_PROJECTS])', to: 'Object.freeze([PRODUCTION_TYPE.COMPONENTS, PRODUCTION_TYPE.ENGINEERING_PROJECTS, PRODUCTION_TYPE.GROUND_UNIT_PROJECTS])', fails: ['manifest'] },
  { name: 'a project read without its type is no supply', target: 'manifest', from: 'project.productionType === undefined || SUPPLY_TYPES.includes(project.productionType)', to: 'SUPPLY_TYPES.includes(project.productionType)', fails: ['manifest'] },
  { name: 'the Ordnance Projects are counted as Ground Unit Projects', target: 'manifest', from: 'ordnance: projects.filter((project) => project.productionType === PRODUCTION_TYPE.ORDNANCE_PROJECTS).length', to: 'ordnance: projects.filter((project) => project.productionType === PRODUCTION_TYPE.GROUND_UNIT_PROJECTS).length', fails: ['manifest'] },
  { name: 'the note says the Ordnance Projects are supply', target: 'manifest', from: '\'adds ordnance, not component supply\'', to: '\'counted as component supply\'', fails: ['manifest', 'manifest-view'] },
  { name: 'the CSV leaves the note out', target: 'manifest', from: 'lines.push(record({ Record: \'context\', Note: development, Rule: RULE }))', to: 'void development', fails: ['manifest'] },
  { name: 'the text leaves the note out', target: 'manifest', from: 'lines.push(development)', to: 'void development', fails: ['manifest'] },
  { name: 'the manifest draws the note in an element not marked', target: 'manifestView', from: MANIFEST_ELEMENT, to: '<div v-if="developmentText" class="caption text--secondary">', fails: ['manifest-view'] },
  { name: 'the manifest draws the note always', target: 'manifestView', from: MANIFEST_ELEMENT, to: '<div class="caption text--secondary" data-manifest-projects>', fails: ['manifest-view'] },
  { name: 'the manifest foot leaves the projects out', target: 'manifestView', from: MANIFEST_FOOT, to: '', fails: ['text'] },
  { name: 'the setting is read from the wrong end', target: 'researchData', from: 'typeof raw === \'number\' && (raw === 0 || raw === 1) ? raw === 1', to: 'typeof raw === \'number\' && (raw === 0 || raw === 1) ? raw === 0', fails: ['no-research', 'no-research-pages'] },
  { name: 'a stored NULL is read as the setting off', target: 'researchData', from: 'value: flagOfStored(rows[0].NoResearchProjects)', to: 'value: Boolean(rows[0].NoResearchProjects)', fails: ['no-research', 'no-research-pages'] },
  { name: 'a save without the column is read as the setting off', target: 'researchData', from: 'names.has(name))) {\n    return NO_RESEARCH_UNREAD', to: 'names.has(name))) {\n    return { read: true, value: false }', fails: ['no-research', 'no-research-pages'] },
  { name: 'the words of the reason leave the projects of the race out', target: 'researchData', from: 'It develops components, missiles and ground unit classes by Engineering, Ordnance and Ground Unit Projects on the Industry tab of Production, each for twice the development cost.', to: 'It uses no labs.', fails: ['no-research-pages'] },
  { name: 'the idle labs of a race with the setting on are reported', target: 'researchWarn', from: IDLE_EXEMPT, to: 'const exempt = await noResearchOf(ctx)\n\n      const { GameID, RaceID } = ctx', fails: ['no-research'] },
  { name: 'the dead projects of a race with the setting on are reported', target: 'researchWarn', from: DEAD_EXEMPT, to: 'const exempt = await noResearchOf(ctx)\n\n      const projects = await rowsOf(ctx, researchProjectQuery(ctx, DEAD))', fails: ['no-research'] },
  { name: 'an unknown setting leaves the idle labs evaluated', target: 'researchWarn', from: 'verdict: (population) => allOf(population.Verdict, exempt === null ? null : 1),', to: 'verdict: (population) => population.Verdict,', fails: ['no-research'] },
  { name: 'an unknown setting leaves the dead projects evaluated', target: 'researchWarn', from: 'verdict: (project) => allOf(project.Verdict, exempt === null ? null : 1),', to: 'verdict: (project) => project.Verdict,', fails: ['no-research'] },
  { name: 'the rule of the idle labs check says nothing of the race', target: 'researchWarn', from: 'so some labs sit idle. A race that starts no research projects is not checked.', to: 'so some labs sit idle.', fails: ['no-research'] },
  { name: 'the Commanders suggestions are made for a race that starts no research projects', target: 'commandersUtil', from: 'if (noResearch === true) {', to: 'if (false) {', fails: ['no-research-pages'] },
  { name: 'the Commanders skip gives no reason', target: 'commandersUtil', from: 'return { rows: [], unrated: [], skipped: NO_RESEARCH_WORDS }', to: 'return { rows: [], unrated: [], skipped: null }', fails: ['no-research-pages'] },
  { name: 'the Commanders page passes no setting', target: 'commandersPage', from: '{ noResearch: this.noResearch.value === true }', to: '{ noResearch: false }', fails: ['no-research-pages'] },
  { name: 'the Commanders page leaves the reason out of the table', target: 'commandersPage', from: ':data-research-skipped="researchAssessment.skipped ? \'true\' : null">{{ researchAssessment.skipped ? researchAssessment.skipped :', to: '>{{', fails: ['no-research-pages'] },
  { name: 'the Research page keeps the idle count for a race that starts no research projects', target: 'technologiesPage', from: 'const exempt = this.noResearch.value === true', to: 'const exempt = false', fails: ['no-research-pages'] },
  { name: 'the Research page reads the setting of no race', target: 'technologiesPage', from: 'return await loadNoResearchProjects(this.database, { GameID: this.GameID, RaceID: this.RaceID })', to: 'return await loadNoResearchProjects(this.database, { GameID: this.GameID, RaceID: 0 })', fails: ['no-research-pages'] },
  { name: 'the notice of the setting is not marked', target: 'technologiesPage', from: 'class="mt-3" data-no-research>', to: 'class="mt-3">', fails: ['no-research-pages'] },
  { name: 'the notice of an unknown setting is drawn for a setting that is on', target: 'technologiesPage', from: '<v-alert v-else-if="noResearch.value === null"', to: '<v-alert v-if="noResearch.value !== false"', fails: ['no-research-pages'] },
  { name: 'the Commanders read is not an optional input', target: 'capabilities', from: '\'/commanders\': (key) => key === \'navalTree\' || key === \'groundTree\' || key === \'noResearch\',', to: '\'/commanders\': (key) => key === \'navalTree\' || key === \'groundTree\',', fails: ['registry'] },
  { name: 'the column is declared unread again', target: 'capabilities', from: 'Object.freeze({ item: \'AE-308-07\', readBy: \'AE-302-01\', table: \'FCT_Race\',', to: 'Object.freeze({ item: \'AE-308-07\', readBy: \'AE-302-09\', table: \'FCT_Race\', columns: Object.freeze([\'NoResearchProjects\']) }),\n  Object.freeze({ item: \'AE-308-07\', readBy: \'AE-302-01\', table: \'FCT_Race\',', fails: ['registry'] },
  { name: 'the development items are a required read of the Production page', target: 'capabilities', from: '\'/production\': (key) => key === \'developments\',', to: '\'/production\': (key) => key === \'none\',', fails: ['registry'] },
  { name: 'the page help of Production says nothing of the projects', target: 'glossary', from: 'Engineering, Ordnance and Ground Unit Projects are listed with the item they develop, their cost (twice its development cost) and their minerals; the procurement manifest counts an Engineering Project as component supply and the other two by kind.', to: 'Projects are listed.', fails: ['text'] },
  { name: 'the page help of Commanders says nothing of the race with no research', target: 'glossary', from: ' A race that starts no research projects has no Research suggestions, and the table says so.', to: '', fails: ['text'] },
  { name: 'the Industry read keeps the rows the game\'s loader skips', target: 'productionPage', from: ' and ${loadedProject()}`)', to: '`)', fails: ['loader'] },
  { name: 'the Engineering items are read for the rows the loader skips', target: 'development', from: 'PRODUCTION_TYPE.ENGINEERING_PROJECTS} and ${loadedProject()}`', to: 'PRODUCTION_TYPE.ENGINEERING_PROJECTS}`', fails: ['loader'] },
  { name: 'the Ordnance items are read for the rows the loader skips', target: 'development', from: 'PRODUCTION_TYPE.ORDNANCE_PROJECTS} and ${loadedProject()}`', to: 'PRODUCTION_TYPE.ORDNANCE_PROJECTS}`', fails: ['loader'] },
  { name: 'the Ground Unit items are read for the rows the loader skips', target: 'development', from: 'PRODUCTION_TYPE.GROUND_UNIT_PROJECTS} and ${loadedProject()}`', to: 'PRODUCTION_TYPE.GROUND_UNIT_PROJECTS}`', fails: ['loader'] },
  { name: 'the procurement loader reads the rows the game\'s loader skips', target: 'procData', from: ' and ${loadedProject()} order by', to: ' order by', fails: ['loader'] },
  { name: 'the loaded-project clause lets a species the game does not hold through', target: 'types', from: ' and FCT_IndustrialProjects.SpeciesID in (select FCT_Species.SpeciesID from FCT_Species where FCT_Species.GameID = FCT_IndustrialProjects.GameID)', to: '', fails: ['loader'] },
  { name: 'the loaded-project clause lets a wealth use the game does not hold through', target: 'types', from: ' and FCT_IndustrialProjects.WealthUse in (select DIM_WealthUse.WealthUseID from DIM_WealthUse)', to: '', fails: ['loader'] },
  { name: 'the loaded-project clause lets a colony the game does not hold through', target: 'types', from: ' and FCT_IndustrialProjects.PopulationID in (select FCT_Population.PopulationID from FCT_Population where FCT_Population.GameID = FCT_IndustrialProjects.GameID)', to: '', fails: ['loader'] },
]

// Rewrites that say the same thing: the type lists in another order, the minerals filter written as a comparison with 0, the idle verdict written with a ternary.
const BENIGN = [
  { name: 'the ordnance types in the other order', target: 'types', from: ORDNANCE_TYPES, to: 'const ORDNANCE_TYPES = Object.freeze([PRODUCTION_TYPE.ORDNANCE_PROJECTS, PRODUCTION_TYPE.ORDNANCE])' },
  { name: 'the minerals of a line filtered as non-zero', target: 'development', from: 'const needed = stored.filter((mineral) => project[mineral.name] > 0)', to: 'const needed = stored.filter((mineral) => !(project[mineral.name] <= 0))' },
  { name: 'the setting read through a loose test', target: 'researchData', from: 'return rows.length ? { read: true, value: flagOfStored(rows[0].NoResearchProjects) } : NO_RESEARCH_UNREAD', to: 'return rows.length > 0 ? { read: true, value: flagOfStored(rows[0].NoResearchProjects) } : NO_RESEARCH_UNREAD' },
]
/* eslint-enable no-template-curly-in-string */

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
const NEEDS = Object.fromEntries(CHECKS.map((one) => [one.name, [SAVE]]))
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
