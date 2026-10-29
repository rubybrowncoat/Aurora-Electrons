/*
  Checks the supplied maintenance-supply output on the Logistics page: what a colony's maintenance facilities make over a chosen period when mining, mass-driver packets in flight and feasible hauls add the input minerals on the days they arrive (src/renderer/utilities/msp-supply.js, src/renderer/components/logistics/MspSupply.vue and its mount in src/renderer/pages/logistics.vue), and the present-stock output of src/renderer/utilities/logistics.js that it stays apart from.

  bun scripts/check-msp-supply.js [--no-mutations] [--no-saves]

  The ledger is run on colonies worked by hand. A delivery supports the production of its arrival tick and later ones, never an earlier tick, and a delivery after the period counts for nothing. Mines never supply an unlimited amount: they dig at a finite rate from a deposit, drawn on by the mines and the orbital miners together and spent at its amount. A tonne is allocated once: a packet reaches its one destination, a haul's tonnes leave the source and arrive once and are cut to what the source's own production leaves, and the ledger of every colony balances. The queue is served either first or not at all, the export takes the stock above the reserve within the drivers' capacity before the maintenance draw, and no reserve protects the maintenance draw. Both the stock-only and the supplied output name the limiting mineral and the conditional delivery. A figure the save does not hold is unknown, never 0.

  The supplied read feeds only its panel, so a failed read holds nothing back: the page, loaded with its real load-state mixin, stays ready, and the panel (its template compiled and rendered) shows the failure or the progress in place of its figures.

  The saves (saves/AuroraDB_271_skoormit_saved.db, game 138, race 785, and AuroraDB.db, game 140, race 784, read-only; a save that is not there is skipped) are optional witnesses of the real loader and of the ledger.

  Each planted fault must fail a check that needs no save and that it names. Each benign edit (wording, whitespace, the order of attributes, another default) must leave every check that needs no save green, alone, stacked and under every planted fault. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const FILES = {
  utility: path.join(root, 'src', 'renderer', 'utilities', 'msp-supply.js'),
  logistics: path.join(root, 'src', 'renderer', 'utilities', 'logistics.js'),
  component: path.join(root, 'src', 'renderer', 'components', 'logistics', 'MspSupply.vue'),
  page: path.join(root, 'src', 'renderer', 'pages', 'logistics.vue'),
  colonyMinerals: path.join(root, 'src', 'renderer', 'utilities', 'colony-minerals.js'),
}
const U = 'utility'
const L = 'logistics'
const V = 'component'
const P = 'page'
const M = 'colonyMinerals'
const NAMES = ['msp-supply', 'logistics', 'provenance', 'mineral-supply', 'minerals', 'mineral-outlook', 'colony-minerals']
const SAVES = [
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
  { file: 'AuroraDB.db', game: 140, race: 784 },
]

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const THEME_STUB = 'export const chartTheme = () => ({ categorical: [], ink: "", inkMuted: "", primary: "" }); export const withAlpha = (color) => color; export const patternImage = () => null; export const seriesIdentity = () => null'
const STORE = { getters: { config: { get: () => 'Tick' } }, state: {} }
const PAGE_STORE = { getters: { 'capabilities/blockedBonuses': new Set() }, state: { RaceNPR: false }, dispatch: async () => {} }

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
const DROPPED = new Set(['rule', 'assumptions'])

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

// True, or a text with what differed (the bounded assertion's own, shortened).
const same = (actual, expected) => {
  try {
    assert.deepEqual(actual, expected)

    return true
  } catch (error) {
    return `${short(actual)} != ${short(expected)}`
  }
}

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

const compiled = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed

  return compiler.compileTemplate({ source: descriptor.template.content, filename: 'component.vue', id: 'component' })
}

const templateErrors = (source) => compiled(source).errors.map(String)

// The root element of a compiled template, and every element in document order (the branches of a v-if chain included).
const templateAst = (source) => compiled(source).ast
const elementsOf = (ast) => {
  const found = []
  const visit = (node) => {
    if (node.type === 1) {
      found.push(node)
      node.children.forEach(visit)
      ;(node.ifConditions || []).slice(1).forEach((branch) => visit(branch.block))
      Object.values(node.scopedSlots || {}).forEach(visit)
    }
  }

  visit(ast)

  return found
}

const classesOf = (element) => (element.staticClass ? JSON.parse(element.staticClass).split(' ').filter(Boolean) : [])
const staticTextOf = (ast) => {
  const texts = []
  const visit = (node) => {
    if (node.type === 3) {
      texts.push(node.text)
    } else if (node.type === 1) {
      node.children.forEach(visit)
      ;(node.ifConditions || []).slice(1).forEach((branch) => visit(branch.block))
      Object.values(node.scopedSlots || {}).forEach(visit)
    }
  }

  visit(ast)

  return texts
}
const evaluate = (expression, instance) => require('vm').runInNewContext(`with (scope) { (${expression}) }`, { scope: instance })

// What an element binds: the props by name (`:name` or `v-bind:name`) and the handlers by event (`@event` or `v-on:event`), as the expressions written.
const bindingsOf = (element) => {
  const props = {}
  const events = {}

  Object.entries(element.attrsMap).forEach(([name, expression]) => {
    const bound = name.match(/^(?::|v-bind:)([\w-]+)$/)
    const handled = name.match(/^(?:@|v-on:)([\w-]+)$/)

    if (bound) {
      props[bound[1]] = expression
    } else if (handled) {
      events[handled[1]] = expression
    }
  })

  return { props, events }
}

const PRONOUNS = /\b(I|me|my|mine|you|your|we|our)\b/i
const GAME = 1
const RACE = 5
const SYSTEM = 1

// The haul planner's freighter timing stood in by one the checks set (`globalThis.__haulDays`: the days every class needs, null for no class that can carry the haul), so that a haul's arrival is worked from the days it is given and not from a ship design.
const haulStubbed = (text) => {
  if (!text.includes('export const haulByClass = (')) {
    throw new Error('haul-plan.js no longer exports haulByClass as a const arrow function')
  }

  return `${text.replace('export const haulByClass = (', 'const unusedHaulByClass = (')}\nexport const haulByClass = () => (globalThis.__haulDays === null ? { status: 'unavailable', holds: null, tripDays: null } : { status: 'ok', holds: globalThis.__haulHolds === undefined ? 1 : globalThis.__haulHolds, tripDays: globalThis.__haulDays === undefined ? 30 : globalThis.__haulDays })\n`
}

// ---------- the colonies worked by hand ----------

const world = (m) => {
  const { ms, lg, mo, provenance, minerals } = m
  const MIN = lg.MSP_MINERALS.map((mineral) => mineral.name)
  const PER = Object.fromEntries(lg.MSP_MINERALS.map((mineral) => [mineral.name, mineral.perMsp]))
  const ALL = minerals.MINERALS.map((mineral) => mineral.name)
  const value = provenance.valueOrNull
  // The tonnes of `name` that `msp` MSP take.
  const tonnes = (name, msp) => msp * PER[name]
  // The Logistics page's row of a maintenance colony: 10 facilities at 50 a year, 4 MSP each, so 2000 MSP a year at a modifier of 1.
  const row = (id, over = {}) => ({ PopulationID: id, PopName: `C${id}`, SystemName: 'Sol', Component: 1, SystemBodyID: id, PlanetNumber: id, OrbitNumber: 0, BodyClass: 1, SystemBodyName: null, MaintenanceFacilities: 10, MSPProduction: 50, MaintProdStatus: 1, Mines: 0, Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6, ...over })
  // The loader's row of the same colony: stock and reserve of every mineral, the mass driver and the place.
  const source = (id, stock = {}, reserve = {}, over = {}) => ({ PopulationID: id, PopName: `C${id}`, SystemID: SYSTEM, MassDriverDest: 0, Drivers: 0, DriverGaps: 0, DestinationID: null, DestinationName: null, DestinationRaceID: null, DestinationSystemID: null, Xcor: 10 * id, Ycor: 10, ShuttleCapacity: null, ServiceNames: null, ...Object.fromEntries(ALL.flatMap((name) => [[name, stock[name] ?? (MIN.includes(name) ? 1e6 : 0)], [`Reserve${name}`, reserve[name] ?? 0]])), ...over })
  const pair = (id, stock = {}, over = {}, reserve = {}, extra = {}) => ({ colony: row(id, { ...stock, ...over }), source: source(id, stock, reserve, extra) })
  const ships = (to, over = {}) => ({ MassDriverDest: to.PopulationID, DestinationID: to.PopulationID, DestinationName: to.PopName, DestinationRaceID: RACE, DestinationSystemID: to.SystemID, Drivers: 5, DriverGaps: 0, ...over })
  const sources = (over = {}) => ({ colonies: [], needs: {}, packets: {}, packetRows: [], surface: [], orbital: [], plan: null, freighters: null, shuttleTechnology: null, problems: [], ...over })
  const admins = { 1: { NavalAdminCommandID: 1, SystemID: 5, ParentCommandID: 0, BonusValue: 1.2, Share: 0.5, Eligible: true, Unknown: null, Systems: new Set([5]) } }
  // 10 manned mines of 10 t, accessibility 1, every modifier neutral: 100 t a year, from a deposit of `Amount`.
  const surface = (id, material, over = {}) => ({ PopulationID: id, PopName: `C${id}`, SystemID: SYSTEM, SystemName: 'Sol', SystemBodyID: id, MaterialID: material, Amount: 1e9, MassDriverExport: 0, PurchaseCivilianMinerals: 0, ManualMineCount: 10, AutomatedMineCount: 0, CivilianMineCount: 0, MineProduction: 10, Accessibility: 1, GovernorBonus: 1, SectorBonus: 1, Efficiency: 1, StabilityModifier: 1, PoliticalModifier: 1, RadiationModifier: 1, ...over })
  // 10 modules of 14 t at commander 1.25, chain 1.1, full crew and accessibility 0.5: 96.25 t a year.
  const orbital = (id, material, over = {}) => ({ FleetID: 1, ShipName: 'Miner', PopulationID: id, PopName: `C${id}`, SystemID: 5, SystemName: 'Alpha', SystemBodyID: id, MaterialID: material, Amount: 1e9, MassDriverExport: 0, PurchaseCivilianMinerals: 0, MiningModules: 10, MineProduction: 14, CommanderBonus: 1.25, Accessibility: 0.5, Diameter: 1000, MaximumOrbitalMiningDiameter: 4000, ClassCrew: 100, CurrentCrew: 100, NavalAdminCommandID: 1, ...over })
  // A packet bound for colony `to`, which lands after `day` days: the distance is 86,400 km a day at 1 km/s, and the destination body is at 5, 5.
  const packet = (to, day, over = {}) => ({ PacketID: 1, DestID: to, SysID: SYSTEM, DestSystemID: SYSTEM, Speed: 1, Xcor: 86400 * day + 5, Ycor: 5, DestXcor: 5, DestYcor: 5, ...Object.fromEntries(MIN.map((name) => [name, 0])), ...over })
  const need = (over = {}) => ({ ...Object.fromEntries(MIN.flatMap((name) => [[name, 0], [`Missing${name}`, 0]])), ...over })
  const haul = (from, to, minerals, key = 'h1') => ({ key, from: { PopulationID: from.PopulationID, PopName: from.PopName }, to: { PopulationID: to.PopulationID, PopName: to.PopName }, tonnes: minerals.reduce((sum, mineral) => sum + mineral.tonnes, 0), minerals })
  const rowsOf = ({ pairs, years = 1, modifier = 1, ...over }) => ms.mspSupplyRows({ colonies: pairs.map((entry) => entry.colony), sources: sources({ colonies: pairs.map((entry) => entry.source), ...over }), modifierOf: () => modifier, navalAdmins: admins, formulaVersion: '2.7.x', RaceID: RACE, years })
  const rowOf = (rows, id) => rows.find((entry) => entry.populationId === id)
  const withHauls = (days, test, holds) => {
    const before = [globalThis.__haulDays, globalThis.__haulHolds]

    globalThis.__haulDays = days
    globalThis.__haulHolds = holds

    try {
      return test()
    } finally {
      globalThis.__haulDays = before[0]
      globalThis.__haulHolds = before[1]
    }
  }
  const production = (c) => lg.mspProduction(c, 1).value
  const sim = (over = {}) => ms.simulate({ production: 365, stock: { Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6 }, days: 365, ...over })
  const dry = (over = {}) => ({ Duranium: 0, Uridium: 1e6, Gallicite: 1e6, ...over })
  const lump = (mineral, day, t, group = 'packets') => ({ group, kind: 'packets', mineral, tonnes: t, day })

  return { MIN, PER, ALL, value, tonnes, row, source, pair, ships, sources, admins, surface, orbital, packet, need, haul, rowsOf, rowOf, withHauls, production, sim, dry, lump, mo, lg, ms, minerals }
}

// An in-memory save with the tables the loaders of the supply read: `names` are the mineral columns, the rest are the rows of each table, written as given (a column left out of a row is null).
const sqlValue = (value) => (value === null || value === undefined ? 'null' : typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value))
const memoryDatabase = async (names, tables) => {
  const raw = new sqlite3.Database(':memory:')
  const run = (sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))
  const count = names.map((name) => `${name} real`).join(', ')

  await run(`create table FCT_Population (PopulationID integer, PopName text, SystemID integer, SystemBodyID integer, GameID integer, RaceID integer, MassDriverDest integer, ${names.flatMap((name) => [`${name} real`, `Reserve${name} real`]).join(', ')})`)
  await run('create table FCT_SystemBody (SystemBodyID integer, Xcor real, Ycor real)')
  await run('create table DIM_PlanetaryInstallation (PlanetaryInstallationID integer, MassDriverValue real)')
  await run('create table FCT_PopulationInstallations (GameID integer, PopID integer, PlanetaryInstallationID integer, Amount real)')
  await run(`create table FCT_MassDriverPackets (PacketID integer, GameID integer, RaceID integer, DestID integer, Speed real, Xcor real, Ycor real, ${count})`)

  for (const [table, entries] of Object.entries(tables)) {
    for (const entry of entries) {
      await run(`insert into ${table} (${Object.keys(entry).join(', ')}) values (${Object.values(entry).map(sqlValue).join(', ')})`)
    }
  }

  return { query: (sql) => allRows(raw, sql), close: () => closeRaw(raw) }
}

// ---------- the ledger, on the colonies worked by hand ----------

const pure = (ctx) => {
  const w = world(ctx.m)
  const { ms, lg, MIN, PER, value, tonnes, row, pair, ships, surface, orbital, packet, need, haul, rowsOf, rowOf, withHauls, production, sim, dry, lump, minerals } = w
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const everything = () => {
    const a = pair(1, dry({ Uridium: 500 }), {}, { Uridium: 100 }, ships({ PopulationID: 2, PopName: 'C2', SystemID: SYSTEM }))
    const b = pair(2, { Duranium: 400, Uridium: 5e4, Gallicite: 5e4 })
    const t = tonnes('Duranium', 0.3 * production(a.colony))

    return rowsOf({ pairs: [a, b], needs: { 1: need({ Uridium: 50 }) }, packetRows: [packet(1, 120, { Gallicite: 40 })], surface: [surface(1, 1, { Amount: 30 })], orbital: [orbital(1, 1, { Amount: 30 })], plan: { hauls: [haul(b.source, a.source, [{ name: 'Duranium', tonnes: t }])], unmet: [], left: [] }, freighters: [{ Ships: 1 }], shuttleTechnology: {} })
  }

  // ----- a late delivery cannot support earlier production -----
  add('late: a delivery landing on day 200.5 supports no tick before the 201st and the whole of it from then on', () => {
    const delivered = { inflows: [lump('Duranium', 200.5, tonnes('Duranium', 20))], stock: dry() }
    const before = sim({ ...delivered, days: 200 })
    const on = sim({ ...delivered, days: 201 })
    const after = sim({ ...delivered, days: 365 })

    return near(before.made, 0) && near(on.made, 1) && near(after.made, 20) && before.flows.credited.Duranium === 0 && near(on.flows.credited.Duranium, tonnes('Duranium', 20)) ? true : short([before.made, on.made, after.made])
  })
  add('late: a delivery of a whole day or less lands on the first tick, and one beyond the period counts for nothing', () => {
    const first = sim({ stock: dry(), inflows: [lump('Duranium', 0.2, tonnes('Duranium', 20))], days: 5 })
    const beyond = sim({ stock: dry(), inflows: [lump('Duranium', 400, tonnes('Duranium', 20))], days: 365 })

    return near(first.made, 5) && near(first.flows.credited.Duranium, tonnes('Duranium', 20)) && beyond.made === 0 && beyond.flows.credited.Duranium === 0 ? true : short([first.made, beyond.made, beyond.flows.credited])
  })
  add('late: a delivery never raises the output of a shorter period than its arrival: the output over a shorter period is the same with and without it', () => {
    const bare = sim({ stock: dry({ Uridium: tonnes('Uridium', 30) }), days: 90 })
    const lateOne = sim({ stock: dry({ Uridium: tonnes('Uridium', 30) }), inflows: [lump('Duranium', 91, tonnes('Duranium', 50))], days: 90 })

    return same(lateOne.made, bare.made) === true && lateOne.made === 0 ? true : short([bare.made, lateOne.made])
  })
  add('late: a packet that lands on day 200.5 adds nothing over a quarter of a year and arrives on the 201st day over a year', () => {
    const a = pair(1, { Duranium: 0 })
    const t = tonnes('Duranium', 0.2 * production(a.colony))
    const quarter = rowOf(rowsOf({ pairs: [a], packetRows: [packet(1, 200.5, { Duranium: t })], years: 0.25 }), 1)
    const year = rowOf(rowsOf({ pairs: [a], packetRows: [packet(1, 200.5, { Duranium: t })] }), 1)

    return near(value(quarter.high.result), 0) && quarter.high.delivery === null && near(value(year.high.result), 0.2 * production(a.colony)) && year.high.delivery && year.high.delivery.firstDay === 201 ? true : short([value(quarter.high.result), quarter.high.delivery, value(year.high.result), year.high.delivery && year.high.delivery.firstDay])
  })

  // ----- mines are never unlimited supply (the stock-only output) -----
  const mined = { Mines: 10, DepositDuranium: 1, DepositUridium: 1, DepositGallicite: 1 }
  add('local: a colony with mines on a deposit has a finite stock-only output: the stock of its scarcest mineral over what an MSP takes, never the full production', () => {
    const c = row(1, { ...mined, Duranium: tonnes('Duranium', 0.25 * production(row(1))) })
    const out = lg.mspOutput(c, 1)

    return near(value(out), 0.25 * production(c)) && lg.mspLimitingMineral(c, 1) === 'Duranium' && same(lg.mspMineralShortfall(c, 1), ['Duranium']) === true ? true : short([value(out), lg.mspLimitingMineral(c, 1), lg.mspMineralShortfall(c, 1)])
  })
  add('local: a stock-only output with plenty of every mineral is the full production and names no limiting mineral, with or without mines', () => {
    const bare = row(1)
    const dug = row(1, mined)

    return near(value(lg.mspOutput(bare, 1)), production(bare)) && near(value(lg.mspOutput(dug, 1)), production(dug)) && lg.mspLimitingMineral(dug, 1) === null && same(lg.mspMineralShortfall(dug, 1), []) === true ? true : short([value(lg.mspOutput(dug, 1))])
  })
  add('local: an unknown stock of a mineral is unknown, whatever mines stand on a deposit of it', () => {
    const out = lg.mspOutput(row(1, { ...mined, Duranium: null }), 1)

    return out.status === 'unavailable' && value(out) === null ? true : short(out)
  })
  add('local: a mine adds what it digs a year, 100 t from 10 manned mines, and no more than the deposit holds, found in the ledger', () => {
    const c = pair(1, dry())
    const full = rowOf(rowsOf({ pairs: [c], surface: [surface(1, 1)] }), 1)
    const small = rowOf(rowsOf({ pairs: [c], surface: [surface(1, 1, { Amount: 30 })] }), 1)

    return near(full.ledger.high.credited.Duranium, 100) && near(small.ledger.high.credited.Duranium, 30) && near(value(small.high.result), 30 / PER.Duranium) && near(value(small.stockOnly.result), 0) ? true : short([full.ledger.high.credited, small.ledger.high.credited, value(small.high.result)])
  })
  add('local: a deposit that is spent adds nothing', () => {
    const spent = rowOf(rowsOf({ pairs: [pair(1, dry())], surface: [surface(1, 1, { Amount: 0 })] }), 1)

    return spent.ledger.high.credited.Duranium === 0 && near(value(spent.high.result), 0) ? true : short(spent.ledger.high.credited)
  })
  add('local: a mine whose rate is not known is listed and adds nothing, never an unlimited stock and never a 0 stock counted as known', () => {
    const unknown = rowOf(rowsOf({ pairs: [pair(1, dry())], surface: [surface(1, 1, { MineProduction: null })] }), 1)

    return unknown.notCounted.some((entry) => entry.kind === 'mining') && unknown.ledger.high.credited.Duranium === 0 && near(value(unknown.high.result), 0) ? true : short([unknown.notCounted, unknown.ledger.high.credited])
  })
  add('local: a negative stock is held as none, as the Logistics figure does: the stock-only output is that figure, no output is negative and no mineral is made from the negative draw', () => {
    const negative = { Duranium: -0.001 }
    const c = row(1, negative)
    const one = rowOf(rowsOf({ pairs: [pair(1, negative)] }), 1)
    const run = sim({ stock: { Duranium: -0.001, Uridium: 100, Gallicite: 100 } })

    return value(lg.mspOutput(c, 1)) === 0 && near(value(one.stockOnly.result), 0) && value(one.stockOnly.result) >= 0 && value(one.high.result) >= 0 && run.made >= 0 && Object.values(run.flows.used).every((t) => t >= 0) && run.residual < 1e-9 ? true : short([value(lg.mspOutput(c, 1)), value(one.stockOnly.result), value(one.high.result), run.made, run.flows.used])
  })
  add('local: a deposit whose remaining amount is not recorded counts nothing and is listed, never an uncapped supply', () => {
    const one = rowOf(rowsOf({ pairs: [pair(1, dry())], surface: [surface(1, 1, { Amount: null })], orbital: [orbital(1, 1, { Amount: null })] }), 1)

    return one.ledger.high.credited.Duranium === 0 && near(value(one.high.result), 0) && one.notCounted.some((entry) => entry.kind === 'mining') ? true : short([one.ledger.high.credited, one.notCounted])
  })
  add('shared: the mines and the orbital miners on one body draw on one deposit: together they dig no more than it holds', () => {
    const c = pair(1, dry())
    const free = rowOf(rowsOf({ pairs: [c], surface: [surface(1, 1)], orbital: [orbital(1, 1)] }), 1)
    const capped = rowOf(rowsOf({ pairs: [c], surface: [surface(1, 1, { Amount: 150 })], orbital: [orbital(1, 1, { Amount: 150 })] }), 1)
    const groups = Object.fromEntries(capped.deliveries.map((entry) => [entry.group, value(entry.tonnes)]))

    return near(free.ledger.high.credited.Duranium, 196.25) && near(capped.ledger.high.credited.Duranium, 150) && groups.mines > 0 && groups.orbital > 0 && near(groups.mines + groups.orbital, 150) ? true : short([free.ledger.high.credited.Duranium, capped.ledger.high.credited.Duranium, groups])
  })
  add('shared: a deposit is spent once whoever draws on it: the shares it gives over the days sum to what it holds, and one nobody asks of is left whole', () => {
    const run = ms.depositScales({ amount: 60, demand: 200, days: 365 })
    const idle = ms.depositScales({ amount: 60, demand: 0, days: 365 })
    const given = run.scale.reduce((sum, share) => sum + share * 200 / 365, 0)

    return near(given, 60) && near(run.drawn, 60) && near(run.left, 0) && run.scale.every((share) => share >= 0 && share <= 1) && idle.drawn === 0 && idle.left === 60 ? true : short([given, run.drawn, run.left, idle.drawn, idle.left])
  })
  add('shared: two colonies on one body draw on its deposit once, so together they credit no more than it holds, and on two bodies each has its own', () => {
    const a = pair(1, dry())
    const b = pair(2, dry())
    const together = rowsOf({ pairs: [a, b], surface: [surface(1, 1, { SystemBodyID: 7, Amount: 30 }), surface(2, 1, { SystemBodyID: 7, Amount: 30 })] })
    const apart = rowsOf({ pairs: [a, b], surface: [surface(1, 1, { SystemBodyID: 7, Amount: 30 }), surface(2, 1, { SystemBodyID: 8, Amount: 30 })] })
    const credited = [1, 2].map((id) => rowOf(together, id).ledger.high.credited.Duranium)

    return near(credited[0] + credited[1], 30) && credited.every((t) => t > 0) && near(rowOf(apart, 1).ledger.high.credited.Duranium, 30) && near(rowOf(apart, 2).ledger.high.credited.Duranium, 30) ? true : short([credited, rowOf(apart, 1).ledger.high.credited.Duranium, rowOf(apart, 2).ledger.high.credited.Duranium])
  })
  add('shared: civilian mining draws on the deposit whether its output is taxed or bought, and the colony keeps only its own share of a finite deposit', () => {
    const target = { PopulationID: 2, PopName: 'C2', SystemID: SYSTEM }
    const held = { Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6 }
    const taxed = rowOf(rowsOf({ pairs: [pair(1, dry())], surface: [surface(1, 1, { Amount: 60, CivilianMineCount: 10, PurchaseCivilianMinerals: 0 })] }), 1)
    const bought = rowOf(rowsOf({ pairs: [pair(1, dry(), {}, held, ships(target))], surface: [surface(1, 1, { Amount: 60, CivilianMineCount: 10, PurchaseCivilianMinerals: 1, MassDriverExport: 1 })] }), 1)
    const plenty = rowOf(rowsOf({ pairs: [pair(1, dry())], surface: [surface(1, 1, { CivilianMineCount: 10, PurchaseCivilianMinerals: 0 })] }), 1)

    return near(taxed.ledger.high.credited.Duranium, 30) && near(bought.ledger.high.credited.Duranium, 30) && near(plenty.ledger.high.credited.Duranium, 100) ? true : short([taxed.ledger.high.credited.Duranium, bought.ledger.high.credited.Duranium, plenty.ledger.high.credited.Duranium])
  })
  add('shared: a colony on the body whose mining rate is not known leaves the draw on the deposit unknown, so nothing from it is counted for any colony', () => {
    const a = pair(1, dry())
    const b = pair(2, dry())
    const rows = rowsOf({ pairs: [a, b], surface: [surface(1, 1, { SystemBodyID: 7, Amount: 30 }), surface(2, 1, { SystemBodyID: 7, Amount: 30, MineProduction: null })] })

    return [1, 2].every((id) => rowOf(rows, id).ledger.high.credited.Duranium === 0 && rowOf(rows, id).notCounted.some((entry) => entry.kind === 'mining')) ? true : short([1, 2].map((id) => [rowOf(rows, id).ledger.high.credited.Duranium, rowOf(rows, id).notCounted]))
  })

  // ----- a tonne is allocated once -----
  add('once: the ledger of colonies with mines, orbital miners, a packet, a haul, a queue and an export balances to the tonne', () => {
    const rows = everything()
    const worst = Math.max(...rows.map((entry) => entry.balance))

    return rows.length === 2 && worst < 1e-6 && rows.every((entry) => entry.ledger.high && Math.abs(Object.values(entry.ledger.high.credited).reduce((sum, t) => sum + t, 0)) >= 0) ? true : short([rows.length, worst])
  })
  add('once: a simulated run of every kind of flow leaves no tonne unaccounted for', () => {
    const run = sim({ stock: { Duranium: 40, Uridium: 40, Gallicite: 40 }, inflows: [lump('Duranium', 10, 30), lump('Uridium', 50.2, 12), { group: 'mines', kind: 'mining', mineral: 'Gallicite', rate: 70, scale: ms.depositScales({ amount: 25, demand: 70, days: 365 }).scale }], outflows: [{ group: 'haul to 2', mineral: 'Duranium', tonnes: 15 }], queue: { Duranium: 5, Uridium: 2, Gallicite: 1 }, exporter: { capacity: 200, reserve: { Duranium: 3, Uridium: 3, Gallicite: 3 }, others: [{ stock: 40, reserve: 0 }] } })

    return run.residual < 1e-9 && run.flows.given.Duranium === 15 && run.flows.queued.Duranium === 5 && run.flows.exported.Duranium > 0 ? true : short([run.residual, run.flows])
  })
  add('once: a packet lands at its one destination: counted in full there and by no other colony', () => {
    const a = pair(1, { Duranium: 0 })
    const c = pair(3, { Duranium: 0 })
    const t = tonnes('Duranium', 0.2 * production(a.colony))
    const rows = rowsOf({ pairs: [a, c], packetRows: [packet(1, 100, { Duranium: t })] })

    return near(value(rowOf(rows, 1).high.result), 0.2 * production(a.colony)) && near(rowOf(rows, 1).ledger.high.credited.Duranium, t) && near(value(rowOf(rows, 3).high.result), 0) && rowOf(rows, 3).ledger.high.credited.Duranium === 0 ? true : short([value(rowOf(rows, 1).high.result), rowOf(rows, 1).ledger.high.credited, rowOf(rows, 3).ledger.high.credited])
  })
  add('once: a tonne a haul gives leaves the source and is not left in the stock, which the ledger would not balance with', () => {
    const run = sim({ stock: { Duranium: 100, Uridium: 1e6, Gallicite: 1e6 }, outflows: [{ group: 'haul to 2', mineral: 'Duranium', tonnes: 60 }], days: 1, production: 0 })

    return near(run.final.Duranium, 40) && run.flows.given.Duranium === 60 && run.residual < 1e-9 ? true : short([run.final, run.flows.given, run.residual])
  })

  // ----- hauls -----
  const haulWorld = (stock, days, years = 1, plan = null) => {
    const a = pair(1, dry())
    const b = pair(2, { Duranium: stock(production(row(2))) })
    const t = 100
    const rows = withHauls(days, () => rowsOf({ pairs: [a, b], plan: plan || { hauls: [haul(b.source, a.source, [{ name: 'Duranium', tonnes: t }])], unmet: [], left: [] }, freighters: [{ Ships: 1 }], shuttleTechnology: {}, years }))

    return { a, b, rows, ra: rowOf(rows, 1), rb: rowOf(rows, 2) }
  }
  const spare = (extra) => (rate) => tonnes('Duranium', rate) + extra
  add('hauls: a haul is counted on the day its freighter class has made every trip: a day earlier or later changes the output, and one that arrives after the period adds nothing', () => {
    const early = haulWorld(spare(1000), 30)
    const late = haulWorld(spare(1000), 400)
    const shortPeriod = haulWorld(spare(1000), 30, 20 / 365)

    return early.ra.deliveries.some((entry) => entry.group === 'haul from 2' && entry.firstDay === 30) && early.ra.high.delivery && early.ra.high.delivery.group === 'haul from 2' && value(early.ra.high.result) > value(early.ra.stockOnly.result) && late.ra.ledger.high.credited.Duranium === 0 && shortPeriod.ra.ledger.high.credited.Duranium === 0 && near(value(shortPeriod.ra.high.result), value(shortPeriod.ra.stockOnly.result)) ? true : short([early.ra.deliveries.map((entry) => [entry.group, entry.firstDay]), late.ra.ledger.high.credited.Duranium, shortPeriod.ra.ledger.high.credited.Duranium])
  })
  add('hauls: a haul takes from the source only what its own production leaves, and the destination gets exactly that', () => {
    const run = haulWorld(spare(40), 30)
    const rich = haulWorld(spare(1e6), 30)

    return near(run.rb.ledger.high.given.Duranium, 40) && near(run.ra.ledger.high.credited.Duranium, 40) && near(rich.rb.ledger.high.given.Duranium, 100) && near(rich.ra.ledger.high.credited.Duranium, 100) ? true : short([run.rb.ledger.high.given, run.ra.ledger.high.credited, rich.rb.ledger.high.given])
  })
  add('hauls: a source with nothing beyond its own production gives nothing, so the destination gets nothing and the source makes its full production', () => {
    const run = haulWorld(spare(0), 30)

    return near(run.rb.ledger.high.given.Duranium, 0) && near(run.ra.ledger.high.credited.Duranium, 0) && near(value(run.rb.high.result), production(run.b.colony)) ? true : short([run.rb.ledger.high.given, run.ra.ledger.high.credited])
  })
  add('hauls: the tonnes of a haul are debited from the source and credited to the destination in the same amount', () => {
    const run = haulWorld(spare(60), 30)

    return near(run.rb.ledger.high.given.Duranium, run.ra.ledger.high.credited.Duranium) && run.rb.ledger.high.given.Duranium > 0 && run.rb.balance < 1e-6 && run.ra.balance < 1e-6 ? true : short([run.rb.ledger.high.given, run.ra.ledger.high.credited])
  })
  add('hauls: a haul no freighter class can carry is listed for both colonies and moves no tonne', () => {
    const run = haulWorld(spare(1000), null)

    return run.ra.notCounted.some((entry) => entry.kind === 'hauls') && run.ra.ledger.high.credited.Duranium === 0 && run.rb.ledger.high.given.Duranium === 0 && run.rb.notCounted.some((entry) => entry.kind === 'hauls') ? true : short([run.ra.notCounted, run.rb.notCounted])
  })
  add('hauls: one freighter serves one haul of the plan: with one ship the second of two hauls is listed and not counted, with two ships both are counted on the day their own trips end, and a haul never takes more ships than it fills holds', () => {
    const [a, b, c, d] = [pair(1, dry()), pair(2, { Duranium: 1e6 }), pair(3, dry()), pair(4, { Duranium: 1e6 })]
    const plan = { hauls: [haul(b.source, a.source, [{ name: 'Duranium', tonnes: 100 }], 'h1'), haul(d.source, c.source, [{ name: 'Duranium', tonnes: 100 }], 'h2')], unmet: [], left: [] }
    const run = (ships, holds) => withHauls(20, () => ({ timed: ms.timeHauls({ plan, freighters: [{ Ships: ships }], shuttleTechnology: {}, formulaVersion: '2.7.x' }), rows: rowsOf({ pairs: [a, b, c, d], plan, freighters: [{ Ships: ships }], shuttleTechnology: {} }) }), holds)
    const one = run(1)
    const two = run(2)
    const many = run(2, 4)

    return same(one.timed.map((entry) => entry.days), [20, null]) === true && one.timed[1].why && rowOf(one.rows, 3).notCounted.some((entry) => entry.kind === 'hauls') && near(rowOf(one.rows, 1).ledger.high.credited.Duranium, 100) && rowOf(one.rows, 3).ledger.high.credited.Duranium === 0 && rowOf(one.rows, 4).ledger.high.given.Duranium === 0 && same(two.timed.map((entry) => entry.days), [20, 20]) === true && near(rowOf(two.rows, 3).ledger.high.credited.Duranium, 100) && same(many.timed.map((entry) => [entry.days, entry.ships]), [[40, 2], [null, 0]]) === true ? true : short([one.timed.map((entry) => entry.days), two.timed.map((entry) => entry.days), many.timed.map((entry) => [entry.days, entry.ships])])
  })

  // ----- the queue, the export and the order of the draws -----
  add('queue: the queue served first takes the stock before maintenance and the idle queue does not: the output with the queue first is never above the output with it idle', () => {
    const run = ms.allocateMsp({ colony: { production: 365, stock: { Duranium: 36.5, Uridium: 1e6, Gallicite: 1e6 }, inflows: [], outflows: [], queue: { Duranium: 36.5, Uridium: 0, Gallicite: 0 }, exporter: null }, days: 365 })

    return near(run.high.made, 365) && near(run.low.made, 0) && run.low.flows.queued.Duranium === 36.5 && run.low.made <= run.high.made ? true : short([run.high.made, run.low.made, run.low.flows.queued])
  })
  add('queue: a colony whose queue takes part of the stock and leaves the rest to the maintenance sits between the two runs, and the supplied range is ordered', () => {
    const a = pair(1, { Duranium: tonnes('Duranium', 0.4 * production(row(1))) })
    const rows = rowsOf({ pairs: [a], needs: { 1: need({ Duranium: tonnes('Duranium', 0.1 * production(row(1))) }) } })
    const one = rowOf(rows, 1)

    return near(value(one.high.result), 0.4 * production(one.colony)) && near(value(one.low.result), 0.3 * production(one.colony)) && value(one.low.result) <= value(one.high.result) ? true : short([value(one.high.result), value(one.low.result)])
  })
  add('queue: a queue the save does not give in full is listed, the idle figure stands and the queue-first figure is unavailable, never the idle one', () => {
    const a = pair(1, { Duranium: tonnes('Duranium', 0.4 * production(row(1))) })
    const one = rowOf(rowsOf({ pairs: [a], needs: { 1: need({ Duranium: null, MissingDuranium: 1 }) } }), 1)
    const absent = rowOf(rowsOf({ pairs: [a], needs: null }), 1)

    return one.low.result.status === 'unavailable' && value(one.low.result) === null && near(value(one.high.result), 0.4 * production(one.colony)) && one.notCounted.some((entry) => entry.kind === 'queue') && absent.low.result.status === 'unavailable' ? true : short([one.low.result.status, value(one.high.result), one.notCounted])
  })
  const reserves = (name, t) => ({ Duranium: name === 'Duranium' ? t : 0, Uridium: 0, Gallicite: 0 })
  add('export: no reserve protects the maintenance draw: stock equal to the reserve is made into supplies in full, and the export leaves it alone', () => {
    const stock = { Duranium: 36.5, Uridium: 18.25, Gallicite: 36.5 }
    const kept = sim({ stock, exporter: { capacity: 1e9, reserve: stock, others: [] } })

    return near(kept.made, 365) && kept.flows.exported.Duranium === 0 && kept.flows.exported.Uridium === 0 && near(kept.flows.used.Duranium, 36.5) ? true : short([kept.made, kept.flows.exported, kept.flows.used])
  })
  add('export: stock above the reserve is exported within the drivers\' capacity before the maintenance draws, and the export of a year never exceeds the capacity', () => {
    const stock = { Duranium: 1e4, Uridium: 1e4, Gallicite: 1e4 }
    const run = sim({ stock, exporter: { capacity: 3650, reserve: reserves('none', 0), others: [] } })
    const all = Object.values(run.flows.exported).reduce((sum, t) => sum + t, 0)
    const first = sim({ stock: { Duranium: 1, Uridium: 0, Gallicite: 0 }, exporter: { capacity: 1e9, reserve: reserves('none', 0), others: [] }, days: 1 })

    return near(all, 3650) && all <= 3650 + 1e-6 && first.made === 0 && near(first.flows.exported.Duranium, 1) ? true : short([all, first.made, first.flows.exported])
  })
  add('export: a surplus under one tonne stays at the colony: mining that brings the inputs of one MSP a day is made into supplies all year and nothing is exported', () => {
    const rate = { Duranium: 36.5, Uridium: 18.25, Gallicite: 36.5 }
    const run = sim({ stock: { Duranium: 0, Uridium: 0, Gallicite: 0 }, inflows: MIN.map((name) => ({ group: 'mines', kind: 'mining', mineral: name, rate: rate[name] })), exporter: { capacity: 5000, reserve: reserves('none', 0), others: [] } })
    const sub = sim({ stock: { Duranium: 0.1, Uridium: 0.05, Gallicite: 0.1 }, exporter: { capacity: 1e9, reserve: reserves('none', 0), others: [] }, days: 1 })

    return near(run.made, 365) && Object.values(run.flows.exported).every((t) => t === 0) && near(sub.made, 1) && Object.values(sub.flows.exported).every((t) => t === 0) ? true : short([run.made, run.flows.exported, sub.made, sub.flows.exported])
  })
  add('export: the other minerals an export has sent no longer compete for the drivers: they are debited by what is sent, so the output follows the day-by-day reference', () => {
    const stock = { Duranium: 100, Uridium: 50, Gallicite: 100 }
    const held = { ...stock }
    let other = 100
    let reference = 0

    for (let day = 1; day <= 365; day++) {
      const total = other + MIN.reduce((sum, name) => sum + held[name], 0)

      if (total >= 1) {
        const fraction = Math.min(1, 5000 / 365 / total)

        MIN.forEach((name) => { held[name] -= held[name] * fraction })
        other -= other * fraction
      }

      const done = Math.min(1, ...MIN.map((name) => held[name] / PER[name]))

      reference += done
      MIN.forEach((name) => { held[name] -= done * PER[name] })
    }

    const run = sim({ stock, exporter: { capacity: 5000, reserve: reserves('none', 0), others: [{ stock: 100, reserve: 0 }] } })

    return near(run.made, reference) && reference < 30 ? true : short([run.made, reference])
  })
  add('export: a colony that ships by mass driver exports its surplus within its drivers\' capacity, and one that does not export nothing', () => {
    const rich = { Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6 }
    const target = { PopulationID: 2, PopName: 'C2', SystemID: SYSTEM }
    const exports = rowOf(rowsOf({ pairs: [pair(1, rich, {}, {}, ships(target))] }), 1)
    const quiet = rowOf(rowsOf({ pairs: [pair(1, rich)] }), 1)
    const held = rowOf(rowsOf({ pairs: [pair(1, rich, {}, { Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6 }, ships(target))] }), 1)
    const sent = Object.values(exports.ledger.high.exported).reduce((sum, t) => sum + t, 0)

    return sent > 0 && sent <= 5 * minerals.MASS_DRIVER_TONS + 1e-6 && Object.values(quiet.ledger.high.exported).every((t) => t === 0) && Object.values(held.ledger.high.exported).every((t) => t === 0) ? true : short([sent, quiet.ledger.high.exported, held.ledger.high.exported])
  })
  add('export: an allocated haul takes its other minerals out of the stock the export shares among the minerals, on the day it sets out: the colony exports as if it never held them', () => {
    const stock = { Duranium: 100, Uridium: 50, Gallicite: 100 }
    const target = { PopulationID: 2, PopName: 'C2', SystemID: SYSTEM }
    const own = (held) => pair(1, { ...stock, Boronide: held }, {}, {}, ships(target, { Drivers: 1 }))
    const b = pair(2, dry())
    const out = (a, over = {}) => rowOf(rowsOf({ pairs: [a, b], ...over }), 1)
    const plan = { hauls: [haul(own(100).source, b.source, [{ name: 'Boronide', tonnes: 100 }])], unmet: [], left: [] }
    const hauled = withHauls(0.001, () => out(own(100), { plan, freighters: [{ Ships: 1 }], shuttleTechnology: {} }))
    const gone = out(own(0))
    const kept = out(own(100))

    return near(value(hauled.high.result), value(gone.high.result)) && Math.abs(value(kept.high.result) - value(gone.high.result)) > 1 && hauled.notCounted.every((entry) => entry.kind !== 'hauls') ? true : short([value(hauled.high.result), value(gone.high.result), value(kept.high.result), hauled.notCounted])
  })
  add('export: a colony whose mass driver destination is not recorded lists the export and does not count it as none', () => {
    const a = pair(1, { Duranium: 1e6 }, {}, {}, { MassDriverDest: null })
    const one = rowOf(rowsOf({ pairs: [a] }), 1)

    return one.notCounted.some((entry) => entry.kind === 'export') ? true : short(one.notCounted)
  })

  // ----- the limiting mineral and the conditional delivery are named -----
  const limited = () => {
    const c = row(1)
    const p = production(c)
    const a = pair(1, { Duranium: tonnes('Duranium', 0.5 * p), Uridium: tonnes('Uridium', 0.4 * p), Gallicite: tonnes('Gallicite', 5 * p) })
    const rows = rowsOf({ pairs: [a], packetRows: [packet(1, 100, { Uridium: tonnes('Uridium', 0.6 * p) })] })

    return { a, p, one: rowOf(rows, 1) }
  }
  add('limiting: the stock-only output names the mineral that limits it, as the Logistics figure does, and the conditional delivery that would lift it', () => {
    const { a, p, one } = limited()

    return one.stockOnly.limiting === 'Uridium' && lg.mspLimitingMineral(a.colony, 1) === 'Uridium' && near(value(one.stockOnly.result), 0.4 * p) && near(value(one.stockOnly.result), value(lg.mspOutput(a.colony, 1))) && one.stockOnly.delivery && one.stockOnly.delivery.group === 'packets' && one.stockOnly.delivery.firstDay === 100 ? true : short([one.stockOnly.limiting, value(one.stockOnly.result), one.stockOnly.delivery && one.stockOnly.delivery.group])
  })
  add('limiting: the supplied output names its own limiting mineral, the next one the delivery leaves in the way, and the delivery with its tonnes and its days', () => {
    const { p, one } = limited()

    return one.high.limiting === 'Duranium' && near(value(one.high.result), 0.5 * p) && one.high.delivery && one.high.delivery.group === 'packets' && one.high.delivery.kind === 'packets' && one.high.delivery.firstDay === 100 && one.high.delivery.lastDay === 100 && near(value(one.high.delivery.tonnes), tonnes('Uridium', 0.6 * p)) && one.high.delivery.msp.status !== 'unavailable' && value(one.high.delivery.msp) > 0 && one.low.limiting === 'Duranium' && one.low.delivery && one.low.delivery.group === 'packets' ? true : short([one.high.limiting, value(one.high.result), one.high.delivery, one.low.limiting])
  })
  add('limiting: the output with every mineral in plenty is not limited and has no delivery to name', () => {
    const one = rowOf(rowsOf({ pairs: [pair(1)] }), 1)

    return one.stockOnly.limiting === null && one.high.limiting === null && one.high.delivery === null && one.low.limiting === null && near(value(one.high.result), value(one.stockOnly.result)) ? true : short([one.stockOnly.limiting, one.high.limiting, one.high.delivery])
  })
  add('limiting: the stock-only output over a year is the Logistics figure of the present stock, for every mineral that can be the scarcest', () => {
    const wrong = []

    for (const name of MIN) {
      const c = row(1, { [name]: tonnes(name, 0.3 * production(row(1))) })
      const one = rowOf(rowsOf({ pairs: [pair(1, { [name]: c[name] })] }), 1)

      if (!near(value(one.stockOnly.result), value(lg.mspOutput(c, 1))) || one.stockOnly.limiting !== name || lg.mspLimitingMineral(c, 1) !== name) {
        wrong.push([name, value(one.stockOnly.result), value(lg.mspOutput(c, 1)), one.stockOnly.limiting])
      }
    }

    return wrong.length === 0 ? true : short(wrong)
  })
  add('limiting: the three outputs are separate figures, each with its own result, and the supplied one is never below the stock alone', () => {
    const { one } = limited()
    const results = [one.stockOnly.result, one.high.result, one.low.result]

    return new Set(results).size === 3 && results.every((result) => result.rule && result.status) && value(one.high.result) >= value(one.stockOnly.result) && value(one.low.result) <= value(one.high.result) + 1e-9 && one.stockOnly.result.rule !== one.high.result.rule ? true : short(results.map((result) => [result.rule, result.status]))
  })

  // ----- unknown stays unknown -----
  add('unknown: a colony whose stock of an input mineral is not recorded has no figure, never 0, in any of the three outputs', () => {
    const one = rowOf(rowsOf({ pairs: [pair(1, { Duranium: null })] }), 1)

    return [one.stockOnly.result, one.high.result, one.low.result].every((result) => result.status === 'unavailable' && value(result) === null) ? true : short([one.stockOnly.result.status, one.high.result.status, one.low.result.status])
  })
  add('unknown: a colony whose production modifier is not known has no figure', () => {
    const one = rowOf(rowsOf({ pairs: [pair(1)], modifier: null }), 1)

    return one.production.status === 'unavailable' && [one.stockOnly.result, one.high.result, one.low.result].every((result) => result.status === 'unavailable' && value(result) === null) ? true : short(one.production.status)
  })
  add('unknown: a packet whose destination body sits at 0, 0 and one with no speed are listed and never counted at any day', () => {
    const a = pair(1, { Duranium: 0 })
    const t = tonnes('Duranium', 0.2 * production(a.colony))
    const stalled = rowOf(rowsOf({ pairs: [a], packetRows: [packet(1, 100, { Duranium: t, DestXcor: 0, DestYcor: 0 })] }), 1)
    const still = rowOf(rowsOf({ pairs: [a], packetRows: [packet(1, 100, { Duranium: t, Speed: 0 })] }), 1)

    return [stalled, still].every((one) => one.notCounted.some((entry) => entry.kind === 'packets') && one.ledger.high.credited.Duranium === 0 && near(value(one.high.result), 0)) ? true : short([stalled.notCounted, still.notCounted])
  })
  add('unknown: a packet in another system than the body it is bound for lands on the day its distance gives: the game does not hold a packet to its system', () => {
    const a = pair(1, { Duranium: 0 })
    const t = tonnes('Duranium', 0.2 * production(a.colony))
    const away = rowOf(rowsOf({ pairs: [a], packetRows: [packet(1, 100, { Duranium: t, DestSystemID: 9 })] }), 1)
    const here = rowOf(rowsOf({ pairs: [a], packetRows: [packet(1, 100, { Duranium: t, SysID: 9 })] }), 1)

    return [away, here].every((one) => near(one.ledger.high.credited.Duranium, t) && one.high.delivery && one.high.delivery.firstDay === 100 && one.notCounted.every((entry) => entry.kind !== 'packets')) ? true : short([away.ledger.high.credited, away.notCounted, here.notCounted])
  })
  add('unknown: a packet whose load of a mineral is not recorded lists it and counts the loads that are', () => {
    const a = pair(1, { Duranium: 0, Uridium: 0 })
    const one = rowOf(rowsOf({ pairs: [a], packetRows: [packet(1, 100, { Duranium: 10, Uridium: null })] }), 1)

    return one.notCounted.some((entry) => entry.kind === 'packets' && /Uridium/.test(entry.text)) && near(one.ledger.high.credited.Duranium, 10) && one.ledger.high.credited.Uridium === 0 ? true : short([one.notCounted, one.ledger.high.credited])
  })
  add('unknown: a source that could not be read is named and what rests on it is listed, not counted as nothing', () => {
    const none = rowOf(rowsOf({ pairs: [pair(1, { Duranium: 0 })], packetRows: null, surface: null, orbital: null, plan: null, needs: null, problems: [{ source: 'packetRows', text: 'the position and speed of each packet could not be read' }, { source: 'needs', text: 'the build queues could not be read (no such column: FCT_IndustrialProjects.Duranium)' }] }), 1)
    const kinds = new Set(none.notCounted.map((entry) => entry.kind))

    return ['packets', 'mining', 'hauls', 'queue'].every((kind) => kinds.has(kind)) && none.low.result.status === 'unavailable' && none.low.result.inputs.missing.join() === 'the queue needs of the input minerals' ? true : short([...kinds, none.low.result.status, none.low.result.inputs.missing])
  })
  add('unknown: every figure of a row carries a result with a rule, unavailable or not', () => {
    const { one } = limited()
    const figures = [one.production, one.stockOnly.result, one.high.result, one.low.result, one.high.delivery.msp, one.high.delivery.tonnes, ...one.deliveries.flatMap((entry) => [entry.tonnes, entry.msp, entry.mspLow])]

    return figures.every((result) => result && result.rule && typeof result.status === 'string') && ctxRulesRegistered(ctx.m) ? true : short(figures.filter((result) => !result || !result.rule))
  })

  // ----- the loaders, on an in-memory save -----
  const names = w.ALL
  const stocked = (stock) => Object.fromEntries(names.flatMap((name) => [[name, stock[name] ?? 0], [`Reserve${name}`, 0]]))
  const colonyRow = (PopulationID, SystemBodyID, RaceID, MassDriverDest, stock = {}) => ({ PopulationID, PopName: `C${PopulationID}`, SystemID: SYSTEM, SystemBodyID, GameID: GAME, RaceID, MassDriverDest, ...stocked(stock) })
  const packetRow = (PacketID, RaceID, DestID, over = {}) => ({ PacketID, GameID: GAME, RaceID, DestID, Speed: 1, Xcor: 86400 * 100 + 10, Ycor: 10, ...Object.fromEntries(names.map((name) => [name, 0])), ...over })
  const memorySave = (over = {}) => memoryDatabase(names, {
    FCT_Population: [colonyRow(1, 1, RACE, 2, { Duranium: 100, Uridium: 50, Gallicite: 100 }), colonyRow(2, 2, RACE, 0, { Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6 }), colonyRow(3, 3, RACE + 1, 0), colonyRow(4, 4, RACE, 0)],
    FCT_SystemBody: [{ SystemBodyID: 1, Xcor: 10, Ycor: 10 }, { SystemBodyID: 2, Xcor: 20, Ycor: 10 }, { SystemBodyID: 3, Xcor: 30, Ycor: 10 }, { SystemBodyID: 4, Xcor: 40, Ycor: 10 }],
    DIM_PlanetaryInstallation: [{ PlanetaryInstallationID: 1, MassDriverValue: 1 }, { PlanetaryInstallationID: 2, MassDriverValue: 0 }],
    FCT_PopulationInstallations: [{ GameID: GAME, PopID: 1, PlanetaryInstallationID: 1, Amount: 1.9 }, { GameID: GAME, PopID: 2, PlanetaryInstallationID: 1, Amount: 2 }, { GameID: GAME, PopID: 2, PlanetaryInstallationID: 2, Amount: 3 }, { GameID: GAME, PopID: 4, PlanetaryInstallationID: 1, Amount: null }],
    FCT_MassDriverPackets: [],
    ...over,
  })
  const withSave = async (over, test) => {
    const database = await memorySave(over)

    try {
      return await test(database)
    } finally {
      await database.close()
    }
  }

  add('export: the drivers of a colony are its installations of a mass driver type counted as the whole ones the game counts: 1.9 installations are 1 driver and export as 1, and an amount not recorded is a gap', () => withSave({}, async (database) => {
    const colonies = await ms.loadMspColonies(database, { GameID: GAME, RaceID: RACE })
    const byId = Object.fromEntries(colonies.map((colony) => [colony.PopulationID, colony]))
    const exported = (source) => value(rowOf(rowsOf({ pairs: [{ colony: row(1, { Duranium: 100, Uridium: 50, Gallicite: 100 }), source }] }), 1).high.result)
    const loaded = exported(byId[1])
    const whole = exported({ ...byId[1], Drivers: 1 })
    const fractional = exported({ ...byId[1], Drivers: 1.9 })

    return byId[1].Drivers === 1 && byId[2].Drivers === 2 && byId[1].DriverGaps === 0 && byId[4].DriverGaps === 1 && near(loaded, whole) && Math.abs(fractional - whole) > 1 ? true : short([colonies.map((colony) => [colony.PopulationID, colony.Drivers, colony.DriverGaps]), loaded, whole, fractional])
  }))
  add('once: a packet launched by another race and bound for a colony of the race is the race\'s, as the game lets it land: the loaders of the packets in flight read it for the race of the destination', () => {
    const t = tonnes('Duranium', 0.2 * production(row(1)))
    const packets = [packetRow(100, RACE + 1, 1, { Duranium: t }), packetRow(101, RACE, 3, { Gallicite: 7 }), packetRow(102, RACE + 2, 3, { Gallicite: 9 }), { ...packetRow(103, RACE, 1, { Duranium: 5 }), GameID: GAME + 1 }]

    return withSave({ FCT_MassDriverPackets: packets }, async (database) => {
      const read = async (RaceID) => ({ rows: (await ms.loadPacketRows(database, { GameID: GAME, RaceID })).map((entry) => entry.PacketID).sort(), flights: await ctx.m.cm.loadPacketsInFlight(database, { GameID: GAME, RaceID }) })
      const mine = await read(RACE)
      const other = await read(RACE + 1)
      const third = await read(RACE + 2)
      const colonies = await ms.loadMspColonies(database, { GameID: GAME, RaceID: RACE })
      const one = rowOf(rowsOf({ pairs: [{ colony: row(1, { Duranium: 0 }), source: colonies.find((colony) => colony.PopulationID === 1) }], packetRows: await ms.loadPacketRows(database, { GameID: GAME, RaceID: RACE }) }), 1)

      return same(mine.rows, [100, 101]) === true && same(Object.keys(mine.flights).sort(), ['1', '3']) === true && near(mine.flights[1].Duranium, t) && same(other.rows, [100, 101, 102]) === true && same(third.rows, [102]) === true && same(Object.keys(third.flights), ['3']) === true && near(one.ledger.high.credited.Duranium, t) ? true : short([mine.rows, Object.keys(mine.flights), other.rows, third.rows, one.ledger.high.credited])
    })
  })

  return statements
}

// The rules the ledger gives its figures are registered, each with a verification and the structure it reads.
const ctxRulesRegistered = (m) => ['mspSupply.stockOnly', 'mspSupply.supplied', 'mspSupply.delivery', 'mspSupply.arrival'].every((id) => { const rule = m.provenance.getRule(id); return rule && rule.verification && rule.structure && rule.structure.length > 0 })

// ---------- the panel ----------

const treeOf = (node) => {
  const found = []
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      entry.forEach(visit)
    } else if (entry && typeof entry === 'object') {
      found.push(entry)
      visit(entry.children)
    }
  }

  visit(node)

  return found
}

// The results the provenance marks of a render are bound to, and every mark (a rule's too).
const marksIn = (nodes) => treeOf(nodes).filter((node) => node.tag === 'provenance-mark').map((node) => node.data.attrs && node.data.attrs.result).filter((result) => result !== undefined)
const markCount = (nodes) => treeOf(nodes).filter((node) => node.tag === 'provenance-mark').length

// What a compiled template renders for a mounted instance: the render function of the component's own template runs with the instance as its scope. Each element it creates is a record { tag, data, children } and each interpolated text is recorded; the scoped slots are functions of the record of the table, to be called with a row.
const rendered = (componentText, vm, overrides = {}) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source: componentText })
  const descriptor = parsed.descriptor || parsed
  const { code } = compiler.compileTemplate({ source: descriptor.template.content, filename: 'component.vue', id: 'component' })
  const render = require('vm').runInNewContext(`${code.replace(/export \{[^}]*\}\s*$/, '')}\nrender`, {})
  const tags = []
  const texts = []
  const make = (tag, data, children) => {
    const hasData = !Array.isArray(data)

    tags.push(tag)

    return { tag, data: (hasData ? data : null) || {}, children: (hasData ? children : data) || [] }
  }
  const helpers = { _self: { _c: make }, _l: (list, each) => (list || []).map(each), _v: (text) => text, _s: (value) => { texts.push(String(value)); return String(value) }, _e: () => null, _u: (slots) => Object.fromEntries(slots.map((slot) => [slot.key, slot.fn])), _m: () => null }
  const tree = render.call(new Proxy(vm, { get: (target, key) => (key in overrides ? overrides[key] : key in helpers ? helpers[key] : target[key]) }))

  return { tags, texts, tree }
}

const panel = (ctx) => {
  const w = world(ctx.m)
  const { rowsOf, pair, packet, production, row, tonnes, need, surface } = w
  const { options, componentText } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const READY = { loading: false, failed: '', error: '' }
  const sample = () => {
    const c = row(1)
    const p = production(c)
    const a = pair(1, { Duranium: tonnes('Duranium', 0.5 * p), Uridium: tonnes('Uridium', 0.4 * p), Gallicite: tonnes('Gallicite', 5 * p) })
    const b = pair(2, { Duranium: 0 })

    return rowsOf({ pairs: [a, b], needs: { 1: need({ Duranium: 1 }) }, packetRows: [packet(1, 100, { Uridium: tonnes('Uridium', 0.6 * p) })], surface: [surface(2, 1, { Amount: 30 })], plan: null }).map((entry) => ({ ...entry, name: entry.colony.PopName, place: 'Sol' }))
  }
  const mount = (data = {}) => instantiate(options, { $store: STORE, data: { rows: sample(), state: READY, problems: [], years: 1, horizons: ctx.m.ms.MSP_HORIZONS, ...data } })
  const drawn = (vm) => {
    const out = rendered(componentText, vm)
    const table = treeOf(out.tree).find((node) => node.tag === 'v-data-table')

    return { ...out, table, slots: table ? table.data.scopedSlots : {} }
  }
  const root = templateAst(componentText)
  const summary = root.attrsMap['data-summary'] || ''
  // The result each figure column marks: the one of the figure it shows.
  const FIGURES = { productionValue: (item) => item.production, stockOnlyValue: (item) => item.stockOnly.result, highValue: (item) => item.high.result, lowValue: (item) => item.low.result, deliveryText: (item) => (item.high.delivery ? item.high.delivery.msp : item.high.result) }

  add('panel: the panel is a top-level .panel with a data-summary of its own: text with letters, no digit, no first or second person', () => (classesOf(root).includes('panel') && summary.trim() !== '' && /[a-z]/i.test(summary) && !/\d/.test(summary) && !PRONOUNS.test(summary) ? true : `${root.tag} ${classesOf(root)} ${summary.length}`))
  add('panel: the rendered panel carries the data-summary of the template in every state: loading, failed, empty and populated', () => {
    const states = { loading: { rows: null, state: { loading: true, failed: '', error: '' } }, failed: { rows: null, state: { loading: false, failed: 'the read failed', error: 'boom' } }, empty: { rows: [] }, populated: {} }
    const shown = (data) => {
      const card = treeOf(rendered(componentText, mount(data)).tree).find((node) => node.tag === 'v-card')

      return card && card.data.attrs ? card.data.attrs['data-summary'] : undefined
    }
    const wrong = Object.entries(states).filter(([, data]) => { const text = shown(data); return typeof text !== 'string' || text.trim() === '' || text !== summary }).map(([name]) => name)

    return wrong.length === 0 && summary.trim() !== '' ? true : short(wrong)
  })
  add('panel: the template compiles and speaks in the impersonal voice, in its labels and its computed texts', () => {
    const errors = templateErrors(componentText)
    const vm = mount()
    const visible = staticTextOf(root).join(' ')
    const computed = vm.items.flatMap((item) => [vm.limitText(item.stockOnly), vm.limitText(item.high), vm.limitText(item.low), item.high.delivery ? vm.deliveryText(item.high.delivery) : '', ...item.deliveries.map((entry) => vm.arrivalText(entry))])

    return errors.length ? short(errors) : PRONOUNS.test(visible) ? `the template speaks to a person: ${(visible.match(PRONOUNS) || [])[0]}` : computed.some((text) => PRONOUNS.test(text)) ? 'a computed text speaks to a person' : true
  })
  add('panel: a row for each colony that makes supplies, with its stock-only, supplied and queue-first figures and its delivery, keyed once', () => {
    const vm = mount()
    const keys = vm.items.map((item) => item.key)
    const first = vm.items.find((item) => item.key === 1)

    return vm.items.length === 2 && new Set(keys).size === 2 && first.stockOnlyValue !== null && first.highValue !== null && first.deliveryText !== '' && first.notCountedCount === first.notCounted.length ? true : short([keys, first && first.deliveryText])
  })
  add('panel: the unknown figures sort last and show a dash, never 0', () => {
    const vm = mount({ rows: rowsOf({ pairs: [pair(1, { Duranium: null }), pair(2)] }).map((entry) => ({ ...entry, name: entry.colony.PopName, place: '' })) })
    const { table } = drawn(vm)
    const { items } = table.data.attrs
    const sorted = table.data.attrs['custom-sort']([...items], ['highValue'], [false])
    const unknown = vm.items.find((item) => item.key === 1)

    return unknown.highValue === null && vm.msp(null) === '—' && sorted[items.length - 1].highValue === null && sorted[0].highValue !== null ? true : short([unknown.highValue, vm.msp(null), sorted.map((item) => item.highValue)])
  })
  add('marks: every cell that shows a figure carries a mark bound to its own result', () => {
    const vm = mount()
    const { slots } = drawn(vm)
    const item = vm.items.find((entry) => entry.key === 1)
    const wrong = Object.entries(FIGURES).filter(([column, own]) => !slots[`item.${column}`] || !marksIn(slots[`item.${column}`]({ item })).includes(own(item))).map(([column]) => column)
    const counted = slots['item.notCountedCount'] && markCount(slots['item.notCountedCount']({ item })) > 0

    return !wrong.length && counted ? true : `no mark of its own result in ${wrong.join(', ')}${counted ? '' : ' notCountedCount'}`
  })
  add('marks: the detail row is the table of the figures, each delivery with its tonnes, its days and the output it adds, every figure marked with its result', () => {
    const vm = mount()
    const { slots } = drawn(vm)
    const item = vm.items.find((entry) => entry.key === 1)
    const detail = slots['expanded-item']({ headers: vm.headers, item })
    const tables = treeOf(detail).filter((node) => node.tag === 'v-simple-table')
    const marks = marksIn(detail)
    const own = item.deliveries[0]

    return tables.length === 1 && item.deliveries.length >= 1 && marks.includes(own.tonnes) && marks.includes(own.msp) && marks.includes(own.mspLow) && markCount(detail) >= 3 * item.deliveries.length ? true : `${tables.length} tables, ${item.deliveries.length} deliveries, ${marks.length} marks`
  })
  add('marks: a colony with no delivery says so in the detail row with a mark, and each colony\'s not counted deliveries are listed with their reason', () => {
    const vm = mount()
    const { slots } = drawn(vm)
    const plain = vm.items.find((entry) => entry.key === 2)
    const detail = slots['expanded-item']({ headers: vm.headers, item: plain })
    const listed = slots['expanded-item']({ headers: vm.headers, item: vm.items.find((entry) => entry.key === 1) })

    return markCount(detail) >= 1 && plain.notCounted.length > 0 && treeOf(listed).some((node) => node.data && node.data.attrs && 'data-msp-uncounted' in node.data.attrs) ? true : short([markCount(detail), plain.notCounted.length])
  })
  add('panel: the panel draws no chart, so the table is the figure', () => {
    const vm = mount()
    const { tags, slots } = drawn(vm)

    slots['expanded-item']({ headers: vm.headers, item: vm.items[0] })

    return tags.every((name) => name !== 'canvas' && !name.includes('chart')) && tags.includes('v-data-table') ? true : short(tags)
  })
  add('panel: the horizon toggle lists each period of the ledger, and a column of the table has a figure in every row', () => {
    const vm = mount()
    const { tags, table } = drawn(vm)
    const { items, headers } = table.data.attrs
    const missing = headers.filter((header) => !(header.value in items[0])).map((header) => header.value)

    return tags.filter((name) => name === 'v-btn').length === ctx.m.ms.MSP_HORIZONS.length && !missing.length ? true : `columns without a figure: ${missing.join(', ')}`
  })
  add('panel: the view of the horizon is a field the page keeps', () => {
    const fields = ctx.pagePersisted
    const horizon = fields && fields.mspHorizon

    return horizon && typeof horizon.key === 'string' && horizon.key !== '' && ctx.m.ms.MSP_HORIZONS.some((option) => option.years === horizon.default) && horizon.valid(horizon.default) === true && horizon.valid(123) === false && new Set(Object.values(fields).map((field) => field.key)).size === Object.keys(fields).length ? true : short(horizon)
  })

  return statements
}

// ---------- the page ----------

// The reads of the page that are tracked (their loadErrors entry is written when each settles), found by running each async read of the page and of its mixins against a database that fails: what the page declares, not what its text says.
const asyncNamesOf = (options) => [...(options.mixins || []).flatMap(asyncNamesOf), ...Object.keys(options.asyncComputed || {})]
const READS = new WeakMap()
const readsOf = async (ctx) => {
  if (!READS.has(ctx)) {
    const failing = { query: async () => { throw new Error('boom') } }
    const vm = instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database: failing, GameID: GAME, RaceID: RACE, data: { loadErrors: {} } })
    const tracked = []

    for (const key of new Set(asyncNamesOf(ctx.livePageOptions))) {
      try {
        await vm.runAsync(key)
      } catch (error) {
        // a failed read is still a tracked one
      }

      if (vm.loadErrors[key] !== undefined) {
        tracked.push(key)
      }
    }

    READS.set(ctx, tracked)
  }

  return READS.get(ctx)
}

const OWN = 'mspSupply'

// The tracked reads, other than the panel's own, whose failure holds the page back: the page is not ready while one is in error. A read of another panel that the page waits on in no way (the fleet stations) is not one.
const CORES = new WeakMap()
const coresOf = async (ctx) => {
  if (!CORES.has(ctx)) {
    const tracked = (await readsOf(ctx)).filter((key) => key !== OWN)
    const settled = Object.fromEntries(tracked.map((key) => [key, null]))

    CORES.set(ctx, tracked.filter((key) => !instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data: { loadErrors: { ...settled, [key]: 'down' } } }).ready))
  }

  return CORES.get(ctx)
}

const page = (ctx) => {
  const w = world(ctx.m)
  const { ms } = ctx.m
  const { pageText, pageOptions } = ctx
  const { row, pair, sources, packet, tonnes, production } = w
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const pageAst = templateAst(pageText)
  const mounted = elementsOf(pageAst).filter((element) => element.tag === 'msp-supply')
  const liveMount = (data = {}, extra = {}) => instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data, ...extra })
  const coreOf = () => coresOf(ctx)
  const settledOf = async () => Object.fromEntries((await coreOf()).map((key) => [key, null]))
  const loaded = () => {
    const a = pair(1, { Duranium: 0 })

    return { colonies: [row(1, { Duranium: 0 })], [OWN]: sources({ colonies: [a.source], packetRows: [packet(1, 100, { Duranium: tonnes('Duranium', 0.2 * production(a.colony)) })], problems: [{ source: 'mining', text: 'the mines could not be read' }] }), populationProductionModifiers: { 1: { OverallProductionModifier: 1 } }, navalAdmins: {}, formulaVersion: '2.7.x' }
  }

  add('page: the template compiles', () => { const errors = templateErrors(pageText); return errors.length ? short(errors) : true })
  add('page: the panel is mounted once with the page\'s own rows, state, problems and horizon, its retry reads the incoming minerals again and its toggle sets the horizon: each bound value is evaluated against the page', async () => {
    const { props, events } = mounted.length ? bindingsOf(mounted[0]) : { props: {}, events: {} }
    const settled = await settledOf()
    const at = (loadErrors, more = {}) => liveMount({ ...loaded(), loadErrors, ...more })
    const valueOf = (name, vm) => (props[name] === undefined ? undefined : evaluate(props[name], vm))
    const ready = at({ ...settled, [OWN]: null })
    const states = [{ ...settled }, { ...settled, [OWN]: 'down' }, { ...settled, [OWN]: null }].map((loadErrors) => at(loadErrors))
    const state = ['loading', 'failed', 'error'].every((name) => states.every((vm) => valueOf('state', vm)[name] === vm.mspSupplyState[name]) && new Set(states.map((vm) => valueOf('state', vm)[name])).size >= 2)
    const updates = []
    const retrying = at({ ...settled, [OWN]: 'down' }, { $asyncComputed: { [OWN]: { update: () => updates.push(OWN) } } })
    const retry = events.retry === undefined ? null : evaluate(events.retry, retrying)
    const toggled = at({ ...settled, [OWN]: null })
    const proxy = new Proxy(toggled, { has: (target, key) => key === '$event' || key in target, get: (target, key) => (key === '$event' ? 0.25 : target[key]), set: (target, key, next) => { target[key] = next; return true } })
    const handled = events.years === undefined ? null : evaluate(events.years, proxy)

    if (typeof retry === 'function') {
      retry()
    }

    if (typeof handled === 'function') {
      handled(0.25)
    }

    return mounted.length === 1 && same(valueOf('rows', ready), ready.mspSupplyTable) === true && ready.mspSupplyTable.length === 1 && valueOf('problems', ready) === ready.mspSupply.problems && valueOf('years', ready) === ready.mspHorizon && valueOf('horizons', ready) === ready.mspHorizonOptions && state && same(updates, [OWN]) === true && toggled.mspHorizon === 0.25 && 'MspSupply' in pageOptions.components ? true : `${short([props, events])} ${Object.keys(pageOptions.components)} ${updates} ${toggled.mspHorizon}`
  })
  add('page: the panel sits in the maintenance view inside the gate where every core read has loaded, whatever the state of its own read, after the locations panel', async () => {
    const core = await settledOf()
    const all = elementsOf(pageAst)
    const at = all.indexOf(mounted[0])
    const gates = []

    for (let node = mounted[0]; node; node = node.parent) {
      if (node.if) {
        gates.push(node.if)
      }
    }

    const shown = (loadErrors) => { const vm = liveMount({ loadErrors }); return gates.every((expression) => !!evaluate(expression, vm)) }
    const panels = all.map((element, index) => [element, index]).filter(([element, index]) => classesOf(element).includes('panel') && index < at).map(([, index]) => index)
    const failedCore = Object.keys(core).map((key) => shown({ ...core, [key]: 'down' }))

    return mounted.length === 1 && gates.length > 0 && shown(core) === true && shown({ ...core, [OWN]: 'down' }) === true && shown({ ...core, [OWN]: undefined }) === true && failedCore.length > 0 && failedCore.every((value) => value === false) && panels.length > 0 ? true : short([at, panels, shown(core), failedCore])
  })
  add('page: the read is a tracked read with its default, and its key is the asyncComputed name and the label key: a failure names itself', async () => {
    const tracked = await readsOf(ctx)
    const read = pageOptions.asyncComputed[OWN]
    const core = await coreOf()
    const named = liveMount({ loadErrors: { [OWN]: 'down' } }).mspSupplyState
    const unnamed = core.filter((key) => liveMount({ loadErrors: { [key]: 'down' } }).failedInputsText === '')

    return tracked.includes(OWN) && read && read.default === null && core.length > 0 && !unnamed.length && named.failed !== '' && named.error === 'down' && named.loading === false ? true : short([tracked, unnamed, named])
  })
  add('page: the read is of the race and game selected, and waits for a database, a game and a race', async () => {
    const empty = await instantiate(pageOptions, { $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data: { loadErrors: {} } }).runAsync(OWN)
    const noGame = await instantiate(pageOptions, { $store: PAGE_STORE, database: { query: async () => [[]] }, GameID: null, RaceID: RACE, data: { loadErrors: {} } }).runAsync(OWN)
    const noRace = await instantiate(pageOptions, { $store: PAGE_STORE, database: { query: async () => [[]] }, GameID: GAME, RaceID: null, data: { loadErrors: {} } }).runAsync(OWN)

    return empty === null && noGame === null && noRace === null ? true : short([empty, noGame, noRace])
  })
  add('page: the read takes the database, the game, the race and the withheld bonuses before its first await, so that a race switch reloads it', async () => {
    const log = []
    const failing = { query: async () => { throw new Error('boom') } }
    const fake = new Proxy({ loadErrors: {}, $set: (target, key, next) => { target[key] = next }, inputSettled: () => {} }, { get: (target, key) => { log.push(String(key)); return key === 'database' ? failing : key === 'GameID' ? GAME : key === 'RaceID' ? RACE : key === 'blockedBonuses' ? new Set() : target[key] }, set: (target, key, next) => { target[key] = next; return true } })
    const pending = pageOptions.asyncComputed[OWN].get.call(fake)
    const seen = [...log]

    await pending.catch(() => {})

    const missing = ['database', 'GameID', 'RaceID', 'blockedBonuses'].filter((key) => !seen.includes(key))

    return missing.length === 0 ? true : `read only after the first await: ${missing.join(', ')}`
  })
  add('page: a source that fails to read says what the save lacks in words, with no table or column name', async () => {
    const failing = { query: async () => { throw new Error('SQLITE_ERROR: no such column: FCT_Population.PopName') } }
    const vm = instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database: failing, GameID: GAME, RaceID: RACE, data: { loadErrors: await settledOf() } })
    const read = await vm.runAsync(OWN)
    const texts = read.problems.map((problem) => problem.text)

    return texts.length >= 5 && texts.every((text) => text.endsWith('could not be read (the save lacks the pop name of population)') && !/\b(?:FCT|DIM|VIR)_|\.\w|[a-z][A-Z]/.test(text)) ? true : short(texts)
  })
  add('page: a read that settles with sources it could not read is a success of the read and names each source it lacks', async () => {
    const failing = { query: async () => { throw new Error('boom') } }
    const vm = instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database: failing, GameID: GAME, RaceID: RACE, data: { loadErrors: await settledOf() } })
    const read = await vm.runAsync(OWN)

    return vm.loadErrors[OWN] === null && read.problems.length >= 5 && read.colonies === null && read.surface === null && read.packetRows === null && vm.ready === true ? true : short([vm.loadErrors[OWN], read.problems.length])
  })
  add('page: the rows of the panel are the ledger of the page\'s colonies at the chosen horizon, with the name and the place of each colony', async () => {
    const vm = liveMount({ ...loaded(), loadErrors: { ...await settledOf(), [OWN]: null } })
    const day = liveMount({ ...loaded(), loadErrors: { ...await settledOf(), [OWN]: null }, mspHorizon: 0.25 })
    const rows = vm.mspSupplyTable

    return rows.length === 1 && rows[0].name === 'C1' && typeof rows[0].place === 'string' && rows[0].years === vm.mspHorizon && day.mspSupplyTable[0].years === 0.25 && near(rows[0].high.result.value, ms.mspSupplyRows({ colonies: vm.colonies, sources: vm.mspSupply, modifierOf: vm.modifierOf, navalAdmins: vm.navalAdmins, formulaVersion: vm.formulaVersion, RaceID: RACE, years: vm.mspHorizon })[0].high.result.value) ? true : short(rows.map((entry) => [entry.name, entry.place, entry.years]))
  })

  return statements
}

// ---------- the read that holds nothing back ----------

const optional = (ctx) => {
  const w = world(ctx.m)
  const { row, pair, sources, packet, tonnes, production } = w
  const { options, componentText, livePageOptions } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const coreOf = () => coresOf(ctx)
  const settledOf = async () => Object.fromEntries((await coreOf()).map((key) => [key, null]))
  const failing = { query: async () => { throw new Error('boom') } }
  const mountPage = async (data = {}) => instantiate(livePageOptions, { $store: PAGE_STORE, database: failing, GameID: GAME, RaceID: RACE, data: { loadErrors: await settledOf(), ...data } })
  const stateOf = (vm) => vm.mspSupplyState
  const incoming = () => {
    const a = pair(1, { Duranium: 0 })

    return { colonies: [row(1, { Duranium: 0 })], [OWN]: sources({ colonies: [a.source], packetRows: [packet(1, 100, { Duranium: tonnes('Duranium', 0.2 * production(a.colony)) })] }), populationProductionModifiers: { 1: { OverallProductionModifier: 1 } }, navalAdmins: {}, formulaVersion: '2.7.x' }
  }
  const mountPanel = (state, rows = null) => instantiate(options, { $store: STORE, data: { rows, state: { loading: false, failed: '', error: '', ...state }, problems: [], years: 1, horizons: ctx.m.ms.MSP_HORIZONS } })

  add('optional: the other reads in, the page is ready while the read of the incoming minerals is in flight, and the panel is loading', async () => {
    const vm = await mountPage()

    return vm.ready === true && vm.inputsLoaded === true && same(stateOf(vm), { loading: true, failed: '', error: '' }) === true && vm.mspSupplyTable === null ? true : short([vm.ready, stateOf(vm), vm.mspSupplyTable])
  })
  add('optional: a failed read of the incoming minerals leaves the page ready with no failed input, and the panel reports the failure and shows no rows from the last good read', async () => {
    const vm = await mountPage({ ...incoming(), loadErrors: { ...await settledOf(), [OWN]: 'boom' } })
    const state = stateOf(vm)

    return vm.ready === true && vm.inputsLoaded === true && vm.failedInputs.length === 0 && vm.failedInputsText === '' && state.loading === false && state.error === 'boom' && state.failed.length > 0 && vm.mspSupplyTable === null ? true : short([vm.ready, vm.failedInputs, state, vm.mspSupplyTable])
  })
  add('optional: while the read is in flight again the panel shows the progress and no rows, however old the sources it holds', async () => {
    const vm = await mountPage({ ...incoming(), loadErrors: { ...await settledOf(), [OWN]: undefined } })

    return stateOf(vm).loading === true && vm.mspSupplyTable === null && vm.ready === true ? true : short([stateOf(vm), vm.mspSupplyTable])
  })
  add('optional: a failure of another read still holds the page back, and is not the panel\'s', async () => {
    const [first] = await coreOf()
    const vm = await mountPage({ loadErrors: { ...await settledOf(), [first]: 'down' } })

    return vm.ready === false && same(vm.failedInputs, [first]) === true && stateOf(vm).failed === '' ? true : short([vm.ready, vm.failedInputs, stateOf(vm)])
  })
  add('optional: a read that has settled leaves the panel neither loading nor failed, with rows for the colonies', async () => {
    const vm = await mountPage({ ...incoming(), loadErrors: { ...await settledOf(), [OWN]: null } })

    return vm.ready === true && same(stateOf(vm), { loading: false, failed: '', error: '' }) === true && vm.mspSupplyTable !== null && vm.mspSupplyTable.length === 1 ? true : short([vm.ready, stateOf(vm)])
  })
  add('optional: the retry reads again the read of the incoming minerals, whether it failed whole or settled with sources it could not read, and no other read', async () => {
    const updates = []
    const [first] = await coreOf()
    const $asyncComputed = Object.fromEntries([...await coreOf(), OWN].map((key) => [key, { update: () => updates.push(key) }]))

    ;(await mountPage({ $asyncComputed })).retryMspSupply()
    ;(await mountPage({ $asyncComputed, loadErrors: { ...await settledOf(), [OWN]: 'boom', [first]: 'down' } })).retryMspSupply()
    ;(await mountPage({ $asyncComputed, loadErrors: { ...await settledOf(), [OWN]: null } })).retryMspSupply()

    return same(updates, [OWN, OWN, OWN]) === true ? true : short(updates)
  })
  add('optional: every query of the read rejecting settles the read with each source named and marked as one to read again, the panel shows them with a Retry beside the table, and the Retry reads the incoming minerals again, the rest of the page staying up', async () => {
    const updates = []
    const settled = await settledOf()
    const loader = await mountPage()
    const read = await loader.runAsync(OWN)
    const page = await mountPage({ [OWN]: read, loadErrors: { ...settled, [OWN]: null }, $asyncComputed: { [OWN]: { update: () => updates.push(OWN) } } })
    const view = rendered(componentText, instantiate(options, { $store: STORE, data: { rows: [], state: page.mspSupplyState, problems: read.problems, years: 1, horizons: ctx.m.ms.MSP_HORIZONS } }), { $emit: (name) => { if (name === 'retry') page.retryMspSupply() } })
    const button = treeOf(view.tree).find((node) => node.data && node.data.attrs && 'data-msp-retry' in node.data.attrs)

    if (button && button.data.on && typeof button.data.on.click === 'function') {
      button.data.on.click()
    }

    return read.problems.length >= 5 && read.problems.every((problem) => problem.retry === true) && page.ready === true && page.failedInputs.length === 0 && same(page.mspSupplyState, { loading: false, failed: '', error: '' }) === true && view.tags.includes('v-data-table') && !view.tags.includes('load-state') && button && same(updates, [OWN]) === true ? true : short([read.problems.length, page.ready, page.mspSupplyState, view.tags, Boolean(button), updates])
  })
  add('optional: a source the save lacks, as against one that failed to read, is listed with no Retry', async () => {
    const problem = { source: 'freight', text: 'the save lacks a column' }
    const view = rendered(componentText, instantiate(options, { $store: STORE, data: { rows: [], state: { loading: false, failed: '', error: '' }, problems: [problem], years: 1, horizons: ctx.m.ms.MSP_HORIZONS } }))

    return view.tags.includes('v-data-table') && !treeOf(view.tree).some((node) => node.data && node.data.attrs && 'data-msp-retry' in node.data.attrs) && view.texts.some((text) => text.includes(problem.text)) ? true : short([view.tags, view.texts])
  })
  add('optional: the panel renders the failure or the progress and no table while the read is out, and the table once it is in', () => {
    const failed = rendered(componentText, mountPanel({ failed: 'the incoming minerals', error: 'boom' })).tags
    const loading = rendered(componentText, mountPanel({ loading: true })).tags
    const pending = rendered(componentText, mountPanel({}, null)).tags
    const read = rendered(componentText, mountPanel({}, [])).tags
    const hidden = (tags) => tags.includes('load-state') && !tags.includes('v-data-table')

    return hidden(failed) && hidden(loading) && hidden(pending) && read.includes('v-data-table') && !read.includes('load-state') ? true : short([failed, loading, pending, read])
  })
  add('optional: the panel shows no figure while the read is out: not a 0 and not a row', () => {
    const out = rendered(componentText, mountPanel({ failed: 'the incoming minerals', error: 'boom' }, [])).texts
    const waiting = rendered(componentText, mountPanel({ loading: true }, [])).texts

    return !out.some((text) => /^[\d,.]+$/.test(text)) && !waiting.some((text) => /^[\d,.]+$/.test(text)) ? true : short([out, waiting])
  })

  return statements
}

// ---------- the in-memory tables ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows]))))
const closeRaw = (raw) => new Promise((resolve) => raw.close(resolve))

// ---------- the saves ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve({ file: path.basename(resolved), query: (sql) => allRows(raw, sql), close: () => closeRaw(raw) })))
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

const saveStatements = async (ctx, save) => {
  const { ms, lg, provenance } = ctx.m
  const database = await openSave(save.file)

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const name = path.basename(save.file)
  const statements = []
  const add = (label, test) => statements.push([`save-ledger: ${name}: ${label}`, test])
  const where = `GameID = ${save.game} and RaceID = ${save.race}`
  const colonies = async () => rowsOf(database, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.MaintProdStatus, FCT_Population.Duranium, FCT_Population.Uridium, FCT_Population.Gallicite, FCT_Race.MSPProduction, coalesce(VIR_Installations.MaintenanceFacilities, 0) as MaintenanceFacilities from FCT_Population inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID left join (select FCT_PopulationInstallations.PopID, sum(DIM_PlanetaryInstallation.MaintenanceValue * FCT_PopulationInstallations.Amount) as MaintenanceFacilities from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${save.game} group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID where FCT_Population.GameID = ${save.game} and FCT_Population.RaceID = ${save.race} order by FCT_Population.PopulationID`)
  const ledger = async (years = 1) => {
    const read = await ms.loadMspSupply(database, { GameID: save.game, RaceID: save.race })
    const rows = await colonies()
    const out = ms.mspSupplyRows({ colonies: rows, sources: read, modifierOf: () => 1, navalAdmins: {}, formulaVersion: '2.7.x', RaceID: save.race, years })

    return { read, rows, out }
  }

  add('the loader reads every source of the race and the rows are one for each colony that makes supplies, counted against the raw rows', async () => {
    const { read, rows, out } = await ledger()
    const raw = rows.filter((entry) => entry.MaintenanceFacilities > 0 && entry.MaintProdStatus !== 0).length
    const [{ packets }] = await rowsOf(database, `select count(*) as packets from FCT_MassDriverPackets where ${where}`)

    return read.problems.length === 0 && out.length === raw && read.packetRows.length === packets ? true : short([read.problems, out.length, raw, read.packetRows && read.packetRows.length, packets])
  })
  add('the ledger of every colony balances to the tonne, over a quarter of a year and over two', async () => {
    const quarter = (await ledger(0.25)).out
    const two = (await ledger(2)).out

    return Math.max(...quarter.map((entry) => entry.balance || 0), ...two.map((entry) => entry.balance || 0)) < 1e-4 ? true : short(Math.max(...quarter.map((entry) => entry.balance || 0)))
  })
  add('the stock-only output over a year is the Logistics figure for every colony with a known stock, and the supplied one is never below it', async () => {
    const { out } = await ledger()
    const wrong = out.filter((entry) => provenance.valueOrNull(entry.stockOnly.result) !== null && (!near(provenance.valueOrNull(entry.stockOnly.result), provenance.valueOrNull(lg.mspOutput(entry.colony, 1))) || provenance.valueOrNull(entry.high.result) < provenance.valueOrNull(entry.stockOnly.result) - 1e-6)).map((entry) => entry.colony.PopName)

    return wrong.length === 0 && out.length > 0 ? true : short(wrong)
  })
  add('a packet counted for a colony is a packet of the race bound for it, each with a speed and a destination the save holds', async () => {
    const { read } = await ledger()
    const [{ stalled }] = await rowsOf(database, `select count(*) as stalled from FCT_MassDriverPackets inner join FCT_Population on FCT_Population.PopulationID = FCT_MassDriverPackets.DestID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_MassDriverPackets.${where.replace(' and ', ' and FCT_MassDriverPackets.')} and FCT_SystemBody.Xcor = 0 and FCT_SystemBody.Ycor = 0`)
    const stalledHere = read.packetRows.filter((entry) => ms.packetArrival(entry).days === null && entry.DestXcor === 0 && entry.DestYcor === 0).length

    return stalledHere === stalled ? true : `${stalledHere} != ${stalled}`
  })

  return { skipped: false, statements, close: () => database.close() }
}

// ---------- the planted faults ----------

/* eslint-disable no-template-curly-in-string */
const MUTATIONS = [
  { name: 'mines read as unlimited supply again where a deposit stands under them', file: L, find: 'msp: isNumber(colony[mineral.name]) ? Math.max(0, colony[mineral.name]) / mineral.perMsp : null }))', replace: 'msp: colony.Mines > 0 && colony[`Deposit${mineral.name}`] > 0 ? Infinity : isNumber(colony[mineral.name]) ? Math.max(0, colony[mineral.name]) / mineral.perMsp : null }))', fails: ['local'] },
  { name: 'a delivery credited on the first tick whatever its day', file: U, find: 'const step = stepOf(inflow.day)', replace: 'const step = 1', fails: ['late'] },
  { name: 'a delivery credited on the tick before its arrival', file: U, find: 'Math.max(1, Math.ceil(day - EPSILON))', replace: 'Math.max(1, Math.floor(day))', fails: ['late'] },
  { name: 'a packet counted twice', file: U, find: 'inflows.push({ group: \'packets\', kind: \'packets\', mineral: name, tonnes: packet[name], day: arrival.days })', replace: 'inflows.push({ group: \'packets\', kind: \'packets\', mineral: name, tonnes: packet[name], day: arrival.days }, { group: \'packets\', kind: \'packets\', mineral: name, tonnes: packet[name], day: arrival.days })', fails: ['once'] },
  { name: 'every colony counts every packet', file: U, find: 'const packets = sources.packetRows.filter((packet) => packet.DestID === id)', replace: 'const packets = sources.packetRows.filter(() => true)', fails: ['once'] },
  { name: 'a haul that does not debit its source', file: U, find: 'outflows.push({ group, mineral: mineral.name, tonnes: scaled.get(`${haul.key}:${mineral.name}`) })', replace: 'scaled.get(`${haul.key}:${mineral.name}`)', fails: ['hauls'] },
  { name: 'a haul not cut to what its source\'s production leaves', file: U, find: 'const share = total > cap && total > 0 ? cap / total : 1', replace: 'const share = 1', fails: ['hauls'] },
  { name: 'a tonne a haul gives that stays in the stock', file: U, find: 'held[outflow.mineral] -= given', replace: 'void given', fails: ['once'] },
  { name: 'the amount of a deposit ignored', file: U, find: 'const amount = known ? Math.max(...entry.amounts) : null', replace: 'const amount = 1e12', fails: ['local'] },
  { name: 'a deposit kept apart for each colony on its body', file: U, find: 'const deposit = deposits.get(`${rows[0].SystemBodyID}:${MATERIAL[name]}`)', replace: 'const deposit = depositsOf({ surface: sources.surface.filter((row) => row.PopulationID === id), orbital: sources.orbital.filter((row) => row.PopulationID === id), navalAdmins, days }).get(`${rows[0].SystemBodyID}:${MATERIAL[name]}`)', fails: ['shared'] },
  { name: 'the taxed output of civilian complexes left out of what a deposit gives', file: U, find: 'surfaceRateResult(row, false)', replace: 'surfaceRateResult(row, true)', fails: ['shared'] },
  { name: 'an unknown deposit amount read as known', file: U, find: 'const known = entry.amounts.every(isNumber)', replace: 'const known = true', fails: ['local'] },
  { name: 'the exported minerals besides the input ones kept at their start surplus', file: U, find: 'otherHeld[index] -= value * fraction', replace: 'void value', fails: ['export'] },
  { name: 'a surplus of under a tonne exported', file: U, find: 'if (total >= MIN_LAUNCH) {', replace: 'if (total > EPSILON) {', fails: ['export'] },
  { name: 'a freighter left free after it is given to a haul', file: U, find: 'free[best.index] -= best.ships', replace: 'void best', fails: ['hauls'] },
  { name: 'a haul given every free ship of its class', file: U, find: 'const ships = Math.min(estimate.holds, free[index])', replace: 'const ships = free[index]', fails: ['hauls'] },
  { name: 'a negative stock held as it is', file: U, find: 'const start = Object.fromEntries(NAMES.map((name) => [name, Math.max(0, stock[name])]))', replace: 'const start = Object.fromEntries(NAMES.map((name) => [name, stock[name]]))', fails: ['local'] },
  { name: 'a read that could not be made not marked to be read again', file: U, find: 'problems.push({ source, retry: true, text:', replace: 'problems.push({ source, text:', fails: ['optional'] },
  { name: 'the Retry beside the sources not read removed', file: V, at: /<v-btn\s+v-if="retryable"[\s\S]*?<\/v-btn>/, to: () => '', fails: ['optional'] },
  { name: 'the retry of the page that reads again only a failed read', file: P, find: 'MSP_INPUTS.forEach((key) => this.$asyncComputed[key].update())', replace: 'MSP_INPUTS.filter((key) => this.loadErrors[key]).forEach((key) => this.$asyncComputed[key].update())', fails: ['optional'] },
  { name: 'the maintenance draw protected by the reserve', file: U, find: 'const allowed = NAMES.map((name) => held[name] / PER_MSP[name])', replace: 'const allowed = NAMES.map((name) => Math.max(0, held[name] - (exporter ? exporter.reserve[name] : 0)) / PER_MSP[name])', fails: ['export'] },
  { name: 'the export that ignores the reserve', file: U, find: 'const surplus = Object.fromEntries(NAMES.map((name) => [name, Math.max(0, held[name] - exporter.reserve[name])]))', replace: 'const surplus = Object.fromEntries(NAMES.map((name) => [name, Math.max(0, held[name])]))', fails: ['export'] },
  { name: 'the queue-first figure naming the failed read as it was stored', file: U, find: "missing: ['the queue needs of the input minerals'] })", replace: "missing: notCounted.filter((entry) => entry.kind === 'queue').map((entry) => entry.text) })", fails: ['unknown'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'a failed read showing the database error as it came', file: U, find: 'could not be read (${failureWords(error)})', replace: 'could not be read (${error.message})', fails: ['page'] },
  { name: 'the queue-first run that skips the queue', file: U, find: 'const low = colony.queue ? simulate({ ...colony, days }) : null', replace: 'const low = colony.queue ? simulate({ ...colony, queue: null, days }) : null', fails: ['queue'] },
  { name: 'the limiting mineral of the supplied output not named', file: U, find: 'limiting: run.limiting, delivery: deliveryOf(groups)', replace: 'limiting: null, delivery: deliveryOf(groups)', fails: ['limiting'] },
  { name: 'the conditional delivery of the stock-only output not named', file: U, find: 'limiting: allocation.stockOnly.limiting, delivery: deliveryOf(allocation.highGroups)', replace: 'limiting: allocation.stockOnly.limiting, delivery: null', fails: ['limiting'] },
  { name: 'the stock-only limiting mineral not named', file: U, find: 'limiting: allocation.stockOnly.limiting, delivery: deliveryOf(allocation.highGroups)', replace: 'limiting: null, delivery: deliveryOf(allocation.highGroups)', fails: ['limiting'] },
  { name: 'a packet with no arrival time counted on the first tick', file: U, find: 'if (arrival.days === null) {', replace: 'if (false) {', fails: ['unknown'] },
  { name: 'a packet bound for a body at 0, 0 counted', file: U, find: '} else if (packet.DestXcor === 0 && packet.DestYcor === 0) {', replace: '} else if (false) {', fails: ['unknown'] },
  { name: 'an unknown stock read as none held', file: U, find: '...NAMES.filter((name) => !isNumber(colony[name])).map((name) => `the colony\'s stock of ${name}`)', replace: '...[]', fails: ['unknown'] },
  { name: 'an unknown queue read as an empty one', file: U, find: '(needRow[`Missing${name}`] > 0 || !isNumber(needRow[name]) ? null : needRow[name])', replace: '(needRow[name] || 0)', fails: ['queue'] },
  { name: 'the read of the incoming minerals made one the page waits for', file: P, find: 'const MSP_INPUTS = [\'mspSupply\']', replace: 'const MSP_INPUTS = []', fails: ['optional'] },
  { name: 'the panel never loading', file: P, find: 'loading: failed.length === 0 && !allLoaded(this.loadErrors, keys)', replace: 'loading: false', fails: ['optional'] },
  { name: 'the rows shown while the read is failed or in flight', file: P, find: 'if (!this.mspSupply || this.mspSupplyState.loading || this.mspSupplyState.failed) {', replace: 'if (!this.mspSupply) {', fails: ['optional'] },
  { name: 'the label of the read under another key than its read', file: P, at: /(\n\s+)mspSupply(\s*:\s*'[^']*')/, to: (m) => `${m[1]}mspSupplies${m[2]}`, fails: ['page'] },
  { name: 'the bonuses read after the first await', file: P, find: 'const blocked = this.blockedBonuses\n\n        if (!database || !GameID || !RaceID) {', replace: 'const blocked = await Promise.resolve().then(() => this.blockedBonuses)\n\n        if (!database || !GameID || !RaceID) {', fails: ['page'] },
  { name: 'the data-summary of the panel removed', file: V, at: null, find: null, replace: null, fails: ['panel'] },
  { name: 'the mark of the stock-only figure removed', file: V, at: /<provenance-mark\s+:result\s*=\s*"item\.stockOnly\.result"\s*\/>/, to: () => '', fails: ['marks'] },
  { name: 'a packet in another system than its destination held back', file: U, find: '} else if (packet.DestXcor === 0 && packet.DestYcor === 0) {', replace: '} else if (packet.SysID !== packet.DestSystemID) {\n    return { days: null, why: \'other system\' }\n  } else if (packet.DestXcor === 0 && packet.DestYcor === 0) {', fails: ['unknown'] },
  { name: 'the drivers counted as the fractional installations', file: U, find: 'cast(FCT_PopulationInstallations.Amount + 1e-9 as integer)', replace: 'FCT_PopulationInstallations.Amount', fails: ['export'] },
  { name: 'the packets of the race read by the race that launched them', file: U, find: '(FCT_MassDriverPackets.RaceID = ${RaceID} or FCT_Population.RaceID = ${RaceID})', replace: 'FCT_MassDriverPackets.RaceID = ${RaceID}', fails: ['once'] },
  { name: 'the packets in flight read by the race that launched them', file: M, find: '(FCT_MassDriverPackets.RaceID = ${RaceID} or VIR_Destination.RaceID = ${RaceID})', replace: 'FCT_MassDriverPackets.RaceID = ${RaceID}', fails: ['once'] },
  { name: 'the other minerals of an outgoing haul left out of the export\'s stock', file: U, find: 'aboard.forEach((mineral) => outflows.push({ group, mineral: mineral.name, tonnes: mineral.tonnes }))', replace: 'void aboard', fails: ['export'] },
  { name: 'the other minerals a haul carries taken out of nothing', file: U, find: 'otherHeld[index] -= Math.min(otherHeld[index], outflow.tonnes)', replace: 'void index', fails: ['export'] },
  { name: 'a bound summary overriding the static one on the panel', file: V, at: /<v-card\b[^>]*/, to: (m) => `${m[0]} :data-summary="String()"`, fails: ['panel'] },
]
/* eslint-enable no-template-curly-in-string */

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// The same planted faults on the source with every benign edit applied.
const COMPOSED = MUTATIONS.map((mutation, index) => ({ id: `composed:${index}`, ...mutation }))

// Edits that must change nothing the checks look at: the summary and the header reworded, whitespace before an equals sign and a reordered list of attributes on the page's mount and on a marked cell, the columns in another order, another default horizon and the bound values written another way. Each is located by its structure (the attribute, the key or the state it belongs to and its whole value, with any spacing around `=` and either quote), never by what it holds now, so it still applies after the others.
const QUOTED = '"[^"]*"|\'[^\']*\''
const attribute = (name) => new RegExp(`(?<=\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(${QUOTED})`)
const valueOf = (quoted) => quoted.slice(1, -1)
const quote = (text) => (text.includes('"') ? `'${text}'` : `"${text}"`)

// The attributes inside a start tag, as name and whole value, put in the opposite order and written out again.
const ATTRIBUTES = new RegExp(`([^\\s=]+)(?:\\s*=\\s*(${QUOTED}))?`, 'g')
const reversed = (inside) => [...inside.matchAll(ATTRIBUTES)].reverse().map(([, name, value]) => (value === undefined ? name : `${name}=${value}`)).join(' ')
const SLOT = (column) => `<template\\s+#\\[\`item\\.${column}\`\\]\\s*=\\s*"[^"]*"\\s*>`

const BENIGN = [
  { name: 'the summary reworded', file: V, at: attribute('data-summary'), to: () => 'data-summary="Maintenance supplies per colony over a period, with the delivery each output waits for and what the save leaves out."' },
  { name: 'the summary shortened to one sentence', file: V, at: attribute('data-summary'), to: () => 'data-summary="Compare the maintenance supplies of each colony with and without incoming minerals."' },
  { name: 'the header of the panel reworded', file: V, at: /(<div class="panel-head">\s*<span[^>]*>)[^<]*/, to: (m) => `${m[1]}Incoming minerals and maintenance` },
  { name: 'the foot of the panel reworded', file: V, at: /(<div class="panel-foot[^"]*">)[^<]*/, to: (m) => `${m[1]}\n        The figures are an estimate from the saved game.\n      ` },
  { name: 'whitespace around the equals sign of a bound property on the mount', file: P, at: attribute(':rows'), to: (m) => `:rows  =  ${m[1]}` },
  { name: 'the attributes of the mount reordered', file: P, at: /(<msp-supply)([^>]*?)(\s*\/>)/, to: (m) => `${m[1]} ${reversed(m[2])}${m[3]}` },
  { name: 'the rows given to the panel in parentheses', file: P, at: attribute(':rows'), to: (m) => `:rows=${quote(`(${valueOf(m[1])})`)}` },
  { name: 'the horizon given to the panel as a negated negation', file: P, at: attribute(':years'), to: (m) => `:years=${quote(`+${valueOf(m[1])}`)}` },
  { name: 'whitespace in the mark of a figure cell', file: V, at: new RegExp(`(${SLOT('stockOnlyValue')}[\\s\\S]*?)<provenance-mark\\s+:result\\s*=\\s*(${QUOTED})\\s*/>`), to: (m) => `${m[1]}<provenance-mark  :result = ${m[2]}  />` },
  { name: 'the attributes of a figure cell reordered', file: V, at: new RegExp(`(${SLOT('highValue')}\\s*<span)([^>]*)>`), to: (m) => `${m[1]} ${reversed(m[2])}>` },
  { name: 'the columns of the table in the opposite order', file: V, at: /(headers\(\) \{\s*return \[\n)([\s\S]*?)(\n\s*\]\n\s*\})/, to: (m) => `${m[1]}${m[2].split('\n').reverse().join('\n')}${m[3]}` },
  { name: 'another default horizon', file: P, at: /(mspHorizon:\s*\{\s*key:\s*'logisticsMspHorizon',\s*default:\s*)[\d.]+/, to: (m) => `${m[1]}0.5` },
  { name: 'the label of the read reworded', file: P, at: /(\n\s+mspSupply\s*:\s*')[^']*'/, to: (m) => `${m[1]}the mineral deliveries'` },
  { name: 'the retry of the sources not read reworded', file: V, at: /(<v-btn\s+v-if="retryable"[^>]*>)[^<]*/, to: (m) => `${m[1]}Read again` },
].map((edit, index) => ({ id: `benign:${index}`, ...edit }))

// The text to find and its replacement for a planted fault or a benign edit: the literal `find` and `replace`, or what the pattern `at` matches (exactly once) and `to` makes of the match.
const resolved = (edit, text) => {
  if (!edit.at) {
    if (edit.find === null) {
      return resolvedSummary(text)
    }

    return edit
  }

  const all = [...text.matchAll(new RegExp(edit.at.source, `${edit.at.flags}g`))]

  if (all.length !== 1) {
    throw new Error(`The pattern of ${edit.name} matches ${all.length} times, not once`)
  }

  return { find: all[0][0], replace: edit.to(all[0]) }
}

// The planted fault that removes the summary: the attribute, wherever it stands and however it is written.
const resolvedSummary = (text) => {
  const all = [...text.matchAll(new RegExp(attribute('data-summary').source, 'g'))]

  if (all.length !== 1) {
    throw new Error(`The data-summary matches ${all.length} times, not once`)
  }

  return { find: all[0][0], replace: '' }
}

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, () => fs.readFileSync(file, 'utf8')]))

// The sources with one edit (a planted fault or a benign edit) applied.
const applied = (sources, edit) => {
  const change = resolved(edit, sources[edit.file])

  return { ...sources, [edit.file]: patched(path.basename(FILES[edit.file]), sources[edit.file], change.find, change.replace) }
}

// The sources one run reads: the real ones, or the real ones with one planted fault.
const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((name) => [name, TEXTS[name]()]))

  return mutant ? applied(sources, mutant) : sources
}

// The real sources with every benign edit applied in turn.
const stackedSources = () => BENIGN.reduce((sources, edit) => applied(sources, edit), sourcesOf(null))

const contextOf = async (sources) => {
  const changed = (name) => sources[name] !== TEXTS[name]()
  const haulPlan = haulStubbed(fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', 'haul-plan.js'), 'utf8'))
  const sourcesFor = { 'haul-plan': haulPlan, ...(changed(U) ? { 'msp-supply': sources[U] } : {}), ...(changed(L) ? { logistics: sources[L] } : {}), ...(changed(M) ? { 'colony-minerals': sources[M] } : {}) }
  const utilitySources = { ...(changed(U) ? { 'utilities/msp-supply': sources[U] } : {}), ...(changed(L) ? { 'utilities/logistics': sources[L] } : {}), ...(changed(M) ? { 'utilities/colony-minerals': sources[M] } : {}) }
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: sourcesFor })
  const options = await loadPage('components/logistics/MspSupply', { stubs: STUBS, sources: { 'components/logistics/MspSupply': sources[V], ...utilitySources } })
  const recorder = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults, table: true }); export default (fields) => { globalThis.__persistedFields = fields; return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'
  const pageSources = { 'pages/logistics': sources[P], ...utilitySources }
  const pageOptions = await loadPage('pages/logistics', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB, 'mixins/persisted-view': recorder }, sources: pageSources })
  const pagePersisted = globalThis.__persistedFields
  const livePageOptions = await loadPage('pages/logistics', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB, 'mixins/load-state': null }, sources: pageSources })

  return { m: { ms: loaded['msp-supply'], lg: loaded.logistics, mo: loaded['mineral-outlook'], provenance: loaded.provenance, minerals: loaded.minerals, cm: loaded['colony-minerals'] }, options, pageOptions, pagePersisted, livePageOptions, componentText: sources[V], pageText: sources[P] }
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
  const statements = [...pure(ctx), ...panel(ctx), ...page(ctx), ...optional(ctx)]
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

  console.log('\nMaintenance supplies with incoming minerals: the ledger of a colony\'s input minerals over a period, on colonies worked by hand, the panel, the page and the saves')

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

const checkMutant = async (mutant, composed = false) => {
  const began = Date.now()
  const label = `${composed ? 'mutation caught on the stacked benign edits' : 'mutation caught'}: ${mutant.name}`
  let sources

  try {
    sources = composed ? applied(stackedSources(), mutant) : sourcesOf(mutant)
  } catch (error) {
    check(label, `invalid mutant: ${error.message}`)

    return
  }

  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(label, `does not load: ${error.message}`)

    return
  }

  const required = mutant.fails.filter((key) => !key.startsWith('save-'))
  const { statements } = await statementsOf(ctx, false)
  const present = (key) => statements.some(([name]) => keyOf(name) === key)
  const absent = required.filter((key) => !present(key))
  const results = await runStatements(statements, required)
  const missed = required.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  check(label, !required.length ? 'names no group of checks that needs no save' : absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// An edit that changes no behaviour (wording, whitespace, the order of attributes) leaves every check that needs no save green: the checks look at what the sources do, not at how they are written.
const checkBenign = async (edit) => {
  const began = Date.now()
  let results

  try {
    const ctx = await contextOf(sourcesOf(edit))
    const { statements } = await statementsOf(ctx, false)

    results = await runStatements(statements)
  } catch (error) {
    check(`benign edit kept: ${edit.name}`, `does not load: ${error.message}`)

    return
  }

  const failed = results.filter(([, result]) => result !== true)

  check(`benign edit kept: ${edit.name}`, failed.length ? short(failed.map(([name, result]) => [name, result])) : true, `${results.length} checks stay green, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// The benign edits are independent of one another: each is located by structure, so it still applies to a source another has already changed, and the source with every one of them applied (in order) is still green.
const checkStacked = async () => {
  const began = Date.now()
  const base = sourcesOf(null)
  const conflicts = []

  for (const first of BENIGN) {
    let after

    try {
      after = applied(base, first)
    } catch (error) {
      conflicts.push(`${first.name}: ${error.message}`)

      continue
    }

    for (const second of BENIGN) {
      try {
        applied(after, second)
      } catch (error) {
        conflicts.push(`${second.name} after ${first.name}: ${error.message}`)
      }
    }
  }

  check('benign edits: each still applies to a source another has changed', conflicts.length ? short(conflicts) : true, `${BENIGN.length * BENIGN.length} pairs`)

  let results

  try {
    const ctx = await contextOf(BENIGN.reduce((sources, edit) => applied(sources, edit), base))
    const { statements } = await statementsOf(ctx, false)

    results = await runStatements(statements)
  } catch (error) {
    check('benign edits: all of them together keep every check green', `does not load: ${error.message}`)

    return
  }

  const failed = results.filter(([, result]) => result !== true)

  check('benign edits: all of them together keep every check green', failed.length ? short(failed.map(([name, result]) => [name, result])) : true, `${results.length} checks stay green, ${((Date.now() - began) / 1000).toFixed(1)} s`)
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
    const edit = BENIGN.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else if (COMPOSED.some(({ id }) => id === options.part)) {
      await checkMutant(COMPOSED.find(({ id }) => id === options.part), true)
    } else if (edit) {
      await checkBenign(edit)
    } else if (options.part === 'stacked') {
      await checkStacked()
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const benign = options.mutations ? BENIGN : []
  const extra = options.saves ? [] : ['--no-saves']
  const stacked = options.mutations ? ['stacked'] : []
  const composed = options.mutations ? COMPOSED : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...extra], weight: 30 }, ...[...wanted, ...benign, ...composed].map(({ id }) => ({ args: ['--part', id, ...extra], weight: 3 })), ...stacked.map((id) => ({ args: ['--part', id, ...extra], weight: 5 }))])
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

  if (benign.length) {
    console.log('\nBenign edits: each must leave every save-free check green')
    benign.forEach(printed)
  }

  if (stacked.length) {
    console.log('\nBenign edits stacked: each still applies after any other, and all of them together leave every save-free check green')
    stacked.forEach(printed)
  }

  if (composed.length) {
    console.log('\nPlanted faults on the source with every benign edit applied: each must still apply once and fail the checks it names')
    composed.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
