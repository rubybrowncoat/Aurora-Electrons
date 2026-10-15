/* eslint-disable no-template-curly-in-string */
/*
  Checks the mining redeployment queue (src/renderer/utilities/mining-redeployment.js and the mining-redeployment warning of src/renderer/utilities/warnings/colonies.js) on worked fixtures, on in-memory SQLite and, read-only, on the colonies and orbital miners the saves hold.

  bun scripts/check-mining-redeployment.js [--no-mutations] [--save <save.db> <GameID> <RaceID>]...

  Fixtures: mines at a body whose deposit rows are all at 0 t (exhausted), at a surveyed body with no row (empty), with a deposit left, automated only, civilian only; orbital miners at an exhausted, empty, oversized or colony-less body, those reasons together on one site, a ship with one module (assessed), a diameter limit or diameter that is not stored (unknown, never "fits" and never oversized), a body the race has not surveyed, a save that is not 2.7-shaped, counts of ships and modules and of mines, the destination requirements and the inputs a relocation lacks (travel, production, stored). The mine counts and the fleet speed queries run against an in-memory SQLite, and the warning's rows, cells, links and signatures against a fake database of fixture rows.

  Saves: with no recommendation to be had in a real save (the sample saves hold no exhausted mine and no miner out of its limits), the queue is compared with queries written another way on each save as it stands, then with the rows the app's own loaders read from the save changed in memory (deposit rows at 0 t, a body wider than the limit, a missing limit, a ship with one module, a body with no colony, modules all damaged), the saves never written to. A save that is not there is reported as skipped and never counted as passed.

  Mutations: each planted fault in the utility, the sites it reads or the warning must fail the checks it names, and every one of them names a fixture check so that it is caught with no save there. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const utilities = path.join(root, 'src', 'renderer', 'utilities')
const NAMES = ['mining-redeployment', 'mining-sites', 'provenance', 'capabilities', 'warnings/common', 'warnings/index']
const DEFAULT_SAVES = [
  { label: 'modded', file: 'AuroraDB.db', game: 140, race: 784 },
  { label: 'stock', file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
]
// The parts run as children of the one that was started, so the saves given on its command line reach them through the environment.
const SAVES = process.env.MINING_REDEPLOYMENT_SAVES ? JSON.parse(process.env.MINING_REDEPLOYMENT_SAVES) : DEFAULT_SAVES
const STUBS = {
  'electron-store': 'export default class Config { constructor() {} get store() { return {} } set store(value) {} }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const KEY = 'mining-redeployment'
const VERSION = '2.7.1'
const MISSING = (result) => (result && result.inputs ? result.inputs.missing : [])

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

const skip = (reason) => ({ skipped: reason })

// ---------- fixtures ----------

const RACE = 784
const colony = (over = {}) => ({ PopulationID: 1, PopName: 'Alpha', SystemID: 10, SystemName: 'Sol', SystemBodyID: 500, SystemBodyName: 'Alpha I', Population: 5, Efficiency: 1, Capital: 0, MassDriverDest: 0, MineProduction: 600, RadiationLevel: 0, Surveyed: 1, Deposits: 2, DepositGaps: 0, Depleted: 0, Manned: 3, Automated: 0, Civilian: 0, MineGaps: 0, MineNames: '3x Mine', Drivers: 0, DriverGaps: 0, Factories: 0, FactoryGaps: 0, DestinationID: null, DestinationRaceID: null, DestinationSystemID: null, DestinationDrivers: 0, DestinationGaps: 0, OtherColonies: 2, HaulOrders: 0, MannedMines: 3, AutomatedMines: 0, ...over })
const noMines = { Manned: 0, Automated: 0, Civilian: 0, MineNames: null, MannedMines: 0, AutomatedMines: 0 }
const fleet = (over = {}) => ({ FleetID: 100, FleetName: 'Miner', AssignedPopulationID: 0, SystemName: 'Sol', SystemBodyID: 500, SystemBodyName: 'Alpha I', Diameter: 1000, MaximumDiameter: 4000, MineProduction: 600, Surveyed: 1, Deposits: 2, DepositGaps: 0, Depleted: 0, ColonyID: 1, ColonyName: 'Alpha', AssignedID: null, AssignedName: null, ShipID: 1, CurrentCrew: 10, ClassCrew: 10, Modules: 5, ClassLines: 3, WorkingModules: 5, Speed: 1, ...over })
const gone = { Deposits: 0, Depleted: 0 }
const exhausted = { Deposits: 0, Depleted: 2 }

const count = (value) => String(value)

const assess = (m, colonies, fleets, version = VERSION) => m.redeploy.assessRedeployment(m.sites.assessMiningSites({ colonies, fleets }, { RaceID: RACE, version, count }), { count })

const reasons = (item) => item.reasons.map((reason) => reason.key)

const only = (list) => {
  assert.equal(list.length, 1, `${list.length} recommendations, not one`)

  return list[0]
}

const stored = (item) => item.unknown.stored.join(' | ')

// ---------- statements: [key:name, run], each returning true, a reason, or throwing ----------

const fixtures = (m) => {
  const ground = (over) => only(assess(m, [colony(over)], []).ground)
  const orbital = (over, version) => only(assess(m, [], [fleet(over)], version).orbital)
  const together = (...ships) => only(assess(m, [], ships.map((ship, index) => fleet({ ShipID: index + 1, ...ship }))).orbital)

  return [
    ['ground: mines at a body whose deposit rows are all at 0 t are queued as exhausted', () => {
      const item = ground({ ...exhausted })

      assert.equal(item.verdict, 1)
      assert.deepEqual(reasons(item), ['exhausted'])
      assert.equal(item.reasons[0].need.text, 'Every deposit on the body is exhausted')
    }],
    ['ground: a surveyed body with no deposit row is queued as empty, in other words than exhausted', () => {
      const item = ground({ ...gone })

      assert.equal(item.verdict, 1)
      assert.deepEqual(reasons(item), ['empty'])
      assert.equal(item.reasons[0].need.text, 'No mineral deposit on the body')
    }],
    ['ground: a body with a deposit left is not queued whatever its mines', () => {
      assert.equal(ground({ Deposits: 1 }).verdict, 0)
      assert.equal(ground({ Deposits: 1, Depleted: 3 }).verdict, 0)
    }],
    ['ground: an automated-only colony is queued and a civilian-only one is not', () => {
      assert.equal(ground({ ...exhausted, MannedMines: 0, Manned: 0, AutomatedMines: 2, Automated: 2 }).verdict, 1)
      assert.equal(ground({ ...exhausted, MannedMines: 0, Manned: 0, Civilian: 7 }).verdict, 0)
    }],
    ['ground: a colony with orbital miners and no mines is no ground recommendation', () => {
      const model = assess(m, [colony({ ...noMines, ...exhausted })], [fleet({ AssignedPopulationID: 1, AssignedID: 1 })])

      assert.equal(model.ground.length, 0)
      assert.equal(model.orbital.length, 1)
    }],
    ['ground: other missing prerequisites are named beside the reason, not made reasons', () => {
      const item = ground({ ...exhausted, RadiationLevel: 20000, Efficiency: 0 })

      assert.deepEqual(reasons(item), ['exhausted'])
      assert.deepEqual(item.others.map((need) => need.key), ['radiation', 'staffing'])
      assert.deepEqual(reasons(ground({ Deposits: 1, RadiationLevel: 20000 })), [])
    }],
    ['ground: radiation and an unstaffed workforce at the colony are current blockers a destination cures, not ones that travel with the mines', () => {
      const item = ground({ ...exhausted, RadiationLevel: 20000, Efficiency: 0 })

      assert.deepEqual(item.current.map((need) => need.key), ['radiation', 'staffing'])
      assert.deepEqual(item.carried, [])
      assert.deepEqual(ground({ ...exhausted, MineProduction: 0 }).carried.map((need) => need.key), ['mineProduction'])
    }],
    ['ground: a radiation level that is not stored beside an exhausted body keeps the verdict and is named among the production inputs', () => {
      const item = ground({ ...exhausted, RadiationLevel: null })

      assert.equal(item.verdict, 1)
      assert.ok(item.unknown.production.includes('the radiation of the body'), item.unknown.production.join(' | '))
      assert.ok(!stored(item).includes('radiation'), stored(item))
    }],
    ['counts: the mines are counted by installation, manned and automated apart', () => {
      const item = ground({ ...exhausted, MannedMines: 3, AutomatedMines: 2 })

      assert.deepEqual(item.assets, { kind: 'ground', manned: 3, automated: 2, total: 5 })
      assert.equal(m.redeploy.assetText(item.assets, count).text, '5 mines (3 manned, 2 automated)')
      assert.equal(m.redeploy.assetText(ground({ ...exhausted, MannedMines: 1, AutomatedMines: 0 }).assets, count).text, '1 mine (1 manned, 0 automated)')
    }],
    ['counts: a mine count that cannot be read is unknown, never 0', () => {
      const item = ground({ ...exhausted, MineGaps: 1 })

      assert.equal(item.verdict, 1)
      assert.deepEqual(item.assets, { kind: 'ground', manned: null, automated: null, total: null })

      const text = m.redeploy.assetText(item.assets, count)

      assert.equal(text.text, 'mines not counted')
      assert.equal(text.lacking.length, 1)
    }],
    ['counts: a ship with one module is assessed and counted in the singular', () => {
      const item = orbital({ ...exhausted, Modules: 1, WorkingModules: 1, ClassLines: 1 })

      assert.equal(item.verdict, 1)
      assert.deepEqual(item.assets, { kind: 'orbital', ships: 1, modules: 1, working: 1, speed: 1 })
      assert.equal(m.redeploy.assetText(item.assets, count).text, '1 ship, 1 module (1 working), at 1 km/s')
    }],
    ['orbital: a one-module ship with its module damaged on a body that serves it is not queued, moving would not fix it', () => {
      const item = orbital({ Modules: 1, WorkingModules: 0, ClassLines: 1 })

      assert.equal(item.verdict, 0)
      assert.deepEqual(item.others.map((need) => need.key), ['modules'])
    }],
    ['counts: ships and modules add up over the fleet, working modules apart', () => {
      const item = together({ Modules: 5, WorkingModules: 3, ...exhausted }, { Modules: 5, WorkingModules: 5, ...exhausted }, { Modules: 2, WorkingModules: 0, ...exhausted })

      assert.deepEqual(item.assets, { kind: 'orbital', ships: 3, modules: 12, working: 8, speed: 1 })
      assert.equal(m.redeploy.assetText(item.assets, count).text, '3 ships, 12 modules (8 working), at 1 km/s')
    }],
    ['counts: modules that are not stored are unknown and named, not 0', () => {
      const item = orbital({ ...exhausted, Modules: null, WorkingModules: null })
      const text = m.redeploy.assetText(item.assets, count)

      assert.equal(item.assets.modules, null)
      assert.equal(item.assets.working, null)
      assert.equal(text.text, '1 ship, modules not stored, at 1 km/s')
      assert.ok(text.lacking.length >= 2)
    }],
    ['orbital: a body wider than the race\'s limit is queued as oversized, one at the limit is not', () => {
      const item = orbital({ Diameter: 5000 })

      assert.equal(item.verdict, 1)
      assert.deepEqual(reasons(item), ['oversized'])
      assert.equal(item.reasons[0].need.text, '5000 km across, more than the 4000 km orbital mining can handle')
      assert.equal(orbital({ Diameter: 4000 }).verdict, 0)
    }],
    ['orbital: oversized and exhausted reasons coexist on one site', () => {
      const item = orbital({ ...exhausted, Diameter: 5000 })

      assert.equal(item.verdict, 1)
      assert.deepEqual(reasons(item), ['exhausted', 'oversized'])
      assert.deepEqual(reasons(orbital({ ...gone, Diameter: 5000 })), ['empty', 'oversized'])
    }],
    ['orbital: zero-amount deposit rows are exhausted and no row at all is empty', () => {
      assert.deepEqual(reasons(orbital({ ...exhausted })), ['exhausted'])
      assert.deepEqual(reasons(orbital({ ...gone })), ['empty'])
      assert.equal(orbital({ Deposits: 1, Depleted: 2 }).verdict, 0)
    }],
    ['orbital: a body with no colony of the race is queued as unsupported, the three reasons add up', () => {
      assert.deepEqual(reasons(orbital({ ColonyID: null, ColonyName: null })), ['unsupported'])
      assert.deepEqual(reasons(orbital({ ColonyID: null, ColonyName: null, ...exhausted, Diameter: 5000 })), ['exhausted', 'oversized', 'unsupported'])
    }],
    ['orbital: another failing prerequisite is named beside a reason, and alone it queues nothing', () => {
      const item = orbital({ ...exhausted, WorkingModules: 0, AssignedPopulationID: 2, AssignedID: 2, AssignedName: 'Beta' })

      assert.equal(item.verdict, 1)
      assert.deepEqual(reasons(item), ['exhausted'])
      assert.deepEqual(item.others.map((need) => need.key), ['assignment', 'modules'])
      assert.equal(orbital({ CurrentCrew: 0 }).verdict, 0)
      assert.equal(orbital({ MineProduction: 0 }).verdict, 0)
    }],
    ['orbital: the assignment is a current blocker a destination cures, a damaged module and a race without mine production travel with the ships', () => {
      const item = orbital({ ...exhausted, WorkingModules: 0, AssignedPopulationID: 2, AssignedID: 2, AssignedName: 'Beta' })

      assert.deepEqual(item.current.map((need) => need.key), ['assignment'])
      assert.deepEqual(item.carried.map((need) => need.key), ['modules'])
    }],
    ['unknown: an exhausted one-module miner with its crew not stored keeps the verdict and names the crew among the production inputs', () => {
      const item = orbital({ ...exhausted, Modules: 1, WorkingModules: 1, ClassLines: 1, CurrentCrew: null })

      assert.equal(item.verdict, 1)
      assert.deepEqual(reasons(item), ['exhausted'])
      assert.ok(item.unknown.production.includes('the crew aboard of a ship'), item.unknown.production.join(' | '))
      assert.ok(!stored(item).includes('crew'), stored(item))
      assert.ok(m.redeploy.unknownInputs(item).includes('the crew aboard of a ship'))
      assert.ok(orbital({ ...exhausted, ClassCrew: null }).unknown.production.includes('the crew of a ship class'))
      assert.ok(!orbital({ ...exhausted }).unknown.production.includes('the crew aboard of a ship'))
    }],
    ['unknown: a missing diameter limit is unknown, never fits and never oversized', () => {
      const item = orbital({ MaximumDiameter: null })

      assert.equal(item.verdict, null)
      assert.deepEqual(reasons(item), [])
      assert.ok(stored(item).includes('orbital mining diameter limit'), stored(item))
      assert.equal(item.constraints.find((need) => need.key === 'diameter').state, 'unknown')
    }],
    ['unknown: a missing limit beside an exhausted body queues for the deposit only and still asks for the limit', () => {
      const item = orbital({ ...exhausted, MaximumDiameter: null })

      assert.equal(item.verdict, 1)
      assert.deepEqual(reasons(item), ['exhausted'])
      assert.ok(stored(item).includes('orbital mining diameter limit'), stored(item))
      assert.equal(item.undecided.length, 1)
    }],
    ['unknown: a diameter that is not stored is unknown too', () => {
      const item = orbital({ Diameter: null })

      assert.equal(item.verdict, null)
      assert.ok(stored(item).includes('diameter of the body'), stored(item))
    }],
    ['unknown: a body the race has not surveyed is unknown, not empty, for mines and miners', () => {
      assert.equal(ground({ Surveyed: 0, Deposits: 0 }).verdict, null)
      assert.ok(stored(ground({ Surveyed: 0, Deposits: 0 })).includes('survey'))
      assert.equal(orbital({ Surveyed: 0, Deposits: 0 }).verdict, null)
      assert.equal(orbital({ Surveyed: 0, Deposits: 0, Diameter: 5000 }).verdict, 1)
    }],
    ['unknown: a deposit amount that is not stored is unknown', () => {
      assert.equal(ground({ DepositGaps: 1, Deposits: 0 }).verdict, null)
      assert.equal(orbital({ DepositGaps: 1, Deposits: 0 }).verdict, null)
    }],
    ['unknown: a mine count that cannot be read leaves a colony with no mine row undecided and names the installation', () => {
      const item = ground({ ...exhausted, MannedMines: null, AutomatedMines: null, MineGaps: 1 })

      assert.equal(item.verdict, null)
      assert.ok(stored(item).includes('installation'), stored(item))
    }],
    ['unknown: every recommendation names the travel and production inputs it lacks', () => {
      const item = orbital({ ...exhausted })
      const mine = ground({ ...exhausted })

      assert.ok(item.unknown.travel.some((name) => name.includes('route')), item.unknown.travel.join())
      assert.ok(item.unknown.production.some((name) => name.includes('dig')), item.unknown.production.join())
      assert.ok(mine.unknown.travel.some((name) => name.includes('route')) && mine.unknown.travel.some((name) => name.includes('freight')))
      assert.ok(mine.unknown.production.some((name) => name.includes('dig')))
      assert.equal(m.redeploy.unknownInputs(item).length, item.unknown.stored.length + item.unknown.travel.length + item.unknown.production.length)
    }],
    ['unknown: a mixed fleet keeps the production inputs of the ship whose crew or modules are not stored, and a fully known fleet has none', () => {
      const known = { ...exhausted, Modules: 1, WorkingModules: 1, ClassLines: 1 }

      assert.ok(together({ ...known, CurrentCrew: null }, known).unknown.production.includes('the crew aboard of a ship'))
      assert.ok(together({ ...known, ClassCrew: null }, known).unknown.production.includes('the crew of a ship class'))
      assert.ok(together(known, { ...known, CurrentCrew: null }).unknown.production.includes('the crew aboard of a ship'))
      assert.ok(together({ ...known, Modules: null, WorkingModules: null }, known).unknown.production.includes('the mining modules of a ship class'))
      assert.ok(!together({ ...known, WorkingModules: 0, CurrentCrew: null }, known).unknown.production.includes('the crew aboard of a ship'), 'the crew of a ship with no working module does not matter')
      assert.equal(together({ ...known, CurrentCrew: null }, known).verdict, 1)
      assert.deepEqual(together(known, known).unknown.production, ['what the assets would dig at a destination (the accessibility of its deposits)'])
    }],
    ['unknown: a fleet speed or a race mine production that is not stored is added to the inputs', () => {
      const item = orbital({ ...exhausted, Speed: null, MineProduction: null })

      assert.ok(item.unknown.travel.some((name) => name.includes('speed')), item.unknown.travel.join())
      assert.ok(item.unknown.production.some((name) => name.includes('mine production')), item.unknown.production.join())
      assert.ok(!orbital({ ...exhausted }).unknown.travel.some((name) => name.includes('speed')))
      assert.ok(ground({ ...exhausted, MineProduction: null }).unknown.production.some((name) => name.includes('mine production')))
      assert.equal(m.redeploy.assetText(item.assets, count).text, '1 ship, 5 modules (5 working)')
    }],
    ['constraints: a destination for orbital miners is within the known limit, surveyed, with a colony and the fleet assigned to it', () => {
      const item = orbital({ ...exhausted })

      assert.deepEqual(item.constraints.map((need) => [need.key, need.state]), [['diameter', 'known'], ['deposit', 'known'], ['colony', 'known'], ['assignment', 'known']])
      assert.equal(item.constraints[0].text, 'a body no more than 4000 km across')
    }],
    ['constraints: a limit that is not stored leaves its constraint unknown and names the limit', () => {
      const need = orbital({ ...exhausted, MaximumDiameter: null }).constraints[0]

      assert.equal(need.state, 'unknown')
      assert.deepEqual(need.inputs, ['the race\'s orbital mining diameter limit'])
    }],
    ['constraints: a destination for mines needs a colony, a deposit, a workforce for manned mines, radiation under the cut-off and an export', () => {
      const item = ground({ ...exhausted })

      assert.deepEqual(item.constraints.map((need) => [need.key, need.state]), [['colony', 'known'], ['deposit', 'known'], ['workforce', 'known'], ['radiation', 'known'], ['export', 'known']])
      assert.equal(item.constraints[3].text, 'radiation under 10000')
      assert.deepEqual(ground({ ...exhausted, MannedMines: 0, AutomatedMines: 4 }).constraints.map((need) => need.key), ['colony', 'deposit', 'radiation', 'export'])
    }],
    ['version: on a save that is not 2.7-shaped the colony reason and the game rules of a destination are unknown', () => {
      const item = orbital({ ColonyID: null, ColonyName: null }, null)

      assert.equal(item.verdict, null)
      assert.deepEqual(reasons(item), [])
      assert.ok(stored(item).includes('game version'), stored(item))
      assert.deepEqual(item.constraints.filter((need) => need.state === 'unknown').map((need) => need.key), ['colony', 'assignment'])
      assert.deepEqual(only(assess(m, [colony({ ...exhausted })], [], '2.6.4').ground).constraints.filter((need) => need.state === 'unknown').map((need) => need.key), ['workforce', 'radiation', 'export'])
    }],
    ['version: the stored facts still decide on a save that is not 2.7-shaped', () => {
      assert.deepEqual(reasons(orbital({ ...exhausted, Diameter: 5000, ColonyID: null, ColonyName: null }, null)), ['exhausted', 'oversized'])
      assert.deepEqual(reasons(only(assess(m, [colony({ ...exhausted })], [], null).ground)), ['exhausted'])
    }],
  ]
}

// ---------- in-memory SQLite: the mine counts and the fleet speeds ----------

const memory = () => {
  const raw = new sqlite3.Database(':memory:')

  return {
    run: (sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve()))),
    all: (sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)))),
    close: () => raw.close(),
  }
}

const sqlStatements = (m) => [
  ['sql: the mine counts take the amounts of manned and automated mines of the race, civilian complexes and other installations left out', async () => {
    const db = memory()

    try {
      await db.run('create table FCT_Population (PopulationID integer, GameID integer, RaceID integer)')
      await db.run('create table FCT_PopulationInstallations (PopID integer, GameID integer, PlanetaryInstallationID integer, Amount integer)')
      await db.run('create table DIM_PlanetaryInstallation (PlanetaryInstallationID integer, MiningProductionValue real, CivilianInstallation integer, Workers real)')
      await db.run('insert into DIM_PlanetaryInstallation values (7, 1, 0, 0.05), (12, 1, 0, 0), (39, 1, 1, 0), (48, 5, 1, 1), (5, 0, 0, 0.5), (52, 10, 0, 1)')
      await db.run('insert into FCT_Population values (1, 1, 1), (2, 1, 1), (3, 1, 2), (4, 2, 1), (5, 1, 1), (6, 1, 1), (7, 1, 1)')
      await db.run('insert into FCT_PopulationInstallations values (1, 1, 7, 3), (1, 1, 12, 2), (1, 1, 39, 4), (1, 1, 48, 2), (1, 1, 5, 9), (2, 1, 39, 6), (2, 1, 48, 3), (3, 1, 7, 8), (4, 2, 7, 5), (5, 1, 7, null), (5, 1, 12, 1), (6, 1, 52, 2), (6, 1, 12, 0), (7, 1, 7, null)')

      const rows = await db.all(m.common.mineCountsQuery({ GameID: 1, RaceID: 1 }))
      const by = Object.fromEntries(rows.map((row) => [row.PopulationID, [row.MannedMines, row.AutomatedMines]]))

      assert.deepEqual(by[1], [3, 2])
      assert.deepEqual(by[2], [0, 0])
      assert.equal(by[3], undefined, 'another race\'s colony has no entry')
      assert.equal(by[4], undefined, 'another game\'s colony has no entry')
      assert.deepEqual(by[5], [0, 1], 'a row with no amount adds nothing here; the colony row\'s MineGaps makes the count unknown')
      assert.deepEqual(by[6], [2, 0])
      assert.deepEqual(by[7], [null, 0])
      assert.equal(rows.length, 5)
    } finally {
      db.close()
    }
  }],
  ['sql: the fleet speeds are those of the race\'s fleets in orbit, a speed not stored staying null', async () => {
    const db = memory()

    try {
      await db.run('create table FCT_Fleet (FleetID integer, GameID integer, RaceID integer, OrbitBodyID integer, Speed integer)')
      await db.run('insert into FCT_Fleet values (1, 1, 1, 7, 1), (2, 1, 1, 0, 500), (3, 1, 2, 7, 9), (4, 2, 1, 7, 9), (5, 1, 1, 8, null)')

      const rows = await db.all(m.common.fleetSpeedQuery({ GameID: 1, RaceID: 1 }))

      assert.deepEqual(rows.map((row) => [row.FleetID, row.Speed]).sort((a, b) => a[0] - b[0]), [[1, 1], [5, null]])
    } finally {
      db.close()
    }
  }],
]

// ---------- the warning on a fake database of fixture rows ----------

const fakeDatabase = ({ colonies, mines, fleets, speeds, formula = true, speedColumn = true }) => ({
  query: async (sql) => {
    if (sql.includes('pragma_table_xinfo(\'FCT_Game\')')) {
      return [formula ? [{ tbl: 'FCT_Game', name: 'AllowCMC' }, { tbl: 'FCT_Game', name: 'AncientRelics' }] : []]
    } else if (sql.includes('pragma_table_info(\'FCT_Fleet\')')) {
      return [[{ name: 'FleetID' }, { name: 'RaceID' }, ...(speedColumn ? [{ name: 'Speed' }] : [])]]
    } else if (sql.includes('as MannedMines')) {
      return [mines]
    } else if (sql.includes('FCT_Fleet.Speed from FCT_Fleet where')) {
      if (!speedColumn) {
        throw new Error('SQLITE_ERROR: no such column: FCT_Fleet.Speed')
      }

      return [speeds]
    } else if (sql.includes('FCT_ShipClass.MiningModules as Modules')) {
      return [fleets]
    } else if (sql.includes('VIR_Own.MineNames')) {
      return [colonies]
    }

    throw new Error(`The fake database has no rows for ${sql.slice(0, 80)}`)
  },
})

const fixtureWorld = () => {
  const mine = (PopulationID, MannedMines, AutomatedMines) => ({ PopulationID, MannedMines, AutomatedMines })
  const strip = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'MannedMines' && key !== 'AutomatedMines'))

  return {
    colonies: [
      colony({ PopulationID: 1, PopName: 'Alpha', ...exhausted }),
      colony({ PopulationID: 2, PopName: 'Beta', SystemBodyID: 501, SystemBodyName: 'Alpha II', Deposits: 3 }),
      colony({ PopulationID: 3, PopName: 'Gamma', SystemBodyID: 502, SystemBodyName: 'Alpha III', Surveyed: 0, Deposits: 0 }),
      colony({ PopulationID: 4, PopName: 'Delta', SystemBodyID: 503, SystemBodyName: 'Alpha IV', ...gone }),
    ].map(strip),
    mines: [mine(1, 3, 2), mine(2, 4, 0), mine(3, 1, 0), mine(4, 0, 2)],
    fleets: [
      fleet({ FleetID: 100, FleetName: 'Both', ...exhausted, Diameter: 5000, Modules: 1, WorkingModules: 1, ClassLines: 1, ColonyID: 1, ColonyName: 'Alpha' }),
      fleet({ FleetID: 101, FleetName: 'Limitless', MaximumDiameter: null, ColonyID: 2, ColonyName: 'Beta', SystemBodyID: 501, SystemBodyName: 'Alpha II' }),
      fleet({ FleetID: 102, FleetName: 'Content', ColonyID: 2, ColonyName: 'Beta', SystemBodyID: 501, SystemBodyName: 'Alpha II' }),
      fleet({ FleetID: 103, FleetName: 'Colonyless', ColonyID: null, ColonyName: null, SystemBodyID: 504, SystemBodyName: 'Alpha V' }),
    ],
    speeds: [{ FleetID: 100, Speed: 1 }, { FleetID: 101, Speed: 1 }, { FleetID: 102, Speed: 1 }, { FleetID: 103, Speed: 400 }],
  }
}

const contextOf = (m, database) => ({ database, GameID: 140, RaceID: RACE, RaceNPR: false, separator: ',', options: {}, count: m.common.counter(',') })

const ids = (rows) => rows.map((row) => row.id)

const sameIds = (actual, expected) => new Set(actual).size === actual.length && actual.length === expected.length && expected.every((id) => actual.includes(id))

const textOf = (cell) => (cell !== null && typeof cell === 'object' ? cell.text : cell)

const warningStatements = (m) => {
  const read = async (world = fixtureWorld()) => m.index.checkByKey[KEY].read(contextOf(m, fakeDatabase(world)))

  return [
    ['warning: the check lists the queued assets and sets the undecided ones apart', async () => {
      const rows = await read()

      assert.ok(sameIds(ids(rows.filter((row) => !row.unevaluated)), ['colony:1', 'colony:4', 'fleet:100', 'fleet:103']), ids(rows).join())
      assert.ok(sameIds(ids(rows.filter((row) => row.unevaluated)), ['colony:3', 'fleet:101']), ids(rows.filter((row) => row.unevaluated)).join())
    }],
    ['warning: mines come before orbital miners, the larger first and the uncounted last', async () => {
      const queued = ids((await read()).filter((row) => !row.unevaluated))

      assert.deepEqual(queued, ['colony:1', 'colony:4', 'fleet:103', 'fleet:100'])

      const world = fixtureWorld()
      const big = { ...world.fleets[3], FleetID: 110, FleetName: 'Big', Modules: 30, WorkingModules: 30 }
      const rows = await read({ ...world, fleets: [...world.fleets, big], speeds: [...world.speeds, { FleetID: 110, Speed: 1 }] })

      assert.deepEqual(ids(rows.filter((row) => !row.unevaluated)).filter((id) => id.startsWith('fleet')), ['fleet:110', 'fleet:103', 'fleet:100'])
    }],
    ['warning: a save without the fleet speed column keeps the other mining warnings, lists the ground recommendation and names the speed as unknown travel', async () => {
      const world = { ...fixtureWorld(), speedColumn: false }
      const context = contextOf(m, fakeDatabase(world))

      for (const key of ['wasted-mining-capacity', 'mass-driver-orphans', 'stranded-miners']) {
        await m.index.checkByKey[key].read(context)
      }

      const rows = await m.index.checkByKey[KEY].read(context)
      const ground = rows.find((row) => row.id === 'colony:1')
      const orbital = rows.find((row) => row.id === 'fleet:100')

      assert.ok(ground && !ground.unevaluated, 'the ground recommendation is gone')
      assert.equal(textOf(ground.cells.assets), '5 mines (3 manned, 2 automated)')
      assert.ok(orbital && !orbital.unevaluated, 'the orbital recommendation is gone')
      assert.ok(MISSING(orbital.cells.unknown.result).includes('the fleet\'s speed'), JSON.stringify(orbital.cells.unknown.result))
      assert.ok(textOf(orbital.cells.assets).includes('1 ship'), textOf(orbital.cells.assets))
    }],
    ['warning: a mixed fleet with a ship whose crew is not stored names the crew beside a crewed ship, for crew aboard and for class crew', async () => {
      for (const [crewed, input] of [[{ CurrentCrew: null }, 'the crew aboard of a ship'], [{ ClassCrew: null }, 'the crew of a ship class']]) {
        const world = fixtureWorld()
        const [first] = world.fleets
        const rows = await read({ ...world, fleets: [{ ...first, ...crewed }, { ...first, ShipID: 2 }, ...world.fleets.slice(1)] })
        const row = rows.find((item) => item.id === 'fleet:100')

        assert.ok(row && !row.unevaluated, 'the fleet is no longer a warning')
        assert.ok(textOf(row.cells.reason).startsWith('Every deposit on the body is exhausted'), textOf(row.cells.reason))
        assert.ok(textOf(row.cells.unknown).includes(input), textOf(row.cells.unknown))
        assert.ok(MISSING(row.cells.unknown.result).includes(input), JSON.stringify(row.cells.unknown.result))
      }
    }],
    ['warning: a row names why, how many, what a destination needs and what is not known', async () => {
      const rows = await read()
      const ground = rows.find((row) => row.id === 'colony:1')
      const orbital = rows.find((row) => row.id === 'fleet:100')

      assert.equal(textOf(ground.cells.reason), 'Every deposit on the body is exhausted')
      assert.equal(textOf(ground.cells.assets), '5 mines (3 manned, 2 automated)')
      assert.ok(textOf(ground.cells.destination).startsWith('Needs a colony of the race'), textOf(ground.cells.destination))
      assert.ok(textOf(ground.cells.unknown).includes('Travel: the destination body and the route to it; the freight capacity'), textOf(ground.cells.unknown))
      assert.ok(textOf(ground.cells.unknown).includes('Production: what the assets would dig'), textOf(ground.cells.unknown))
      assert.equal(textOf(orbital.cells.reason), 'Every deposit on the body is exhausted; 5,000 km across, more than the 4,000 km orbital mining can handle')
      assert.equal(textOf(orbital.cells.assets), '1 ship, 1 module (1 working), at 1 km/s')
      assert.ok(textOf(orbital.cells.destination).includes('no more than 4,000 km across'), textOf(orbital.cells.destination))
      assert.ok(MISSING(orbital.cells.unknown.result).length > 0)
      assert.equal(orbital.caption, 'Alpha I')
      assert.ok(textOf(orbital.cells.unknown).startsWith('Travel: the destination body and the route to it. Production: what the assets would dig'), textOf(orbital.cells.unknown))
    }],
    ['warning: another missing prerequisite is named beside the reasons as one that moving does not fix', async () => {
      const world = fixtureWorld()
      const rows = await read({ ...world, fleets: world.fleets.map((row) => (row.FleetID === 100 ? { ...row, WorkingModules: 0 } : row)) })

      assert.equal(textOf(rows.find((item) => item.id === 'fleet:100').cells.reason), 'Every deposit on the body is exhausted; 5,000 km across, more than the 4,000 km orbital mining can handle. Also missing, which moving does not fix: Every mining module of the fleet is damaged')
    }],
    ['warning: an exhausted miner whose crew is not stored is still a warning and the Not known cell and its result name the crew', async () => {
      const world = fixtureWorld()
      const rows = await read({ ...world, fleets: world.fleets.map((row) => (row.FleetID === 100 ? { ...row, CurrentCrew: null } : row)) })
      const row = rows.find((item) => item.id === 'fleet:100')

      assert.ok(!row.unevaluated)
      assert.ok(textOf(row.cells.reason).startsWith('Every deposit on the body is exhausted'), textOf(row.cells.reason))
      assert.ok(textOf(row.cells.unknown).includes('the crew aboard of a ship'), textOf(row.cells.unknown))
      assert.ok(MISSING(row.cells.unknown.result).includes('the crew aboard of a ship'), JSON.stringify(row.cells.unknown.result))
    }],
    ['warning: radiation and no workforce at the colony are other current blockers, not conditions moving does not fix', async () => {
      const world = fixtureWorld()
      const rows = await read({ ...world, colonies: world.colonies.map((row) => (row.PopulationID === 1 ? { ...row, RadiationLevel: 20000, Efficiency: 0 } : row)) })
      const text = textOf(rows.find((item) => item.id === 'colony:1').cells.reason)

      assert.ok(text.startsWith('Every deposit on the body is exhausted. Other current blockers, which a suitable destination cures: Radiation of '), text)
      assert.ok(text.includes('No workforce for the manned mines'), text)
      assert.ok(!text.includes('moving does not fix'), text)
    }],
    ['warning: a queued row with an input not stored carries it as unavailable, and has no signature', async () => {
      const world = fixtureWorld()
      const rows = await read({ ...world, fleets: world.fleets.map((row) => (row.FleetID === 103 ? { ...row, MaximumDiameter: null, Depleted: 1 } : row)) })
      const row = rows.find((item) => item.id === 'fleet:103')

      assert.ok(!row.unevaluated)
      assert.ok(MISSING(row.cells.reason.result).some((name) => name.includes('orbital mining diameter limit')), JSON.stringify(row.cells.reason))
      assert.equal(row.signature, null)
      assert.ok(textOf(row.cells.destination).includes('Not stated: a body within the race\'s orbital mining diameter limit'), textOf(row.cells.destination))
      assert.ok(!textOf(row.cells.destination).split('. Not stated:')[0].includes('within the race\'s orbital mining diameter limit'), textOf(row.cells.destination))
      assert.ok(MISSING(row.cells.destination.result).some((name) => name.includes('orbital mining diameter limit')))
    }],
    ['warning: an undecided row says what it lacks and is not a warning', async () => {
      const rows = await read()
      const row = rows.find((item) => item.id === 'fleet:101')

      assert.ok(MISSING(row.unevaluated).some((name) => name.includes('orbital mining diameter limit')), JSON.stringify(row.unevaluated))
      assert.ok(MISSING(rows.find((item) => item.id === 'colony:3').unevaluated).some((name) => name.includes('survey')))
    }],
    ['warning: every row links the colony\'s body or the fleet and keeps the ids of the other mining warnings', async () => {
      const rows = await read()

      rows.filter((row) => row.id.startsWith('colony:')).forEach((row) => {
        assert.equal(row.link.path, '/minerals')
        assert.equal(JSON.parse(row.link.query.bodies)[0].SystemBodyID, Number(row.id.slice(7)) === 1 ? 500 : Number(row.id.slice(7)) === 4 ? 503 : 502)
      })
      rows.filter((row) => row.id.startsWith('fleet:')).forEach((row) => {
        assert.equal(row.link.path, '/routes')
        assert.equal(row.link.query.from, `fleet:${row.id.slice(6)}`)
      })
    }],
    ['warning: the signature is the reasons of the asset, so a reason added or cleared changes it', async () => {
      const rows = await read()
      const [first, second] = [rows.find((row) => row.id === 'colony:1'), rows.find((row) => row.id === 'fleet:100')]

      assert.equal(first.signature, 'colony:deposit')
      assert.equal(second.signature, 'fleet:deposit,fleet:diameter')

      const world = fixtureWorld()
      const changed = await read({ ...world, fleets: world.fleets.map((row) => (row.FleetID === 100 ? { ...row, Diameter: 1000 } : row)) })

      assert.equal(changed.find((row) => row.id === 'fleet:100').signature, 'fleet:deposit')
      assert.equal(m.index.checkByKey[KEY].captured[0]('fleet:deposit,fleet:diameter'), 'no mineral deposit on the body, body wider than the orbital mining limit')
    }],
    ['warning: a save that is not 2.7-shaped lists no colony-less miner as a warning and says the game version is unknown', async () => {
      const rows = await read({ ...fixtureWorld(), formula: false })
      const row = rows.find((item) => item.id === 'fleet:103')

      assert.ok(MISSING(row.unevaluated).some((name) => name.includes('game version')), JSON.stringify(row && row.unevaluated))
    }],
    ['warning: the page lists it among the colonies checks as a needs-attention check with a rule behind it', () => {
      const entry = m.index.checkByKey[KEY]

      assert.equal(entry.group, 'colonies')
      assert.equal(entry.severity, 'attention')
      assert.equal(entry.provenance, 'warnings.miningRedeployment')
      assert.deepEqual(entry.columns.map((column) => column.key), ['asset', 'reason', 'assets', 'destination', 'unknown'])
      assert.equal(entry.title(1), '1 mining asset to redeploy')
      assert.equal(entry.title(2), '2 mining assets to redeploy')
      assert.ok(typeof entry.material === 'string' && entry.material.length > 10)
    }],
  ]
}

const registryStatements = (m) => [
  ['registry: the queue and the warning are registered with a verification, a structure and the 2.7 versions', () => {
    ;['miningRedeployment.queue', 'warnings.miningRedeployment'].forEach((id) => {
      const rule = m.provenance.getRule(id)

      assert.ok(rule && rule.structure.length > 0 && ['confirmed', 'estimated', 'assumed'].includes(rule.verification), id)
    })
    assert.equal(m.provenance.getRule('miningRedeployment.queue').verification, 'estimated')
    assert.equal(m.provenance.ruleSupports('miningRedeployment.queue', '2.7.1'), true)
    assert.equal(m.provenance.ruleSupports('miningRedeployment.queue', '2.6.4'), false)
    assert.equal(m.provenance.ruleSupports('miningRedeployment.queue', null), null)
  }],
]

// ---------- the saves, read-only ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({ query: (sql) => new Promise((resolve, reject) => raw.all(sql, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))), close: () => raw.close() })
  })
})

const QUERIES = {
  colonies: (sql) => sql.includes('VIR_Own.MineNames'),
  fleets: (sql) => sql.includes('FCT_ShipClass.MiningModules as Modules'),
  mines: (sql) => sql.includes('as MannedMines'),
  speeds: (sql) => sql.includes('FCT_Fleet.Speed from FCT_Fleet where'),
}

// The save as the app's loaders read it, with `edits` ({ colonies, fleets, mines, speeds }: rows to rows) changed in memory; `hits` counts the queries each edit met, so a query that moved cannot silently leave a fault unplanted.
const planted = (database, edits = {}) => {
  const hits = { colonies: 0, fleets: 0, mines: 0, speeds: 0 }

  return {
    hits,
    query: async (sql) => {
      const [rows] = await database.query(sql)
      const kind = Object.keys(QUERIES).find((name) => QUERIES[name](sql))

      if (!kind) {
        return [rows]
      }

      hits[kind]++

      return [edits[kind] ? edits[kind](rows.map((row) => ({ ...row }))) : rows]
    },
  }
}

const saveStatements = (m, held) => {
  const opened = new Map()
  const loaded = async (save) => {
    if (!opened.has(save.file)) {
      opened.set(save.file, (async () => {
        const database = await openSave(save.file)

        if (!database) {
          return null
        }

        const stat = fs.statSync(path.resolve(root, save.file))
        const ctx = contextOf(m, database)
        const baseline = { ...ctx, GameID: save.game, RaceID: save.race }
        const sites = await m.common.readRedeploymentSites(baseline)

        return { database, ctx: baseline, sites, queue: await m.index.checkByKey[KEY].read(baseline), stat }
      })())
    }

    return opened.get(save.file)
  }

  held.push(async () => {
    for (const promise of opened.values()) {
      const world = await promise

      if (world) {
        world.database.close()
      }
    }
  })

  const per = (title, run) => SAVES.map((save) => [`real: ${save.label}: ${title}`, async () => {
    const world = await loaded(save)

    return world ? run(world, save) : skip(`${save.file} is not there`)
  }])

  const scalar = async (world, sql) => (await world.database.query(sql))[0]

  const mineOracle = async (world, save) => {
    const rows = await scalar(world, `select FCT_PopulationInstallations.PopID, DIM_PlanetaryInstallation.Workers > 0 as Manned, sum(FCT_PopulationInstallations.Amount) as Amount from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID where FCT_Population.RaceID = ${save.race} and FCT_Population.GameID = ${save.game} and FCT_PopulationInstallations.GameID = ${save.game} and DIM_PlanetaryInstallation.MiningProductionValue > 0 and DIM_PlanetaryInstallation.CivilianInstallation = 0 group by FCT_PopulationInstallations.PopID, Manned`)
    const by = new Map()

    rows.forEach((row) => by.set(row.PopID, { ...(by.get(row.PopID) || { manned: 0, automated: 0 }), [row.Manned ? 'manned' : 'automated']: row.Amount }))

    return by
  }

  const groundOracle = async (world, save) => {
    const mines = await mineOracle(world, save)
    const rows = await scalar(world, `select FCT_Population.PopulationID, (select count(*) from FCT_SystemBodySurveys where FCT_SystemBodySurveys.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_Population.RaceID and FCT_SystemBodySurveys.GameID = FCT_Population.GameID) as Surveyed, (select count(*) from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = FCT_Population.SystemBodyID and FCT_MineralDeposit.GameID = FCT_Population.GameID and FCT_MineralDeposit.Amount > 0) as Deposits from FCT_Population where FCT_Population.RaceID = ${save.race} and FCT_Population.GameID = ${save.game}`)
    const withMines = rows.filter((row) => mines.has(row.PopulationID) && (mines.get(row.PopulationID).manned > 0 || mines.get(row.PopulationID).automated > 0))

    return { mines, queued: withMines.filter((row) => row.Surveyed > 0 && row.Deposits === 0).map((row) => `colony:${row.PopulationID}`), undecided: withMines.filter((row) => row.Surveyed === 0).map((row) => `colony:${row.PopulationID}`), withMines }
  }

  const orbitalOracle = async (world, save) => {
    const supported = world.sites.supported.orbital
    const rows = await scalar(world, `select distinct FCT_Fleet.FleetID, (select count(*) from FCT_SystemBodySurveys where FCT_SystemBodySurveys.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBodySurveys.RaceID = FCT_Fleet.RaceID and FCT_SystemBodySurveys.GameID = FCT_Fleet.GameID) as Surveyed, (select count(*) from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_MineralDeposit.GameID = FCT_Fleet.GameID and FCT_MineralDeposit.Amount > 0) as Deposits, FCT_SystemBody.Radius * 2 > FCT_Race.MaximumOrbitalMiningDiameter as Wide, (select count(*) from FCT_Population where FCT_Population.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_Population.RaceID = FCT_Fleet.RaceID and FCT_Population.GameID = FCT_Fleet.GameID) as Colonies from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID inner join FCT_Race on FCT_Race.RaceID = FCT_Fleet.RaceID and FCT_Race.GameID = FCT_Fleet.GameID where FCT_Fleet.RaceID = ${save.race} and FCT_Fleet.GameID = ${save.game} and FCT_Fleet.OrbitBodyID > 0 and FCT_Ship.MothershipID = 0 and FCT_ShipClass.MiningModules > 0 and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID)`)
    const queued = rows.filter((row) => row.Wide === 1 || (supported && row.Colonies === 0) || (row.Surveyed > 0 && row.Deposits === 0))

    return { rows, queued: queued.map((row) => `fleet:${row.FleetID}`), undecided: rows.filter((row) => !queued.includes(row) && row.Surveyed === 0).map((row) => `fleet:${row.FleetID}`) }
  }

  const shown = (rows, unevaluated) => ids(rows.filter((row) => Boolean(row.unevaluated) === unevaluated))

  // The sites whose deposit, diameter limit, crew, modules and colony are those a fault is planted on, picked from the save as it stands.
  const targets = (world, kind, wanted) => {
    const list = kind === 'ground' ? world.sites.colonies.filter((site) => site.surface && (site.row.MannedMines > 0 || site.row.AutomatedMines > 0) && site.row.Deposits > 0 && !(site.row.MineGaps > 0)) : world.sites.fleets.filter((site) => site.producing === 1 && site.prerequisites.every((need) => need.state === 'met'))

    return list.length >= wanted ? list.slice(0, wanted) : null
  }

  return [
    ...per('the queue of mines is the colonies with mines on a surveyed body with no deposit above 0 t, by a query written another way', async (world, save) => {
      const oracle = await groundOracle(world, save)
      const queue = world.queue.filter((row) => row.id.startsWith('colony:'))

      assert.ok(sameIds(shown(queue, false), oracle.queued), `rows ${shown(queue, false).join()} expected ${oracle.queued.join()}`)
      assert.ok(sameIds(shown(queue, true), oracle.undecided), `not evaluated ${shown(queue, true).join()} expected ${oracle.undecided.join()}`)
    }),
    ...per('the queue of orbital miners is the fleets at a body that is wide, exhausted, empty or without a colony, by a query written another way', async (world, save) => {
      const oracle = await orbitalOracle(world, save)
      const queue = world.queue.filter((row) => row.id.startsWith('fleet:'))

      assert.equal(world.sites.fleets.length, oracle.rows.length, 'the fleet sites are the fleets with mining modules and no orders')
      assert.ok(sameIds(shown(queue, false), oracle.queued), `rows ${shown(queue, false).join()} expected ${oracle.queued.join()}`)
      assert.ok(sameIds(shown(queue, true), oracle.undecided), `not evaluated ${shown(queue, true).join()} expected ${oracle.undecided.join()}`)
    }),
    ...per('the mine counts of every colony with mines are the sums of the installation amounts, and every fleet has its stored speed', async (world, save) => {
      const mines = await mineOracle(world, save)
      const speeds = new Map((await scalar(world, `select FleetID, Speed from FCT_Fleet where GameID = ${save.game} and RaceID = ${save.race}`)).map((row) => [row.FleetID, row.Speed]))

      world.sites.colonies.filter((site) => site.surface).forEach((site) => {
        const own = mines.get(site.id) || { manned: 0, automated: 0 }

        assert.equal(site.row.MannedMines, own.manned || 0, `manned mines of colony ${site.id}`)
        assert.equal(site.row.AutomatedMines, own.automated || 0, `automated mines of colony ${site.id}`)
      })
      world.sites.fleets.forEach((site) => assert.equal(site.row.Speed, speeds.get(site.id), `speed of fleet ${site.id}`))
    }),
    ...per('mines with their deposit rows at 0 t, none, or unsurveyed, and mines counted as zero, are queued as exhausted, empty, not evaluated and not at all', async (world, save) => {
      const picked = targets(world, 'ground', 5)

      if (!picked) {
        return skip('the save has fewer than 5 colonies with mines on a body with a deposit')
      }

      const [exhaustedSite, emptySite, unsurveyedSite, leftSite, noMinesSite] = picked.map((site) => site.id)
      const edit = planted(world.database, {
        colonies: (rows) => rows.map((row) => (row.PopulationID === exhaustedSite ? { ...row, Deposits: 0, Depleted: 2 } : row.PopulationID === emptySite ? { ...row, Deposits: 0, Depleted: 0 } : row.PopulationID === unsurveyedSite ? { ...row, Surveyed: 0, Deposits: 0 } : row.PopulationID === noMinesSite ? { ...row, Deposits: 0, Depleted: 1 } : row)),
        mines: (rows) => rows.map((row) => (row.PopulationID === noMinesSite ? { ...row, MannedMines: 0, AutomatedMines: 0 } : row)),
      })
      const rows = await m.index.checkByKey[KEY].read({ ...world.ctx, database: edit })
      const oracle = await groundOracle(world, save)
      const counts = await mineOracle(world, save)
      const own = counts.get(exhaustedSite)
      const row = (id) => rows.find((item) => item.id === `colony:${id}`)

      assert.ok(edit.hits.colonies > 0 && edit.hits.mines > 0, 'the loaders were not met by the plant')
      assert.ok(sameIds(shown(rows.filter((item) => item.id.startsWith('colony:')), false), [...oracle.queued, `colony:${exhaustedSite}`, `colony:${emptySite}`]), shown(rows, false).join())
      assert.ok(sameIds(shown(rows.filter((item) => item.id.startsWith('colony:')), true), [...oracle.undecided, `colony:${unsurveyedSite}`]), shown(rows, true).join())
      assert.equal(textOf(row(exhaustedSite).cells.reason), 'Every deposit on the body is exhausted')
      assert.equal(textOf(row(emptySite).cells.reason), 'No mineral deposit on the body')
      assert.equal(textOf(row(exhaustedSite).cells.assets), `${world.ctx.count((own.manned || 0) + (own.automated || 0))} ${(own.manned || 0) + (own.automated || 0) === 1 ? 'mine' : 'mines'} (${world.ctx.count(own.manned || 0)} manned, ${world.ctx.count(own.automated || 0)} automated)`)
      assert.ok(MISSING(row(unsurveyedSite).unevaluated).some((name) => name.includes('survey')))
      assert.equal(row(leftSite), undefined, 'a colony with a deposit is not queued')
      assert.equal(row(noMinesSite), undefined, 'a colony with no mine counted is not queued')
    }),
    ...per('orbital miners at a body with rows at 0 t, wider than the limit, with the limit missing, with one module and no colony, and with every module damaged', async (world, save) => {
      const picked = targets(world, 'orbital', 6)

      if (!picked) {
        return skip('the save has fewer than 6 working orbital miners')
      }

      const [exhaustedFleet, bothFleet, limitFleet, limitAndGoneFleet, oneModuleFleet, damagedFleet] = picked.map((site) => site.id)
      const edited = (id, rows, change) => rows.map((row) => (row.FleetID === id ? { ...row, ...change(row) } : row))
      const edit = planted(world.database, {
        fleets: (rows) => {
          const kept = rows.filter((row) => row.FleetID !== oneModuleFleet || row.ShipID === rows.find((item) => item.FleetID === oneModuleFleet).ShipID)
          const stage = [
            [exhaustedFleet, () => ({ Deposits: 0, Depleted: 1 })],
            [bothFleet, (row) => ({ Deposits: 0, Depleted: 1, Diameter: row.MaximumDiameter + 1 })],
            [limitFleet, () => ({ MaximumDiameter: null })],
            [limitAndGoneFleet, () => ({ MaximumDiameter: null, Deposits: 0, Depleted: 0 })],
            [oneModuleFleet, () => ({ Modules: 1, WorkingModules: 1, ClassLines: 1, ClassCrew: 10, CurrentCrew: 10, ColonyID: null, ColonyName: null })],
            [damagedFleet, () => ({ WorkingModules: 0 })],
          ]

          return stage.reduce((current, [id, change]) => edited(id, current, change), kept)
        },
      })
      const rows = await m.index.checkByKey[KEY].read({ ...world.ctx, database: edit })
      const oracle = await orbitalOracle(world, save)
      const row = (id) => rows.find((item) => item.id === `fleet:${id}`)
      const fleets = rows.filter((item) => item.id.startsWith('fleet:'))
      const speed = new Map(world.sites.fleets.map((site) => [site.id, site.row.Speed]))

      assert.ok(edit.hits.fleets > 0, 'the loader was not met by the plant')
      assert.ok(sameIds(shown(fleets, false), [...oracle.queued, ...[exhaustedFleet, bothFleet, limitAndGoneFleet, oneModuleFleet].map((id) => `fleet:${id}`)]), shown(fleets, false).join())
      assert.ok(sameIds(shown(fleets, true), [...oracle.undecided, `fleet:${limitFleet}`]), shown(fleets, true).join())
      assert.ok(textOf(row(exhaustedFleet).cells.reason).includes('exhausted'))
      assert.ok(textOf(row(bothFleet).cells.reason).includes('exhausted') && textOf(row(bothFleet).cells.reason).includes('km across, more than the'), textOf(row(bothFleet).cells.reason))
      assert.ok(textOf(row(limitAndGoneFleet).cells.reason).includes('No mineral deposit') && !textOf(row(limitAndGoneFleet).cells.reason).includes('km across'), textOf(row(limitAndGoneFleet).cells.reason))
      assert.ok(MISSING(row(limitAndGoneFleet).cells.reason.result).some((name) => name.includes('orbital mining diameter limit')))
      assert.ok(MISSING(row(limitFleet).unevaluated).some((name) => name.includes('orbital mining diameter limit')))
      assert.equal(textOf(row(oneModuleFleet).cells.reason), 'No colony of the race on this body to take the output')
      assert.equal(textOf(row(oneModuleFleet).cells.assets), `1 ship, 1 module (1 working), at ${world.ctx.count(speed.get(oneModuleFleet))} km/s`)
      assert.equal(row(damagedFleet), undefined, 'a fleet with only its modules damaged is not queued')
    }),
    ...per('the queue never writes to the save and every row links the colony body or the fleet', async (world, save) => {
      const after = fs.statSync(path.resolve(root, save.file))

      world.queue.forEach((row) => assert.ok(row.link && (row.link.path === '/minerals' || row.link.path === '/routes'), row.id))
      assert.ok(after.mtimeMs === world.stat.mtimeMs && after.size === world.stat.size, 'the save file changed while the queue was read')
    }),
  ]
}

// ---------- planted faults ----------

const U = 'mining-redeployment'
const S = 'mining-sites'
const C = 'warnings/common'
const W = 'warnings/colonies'

const MUTATIONS = [
  { name: 'an exhausted deposit keyed as empty', file: U, find: '(depositState(row) === \'exhausted\' ? \'exhausted\' : \'empty\')', replace: '\'empty\'', fails: ['ground', 'orbital'] },
  { name: 'an unknown deposit read as no reason', file: U, find: 'deposit.state === \'missing\' ? 1 : deposit.state === \'met\' ? 0 : null', replace: 'deposit.state === \'missing\' ? 1 : 0', fails: ['unknown', 'warning'], real: ['real'] },
  { name: 'a colony with no mines queued', file: U, find: 'const verdict = all(present, gone)', replace: 'const verdict = gone', fails: ['ground'] },
  { name: 'an unknown mine count read as mines', file: U, find: 'const present = any(positive(row.MannedMines, row.MineGaps), positive(row.AutomatedMines, row.MineGaps))', replace: 'const present = 1', fails: ['ground', 'unknown'] },
  { name: 'a missing diameter limit read as fitting', file: U, find: 'verdict: reasons.length ? 1 : undecided.length ? null : 0,', replace: 'verdict: reasons.length ? 1 : 0,', fails: ['unknown', 'warning'], real: ['real'] },
  { name: 'only the first reason kept', file: U, find: 'const reasons = found.filter((need) => need.state === \'missing\').map((need) => ({ key: reasonKey(need, row), need }))', replace: 'const reasons = found.filter((need) => need.state === \'missing\').slice(0, 1).map((need) => ({ key: reasonKey(need, row), need }))', fails: ['orbital', 'warning'] },
  { name: 'the colony left out of the reasons', file: U, find: 'const REDEPLOY = [\'deposit\', \'diameter\', \'colony\']', replace: 'const REDEPLOY = [\'deposit\', \'diameter\']', fails: ['orbital', 'version'] },
  { name: 'a wide body called unsupported', file: U, find: 'need.key === \'diameter\' ? \'oversized\' : \'unsupported\'', replace: 'need.key === \'diameter\' ? \'unsupported\' : \'oversized\'', fails: ['orbital'] },
  { name: 'every other missing prerequisite read as a reason', file: U, find: '...otherParts(site),\n    assets: { kind: \'orbital\'', replace: 'others: [], carried: [], current: [],\n    assets: { kind: \'orbital\'', fails: ['orbital'] },
  { name: 'the unknown other prerequisites of a fleet left out of the production inputs', file: U, find: 'production: unique([OUTPUT_INPUT, ...otherInputs(site), ...site.shipInputs]), stored: unique(undecided', replace: 'production: [OUTPUT_INPUT, ...site.shipInputs], stored: unique(undecided', fails: ['unknown'] },
  { name: 'the per-ship unknown inputs of a mixed fleet left out of the production inputs', file: U, find: '...otherInputs(site), ...site.shipInputs]), stored: unique(undecided', replace: '...otherInputs(site)]), stored: unique(undecided', fails: ['unknown', 'warning'] },
  { name: 'the per-ship unknown inputs read only from the fleet-wide crew prerequisite', file: S, find: '...(working[index] !== 0 && crewAboard[index] === null ? CREW_INPUTS : [])', replace: '...(false ? CREW_INPUTS : [])', fails: ['unknown', 'warning'] },
  { name: 'the crew of a ship with no working module counted as an input', file: S, find: '...(working[index] !== 0 && crewAboard[index] === null ? CREW_INPUTS : [])', replace: '...(crewAboard[index] === null ? CREW_INPUTS : [])', fails: ['unknown'] },
  { name: 'every other missing prerequisite called one that travels with the asset', file: U, find: 'carried: others.filter((need) => CARRIED.includes(need.key)), current: others.filter((need) => !CARRIED.includes(need.key))', replace: 'carried: others, current: []', fails: ['ground', 'orbital', 'warning'] },
  { name: 'the ground colonies not limited to those with mines', file: U, find: 'colonies.filter((site) => site.surface).map', replace: 'colonies.map', fails: ['ground'] },
  { name: 'the route left out of the travel inputs', file: U, find: 'travel: [DESTINATION_INPUT, ...(known(row.Speed) ? [] : [SPEED_INPUT])]', replace: 'travel: [...(known(row.Speed) ? [] : [SPEED_INPUT])]', fails: ['unknown', 'warning'] },
  { name: 'the unknown other prerequisites of a colony left out of the production inputs', file: U, find: 'production: unique([OUTPUT_INPUT, ...otherInputs(site)]), stored },', replace: 'production: [OUTPUT_INPUT], stored },', fails: ['ground'] },
  { name: 'an unreadable mine count shown as counted', file: U, find: 'const readable = known(row.MannedMines) && known(row.AutomatedMines) && !(row.MineGaps > 0)', replace: 'const readable = known(row.MannedMines) && known(row.AutomatedMines)', fails: ['counts'] },
  { name: 'one module given the plural', file: U, find: '${assets.modules === 1 ? \'module\' : \'modules\'}', replace: '${assets.modules === 1 ? \'modules\' : \'modules\'}', fails: ['counts', 'warning'] },
  { name: 'the designed modules shown as working', file: U, find: 'modules: site.modules, working: site.workingModules,', replace: 'modules: site.modules, working: site.modules,', fails: ['counts'] },
  { name: 'the diameter limit taken as stored', file: U, find: 'requirement(\'diameter\', known(row.MaximumDiameter) ? `a body no more than ${count(row.MaximumDiameter)} km across` : \'a body within the race\\\'s orbital mining diameter limit\', known(row.MaximumDiameter), [LIMIT_INPUT])', replace: 'requirement(\'diameter\', `a body no more than ${count(row.MaximumDiameter)} km across`, true, [LIMIT_INPUT])', fails: ['constraints', 'warning'] },
  { name: 'the colony rule applied on any version', file: U, find: 'requirement(\'colony\', \'a colony of the race on the body to take the output\', supported.orbital, [VERSION_INPUT])', replace: 'requirement(\'colony\', \'a colony of the race on the body to take the output\', true, [VERSION_INPUT])', fails: ['version'] },
  { name: 'the ships counted as one', file: S, find: 'ships: ships.length,', replace: 'ships: 1,', fails: ['counts'] },
  { name: 'the working modules read as the designed ones', file: S, find: 'workingModules: operable,', replace: 'workingModules: designed,', fails: ['counts'] },
  { name: 'rows at 0 t read as empty', file: S, find: 'return row.Depleted > 0 ? \'exhausted\' : \'empty\'', replace: 'return \'empty\'', fails: ['ground', 'orbital'] },
  { name: 'the supported rules left out of the sites', file: S, find: 'colonies: colonySites(colonies, fleetList, { RaceID, supported, count }), supported }', replace: 'colonies: colonySites(colonies, fleetList, { RaceID, supported, count }), supported: { surface: true, orbital: true, delivery: true } }', fails: ['version'] },
  { name: 'automated mines counted as manned', file: C, find: 'DIM_PlanetaryInstallation.CivilianInstallation = 0 and DIM_PlanetaryInstallation.Workers = 0 then FCT_PopulationInstallations.Amount else 0 end) as AutomatedMines', replace: 'DIM_PlanetaryInstallation.CivilianInstallation = 0 and DIM_PlanetaryInstallation.Workers >= 0 then FCT_PopulationInstallations.Amount else 0 end) as AutomatedMines', fails: ['sql'], real: ['real'] },
  { name: 'civilian complexes counted as mines', file: C, find: 'DIM_PlanetaryInstallation.CivilianInstallation = 0 and DIM_PlanetaryInstallation.Workers > 0 then FCT_PopulationInstallations.Amount else 0 end) as MannedMines', replace: 'DIM_PlanetaryInstallation.CivilianInstallation >= 0 and DIM_PlanetaryInstallation.Workers > 0 then FCT_PopulationInstallations.Amount else 0 end) as MannedMines', fails: ['sql'] },
  { name: 'the mine counts of every race', file: C, find: ' and FCT_Population.RaceID = ${RaceID}) group by FCT_PopulationInstallations.PopID', replace: ') group by FCT_PopulationInstallations.PopID', fails: ['sql'] },
  { name: 'the fleet speeds of fleets out of orbit too', file: C, find: 'FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.OrbitBodyID > 0`', replace: 'FCT_Fleet.RaceID = ${RaceID}`', fails: ['sql'] },
  { name: 'the fleet speed never merged', file: C, find: 'Speed: speedOf.has(site.id) ? speedOf.get(site.id) : null', replace: 'Speed: null', fails: ['warning'], real: ['real'] },
  { name: 'the fleet speed read without asking the save for the column', file: C, find: 'columns.some((column) => column.name === \'Speed\') ? rowsOf(ctx, fleetSpeedQuery(ctx)) : []', replace: 'rowsOf(ctx, fleetSpeedQuery(ctx))', fails: ['warning'] },
  { name: 'the fleet speed read by the shared mining loader', file: C, find: 'loadFormulaVersion(ctx.database)])\n  const minesOf', replace: 'loadFormulaVersion(ctx.database), rowsOf(ctx, fleetSpeedQuery(ctx))])\n  const minesOf', fails: ['warning'] },
  { name: 'a colony with no mine row read as not counted', file: C, find: 'MannedMines: minesOf.has(row.PopulationID) ? minesOf.get(row.PopulationID).MannedMines : 0', replace: 'MannedMines: minesOf.has(row.PopulationID) ? 0 : 0', fails: ['warning'], real: ['real'] },
  { name: 'every queued row a warning', file: W, find: 'verdict: (item) => item.verdict,', replace: 'verdict: (item) => (item.verdict === null ? 1 : item.verdict),', fails: ['warning'] },
  { name: 'a fleet linked to the minerals', file: W, find: ': linkTo.routes({ from: place.fleet(item.id) }),\n            signature:', replace: ': linkTo.minerals({ bodies: [item.row] }),\n            signature:', fails: ['warning'] },
  { name: 'the unknown inputs left out of the row', file: W, find: 'unknown: { text: `Travel: ${item.unknown.travel.join(\'; \')}. Production:', replace: 'unknown: { text: `Production:', fails: ['warning'] },
  { name: 'a signature on a row with an input not stored', file: W, find: 'signature: item.unknown.stored.length ? null : signatureOf(', replace: 'signature: signatureOf(', fails: ['warning'] },
  { name: 'the largest mining assets listed last', file: W, find: '(size(alpha) === null) - (size(beta) === null) || size(beta) - size(alpha)', replace: '(size(alpha) === null) - (size(beta) === null) || size(alpha) - size(beta)', fails: ['warning'] },
  { name: 'the stated destination needs shown as unknown ones', file: W, find: 'const stated = item.constraints.filter((need) => need.state === \'known\')', replace: 'const stated = item.constraints', fails: ['warning'] },
  { name: 'the other missing prerequisites left out of the row', file: W, find: 'const carried = item.carried.length ?', replace: 'const carried = false ?', fails: ['warning'] },
]

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts ----------

const sourcesOf = (mutant) => {
  const sources = {}

  if (mutant) {
    sources[mutant.file] = patched(`${mutant.file}.js`, fs.readFileSync(path.join(utilities, `${mutant.file}.js`), 'utf8'), mutant.find, mutant.replace)
  }

  return sources
}

const modulesOf = async (sources) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources })

  return { redeploy: loaded['mining-redeployment'], sites: loaded['mining-sites'], provenance: loaded.provenance, capabilities: loaded.capabilities, common: loaded['warnings/common'], index: loaded['warnings/index'] }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const statementsOf = (m, held) => [...fixtures(m), ...sqlStatements(m), ...warningStatements(m), ...registryStatements(m), ...saveStatements(m, held)]

const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      const given = await test()

      result = given === undefined ? true : given
    } catch (error) {
      result = `${error.name === 'AssertionError' ? '' : 'threw '}${String(error.message).split('\n').slice(0, 3).join(' | ').slice(0, 400)}`
    }

    results.push([name, result])
  }

  return results
}

const savesPresent = () => SAVES.some((save) => fs.existsSync(path.resolve(root, save.file)))

const checkHead = async () => {
  const held = []
  const m = await modulesOf({})

  console.log('\nMining redeployment queue, on fixtures, in-memory SQLite and the saves')

  try {
    for (const [name, result] of await runStatements(statementsOf(m, held))) {
      check(name, result)
    }
  } finally {
    for (const close of held) {
      await close()
    }
  }
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

  const held = []
  let m

  try {
    m = await modulesOf(sources)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  try {
    const keys = savesPresent() ? [...mutant.fails, ...(mutant.real || [])] : mutant.fails
    const statements = statementsOf(m, held)
    const absent = keys.filter((key) => !statements.some(([name]) => keyOf(name) === key))
    const results = await runStatements(statements, keys)
    const missed = keys.filter((key) => {
      const ran = results.filter(([name, result]) => keyOf(name) === key && !(result && result.skipped))

      return ran.length > 0 && !ran.some(([, result]) => result !== true)
    })

    check(`mutation caught: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true && !(result && result.skipped)).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
  } finally {
    for (const close of held) {
      await close()
    }
  }
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: [] }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--save') {
      options.saves.push({ label: `save ${options.saves.length + 1}`, file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
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

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  if (options.saves.length) {
    process.env.MINING_REDEPLOYMENT_SAVES = JSON.stringify(options.saves)
  }

  const wanted = options.mutations ? MUTANTS : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head'], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id], weight: 3 }))])
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
