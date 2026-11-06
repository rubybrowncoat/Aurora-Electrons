/*
  Checks the Empire summary of the Logistics page (src/renderer/utilities/empire-logistics.js, components/logistics/EmpireSummary.vue, the page's `summarySources` read and `summaryTable`): one row per colony with the figures of the game's Empire Logistics tab (M-CAP, M-CIO, M-TONS, M-YEAR, M-MSP, M-PROD, F-MLT, F-PRDM and the REF, RES and ORD marks), in the game's order and colours.

  Run: bun scripts/check-empire-logistics.js [--no-mutations]

  The expected figures of `s4` are typed here from the owner's two captures of the tab (the specimen S4, the interim fixture of scripts/lib/fixtures.js named `INTERIM`, at 17 June 2199, game 141, race 784), every row with its colours; `oracle` works the same figures out again from the stored rows by SQL and arithmetic written apart from the loaders, after the game's own code (`Race.method_92`, `Population.RecalculateMaintainedShipTonnage`, `RecalculateAnnualProductionCapacities`, `method_210`, `Ship.CountsAgainstPopulationMaintenance`):
  - `s4`: the page's own read and rows, drawn by the component, equal the capture for every colony: name, the eight figures as written (the whole figure, the fuel in millions to one place), the colour of each, the three marks and the order of the rows;
  - `oracle`: the rows equal the oracle's for the fixture as saved and for in-memory copies in which a fleet of maintenance modules is assigned to no colony, to another colony, moved by less than a unit, moved to another system, given a civilian function or has its modules damaged, a class is made commercial, a ship's mothership has no commercial hangar, a ship is in a shipyard task of its colony, a ship sits a hair off the body and a class lacks its hull spaces;
  - `formula`: the worked cases on given rows (capacity with every modifier, the module's addition with the racial capacity and the economic modifier alone, the whole facilities of production and of the marks, the tonnage and the supplies a year);
  - `show`: which colonies the list shows, one predicate at a time;
  - `order`: each of the eight columns orders the rows from the largest down, equal figures keeping the list order, an unknown figure last;
  - `colours`: the amber and red of the tonnage, the production and the fuel production;
  - `modules`: the fleets the capacity including orbital counts: assigned to the colony or to none (the first colony in the list takes it), within less than a unit on both axes whatever the system, not a civilian one, unknown when a count is not given;
  - `unknown`: a figure the save does not give is null with the result that names what it lacks, never 0, and does not hide or colour a row it cannot judge;
  - `rounding`: a figure is written as the game writes it, a half rounded away from zero, though a binary product lies a hair under it;
  - `component`: the cells, the dashes, the colours with their titles, the marks, the empty and the unread states;
  - `template`: the panel has its own data-summary, the foot opens with how to use it, nothing speaks to a person or names a release, and the template compiles;
  - `page`: the toggle, the view, the optional read and its retry, the saved order, the help and the capability registry carry the new view.
  What no check here can settle on the migrated fixture: the order of the rows of a save the 3.1 game itself wrote (the migrated save stores its populations in the order the game loaded them, which the capture's order equals), and a fleet with no assigned colony near two colonies (the fixture has none).

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { compiledTemplate, renderTree, treeOf } = require('./lib/vue-render')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { INTERIM } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
// The data of this check are the specimen S4 of the interim fixture, not the default: the owner's captures of the tab and the cases planted on the colonies of that save (Earth, Aurelia, Venus) are bound to it, so it names INTERIM and keeps reading that save when `FIXTURE` moves to a later one.
const SAVE = INTERIM.file
const GAME = INTERIM.gameId
const RACE = INTERIM.raceId
const NEAR = 1e-9
// DIM_ComponentType: Maintenance Module.
const MODULE_TYPE = 48

const FILES = {
  util: path.join(root, 'src', 'renderer', 'utilities', 'empire-logistics.js'),
  pools: path.join(root, 'src', 'renderer', 'utilities', 'maintenance-pools.js'),
  component: path.join(root, 'src', 'renderer', 'components', 'logistics', 'EmpireSummary.vue'),
  page: path.join(root, 'src', 'renderer', 'pages', 'logistics.vue'),
  glossary: path.join(root, 'src', 'renderer', 'utilities', 'glossary.js'),
  capabilities: path.join(root, 'src', 'renderer', 'utilities', 'capabilities.js'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const THEME_STUB = 'export const chartTheme = () => ({ categorical: [], ink: "", inkMuted: "", primary: "" }); export const withAlpha = (color) => color; export const patternImage = () => null; export const seriesIdentity = () => null'
const STORE = { getters: { config: { get: () => 'Tick' } }, state: {} }
const PAGE_STORE = { getters: { 'capabilities/blockedBonuses': new Set(), 'capabilities/report': () => null, config: { get: () => 'Tick' } }, state: { RaceNPR: false }, dispatch: async () => {} }
const READY = { loading: false, failed: '', error: '' }
const PRONOUNS = /\b(?:me|my|myself|we|our|ours|ourselves|you|your|yours|yourself)\b|\bI\b/

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- The modules as shipped, or with edits planted ---------------------------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => {
  const changed = (name) => texts[name] !== ORIGINALS[name]
  const utilitySources = { ...(changed('util') ? { 'utilities/empire-logistics': texts.util } : {}), ...(changed('pools') ? { 'utilities/maintenance-pools': texts.pools } : {}), ...(changed('glossary') ? { 'utilities/glossary': texts.glossary } : {}), ...(changed('capabilities') ? { 'utilities/capabilities': texts.capabilities } : {}) }
  const plainSources = { ...(changed('util') ? { 'empire-logistics': texts.util } : {}), ...(changed('pools') ? { 'maintenance-pools': texts.pools } : {}) }

  return {
    texts,
    modules: memo(() => loadUtilities(['empire-logistics', 'maintenance-pools', 'provenance'], { sources: plainSources })),
    glossary: memo(() => loadUtilities(['glossary'], { sources: changed('glossary') ? { glossary: texts.glossary } : {} })),
    capabilities: memo(() => loadUtilities(['capabilities'], { sources: changed('capabilities') ? { capabilities: texts.capabilities } : {} })),
    page: memo(() => loadPage('pages/logistics', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB, 'mixins/load-state': null }, sources: { 'pages/logistics': texts.page, ...utilitySources } })),
    component: memo(() => loadPage('components/logistics/EmpireSummary', { stubs: STUBS, sources: { 'components/logistics/EmpireSummary': texts.component, ...utilitySources } })),
  }
}

// ---- The fixture, as in-memory copies ----------------------------------------------------------------------------------
let BYTES = null
const bytes = () => BYTES || (BYTES = fs.readFileSync(path.join(root, SAVE)))
const OPEN = []
const copy = () => {
  const database = Database.deserialize(bytes())

  OPEN.push(database)

  return database
}
const closeAll = () => OPEN.splice(0).forEach((database) => database.close())
const loaderOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })
const rowsOf = (database, sql) => database.query(sql).all()

// ---- The captured tab (specimen S4) --------------------------------------------------------------------------------------
// [name, M-CAP, M-CIO, M-TONS, M-YEAR, M-MSP, M-PROD, F-MLT, F-PRDM, REF RES ORD, colours] as the tab writes them; colours: `po` the M-PROD amber, `pr` the M-PROD red, `fr` the F-PRDM red. The capture reads one name as "Voltum" for the colony the save names Volturn.
const dash = (name, marks = 'YYY', fuel = '-') => [name, '-', '-', '-', '-', '-', '-', fuel, '-', marks, '']
const outpost = (name) => [name, '-', '200,000', name === 'Outpost - 68 Andromedae' ? '146,749' : '49,749', name === 'Outpost - 68 Andromedae' ? '158,409' : '59,355', '-', '-', '-', '-', '-Y-', 'po']
const S4 = [
  ['Aurelia', '24,550,993', '24,550,993', '2,609,494', '2,315,204', '13,839,235', '2,982,946', '2,070.5m', '49.7m', 'YYY', ''],
  ['Cascadia', '2,500,000', '2,500,000', '124,749', '124,020', '2,923,557', '227,813', '766.9m', '19m', 'YYY', ''],
  ['Favonius', '1,000,000', '1,000,000', '124,999', '124,478', '616,127', '74,700', '209m', '15.6m', 'YYY', 'po'],
  ['Cygnus', '932,646', '932,646', '124,749', '124,020', '1,267,901', '92,920', '514m', '19.4m', 'YYY', 'po'],
  ['Earth', '200,000', '200,000', '125,249', '122,146', '491,861', '20,250', '33.8m', '4.2m', 'YYY', 'po fr'],
  ['Laythe', '200,000', '200,000', '2,749', '7,392', '512,125', '22,680', '22.2m', '4.7m', 'YYY', 'pr fr'],
  ['Auriga', '200,000', '200,000', '27,749', '24,966', '505,731', '19,440', '25.3m', '4.1m', 'YYY', 'pr fr'],
  ['Talos', '200,000', '200,000', '27,749', '24,966', '431,490', '20,250', '26.4m', '4.2m', 'YYY', 'po fr'],
  ['Sera', '200,000', '200,000', '27,749', '24,966', '281,430', '15,309', '27.3m', '3.2m', 'YYY', 'po fr'],
  ['Laika', '200,000', '200,000', '27,749', '24,966', '212,941', '16,038', '25.2m', '3.3m', 'YYY', 'po fr'],
  ['Taranis', '200,000', '200,000', '27,749', '24,966', '255,405', '16,974', '23.9m', '3.5m', 'YYY', 'po fr'],
  ['Zakuul', '200,000', '200,000', '27,749', '24,966', '209,715', '16,236', '47.2m', '3.4m', 'YYY', 'po fr'],
  ['Auroria', '200,000', '200,000', '27,749', '24,966', '145,477', '16,434', '22.1m', '3.4m', 'YYY', 'po fr'],
  ['Kharak', '200,000', '200,000', '27,749', '24,966', '42,663', '16,038', '9.7m', '3.3m', 'YYY', 'po'],
  ['Venus', '100,000', '100,000', '-', '-', '-', '8,100', '1m', '3.4m', 'YYY', 'pr fr'],
  dash('Shiokaze'),
  dash('Elysium'),
  dash('Aleria-A I', 'YYY', '1m'),
  dash('Aleria-B I - Moon 4', 'YYY', '1m'),
  dash('Mars'),
  dash('Terranova'),
  dash('Kaifeng I'),
  dash('Lyrenia'),
  dash('Kaifeng II'),
  dash('Aleria-B V - Moon 26'),
  dash('Albion-A II'),
  outpost('Outpost - 68 Andromedae'),
  dash('Canis Prime I'),
  dash('Volturn'),
  dash('QY Aurigae II', '--Y'),
  dash('Luytens Star I'),
  dash('Luytens Star II'),
  dash('Pallas-A I'),
  dash('Pallas-A II'),
  outpost('Outpost - Proxima Centauri'),
  dash('Mephistos-A I'),
  outpost('Outpost - EV Lacertae'),
  dash('Hera III'),
  outpost('Outpost - 9 Cassiopeiae'),
  outpost('Outpost - 67 Andromedae'),
  dash('Wormwood IV - Moon 24'),
  dash('Concordia II'),
  outpost('Outpost - Omicron Tucanae'),
  dash('V577 Monoceri-A II'),
  outpost('Outpost - GJ 3454'),
]

// ---- The page and the component on a database ----------------------------------------------------------------------------
const CORE = ['colonies', 'maintenanceShips', 'harvesters', 'burn', 'shipFuel', 'navalAdmins', 'populationProductionModifiers', 'formulaVersion']

// The page of the Logistics view mounted on `database` with the reads the summary rests on run, and its summary rows in `order`.
const pageOn = async (world, database, order = 'capacity') => {
  const options = await world.page()
  const vm = instantiate(options, { $store: PAGE_STORE, database: loaderOf(database), GameID: GAME, RaceID: RACE, data: { loadErrors: Object.fromEntries([...CORE, 'summarySources'].map((key) => [key, null])), summaryOrder: order } })

  for (const key of ['colonies', 'populationProductionModifiers', 'summarySources']) {
    await vm.runAsync(key)
  }

  return vm
}

const cellsOf = (tree) => treeOf(tree).filter((node) => node.tag === 'tr' && node.data.attrs && node.data.attrs['data-colony']).map((row) => ({
  id: Number(row.data.attrs['data-colony']),
  name: (treeOf(row).find((node) => node.data.attrs && 'data-summary-name' in node.data.attrs) || { children: [] }).children.filter((child) => typeof child === 'string').join(''),
  figures: Object.fromEntries(treeOf(row).filter((node) => node.data.attrs && node.data.attrs['data-figure']).map((node) => [node.data.attrs['data-figure'], { text: node.children.filter((child) => typeof child === 'string').join('').replace(/'/g, ',').replace(/—/g, '-'), color: node.data.class, title: node.data.attrs.title, marks: node.children.filter((child) => child && child.tag === 'provenance-mark').length }])),
  services: Object.fromEntries(treeOf(row).filter((node) => node.data.attrs && node.data.attrs['data-service']).map((node) => [node.data.attrs['data-service'], node.children.filter((child) => typeof child === 'string').join('').replace(/—/g, '-')])),
}))

const drawn = async (world, rows, order = 'capacity', state = READY) => {
  const options = await world.component()
  const vm = instantiate(options, { $store: STORE, data: { rows, state, order } })
  const out = renderTree(world.texts.component, vm)

  assert.deepEqual(out.errors, [], 'the template renders without a compile error')

  return { vm, ...out, rows: cellsOf(out.tree) }
}

const colourOf = (color) => (typeof color === 'string' && color.includes('warning--text') ? 'amber' : typeof color === 'string' && color.includes('error--text') ? 'red' : '')

// ---- What the figures need of the stored rows, by SQL and arithmetic written here, apart from the loaders' ------------
// Each colony of the race in the order the save stores them, with every figure of the tab worked out from the raw tables.
const oracle = (database, modifierOf, order = 'capacity') => {
  const race = rowsOf(database, `select MaintenanceCapacity, MSPProduction, FuelProduction, EconomicProdModifier from FCT_Race where RaceID = ${RACE}`)[0]
  const colonies = rowsOf(database, `select p.rowid as stored, p.PopulationID, p.PopName, p.SystemID, p.Efficiency, p.UnrestPoints, p.PoliticalStatus, p.MaintenanceStockpile, p.MaintProdStatus, p.FuelStockpile, p.FuelProdStatus, b.Xcor, b.Ycor, b.RadiationLevel from FCT_Population p left join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where p.GameID = ${GAME} and p.RaceID = ${RACE} order by p.rowid`)
  const political = Object.fromEntries(rowsOf(database, 'select StatusID, ProductionMod from DIM_PopPoliticalStatus').map((row) => [row.StatusID, row.ProductionMod]))
  const lines = rowsOf(database, `select i.PopID, i.Amount, d.MaintenanceValue, d.RefineryProductionValue, d.MassRefuelling, d.MassOrdnanceTransfer, d.CargoShuttleValue from FCT_PopulationInstallations i inner join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = i.PlanetaryInstallationID where i.GameID = ${GAME}`)
  const classes = Object.fromEntries(rowsOf(database, 'select ShipClassID, Size, Cost, Commercial, CommercialHangar from FCT_ShipClass').map((row) => [row.ShipClassID, row]))
  const fleets = Object.fromEntries(rowsOf(database, `select FleetID, RaceID, SystemID, Xcor, Ycor, AssignedPopulationID, CivilianFunction from FCT_Fleet where GameID = ${GAME}`).map((row) => [row.FleetID, row]))
  const ships = rowsOf(database, `select ShipID, FleetID, ShipClassID, MothershipID from FCT_Ship where GameID = ${GAME}`)
  const shipById = Object.fromEntries(ships.map((row) => [row.ShipID, row]))
  const yardOf = Object.fromEntries(rowsOf(database, 'select ShipyardID, PopulationID from FCT_Shipyard').map((row) => [row.ShipyardID, row.PopulationID]))
  const tasks = rowsOf(database, `select ShipID, ShipyardID from FCT_ShipyardTask where GameID = ${GAME} and ShipID > 0`)
  const moduleLines = rowsOf(database, `select cc.ClassID, cc.ComponentID, cc.NumComponent from FCT_ClassComponent cc inner join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where d.ComponentTypeID = ${MODULE_TYPE}`)
  const damage = rowsOf(database, `select ShipID, ComponentID, Number from FCT_DamagedComponent where GameID = ${GAME}`)
  const modulesOf = (ship) => moduleLines.filter((line) => line.ClassID === ship.ShipClassID).reduce((sum, line) => sum + Math.max(line.NumComponent - damage.filter((one) => one.ShipID === ship.ShipID && one.ComponentID === line.ComponentID).reduce((total, one) => total + one.Number, 0), 0), 0)
  const clamp = (value) => Math.max(0, Math.min(1, value))
  const claimed = {}
  const rows = colonies.map((colony) => {
    const own = lines.filter((line) => line.PopID === colony.PopulationID)
    const total = (key) => own.reduce((sum, line) => sum + line[key] * line.Amount, 0)
    const facilities = total('MaintenanceValue')
    const capacity = facilities * race.MaintenanceCapacity * colony.Efficiency * clamp(1 - (colony.RadiationLevel || 0) / 10000) * clamp(1 - colony.UnrestPoints / 100) * (political[colony.PoliticalStatus] === undefined || political[colony.PoliticalStatus] === null ? 1 : political[colony.PoliticalStatus]) * race.EconomicProdModifier
    // The fleets of the race with no civilian function within a unit of the body on both axes (in any system): a fleet with no colony goes to the first colony that meets it.
    let modules = 0

    for (const fleet of Object.values(fleets)) {
      if (fleet.RaceID !== RACE || fleet.CivilianFunction !== 0 || !(Math.abs(fleet.Xcor - colony.Xcor) < 1 && Math.abs(fleet.Ycor - colony.Ycor) < 1)) {
        continue
      }

      const holder = fleet.AssignedPopulationID > 0 ? fleet.AssignedPopulationID : claimed[fleet.FleetID] || (claimed[fleet.FleetID] = colony.PopulationID)

      if (holder === colony.PopulationID) {
        modules += ships.filter((ship) => ship.FleetID === fleet.FleetID).reduce((sum, ship) => sum + modulesOf(ship), 0)
      }
    }

    const present = ships.filter((ship) => {
      const fleet = fleets[ship.FleetID]
      const kind = classes[ship.ShipClassID]
      const carrier = ship.MothershipID > 0 && shipById[ship.MothershipID] ? classes[shipById[ship.MothershipID].ShipClassID] : null
      const inYard = tasks.some((task) => task.ShipID === ship.ShipID && yardOf[task.ShipyardID] === colony.PopulationID)

      return fleet && fleet.RaceID === RACE && fleet.SystemID === colony.SystemID && fleet.Xcor === colony.Xcor && fleet.Ycor === colony.Ycor && kind && !kind.Commercial && (!carrier || carrier.CommercialHangar) && !inYard
    })
    const modifier = modifierOf(colony.PopulationID)
    const refineries = Math.trunc(total('RefineryProductionValue'))
    const tons = present.reduce((sum, ship) => sum + classes[ship.ShipClassID].Size * 50, 0)
    const year = present.reduce((sum, ship) => sum + classes[ship.ShipClassID].Cost, 0) / 4
    const production = race.MSPProduction * modifier * Math.trunc(facilities) * 4
    const fuelProduction = race.FuelProduction * modifier * refineries
    const orbital = modules > 0 ? capacity + modules * race.MaintenanceCapacity * race.EconomicProdModifier : capacity

    return {
      id: colony.PopulationID,
      name: colony.PopName,
      capacity,
      orbital,
      tons,
      year,
      stock: colony.MaintenanceStockpile,
      production,
      fuel: colony.FuelStockpile,
      fuelProduction,
      refuel: Math.trunc(total('MassRefuelling')) > 0,
      resupply: Math.trunc(facilities) > 0 || modules > 0 || Math.trunc(total('CargoShuttleValue')) > 0,
      ordnance: Math.trunc(total('MassOrdnanceTransfer')) > 0,
      tonsAbove: tons > orbital,
      productionState: colony.MaintProdStatus ? (year > production ? 'short' : null) : production > 0 ? 'off' : null,
      fuelProductionOff: !colony.FuelProdStatus && fuelProduction > 0,
    }
  })
  const listed = rows.filter((row) => row.orbital !== 0 || row.tons !== 0 || row.production !== 0 || row.fuel !== 0 || row.fuelProduction !== 0 || row.refuel || row.resupply || row.ordnance || row.stock !== 0)

  // The listed colonies keep the order the save stores them; sorting is stable, and the game's decimal sums of the same ships are equal, so figures equal to the last digits of a binary sum are equal figures.
  return listed.map((row, index) => ({ row, index })).sort((a, b) => (Math.abs(b.row[order] - a.row[order]) <= NEAR * Math.max(1, Math.abs(a.row[order])) ? a.index - b.index : b.row[order] - a.row[order])).map(({ row }) => row)
}

const near = (actual, expected, message = '') => assert.ok(typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= NEAR * Math.max(1, Math.abs(expected)), `${message} ${actual} is not ${expected}`.trim())

const FIGURES = ['capacity', 'orbital', 'tons', 'year', 'stock', 'production', 'fuel', 'fuelProduction']

// A page row against the oracle's, every figure and mark.
const sameRow = (found, expected, label) => {
  assert.equal(found.PopulationID, expected.id, `${label}: the colony`)

  for (const key of FIGURES) {
    near(found[key], expected[key], `${label} ${expected.name} ${key}:`)
  }

  for (const key of ['refuel', 'resupply', 'ordnance', 'tonsAbove', 'fuelProductionOff']) {
    assert.equal(found[key], expected[key], `${label} ${expected.name} ${key}`)
  }

  assert.equal(found.productionState, expected.productionState, `${label} ${expected.name} the production colour`)
}

// ---- Checks ------------------------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, body) => CHECKS.push({ name, description, run: body })

check('s4', 'the page\'s own read and rows, drawn by the component, equal the captured tab for every colony: the name, the eight figures as written, their colours, the marks and the order', async (w) => {
  const database = copy()
  const vm = await pageOn(w, database)
  const out = await drawn(w, vm.summaryTable)
  const found = out.rows

  assert.equal(found.length, S4.length, `${found.length} colonies where the capture lists ${S4.length}`)

  S4.forEach(([name, capacity, orbital, tons, year, stock, production, fuel, fuelProduction, marks, colours], index) => {
    const row = found[index]
    const where = `row ${index + 1} ${name}`

    assert.equal(row.name, name, `${where}: the name`)
    assert.deepEqual(['capacity', 'orbital', 'tons', 'year', 'stock', 'production', 'fuel', 'fuelProduction'].map((key) => row.figures[key].text), [capacity, orbital, tons, year, stock, production, fuel, fuelProduction], `${where}: the figures`)
    assert.deepEqual(['refuel', 'resupply', 'ordnance'].map((key) => row.services[key]), [...marks].map((mark) => (mark === 'Y' ? 'Yes' : '-')), `${where}: the marks`)
    assert.deepEqual(['capacity', 'orbital', 'tons', 'year', 'stock'].map((key) => colourOf(row.figures[key].color)), ['', '', '', '', ''], `${where}: no colour on the capacity, the tonnage or the stock`)
    assert.equal(colourOf(row.figures.production.color), colours.includes('po') ? 'amber' : colours.includes('pr') ? 'red' : '', `${where}: the colour of M-PROD`)
    assert.equal(colourOf(row.figures.fuelProduction.color), colours.includes('fr') ? 'red' : '', `${where}: the colour of F-PRDM`)
    assert.equal(colourOf(row.figures.fuel.color), '', `${where}: no colour on the fuel stock`)
  })
})

const SYSTEM_OF = (database, populationId) => rowsOf(database, `select SystemID from FCT_Population where PopulationID = ${populationId}`)[0].SystemID

// The fleets with maintenance modules on the fixture: the outpost fleets, each assigned to its own outpost.
const moduleFleet = (database) => rowsOf(database, `select f.FleetID, f.AssignedPopulationID, f.Xcor, f.Ycor, f.SystemID, p.PopName from FCT_Fleet f inner join FCT_Population p on p.PopulationID = f.AssignedPopulationID where f.RaceID = ${RACE} and f.GameID = ${GAME} and f.FleetID in (select s.FleetID from FCT_Ship s inner join FCT_ClassComponent cc on cc.ClassID = s.ShipClassID inner join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where d.ComponentTypeID = ${MODULE_TYPE}) order by f.FleetID`)[0]

const damageModules = (database) => {
  const ship = rowsOf(database, `select s.ShipID, cc.ComponentID, cc.NumComponent from FCT_Ship s inner join FCT_Fleet f on f.FleetID = s.FleetID inner join FCT_ClassComponent cc on cc.ClassID = s.ShipClassID inner join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID where d.ComponentTypeID = ${MODULE_TYPE} and f.FleetID = ${moduleFleet(database).FleetID} order by s.ShipID limit 1`)[0]

  database.run(`insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) values (${ship.ShipID}, ${ship.ComponentID}, ${GAME}, ${ship.NumComponent})`)
}

// The first shipyard task of the save, and the colony its yard belongs to.
const firstTask = (database) => {
  const task = rowsOf(database, 'select TaskID, ShipyardID from FCT_ShipyardTask order by TaskID limit 1')[0]

  return { ...task, PopulationID: rowsOf(database, `select PopulationID from FCT_Shipyard where ShipyardID = ${task.ShipyardID}`)[0].PopulationID }
}

// A ship that counts at the yard's own colony is put in the task.
const taskShipOfOwnColony = (database) => {
  const task = firstTask(database)
  const ship = rowsOf(database, `select s.ShipID from FCT_Ship s inner join FCT_Fleet f on f.FleetID = s.FleetID inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID inner join FCT_Population p on p.PopulationID = ${task.PopulationID} inner join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where f.SystemID = p.SystemID and f.Xcor = b.Xcor and f.Ycor = b.Ycor and c.Commercial = 0 and s.MothershipID = 0 order by s.ShipID limit 1`)[0]

  database.run(`update FCT_ShipyardTask set ShipID = ${ship.ShipID} where TaskID = ${task.TaskID}`)
}

// A ship that counts at another colony of the race is put in the task.
const taskShipOfOtherColony = (database) => {
  const task = firstTask(database)
  const ship = rowsOf(database, `select s.ShipID from FCT_Ship s inner join FCT_Fleet f on f.FleetID = s.FleetID inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID inner join FCT_Population p on p.SystemID = f.SystemID and p.RaceID = ${RACE} and p.PopulationID <> ${task.PopulationID} inner join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where f.Xcor = b.Xcor and f.Ycor = b.Ycor and c.Commercial = 0 and s.MothershipID = 0 order by s.ShipID limit 1`)[0]

  database.run(`update FCT_ShipyardTask set ShipID = ${ship.ShipID} where TaskID = ${task.TaskID}`)
}

const moveHairOff = (database) => {
  const fleet = rowsOf(database, `select f.FleetID from FCT_Fleet f inner join FCT_Population p on p.SystemID = f.SystemID and p.RaceID = ${RACE} inner join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where f.RaceID = ${RACE} and f.Xcor = b.Xcor and f.Ycor = b.Ycor and p.PopName = 'Auriga' order by f.FleetID limit 1`)[0]

  database.run(`update FCT_Fleet set Xcor = Xcor + 0.001 where FleetID = ${fleet.FleetID}`)
}

const changeModifiers = (database) => {
  database.run(`update FCT_Race set EconomicProdModifier = 1.25 where RaceID = ${RACE}`)
  database.run(`update FCT_Population set Efficiency = 0.8, UnrestPoints = 10 where PopName = 'Earth' and RaceID = ${RACE}`)
  database.run(`update FCT_Population set MaintProdStatus = 0, FuelProdStatus = 1 where PopName = 'Aurelia' and RaceID = ${RACE}`)
  database.run(`update FCT_Population set MaintenanceStockpile = 0, FuelStockpile = 0 where PopName = 'Venus' and RaceID = ${RACE}`)
}

// The class that counts at Earth with the most ships is made commercial.
const makeCommercial = (database) => {
  const kind = rowsOf(database, `select s.ShipClassID from FCT_Ship s inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID inner join FCT_Fleet f on f.FleetID = s.FleetID inner join FCT_Population p on p.SystemID = f.SystemID inner join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID and b.Xcor = f.Xcor and b.Ycor = f.Ycor where p.PopName = 'Earth' and p.RaceID = ${RACE} and s.RaceID = ${RACE} and c.Commercial = 0 and s.MothershipID = 0 group by s.ShipClassID order by count(*) desc limit 1`)[0]

  database.run(`update FCT_ShipClass set Commercial = 1 where ShipClassID = ${kind.ShipClassID}`)
}

// The module fleet and its ships belong to another race of the save.
const foreignFleet = (database) => {
  const other = rowsOf(database, `select RaceID from FCT_Race where GameID = ${GAME} and RaceID <> ${RACE} order by RaceID limit 1`)[0].RaceID
  const fleet = moduleFleet(database).FleetID

  database.run(`update FCT_Fleet set RaceID = ${other} where FleetID = ${fleet}`)
  database.run(`update FCT_Ship set RaceID = ${other} where FleetID = ${fleet}`)
}

// A maintenance facility of Earth and an automated replenishment facility of Venus (maintenance and refining both) are a half more, so the whole of the sums is not the sum.
const halfInstallations = (database) => {
  const colonyOf = (name) => `(select PopulationID from FCT_Population where PopName = '${name}' and RaceID = ${RACE})`

  database.run(`update FCT_PopulationInstallations set Amount = 1.5 where PlanetaryInstallationID = 21 and PopID = ${colonyOf('Earth')}`)
  database.run(`update FCT_PopulationInstallations set Amount = 1.5 where PlanetaryInstallationID = 63 and PopID = ${colonyOf('Venus')}`)
}

const fleetSet = (assignment) => (database) => database.run(`update FCT_Fleet set ${assignment} where FleetID = ${moduleFleet(database).FleetID}`)

// The copies of the fixture the planted cases need, each with what it changes; `same` marks a case whose every figure stays as saved.
const PLANTS = [
  { name: 'as saved', change: () => {} },
  { name: 'a fleet of modules assigned to no colony', same: true, change: fleetSet('AssignedPopulationID = 0') },
  { name: 'a fleet of modules assigned to another colony', change: fleetSet('AssignedPopulationID = 48977') },
  { name: 'a fleet of modules half a unit from its colony', change: fleetSet('Xcor = Xcor + 0.5, Ycor = Ycor - 0.5') },
  { name: 'a fleet of modules two units from its colony', change: fleetSet('Xcor = Xcor + 2') },
  { name: 'a fleet of modules in another system at the same place', change: (database) => fleetSet(`SystemID = ${SYSTEM_OF(database, 48977)}`)(database) },
  { name: 'a fleet of modules with a civilian function', change: fleetSet('CivilianFunction = 1') },
  { name: 'the modules of a ship damaged', change: damageModules },
  { name: 'a commercial class at a colony', change: makeCommercial },
  { name: 'ships carried by a ship whose class has a commercial hangar', change: (database) => database.run('update FCT_ShipClass set CommercialHangar = 1') },
  { name: 'a ship in a shipyard task of its colony', change: taskShipOfOwnColony },
  { name: 'a ship in a shipyard task of another colony', same: true, change: taskShipOfOtherColony },
  { name: 'a fleet a hair off the body of its colony', change: moveHairOff },
  { name: 'a colony with its facilities and its modifiers changed', change: changeModifiers },
  { name: 'a fleet of modules and its ships of another race', change: foreignFleet },
  { name: 'half an installation of maintenance and of refining', change: halfInstallations },
]

check('oracle', 'the rows equal the oracle\'s, worked from the stored tables apart from the loaders, for the fixture as saved and for copies with a fleet of modules assigned to no colony, to another, moved, in another system, civilian, of another race or damaged, a class made commercial, carriers with and without a commercial hangar, a ship in a shipyard task of its colony and of another, a fleet a hair off the body, installations in halves and changed facilities and modifiers', async (w) => {
  let moved = 0

  for (const plant of PLANTS) {
    const database = copy()

    plant.change(database)

    const vm = await pageOn(w, database)
    const modifiers = vm.populationProductionModifiers
    const modifierOf = (id) => (modifiers[id] ? modifiers[id].OverallProductionModifier : null)

    for (const order of ['capacity', 'orbital', 'tons', 'year', 'stock', 'production', 'fuel', 'fuelProduction']) {
      vm.summaryOrder = order

      const found = vm.summaryTable
      const expected = oracle(database, modifierOf, order)

      assert.equal(found.length, expected.length, `${plant.name}, by ${order}: ${found.length} colonies where the oracle lists ${expected.length}`)
      expected.forEach((row, index) => sameRow(found[index], row, `${plant.name}, by ${order}, row ${index + 1}`))
    }

    // The planted case must change what the oracle says, or it tests nothing; a fleet assigned to no colony is taken by the colony it is at, so it changes nothing, and that is the case.
    if (plant.name !== 'as saved') {
      const base = oracle(copy(), modifierOf)
      const planted = oracle(database, modifierOf)

      if (plant.same) {
        assert.deepEqual(base, planted, `${plant.name}: the oracle's rows change`)
      } else {
        moved += JSON.stringify(base) === JSON.stringify(planted) ? 0 : 1
        assert.notDeepEqual(base, planted, `${plant.name}: the oracle's rows do not change`)
      }
    }
  }

  assert.equal(moved, PLANTS.filter((plant) => plant.name !== 'as saved' && !plant.same).length, 'every planted case moves a figure')
})

// ---- Given rows ------------------------------------------------------------------------------------------------------------
const colony = (extra = {}) => ({ PopulationID: 1, PopName: 'A', SystemID: 1, Xcor: 5, Ycor: 5, MaintenanceFacilities: 2, Refineries: 1, MaintenanceCapacity: 1000, Efficiency: 1, CapacityModifier: 1, EconomicProdModifier: 1, MSPProduction: 100, FuelProduction: 1000000, MaintenanceStockpile: 0, MaintProdStatus: 1, FuelStockpile: 0, FuelProdStatus: 1, ...extra })
const idle = (id, extra = {}) => colony({ PopulationID: id, PopName: `C${id}`, MaintenanceFacilities: 0, Refineries: 0, ...extra })
const sources = (extra = {}) => ({ tonnage: [], modules: [], services: [], listing: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], ...extra })
const MODIFIER = () => 1.5
const rowsOfGiven = (m, colonies, over = {}, modifierOf = MODIFIER, order = 'capacity') => m['empire-logistics'].summaryRows({ colonies, sources: sources(over), modifierOf, order })
const fleetShip = (id, fleet, modules, extra = {}) => ({ FleetID: fleet, ShipID: id, Xcor: 5, Ycor: 5, AssignedPopulationID: 0, Modules: modules, ...extra })

check('formula', 'the figures of a colony are the game\'s products: the capacity is the facilities times the racial capacity, the efficiency, the radiation, unrest and political modifier and the economic modifier, the modules add the racial capacity and the economic modifier alone, production is the racial rate times the modifier times the whole facilities times four, the fuel production the racial rate times the modifier times the whole refineries, the tonnage is 50 tons a hull space and the supplies a year a quarter of the cost, the marks come from the whole sums', async (w) => {
  const m = await w.modules()
  const [row] = rowsOfGiven(m, [colony({ MaintenanceFacilities: 2.9, Refineries: 1.9, Efficiency: 0.5, CapacityModifier: 0.8, EconomicProdModifier: 1.25 })], { tonnage: [{ PopulationID: 1, Ships: 2, Size: 30, Cost: 400, Unknown: 0 }], modules: [fleetShip(1, 9, 3)] })

  near(row.capacity, 2.9 * 1000 * 0.5 * 0.8 * 1.25, 'the capacity')
  near(row.orbital, 2.9 * 1000 * 0.5 * 0.8 * 1.25 + 3 * 1000 * 1.25, 'the capacity including orbital')
  near(row.tons, 30 * 50, 'the tonnage')
  near(row.year, 100, 'the supplies a year')
  near(row.production, 100 * 1.5 * 2 * 4, 'the production')
  near(row.fuelProduction, 1000000 * 1.5 * 1, 'the fuel production')

  const marks = rowsOfGiven(m, [colony({ MaintenanceFacilities: 0.9, Refineries: 0 })], { services: [{ PopulationID: 1, RefuelPoints: 0.9, OrdnancePoints: 0.9, ShuttlePoints: 0.9 }] })

  assert.deepEqual(marks.map((one) => [one.refuel, one.resupply, one.ordnance]), [[false, false, false]], 'a fraction of a point is no point')

  for (const [name, services, expected] of [['a refuelling point', { RefuelPoints: 1, OrdnancePoints: 0, ShuttlePoints: 0 }, [true, false, false]], ['an ordnance transfer point', { RefuelPoints: 0, OrdnancePoints: 2, ShuttlePoints: 0 }, [false, false, true]], ['a cargo shuttle point', { RefuelPoints: 0, OrdnancePoints: 0, ShuttlePoints: 1 }, [false, true, false]]]) {
    const listed = rowsOfGiven(m, [idle(1)], { services: [{ PopulationID: 1, ...services }] })

    assert.equal(listed.length, 1, `${name}: the colony is listed`)
    assert.deepEqual([listed[0].refuel, listed[0].resupply, listed[0].ordnance], expected, name)
  }

  const [facility] = rowsOfGiven(m, [idle(1, { MaintenanceFacilities: 1 })])

  assert.deepEqual([facility.refuel, facility.resupply, facility.ordnance], [false, true, false], 'a maintenance facility is a resupply point')

  const [module] = rowsOfGiven(m, [idle(1)], { modules: [fleetShip(1, 9, 1)] })

  assert.deepEqual([module.refuel, module.resupply, module.ordnance], [false, true, false], 'a ship with a module near the colony is a resupply point')
  near(module.orbital, 1000, 'the module alone is the orbital capacity')
  near(module.capacity, 0, 'and no capacity')
})

check('show', 'a colony is listed when its capacity including orbital, tonnage, production, stock, fuel stock, fuel production or any mark is not nothing, and not otherwise', async (w) => {
  const m = await w.modules()
  const shown = (extra, over = {}) => rowsOfGiven(m, [idle(1, extra)], over).length

  assert.equal(shown({}), 0, 'a colony with nothing')
  assert.equal(shown({ MaintenanceFacilities: 1 }), 1, 'capacity')
  assert.equal(shown({ MaintenanceStockpile: 5 }), 1, 'a stock of supplies')
  assert.equal(shown({ FuelStockpile: 5 }), 1, 'a stock of fuel')
  assert.equal(shown({ Refineries: 1 }), 1, 'fuel production')
  assert.equal(shown({}, { tonnage: [{ PopulationID: 1, Ships: 1, Size: 1, Cost: 0, Unknown: 0 }] }), 1, 'tonnage')
  assert.equal(shown({}, { modules: [fleetShip(1, 9, 1)] }), 1, 'the capacity including orbital')
  assert.equal(shown({}, { services: [{ PopulationID: 1, RefuelPoints: 1, OrdnancePoints: 0, ShuttlePoints: 0 }] }), 1, 'a refuelling point')
  assert.equal(shown({}, { services: [{ PopulationID: 1, RefuelPoints: 0, OrdnancePoints: 1, ShuttlePoints: 0 }] }), 1, 'an ordnance transfer point')
  assert.equal(shown({}, { services: [{ PopulationID: 1, RefuelPoints: 0, OrdnancePoints: 0, ShuttlePoints: 1 }] }), 1, 'a cargo shuttle point')
  assert.equal(shown({ MaintenanceFacilities: 0.5, Efficiency: 0 }), 0, 'less than a whole facility is no resupply point and no production, and with no efficiency it has no capacity')
  assert.equal(shown({ MaintenanceCapacity: null }), 1, 'a capacity not known keeps the colony listed')
  assert.equal(shown({ MSPProduction: null }), 1, 'a production not known keeps the colony listed')
})

check('order', 'each of the eight columns orders the listed colonies from the largest down, equal figures keep the order of the list, and the page orders by the chosen column', async (w) => {
  const m = await w.modules()
  const colonies = [
    colony({ PopulationID: 1, MaintenanceFacilities: 1, MaintenanceStockpile: 30, FuelStockpile: 10, MaintProdStatus: 1, Refineries: 1 }),
    colony({ PopulationID: 2, MaintenanceFacilities: 3, MaintenanceStockpile: 10, FuelStockpile: 30, Refineries: 3 }),
    colony({ PopulationID: 3, MaintenanceFacilities: 2, MaintenanceStockpile: 20, FuelStockpile: 20, Refineries: 2 }),
    colony({ PopulationID: 4, MaintenanceFacilities: 3, MaintenanceStockpile: 10, FuelStockpile: 30, Refineries: 3 }),
  ]
  const tonnage = [{ PopulationID: 1, Ships: 1, Size: 1, Cost: 300, Unknown: 0 }, { PopulationID: 2, Ships: 1, Size: 3, Cost: 100, Unknown: 0 }, { PopulationID: 3, Ships: 1, Size: 2, Cost: 200, Unknown: 0 }, { PopulationID: 4, Ships: 1, Size: 3, Cost: 100, Unknown: 0 }]
  const modules = [fleetShip(1, 9, 5, { Xcor: 5, Ycor: 5 })]
  const orderOf = (order, listing) => rowsOfGiven(m, colonies, { tonnage, modules, listing }, MODIFIER, order).map((row) => row.PopulationID)

  // Colony 1 holds the modules, so its capacity including orbital is the largest.
  assert.deepEqual(orderOf('capacity', [1, 2, 3, 4]), [2, 4, 3, 1], 'M-CAP, equal figures in the order of the list')
  assert.deepEqual(orderOf('capacity', [4, 3, 2, 1]), [4, 2, 3, 1], 'M-CAP, the other list order')
  assert.deepEqual(orderOf('orbital', [1, 2, 3, 4]), [1, 2, 4, 3], 'M-CIO')
  assert.deepEqual(orderOf('tons', [1, 2, 3, 4]), [2, 4, 3, 1], 'M-TONS')
  assert.deepEqual(orderOf('year', [1, 2, 3, 4]), [1, 3, 2, 4], 'M-YEAR')
  assert.deepEqual(orderOf('stock', [1, 2, 3, 4]), [1, 3, 2, 4], 'M-MSP')
  assert.deepEqual(orderOf('production', [1, 2, 3, 4]), [2, 4, 3, 1], 'M-PROD')
  assert.deepEqual(orderOf('fuel', [1, 2, 3, 4]), [2, 4, 3, 1], 'F-MLT')
  assert.deepEqual(orderOf('fuelProduction', [1, 2, 3, 4]), [2, 4, 3, 1], 'F-PRDM')
  assert.deepEqual(orderOf('capacity', [4, 3, 2]), [4, 2, 3, 1], 'a colony the listing does not name comes after the named ones')
  assert.deepEqual(rowsOfGiven(m, [...colonies, colony({ PopulationID: 5, MaintenanceFacilities: 4, Efficiency: null })], { tonnage, modules, listing: [5, 1, 2, 3, 4] }, MODIFIER, 'capacity').map((row) => row.PopulationID), [2, 4, 3, 1, 5], 'a figure not known orders after every figure known, though its colony is first in the list')

  const database = copy()
  const byProduction = (await pageOn(w, database, 'production')).summaryTable
  const byStock = (await pageOn(w, database, 'stock')).summaryTable

  assert.ok(byProduction.length > 20 && byStock.length === byProduction.length, 'the page lists the colonies')
  assert.ok(byProduction.every((row, index) => index === 0 || byProduction[index - 1].production >= row.production), 'the page orders by production')
  assert.ok(byStock.every((row, index) => index === 0 || byStock[index - 1].stock >= row.stock), 'and by stock')
  assert.notDeepEqual(byProduction.map((row) => row.PopulationID), byStock.map((row) => row.PopulationID), 'the two orders differ')
})

check('colours', 'the tonnage is amber above the capacity including orbital, M-PROD is amber when production is on and below the supplies a year (a production of nothing too) and red when it is off though the colony could make some, F-PRDM is red when fuel production is off though it could make some', async (w) => {
  const m = await w.modules()
  const row = (extra, over = {}) => rowsOfGiven(m, [colony(extra)], over)[0]
  const held = (size, cost) => ({ tonnage: [{ PopulationID: 1, Ships: 1, Size: size, Cost: cost, Unknown: 0 }] })

  // Capacity 2 x 1000 = 2,000 t; production 100 x 1.5 x 2 x 4 = 1,200.
  assert.equal(row({}, held(41, 0)).tonsAbove, true, 'a tonnage above the capacity')
  assert.equal(row({}, held(40, 0)).tonsAbove, false, 'a tonnage equal to the capacity')
  assert.equal(row({}, { ...held(41, 0), modules: [fleetShip(1, 9, 1)] }).tonsAbove, false, 'a tonnage within the capacity including orbital')
  assert.equal(row({}, held(1, 4804)).productionState, 'short', 'production on and below the supplies a year')
  assert.equal(row({}, held(1, 4800)).productionState, null, 'production on and equal to the supplies a year')
  assert.equal(row({}, held(1, 4000)).productionState, null, 'production on above the supplies a year')
  assert.equal(row({ MaintenanceFacilities: 0, Refineries: 1 }, held(1, 4)).productionState, 'short', 'production on and nothing at all')
  assert.equal(row({ MaintProdStatus: 0 }, held(1, 4800)).productionState, 'off', 'production off though the colony could make some')
  assert.equal(row({ MaintProdStatus: 0, MaintenanceFacilities: 0, Refineries: 1 }, held(1, 4800)).productionState, null, 'production off and none to make')
  assert.equal(row({ MaintProdStatus: 0 }, held(1, 0)).productionState, 'off', 'production off with no ships to supply')
  assert.equal(row({ FuelProdStatus: 0 }).fuelProductionOff, true, 'fuel production off with refineries')
  assert.equal(row({ FuelProdStatus: 0, Refineries: 0, MaintenanceFacilities: 1 }).fuelProductionOff, false, 'fuel production off with no refineries')
  assert.equal(row({ FuelProdStatus: 1 }).fuelProductionOff, false, 'fuel production on')
  assert.equal(row({ FuelProduction: 0, FuelProdStatus: 0 }).fuelProductionOff, false, 'fuel production off and a rate of nothing')
})

check('modules', 'the capacity including orbital counts the undamaged modules of the fleets within less than a unit of the colony on both axes, in whatever system, assigned to the colony or to none (the first colony of the list takes such a fleet), and a count the save does not give leaves it unknown', async (w) => {
  const m = await w.modules()
  const two = [colony({ PopulationID: 1, MaintenanceFacilities: 0, Xcor: 5, Ycor: 5 }), colony({ PopulationID: 2, MaintenanceFacilities: 0, Xcor: 5.5, Ycor: 5, SystemID: 2 })]
  const orbital = (colonies, modules, listing = [1, 2]) => Object.fromEntries(rowsOfGiven(m, colonies, { modules, listing }).map((row) => [row.PopulationID, row.orbital]))

  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2, { AssignedPopulationID: 1 })]), { 1: 2000, 2: 0 }, 'assigned to the first')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2, { AssignedPopulationID: 2 })]), { 1: 0, 2: 2000 }, 'assigned to the second, though the first is as near')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2)]), { 1: 2000, 2: 0 }, 'assigned to none: the first of the list takes it')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2)], [2, 1]), { 1: 0, 2: 2000 }, 'assigned to none: the first of the other list takes it')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2), fleetShip(2, 9, 3)]), { 1: 5000, 2: 0 }, 'the ships of one fleet add up')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2, { AssignedPopulationID: 7 })]), { 1: 0, 2: 0 }, 'assigned to a colony that is not in the list')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2, { Xcor: 5.999 })]), { 1: 2000, 2: 0 }, 'a hair under a unit on one axis')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2, { Xcor: 6 })]), { 1: 0, 2: 2000 }, 'a unit from the first and within a unit of the second: the second takes it')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2, { Xcor: 6.5 })]), { 1: 0, 2: 0 }, 'a unit away from both is outside')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2, { Ycor: 6 })]), { 1: 0, 2: 0 }, 'a unit away on the other axis is outside')
  assert.deepEqual(orbital(two, [fleetShip(1, 9, 2, { Xcor: 4.5, Ycor: 5.9 })]), { 1: 2000, 2: 0 }, 'within a unit of the first on both axes')
  assert.deepEqual(orbital([...two.slice(0, 1), colony({ PopulationID: 2, MaintenanceFacilities: 0, Xcor: 5, Ycor: 5, SystemID: 9 })], [fleetShip(1, 9, 2, { AssignedPopulationID: 2 })]), { 1: 0, 2: 2000 }, 'a colony in another system at the same place has the fleet assigned to it')

  const unknown = rowsOfGiven(m, two, { modules: [fleetShip(1, 9, null)] })

  assert.deepEqual(unknown.map((row) => [row.PopulationID, row.orbital]), [[1, null], [2, 0]], 'a module count the save does not give: unknown, never 0')
  assert.ok(unknown[0].missing.orbital, 'the result that names it')
  assert.equal(unknown[1].missing.orbital, undefined, 'a colony the fleet is not at has its own figure')
})

check('unknown', 'a figure the save does not give is null with the result that names what is missing, never 0, and a row that cannot be judged stays listed with no colour', async (w) => {
  const m = await w.modules()
  const [row] = rowsOfGiven(m, [colony({ Efficiency: null, MaintenanceStockpile: null, FuelStockpile: null })], { tonnage: [{ PopulationID: 1, Ships: 2, Size: 30, Cost: 400, Unknown: 1 }] })

  for (const key of ['capacity', 'orbital', 'tons', 'year', 'stock', 'fuel']) {
    assert.equal(row[key], null, `${key} is null`)
    assert.ok(row.missing[key], `${key} has a result`)
    assert.equal(row.missing[key].status, 'unavailable', `${key} has a result that names what is missing`)
    assert.ok(row.missing[key].inputs.missing.length > 0, `${key} names what`)
  }

  assert.equal(row.tonsAbove, false, 'a tonnage not known is not amber')
  assert.equal(row.productionState, null, 'the production is known and the supplies a year are not: neither amber nor red')
  assert.equal(row.production, 1200, 'the production does not rest on them')

  const [none] = rowsOfGiven(m, [colony()], {}, () => null)

  assert.equal(none.production, null, 'no modifier, no production')
  assert.equal(none.fuelProduction, null, 'no modifier, no fuel production')
  assert.equal(none.productionState, null, 'and no colour')
  assert.equal(none.fuelProductionOff, false, 'and no red')
  assert.ok(none.missing.production && none.missing.fuelProduction, 'the results that name it')

  const [unset] = rowsOfGiven(m, [colony({ MaintProdStatus: null, FuelProdStatus: null })], { tonnage: [{ PopulationID: 1, Ships: 1, Size: 1, Cost: 4800, Unknown: 0 }] })

  assert.equal(unset.productionState, null, 'a switch the save does not give is neither on nor off')
  assert.equal(unset.fuelProductionOff, false, 'and so for the fuel')
})

check('rounding', 'a figure is written as the game writes it: the whole figure with a half rounded away from zero, the fuel in millions to one place, though a binary product lies a hair under the half', async (w) => {
  const { 'empire-logistics': m } = await w.modules()

  assert.equal(m.roundedFigure(4.049999999999999, 1), 4.1, 'a binary product under a half')
  assert.equal(Math.round(4.049999999999999 * 10), 40, 'the product is under the half')
  assert.equal(m.roundedFigure(0.5, 0), 1, 'a half')
  assert.equal(m.roundedFigure(2.5, 0), 3, 'a half is not rounded to even')
  assert.equal(m.roundedFigure(1.4999, 0), 1, 'under a half')
  assert.equal(m.roundedFigure(-2.5, 0), -3, 'a negative half away from zero')
  assert.equal(m.roundedFigure(19, 1), 19, 'a whole figure')
  assert.equal(m.roundedFigure(2070.4499, 1), 2070.4, 'a hair under a half place')
  assert.equal(m.roundedFigure(24550993.369233325, 0), 24550993, 'a large figure')
  assert.equal(m.FUEL_UNIT, 1000000, 'fuel counts in millions')
})

check('component', 'the cells: a dash for nothing and for a figure not known (marked), the whole figure otherwise, the fuel in millions to one place with an m, the colours with their titles, the marks Yes or a dash, and the empty and unread panels', async (w) => {
  const m = await w.modules()
  const rows = rowsOfGiven(m, [colony({ PopulationID: 1, PopName: 'Alpha', MaintenanceStockpile: 1234.5, FuelStockpile: 2070499999 }), idle(2, { PopName: 'Beta', Efficiency: null, MaintenanceStockpile: 7 })], { tonnage: [{ PopulationID: 1, Ships: 1, Size: 41, Cost: 4804, Unknown: 0 }, { PopulationID: 2, Ships: 1, Size: 1, Cost: 1, Unknown: 0 }], services: [{ PopulationID: 1, RefuelPoints: 1, OrdnancePoints: 0, ShuttlePoints: 0 }] }).map((row) => ({ ...row, name: row.colony.PopName, place: 'Sol' }))
  const out = await drawn(w, rows)
  const [alpha, beta] = out.rows

  assert.deepEqual([alpha.name, beta.name], ['Alpha', 'Beta'], 'a row for each colony')
  assert.equal(alpha.figures.capacity.text, '2,000', 'the capacity')
  assert.equal(alpha.figures.stock.text, '1,235', 'the stock, rounded')
  assert.equal(alpha.figures.fuel.text, '2,070.5m', 'the fuel in millions, a half place away from zero')
  assert.equal(alpha.figures.tons.text, '2,050', 'the tonnage')
  assert.equal(colourOf(alpha.figures.tons.color), 'amber', 'the tonnage above the capacity is amber')
  assert.ok(alpha.figures.tons.title.includes('above'), 'with a title that says why')
  assert.equal(colourOf(alpha.figures.production.color), 'amber', 'production short is amber')
  assert.ok(alpha.figures.production.title.includes('below'), 'with a title')
  assert.deepEqual([alpha.services.refuel, alpha.services.resupply, alpha.services.ordnance], ['Yes', 'Yes', '-'], 'the marks')
  assert.equal(beta.figures.capacity.text, '-', 'a figure not known is a dash')
  assert.equal(beta.figures.capacity.marks, 1, 'with a mark')
  assert.equal(alpha.figures.capacity.marks, 0, 'a known figure has none')
  assert.equal(beta.figures.fuelProduction.text, '-', 'fuel production of nothing is a dash')
  assert.equal(colourOf(beta.figures.fuelProduction.color), '', 'with no colour')
  assert.equal(out.vm.figureText({ stock: 0 }, 'stock'), '—', 'a figure of nothing')
  assert.equal(out.vm.figureText({ stock: -3 }, 'stock'), '—', 'a figure below nothing')
  assert.equal(out.vm.figureText({ stock: null }, 'stock'), '—', 'a figure not known')

  const written = (value, key) => out.vm.figureText({ [key]: value }, key).replace(/'/g, ',')

  assert.equal(written(1234.4999999999998, 'stock'), '1,235', 'a half a binary hair under is rounded up')
  assert.equal(written(4049999.999999999, 'fuel'), '4.1m', 'a half place of fuel a binary hair under is rounded up')

  const [lacking] = rowsOfGiven(m, [idle(3, { PopName: 'Gamma', Refineries: 1, FuelProdStatus: 0 })]).map((row) => ({ ...row, name: row.colony.PopName, place: 'Sol' }))
  const [gamma] = (await drawn(w, [lacking])).rows

  assert.equal(colourOf(gamma.figures.fuelProduction.color), 'red', 'fuel production that is off is red')
  assert.ok(gamma.figures.fuelProduction.title.includes('switched off'), 'with a title')
  assert.equal(treeOf(out.tree).filter((node) => node.data.attrs && node.data.attrs['data-column']).map((node) => node.data.attrs['data-column']).join(' '), 'capacity orbital tons year stock production fuel fuelProduction refuel resupply ordnance', 'a column for each figure and mark, in the tab\'s order')
  assert.deepEqual(out.vm.orders.map((order) => order.key), ['capacity', 'orbital', 'tons', 'year', 'stock', 'production', 'fuel', 'fuelProduction'], 'the order choices')
  assert.ok(out.vm.orders.every((order) => /^[A-Z]-[A-Z]+ /.test(order.text)), 'each named with the tab\'s abbreviation')

  const empty = await drawn(w, [])

  assert.ok(treeOf(empty.tree).some((node) => node.data.attrs && 'data-summary-empty' in node.data.attrs), 'an empty list says so')

  for (const [name, data] of [['loading', { rows: null, state: { loading: true, failed: '', error: '' } }], ['failed', { rows: null, state: { loading: false, failed: 'the ships', error: 'boom' } }], ['not in', { rows: null, state: READY }]]) {
    const options = await w.component()
    const vm = instantiate(options, { $store: STORE, data: { order: 'capacity', ...data } })
    const shown = renderTree(w.texts.component, vm)

    assert.ok(treeOf(shown.tree).some((node) => node.data.attrs && 'data-summary-state' in node.data.attrs), `${name}: the state is shown`)
    assert.ok(!treeOf(shown.tree).some((node) => node.tag === 'v-simple-table'), `${name}: and no table`)
  }
})

check('template', 'the panel is a top-level .panel with a data-summary of one short sentence with no digit and no first or second person, its foot opens with how to use it and sets the figures apart from the Maintenance table\'s, nothing names a release, and the template compiles', async (w) => {
  const text = w.texts.component
  const { errors } = compiledTemplate(text)
  const tag = (text.match(/<v-card\b[^>]*>/) || [''])[0]
  const summary = (tag.match(/data-summary="([^"]*)"/) || [])[1] || ''
  const foot = ((text.match(/<div class="panel-foot[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '').trim()
  const visible = text.slice(0, text.indexOf('<script>')).replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]*>/g, ' ')

  assert.deepEqual(errors, [], 'the template compiles')
  assert.ok(/class="panel[ "]/.test(tag), 'a top-level panel')
  assert.ok(/[A-Za-z]/.test(summary) && summary.length >= 20 && summary.length < 200, `a summary: ${summary}`)
  assert.ok(!/\d/.test(summary) && !PRONOUNS.test(summary), `no digit and no person in ${summary}`)
  assert.equal((summary.match(/[.!?](\s|$)/g) || []).length, 1, 'one sentence')
  assert.ok(foot.startsWith('Use it to'), `the foot opens with how to use it: ${foot.slice(0, 40)}`)
  assert.ok(!foot.includes('\n'), 'one paragraph on one line')
  assert.ok(!PRONOUNS.test(visible), 'the template speaks to no person')
  assert.ok(!/\b[23]\.\d\b|\b(?:release|version)\s+\d/i.test(visible), 'the template names no release')
  assert.ok(/The Maintenance table's capacity leaves the economic modifier out, so the two differ only where it is not 1\./.test(foot) && /exactly at the colony/.test(foot) && /Amber/.test(foot) && /Red/.test(foot), 'the foot sets the figures apart from the Maintenance table\'s and explains the colours')
  assert.ok(/The Fuel table and the Maintenance table count a part of a refinery or a facility as that part of its output, and the Maintenance table stops at what the minerals in stock allow, so their production can differ from the production here\./.test(foot), 'the foot says how the production of the Fuel and Maintenance tables differs')
  assert.ok(/a resupply point \(maintenance facility, cargo shuttle station, spaceport or starport, or a ship with maintenance modules near it\)/.test(foot) && !/shuttle bay/.test(foot), 'the foot names the resupply points as the game counts them: no cargo shuttle bay of a ship')
  assert.ok(/<provenance-mark rule="logistics\.empireSummary" label \/>/.test(text), 'the head carries the rule\'s mark')
})

check('rule', 'the summary rule is registered for the 3.2 line alone, confirmed, and names what it reads', async (w) => {
  const { provenance } = await w.modules()
  const rule = provenance.getRule('logistics.empireSummary')

  assert.ok(rule, 'the rule is registered')
  assert.deepEqual(rule.versions, ['3.2.x'], 'for the 3.2 line')
  assert.equal(provenance.ruleSupports('logistics.empireSummary', '3.2.x'), true, 'it holds there')
  assert.equal(provenance.ruleSupports('logistics.empireSummary', '3.0.x'), false, 'and not on another line')
  assert.equal(rule.verification, 'confirmed', 'confirmed against the capture')
  assert.ok(rule.structure.length >= 6 && rule.assumptions.length >= 2, 'it names its reads and its assumptions')
  assert.ok(rule.structure.some((line) => line.includes('MassOrdnanceTransfer')) && rule.structure.some((line) => line.includes('CivilianFunction')), 'including the columns the page did not read before')
})

check('page', 'the page has the Empire summary view in its toggle, view names, saved order and help, reads the summary apart from the core reads with its own state and retry, and hands the component the rows in the chosen order', async (w) => {
  const text = w.texts.page
  const { glossary } = await w.glossary()
  const { capabilities } = await w.capabilities()
  const help = glossary.PAGE_HELP['/logistics']
  const options = await w.page()
  const vm = instantiate(options, { $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data: { loadErrors: Object.fromEntries(CORE.map((key) => [key, null])) } })

  assert.ok(/<v-btn value="summary" small>[^<]*<v-icon[^>]*>[^<]*<\/v-icon>Empire summary<\/v-btn>/.test(text), 'a toggle button')
  assert.ok(/summary: 'Empire summary'/.test(text), 'a view name')
  assert.ok(/<template v-else-if="view === 'summary'">\s*<empire-summary [^>]*:rows="summaryTable" :state="summaryState" :order="summaryOrder" @order="summaryOrder = \$event" @retry="retrySummary" \/>/.test(text), 'the view hands the component its rows, state, order and retry')
  assert.ok(/summaryOrder: \{ key: 'logisticsSummaryOrder', default: 'capacity', valid: oneOf\(SUMMARY_COLUMNS\.map\(\(column\) => column\.key\)\) \}/.test(text), 'a saved order that must be one of the columns')
  assert.ok(/const SUMMARY_INPUTS = \['summarySources'\]/.test(text) && /const OPTIONAL_INPUTS = \[\.\.\.MSP_INPUTS, \.\.\.DONOR_INPUTS, \.\.\.SUMMARY_INPUTS\]/.test(text), 'the read is optional')
  assert.ok(/summarySources: 'the ships, modules and services of the colony summary'/.test(text), 'with a label')
  assert.ok(help.usage.some((line) => /Empire summary/.test(line) && /Order by/.test(line)) && /Empire summary/.test(help.usage[0]), 'the help names the view and its control')
  assert.ok(/view=fuel`, `maintenance`, `reserves`, `summary` or `stations`/.test(fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', 'deep-links.js'), 'utf8')), 'the link table lists the view')
  assert.equal(capabilities.isOptional('/logistics', 'summarySources'), true, 'the capability registry lets the page go on without the read')
  assert.equal(vm.ready, true, 'the page is ready without the summary read')
  assert.deepEqual(vm.summaryState, { loading: true, failed: '', error: '' }, 'the summary is loading until its read settles')
  assert.equal(vm.summaryTable, null, 'and has no rows')
  assert.deepEqual(instantiate(options, { $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data: { loadErrors: { ...Object.fromEntries(CORE.map((key) => [key, null])), summarySources: 'boom' } } }).summaryState, { loading: false, failed: 'the ships, modules and services of the colony summary', error: 'boom' }, 'a failed read is named')

  const updates = []
  const retried = instantiate(options, { $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data: { $asyncComputed: new Proxy({}, { get: (_target, key) => ({ update: () => updates.push(key) }) }) } })

  retried.retrySummary()
  assert.deepEqual(updates, ['summarySources'], 'Retry reads the summary again')

  const database = copy()
  const first = await pageOn(w, database, 'capacity')
  const second = await pageOn(w, database, 'fuel')

  assert.ok(first.summaryTable.length === 45 && second.summaryTable.length === 45, 'the colonies the capture lists')
  assert.notDeepEqual(first.summaryTable.map((row) => row.PopulationID), second.summaryTable.map((row) => row.PopulationID), 'the chosen column orders the rows')
  assert.ok(first.summaryTable.every((row) => row.name === row.colony.PopName && typeof row.place === 'string'), 'each row carries its name and place')

  const held = await pageOn(w, copy())

  assert.ok(held.summaryTable, 'the rows are there once the read is in')
  held.loadErrors = { ...held.loadErrors, summarySources: 'boom' }
  assert.equal(held.summaryTable, null, 'a failed read shows no rows, whatever an earlier read held')
  held.loadErrors = { ...held.loadErrors, summarySources: undefined }
  assert.equal(held.summaryTable, null, 'a read in flight shows no rows')
})

const loadersOf = (database) => loaderOf(database)

check('loader', 'the loader reads the ships that count, the modules, the services and the stored order, and the capture\'s colonies are the ones it lists', async (w) => {
  const { 'empire-logistics': m } = await w.modules()
  const database = copy()
  const read = await m.loadSummarySources(loadersOf(database), { GameID: GAME, RaceID: RACE })
  const ids = rowsOf(database, `select PopulationID from FCT_Population where GameID = ${GAME} and RaceID = ${RACE} order by rowid`).map((row) => row.PopulationID)

  assert.deepEqual([...read.listing], ids, 'the colonies in the order the save stores them')
  assert.ok(read.tonnage.length >= 20 && read.tonnage.every((row) => row.Ships > 0 && row.Unknown === 0), 'the colonies with ships')
  assert.ok(read.modules.length >= 7 && read.modules.every((row) => row.Modules > 0), 'the ships with modules')
  assert.ok(read.services.length > 40, 'the colonies with installations')
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.tonnage), 'frozen')

  const failing = { query: async () => { throw new Error('no such column: FCT_Fleet.CivilianFunction') } }

  await assert.rejects(m.loadSummarySources(failing, { GameID: GAME, RaceID: RACE }), /CivilianFunction/, 'a read that fails fails the loader whole')
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------------
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the capacity leaves out the economic modifier', target: 'util', from: 'colony.CapacityModifier, colony.EconomicProdModifier)\n    const moduleCount', to: 'colony.CapacityModifier)\n    const moduleCount', fails: ['oracle', 'formula'] },
  { name: 'the capacity leaves out the efficiency', target: 'util', from: 'colony.MaintenanceCapacity, colony.Efficiency, colony.CapacityModifier', to: 'colony.MaintenanceCapacity, colony.CapacityModifier', fails: ['oracle', 'formula'] },
  { name: 'the module adds the efficiency too', target: 'util', from: 'product(moduleCount, colony.MaintenanceCapacity, colony.EconomicProdModifier) : 0', to: 'product(moduleCount, colony.MaintenanceCapacity, colony.EconomicProdModifier, colony.Efficiency) : 0', fails: ['formula'] },
  { name: 'the module adds no economic modifier', target: 'util', from: 'product(moduleCount, colony.MaintenanceCapacity, colony.EconomicProdModifier) : 0', to: 'product(moduleCount, colony.MaintenanceCapacity) : 0', fails: ['formula'] },
  { name: 'the capacity including orbital is the capacity', target: 'util', from: 'capacity === null || moduleCount === null || added === null ? null : capacity + added', to: 'capacity', fails: ['s4', 'oracle', 'formula'] },
  { name: 'the modules of a fleet near several colonies count for each', target: 'util', from: 'if (fleet.assigned === 0) {\n        fleet.assigned = colony.PopulationID\n      }\n\n      if (fleet.assigned === colony.PopulationID) {', to: 'if (fleet.assigned === 0 || fleet.assigned === colony.PopulationID) {', fails: ['modules'] },
  { name: 'a fleet with no colony is counted by none', target: 'util', from: 'if (fleet.assigned === 0) {\n        fleet.assigned = colony.PopulationID\n      }\n\n', to: '', fails: ['modules', 'oracle'] },
  { name: 'a fleet assigned to another colony is counted too', target: 'util', from: 'if (fleet.assigned === colony.PopulationID) {', to: 'if (fleet.assigned === colony.PopulationID || fleet.assigned > 0) {', fails: ['modules', 'oracle'] },
  { name: 'the modules count from a fleet a unit away', target: 'pools', from: 'Math.abs(anchor.Xcor - item.Xcor) < CLUSTER_UNITS && Math.abs(anchor.Ycor - item.Ycor) < CLUSTER_UNITS', to: 'Math.abs(anchor.Xcor - item.Xcor) <= CLUSTER_UNITS && Math.abs(anchor.Ycor - item.Ycor) <= CLUSTER_UNITS', fails: ['modules'] },
  { name: 'the modules count from a fleet within a unit on one axis', target: 'pools', from: 'Math.abs(anchor.Xcor - item.Xcor) < CLUSTER_UNITS && Math.abs(anchor.Ycor - item.Ycor) < CLUSTER_UNITS', to: 'Math.abs(anchor.Xcor - item.Xcor) < CLUSTER_UNITS', fails: ['modules'] },
  { name: 'the modules of a fleet in another system are not counted', target: 'util', from: 'if (!withinUnits(colony, fleet)) {', to: 'if (!withinUnits(colony, fleet) || fleet.SystemID !== colony.SystemID) {', fails: ['modules', 'oracle'] },
  { name: 'the modules of a civilian fleet are counted', target: 'util', from: 'FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.CivilianFunction = 0)', to: 'FCT_Fleet.RaceID = ${RaceID})', fails: ['oracle'] },
  { name: 'the modules of the ships of every race are counted', target: 'util', from: 'where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Fleet.RaceID = ${RaceID}', to: 'where FCT_Ship.GameID = ${GameID}', fails: ['oracle'] },
  { name: 'the tonnage is 25 tons a hull space', target: 'util', from: 'export const TONS_PER_HULL_SPACE = 50', to: 'export const TONS_PER_HULL_SPACE = 25', fails: ['s4', 'oracle', 'formula'] },
  { name: 'the supplies a year are the whole cost', target: 'util', from: 'Number(held.Cost) * ORDINARY_SHARE', to: 'Number(held.Cost)', fails: ['s4', 'oracle', 'formula'] },
  { name: 'the tonnage is summed over the ships of a hair off the body', target: 'util', from: 'FCT_Fleet.Xcor = FCT_SystemBody.Xcor and FCT_Fleet.Ycor = FCT_SystemBody.Ycor', to: 'abs(FCT_Fleet.Xcor - FCT_SystemBody.Xcor) < 1 and abs(FCT_Fleet.Ycor - FCT_SystemBody.Ycor) < 1', fails: ['oracle'] },
  { name: 'the tonnage is summed over the ships of every system at the place', target: 'util', from: 'FCT_Fleet.SystemID = FCT_Population.SystemID and ', to: '', fails: ['oracle'] },
  { name: 'the tonnage counts the ships of a commercial class', target: 'util', from: 'and coalesce(FCT_ShipClass.Commercial, 0) = 0', to: '', fails: ['s4', 'oracle'] },
  { name: 'the tonnage counts the ships a military hangar carries', target: 'util', from: ' and (VIR_Mothership.CommercialHangar is null or VIR_Mothership.CommercialHangar <> 0)', to: '', fails: ['s4', 'oracle'] },
  { name: 'the tonnage counts the ships of a shipyard task of the colony', target: 'util', from: ' and not exists (select 1 from FCT_ShipyardTask inner join FCT_Shipyard on FCT_Shipyard.ShipyardID = FCT_ShipyardTask.ShipyardID where FCT_ShipyardTask.ShipID = FCT_Ship.ShipID and FCT_Shipyard.PopulationID = FCT_Population.PopulationID)', to: '', fails: ['oracle'] },
  { name: 'the tonnage leaves out the ships of every shipyard task', target: 'util', from: 'and FCT_Shipyard.PopulationID = FCT_Population.PopulationID)', to: ')', fails: ['oracle'] },
  { name: 'the tonnage counts the ships of every race', target: 'util', from: 'FCT_Fleet.GameID = FCT_Population.GameID and FCT_Fleet.RaceID = FCT_Population.RaceID and ', to: 'FCT_Fleet.GameID = FCT_Population.GameID and ', fails: ['oracle'] },
  { name: 'production takes the facilities whole', target: 'util', from: 'whole(colony.MaintenanceFacilities), PRODUCTION_PERIODS', to: 'colony.MaintenanceFacilities, PRODUCTION_PERIODS', fails: ['formula', 'oracle'] },
  { name: 'production is not made four times over', target: 'util', from: 'export const PRODUCTION_PERIODS = 4', to: 'export const PRODUCTION_PERIODS = 1', fails: ['s4', 'oracle', 'formula'] },
  { name: 'production leaves out the colony\'s modifier', target: 'util', from: 'product(colony.MSPProduction, modifier, whole', to: 'product(colony.MSPProduction, 1, whole', fails: ['s4', 'oracle', 'formula'] },
  { name: 'fuel production takes the refineries whole', target: 'util', from: 'product(colony.FuelProduction, modifier, whole(colony.Refineries))', to: 'product(colony.FuelProduction, modifier, colony.Refineries)', fails: ['formula', 'oracle'] },
  { name: 'fuel production leaves out the colony\'s modifier', target: 'util', from: 'product(colony.FuelProduction, modifier, whole', to: 'product(colony.FuelProduction, 1, whole', fails: ['s4', 'oracle', 'formula'] },
  { name: 'the refuelling mark takes a fraction of a point', target: 'util', from: 'refuel: whole(service.RefuelPoints) > 0,', to: 'refuel: service.RefuelPoints > 0,', fails: ['formula'] },
  { name: 'the ordnance mark takes a fraction of a point', target: 'util', from: 'ordnance: whole(service.OrdnancePoints) > 0,', to: 'ordnance: service.OrdnancePoints > 0,', fails: ['formula'] },
  { name: 'the resupply mark leaves out the cargo shuttle points', target: 'util', from: ' || whole(service.ShuttlePoints) > 0,', to: ',', fails: ['formula', 'oracle', 's4'] },
  { name: 'the resupply mark leaves out the modules', target: 'util', from: 'whole(colony.MaintenanceFacilities) > 0 || moduleCount > 0 ||', to: 'whole(colony.MaintenanceFacilities) > 0 ||', fails: ['formula', 'oracle', 's4'] },
  { name: 'the resupply mark leaves out the facilities', target: 'util', from: 'resupply: whole(colony.MaintenanceFacilities) > 0 || moduleCount > 0', to: 'resupply: moduleCount > 0', fails: ['formula', 'component'] },
  { name: 'the services read the refuelling points for the ordnance', target: 'util', from: 'sum(DIM_PlanetaryInstallation.MassOrdnanceTransfer * FCT_PopulationInstallations.Amount) as OrdnancePoints', to: 'sum(DIM_PlanetaryInstallation.MassRefuelling * FCT_PopulationInstallations.Amount) as OrdnancePoints', fails: ['oracle', 's4'] },
  { name: 'the list shows a colony with nothing', target: 'util', from: 'return rows.filter(shown)', to: 'return rows.filter(() => true)', fails: ['s4', 'show', 'oracle'] },
  { name: 'the list leaves out the colonies with a stock alone', target: 'util', from: ' || row.ordnance || row.stock !== 0', to: ' || row.ordnance', fails: ['show'] },
  { name: 'the list leaves out the colonies with fuel alone', target: 'util', from: ' || row.fuel !== 0 ||', to: ' ||', fails: ['show'] },
  { name: 'the list leaves out the colonies with a tonnage alone', target: 'util', from: 'row.orbital !== 0 || row.tons !== 0 ||', to: 'row.orbital !== 0 ||', fails: ['show'] },
  { name: 'the list leaves out the colonies with production alone', target: 'util', from: ' || row.production !== 0 ||', to: ' ||', fails: ['show'] },
  { name: 'the list leaves out the colonies with fuel production alone', target: 'util', from: ' || row.fuelProduction !== 0 ||', to: ' ||', fails: ['show'] },
  { name: 'the list leaves out the colonies with a capacity including orbital alone', target: 'util', from: 'const shown = (row) => row.orbital !== 0 || row.tons', to: 'const shown = (row) => row.tons', fails: ['show'] },
  { name: 'the rows run from the smallest up', target: 'util', from: 'keyOf(a) === keyOf(b) ? 0 : keyOf(b) - keyOf(a)', to: 'keyOf(a) === keyOf(b) ? 0 : keyOf(a) - keyOf(b)', fails: ['s4', 'order', 'oracle'] },
  { name: 'equal figures run in the order of the IDs, not the list', target: 'util', from: 'rank(a) === rank(b) ? a.PopulationID - b.PopulationID : rank(a) - rank(b)', to: 'a.PopulationID - b.PopulationID', fails: ['s4', 'order', 'oracle'] },
  { name: 'equal figures run in the reverse of the list', target: 'util', from: 'keyOf(a) === keyOf(b) ? 0 : keyOf(b) - keyOf(a)', to: 'keyOf(a) === keyOf(b) ? -1 : keyOf(b) - keyOf(a)', fails: ['order', 'oracle'] },
  { name: 'an unknown figure orders first', target: 'util', from: '? Number(row[order].toPrecision(12)) : -Infinity', to: '? Number(row[order].toPrecision(12)) : Infinity', fails: ['order'] },
  { name: 'the tonnage orders by the supplies a year', target: 'util', from: 'rows.filter(shown).sort((a, b) =>', to: "rows.filter(shown).sort((a, b) => (order === 'tons' && (order = 'year'), 0) ||", fails: ['order'] },
  { name: 'the tonnage is amber at the capacity', target: 'util', from: 'row.tons > row.orbital', to: 'row.tons >= row.orbital', fails: ['colours', 'oracle'] },
  { name: 'the tonnage is amber above the capacity alone', target: 'util', from: 'isNumber(row.orbital) && row.tons > row.orbital', to: 'isNumber(row.capacity) && row.tons > row.capacity', fails: ['colours'] },
  { name: 'production is amber when it is equal to the supplies a year', target: 'util', from: 'row.year > row.production ? \'short\'', to: 'row.year >= row.production ? \'short\'', fails: ['colours'] },
  { name: 'production is amber when it is above the supplies a year', target: 'util', from: 'row.year > row.production ? \'short\'', to: 'row.year < row.production ? \'short\'', fails: ['colours', 's4', 'oracle'] },
  { name: 'production off is amber, not red', target: 'util', from: ": row.production > 0 ? 'off' : null", to: ": row.production > 0 ? 'short' : null", fails: ['colours', 's4', 'oracle'] },
  { name: 'production off with none to make is red', target: 'util', from: ": row.production > 0 ? 'off' : null", to: ": 'off'", fails: ['colours', 's4', 'oracle'] },
  { name: 'production on and short is red', target: 'util', from: "(isNumber(row.year) && row.year > row.production ? 'short' : null)", to: "(isNumber(row.year) && row.year > row.production ? 'off' : null)", fails: ['colours', 's4', 'oracle'] },
  { name: 'fuel production off with none to make is red', target: 'util', from: 'fuelOn === false && row.fuelProduction > 0', to: 'fuelOn === false', fails: ['colours', 'oracle'] },
  { name: 'fuel production on is red', target: 'util', from: 'fuelOn === false && row.fuelProduction > 0', to: 'fuelOn !== false && row.fuelProduction > 0', fails: ['colours', 's4', 'oracle'] },
  { name: 'a production switch not given counts as off', target: 'util', from: 'value === null || value === undefined ? null : Number(value) !== 0', to: 'Number(value) !== 0', fails: ['unknown'] },
  { name: 'a figure not known is 0', target: 'util', from: 'if (value === null) {\n        missing[key] = missingOf(names)\n      }\n\n      return value', to: 'if (value === null) {\n        missing[key] = missingOf(names)\n      }\n\n      return value === null ? 0 : value', fails: ['unknown', 'modules'] },
  { name: 'a figure not known has no result that names it', target: 'util', from: 'missing[key] = missingOf(names)', to: 'missing[key] = undefined', fails: ['unknown', 'modules', 'component'] },
  { name: 'a tonnage with a class lacking its hull spaces is counted as given', target: 'util', from: 'const heldKnown = !held || Number(held.Unknown) === 0', to: 'const heldKnown = true', fails: ['unknown'] },
  { name: 'a module count not given is 0', target: 'util', from: 'unknown = unknown || fleet.unknown', to: 'unknown = false', fails: ['modules'] },
  { name: 'the figures are rounded by the binary product', target: 'util', from: 'const scaled = Number((Math.abs(value) * scale).toPrecision(12))', to: 'const scaled = Math.abs(value) * scale', fails: ['rounding'] },
  { name: 'a half is rounded to the even figure', target: 'util', from: 'return (value < 0 ? -1 : 1) * Math.round(scaled) / scale', to: 'return (value < 0 ? -1 : 1) * (scaled % 1 === 0.5 && Math.floor(scaled) % 2 === 0 ? Math.floor(scaled) : Math.round(scaled)) / scale', fails: ['rounding'] },
  { name: 'a negative figure is rounded toward zero', target: 'util', from: 'return (value < 0 ? -1 : 1) * Math.round(scaled) / scale', to: 'return Math.round(value * scale) / scale', fails: ['rounding'] },
  { name: 'the fuel counts in thousands', target: 'util', from: 'export const FUEL_UNIT = 1e6', to: 'export const FUEL_UNIT = 1e3', fails: ['rounding', 's4', 'component'] },
  { name: 'the listing is read by ID', target: 'util', from: 'order by FCT_Population.rowid`', to: 'order by FCT_Population.PopulationID`', fails: ['s4', 'oracle', 'loader'] },
  { name: 'the colonies of every race are listed', target: 'util', from: 'where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} order by', to: 'where FCT_Population.GameID = ${GameID} order by', fails: ['loader'] },
  { name: 'the rule is registered for another line', target: 'util', from: "const SUMMARY_VERSIONS = ['3.2.x']", to: "const SUMMARY_VERSIONS = ['3.0.x']", fails: ['rule'] },
  { name: 'the rule is registered for another line as well', target: 'util', from: "const SUMMARY_VERSIONS = ['3.2.x']", to: "const SUMMARY_VERSIONS = ['3.0.x', '3.2.x']", fails: ['rule'] },
  { name: 'the rule is estimated', target: 'util', from: "verification: 'confirmed',", to: "verification: 'estimated',", fails: ['rule'] },
  { name: 'the component writes M-PROD amber for red', target: 'component', from: "return row.productionState === 'short' ? 'warning--text' : 'error--text'", to: "return row.productionState === 'short' ? 'error--text' : 'warning--text'", fails: ['s4', 'component'] },
  { name: 'the component writes the tonnage with no colour', target: 'component', from: "if (key === 'tons' && row.tonsAbove) {\n        return 'warning--text'", to: "if (key === 'tons' && row.tonsAbove) {\n        return ''", fails: ['component'] },
  { name: 'the component colours the fuel production amber', target: 'component', from: "return 'error--text'\n      }\n\n      return row[key]", to: "return 'warning--text'\n      }\n\n      return row[key]", fails: ['s4', 'component'] },
  { name: 'the component writes a figure of nothing as 0', target: 'component', from: 'if (!(value > 0)) {', to: 'if (!(value >= 0)) {', fails: ['s4', 'component'] },
  { name: 'the component writes the fuel in whole litres', target: 'component', from: 'FUEL_KEYS.includes(key) ? `${this.count(roundedFigure(value / FUEL_UNIT, 1), 1)}m`', to: 'FUEL_KEYS.includes(key) ? `${this.count(roundedFigure(value / FUEL_UNIT, 1), 0)}m`', fails: ['s4', 'component'] },
  { name: 'the component rounds with the binary product', target: 'component', from: 'this.count(roundedFigure(value, 0))', to: 'this.count(Math.round(value))', fails: ['component'] },
  { name: 'the component rounds the fuel with the binary product', target: 'component', from: 'this.count(roundedFigure(value / FUEL_UNIT, 1), 1)', to: 'this.count(value / FUEL_UNIT, 1)', fails: ['component'] },
  { name: 'the component draws no mark on a figure not known', target: 'component', from: '<provenance-mark v-if="row.missing[column.key]" :result="row.missing[column.key]" />', to: '', fails: ['component'] },
  { name: 'the component marks every figure', target: 'component', from: '<provenance-mark v-if="row.missing[column.key]" :result="row.missing[column.key]" />', to: '<provenance-mark :result="row.missing[column.key]" />', fails: ['component'] },
  { name: 'the component draws No for a dash in the marks', target: 'component', from: "row[service.key] ? 'Yes' : UNKNOWN_TEXT", to: "row[service.key] ? 'Yes' : 'No'", fails: ['s4', 'component'] },
  { name: 'the tab leaves the ORD mark out', target: 'util', from: "key: 'ordnance'", to: "key: 'ordnanceX'", fails: ['component', 's4'] },
  { name: 'the component draws no title on a coloured figure', target: 'component', from: "return 'Production is on and below the maintenance supplies the ships need in a year'", to: "return ''", fails: ['component'] },
  { name: 'the panel has no data-summary', target: 'component', from: 'data-summary="List each colony', to: 'data-sum="List each colony', fails: ['template'] },
  { name: 'the data-summary carries a figure', target: 'component', from: 'data-summary="List each colony\'s maintenance capacity', to: 'data-summary="List each of the 45 colonies\' maintenance capacity', fails: ['template'] },
  { name: 'the data-summary speaks to a person', target: 'component', from: "as the game's empire logistics list gives them.\"", to: "as your game's empire logistics list gives them.\"", fails: ['template'] },
  { name: 'the foot opens with something else', target: 'component', from: 'Use it to read each colony\'s maintenance', to: 'Read each colony\'s maintenance', fails: ['template'] },
  { name: 'the foot names a release', target: 'component', from: 'The Maintenance table\'s capacity leaves the economic modifier out', to: 'The Maintenance table\'s capacity in 3.2 leaves the economic modifier out', fails: ['template'] },
  { name: 'the foot speaks to a person', target: 'component', from: 'and to find colonies whose maintained tonnage', to: 'and to find your colonies whose maintained tonnage', fails: ['template'] },
  { name: 'the foot does not set the figures apart from the Maintenance table\'s', target: 'component', from: 'The Maintenance table\'s capacity leaves the economic modifier out, so the two differ only where it is not 1. ', to: '', fails: ['template'] },
  { name: 'the foot does not set the production apart from the other tables', target: 'component', from: 'The Fuel table and the Maintenance table count a part of a refinery or a facility as that part of its output, and the Maintenance table stops at what the minerals in stock allow, so their production can differ from the production here. ', to: '', fails: ['template'] },
  { name: 'the foot counts the cargo shuttle bays of ships as resupply points', target: 'component', from: 'or a ship with maintenance modules near it)', to: 'or a ship with maintenance modules or cargo shuttle bays near it)', fails: ['template'] },
  { name: 'the head carries no mark of the rule', target: 'component', from: '<provenance-mark rule="logistics.empireSummary" label />', to: '', fails: ['template'] },
  { name: 'the page has no toggle for the view', target: 'page', from: '<v-btn value="summary" small><v-icon small left>mdi-table-large</v-icon>Empire summary</v-btn>', to: '', fails: ['page'] },
  { name: 'the page hands the component the rows of another order', target: 'page', from: ':rows="summaryTable" :state="summaryState" :order="summaryOrder"', to: ':rows="summaryTable" :state="summaryState" :order="\'capacity\'"', fails: ['page'] },
  { name: 'the page orders by the capacity whatever is chosen', target: 'page', from: 'modifierOf: this.modifierOf, order: this.summaryOrder })', to: 'modifierOf: this.modifierOf, order: \'capacity\' })', fails: ['page', 'order'] },
  { name: 'the page waits for the summary read with the core reads', target: 'page', from: 'const OPTIONAL_INPUTS = [...MSP_INPUTS, ...DONOR_INPUTS, ...SUMMARY_INPUTS]', to: 'const OPTIONAL_INPUTS = [...MSP_INPUTS, ...DONOR_INPUTS]', fails: ['page'] },
  { name: 'the page\'s retry reads the donors', target: 'page', from: 'SUMMARY_INPUTS.forEach((key) => this.$asyncComputed[key].update())', to: 'DONOR_INPUTS.forEach((key) => this.$asyncComputed[key].update())', fails: ['page'] },
  { name: 'the page shows the rows before the read is in', target: 'page', from: 'if (!this.summarySources || this.summaryState.loading || this.summaryState.failed) {', to: 'if (!this.summarySources) {', fails: ['page'] },
  { name: 'the page saves any order', target: 'page', from: "default: 'capacity', valid: oneOf(SUMMARY_COLUMNS.map((column) => column.key)) }", to: "default: 'capacity' }", fails: ['page'] },
  { name: 'the page gives the rows the colony\'s name of another', target: 'page', from: '.map((row) => ({ ...row, name: row.colony.PopName, place: this.place(row.colony) }))\n    },\n\n    // FUEL', to: '.map((row) => ({ ...row, name: row.colony.SystemName, place: this.place(row.colony) }))\n    },\n\n    // FUEL', fails: ['s4', 'page'] },
  { name: 'the page reads the summary of the colonies of the first race alone', target: 'page', from: 'return await loadSummarySources(database, { GameID, RaceID })', to: 'return await loadSummarySources(database, { GameID, RaceID: 1 })', fails: ['s4', 'oracle'] },
  { name: 'the help leaves the view out', target: 'glossary', from: 'Reserves, Empire summary and Fleet stations.', to: 'Reserves and Fleet stations.', fails: ['page'] },
  { name: 'the capability registry loses the optional read', target: 'capabilities', from: "key === 'fuelDonors' || key === 'summarySources' ||", to: "key === 'fuelDonors' ||", fails: ['page'] },
]
/* eslint-enable no-template-curly-in-string */

// Rewrites that say the same thing: the hull spaces and the product of figures written the other way round, the whole of a figure written as the remainder taken away, a number test written as a negation, a scale written as a power.
const BENIGN = [
  { name: 'the tons of a hull space written first', target: 'util', from: 'heldKnown ? Number(held.Size) * TONS_PER_HULL_SPACE : null', to: 'heldKnown ? TONS_PER_HULL_SPACE * Number(held.Size) : null' },
  { name: 'the whole of a figure written as the remainder taken away', target: 'util', from: 'const whole = (value) => (isNumber(value) ? Math.trunc(value) : null)', to: 'const whole = (value) => (isNumber(value) ? value - (value % 1) : null)' },
  { name: 'the product written with the factors the other way round', target: 'util', from: 'factors.reduce((result, factor) => result * factor, 1)', to: 'factors.reduce((result, factor) => factor * result, 1)' },
  { name: 'a number test written as a negation', target: 'util', from: 'const isNumber = (value) => typeof value === \'number\' && Number.isFinite(value)', to: 'const isNumber = (value) => !(typeof value !== \'number\' || !Number.isFinite(value))' },
  { name: 'the scale of a rounding written as a product', target: 'util', from: 'const scale = 10 ** decimals', to: 'const scale = Math.pow(10, decimals)' },
]

// ---- Run ------------------------------------------------------------------------------------------------------------------
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

const FIXTURES = { s4: [SAVE], oracle: [SAVE], order: [SAVE], page: [SAVE], loader: [SAVE] }
const absent = (one) => (FIXTURES[one.name] || []).filter((file) => !fs.existsSync(path.join(root, file)))

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
      const texts = textWith(benign)

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

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
    closeAll()
    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    closeAll()
    process.exit(2)
  })
