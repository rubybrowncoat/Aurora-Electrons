// Mining association, whole productive capacity, local civilian reserve allocation and replacement destinations, through the same public producers and SQL as the pages.
// bun scripts/check-mining-flow.js [--no-mutations] [--fault <index>]
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { strictRecords } = require('./lib/csv-records')
const { loadPage, instantiate } = require('./lib/page-loader')
const { plantedPatch } = require('./lib/mutant-source')
const { runChild } = require('./lib/check-pool')
const { mutating } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const exportsPath = path.join(root, '.github', 'exports')
const SCHEMA = Object.fromEntries(fs.readdirSync(exportsPath).filter((name) => name.endsWith('.csv')).map((name) => [name.slice(0, -4), strictRecords(fs.readFileSync(path.join(exportsPath, name), 'utf8').split(/\r?\n/, 1)[0])[0]]))
const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (items, test) => items.reduce((groups, item) => { groups[test(item) ? 0 : 1].push(item); return groups }, [[], []])',
}
const stock = Object.fromEntries(['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite'].flatMap((name) => [[name, 0], [`Reserve${name}`, 0]]))
const world = () => ({
  FCT_Race: [{ GameID: 1, RaceID: 7, NPR: 0, MineProduction: 100, MaximumOrbitalMiningDiameter: 4000 }],
  FCT_Population: [
    { ...stock, GameID: 1, PopulationID: 1, RaceID: 7, SystemID: 1, SystemBodyID: 11, PopName: 'Alpha', Population: 0.9, Efficiency: 1, Capital: 0, MassDriverDest: 2, PurchaseCivilianMinerals: 1, UnrestPoints: 0, PoliticalStatus: 1, ReserveDuranium: 80 },
    { ...stock, GameID: 1, PopulationID: 2, RaceID: 7, SystemID: 1, SystemBodyID: 12, PopName: 'Beta', Population: 0, Efficiency: 1, Capital: 0, MassDriverDest: 0, PurchaseCivilianMinerals: 0, UnrestPoints: 0, PoliticalStatus: 1 },
  ],
  FCT_SystemBody: [{ GameID: 1, SystemBodyID: 11, SystemID: 1, Xcor: 10, Ycor: 20, Radius: 500, RadiationLevel: 0, BodyClass: 1, PlanetNumber: 1, OrbitNumber: 0, StarID: 1 }, { GameID: 1, SystemBodyID: 12, SystemID: 1, Xcor: 1000, Ycor: 2000, Radius: 500, RadiationLevel: 0, BodyClass: 1, PlanetNumber: 2, OrbitNumber: 0, StarID: 1 }],
  FCT_Star: [{ GameID: 1, StarID: 1, ComponentNumber: 1 }],
  FCT_RaceSysSurvey: [{ GameID: 1, RaceID: 7, SystemID: 1, Name: 'Local', SectorID: 0 }],
  FCT_SystemBodySurveys: [{ GameID: 1, RaceID: 7, SystemBodyID: 11 }, { GameID: 1, RaceID: 7, SystemBodyID: 12 }],
  FCT_MineralDeposit: [{ GameID: 1, SystemBodyID: 11, MaterialID: 1, Amount: 1000000, Accessibility: 1, HalfOriginalAmount: 500000, OriginalAcc: 1 }],
  DIM_PopPoliticalStatus: [{ StatusID: 1, ProductionMod: 1 }],
  DIM_PlanetaryInstallation: [
    { PlanetaryInstallationID: 1, Name: 'Mine', MiningProductionValue: 1, Workers: 1, CivilianInstallation: 0, MassDriverValue: 0, ConstructionValue: 0, OrdnanceProductionValue: 0, FighterProductionValue: 0 },
    { PlanetaryInstallationID: 39, Name: 'Civilian complex', MiningProductionValue: 1, Workers: 0, CivilianInstallation: 1, MassDriverValue: 0, ConstructionValue: 0, OrdnanceProductionValue: 0, FighterProductionValue: 0 },
    { PlanetaryInstallationID: 10, Name: 'Driver', MiningProductionValue: 0, Workers: 0, CivilianInstallation: 0, MassDriverValue: 1, ConstructionValue: 0, OrdnanceProductionValue: 0, FighterProductionValue: 0 },
  ],
  FCT_PopulationInstallations: [{ GameID: 1, PopID: 1, PlanetaryInstallationID: 39, Amount: 1 }, { GameID: 1, PopID: 2, PlanetaryInstallationID: 10, Amount: 1 }],
  FCT_Fleet: [{ GameID: 1, RaceID: 7, FleetID: 100, FleetName: 'Miner', AssignedPopulationID: 0, OrbitBodyID: 0, Xcor: 10, Ycor: 20, SystemID: 1, Speed: 10, ParentCommandID: 0, CivilianFunction: 0 }],
  FCT_Ship: [{ GameID: 1, RaceID: 7, ShipID: 100, FleetID: 100, ShipClassID: 100, ShipName: 'Miner ship', CurrentCrew: 10, MothershipID: 0, ShippingLineID: 0 }],
  FCT_ShipClass: [{ GameID: 1, ShipClassID: 100, MiningModules: 1, Crew: 10, ArkShip: 0 }],
  FCT_ClassComponent: [{ GameID: 1, ClassID: 100, ComponentID: 38, NumComponent: 1 }],
  FCT_ShipDesignComponents: [{ GameID: 0, SDComponentID: 38, ComponentTypeID: 38, ComponentValue: 100 }],
})
const opened = (rows) => {
  const raw = new Database(':memory:')
  for (const [table, columns] of Object.entries(SCHEMA)) {
    raw.exec(`create table ${table} (${columns.map((name) => `"${name}"`).join(', ')})`)
    for (const row of rows[table] || []) {
      for (const key of Object.keys(row)) assert.ok(columns.includes(key), `${table}.${key} is an exported column`)
      raw.query(`insert into ${table} values (${columns.map(() => '?').join(', ')})`).run(...columns.map((name) => row[name] ?? null))
    }
  }
  return { raw, database: { query: async (sql, options = {}) => [options.replacements ? raw.query(sql).all(options.replacements) : raw.query(sql).all()] }, close: () => raw.close() }
}
const withWorld = async (rows, run) => {
  const db = opened(rows)
  try { await run(db) } finally { db.close() }
}
const ctxOf = (common, database) => ({ database, GameID: 1, RaceID: 7, RaceNPR: false, options: {}, separator: ',', count: common.counter(',') })
const options = { RaceID: 7, version: '3.2.0' }
const tests = []
const test = (name, run) => tests.push({ name, run })
const define = (m, pageOf) => {
  const mining = m['mining-sites']
  const common = m['warnings/common']
  const policy = m['cmc-policy']
  const warnings = Object.fromEntries([...m['warnings/colonies'].checks, ...m['warnings/fleets'].checks, ...m['warnings/ships'].checks].map((check) => [check.key, check]))
  const current = (world) => mining.assessMiningSites(world, options)
  const colony = (over = {}) => ({ PopulationID: 1, Population: 1, Efficiency: 1, Capital: 0, MassDriverDest: 0, MineProduction: 100, RadiationLevel: 0, Surveyed: 1, Deposits: 1, DepositGaps: 0, Depleted: 0, Manned: 0.5, Automated: 0, Civilian: 0, MineGaps: 0, Drivers: 0, DriverGaps: 0, FactoryGaps: 0, Factories: 0, HaulOrders: 0, ...over })
  test('rates: driver amounts are whole capacity before 5000 t/year', () => {
    assert.deepEqual([0.5, 1.5, 2].map((value) => m.minerals.massDriverRateResult(value).value), [0, 5000, 10000])
    assert.equal(m.minerals.massDriverRateResult(null).status, 'unavailable')
  })
  test('rates: whole refineries and positive sub-tonne Sorium preserve the current annualised rate', () => {
    const colony = { Refineries: 1.5, FuelProduction: 1000, FuelProdStatus: 1, Sorium: 0.5 }
    assert.equal(m.logistics.refineryYield(colony, 1.5).value, 1500)
    assert.equal(m.logistics.refineryYield({ ...colony, Sorium: 0 }, 1.5).value, 0)
    assert.equal(m.logistics.refineryOutput({ ...colony, Refineries: 0.5 }, null).value, 0)
    assert.equal(m.logistics.refineryYield({ ...colony, Sorium: null }, 1.5).status, 'unavailable')
  })
  test('warnings: fractional categories stay physical assets but do not produce or require mineral export', () => {
    for (const values of [{ Manned: 0.5 }, { Manned: 0, Automated: 0.5 }, { Manned: 0, Civilian: 0.5 }, { Manned: 0.5, Automated: 0.5, Civilian: 0.5 }]) {
      const site = current({ colonies: [colony(values)], fleets: [] }).colonies[0]
      assert.equal(site.capacity, 0)
      assert.equal(site.idle, 1)
      assert.equal(site.output, 0)
      assert.equal(mining.deliveryVerdict(site), 0)
      assert.ok(mining.missingNeeds(site).some((need) => need.key === 'capacity'))
    }
    const site = current({ colonies: [colony({ Manned: 1.5, MassDriverDest: 2, DestinationID: 2, DestinationRaceID: 7, SystemID: 1, DestinationSystemID: 1, Drivers: 0.5, DestinationDrivers: 1 })], fleets: [] }).colonies[0]
    assert.equal(site.capacity, 1)
    assert.equal(mining.deliveryVerdict(site), 1)
    const receiver = current({ colonies: [colony({ Manned: 1, MassDriverDest: 2, DestinationID: 2, DestinationRaceID: 7, SystemID: 1, DestinationSystemID: 1, Drivers: 1, DestinationDrivers: 0.5 })], fleets: [] }).colonies[0]
    assert.equal(mining.deliveryVerdict(receiver), 1)
  })
  test('warnings: the real fractional mine and driver reads reach the warning predicates', async () => {
    const rows = world()
    rows.FCT_Ship = []
    rows.FCT_PopulationInstallations[0] = { GameID: 1, PopID: 1, PlanetaryInstallationID: 1, Amount: 0.5 }
    rows.FCT_PopulationInstallations.push({ GameID: 1, PopID: 1, PlanetaryInstallationID: 10, Amount: 0.5 })
    await withWorld(rows, async ({ raw, database }) => {
      const ctx = ctxOf(common, database)
      assert.equal((await warnings['wasted-mining-capacity'].read(ctx)).length, 1)
      assert.equal((await warnings['mass-driver-orphans'].read(ctx)).length, 0)
      raw.exec('update FCT_PopulationInstallations set Amount = 1 where PopID = 1 and PlanetaryInstallationID = 1')
      assert.equal((await warnings['wasted-mining-capacity'].read(ctx)).length, 0)
      assert.equal((await warnings['mass-driver-orphans'].read(ctx)).length, 1)
    })
  })
  test('location: absent or stale orbit IDs use the coordinate colony in warnings and numerical production', async () => {
    for (const orbit of [0, 12]) {
      const rows = world()
      rows.FCT_Fleet[0].OrbitBodyID = orbit
      await withWorld(rows, async ({ database }) => {
        const sites = await common.readMiningSites(ctxOf(common, database))
        assert.equal(sites.fleets.length, 1)
        assert.equal(sites.fleets[0].row.SystemBodyID, 11)
        assert.equal(sites.fleets[0].colonyId, 1)
        assert.equal(sites.fleets[0].producing, 1)
        const production = await m['mining-data'].loadOrbitalMining(database, { GameID: 1, RaceID: 7 })
        assert.equal(production.length, 1)
        assert.equal(production[0].PopulationID, 1)
        assert.equal(production[0].SystemBodyID, 11)
        assert.equal(m['mineral-outlook'].orbitalRateResult(production[0], {}).value, 100)
      })
    }
  })
  test('location: a gone assignment auto-associates, but an existing remote assignment prevents production', async () => {
    await withWorld(world(), async ({ raw, database }) => {
      const production = () => m['mining-data'].loadOrbitalMining(database, { GameID: 1, RaceID: 7 })
      raw.exec('update FCT_Fleet set AssignedPopulationID = 999')
      assert.equal((await production()).length, 1)
      raw.exec('update FCT_Fleet set AssignedPopulationID = 2')
      assert.equal((await production()).length, 0)
      const sites = await common.readMiningSites(ctxOf(common, database))
      assert.equal(sites.fleets[0].producing, 0)
      assert.equal(sites.fleets[0].colonyId, null)
      raw.exec('insert into FCT_Population (GameID, PopulationID, RaceID, SystemBodyID) values (1, 3, 7, 11)')
      assert.equal((await production()).length, 0)
      assert.equal((await common.readMiningSites(ctxOf(common, database))).fleets[0].producing, 0)
    })
  })
  test('location: strict coordinate tolerance, no system restriction, and a matching saved assignment', async () => {
    await withWorld(world(), async ({ raw, database }) => {
      const locate = async () => (await database.query(m['mining-data'].miningLocationsQuery({ GameID: 1, RaceID: 7 })))[0][0]
      raw.exec('update FCT_Fleet set Xcor = 10.999, Ycor = 19.001, SystemID = 99')
      assert.equal((await locate()).ColonyID, 1)
      raw.exec('update FCT_Fleet set Xcor = 11')
      assert.equal((await locate()).ColonyID, null)
      raw.exec('update FCT_Fleet set Xcor = 10, Ycor = 20; update FCT_SystemBody set Xcor = 10, Ycor = 20 where SystemBodyID = 12')
      assert.equal((await locate()).LocationUnknown, 1)
      raw.exec('update FCT_Fleet set AssignedPopulationID = 2')
      assert.equal((await locate()).ColonyID, 2)
      assert.equal((await locate()).LocationUnknown, 0)
    })
  })
  test('location: ambiguous unassigned colonies propagate unknown contributions rather than inventing a winner', async () => {
    const rows = world()
    rows.FCT_SystemBody[1].Xcor = 10
    rows.FCT_SystemBody[1].Ycor = 20
    await withWorld(rows, async ({ database }) => {
      const sites = await common.readMiningSites(ctxOf(common, database))
      assert.equal(sites.fleets[0].producing, null)
      assert.ok(sites.colonies.every((site) => site.output === null))
      const production = await m['mining-data'].loadOrbitalMining(database, { GameID: 1, RaceID: 7 })
      assert.ok(production.length > 0)
      assert.equal(m['mineral-outlook'].orbitalRateResult(production[0], {}).status, 'unavailable')
      assert.equal(m.minerals.orbitalMinerRate(production[0], {}), null)
    })
  })
  test('location: redeployment and stranded reasons follow the exhausted coordinate body, not the viable saved body', async () => {
    const rows = world()
    rows.FCT_Fleet[0].OrbitBodyID = 12
    rows.FCT_MineralDeposit[0].Amount = 0
    rows.FCT_MineralDeposit.push({ ...rows.FCT_MineralDeposit[0], SystemBodyID: 12, Amount: 1000000 })
    await withWorld(rows, async ({ database }) => {
      const ctx = ctxOf(common, database)
      const stranded = await warnings['stranded-miners'].read(ctx)
      assert.equal(stranded.length, 1)
      assert.match(stranded[0].cells.reason.text, /exhausted/)
      const redeploy = await warnings['mining-redeployment'].read(ctx)
      assert.ok(redeploy.some((row) => row.id === 'fleet:100' && /exhausted/.test(row.cells.reason.text)))
    })
  })
  const policyResult = async (rows, run) => withWorld(rows, async ({ database }) => {
    const loaded = await policy.loadCmcPolicy(database, { GameID: 1, RaceID: 7 })
    const report = policy.cmcPolicyRows(loaded, options)
    await run(report.rows[0], loaded)
  })
  test('reserve: 100 civilian tonnes, an 80-tonne local shortfall and no other mining ship 20 tonnes', async () => {
    const rows = world()
    rows.FCT_Ship = []
    await policyResult(rows, (row, loaded) => {
      assert.equal(loaded.colonies[0].ReserveDuranium, 80)
      assert.equal(row.output.value, 100)
      assert.equal(row.throughput.result.value.shipped, 20)
      assert.equal(row.throughput.state, 'over')
    })
  })
  test('reserve: other surface and orbital mining fill the local reserve before civilian output; stocks and reserves stay per mineral', async () => {
    const rows = world()
    rows.FCT_Population[0].ReserveDuranium = 180
    rows.FCT_PopulationInstallations.push({ GameID: 1, PopID: 1, PlanetaryInstallationID: 1, Amount: 1 })
    rows.FCT_MineralDeposit.push({ ...rows.FCT_MineralDeposit[0], MaterialID: 2, Accessibility: 0.5 })
    rows.FCT_Population[0].ReserveNeutronium = 120
    await policyResult(rows, (row) => {
      assert.equal(row.output.value, 150)
      assert.equal(row.throughput.result.value.shipped, 130)
    })
    rows.FCT_Population[0].ReserveDuranium = 10000
    rows.FCT_Population[0].ReserveNeutronium = 10000
    await policyResult(rows, (row) => assert.equal(row.throughput.result.value.shipped, 0))
    rows.FCT_Population[0].ReserveDuranium = null
    await policyResult(rows, (row) => assert.equal(row.throughput.result.status, 'unavailable'))
  })
  test('crew: 0.9 million surface plus 0.2 million orbital residents is eligible, exactly one million is not, unknown is disclosed', async () => {
    const rows = world()
    rows.FCT_Ship[0].CurrentCrew = 5
    rows.FCT_Fleet.push({ ...rows.FCT_Fleet[0], FleetID: 200, AssignedPopulationID: 1 })
    rows.FCT_Ship.push({ ...rows.FCT_Ship[0], ShipID: 200, FleetID: 200, ShipClassID: 200 })
    rows.FCT_ShipClass.push({ GameID: 1, ShipClassID: 200, ArkShip: 1, Crew: 0, MiningModules: 0 })
    rows.FCT_ClassComponent.push({ GameID: 1, ClassID: 200, ComponentID: 17, NumComponent: 1 })
    rows.FCT_ShipDesignComponents.push({ GameID: 0, SDComponentID: 17, ComponentTypeID: 17, SpecialFunction: 7, ComponentValue: 200000 })
    rows.FCT_ShipCargo = [{ GameID: 1, ShipID: 200, SpeciesID: 1, CargoTypeID: 1, Amount: 200000 }]
    rows.FCT_Species = [{ GameID: 1, SpeciesID: 1 }]
    await withWorld(rows, async ({ raw, database }) => {
      const read = async () => (await warnings['undermanned-ships'].read(ctxOf(common, database)))[0].cells.replace
      assert.match(await read(), /Alpha/)
      raw.exec('update FCT_Population set Population = 0.8 where PopulationID = 1')
      assert.match(await read(), /No colony/)
      raw.exec('update FCT_ShipCargo set Amount = null; update FCT_Population set Population = 0.9 where PopulationID = 1')
      const unknown = await read()
      assert.match(unknown.text, /not known/)
      assert.equal(unknown.result.status, 'unavailable')
    })
  })
  const unknownWorlds = async (run) => {
    for (const table of ['FCT_Fleet', 'FCT_SystemBody']) {
      for (const axis of ['Xcor', 'Ycor']) {
        for (const absent of [false, true]) {
          const rows = world()
          rows[table][0][axis] = null
          await withWorld(rows, async (db) => {
            if (absent) db.raw.exec(`alter table ${table} drop column ${axis}`)
            await run(db, `${table}.${axis}`)
          })
        }
      }
    }
  }
  test('unknown numeric: absent and NULL coordinates preserve potential production and name the input', async () => {
    await unknownWorlds(async ({ database }, input) => {
      const production = await m['mining-data'].loadOrbitalMining(database, { GameID: 1, RaceID: 7 })
      assert.equal(production.length, 1, input)
      const rate = m['mineral-outlook'].miningSum(production.map((row) => m['mineral-outlook'].orbitalRateResult(row, {})))
      assert.equal(rate.status, 'unavailable', input)
      assert.ok(rate.inputs.missing.includes(input), input)
      assert.equal(m.minerals.orbitalMinerRate(production[0], {}), null)
    })
  })
  test('unknown CMC: absent and NULL coordinates cannot turn an unknown reserve contribution into 20 shipped tonnes', async () => {
    await unknownWorlds(async ({ database }, input) => {
      const loaded = await policy.loadCmcPolicy(database, { GameID: 1, RaceID: 7 })
      const result = policy.cmcPolicyRows(loaded, options).rows[0].throughput.result
      assert.equal(result.status, 'unavailable', input)
      assert.ok(result.inputs.missing.includes(input), input)
    })
  })
  test('unknown warnings: absent and NULL coordinates reach orphan, stranded and redeployment consumers', async () => {
    await unknownWorlds(async ({ database }, input) => {
      const ctx = ctxOf(common, database)
      const sites = await common.readMiningSites(ctx)
      const colony = sites.colonies.find((site) => site.id === 1)
      assert.ok(colony, input)
      assert.equal(colony.output, null, input)
      for (const [key, id] of [['mass-driver-orphans', 'colony:1'], ['stranded-miners', 'fleet:100'], ['mining-redeployment', 'fleet:100']]) {
        const rows = await warnings[key].read(ctx)
        const row = rows.find((row) => row.id === id)
        assert.ok(row && row.unevaluated, `${input}: ${key}`)
        assert.ok(row.unevaluated.inputs.missing.includes(input), `${input}: ${key}`)
      }
    })
  })
  test('unknown controls: readable positions, far axes, race, blocking assignment and zero crew or modules remain decisive', async () => {
    for (const mode of ['known', 'far fleet axis', 'far body axis', 'other race', 'remote assignment', 'zero crew', 'zero modules']) {
      const rows = world()
      if (mode !== 'known') rows.FCT_Fleet[0].Xcor = null
      if (mode === 'far fleet axis') rows.FCT_Fleet[0].Ycor = 5000
      if (mode === 'far body axis') { rows.FCT_Fleet[0].Xcor = 10; rows.FCT_SystemBody[0].Xcor = null; rows.FCT_SystemBody[0].Ycor = 5000 }
      if (mode === 'other race') rows.FCT_Fleet[0].RaceID = 8
      if (mode === 'remote assignment') rows.FCT_Fleet[0].AssignedPopulationID = 2
      if (mode === 'zero crew') rows.FCT_Ship[0].CurrentCrew = 0
      if (mode === 'zero modules') rows.FCT_ShipClass[0].MiningModules = 0
      await withWorld(rows, async ({ database }) => {
        const loaded = await policy.loadCmcPolicy(database, { GameID: 1, RaceID: 7 })
        assert.equal(loaded.orbital.length, mode === 'known' ? 1 : 0, mode)
        const result = policy.cmcPolicyRows(loaded, options).rows[0].throughput.result
        assert.equal(result.value.shipped, mode === 'known' ? 100 : 20, mode)
        const sites = await common.readMiningSites(ctxOf(common, database))
        assert.ok(sites.colonies.every((site) => site.output !== null), mode)
      })
    }
  })
  test('unknown controls: an unread rival colony cannot falsely establish uniqueness, but a confirmed assignment still wins', async () => {
    const rows = world()
    rows.FCT_SystemBody[1].Xcor = null
    rows.FCT_SystemBody[1].Ycor = 20
    await withWorld(rows, async ({ raw, database }) => {
      const loaded = await policy.loadCmcPolicy(database, { GameID: 1, RaceID: 7 })
      assert.equal(loaded.orbital.length, 1)
      assert.equal(policy.cmcPolicyRows(loaded, options).rows[0].throughput.result.status, 'unavailable')
      raw.exec('update FCT_Fleet set AssignedPopulationID = 1')
      const known = await m['mining-data'].loadOrbitalMining(database, { GameID: 1, RaceID: 7 })
      assert.equal(m['mineral-outlook'].orbitalRateResult(known[0], {}).value, 100)
      raw.exec('update FCT_Fleet set AssignedPopulationID = 2')
      assert.equal((await m['mining-data'].loadOrbitalMining(database, { GameID: 1, RaceID: 7 })).length, 0)
      const sites = await common.readMiningSites(ctxOf(common, database))
      assert.ok(!sites.colonies.some((site) => site.id === 1 && site.output === null))
    })
  })
  test('decimal numeric: weighted category sums are decimal before the category is truncated', async () => {
    for (const [amount, industries, whole] of [[0.1, 6, 1], [0.0999999999999, 6, 0], [0.6, 6, 1], [0.5, 0, 0]]) {
      const rows = world()
      rows.FCT_Ship = []
      rows.DIM_PlanetaryInstallation.push({ ...rows.DIM_PlanetaryInstallation[0], PlanetaryInstallationID: 7 }, { ...rows.DIM_PlanetaryInstallation[0], PlanetaryInstallationID: 38, Name: 'Conventional industry', MiningProductionValue: 0.15 })
      rows.FCT_PopulationInstallations = [{ GameID: 1, PopID: 1, PlanetaryInstallationID: 7, Amount: amount }, { GameID: 1, PopID: 1, PlanetaryInstallationID: 38, Amount: industries }]
      await withWorld(rows, async ({ database }) => {
        const production = await m['mining-data'].loadSurfaceMining(database, { GameID: 1, RaceID: 7 })
        assert.equal(m['mineral-outlook'].surfaceRateResult(production[0]).value, whole * 100)
        const site = (await common.readMiningSites(ctxOf(common, database))).colonies[0]
        assert.equal(site.capacity, whole)
        assert.equal(site.output, whole > 0 ? 1 : 0)
        assert.equal((await warnings['wasted-mining-capacity'].read(ctxOf(common, database))).length, whole > 0 ? 0 : 1)
      })
    }
  })
  test('decimal refinery: weighted installation acquisition stays exact through the annualised rate and legacy use', async () => {
    const rows = world()
    rows.FCT_Ship = []
    rows.FCT_Population[0].Sorium = 10
    rows.FCT_Population[0].FuelProdStatus = 1
    rows.FCT_Race[0].FuelProduction = 1000
    rows.DIM_PlanetaryInstallation.push({ ...rows.DIM_PlanetaryInstallation[0], PlanetaryInstallationID: 34, RefineryProductionValue: 1 }, { ...rows.DIM_PlanetaryInstallation[0], PlanetaryInstallationID: 38, RefineryProductionValue: 0.05 })
    rows.FCT_PopulationInstallations = [{ GameID: 1, PopID: 1, PlanetaryInstallationID: 34, Amount: 0.08 }, { GameID: 1, PopID: 1, PlanetaryInstallationID: 38, Amount: 18.4 }]
    await withWorld(rows, async ({ database }) => {
      const [colonies] = await database.query(m['legacy-consumption'].legacyColoniesQuery({ GameID: 1, RaceID: 7 }))
      assert.equal(colonies[0].Refineries, 0.9999999999999999)
      assert.equal(m.logistics.refineryYield(colonies[0], 1).value, 1000)
      const summary = m['empire-logistics'].summaryRows({ colonies: [colonies[0]], sources: { listing: [1], tonnage: [], services: [], modules: [] }, modifierOf: () => 1 })
      assert.equal(summary[0].fuelProduction, 1000)
      const totals = m['legacy-consumption'].legacyModels({ colonies, modifiers: { 1: { OverallProductionModifier: 1 } }, tasks: [], activities: [] })
      assert.equal(totals.fuel.byMineral.Sorium.value, 0.5)
    })
  })
  test('decimal export: surface and orbital acquisition share the civilian whole-capacity boundary and ledger correction', async () => {
    for (const [amount, exporting] of [[0.09999999999999999, 1], [0.0999999999999, 0], [0.1, 1]]) {
      const rows = world()
      rows.DIM_PlanetaryInstallation[1].MiningProductionValue = 10
      rows.FCT_PopulationInstallations[0].Amount = amount
      await withWorld(rows, async ({ database }) => {
        const surface = await m['mining-data'].loadSurfaceMining(database, { GameID: 1, RaceID: 7 })
        const orbital = await m['mining-data'].loadOrbitalMining(database, { GameID: 1, RaceID: 7 })
        assert.equal(surface[0].MassDriverExport, exporting, `surface ${amount}`)
        assert.equal(orbital[0].MassDriverExport, exporting, `orbital ${amount}`)
        const routes = await m['mineral-supply'].loadSiteRoutes(database, { GameID: 1, RaceID: 7 })
        const [site] = m['mineral-supply'].siteSupply({ surface, orbital, navalAdmins: {}, routes, packets: {}, RaceID: 7, materialId: 1, flows: m['mineral-supply'].transferFlows([], 1) })
        assert.equal(site.packetOutput.value, exporting ? 100 : 0, `packets ${amount}`)
        assert.equal(site.local.value, 100, `local ${amount}`)
        assert.deepEqual(m.minerals.unloggedMining({ surface, orbital, navalAdmins: {} }), exporting ? { 1: 200 } : {}, `unlogged ${amount}`)
      })
    }
  })
  test('decimal orbital export: the orbital ledger correction independently uses decimal civilian capacity', async () => {
    const rows = world()
    rows.DIM_PlanetaryInstallation[1].MiningProductionValue = 10
    rows.FCT_PopulationInstallations[0].Amount = 0.09999999999999999
    await withWorld(rows, async ({ database }) => {
      const orbital = await m['mining-data'].loadOrbitalMining(database, { GameID: 1, RaceID: 7 })
      assert.equal(orbital[0].MassDriverExport, 1)
      assert.deepEqual(m.minerals.unloggedMining({ surface: [], orbital, navalAdmins: {} }), { 1: 100 })
    })
  })
  test('unknown export: missing capacity or eligibility remains unknown in packet, local and both ledger corrections', async () => {
    for (const mode of ['amount', 'type', 'value', 'radiation', 'purchase', 'race', 'production', 'destination']) {
      const rows = world()
      if (mode === 'amount') rows.FCT_PopulationInstallations[0].Amount = null
      if (mode === 'type') rows.DIM_PlanetaryInstallation.splice(1, 1)
      if (mode === 'value') rows.DIM_PlanetaryInstallation[1].MiningProductionValue = null
      if (mode === 'destination') rows.FCT_Population[0].MassDriverDest = null
      if (mode === 'radiation') rows.FCT_SystemBody[0].RadiationLevel = null
      if (mode === 'purchase') rows.FCT_Population[0].PurchaseCivilianMinerals = null
      if (mode === 'race') rows.FCT_Race[0].NPR = null
      if (mode === 'production') rows.FCT_Race[0].MineProduction = null
      await withWorld(rows, async ({ database }) => {
        const surface = await m['mining-data'].loadSurfaceMining(database, { GameID: 1, RaceID: 7 })
        const orbital = await m['mining-data'].loadOrbitalMining(database, { GameID: 1, RaceID: 7 })
        assert.equal(surface[0].MassDriverExport, null, `surface ${mode}`)
        assert.equal(orbital[0].MassDriverExport, null, `orbital ${mode}`)
        const routes = await m['mineral-supply'].loadSiteRoutes(database, { GameID: 1, RaceID: 7 })
        const result = m['mineral-supply'].mineralSupply({ surface, orbital, navalAdmins: {}, routes, packets: {}, cargo: {}, RaceID: 7, materialId: 1, flows: m['mineral-supply'].transferFlows([], 1) })
        const [site] = result.sites
        assert.equal(site.packetOutput.status, 'unavailable', mode)
        assert.equal(site.local.status, 'unavailable', mode)
        assert.equal(site.route.status, 'unavailable', mode)
        assert.equal(site.supply.status, 'unavailable', mode)
        assert.equal(site.destination ? site.destination.populationId : null, mode === 'destination' ? null : 2, mode)
        assert.equal(result.destinations.length, mode === 'destination' ? 0 : 1, mode)
        if (mode !== 'destination') assert.equal(result.destinations[0].fromSites.status, 'unavailable', mode)
        assert.equal(result.empire.packetOutput.status, 'unavailable', mode)
        assert.equal(result.empire.local.status, 'unavailable', mode)
        assert.deepEqual(m.minerals.unloggedMining({ surface, orbital, navalAdmins: {} }), { 1: null }, mode)
        const vm = instantiate(await pageOf('mineral-outlook'), { $store: { getters: {}, state: {} }, data: { surfaceMining: surface, orbitalMining: orbital, navalAdmins: {} } })
        assert.equal(vm.unloggedResults[1].status, 'unavailable', mode)
      })
    }
  })
  test('decimal drivers: source, receiver, capacity, warning delivery and MSP acquisition share whole decimal amounts', async () => {
    for (const [amount, count] of [[0.9999999999999999, 1], [0.9999999999999, 0], [1, 1]]) {
      const rows = world()
      rows.FCT_PopulationInstallations[1].Amount = amount
      rows.FCT_PopulationInstallations.push({ ...rows.FCT_PopulationInstallations[1], PopID: 1 })
      await withWorld(rows, async ({ database }) => {
        const loaded = await policy.loadCmcPolicy(database, { GameID: 1, RaceID: 7 })
        const row = policy.cmcPolicyRows(loaded, options).rows[0]
        assert.equal(row.capacity.value, count * 5000, `capacity ${amount}`)
        assert.equal(row.sourceDrivers.value, Boolean(count), `source ${amount}`)
        assert.equal(row.receiverDrivers.value, Boolean(count), `receiver ${amount}`)
        const [route] = await m['mineral-supply'].loadSiteRoutes(database, { GameID: 1, RaceID: 7 })
        assert.equal(m['mineral-supply'].routeResult({ colony: route, civilian: false, RaceID: 7 }).value.stock, count ? 'ships' : 'none', `route ${amount}`)
        const site = (await common.readMiningSites(ctxOf(common, database))).colonies.find((site) => site.id === 1)
        assert.equal(mining.deliveryVerdict(site), count ? 0 : 1, `warning ${amount}`)
        const msp = await m['msp-supply'].loadMspColonies(database, { GameID: 1, RaceID: 7 })
        assert.equal(msp[0].Drivers, count, `MSP ${amount}`)
      })
    }
  })
  test('decimal complexes: policy wealth and system summary use the decimal whole physical count', async () => {
    for (const [amount, count] of [[0.9999999999999999, 1], [0.9999999999999, 0], [1, 1]]) {
      const rows = world()
      rows.DIM_PlanetaryInstallation[1].MiningProductionValue = 10
      rows.FCT_PopulationInstallations[0].Amount = amount
      await withWorld(rows, async ({ database }) => {
        const loaded = await policy.loadCmcPolicy(database, { GameID: 1, RaceID: 7 })
        const report = policy.cmcPolicyRows(loaded, options)
        assert.equal(report.rows[0].complexes, count, `policy ${amount}`)
        const vm = instantiate(await pageOf('minerals'), { $store: { getters: {}, state: {} }, database, GameID: 1, RaceID: 7 })
        const colonies = await vm.runAsync('colonies')
        const summary = m['cmc-summary'].cmcSummary({ colonies, bodies: [{ SystemID: 1, depositList: [{ MaterialID: 1, Amount: 50000, Accessibility: 1 }], cmcInReach: true, cmcStarInReach: true }], systems: [{ SystemID: 1, Name: 'Local' }], version: '3.2.x' })
        assert.equal(summary.rows[0].expenditure, count * 250, `summary ${amount}`)
      })
    }
  })
  test('decimal pages: Minerals and Hauling classify exporting stock from the same whole driver capacity', async () => {
    for (const [amount, exporting] of [[0.9999999999999999, true], [0.9999999999999, false], [1, true], [0.5, false]]) {
      const rows = world()
      rows.FCT_Population[0].Duranium = 100
      rows.FCT_Population[0].ReserveDuranium = 0
      rows.FCT_PopulationInstallations.push({ GameID: 1, PopID: 1, PlanetaryInstallationID: 10, Amount: amount })
      await withWorld(rows, async ({ database }) => {
        for (const name of ['minerals', 'hauling']) {
          const vm = instantiate(await pageOf(name), { $store: { getters: {}, state: {} }, database, GameID: 1, RaceID: 7, data: { needs: { 1: { Duranium: 50 } }, packets: {} } })
          await vm.runAsync('colonies')
          const row = vm.colonyStocks.find((row) => row.colony.PopulationID === 1)
          assert.equal(row.minerals[0].state, exporting ? 'exported' : 'surplus', `${name} ${amount}`)
        }
      })
    }
  })
  test('unread stock drivers: actual page acquisitions retain deciding gaps and independent controls', async () => {
    for (const mode of ['amount', 'type', 'weight', 'destination', 'none', 'no destination', 'zero', 'fractional', 'whole', 'mixed', 'short', 'below', 'held', 'empty', 'no queue']) {
      const rows = world()
      Object.assign(rows.FCT_Population[0], { Duranium: 100, ReserveDuranium: 0 })
      rows.FCT_PopulationInstallations.push({ GameID: 1, PopID: 1, PlanetaryInstallationID: 10, Amount: mode === 'zero' ? 0 : mode === 'fractional' ? 0.5 : mode === 'whole' || mode === 'destination' ? 1 : null })
      if (mode === 'mixed') rows.FCT_PopulationInstallations.push({ GameID: 1, PopID: 1, PlanetaryInstallationID: 10, Amount: 1 })
      if (mode === 'type') rows.DIM_PlanetaryInstallation.splice(2, 1)
      if (mode === 'weight') rows.DIM_PlanetaryInstallation[2].MassDriverValue = null
      if (mode === 'destination') rows.FCT_Population[0].MassDriverDest = null
      if (mode === 'no destination') rows.FCT_Population[0].MassDriverDest = 0
      if (mode === 'none') rows.FCT_PopulationInstallations.pop()
      if (mode === 'below') rows.FCT_Population[0].ReserveDuranium = 150
      if (mode === 'held') rows.FCT_Population[0].ReserveDuranium = 100
      if (mode === 'empty') rows.FCT_Population[0].Duranium = 0
      const needs = mode === 'short' ? 200 : mode === 'empty' || mode === 'no queue' ? 0 : 50
      const expected = ({ none: 'surplus', 'no destination': 'surplus', zero: 'surplus', fractional: 'surplus', whole: 'exported', mixed: 'exported', short: 'short', below: 'below', held: 'held', empty: 'empty', 'no queue': 'surplus' })[mode] || 'unknown'
      await withWorld(rows, async ({ database }) => {
        for (const name of ['minerals', 'hauling']) {
          const vm = instantiate(await pageOf(name), { $store: { getters: {}, state: {} }, database, GameID: 1, RaceID: 7, data: { needs: { 1: { Duranium: needs } }, packets: {} } })
          await vm.runAsync('colonies')
          if (['amount', 'type', 'weight'].includes(mode)) assert.equal(vm.colonies[0].MassDrivers, null, `driver display ${name} ${mode}`)
          const mineral = vm.colonyStocks.find((row) => row.colony.PopulationID === 1).minerals[0]
          assert.equal(mineral.state, expected === 'unknown' && name === 'minerals' ? null : expected, `${name} ${mode}`)
          if (name === 'minerals') assert.equal(mineral.results.state.status === 'unavailable', expected === 'unknown', mode)
        }
      })
    }
  })
  test('unread refineries: page membership, totals and acquired feeds retain unavailable rates', async () => {
    for (const mode of ['amount', 'type', 'weight', 'none', 'zero', 'fractional', 'whole', 'off', 'zero unread type']) {
      const rows = world()
      rows.FCT_Ship = []
      rows.DIM_PlanetaryInstallation.forEach((type) => { type.RefineryProductionValue = 0 })
      rows.DIM_PlanetaryInstallation.push({ PlanetaryInstallationID: 34, Name: 'Refinery', RefineryProductionValue: mode === 'weight' ? null : 1, MaintenanceValue: 0 })
      Object.assign(rows.FCT_Population[0], { Sorium: 10, FuelStockpile: 0, FuelProdStatus: mode === 'off' ? 0 : 1 })
      rows.FCT_Race[0].FuelProduction = 1000
      rows.FCT_PopulationInstallations = mode === 'none' ? [] : [{ GameID: 1, PopID: 1, PlanetaryInstallationID: 34, Amount: mode === 'amount' ? null : mode === 'zero' || mode === 'zero unread type' ? 0 : mode === 'fractional' ? 0.5 : 1 }]
      if (mode === 'type' || mode === 'zero unread type') rows.DIM_PlanetaryInstallation.pop()
      const unknown = ['amount', 'type', 'weight'].includes(mode)
      const expected = unknown ? null : mode === 'whole' ? 1000 : 0
      await withWorld(rows, async ({ database }) => {
        const vm = instantiate(await pageOf('logistics'), { $store: { getters: {}, state: {} }, database, GameID: 1, RaceID: 7, data: { modifierOf: () => 1, place: () => '' } })
        await vm.runAsync('colonies')
        const listed = vm.refineryRows.find((row) => row.PopulationID === 1)
        assert.equal(Boolean(listed), unknown || mode === 'whole' || mode === 'off', `membership ${mode}`)
        if (listed) assert.equal(listed.output, expected, `page ${mode}`)
        if (unknown) assert.equal(listed.Refineries, null, `page display ${mode}`)
        assert.equal(vm.refineryTotals.unknown, unknown ? 1 : 0, `totals ${mode}`)
        const colonies = await m['resource-feeds'].loadSupplyState(database, { GameID: 1, RaceID: 7 })
        if (unknown) assert.equal(colonies[0].Refineries, null, `feed acquisition ${mode}`)
        const feed = m['resource-feeds'].supplyFeeds({ colonies, modifierOf: () => 1 }).find((feed) => feed.key === '1:fuel')
        assert.equal(feed.production, expected, `feed ${mode}`)
        const [legacy] = await database.query(m['legacy-consumption'].legacyColoniesQuery({ GameID: 1, RaceID: 7 }))
        assert.equal(m.logistics.refineryYield(legacy[0], 1).value ?? null, expected, `legacy ${mode}`)
      })
    }
  })
  test('unread civilian policy: real candidates and system summary keep potentially productive installations', async () => {
    for (const mode of ['amount', 'type', 'weight', 'flag', 'non-civilian', 'zero weight', 'zero amount', 'zero unread type', 'fractional', 'whole', 'destination']) {
      const rows = world()
      rows.FCT_Ship = []
      rows.DIM_PlanetaryInstallation[1].MiningProductionValue = mode === 'weight' ? null : mode === 'zero weight' ? 0 : 10
      rows.DIM_PlanetaryInstallation[1].CivilianInstallation = mode === 'flag' ? null : mode === 'non-civilian' ? 0 : 1
      rows.FCT_PopulationInstallations[0].Amount = mode === 'amount' ? null : mode === 'zero amount' || mode === 'zero unread type' ? 0 : mode === 'fractional' ? 0.05 : 1
      if (mode === 'type' || mode === 'zero unread type') rows.DIM_PlanetaryInstallation.splice(1, 1)
      if (mode === 'destination') rows.FCT_Population[0].MassDriverDest = null
      const unknown = ['amount', 'type', 'weight', 'flag'].includes(mode)
      const listed = unknown || mode === 'whole' || mode === 'destination'
      await withWorld(rows, async ({ database }) => {
        const loaded = await policy.loadCmcPolicy(database, { GameID: 1, RaceID: 7 })
        if (unknown) assert.equal(loaded.surface.length, 1, `policy surface membership ${mode}`)
        const report = policy.cmcPolicyRows(loaded, options)
        assert.equal(report.rows.length, listed ? 1 : 0, `policy membership ${mode}`)
        if (listed) {
          assert.equal(report.rows[0].production.status === 'unavailable', unknown, `policy production ${mode}`)
          if (unknown) assert.equal(report.rows[0].state, 'unknown', `policy ${mode}`)
          assert.equal(report.rows[0].output.value ?? null, unknown ? null : 1000, `output ${mode}`)
        }
        const vm = instantiate(await pageOf('minerals'), { $store: { getters: {}, state: {} }, database, GameID: 1, RaceID: 7 })
        const colonies = await vm.runAsync('colonies')
        const summary = m['cmc-summary'].cmcSummary({ colonies, bodies: [], systems: [{ SystemID: 1, Name: 'Local' }], version: '3.2.x' })
        assert.equal(summary.rows.length, listed ? 1 : 0, `summary membership ${mode}`)
        if (listed) assert.equal(summary.rows[0].expenditure, unknown ? null : 250, `summary wealth ${mode}`)
      })
    }
  })
  test('unread sibling acquisitions: MSP driver routes and fuel-site refinery caveats retain potential inputs', async () => {
    for (const mode of ['amount', 'type', 'weight', 'none', 'zero', 'whole']) {
      const rows = world()
      rows.FCT_Ship = []
      rows.FCT_Population[0].FuelProdStatus = 1
      rows.DIM_PlanetaryInstallation.forEach((type) => { type.RefineryProductionValue = 0 })
      Object.assign(rows.DIM_PlanetaryInstallation[2], { RefineryProductionValue: 1, MassDriverValue: mode === 'weight' ? null : 1 })
      if (mode === 'weight') rows.DIM_PlanetaryInstallation[2].RefineryProductionValue = null
      rows.FCT_PopulationInstallations = mode === 'none' ? [] : [{ GameID: 1, PopID: 1, PlanetaryInstallationID: 10, Amount: mode === 'amount' ? null : mode === 'zero' ? 0 : 1 }]
      if (mode === 'type') rows.DIM_PlanetaryInstallation.splice(2, 1)
      const unknown = ['amount', 'type', 'weight'].includes(mode)
      await withWorld(rows, async ({ database }) => {
        const colonies = await m['msp-supply'].loadMspColonies(database, { GameID: 1, RaceID: 7 })
        const route = m['mineral-supply'].routeResult({ colony: colonies[0], civilian: false, RaceID: 7 })
        assert.equal(route.status === 'unavailable', unknown, `MSP route ${mode}`)
        if (!unknown) assert.equal(route.value.stock, mode === 'whole' ? 'ships' : 'none', mode)
        const sites = await m['fuel-ledger'].loadFuelSites(database, { GameID: 1, RaceID: 7 })
        const site = sites.colonies[0]
        assert.equal(site.Refineries, unknown ? null : mode === 'whole' ? 1 : 0, `fuel site ${mode}`)
        assert.equal(m['fuel-ledger'].colonyService(site, []).conditional.length, unknown || mode === 'whole' ? 1 : 0, `fuel caveat ${mode}`)
      })
    }
  })
  test('decimal planned: assumed civilian and new manned or automated categories preserve inputs before multiplication', () => {
    const deposit = { SystemBodyID: 1, MaterialID: 1, Amount: 1e9, Accessibility: 1, HalfOriginalAmount: 1e9, OriginalAcc: 1, RadiationLevel: 0, OwnColonies: 1, Xcor: 0, Ycor: 0, SystemID: 1 }
    for (const [weight, count, whole] of [[0.333333333333333, 300003, 100000], [0.09999999999999999, 10, 1], [0.0999999999999, 10, 0], [0.1, 10, 1]]) {
      const candidate = m['cmc-candidates'].candidateRanking({ bodies: [{ SystemBodyID: 1, name: 'Planned', depositList: [deposit], cmcInReach: true, complexes: 0, RadiationLevel: 0 }], race: { MineProduction: 100, ComplexMining: weight }, allowed: true, settings: { ...m['cmc-candidates'].DEFAULT_SETTINGS, complexes: String(count) } })
      assert.equal(candidate.rows[0].lines[0].rate.value, whole * 100, `CMC ${weight} x ${count}`)
      for (const workers of [0, 1]) {
        const [site] = m['deficit-sites'].rankSites({ candidates: [deposit], type: { Name: 'Planned mine', Cost: 1, CargoPoints: 1, Workers: workers, Mining: weight, eligibility: [] }, count, basis: { speed: 1, drive: 'drive', cargo: 1 }, sources: { jumpPoints: [], lagrangePoints: [], classes: [], colonies: [], projects: [], problems: [], race: { MineProduction: 100 } } })
        assert.equal(site.extraction.value, whole * 100, `${workers ? 'manned' : 'automated'} ${weight} x ${count}`)
      }
    }
  })
  test('labels: the eight repaired rules support the line, while summary stays retained', () => {
    for (const id of ['cmcPolicy.throughput', 'logistics.refineryOutput', 'minerals.massDriverRate', 'warnings.massDriverOrphans', 'warnings.miningRedeployment', 'warnings.strandedMiners', 'warnings.undermannedShips', 'warnings.wastedMiningCapacity']) assert.deepEqual(m.provenance.getRule(id).versions, ['3.2.x'], id)
    assert.deepEqual(m.provenance.getRule('warnings.summary').versions, ['2.7.x'])
  })
}

// Literal faults target changed decisions only. Invalid anchors, parse errors and thrown non-assertion failures never count as a caught arithmetic fault.
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'fractional driver capacity', file: 'minerals', from: 'value: count * MASS_DRIVER_TONS', to: 'value: drivers * MASS_DRIVER_TONS', group: 'rates:' },
  { name: 'fractional refinery capacity', file: 'logistics', from: 'value: refineries * colony.FuelProduction', to: 'value: colony.Refineries * colony.FuelProduction', group: 'rates:' },
  { name: 'sub-tonne stock discarded', file: 'logistics', from: 'colony.Sorium > 0 ? output', to: 'colony.Sorium >= 1 ? output', group: 'rates:' },
  { name: 'fractional mining categories produce', file: 'mining-sites', from: 'positive(known(sum) ? wholeCapacity(sum, terms) : sum, gaps)', to: 'positive(sum, gaps)', group: 'warnings:' },
  { name: 'coordinate edge included', file: 'mining-data', from: 'abs(${a} - ${b}) < 1', to: 'abs(${a} - ${b}) <= 1', group: 'location:' },
  { name: 'cross-system coordinate colony excluded', file: 'mining-data', from: '${colony}.GameID = ${fleet}.GameID and ${colony}.RaceID', to: '${colony}.SystemID = ${fleet}.SystemID and ${colony}.GameID = ${fleet}.GameID and ${colony}.RaceID', group: 'location:' },
  { name: 'unknown location reuses saved orbit body', file: 'warnings/common', from: 'coalesce(VIR_Colony.SystemBodyID,', to: 'coalesce(FCT_Fleet.OrbitBodyID,', group: 'location:' },
  { name: 'ambiguous association is silently current', file: 'minerals', from: 'row.LocationUnknown ? null : row.Diameter', to: 'row.Diameter', group: 'location:' },
  { name: 'existing remote assignment ignored', file: 'mining-sites', from: "assignment !== 'colony' || assigned === colonyId ||", to: 'true ||', group: 'location:' },
  { name: 'civilian output skips local reserve', file: 'minerals', from: 'civilian - Math.min(civilian, Math.max(0, reserve - (stock + extraction - civilian)))', to: 'civilian', group: 'reserve:' },
  { name: 'other mining omitted from reserve', file: 'minerals', from: '(stock + extraction - civilian)', to: 'stock', group: 'reserve:' },
  { name: 'civilian shipment uses total output', file: 'cmc-policy', from: 'parts: { output, capacity, shipped }, compute: (values) => values', to: 'parts: { output, capacity, shipped }, compute: (values) => ({ ...values, shipped: values.output })', group: 'reserve:' },
  { name: 'replacement equality accepted', file: 'warnings/ships', from: 'compare(total.lo, million) > 0', to: 'compare(total.lo, million) >= 0', group: 'crew:' },
  { name: 'replacement ignores orbital residents', file: 'warnings/ships', from: 'const total = population && population.totalPopulation', to: 'const total = population && population.totalPopulation ? { ...population.totalPopulation, lo: fromString("0.9"), hi: fromString("0.9") } : null', group: 'crew:' },
  { name: 'missing coordinates silently excluded from numeric rates', file: 'mining-data', from: 'return possible ?', to: 'return false ?', group: 'unknown numeric:' },
  { name: 'missing coordinates silently excluded from CMC reserve allocation', file: 'mining-data', from: 'return possible ?', to: 'return false ?', group: 'unknown CMC:' },
  { name: 'missing coordinates silently excluded from warnings', file: 'mining-data', from: 'return possible ?', to: 'return false ?', group: 'unknown warnings:' },
  { name: 'binary weighted floor drops whole mining capacity', file: 'minerals', from: 'return toNumber(floor(total))', to: 'return Math.floor(capacity)', group: 'decimal numeric:' },
  { name: 'binary weighted floor drops whole refinery capacity', file: 'minerals', from: 'return toNumber(floor(total))', to: 'return Math.floor(capacity)', group: 'decimal refinery:' },
  { name: 'surface export restores binary capacity threshold', file: 'mining-data', from: 'const capacity = wholeCapacity(row.CivilianMineCount, row.CivilianMineTerms)', to: 'const capacity = Math.floor(JSON.parse(row.CivilianMineTerms).reduce((sum, term) => sum + (term ? Number(term[0]) * Number(term[1]) : 0), 0))', group: 'decimal export:' },
  { name: 'orbital export restores binary capacity threshold', file: 'mining-data', from: 'const capacity = wholeCapacity(row.CivilianMineCount, row.CivilianMineTerms)', to: 'const capacity = Math.floor(JSON.parse(row.CivilianMineTerms).reduce((sum, term) => sum + (term ? Number(term[0]) * Number(term[1]) : 0), 0))', group: 'decimal orbital export:' },
  { name: 'unknown export is silently false', file: 'mining-data', from: '? 1 : null', to: '? 1 : 0', group: 'unknown export:' },
  { name: 'driver rate restores binary floor', file: 'minerals', from: 'const count = wholeCapacity(drivers, terms)', to: 'const count = Math.floor(drivers)', group: 'decimal drivers:' },
  { name: 'policy driver presence restores binary threshold', file: 'cmc-policy', from: 'value: count >= 1', to: 'value: drivers >= 1', group: 'decimal drivers:' },
  { name: 'warning source restores binary floor', file: 'mining-sites', from: 'productive(row.Drivers, row.DriverGaps, row.DriverTerms)', to: 'productive(Math.floor(row.Drivers), row.DriverGaps)', group: 'decimal drivers:' },
  { name: 'warning receiver restores binary floor', file: 'mining-sites', from: 'productive(row.DestinationDrivers, row.DestinationGaps, row.DestinationDriverTerms)', to: 'productive(Math.floor(row.DestinationDrivers), row.DestinationGaps)', group: 'decimal drivers:' },
  { name: 'supply driver presence restores binary threshold', file: 'mineral-supply', from: '? count >= 1 : null', to: '? drivers >= 1 : null', group: 'decimal drivers:' },
  { name: 'MSP driver acquisition restores binary floor', file: 'msp-supply', from: 'wholeCapacity(row.Drivers ?? 0, row.DriverTerms)', to: 'Math.floor(row.Drivers ?? 0)', group: 'decimal drivers:' },
  { name: 'policy complex count restores binary floor', file: 'cmc-policy', from: 'whole(row.Complexes, row.ComplexesTerms)', to: 'Math.floor(row.Complexes)', group: 'decimal complexes:' },
  { name: 'summary complex count restores binary floor', file: 'cmc-summary', from: 'whole(Math.max(0, colony.Complexes), colony.ComplexesTerms)', to: 'Math.floor(Math.max(0, colony.Complexes))', group: 'decimal complexes:' },
  { name: 'Minerals stock export restores binary threshold', page: 'minerals', from: 'stockExporting(colony)', to: 'Math.floor(colony.MassDrivers) > 0 && colony.MassDriverDest > 0', group: 'decimal pages:' },
  { name: 'Hauling stock export restores binary threshold', page: 'hauling', from: 'stockExporting(colony)', to: 'Math.floor(colony.MassDrivers) > 0 && colony.MassDriverDest > 0', group: 'decimal pages:' },
  { name: 'Hauling fractional driver ships stock', page: 'hauling', from: 'stockExporting(colony)', to: 'colony.MassDrivers > 0 && colony.MassDriverDest > 0', group: 'decimal pages:' },
  { name: 'Minerals fractional driver ships stock', page: 'minerals', from: 'stockExporting(colony)', to: 'colony.MassDrivers > 0 && colony.MassDriverDest > 0', group: 'decimal pages:' },
  { name: 'MSP driver acquisition restores epsilon floor', file: 'msp-supply', from: 'wholeCapacity(row.Drivers ?? 0, row.DriverTerms)', to: 'Math.floor((row.Drivers ?? 0) + 1e-9)', group: 'decimal drivers:' },
  { name: 'summary complex count restores epsilon floor', file: 'cmc-summary', from: 'whole(Math.max(0, colony.Complexes), colony.ComplexesTerms)', to: 'Math.floor(Math.max(0, colony.Complexes) + 1e-9)', group: 'decimal complexes:' },
  { name: 'planned CMC capacity restores binary threshold', file: 'cmc-candidates', from: 'CivilianMineTerms: JSON.stringify([[values.complexes, values.complexMining]])', to: 'CivilianMineTerms: JSON.stringify([[Math.floor(values.complexes * values.complexMining), 1]])', group: 'decimal planned:' },
  { name: 'planned manned capacity restores binary threshold', file: 'deficit-sites', from: 'ManualMineTerms: manned ? JSON.stringify([[count, type.Mining]]) : null', to: 'ManualMineTerms: manned ? JSON.stringify([[Math.floor(count * type.Mining), 1]]) : null', group: 'decimal planned:' },
  { name: 'planned automated capacity restores binary threshold', file: 'deficit-sites', from: 'AutomatedMineTerms: manned ? null : JSON.stringify([[count, type.Mining]])', to: 'AutomatedMineTerms: manned ? null : JSON.stringify([[Math.floor(count * type.Mining), 1]])', group: 'decimal planned:' },
  { name: 'planned CMC capacity loses separate terms', file: 'cmc-candidates', from: 'CivilianMineTerms: JSON.stringify([[values.complexes, values.complexMining]])', to: 'CivilianMineTerms: null', group: 'decimal planned:' },
  { name: 'planned manned capacity loses separate terms', file: 'deficit-sites', from: 'ManualMineTerms: manned ? JSON.stringify([[count, type.Mining]]) : null', to: 'ManualMineTerms: null', group: 'decimal planned:' },
  { name: 'planned automated capacity loses separate terms', file: 'deficit-sites', from: 'AutomatedMineTerms: manned ? null : JSON.stringify([[count, type.Mining]])', to: 'AutomatedMineTerms: null', group: 'decimal planned:' },
  { name: 'unknown export route suppresses aggregate supply', file: 'mineral-supply', from: "if (civilian === null && reach !== false) return unavailable({ rule: 'mineralSupply.route'", to: "if (false) return unavailable({ rule: 'mineralSupply.route'", group: 'unknown export:' },
  { name: 'unknown route loses its known potential destination', file: 'mineral-supply', from: 'const destinationId = routed ? routed.destinationId : reach === true ? colony.MassDriverDest : null', to: 'const destinationId = routed ? routed.destinationId : null', group: 'unknown export:' },
  { name: 'Minerals coerces unknown stock export to false', page: 'minerals', from: 'stockExporting(colony)', to: 'stockExporting(colony) === true', group: 'unread stock drivers:' },
  { name: 'Hauling coerces unknown stock export to false', page: 'hauling', from: 'stockExporting(colony)', to: 'stockExporting(colony) === true', group: 'unread stock drivers:' },
  { name: 'stock state ignores unknown export', file: 'colony-minerals', from: 'exporting !== false', to: 'exporting', group: 'unread stock drivers:' },
  { name: 'Minerals drops unread installation types', page: 'minerals', from: 'from FCT_PopulationInstallations left join DIM_PlanetaryInstallation', to: 'from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation', group: 'unread stock drivers:' },
  { name: 'Hauling drops unread driver amounts', page: 'hauling', from: 'group by FCT_PopulationInstallations.PopID', to: 'and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID', group: 'unread stock drivers:' },
  { name: 'Hauling drops unread driver types', page: 'hauling', from: 'from FCT_PopulationInstallations left join DIM_PlanetaryInstallation', to: 'from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation', group: 'unread stock drivers:' },
  { name: 'Logistics drops unknown refinery membership', page: 'logistics', from: 'wholeCapacity(colony.Refineries, colony.RefineriesTerms) !== 0', to: 'wholeCapacity(colony.Refineries, colony.RefineriesTerms) >= 1', group: 'unread refineries:' },
  { name: 'Logistics drops unread refinery amounts', page: 'logistics', from: '(FCT_PopulationInstallations.Amount > 0 or FCT_PopulationInstallations.Amount is null)', to: 'FCT_PopulationInstallations.Amount > 0', group: 'unread refineries:' },
  { name: 'Logistics drops unread refinery types', page: 'logistics', from: 'from FCT_PopulationInstallations left join DIM_PlanetaryInstallation', to: 'from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation', group: 'unread refineries:' },
  { name: 'feed drops unread refinery amounts', file: 'resource-feeds', from: 'group by FCT_PopulationInstallations.PopID', to: 'and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PopID', group: 'unread refineries:' },
  { name: 'feed drops unread refinery types', file: 'resource-feeds', from: 'from FCT_PopulationInstallations left join DIM_PlanetaryInstallation', to: 'from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation', group: 'unread refineries:' },
  { name: 'refinery display sum coalesces unread inputs to zero', file: 'mining-data', from: 'then null else coalesce(sum(case when', to: 'then 0 else coalesce(sum(case when', group: 'unread refineries:' },
  { name: 'policy drops unread civilian weight', file: 'cmc-policy', from: '(DIM_PlanetaryInstallation.MiningProductionValue > 0) is not 0', to: 'DIM_PlanetaryInstallation.MiningProductionValue > 0', group: 'unread civilian policy:' },
  { name: 'policy drops unread civilian flag', file: 'cmc-policy', from: '(DIM_PlanetaryInstallation.CivilianInstallation = 1) is not 0', to: 'DIM_PlanetaryInstallation.CivilianInstallation = 1', group: 'unread civilian policy:' },
  { name: 'policy drops unread civilian types', file: 'cmc-policy', from: 'from FCT_PopulationInstallations left join DIM_PlanetaryInstallation', to: 'from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation', group: 'unread civilian policy:' },
  { name: 'summary drops unread civilian types', page: 'minerals', from: 'from FCT_PopulationInstallations left join DIM_PlanetaryInstallation', to: 'from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation', group: 'unread civilian policy:' },
  { name: 'MSP drops unread driver types', file: 'msp-supply', from: 'from FCT_PopulationInstallations left join DIM_PlanetaryInstallation', to: 'from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation', group: 'unread sibling acquisitions:' },
  { name: 'fuel site coalesces unread refinery amount to zero', file: 'fuel-ledger', from: "${capacitySum('1', 'DIM_PlanetaryInstallation.RefineryProductionValue > 0')}", to: 'coalesce(sum(case when DIM_PlanetaryInstallation.RefineryProductionValue > 0 then FCT_PopulationInstallations.Amount else 0 end), 0)', group: 'unread sibling acquisitions:' },
  { name: 'policy drops unread civilian surface production', file: 'cmc-policy', from: 'whole(row.CivilianMineCount, row.CivilianMineTerms) !== 0', to: 'row.CivilianMineCount > 0', group: 'unread civilian policy:' },
  { name: 'legacy loses decisive zero amount at an unread refinery type', file: 'legacy-consumption', from: 'FCT_PopulationInstallations.Amount is not 0 and (DIM_PlanetaryInstallation.${value} is null', to: '(DIM_PlanetaryInstallation.${value} is null', group: 'unread refineries:' },
]
/* eslint-enable no-template-curly-in-string */

const main = async () => {
  const args = process.argv.slice(2)
  const faultAt = args.indexOf('--fault')
  const fault = faultAt < 0 ? null : FAULTS[Number(args[faultAt + 1])]
  if (faultAt >= 0 && !fault) throw new Error('unknown fault index')
  const sources = {}
  const pageSources = {}
  if (fault) {
    const file = path.join(root, 'src', 'renderer', fault.page ? 'pages' : 'utilities', fault.page ? `${fault.page}.vue` : `${fault.file}.js`)
    const source = plantedPatch(file, fs.readFileSync(file, 'utf8'), fault.from, fault.to)
    if (fault.page) pageSources[`pages/${fault.page}`] = source
    else sources[fault.file] = source
  }
  const names = ['minerals', 'logistics', 'mining-sites', 'mining-data', 'mineral-outlook', 'mineral-supply', 'cmc-policy', 'cmc-summary', 'cmc-candidates', 'deficit-sites', 'msp-supply', 'warnings/common', 'warnings/colonies', 'warnings/fleets', 'warnings/ships', 'provenance', 'legacy-consumption', 'empire-logistics', 'resource-feeds', 'fuel-ledger']
  const m = await loadUtilities(names, { sources, stubs: STUBS })
  const pages = {}
  const pageOf = (name) => (pages[name] = pages[name] || loadPage(`pages/${name}`, { modules: { 'components/charts/theme': 'export const chartTheme = () => ({}); export const withAlpha = (color) => color; export const flowColor = () => ""; export const chartFont = () => ({}); export const seriesIdentity = () => ({})' }, stubs: { ...STUBS, 'lodash/groupBy': 'export default (items, by) => items.reduce((groups, item) => { (groups[item[by]] = groups[item[by]] || []).push(item); return groups }, {})' }, sources: { ...Object.fromEntries(Object.entries(sources).map(([name, source]) => [`utilities/${name}`, source])), ...pageSources } }))
  define(m, pageOf)
  let failures = 0
  let count = 0
  for (const { name, run } of tests.filter((test) => !fault || test.name.startsWith(fault.group))) {
    count++
    try { await run(); console.log(`PASS  ${name}`) } catch (error) {
      if (error.name !== 'AssertionError') throw error
      failures++
      console.log(`FAIL  ${name}: ${error.message}`)
    }
  }
  if (!fault && mutating()) {
    for (const [index, fault] of FAULTS.entries()) {
      const result = await runChild(__filename, ['--fault', String(index)])
      const caught = result.code === 1 && result.stdout.includes(`FAIL  ${fault.group}`)
      count++
      if (!caught) failures++
      console.log(`${caught ? 'PASS' : 'FAIL'}  mutation: ${fault.name}${caught ? '' : `: ${result.stdout} ${result.stderr}`}`)
    }
  }
  console.log(`${count - failures} of ${count} checks passed`)
  process.exitCode = failures ? 1 : 0
}
main().catch((error) => { console.error(error); process.exitCode = 2 })
