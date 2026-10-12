/*
  Behavioural invariants of the shared planning helpers, checked on small in-memory fixtures. No save, no Electron and no network are needed.

  node scripts/check-invariants.js

  Every case names the invariant it states and builds its own rows; none copies a helper's arithmetic, so a case records what the planners agreed the helper must do, not what it happens to compute. Five areas: routes over explored jump links (utilities/jump-graph.js, route-plan.js), stock allocation across queued demands (haul-plan.js planHauls), history capture, superseded passes and rewinds (history.js recordHistory, mergeGame), terraforming at the boundaries of an atmosphere (terraforming.js) and the industry queue's yearly mineral demand with unknown inputs (minerals.js annualQueueDemand, mineral-outlook.js queueDemandResult).

  A case that fails is a mismatch and sets exit code 1. A case marked `known` documents an invariant a helper is known to break today: it names why and the backlog task that fixes it, prints as KNOWN instead of FAIL and does not set the exit code. When a known case starts to pass the run says so, so the mark can be removed.
*/
const assert = require('assert').strict
const { loadUtilities } = require('./lib/utilities')

// The packages the utilities import, as the least their callers here need of them. Dates and numerals are never formatted by a case, and electron-store becomes an in-memory file per name that reports every write to `globalThis.onHistoryWrite`.
const STUBS = {
  'electron-store': `
    const files = (globalThis.historyFiles = globalThis.historyFiles || new Map())
    export default class Config {
      constructor({ name }) { this.name = name }
      get store() { return files.get(this.name) || {} }
      set store(value) { if (globalThis.onHistoryWrite) globalThis.onHistoryWrite(this.name, value); files.set(this.name, JSON.parse(JSON.stringify(value))) }
    }
  `,
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}

const cases = []

const invariant = (area, statement, check, known = null) => cases.push({ area, statement, check, known })

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }

  return value
}

const defineCases = (modules) => {
  const { jumpGraph, routePlan, haulPlan, history, terraforming, habitability, minerals, mineralOutlook } = modules

  // ---- Routes over explored jump links -------------------------------------------------------------------------
  // Three systems in a chain, A (1) to B (2) to C (3), all explored; and a direct A to C link that is much shorter in distance and in jumps. The link's two ends carry their own Explored flags.
  const point = (WarpPointID, SystemID, WPLink, Xcor, Explored = 1, extra = {}) => ({ WarpPointID, SystemID, WPLink, Distance: 0, Xcor, Ycor: 0, JumpGateStrength: 0, Explored, MilitaryRestricted: 0, IgnoreForDistance: 0, ...extra })
  const chain = () => [point(11, 1, 21, 1000), point(21, 2, 11, 1000), point(22, 2, 31, 2000), point(31, 3, 22, 1000)]
  const shortcut = (nearSide, farSide, extra = {}) => [point(12, 1, 32, 10, nearSide, extra), point(32, 3, 12, 10, farSide, extra)]
  const origin = { SystemID: 1, Xcor: 0, Ycor: 0 }
  const outOf = (SystemID) => ({ SystemID, Xcor: 0, Ycor: 0 })
  const SYSTEMS = [1, 2, 3]
  const ORDERS = ['jumps', 'km']
  const figures = (route) => route && { jumps: route.jumps, km: route.km }

  ORDERS.forEach((order) => {
    invariant('routing', `an explored direct link is used when it is shorter (control: the fixture can tempt the search; order ${order})`, () => {
      const route = jumpGraph.searchRoutes([...chain(), ...shortcut(1, 1)], [origin], { order }).toSystem(3)

      assert.equal(route.jumps, 1)
    })

    invariant('routing', `an unexplored direct link never makes a route shorter (order ${order})`, () => {
      const route = jumpGraph.searchRoutes([...chain(), ...shortcut(0, 0)], [origin], { order }).toSystem(3)

      assert.equal(route.jumps, 2)
      assert.ok(route.km >= 2000, `the route took ${route.km} km, less than the explored chain's 2000`)
    })

    invariant('routing', `adding unexplored links changes no route to any system (order ${order})`, () => {
      const without = jumpGraph.searchRoutes(chain(), [origin], { order })
      const withLinks = jumpGraph.searchRoutes([...chain(), ...shortcut(0, 0)], [origin], { order })

      SYSTEMS.forEach((system) => assert.deepEqual(figures(withLinks.toSystem(system)), figures(without.toSystem(system)), `system ${system}`))
    })

    invariant('routing', `a link cannot be left from its unexplored end, whatever the other end shows (order ${order})`, () => {
      const route = jumpGraph.searchRoutes([...chain(), ...shortcut(1, 0)], [outOf(3)], { order }).toSystem(1)

      assert.equal(route.jumps, 2)
    })
  })

  invariant('routing', 'a system reachable only through an unexplored link has no route, not a zero-length one', () => {
    const search = jumpGraph.searchRoutes(shortcut(0, 0), [origin])

    assert.equal(search.toSystem(3), null)
    assert.equal(search.toPlace({ SystemID: 3, Xcor: 5, Ycor: 5 }), null)
  })

  invariant('routing', 'a link to a jump point the race has not charted leads nowhere', () => {
    const rows = [point(11, 1, 999, 1000)]

    assert.equal(jumpGraph.searchRoutes(rows, [origin]).toSystem(2), null)
    assert.deepEqual(jumpGraph.jumpLinks(rows), [])
  })

  invariant('routing', 'map links join only jump points whose far side is charted', () => {
    assert.deepEqual(jumpGraph.jumpLinks(chain()).map((link) => `${link.SystemID}>${link.DestinationID}`).sort(), ['1>2', '2>1', '2>3', '3>2'])
  })

  invariant('routing', 'a route cannot enter a system the race avoids, even when it is the only way', () => {
    const search = jumpGraph.searchRoutes(chain(), [origin], { canEnter: (SystemID) => SystemID !== 2 })

    assert.equal(search.toSystem(2), null)
    assert.equal(search.toSystem(3), null)
  })

  invariant('routing', 'a route cannot leave through a point the fleet may not transit, even when it is shorter', () => {
    const rows = [...chain(), ...shortcut(1, 1, { JumpGateStrength: 0 })]
    const search = jumpGraph.searchRoutes(rows, [origin], { canTransit: (jumpPoint) => jumpPoint.WarpPointID !== 12 })

    assert.equal(search.toSystem(3).jumps, 2)
  })

  invariant('routing', 'a system that holds the origin is reached at no jumps and no distance', () => {
    assert.deepEqual(figures(jumpGraph.searchRoutes(chain(), [origin]).toSystem(1)), { jumps: 0, km: 0 })
  })

  invariant('routing', 'a jump point marked to be ignored for distance does not shorten a distance', () => {
    const distanceTo = jumpGraph.buildDistanceMap([...chain(), ...shortcut(1, 1, { IgnoreForDistance: 1 })], [origin])

    assert.equal(distanceTo({ SystemID: 3, Xcor: 1000, Ycor: 0 }).jumps, 2)
  })

  invariant('routing', 'a body in a system no explored route reaches has no distance, not zero', () => {
    const distanceTo = jumpGraph.buildDistanceMap(shortcut(0, 0), [origin])

    assert.equal(distanceTo({ SystemID: 3, Xcor: 10, Ycor: 0 }), null)
  })

  invariant('routing', 'a planned route counts the legs no explored route joins as missing and takes no unexplored link', () => {
    const stops = [{ key: 'a', kind: 'system', SystemID: 1 }, { key: 'c', kind: 'system', SystemID: 3 }]
    const plan = routePlan.planRoute(stops, { cycle: false, jumpPoints: shortcut(0, 0) })

    assert.equal(plan.missing, 1)
    assert.equal(plan.legs[0].route, null)
    assert.equal(plan.jumps, 0)
  })

  invariant('routing', 'a planned route over the explored chain crosses the chain, not an unexplored shortcut', () => {
    const stops = [{ key: 'a', kind: 'system', SystemID: 1 }, { key: 'c', kind: 'system', SystemID: 3 }]
    const plan = routePlan.planRoute(stops, { cycle: false, jumpPoints: [...chain(), ...shortcut(0, 0)] })

    assert.equal(plan.missing, 0)
    assert.equal(plan.jumps, 2)
    assert.deepEqual(plan.systems, [1, 2, 3])
  })

  // ---- Stock across queued demands -----------------------------------------------------------------------------
  // Colonies in one system, so every one is on a route of every other. A mineral is { id, name, stock, reserve, needs, inbound }, as colonyMinerals gives it.
  const colonyAt = (PopulationID, Xcor, minerals) => ({ colony: { PopulationID, SystemID: 1, Xcor, Ycor: 0 }, minerals: minerals.map((mineral) => ({ id: 1, name: 'Duranium', stock: 0, reserve: 0, needs: 0, inbound: 0, ...mineral })) })
  const received = (result, PopulationID, id = 1) => result.hauls.filter((haul) => haul.to.PopulationID === PopulationID).reduce((total, haul) => total + haul.minerals.filter((mineral) => mineral.id === id).reduce((sum, mineral) => sum + mineral.tonnes, 0), 0)
  const given = (result, PopulationID, id = 1) => result.hauls.filter((haul) => haul.from.PopulationID === PopulationID).reduce((total, haul) => total + haul.minerals.filter((mineral) => mineral.id === id).reduce((sum, mineral) => sum + mineral.tonnes, 0), 0)
  const unmetOf = (result, PopulationID, id = 1) => result.unmet.filter((entry) => entry.colony.PopulationID === PopulationID && entry.mineral.id === id).reduce((total, entry) => total + entry.tonnes, 0)
  const plan = (colonies, options = {}) => haulPlan.planHauls(deepFreeze(colonies), { jumpPoints: [], ...options })
  const source = (PopulationID = 1, Xcor = 0) => colonyAt(PopulationID, Xcor, [{ stock: 150, reserve: 50 }])

  invariant('stock', 'two demands for one source never draw more than the source has above its reserve', () => {
    const result = plan([source(), colonyAt(2, 10, [{ needs: 80 }]), colonyAt(3, 20, [{ needs: 80 }])])

    assert.ok(given(result, 1) <= 100, `the source gave ${given(result, 1)} of 100 spare`)
  })

  invariant('stock', 'every tonne a demand asks is either delivered or reported unmet, once', () => {
    const result = plan([source(), colonyAt(2, 10, [{ needs: 80 }]), colonyAt(3, 20, [{ needs: 80 }])])

    ;[2, 3].forEach((PopulationID) => assert.equal(received(result, PopulationID) + unmetOf(result, PopulationID), 80, `colony ${PopulationID}`))
  })

  invariant('stock', 'the totals do not depend on the order the colonies are listed in', () => {
    const colonies = [source(), colonyAt(2, 10, [{ needs: 80 }]), colonyAt(3, 20, [{ needs: 80 }])]
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]

    orders.forEach((order) => {
      const result = plan(order.map((index) => colonies[index]))

      assert.ok(given(result, 1) <= 100, `order ${order}: the source gave ${given(result, 1)}`)
      assert.equal(received(result, 2) + received(result, 3) + unmetOf(result, 2) + unmetOf(result, 3), 160, `order ${order}`)
    })
  })

  invariant('stock', 'a colony gives nothing its own queue needs', () => {
    const result = plan([colonyAt(1, 0, [{ stock: 100, needs: 100 }]), colonyAt(2, 10, [{ needs: 50 }])])

    assert.equal(given(result, 1), 0)
    assert.equal(unmetOf(result, 2), 50)
  })

  invariant('stock', 'a colony gives nothing out of its reserve', () => {
    const result = plan([colonyAt(1, 0, [{ stock: 100, reserve: 100 }]), colonyAt(2, 10, [{ needs: 50 }])])

    assert.equal(given(result, 1), 0)
  })

  invariant('stock', 'a colony short of a mineral is never a source of it', () => {
    const result = plan([colonyAt(1, 0, [{ stock: 10, needs: 40 }]), colonyAt(2, 10, [{ needs: 40 }])])

    assert.equal(given(result, 1), 0)
  })

  invariant('stock', 'no haul runs from a colony to itself', () => {
    const result = plan([source(), colonyAt(2, 10, [{ needs: 30 }])])

    result.hauls.forEach((haul) => assert.notEqual(haul.from.PopulationID, haul.to.PopulationID))
  })

  invariant('stock', 'mass-driver packets already on their way count as held, so they are not hauled twice', () => {
    const result = plan([source(), colonyAt(2, 10, [{ needs: 50, inbound: 50 }])])

    assert.equal(result.hauls.length, 0)
    assert.equal(result.unmet.length, 0)
  })

  invariant('stock', 'stock of one mineral cannot cover a shortfall of another', () => {
    const result = plan([colonyAt(1, 0, [{ id: 1, stock: 150, reserve: 50 }]), colonyAt(2, 10, [{ id: 2, name: 'Neutronium', needs: 40 }])])

    assert.equal(result.hauls.length, 0)
    assert.equal(unmetOf(result, 2, 2), 40)
  })

  invariant('stock', 'a queue shortfall is covered before a reserve shortfall when the spare stock is short', () => {
    const result = plan([colonyAt(1, 0, [{ stock: 60 }]), colonyAt(2, 10, [{ reserve: 60 }]), colonyAt(3, 20, [{ needs: 60 }])])

    assert.equal(received(result, 3), 60)
    assert.equal(received(result, 2), 0)
    assert.equal(unmetOf(result, 2), 60)
  })

  invariant('stock', 'with reserves left out a reserve shortfall asks for nothing', () => {
    const result = plan([source(), colonyAt(2, 10, [{ reserve: 60 }])], { reserves: false })

    assert.equal(result.hauls.length, 0)
    assert.equal(result.unmet.length, 0)
  })

  invariant('stock', 'a shortfall is drawn from the nearest source first and then from the next one, each source once', () => {
    const result = plan([colonyAt(1, 0, [{ stock: 100 }]), colonyAt(2, 500, [{ stock: 100 }]), colonyAt(3, 10, [{ needs: 150 }])])

    assert.equal(given(result, 1), 100)
    assert.equal(given(result, 2), 50)
    assert.equal(received(result, 3), 150)
  })

  invariant('stock', 'a demand no charted route reaches stays unmet and moves nothing', () => {
    const away = { colony: { PopulationID: 2, SystemID: 2, Xcor: 0, Ycor: 0 }, minerals: [{ id: 1, name: 'Duranium', stock: 0, reserve: 0, needs: 50, inbound: 0 }] }
    const result = plan([source(), away])

    assert.equal(result.hauls.length, 0)
    assert.equal(unmetOf(result, 2), 50)
  })

  invariant('stock', 'planning leaves the colonies it was given untouched', () => {
    const colonies = deepFreeze([source(), colonyAt(2, 10, [{ needs: 80 }])])

    assert.doesNotThrow(() => haulPlan.planHauls(colonies, { jumpPoints: [] }))
    assert.equal(colonies[0].minerals[0].stock, 150)
  })

  // ---- History capture, superseded passes and rewinds ----------------------------------------------------------
  const files = () => (globalThis.historyFiles = globalThis.historyFiles || new Map())
  const snapshotOf = (t) => ({ t, population: t })
  const recordOf = (...times) => ({ raceName: 'Race', npr: false, snapshots: times.map(snapshotOf) })
  const fileOf = (...times) => ({ gameName: 'Campaign', races: { 7: recordOf(...times) }, intel: {} })
  const timesIn = (file, RaceID = 7) => (file.races[RaceID] ? file.races[RaceID].snapshots.map((snapshot) => snapshot.t) : [])
  const gate = () => {
    let open

    return { wait: new Promise((resolve) => (open = resolve)), open }
  }

  // A save with one race of game 1 at game time `time`, answering the recorder's reads from memory. `held` delays the read transaction's end, `onQuery` sees every read's options.
  const saveAt = (time, { held = null, onQuery = () => {}, gameName = 'Campaign' } = {}) => {
    const state = { inTransaction: false }

    return {
      state,
      transaction: async (work) => {
        state.inTransaction = true

        try {
          const result = await work({ id: 'transaction' })

          if (held) {
            await held
          }

          return result
        } finally {
          state.inTransaction = false
        }
      },
      query: async (sql, options) => {
        onQuery(sql, options, state)

        if (sql.startsWith('select FCT_Race.GameID')) {
          return [[{ GameID: 1, RaceID: 7, NPR: 0, SpecialNPRID: 0 }]]
        }

        if (sql.startsWith('select FCT_Game.GameTime')) {
          return [[{ GameTime: time, GameName: gameName, RaceTitle: 'Race', WealthPoints: 0, AnnualWealth: 0 }]]
        }

        if (sql.startsWith('select (select sum(FCT_TechSystem')) {
          return [[{ Research: 0, Systems: 0, Commanders: 0 }]]
        }

        return [[]]
      },
    }
  }

  const reset = (file) => {
    files().clear()
    globalThis.onHistoryWrite = null

    if (file) {
      files().set('game-1', file)
    }
  }

  const stored = () => files().get('game-1')

  invariant('history', 'a current pass records one snapshot of the race at the save time (control)', async () => {
    reset(fileOf(50))

    const result = await history.recordHistory(saveAt(100))

    assert.equal(result.superseded, false)
    assert.deepEqual(timesIn(stored()), [50, 100])
  })

  invariant('history', 'a superseded pass writes nothing and leaves the stored history as it was', async () => {
    reset(fileOf(100, 200))

    const before = JSON.stringify(stored())
    const result = await history.recordHistory(saveAt(150), { isCurrent: () => false })

    assert.equal(result.superseded, true)
    assert.equal(result.recorded, 0)
    assert.equal(JSON.stringify(stored()), before)
  })

  invariant('history', 'an older save whose pass finishes after a newer save\'s cannot erase the newer snapshot', async () => {
    reset(fileOf(50))

    let generation = 0
    const release = gate()
    const older = ++generation
    const olderPass = history.recordHistory(saveAt(100, { held: release.wait }), { isCurrent: () => older === generation })
    const newer = ++generation
    const newerPass = await history.recordHistory(saveAt(200), { isCurrent: () => newer === generation })

    release.open()

    const olderResult = await olderPass

    assert.equal(newerPass.superseded, false)
    assert.equal(olderResult.superseded, true)
    assert.deepEqual(timesIn(stored()), [50, 200])
  })

  invariant('history', 'passes that finish in the order they started keep both snapshots', async () => {
    reset(fileOf(50))

    let generation = 0
    const first = ++generation

    await history.recordHistory(saveAt(100), { isCurrent: () => first === generation })

    const second = ++generation

    await history.recordHistory(saveAt(200), { isCurrent: () => second === generation })

    assert.deepEqual(timesIn(stored()), [50, 100, 200])
  })

  invariant('history', 'a pass reads the whole save inside one read transaction', async () => {
    reset(fileOf(50))

    const outside = []

    await history.recordHistory(saveAt(100, { onQuery: (sql, options, state) => !(state.inTransaction && options && options.transaction) && outside.push(sql.slice(0, 40)) }))

    assert.deepEqual(outside, [])
  })

  invariant('history', 'a pass writes its history file only after the read transaction has ended', async () => {
    reset(fileOf(50))

    const database = saveAt(100)
    const writes = []

    globalThis.onHistoryWrite = () => writes.push(database.state.inTransaction)
    await history.recordHistory(database)

    assert.deepEqual(writes, [false])
  })

  invariant('history', 'a save at an already recorded time replaces that snapshot instead of adding a second', () => {
    const merged = history.mergeGame(fileOf(100, 200), { gameName: 'Campaign', t: 200, races: [{ RaceID: 7, raceName: 'Race', npr: false, snapshot: { t: 200, population: 999 } }] })

    assert.deepEqual(timesIn(merged), [100, 200])
    assert.equal(merged.races[7].snapshots[1].population, 999)
  })

  invariant('history', 'a race missing from a save keeps its recorded past', () => {
    const merged = history.mergeGame(fileOf(100), { gameName: 'Campaign', t: 200, races: [{ RaceID: 8, raceName: 'Other', npr: false, snapshot: snapshotOf(200) }] })

    assert.deepEqual(timesIn(merged, 7), [100])
    assert.deepEqual(timesIn(merged, 8), [200])
  })

  invariant('history', 'merging an older save (a rewind) does not erase the later snapshots; they stay as a branch', () => {
    const merged = history.mergeGame(fileOf(100, 200), { gameName: 'Campaign', t: 150, races: [{ RaceID: 7, raceName: 'Race', npr: false, snapshot: snapshotOf(150) }] })

    assert.ok(JSON.stringify(merged).includes('"t":200'), 'the snapshot at 200 is gone from the merged history')
  }, { reason: 'mergeGame trims every snapshot at or after the incoming time (utilities/history.js `before`), so a rewind or a copied older save drops the later record', task: 'AE-033-02' })

  invariant('history', 'a save of another campaign under the same GameID does not erase the recorded campaign', () => {
    const merged = history.mergeGame(fileOf(100, 200), { gameName: 'Another campaign', t: 50, races: [{ RaceID: 7, raceName: 'Race', npr: false, snapshot: snapshotOf(50) }] })

    assert.ok(JSON.stringify(merged).includes('"t":200'), 'the snapshots of the first campaign are gone from the merged history')
  }, { reason: 'the history file is keyed by GameID alone and a different GameName starts it over (mergeGame `sameGame`), so two campaigns that reuse an ID overwrite each other', task: 'AE-033-02' })

  invariant('history', 'thinning a long history keeps its first and latest snapshot and fits the limit', () => {
    const many = Array.from({ length: 11 }, (_, index) => snapshotOf(index))
    const thinned = history.thinSnapshots(many, 5)

    assert.ok(thinned.length <= 5)
    assert.equal(thinned[0].t, 0)
    assert.equal(thinned[thinned.length - 1].t, 10)
  })

  // ---- Terraforming boundaries ---------------------------------------------------------------------------------
  const species = habitability.speciesLimits({ IdealTemperature: 288, TemperatureDeviation: 30, IdealBreathePressure: 0.2, BreathePressureDeviation: 0.1, IdealGravity: 1, GravityDeviation: 0.5, MaximumPressure: 4, BreatheID: 2, BreatheName: 'Oxygen', PopulationDensityModifier: 1 })
  const gas = (AtmosGasID, AtmosGasName, GasAtm, AtmosGasAmount) => ({ AtmosGasID, AtmosGasName, GasAtm, AtmosGasAmount, BoilingPoint: 0, GHGas: 0, AntiGHGas: 0, Dangerous: 0, DangerousLevel: 0, FrozenOut: 0 })
  const earthlike = (extra = {}) => ({ BodyClass: 1, BodyTypeID: 1, FixedBody: 0, TidalLock: 0, Radius: 6371, Gravity: 1, SurfaceTemp: 288, BaseTemp: 255, Albedo: 0.3, StarLuminosity: 1, DustLevel: 0, HydroExt: 50, HydroID: 3, AtmosPress: 1, Eccentricity: 0, OrbitalDistance: 1, Atmosphere: [gas(2, 'Oxygen', 0.2, 20), gas(7, 'Nitrogen', 0.8, 80)], ...extra })
  const airless = (extra = {}) => earthlike({ SurfaceTemp: 255, HydroExt: 0, HydroID: 1, AtmosPress: 0, Atmosphere: [], ...extra })
  // The DIM_Gases rows the plan needs: Aestusium warms, Frigusium cools, the rest are neutral. Every row holds all the figures a plan prices a gas with; a row without them makes the plan unknown (see the cases below).
  const gasRow = (AtmosGasName, extra = {}) => ({ AtmosGasName, BoilingPoint: 0, GHGas: 0, AntiGHGas: 0, Dangerous: 0, DangerousLevel: 0, ...extra })
  const GASES = { 2: gasRow('Oxygen'), 5: gasRow('Water Vapour'), 7: gasRow('Nitrogen'), 20: gasRow('Aestusium', { GHGas: 1 }), 22: gasRow('Frigusium', { AntiGHGas: 1 }) }
  const assess = (body) => terraforming.assessTerraforming(deepFreeze(body), species, 1, (id) => GASES[id])
  const BOUNDARY_BODIES = {
    'an airless body': airless(),
    'a body with a zero-pressure atmosphere entry': airless({ Atmosphere: [gas(7, 'Nitrogen', 0, 0)] }),
    'a body at the species\' maximum pressure': earthlike({ AtmosPress: 4, Atmosphere: [gas(2, 'Oxygen', 0.2, 5), gas(7, 'Nitrogen', 3.8, 95)] }),
    'a body just over the species\' maximum pressure': earthlike({ AtmosPress: 4.001, Atmosphere: [gas(2, 'Oxygen', 0.2, 5), gas(7, 'Nitrogen', 3.801, 95)] }),
    'a body with a very thin atmosphere': airless({ AtmosPress: 0.01, Atmosphere: [gas(7, 'Nitrogen', 0.01, 100)] }),
    'a liveable body that is too warm for a plan to help': earthlike({ SurfaceTemp: 400 }),
    'a body at the minimum gravity terraforming can hold an atmosphere at': airless({ Gravity: 0.1 }),
    'a body just under that gravity': airless({ Gravity: 0.0999 }),
    'a body with no radius': airless({ Radius: 0 }),
  }

  Object.entries(BOUNDARY_BODIES).forEach(([name, body]) => {
    invariant('terraforming', `${name}: the assessment terminates with a known outcome and a finite, non-negative amount of work`, () => {
      const assessment = assess(body)

      assert.ok(Object.prototype.hasOwnProperty.call(terraforming.OUTCOMES, assessment.outcome), `outcome ${assessment.outcome}`)
      assert.ok(Number.isFinite(assessment.work) && assessment.work >= 0, `work ${assessment.work}`)
    })

    invariant('terraforming', `${name}: an impossible body says why, and a body with nothing to do carries no plan`, () => {
      const assessment = assess(body)

      assert.equal(assessment.plan === null, assessment.work === 0, 'work and plan disagree')

      if (assessment.outcome === 'no') {
        assert.equal(typeof assessment.reason, 'string')
        assert.equal(assessment.work, 0)
      }

      if (assessment.outcome === 'done') {
        assert.equal(assessment.plan, null)
        assert.equal(assessment.work, 0)
      }
    })
  })

  invariant('terraforming', 'a body already liveable is done with no work, which is not the same as impossible', () => {
    const done = assess(earthlike())
    const impossible = assess(airless({ Gravity: 0.05 }))

    assert.equal(done.outcome, 'done')
    assert.equal(done.reason, null)
    assert.equal(impossible.outcome, 'no')
    assert.equal(typeof impossible.reason, 'string')
  })

  invariant('terraforming', 'a body lighter than the terraforming gravity limit is impossible; at the limit it is planned', () => {
    assert.equal(assess(airless({ Gravity: 0.0999 })).reason, 'Too light to keep an atmosphere')
    assert.notEqual(assess(airless({ Gravity: 0.1 })).reason, 'Too light to keep an atmosphere')
  })

  invariant('terraforming', 'work on an airless body is positive and a colony without capacity never finishes it', () => {
    const assessment = assess(airless())

    assert.ok(assessment.work > 0, `work ${assessment.work}`)
    assert.equal(terraforming.planYears(assessment.work, 0), Infinity)
    assert.ok(Number.isFinite(terraforming.planYears(assessment.work, 1)))
  })

  invariant('terraforming', 'no work takes no years, whatever the capacity, so it is told from work nothing can do', () => {
    assert.equal(terraforming.planYears(0, 0), 0)
    assert.equal(terraforming.planYears(0, 5), 0)
    assert.equal(terraforming.planYears(1, 0), Infinity)
    assert.notEqual(terraforming.planYears(1, 0), terraforming.planYears(0, 0))
  })

  invariant('terraforming', 'a capacity that is not known is never read as zero years', () => {
    assert.notEqual(terraforming.planYears(1, Number.NaN), 0)
    assert.notEqual(terraforming.planYears(Number.NaN, 1), 0)
  })

  invariant('terraforming', 'a colony without terraformers, or a game with terraforming switched off, moves no atmosphere', () => {
    assert.equal(terraforming.terraformCapacity({ TerraformingRate: 0.5, TerraformingSpeed: 100 }, 0), 0)
    assert.equal(terraforming.terraformCapacity({ TerraformingRate: 0.5, TerraformingSpeed: 0 }, 10), 0)
    assert.ok(terraforming.terraformCapacity({ TerraformingRate: 0.5, TerraformingSpeed: 100 }, 10) > 0)
  })

  invariant('terraforming', 'more terraformers never take more years', () => {
    const { work } = assess(airless())
    const capacity = (terraformers) => terraforming.terraformCapacity({ TerraformingRate: 0.5, TerraformingSpeed: 100 }, terraformers)

    assert.ok(terraforming.planYears(work, capacity(4)) <= terraforming.planYears(work, capacity(2)))
    assert.ok(terraforming.planYears(work, capacity(2)) <= terraforming.planYears(work, capacity(0)))
  })

  // A plan prices its end state with the DIM_Gases figures of every gas it adds. A table without them leaves the plan unknown, whatever the figures it would have priced at (zeros would turn an improving plan into "would make it worse"), and a gas the plan does not add is not asked for.
  const withoutGas = (id) => (gasId) => (gasId === id ? undefined : GASES[gasId])
  const assessWith = (body, gasInfo) => terraforming.assessTerraforming(deepFreeze(body), species, 1, gasInfo)

  invariant('terraforming', 'a plan that adds a gas DIM_Gases holds no figures of is unknown and names the gas, not priced with zeros', () => {
    const assessment = assessWith(airless(), withoutGas(20))

    assert.deepEqual(assessment.missing, ['DIM_Gases row of gas 20'])
    assert.equal(assessment.plan, null)
  })

  invariant('terraforming', 'a gas row without its figures (a boiling point, say) is as missing as an absent row', () => {
    const assessment = assessWith(airless(), (id) => (id === 20 ? { AtmosGasName: 'Aestusium', GHGas: 1 } : GASES[id]))

    assert.deepEqual(assessment.missing, ['DIM_Gases row of gas 20'])
  })

  invariant('terraforming', 'a plan the full table rejects as making things worse is unknown, not worse, when it adds a gas the table lacks', () => {
    const body = earthlike({ SurfaceTemp: 200, BaseTemp: 180 })

    assert.equal(assessWith(body, (id) => GASES[id]).reason, 'Terraforming would make it worse', 'control: the complete table rejects this plan')
    assert.deepEqual(assessWith(body, withoutGas(20)).missing, ['DIM_Gases row of gas 20'])
  })

  invariant('terraforming', 'a gas the plan does not add is not asked for: the plan stands without its row', () => {
    const assessment = assessWith(airless(), withoutGas(7))

    assert.equal(assessment.missing, undefined)
    assert.ok(assessment.plan, 'the plan is gone')
  })

  // ---- Industry queue demand ----------------------------------------------------------------------------------
  // One queued project at a colony: 10 units of 100 BP each costing 5 t Duranium a unit, the whole of the colony's capacity.
  const queued = (extra = {}) => ({ PopulationID: 1, ProductionType: 0, Percentage: 100, Queue: 1, Amount: 10, ProdPerUnit: 100, Duranium: 5, Neutronium: 0, Corbomite: 0, Tritanium: 0, Boronide: 0, Mercassium: 0, Vendarite: 0, Sorium: 0, Uridium: 0, Corundium: 0, Gallicite: 0, ...extra })
  const demandOf = (project, capacity) => mineralOutlook.queueDemandResult(minerals.annualQueueDemand([project], () => capacity), 'Duranium')

  invariant('queue demand', 'a complete project at a known capacity gives its tonnes (control)', () => {
    const result = demandOf(queued(), 1000)

    assert.equal(result.status, 'estimated')
    assert.equal(result.value, 50)
  })

  invariant('queue demand', 'a project with an unrecorded mineral cost at a colony of unknown capacity is unavailable for that mineral, both reasons kept', () => {
    const result = demandOf(queued({ Duranium: null }), null)

    assert.equal(result.status, 'unavailable')
    assert.ok(result.inputs.missing.some((name) => name.includes('Duranium cost')), `missing: ${result.inputs.missing}`)
    assert.ok(result.inputs.missing.some((name) => name.includes('production capacity')), `missing: ${result.inputs.missing}`)
  })

  invariant('queue demand', 'an unknown capacity and a recorded cost keep only the capacity reason', () => {
    const result = demandOf(queued(), null)

    assert.equal(result.status, 'unavailable')
    assert.deepEqual(result.inputs.missing, ['the production capacity of a colony with queued projects'])
  })

  invariant('queue demand', 'a project missing its units, share or place leaves the demand unknown at a colony of known capacity', () => {
    ;['Amount', 'ProdPerUnit', 'Percentage', 'Queue'].forEach((field) => assert.equal(demandOf(queued({ [field]: null }), 1000).status, 'unavailable', field))
  })

  invariant('queue demand', 'a recorded capacity of 0 demands nothing, whatever the queue lacks: no work gets done', () => {
    ;[{}, { Amount: null }, { ProdPerUnit: null }, { Percentage: null }, { Queue: null }, { Duranium: null }].forEach((patch) => {
      const result = demandOf(queued(patch), 0)

      assert.equal(result.status, 'estimated', JSON.stringify(patch))
      assert.equal(result.value, 0, JSON.stringify(patch))
    })
  })
}

const main = async () => {
  const modules = await loadUtilities(['jump-graph', 'route-plan', 'haul-plan', 'history', 'terraforming', 'habitability', 'minerals', 'mineral-outlook'], { stubs: STUBS })

  defineCases({ jumpGraph: modules['jump-graph'], routePlan: modules['route-plan'], haulPlan: modules['haul-plan'], history: modules.history, terraforming: modules.terraforming, habitability: modules.habitability, minerals: modules.minerals, mineralOutlook: modules['mineral-outlook'] })

  const totals = { ok: 0, fail: 0, known: 0, fixed: 0 }
  let area = null

  for (const { area: caseArea, statement, check, known } of cases) {
    if (caseArea !== area) {
      area = caseArea
      console.log(`\n${area}`)
    }

    let error = null

    try {
      await check()
    } catch (thrown) {
      error = thrown
    }

    if (!error && !known) {
      totals.ok += 1
      console.log(`  ok     ${statement}`)
    } else if (!error) {
      totals.fixed += 1
      console.log(`  FIXED  ${statement}\n         the known failure no longer reproduces (${known.task}); remove its mark`)
    } else if (known) {
      totals.known += 1
      console.log(`  KNOWN  ${statement}\n         ${error.message.split('\n')[0]}\n         why: ${known.reason}\n         fixed by: ${known.task}`)
    } else {
      totals.fail += 1
      console.log(`  FAIL   ${statement}\n         ${String(error && error.message).split('\n').join('\n         ')}`)
    }
  }

  console.log(`\n${cases.length} invariants: ${totals.ok} ok, ${totals.fail} failed, ${totals.known} known failures${totals.fixed ? `, ${totals.fixed} known failures no longer reproduce` : ''}`)
  process.exit(totals.fail ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
