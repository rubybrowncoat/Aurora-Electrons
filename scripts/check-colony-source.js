/* eslint-disable no-template-curly-in-string */
// Arithmetic from the game's rules at the public Colony Outlook seams. The game's growth rules supply the worked growth figures; no expected value is calculated by the implementation under test.
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { loadPage, instantiate } = require('./lib/page-loader')
const { fixtureSave } = require('./lib/fixtures')

const STUBS = { dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs', 'dayjs/plugin/utc.js': 'export default {}', romanum: 'export default { toNumeral: String }', 'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])', 'lodash/groupBy': 'export default (list, key) => list.reduce((groups, row) => { (groups[row[key]] ||= []).push(row); return groups }, {})' }
const STORE = { getters: { 'capabilities/blockedBonuses': new Set(), 'capabilities/report': () => null }, state: { RaceNPR: false }, dispatch: async () => {} }
const pageFor = (sources = {}) => loadPage('pages/colony-outlook', { stubs: STUBS, modules: { 'components/charts/theme': 'export const chartTheme = () => ({ categorical: [], ink: \'\', inkMuted: \'\', primary: \'\' }); export const withAlpha = (color) => color; export const patternImage = () => null; export const seriesIdentity = () => null' }, sources: Object.fromEntries(Object.entries(sources).map(([name, text]) => [name === 'page' ? 'pages/colony-outlook' : `utilities/${name}`, text])) })

const root = path.resolve(__dirname, '..')
const near = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
const colony = (over = {}) => ({ PopulationID: 1, PopName: 'Source case', SystemBodyID: 1, Population: 8, BodyPopulation: 8, CurrentColonyCost: 0, MaximumColonyCost: 0, PopulationGrowthBonus: 1, PopulationGrowthModifier: 1, PopulationDensityModifier: 1, RadiationLevel: 0, Radius: 6400, HydroExt: 20, TidalLock: 0, BodyClass: 1, LowGravity: 0, Infrastructure: 0, LGInfrastructure: 0, ReqInf: 0, InstallationWorkers: 0, YardWorkers: 0, OrbitalPopulation: 0, ...over })

// Real page SQL over a read-only save; temporary tables hold the counterexamples without changing the fixture.
const withSnapshot = async (sources, run) => {
  const save = fixtureSave()
  const raw = await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(path.resolve(root, save.file), sqlite3.OPEN_READONLY, (error) => error ? reject(error) : resolve(database))
  })
  const database = { query: (sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => error ? reject(error) : resolve([rows]))) }
  const execute = (sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => error ? reject(error) : resolve()))

  try {
    const [[seed]] = await database.query(`select PopulationID, SystemBodyID from FCT_Population where GameID = ${save.game} and RaceID = ${save.race} and Population > 0 order by PopulationID limit 1`)
    assert.ok(seed, 'the read-only fixture must contain a populated colony')
    const vm = instantiate(await pageFor(sources), { $store: STORE, database, GameID: save.game, RaceID: save.race })

    await run({ database, execute, vm, seed, save })
  } finally {
    await new Promise((resolve, reject) => raw.close((error) => error ? reject(error) : resolve()))
  }
}

const withArkSnapshot = (sources, run) => withSnapshot(sources, async (context) => {
  const { execute, seed, save } = context

  await execute(`create temp table FCT_Population as select * from main.FCT_Population where PopulationID = ${seed.PopulationID}; update FCT_Population set PopulationID = 1, SystemBodyID = 1, Population = 100; insert into FCT_Population select * from FCT_Population; update FCT_Population set PopulationID = 2, SystemBodyID = 2, SystemID = -99 where rowid = 2; create temp table FCT_SystemBody as select * from main.FCT_SystemBody where SystemBodyID = ${seed.SystemBodyID}; update FCT_SystemBody set SystemBodyID = 1, Xcor = 0, Ycor = 0; insert into FCT_SystemBody select * from FCT_SystemBody; update FCT_SystemBody set SystemBodyID = 2, SystemID = -99 where rowid = 2; create temp table FCT_Fleet as select * from main.FCT_Fleet limit 1; update FCT_Fleet set FleetID = 1, GameID = ${save.game}, RaceID = ${save.race}, SystemID = -88, Xcor = 0, Ycor = 0, AssignedPopulationID = 0, CivilianFunction = 0; create temp table FCT_Ship as select * from main.FCT_Ship limit 1; update FCT_Ship set ShipID = 1, GameID = ${save.game}, RaceID = ${save.race}, ShipClassID = 1, FleetID = 1; create temp table FCT_ShipClass as select * from main.FCT_ShipClass limit 1; update FCT_ShipClass set ShipClassID = 1, ArkShip = 1; create temp table FCT_ClassComponent as select * from main.FCT_ClassComponent where 0; insert into FCT_ClassComponent (ClassID, ComponentID, NumComponent) values (1, 1, 1); create temp table FCT_ShipDesignComponents as select * from main.FCT_ShipDesignComponents limit 1; update FCT_ShipDesignComponents set SDComponentID = 1, ComponentTypeID = 17, SpecialFunction = 7, ComponentValue = 100000000; create temp table FCT_DamagedComponent as select * from main.FCT_DamagedComponent where 0; create temp table FCT_MoveOrders as select * from main.FCT_MoveOrders where 0; create temp table FCT_ShipCargo as select * from main.FCT_ShipCargo where 0; insert into FCT_ShipCargo (GameID, ShipID, CargoTypeID, SpeciesID, Amount) select ${save.game}, 1, 1, SpeciesID, 100000000 from main.FCT_Species where GameID = ${save.game} limit 1`)

  await run(context)
})

const readArks = async (a, database, save) => {
  const loaded = await a.loadArks(database, { GameID: save.game, RaceID: save.race })

  return { loaded, layer: a.arkLayer(loaded) }
}

const CASES = [
  {
    id: 'ark-membership',
    run: async ({ arks: a, 'colony-environment': environment }, sources) => {
      await withArkSnapshot(sources, async ({ database, execute, save }) => {
        const read = async () => {
          const loaded = await a.loadArks(database, { GameID: save.game, RaceID: save.race })
          const layer = a.arkLayer(loaded)

          return { loaded, layer, people: loaded.colonies.map((row) => environment.orbitalPopulationResult(layer, row)) }
        }
        const occupied = (result) => result.people.map((value) => value.value)
        const cross = await read()

        assert.deepEqual(occupied(cross), [100, 100], 'cross-system coincident bodies each count the saved fleet')
        assert.deepEqual(cross.layer.bodies.map((body) => body.occupied.value), [100, 100])
        assert.deepEqual(cross.layer.bodies.map((body) => body.species.value[0].amount), [100, 100])
        near(cross.layer.totals.occupied.value, 100)
        near(cross.layer.totals.empty.value, 0)
        assert.equal(cross.layer.ships.length, 1, 'grand inventory counts the ship once')
        await execute('update FCT_Fleet set AssignedPopulationID = 1')
        assert.deepEqual(occupied(await read()), [100, 100], 'an assignment on another body does not hold the fleet away')
        await execute('update FCT_Population set SystemBodyID = 1 where PopulationID = 2')
        assert.deepEqual(occupied(await read()), [100, 0], 'another colony on the same body holds its assignment')
        await execute('update FCT_Fleet set AssignedPopulationID = null')
        assert.ok((await read()).people.every((result) => result.status === 'unavailable'), 'unknown assignment is not explicit zero')
        await execute('update FCT_Fleet set AssignedPopulationID = 0')
        const alternatives = await read()

        assert.ok(alternatives.people.every((result) => result.status === 'unavailable'), 'several receiving colonies retain attribution alternatives')
        assert.equal(alternatives.layer.bodies.length, 1)
        near(alternatives.layer.bodies[0].occupied.value, 100)
        near(alternatives.layer.bodies[0].species.value[0].amount, 100)
        near(alternatives.layer.totals.occupied.value, 100)
        await execute('update FCT_Fleet set Xcor = 1')
        assert.deepEqual(occupied(await read()), [0, 0], 'the tolerance is strict')
        await execute('update FCT_Population set SystemBodyID = 2 where PopulationID = 2')
        await execute('update FCT_Fleet set Xcor = 0.999, Ycor = -0.999')
        assert.deepEqual(occupied(await read()), [100, 100])
        for (const setting of ['CivilianFunction = 1', 'CivilianFunction = 0, Xcor = 50']) {
          await execute(`update FCT_Fleet set ${setting}`)
          assert.deepEqual(occupied(await read()), [0, 0], 'known exclusions do not require other inputs')
        }
        await execute('update FCT_Fleet set CivilianFunction = 0, Xcor = 0, Ycor = 0; insert into FCT_MoveOrders (GameID, FleetID) values (' + save.game + ', 1)')
        assert.deepEqual(occupied(await read()), [0, 0], 'move orders exclude the fleet')
        await execute(`delete from FCT_MoveOrders; update FCT_Fleet set RaceID = ${save.race + 1}`)
        assert.deepEqual(occupied(await read()), [0, 0], 'another race fleet is not orbital population of these colonies')
        await execute(`update FCT_Fleet set RaceID = ${save.race}; update FCT_ShipClass set ArkShip = 0`)
        assert.deepEqual(occupied(await read()), [0, 0], 'a non-Ark ship is excluded')
        await execute('update FCT_ShipClass set ArkShip = 1')
        await execute('delete from FCT_MoveOrders; update FCT_ShipCargo set CargoTypeID = null')
        const unread = await read()

        assert.equal(unread.loaded.cargo.length, 1, 'the real cargo SQL preserves unknown categories')
        assert.ok(unread.people.every((result) => result.status === 'unavailable'))
        assert.equal(unread.layer.totals.occupied.status, 'unavailable')
        assert.equal(unread.layer.bodies[0].species.status, 'unavailable')
        await execute('update FCT_ShipCargo set Amount = 0')
        assert.deepEqual(occupied(await read()), [0, 0], 'known zero is zero even with unknown category')
        await execute('update FCT_ShipCargo set Amount = 100000000, CargoTypeID = 2')
        assert.deepEqual(occupied(await read()), [0, 0], 'known non-colonist cargo is excluded')
        await execute('update FCT_ShipCargo set CargoTypeID = 1; update FCT_Population set SystemBodyID = 2 where PopulationID = 2; update FCT_SystemBody set Xcor = 100 where SystemBodyID = 2; update FCT_Fleet set AssignedPopulationID = null')
        assert.deepEqual(occupied(await read()), [100, 0], 'unknown assignment cannot change a unique-body membership or a coordinate exclusion')
        await execute(`insert into FCT_Population select * from FCT_Population where PopulationID = 1; update FCT_Population set PopulationID = 3, RaceID = ${save.race + 1} where rowid = (select max(rowid) from FCT_Population); update FCT_Fleet set AssignedPopulationID = 3`)
        assert.deepEqual(occupied(await read()), [0, 0], 'an assignment to another race colony on this body holds the fleet there')
        await execute('update FCT_Fleet set AssignedPopulationID = null')
        assert.equal((await read()).people[0].status, 'unavailable', 'unknown assignment can mean a foreign same-body hold, unlike explicit zero')
        await execute('update FCT_Fleet set AssignedPopulationID = 0')
        assert.deepEqual(occupied(await read()), [100, 0], 'explicit unassigned permits the sole own colony to receive the fleet')
        await execute('update FCT_Fleet set AssignedPopulationID = 3; update FCT_Population set SystemBodyID = 2 where PopulationID = 3')
        assert.deepEqual(occupied(await read()), [100, 0], 'an assignment to a foreign colony on another body permits reassignment')
      })
    },
  },
  {
    id: 'ark-absent-assignment',
    run: async ({ arks: a, 'colony-environment': environment }, sources) => {
      await withArkSnapshot(sources, async ({ database, execute, save }) => {
        await execute('update FCT_Fleet set AssignedPopulationID = 999; update FCT_SystemBody set Xcor = 100 where SystemBodyID = 2')
        const absent = await readArks(a, database, save)

        assert.ok(!absent.loaded.assignments.some((row) => row.PopulationID === 999), 'the complete real-query roster proves the target absent')
        near(environment.orbitalPopulationResult(absent.layer, absent.loaded.colonies[0]).value, 100)
        near(absent.layer.byPopulation[1].occupied.value, 100)
        near(absent.layer.bodies[0].occupied.value, 100)
        near(absent.layer.totals.occupied.value, 100)
        near(absent.layer.totals.empty.value, 0)
        await execute(`insert into FCT_Population select * from FCT_Population where PopulationID = 1; update FCT_Population set PopulationID = 3, RaceID = ${save.race + 1}, SystemBodyID = null where rowid = (select max(rowid) from FCT_Population); update FCT_Fleet set AssignedPopulationID = 3`)
        const unreadBody = await readArks(a, database, save)

        assert.equal(environment.orbitalPopulationResult(unreadBody.layer, unreadBody.loaded.colonies[0]).status, 'unavailable', 'a present target with an unread body is not a proven absent target')
        await execute('update FCT_Population set SystemBodyID = 1 where PopulationID = 3')
        near((await readArks(a, database, save)).layer.byPopulation[1].occupied.value, 0, 'a present foreign same-body assignment still holds the fleet')
        await execute('update FCT_Fleet set AssignedPopulationID = 999; update FCT_Population set SystemBodyID = 1 where PopulationID = 2')
        const alternatives = await readArks(a, database, save)

        assert.equal(alternatives.layer.byPopulation[1].occupied.status, 'unavailable', 'an absent target permits reassignment, not an invented same-body winner')
        near(alternatives.layer.totals.occupied.value, 100)
      })
    },
  },
  {
    id: 'ark-zero-attribution',
    run: async ({ arks: a, 'colony-environment': environment }, sources) => {
      await withArkSnapshot(sources, async ({ database, execute, save }) => {
        await execute('update FCT_Population set SystemBodyID = 1 where PopulationID = 2; delete from FCT_ShipCargo')
        const empty = await readArks(a, database, save)

        assert.ok(Object.values(empty.layer.ships[0].memberships).every((result) => result.status === 'unavailable'), 'zero people do not decide membership')
        for (const row of empty.loaded.colonies) {
          near(empty.layer.byPopulation[row.PopulationID].occupied.value, 0)
          near(environment.orbitalPopulationResult(empty.layer, row).value, 0)
          assert.equal(empty.layer.byPopulation[row.PopulationID].empty.status, 'unavailable', 'nonzero empty berths still depend on attribution')
        }
        const page = await pageFor(sources)
        const rows = instantiate(page, { $store: STORE, data: { colonies: empty.loaded.colonies.map((row) => colony({ ...row, BodyPopulation: 200 })), arks: empty.loaded } }).rows

        rows.forEach((row) => {
          near(row.OrbitalPopulation, 0)
          assert.ok(row.workersNow !== null, 'the real-query empty Ark must not suppress outlook workers')
          near(row.workersNow.available, 38.76586748096509)
          assert.ok(row.workersLater !== null, 'the zero contribution also preserves horizon workers')
        })
        await execute(`insert into FCT_Population select * from FCT_Population where PopulationID = 1; update FCT_Population set PopulationID = 3, RaceID = ${save.race + 1} where rowid = (select max(rowid) from FCT_Population); update FCT_Fleet set AssignedPopulationID = null`)
        const unplacedEmpty = await readArks(a, database, save)

        assert.equal(unplacedEmpty.layer.ships[0].results.orbit.status, 'unavailable')
        near(unplacedEmpty.layer.bodies[0].occupied.value, 0)
        assert.deepEqual(unplacedEmpty.layer.bodies[0].species.value, [], 'no occupants contribute no species under every body attribution')
        near(unplacedEmpty.layer.totals.occupied.value, 0)
        assert.equal(unplacedEmpty.layer.totals.empty.status, 'unavailable')
        await execute('update FCT_Fleet set AssignedPopulationID = 0')
        await execute(`insert into FCT_Fleet select * from FCT_Fleet; update FCT_Fleet set FleetID = 2, AssignedPopulationID = 1 where rowid = (select max(rowid) from FCT_Fleet); insert into FCT_Ship select * from FCT_Ship; update FCT_Ship set ShipID = 2, FleetID = 2 where rowid = (select max(rowid) from FCT_Ship); insert into FCT_ShipCargo (GameID, ShipID, CargoTypeID, SpeciesID, Amount) select ${save.game}, 2, 1, SpeciesID, 50000000 from main.FCT_Species where GameID = ${save.game} limit 1`)
        const mixed = await readArks(a, database, save)

        near(environment.orbitalPopulationResult(mixed.layer, mixed.loaded.colonies[0]).value, 50, 'an attribution-uncertain zero must not poison another ship\'s positive contribution')
        near(environment.orbitalPopulationResult(mixed.layer, mixed.loaded.colonies[1]).value, 0)
      })
    },
  },
  {
    id: 'ark-correlated-assignment',
    run: async ({ arks: a, 'colony-environment': environment }, sources) => {
      await withArkSnapshot(sources, async ({ database, execute, save }) => {
        await execute(`update FCT_Fleet set AssignedPopulationID = null; insert into FCT_Population select * from FCT_Population where PopulationID = 1; update FCT_Population set PopulationID = 3, RaceID = ${save.race + 1} where rowid = (select max(rowid) from FCT_Population); insert into FCT_Population select * from FCT_Population where PopulationID = 2; update FCT_Population set PopulationID = 4, RaceID = ${save.race + 1} where rowid = (select max(rowid) from FCT_Population)`)
        const correlated = await readArks(a, database, save)

        assert.ok(correlated.loaded.colonies.every((row) => environment.orbitalPopulationResult(correlated.layer, row).status === 'unavailable'))
        assert.ok(correlated.layer.bodies.every((body) => body.occupied.status === 'unavailable'), 'each body can be excluded by its foreign same-body hold')
        near(correlated.layer.totals.occupied.value, 100, 'one shared assignment cannot exclude both coincident bodies')
        near(correlated.layer.totals.empty.value, 0)
        assert.equal(correlated.layer.totals.unknown, 0)
        assert.equal(correlated.layer.unplaced.length, 0)
        const page = instantiate(await pageFor(sources), { $store: STORE })

        assert.equal(page.orbitText(correlated.layer.ships[0]), 'At a colony body; body attribution unresolved')
        await execute('update FCT_SystemBody set Xcor = 100 where SystemBodyID = 2')
        const varying = await readArks(a, database, save)

        assert.equal(varying.layer.totals.occupied.status, 'unavailable', 'a single possible body with a foreign hold really can lose the ship')
        near(varying.layer.totals.empty.value, 0, 'an unknown inclusion still cannot change a known zero contribution')
        assert.equal(varying.layer.totals.unknown, 1)
      })
    },
  },
  {
    id: 'ark-scope',
    run: async (_apps, sources) => {
      const page = await pageFor(sources)
      const colonies = [colony({ PopulationID: 1, SystemBodyID: 1, Population: 100, BodyPopulation: 100 }), colony({ PopulationID: 2, SystemBodyID: 2, Population: 100, BodyPopulation: 100 })]
      const locations = colonies.map((row, index) => ({ ...row, SystemID: 1, Xcor: index * 100, Ycor: 0 }))
      const rows = (over) => instantiate(page, { $store: STORE, data: { colonies, arks: { colonies: locations, assignments: locations, cargo: [{ ShipID: 1, CargoTypeID: 1, Amount: 100000000, Rows: 1, Amounts: 1, SpeciesID: 1, SpeciesName: 'Residents' }], ships: [{ ShipID: 1, AssignedPopulationID: 1, OrbitBodyID: 1, SystemID: 1, Xcor: 0, Ycor: 0, CivilianFunction: 0, MoveOrders: 0, Berths: null, ...over }] } } }).rows

      // Known exclusions do not need berth capacity, even if the ship holds colonists.
      for (const excluded of [{ MoveOrders: 1 }, { CivilianFunction: 1 }, { Xcor: 50 }]) {
        rows(excluded).forEach((row) => {
          assert.ok(row.workersNow !== null, 'an excluded Ark must not suppress current workers')
          near(row.OrbitalPopulation, 0)
          near(row.workersNow.available, 38.76586748096509)
          assert.ok(row.workersLater !== null, 'an excluded Ark must not suppress horizon workers')
        })
      }
      const counted = rows({})

      assert.strictEqual(counted[0].workersNow, null, 'unknown capacity is required at the colony that counts the ship')
      assert.ok(counted[1].workersNow !== null, 'unknown capacity is irrelevant to a different colony')
      near(counted[1].OrbitalPopulation, 0)
      const ambiguous = rows({ AssignedPopulationID: 0, Xcor: null })

      assert.ok(ambiguous.every((row) => row.workersNow === null), 'unresolved membership must not silently become zero')
    },
  },
  {
    id: 'all-race-crowding',
    run: async ({ colonies: c, provenance: p }, sources) => {
      await withSnapshot(sources, async ({ execute, vm, seed, save }) => {
        await execute(`create temp table FCT_Population as select * from main.FCT_Population; delete from FCT_Population where SystemBodyID = ${seed.SystemBodyID} and PopulationID <> ${seed.PopulationID}; update FCT_Population set Population = 8 where PopulationID = ${seed.PopulationID}; create temp table OtherRace as select * from FCT_Population where PopulationID = ${seed.PopulationID}; update OtherRace set PopulationID = -1, RaceID = -1; insert into FCT_Population select * from OtherRace; update OtherRace set PopulationID = -2, GameID = ${save.game + 1}, Population = 100; insert into FCT_Population select * from OtherRace`)
        const rows = await vm.runAsync('colonies')
        const own = rows.find((row) => row.PopulationID === seed.PopulationID)

        near(own.BodyPopulation, 16)
        const snapshot = colony({ ...own, CurrentColonyCost: 0, MaximumColonyCost: 0, PopulationGrowthModifier: 1, PopulationGrowthBonus: 1, RadiationLevel: 0 })

        near(c.growthRateResult(snapshot, p.ofRule({ rule: 'colonies.capacity', value: 24 })).value, 0.04999750012499375)
        near(c.projectBody([{ colony: snapshot, capacity: 24 }], 1 / 12)[0].final, 8.033331666749996)
        near(c.projectBody([{ colony: snapshot, capacity: 24 }], 2 / 12)[0].final, 8.066616592183738)
        const shared = c.projectBody([{ colony: { ...snapshot, BodyPopulation: 18 }, capacity: 24 }, { colony: { ...snapshot, PopulationID: 3, Population: 2, BodyPopulation: 18 }, capacity: 24 }], 1 / 12)

        near(shared[0].final, 8.024998750062496)
        near(shared[1].final, 2.006249687515624)
        const outlook = c.outlookColonies([snapshot], [], 1 / 12)[0]

        near(outlook.otherSeries[0], 8)
        near(outlook.otherSeries[1], 8)
        const missing = c.outlookColonies([{ ...snapshot, BodyPopulation: null }], [], 1)[0]

        assert.strictEqual(missing.results.projection.status, 'unavailable')
      })
    },
  },
  {
    id: 'null-body-census',
    run: async ({ colonies: c, provenance: p }, sources) => {
      await withSnapshot(sources, async ({ execute, vm, seed, save }) => {
        const phrase = 'the population of another colony on the body'
        const census = async () => (await vm.runAsync('colonies')).find((row) => row.PopulationID === seed.PopulationID)
        const snapshotOf = (own) => colony({ ...own, CurrentColonyCost: 0, MaximumColonyCost: 0, PopulationGrowthModifier: 1, PopulationGrowthBonus: 1, RadiationLevel: 0 })
        const capacity = p.ofRule({ rule: 'colonies.capacity', value: 24 })

        // Another race's colony on the body holds no stored population: the body's census is unknown, not the selected race's share of it.
        await execute(`create temp table FCT_Population as select * from main.FCT_Population; delete from FCT_Population where SystemBodyID = ${seed.SystemBodyID} and PopulationID <> ${seed.PopulationID}; update FCT_Population set Population = 8 where PopulationID = ${seed.PopulationID}; create temp table OtherRace as select * from FCT_Population where PopulationID = ${seed.PopulationID}; update OtherRace set PopulationID = -1, RaceID = -1, Population = null; insert into FCT_Population select * from OtherRace`)
        const unknown = await census()

        assert.strictEqual(unknown.BodyPopulation, null, 'an unknown population on the body must leave the body census unknown')
        const growth = c.growthRateResult(snapshotOf(unknown), capacity)
        const outlook = c.outlookColonies([snapshotOf(unknown)], [], 1 / 12)[0]

        assert.strictEqual(growth.status, 'unavailable', 'unknown body population must leave growth unavailable')
        assert.strictEqual(growth.value, null)
        assert.ok(growth.inputs.missing.includes(phrase), growth.inputs.missing.join(', '))
        assert.strictEqual(outlook.results.projection.status, 'unavailable')
        assert.strictEqual(outlook.results.projection.value, null)
        assert.ok(outlook.results.projection.inputs.missing.includes(phrase), outlook.results.projection.inputs.missing.join(', '))
        assert.strictEqual(outlook.results.fill.status, 'unavailable')
        assert.strictEqual(outlook.otherSeries, null)
        assert.strictEqual(c.projectBody([{ colony: snapshotOf(unknown), capacity: 24 }], 1 / 12), null, 'a direct horizon call must not take a share of a partial census')
        // A same-game zero and a different game's null row leave the same-game census known.
        await execute('update FCT_Population set Population = 0 where PopulationID = -1')
        const zero = await census()

        near(zero.BodyPopulation, 8)
        near(c.growthRateResult(snapshotOf(zero), capacity).value, 0.1)
        await execute(`update FCT_Population set Population = null, GameID = ${save.game + 1} where PopulationID = -1`)
        const otherGame = await census()

        near(otherGame.BodyPopulation, 8)
        near(c.growthRateResult(snapshotOf(otherGame), capacity).value, 0.1)
      })
    },
  },
  {
    id: 'infrastructure-balance',
    run: async ({ colonies: c }, sources) => {
      await withSnapshot(sources, async ({ database, execute, vm, seed, save }) => {
        const [[installation]] = await database.query('select PlanetaryInstallationID from DIM_PlanetaryInstallation where InfrastructureValue = 1 limit 1')
        assert.ok(installation, 'the read-only fixture must contain ordinary infrastructure')
        await execute(`create temp table DIM_PlanetaryInstallation as select * from main.DIM_PlanetaryInstallation; update DIM_PlanetaryInstallation set LGInfrastructureValue = 1 where PlanetaryInstallationID = ${installation.PlanetaryInstallationID}; create temp table FCT_PopulationInstallations as select * from main.FCT_PopulationInstallations where 0; insert into FCT_PopulationInstallations (GameID, PopID, PlanetaryInstallationID, Amount) values (${save.game}, ${seed.PopulationID}, ${installation.PlanetaryInstallationID}, 100); create temp table FCT_Ship as select * from main.FCT_Ship where 0; insert into FCT_Ship (ShipID, FleetID) values (-1, -1); create temp table FCT_MoveOrders as select * from main.FCT_MoveOrders where 0; insert into FCT_MoveOrders (GameID, RaceID, FleetID, PopulationID, MoveActionID) values (${save.game}, ${save.race}, -1, ${seed.PopulationID}, 96); create temp table FCT_ShipCargo as select * from main.FCT_ShipCargo where 0; insert into FCT_ShipCargo (ShipID, CargoTypeID, CargoID, Amount) values (-1, 2, ${installation.PlanetaryInstallationID}, 100)`)
        const built = (await vm.runAsync('colonies')).find((row) => row.PopulationID === seed.PopulationID)
        const inbound = await vm.runAsync('inbound')

        near(built.Infrastructure, 100)
        for (const LowGravity of [0, 1]) {
          const row = colony({ PopulationID: seed.PopulationID, Population: 1, BodyPopulation: 1, CurrentColonyCost: 2, MaximumColonyCost: 2, LowGravity, Infrastructure: built.Infrastructure, LGInfrastructure: 100 })
          const current = c.outlookColonies([row], [], 1 / 12)[0]

          near(current.results.growth.value, LowGravity ? -0.375 : -0.25)
          near(current.results.cap.value, LowGravity ? 0.25 : 0.5)
          near(current.results.projection.value.final, LowGravity ? 0.96875 : 0.9791666666666666)
          const arriving = c.outlookColonies([row], inbound, 1 / 12)[0]

          near(inbound[0].Infrastructure, 100)
          near(arriving.results.cap.value, LowGravity ? 0.5 : 1)
          near(arriving.results.projection.value.final, LowGravity ? 0.9791666666666666 : 1.0083333333333333)
          const absentUnusedColumn = c.outlookColonies([{ ...row, LGInfrastructure: null }], [], 1 / 12)[0]

          near(absentUnusedColumn.results.growth.value, current.results.growth.value)
          near(absentUnusedColumn.results.projection.value.final, current.results.projection.value.final)
        }
        await execute(`update DIM_PlanetaryInstallation set InfrastructureValue = 0 where PlanetaryInstallationID = ${installation.PlanetaryInstallationID}`)
        const unusedOnly = await vm.runAsync('inbound')

        near(unusedOnly[0].Infrastructure, 0)
        near(unusedOnly[0].Installations, 100)
      })
    },
  },
  {
    id: 'growth',
    run: ({ colonies: c }) => {
    // 10% base minus 2 percentage points, then (24 - 16)/(24 * .6667).
      near(c.growthRate(colony({ RadiationLevel: 800 }), 8, 16, 24), 0.039998000099995)
      near(c.growthRate(colony({ RadiationLevel: 8000 }), 8, 16, 24), -0.1)
      near(c.growthRate(colony({ RadiationLevel: 2 }), 8, 0, 24), 0.1)
      near(c.growthRate(colony({ RadiationLevel: 6 }), 8, 0, 24), 0.0998)
      near(c.growthRate(colony({ RadiationLevel: 400 }), 0, 0, 24), 0)
    },
  },
  {
    id: 'shortfall',
    run: ({ colonies: c }) => {
      near(c.growthRate(colony({ CurrentColonyCost: 2, Infrastructure: 800, RadiationLevel: 800, PopulationGrowthModifier: 10 }), 8, 16, 24), -0.27)
      near(c.growthRate(colony({ CurrentColonyCost: 2 }), 8, 16, 24), -0.5)
      near(c.growthRate(colony({ CurrentColonyCost: -1, RadiationLevel: 800 }), 8, 16, 0), -1)
      near(c.bodyCapacity(colony({ CurrentColonyCost: -1 })), 0)
    },
  },
  {
    // The game's geometry for the stated inputs: four times its pi (3.1416) times the radius squared over its Earth surface (511187128), times the baseline density (12,000) and the species density, the water factor above three quarters water (a hundredth at all water), a fifth on a tide-locked planet that is not a moon, and a floor of 50,000 people. The figures are the game's own arithmetic, not the helper's: Math.PI would give 12082.89909124985 for the first.
    id: 'capacity',
    run: ({ colonies: c }) => {
      const capacity = (over = {}) => c.bodyCapacity(colony(over))

      near(capacity(), 12082.927346323946)
      near(capacity({ HydroExt: 75 }), 12082.927346323946)
      near(capacity({ HydroExt: 90 }), 4833.170938529579)
      near(capacity({ HydroExt: 100 }), 120.82927346323946)
      near(capacity({ TidalLock: 1 }), 2416.585469264789)
      near(capacity({ TidalLock: 1, BodyClass: 2 }), 12082.927346323946)
      near(capacity({ PopulationDensityModifier: 2 }), 24165.854692647892)
      near(capacity({ Radius: 10 }), 0.05)
      // The repaired non-colonisable branch stays: a body that cannot be settled holds nobody, whatever its geometry.
      near(capacity({ CurrentColonyCost: -1, Radius: 10 }), 0)

      const result = c.bodyCapacityResult(colony())

      near(result.value, 12082.927346323946)
      assert.deepEqual(result.rule.versions, ['3.2.x'], 'the capacity rule is on the line')
    },
  },
  {
    id: 'support',
    run: ({ colonies: c }) => {
      const row = colony({ Population: 10, ReqInf: 36, CurrentColonyCost: 0.036, MaximumColonyCost: 0.036, Infrastructure: 36 })
      near(c.outlookColonies([row], [], 1)[0].results.cap.value, 9)
      near(c.outlookColonies([{ ...row, MaximumColonyCost: 0.07 }], [], 1)[0].results.cap.value, 36 / 7)
    },
  },
  {
    id: 'projection',
    run: ({ colonies: c }) => {
      near(c.projectBody([{ colony: colony(), capacity: 1000 }], 1 / 12)[0].final, 8.066666666666666)
      near(c.projectBody([{ colony: colony({ CurrentColonyCost: 2, Infrastructure: 800 }), capacity: 1000, infrastructureCap: 4 }], 1 / 12)[0].final, 7.833333333333333)
      near(c.projectBody([{ colony: colony({ CurrentColonyCost: 1, Infrastructure: 800 }), capacity: 1000, infrastructureCap: 8 }], 1 / 12)[0].final, 8.066666666666666)
    },
  },
  {
    id: 'workers',
    run: ({ colonies: c }) => {
      const crowded = c.workerSplit({}, 1000, 10, 0)
      near(crowded.agriculture, 550)
      near(crowded.service, 450)
      near(crowded.available, 0)
      const orbital = c.workerSplit({ OrbitalPopulation: 100 }, 100, 0, 40)
      near(orbital.available, 61.2519390047156)
      near(orbital.agriculture, 5)
      near(orbital.efficiency, 1)
    },
  },
  {
    id: 'bootstrap',
    run: ({ colonies: c, 'mine-bootstrap': mb, provenance: p }) => {
      const split = c.workerSplit({ OrbitalPopulation: 100 }, 100, 0, 40)
      const workers = { now: split, later: split, cost: 0 }
      const requirement = mb.mineRequirements({ Name: 'Mine', Cost: 1, Workers: 1, CargoPoints: 1, recipe: {} }, 1)
      const rate = p.ofRule({ rule: 'mineBootstrap.localBuild', value: 10 })
      const local = mb.localRoute({ requirement, capacity: { now: rate, full: rate }, colony: { Efficiency: 1 }, workers, stock: {} })
      const imported = mb.importRoute({ requirement, target: {}, builder: null, workers })
      near(local.figures.efficiencyAfter, 1)
      near(imported.figures.labour.deficitNow, 0)
    },
  },
  {
    id: 'floor',
    run: ({ 'colonist-floor': f }) => {
      const outcome = f.batchOutcome({ population: 100, orbitalPopulation: 100, cost: 0, required: 40, batch: 0 })
      near(outcome.workers, 61.2519390047156)
      near(outcome.shortage, 0)
      assert.ok(f.staffingMinimum({ population: 100, orbitalPopulation: 100, cost: 0, required: 40 }) !== null)
    },
  },
]

const FAULTS = [
  { name: 'Ark membership requires system equality', file: 'arks', from: "if (x === false || y === false) return excluded('space')", to: "if (ship.SystemID !== colony.SystemID || x === false || y === false) return excluded('space')", fails: 'ark-membership' },
  { name: 'Ark cargo query drops unknown categories', file: 'arks', from: '(FCT_ShipCargo.CargoTypeID = ${COLONIST_CARGO} or FCT_ShipCargo.CargoTypeID is null)', to: 'FCT_ShipCargo.CargoTypeID = ${COLONIST_CARGO}', fails: 'ark-membership' },
  { name: 'Ark unknown assignment defaults to zero', file: 'arks', from: 'const outcomes = finite(assignmentId)', to: 'assignmentId = assignmentId ?? 0; const outcomes = finite(assignmentId)', fails: 'ark-membership' },
  { name: 'Ark assignment on another body excludes membership', file: 'arks', from: 'return assigned.SystemBodyID === colony.SystemBodyID ? false : reassigned', to: 'return false', fails: 'ark-membership' },
  { name: 'Ark coordinate tolerance is inclusive', file: 'arks', from: '< POSITION_TOLERANCE : null', to: '<= POSITION_TOLERANCE : null', fails: 'ark-membership' },
  { name: 'Ark same-body attribution alternatives become certain', file: 'arks', from: 'const reassigned = bodyWide || candidates.length === 1 ? true : null', to: 'const reassigned = true', fails: 'ark-membership' },
  { name: 'Ark grand inventory requires decided colony attribution', file: 'arks', from: 'const orbit = orbitResult(memberships, bodyMemberships, countedInEveryAssignment)', to: 'const orbit = orbitResult(memberships, memberships, false)', fails: 'ark-membership' },
  { name: 'Ark absent assignment target becomes unknown', file: 'arks', from: 'if (!assigned) return reassigned', to: 'if (!assigned) return null', fails: 'ark-absent-assignment' },
  { name: 'Ark attribution uncertainty suppresses zero scalars', file: 'arks', from: "isAvailable(result) && (result.value === 0 || (key === 'species' && result.value.length === 0)) ? result :", to: 'false ? result :', fails: 'ark-zero-attribution' },
  { name: 'orbital workers reject every unresolved membership', file: 'colony-environment', from: 'export const orbitalPopulationResult = (ark, colony) => {', to: "export const orbitalPopulationResult = (ark, colony) => { if (ark.ships.some((ship) => !isAvailable(ship.memberships[colony.PopulationID]))) return unavailable({ rule: 'colonies.workers', missing: ['the colony assignment of orbital population'] });", fails: 'ark-zero-attribution' },
  { name: 'Ark grand inclusion collapses body assignment alternatives independently', file: 'arks', from: 'if (bodies.length || countedInEveryAssignment)', to: 'if (bodies.length)', fails: 'ark-correlated-assignment' },
  { name: 'Ark uncertain grand inclusion suppresses zero scalars', file: 'arks', from: 'scoped(member, member.results.orbit).results[name]', to: 'unavailable({ rule: TOTALS, missing: member.results.orbit.inputs.missing })', fails: 'ark-correlated-assignment' },
  { name: 'Ark zero body species requires uncertain berth attribution', file: 'arks', from: 'const contributing = members.filter((member) => !(isAvailable(member.results.occupied) && member.results.occupied.value === 0))', to: 'const contributing = members', fails: 'ark-zero-attribution' },
  { name: 'unused low-gravity value added to the balance', file: 'colonies', from: 'const terms = [colony.Infrastructure, arriving ? arriving.Infrastructure : 0]', to: 'const terms = [colony.Infrastructure, colony.LGInfrastructure, arriving ? arriving.Infrastructure : 0]', fails: 'infrastructure-balance' },
  { name: 'installed balance includes the unused low-gravity column', file: 'page', from: 'sum(DIM_PlanetaryInstallation.InfrastructureValue * FCT_PopulationInstallations.Amount) as Infrastructure', to: 'sum((DIM_PlanetaryInstallation.InfrastructureValue + DIM_PlanetaryInstallation.LGInfrastructureValue) * FCT_PopulationInstallations.Amount) as Infrastructure', fails: 'infrastructure-balance' },
  { name: 'inbound balance includes the unused low-gravity column', file: 'page', from: 'FCT_ShipCargo.Amount * coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0)', to: 'FCT_ShipCargo.Amount * (coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0) + coalesce(DIM_PlanetaryInstallation.LGInfrastructureValue, 0))', fails: 'infrastructure-balance' },
  { name: 'unused low-gravity cargo misclassified as infrastructure', file: 'page', from: 'and coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0) = 0 then FCT_ShipCargo.Amount', to: 'and coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0) + coalesce(DIM_PlanetaryInstallation.LGInfrastructureValue, 0) = 0 then FCT_ShipCargo.Amount', fails: 'infrastructure-balance' },
  { name: 'low gravity multiplier omitted from the current requirement', file: 'colonies', from: "fromString(colony.LowGravity ? '200' : '100')), fromDouble(colony.PopulationDensityModifier)) : 0", to: "fromString('100')), fromDouble(colony.PopulationDensityModifier)) : 0", fails: 'infrastructure-balance' },
  { name: 'low gravity multiplier omitted from support denominator', file: 'colonies', from: "const numerator = multiply(fromDouble(cost), fromString(colony.LowGravity ? '200' : '100'))", to: "const numerator = multiply(fromDouble(cost), fromString('100'))", fails: 'infrastructure-balance' },
  { name: 'body census filtered to the selected race', file: 'page', from: 'where FCT_Population.GameID = ${this.GameID} group by FCT_Population.SystemBodyID) as VIR_Body', to: 'where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SystemBodyID) as VIR_Body', fails: 'all-race-crowding' },
  { name: 'other races omitted from horizon crowding', file: 'colonies', from: 'const fixedPopulation = fixedSurfacePopulation(members)', to: 'const fixedPopulation = 0', fails: 'all-race-crowding' },
  { name: 'other races omitted from chart crowding series', file: 'colonies', from: '(_, month) => fixedPopulation + projections.reduce', to: '(_, month) => 0 + projections.reduce', fails: 'all-race-crowding' },
  { name: 'partial body census treated as whole', file: 'page', from: 'case when coalesce(VIR_Body.UnknownPopulation, 0) > 0 then null else VIR_Body.Population end as BodyPopulation', to: 'VIR_Body.Population as BodyPopulation', fails: 'null-body-census' },
  { name: 'null population dropped from the body census', file: 'page', from: 'sum(case when FCT_Population.Population is null then 1 else 0 end) as UnknownPopulation', to: '0 as UnknownPopulation', fails: 'null-body-census' },
  { name: 'unknown body census named as this colony\'s own', file: 'colonies', from: "const BODY_CENSUS_MISSING = 'the population of another colony on the body'", to: "const BODY_CENSUS_MISSING = 'the population of the body'", fails: 'null-body-census' },
  { name: 'unknown census counted as no other residents', file: 'colonies', from: 'return finite(census) && finite(own) ? Math.max(0, census - own) : null', to: 'return finite(census) && finite(own) ? Math.max(0, census - own) : 0', fails: 'null-body-census' },
  { name: 'partial census still projects a horizon', file: 'colonies', from: 'if (fixedPopulation === null) {', to: 'if (false) {', fails: 'null-body-census' },
  { name: 'excluded Ark capacity required at every colony', file: 'arks', from: 'all.filter((ship) => possible(ship.memberships[colony.PopulationID]))', to: 'all', fails: 'ark-scope' },
  { name: 'counted Ark capacity silently discarded', file: 'colony-environment', from: "const parts = ark.ships.length ? { occupied: occupied || unavailable({ rule: 'colonies.workers', missing: ['the colony assignment of orbital population'] }) } : {}", to: 'const parts = {}', fails: 'ark-scope' },
  { name: 'membership uncertainty treated as zero', file: 'arks', from: 'unavailable({ rule: result.rule.id, missing: membership.inputs.missing })', to: "key === 'occupied' ? ofRule({ rule: result.rule.id, value: 0 }) : unavailable({ rule: result.rule.id, missing: membership.inputs.missing })", fails: 'ark-scope' },
  { name: 'radiation subtracted after crowding', file: 'colonies', from: 'return rate > 0 ? rate * crowdingFactor(bodyPopulation, capacity) : rate', to: 'return (growth > 0 ? growth * colony.PopulationGrowthModifier : growth) * crowdingFactor(bodyPopulation, capacity) - radiation', fails: 'growth' },
  { name: 'crowding denominator replaced by one and a half', file: 'colonies', from: '(capacity - bodyPopulation) / (capacity * 0.6667)', to: '1.5 * (1 - bodyPopulation / capacity)', fails: 'growth' },
  { name: 'radiation penalty not rounded', file: 'colonies', from: "toNumber(round(multiply(fromDouble(colony.RadiationLevel), fromString('0.0025')), 2)) / 100", to: 'colony.RadiationLevel / 40000', fails: 'growth' },
  { name: 'infrastructure shortfall growth omitted', file: 'colonies', from: 'shortfall > 0 ? -shortfall * 0.25 : baseGrowthRate(population)', to: 'shortfall > 0 ? 0 : baseGrowthRate(population)', fails: 'shortfall' },
  { name: 'non-colonisable capacity gate omitted', file: 'colonies', from: 'if (CurrentColonyCost === -1)', to: 'if (false)', fails: 'shortfall' },
  { name: 'capacity geometry taken from Math.PI', file: 'colonies', from: 'export const PI_APPROX = 3.1416', to: 'export const PI_APPROX = Math.PI', fails: 'capacity' },
  { name: 'support denominator not ceiling-rounded', file: 'colonies', from: 'Math.max(1, ceilRatio(numerator, fromDouble(colony.PopulationDensityModifier)))', to: 'toNumber(numerator) / colony.PopulationDensityModifier', fails: 'support' },
  { name: 'monthly population compounded instead of linear', file: 'colonies', from: 'population * (1 + rate / MONTHS_PER_YEAR)', to: 'population * (1 + rate) ** (1 / MONTHS_PER_YEAR)', fails: 'projection' },
  { name: 'services take priority over agriculture', file: 'colonies', from: 'agriculture,\n    available,', to: 'agriculture: Math.min(agriculture, totalPopulation - Math.min(0.7, (totalPopulation / 1000) ** 0.25) * totalPopulation),\n    available,', fails: 'workers' },
  { name: 'orbital people excluded from workforce', file: 'colonies', from: 'const totalPopulation = population + orbitalPopulation', to: 'const totalPopulation = population', fails: 'workers' },
  { name: 'bootstrap loses orbital workforce again', file: 'mine-bootstrap', from: 'workerSplit({ OrbitalPopulation: split.orbitalPopulation }, split.population', to: 'workerSplit({}, split.population', fails: 'bootstrap' },
  { name: 'colonist removal loses orbital workers', file: 'colonist-floor', from: 'const after = workerSplit({ OrbitalPopulation: orbitalPopulation }, remaining, cost, required)', to: 'const after = workerSplit({}, remaining, cost, required)', fails: 'floor' },
]

const main = async () => {
  const selected = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7)
  const load = (sources = {}) => loadUtilities(['colonies', 'mine-bootstrap', 'colonist-floor', 'arks', 'colony-environment', 'provenance'], { sources, stubs: STUBS })
  const apps = await load()
  const cases = CASES.filter((item) => !selected || item.id === selected)
  let failures = 0

  for (const item of cases) {
    try { await item.run(apps); console.log(`PASS ${item.id}`) } catch (error) { failures++; console.error(`FAIL ${item.id}: ${error.message}`) }
  }

  if (mutating() && !selected && !failures) {
    for (const fault of FAULTS) {
      const source = fs.readFileSync(path.join(root, fault.file === 'page' ? 'src/renderer/pages/colony-outlook.vue' : `src/renderer/utilities/${fault.file}.js`), 'utf8')
      const sources = { [fault.file]: patched(fault.file, source, fault.from, fault.to) }
      const mutant = await load(sources)
      let caught = false
      try { await CASES.find((item) => item.id === fault.fails).run(mutant, sources) } catch (error) { caught = error instanceof assert.AssertionError }
      if (!caught) failures++
      console.log(`${caught ? 'PASS' : 'FAIL'} mutant: ${fault.name}`)
    }
  }

  console.log(`${cases.length} source cases; ${failures} failures`)
  process.exitCode = failures ? 1 : 0
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
