/*
  Behavioural invariants of the shared planning helpers, checked on small in-memory fixtures. No save, no Electron and no network are needed.

  node scripts/check-invariants.js

  Every case names the invariant it states and builds its own rows; none copies a helper's arithmetic, so a case records what the planners agreed the helper must do, not what it happens to compute. Five areas: routes over explored jump links (utilities/jump-graph.js, route-plan.js), stock allocation across queued demands (haul-plan.js planHauls), history capture, superseded passes and rewinds (history.js recordHistory, mergeGame), terraforming at the boundaries of an atmosphere (terraforming.js) and the industry queue's yearly mineral demand with unknown inputs (minerals.js annualQueueDemand, mineral-outlook.js queueDemandResult).

  A case that fails is a mismatch and sets exit code 1. A case marked `known` documents an invariant a helper is known to break today: it names why and the backlog task that fixes it, prints as KNOWN instead of FAIL and does not set the exit code. When a known case starts to pass the run says so, so the mark can be removed.
*/
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')

// The packages the utilities import, as the least their callers here need of them. Dates and numerals are never formatted by a case, and electron-store becomes an in-memory file per name that reports every write to `globalThis.onHistoryWrite`.
const STUBS = {
  'electron-store': `
    const files = (globalThis.historyFiles = globalThis.historyFiles || new Map())
    export default class Config {
      constructor({ name }) { this.name = name }
      get store() { return files.get(this.name) || {} }
      set store(value) { if (globalThis.onHistoryWrite) globalThis.onHistoryWrite(this.name, value); files.set(this.name, JSON.parse(JSON.stringify(value))) }
      update(change) { this.store = change(this.store) }
    }
  `,
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
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
  const { history, terraforming, habitability, minerals } = modules
  const jumpGraph = modules['jump-graph']
  const routePlan = modules['route-plan']
  const haulPlan = modules['haul-plan']
  const mineralOutlook = modules['mineral-outlook']

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

  // A save with one race of game 1 at game time `time`, answering the recorder's reads from memory: the games, the lowest-numbered systems and the increment ledger, a prefix of one chain that is longer the later the time. `held` delays the read transaction's end, `onQuery` sees every read's options.
  const LEDGER_BASE = 64
  const ledgerAt = (time) => Array.from({ length: LEDGER_BASE + Math.floor(time / 10) }, (_, index) => ({ IncrementID: index + 1, GameTime: index + 1 }))
  const anchorRows = Array.from({ length: 10 }, (_, index) => ({ SystemID: 10 + index, SystemNumber: index + 1, Age: 1, AbundanceModifier: 1, Stars: 1, DustDensity: 1, SystemTypeID: 1 }))
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

        if (sql.startsWith('select FCT_Game.GameID')) {
          return [[{ GameID: 1, GameName: gameName, GameTime: time }]]
        }

        if (sql.startsWith('select FCT_System.SystemID')) {
          return [anchorRows]
        }

        if (sql.startsWith('select FCT_Increments.IncrementID')) {
          return [ledgerAt(time)]
        }

        if (sql.startsWith('select FCT_Game.GameTime')) {
          return [[{ GameTime: time, GameName: gameName, RaceTitle: 'Race', WealthPoints: 0, AnnualWealth: 0 }]]
        }

        if (sql.startsWith('select (select case when count(FCT_TechSystem')) {
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

  // What a pass leaves behind for the one campaign it recorded: its first branch's history file, or the pre-campaign file while no campaign has been recorded.
  const stored = () => {
    const registry = files().get('campaigns')
    const campaign = registry && Object.values(registry.campaigns || {}).find((entry) => !entry.mergedInto)

    return campaign ? files().get(`campaign-${campaign.id}-b1`) : files().get('game-1')
  }
  const everything = () => JSON.stringify([...files()])

  invariant('history', 'a current pass records one snapshot of the race at the save time (control)', async () => {
    reset(fileOf(50))

    const result = await history.recordHistory(saveAt(100))

    assert.equal(result.superseded, false)
    assert.deepEqual(timesIn(stored()), [50, 100])
  })

  invariant('history', 'a superseded pass writes nothing and leaves the stored history as it was', async () => {
    reset(fileOf(100, 200))

    const before = everything()
    const result = await history.recordHistory(saveAt(150), { isCurrent: () => false })

    assert.equal(result.superseded, true)
    assert.equal(result.recorded, 0)
    assert.equal(everything(), before)
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

    assert.ok(writes.length > 0, 'nothing was written')
    assert.deepEqual(writes.filter((inside) => inside), [])
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
  })

  invariant('history', 'a save of another campaign under the same GameID does not erase the recorded campaign', () => {
    const merged = history.mergeGame(fileOf(100, 200), { gameName: 'Another campaign', t: 50, races: [{ RaceID: 7, raceName: 'Race', npr: false, snapshot: snapshotOf(50) }] })

    assert.ok(JSON.stringify(merged).includes('"t":200'), 'the snapshots of the first campaign are gone from the merged history')
  })

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

  invariant('queue demand', 'a project with no production type is never taken as construction: its demand and that of the colony\'s other projects are unknown, naming the type', () => {
    const projects = [queued({ ProductionType: null }), queued({ Queue: 2 })]
    const result = mineralOutlook.queueDemandResult(minerals.annualQueueDemand(projects, () => 1000), 'Duranium')

    assert.equal(result.status, 'unavailable')
    assert.ok(result.inputs.missing.some((name) => name.includes('production type')), `missing: ${result.inputs.missing}`)
  })

  invariant('queue demand', 'a project with no production type at another colony leaves this colony\'s demand known (control)', () => {
    const projects = [queued({ ProductionType: null, PopulationID: 2, Duranium: 0 }), queued()]
    const queue = minerals.annualQueueDemand(projects, () => 1000)

    assert.equal(queue.demand.Duranium, 50)
    assert.equal(mineralOutlook.queueDemandResult(queue, 'Duranium').status, 'estimated')
  })

  // ---- Page group C (provenance, unknown is not zero). Each page's cases go under its own marker; add the utility a case loads to the list in `main`. ----
  // ---- Shared formatting and history ----
  const mathUtilities = modules.math
  const coloniesUtilities = modules.colonies

  invariant('unknown formatting', 'a figure that is not known reads as a dash, never 0 (null, undefined, NaN, an empty string, infinity)', () => {
    ;[null, undefined, NaN, '', Infinity].forEach((value) => {
      assert.equal(mathUtilities.countText(value, 0, ','), '—', String(value))
      assert.equal(mathUtilities.separatedNumber(value, ','), '—', String(value))
      assert.equal(coloniesUtilities.people(value), '—', String(value))
    })
  })

  invariant('unknown formatting', 'a real 0 still reads 0 and a known figure is rounded and separated (control)', () => {
    assert.equal(mathUtilities.countText(0, 0, ','), '0')
    assert.equal(mathUtilities.countText(1234567.4, 0, ','), '1,234,567')
    assert.equal(mathUtilities.countText(12.34, 1, ','), '12.3')
    assert.equal(coloniesUtilities.people(0), '0')
    assert.equal(coloniesUtilities.people(1500), '1.5 bn')
  })

  // One race's snapshot from rows the recorder's reads would return.
  const savedSnapshot = async ({ race = { GameTime: 10, GameName: 'G', RaceTitle: 'R', WealthPoints: 100, AnnualWealth: 5 }, colonies = [], ships = [], installations = [], counts = { Research: 0, Systems: 0, Commanders: 0 } } = {}) => {
    const database = {
      query: async (sql) => {
        const rows = sql.startsWith('select FCT_Game.GameTime') ? [race] : sql.startsWith('select FCT_Population.Population') ? colonies : sql.startsWith('select FCT_ShipClass.Commercial') ? ships : sql.startsWith('select FCT_PopulationInstallations') ? installations : sql.startsWith('select (select case') ? [counts] : []

        return [rows]
      },
    }

    return (await history.takeSnapshot(database, { GameID: 1, RaceID: 7 })).snapshot
  }
  const colony = (extra = {}) => ({ Population: 10, FuelStockpile: 100, MaintenanceStockpile: 20, Duranium: 5, Neutronium: 0, Corbomite: 0, Tritanium: 0, Boronide: 0, Mercassium: 0, Vendarite: 0, Sorium: 0, Uridium: 0, Corundium: 0, Gallicite: 0, ...extra })

  invariant('history snapshot', 'a snapshot of complete rows sums them (control), and no ship of a kind is a known 0', async () => {
    const snapshot = await savedSnapshot({ colonies: [colony(), colony({ Population: 0 })], counts: { Research: 40, Systems: 3, Commanders: 2 } })

    assert.equal(snapshot.population, 10)
    assert.equal(snapshot.colonies, 1)
    assert.equal(snapshot.fuel, 200)
    assert.equal(snapshot.minerals[0], 10)
    assert.equal(snapshot.militaryShips, 0)
    assert.equal(snapshot.militaryTons, 0)
    assert.equal(snapshot.research, 40)
  })

  invariant('history snapshot', 'a colony with no stored population leaves the population and the colony count unknown, not the sum of the others', async () => {
    const snapshot = await savedSnapshot({ colonies: [colony(), colony({ Population: null })] })

    assert.equal(snapshot.population, null)
    assert.equal(snapshot.colonies, null)
    assert.equal(snapshot.fuel, 200)
  })

  invariant('history snapshot', 'a colony with no stored stockpile leaves that stockpile unknown and the others known', async () => {
    const snapshot = await savedSnapshot({ colonies: [colony(), colony({ Duranium: null, FuelStockpile: null })] })

    assert.equal(snapshot.fuel, null)
    assert.equal(snapshot.minerals[0], null)
    assert.equal(snapshot.minerals[1], 0)
    assert.equal(snapshot.msp, 40)
  })

  invariant('history snapshot', 'a missing treasury, tonnage, research total or installation amount is null in the snapshot, never 0', async () => {
    const snapshot = await savedSnapshot({ race: { GameTime: 10, GameName: 'G', RaceTitle: 'R', WealthPoints: null, AnnualWealth: null }, ships: [{ Commercial: 0, Ships: 2, Tons: null }], installations: [{ ID: 4, Amount: null }, { ID: 5, Amount: 3 }], counts: { Research: null, Systems: 1, Commanders: 1 } })

    assert.equal(snapshot.wealth, null)
    assert.equal(snapshot.income, null)
    assert.equal(snapshot.militaryShips, 2)
    assert.equal(snapshot.militaryTons, null)
    assert.equal(snapshot.research, null)
    assert.equal(snapshot.installations[4], null)
    assert.equal(snapshot.installations[5], 3)
  })

  invariant('history snapshot', 'a snapshot field is a result of its rule: a 0 is available, a null or an absent field is unavailable and names itself', () => {
    const real = history.snapshotResult({ population: 0 }, 'population')
    const none = history.snapshotResult({ population: null }, 'population')
    const old = history.snapshotResult({}, 'systems')

    assert.equal(real.status, 'confirmed')
    assert.equal(real.value, 0)
    assert.equal(none.status, 'unavailable')
    assert.equal(none.value, null)
    assert.deepEqual(none.inputs.missing, ['population'])
    assert.equal(old.status, 'unavailable')
    assert.equal(history.snapshotResult(null, 'systems').status, 'unavailable')
  })

  invariant('history snapshot', 'an installation type absent from a snapshot that lists installations is none built; unknown when the amount is null or no installations were kept', () => {
    assert.equal(history.installationResult({ installations: { 4: 2 } }, 9, 'Mine').value, 0)
    assert.equal(history.installationResult({ installations: { 4: 2 } }, 4, 'Mine').value, 2)
    assert.equal(history.installationResult({ installations: { 4: null } }, 4, 'Mine').status, 'unavailable')
    assert.equal(history.installationResult({}, 4, 'Mine').status, 'unavailable')
  })

  invariant('history snapshot', 'a change and a total over a figure that is unknown are unknown; over known ones they are exact', () => {
    const known = (value) => history.snapshotResult({ research: value }, 'research')

    assert.equal(history.changeResult(known(10), known(25)).value, 15)
    assert.equal(history.changeResult(known(0), known(0)).value, 0)
    assert.equal(history.changeResult(known(null), known(25)).status, 'unavailable')
    assert.equal(history.totalResult('history.fleetTonnage', [history.snapshotResult({ militaryTons: 4 }, 'militaryTons'), history.snapshotResult({ commercialTons: null }, 'commercialTons')]).status, 'unavailable')
    assert.equal(history.totalResult('history.fleetTonnage', [history.snapshotResult({ militaryTons: 4 }, 'militaryTons'), history.snapshotResult({ commercialTons: 6 }, 'commercialTons')]).value, 10)
  })

  // ---- Commanders ----
  const commanders = modules.commanders
  const admin = (id, bonuses, extra = {}) => ({ CommanderID: id, Name: `Admin ${id}`, CommanderType: 2, CommandType: 0, bonuses, ...extra })
  const colonyRow = (extra = {}) => ({ PopulationID: 1, PopName: 'Mars', GovernorID: 0, Population: 5, BonusOne: 25, BonusTwo: 0, BonusThree: 0, ...extra })
  const shipRow = (extra = {}) => ({ ShipID: 1, ShipName: 'Digger', ClassName: 'Miner', CaptainID: 0, ScienceOfficerID: 0, RankRequired: 2, Terraformers: 0, MiningModules: 3, Harvesters: 0, SciencePosts: 0, GeoSurvey: 0, GravSurvey: 0, ...extra })
  const officer = (id, bonuses, extra = {}) => ({ CommanderID: id, Name: `Officer ${id}`, CommanderType: 0, CommandType: 0, RankLevel: 2, bonuses, ...extra })
  const scientist = (id, bonuses, extra = {}) => ({ CommanderID: id, Name: `Scientist ${id}`, CommanderType: 3, CommandType: 0, ResSpecID: 1, bonuses, ...extra })
  const projectRow = (extra = {}) => ({ ProjectID: 1, ProjectName: 'Lasers', ScientistID: 0, ResSpecID: 1, Facilities: 2, ...extra })

  invariant('commanders', 'a bonus stored with no value parses to null, not 0 or NaN; a bonus never stored stays absent', () => {
    assert.deepEqual(commanders.parseBonuses('9:,25:6,6:1.15'), { 9: null, 25: 6, 6: 1.15 })
    assert.equal(commanders.parseBonuses('7:x')[7], null)
    assert.equal(commanders.parseBonuses('25:6')[27], undefined)
    assert.equal(commanders.formatBonus(6, null), '—')
  })

  invariant('commanders', 'a vacant colony and an unassigned administrator with the required bonus give an improvement (control)', () => {
    const review = commanders.governorReview([colonyRow()], [admin(1, { 25: 6 })])

    assert.equal(review.rows.length, 1)
    assert.equal(review.coverage.status[1], 'improvement')
    assert.equal(review.rows[0].result.status, 'estimated')
    assert.equal(review.coverage.vacant, 1)
  })

  invariant('commanders', 'a governor whose required bonus has no value cannot be rated: the colony is left out and the result names the commander', () => {
    const review = commanders.governorReview([colonyRow({ GovernorID: 2 })], [admin(1, { 25: 6 }), admin(2, { 25: null }, { CommandType: 3 })], { 25: 'Colony Administration' })

    assert.equal(review.rows.length, 0)
    assert.equal(review.unrated.length, 1)
    assert.equal(review.unrated[0].result.status, 'unavailable')
    assert.ok(review.unrated[0].result.inputs.missing.some((name) => name.includes('Admin 2')), `missing: ${review.unrated[0].result.inputs.missing}`)
    assert.equal(review.coverage.status[1], 'unknown')
  })

  invariant('commanders', 'a candidate with no value for the required bonus is neither a better candidate nor no change: a colony the others do not beat is unrated, one they beat stays an improvement that names the gap', () => {
    const unrated = commanders.governorReview([colonyRow({ GovernorID: 2 })], [admin(1, { 25: null }), admin(2, { 25: 6 }, { CommandType: 3 })])

    assert.equal(unrated.rows.length, 0)
    assert.equal(unrated.coverage.status[1], 'unknown')
    assert.equal(unrated.unrated[0].result.status, 'unavailable')

    const beaten = commanders.governorReview([colonyRow({ GovernorID: 2 })], [admin(1, { 25: null }), admin(3, { 25: 9 }), admin(2, { 25: 6 }, { CommandType: 3 })])

    assert.equal(beaten.rows.length, 1)
    assert.equal(beaten.rows[0].candidate.CommanderID, 3)
    assert.ok(beaten.rows[0].result.inputs.missing.some((name) => name.includes('Admin 1')))
  })

  invariant('commanders', 'a colony with no stored required bonus, or a vacant one with no stored population, is unknown and named, not unrated or counted vacant', () => {
    const review = commanders.governorReview([colonyRow({ BonusOne: null }), colonyRow({ PopulationID: 2, PopName: 'Venus', Population: null })], [admin(1, { 25: 6 })])

    assert.equal(review.coverage.status[1], 'unknown')
    assert.equal(review.coverage.status[2], 'unknown')
    assert.equal(review.unrated.length, 2)
    assert.equal(review.coverage.vacant, 1)
    assert.equal(review.coverage.results.vacant.status, 'estimated')
  })

  invariant('commanders', 'no colony, a colony with no required bonus set and a governor no administrator beats are known zeros', () => {
    assert.equal(commanders.governorReview([], []).rows.length, 0)
    assert.equal(commanders.governorReview([colonyRow({ BonusOne: 0 })], [admin(1, { 25: 6 })]).coverage.status[1], 'unrated')

    const review = commanders.governorReview([colonyRow({ GovernorID: 2 })], [admin(1, { 25: 3 }), admin(2, { 25: 6 }, { CommandType: 3 })])

    assert.equal(review.coverage.status[1], 'not-stronger')
    assert.equal(review.coverage.results.improvements.value, 0)
    assert.deepEqual(review.coverage.results.improvements.inputs.missing, [])
  })

  invariant('commanders', 'a specialist ship whose class modules or required rank are not stored has no post; stored ones give the post', () => {
    assert.equal(commanders.specialistPost(shipRow()).value.bonusId, 6)
    assert.equal(commanders.specialistPost(shipRow({ Terraformers: null })).status, 'unavailable')
    assert.equal(commanders.specialistPost(shipRow({ RankRequired: null })).status, 'unavailable')
    assert.equal(commanders.specialistPost(shipRow({ MiningModules: 0, Harvesters: null })).status, 'unavailable')
    assert.equal(commanders.specialistPost(shipRow({ MiningModules: 0, SciencePosts: 1 })).value.post, 'science')
  })

  invariant('commanders', 'a vacant ship post stays a row; an unrateable ship is listed with the reason and is not a candidate', () => {
    const review = commanders.shipSuggestions([shipRow(), shipRow({ ShipID: 2, ShipName: 'Odd', Terraformers: null }), shipRow({ ShipID: 3, ShipName: 'Held', CaptainID: 9 })], [officer(1, { 6: 1.3 })])

    assert.deepEqual(review.rows.map((row) => row.ship.ShipID), [1])
    assert.equal(review.rows[0].candidate.CommanderID, 1)
    assert.deepEqual(review.unrated.map((item) => item.ship.ShipID).sort(), [2, 3])
    assert.ok(review.unrated.every((item) => item.result.status === 'unavailable'))
  })

  invariant('commanders', 'a captain or an idle officer whose bonus has no value is not read as no bonus', () => {
    const held = commanders.shipSuggestions([shipRow({ CaptainID: 5 })], [officer(1, { 6: 1.3 }), officer(5, { 6: null }, { CommandType: 1 })])

    assert.equal(held.rows.length, 0)
    assert.equal(held.unrated.length, 1)
    assert.ok(held.unrated[0].result.inputs.missing.some((name) => name.includes('Officer 5')))

    const idle = commanders.shipSuggestions([shipRow({ CaptainID: 5 })], [officer(1, { 6: null }), officer(5, { 6: 1.1 }, { CommandType: 1 })])

    assert.equal(idle.rows.length, 0)
    assert.equal(idle.unrated.length, 1)
    assert.ok(idle.unrated[0].result.inputs.missing.some((name) => name.includes('Officer 1')))

    const sound = commanders.shipSuggestions([shipRow({ CaptainID: 5 })], [officer(1, { 6: 1.2 }), officer(5, { 6: 1.1 }, { CommandType: 1 })])

    assert.equal(sound.rows.length, 1)
    assert.equal(sound.unrated.length, 0)
  })

  invariant('commanders', 'a research multiplier with a missing Research value or field is unavailable; no stored row is ×1 and a stored row in the field counts four times', () => {
    assert.equal(commanders.researchMultiplier(scientist(1, { 3: 1.15 }), true).value.toFixed(2), '1.60')
    assert.equal(commanders.researchMultiplier(scientist(1, { 3: 1.15 }), false).value, 1.15)
    assert.equal(commanders.researchMultiplier(scientist(1, {}), true).value, 1)
    assert.equal(commanders.researchMultiplier(scientist(1, { 3: null }), true).status, 'unavailable')
    assert.equal(commanders.researchMultiplier(scientist(1, { 3: 1.15 }), null).status, 'unavailable')
  })

  invariant('commanders', 'a project with unknown labs and a same-field idle scientist is unrated, not skipped; a different field is skipped; a faster scientist at known labs is a row', () => {
    const noLabs = commanders.researchSuggestions([projectRow({ Facilities: null })], [scientist(1, { 3: 1.3, 27: 5 })])

    assert.equal(noLabs.rows.length, 0)
    assert.equal(noLabs.unrated.length, 1)
    assert.ok(noLabs.unrated[0].result.inputs.missing.some((name) => name.includes('Facilities')))
    assert.equal(commanders.researchSuggestions([projectRow({ Facilities: null })], [scientist(1, { 3: 1.3, 27: 5 }, { ResSpecID: 2 })]).unrated.length, 0)

    const faster = commanders.researchSuggestions([projectRow()], [scientist(1, { 3: 1.3, 27: 5 })])

    assert.equal(faster.rows.length, 1)
    assert.equal(faster.rows[0].candidateLabs, 5)
    assert.equal(commanders.researchSuggestions([projectRow({ ScientistID: 7 })], [scientist(1, { 3: 1.3, 27: 5 })]).unrated.length, 1)
  })

  invariant('commanders', 'the better-assignment count is a planner estimate that names the assignments it leaves out', () => {
    const none = { rows: [], unrated: [] }
    const some = { rows: [{}], unrated: [{}, {}] }

    assert.equal(commanders.bonusSuggestionCount(none, none, none).value, 0)
    assert.equal(commanders.bonusSuggestionCount(none, none, none).result.status, 'estimated')
    assert.equal(commanders.bonusSuggestionCount(some, none, none).unknown, 2)
    assert.ok(commanders.bonusSuggestionCount(some, none, none).result.inputs.missing.length > 0)
  })

  invariant('commanders', 'the unassigned count leaves out a commander with no stored post; a real unassigned commander and a real 0 count', () => {
    const people = [admin(1, {}), admin(2, {}, { CommandType: null }), admin(3, {}, { CommandType: 3 }), officer(4, {}, { CommandType: 0 })]
    const counts = commanders.commanderCounts(people)

    assert.equal(counts.idle, 2)
    assert.equal(counts.noPost, 1)
    assert.equal(counts.idleResult.status, 'estimated')
    assert.equal(commanders.commanderCounts([]).idle, 0)
    assert.equal(commanders.commanderCounts([]).idleResult.status, 'confirmed')
    assert.equal(commanders.assignmentResult(people[1]).status, 'unavailable')
    assert.equal(commanders.assignmentResult(people[0]).value, true)
    assert.equal(commanders.commanderCounts(people, 3).totalResult.status, 'estimated')
  })

  invariant('commanders', 'specialist ships without a captain skip ships whose class modules are unknown and say how many', () => {
    const result = commanders.captainlessShips([shipRow(), shipRow({ ShipID: 2, MiningModules: 0 }), shipRow({ ShipID: 3, MiningModules: null, Terraformers: 0, Harvesters: 0, GeoSurvey: 0, GravSurvey: 0 }), shipRow({ ShipID: 4, CaptainID: 8 })])

    assert.equal(result.value, 1)
    assert.equal(result.unknown, 1)
    assert.equal(result.result.status, 'estimated')
    assert.equal(commanders.captainlessShips([]).result.status, 'confirmed')
  })

  invariant('commanders', 'kills, medals and age with a missing input are unavailable and name it; zero kills, no medals and a real age are values', () => {
    assert.equal(commanders.killsResult({ Name: 'A', KillTonnageMilitary: 100, KillTonnageCommercial: 50 }).value, 150)
    assert.equal(commanders.killsResult({ Name: 'A', KillTonnageMilitary: 0, KillTonnageCommercial: 0 }).value, 0)

    const kills = commanders.killsResult({ Name: 'A', KillTonnageMilitary: 100, KillTonnageCommercial: null })

    assert.equal(kills.status, 'unavailable')
    assert.ok(kills.inputs.missing[0].includes('KillTonnageCommercial'))
    assert.equal(commanders.medalsResult({ Name: 'A', Medals: null, MedalCount: null }).value, 0)
    assert.equal(commanders.medalsResult({ Name: 'A', Medals: 'Star', MedalCount: 2 }).value, 2)
    assert.equal(commanders.medalsResult({ Name: 'A', Medals: 'Star', MedalCount: null }).status, 'unavailable')
    assert.equal(commanders.ageResult({ Name: 'A', GraduationAge: 21, CareerStart: 0 }, 31536000 * 4).value, 25)
    assert.equal(commanders.ageResult({ Name: 'A', GraduationAge: null, CareerStart: 0 }, 1).status, 'unavailable')
    assert.equal(commanders.ageResult({ Name: 'A', GraduationAge: 21, CareerStart: null }, 1).status, 'unavailable')
    assert.equal(commanders.ageResult({ Name: 'A', GraduationAge: 21, CareerStart: 0 }, null, 'the time of the last career record').inputs.missing[0], 'the time of the last career record')
  })

  invariant('commanders', 'a career record with no stored time or no game start year has no date', () => {
    assert.equal(commanders.recordDate(2025, null).status, 'unavailable')
    assert.equal(commanders.recordDate(0, 100).status, 'unavailable')
    assert.equal(commanders.recordDate(null, 100).status, 'unavailable')
  })

  invariant('commanders', 'former groups count their own rows; commanders with no stored status make each a lower bound; the held group is known', () => {
    const former = [{ kind: 'dead' }, { kind: 'dead' }, { kind: 'retired' }]
    const counts = commanders.formerGroupCounts(former, [{}], 0)

    assert.equal(counts.dead.value, 2)
    assert.equal(counts.prisoner.value, 0)
    assert.equal(counts.prisoner.status, 'confirmed')

    const bounded = commanders.formerGroupCounts(former, [{}], 2)

    assert.equal(bounded.dead.status, 'estimated')
    assert.ok(bounded.dead.inputs.missing.length > 0)
    assert.equal(bounded.held.status, 'confirmed')
  })

  invariant('commanders', 'every commanders rule is registered once with a verification and a rank label falls back to a dash only for an officer', () => {
    const { getRule } = modules.provenance

    ;['count', 'unassigned', 'vacantGovernor', 'captainless', 'governorBonus', 'specialistPost', 'shipBonus', 'researchMultiplier', 'researchSuggestion', 'bonusSuggestion', 'kills', 'age', 'medals', 'groupCount', 'bonusValue', 'recordDate'].forEach((name) => assert.ok(getRule(`commanders.${name}`), name))
    assert.equal(commanders.rankLabel({ CommanderType: 2 }), 'Administrator')
    assert.equal(commanders.rankLabel({ CommanderType: 0 }), '—')
    assert.equal(commanders.rankLabel({ CommanderType: 3, FieldName: 'Energy' }), 'Energy')
  })
  // ---- Designed tech and technologies ----
  const research = modules.research
  const designedTech = modules['designed-tech']
  const provenance = modules.provenance
  const counter = { count: (value) => (value === null || value === undefined ? '—' : String(value)) }
  const labProject = (extra = {}) => ({ ProjectID: 1, Name: 'Lasers', CommanderID: 9, ResearchBonus: 1, ScientistField: 1, FieldID: 1, OutputPerLab: 10, Facilities: 3, Pause: 0, ResearchPointsRequired: 300, LocalConstructField: null, LocalConstructBonus: null, ...extra })
  const techRow = (id, extra = {}) => ({ TechSystemID: id, Name: `Tech ${id}`, DevelopCost: 100, FieldID: 1, TechTypeID: 1, TypeName: 'Type', RaceID: 0, Prerequisite1: 0, Prerequisite2: 0, ...extra })
  const componentRow = (extra = {}) => ({ SDComponentID: 1, Name: 'Armour', CategoryID: 1, ComponentTypeID: 1, ComponentValue: 10, Size: 2, Cost: 4, Obsolete: 0, MilitarySystem: 1, ShippingLineSystem: 0, Baseline: 0, ...extra })

  invariant('research', 'a project with no scientist makes no known rate: its rate is unavailable, the output leaves it out and names it (control: a project with one counts)', () => {
    const schedule = research.scheduleProjects([labProject({ ProjectID: 1, Name: 'Staffed' }), labProject({ ProjectID: 2, Name: 'Unstaffed', CommanderID: 0 })], [], new Map())
    const output = research.outputResult(schedule)

    assert.equal(schedule[0].rate, 30)
    assert.equal(schedule[1].rate, null)
    assert.equal(schedule[1].rateResult.status, 'unavailable')
    assert.equal(output.result.value, 30)
    assert.equal(output.unknown, 1)
    assert.ok(output.result.inputs.missing.some((name) => name.includes('Unstaffed')), `missing: ${output.result.inputs.missing}`)
  })

  invariant('research', 'a paused project makes a known 0; every project unrated leaves the output unavailable and no projects at all a known 0', () => {
    const paused = research.outputResult(research.scheduleProjects([labProject({ Pause: 1 })], [], new Map()))
    const unrated = research.outputResult(research.scheduleProjects([labProject({ CommanderID: 0 }), labProject({ ProjectID: 2, OutputPerLab: null })], [], new Map()))
    const none = research.outputResult([])

    assert.equal(paused.result.value, 0)
    assert.equal(paused.result.status, 'estimated')
    assert.equal(unrated.result.status, 'unavailable')
    assert.equal(none.result.value, 0)
  })

  invariant('research', 'a project missing its labs, output per lab, scientist bonus or field has an unavailable rate that names the input', () => {
    ;[['Facilities', 'labs'], ['OutputPerLab', 'output per lab'], ['ResearchBonus', 'Research bonus'], ['FieldID', 'field']].forEach(([field, word]) => {
      const [project] = research.scheduleProjects([labProject({ [field]: null })], [], new Map())

      assert.equal(project.rateResult.status, 'unavailable', field)
      assert.ok(project.rateResult.inputs.missing.some((name) => name.includes(word)), `${field}: ${project.rateResult.inputs.missing}`)
      assert.equal(project.rate, null, field)
    })
  })

  invariant('research', 'a paused project and one with an unstored pause flag have no landing; the flag is named', () => {
    const [paused, unknownFlag] = research.scheduleProjects([labProject({ Pause: 1 }), labProject({ ProjectID: 2, Pause: null })], [], new Map())

    assert.equal(paused.yearsResult.status, 'unavailable')
    assert.equal(unknownFlag.yearsResult.status, 'unavailable')
    assert.ok(unknownFlag.yearsResult.inputs.missing.some((name) => name.includes('pause flag')))
    assert.equal(research.outputResult([unknownFlag]).result.status, 'unavailable')
  })

  invariant('research', 'a queued tech with no stored cost or banked points has no years and the unknown carries to every tech behind it', () => {
    const queue = [{ CurrentProjectID: 1, ResearchOrder: 1, TechID: 11, FieldID: 1, DevelopCost: null, Name: 'First' }, { CurrentProjectID: 1, ResearchOrder: 2, TechID: 12, FieldID: 1, DevelopCost: 100, Name: 'Second' }]
    const [project] = research.scheduleProjects([labProject()], queue, new Map())

    assert.equal(project.queue[0].years, null)
    assert.equal(project.queue[1].years, null)
    assert.equal(project.queue[1].yearsResult.status, 'unavailable')
    assert.equal(project.years, 10)
  })

  invariant('research', 'a tech whose cost or banked points are unknown has no remaining RP, and its path is unknown too; known ones add up (control)', () => {
    const graph = research.buildTechGraph([techRow(1), techRow(2, { Prerequisite1: 1 }), techRow(3, { DevelopCost: null, Prerequisite1: 2 })])
    const info = research.evaluateResearch(graph, research.researchState({ raceId: 1, researched: [], projects: [] }))

    assert.equal(info.get(2).remaining, 100)
    assert.equal(info.get(2).pathRp, 200)
    assert.equal(research.pathRpResult(info.get(2)).value, 200)
    assert.equal(info.get(3).remaining, null)
    assert.equal(info.get(3).pathRp, null)
    assert.equal(research.remainingResult(info.get(3)).status, 'unavailable')
    assert.ok(research.pathRpResult(info.get(3)).inputs.missing.some((name) => name.includes('Tech 3')))

    const banked = research.evaluateResearch(graph, research.researchState({ raceId: 1, researched: [], paused: [{ TechSystemID: 1, PointsAccumulated: null }] }))

    assert.equal(banked.get(1).remaining, null)
    assert.equal(banked.get(2).pathRp, null)
  })

  invariant('research', 'the share researched is unavailable when nothing is reachable, not 0%; with techs it is the exact share', () => {
    const none = research.researchedResults({ done: 0, active: 0, queued: 0, available: 0, locked: 0, blocked: 4 })
    const some = research.researchedResults({ done: 1, active: 0, queued: 0, available: 1, locked: 2, blocked: 0 })

    assert.equal(none.share.status, 'unavailable')
    assert.equal(none.done.value, 0)
    assert.equal(some.share.value, 0.25)
  })

  invariant('research', 'built labs are unavailable when a colony count is not stored, and a real 0 is known; idle follows both and never goes below 0', () => {
    const schedule = research.scheduleProjects([labProject({ Facilities: 4 })], [], new Map())
    const unknown = research.labsResults([{ Labs: 6 }, { Labs: null }], schedule)
    const zero = research.labsResults([{ Labs: 0 }], schedule)
    const ample = research.labsResults([{ Labs: 6 }, { Labs: 2 }], schedule)

    assert.equal(unknown.built.status, 'unavailable')
    assert.equal(unknown.idle.status, 'unavailable')
    assert.equal(zero.built.value, 0)
    assert.equal(zero.idle.value, 0)
    assert.equal(zero.over, 4)
    assert.equal(ample.idle.value, 4)
    assert.equal(research.labsResults([], []).built.value, 0)
  })

  invariant('research', 'the next landing is unavailable without a running project with a rate, and without the game clock, naming what is missing', () => {
    const running = research.scheduleProjects([labProject()], [], new Map())
    const unrated = research.scheduleProjects([labProject({ CommanderID: 0 })], [], new Map())

    assert.equal(research.nextLandingResult(running, { StartYear: 2000, GameTime: 0 }).result.value, 10)
    assert.equal(research.nextLandingResult(unrated, { StartYear: 2000, GameTime: 0 }).result.status, 'unavailable')
    assert.equal(research.nextLandingResult([], { StartYear: 2000, GameTime: 0 }).result.status, 'unavailable')
    assert.ok(research.nextLandingResult(running, { StartYear: null, GameTime: null }).result.inputs.missing.includes('the game start year'))
  })

  invariant('research', 'a project whose scientist field is not stored has no rate (it decides the fourfold bonus), and a project that may be running with no landing time is counted against the next landing', () => {
    const rate = (extra) => research.annualResearchPointsResult(labProject(extra), 1)

    assert.equal(rate({ ScientistField: null }).status, 'unavailable')
    assert.ok(rate({ ScientistField: null }).inputs.missing.includes('the scientist\'s research field'))
    assert.equal(typeof rate({}).value, 'number')

    const clock = { StartYear: 2000, GameTime: 0 }
    const known = labProject()
    const unrated = labProject({ ProjectID: 2, Name: 'Shields', OutputPerLab: null })
    const unflagged = labProject({ ProjectID: 3, Name: 'Engines', Pause: null })
    const paused = labProject({ ProjectID: 4, Name: 'Armour', Pause: 1 })
    const mixed = research.nextLandingResult(research.scheduleProjects([known, unrated, unflagged, paused], [], new Map()), clock)
    const onlyUnknown = research.nextLandingResult(research.scheduleProjects([unrated, paused], [], new Map()), clock)
    const settled = research.nextLandingResult(research.scheduleProjects([known, paused], [], new Map()), clock)

    assert.equal(mixed.project.Name, 'Lasers')
    assert.equal(mixed.unknown, 2)
    assert.ok(mixed.result.inputs.missing.some((name) => name.includes('Shields')))
    assert.ok(mixed.result.inputs.missing.some((name) => name.includes('Engines')))
    assert.equal(onlyUnknown.project, null)
    assert.equal(onlyUnknown.unknown, 1)
    assert.equal(onlyUnknown.result.status, 'unavailable')
    assert.equal(settled.unknown, 0)
  })

  invariant('research', 'the scientist queries keep a neutral bonus only when the bonus row is absent; a stored row with no value stays unknown', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../src/renderer/pages/technologies.vue'), 'utf8')
    const research3 = source.match(/case when JOI_Research\.CommanderID is null then 1 else JOI_Research\.BonusValue end as ResearchBonus/g) || []
    const admin27 = source.match(/case when JOI_Admin\.CommanderID is null then 0 else JOI_Admin\.BonusValue end as MaxLabs/g) || []

    assert.equal(research3.length, 2)
    assert.equal(admin27.length, 2)
    assert.ok(!/(ifnull|coalesce)\(JOI_(Research|Admin)\.BonusValue/i.test(source))
  })

  invariant('research', 'the starting tech points are unavailable when the race row or its column is not stored, and a stored 0 is known', () => {
    assert.equal(research.startPointsResult(null).status, 'unavailable')
    assert.equal(research.startPointsResult({ StartTechPoints: null }).status, 'unavailable')
    assert.equal(research.startPointsResult({ StartTechPoints: 0 }).value, 0)
    assert.equal(research.startPointsResult({ StartTechPoints: 120 }).value, 120)
  })

  invariant('designed tech', 'a figure per hull space or per BP is unavailable where the size or cost is not stored or not above 0, and exact where it is (control)', () => {
    const complete = designedTech.augmentComponent(componentRow())
    const noSize = designedTech.augmentComponent(componentRow({ Size: null }))
    const zeroSize = designedTech.augmentComponent(componentRow({ Size: 0 }))
    const noCost = designedTech.augmentComponent(componentRow({ Cost: null }))

    assert.equal(complete.MeasurePerHS, 5)
    assert.equal(complete.MeasurePerCost, 2.5)
    assert.equal(designedTech.figureResult(complete, 'MeasurePerHS').status, 'estimated')
    ;[noSize, zeroSize].forEach((item) => {
      assert.equal(item.MeasurePerHS, null)
      assert.equal(designedTech.figureResult(item, 'MeasurePerHS').status, 'unavailable')
    })
    assert.equal(noCost.MeasurePerCost, null)
    assert.equal(noCost.MeasurePerHS, 5)
    assert.ok(designedTech.figureResult(noCost, 'MeasurePerCost').inputs.missing.some((name) => name.includes('build cost')))
  })

  invariant('designed tech', 'a beam weapon with no stored damage, shots or capacitor figure has no damage, interval or damage per second; it never works out as 0 or NaN', () => {
    const beam = (extra) => designedTech.augmentComponent(componentRow({ CategoryID: 2, ComponentTypeID: 2, DamageOutput: 4, NumberOfShots: 1, MaxWeaponRange: 100, RangeModifier: 1, PowerRequirement: 6, RechargeRate: 3, ...extra }))

    assert.equal(beam({}).DamagePerSecond, 0.4)
    assert.equal(beam({ DamageOutput: null }).TotalDamage, null)
    assert.equal(beam({ DamageOutput: null }).DamagePerSecond, null)
    assert.equal(beam({ RechargeRate: null }).Interval, null)
    assert.equal(beam({ RechargeRate: 0 }).Interval, null)
    assert.equal(beam({ PowerRequirement: 0, RechargeRate: null }).Interval, 5)
  })

  invariant('designed tech', 'a cell for a stored figure that is null reads a dash with an unavailable result, while a design that has none reads a dash without one', () => {
    const column = designedTech.columnsFor(13).find((entry) => entry.value === 'Resolution')
    const unknown = designedTech.cellOf(column, { Resolution: null }, counter)
    const none = designedTech.cellOf(column, { Resolution: 0 }, counter)
    const known = designedTech.cellOf(column, { Resolution: 5 }, counter)

    assert.equal(unknown.text, '—')
    assert.equal(unknown.result.status, 'unavailable')
    assert.deepEqual(unknown.result.inputs.missing, ['Resolution'])
    assert.equal(none.text, '—')
    assert.equal(none.result, null)
    assert.equal(known.text, '5')
  })

  invariant('designed tech', 'a design on no class has 0 classes and 0 ships; a class mount that cannot be attributed makes the counts unknown, never 0', () => {
    const item = designedTech.augmentComponent(componentRow())
    const [classes, ships] = designedTech.USAGE_COLUMNS
    const empty = designedTech.withUsage(item, designedTech.classUsageByComponent([]))
    const lost = designedTech.withUsage(item, designedTech.classUsageByComponent([{ ComponentID: null, ClassID: 3, NumComponent: 1, ClassName: 'Lost', Obsolete: 0, Ships: 2 }]))

    assert.equal(empty.classCount, 0)
    assert.equal(empty.shipCount, 0)
    assert.equal(designedTech.cellOf(classes, empty, counter).text, '0')
    assert.equal(designedTech.cellOf(ships, empty, counter).text, '0')
    assert.equal(lost.classCount, null)
    assert.equal(designedTech.cellOf(classes, lost, counter).text, '—')
    assert.equal(designedTech.cellOf(classes, lost, counter).result.status, 'unavailable')
    assert.equal(designedTech.isUnused(lost), false)
  })

  invariant('designed tech', 'a class that mounts a design with no stored count or ship total leaves the counts unknown and names it; classes with known figures sum (control)', () => {
    const item = designedTech.augmentComponent(componentRow())
    const mounts = [{ ComponentID: 1, ClassID: 3, NumComponent: 2, ClassName: 'A', Obsolete: 0, Ships: 4 }, { ComponentID: 1, ClassID: 4, NumComponent: 1, ClassName: 'B', Obsolete: 0, Ships: 5 }]
    const sum = designedTech.withUsage(item, designedTech.classUsageByComponent(mounts))
    const open = designedTech.withUsage(item, designedTech.classUsageByComponent([mounts[0], { ...mounts[1], Ships: null, NumComponent: null }]))

    assert.equal(sum.classCount, 2)
    assert.equal(sum.shipCount, 9)
    assert.equal(open.classCount, 2)
    assert.equal(open.shipCount, null)
    assert.equal(open.classes[1].perShip, null)
    assert.ok(open.usageGaps.some((name) => name.includes('ships')))
  })

  invariant('designed tech', 'the tiles of a missile or species category have no in-use or unused figure; a mountable category counts known usage and names the designs without it', () => {
    const mountable = designedTech.augmentComponent(componentRow())
    const used = designedTech.withUsage(mountable, designedTech.classUsageByComponent([{ ComponentID: 1, ClassID: 3, NumComponent: 1, ClassName: 'A', Obsolete: 0, Ships: 2 }]))
    const idle = designedTech.withUsage({ ...mountable, SDComponentID: 2 }, designedTech.classUsageByComponent([]))
    const lost = { ...idle, SDComponentID: 3, classCount: null, shipCount: null }
    const tile = (tiles, label) => tiles.find((entry) => entry.label === label)
    const complete = designedTech.designTiles({ rows: [used, idle], shown: 2, mountable: true, f: counter })
    const partial = designedTech.designTiles({ rows: [used, idle, lost], shown: 3, mountable: true, f: counter })
    const missile = designedTech.designTiles({ rows: [designedTech.augmentMissile({ MissileID: 1, Name: 'M', Obsolete: 1, Size: 1, Cost: 1, MaxRange: 1, WarheadStrength: 1, ShipDecoy: 0 })], shown: 1, mountable: false, f: counter })

    assert.equal(tile(complete, 'In use').result.value, 1)
    assert.equal(tile(complete, 'Unused').result.value, 1)
    assert.equal(tile(complete, 'In use').result.status, 'confirmed')
    assert.equal(tile(partial, 'In use').result.status, 'estimated')
    assert.equal(tile(partial, 'In use').result.value, 1)
    assert.ok(tile(partial, 'In use').result.inputs.missing.length > 0)
    assert.equal(tile(missile, 'In use').result.status, 'unavailable')
    assert.equal(tile(missile, 'Unused').result.status, 'unavailable')
    assert.equal(tile(missile, 'Obsolete').result.value, 1)
  })

  invariant('designed tech', 'a compared figure that one design lacks takes no part in best and worst and the verdict says how many were ranked; one figure alone gives no verdict', () => {
    const column = designedTech.columnsFor(1).find((entry) => entry.value === 'Cost')
    const design = (id, extra) => designedTech.augmentComponent(componentRow({ SDComponentID: id, Name: `Design ${id}`, ...extra }))
    const compare = (rows) => designedTech.compareMarks(column, rows, rows.map((row) => designedTech.cellOf(column, row, counter)), true)
    const full = compare([design(1, { Cost: 4 }), design(2, { Cost: 8 }), design(3, { Cost: 6 })])
    const open = compare([design(1, { Cost: 4 }), design(2, { Cost: null }), design(3, { Cost: 6 })])
    const alone = compare([design(1, { Cost: 4 }), design(2, { Cost: null }), design(3, { Cost: null })])

    assert.deepEqual(full.marks.map((mark) => mark.verdict), ['best', 'worst', null])
    assert.equal(full.note, '')
    assert.equal(open.marks[1].mark, null)
    assert.deepEqual([open.marks[0].verdict, open.marks[2].verdict], ['best', 'worst'])
    assert.equal(open.verdict.status, 'estimated')
    assert.equal(open.verdict.value, 2)
    assert.ok(open.verdict.inputs.missing.some((name) => name.includes('Design 2')))
    assert.ok(open.note.includes('2 of 3'))
    assert.ok(alone.marks.every((mark) => mark.mark === null))
    assert.equal(alone.verdict.status, 'unavailable')
    assert.ok(alone.note.includes('only 1 of 3'))
  })

  invariant('designed tech', 'a missile whose second stage flag is not stored has no total range and no stage text and takes no part in ranking; an explicit 0 is a single stage (control)', () => {
    const column = designedTech.columnsFor(4).find((entry) => entry.value === 'TotalRange')
    const stage = designedTech.columnsFor(4).find((entry) => entry.value === 'SecondStage')
    const missile = (id, extra) => designedTech.augmentMissile({ MissileID: id, Name: `Missile ${id}`, Obsolete: 0, Size: 1, Cost: 1, MaxRange: 5e6, WarheadStrength: 1, ShipDecoy: 0, SecondStageID: 0, ...extra })
    const open = missile(2, { SecondStageID: null, MaxRange: 9e6 })
    const single = missile(1)
    const staged = missile(3, { SecondStageID: 7, SecondStageMaxRange: 2e6, NumSS: 2, SecondStageName: 'Sub' })
    const rows = [single, open, staged]
    const marks = designedTech.compareMarks(column, rows, rows.map((row) => designedTech.cellOf(column, row, counter)), true)

    assert.equal(open.TotalRange, null)
    assert.equal(designedTech.cellOf(column, open, counter).result.status, 'unavailable')
    assert.ok(designedTech.cellOf(column, open, counter).result.inputs.missing.includes('whether the missile has a second stage'))
    assert.equal(designedTech.cellOf(column, open, counter).title, '')
    assert.equal(designedTech.cellOf(stage, open, counter).unknown, true)
    assert.deepEqual(designedTech.cellOf(stage, open, counter).result.inputs.missing, ['whether the missile has a second stage'])
    assert.equal(single.TotalRange, 5e6)
    assert.equal(designedTech.cellOf(column, single, counter).title, 'Single stage')
    assert.equal(staged.TotalRange, 7e6)
    assert.equal(staged.SecondStage, '2 × Sub')
    assert.equal(marks.marks[1].mark, null)
    assert.deepEqual([marks.marks[0].verdict, marks.marks[2].verdict], ['worst', 'best'])
  })

  invariant('designed tech', 'every designed tech rule is registered once with a verification and every figure column of a category names a registered rule', () => {
    const rules = provenance.listRules().filter((entry) => entry.id.startsWith('designedTech.'))

    assert.ok(rules.length > 10)
    rules.forEach((entry) => assert.ok(['confirmed', 'estimated', 'assumed'].includes(entry.verification), entry.id))
    ;[1, 2, 3, 4, 7, 12, 13, 22, 34, 35, 41, 47, 48].forEach((categoryId) => designedTech.columnsFor(categoryId).forEach((column) => {
      const rule = designedTech.columnRule(column)

      assert.ok(rule === null || provenance.getRule(rule), `${categoryId} ${column.text}: ${rule}`)
    }))
  })

  invariant('designed tech', 'the designs table sorts a design with no figure after every other one in both directions, and a real 0 sorts as 0', () => {
    const rows = [{ Name: 'b', Cost: null }, { Name: 'a', Cost: 3 }, { Name: 'c', Cost: 0 }, { Name: 'd' }, { Name: 'e', Cost: NaN }, { Name: 'f', Cost: 1 }]
    const names = (desc) => designedTech.sortRows(rows, ['Cost'], [desc]).map((row) => row.Name).join('')

    assert.equal(names(false).slice(0, 3), 'cfa')
    assert.equal(names(true).slice(0, 3), 'afc')
    assert.equal(names(false).slice(3).split('').sort().join(''), 'bde')
    assert.equal(names(true).slice(3).split('').sort().join(''), 'bde')
    assert.equal(designedTech.sortRows(rows, [], []), rows)
  })
  // ---- Production and logistics ----
  const production = modules.production
  const logistics = modules.logistics
  const colonyModifiers = { OverallResearchModifier: 2, ShipyardBuildRate: 1000, OverallGroundUnitModifier: 50, MinConstructionPeriod: 5 * 86400, ShipyardOperations: 1 }
  const terraform = modules['terraform-capacity']
  const colonyOf = (extra = {}) => ({ installations: 0, radius: 6000, modifier: { governor: 1, sector: 1, efficiency: 1, radiation: 0, unrest: 0, status: 1 }, ships: [], ...extra })
  const shipOf = (extra = {}) => ({ ShipID: 1, PopulationID: 1, ParentCommandID: 0, FleetSystemID: 1, crew: 1, captain: 1, captained: true, modules: 100, ...extra })
  const rateOf = (source, { raceRate = 0.001, speed = 100 } = {}) => terraform.terraformBreakdown({ raceRate, speed, source, admins: {} }).rate
  const researchRow = (extra = {}) => ({ Facilities: 4, ActualCommanderResearchBonus: 1.5, ActualAnomalyBonus: 1, CommanderField: 3, ...extra })
  const industryRow = (id, extra = {}) => ({ ID: id, ProductionType: 0, Percentage: 50, Amount: 10, ProdPerUnit: 100, Queue: 0, Paused: 0, ...extra })
  const capacityResult = (value) => (value === null ? provenance.unavailable({ rule: 'production.industryRate', missing: ['the colony\'s production modifiers'] }) : provenance.ofRule({ rule: 'production.industryRate', value, inputs: { present: ['capacity'] } }))

  invariant('production', 'every production and logistics rule the pages show is registered with a verification and its units', () => {
    ;['jobCount', 'capacityFree', 'trainingCapacity', 'researchLabs', 'slipways', 'researchRate', 'industryRate', 'shipRate', 'shipyardUpgradeRate', 'trainingRate', 'terraformRate', 'shipyardContinual', 'researchFinish', 'industryFinish', 'shipFinish', 'shipyardUpgradeFinish', 'trainingFinish', 'terraformFinish', 'timeline', 'shortage'].forEach((key) => {
      const rule = provenance.getRule(`production.${key}`)

      assert.ok(rule && ['confirmed', 'estimated', 'assumed'].includes(rule.verification) && rule.units, key)
    })
    ;['refineryOutput', 'soriumLasts', 'mspProduction', 'mspOutput', 'maintenanceLocation'].forEach((key) => assert.ok(provenance.getRule(`logistics.${key}`), key))
  })

  invariant('production', 'a research rate with no scientist takes no bonus and says so, and a missing modifier row or facility count leaves it unavailable, never 0', () => {
    const alone = production.researchRate(colonyModifiers, researchRow({ CommanderField: null, ActualCommanderResearchBonus: 1 }))

    assert.equal(alone.value, 8)
    assert.ok(alone.assumptions.some((text) => text.includes('No scientist')))
    assert.equal(production.researchRate(colonyModifiers, researchRow()).value, 12)
    assert.equal(production.researchRate(undefined, researchRow()).status, 'unavailable')
    assert.ok(production.researchRate(undefined, researchRow()).inputs.missing.includes('the colony\'s production modifiers'))
    assert.equal(production.researchRate(colonyModifiers, researchRow({ Facilities: null })).status, 'unavailable')
    assert.equal(production.researchRate(colonyModifiers, researchRow({ Facilities: 0 })).value, 0)
  })

  invariant('production', 'an industrial project with an unknown capacity has no rate and no finish and is not idle, while a real 0 capacity is a rate of 0 and an idle job', () => {
    const unknown = production.industryFigures([industryRow(1)], capacityResult(null))[0]

    assert.equal(unknown.rate.status, 'unavailable')
    assert.equal(unknown.finish.result.status, 'unavailable')
    assert.equal(unknown.finish.idle, false)
    assert.equal(unknown.start, null)

    const none = production.industryFigures([industryRow(1)], capacityResult(0))[0]

    assert.equal(none.rate.value, 0)
    assert.equal(none.finish.result.status, 'unavailable')
    assert.equal(none.finish.idle, true)

    const running = production.industryFigures([industryRow(1)], capacityResult(1000))[0]

    assert.equal(running.rate.value, 500)
    assert.equal(Math.round(running.finish.result.value), Math.round((10 * 100 / 500) * 365))
    assert.equal(running.start, 0)
  })

  invariant('production', 'a queued industrial project starts when the project ahead of it ends, and a group that lacks a figure leaves the queued project without a start while the running one keeps its finish', () => {
    const group = [industryRow(1, { Percentage: 100 }), industryRow(2, { Percentage: 100, Queue: 1 })]
    const figures = production.industryFigures(group, capacityResult(1000))

    assert.equal(figures[0].start, 0)
    assert.equal(Math.round(figures[1].start), Math.round(figures[0].finish.result.value))

    const gap = production.industryFigures([industryRow(1, { Percentage: 100 }), industryRow(2, { Percentage: 100, Queue: 1, Amount: null })], capacityResult(1000))

    assert.equal(gap[0].finish.result.status, 'estimated')
    assert.equal(gap[0].rate.value, 1000)
    assert.equal(gap[1].start, null)
    assert.equal(gap[1].finish.result.status, 'unavailable')
    assert.equal(gap[1].finish.idle, false)
  })

  invariant('production', 'the idle share of a capacity is unavailable while a running project\'s share is unknown, 0 with a statement while the work holds over 100%, and a colony with no work has all of it idle', () => {
    const total = capacityResult(1000)

    assert.equal(production.freeCapacity(total, undefined).free.value, 1000)
    assert.equal(production.freeCapacity(total, { used: 40, missing: [] }).free.value, 600)

    const over = production.freeCapacity(total, { used: 120, missing: [] }).free

    assert.equal(over.value, 0)
    assert.ok(over.assumptions.some((text) => text.includes('nothing is idle')))
    assert.equal(production.freeCapacity(total, { used: 0, missing: ['a running project\'s share of the capacity'] }).free.status, 'unavailable')
    assert.equal(production.freeCapacity(capacityResult(null), undefined).free.status, 'unavailable')
    assert.equal(production.industryUsage([industryRow(1, { PopulationID: 7, Queue: null })])['7-construction'].missing.length, 1)
    assert.equal(production.industryUsage([industryRow(1, { PopulationID: 7, Queue: 2, Percentage: null })])['7-construction'].used, 0)
  })

  invariant('production', 'a project with no production type is an unknown category, never construction: its rate and finish name the type, nothing is charged or freed by it, and the starts behind it are unavailable', () => {
    assert.equal(production.categoryOf(null), 'unknown')
    assert.equal(production.categoryOf(undefined), 'unknown')
    assert.equal(production.categoryOf(0), 'construction')
    assert.equal(production.categoryOf(3), 'construction')
    assert.equal(production.categoryOf(1), 'ordnance')
    assert.equal(production.categoryOf(2), 'fighter')

    const unknownProject = industryRow(1, { PopulationID: 7, ProductionType: null, Name: 'Mystery' })
    const unknown = production.industryFigures([unknownProject], production.unknownKindCapacity())[0]

    assert.equal(unknown.rate.status, 'unavailable')
    assert.ok(unknown.rate.inputs.missing.some((text) => text.includes('production type')))
    assert.equal(unknown.finish.result.status, 'unavailable')
    assert.ok(unknown.finish.result.inputs.missing.some((text) => text.includes('production type')))
    assert.equal(unknown.finish.idle, false)

    const usage = production.industryUsage([unknownProject, industryRow(2, { PopulationID: 7, ProductionType: 0, Percentage: 30 })])

    ;['construction', 'ordnance', 'fighter'].forEach((category) => {
      assert.ok(usage[`7-${category}`].missing.some((text) => text.includes('production type') && text.includes('Mystery')), category)
      assert.equal(production.freeCapacity(capacityResult(1000), usage[`7-${category}`]).free.status, 'unavailable', category)
    })

    assert.equal(usage['7-construction'].used, 30)
    assert.equal(usage['7-unknown'], undefined)

    const queuedUnknown = production.industryUsage([industryRow(1, { PopulationID: 7, ProductionType: null, Queue: 2 }), industryRow(2, { PopulationID: 7, ProductionType: 1, Percentage: 30 })])

    assert.equal(queuedUnknown['7-construction'], undefined)
    assert.equal(queuedUnknown['7-fighter'], undefined)
    assert.deepEqual(queuedUnknown['7-ordnance'], { used: 30, missing: [] })
    assert.equal(production.industryUsage([industryRow(1, { PopulationID: 7, ProductionType: null, Paused: 1 })])['7-construction'], undefined)

    const undecided = production.undecidedStarts([unknownProject])[7]
    const behind = production.industryFigures([industryRow(2, { Percentage: 100 }), industryRow(3, { Percentage: 100, Queue: 1 })], capacityResult(1000), undecided)

    assert.equal(behind[0].rate.value, 1000)
    assert.equal(behind[0].start, 0)
    assert.equal(behind[0].finish.result.status, 'estimated')
    assert.equal(behind[1].start, null)
    assert.equal(behind[1].finish.result.status, 'unavailable')
    assert.equal(behind[1].finish.idle, false)
    assert.ok(behind[1].finish.result.inputs.missing.some((text) => text.includes('production type')))
    assert.equal(production.industryFigures([industryRow(2, { Percentage: 100 }), industryRow(3, { Percentage: 100, Queue: 1 })], capacityResult(1000), [])[1].finish.result.status, 'estimated')
  })

  invariant('production', 'a project of unknown category is tried in every category against the real scheduler: a queued start that any resolution changes is unavailable, naming the type, and one all agree on stays known; current shares stay apart from start uncertainty', () => {
    const capacity = capacityResult(2000)
    const colony = { PopulationID: 7 }
    const running = industryRow(1, { ...colony, Percentage: 50 })
    const queued = industryRow(2, { ...colony, Percentage: 100, Queue: 1 })
    const pausedUnknown = industryRow(3, { ...colony, ProductionType: null, Percentage: 50, Paused: 1, Name: 'Held' })
    const known = production.industryFigures([running, queued], capacity, production.undecidedStarts([running, queued])[7])

    assert.equal(known[1].start, 365)
    assert.equal(known[1].finish.result.value, 547.5)

    const paused = production.industryFigures([running, queued], capacity, production.undecidedStarts([running, queued, pausedUnknown])[7])

    assert.equal(paused[0].start, 0)
    assert.equal(paused[0].finish.result.value, 365)
    assert.equal(paused[1].start, null)
    assert.equal(paused[1].finish.result.status, 'unavailable')
    assert.equal(paused[1].finish.idle, false)
    assert.ok(paused[1].finish.result.inputs.missing.some((text) => text.includes('production type') && text.includes('Held') && text.includes('paused')))
    assert.equal(production.undecidedKinds([running, queued, pausedUnknown])[7], undefined)
    assert.equal(production.industryUsage([running, queued, pausedUnknown])['7-construction'].used, 50)
    assert.deepEqual(production.industryUsage([running, queued, pausedUnknown])['7-construction'].missing, [])

    const queuedAhead = industryRow(4, { ...colony, ProductionType: null, Percentage: 50, Queue: 1, Name: 'Early' })
    const behindQueue = industryRow(5, { ...colony, Percentage: 100, Queue: 2 })
    const early = production.industryFigures([running, behindQueue], capacity, production.undecidedStarts([running, behindQueue, queuedAhead])[7])
    const alone = production.industryFigures([running, behindQueue], capacity, production.undecidedStarts([running, behindQueue])[7])

    assert.equal(alone[1].start, 365)
    assert.equal(early[1].start, null)
    assert.equal(early[1].finish.result.status, 'unavailable')
    assert.ok(early[1].finish.result.inputs.missing.some((text) => text.includes('production type') && text.includes('Early')))
    assert.equal(early[0].start, 0)
    assert.equal(early[0].finish.result.value, 365)
    assert.equal(production.undecidedKinds([running, behindQueue, queuedAhead])[7], undefined)

    const onePerUnit = (id, extra) => industryRow(id, { ...colony, Amount: 1, ProdPerUnit: 50, ...extra })
    const first = onePerUnit(6, { Percentage: 50 })
    const target = onePerUnit(7, { Percentage: 100, Queue: 1 })
    const behind = onePerUnit(8, { ProductionType: null, Percentage: 50, Queue: 99, Name: 'Late' })
    const hundred = capacityResult(100)
    const unrelated = production.industryFigures([first, target], hundred, production.undecidedStarts([first, target, behind])[7])
    const lateOnly = production.undecidedStarts([first, target, behind])[7]

    assert.deepEqual(lateOnly.map((entry) => entry.project.ID), [8])
    assert.equal(unrelated[0].start, 0)
    assert.equal(unrelated[0].finish.result.value, 365)
    assert.equal(unrelated[1].start, 365)
    assert.equal(unrelated[1].finish.result.value, 547.5)
    assert.equal(unrelated[1].finish.result.status, 'estimated')
    assert.deepEqual(unrelated, production.industryFigures([first, target], hundred, []))

    const behindTheLate = onePerUnit(9, { Percentage: 100, Queue: 100 })
    const after = production.industryFigures([first, target, behindTheLate], hundred, lateOnly)

    assert.equal(after[1].start, 365)
    assert.equal(after[2].start, null)
    assert.equal(after[2].finish.result.status, 'unavailable')
    assert.ok(after[2].finish.result.inputs.missing.some((text) => text.includes('Late')))

    const slow = (id, left, extra) => industryRow(id, { ...colony, Amount: 1, ProdPerUnit: left, ...extra })
    const runningShort = slow(10, 50, { Percentage: 50 })
    const runningLong = slow(11, 100, { Percentage: 50 })
    const skipTarget = slow(12, 50, { Percentage: 100, Queue: 1 })
    const skipper = slow(13, 1000, { ProductionType: null, Percentage: 50, Queue: 99, Name: 'Skipper' })
    const skipGroup = [runningShort, runningLong, skipTarget]
    const skipFigures = production.industryFigures(skipGroup, hundred, production.undecidedStarts([...skipGroup, skipper])[7])
    const asConstruction = production.industrySchedule([...skipGroup, { ...skipper, ProductionType: 0 }], 100)

    assert.equal(production.industrySchedule(skipGroup, 100)[12].start, 730)
    assert.equal(production.industrySchedule(skipGroup, 100)[12].finish, 912.5)
    assert.equal(asConstruction[12].start, 7665)
    assert.equal(asConstruction[12].finish, 7847.5)
    assert.equal(skipFigures[2].start, null)
    assert.equal(skipFigures[2].finish.result.status, 'unavailable')
    assert.equal(skipFigures[2].finish.idle, false)
    assert.ok(skipFigures[2].finish.result.inputs.missing.some((text) => text.includes('production type') && text.includes('Skipper')))
    assert.equal(skipFigures[0].finish.result.value, 365)
    assert.equal(skipFigures[1].finish.result.value, 730)
    assert.equal(skipFigures[0].start, 0)
    assert.equal(production.industryFigures(skipGroup, hundred, [])[2].start, 730)

    const crowd = [1, 2, 3, 4, 5].map((index) => slow(20 + index, 1000, { ProductionType: null, Percentage: 1, Queue: 50 + index, Name: `Crowd ${index}` }))
    const crowded = production.industryFigures([first, target], hundred, production.undecidedStarts([first, target, ...crowd])[7])

    assert.equal(crowded[0].start, 0)
    assert.equal(crowded[0].finish.result.value, 365)
    assert.equal(crowded[1].start, null)
    assert.equal(crowded[1].finish.result.inputs.missing.filter((text) => text.includes('Crowd')).length, 5)

    const few = production.industryFigures([first, target], hundred, production.undecidedStarts([first, target, ...crowd.slice(0, 4)])[7])

    assert.equal(few[1].start, 365)

    const partial = slow(30, 50, { ProductionType: null, Percentage: null, Queue: 99, Name: 'Partial' })
    const unsimulable = production.industryFigures([first, target], hundred, production.undecidedStarts([first, target, partial])[7])

    assert.equal(unsimulable[1].start, null)
    assert.ok(unsimulable[1].finish.result.inputs.missing.some((text) => text.includes('Partial')))
    assert.equal(unsimulable[0].finish.result.value, 365)

    const tied = { u: slow(41, 20, { ProductionType: null, Percentage: 20, Name: 'Tied' }), a: slow(42, 50, { Percentage: 50 }), target: slow(43, 70, { Percentage: 70, Queue: 1 }), late: slow(44, 400, { Percentage: 40, Queue: 2 }) }
    const knownGroup = [tied.a, tied.target, tied.late]
    const tiedFirst = [tied.u, tied.a, tied.target, tied.late]
    const tiedFigures = production.industryFigures(knownGroup, hundred, production.undecidedStarts(tiedFirst)[7])
    const asTiedConstruction = production.industrySchedule([{ ...tied.u, ProductionType: 0 }, ...knownGroup], 100)

    assert.equal(production.industrySchedule(knownGroup, 100)[43].start, 365)
    assert.equal(asTiedConstruction[43].start, 4015)
    assert.equal(asTiedConstruction[43].finish, 4380)
    assert.equal(tiedFigures[1].start, null)
    assert.equal(tiedFigures[1].finish.result.status, 'unavailable')
    assert.ok(tiedFigures[1].finish.result.inputs.missing.some((text) => text.includes('Tied')))
    assert.equal(tiedFigures[0].finish.result.value, 365)

    const tiedAfter = [tied.a, tied.u, tied.target, tied.late]
    const reversed = production.industryFigures(knownGroup, hundred, production.undecidedStarts(tiedAfter)[7])

    assert.equal(production.industrySchedule([tied.a, { ...tied.u, ProductionType: 0 }, tied.target, tied.late], 100)[43].start, 365)
    assert.equal(reversed[1].start, 365)
    assert.equal(reversed[1].finish.result.value, 730)
    assert.deepEqual(reversed, production.industryFigures(knownGroup, hundred, []))
  })

  invariant('production', 'idle labs and slipways are unavailable while a count is not in the save, say when the work holds more than is installed, and a colony with none has 0 of 0', () => {
    const labs = production.idleFacilities({ ResearchFacilities: 10, ResearchFacilitiesUsed: 4 }, 'research')

    assert.equal(labs.total.value, 10)
    assert.equal(labs.free.value, 6)
    assert.equal(production.idleFacilities({ ResearchFacilities: null, ResearchFacilitiesUsed: 4 }, 'research').free.status, 'unavailable')
    assert.equal(production.idleFacilities({ ResearchFacilities: 10, ResearchFacilitiesUsed: null }, 'research').total.value, 10)
    assert.equal(production.idleFacilities({ ResearchFacilities: 10, ResearchFacilitiesUsed: null }, 'research').free.status, 'unavailable')

    const over = production.idleFacilities({ Slipways: 2, SlipwaysUsed: 5 }, 'slipways').free

    assert.equal(over.value, 0)
    assert.equal(over.assumptions.length, 1)
    assert.equal(production.idleFacilities({ Slipways: 0, SlipwaysUsed: 0 }, 'slipways').total.value, 0)
  })

  invariant('production', 'a sum of results counts the figures it left out, is unavailable only while every figure is, and an empty group is a known 0', () => {
    const labs = (value) => production.idleFacilities({ ResearchFacilities: value, ResearchFacilitiesUsed: 0 }, 'research').total
    const mixed = production.totalOf('production.researchLabs', [labs(3), labs(null), labs(4)], 'colonies')

    assert.equal(mixed.result.value, 7)
    assert.equal(mixed.unknown, 1)
    assert.ok(mixed.result.assumptions.some((text) => text.includes('1 colonies have no figure')))

    const none = production.totalOf('production.researchLabs', [labs(null), labs(null)], 'colonies')

    assert.equal(none.result.status, 'unavailable')
    assert.equal(none.unknown, 2)
    assert.equal(production.totalOf('production.researchLabs', [], 'colonies').result.value, 0)
  })

  invariant('production', 'a job\'s finish tells a paused job, a job with no rate to work with and a missing input apart, and a pause flag that is not in the save is not read as running', () => {
    const rate = (value) => (value === null ? provenance.unavailable({ rule: 'production.shipRate', missing: ['the class\'s size'] }) : provenance.ofRule({ rule: 'production.shipRate', value, inputs: { present: ['x'] } }))
    const finish = (args) => production.finishDays({ rule: 'production.shipFinish', remaining: 100, remainingName: 'the remaining points', ...args })

    assert.equal(Math.round(finish({ rate: rate(100) }).result.value), 365)
    assert.equal(finish({ rate: rate(100), paused: true }).idle, true)
    assert.equal(finish({ rate: rate(100), paused: null }).idle, false)
    assert.equal(finish({ rate: rate(100), paused: null }).result.status, 'unavailable')
    assert.equal(finish({ rate: rate(0) }).idle, true)
    assert.equal(finish({ rate: rate(null) }).idle, false)
    assert.equal(finish({ rate: rate(null) }).result.status, 'unavailable')
    assert.equal(finish({ rate: rate(100), remaining: null }).result.status, 'unavailable')
    assert.equal(Math.round(finish({ rate: rate(100), divisor: 2 }).result.value), 183)
    assert.equal(production.jobStatus({ paused: null, rate: rate(100), stalled: { label: 'No capacity' } }).id, 'unknown')
    assert.equal(production.jobStatus({ paused: false, rate: rate(null), stalled: { label: 'No capacity' } }).id, 'unknown')
    assert.equal(production.jobStatus({ paused: false, rate: rate(0), stalled: { label: 'No capacity' } }).id, 'stalled')
    assert.equal(production.jobStatus({ paused: false, rate: rate(5), stalled: { label: 'No capacity' } }).id, 'running')
  })

  invariant('production', 'a continual shipyard upgrade is an estimate that says its date is approximate, and a yard with no build rate never gets there', () => {
    const yard = { SYType: 1, Capacity: 500, CapacityTarget: 5000, Slipways: 2, UpgradeTaskType: 8, Paused: 0 }
    const finish = production.shipyardFinish(colonyModifiers, yard, production.shipyardUpgradeRate(colonyModifiers, yard))

    assert.equal(finish.result.status, 'estimated')
    assert.ok(finish.result.value > 0)
    assert.ok(finish.result.assumptions.some((text) => text.includes('approximate')))

    const stalled = { ...colonyModifiers, ShipyardBuildRate: 0 }
    const stuck = production.shipyardFinish(stalled, yard, production.shipyardUpgradeRate(stalled, yard))

    assert.equal(stuck.result.status, 'unavailable')
    assert.equal(stuck.idle, true)

    const gap = { ...yard, Capacity: null }

    assert.equal(production.shipyardFinish(colonyModifiers, gap, production.shipyardUpgradeRate(colonyModifiers, gap)).idle, false)
  })

  invariant('production', 'ground training has no capacity or rate without its modifier or GFCC count, and its rate is the task\'s share of the capacity', () => {
    const capacity = production.trainingCapacity(colonyModifiers, { TrainingFacilities: 3 })

    assert.equal(capacity.value, 150)
    assert.equal(production.trainingRate(capacity, { TaskPercentage: 40 }).value, 60)
    assert.equal(production.trainingCapacity(undefined, { TrainingFacilities: 3 }).status, 'unavailable')
    assert.equal(production.trainingCapacity(colonyModifiers, undefined).status, 'unavailable')
    assert.equal(production.trainingCapacity(colonyModifiers, { TrainingFacilities: 0 }).value, 0)
    assert.equal(production.trainingRate(production.trainingCapacity(colonyModifiers, undefined), { TaskPercentage: 40 }).status, 'unavailable')
    assert.equal(production.trainingRate(capacity, { TaskPercentage: null }).status, 'unavailable')
  })

  invariant('production', 'a terraforming rate is unavailable while a ship\'s modules, crew share or captain bonus, the colony\'s modifier, the race rate, the game speed or the body\'s radius is unknown, and the crew share and the module count scale it', () => {
    const full = rateOf(colonyOf({ ships: [shipOf()] }))
    const half = rateOf(colonyOf({ ships: [shipOf({ modules: 50 })] }))
    const crewed = rateOf(colonyOf({ ships: [shipOf({ crew: 0.5 })] }))

    assert.ok(full.value > 0)
    assert.ok(Math.abs(half.value * 2 - full.value) < 1e-12)
    assert.ok(Math.abs(crewed.value * 2 - full.value) < 1e-12)

    for (const [name, source] of [['modules', colonyOf({ ships: [shipOf({ modules: null })] })], ['crew', colonyOf({ ships: [shipOf({ crew: null })] })], ['captain', colonyOf({ ships: [shipOf({ captain: null })] })], ['installations', colonyOf({ installations: null })], ['governor', colonyOf({ installations: 5, modifier: { ...colonyOf().modifier, governor: null } })], ['radius', colonyOf({ installations: 5, radius: null })]]) {
      assert.equal(rateOf(source).status, 'unavailable', name)
    }

    assert.equal(rateOf(colonyOf({ installations: 5 }), { raceRate: null }).status, 'unavailable')
    assert.equal(rateOf(colonyOf({ installations: 5 }), { speed: null }).status, 'unavailable')
    assert.equal(rateOf(colonyOf({ installations: 0 })).value, 0)
    assert.ok(provenance.getRule('production.terraformRate').structure.includes('crew.terraforming'))
  })

  invariant('production', 'the installations\' output is the whole installations, a fraction of an installation is not counted, and a colony without a modifier component has no installations\' output', () => {
    const whole = rateOf(colonyOf({ installations: 6 }))

    assert.equal(rateOf(colonyOf({ installations: 6.5 })).value, whole.value)
    assert.ok(Math.abs(rateOf(colonyOf({ installations: 12, modifier: { ...colonyOf().modifier, efficiency: 0.5 } })).value - whole.value) < 1e-12)
    assert.equal(rateOf(colonyOf({ installations: 6, modifier: { ...colonyOf().modifier, unrest: null } })).status, 'unavailable')
  })

  invariant('production', 'a terraforming finish with no rate says why, and one with a rate of 0 is idle', () => {
    const rate = rateOf(colonyOf({ installations: 10 }))
    const job = { TerraformStatus: 1, MaxAtm: 1, GasAtm: 0.5, GasName: 'Oxygen', HydroID: 1, HydroExt: 0, AtmosPress: 1 }
    const finish = production.terraformFinish(colonyModifiers, job, rate)

    assert.equal(finish.result.status, 'estimated')
    assert.ok(Math.abs(finish.result.value - (0.5 / (rate.value / 365))) < 1e-9)
    assert.equal(production.terraformFinish(colonyModifiers, job, rateOf(colonyOf(), { speed: null })).result.status, 'unavailable')
    assert.equal(production.terraformFinish(colonyModifiers, job, rateOf(colonyOf({ installations: 0 }))).idle, true)
    assert.equal(production.terraformFinish(colonyModifiers, { ...job, TerraformStatus: null }, rate).result.status, 'unavailable')
  })

  invariant('production', 'a gas with no row in the body\'s atmosphere is 0 atm and a row with a null pressure is unavailable, naming the pressure, never a finish of 0 days', () => {
    const rate = rateOf(colonyOf({ installations: 10 }))
    const removing = { TerraformStatus: 0, MaxAtm: 0, GasAtm: null, GasAtmUnknown: 0, GasName: 'Oxygen', HydroID: 1, HydroExt: 0, AtmosPress: 1 }
    const absent = production.terraformFinish(colonyModifiers, removing, rate)

    assert.equal(absent.result.value, 0)
    assert.ok(absent.result.assumptions.some((text) => text.includes('0 atm')))

    const unknown = production.terraformFinish(colonyModifiers, { ...removing, GasAtmUnknown: 1 }, rate)

    assert.equal(unknown.result.status, 'unavailable')
    assert.ok(unknown.result.inputs.missing.some((text) => text.includes('pressure of the gas')))
    assert.equal(production.terraformFinish(colonyModifiers, { ...removing, GasAtmUnknown: undefined }, rate).result.status, 'unavailable')
    assert.equal(production.terraformFinish(colonyModifiers, { ...removing, GasAtm: 0.5, GasAtmUnknown: 0 }, rate).result.status, 'estimated')

    const vapour = { ...removing, MaxAtm: 0.1, GasName: 'Water Vapour', HydroID: 3, HydroExt: 20, AtmosPress: 1 }

    assert.equal(production.terraformFinish(colonyModifiers, { ...vapour, GasAtmUnknown: 1 }, rate).result.status, 'unavailable')
    assert.notEqual(production.terraformFinish(colonyModifiers, { ...vapour, GasAtmUnknown: 0 }, rate).result.status, 'unavailable')
  })

  invariant('production', 'the completions timeline reports the jobs it skipped by reason, and a job with no date is not counted as finishing now', () => {
    const jobs = [
      { days: 10, type: 'ship', shortage: null },
      { days: 400, type: 'ship', shortage: null },
      { days: 30, type: 'industry', shortage: {} },
      { days: null, finishIdle: true, type: 'ship' },
      { days: null, finishIdle: false, type: 'research' },
      { days: null, type: 'research' },
      { days: 0, type: 'ship' },
    ]
    const bins = production.completionBins(jobs, { years: 1, bins: 12 }, ['research', 'industry', 'ship'])

    assert.equal(bins.total, 2)
    assert.equal(bins.later, 1)
    assert.deepEqual(bins.skipped, { unknown: 2, idle: 1, done: 1 })
    assert.equal(bins.counts.short.reduce((total, count) => total + count, 0), 1)
    assert.equal(bins.result.value, 2)
    assert.ok(bins.result.inputs.missing[0].includes('2 jobs'))
  })

  invariant('production', 'a shortage that a stock not in the save leaves unknown is not read as a stock of 0, and a missing need is unknown, not free', () => {
    const base = Object.fromEntries(modules.minerals.MINERALS.map((mineral) => [mineral.name, 0]))
    const project = (extra = {}) => ({ ...base, Amount: 10, FuelRequired: 0, StockFuel: 0, ...extra })

    assert.equal(production.shortageOf(project()).covers, null)

    const short = production.shortageOf(project({ Duranium: 2, StockDuranium: 6 }))

    assert.equal(short.shortage.name, 'Duranium')
    assert.equal(short.covers.value, 3)

    const unknownStock = production.shortageOf(project({ Duranium: 2, StockDuranium: null }))

    assert.equal(unknownStock.shortage, null)
    assert.equal(unknownStock.covers.status, 'unavailable')
    assert.ok(unknownStock.unknown[0].includes('stock of Duranium'))
    assert.equal(production.shortageOf(project({ Neutronium: null })).covers.status, 'unavailable')
    assert.equal(production.shortageOf(project({ Amount: null })).covers.status, 'unavailable')
    assert.equal(production.shortageOf(project({ FuelRequired: 1, StockFuel: 2 })).shortage.name, 'fuel')
    assert.equal(production.shortageOf(project({ FuelRequired: 1, StockFuel: null })).covers.status, 'unavailable')
  })

  invariant('production', 'the production tables sort a figure that is not known after every number in both directions, and a real 0 sorts as 0', () => {
    const rows = [{ name: 'a', value: null }, { name: 'b', value: 3 }, { name: 'c', value: 0 }, { name: 'd' }, { name: 'e', value: 7 }, { name: 'f', value: NaN }]
    const names = (desc) => production.sortNullLast(rows, ['value'], [desc]).map((row) => row.name).join('')

    assert.equal(names(false).slice(0, 3), 'cbe')
    assert.equal(names(true).slice(0, 3), 'ebc')
    assert.equal(names(false).slice(3).split('').sort().join(''), 'adf')
    assert.equal(names(true).slice(3).split('').sort().join(''), 'adf')
    assert.equal(production.sortNullLast(rows, [], []), rows)
    assert.equal(production.sortNullLast([{ group: 'b', value: 1 }, { group: 'a', value: 2 }], ['group', 'value'], [false, true])[0].group, 'a')
  })

  invariant('logistics', 'a refinery or maintenance facility makes 0 where it has no installations or is off, and has no figure rather than 0 where its modifier or rate is not in the save', () => {
    const colony = { FuelProdStatus: 1, Refineries: 4, FuelProduction: 1000, MaintenanceFacilities: 5, MSPProduction: 10, MaintProdStatus: 1, Mines: 0, Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6 }

    assert.equal(logistics.refineryOutput(colony, 1.5).value, 6000)
    assert.equal(logistics.refineryOutput(colony, null).status, 'unavailable')
    assert.ok(logistics.refineryOutput(colony, null).inputs.missing.includes('the colony\'s production modifier'))
    assert.equal(logistics.refineryOutput({ ...colony, FuelProduction: null }, 1.5).status, 'unavailable')
    assert.equal(logistics.refineryOutput({ ...colony, FuelProdStatus: 0 }, null).value, 0)
    assert.equal(logistics.refineryOutput({ ...colony, Refineries: 0 }, null).value, 0)
    assert.equal(logistics.refineryOutput({ ...colony, FuelProdStatus: null }, 1.5).status, 'unavailable')
    assert.equal(logistics.refineryYield({ ...colony, Sorium: 0.5 }, null).value, 0)
    assert.equal(logistics.refineryYield({ ...colony, Sorium: 100 }, 1.5).value, 6000)
    assert.equal(logistics.refineryYield({ ...colony, Sorium: null }, 1.5).status, 'unavailable')
    assert.equal(logistics.mspProduction(colony, 2).value, 400)
    assert.equal(logistics.mspProduction(colony, null).status, 'unavailable')
    assert.equal(logistics.mspProduction({ ...colony, MaintenanceFacilities: 0 }, null).value, 0)
    assert.equal(logistics.mspOutput(colony, 2).value, 400)
    assert.equal(logistics.mspOutput({ ...colony, Duranium: 10 }, 2).value, 100)
    assert.equal(logistics.mspOutput({ ...colony, Duranium: null }, 2).status, 'unavailable')
    assert.equal(logistics.mspOutput({ ...colony, MaintProdStatus: 0 }, null).value, 0)
    assert.equal(logistics.mspOutput(colony, null).status, 'unavailable')
    assert.deepEqual(logistics.mspMineralShortfall({ ...colony, Duranium: 10 }, 2), ['Duranium'])
    assert.deepEqual(logistics.mspMineralShortfall(colony, null), [])
  })

  // A row of the page's ship read (`loadMaintenanceShips`): an ordinary warship in a fleet at the origin of system 1, with every figure the maintenance step reads.
  const rawShip = (over = {}) => ({ ShipID: 1, ShipName: 'Ship', FleetID: 1, FleetName: 'Fleet', SystemID: 1, SystemName: 'System', OrbitBodyID: 1, Xcor: 0, Ycor: 0, AssignedPopulationID: 0, ShipClassID: 1, ClassName: 'Class', Size: 1, Cost: 0, Commercial: 0, SupplyShip: 0, MinimumSupplies: 0, ClassSupplies: 0, MaintPriority: 0, CurrentMaintSupplies: 0, MaintenanceState: 0, LastOverhaul: 0, MothershipID: 0, CarrierCommercialHangar: null, Modules: 0, Bays: 0, ...over })

  invariant('logistics', 'how long a colony\'s Sorium lasts is unavailable while its refinery output or stock is not known or nothing is refined, and a location leaves a colony without a production figure out of its sum and counts it', () => {
    const colony = { FuelProdStatus: 1, Refineries: 4, FuelProduction: 1000, Sorium: 20 }
    const output = logistics.refineryOutput(colony, 1)

    assert.equal(logistics.soriumLasts(colony, output).value, 10)
    assert.equal(logistics.soriumLasts({ ...colony, Sorium: null }, output).status, 'unavailable')
    assert.equal(logistics.soriumLasts(colony, logistics.refineryOutput(colony, null)).status, 'unavailable')
    assert.equal(logistics.soriumLasts({ ...colony, FuelProdStatus: 0 }, logistics.refineryOutput({ ...colony, FuelProdStatus: 0 }, 1)).status, 'unavailable')

    const make = (id) => ({ PopulationID: id, SystemID: 1, Xcor: 0, Ycor: 0, SystemBodyID: 1, MaintenanceFacilities: 1, MSPProduction: 10, MaintProdStatus: 1, MaintenanceStockpile: 0, Mines: 0, Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6, Efficiency: 1, CapacityModifier: 1, EconomicProdModifier: 1, MaintenanceCapacity: 1 })
    const ships = [rawShip({ Size: 2, Cost: 40 })]
    const place = (colonies, modifierOf) => logistics.maintenanceLocations({ colonies, ships, modifierOf, maintenanceCapacity: 1, economicModifier: 1 })[0]
    const mixed = place([make(1), make(2)], (id) => (id === 1 ? 1 : null))

    assert.equal(mixed.production, 40)
    assert.equal(mixed.uncounted, 1)
    assert.ok(mixed.productionResult.assumptions.some((text) => text.includes('1 colonies have no figure')))
    assert.equal(mixed.net, 40 - mixed.upkeep)

    const alone = place([make(1)], () => null)

    assert.equal(alone.production, null)
    assert.equal(alone.potential, null)
    assert.equal(alone.net, null)
    assert.equal(alone.runway, null)
    assert.equal(alone.netResult.status, 'unavailable')
    assert.equal(alone.uncounted, 1)
  })

  invariant('logistics', 'a maintenance location leaves an unknown capacity, tonnage, stock or supply out and names it, while a real 0 still counts', () => {
    const colony = { PopulationID: 1, SystemID: 1, Xcor: 0, Ycor: 0, SystemBodyID: 1, MaintenanceFacilities: 1, MSPProduction: 10, MaintProdStatus: 0, MaintenanceStockpile: 100, Mines: 0, Duranium: 1e6, Uridium: 1e6, Gallicite: 1e6, Efficiency: 1, CapacityModifier: 1, EconomicProdModifier: 1, MaintenanceCapacity: 50, WarningMSP: 0 }
    const fleet = rawShip({ Size: 2, Cost: 40 })
    const supplier = rawShip({ ShipID: 2, FleetID: 2, Commercial: 1, SupplyShip: 1, CurrentMaintSupplies: 5 })
    const place = (colonies, ships) => logistics.maintenanceLocations({ colonies, ships, modifierOf: () => 1, maintenanceCapacity: 50, economicModifier: 1 })[0]
    const whole = place([colony], [fleet, supplier])

    assert.equal(whole.capacity, 50)
    assert.equal(whole.rate, 0.5)
    assert.equal(whole.upkeep, 5)
    assert.equal(whole.stock, 100)
    assert.equal(whole.supply, 5)
    assert.equal(whole.net, -5)
    assert.equal(whole.runway, 21)
    assert.equal(logistics.facilityCapacity({ ...colony, Efficiency: null }), null)
    assert.equal(logistics.facilityCapacity({ ...colony, MaintenanceFacilities: 0, Efficiency: null }), 0)
    assert.equal(logistics.facilityCapacity({ ...colony, Efficiency: -1 }), 0)

    const noCapacity = place([{ ...colony, Efficiency: null }], [fleet, supplier])

    assert.equal(noCapacity.capacity, null)
    assert.equal(noCapacity.capacityResult.status, 'unavailable')
    assert.equal(noCapacity.rate, null)
    assert.equal(noCapacity.upkeep, null)
    assert.equal(noCapacity.net, null)
    assert.equal(noCapacity.netResult.status, 'unavailable')
    assert.equal(place([{ ...colony, Efficiency: null }], [{ ...fleet, Cost: 0 }]).upkeep, 0)
    assert.equal(place([{ ...colony, Efficiency: null }], [{ ...fleet, Size: 0 }]).rate, 1)

    const moduleUnknown = place([colony], [fleet, rawShip({ ShipID: 3, FleetID: 3, Commercial: 1, Modules: null })])

    assert.equal(moduleUnknown.capacity, null)
    assert.ok(moduleUnknown.capacityResult.inputs.missing.some((text) => text.includes('maintenance modules')))
    assert.equal(place([colony], [fleet, rawShip({ ShipID: 3, FleetID: 3, Commercial: 1, Modules: 2 })]).capacity, 150)

    const noTons = place([colony], [{ ...fleet, Size: null }])

    assert.equal(noTons.tons, null)
    assert.equal(noTons.upkeep, null)
    assert.equal(noTons.tonsResult.status, 'unavailable')
    assert.ok(noTons.tonsResult.inputs.missing.some((text) => text.includes('maintained ships')))

    const mixedTons = place([colony], [fleet, { ...fleet, ShipID: 2, FleetID: 2, Size: null }])

    assert.equal(mixedTons.tons, null)
    assert.equal(mixedTons.tonsResult.status, 'unavailable')
    assert.equal(mixedTons.upkeep, null)
    assert.equal(place([colony], [fleet, { ...fleet, ShipID: 2, FleetID: 2 }]).tonsResult.value, 200)
    assert.equal(place([colony], [{ ...fleet, Commercial: null, Cost: 0 }]).upkeep, null)
    assert.equal(place([colony], [{ ...fleet, Size: null }]).tons, null)

    const noStock = place([{ ...colony, MaintenanceStockpile: null }], [fleet, supplier])

    assert.equal(noStock.stock, null)
    assert.equal(noStock.stockUnknown, 1)
    assert.equal(noStock.stockResult.status, 'unavailable')
    assert.equal(noStock.net, -5)
    assert.equal(noStock.runway, null)
    assert.equal(noStock.runwayResult.status, 'unavailable')
    assert.ok(noStock.runwayResult.inputs.missing.some((text) => text.includes('stockpile')))

    const partial = place([colony, { ...colony, PopulationID: 2, MaintenanceStockpile: null }], [fleet, supplier])

    assert.equal(partial.stock, 100)
    assert.equal(partial.stockUnknown, 1)
    assert.equal(partial.runway, null)

    const noSupply = place([colony], [fleet, { ...supplier, CurrentMaintSupplies: null }])

    assert.equal(noSupply.supply, null)
    assert.equal(noSupply.supplyUnknown, 1)
    assert.equal(place([colony], [fleet, { ...supplier, SupplyShip: null }]).supply, null)
    assert.equal(place([colony], [fleet, { ...supplier, CurrentMaintSupplies: 0 }]).supply, 0)
    assert.equal(place([{ ...colony, MaintenanceStockpile: 0 }], [fleet, { ...supplier, CurrentMaintSupplies: 0 }]).stock, 0)

    const total = logistics.columnTotal('logistics.fuelStock', [{ Fuel: 5 }, { Fuel: null }, { Fuel: 7, Flag: 1 }], 'Fuel', 'the fuel aboard', 'ships', ['Flag'])

    assert.equal(total.value, 5)
    assert.equal(total.unknown, 2)
    assert.ok(total.gap.includes('2 ships'))
    assert.equal(logistics.columnTotal('logistics.fuelStock', [], 'Fuel', 'the fuel aboard', 'ships').value, 0)
    assert.equal(logistics.columnTotal('logistics.fuelStock', [{ Fuel: null }], 'Fuel', 'the fuel aboard', 'ships').value, null)

    const grouped = logistics.columnTotal('logistics.fuelStock', [{ Fuel: 100, FuelUnknown: 2 }, { Fuel: 50, FuelUnknown: 0 }], 'Fuel', 'the fuel aboard', 'ships', [], 'FuelUnknown')

    assert.equal(grouped.value, 150)
    assert.equal(grouped.unknown, 2)
    assert.ok(grouped.gap.includes('2 ships'))
    assert.ok(grouped.result.assumptions.some((text) => text.includes('2 of the ships have no figure')))
    assert.equal(logistics.columnTotal('logistics.fuelStock', [{ Fuel: null, FuelUnknown: 3 }], 'Fuel', 'the fuel aboard', 'ships', [], 'FuelUnknown').unknown, 3)
    assert.equal(logistics.columnTotal('logistics.fuelStock', [{ Fuel: 7, FuelUnknown: 0 }], 'Fuel', 'the fuel aboard', 'ships', [], 'FuelUnknown').unknown, 0)
  })

  const donors = modules['fuel-donors']
  const donorShip = (extra = {}) => ({ ShipID: 1, Fuel: 1000000, FuelCapacity: 5000000, FuelTanker: 1, MinimumFuel: 100000, RefuellingRate: 30000, EnginePower: 100, TransferSystems: 1, UndamagedTransfer: 1, Harvester: 0, HubEra: 0, ...extra })

  invariant('logistics', 'the fuel service rules are registered with their units, and the donor result names allowed, blocked or unknown with the first gate that decides it', () => {
    ;['stored', 'gameMinimum', 'playerReserve', 'eligibleSurplus', 'donor'].forEach((key) => assert.ok(provenance.getRule(`fuelService.${key}`), key))
    assert.equal(provenance.getRule('fuelService.playerReserve').verification, 'confirmed')
    assert.equal(donors.fuelDonor(donorShip()).permission, 'allowed')
    assert.equal(donors.fuelDonor(donorShip({ FuelTanker: 0 })).gate, 'designation')
    assert.equal(donors.fuelDonor(donorShip({ TransferSystems: 0, UndamagedTransfer: 0 })).gate, 'system')
    assert.equal(donors.fuelDonor(donorShip({ UndamagedTransfer: null })).permission, 'unknown')
    assert.equal(donors.fuelDonor(donorShip({ RefuellingRate: 0 })).gate, 'rate')
    assert.equal(donors.fuelDonor(donorShip({ Fuel: 100000 })).gate, 'litres')
    assert.equal(donors.fuelDonor(donorShip({ RefuellingRate: 15000 }), { recipient: { size: 20.001 } }).gate, 'recipient')
    assert.equal(donors.fuelDonor(donorShip({ RefuellingRate: 15000 }), { recipient: { size: 20 } }).permission, 'allowed')
  })

  invariant('logistics', 'a ship that cannot serve keeps every stored litre, the tanker total reconciles to the fuel aboard when no ship has a surplus, and a local reserve never changes the class minimum', () => {
    const ships = [donorShip({ ShipID: 1, Fuel: 90000 }), donorShip({ ShipID: 2, Fuel: 50000.5, UndamagedTransfer: 0 }), donorShip({ ShipID: 3, Fuel: 20, MinimumFuel: 0, FuelTanker: 0, RefuellingRate: 90000 })]
    const report = donors.tankerReport(ships)

    assert.equal(report.totals.stored.value, 140000.5)
    assert.equal(report.totals.eligible, 0)
    assert.equal(report.totals.ships, 2)
    assert.equal(report.rows[2].donor.stored, 20)
    assert.equal(report.rows[1].donor.stored, 50000.5)
    assert.equal(logistics.columnTotal('logistics.fuelStock', ships.filter((ship) => ship.FuelTanker), 'Fuel', 'the fuel aboard', 'tankers').value, report.totals.stored.value)

    const reserved = donors.fuelDonor(donorShip(), { playerReserve: 400000 })

    assert.equal(reserved.minimum, 100000)
    assert.equal(reserved.stored, 1000000)
    assert.equal(reserved.eligibleSurplus, 600000)
  })
  // ---- Warnings ----
  const warnings = modules['warnings/index']
  const warningsCommon = modules['warnings/common']

  // Runs one check's read against rows a fake save returns: `rows` is a list, or a function of the query's text that returns one.
  const readCheck = (key, rows, extra = {}) => warnings.checkByKey[key].read({
    GameID: 1,
    RaceID: 1,
    RaceNPR: false,
    separator: ',',
    options: { idleFleetsAtColonies: false, maintenanceThreshold: 100, maintenanceExclusions: [] },
    count: warningsCommon.counter(','),
    database: { query: async (sql) => [typeof rows === 'function' ? rows(sql) : rows] },
    ...extra,
  })

  invariant('warnings', 'every check carries the id of a registered rule with a verification and the structure it reads, and the summary has a rule too', () => {
    const { getRule } = modules.provenance

    assert.ok(warnings.CHECKS.length > 40)
    warnings.CHECKS.forEach((check) => {
      const rule = getRule(check.provenance)

      assert.equal(check.provenance, `warnings.${check.key.replace(/-(\w)/g, (_match, letter) => letter.toUpperCase())}`)
      assert.ok(['confirmed', 'estimated', 'assumed'].includes(rule.verification), check.key)
      assert.ok(rule.structure.length > 0, check.key)
    })
    assert.ok(getRule('warnings.summary'))
  })

  invariant('warnings', 'a count that is not known is a dash and a real 0 is 0', () => {
    const counter = warningsCommon.counter(',')

    ;[null, undefined, NaN].forEach((value) => assert.equal(counter(value), '—'))
    assert.equal(counter(0), '0')
    assert.equal(counter(1234.5, 1), '1,234.5')
  })

  invariant('warnings', 'a verdict over stored values follows three-valued logic: one failing condition settles it and an unknown input leaves it open', () => {
    const { allOf, anyOf } = warningsCommon

    assert.equal(allOf(1, 1), 1)
    assert.equal(allOf(1, null), null)
    assert.equal(allOf(0, null), 0)
    assert.equal(anyOf(0, 0), 0)
    assert.equal(anyOf(0, null), null)
    assert.equal(anyOf(1, null), 1)
    assert.deepEqual(warningsCommon.lacking({ A: 1, B: null, C: undefined, D: NaN, E: 0 }, { A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' }), ['b', 'c', 'd'])
  })

  invariant('warnings', 'a ship with no crew morale stored is not evaluated and names the missing input, while a known morale under 100% warns and a full one is dropped', async () => {
    const ship = (ShipID, CrewMorale, Verdict) => ({ ShipID, FleetID: 1, ShipName: `Ship ${ShipID}`, FleetName: 'Fleet', ShippingLineID: 0, CrewMorale, Verdict })
    const rows = await readCheck('low-morale-crews', [ship(1, 0.5, 1), ship(2, null, null), ship(3, 1, 0)])

    assert.deepEqual(rows.map((row) => row.id), ['ship:1', 'ship:2'])
    assert.equal(rows[0].unevaluated, undefined)
    assert.equal(rows[0].cells.morale.text, '50%')
    assert.equal(rows[1].unevaluated.status, 'unavailable')
    assert.equal(rows[1].unevaluated.rule.id, 'warnings.lowMoraleCrews')
    assert.deepEqual(rows[1].unevaluated.inputs.missing, ['the ship\'s crew morale'])
    assert.equal(rows[1].cells.morale.text, '—')
    assert.equal(rows[1].cells.morale.result.status, 'unavailable')
  })

  invariant('warnings', 'a damaged component with no stored cost gives a dash and an unavailable result for the ship\'s repair, never a cost of 0, and a stored cost of 0 stays 0', async () => {
    const item = (ComponentCost) => ({ ShipID: 1, FleetID: 1, ShipName: 'Ship', ShippingLineID: 0, Verdict: 1, FleetName: 'Fleet', ComponentName: 'Gun', ComponentCost })
    const [unknown] = await readCheck('damaged-ships', [item(null), item(5)])
    const [zero] = await readCheck('damaged-ships', [item(0)])

    assert.equal(unknown.cells.cost.text, '—')
    assert.equal(unknown.cells.cost.result.status, 'unavailable')
    assert.equal(zero.cells.cost, '0 MSP')
  })

  invariant('warnings', 'a lifepod keeps its crew of 0, and without a game time or a creation time its time remaining is a dash with an unavailable result and not an expiry', async () => {
    const pod = (CreationTime, Crew) => ({ LifepodID: 1, SystemID: 1, ShipName: 'Pod', Crew, CreationTime, SystemName: 'Sol' })
    const [known] = await readCheck('active-lifepods', [pod(0, 0)], { GameTime: 1209600 - 90061 })
    const [noClock] = await readCheck('active-lifepods', [pod(0, 4)], { GameTime: null })
    const [noCreation] = await readCheck('active-lifepods', [pod(null, 4)], { GameTime: 100 })
    const [expired] = await readCheck('active-lifepods', [pod(0, 4)], { GameTime: 1209601 })

    assert.equal(known.cells.crew, '0')
    assert.equal(known.cells.remaining.text, '1d 1h 1m 1s')
    assert.equal(noClock.cells.remaining.text, '—')
    assert.deepEqual(noClock.cells.remaining.result.inputs.missing, ['the game time'])
    assert.equal(noCreation.cells.remaining.text, '—')
    assert.deepEqual(noCreation.cells.remaining.result.inputs.missing, ['the creation time of the lifepod'])
    assert.equal(expired.cells.remaining.text, 'Expired')
  })

  invariant('warnings', 'a rift whose only possible occupants are colonies of unknown use is not evaluated, and a rift with a known occupant warns with a dash for a missing diameter', async () => {
    const rift = (extra) => ({ SystemID: 1, Xcor: 0, Ycor: 0, Diameter: 2000000, SystemName: 'Sol', CivilianFleets: 0, MilitaryFleets: 0, UnknownFleets: 0, InhabitedColonies: 0, UsedColonies: 0, StockedColonies: 0, GroundUnitBases: 0, OpenColonies: 0, ...extra })
    const rows = await readCheck('dangerous-rifts', [rift({ SystemID: 1, OpenColonies: 1 }), rift({ SystemID: 2, MilitaryFleets: 1, Diameter: null }), rift({ SystemID: 3 })])

    assert.deepEqual(rows.map((row) => row.id), ['rift:1:0:0', 'rift:2:0:0'])
    assert.equal(rows[0].unevaluated.status, 'unavailable')
    assert.equal(rows[0].cells.size, '2 Mkm')
    assert.equal(rows[1].unevaluated, undefined)
    assert.equal(rows[1].cells.size.text, '—')
    assert.equal(rows[1].cells.size.result.status, 'unavailable')
  })

  invariant('warnings', 'an ancient construct with no known colony of 10 million is not evaluated while a population or its state is missing, and one that is known to be dormant or short of people warns', async () => {
    const construct = (AncientConstructID, Active, PopulationID, Population) => ({ AncientConstructID, Active, ResearchBonus: 1.25, FieldName: 'Sensors', SystemBodyID: AncientConstructID, PlanetNumber: 1, OrbitNumber: 0, BodyClass: 1, SystemBodyName: `Body ${AncientConstructID}`, Component: 1, SystemName: 'Sol', PopulationID, Population })
    const rows = await readCheck('known-unexploited-constructs', (sql) => (sql.includes('FCT_AncientConstruct') ? [construct(1, 1, 11, null), construct(2, null, 12, 25), construct(3, 0, null, null), construct(4, 1, 13, 25), construct(5, 1, 14, 5)] : []))
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]))

    assert.deepEqual(Object.keys(byId), ['construct:1', 'construct:2', 'construct:3', 'construct:5'])
    assert.deepEqual(byId['construct:1'].unevaluated.inputs.missing, ['the population of a colony on the construct\'s body'])
    assert.deepEqual(byId['construct:2'].unevaluated.inputs.missing, ['whether the ancient construct is active'])
    assert.equal(byId['construct:3'].cells.bonus, 'Dormant')
    assert.equal(byId['construct:5'].cells.blocker, 'Lacking 10 million population on the body')
  })

  invariant('warnings', 'a colony whose factory amounts are all unstored is not evaluated and names the amount, one known positive amount still proves free capacity, a real 0 amount has none, and an unstored installation type is named', async () => {
    const sqlite3 = require('sqlite3')
    const db = new sqlite3.Database(':memory:')
    const run = (sql) => new Promise((resolve, reject) => db.exec(sql, (error) => (error ? reject(error) : resolve())))
    const all = (sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))
    const installation = (PopID, PlanetaryInstallationID, Amount) => `insert into FCT_PopulationInstallations values (${PopID}, ${PlanetaryInstallationID}, ${Amount}, 1);`

    await run(`
      create table DIM_PlanetaryInstallation (PlanetaryInstallationID integer, ConstructionValue real, OrdnanceProductionValue real, FighterProductionValue real);
      create table FCT_Population (PopulationID integer, GameID integer, RaceID integer, PopName text, SystemBodyID integer, SystemID integer);
      create table FCT_PopulationInstallations (PopID integer, PlanetaryInstallationID integer, Amount real, GameID integer);
      create table FCT_IndustrialProjects (ProjectID integer, PopulationID integer, Queue integer, ProductionType integer, Percentage real, Pause integer);
      create table FCT_SystemBody (SystemBodyID integer, PlanetNumber integer, OrbitNumber integer, BodyClass integer, StarID integer);
      create table FCT_SystemBodyName (SystemBodyID integer, RaceID integer, Name text);
      create table FCT_RaceSysSurvey (SystemID integer, RaceID integer, Name text);
      create table FCT_Star (StarID integer, Component integer);
      insert into DIM_PlanetaryInstallation values (1, 1, 0, 0), (2, 2, 0, 0), (3, 0, 0, 0), (4, 0, 1, 0);
      insert into FCT_Population values (1, 1, 1, 'One', 1, 1), (2, 1, 1, 'Two', 1, 1), (3, 1, 1, 'Three', 1, 1), (4, 1, 1, 'Four', 1, 1), (5, 1, 1, 'Five', 1, 1), (6, 1, 1, 'Six', 1, 1), (7, 1, 1, 'Seven', 1, 1);
      ${installation(1, 1, 'null')}
      ${installation(2, 1, 5)}
      ${installation(2, 2, 'null')}
      ${installation(3, 1, 0)}
      ${installation(4, 1, 7)}
      ${installation(5, 99, 3)}
      ${installation(6, 3, 4)}
      ${installation(7, 4, 'null')}
    `)

    const database = { query: async (sql) => [await all(sql)] }
    const construction = Object.fromEntries((await readCheck('free-construction-capacity', [], { database })).map((row) => [row.id, row]))

    assert.deepEqual(Object.keys(construction), ['colony:1', 'colony:2', 'colony:4', 'colony:5'])
    assert.deepEqual(construction['colony:1'].unevaluated.inputs.missing, ['the amount of a factory of the colony'])
    assert.equal(construction['colony:1'].cells.installations.text, '—')
    assert.equal(construction['colony:2'].unevaluated, undefined)
    assert.equal(construction['colony:2'].cells.installations.text, '—')
    assert.equal(construction['colony:4'].unevaluated, undefined)
    assert.equal(construction['colony:4'].cells.installations, '7')
    assert.equal(construction['colony:4'].cells.free, '100%')
    assert.deepEqual(construction['colony:5'].unevaluated.inputs.missing, ['the type of an installation of the colony'])

    const ordnance = Object.fromEntries((await readCheck('free-ordnance-capacity', [], { database })).map((row) => [row.id, row]))

    assert.deepEqual(Object.keys(ordnance), ['colony:5', 'colony:7'])
    assert.deepEqual(ordnance['colony:7'].unevaluated.inputs.missing, ['the amount of a factory of the colony'])

    db.close()
  })

  invariant('warnings', 'a colony, naval administration or sector counts as commanded only by a commander of its own command type in its game: a ground formation\'s commander, an academy commandant or a governor of another game whose command id is the same leaves it listed', async () => {
    const sqlite3 = require('sqlite3')
    const db = new sqlite3.Database(':memory:')
    const run = (sql) => new Promise((resolve, reject) => db.exec(sql, (error) => (error ? reject(error) : resolve())))
    const all = (sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))

    await run(`
      create table FCT_Population (PopulationID integer, GameID integer, RaceID integer, PopName text, Population real, SystemBodyID integer, SystemID integer);
      create table FCT_Commander (CommanderID integer, GameID integer, CommandID integer, CommandType integer);
      create table FCT_NavalAdminCommand (NavalAdminCommandID integer, GameID integer, RaceID integer, AdminCommandName text, PopulationID integer);
      create table FCT_SectorCommand (SectorCommandID integer, GameID integer, RaceID integer, SectorName text, PopulationID integer);
      create table FCT_SystemBody (SystemBodyID integer, PlanetNumber integer, OrbitNumber integer, BodyClass integer, StarID integer);
      create table FCT_SystemBodyName (SystemBodyID integer, RaceID integer, Name text);
      create table FCT_RaceSysSurvey (SystemID integer, RaceID integer, Name text);
      create table FCT_Star (StarID integer, Component integer);
      insert into FCT_Population values (1, 1, 1, 'Governed', 5, 1, 1), (2, 1, 1, 'Academy', 4, 1, 1), (3, 1, 1, 'Garrison', 3, 1, 1), (4, 1, 1, 'Elsewhere', 2, 1, 1), (5, 1, 1, 'Empty', 0, 1, 1);
      insert into FCT_NavalAdminCommand values (10, 1, 1, 'Commanded', 1), (11, 1, 1, 'Shared', 1), (12, 1, 1, 'Vacant', 1);
      insert into FCT_SectorCommand values (20, 1, 1, 'Commanded', 1), (21, 1, 1, 'Shared', 1), (22, 1, 1, 'Admiralty', 1);
      insert into FCT_Commander values (101, 1, 1, 3), (102, 1, 2, 17), (103, 1, 3, 5), (104, 2, 4, 3), (110, 1, 10, 12), (111, 1, 11, 5), (120, 1, 20, 4), (121, 1, 21, 5), (122, 1, 22, 12);
    `)

    const database = { query: async (sql) => [await all(sql)] }
    const listed = async (key) => (await readCheck(key, [], { database })).map((row) => row.id)

    assert.deepEqual(await listed('governorless-populations'), ['colony:2', 'colony:3', 'colony:4'])
    assert.deepEqual(await listed('commanderless-naval-administrations'), ['admin:11', 'admin:12'])
    assert.deepEqual(await listed('commanderless-sectors'), ['sector:21', 'sector:22'])

    db.close()
  })
}

const main = async () => {
  // One entry per utility a case area loads, by file name under src/renderer/utilities; a case reads it as `modules['<name>']`.
  const modules = await loadUtilities([
    'jump-graph',
    'route-plan',
    'haul-plan',
    'history',
    'terraforming',
    'habitability',
    'minerals',
    'mineral-outlook',
    'math',
    'colonies',
    'provenance',
    'commanders',
    'research',
    'designed-tech',
    'production',
    'terraform-capacity',
    'logistics',
    'fuel-donors',
    'warnings/common',
    'warnings/index',
  ], { stubs: STUBS })

  defineCases(modules)

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
