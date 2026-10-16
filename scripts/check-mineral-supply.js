/*
  Checks the Mineral Outlook's supply accounting: extraction, export capacity and delivered supply kept apart (src/renderer/utilities/mineral-supply.js, src/renderer/components/minerals/MineralSupply.vue and its mount in src/renderer/pages/mineral-outlook.vue).

  bun scripts/check-mineral-supply.js [--no-mutations]

  The utility is run on synthetic colonies, mines, packets and ledger moves worked by hand. Route: a colony with no destination, a destination that is gone or the colony itself sends nothing by packet, whatever its civilian complexes do; a destination that exists keeps the route whoever owns it, wherever it is and whether or not it has a driver (only the destination picker restricts those), and the site's drivers alone decide whether stock ships; the civilian output a race buys for such a destination goes straight into a packet; what is not stored leaves the route unavailable, and a purchase choice that is not stored leaves the packet output, the stock added and the supply of a site with a destination unknown. Unconnected: a productive mine with no route adds all it extracts to its own stock, supplies no destination and credits no colony, the capital included. Throughput: stock shipped by drivers is the ledger's observed tonnes, never the drivers' capacity, and without a ledger it is unknown, not 0. Packets: a packet is in the sender's stock before it leaves, in flight to its destination (in no stock) in transit, and in the destination's own stock after, counted once; the race's total is the same in every phase; a packet bound for a colony the race lacks is in flight and in no destination. Destinations: each is credited by the sites that name it, never by a packet's origin, which the save does not hold. Conservation: extraction is the civilian output that goes into a packet plus what stays in the site's stock. Neutral: the ledger's transfers (freighter loads and unloads, packet sends and receipts) add no income. Observed: the ledger's tonnes are annualised, and unknown without a ledger or with an amount missing. Scenario: a blank delivery is nothing entered, a negative or non-numeric one is invalid, one with no colony is incomplete, an applied one is assumed and changes no confirmed figure.

  The panel's script runs as a pseudo instance over scripts/lib/page-loader.js, its template and the page are read as text and the page's script runs the supply computed.

  The saves (saves/AuroraDB.db, saves/AuroraDB_271_skoormit_saved.db, game 138, race 785, and AuroraDB.db, game 140, race 784, read-only) give the real colonies, mines, packets and ledger: the stock and the packets in flight are compared with raw sums of the tables, extraction with the rates of the mining rows, each site's route with the stored destination, and the ledger's sums with a raw grouped read. On a temporary copy of the 271 save every destination is cleared (no site has a route: each adds its extraction to its own stock and supplies none) and the ledger is dropped (no moves are observed). A save that is not there is skipped.

  Each mutation of the utility, the panel, the page or the outlook must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const FILES = {
  utility: path.join(root, 'src', 'renderer', 'utilities', 'mineral-supply.js'),
  minerals: path.join(root, 'src', 'renderer', 'utilities', 'minerals.js'),
  component: path.join(root, 'src', 'renderer', 'components', 'minerals', 'MineralSupply.vue'),
  page: path.join(root, 'src', 'renderer', 'pages', 'mineral-outlook.vue'),
}
const U = 'utility'
const M = 'minerals'
const V = 'component'
const P = 'page'
const NAMES = ['mineral-supply', 'mineral-outlook', 'minerals', 'colony-minerals', 'cmc-policy', 'mining-data', 'provenance']
const SAVES = [
  { file: 'saves/AuroraDB.db', game: 138, race: 785 },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785, copy: true },
  { file: 'AuroraDB.db', game: 140, race: 784 },
]

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
}
const THEME_STUB = 'export const chartTheme = () => ({ categorical: [], ink: "", inkMuted: "" }); export const withAlpha = (color) => color; export const flowColor = () => ""'
const MIXIN_STUB = 'export default { methods: {}, asyncComputed: {} }'
const STORE = { getters: { config: { get: () => 'Tick' } }, state: {} }

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
const DROPPED = new Set(['rule', 'inputs', 'assumptions', 'row', 'route'])

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

// True, or a text with what differed (the bounded assertion's own, shortened).
const same = (actual, expected) => {
  try {
    assert.deepEqual(actual, expected)

    return true
  } catch (error) {
    return `${short(actual)} != ${short(expected)}`
  }
}

const sameNumber = (actual, expected) => (near(actual, expected) ? true : `${short(actual)} != ${short(expected)}`)

const templateErrors = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed

  return compiler.compileTemplate({ source: descriptor.template.content, filename: 'component.vue', id: 'component' }).errors.map(String)
}

const PRONOUNS = /\b(I|me|my|mine|you|your|we|our)\b/i

// ---------- the fixtures worked by hand ----------

const RACE = 5
const SYSTEM = 1

const fixtures = (m) => {
  const { ms, provenance, minerals, colony: colonyModule } = m
  const MINS = minerals.MINERALS
  const value = provenance.valueOrNull
  const colony = (id, name, over = {}) => ({ PopulationID: id, PopName: name, SystemID: SYSTEM, MassDriverDest: 0, Drivers: 0, DriverGaps: 0, DestinationID: null, DestinationName: null, DestinationRaceID: null, DestinationSystemID: null, ...Object.fromEntries(MINS.map(({ name: mineral }) => [mineral, 0])), ...over })
  // The colony `from` with its mass driver pointed at the colony `to`, in the same system and the same race unless the override says otherwise.
  const toward = (to, over = {}) => ({ MassDriverDest: to.PopulationID, DestinationID: to.PopulationID, DestinationName: to.PopName, DestinationRaceID: RACE, DestinationSystemID: to.SystemID, ...over })
  // One deposit row of the colony's mines: 10 manned mines at 10 t each, accessibility 1, every modifier neutral, so 100 t/yr; civilian complexes add 10 t each.
  const surface = (id, name, over = {}) => ({ PopulationID: id, PopName: name, SystemID: SYSTEM, SystemName: 'Sol', SystemBodyID: 100 + id, MaterialID: 1, MassDriverExport: 0, PurchaseCivilianMinerals: 0, ManualMineCount: 10, AutomatedMineCount: 0, CivilianMineCount: 0, MineProduction: 10, Accessibility: 1, GovernorBonus: 1, SectorBonus: 1, Efficiency: 1, StabilityModifier: 1, PoliticalModifier: 1, RadiationModifier: 1, ...over })
  // Twenty civilian complexes the race buys the output of, for a destination: with the 10 manned mines 300 t/yr, 200 of them the complexes'.
  const BOUGHT = { CivilianMineCount: 20, PurchaseCivilianMinerals: 1, MassDriverExport: 1 }
  const packetRow = (id, over = {}) => ({ PopulationID: id, ...Object.fromEntries(MINS.flatMap(({ name }) => [[name, 0], [`Missing${name}`, 0]])), ...over })
  const admins = { 1: { NavalAdminCommandID: 1, SystemID: 5, ParentCommandID: 0, BonusValue: 1.2, Share: 0.5, Eligible: true, Unknown: null, Systems: new Set([5]) } }
  // 10 modules of 14 t at commander 1.25, chain 1.1, full crew and accessibility 0.5: 96.25 t/yr.
  const orbital = (id, name, over = {}) => ({ FleetID: 1, ShipName: 'Miner', PopulationID: id, PopName: name, SystemID: 5, SystemName: 'Alpha', SystemBodyID: 500 + id, MaterialID: 1, MassDriverExport: 0, PurchaseCivilianMinerals: 0, MiningModules: 10, MineProduction: 14, CommanderBonus: 1.25, Accessibility: 0.5, Diameter: 1000, MaximumOrbitalMiningDiameter: 4000, ClassCrew: 100, CurrentCrew: 100, NavalAdminCommandID: 1, ...over })
  const ledger = (rows, perYear = 1) => ms.transferFlows(rows, perYear)
  const move = (populationId, type, amount, materialId = 1) => ({ PopulationID: populationId, MaterialID: materialId, MineralDataType: type, Amount: amount })
  const supply = ({ surface: surfaceRows = [], orbital: orbitalRows = [], routes, packets = {}, cargo = {}, flows = null, entries = [], materialId = 1 }) => ms.mineralSupply({ surface: surfaceRows, orbital: orbitalRows, navalAdmins: admins, routes, packets, cargo, RaceID: RACE, materialId, flows, entries })
  const siteOf = (result, id) => result.sites.find((site) => site.populationId === id)
  const destinationOf = (result, id) => result.destinations.find((destination) => destination.populationId === id)
  const route = (colony, civilian = false) => ms.routeResult({ colony, civilian, RaceID: RACE })

  return { MINS, value, colony, toward, surface, BOUGHT, packetRow, admins, orbital, ledger, move, supply, siteOf, destinationOf, route, colonyModule }
}

// ---------- the checks that need no save ----------

const pure = (ctx) => {
  const { m } = ctx
  const f = fixtures(m)
  const { ms, provenance, minerals } = m
  const { value, colony, toward, surface, BOUGHT, packetRow, orbital, ledger, move, supply, siteOf, destinationOf, route } = f
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const isUnavailable = (result) => !provenance.isAvailable(result)

  // ----- the route -----
  add('route: a colony with no destination sends nothing by packet, whatever its complexes do', () => {
    const home = colony(1, 'Home', { Drivers: 2 })
    const plain = route(home, false).value
    const bought = route(home, true).value

    return same([plain.state, plain.target, plain.destinationId, bought.state, bought.target, bought.destinationId], ['none', 'none', null, 'none', 'none', null])
  })
  add('route: a destination that is gone or the colony itself is no route, whatever the drivers and the complexes', () => {
    const cases = [
      ['gone', toward(colony(2, 'Far', { Drivers: 1 }), { DestinationID: null, DestinationName: null, DestinationRaceID: null, DestinationSystemID: null })],
      ['self', { MassDriverDest: 1, DestinationID: 1, DestinationName: 'Home', DestinationRaceID: RACE, DestinationSystemID: SYSTEM }],
    ]
    const read = (over) => [false, true].map((civilian) => { const result = route(colony(1, 'Home', { Drivers: 1, ...over }), civilian).value; return [result.target, result.state, result.destinationId, ms.noRouteReason(result).includes('destination')] })

    return same(cases.map(([target, over]) => [target, read(over)]), cases.map(([target]) => [target, [[target, 'none', null, true], [target, 'none', null, true]]]))
  })
  add('route: a destination of another race, in another system or without a driver keeps the route: only the destination picker restricts those', () => {
    const cases = [
      ['foreign', colony(2, 'Far', { Drivers: 1 }), { DestinationRaceID: RACE + 1 }],
      ['elsewhere', colony(2, 'Far', { Drivers: 1 }), { DestinationSystemID: SYSTEM + 1 }],
      ['valid', colony(2, 'Far', { Drivers: 0 }), {}],
    ]
    const read = (to, over) => [false, true].map((civilian) => { const result = route(colony(1, 'Home', { Drivers: 1, ...toward(to, over) }), civilian).value; return [result.target, result.state, result.destinationId] })

    return same(cases.map(([target, to, over]) => [target, read(to, over)]), cases.map(([target]) => [target, [[target, 'driver', 2], [target, 'packets', 2]]]))
  })
  add('route: a destination in the same system with a driver at the site ships stock by drivers', () => {
    const to = colony(2, 'Mine', { Drivers: 1 })
    const value = route(colony(1, 'Home', { Drivers: 1, ...toward(to) }), false).value

    return same([value.state, value.stock, value.destinationId, value.target], ['driver', 'ships', 2, 'valid'])
  })
  add('route: a site without a driver ships no stock to a destination that exists and names no destination', () => {
    const source = route(colony(1, 'Home', { Drivers: 0, ...toward(colony(2, 'Mine', { Drivers: 1 })) }), false).value

    return same([source.state, source.stock, source.destinationId, ms.noRouteReason(source).includes('the site has no mass driver')], ['none', 'none', null, true])
  })
  add('route: a destination that loses its last driver keeps the route, the capacity and the supply', () => {
    const at = (drivers) => { const to = colony(1, 'Home', { Drivers: drivers }); return siteOf(supply({ surface: [surface(2, 'Mine', BOUGHT)], routes: [to, colony(2, 'Mine', { Drivers: 2, ...toward(to) })], flows: ledger([move(2, 12, 40)]) }), 2) }
    const pick = (site) => [site.connection, value(site.capacity), value(site.supply), value(site.packetOutput), site.destination.populationId]

    return same([pick(at(0)), pick(at(1))], [['packets', 10000, 240, 200, 1], ['packets', 10000, 240, 200, 1]])
  })
  add('route: the civilian output a race buys for a valid destination goes by packet whatever the drivers are', () => {
    const to = colony(2, 'Mine')
    const value = route(colony(1, 'Home', { ...toward(to) }), true).value

    return same([value.state, value.civilian, value.destinationId], ['packets', true, 2])
  })
  add('route: a destination or a driver count that is not stored leaves a stock route unavailable, naming it', () => {
    const to = colony(2, 'Mine', { Drivers: 1 })
    const noDestination = route(colony(1, 'Home', { MassDriverDest: null }), false)
    const noDrivers = route(colony(1, 'Home', { Drivers: 1, DriverGaps: 1, ...toward(to) }), false)
    const noColony = route(undefined, false)

    return isUnavailable(noDestination) && noDestination.inputs.missing.some((text) => text.includes('MassDriverDest')) && isUnavailable(noDrivers) && noDrivers.inputs.missing.some((text) => text.includes('MassDriverValue')) && isUnavailable(noColony) ? true : short([noDestination, noDrivers, noColony])
  })
  add('route: the route is an estimate with its own rule', () => {
    const result = route(colony(1, 'Home'), false)

    return same([result.status, result.rule.id], ['estimated', 'mineralSupply.route'])
  })

  // ----- a productive mine with no route -----
  const home = colony(1, 'Home', { Duranium: 100 })
  const remote = colony(2, 'Remote', { SystemID: 2, Drivers: 3 })

  add('unconnected: a productive mine with no route adds all it extracts to its own stock and supplies no destination', () => {
    const result = supply({ surface: [surface(2, 'Remote')], routes: [home, remote] })
    const site = siteOf(result, 2)

    return same([site.connection, value(site.extraction), value(site.packetOutput), value(site.local), value(site.supply), value(site.capacity)], ['unconnected', 100, 0, 100, 0, 0])
  })
  add('unconnected: no colony is credited: no destination row, no destination named, the capital\'s stock unchanged', () => {
    const result = supply({ surface: [surface(2, 'Remote')], routes: [home, remote] })
    const site = siteOf(result, 2)

    return same([result.destinations.length, site.destination, result.empire.destinations, value(result.empire.stock)], [0, null, 0, 100])
  })
  add('unconnected: a destination named by a site with no driver is no route for stock either', () => {
    const to = colony(1, 'Home', { Duranium: 100 })
    const result = supply({ surface: [surface(2, 'Remote')], routes: [to, colony(2, 'Remote', { ...toward(to) })] })
    const site = siteOf(result, 2)

    return same([site.connection, value(site.supply), value(site.local), site.destination, result.destinations.length], ['unconnected', 0, 100, null, 0])
  })
  add('unconnected: the race\'s totals count the extraction once, as stock added at the site and nothing delivered', () => {
    const result = supply({ surface: [surface(2, 'Remote')], routes: [home, remote] })
    const { empire } = result

    return same([value(empire.extraction), value(empire.packetOutput), value(empire.local), value(empire.inFlight)], [100, 0, 100, 0])
  })
  add('unconnected: an orbital miner with no route likewise adds to its colony\'s stock and supplies none', () => {
    const result = supply({ orbital: [orbital(2, 'Remote')], routes: [home, remote] })
    const site = siteOf(result, 2)

    return sameNumber(value(site.extraction), 96.25) === true && sameNumber(value(site.local), 96.25) === true && same([site.connection, value(site.supply)], ['unconnected', 0]) === true ? true : short(site)
  })
  add('unconnected: a mine of a colony not in the routes read has a route that is unknown, not none', () => {
    const result = supply({ surface: [surface(9, 'Elsewhere')], routes: [home] })
    const site = siteOf(result, 9)

    return same([site.connection, isUnavailable(site.supply), value(site.local)], ['unknown', true, 100])
  })

  // ----- the throughput of a route -----
  add('throughput: the stock drivers ship is the ledger\'s observed tonnes, never the drivers\' capacity', () => {
    const to = colony(1, 'Home', { Drivers: 1 })
    const from = colony(2, 'Mine', { Drivers: 2, ...toward(to) })
    const site = siteOf(supply({ surface: [surface(2, 'Mine')], routes: [to, from], flows: ledger([move(2, 12, 500)], 2) }), 2)

    return same([site.connection, value(site.capacity), value(site.supply), value(site.sent)], ['driver', 10000, 1000, 1000])
  })
  add('throughput: with no ledger what the drivers send is not known: the supply is unavailable, the capacity still is', () => {
    const to = colony(1, 'Home', { Drivers: 1 })
    const from = colony(2, 'Mine', { Drivers: 2, ...toward(to) })
    const site = siteOf(supply({ surface: [surface(2, 'Mine')], routes: [to, from], flows: null }), 2)

    return isUnavailable(site.supply) && isUnavailable(site.sent) && value(site.capacity) === 10000 && value(site.local) === 100 ? true : short([site.supply, site.sent, site.capacity])
  })
  add('throughput: a site the ledger has no send for sent 0 over the window, once the ledger is known', () => {
    const to = colony(1, 'Home', { Drivers: 1 })
    const from = colony(2, 'Mine', { Drivers: 1, ...toward(to) })
    const site = siteOf(supply({ surface: [surface(2, 'Mine')], routes: [to, from], flows: ledger([move(1, 12, 9)]) }), 2)

    return same([value(site.sent), value(site.supply)], [0, 0])
  })
  add('throughput: civilian output bought for a destination and stock shipped by drivers add up, and a freighter load is not in it', () => {
    const to = colony(1, 'Home', { Drivers: 1 })
    const from = colony(2, 'Mine', { Drivers: 1, ...toward(to) })
    const site = siteOf(supply({ surface: [surface(2, 'Mine', BOUGHT)], routes: [to, from], flows: ledger([move(2, 12, 40), move(2, 8, 7000)]) }), 2)

    return same([site.connection, value(site.packetOutput), value(site.sent), value(site.supply), value(site.loaded)], ['packets', 200, 40, 240, 7000])
  })
  add('throughput: bought civilian output whose driver count is not stored has an unknown supply, its packet output still known', () => {
    const to = colony(1, 'Home', { Drivers: 1 })
    const from = colony(2, 'Mine', { Drivers: 0, DriverGaps: 1, ...toward(to) })
    const site = siteOf(supply({ surface: [surface(2, 'Mine', BOUGHT)], routes: [to, from], flows: ledger([]) }), 2)

    return isUnavailable(site.supply) && isUnavailable(site.capacity) && value(site.packetOutput) === 200 ? true : short([site.supply, site.capacity, site.packetOutput])
  })
  add('throughput: bought civilian output for a destination with no driver at the site is a packet supply of its own tonnes, with no capacity', () => {
    const to = colony(1, 'Home')
    const from = colony(2, 'Mine', { ...toward(to) })
    const site = siteOf(supply({ surface: [surface(2, 'Mine', BOUGHT)], routes: [to, from], flows: ledger([]) }), 2)

    return same([site.connection, value(site.supply), value(site.capacity), value(site.local)], ['packets', 200, 0, 100])
  })

  // ----- a packet through its phases -----
  const A = (stock, over = {}) => colony(1, 'A', { Duranium: stock, Drivers: 1, ...over })
  const B = (stock, over = {}) => colony(2, 'B', { Duranium: stock, Drivers: 1, ...over })
  const phase = (aStock, bStock, packets = {}, flows = null) => {
    const b = B(bStock)

    return supply({ surface: [surface(1, 'A')], routes: [A(aStock, toward(b)), b], packets, flows })
  }
  const BEFORE = () => phase(100, 20)
  const TRANSIT = () => phase(70, 20, { 2: packetRow(2, { Duranium: 30 }) })
  const AFTER = () => phase(70, 50)

  add('packets: before it leaves, nothing is in flight and the race holds the stock of both colonies', () => {
    const { empire } = BEFORE()

    return same([value(empire.stock), value(empire.inFlight), value(empire.held)], [120, 0, 120])
  })
  add('packets: in transit the packet is in flight to its destination and in no colony\'s stock', () => {
    const result = TRANSIT()
    const b = destinationOf(result, 2)

    return same([value(result.empire.stock), value(result.empire.inFlight), value(b.inbound), value(b.stock), value(b.afterArrival)], [90, 30, 30, 20, 50])
  })
  add('packets: after arrival the destination\'s own stock holds it and nothing is in flight', () => {
    const result = AFTER()
    const b = destinationOf(result, 2)

    return same([value(result.empire.inFlight), value(b.inbound), value(b.stock), value(b.afterArrival)], [0, 0, 50, 50])
  })
  add('packets: the packet is counted once: the race holds the same in every phase', () => {
    const held = [BEFORE(), TRANSIT(), AFTER()].map((result) => [value(result.empire.held), value(result.empire.landed)])

    return same(held, [[120, 120], [120, 120], [120, 120]])
  })
  add('packets: the destination\'s stock after arrival is what it held plus the packet, not the race\'s total', () => {
    const before = value(destinationOf(BEFORE(), 2).afterArrival)
    const transit = value(destinationOf(TRANSIT(), 2).afterArrival)
    const after = value(destinationOf(AFTER(), 2).stock)

    return same([before, transit, after], [20, 50, 50])
  })
  add('packets: the in-flight tonnes of the destinations and of the packets bound for no colony of the race add up to the race\'s in flight', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], packets: { 2: packetRow(2, { Duranium: 30 }), 99: packetRow(99, { Duranium: 15 }) } })
    const inbound = result.destinations.reduce((total, destination) => total + value(destination.inbound), 0)

    return same([value(result.lost), value(result.empire.inFlight), inbound + value(result.lost), result.destinations.map((destination) => destination.populationId)], [15, 45, 45, [2]])
  })
  add('packets: a packet to a colony no site names is a destination of its own with nothing from sites, and credits no site', () => {
    const c = colony(3, 'C', { Duranium: 5 })
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100), c], packets: { 3: packetRow(3, { Duranium: 12 }) } })
    const destination = destinationOf(result, 3)

    return same([value(destination.inbound), value(destination.fromSites), destination.sites, value(siteOf(result, 1).supply)], [12, 0, [], 0])
  })
  add('packets: a packet with a tonnage that is not stored is unknown in flight, not 0', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], packets: { 2: packetRow(2, { Duranium: 30, MissingDuranium: 1 }) } })

    return isUnavailable(destinationOf(result, 2).inbound) && isUnavailable(result.empire.inFlight) && isUnavailable(result.empire.held) ? true : short(result.empire)
  })
  add('packets: with no packet read the race\'s in flight is unknown', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], packets: null })

    return isUnavailable(result.empire.inFlight) && isUnavailable(result.lost) ? true : short(result.empire)
  })
  add('freight: the minerals aboard ships are held by the race, so a haul between colonies changes no total, and they are assigned to no destination', () => {
    const b = (stock) => B(stock)
    const at = (aStock, bStock, cargo) => supply({ surface: [surface(1, 'A')], routes: [A(aStock, toward(b(bStock))), b(bStock)], cargo, flows: ledger([]) })
    const phases = [at(100, 20, {}), at(70, 20, { 1: 30 }), at(70, 50, {})]

    return same(phases.map((result) => [value(result.empire.held), value(result.empire.landed), value(result.empire.cargo)]), [[120, 120, 0], [120, 120, 30], [120, 120, 0]]) === true && phases.every((result) => value(destinationOf(result, 2).inbound) === 0 && value(destinationOf(result, 2).fromSites) === 0 && value(destinationOf(result, 2).afterArrival) === value(destinationOf(result, 2).stock)) ? true : short(phases.map((result) => result.empire))
  })
  add('freight: a cargo that is not stored, or no cargo read, leaves the holdings unknown, not 0', () => {
    const b = B(20)
    const held = (cargo) => supply({ surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], cargo }).empire

    return isUnavailable(held({ 1: null }).held) && isUnavailable(held({ 1: null }).cargo) && isUnavailable(held(null).held) && isUnavailable(held(null).landed) && value(held({ 2: null }).held) === 90 ? true : short([held({ 1: null }).held, held(null).held])
  })
  add('freight: the cargo of another mineral is not counted', () => {
    const b = B(20)

    return same(value(supply({ surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], cargo: { 2: 500 } }).empire.held), 90)
  })
  add('nulldest: a packet with no stored destination is held by the race and assigned to no colony', () => {
    const b = B(20)
    const known = supply({ surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], packets: { null: packetRow(null, { Duranium: 30 }) } })
    const unstored = supply({ surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], packets: { null: packetRow(null, { Duranium: 30, MissingDuranium: 1 }) } })

    return same([value(known.lost), value(known.empire.inFlight), value(known.empire.held), value(known.empire.landed), value(destinationOf(known, 2).inbound), isUnavailable(unstored.lost), isUnavailable(unstored.empire.held)], [30, 30, 120, 120, 0, true, true])
  })
  add('nulldest: a packet with no stored destination is as lost as one bound for a colony the race lacks, and the two add up', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], packets: { 2: packetRow(2, { Duranium: 30 }), 99: packetRow(99, { Duranium: 15 }), null: packetRow(null, { Duranium: 5 }) } })

    return same([value(result.lost), value(result.empire.inFlight)], [20, 50])
  })
  add('cmcunknown: bought civilian output with no stored destination is unknown: neither shipped nor kept is established', () => {
    const derived = { ...BOUGHT, MassDriverExport: 0 }
    const site = (over) => siteOf(supply({ surface: [surface(2, 'Mine', derived)], routes: [colony(1, 'Home'), colony(2, 'Mine', over)] }), 2)
    const unknown = site({ MassDriverDest: null })
    const none = site({ MassDriverDest: 0 })

    return isUnavailable(unknown.route) && isUnavailable(unknown.packetOutput) && isUnavailable(unknown.local) && value(unknown.extraction) === 300 && same([value(none.packetOutput), value(none.local), none.connection], [0, 300, 'unconnected']) === true ? true : short([unknown.packetOutput, unknown.local, none.packetOutput])
  })
  add('cmcunknown: a destination that is not stored leaves a mine without bought complexes known, and complexes that are not bought', () => {
    const mine = (row) => siteOf(supply({ surface: [surface(2, 'Mine', row)], routes: [home, colony(2, 'Mine', { MassDriverDest: null })] }), 2)
    const plain = mine({})
    const taxed = mine({ CivilianMineCount: 20, PurchaseCivilianMinerals: 0 })

    return same([value(plain.packetOutput), value(plain.local), value(taxed.packetOutput), value(taxed.local)], [0, 100, 0, 100])
  })
  add('cmcunknown: a purchase choice that is not stored leaves the packet output, the stock added and the supply of a site with a destination unknown', () => {
    const to = colony(1, 'Home', { Drivers: 1 })
    const at = (choice, over = {}) => siteOf(supply({ surface: [surface(2, 'Mine', { CivilianMineCount: 20, PurchaseCivilianMinerals: choice, MassDriverExport: choice === 1 ? 1 : 0 })], routes: [to, colony(2, 'Mine', { ...toward(to), ...over })], flows: ledger([move(2, 12, 40)]) }), 2)
    const unknowns = [at(null), at(null, { Drivers: 1 })]

    return unknowns.every((site) => isUnavailable(site.packetOutput) && isUnavailable(site.local) && isUnavailable(site.supply) && site.packetOutput.inputs.missing.some((text) => text.includes('PurchaseCivilianMinerals'))) ? true : short(unknowns.map((site) => [site.packetOutput, site.local, site.supply]))
  })
  add('cmcunknown: a purchase choice that is stored, tax or buy, leaves every figure known', () => {
    const to = colony(1, 'Home', { Drivers: 1 })
    const at = (choice) => siteOf(supply({ surface: [surface(2, 'Mine', { CivilianMineCount: 20, PurchaseCivilianMinerals: choice, MassDriverExport: choice === 1 ? 1 : 0 })], routes: [to, colony(2, 'Mine', { Drivers: 1, ...toward(to) })], flows: ledger([move(2, 12, 40)]) }), 2)
    const pick = (site) => [value(site.packetOutput), value(site.local), value(site.supply)]

    return same([pick(at(0)), pick(at(1))], [[0, 100, 40], [200, 100, 240]])
  })
  add('cmcunknown: a purchase choice that is not stored with no destination sends nothing by packet, but what the site keeps is unknown', () => {
    const site = siteOf(supply({ surface: [surface(2, 'Mine', { CivilianMineCount: 20, PurchaseCivilianMinerals: null, MassDriverExport: 0 })], routes: [colony(1, 'Home'), colony(2, 'Mine', { Drivers: 1 })], flows: ledger([]) }), 2)

    return same([value(site.packetOutput), value(site.supply), isUnavailable(site.local), site.connection], [0, 0, true, 'unconnected'])
  })
  add('scenario: a delivery of a site that does not mine the mineral reaches no destination', () => {
    const result = supply({ surface: [surface(2, 'Mine')], routes: [home, colony(2, 'Mine')], materialId: 2, entries: m.ms.scenarioEntries({ 2: { tonnes: '30', destinationId: 1 } }) })

    return same([result.sites.length, result.destinations.length, result.entries.length], [0, 0, 0])
  })

  // ----- destinations credited by the sites that name them -----
  add('destinations: each is credited by the sites whose route names it, with the ledger\'s sent tonnes, never by an origin', () => {
    const b = B(20)
    const d = colony(4, 'D', { Duranium: 1, Drivers: 1 })
    const result = supply({ surface: [surface(1, 'A'), surface(3, 'C')], routes: [A(100, toward(b)), b, colony(3, 'C', { Drivers: 1, ...toward(d) }), d], flows: ledger([move(1, 12, 300), move(3, 12, 700)]) })

    return same([value(destinationOf(result, 2).fromSites), destinationOf(result, 2).sites, value(destinationOf(result, 4).fromSites), destinationOf(result, 4).sites], [300, [1], 700, [3]])
  })
  add('destinations: a site\'s civilian packets credit the destination it names with their tonnes', () => {
    const to = colony(1, 'Home', { Duranium: 3 })
    const result = supply({ surface: [surface(2, 'Mine', BOUGHT)], routes: [to, colony(2, 'Mine', toward(to))], flows: ledger([]) })

    return same([value(destinationOf(result, 1).fromSites), destinationOf(result, 1).sites], [200, [2]])
  })
  add('destinations: the ledger\'s receipts by packet and freighter are observed apart, and an unread ledger leaves them unknown', () => {
    const b = B(20)
    const withLedger = supply({ surface: [surface(1, 'A')], routes: [A(100, toward(b)), b], flows: ledger([move(2, 13, 250), move(2, 7, 80), move(2, 12, 4)], 2) })
    const without = supply({ surface: [surface(1, 'A')], routes: [A(100, toward(b)), b], flows: null })

    return same([value(destinationOf(withLedger, 2).received), value(destinationOf(withLedger, 2).unloaded), isUnavailable(destinationOf(without, 2).received), isUnavailable(destinationOf(without, 2).unloaded)], [500, 160, true, true])
  })
  add('destinations: a colony with an observed receipt and no packet or route is shown with what it received', () => {
    const c = colony(3, 'C')
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100), c], flows: ledger([move(3, 13, 60)]) })

    return same([result.destinations.map((destination) => destination.populationId), value(destinationOf(result, 3).received)], [[3], 60])
  })

  // ----- extraction is the packet output and what stays -----
  add('conservation: extraction is the civilian output that goes into a packet plus what stays in the site\'s stock', () => {
    const to = colony(1, 'Home')
    const result = supply({ surface: [surface(2, 'Mine', BOUGHT), surface(3, 'Plain')], routes: [to, colony(2, 'Mine', toward(to)), colony(3, 'Plain')] })
    const mine = siteOf(result, 2)
    const plain = siteOf(result, 3)

    return same([[value(mine.extraction), value(mine.packetOutput), value(mine.local)], [value(plain.extraction), value(plain.packetOutput), value(plain.local)], [value(result.empire.extraction), value(result.empire.packetOutput), value(result.empire.local)]], [[300, 200, 100], [100, 0, 100], [400, 200, 200]])
  })
  add('conservation: complexes the race taxes and not buys add nothing and send nothing', () => {
    const site = siteOf(supply({ surface: [surface(2, 'Mine', { CivilianMineCount: 20, PurchaseCivilianMinerals: 0, MassDriverExport: 0 })], routes: [colony(2, 'Mine')] }), 2)

    return same([value(site.extraction), value(site.packetOutput), value(site.local)], [100, 0, 100])
  })
  add('conservation: bought output for a destination that is not a route stays in the site\'s stock', () => {
    const site = siteOf(supply({ surface: [surface(2, 'Mine', BOUGHT)], routes: [colony(2, 'Mine')] }), 2)

    return same([site.connection, value(site.extraction), value(site.packetOutput), value(site.local), value(site.supply)], ['unconnected', 300, 0, 300, 0])
  })
  add('conservation: bought output for a destination of another race, in another system or without a driver is still a packet and leaves the site\'s stock', () => {
    const cases = [{ DestinationRaceID: RACE + 1 }, { DestinationSystemID: SYSTEM + 1 }, {}]
    const sites = cases.map((over) => { const to = colony(1, 'Home'); return siteOf(supply({ surface: [surface(2, 'Mine', BOUGHT)], routes: [to, colony(2, 'Mine', toward(to, over))], flows: ledger([]) }), 2) })

    return same(sites.map((site) => [site.connection, value(site.extraction), value(site.packetOutput), value(site.local), value(site.supply)]), cases.map(() => ['packets', 300, 200, 100, 200]))
  })
  add('destinations: a destination of another race is named and shipped to but is no colony of the race: no row, and its packets are lost to the race', () => {
    const from = colony(2, 'Mine', { Drivers: 1, ...toward(colony(1, 'Captured'), { DestinationRaceID: RACE + 1 }) })
    const result = supply({ surface: [surface(2, 'Mine', BOUGHT)], routes: [from], packets: { 1: packetRow(1, { Duranium: 30 }) }, flows: ledger([]) })
    const site = siteOf(result, 2)

    return same([site.connection, site.destination && site.destination.populationId, value(site.packetOutput), value(site.supply), result.destinations.length, value(result.lost)], ['packets', 1, 200, 200, 0, 30])
  })
  add('conservation: a rate that is not known leaves the extraction and the stock added unknown, never smaller', () => {
    const site = siteOf(supply({ surface: [surface(2, 'Mine', { MineProduction: null })], routes: [colony(2, 'Mine')] }), 2)

    return isUnavailable(site.extraction) && isUnavailable(site.local) && value(site.supply) === 0 ? true : short(site)
  })
  add('conservation: the sites are by most extracted first, one for each colony with a mine of the mineral, and other minerals leave none', () => {
    const result = supply({ surface: [surface(2, 'Small'), surface(3, 'Big', { ManualMineCount: 30 }), surface(4, 'Other', { MaterialID: 2 })], routes: [colony(2, 'Small'), colony(3, 'Big'), colony(4, 'Other')] })

    return same(result.sites.map((site) => [site.name, value(site.extraction)]), [['Big', 300], ['Small', 100]])
  })

  // ----- the totals take no transfer as income -----
  const mining = minerals.FLOW_GROUPS.find((group) => group.key === 'mining')
  const spend = minerals.FLOW_GROUPS.find((group) => !group.income)
  const DAY = 86400
  const meta = { FirstTime: 100 * DAY, LastTime: 400 * DAY, ProductionTicks: 4, FirstTick: 100 * DAY, LastTick: 400 * DAY }
  const LEDGER_ROWS = [{ MaterialID: 1, MineralDataType: mining.types[0], Amount: 600, ...meta }, { MaterialID: 1, MineralDataType: spend.types[0], Amount: 200, ...meta }]
  const TRANSFER_ROWS = [7, 8, 12, 13].map((type) => ({ MaterialID: 1, MineralDataType: type, Amount: 5000, ...meta }))
  const outlookOf = (rows) => minerals.mineralOutlook({ ledger: rows, gameTime: 400 * DAY, windowDays: 365, stock: { 1: 100 }, transit: { 1: 0 } })

  add('neutral: the ledger\'s transfers between colonies add no income and no use: the flows are the same with them', () => {
    const base = outlookOf(LEDGER_ROWS)
    const moved = outlookOf([...LEDGER_ROWS, ...TRANSFER_ROWS])
    const pick = (result) => [result.known, result.minerals[1].produced, result.minerals[1].used, result.minerals[1].net]

    return base.known === true && base.minerals[1].produced > 0 && base.minerals[1].used > 0 ? same(pick(moved), pick(base)) : short(pick(base))
  })
  add('neutral: the observed moves change none of the race\'s totals: extraction, stock added, stock and in flight stay as they were', () => {
    const b = B(20)
    const args = { surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], packets: { 2: packetRow(2, { Duranium: 30 }) } }
    const quiet = supply({ ...args, flows: null }).empire
    const busy = supply({ ...args, flows: ledger([move(1, 12, 900), move(2, 13, 900), move(1, 8, 40), move(2, 7, 40)]) }).empire
    const pick = (empire) => [value(empire.extraction), value(empire.packetOutput), value(empire.local), value(empire.stock), value(empire.inFlight), value(empire.held)]

    return same(pick(busy), pick(quiet))
  })

  // ----- the ledger as observed -----
  add('observed: the ledger\'s tonnes are annualised by the factor of the window and kept apart by type', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100, toward(b)), b], flows: ledger([move(1, 12, 500), move(1, 8, 70), move(1, 13, 11), move(1, 7, 3)], 365 / 90) })
    const site = siteOf(result, 1)

    return sameNumber(value(site.sent), 500 * 365 / 90) === true && sameNumber(value(site.loaded), 70 * 365 / 90) === true ? true : short([site.sent, site.loaded])
  })
  add('observed: without a ledger every observed figure is unknown, not 0', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100, toward(b)), b], flows: null })
    const site = siteOf(result, 1)
    const destination = destinationOf(result, 2)

    return [site.sent, site.loaded, destination.received, destination.unloaded].every(isUnavailable) ? true : short([site.sent, site.loaded, destination.received])
  })
  add('observed: a ledger that covers no days leaves them unknown too', () => {
    const flows = ms.transferFlows([move(1, 12, 500)], 0)
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100, toward(b)), b], flows })

    return flows.perYear === null && isUnavailable(siteOf(result, 1).sent) ? true : short(flows)
  })
  add('observed: a sum with a term not stored is unknown, a colony and mineral with no entry moved none', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100, toward(b)), b], flows: ledger([move(1, 12, null), move(2, 13, 4)]) })

    return isUnavailable(siteOf(result, 1).sent) && value(siteOf(result, 1).loaded) === 0 && value(destinationOf(result, 2).received) === 4 ? true : short(siteOf(result, 1).sent)
  })
  add('observed: the moves of another mineral are not counted', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100, toward(b)), b], flows: ledger([move(1, 12, 500, 2), move(2, 13, 9, 3)]) })

    return same([value(siteOf(result, 1).sent), value(destinationOf(result, 2).received)], [0, 0])
  })
  add('observed: the figures are confirmed values of the ledger, the supply an estimate', () => {
    const b = B(20)
    const site = siteOf(supply({ surface: [surface(1, 'A')], routes: [A(100, toward(b)), b], flows: ledger([move(1, 12, 500)]) }), 1)

    return same([site.sent.status, site.sent.rule.id, site.supply.status, site.supply.rule.id], ['confirmed', 'mineralSupply.shipped', 'estimated', 'mineralSupply.supply'])
  })

  // ----- the hypothetical deliveries -----
  const scenarios = (inputs) => ms.scenarioEntries(inputs)

  add('scenario: a blank delivery is nothing entered: no entry', () => same([scenarios({}), scenarios(null), scenarios({ 1: { tonnes: '', destinationId: 2 } }), scenarios({ 1: { tonnes: '   ', destinationId: 2 } }), scenarios({ 1: { tonnes: null, destinationId: 2 } }), scenarios({ 1: { destinationId: 2 } })], [[], [], [], [], [], []]))
  add('scenario: a delivery of 0 is a real entry, not a blank', () => {
    const [entry] = scenarios({ 1: { tonnes: '0', destinationId: 2 } })

    return same([entry.state, entry.result.value], ['applied', 0])
  })
  add('scenario: a negative or non-numeric delivery is invalid', () => same(['-5', 'abc', 'Infinity', '1e999'].map((tonnes) => scenarios({ 1: { tonnes, destinationId: 2 } })[0].state), ['invalid', 'invalid', 'invalid', 'invalid']))
  add('scenario: a delivery with no colony is incomplete, and no colony is assumed', () => same(['', null, undefined].map((destinationId) => scenarios({ 1: { tonnes: '40', destinationId } })[0]).map((entry) => [entry.state, entry.destinationId, entry.result]), [['incomplete', null, null], ['incomplete', null, null], ['incomplete', null, null]]))
  add('scenario: an applied delivery is an assumed figure with its hypothetical named', () => {
    const [entry] = scenarios({ 1: { tonnes: '40', destinationId: 2 } })

    return same([entry.state, entry.result.status, entry.result.value, entry.result.assumptions.length > 0 && /hypothetical/.test(entry.result.assumptions.join(' '))], ['applied', 'assumed', 40, true])
  })
  add('scenario: the delivery lowers what the site keeps, which may go below 0 when it draws on stock', () => {
    const b = B(20)
    const routes = [colony(1, 'A', { Duranium: 100 }), b]
    const small = siteOf(supply({ surface: [surface(1, 'A')], routes, entries: scenarios({ 1: { tonnes: '40', destinationId: 2 } }) }), 1)
    const large = siteOf(supply({ surface: [surface(1, 'A')], routes, entries: scenarios({ 1: { tonnes: '150', destinationId: 2 } }) }), 1)
    const none = siteOf(supply({ surface: [surface(1, 'A')], routes, entries: scenarios({ 1: { tonnes: '', destinationId: 2 } }) }), 1)

    return same([value(small.keeps), small.exceeds, value(large.keeps), large.exceeds, none.keeps, none.scenario], [60, false, -50, true, null, null])
  })
  add('scenario: the destination shows the delivery apart from what the sites send and adds them in its own column', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100, toward(b)), b], flows: ledger([move(1, 12, 300)]), entries: scenarios({ 1: { tonnes: '40', destinationId: 2 } }) })
    const destination = destinationOf(result, 2)

    return same([value(destination.fromSites), value(destination.scenario), value(destination.withScenario), destination.scenario.status], [300, 40, 340, 'assumed'])
  })
  add('scenario: a delivery to a colony no route names credits it only as a hypothetical: the confirmed supply stays 0', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100), b], entries: scenarios({ 1: { tonnes: '40', destinationId: 2 } }) })
    const destination = destinationOf(result, 2)

    return same([value(destination.fromSites), value(destination.scenario), value(destination.withScenario), value(siteOf(result, 1).supply), siteOf(result, 1).connection], [0, 40, 40, 0, 'unconnected'])
  })
  add('scenario: no entered delivery changes a confirmed figure: sites, destinations and the race\'s totals', () => {
    const b = B(20)
    const args = { surface: [surface(1, 'A')], routes: [A(70, toward(b)), b], packets: { 2: packetRow(2, { Duranium: 30 }) }, flows: ledger([move(1, 12, 300), move(2, 13, 100)]) }
    const quiet = supply(args)
    const busy = supply({ ...args, entries: scenarios({ 1: { tonnes: '40', destinationId: 2 } }) })
    const sitePick = (result) => result.sites.map((site) => [value(site.extraction), value(site.local), value(site.supply), value(site.sent)])
    const destinationPick = (result) => result.destinations.map((destination) => [value(destination.stock), value(destination.inbound), value(destination.afterArrival), value(destination.fromSites), value(destination.received)])
    const empirePick = (result) => ['extraction', 'packetOutput', 'local', 'stock', 'inFlight', 'held', 'landed'].map((key) => value(result.empire[key]))

    return same([sitePick(busy), destinationPick(busy), empirePick(busy)], [sitePick(quiet), destinationPick(quiet), empirePick(quiet)])
  })
  add('scenario: an invalid or incomplete delivery is kept as an entry that says so and counts for nothing', () => {
    const b = B(20)
    const result = supply({ surface: [surface(1, 'A')], routes: [A(100), b], entries: scenarios({ 1: { tonnes: '-3', destinationId: 2 } }) })

    return same([siteOf(result, 1).scenario.state, siteOf(result, 1).keeps, result.destinations.length], ['invalid', null, 0])
  })

  // ----- the loaders on a stand-in database -----
  const standIn = (answers) => {
    const log = []

    return { log, query: async (sql) => { log.push(sql); return [answers.find(([pattern]) => pattern.test(sql))[1]] } }
  }

  add('loaders: a save without the ledger has no moves and asks no more than the table', async () => {
    const database = standIn([[/sqlite_master/, [{ Present: 0 }]], [/FCT_RaceMineralData/, [{ PopulationID: 1 }]]])
    const rows = await ms.loadTransfers(database, { GameID: 3, RaceID: RACE, windowDays: 30 })

    return same([rows, database.log.length], [[], 1])
  })
  add('loaders: the ledger read takes the race\'s moves of the four entry types inside the window, summed by colony, mineral and type', async () => {
    const database = standIn([[/sqlite_master/, [{ Present: 1 }]], [/FCT_RaceMineralData/, [move(1, 12, 5)]]])
    const rows = await ms.loadTransfers(database, { GameID: 3, RaceID: RACE, windowDays: 30 })
    const sql = database.log[1]

    return rows.length === 1 && sql.includes('MineralDataType in (7, 8, 12, 13)') && sql.includes('GameTime - 2592000') && sql.includes('GameID = 3') && sql.includes(`RaceID = ${RACE}`) && /group by FCT_RaceMineralData\.PopulationID, FCT_RaceMineralData\.MineralID, FCT_RaceMineralData\.MineralDataType/.test(sql) && sql.includes('count(FCT_RaceMineralData.Amount) = count(*)') ? true : sql
  })
  add('loaders: the colonies read is the race\'s own, with its destination and the drivers at the site', async () => {
    const database = standIn([[/FCT_Population/, [colony(1, 'A')]]])
    const rows = await ms.loadSiteRoutes(database, { GameID: 3, RaceID: RACE })
    const sql = database.log[0]

    return rows.length === 1 && sql.includes('FCT_Population.GameID = 3') && sql.includes(`FCT_Population.RaceID = ${RACE}`) && sql.includes('MassDriverDest') && sql.includes('DriverGaps') && sql.includes('FCT_Population.Duranium') && sql.includes('FCT_Population.Gallicite') ? true : sql
  })
  add('loaders: the colonies read names no reserve column, so a save without the reserves still reads', async () => {
    const database = standIn([[/FCT_Population/, [colony(1, 'A')]]])

    await ms.loadSiteRoutes(database, { GameID: 3, RaceID: RACE })

    return /Reserve/.test(database.log[0]) ? database.log[0] : true
  })
  add('loaders: the destination\'s drivers are not read: the destination\'s own drivers decide nothing', async () => {
    const database = standIn([[/FCT_Population/, []]])

    await ms.loadSiteRoutes(database, { GameID: 3, RaceID: RACE })

    return !/DestinationDrivers/.test(database.log[0]) && /VIR_Drivers on VIR_Drivers\.PopID = FCT_Population\.PopulationID/.test(database.log[0]) ? true : database.log[0]
  })

  return statements
}

// ---------- the panel ----------

const panel = (ctx) => {
  const { m, componentText } = ctx
  const f = fixtures(m)
  const { colony, toward, surface, BOUGHT, packetRow, ledger, move, supply } = f
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const events = []
  const mount = (data = {}) => instantiate(ctx.options, { $store: STORE, data: { mineral: { id: 1, name: 'Duranium' }, colonies: [{ id: 1, name: 'Home' }], scenario: {}, supply: null, ...data } })
  const tag = (text, name) => (text.match(new RegExp(`<${name}\\b[^>]*>`)) || [''])[0]
  const home = colony(1, 'Home', { Duranium: 100 })
  const mine = colony(2, 'Mine', toward(home))
  const lone = colony(3, 'Lone')
  const result = (extra = {}) => supply({ surface: [surface(2, 'Mine', BOUGHT), surface(3, 'Lone')], routes: [home, mine, lone], packets: { 1: packetRow(1, { Duranium: 12 }), 99: packetRow(99, { Duranium: 8 }) }, flows: ledger([move(2, 8, 5)]), ...extra })

  add('panel: a site\'s row carries its route, its figures as numbers and their results, and null for what is not known', () => {
    const vm = mount({ supply: result() })
    const row = vm.siteRows.find((item) => item.populationId === 2)
    const lonely = vm.siteRows.find((item) => item.populationId === 3)

    return same([row.connectionRank, row.extraction, row.packetOutput, row.local, row.supply, row.loaded, row.destinationName], [0, 300, 200, 100, 200, 5, 'Home']) === true && same([lonely.connectionRank, lonely.supply, lonely.local, lonely.destinationName], [2, 0, 100, '']) === true && row.extractionResult !== null && row.supplyResult.rule.id === 'mineralSupply.supply' ? true : short([row, lonely])
  })
  add('panel: a site with no packet route says why, and one whose route is not known says what is missing', () => {
    const vm = mount({ supply: result({ routes: [home, colony(2, 'Mine', { MassDriverDest: null }), lone], surface: [surface(2, 'Mine'), surface(3, 'Lone')] }) })
    const unknown = vm.siteRows.find((item) => item.populationId === 2)
    const lonely = vm.siteRows.find((item) => item.populationId === 3)

    return unknown.connectionRank === null && unknown.gaps.some((text) => text.includes('MassDriverDest')) && lonely.reason === 'No destination' && unknown.view.label === 'Route not known' ? true : short([unknown.gaps, lonely.reason])
  })
  add('panel: a figure that is not known is null with its result kept, never 0', () => {
    const vm = mount({ supply: result({ surface: [surface(3, 'Lone', { MineProduction: null })] }) })
    const row = vm.siteRows.find((item) => item.populationId === 3)

    return row.extraction === null && row.local === null && row.extractionResult.status === 'unavailable' && row.supply === 0 ? true : short(row)
  })
  add('panel: the destinations carry what they hold, what is on its way, what the sites send and the delivery entered', () => {
    const vm = mount({ supply: result({ entries: [] }) })
    const row = vm.destinationRows.find((item) => item.populationId === 1)

    return same([row.stock, row.inbound, row.afterArrival, row.fromSites, row.scenario, row.withScenario, row.sitesText], [100, 12, 112, 200, null, null, '1 site names it by route']) === true && row.afterArrivalResult.rule.id === 'mineralSupply.afterArrival' ? true : short(row)
  })
  add('panel: the tiles give the race\'s extraction, packet output, stock added, stock, in flight and held, each with its result', () => {
    const vm = mount({ supply: result() })

    return same(vm.tiles.map((tile) => [tile.label, tile.value]), [['Extracted a year', '400 t'], ['Straight into packets a year', '200 t'], ['Added to own stock a year', '200 t'], ['In stock', '100 t'], ['In flight', '20 t'], ['Aboard ships', '0 t'], ['Held in all', '120 t']]) === true && vm.tiles.every((tile) => tile.result && tile.result.rule) ? true : short(vm.tiles.map((tile) => [tile.label, tile.value]))
  })
  add('panel: a total that is not known shows a dash, not 0 t', () => {
    const vm = mount({ supply: result({ packets: null }) })
    const tile = vm.tiles.find((item) => item.label === 'In flight')

    return tile.value === '—' ? true : tile.value
  })
  add('panel: tonnes in packets bound for a colony the race lacks are named in a line of their own', () => {
    const lost = mount({ supply: result() })
    const none = mount({ supply: result({ packets: { 1: packetRow(1, { Duranium: 12 }) } }) })

    return lost.lostText.startsWith('8 t') && lost.lostText.includes('does not have') && none.lostText === '' ? true : short([lost.lostText, none.lostText])
  })
  add('panel: a delivery entered is emitted with the others kept, a blank colony as no colony', () => {
    events.length = 0

    const vm = mount({ supply: result(), scenario: { 3: { tonnes: '5', destinationId: 1 } } })

    const emitting = new Proxy(vm, { get: (target, key) => (key === '$emit' ? (name, payload) => events.push([name, payload]) : target[key]) })

    ctx.options.methods.change.call(emitting, 2, { tonnes: '40' })
    ctx.options.methods.change.call(emitting, 2, { destinationId: null })

    return same(events, [['update:scenario', { 3: { tonnes: '5', destinationId: 1 }, 2: { tonnes: '40', destinationId: null } }], ['update:scenario', { 3: { tonnes: '5', destinationId: 1 }, 2: { tonnes: '', destinationId: null } }]])
  })
  add('panel: what an entered delivery means is said: kept, drawing on stock, invalid, incomplete', () => {
    const look = (tonnes, destinationId) => mount({ supply: result({ entries: m.ms.scenarioEntries({ 3: { tonnes, destinationId } }) }) }).siteRows.find((row) => row.populationId === 3)

    return look('40', 1).scenarioText === 'The site would keep 60 t/yr in its own stock' && look('150', 1).scenarioText.includes('draws on stock') && look('-1', 1).scenarioText.includes('0 or more') && look('7', null).scenarioText.includes('Pick the colony') && look('150', 1).scenarioTone === 'warning' && look('40', 1).scenarioTone === '' && look('', 1).scenarioText === '' ? true : short(['40', '150', '-1'].map((tonnes) => look(tonnes, 1).scenarioText))
  })
  add('panel: the scenario field gives its stored text and no colony for a site with none entered', () => {
    const vm = mount({ supply: result(), scenario: { 2: { tonnes: '40', destinationId: 1 } } })

    return same([vm.inputOf(2), vm.inputOf(3)], [{ tonnes: '40', destinationId: 1 }, { tonnes: '', destinationId: null }])
  })
  add('panel: the tables\' sort defaults are held as views of their own', () => {
    const vm = mount()

    return same([vm.sitesTable, vm.destinationsTable], [{ sortBy: ['extraction'], sortDesc: true }, { sortBy: ['inbound'], sortDesc: true }])
  })

  // ----- the template, read as text -----
  const text = componentText
  const startTag = tag(text, 'v-card')
  const summary = (startTag.match(/data-summary="([^"]*)"/) || [])[1] || ''
  const foot = (text.match(/<div class="panel-foot[^>]*>([\s\S]*?)<\/div>/) || [])[1] || ''
  const template = (text.match(/<template>([\s\S]*)<\/template>\s*<script>/) || [])[1] || ''

  add('panel-template: the panel is a top-level .panel with a data-summary that has no digit and no first or second person', () => (/class="panel mineral-supply"/.test(startTag) && summary.length > 80 && !/\d/.test(summary) && !PRONOUNS.test(summary) ? true : summary))
  add('panel-template: the foot says what the figures are: stock, packets with no origin, transfers not income, freighters, hypothetical deliveries, unknown not 0', () => ['own stock', 'carries no origin', 'as income', 'freighter', 'hypothetical delivery', 'never 0', 'no packet route adds to its own stock'].filter((phrase) => !foot.includes(phrase)).map((phrase) => `the foot lacks "${phrase}"`).join('; ') || true)
  add('panel-template: the foot is in the UI voice: no first or second person', () => (PRONOUNS.test(foot.replace(/<[^>]*>/g, '')) ? 'the foot speaks to a person' : true))
  add('panel-template: the template compiles', () => { const errors = templateErrors(text); return errors.length ? short(errors) : true })
  add('panel-template: every figure carries its mark: the sites\' and destinations\' figures, known and not, the route, the delivery, the lost tonnes and the rules of the heads', () => {
    const figureMarks = (text.match(/<provenance-mark (?:v-if="[^"]*" )?:result="item\[`\$\{column\}Result`\]"/g) || []).length
    const missing = ['<provenance-mark :result="item.route" />', '<provenance-mark v-if="item.scenarioResult" :result="item.scenarioResult" />', '<provenance-mark :result="supply.lost" />', 'rule="mineralSupply.supply"', 'rule="mineralSupply.localStock"', 'rule="mineralSupply.afterArrival"', 'result: empire.extraction', 'result: empire.held'].filter((mark) => !(template + text).includes(mark))

    return figureMarks === 4 && !missing.length ? true : `${figureMarks} figure marks of 4; no mark ${missing.join('; ')}`
  })
  add('panel-template: both tables key their rows and sort the unknown last, and the headers are the columns the rows have', () => {
    const vm = mount({ supply: result() })
    const sites = vm.siteRows[0]
    const destinations = vm.destinationRows[0]
    const missingSite = vm.siteHeaders.filter((header) => header.sortable !== false && !(header.value in sites)).map((header) => header.value)
    const missingDestination = vm.destinationHeaders.filter((header) => header.sortable !== false && !(header.value in destinations)).map((header) => header.value)

    return missingSite.length || missingDestination.length ? short([missingSite, missingDestination]) : (text.match(/:custom-sort="sortNullLast"/g) || []).length === 2 && text.includes('item-key="key"') && text.includes('item-key="populationId"') ? true : 'the tables\' keys or sorts changed'
  })
  add('panel-template: the delivery inputs leave a blank as nothing and hold the entered text', () => (text.includes(':value="inputOf(item.populationId).tonnes"') && text.includes('type="number" min="0"') && text.includes('clearable') && text.includes('@input="change(item.populationId, { tonnes: $event })"') ? true : 'the delivery field changed'))
  add('panel-template: the view fields have the keys of the preferences: the sites\' and the destinations\' tables', () => same([...text.matchAll(/tableView\('(\w+)'/g)].map((match) => match[1]).sort(), ['mineralSupplyDestinationsTable', 'mineralSupplySitesTable']))

  return statements
}

// ---------- the page ----------

const page = (ctx) => {
  const { m, pageText, pageOptions } = ctx
  const f = fixtures(m)
  const { value, colony, toward, surface, packetRow, move, admins } = f
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const mount = (data = {}) => instantiate(pageOptions, { $store: STORE, data })
  const mountTag = (pageText.match(/<mineral-supply\b[^>]*>/) || [''])[0]
  const labels = (pageText.match(/const INPUT_LABELS = \{([\s\S]*?)\n\}/) || [])[1] || ''
  const labelKeys = [...labels.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])
  const trackedKeys = [...pageText.matchAll(/tracked\('(\w+)'/g)].map((match) => match[1])
  const READS = ['siteRoutes', 'packetsByDestination', 'transfers']
  const home = colony(1, 'Home', { Duranium: 100, Drivers: 1 })
  const mine = colony(2, 'Mine', { Duranium: 20, Drivers: 1, ...toward(home) })
  const ready = (over = {}) => ({ RaceID: RACE, forecastReady: true, focusMineralId: 1, surfaceMining: [surface(2, 'Mine')], orbitalMining: [], navalAdmins: admins, siteRoutes: [home, mine], packetsByDestination: { 1: packetRow(1, { Duranium: 12 }) }, cargo: {}, transfers: [move(2, 12, 90)], perYear: 2, supplyScenario: {}, ...over })

  add('page: the panel is mounted once with the focused mineral, the supply, the colonies and the deliveries, and registered', () => (/:mineral="focusMineral" :supply="supply" :colonies="supplyColonies" :scenario="focusScenario" @update:scenario="enterSupplyScenario"/.test(mountTag) && (pageText.match(/<mineral-supply\b/g) || []).length === 1 && 'MineralSupply' in pageOptions.components ? true : `${mountTag} ${Object.keys(pageOptions.components)}`))
  add('page: the panel sits inside the forecast gate, where every read has loaded', () => {
    const gate = pageText.indexOf('<template v-if="forecastReady">')
    const mountAt = pageText.indexOf('<mineral-supply')
    const dialog = pageText.indexOf('<v-dialog v-model="flowsOpen"')

    return gate > 0 && gate < mountAt && mountAt < dialog ? true : short([gate, mountAt, dialog])
  })
  add('page: the template compiles', () => { const errors = templateErrors(pageText); return errors.length ? short(errors) : true })
  add('page: each read has one name as a tracked key, an asyncComputed and an INPUT_LABELS key, with its default', () => {
    const asyncKeys = Object.keys(pageOptions.asyncComputed)
    const defaults = READS.map((key) => pageOptions.asyncComputed[key] && pageOptions.asyncComputed[key].default)

    return READS.every((key) => labelKeys.includes(key) && trackedKeys.includes(key) && asyncKeys.includes(key)) && trackedKeys.every((key) => asyncKeys.includes(key) && labelKeys.includes(key)) && same(defaults, [[], {}, []]) === true ? true : short([labelKeys, trackedKeys, asyncKeys])
  })
  add('page: the ledger read of the transfers takes the window before its first await, so a window change re-runs it', () => {
    const body = (pageText.match(/transfers: \{\s*get: tracked\('transfers', async function \(\) \{([\s\S]*?)\n {6}\}\),/) || [])[1] || ''

    return /const windowDays = Number\(this\.windowDays\) \|\| 365/.test(body) && body.indexOf('const windowDays') < body.indexOf('await loadTransfers') ? true : body
  })
  add('page: the reads are of the race and game selected, and the deliveries entered are cleared with a change of either', () => {
    const reads = READS.map((key) => (pageText.match(new RegExp(`${key}: \\{\\s*get: tracked\\('${key}'[\\s\\S]*?default:`)) || [''])[0])
    const watchers = (pageText.match(/RaceID\(\) \{[\s\S]*?\n {4}\},\n {4}GameID\(\) \{[\s\S]*?\n {4}\},/) || [''])[0]

    return reads.every((read) => read.includes('GameID: this.GameID, RaceID: this.RaceID') && read.includes('!this.database || !this.GameID || !this.RaceID')) && (watchers.match(/this\.supplyScenario = \{\}/g) || []).length === 2 ? true : short([reads.map((read) => read.length), watchers])
  })
  add('page: the supply is the focused mineral\'s, from the page\'s own mining rows, reads and deliveries, annualised by the page\'s ledger factor', () => {
    const vm = mount(ready())
    const result = vm.supply
    const site = result.sites[0]

    return same([result.sites.length, value(site.extraction), value(site.sent), value(site.supply), value(result.empire.inFlight), result.destinations.map((destination) => destination.populationId), value(result.destinations[0].inbound)], [1, 100, 180, 180, 12, [1], 12])
  })
  add('page: no focused mineral or an unfinished read gives no supply', () => same([mount(ready({ focusMineralId: null })).supply, mount(ready({ forecastReady: false })).supply], [null, null]))
  add('page: a ledger that covers no days leaves the observed supply unknown, not 0', () => {
    const vm = mount(ready({ perYear: null }))
    const site = vm.supply.sites[0]

    return !m.provenance.isAvailable(site.sent) && !m.provenance.isAvailable(site.supply) && value(site.local) === 100 ? true : short(site)
  })
  add('page: the deliveries entered reach the supply, and a blank one reaches nothing', () => {
    const vm = mount(ready({ supplyScenario: { 1: { 2: { tonnes: '30', destinationId: 1 } } } }))
    const blank = mount(ready({ supplyScenario: { 1: { 2: { tonnes: '', destinationId: 1 } } } }))

    return same([value(vm.supply.sites[0].keeps), value(vm.supply.destinations[0].withScenario), blank.supply.sites[0].scenario], [70, 210, null])
  })
  add('page: the deliveries entered for one mineral never reach another, a mineral the source does not mine included', () => {
    const entered = { 1: { 2: { tonnes: '30', destinationId: 1 } } }
    const other = mount(ready({ focusMineralId: 2, supplyScenario: entered }))
    const both = mount(ready({ focusMineralId: 2, surfaceMining: [surface(2, 'Mine'), surface(2, 'Mine', { MaterialID: 2 })], supplyScenario: entered }))
    const back = mount(ready({ supplyScenario: entered }))

    return same([other.supply.sites.length, other.supply.destinations.length, other.supply.entries.length, both.supply.sites.length, both.supply.entries.length, both.supply.destinations.some((destination) => destination.scenario !== null), value(back.supply.destinations[0].scenario)], [0, 0, 0, 1, 0, false, 30])
  })
  add('page: entering a delivery stores it under the focused mineral and keeps the other minerals\' entries', () => {
    const vm = mount(ready({ focusMineralId: 2, supplyScenario: { 1: { 2: { tonnes: '30', destinationId: 1 } } } }))

    vm.enterSupplyScenario({ 2: { tonnes: '5', destinationId: 1 } })

    return same([vm.supplyScenario, vm.focusScenario], [{ 1: { 2: { tonnes: '30', destinationId: 1 } }, 2: { 2: { tonnes: '5', destinationId: 1 } } }, { 2: { tonnes: '5', destinationId: 1 } }])
  })
  add('page: the ships\' cargo read reaches the race\'s holdings', () => {
    const held = (cargo) => value(mount(ready({ cargo })).supply.empire.held)

    return same([held({}), held({ 1: 40 }), held({ 1: null })], [100 + 20 + 12, 100 + 20 + 12 + 40, null])
  })
  add('page: the colonies a delivery can go to are the race\'s, by name', () => same(mount(ready({ siteRoutes: [mine, home] })).supplyColonies, [{ id: 1, name: 'Home' }, { id: 2, name: 'Mine' }]))
  add('page: the race\'s totals are still built from the holdings and the flows of the ledger, with no transfer added', () => (pageText.includes('const holdings = holdingsResult({ stockpile, cargo, packets, mineral })') && pageText.includes('flowResults({ hasLedger, coverageDays, ledger: this.ledgerFlows[mineral.id]') && pageText.includes('Freighter and mass-driver transfers between colonies aren\'t counted.') ? true : 'the totals changed'))

  return statements
}

// ---------- the saves ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows]))))
const runSql = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))
const closeRaw = (raw) => new Promise((resolve) => raw.close(resolve))

const openSave = (file, mode = sqlite3.OPEN_READONLY) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, mode, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({
      file: path.basename(resolved),
      query: (sql) => allRows(raw, sql),
      run: (sql) => runSql(raw, sql),
      close: () => closeRaw(raw),
    })
  })
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

const saveStatements = async (ctx, save) => {
  const { m } = ctx
  const { ms, mining, colony: colonyModule, provenance, minerals } = m
  const value = provenance.valueOrNull
  const database = await openSave(save.file)
  const label = save.file

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const ids = { GameID: save.game, RaceID: save.race }
  const [race] = await rowsOf(database, `select RaceID from FCT_Race where GameID = ${save.game} and RaceID = ${save.race}`)

  if (!race) {
    console.log(`SKIP  ${label}: game ${save.game} race ${save.race} is not in the file`)
    await database.close()

    return { skipped: true, statements: [] }
  }

  const read = async (db) => {
    const [surface, orbital, routes, packets] = await Promise.all([rowsOf(db, mining.surfaceMiningQuery(ids)), rowsOf(db, mining.orbitalMiningQuery(ids)), ms.loadSiteRoutes(db, ids), colonyModule.loadPacketsInFlight(db, ids)])
    const cargoRows = await rowsOf(db, `select FCT_ShipCargo.CargoID as MaterialID, case when count(FCT_ShipCargo.Amount) = count(*) then sum(FCT_ShipCargo.Amount) end as Amount from FCT_ShipCargo inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID where FCT_ShipCargo.GameID = ${save.game} and FCT_Ship.RaceID = ${save.race} and FCT_ShipCargo.CargoTypeID = 3 group by FCT_ShipCargo.CargoID`)
    const cargo = Object.fromEntries(cargoRows.map((row) => [row.MaterialID, row.Amount]))
    const [{ Present: ledgerTable }] = await rowsOf(db, "select count(*) as Present from sqlite_master where type = 'table' and name = 'FCT_RaceMineralData'")
    const transfers = await ms.loadTransfers(db, { ...ids, windowDays: 365 })

    return { surface, orbital, routes, packets, cargo, transfers, ledgerTable }
  }

  const data = await read(database)
  const names = minerals.MINERALS
  const totals = (flows, over = data) => Object.fromEntries(names.map(({ id }) => [id, ms.mineralSupply({ surface: over.surface, orbital: over.orbital, navalAdmins: {}, routes: over.routes, packets: over.packets, cargo: over.cargo, RaceID: save.race, materialId: id, flows, entries: [] })]))
  const flows = ms.transferFlows(data.transfers, 2)
  const supplies = totals(flows)
  const statements = []
  const addSave = (name, test) => statements.push([`${name.slice(0, name.indexOf(':'))}: ${label}:${name.slice(name.indexOf(':') + 1)}`, test])
  const raw = {
    stock: (await rowsOf(database, `select ${names.map(({ name }) => `sum(${name}) as ${name}`).join(', ')} from FCT_Population where GameID = ${save.game} and RaceID = ${save.race}`))[0],
    packets: await rowsOf(database, `select DestID, ${names.map(({ name }) => `sum(${name}) as ${name}`).join(', ')} from FCT_MassDriverPackets where GameID = ${save.game} and RaceID = ${save.race} group by DestID`),
    colonies: await rowsOf(database, `select PopulationID, SystemID, RaceID, MassDriverDest, (select count(*) from FCT_Population as Destination where Destination.GameID = ${save.game} and Destination.PopulationID = FCT_Population.MassDriverDest) as DestinationExists from FCT_Population where GameID = ${save.game} and RaceID = ${save.race}`),
    cargo: await rowsOf(database, `select CargoID as id, sum(Amount) as total from FCT_ShipCargo where GameID = ${save.game} and CargoTypeID = 3 and ShipID in (select ShipID from FCT_Ship where RaceID = ${save.race}) group by CargoID`),
  }
  const colonyBy = Object.fromEntries(raw.colonies.map((row) => [row.PopulationID, row]))

  addSave('save-stock: each mineral\'s stock over the colonies read is the raw sum of the race\'s colonies', () => {
    const bad = names.filter(({ id, name }) => !near(value(supplies[id].empire.stock), raw.stock[name] || 0))

    return bad.length ? short(bad.map(({ name }) => [name, value(supplies[names.find((item) => item.name === name).id].empire.stock), raw.stock[name]])) : true
  })
  addSave('save-packets: the packets in flight are the raw sums, each in one destination or in none, and no destination is another race\'s', () => {
    const bad = names.filter(({ id, name }) => {
      const { empire, destinations, lost } = supplies[id]
      const rawTotal = raw.packets.reduce((total, row) => total + (row[name] || 0), 0)
      const inbound = destinations.reduce((total, destination) => total + value(destination.inbound), 0)

      return !near(value(empire.inFlight), rawTotal) || !near(inbound + value(lost), rawTotal) || destinations.some((destination) => !colonyBy[destination.populationId] || !near(value(destination.inbound), (raw.packets.find((row) => row.DestID === destination.populationId) || {})[name] || 0))
    })

    return bad.length ? short(bad.map(({ name }) => name)) : true
  })
  addSave('save-packets: nothing is lost, counted twice or left out: the race holds stock and in flight, the same as the stock with the packets landed', () => {
    const bad = names.filter(({ id }) => !near(value(supplies[id].empire.held), value(supplies[id].empire.landed)))

    return bad.length ? short(bad.map(({ name }) => name)) : true
  })
  addSave('save-packets: the race holds the raw stock, the raw packets in flight and the raw cargo aboard its ships, and a mineral with no cargo has none', () => {
    const bad = names.filter(({ id, name }) => {
      const aboard = (raw.cargo.find((row) => row.id === id) || {}).total || 0
      const packed = raw.packets.reduce((total, row) => total + (row[name] || 0), 0)

      return !near(value(supplies[id].empire.held), (raw.stock[name] || 0) + packed + aboard) || !near(value(supplies[id].empire.cargo), aboard)
    })

    return bad.length ? short(bad.map(({ name }) => name)) : true
  })
  addSave('save-conservation: each site\'s extraction is its packet output and what it adds to its own stock, and the sites add up to the mines\' rates', () => {
    const bad = []

    names.forEach(({ id, name }) => {
      const { sites, empire } = supplies[id]
      sites.forEach((site) => {
        const dug = value(site.extraction)
        const shipped = value(site.packetOutput)
        const kept = value(site.local)

        if ((dug === null) !== (kept === null) || (dug !== null && (!near(dug, shipped + kept) || kept < -1e-6 || shipped < 0))) {
          bad.push([name, site.name, dug, shipped, kept])
        }
      })

      const rates = [...data.surface.filter((row) => row.MaterialID === id).map((row) => m.outlook.surfaceRateResult(row, true)), ...data.orbital.filter((row) => row.MaterialID === id).map((row) => m.outlook.orbitalRateResult(row, {}))]
      const all = rates.every(provenance.isAvailable)

      if (all !== provenance.isAvailable(empire.extraction) || (all && !near(value(empire.extraction), rates.reduce((total, rate) => total + rate.value, 0)))) {
        bad.push([name, 'total', value(empire.extraction), all])
      }
    })

    return bad.length ? short(bad.slice(0, 4)) : true
  })
  addSave('save-routes: a site\'s route follows the stored destination: a stock or packet route names a colony that exists, whoever owns it, and none, the site itself or a colony that is gone is no route', () => {
    const bad = []

    names.forEach(({ id }) => supplies[id].sites.forEach((site) => {
      const colony = colonyBy[site.populationId]
      const reachable = Boolean(colony) && colony.MassDriverDest > 0 && colony.MassDriverDest !== colony.PopulationID && colony.DestinationExists > 0
      const connected = site.connection === 'packets' || site.connection === 'driver'

      if (connected && !(reachable && site.destination && site.destination.populationId === colony.MassDriverDest)) {
        bad.push([site.name, site.connection, colony && colony.MassDriverDest])
      }

      if (site.connection === 'unconnected' && (value(site.supply) !== 0 || site.destination !== null)) {
        bad.push([site.name, 'unconnected supply', value(site.supply)])
      }

      if (site.connection === 'unconnected' && reachable && colony && data.routes.find((row) => row.PopulationID === site.populationId).Drivers >= 1) {
        bad.push([site.name, 'a destination that exists and a driver at the site, not seen'])
      }
    }))

    return bad.length ? short(bad.slice(0, 4)) : true
  })
  addSave('save-routes: a site whose drivers ship stock has a driver at the site in the routes read, whatever the destination has', () => {
    const rows = Object.fromEntries(data.routes.map((row) => [row.PopulationID, row]))
    const bad = []

    names.forEach(({ id }) => supplies[id].sites.filter((site) => site.connection === 'driver').forEach((site) => {
      const row = rows[site.populationId]

      if (!(row.Drivers >= 1)) {
        bad.push([site.name, row.Drivers])
      }
    }))

    return bad.length ? short(bad.slice(0, 4)) : true
  })
  addSave('save-loaders: the routes read has one frozen row for each colony of the race, and the packets read one for each destination', () => (data.routes.length === raw.colonies.length && Object.isFrozen(data.routes) && Object.keys(data.packets).length === raw.packets.length ? true : short([data.routes.length, raw.colonies.length, Object.keys(data.packets).length, raw.packets.length])))
  addSave('save-neutral: the ledger\'s moves change no total of the race: with and without them extraction, stock added, stock and in flight are the same', () => {
    const quiet = totals(null)
    const bad = names.filter(({ id }) => ['extraction', 'packetOutput', 'local', 'stock', 'inFlight', 'held'].some((key) => value(quiet[id].empire[key]) !== value(supplies[id].empire[key])))

    return bad.length ? short(bad.map(({ name }) => name)) : true
  })

  if (data.ledgerTable) {
    const types = [7, 8, 12, 13]
    const grouped = async (days) => rowsOf(database, `select MineralDataType, MineralID, PopulationID, sum(Amount) as Amount from FCT_RaceMineralData inner join FCT_Game on FCT_Game.GameID = FCT_RaceMineralData.GameID where FCT_RaceMineralData.GameID = ${save.game} and RaceID = ${save.race} and MineralDataType in (${types.join(', ')}) and Time > FCT_Game.GameTime - ${days * 86400} group by PopulationID, MineralID, MineralDataType`)
    const rawRows = await grouped(365)
    const total = (rows, type) => rows.filter((row) => row.MineralDataType === type).reduce((sum, row) => sum + row.Amount, 0)

    addSave('save-ledger: the transfers read is the raw sum of the four entry types by colony, mineral and type over the window', () => {
      const bad = types.filter((type) => !near(total(data.transfers, type), total(rawRows, type)))

      return data.transfers.length === rawRows.length && !bad.length && data.transfers.every((row) => types.includes(row.MineralDataType)) ? true : short([data.transfers.length, rawRows.length, bad])
    })
    addSave('save-ledger: a shorter window reads fewer or the same moves, as the raw read does', async () => {
      const month = await ms.loadTransfers(database, { ...ids, windowDays: 30 })
      const rawMonth = await grouped(30)
      const bad = types.filter((type) => !near(total(month, type), total(rawMonth, type)) || total(month, type) > total(data.transfers, type) + 1e-6)

      return bad.length ? short(bad) : true
    })
    addSave('save-ledger: the observed sends and receipts are the ledger\'s tonnes times the factor, summed over the sites and the destinations', () => {
      const raws = (id, type, who) => rawRows.filter((row) => row.MineralID === id && row.MineralDataType === type && who.some((entry) => entry.populationId === row.PopulationID)).reduce((sum, row) => sum + row.Amount, 0) * 2
      const bad = names.filter(({ id }) => {
        const { sites, destinations } = supplies[id]
        const total = (list, key) => list.reduce((sum, entry) => sum + (value(entry[key]) || 0), 0)

        return !near(total(sites, 'sent'), raws(id, 12, sites)) || !near(total(sites, 'loaded'), raws(id, 8, sites)) || !near(total(destinations, 'received'), raws(id, 13, destinations)) || !near(total(destinations, 'unloaded'), raws(id, 7, destinations))
      })

      return bad.length ? short(bad.map(({ name }) => name)) : true
    })
  }

  let close = () => database.close()

  if (save.copy) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-supply-'))
    const copy = path.join(folder, 'copy.db')

    fs.copyFileSync(path.resolve(root, save.file), copy)
    close = async () => {
      await database.close()
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }

    const withCopy = async (statement, work) => {
      const edited = await openSave(copy, sqlite3.OPEN_READWRITE)

      try {
        await edited.run(statement)

        return await work(edited)
      } finally {
        await edited.close()
      }
    }

    addSave('save-unconnected: on a copy with every destination cleared no site has a route: each adds its extraction to its own stock and supplies no destination', async () => {
      const results = await withCopy('update FCT_Population set MassDriverDest = 0', async (edited) => totals(flows, await read(edited)))
      const sites = names.flatMap(({ id }) => results[id].sites)
      const bad = sites.filter((site) => site.connection !== 'unconnected' || value(site.supply) !== 0 || value(site.packetOutput) !== 0 || site.destination !== null || (value(site.extraction) !== null && !near(value(site.local), value(site.extraction))))
      const fed = names.flatMap(({ id }) => results[id].destinations.filter((destination) => destination.sites.length || value(destination.fromSites) !== 0))
      const empires = names.filter(({ id }) => !near(value(results[id].empire.local), value(results[id].empire.extraction)) && value(results[id].empire.extraction) !== null)

      return sites.length > 0 && !bad.length && !fed.length && !empires.length ? true : short([sites.length, bad.slice(0, 2).map((site) => [site.name, site.connection, value(site.supply)]), fed.length, empires.map(({ name }) => name)])
    })
    addSave('save-unconnected: on a copy with every destination cleared the packets in flight stay in flight, bound for their colonies, and the race\'s totals are those of the save', async () => {
      const results = await withCopy('update FCT_Population set MassDriverDest = 0', async (edited) => totals(flows, await read(edited)))
      const bad = names.filter(({ id }) => ['inFlight', 'stock', 'held'].some((key) => value(results[id].empire[key]) !== value(supplies[id].empire[key])))

      return bad.length ? short(bad.map(({ name }) => name)) : true
    })
    addSave('save-noledger: on a copy without the ledger table no moves are read, every observed figure is unknown and the totals are unchanged', async () => {
      const rows = await withCopy('drop table if exists FCT_RaceMineralData', (edited) => ms.loadTransfers(edited, { ...ids, windowDays: 365 }))
      const none = totals(ms.transferFlows(rows, null))
      const site = names.flatMap(({ id }) => none[id].sites)[0]
      const unknown = site && !provenance.isAvailable(site.sent) && !provenance.isAvailable(site.loaded)
      const bad = names.filter(({ id }) => ['extraction', 'stock', 'inFlight'].some((keyName) => value(none[id].empire[keyName]) !== value(supplies[id].empire[keyName])))

      return rows.length === 0 && unknown && !bad.length ? true : short([rows.length, unknown, bad.map(({ name }) => name)])
    })
  }

  return { skipped: false, statements, close }
}

// ---------- the planted faults ----------

// A planted fault and the checks that must fail for it: each name is the key of a check (the text before its colon), and the fault is caught only when every one of them fails.
/* eslint-disable no-template-curly-in-string */
const MUTATIONS = [
  { name: 'an unconnected site taken as shipping stock', file: U, find: 'const state = packets ? \'packets\' : stock === \'ships\' ? \'driver\' : \'none\'', replace: 'const state = packets ? \'packets\' : \'driver\'', fails: ['route', 'unconnected'] },
  { name: 'bought output shipped by packet with no destination that exists', file: U, find: 'const packets = Boolean(civilian) && reach === true', replace: 'const packets = Boolean(civilian)', fails: ['route', 'conservation'] },
  { name: 'a driver count not stored taken as a driver', file: U, find: 'const hasDriver = (drivers, gaps) => (known(drivers) && !(gaps > 0) ? Math.floor(drivers + 1e-9) >= 1 : null)', replace: 'const hasDriver = (drivers, gaps) => (known(drivers) ? Math.floor(drivers + 1e-9) >= 1 : null)', fails: ['route'] },
  { name: 'a route that cannot be told given as none', file: U, find: 'if (!civilian || reach === null || !colony) {\n      return unavailable({ rule: \'mineralSupply.route\', missing })', replace: 'if (false) {\n      return unavailable({ rule: \'mineralSupply.route\', missing })', fails: ['route', 'unconnected'] },
  { name: 'a destination that is the colony itself reached', file: U, find: ' && destination !== colony.PopulationID', replace: '', fails: ['route'] },
  { name: 'a destination that is gone reached', file: U, find: 'destination > 0 && colony.DestinationID !== null && colony.DestinationID !== undefined &&', replace: 'destination > 0 &&', fails: ['route'] },
  { name: 'a destination that is not stored taken as none', file: U, find: 'if (!Number.isInteger(destination)) {\n    return null\n  }\n\n  return destination > 0', replace: 'if (false) {\n    return null\n  }\n\n  return destination > 0', fails: ['route'] },
  { name: 'a destination of another race refused', file: U, find: '} else if (reach === false || source === false) {', replace: '} else if (reach === false || source === false || target === \'foreign\') {', fails: ['route'] },
  { name: 'a destination in another system refused', file: U, find: '} else if (reach === false || source === false) {', replace: '} else if (reach === false || source === false || target === \'elsewhere\') {', fails: ['route'] },
  { name: 'a destination that is none, gone or the colony itself shipping stock', file: U, find: '} else if (reach === false || source === false) {', replace: '} else if (source === false) {', fails: ['route'] },
  { name: 'bought output of a destination of another race kept in the site\'s stock', file: U, find: 'const packets = Boolean(civilian) && reach === true', replace: 'const packets = Boolean(civilian) && reach === true && target !== \'foreign\'', fails: ['route', 'conservation'] },
  { name: 'a purchase choice that is not stored taken as stored', file: U, find: 'const policyMissing = complexes.some((row) => row.PurchaseCivilianMinerals === null || row.PurchaseCivilianMinerals === undefined)', replace: 'const policyMissing = false', fails: ['cmcunknown'] },
  { name: 'a purchase choice that is not stored leaves the packet output known', file: U, find: '} else if (policyMissing && reach !== false) {\n      packetOutput', replace: '} else if (false) {\n      packetOutput', fails: ['cmcunknown'] },
  { name: 'a purchase choice that is not stored with no destination leaves the packet output unknown', file: U, find: '} else if (policyMissing && reach !== false) {\n      packetOutput', replace: '} else if (policyMissing) {\n      packetOutput', fails: ['cmcunknown'] },
  { name: 'a purchase choice that is not stored leaves the stock added known', file: U, find: 'const local = policyMissing ? unavailable({ rule: \'mineralSupply.localStock\', missing: [POLICY_COLUMN] }) : combine(', replace: 'const local = combine(', fails: ['cmcunknown'] },
  { name: 'a purchase choice that is not stored leaves the supply known', file: U, find: 'if (policyMissing && reach !== false) {\n      supply = unavailable', replace: 'if (false) {\n      supply = unavailable', fails: ['cmcunknown'] },
  { name: 'the extraction of an unconnected site delivered to a destination', file: U, find: 'supply = ofRule({ rule: \'mineralSupply.supply\', value: 0, inputs: { present: [\'FCT_Population.MassDriverDest\', \'FCT_PopulationInstallations.Amount\'] } })', replace: 'supply = extraction', fails: ['unconnected', 'save-unconnected'] },
  { name: 'an unconnected site\'s capacity taken from its drivers', file: U, find: 'capacity = ofRule({ rule: \'minerals.massDriverRate\', value: 0, inputs: { present: [\'FCT_Population.MassDriverDest\', \'FCT_PopulationInstallations.Amount\'] } })\n    } else {', replace: 'capacity = massDriverRateResult(colony.Drivers, colony.DriverGaps)\n    } else {', fails: ['unconnected'] },
  { name: 'the drivers\' capacity taken for what they ship', file: U, find: 'const driverPart = ships ? sent :', replace: 'const driverPart = ships ? massDriverRateResult(colony.Drivers, colony.DriverGaps) :', fails: ['throughput'] },
  { name: 'a throughput that is not known given as 0', file: U, find: ': unavailable({ rule: \'mineralSupply.supply\', missing: [\'FCT_PopulationInstallations.Amount or DIM_PlanetaryInstallation.MassDriverValue\'] })', replace: ': ofRule({ rule: \'mineralSupply.supply\', value: 0, inputs: { present: [] } })', fails: ['throughput'] },
  { name: 'the freighter loads counted as the drivers\' sends', file: U, find: 'const sentOf = (flows, populationId, materialId) => observed(\'mineralSupply.shipped\', flows, populationId, materialId, [LEDGER_TYPES.sent])', replace: 'const sentOf = (flows, populationId, materialId) => observed(\'mineralSupply.shipped\', flows, populationId, materialId, [LEDGER_TYPES.sent, LEDGER_TYPES.loaded])', fails: ['throughput', 'observed'] },
  { name: 'the packets\' output left out of the supply', file: U, find: 'compute: ({ packets: output, drivers: sentByDrivers }) => output + sentByDrivers', replace: 'compute: ({ packets: output, drivers: sentByDrivers }) => sentByDrivers', fails: ['throughput', 'destinations'] },
  { name: 'the extraction taken as what stays in the site\'s stock', file: U, find: 'compute: ({ extraction: dug, packetOutput: shipped }) => dug - shipped', replace: 'compute: ({ extraction: dug, packetOutput: shipped }) => dug', fails: ['conservation', 'save-conservation'] },
  { name: 'the packet output taken from every kind of mine', file: U, find: 'surfaceRateResult({ ...row, ...CIVILIAN_ONLY }, true)', replace: 'surfaceRateResult(row, true)', fails: ['conservation', 'destinations'] },
  { name: 'the packet output dropped for a site whose complexes are bought', file: U, find: 'if (routed !== null && routed.state === \'packets\') {', replace: 'if (false) {', fails: ['conservation', 'throughput'] },
  { name: 'a packet counted in the destination\'s stock and in flight', file: U, find: 'compute: ({ stock, inbound }) => stock + inbound }),\n      fromSites', replace: 'compute: ({ stock, inbound }) => stock + inbound + inbound }),\n      fromSites', fails: ['packets'] },
  { name: 'a packet bound for a colony the race lacks dropped', file: U, find: 'results: lostKeys.map((key) => inFlightOf(key)) })', replace: 'results: [] })', fails: ['packets'] },
  { name: 'the packets in flight left out of what the race holds', file: U, find: 'parts: { stock, inFlight, aboard }, compute: (values) => values.stock + values.inFlight + values.aboard })', replace: 'parts: { stock, inFlight, aboard }, compute: (values) => values.stock + values.aboard })', fails: ['packets', 'save-packets'] },
  { name: 'the packets bound for no colony left out of the race\'s in flight', file: U, find: 'sumResults({ rule: \'minerals.inFlight\', results: [...inFlightByColony, lost] })', replace: 'sumResults({ rule: \'minerals.inFlight\', results: inFlightByColony })', fails: ['packets'] },
  { name: 'every site credited with every destination', file: U, find: 'const feeding = sites.filter((site) => site.destination && site.destination.populationId === id)', replace: 'const feeding = sites', fails: ['destinations', 'packets'] },
  { name: 'a destination without a route or a packet left out although it received', file: U, find: '...Object.keys(flows ? flows.table : {}).map(Number).filter((id) => receivesIn(flows, id, materialId)),', replace: '', fails: ['destinations'] },
  { name: 'a packet with a destination no site names left out', file: U, find: '...packetIds.filter((id) => valueOrNull(inFlightOf(id)) !== 0),', replace: '', fails: ['packets'] },
  { name: 'the destination of a hypothetical delivery left out', file: U, find: '...applied.map((entry) => entry.destinationId),', replace: '', fails: ['scenario'] },
  { name: 'the receipts read as the sends', file: U, find: 'export const LEDGER_TYPES = Object.freeze({ unloaded: 7, loaded: 8, sent: 12, received: 13 })', replace: 'export const LEDGER_TYPES = Object.freeze({ unloaded: 7, loaded: 8, sent: 12, received: 12 })', fails: ['observed', 'destinations', 'save-ledger'] },
  { name: 'the observed tonnes not annualised', file: U, find: 'amounts.reduce((total, amount) => total + amount, 0) * flows.perYear', replace: 'amounts.reduce((total, amount) => total + amount, 0)', fails: ['observed', 'throughput', 'page', 'save-ledger'] },
  { name: 'a ledger that is not there taken as 0', file: U, find: 'if (!flows || flows.perYear === null) {', replace: 'if (false) {', fails: ['observed', 'destinations'] },
  { name: 'a ledger amount not stored taken as 0', file: U, find: 'if (amounts.includes(null)) {', replace: 'if (false) {', fails: ['observed'] },
  { name: 'a ledger that covers no days kept', file: U, find: 'return { table, perYear: known(perYear) && perYear > 0 ? perYear : null }', replace: 'return { table, perYear: known(perYear) ? perYear : null }', fails: ['observed'] },
  { name: 'a move with no amount read as 0', file: U, find: 'mineral[row.MineralDataType] = Number.isFinite(row.Amount) ? row.Amount : null', replace: 'mineral[row.MineralDataType] = Number.isFinite(row.Amount) ? row.Amount : 0', fails: ['observed'] },
  { name: 'the moves of the saves read over every type', file: U, find: 'MineralDataType in (${TRANSFER_LIST.join(\', \')})', replace: 'MineralDataType in (7, 8, 12)', fails: ['loaders', 'save-ledger'] },
  { name: 'the ledger read over the whole history', file: U, find: 'and FCT_RaceMineralData.Time > FCT_Game.GameTime - ${windowDays * 86400}', replace: '', fails: ['loaders', 'save-ledger'] },
  { name: 'a save without the ledger asked for its moves', file: U, find: 'if (!table.Present) {', replace: 'if (false) {', fails: ['loaders', 'save-noledger'] },
  { name: 'the destination\'s drivers read again as a gate', file: U, find: 'VIR_Destination.SystemID as DestinationSystemID from', replace: 'VIR_Destination.SystemID as DestinationSystemID, 0 as DestinationDrivers from', fails: ['loaders'] },
  { name: 'the colonies read without their stock', file: U, find: 'FCT_Population.MassDriverDest, ${stocks},', replace: 'FCT_Population.MassDriverDest,', fails: ['loaders', 'save-stock'] },
  { name: 'the colonies read with the reserves, which a save may lack', file: U, find: 'FCT_Population.MassDriverDest, ${stocks},', replace: 'FCT_Population.MassDriverDest, ${stocks}, FCT_Population.ReserveDuranium,', fails: ['loaders'] },
  { name: 'a blank delivery taken as 0', file: U, find: 'if (!text) {\n    return []\n  }', replace: 'if (false) {\n    return []\n  }', fails: ['scenario'] },
  { name: 'a negative delivery accepted', file: U, find: 'if (!Number.isFinite(tonnes) || tonnes < 0) {', replace: 'if (!Number.isFinite(tonnes)) {', fails: ['scenario'] },
  { name: 'a delivery with no colony assumed to go somewhere', file: U, find: '} else if (destinationId === null) {', replace: '} else if (false) {', fails: ['scenario'] },
  { name: 'a hypothetical delivery taken for an estimate', file: U, find: 'verification: \'assumed\',\n  structure: [\'a delivery entered on the page\'],', replace: 'verification: \'estimated\',\n  structure: [\'a delivery entered on the page\'],', fails: ['scenario'] },
  { name: 'the delivery not taken from what the site keeps', file: U, find: 'compute: ({ local: added, scenario }) => added - scenario', replace: 'compute: ({ local: added, scenario }) => added', fails: ['scenario'] },
  { name: 'a hypothetical delivery counted in what the sites send', file: U, find: 'const fromSites = sumResults({ rule: \'mineralSupply.supply\', results: feeding.map((site) => site.supply) })', replace: 'const fromSites = sumResults({ rule: \'mineralSupply.supply\', results: [...feeding.map((site) => site.supply), ...applied.filter((entry) => entry.destinationId === id).map((entry) => entry.result)] })', fails: ['scenario'] },
  { name: 'an invalid delivery counted', file: U, find: 'const applied = entries.filter((entry) => entry.state === \'applied\')\n  const packetIds', replace: 'const applied = entries.filter((entry) => entry.state !== \'incomplete\')\n  const packetIds', fails: ['scenario'] },
  { name: 'the delivery\'s excess not flagged', file: U, find: 'exceeds: applied && local !== null ? applied.result.value > local : null', replace: 'exceeds: false', fails: ['scenario'] },
  { name: 'the receipts of the ledger counted as the race\'s mining income', file: M, find: 'const group = !TRANSFER_TYPES.has(row.MineralDataType) && flowGroupOf(row.MineralDataType)', replace: 'const group = row.MineralDataType === 13 ? flowGroupOf(1) : !TRANSFER_TYPES.has(row.MineralDataType) && flowGroupOf(row.MineralDataType)', fails: ['neutral'] },
  { name: 'the data-summary with a figure', file: V, find: 'data-summary="What each site extracts', replace: 'data-summary="What each of 2 sites extracts', fails: ['panel-template'] },
  { name: 'the panel without a data-summary', file: V, find: 'class="panel mineral-supply" data-summary="', replace: 'class="panel mineral-supply" data-sum="', fails: ['panel-template'] },
  { name: 'the foot without its claim about packets and origins', file: V, find: 'A packet carries no origin in the save', replace: 'A packet is short', fails: ['panel-template'] },
  { name: 'the foot without its claim about freighters', file: V, find: 'A tonne loaded into a freighter is not a tonne delivered: freighter orders are not read.', replace: 'Freighters are not read.', fails: ['panel-template'] },
  { name: 'a figure drawn without its mark', file: V, find: '<provenance-mark :result="item[`${column}Result`]" /></span>\n          <span v-else :key="column" class="text--secondary text-no-wrap">—<provenance-mark :result="item[`${column}Result`]" /></span>\n        </template>\n        <template #[`item.destinationName`]', replace: '</span>\n          <span v-else :key="column" class="text--secondary text-no-wrap">—<provenance-mark :result="item[`${column}Result`]" /></span>\n        </template>\n        <template #[`item.destinationName`]', fails: ['panel-template'] },
  { name: 'the lost tonnes without their mark', file: V, find: '{{ lostText }}<provenance-mark :result="supply.lost" />', replace: '{{ lostText }}', fails: ['panel-template'] },
  { name: 'the unknown figures not sorted last', file: V, find: ':custom-sort="sortNullLast" :sort-by.sync="sitesTable.sortBy"', replace: ':sort-by.sync="sitesTable.sortBy"', fails: ['panel-template'] },
  { name: 'the panel\'s card left unclosed', file: V, find: '  </v-card>\n</template>', replace: '  </v-cardx>\n</template>', fails: ['panel-template'] },
  { name: 'a figure that is not known drawn as 0', file: V, find: 'const numberOf = (result) => (result ? valueOrNull(result) : null)', replace: 'const numberOf = (result) => (result ? valueOrNull(result) || 0 : null)', fails: ['panel'] },
  { name: 'the connection ranks mixed', file: V, find: 'unconnected: { label: ROUTE_STATES.none, icon: \'mdi-close-circle-outline\', color: \'\', rank: 2 },', replace: 'unconnected: { label: ROUTE_STATES.none, icon: \'mdi-close-circle-outline\', color: \'\', rank: 0 },', fails: ['panel'] },
  { name: 'the other deliveries dropped when one is entered', file: V, find: '...this.scenario, [populationId]', replace: '[populationId]', fails: ['panel'] },
  { name: 'the lost tonnes not named', file: V, find: 'return lost > 0 ?', replace: 'return lost > 1e12 ?', fails: ['panel'] },
  { name: 'the panel not mounted', file: P, find: '<mineral-supply :mineral="focusMineral"', replace: '<mineral-supplyx :mineral="focusMineral"', fails: ['page'] },
  { name: 'the panel mounted outside the forecast gate', file: P, find: '<mineral-supply :mineral="focusMineral" :supply="supply" :colonies="supplyColonies" :scenario="focusScenario" @update:scenario="enterSupplyScenario" />', replace: '', fails: ['page'] },
  { name: 'the panel not registered', file: P, find: 'components: { ChartCanvas, LoadState, MineralSupply, ProvenanceMark, SeriesKey, StatTiles },', replace: 'components: { ChartCanvas, LoadState, ProvenanceMark, SeriesKey, StatTiles },', fails: ['page'] },
  { name: 'the deliveries not passed on', file: P, find: ' :scenario="focusScenario" @update:scenario="enterSupplyScenario"', replace: '', fails: ['page'] },
  { name: 'a read\'s label under another name', file: P, find: 'siteRoutes: \'the colonies\\\' mass drivers and destinations\'', replace: 'siteRoute: \'the colonies\\\' mass drivers and destinations\'', fails: ['page'] },
  { name: 'a read tracked under another name', file: P, find: 'tracked(\'packetsByDestination\'', replace: 'tracked(\'packetsByDestinations\'', fails: ['page'] },
  { name: 'the transfers read\'s window taken after the await', file: P, find: '        // Read before the first await, so a window change re-runs this getter.\n        const windowDays = Number(this.windowDays) || 365\n\n        return await loadTransfers(this.database, { GameID: this.GameID, RaceID: this.RaceID, windowDays })', replace: '        const rows = await loadTransfers(this.database, { GameID: this.GameID, RaceID: this.RaceID, windowDays: Number(this.windowDays) || 365 })\n\n        return rows', fails: ['page'] },
  { name: 'the deliveries kept across a change of race', file: P, find: '    RaceID() {\n      this.fallbackFocusId = null\n      this.supplyScenario = {}\n    },', replace: '    RaceID() {\n      this.fallbackFocusId = null\n    },', fails: ['page'] },
  { name: 'the supply of another mineral than the focused one', file: P, find: 'materialId: focusMineral.id,', replace: 'materialId: 2,', fails: ['page'] },
  { name: 'the ledger factor left out of the supply', file: P, find: 'flows: transferFlows(this.transfers, this.perYear)', replace: 'flows: transferFlows(this.transfers, 1)', fails: ['page'] },
  { name: 'the deliveries not read into the supply', file: P, find: 'entries: scenarioEntries(this.focusScenario)', replace: 'entries: []', fails: ['page'] },
  { name: 'the supply built before the reads have loaded', file: P, find: 'if (!focusMineral || !this.forecastReady) {', replace: 'if (!focusMineral) {', fails: ['page'] },
  { name: 'the colonies of a delivery not sorted by name', file: P, find: '.sort((a, b) => a.name.localeCompare(b.name))\n    },\n\n    // The focused mineral', replace: '\n    },\n\n    // The focused mineral', fails: ['page'] },
  { name: 'the cargo left out of what the race holds', file: U, find: 'compute: (values) => values.stock + values.inFlight + values.aboard })', replace: 'compute: (values) => values.stock + values.inFlight })', fails: ['freight'] },
  { name: 'the cargo left out of what lands', file: U, find: 'compute: (values) => values.held + values.lost + values.aboard })', replace: 'compute: (values) => values.held + values.lost })', fails: ['freight'] },
  { name: 'a cargo that is not stored taken as 0', file: U, find: 'return known(cargo[materialId]) ? ofRule({ rule: \'mineralSupply.cargo\', value: cargo[materialId],', replace: 'return true ? ofRule({ rule: \'mineralSupply.cargo\', value: cargo[materialId] || 0,', fails: ['freight'] },
  { name: 'no cargo read taken as no cargo', file: U, find: 'if (!cargo) {\n    return unavailable', replace: 'if (false) {\n    return unavailable', fails: ['freight'] },
  { name: 'the packets with no stored destination dropped', file: U, find: 'const lostKeys = Object.keys(packets || {}).filter((key) => !routeBy[key])', replace: 'const lostKeys = Object.keys(packets || {}).filter((key) => !routeBy[key] && key !== \'null\')', fails: ['nulldest'] },
  { name: 'the key of a packet turned into a number', file: U, find: 'results: lostKeys.map((key) => inFlightOf(key))', replace: 'results: lostKeys.map((key) => inFlightOf(Number(key)))', fails: ['nulldest'] },
  { name: 'bought output with no stored destination taken as staying local', file: U, find: 'if (routed === null && (civilian || maybeBought)) {', replace: 'if (routed === null && civilian) {', fails: ['cmcunknown'] },
  { name: 'the deliveries of a site that does not mine the mineral counted', file: U, find: 'const counted = entries.filter((entry) => found.some((site) => site.populationId === entry.populationId))', replace: 'const counted = entries', fails: ['scenario'] },
  { name: 'the deliveries of every mineral read into the focused one', file: P, find: 'return (this.focusMineral && this.supplyScenario[this.focusMineral.id]) || {}', replace: 'return Object.assign({}, ...Object.values(this.supplyScenario))', fails: ['page'] },
  { name: 'the deliveries of the other minerals dropped on an entry', file: P, find: 'this.supplyScenario = { ...this.supplyScenario, [this.focusMineralId]: inputs }', replace: 'this.supplyScenario = { [this.focusMineralId]: inputs }', fails: ['page'] },
  { name: 'the cargo not passed to the supply', file: P, find: 'cargo: this.cargo, RaceID: this.RaceID, materialId: focusMineral.id', replace: 'RaceID: this.RaceID, materialId: focusMineral.id', fails: ['page'] },
]
/* eslint-enable no-template-curly-in-string */

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, () => fs.readFileSync(file, 'utf8')]))

// The sources one run reads: the real ones, or the real ones with one planted fault.
const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((name) => [name, TEXTS[name]()]))

  if (mutant) {
    sources[mutant.file] = patched(path.basename(FILES[mutant.file]), sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

const contextOf = async (sources) => {
  const changed = (name) => sources[name] !== TEXTS[name]()
  const sourcesFor = { ...(changed(U) ? { 'mineral-supply': sources[U] } : {}), ...(changed(M) ? { minerals: sources[M] } : {}) }
  const utilitySources = { ...(changed(U) ? { 'utilities/mineral-supply': sources[U] } : {}), ...(changed(M) ? { 'utilities/minerals': sources[M] } : {}) }
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: sourcesFor })
  const modules = { 'components/charts/theme': THEME_STUB, 'mixins/production-modifiers': MIXIN_STUB }
  const options = await loadPage('components/minerals/MineralSupply', { stubs: STUBS, sources: { 'components/minerals/MineralSupply': sources[V], ...utilitySources } })
  const pageOptions = await loadPage('pages/mineral-outlook', { stubs: STUBS, modules, sources: { 'pages/mineral-outlook': sources[P], ...utilitySources } })

  return { m: { ms: loaded['mineral-supply'], outlook: loaded['mineral-outlook'], minerals: loaded.minerals, colony: loaded['colony-minerals'], mining: loaded['mining-data'], provenance: loaded.provenance }, options, pageOptions, componentText: sources[V], pageText: sources[P] }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

// The statements run, as [name, result]; `keys` limits them to the checks of those keys.
const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

let useSaves = true

const statementsOf = async (ctx, withSaves) => {
  const statements = [...pure(ctx), ...panel(ctx), ...page(ctx)]
  const opened = []
  const skipped = []

  if (withSaves && useSaves) {
    for (const save of SAVES) {
      const read = await saveStatements(ctx, save)

      if (read.skipped) {
        skipped.push(save.file)
      } else {
        statements.push(...read.statements)
        opened.push(read)
      }
    }
  }

  return { statements, opened, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, opened, skipped } = await statementsOf(ctx, true)

  console.log('\nMineral supply: extraction, export capacity and delivered supply, on colonies, mines, packets and ledger moves worked by hand, the panel, the page and the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  const keys = new Set(statements.map(([name]) => keyOf(name)))
  const bare = MUTATIONS.filter((mutation) => !mutation.fails.some((key) => !key.startsWith('save-') && keys.has(key))).map((mutation) => mutation.name)

  check('mutations: every planted fault names a group of checks that needs no save, so a checkout without the saves still catches it', bare.length ? short(bare) : true)

  for (const [name, result] of await runStatements(statements)) {
    check(name, result)
  }

  await Promise.all(opened.map((read) => read.close()))
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

  // The checks of the saves are witnesses: each must fail when its save is there, and none is needed when it is not. Every planted fault names a group that needs no save, and that group must fail whatever saves are present.
  const required = mutant.fails.filter((key) => !key.startsWith('save-'))
  const witnesses = mutant.fails.filter((key) => key.startsWith('save-'))
  const { statements, opened } = await statementsOf(ctx, witnesses.length > 0)
  const present = (key) => statements.some(([name]) => keyOf(name) === key)
  const named = [...required, ...witnesses.filter(present)]
  const absent = required.filter((key) => !present(key))
  const results = await runStatements(statements, named)
  const missed = named.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  await Promise.all(opened.map((read) => read.close()))
  check(`mutation caught: ${mutant.name}`, !required.length ? 'names no group of checks that needs no save' : absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
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

  useSaves = options.saves

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const extra = options.saves ? [] : ['--no-saves']
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...extra], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id, ...extra], weight: 3 }))])
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
