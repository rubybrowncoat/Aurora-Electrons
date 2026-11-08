/*
  Checks the Colony Comparison worksheet (src/renderer/utilities/colony-worksheet.js, src/renderer/components/planner/ColonyWorksheet.vue and its mount in src/renderer/pages/habitability.vue).

  bun scripts/check-colony-worksheet.js [--no-mutations] [--no-saves]

  The worksheet is run on the Planner's own pipeline over an in-memory save built in this script: the real loaders (loadBodies, loadSpecies, loadRaceRules, loadGases) read it through sqlite3, the real assessBodies and rankBodies rank it, and the worksheet takes the ranked rows. The save holds bodies worked out by hand: a surveyed body with deposits (one with no recorded amount, one with no recorded accessibility, one of 0 t), an unsurveyed body whose deposits sit in the table (a hidden reserve), a body another race surveyed, a surveyed body with no deposit, a body with a figure missing and a body no species can live on.

  The panel is the component the app ships: its script is loaded the way the pages' are (with the real persisted-view mixin), its template is compiled and rendered by Vue without a document, and what is read is the text and the attributes of the nodes. The body detail is rendered the same way, and the cost and the population limit the worksheet shows for a species are read against its two headlines. The Planner's own shownEvaluation is run for the evaluation it shows.

  The save (the fixture of scripts/lib/fixtures.js, game 141, read-only, as races 784 and 785, the two that know bodies both surveyed and not) gives the real figures: the worksheet's deposits against the raw rows and its cost and limit against the assessment. A save that is not there is skipped.

  Each planted fault in a source must fail the checks it names, none of them a check of a save. Exit code 1 when a check fails.
*/
const fs = require('fs')
const nodeVm = require('vm')
const path = require('path')
const sqlite3 = require('sqlite3')
const Vue = require('vue')
const { compileTemplate, parse } = require('vue/compiler-sfc')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')
const { fixtureSave } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')

const U = 'colony-worksheet.js'
const V = 'ColonyWorksheet.vue'
const P = 'habitability.vue'
const B = 'BodyDetail.vue'
const C = 'colonization.js'

const FILES = {
  [U]: path.join(rendererDirectory, 'utilities', U),
  [V]: path.join(rendererDirectory, 'components', 'planner', V),
  [P]: path.join(rendererDirectory, 'pages', P),
  [B]: path.join(rendererDirectory, 'components', 'planner', B),
  [C]: path.join(rendererDirectory, 'utilities', C),
}

const NAMES = ['colony-worksheet', 'colonization', 'colonization-data', 'habitability', 'colonies', 'minerals', 'provenance', 'math']
// The fixture as its player race and as the second race of its game that knows bodies both surveyed and not (race 785, pinned with the figures read from the save: re-pinned with them when the fixture moves).
const SAVES = [
  fixtureSave(),
  { ...fixtureSave(), race: 785 },
]

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  vue: 'export default { component: () => undefined }',
  'lodash/groupBy': 'export default (list, key) => list.reduce((groups, item) => { (groups[item[key]] = groups[item[key]] || []).push(item); return groups }, {})',
}

// Modules the page and the body detail need only to draw.
const MODULES = {
  'components/navigation/section-style': 'export const sectionStyle = () => ({})',
  'utilities/appearance': 'export const activeAppearance = () => ({}); export const toneColor = () => \'#000000\'',
}

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  if (result && result.skipped) {
    console.log(`SKIP  ${name}  [${result.skipped}]`)

    return
  }

  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

Vue.config.silent = true
Vue.config.productionTip = false
Vue.config.devtools = false

// ---------- the in-memory save ----------

const SURVEYED_BY_OTHER = 8
const GAME = 1
const RACE = 7
const SCOPE = { GameID: GAME, RaceID: RACE }

const HIDDEN_AMOUNT = 987654.321
const HIDDEN_ACCESS = 0.8765

const earth = { Radius: 6371, Gravity: 1, BaseTemp: 255, SurfaceTemp: 288, HydroID: 3, HydroExt: 70, Albedo: 0.3, AtmosPress: 1, TidalLock: 0, DustLevel: 0, OrbitalDistance: 1, DistanceToParent: 1, Eccentricity: 0, FixedBody: 0, BodyClass: 1, BodyTypeID: 1, GroundMineralSurvey: 0, StarID: 1, SystemID: 1, GameID: GAME, ParentBodyID: 0, ParentBodyType: 0, Xcor: 0, Ycor: 0 }

const BODIES = [
  { ...earth, SystemBodyID: 101, PlanetNumber: 1, OrbitNumber: 0, Eccentricity: 0.3, Year: 8760, SurfaceTemp: 250, HydroID: 4, HydroExt: 60, name: 'Alpha' },
  { ...earth, SystemBodyID: 102, PlanetNumber: 2, OrbitNumber: 0, SurfaceTemp: 281, name: 'Beta' },
  { ...earth, SystemBodyID: 103, PlanetNumber: 3, OrbitNumber: 0, SurfaceTemp: 300, Gravity: 0.7, name: 'Gamma' },
  { ...earth, SystemBodyID: 104, PlanetNumber: 4, OrbitNumber: 0, Gravity: null, name: 'Delta' },
  { ...earth, SystemBodyID: 105, PlanetNumber: 5, OrbitNumber: 0, name: 'Home' },
  { ...earth, SystemBodyID: 106, PlanetNumber: 6, OrbitNumber: 0, Gravity: 3, name: 'Epsilon' },
]

const SURVEYED = [101, 103, 104, 105, 106]

// The danger of a gas to a breather is a pair of columns for each of the four breathing gases (oxygen is gas 10); the Carbon Dioxide row is dangerous to an oxygen breather (rating 1) above 5 ppm.
const NO_DANGER = { DangerousOxygen: 0, DangerousPPMOxygen: 0, DangerousMethane: 0, DangerousPPMMethane: 0, DangerousSulphur: 0, DangerousPPMSulphur: 0, DangerousAmmonia: 0, DangerousPPMAmmonia: 0 }

const GASES = [
  { GasID: 10, Name: 'Oxygen', FreezingPoint: 90, GHGas: 0, AntiGHGas: 0, ...NO_DANGER },
  { GasID: 2, Name: 'Nitrogen', FreezingPoint: 77, GHGas: 0, AntiGHGas: 0, ...NO_DANGER },
  { GasID: 5, Name: 'Water Vapour', FreezingPoint: 373, GHGas: 1, AntiGHGas: 0, ...NO_DANGER },
  { GasID: 20, Name: 'Carbon Dioxide', FreezingPoint: 195, GHGas: 1, AntiGHGas: 0, ...NO_DANGER, DangerousOxygen: 1, DangerousPPMOxygen: 5 },
]

const SPECIES = [
  { SpeciesID: 1, SpeciesName: 'Humans', BreatheID: 10, Oxygen: 0.21, OxyDev: 0.15, PressMax: 4, Temperature: 288, TempDev: 20, Gravity: 1, GravDev: 0.4, PopulationDensityModifier: 1 },
  { SpeciesID: 2, SpeciesName: 'Cold-bloods', BreatheID: 10, Oxygen: 0.21, OxyDev: 0.15, PressMax: 4, Temperature: 270, TempDev: 15, Gravity: 0.8, GravDev: 0.5, PopulationDensityModifier: 1.5 },
]

// The deposits of the fixture by body: [MaterialID, Amount, Accessibility, HalfOriginalAmount, OriginalAcc].
const DEPOSITS = {
  101: [[1, 250000, 0.9, 111111, 0.55], [3, 0, 0.5, 0, 0.5], [5, 1200, null, 600, 0.4], [6, null, 0.5, 300, 0.45], [8, 40000000, 0.35, 20000000, 0.3], [7, ' ', 0.5, 100, 0.5], [9, 100, '\t', 50, 0.5], [10, '', '', 0, 0], [11, 3500, 1, 1750, 1]],
  102: [[1, HIDDEN_AMOUNT, HIDDEN_ACCESS, 493827, 0.8], [5, 765432, 0.4321, 382716, 0.4]],
  105: [[2, 5000, 0.7, 2500, 0.7], [4, 123456, 0.2468, 61728, 0.2]],
  106: [[2, 0, 0.6, 0, 0.6]],
}

const rowsOfFixture = () => {
  const tables = []

  tables.push(['FCT_Game', { GameID: GAME, TerraformingSpeed: 100 }])
  tables.push(['FCT_Race', { GameID: GAME, RaceID: RACE, ColonizationSkill: 1, TerraformingRate: 0.1 }])
  tables.push(['FCT_RaceSysSurvey', { SystemID: 1, RaceID: RACE, GameID: GAME, Name: 'Test', ControlRaceID: 0, MilitaryRestrictedSystem: 0 }])
  tables.push(['FCT_Star', { StarID: 1, SystemID: 1, GameID: GAME, ComponentNumber: 1, Luminosity: 1, OrbitingComponent: 0, OrbitalDistance: 0, Eccentricity: 0 }])
  GASES.forEach((gas) => tables.push(['DIM_Gases', gas]))
  SPECIES.forEach((species, index) => {
    tables.push(['FCT_Species', species])
    tables.push(['FCT_Population', { PopulationID: index + 1, GameID: GAME, RaceID: RACE, SystemBodyID: 105, SpeciesID: species.SpeciesID, Population: 100 - index * 40, PopName: `Colony ${index + 1}` }])
  })
  BODIES.forEach(({ name, ...body }) => {
    tables.push(['FCT_SystemBody', body])
    tables.push(['FCT_SystemBodyName', { SystemBodyID: body.SystemBodyID, RaceID: RACE, Name: name }])
    tables.push(['FCT_AtmosphericGas', { GameID: GAME, SystemBodyID: body.SystemBodyID, AtmosGasID: 10, AtmosGasPercentage: 21, GasAtm: 0.21, FrozenOut: 0 }])
    tables.push(['FCT_AtmosphericGas', { GameID: GAME, SystemBodyID: body.SystemBodyID, AtmosGasID: 2, AtmosGasPercentage: 79, GasAtm: 0.79, FrozenOut: 0 }])
  })
  SURVEYED.forEach((id) => tables.push(['FCT_SystemBodySurveys', { SystemBodyID: id, RaceID: RACE }]))
  tables.push(['FCT_SystemBodySurveys', { SystemBodyID: 102, RaceID: SURVEYED_BY_OTHER }])
  Object.entries(DEPOSITS).forEach(([id, deposits]) => deposits.forEach(([MaterialID, Amount, Accessibility, HalfOriginalAmount, OriginalAcc]) => tables.push(['FCT_MineralDeposit', { GameID: GAME, SystemBodyID: Number(id), MaterialID, Amount, Accessibility, HalfOriginalAmount, OriginalAcc }])))

  return tables
}

// A body of each of two radii, alike in everything else and liveable as it is for the race's oxygen breathers, so that the only figure that differs between them is the area the game's capacity rule works from: it holds the limit, and the people share behind a score. A third body holds the race's colony, which is where the save's species comes from.
const CAPACITY_BODIES = [{ id: 400, radius: 6400 }, { id: 401, radius: 4000 }, { id: 402, radius: 6400 }]

const rowsOfCapacity = () => {
  const tables = []

  tables.push(['FCT_Game', { GameID: GAME, TerraformingSpeed: 100 }])
  tables.push(['FCT_Race', { GameID: GAME, RaceID: RACE, ColonizationSkill: 1, TerraformingRate: 0.1 }])
  tables.push(['FCT_RaceSysSurvey', { SystemID: 1, RaceID: RACE, GameID: GAME, Name: 'Test', ControlRaceID: 0, MilitaryRestrictedSystem: 0 }])
  tables.push(['FCT_Star', { StarID: 1, SystemID: 1, GameID: GAME, ComponentNumber: 1, Luminosity: 1, OrbitingComponent: 0, OrbitalDistance: 0, Eccentricity: 0 }])
  GASES.forEach((gas) => tables.push(['DIM_Gases', gas]))
  tables.push(['FCT_Species', SPECIES[0]])
  tables.push(['FCT_Population', { PopulationID: 1, GameID: GAME, RaceID: RACE, SystemBodyID: 400, SpeciesID: SPECIES[0].SpeciesID, Population: 100, PopName: 'Capacity home' }])
  CAPACITY_BODIES.forEach(({ id, radius }, index) => {
    const { name, ...body } = { ...earth, SystemBodyID: id, PlanetNumber: index + 1, OrbitNumber: 0, Radius: radius, SurfaceTemp: 288, name: `Capacity ${index + 1}` }

    tables.push(['FCT_SystemBody', body])
    tables.push(['FCT_SystemBodyName', { SystemBodyID: id, RaceID: RACE, Name: name }])
    tables.push(['FCT_SystemBodySurveys', { SystemBodyID: id, RaceID: RACE }])
    tables.push(['FCT_AtmosphericGas', { GameID: GAME, SystemBodyID: id, AtmosGasID: 10, AtmosGasPercentage: 21, GasAtm: 0.21, FrozenOut: 0 }])
    tables.push(['FCT_AtmosphericGas', { GameID: GAME, SystemBodyID: id, AtmosGasID: 2, AtmosGasPercentage: 79, GasAtm: 0.79, FrozenOut: 0 }])
  })

  return tables
}

// Two small saves for the time of a terraforming plan, each with the race's own colony on a body (Home, which gives the race its species) and one body to plan: the reviewer's probe, an ammonia breather's body of 50 % liquid water at 280.5 K under 1 atm of 0.2 ammonia and 0.8 nitrogen, whose plan drains the water; and an oxygen breather's cold body of ice, whose plan drains nothing. The race's terraformers move 1 atm a year each.
const TIME_GASES = [
  { GasID: 4, Name: 'Ammonia', FreezingPoint: 195, GHGas: 0, AntiGHGas: 0, ...NO_DANGER },
  { GasID: 5, Name: 'Water Vapour', FreezingPoint: 0, GHGas: 0, AntiGHGas: 0, ...NO_DANGER, DangerousAmmonia: 2, DangerousPPMAmmonia: 2000 },
  { GasID: 7, Name: 'Nitrogen', FreezingPoint: 63, GHGas: 0, AntiGHGas: 0, ...NO_DANGER },
  { GasID: 10, Name: 'Oxygen', FreezingPoint: 54, GHGas: 0, AntiGHGas: 0, ...NO_DANGER },
  { GasID: 20, Name: 'Aestusium', FreezingPoint: 1, GHGas: 1, AntiGHGas: 0, ...NO_DANGER },
  { GasID: 22, Name: 'Frigusium', FreezingPoint: 1, GHGas: 0, AntiGHGas: 1, ...NO_DANGER },
]

const TIME_CASES = {
  drain: { species: { SpeciesID: 3, SpeciesName: 'Ammonians', BreatheID: 4, Oxygen: 0.2, OxyDev: 0.1, PressMax: 4, Temperature: 288, TempDev: 30, Gravity: 1, GravDev: 0.5, PopulationDensityModifier: 1 }, own: 4, body: { BaseTemp: 255, SurfaceTemp: 280.5, HydroID: 3, HydroExt: 50 } },
  plain: { species: { SpeciesID: 4, SpeciesName: 'Humans', BreatheID: 10, Oxygen: 0.2, OxyDev: 0.1, PressMax: 10, Temperature: 280, TempDev: 30, Gravity: 1, GravDev: 0.5, PopulationDensityModifier: 1 }, own: 10, body: { BaseTemp: 180, SurfaceTemp: 198, HydroID: 4, HydroExt: 100 } },
}

const PLANNED_BODY = 201
const HOME_BODY = 205

const rowsOfTimeCase = ({ species, own, body }) => {
  const tables = []
  const planet = (extra) => ({ ...earth, Albedo: 1, OrbitNumber: 0, ...extra })

  tables.push(['FCT_Game', { GameID: GAME, TerraformingSpeed: 100 }])
  tables.push(['FCT_Race', { GameID: GAME, RaceID: RACE, ColonizationSkill: 1, TerraformingRate: 1 }])
  tables.push(['FCT_RaceSysSurvey', { SystemID: 1, RaceID: RACE, GameID: GAME, Name: 'Test', ControlRaceID: 0, MilitaryRestrictedSystem: 0 }])
  tables.push(['FCT_Star', { StarID: 1, SystemID: 1, GameID: GAME, ComponentNumber: 1, Luminosity: 1, OrbitingComponent: 0, OrbitalDistance: 0, Eccentricity: 0 }])
  TIME_GASES.forEach((gas) => tables.push(['DIM_Gases', gas]))
  tables.push(['FCT_Species', species])
  tables.push(['FCT_Population', { PopulationID: 1, GameID: GAME, RaceID: RACE, SystemBodyID: HOME_BODY, SpeciesID: species.SpeciesID, Population: 100, PopName: 'Colony' }])
  ;[planet({ SystemBodyID: PLANNED_BODY, PlanetNumber: 1, ...body, name: 'Planned' }), planet({ SystemBodyID: HOME_BODY, PlanetNumber: 5, SurfaceTemp: 288, BaseTemp: 255, HydroID: 1, HydroExt: 0, name: 'Home' })].forEach(({ name, ...row }) => {
    tables.push(['FCT_SystemBody', row])
    tables.push(['FCT_SystemBodyName', { SystemBodyID: row.SystemBodyID, RaceID: RACE, Name: name }])
    tables.push(['FCT_SystemBodySurveys', { SystemBodyID: row.SystemBodyID, RaceID: RACE }])
    tables.push(['FCT_AtmosphericGas', { GameID: GAME, SystemBodyID: row.SystemBodyID, AtmosGasID: own, AtmosGasPercentage: 20, GasAtm: 0.2, FrozenOut: 0 }])
    tables.push(['FCT_AtmosphericGas', { GameID: GAME, SystemBodyID: row.SystemBodyID, AtmosGasID: 7, AtmosGasPercentage: 80, GasAtm: 0.8, FrozenOut: 0 }])
  })

  return tables
}

// Three bodies the race's own colony sits on, for what the body detail says of a colony's terraforming whether or not there is a plan: one already liveable for the species (Done, no plan to make), one too light to keep an atmosphere (no plan found), and one cold body the plan warms. The colonies move pressure on all three, so the game's one-year lines belong on all three.
const OWN_SPECIES = { SpeciesID: 4, SpeciesName: 'Humans', BreatheID: 10, Oxygen: 0.2, OxyDev: 0.1, PressMax: 10, Temperature: 280, TempDev: 30, Gravity: 1, GravDev: 0.5, PopulationDensityModifier: 1 }
const OWN_BODIES = { done: 301, noPlan: 302, planned: 303 }
const OWN_COLONIES = { [OWN_BODIES.done]: { id: 1, name: 'Alive' }, [OWN_BODIES.noPlan]: { id: 2, name: 'Light' }, [OWN_BODIES.planned]: { id: 3, name: 'Cold' } }

const rowsOfOwnColony = () => {
  const tables = []
  const planet = (extra) => ({ ...earth, Albedo: 1, OrbitNumber: 0, ...extra })

  tables.push(['FCT_Game', { GameID: GAME, TerraformingSpeed: 100 }])
  tables.push(['FCT_Race', { GameID: GAME, RaceID: RACE, ColonizationSkill: 1, TerraformingRate: 1 }])
  tables.push(['FCT_RaceSysSurvey', { SystemID: 1, RaceID: RACE, GameID: GAME, Name: 'Test', ControlRaceID: 0, MilitaryRestrictedSystem: 0 }])
  tables.push(['FCT_Star', { StarID: 1, SystemID: 1, GameID: GAME, ComponentNumber: 1, Luminosity: 1, OrbitingComponent: 0, OrbitalDistance: 0, Eccentricity: 0 }])
  TIME_GASES.forEach((gas) => tables.push(['DIM_Gases', gas]))
  tables.push(['FCT_Species', OWN_SPECIES])
  Object.entries(OWN_COLONIES).forEach(([body, colony]) => tables.push(['FCT_Population', { PopulationID: colony.id, GameID: GAME, RaceID: RACE, SystemBodyID: Number(body), SpeciesID: OWN_SPECIES.SpeciesID, Population: 100, PopName: colony.name }]))
  ;[
    planet({ SystemBodyID: OWN_BODIES.done, PlanetNumber: 1, SurfaceTemp: 275, BaseTemp: 250, HydroID: 1, HydroExt: 0, name: 'Alive' }),
    planet({ SystemBodyID: OWN_BODIES.noPlan, PlanetNumber: 2, Gravity: 0.05, SurfaceTemp: 275, BaseTemp: 250, HydroID: 1, HydroExt: 0, name: 'Light' }),
    planet({ SystemBodyID: OWN_BODIES.planned, PlanetNumber: 3, SurfaceTemp: 198, BaseTemp: 180, HydroID: 4, HydroExt: 100, name: 'Cold' }),
  ].forEach(({ name, ...row }) => {
    tables.push(['FCT_SystemBody', row])
    tables.push(['FCT_SystemBodyName', { SystemBodyID: row.SystemBodyID, RaceID: RACE, Name: name }])
    tables.push(['FCT_SystemBodySurveys', { SystemBodyID: row.SystemBodyID, RaceID: RACE }])
    tables.push(['FCT_AtmosphericGas', { GameID: GAME, SystemBodyID: row.SystemBodyID, AtmosGasID: 10, AtmosGasPercentage: 20, GasAtm: 0.2, FrozenOut: 0 }])
    tables.push(['FCT_AtmosphericGas', { GameID: GAME, SystemBodyID: row.SystemBodyID, AtmosGasID: 7, AtmosGasPercentage: 80, GasAtm: 0.8, FrozenOut: 0 }])
  })

  return tables
}

// The terraforming sources of those colonies, as `loadTerraformSources` gives them: the race moves 1 atm a year and each colony has this many terraforming installations.
const ownSources = (installations = 1) => ({
  raceRate: 1,
  speed: 100,
  colonies: Object.fromEntries(Object.entries(OWN_COLONIES).map(([body, colony]) => [colony.id, { PopulationID: colony.id, PopName: colony.name, SystemID: 1, SystemBodyID: Number(body), RaceID: RACE, radius: 6371, modifier: { governor: 1, sector: 1, efficiency: 1, radiation: 0, unrest: 0, status: 1 }, installations, ships: [], shipsKnown: true }])),
})

const exec = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())))

const wrapped = (db) => ({ query: (sql) => new Promise((resolve, reject) => db.all(sql, (error, items) => (error ? reject(error) : resolve([items])))) })

// The tables and columns the loaders' SQL names, found by running the real loaders against a database that records what it is asked and answers nothing; an alias is resolved to its table.
const schemaOf = (sqls) => {
  const columns = new Map()

  sqls.forEach((sql) => {
    const aliases = new Map()

    for (const match of sql.matchAll(/\b(?:from|join)\s+(\w+)(?:\s+as\s+(\w+))?/gi)) {
      aliases.set(match[2] || match[1], match[1])
    }

    for (const match of sql.matchAll(/\b(\w+)\.(\w+)\b/g)) {
      const table = aliases.get(match[1]) || match[1]

      if (/^(FCT|DIM)_/.test(table)) {
        columns.set(table, new Set([...(columns.get(table) || []), match[2]]))
      }
    }
  })

  return columns
}

const buildDatabase = async (m, rows = rowsOfFixture()) => {
  const sqls = []
  const recording = { query: async (sql) => { sqls.push(sql); return [[]] } }
  const data = m['colonization-data']

  await data.loadBodies(recording, SCOPE)
  await data.loadSpecies(recording, SCOPE)
  await data.loadRaceRules(recording, SCOPE)
  await data.loadGases(recording)

  const columns = schemaOf(sqls)
  rows.forEach(([table, row]) => columns.set(table, new Set([...(columns.get(table) || []), ...Object.keys(row)])))

  const db = new sqlite3.Database(':memory:')

  for (const [table, names] of columns) {
    await exec(db, `create table ${table} (${[...names].join(', ')})`)
  }

  for (const [table, row] of rows) {
    const names = Object.keys(row)

    await exec(db, `insert into ${table} (${names.join(', ')}) values (${names.map(() => '?').join(', ')})`, names.map((name) => row[name]))
  }

  return { db, database: wrapped(db) }
}

// The Planner's pipeline over a database: what loadBodies, loadSpecies, loadRaceRules and loadGases read, assessed and ranked as the page does (nothing filtered, no species picked). `terraformers` are the installations the ranking assumes.
const pipeline = async (m, database, scope = SCOPE, terraformers = 10) => {
  const data = m['colonization-data']
  const colonization = m.colonization
  const bodies = await data.loadBodies(database, scope)
  const species = await data.loadSpecies(database, scope)
  const raceRules = await data.loadRaceRules(database, scope)
  const gases = await data.loadGases(database)
  const gasById = new Map(gases.map((gas) => [gas.GasID, gas]))
  const assessed = await colonization.assessBodies(bodies, species, raceRules, (id) => gasById.get(id))
  const rows = await colonization.rankBodies(assessed, { speciesId: null, goal: 'both', ranking: colonization.normaliseRanking(null), rules: raceRules, terraformers, distanceOf: () => null, capitalDistanceOf: () => null, origins: { colonies: 0, capital: false } })

  return { bodies, species, raceRules, gases, assessed, rows: Object.freeze(rows) }
}

// ---------- rendering ----------

const textOf = (node) => (typeof node.text === 'string' ? node.text : (node.children || []).map(textOf).join(''))

const nodesOf = (node, test, found = []) => {
  if (test(node)) {
    found.push(node)
  }

  ;(node.children || []).forEach((child) => nodesOf(child, test, found))

  return found
}

const withAttr = (name, value) => (node) => Boolean(node.data && node.data.attrs && name in node.data.attrs && (value === undefined || String(node.data.attrs[name]) === String(value)))

const attrOf = (node, name) => (node && node.data && node.data.attrs ? node.data.attrs[name] : undefined)

const flush = async () => {
  await Vue.nextTick()
  await Vue.nextTick()
}

class MemoryConfig {
  constructor (entries = []) {
    this.values = new Map(entries)
  }

  get (key, fallback) {
    return this.values.has(key) ? JSON.parse(this.values.get(key)) : fallback
  }

  set (key, value) {
    this.values.set(key, JSON.stringify(value))
  }

  has (key) {
    return this.values.has(key)
  }

  reopened () {
    return new MemoryConfig([...this.values])
  }
}

const PERSISTED_VIEW_SOURCE = fs.readFileSync(path.join(rendererDirectory, 'mixins', 'persisted-view.js'), 'utf8')

// A copy of the mixin for each load: a data-URL module is shared by its text, so each load declares its views in a registry of its own.
let loads = 0

const persistedViewCopy = () => `${PERSISTED_VIEW_SOURCE}\nglobalThis.__declaredViews = declaredViews\n// load ${++loads}\n`

const compiledOf = (source, filename) => {
  const compiled = compileTemplate({ source: parse({ source }).template.content, filename })

  if (compiled.errors.length) {
    throw new Error(`The template of ${filename} does not compile: ${compiled.errors.join('; ')}`)
  }

  return nodeVm.runInThisContext(`(function () {\n${compiled.code}\nreturn { render, staticRenderFns }\n})()`)
}

const KEY = 'campaign.c1.race.7'

const unchanged = (sources, file) => sources[file] === fs.readFileSync(FILES[file], 'utf8')

// What a run reads of the sources and the modules loaded from them.
const contextOf = async (sources) => {
  const utilitySources = {}
  const pageSources = {}

  if (!unchanged(sources, U)) {
    utilitySources['colony-worksheet'] = sources[U]
    pageSources['utilities/colony-worksheet'] = sources[U]
  }

  if (!unchanged(sources, C)) {
    utilitySources.colonization = sources[C]
    pageSources['utilities/colonization'] = sources[C]
  }

  const m = await loadUtilities(NAMES, { stubs: STUBS, sources: utilitySources })
  const componentOptions = await loadPage('components/planner/ColonyWorksheet', { stubs: STUBS, modules: { 'mixins/persisted-view': persistedViewCopy() }, sources: { 'components/planner/ColonyWorksheet': sources[V], ...pageSources } })
  const declared = globalThis.__declaredViews()
  const detailOptions = await loadPage('components/planner/BodyDetail', { stubs: STUBS, modules: MODULES, sources: { 'components/planner/BodyDetail': sources[B], ...pageSources } })
  const pageOptions = await loadPage('pages/habitability', { stubs: STUBS, modules: MODULES, sources: { 'pages/habitability': sources[P], ...pageSources } })

  return { m, sources, componentOptions, declared, detailOptions, pageOptions, component: compiledOf(sources[V], V), detail: compiledOf(sources[B], B) }
}

// The memoised fixture of one run.
const fixtureOf = (ctx) => {
  if (!ctx.fixture) {
    ctx.fixture = buildDatabase(ctx.m).then(async ({ db, database }) => ({ db, database, ...(await pipeline(ctx.m, database)) }))
  }

  return ctx.fixture
}

const referenceOf = (row) => ({ SystemBodyID: row.body.SystemBodyID, SystemBodyName: row.body.SystemBodyName, SystemName: row.body.SystemName, BodyClass: row.body.BodyClass, ComponentNumber: row.body.ComponentNumber, PlanetNumber: row.body.PlanetNumber })

const rowById = (rows, id) => rows.find((row) => row.body.SystemBodyID === id)

const select = (rows, ids) => ids.map((id) => (rowById(rows, id) ? referenceOf(rowById(rows, id)) : { SystemBodyID: id, SystemBodyName: `Missing ${id}`, SystemName: 'Test' }))

const mounted = []

// A component of the app from its options and its compiled template; `hooks` are the lifecycle hooks it needs from the app around it.
const extended = (options, compiled, hooks = {}) => Vue.extend({ mixins: [options], ...hooks, render: compiled.render, staticRenderFns: compiled.staticRenderFns })

// The panel as the app ships it. `config` is the store's settings, `prefix` the campaign and race the store names.
const BY_NAME = JSON.stringify({ sortBy: ['name'], sortDesc: [false] })

const mount = (ctx, props, { config = new MemoryConfig([['colonyWorksheetTable', BY_NAME]]), prefix = KEY } = {}) => {
  const store = Vue.observable({ getters: { racePrefix: prefix, config, database: null, GameID: GAME, RaceID: RACE } })
  const Panel = extended(ctx.componentOptions, ctx.component, {
    beforeCreate () {
      this.$store = store
    },
  })
  const vm = new Panel({ propsData: { loading: false, ...props } })

  mounted.push(vm)

  return { vm, config, tree: () => vm._render() }
}

const release = () => mounted.splice(0).forEach((vm) => vm.$destroy())

const rowNode = (tree, id) => nodesOf(tree, withAttr('data-body', id))[0]

const cellNode = (tree, id, cell) => nodesOf(rowNode(tree, id) || { children: [] }, withAttr('data-cell', cell))[0]

const cellText = (tree, id, cell) => {
  const node = cellNode(tree, id, cell)

  return node ? textOf(node).trim() : null
}

// The provenance mark that sits beside a figure: the mark node in the cell that holds it.
const markOf = (tree, id, cell) => {
  const row = rowNode(tree, id)
  const cells = nodesOf(row || { children: [] }, (node) => node.tag === 'td')
  const holder = cells.find((td) => nodesOf(td, withAttr('data-cell', cell)).length)
  const mark = holder ? nodesOf(holder, (node) => Boolean(node.componentOptions && node.componentOptions.tag === 'provenance-mark'))[0] : null

  return mark ? mark.data.attrs : null
}

const ids = (tree) => nodesOf(tree, withAttr('data-body')).map((node) => String(node.data.attrs['data-body']))

const MINERAL_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const CELLS = MINERAL_IDS.flatMap((id) => [`amount-${id}`, `access-${id}`])

const detailOf = (ctx, fixture, row, speciesId) => {
  const item = { id: row.body.SystemBodyID, row, body: row.body, best: row.best }
  const shown = ctx.pageOptions.methods.shownEvaluation.call({ detailSpecies: speciesId ? { [item.id]: speciesId } : {} }, item)
  const Detail = extended(ctx.detailOptions, ctx.detail)
  const vm = new Detail({ propsData: { item, shown, speciesOptions: row.evaluations, terraformCapacity: 0.01, rules: { ...fixture.raceRules, ColonizationSkill: 1 }, separator: ',' } })

  mounted.push(vm)

  const tree = vm._render()
  const node = (name) => nodesOf(tree, withAttr('data-detail', name))[0]

  return { shown, cost: node('cost') ? textOf(node('cost')).replace(/\s+/g, ' ').trim() : null, capacity: node('capacity') ? textOf(node('capacity')).replace(/\s+/g, ' ').trim() : null, gravityClass: node('gravity-class') ? textOf(node('gravity-class')).trim() : null }
}

// The body detail of a planted body as the page gives it for a species, rendered: its text with the white space of the template folded, the notes under the plan's heading that say its time is a minimum, and the one-year lines of the race's own colonies. `capacity` is what the terraformers move in a year; `sources` is the race's colonies as the page loads them (`terraformSources`).
const renderedDetail = (ctx, fixture, row, speciesId, capacity, sources = null) => {
  const item = { id: row.body.SystemBodyID, row, body: row.body, best: row.best }
  const shown = ctx.pageOptions.methods.shownEvaluation.call({ detailSpecies: { [item.id]: speciesId } }, item)
  const Detail = extended(ctx.detailOptions, ctx.detail)
  const vm = new Detail({ propsData: { item, shown, speciesOptions: row.evaluations, terraformCapacity: capacity, gases: fixture.gases, rules: { ...fixture.raceRules, ColonizationSkill: 1 }, separator: ',', ...(sources ? { terraformSources: sources } : {}) } })

  mounted.push(vm)

  const tree = vm._render()

  return { shown, text: textOf(tree).replace(/\s+/g, ' '), minimumNotes: nodesOf(tree, withAttr('data-detail', 'minimum-time')).map((node) => textOf(node).trim()), oneYear: nodesOf(tree, withAttr('data-detail', 'one-year')).map((node) => textOf(node).replace(/\s+/g, ' ').trim()) }
}

// ---------- the statements ----------

const FIRST_OR_SECOND_PERSON = /\b(I|me|my|mine|you|your|yours|we|our|ours)\b/i

// Whether a shown figure is the number, to the two decimals the panel writes.
const closeTo = (text, value) => Math.abs(Number(text) - value) <= 0.005 + 1e-9
// A hand-worked figure, to the precision the double arithmetic of a check works at.
const close = (actual, expected, name) => assert.ok(Math.abs(actual - expected) < 1e-9, `${name}: ${actual} != ${expected}`)

const statements = (ctx) => {
  const list = []
  const add = (name, test) => list.push([name, test])
  const fx = () => fixtureOf(ctx)
  const w = ctx.m['colony-worksheet']
  const THREE = [101, 102, 103]
  const DASH = ctx.m.math.UNKNOWN_TEXT
  const noteOf = (view, id) => nodesOf(rowNode(view, id) || { children: [] }, withAttr('data-note')).map((node) => [node.data.attrs['data-note'], textOf(node).trim()])
  const render = async (selection, extra = {}) => {
    const fixture = await fx()

    return mount(ctx, { selection: select(fixture.rows, selection), rows: fixture.rows, species: fixture.species, ...extra })
  }
  const settle = (statement) => async () => {
    try {
      return await statement()
    } finally {
      release()
    }
  }

  add('loader: the executed reads rank every body of the fixture and the unsurveyed one holds no deposit', settle(async () => {
    const { rows, bodies } = await fx()

    assert.deepEqual(rows.map((row) => row.body.SystemBodyID).sort(), [101, 102, 103, 104, 105, 106])
    assert.equal(bodies.find((body) => body.SystemBodyID === 102).Minerals.length, 0)
    assert.equal(bodies.find((body) => body.SystemBodyID === 101).Minerals.length, DEPOSITS[101].length)

    return true
  }))

  add('cmc-reach: the loader marks a body of the primary star (component 1) as in the star\'s reach and a body of a companion that circles it from beyond 80 AU, with no Lagrange point, as out of it', settle(async () => {
    const { db, database } = await buildDatabase(ctx.m)

    try {
      await exec(db, 'insert into FCT_Star (StarID, SystemID, GameID, ComponentNumber, Luminosity, OrbitingComponent, OrbitalDistance, Eccentricity) values (2, 1, ?, 2, 1, 1, 100, 0)', [GAME])
      await exec(db, 'update FCT_SystemBody set StarID = 2 where SystemBodyID = 106')

      const bodies = await ctx.m['colonization-data'].loadBodies(database, SCOPE)

      assert.deepEqual(bodies.filter((body) => body.StarID === 1).map((body) => body.SystemBodyID).sort(), [101, 102, 103, 104, 105])
      assert.deepEqual(bodies.filter((body) => body.CmcStarInReach).map((body) => body.SystemBodyID).sort(), [101, 102, 103, 104, 105])
      assert.equal(bodies.find((body) => body.SystemBodyID === 106).CmcStarInReach, false)
    } finally {
      await new Promise((resolve) => db.close(resolve))
    }

    return true
  }))

  // The game's geometry for the two planted bodies: four times its pi (3.1416) times the radius squared over its Earth surface (511187128), times the baseline density (12,000) and the species density. The people share of the score is that capacity over capacity plus 1,000 M, and the two bodies are alike in cost, years and distance, so their scores are the ratio of those shares. Math.PI would give 12082.89909124985 on the larger body instead of 12082.927346323946.
  add('capacity: the game\'s 3.1416 geometry gives the planner\'s body capacity, and the people share behind a score follows it', settle(async () => {
    const { db, database } = await buildDatabase(ctx.m, rowsOfCapacity())

    try {
      const { rows } = await pipeline(ctx.m, database)
      const small = rowById(rows, 401)
      const large = rowById(rows, 402)
      const capacityOf = (radius) => (4 * 3.1416 * radius ** 2 * 12000) / 511187128
      const people = (capacity) => capacity / (capacity + 1000)

      assert.deepEqual(rows.map((row) => row.body.SystemBodyID).sort(), [400, 401, 402])
      assert.equal(small.best.strategy, 'now', 'a body the species can live on as it is settles now')
      assert.equal(large.best.strategy, 'now', 'and so does the other')
      close(small.best.capacity, capacityOf(4000), 'the small body holds the game\'s capacity')
      close(large.best.capacity, capacityOf(6400), 'the large body holds the game\'s capacity')
      close(small.best.parts.people, people(capacityOf(4000)), 'the people share of the small body is that capacity\'s share of 1,000 M')
      close(large.best.parts.people, people(capacityOf(6400)), 'and the large body\'s')
      close(large.score, 100, 'the larger body is the best target')
      close(small.score, (100 * people(capacityOf(4000))) / people(capacityOf(6400)), 'the score follows the people share')
    } finally {
      await new Promise((resolve) => db.close(resolve))
    }

    return true
  }))

  add('three: three selected bodies stand side by side, each with all eleven amounts and accessibilities, the cost and the limit', settle(async () => {
    const { tree } = await render(THREE)
    const view = tree()

    assert.deepEqual(ids(view), THREE.map(String))

    for (const id of THREE) {
      for (const cell of ['name', 'species', 'cost', 'capacity', ...CELLS]) {
        assert.notEqual(cellNode(view, id, cell), undefined, `${id} ${cell}`)
      }

      assert.equal(nodesOf(rowNode(view, id), (node) => node.tag === 'td').length, 4 + 22, `${id} cells`)
    }

    const headed = nodesOf(view, (node) => node.tag === 'th' && Boolean(node.data && node.data.attrs && node.data.attrs['data-mineral']))

    assert.deepEqual(headed.map((node) => Number(node.data.attrs['data-mineral'])), MINERAL_IDS)
    assert.deepEqual(headed.map((node) => textOf(node).trim()), ctx.m.minerals.MINERALS.map((mineral) => mineral.name))

    const alpha = Object.fromEntries(DEPOSITS[101].map(([id, amount, access]) => [id, { amount, access }]))

    assert.equal(cellText(view, 101, 'amount-1'), ctx.m.minerals.compact(alpha[1].amount))
    assert.ok(closeTo(cellText(view, 101, 'access-1'), 0.9))
    assert.equal(cellText(view, 101, 'amount-8'), ctx.m.minerals.compact(alpha[8].amount))
    assert.ok(closeTo(cellText(view, 101, 'access-8'), 0.35))
    assert.equal(cellText(view, 101, 'amount-11'), ctx.m.minerals.compact(alpha[11].amount))
    assert.ok(closeTo(cellText(view, 101, 'access-11'), 1))

    const items = w.worksheetRows({ rows: (await fx()).rows, selection: select((await fx()).rows, THREE) })

    assert.deepEqual(items.map((item) => item.id), THREE)
    items.forEach((item) => assert.deepEqual(item.minerals.map((cell) => cell.id), MINERAL_IDS))

    return true
  }))

  add('three: a body keeps its place and its figures whichever other bodies are selected', settle(async () => {
    const fixture = await fx()
    const alone = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, [101]) })[0]
    const among = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, [103, 101, 105]) }).find((item) => item.id === 101)

    assert.deepEqual(JSON.parse(JSON.stringify(among)), JSON.parse(JSON.stringify(alone)))

    return true
  }))

  add('unknown: a body the race has not surveyed shows no deposit at all, only dashes, and a body another race surveyed is no different', settle(async () => {
    const { tree } = await render([102])
    const view = tree()

    for (const cell of CELLS) {
      assert.equal(cellText(view, 102, cell), DASH, cell)
    }

    assert.deepEqual(noteOf(view, 102).map(([state]) => state), ['unsurveyed'])

    const [item] = w.worksheetRows({ rows: (await fx()).rows, selection: select((await fx()).rows, [102]) })

    assert.deepEqual(item.minerals.map((cell) => cell.status), new Array(11).fill('unsurveyed'))
    item.minerals.forEach((cell) => {
      assert.equal(cell.amount, null)
      assert.equal(cell.accessibility, null)
      assert.equal(cell.amountResult.status, 'unavailable')
      assert.equal(cell.accessResult.status, 'unavailable')
    })

    return true
  }))

  add('unknown: a deposit with no recorded amount or accessibility is unknown in that figure only, never 0, and a recorded 0 t is a figure', settle(async () => {
    const { tree } = await render([101])
    const view = tree()

    assert.equal(cellText(view, 101, 'amount-6'), DASH)
    assert.ok(closeTo(cellText(view, 101, 'access-6'), 0.5))
    assert.equal(cellText(view, 101, 'amount-5'), ctx.m.minerals.compact(1200))
    assert.equal(cellText(view, 101, 'access-5'), DASH)
    assert.equal(cellText(view, 101, 'amount-3'), ctx.m.minerals.compact(0))
    assert.notEqual(cellText(view, 101, 'amount-3'), DASH)
    assert.ok(closeTo(cellText(view, 101, 'access-3'), 0.5))

    const [item] = w.worksheetRows({ rows: (await fx()).rows, selection: select((await fx()).rows, [101]) })
    const byId = Object.fromEntries(item.minerals.map((cell) => [cell.id, cell]))

    assert.equal(byId[6].amount, null)
    assert.equal(byId[6].accessibility, 0.5)
    assert.equal(byId[5].accessibility, null)
    assert.equal(byId[3].amount, 0)
    assert.equal(byId[6].amountResult.status, 'unavailable')
    assert.equal(byId[5].accessResult.status, 'unavailable')

    return true
  }))

  add('unknown: a figure stored as blank text (spaces, a tab or nothing) is unknown, never a known 0, while a numeric 0 stays a figure', settle(async () => {
    const { tree } = await render([101])
    const view = tree()
    const [item] = w.worksheetRows({ rows: (await fx()).rows, selection: select((await fx()).rows, [101]) })
    const byId = Object.fromEntries(item.minerals.map((cell) => [cell.id, cell]))

    assert.equal(byId[7].amount, null)
    assert.equal(byId[7].accessibility, 0.5)
    assert.equal(byId[9].amount, 100)
    assert.equal(byId[9].accessibility, null)
    assert.equal(byId[10].amount, null)
    assert.equal(byId[10].accessibility, null)
    assert.equal(byId[3].amount, 0)

    for (const [id, field, result] of [[7, 'amount', 'amountResult'], [9, 'accessibility', 'accessResult'], [10, 'amount', 'amountResult'], [10, 'accessibility', 'accessResult']]) {
      assert.equal(byId[id][result].status, 'unavailable', `${id} ${field}`)
    }

    assert.equal(cellText(view, 101, 'amount-7'), DASH)
    assert.equal(cellText(view, 101, 'access-9'), DASH)
    assert.equal(cellText(view, 101, 'amount-10'), DASH)
    assert.equal(cellText(view, 101, 'access-10'), DASH)
    assert.notEqual(cellText(view, 101, 'amount-3'), DASH)

    const sorted = w.sortWorksheetRows(w.worksheetRows({ rows: (await fx()).rows, selection: select((await fx()).rows, [101, 103]) }), ['amount7'], [true])

    assert.deepEqual(sorted.map((entry) => entry.amount7), [0, null])

    return true
  }))

  add('unknown: a surveyed body with no deposit of a mineral holds none of it, a real 0 with no accessibility', settle(async () => {
    const { tree } = await render([103, 101])
    const view = tree()

    for (const id of MINERAL_IDS) {
      assert.equal(cellText(view, 103, `amount-${id}`), ctx.m.minerals.compact(0), `amount ${id}`)
      assert.equal(cellText(view, 103, `access-${id}`), DASH, `access ${id}`)
    }

    assert.equal(cellText(view, 101, 'amount-2'), ctx.m.minerals.compact(0))

    const [item] = w.worksheetRows({ rows: (await fx()).rows, selection: select((await fx()).rows, [103]) })

    item.minerals.forEach((cell) => {
      assert.equal(cell.status, 'none')
      assert.equal(cell.amount, 0)
      assert.equal(cell.accessibility, null)
      assert.equal(cell.amountResult.status, 'confirmed')
    })

    return true
  }))

  add('unknown: a mineral with more than one deposit row on a body is unknown, never the first row or a sum', settle(async () => {
    const fixture = await fx()
    const row = rowById(fixture.rows, 101)
    const doubled = { ...row, body: { ...row.body, Minerals: [...row.body.Minerals, { ...row.body.Minerals[0], Amount: 777 }] } }
    const [item] = w.worksheetRows({ rows: [doubled], selection: select(fixture.rows, [101]) })
    const byId = Object.fromEntries(item.minerals.map((cell) => [cell.id, cell]))

    assert.equal(byId[1].status, 'ambiguous')
    assert.equal(byId[1].amount, null)
    assert.equal(byId[1].accessibility, null)
    assert.equal(byId[8].amount, 40000000)

    return true
  }))

  add('absent: a selected body the ranked rows lack stays in the worksheet with no figure and says why, and a body selected twice is one row', settle(async () => {
    const fixture = await fx()
    const { tree } = await mount(ctx, { selection: [...select(fixture.rows, [101]), ...select(fixture.rows, [999]), ...select(fixture.rows, [101])], rows: fixture.rows, species: fixture.species })
    const view = tree()

    assert.deepEqual(ids(view), ['101', '999'])
    assert.equal(cellText(view, 999, 'cost'), DASH)
    assert.equal(cellText(view, 999, 'capacity'), DASH)

    for (const cell of CELLS) {
      assert.equal(cellText(view, 999, cell), DASH, cell)
    }

    const absent = noteOf(view, 999).filter(([state]) => state === 'absent')

    assert.equal(absent.length, 1)
    assert.ok(absent[0][1].length > 0)

    return true
  }))

  add('hidden: the read gives an unsurveyed body no deposit and no figure of its true reserve reaches the rows or the page', settle(async () => {
    const fixture = await fx()
    const { tree } = await render(THREE)
    const view = tree()
    const items = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, THREE) })
    const unsurveyed = JSON.stringify(items.find((item) => item.id === 102))
    const shown = textOf(rowNode(view, 102))

    for (const hidden of [String(HIDDEN_AMOUNT), '987654', '765432', String(HIDDEN_ACCESS), '0.4321', '493827']) {
      assert.equal(unsurveyed.includes(hidden), false, `rows leak ${hidden}`)
      assert.equal(shown.includes(hidden), false, `text leaks ${hidden}`)
    }

    assert.equal(/\d/.test(CELLS.map((cell) => cellText(view, 102, cell)).join('')), false)

    return true
  }))

  add('hidden: a body that is not surveyed shows nothing even if deposit rows reach it', settle(async () => {
    const fixture = await fx()
    const row = rowById(fixture.rows, 102)
    const hidden = { ...row, body: { ...row.body, Minerals: [{ SystemBodyID: 102, MaterialID: 1, Amount: HIDDEN_AMOUNT, Accessibility: HIDDEN_ACCESS }] } }
    const [item] = w.worksheetRows({ rows: [hidden], selection: select(fixture.rows, [102]) })

    assert.equal(JSON.stringify(item).includes('987654'), false)
    assert.equal(item.amount1, null)
    assert.equal(item.access1, null)

    return true
  }))

  add('unfit: a body the species cannot live on, and one with a figure missing, show no cost and no limit and say so', settle(async () => {
    const { tree } = await render([106, 104])
    const view = tree()

    for (const id of [106, 104]) {
      assert.equal(cellText(view, id, 'cost'), DASH, `${id} cost`)
      assert.equal(cellText(view, id, 'capacity'), DASH, `${id} capacity`)
    }

    const items = w.worksheetRows({ rows: (await fx()).rows, selection: select((await fx()).rows, [106, 104]) })

    assert.equal(items[0].state, 'unfit')
    assert.equal(items[0].costValue, null)
    assert.equal(items[0].capacityValue, null)
    assert.equal(typeof items[0].reason, 'string')
    assert.equal(items[1].state, 'unknown')
    assert.equal(items[1].costValue, null)
    assert.ok(items[1].missing.length > 0)
    assert.deepEqual(noteOf(view, 106).map(([state]) => state), ['unfit'])
    assert.equal(noteOf(view, 106)[0][1].toLowerCase().includes(items[0].reason.toLowerCase()), true)
    assert.deepEqual(noteOf(view, 104).map(([state]) => state), ['unknown'])
    items[1].missing.forEach((name) => assert.equal(noteOf(view, 104)[0][1].includes(name), true, name))
    assert.equal(items[1].results.cost.status, 'unavailable')

    return true
  }))

  add('parity: the cost and the limit of a body for each species are the headlines of the body detail for the same species', settle(async () => {
    const fixture = await fx()
    let compared = 0

    for (const speciesId of [null, 1, 2]) {
      const { tree } = mount(ctx, { selection: select(fixture.rows, [101, 102, 103, 104, 105, 106]), rows: fixture.rows, species: fixture.species }, { config: new MemoryConfig([[`${KEY}.colonyWorksheetSpecies`, JSON.stringify(speciesId)]]) })
      const view = tree()

      for (const row of fixture.rows) {
        const id = row.body.SystemBodyID
        const detail = detailOf(ctx, fixture, row, speciesId)
        const cost = cellText(view, id, 'cost')
        const capacity = cellText(view, id, 'capacity')

        if (detail.cost === null) {
          assert.equal(cost, DASH, `${id} species ${speciesId} cost shown where the detail has none`)
          assert.equal(capacity, DASH, `${id} species ${speciesId} capacity shown where the detail has none`)
        } else {
          assert.equal(detail.cost === cost || detail.cost.startsWith(`${cost} `), true, `${id} species ${speciesId}: ${cost} against ${detail.cost}`)
          assert.equal(detail.capacity === capacity || detail.capacity.startsWith(`${capacity} `), true, `${id} species ${speciesId}: ${capacity} against ${detail.capacity}`)
          assert.notEqual(cost, DASH)
          compared++
        }
      }

      release()
    }

    assert.ok(compared >= 6, `only ${compared} figures were compared`)

    return true
  }))

  add('gravity: the gravity class of a body is carried by its row and drawn beside its cost, and a body in range has none', settle(async () => {
    const fixture = await fx()
    const row = rowById(fixture.rows, 101)
    const classed = { ...row, best: { ...row.best, assessment: { ...row.best.assessment, lowGravity: true, gravityClass: 'LGR' } } }
    const rows = fixture.rows.map((entry) => (entry === row ? classed : entry))
    const [item] = w.worksheetRows({ rows, selection: select(fixture.rows, [101]) })

    assert.equal(item.gravityClass, 'LGR')
    assert.equal(w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, [101]) })[0].gravityClass, null)

    const shown = mount(ctx, { selection: select(fixture.rows, [101]), rows, species: fixture.species })

    assert.equal(cellText(shown.tree(), 101, 'gravity-class'), 'LGR')
    release()

    const plain = mount(ctx, { selection: select(fixture.rows, [101]), rows: fixture.rows, species: fixture.species })

    assert.equal(cellText(plain.tree(), 101, 'gravity-class'), null)
    release()
    assert.equal(detailOf(ctx, fixture, classed, null).gravityClass, 'LGR', 'the body detail draws the class beside its cost')
    assert.equal(detailOf(ctx, fixture, row, null).gravityClass, null, 'and none for a body in range')
    release()

    return true
  }))

  add('parity: the figures are those of the evaluation the Planner shows, the worst cost of the orbit and the limit now', settle(async () => {
    const fixture = await fx()
    let known = 0

    for (const speciesId of [null, 1, 2]) {
      const items = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, [101, 102, 103, 105]), speciesId })

      for (const item of items) {
        const row = rowById(fixture.rows, item.id)
        const evaluation = speciesId ? row.evaluations.find((entry) => entry.species.SpeciesID === speciesId) : row.best

        assert.equal(item.speciesName, evaluation.species.SpeciesName)

        if (item.state !== 'known') {
          assert.equal(item.costValue, null)
          assert.equal(item.capacityValue, null)

          continue
        }

        known++

        const independent = fixture.assessed.find((entry) => entry.body.SystemBodyID === item.id).byspecies.find((entry) => entry.species.SpeciesID === evaluation.species.SpeciesID)

        assert.equal(item.costValue, independent.assessment.cost.worst)
        assert.equal(item.capacityValue, independent.capacityNow)
        assert.equal(item.results.cost.value, independent.assessment.cost.worst)
        assert.equal(item.results.capacity.value, independent.capacityNow)
      }
    }

    assert.ok(known >= 6, `only ${known} known figures were compared`)

    const eccentric = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, [101]), speciesId: 1 })[0]
    const assessment = fixture.assessed.find((entry) => entry.body.SystemBodyID === 101).byspecies[0].assessment

    assert.ok(assessment.cost.worst > assessment.cost.current, 'the fixture needs an orbit whose worst cost is above its cost now')
    assert.equal(eccentric.costValue, assessment.cost.worst)

    return true
  }))

  add('species: a species chosen for the worksheet is the species of every row, with the figures of its evaluation', settle(async () => {
    const fixture = await fx()
    const { vm, tree } = await render([101, 103, 105])

    assert.equal(vm.chosenId, null)

    const shown = (view) => [101, 103, 105].map((id) => [cellText(view, id, 'species'), cellText(view, id, 'cost'), cellText(view, id, 'capacity')])
    const before = shown(tree())

    for (const speciesId of [1, 2]) {
      const picker = nodesOf(tree(), withAttr('data-control', 'species'))[0]

      picker.data.on.input(speciesId)
      await flush()

      const view = tree()
      const name = fixture.species.find((entry) => entry.SpeciesID === speciesId).SpeciesName

      for (const id of [101, 103, 105]) {
        const evaluation = rowById(fixture.rows, id).evaluations.find((entry) => entry.species.SpeciesID === speciesId)

        assert.equal(cellText(view, id, 'species'), name)

        if (evaluation.missing.length || !evaluation.assessment.cost.colonisable) {
          assert.equal(cellText(view, id, 'cost'), DASH)
        } else {
          assert.ok(closeTo(cellText(view, id, 'cost'), evaluation.assessment.cost.worst), `${id} cost`)
          assert.equal(cellText(view, id, 'capacity'), ctx.m.colonies.people(evaluation.capacityNow))
        }
      }
    }

    nodesOf(tree(), withAttr('data-control', 'species'))[0].data.on.input(undefined)
    await flush()
    assert.equal(vm.chosenId, null)
    assert.deepEqual(shown(tree()), before)

    return true
  }))

  add('species: the two species differ on the fixture so a species change is a change', settle(async () => {
    const fixture = await fx()
    const one = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, [101, 103, 105]), speciesId: 1 })
    const two = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, [101, 103, 105]), speciesId: 2 })

    assert.notDeepEqual(one.map((item) => [item.costValue, item.capacityValue]), two.map((item) => [item.costValue, item.capacityValue]))

    return true
  }))

  add('score: the columns are the raw inputs and no aggregate score, rank or total stands in for them', settle(async () => {
    const { tree } = await render(THREE)
    const view = tree()
    const columns = nodesOf(view, withAttr('data-sort')).map((node) => node.data.attrs['data-sort'])
    const expected = ['name', 'speciesName', 'costValue', 'capacityValue', ...MINERAL_IDS.flatMap((id) => [`amount${id}`, `access${id}`])]

    assert.deepEqual([...columns].sort(), [...expected].sort())
    assert.deepEqual([...w.SORT_KEYS].sort(), [...expected].sort())

    const fixture = await fx()
    const items = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, THREE) })

    for (const item of items) {
      assert.deepEqual(Object.keys(item).filter((key) => /score|rank|total|worth|index/i.test(key)), [])
    }

    assert.deepEqual(w.SORT_KEYS.filter((key) => /score|rank|total|worth|index/i.test(key)), [])
    assert.equal(w.SORT_KEYS.length, 4 + 22)

    return true
  }))

  add('sort: an unknown figure goes last whichever way the column is sorted and is never read as 0', settle(async () => {
    const fixture = await fx()
    const items = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, [103, 102, 101, 104]) })

    for (const key of ['amount1', 'access1', 'amount5', 'costValue', 'capacityValue']) {
      for (const desc of [false, true]) {
        const sorted = w.sortWorksheetRows(items, [key], [desc])
        const values = sorted.map((item) => item[key])
        const known = values.filter((value) => value !== null)

        assert.deepEqual(values.slice(0, known.length), known, `${key} ${desc}`)
        assert.deepEqual([...known].sort((a, b) => (desc ? b - a : a - b)), known, `${key} ${desc} order`)
      }
    }

    const byAmount = w.sortWorksheetRows(items, ['amount1'], [false]).map((item) => item.id)
    const byAccess = w.sortWorksheetRows(items, ['access8'], [true]).map((item) => item.id)

    assert.deepEqual(byAmount.slice(2), [101, 102])
    assert.equal(byAccess[0], 101)
    assert.deepEqual(w.sortWorksheetRows(items, ['name'], [false]).map((item) => item.name), [...items].map((item) => item.name).sort((a, b) => a.localeCompare(b)))

    return true
  }))

  add('sort: clicking a header orders the rows and its direction, a second click reverses it, and the header says which', settle(async () => {
    const { vm, tree } = await render([101, 102, 103])
    const header = (view, key) => nodesOf(view, (node) => node.tag === 'th' && (node.children || []).some((child) => attrOf(child, 'data-sort') === key))[0]

    const orders = { ascending: ['103', '101', '102'], descending: ['101', '103', '102'] }

    assert.equal(attrOf(header(tree(), 'name'), 'aria-sort'), 'ascending')
    assert.deepEqual(ids(tree()), ['101', '102', '103'])

    nodesOf(tree(), withAttr('data-sort', 'amount1'))[0].data.on.click()
    await flush()

    const first = attrOf(header(tree(), 'amount1'), 'aria-sort')

    assert.deepEqual(Object.keys(orders).includes(first), true)
    assert.deepEqual(ids(tree()), orders[first])
    assert.equal(attrOf(header(tree(), 'name'), 'aria-sort'), 'none')

    nodesOf(tree(), withAttr('data-sort', 'amount1'))[0].data.on.click()
    await flush()

    const second = attrOf(header(tree(), 'amount1'), 'aria-sort')

    assert.notEqual(second, first)
    assert.deepEqual(ids(tree()), orders[second])

    vm.sortOn('costValue')
    await flush()
    assert.equal(vm.table.sortBy[0], 'costValue')

    return true
  }))

  add('loading: no figure is shown while the rows are being worked out again', settle(async () => {
    const { tree } = await render(THREE, { loading: true })
    const view = tree()

    assert.deepEqual(ids(view), [])
    assert.equal(nodesOf(view, withAttr('data-cell')).length, 0)

    return true
  }))

  add('persist: the species is kept for the race, the sort for the app, and a stored value that does not fit is not used', settle(async () => {
    const fixture = await fx()
    const props = { selection: select(fixture.rows, THREE), rows: fixture.rows, species: fixture.species }
    const first = mount(ctx, props)

    nodesOf(first.tree(), withAttr('data-control', 'species'))[0].data.on.input(2)
    first.vm.sortOn('capacityValue')
    await flush()

    assert.equal(first.config.values.get(`${KEY}.colonyWorksheetSpecies`), '2')
    assert.equal([...first.config.values.keys()].filter((key) => key.endsWith('colonyWorksheetTable')).every((key) => !key.startsWith('campaign.')), true)
    assert.equal(first.config.values.has('colonyWorksheetTable'), true)

    const reopened = mount(ctx, props, { config: first.config.reopened() })

    assert.equal(reopened.vm.chosenId, 2)
    assert.deepEqual(reopened.vm.table.sortBy, ['capacityValue'])

    const other = mount(ctx, props, { config: first.config.reopened(), prefix: 'campaign.c1.race.8' })

    assert.equal(other.vm.chosenId, null)
    assert.deepEqual(other.vm.table.sortBy, ['capacityValue'])

    for (const stored of ['"2"', '"x"', '0', '1.5', '-3', 'null', '{}']) {
      const bad = mount(ctx, props, { config: new MemoryConfig([[`${KEY}.colonyWorksheetSpecies`, stored]]) })

      assert.equal(bad.vm.speciesId, null, stored)
    }

    const gone = mount(ctx, props, { config: new MemoryConfig([[`${KEY}.colonyWorksheetSpecies`, '99']]) })

    assert.equal(gone.vm.chosenId, null)
    assert.equal(cellText(gone.tree(), 101, 'species'), rowById(fixture.rows, 101).best.species.SpeciesName)

    for (const stored of ['{"sortBy":["nothing"],"sortDesc":[false]}', '"x"', '{"sortBy":[],"sortDesc":false}', '5']) {
      const bad = mount(ctx, props, { config: new MemoryConfig([['colonyWorksheetTable', stored]]) })

      assert.equal(ctx.m['colony-worksheet'].SORT_KEYS.includes(bad.vm.table.sortBy[0]), true, stored)
    }

    return true
  }))

  add('persist: the species view is declared for the race and the sort for the app', () => {
    const species = ctx.declared.filter((entry) => entry.key === 'colonyWorksheetSpecies').pop()
    const table = ctx.declared.filter((entry) => entry.key === 'colonyWorksheetTable').pop()

    assert.equal(species && species.scope, 'race')
    assert.equal(table && table.scope, 'app')
    assert.equal(species.default, null)

    return true
  })

  add('provenance: every figure carries the mark of the rule that gave it, with the figure the cell shows, and a dash carries what is missing', settle(async () => {
    const fixture = await fx()
    const { tree } = await render([101, 102, 103, 104, 105, 106])
    const view = tree()
    let figures = 0
    let dashes = 0

    for (const id of [101, 102, 103, 104, 105, 106]) {
      for (const cell of ['cost', 'capacity', ...CELLS]) {
        const text = cellText(view, id, cell)
        const mark = markOf(view, id, cell)
        const result = mark ? mark.result : null

        if (text === DASH) {
          if (result) {
            assert.equal(result.status, 'unavailable', `${id} ${cell}`)
            assert.ok(result.inputs.missing.length > 0, `${id} ${cell} names what is missing`)
          }

          dashes++
        } else {
          assert.ok(result, `${id} ${cell} has a mark with a result`)
          assert.notEqual(result.status, 'unavailable', `${id} ${cell}`)
          assert.notEqual(ctx.m.provenance.getRule(result.rule.id), null, `${id} ${cell} rule ${result.rule.id}`)

          const expected = cell === 'cost' ? 'habitability.colonyCost' : cell === 'capacity' ? 'habitability.bodyCapacity' : cell.startsWith('amount') ? 'colonyWorksheet.depositAmount' : 'colonyWorksheet.depositAccessibility'

          assert.equal(result.rule.id, expected, `${id} ${cell}`)
          figures++
        }
      }
    }

    const items = w.worksheetRows({ rows: fixture.rows, selection: select(fixture.rows, [101]), speciesId: 1 })

    assert.equal(markOf(view, 101, 'amount-1').result.value, items[0].amount1)
    assert.equal(markOf(view, 101, 'access-1').result.value, items[0].access1)
    assert.equal(markOf(view, 101, 'cost').result.value, items[0].costValue)
    assert.ok(figures >= 20 && dashes >= 20, `${figures} figures and ${dashes} dashes were read`)

    const head = nodesOf(view, (node) => Boolean(node.componentOptions && node.componentOptions.tag === 'provenance-mark')).filter((node) => node.data.attrs.rule)

    assert.ok(head.length >= 1)
    assert.notEqual(ctx.m.provenance.getRule(head[0].data.attrs.rule), null)

    return true
  }))

  add('rules: the worksheet\'s rules are registered for the game version, state their limits and speak in no first or second person', () => {
    for (const id of ['colonyWorksheet.depositAmount', 'colonyWorksheet.depositAccessibility']) {
      const rule = ctx.m.provenance.getRule(id)

      assert.ok(rule, id)
      assert.ok(rule.versions.length > 0)
      assert.equal(FIRST_OR_SECOND_PERSON.test(`${rule.note} ${rule.assumptions.join(' ')}`), false, id)
      assert.ok(rule.note.length > 0)
    }

    return true
  })

  add('voice: the panel speaks in no first or second person and carries no figure that changes in its summary', settle(async () => {
    const fixture = await fx()
    const shown = await render(THREE)
    const empty = mount(ctx, { selection: [], rows: fixture.rows, species: fixture.species })
    const waiting = mount(ctx, { selection: select(fixture.rows, THREE), rows: fixture.rows, species: fixture.species, loading: true })
    const texts = [textOf(shown.tree()), textOf(empty.tree()), textOf(waiting.tree()), String(attrOf(shown.tree(), 'data-summary'))]

    for (const text of texts) {
      assert.equal(FIRST_OR_SECOND_PERSON.test(text.replace(/\b[A-Z]\b/g, '')), false, text.slice(0, 120))
    }

    for (const row of fixture.rows) {
      const [item] = w.worksheetRows({ rows: [row], selection: select(fixture.rows, [row.body.SystemBodyID]) })

      assert.equal(FIRST_OR_SECOND_PERSON.test(`${item.reason || ''} ${item.missing.join(' ')}`), false)
    }

    return true
  }))

  add('summary: the panel is a top-level panel with a data-summary of a sentence or two and no figure that changes', settle(async () => {
    const { tree } = await render(THREE)
    const root = tree()
    const summary = attrOf(root, 'data-summary')

    assert.equal(typeof summary, 'string')
    assert.ok(summary.trim().length > 0)

    const fixture = await fx()

    for (const [name, selection, extra] of [['one body', [101]], ['six bodies', [101, 102, 103, 104, 105, 106]], ['no body', []], ['a missing body', [101, 999]], ['loading', THREE, { loading: true }], ['no rows', THREE, { rows: [] }], ['one species', THREE, { species: fixture.species.slice(0, 1) }]]) {
      const other = await render(selection, extra)

      assert.equal(attrOf(other.tree(), 'data-summary'), summary, `the summary does not change with ${name}`)
    }

    assert.ok((summary.match(/[.!?](\s|$)/g) || []).length <= 2)
    const classes = (node) => String((node.data && node.data.staticClass) || '').split(/\s+/)

    assert.ok(classes(root).includes('panel'))
    assert.equal(nodesOf(root, (node) => classes(node).includes('panel-head')).length, 1)
    assert.equal(nodesOf(root, (node) => ['canvas', 'v-chart', 'chart-canvas'].includes(node.tag)).length, 0)

    return true
  }))

  add('template: the panel and the body detail templates compile', () => {
    assert.ok(ctx.component.render)
    assert.ok(ctx.detail.render)

    return true
  })

  add('page: the Planner\'s detail shows the evaluation the worksheet reads, for the species picked there or the body\'s best', settle(async () => {
    const fixture = await fx()

    for (const row of fixture.rows) {
      const item = { id: row.body.SystemBodyID, row, body: row.body, best: row.best }

      for (const speciesId of [undefined, 1, 2, 99]) {
        const shown = ctx.pageOptions.methods.shownEvaluation.call({ detailSpecies: speciesId === undefined ? {} : { [item.id]: speciesId } }, item)

        assert.equal(shown, w.evaluationOf(row, speciesId), `${item.id} ${speciesId}`)
      }
    }

    return true
  }))

  add('page: the Planner shows the worksheet exactly when it is ready with rows, species and a selection, with those very props, and tells it when the rows are being worked out again', settle(async () => {
    const text = ctx.sources[P].replace(/\r\n/g, '\n')
    const tags = text.match(/<colony-worksheet\s[^>]*>(?:\s*<\/colony-worksheet>)?/g) || []

    assert.equal(tags.length, 1, 'the page mounts the worksheet once')

    const compiled = compileTemplate({ source: `<div>${tags[0]}</div>`, filename: 'mount.vue' })

    assert.equal(compiled.errors.length, 0, compiled.errors.join('; '))

    const { render, staticRenderFns } = nodeVm.runInThisContext(`(function () {\n${compiled.code}\nreturn { render, staticRenderFns }\n})()`)
    const Stub = { name: 'ColonyWorksheet', props: ['selection', 'rows', 'species', 'loading'], render: (h) => h('div') }
    const fixture = await fx()
    const selection = select(fixture.rows, THREE)
    const Host = extended({ components: { ColonyWorksheet: Stub }, data: () => ({ ready: true, rows: fixture.rows, speciesRows: fixture.species, selectedBodies: selection, tableItems: [] }) }, { render, staticRenderFns }, {
      beforeCreate () {
        this.$asyncComputed = { assessed: { updating: false }, rows: { updating: false } }
      },
    })
    const host = new Host()

    mounted.push(host)

    const mountsOf = () => nodesOf(host._render(), (node) => Boolean(node.componentOptions && node.componentOptions.tag === 'colony-worksheet'))

    assert.equal(mountsOf().length, 1)

    const [shown] = mountsOf()

    assert.equal(shown.componentOptions.propsData.selection, host.selectedBodies)
    assert.equal(shown.componentOptions.propsData.rows, host.rows)
    assert.equal(shown.componentOptions.propsData.species, host.speciesRows)
    assert.equal(Boolean(shown.componentOptions.propsData.loading), false)

    for (const [name, change] of [['not ready', () => { host.ready = false }], ['no rows yet', () => { host.rows = null }], ['no species', () => { host.speciesRows = [] }], ['no selection', () => { host.selectedBodies = [] }]]) {
      const held = { ready: host.ready, rows: host.rows, speciesRows: host.speciesRows, selectedBodies: host.selectedBodies }

      change()
      assert.equal(mountsOf().length, 0, name)
      Object.assign(host, held)
      assert.equal(mountsOf().length, 1, `${name} restored`)
    }

    for (const read of ['rows', 'assessed']) {
      host.$asyncComputed[read].updating = true
      assert.equal(Boolean(mountsOf()[0].componentOptions.propsData.loading), true, read)
      host.$asyncComputed[read].updating = false
    }

    assert.equal(Boolean(mountsOf()[0].componentOptions.propsData.loading), false)
    assert.deepEqual(ctx.pageOptions.computed.speciesRows.call({ ready: true, species: fixture.species }), fixture.species)
    assert.deepEqual(ctx.pageOptions.computed.speciesRows.call({ ready: false, species: fixture.species }), [])
    assert.equal(typeof ctx.pageOptions.components.ColonyWorksheet, 'object')

    return true
  }))

  // The time of a drain on the Planner's own pipeline and the page's own detail and tooltip: the reviewer's probe at 100 installations of rate 1, the capacity bound of 4.55 days. The surface evaporates and the terraformer removes only the vapour in the air, so the drain can take longer: every place that words the time says it is a minimum, and an ordinary plan is worded as it was.
  add('drain: the body detail, the tooltip, the state and the worksheet word the time of a drain as a minimum that evaporation can exceed, and a plan that drains nothing is worded as before', async () => {
    const opened = []
    const timed = async (name) => {
      const { db, database } = await buildDatabase(ctx.m, rowsOfTimeCase(TIME_CASES[name]))

      opened.push(db)

      const fixture = { ...(await pipeline(ctx.m, database, SCOPE, 100)), database }
      const row = rowById(fixture.rows, PLANNED_BODY)

      return { fixture, row, speciesId: TIME_CASES[name].species.SpeciesID, capacity: ctx.m.colonization.terraformCapacityResult(fixture.raceRules, 100).value }
    }
    const tooltip = (row) => {
      const self = { separator: ',' }

      self.years = (value) => ctx.pageOptions.methods.years.call(self, value)
      self.time = (value, basis) => ctx.pageOptions.methods.time.call(self, value, basis)

      return ctx.pageOptions.methods.stateTooltip.call(self, row)
    }

    try {
      const drain = await timed('drain')
      const { row } = drain

      assert.equal(row.best.species.SpeciesID, 3, 'the ammonia breather is the body\'s species')
      assert.equal(row.best.strategy, 'terraform', 'the plan is the best route')
      assert.ok(Math.abs(drain.capacity - 100) < 1e-9, 'the race moves 100 Earth atm a year')
      assert.ok(Math.abs(row.best.years - 1.2472576986093435 / 100) < 1e-9, 'the years are the capacity bound, 4.55 days')
      assert.equal(row.best.yearsBasis, 'minimum', 'the ranking labels the years a minimum')

      const rendered = renderedDetail(ctx, drain.fixture, row, drain.speciesId, drain.capacity)
      const { text } = rendered

      assert.equal(rendered.shown.yearsBasis, 'minimum', 'the evaluation the detail shows is labelled')
      assert.ok(text.includes('draining 50% of the surface water with it, at least 4.5 days, and longer where the surface water evaporates slowly.'), 'the step that drains')
      assert.ok(text.includes('at least 4.5 days with the terraformers set by the race, 1.247 atm of Earth-equivalent work'), 'the plan\'s total')
      assert.equal(rendered.minimumNotes.length, 1, 'the plan\'s heading carries one note')
      assert.ok(rendered.minimumNotes[0].startsWith('A minimum, not a finishing date') && rendered.minimumNotes[0].includes('evaporates more into it only in small steps'), 'the note under the plan\'s heading names the evaporation')
      assert.ok(text.includes('Installations to move the work within') && !text.includes('Installations to finish within'), 'the installation counts')
      assert.ok(text.includes('× at least 4.5 days to terraform'), 'the discount line of the ranking')
      assert.ok(text.includes('The terraforming time is a minimum, so the worth is the most the plan can earn.'), 'the ranking caption')
      assert.ok(text.includes('Terraforming takes at least 4.5 days with the terraformers'), 'the state above the detail')
      assert.ok(text.includes('no stage is dated'), 'the stage notes')
      assert.ok(!/about 4\.\d|under 0\.1 years/.test(text), 'no figure of the time is a plain estimate')

      assert.ok(row.rank === 1 && tooltip(row).includes('after at least 4.5 days of terraforming'), 'the tooltip of the ranked row')
      assert.equal(row.state.chip(row.facts), 'To free · at least 4.5 days', 'the chip of the state')
      assert.ok(ctx.sources[P].includes('counts its minimum years'), 'the ranking help says the years of a drain are a minimum')

      // The worksheet shows the cost and the limit as they are today and no time of a plan, so nothing of it claims a completion.
      const [sheet] = w.worksheetRows({ rows: drain.fixture.rows, selection: select(drain.fixture.rows, [PLANNED_BODY]), speciesId: drain.speciesId })

      assert.equal(sheet.state, 'known')
      assert.ok(Math.abs(sheet.costValue - 5) < 1e-9, 'the worksheet shows the cost the body has, 5, not the cost the drain ends at')
      assert.deepEqual(Object.keys(sheet).filter((key) => /year|time|basis|plan|drain/i.test(key)), [], 'a worksheet row carries no time of a plan')

      // The rendered table itself, not only the row's keys: its columns are the body, its species, the cost and the limit, and no column or cell of the draining body words a time of a plan.
      const sheetView = mount(ctx, { selection: select(drain.fixture.rows, [PLANNED_BODY]), rows: drain.fixture.rows, species: drain.fixture.species }).tree()
      const heads = nodesOf(sheetView, (node) => node.tag === 'th' && (node.children || []).some((child) => Boolean(child.data && child.data.attrs && child.data.attrs['data-sort']))).map((node) => textOf(node).replace(/[▲▼]/g, '').replace(/\s+/g, ' ').trim())
      const cells = nodesOf(rowNode(sheetView, PLANNED_BODY) || { children: [] }, (node) => node.tag === 'td').map((node) => textOf(node).replace(/\s+/g, ' ').trim())

      assert.deepEqual(heads.slice(0, 4), ['Body', 'Species', 'Colony cost', 'Holds'], 'the rendered table leads with the body, its species, the cost and the limit')
      assert.equal(cellText(sheetView, PLANNED_BODY, 'cost'), '5', 'the rendered row shows the cost the body has now')
      assert.deepEqual(heads.filter((head) => /time|year|day|finish|terraform|minimum/i.test(head)), [], 'no column of the rendered table is a time of a plan')
      assert.deepEqual(cells.filter((cell) => /at least|\byears?\b|\bdays?\b|minimum|terraform/i.test(cell)), [], 'no cell of the rendered row words a time of a plan')

      // The page writes years at one decimal, and floors a bound there: a bound whose nearest rounding would overshoot reads below itself.
      const pageTime = (value, basis) => ctx.pageOptions.methods.time.call({ separator: ',', years: (one) => ctx.pageOptions.methods.years.call({ separator: ',' }, one) }, value, basis)

      assert.equal(pageTime(2.36, 'minimum'), 'at least 2.3 y', 'a 2.36-year bound reads 2.3 years at the page\'s one decimal, not the 2.4 nearest rounding gives')
      assert.equal(pageTime(2.36, 'capacity'), '2.4 y', 'a plan that drains nothing keeps the page\'s nearest rounding')

      // An ordinary plan: the oxygen breather's cold ice body is warmed and drains nothing, and every place words its time as it did.
      const plain = await timed('plain')

      assert.equal(plain.row.best.strategy, 'terraform', 'the ordinary plan is the best route')
      assert.equal(plain.row.best.yearsBasis, 'capacity', 'its years keep the capacity basis')

      const ordinaryDetail = renderedDetail(ctx, plain.fixture, plain.row, plain.speciesId, plain.capacity)
      const ordinary = ordinaryDetail.text

      assert.deepEqual(ordinaryDetail.minimumNotes, [], 'its plan\'s heading carries no note')

      assert.ok(/, about /.test(ordinary), 'its step is "about" its time')
      assert.ok(ordinary.includes('Installations to finish within'), 'its installations finish within')
      assert.ok(!/at least|minimum|finishing date|no stage is dated/.test(ordinary), 'it says nothing of a minimum')
      assert.ok(!/at least|minimum/.test(tooltip(plain.row)) && !/at least|minimum/.test(plain.row.state.chip(plain.row.facts)), 'neither does its tooltip or chip')

      return true
    } finally {
      opened.forEach((db) => db.close())
    }
  })

  // Terra's r1 finding: the game lists the year's Aestusium and Frigusium estimates for a colony that moves pressure, and its source gates them on the capacity, not on the Planner having a plan. The detail must draw them beside the body's temperature for a body already liveable (Done, no plan) and for one no plan was found for; the plan's own years and capacity lines stay with a plan, and a colony that moves no pressure gets no line.
  add('one-year: the body detail draws a year of the colony\'s Aestusium and Frigusium beside the temperature whether or not there is a plan, and nothing from a colony that moves no pressure', async () => {
    const { db, database } = await buildDatabase(ctx.m, rowsOfOwnColony())

    try {
      const fixture = { ...(await pipeline(ctx.m, database, SCOPE, 1)), database }
      const detail = (body, sources) => {
        const row = rowById(fixture.rows, body)

        return { ...renderedDetail(ctx, fixture, row, OWN_SPECIES.SpeciesID, 1, sources), body: row.body }
      }
      const round = (value) => ctx.m.math.roundToDecimal(value, 1)
      // The line the tab gives the body's temperature now, from the body's climate and its unfrozen gases rather than the saved SurfaceTemp.
      const nowLine = (body) => {
        const unfrozen = (body.Atmosphere || []).filter((gas) => !gas.FrozenOut)
        const greenhouse = unfrozen.reduce((total, gas) => total + (gas.GHGas ? gas.GasAtm : 0), 0)
        const anti = unfrozen.reduce((total, gas) => total + (!gas.GHGas && gas.AntiGHGas ? gas.GasAtm : 0), 0)
        const temperature = ctx.m.habitability.surfaceTemperature(body, Math.min(3, 1 + body.AtmosPress / 10 + greenhouse), Math.min(3, 1 + body.DustLevel / 20000 + anti))

        return `${round(temperature)} K (${round(temperature - 273)} °C)`
      }
      const section = 'The race\'s colonies on this body'
      // The three lines the tab gives a colony that moves pressure: the temperature now, Aestusium above it and Frigusium below.
      const estimates = (rendered, label) => {
        const now = nowLine(rendered.body)

        assert.equal(rendered.oneYear.length, 3, `${label}: the temperature now and both gas estimates`)
        assert.ok(rendered.oneYear[0].includes('Surface temperature now') && rendered.oneYear[0].includes(now), `${label}: the temperature now, ${now}`)
        assert.ok(rendered.oneYear[1].includes('Add Aestusium for one year') && / K \(\+\d/.test(rendered.oneYear[1]), `${label}: Aestusium raises the temperature`)
        assert.ok(rendered.oneYear[2].includes('Add Frigusium for one year') && / K \(-\d/.test(rendered.oneYear[2]), `${label}: Frigusium lowers it`)
      }

      // Done: the body suits the species, so there is no plan to make; the colony's terraformers still move pressure.
      const done = detail(OWN_BODIES.done, ownSources())

      assert.equal(done.shown.assessment.outcome, 'done', 'the liveable body needs no plan')
      assert.equal(done.shown.assessment.plan, null, 'and has none')
      assert.ok(done.text.includes('Already liveable for this species: nothing to terraform.'), 'the detail says there is nothing to terraform')
      assert.ok(done.text.includes(section), 'the colony is drawn')
      estimates(done, 'done')

      // No plan found: too light to keep an atmosphere, with the colony's terraformers still there.
      const without = detail(OWN_BODIES.noPlan, ownSources())

      assert.equal(without.shown.assessment.plan, null, 'no plan was found')
      assert.equal(without.shown.assessment.outcome, 'no')
      assert.ok(without.text.includes('Too light to keep an atmosphere'), 'the detail says why')
      estimates(without, 'no plan')

      // A plan: the estimates stay, and the plan's own years and capacity lines come with them.
      const planned = detail(OWN_BODIES.planned, ownSources())

      assert.ok(planned.shown.assessment.plan, 'the cold body has a plan')
      assert.ok(planned.text.includes('for this plan'), 'the colony\'s years are for the plan')
      assert.ok(planned.text.includes('Racial rate'), 'its capacity is broken down')
      estimates(planned, 'plan')
      assert.ok(!done.text.includes('for this plan') && !without.text.includes('for this plan'), 'the years of a plan are not worded without one')

      // A colony that moves no pressure: no line at all, and no section of its own.
      const idle = detail(OWN_BODIES.done, ownSources(0))

      assert.deepEqual(idle.oneYear, [], 'a colony that moves no pressure gets no line')
      assert.ok(!idle.text.includes(section), 'and no section is drawn')

      // A capacity the save does not settle: the one-year line says so rather than a figure.
      const unknown = detail(OWN_BODIES.done, ownSources(null)).oneYear

      assert.equal(unknown.length, 1, 'an unknown capacity draws the one-year line only')
      assert.ok(unknown[0].includes('Temperature after a year of terraforming') && unknown[0].includes('not known'), 'and says it is not known')

      return true
    } finally {
      await new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())))
    }
  })

  return list
}

// ---------- the saves ----------

const saveStatements = async (ctx, save) => {
  const file = path.join(root, save.file)

  if (!fs.existsSync(file)) {
    return { skipped: true, statements: [] }
  }

  const db = await new Promise((resolve, reject) => {
    const opened = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(opened)))
  })
  const database = wrapped(db)
  const scope = { GameID: save.game, RaceID: save.race }
  const w = ctx.m['colony-worksheet']
  let loaded = null
  const pipelineOf = () => {
    if (!loaded) {
      loaded = pipeline(ctx.m, database, scope)
    }

    return loaded
  }
  const raw = (sql) => database.query(sql).then(([items]) => items)

  return {
    close: () => db.close(),
    statements: [
      [`save-worksheet: ${save.file} race ${save.race}: the deposits of three bodies are the raw rows of the bodies the race surveyed, nothing of the others, and the cost and the limit are the assessment's`, async () => {
        const { rows, assessed } = await pipelineOf()
        const surveyed = rows.filter((row) => row.minerals.surveyed && row.body.Minerals.length)
        const unsurveyed = rows.filter((row) => !row.minerals.surveyed)

        assert.ok(surveyed.length >= 2 && unsurveyed.length >= 1, 'the save needs surveyed and unsurveyed bodies')

        const chosen = [surveyed[0], surveyed[surveyed.length - 1], unsurveyed[0]]
        const items = w.worksheetRows({ rows, selection: chosen.map(referenceOf) })

        assert.deepEqual(items.map((item) => item.id), chosen.map((row) => row.body.SystemBodyID))

        for (const item of items) {
          const stored = await raw(`select MaterialID, Amount, Accessibility from FCT_MineralDeposit where GameID = ${save.game} and SystemBodyID = ${item.id}`)
          const own = await raw(`select 1 as Hit from FCT_SystemBodySurveys where RaceID = ${save.race} and SystemBodyID = ${item.id}`)

          for (const cell of item.minerals) {
            const deposits = stored.filter((deposit) => deposit.MaterialID === cell.id)

            if (own.length === 0) {
              assert.equal(cell.status, 'unsurveyed')
              assert.equal(cell.amount, null)
            } else if (deposits.length === 1) {
              assert.equal(cell.amount, deposits[0].Amount, `${item.id} amount ${cell.id}`)
              assert.equal(cell.accessibility, deposits[0].Accessibility, `${item.id} accessibility ${cell.id}`)
            } else if (deposits.length === 0) {
              assert.equal(cell.amount, 0)
              assert.equal(cell.accessibility, null)
            } else {
              assert.equal(cell.status, 'ambiguous')
            }
          }

          const row = rowById(rows, item.id)
          const independent = assessed.find((entry) => entry.body.SystemBodyID === item.id).byspecies.find((entry) => entry.species.SpeciesID === row.best.species.SpeciesID)

          if (item.state === 'known') {
            assert.equal(item.costValue, independent.assessment.cost.worst)
            assert.equal(item.capacityValue, independent.capacityNow)
          }
        }

        return true
      }],
    ],
  }
}

// ---------- the planted faults ----------

// An anchor found by its shape and not by its wording: the whole value of the `data-summary` attribute, and the whole loading-state element, whatever they say.
const SUMMARY_ATTRIBUTE = (text) => (text.match(/data-summary="[^"]*"/g) || [])[0]
const LOADING_ELEMENT = (text) => (text.match(/<div v-if="loading"[^>]*data-state="loading"[^>]*>[^<]*<\/div>/g) || [])[0]
const COLUMN_ENTRY = (key) => (text) => (text.match(new RegExp(`\\{ key: '${key}', text: '[^']*' \\},`, 'g')) || [])[0]

// A planted fault and the checks that must fail for it: each name is the key of a check (the text before its colon), and the fault is caught only when every one of them fails.
const MUTATIONS = [
  { name: 'an unsurveyed body read as one with no deposits', file: U, find: 'row.minerals.surveyed ? depositCell(mineral, row.body.Minerals.filter((deposit) => deposit.MaterialID === mineral.id)) : unsurveyedCell(mineral)', replace: 'depositCell(mineral, row.body.Minerals.filter((deposit) => deposit.MaterialID === mineral.id))', fails: ['unknown', 'hidden'] },
  { name: 'an unsurveyed body\'s deposit rows shown', file: U, find: 'row.minerals.surveyed ? depositCell(', replace: '(row.minerals.surveyed || row.body.Minerals.length) ? depositCell(', fails: ['hidden'] },
  { name: 'an amount not recorded read as 0', file: U, find: 'const amount = recorded(deposit.Amount)', replace: 'const amount = recorded(deposit.Amount) ?? 0', fails: ['unknown'] },
  { name: 'an accessibility not recorded read as 0', file: U, find: 'const accessibility = recorded(deposit.Accessibility)', replace: 'const accessibility = recorded(deposit.Accessibility) ?? 0', fails: ['unknown'] },
  { name: 'a figure stored as blank text read as a known 0', file: U, find: 'isKnownNumber(value) && (typeof value !== \'string\' || value.trim() !== \'\') ? Number(value) : null', replace: 'isKnownNumber(value) ? Number(value) : null', fails: ['unknown'] },
  { name: 'a surveyed body with no deposit of a mineral read as unknown', file: U, find: 'status: \'none\', amount: 0,', replace: 'status: \'none\', amount: null,', fails: ['unknown'] },
  { name: 'the first of two deposit rows of a mineral taken', file: U, find: 'if (deposits.length > 1) {', replace: 'if (false) {', fails: ['unknown'] },
  { name: 'the amount read from the original amount', file: U, find: 'const amount = recorded(deposit.Amount)', replace: 'const amount = recorded(deposit.HalfOriginalAmount)', fails: ['three', 'unknown'] },
  { name: 'the accessibility read from the amount', file: U, find: 'const accessibility = recorded(deposit.Accessibility)', replace: 'const accessibility = recorded(deposit.Amount)', fails: ['three', 'unknown'] },
  { name: 'an unsurveyed body\'s figure marked as a result of the rule', file: U, find: 'amountResult: unavailable({ rule: AMOUNT_RULE, missing: [SURVEY_INPUT] }),', replace: 'amountResult: ofRule({ rule: AMOUNT_RULE, value: 0 }),', fails: ['unknown', 'provenance'] },
  { name: 'an amount marked as an accessibility', file: U, find: 'ofRule({ rule: AMOUNT_RULE, value: amount, inputs: { present: [\'the deposit\', \'the body\\\'s survey\'] } })', replace: 'ofRule({ rule: ACCESSIBILITY_RULE, value: amount, inputs: { present: [\'the deposit\', \'the body\\\'s survey\'] } })', fails: ['provenance'] },
  { name: 'the cost taken as the cost now, not the worst of the orbit', file: U, find: 'costValue: assessment.cost.worst,', replace: 'costValue: assessment.cost.current,', fails: ['parity'] },
  { name: 'the cost taken after terraforming', file: U, find: 'costValue: assessment.cost.worst,', replace: 'costValue: assessment.plan && assessment.after ? assessment.after.worst : assessment.cost.worst,', fails: ['parity'] },
  { name: 'the gravity class dropped from the row', file: U, find: 'gravityClass: assessment.gravityClass || null }', replace: 'gravityClass: null }', fails: ['gravity'] },
  { name: 'the gravity class not drawn beside the cost', file: V, find: '<span v-if="item.gravityClass" class="caption" :title="gravityText(item.gravityClass)" data-cell="gravity-class"> {{ item.gravityClass }}</span>', replace: '', fails: ['gravity'] },
  { name: 'the gravity class not drawn in the body detail', file: B, find: '<span v-if="assessment.gravityClass" class="caption" :title="gravityText(assessment.gravityClass)" data-detail="gravity-class">{{ assessment.gravityClass }}</span>', replace: '', fails: ['gravity'] },
  { name: 'the year\'s estimates drawn only under a plan', file: B, find: '<template v-if="ownColonies.length">', replace: '<template v-if="plan && ownColonies.length">', fails: ['one-year'] },
  { name: 'the limit of the first species for every body', file: U, find: 'capacityValue: evaluation.capacityNow,', replace: 'capacityValue: row.evaluations[0].capacityNow,', fails: ['parity'] },
  { name: 'the species picked ignored', file: U, find: '(speciesId && row.evaluations.find((evaluation) => evaluation.species.SpeciesID === speciesId)) || row.best', replace: 'row.best', fails: ['species', 'parity'] },
  { name: 'a body selected twice listed twice', file: U, find: 'selection.filter((reference) => !seen.has(reference.SystemBodyID) && seen.add(reference.SystemBodyID))', replace: 'selection.filter(() => true)', fails: ['absent'] },
  { name: 'a selected body the rows lack dropped', file: U, find: 'selection.filter((reference) => !seen.has(reference.SystemBodyID) && seen.add(reference.SystemBodyID))', replace: 'selection.filter((reference) => byId.has(reference.SystemBodyID) && !seen.has(reference.SystemBodyID) && seen.add(reference.SystemBodyID))', fails: ['absent'] },
  { name: 'a score added to the rows', file: U, find: 'name: bodyName(row.body), minerals: cells, ...flat(cells) }', replace: 'name: bodyName(row.body), score: row.score, minerals: cells, ...flat(cells) }', fails: ['score'] },
  { name: 'the rows left unsorted', file: U, find: 'sortTableItems(items, sortBy, sortDesc, COLLATOR.compare)', replace: 'items', fails: ['sort'] },
  { name: 'the sort direction ignored', file: U, find: 'sortTableItems(items, sortBy, sortDesc, COLLATOR.compare)', replace: 'sortTableItems(items, sortBy, [false], COLLATOR.compare)', fails: ['sort'] },
  { name: 'a cost with no figure given the cost of an unfit body', file: U, find: 'if (!assessment.cost.colonisable) {', replace: 'if (false) {', fails: ['unfit'] },
  { name: 'a body with a figure missing given its figures', file: U, find: 'if (missing.length) {\n    return { ...base, state: \'unknown\', missing }', replace: 'if (false) {\n    return { ...base, state: \'unknown\', missing }', fails: ['unfit'] },
  { name: 'a body the species cannot live on told apart from one with a figure missing', file: U, find: 'return { ...base, state: \'unfit\', reason:', replace: 'return { ...base, state: \'unknown\', missing: [\'a reason\'], reason:', fails: ['unfit'] },
  { name: 'the cost marked with the cost now, not the worst of the orbit', file: C, find: 'cost: ofRule({ rule: \'habitability.colonyCost\', value: assessment.cost.worst, inputs: { present: COST_INPUTS }, assumptions: row.basis.skillAssumed ? [SKILL_ASSUMPTION] : [] }),', replace: 'cost: ofRule({ rule: \'habitability.colonyCost\', value: assessment.cost.current, inputs: { present: COST_INPUTS }, assumptions: row.basis.skillAssumed ? [SKILL_ASSUMPTION] : [] }),', fails: ['parity', 'provenance'] },
  { name: 'the limit marked as 0', file: C, find: 'capacity: ofRule({ rule: \'habitability.bodyCapacity\', value: evaluation.capacityNow,', replace: 'capacity: ofRule({ rule: \'habitability.bodyCapacity\', value: 0,', fails: ['parity'] },
  { name: 'the panel without its data-summary', file: V, find: 'data-summary="', replace: 'data-sum="', fails: ['summary'] },
  { name: 'the data-summary carrying a count that changes with the selection', file: V, find: SUMMARY_ATTRIBUTE, replace: () => ':data-summary="\'Bodies side by side: \' + selection.length + \' shown.\'"', fails: ['summary'] },
  { name: 'the cost without its mark', file: V, find: '<provenance-mark :result="item.results.cost" />', replace: '', fails: ['provenance'] },
  { name: 'the amounts without their marks', file: V, find: '<provenance-mark :result="cell.amountResult" />', replace: '', fails: ['provenance'] },
  { name: 'the accessibilities without their marks', file: V, find: '<provenance-mark :result="cell.accessResult" />', replace: '', fails: ['provenance'] },
  { name: 'the limit without its mark', file: V, find: '<provenance-mark :result="item.results.capacity" />', replace: '', fails: ['provenance'] },
  { name: 'the species chosen ignored by the table', file: V, find: 'speciesId: this.chosenId })', replace: 'speciesId: null })', fails: ['species'] },
  { name: 'a species the race lacks kept', file: V, find: 'return this.species.some((one) => one.SpeciesID === this.speciesId) ? this.speciesId : null', replace: 'return this.speciesId', fails: ['persist'] },
  { name: 'the species kept for the app, not the race', file: V, find: 'key: \'colonyWorksheetSpecies\', default: null, scope: \'race\', normalise: positiveInteger', replace: 'key: \'colonyWorksheetSpecies\', default: null, normalise: positiveInteger', fails: ['persist'] },
  { name: 'a stored sort column the table lacks used', file: V, find: 'return table && SORT_KEYS.includes([table.sortBy].flat()[0]) ?', replace: 'return table ?', fails: ['persist'] },
  { name: 'the sort ignored by the panel', file: V, find: 'return sortWorksheetRows(this.items, this.table.sortBy, [this.table.sortDesc].flat())', replace: 'return this.items', fails: ['sort'] },
  { name: 'a column without its sort state', file: V, find: ' :aria-sort="ariaSort(column.key)"', replace: '', fails: ['sort'] },
  { name: 'a score column added', file: V, find: COLUMN_ENTRY('capacityValue'), replace: (found) => `${found}\n  { key: 'score', text: 'Score' },`, fails: ['score'] },
  { name: 'an amount not known drawn as 0', file: V, find: 'return value === null ? UNKNOWN : compact(value)', replace: 'return compact(value === null ? 0 : value)', fails: ['unknown', 'provenance'] },
  { name: 'an accessibility not known drawn as 0', file: V, find: 'accessibility(value) {\n      return value === null ? UNKNOWN : roundToDecimal(value, 2).toString()', replace: 'accessibility(value) {\n      return roundToDecimal(value === null ? 0 : value, 2).toString()', fails: ['unknown', 'provenance'] },
  { name: 'a cost not known drawn as 0', file: V, find: 'return value === null ? UNKNOWN : roundToDecimal(value, 2).toString()\n    },\n    tons', replace: 'return roundToDecimal(value === null ? 0 : value, 2).toString()\n    },\n    tons', fails: ['unfit', 'provenance'] },
  { name: 'the rows shown while they are worked out again', file: V, find: '<div v-if="loading"', replace: '<div v-if="false"', fails: ['loading'] },
  { name: 'the panel worded in the second person', file: V, find: LOADING_ELEMENT, replace: (found) => found.replace(/>[^<]*<\/div>$/, '>Your bodies are being worked out.</div>'), fails: ['voice'] },
  { name: 'the body detail\'s cost taken as the cost now', file: B, find: 'data-detail="cost">', replace: 'data-detail="cost">{{ cost(assessment.cost.current) }}</div><div data-detail-rest="1">', fails: ['parity'] },
  { name: 'the body detail\'s cost without its hook', file: B, find: 'data-detail="cost"', replace: 'data-detail-x="cost"', fails: ['parity'] },
  { name: 'the page\'s detail showing the best species whatever is picked', file: P, find: 'return evaluationOf(item.row, this.detailSpecies[item.id])', replace: 'return item.best', fails: ['page'] },
  { name: 'the worksheet never shown', file: P, find: '<colony-worksheet v-if="ready', replace: '<colony-worksheet v-if="false && ready', fails: ['page'] },
  { name: 'the worksheet shown before the rows are ready', file: P, find: '<colony-worksheet v-if="ready && rows && ', replace: '<colony-worksheet v-if="', fails: ['page'] },
  { name: 'the worksheet not told when the rows are worked out again', file: P, find: 'selectedBodies.length" :selection="selectedBodies" :rows="rows" :species="speciesRows" :loading="$asyncComputed.assessed.updating || $asyncComputed.rows.updating"', replace: 'selectedBodies.length" :selection="selectedBodies" :rows="rows" :species="speciesRows" :loading="false"', fails: ['page'] },
  { name: 'the worksheet not mounted', file: P, find: '<colony-worksheet v-if=', replace: '<colony-worksheet-x v-if=', fails: ['page'] },
  { name: 'the worksheet given the filtered rows', file: P, find: ':rows="rows" :species="speciesRows"', replace: ':rows="tableItems" :species="speciesRows"', fails: ['page'] },
  { name: 'the worksheet mounted without a selection', file: P, find: 'speciesRows.length && selectedBodies.length" :selection', replace: 'speciesRows.length" :selection', fails: ['page'] },
  { name: 'the worksheet not registered', file: P, find: 'components: { BodyDetail, ColonyWorksheet, LoadState,', replace: 'components: { BodyDetail, LoadState,', fails: ['page'] },
  { name: 'the primary star tested by the star\'s old component name', file: C, find: 'if (star.ComponentNumber === 1) {', replace: 'if (star.Component === 1) {', fails: ['cmc-reach'] },
  { name: 'a companion beyond the reach counted as in reach whatever it orbits from', file: C, find: 'return star.Apoapsis < CMC_REACH_AU || linked([star.StarID])', replace: 'return true', fails: ['cmc-reach'] },
  { name: 'the step that drains worded as about its years', file: B, find: ', {{ stepTime(step) }}.</v-list-item-subtitle>', replace: ', about {{ years(stepYears(step)) }}.</v-list-item-subtitle>', fails: ['drain'] },
  { name: 'the plan\'s total worded as plain years', file: B, find: 'const total = this.time(planYears(this.assessment.work, this.terraformCapacity), this.assessment.timeBasis)', replace: 'const total = this.years(planYears(this.assessment.work, this.terraformCapacity))', fails: ['drain'] },
  { name: 'the ranking line worded as plain years', file: B, find: '{{ time(shown.years, shown.yearsBasis) }} to terraform', replace: '{{ years(shown.years) }} to terraform', fails: ['drain'] },
  { name: 'the ranking caption silent on a minimum', file: B, find: 'this.shown.strategy === \'terraform\' && this.shown.yearsBasis === TIME_BASIS.MINIMUM ?', replace: 'false ?', fails: ['drain'] },
  { name: 'the minimum-time note never shown', file: B, find: '<div v-if="minimumTime" class="caption text--secondary mb-1" data-detail="minimum-time">', replace: '<div v-if="false" class="caption text--secondary mb-1" data-detail="minimum-time">', fails: ['drain'] },
  { name: 'the installation counts for finishing within', file: B, find: 'return this.minimumTime ? \'Installations to move the work within\' : \'Installations to finish within\'', replace: 'return \'Installations to finish within\'', fails: ['drain'] },
  { name: 'the stage notes silent on an undated drain', file: B, find: '...(this.minimumTime ? [DRAIN_STAGE_NOTE] : []),', replace: '', fails: ['drain'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the tooltip worded in plain years', file: P, find: 'after ${this.time(best.years, best.yearsBasis)} of terraforming', replace: 'after ${this.years(best.years)} of terraforming', fails: ['drain'] },
  { name: 'the ranking help silent on a minimum', file: P, find: 'A plan that drains surface water counts its minimum years, the terraformers\' time, so its discount is the most that plan can earn. ', replace: '', fails: ['drain'] },
  { name: 'the evaluation without the basis of its years', file: C, find: 'yearsBasis: assessment.timeBasis, cost: assessment.after.worst', replace: 'yearsBasis: null, cost: assessment.after.worst', fails: ['drain'] },
  { name: 'the page floors a minimum at more decimals than it writes', file: P, find: 'timeWords(value, basis, this.years, 1)', replace: 'timeWords(value, basis, this.years, 2)', fails: ['drain'] },
]

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each planted fault and the checks of the real sources run in a process of their own ----------

const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((file) => [file, fs.readFileSync(FILES[file], 'utf8')]))

  if (mutant) {
    const find = typeof mutant.find === 'function' ? mutant.find(sources[mutant.file]) : mutant.find
    const replace = typeof mutant.replace === 'function' ? mutant.replace(find) : mutant.replace

    sources[mutant.file] = patched(mutant.file, sources[mutant.file], find, replace)
  }

  return sources
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const runStatements = async (list, keys = null) => {
  const results = []

  for (const [name, test] of list) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `${error.name === 'AssertionError' ? '' : 'threw '}${String(error.message).split('\n').slice(0, 3).join(' | ').slice(0, 400)}`
    }

    results.push([name, result])
  }

  return results
}

const checkHead = async (withSaves) => {
  const ctx = await contextOf(sourcesOf(null))
  const list = statements(ctx)
  const opened = []
  const skipped = []

  if (withSaves) {
    for (const save of SAVES) {
      const read = await saveStatements(ctx, save)

      if (read.skipped) {
        skipped.push(save.file)
      } else {
        list.push(...read.statements)
        opened.push(read)
      }
    }
  }

  console.log('\nColony comparison worksheet, on the Planner\'s pipeline over a save built here, the panel, the body detail, the page and the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  for (const [name, result] of await runStatements(list)) {
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

  const list = statements(ctx)
  const absent = mutant.fails.filter((key) => !list.some(([name]) => keyOf(name) === key))
  const results = await runStatements(list, mutant.fails)
  const missed = mutant.fails.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  check(`mutation caught: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--no-saves') {
      options.saves = false
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

    if (options.part === 'head' || options.part === 'head-saves') {
      await checkHead(options.part === 'head-saves')
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const sections = await runSections(__filename, [{ args: ['--part', options.saves ? 'head-saves' : 'head'], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id], weight: 3 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names')
    wanted.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
