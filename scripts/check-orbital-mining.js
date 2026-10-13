/*
  Calibrates the Mineral Outlook's orbital mining estimate (utilities/minerals.js `orbitalMinerRate` through utilities/mineral-outlook.js `orbitalRateResult`, and `surfaceRateResult` for the colony mines at the same colony) against the mineral ledger a save holds, read-only.

  node scripts/check-orbital-mining.js [--save <save.db> <GameID> <RaceID>]... [--increments <n>]

  With no options it runs on the repository's modded save (AuroraDB.db, game 140, race 784) and the stock 2.7.1 save one folder up (AuroraDB_271_skoormit_saved.db, game 138, race 785). --increments sets how many production increments of the ledger the window of a flat deposit covers (default 5).

  What is compared. The game's ledger logs, once per production increment, the tonnes each colony mined of each mineral (MineralDataType 1), and that amount is the colony's whole mining output that increment (mines and orbital miners together, civilian complexes apart) times the deposit's accessibility times the years the increment covers. So for each colony with orbital miners the check works out, from the save's rows and with the app's own functions, the t/yr the page would show (the sum over the colony's ships, with the naval admin chain, plus the colony's own mines), multiplies it by the years between two production increments of the race's ledger (365-day years, as the page annualises) and sets it against the ledger amount of that increment: expected, observed, residual and the window it covers, per colony and mineral.

  What a case can and cannot show. A deposit at or above half its original amount keeps its accessibility, so the saved accessibility is the one every increment of the window used and the agreement is exact (flat, tolerance 1e-6 relative; floating point agrees far closer). A deposit below half loses accessibility as it is mined and the game rounds it to 0.01 after each increment, so the saved value is the one after the last increment: only the last increment is compared, and the ledger may exceed the expectation by up to two rounding steps (declining). The state is the save's: a crew, commander, admin chain, ship or deposit that changed inside the window shows as a residual, which is why the window is short. NPR races keep no ledger, so their orbital miners are reported as unobservable, not as agreeing. A class of case the saves hold none of (a short crew, a damaged module, a colony with no admin chain) is reported UNSUPPORTED and asserted nothing about; unknown is never taken as 0 or as agreement.

  Beyond the ledger it checks: a colony that buys its civilian complexes' minerals and ships them by mass driver has no ledger mining at all (the correction `unloggedMining` carries, kept) and the correction holds that colony's orbital rate; a colony whose miners are all over the race's orbital diameter limit has an expected rate of 0 and, where the race keeps a ledger, no ledger mining; and every colony the ledger shows mining at the last increment is one the app reads. Worked cases on synthetic rows (labelled so) pin the arithmetic of the rule where the saves hold no case: one module, a short crew, no crew, no commander, an unknown admin chain, a body over the limit and overlapping miners.

  Agreement of the formula with the ledger does not make the estimate exact: the rate is today's, not a forecast of ships, crews, commanders, admin ranges, deposits or the production cycle that change later.
*/
const path = require('path')
const fs = require('fs')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')

const root = path.resolve(__dirname, '..')
const DEFAULT_SAVES = [
  { file: 'AuroraDB.db', game: 140, race: 784 },
  { file: '../AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
]
const DEFAULT_INCREMENTS = 5
const WINDOW_DAYS = 40
const SECONDS_PER_YEAR = 365 * 86400
const FLAT_TOLERANCE = 1e-6
const WINDOW_TOLERANCE = 1e-3
const ACCESSIBILITY_STEP = 0.01
const DECLINE_STEPS = 2
const SURFACE_TOLERANCE = 0.005
const LOW_ACCESSIBILITY = 0.3

let failures = 0
let checks = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const parseArguments = (argv) => {
  const saves = []
  let increments = DEFAULT_INCREMENTS

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--save') {
      saves.push({ file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
    } else if (argv[index] === '--increments') {
      increments = Number(argv[++index])
    } else {
      console.error(`Unknown option ${argv[index]}`)
      process.exit(2)
    }
  }

  if (!(increments >= 1)) {
    console.error('--increments takes a whole number of 1 or more')
    process.exit(2)
  }

  return { saves: saves.length ? saves : DEFAULT_SAVES, increments: Math.floor(increments) }
}

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does.
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

    resolve({
      file: path.basename(resolved),
      query: (sql) => new Promise((resolve, reject) => raw.all(sql, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))),
      close: () => raw.close(),
    })
  })
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

const near = (actual, expected, tolerance = 1e-9) => Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

const percent = (value) => {
  if (value === null) {
    return 'n/a'
  }

  const text = (value * 100).toFixed(4)

  return Number(text) === 0 ? '0.0000%' : `${value > 0 ? '+' : ''}${text}%`
}

const tonnes = (value) => (value === null ? 'n/a' : (Number(value.toFixed(6)) === 0 ? '0.000000' : value.toFixed(6)))

const days = (seconds) => (seconds / 86400).toFixed(2)

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b)

  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}

// One synthetic admin command: its commander's bonus 1.2 at a 50% share is a chain of 1 + (1.2 - 1) x 0.5 = 1.1 for ships in system 5 under command 1.
const syntheticAdmins = (over = {}) => ({ 1: { NavalAdminCommandID: 1, SystemID: 5, ParentCommandID: 0, BonusValue: 1.2, Share: 0.5, Eligible: true, Unknown: null, Systems: new Set([5]), ...over } })

// A synthetic orbital miner row: 10 modules of a class crewed 100, a race that mines 14 t per module a year, commander bonus 1.25, a body of 1,000 km under a limit of 4,000, accessibility 0.5, in system 5 under command 1.
const syntheticRow = (over = {}) => ({ MiningModules: 10, MineProduction: 14, CommanderBonus: 1.25, Accessibility: 0.5, Diameter: 1000, MaximumOrbitalMiningDiameter: 4000, ClassCrew: 100, CurrentCrew: 100, SystemID: 5, NavalAdminCommandID: 1, ...over })

// The rule on synthetic rows, with the expected number written out from modules x per-module output x commander x chain x crew share x accessibility (not by calling the function under test).
const worked = (app) => {
  const { minerals, outlook, provenance } = app
  const value = (row, admins = syntheticAdmins()) => provenance.valueOrNull(outlook.orbitalRateResult(row, admins))
  const cases = [
    ['SYNTHETIC full crew, commander 1.25, chain 1.1: 10 x 14 x 1.25 x 1.1 x 1 x 0.5', value(syntheticRow()), 10 * 14 * 1.25 * 1.1 * 1 * 0.5],
    ['SYNTHETIC one module: 1 x 14 x 1.25 x 1.1 x 1 x 0.5', value(syntheticRow({ MiningModules: 1 })), 1 * 14 * 1.25 * 1.1 * 1 * 0.5],
    ['SYNTHETIC undermanned, 30 of 100 crew aboard: the crew share 0.3 scales the output once', value(syntheticRow({ CurrentCrew: 30 })), 10 * 14 * 1.25 * 1.1 * 0.3 * 0.5],
    ['SYNTHETIC no crew aboard: 0, not unknown and not full output', value(syntheticRow({ CurrentCrew: 0 })), 0],
    ['SYNTHETIC over-crewed (120 of 100): no faster than the class crew', value(syntheticRow({ CurrentCrew: 120 })), 10 * 14 * 1.25 * 1.1 * 1 * 0.5],
    ['SYNTHETIC a class with no crew is never short: full output', value(syntheticRow({ ClassCrew: 0, CurrentCrew: 0 })), 10 * 14 * 1.25 * 1.1 * 1 * 0.5],
    ['SYNTHETIC no commander bonus (the row carries 1)', value(syntheticRow({ CommanderBonus: 1 })), 10 * 14 * 1 * 1.1 * 1 * 0.5],
    ['SYNTHETIC ship outside its command\'s range: chain 1', value(syntheticRow({ SystemID: 6 })), 10 * 14 * 1.25 * 1 * 1 * 0.5],
    ['SYNTHETIC command without an eligible commander: chain 1', value(syntheticRow(), syntheticAdmins({ Eligible: false })), 10 * 14 * 1.25 * 1 * 1 * 0.5],
    ['SYNTHETIC body wider than the race\'s limit: a real 0', value(syntheticRow({ Diameter: 4001 })), 0],
    ['SYNTHETIC body exactly at the limit is open', value(syntheticRow({ Diameter: 4000 })), 10 * 14 * 1.25 * 1.1 * 1 * 0.5],
    ['SYNTHETIC accessibility 0.1 (the floor)', value(syntheticRow({ Accessibility: 0.1 })), 10 * 14 * 1.25 * 1.1 * 1 * 0.1],
  ]

  cases.forEach(([name, actual, expected]) => check(name, actual !== null && near(actual, expected), `expected ${expected}, rule ${actual}`))
  check('SYNTHETIC an admin chain the save does not settle is unknown (null), never 1', value(syntheticRow(), syntheticAdmins({ Unknown: 'ranks not in the save', Eligible: null })) === null)
  check('SYNTHETIC a commander bonus that is not a number is unknown, never 1', value(syntheticRow({ CommanderBonus: null })) === null)
  check('SYNTHETIC a ship with no recorded crew is unknown, never full', value(syntheticRow({ CurrentCrew: null })) === null)

  const first = outlook.orbitalRateResult(syntheticRow(), syntheticAdmins())
  const second = outlook.orbitalRateResult(syntheticRow({ MiningModules: 1, CommanderBonus: 1.5 }), syntheticAdmins())
  const overlap = outlook.miningSum([first, second]).value

  check('SYNTHETIC overlapping miners at one deposit add: 10 modules at 1.25 and 1 module at 1.5', near(overlap, 10 * 14 * 1.25 * 1.1 * 0.5 + 1 * 14 * 1.5 * 1.1 * 0.5), `sum ${overlap}`)
  check('SYNTHETIC the mass-driver correction holds an orbital miner\'s rate, and an unknown one makes the mineral unknown', (() => {
    const row = { ...syntheticRow(), MassDriverExport: 1, MaterialID: 1 }
    const known = minerals.unloggedMining({ surface: [], orbital: [row, { ...row, MiningModules: 1 }], navalAdmins: syntheticAdmins() })
    const unknown = minerals.unloggedMining({ surface: [], orbital: [row], navalAdmins: syntheticAdmins({ Unknown: 'x', Eligible: null }) })

    return near(known[1], (10 + 1) * 14 * 1.25 * 1.1 * 0.5) && unknown[1] === null
  })())
}

// The saved deposit as the game's decline rule sees it: below half its original amount (and above the accessibility floor) it declines with the amount mined, so its saved accessibility is the one after the last increment, not the one the earlier increments used.
const isDeclining = (minerals, deposit) => deposit.OriginalAcc > minerals.ACCESSIBILITY_FLOOR && deposit.HalfOriginalAmount > 0 && deposit.Amount < deposit.HalfOriginalAmount

const addRate = (total, rate) => (total === null || rate === null ? null : total + rate)

// The race's colonies that mine (orbital miners assigned to the colony, colony mines, or both), each with the app's own expected rate per mineral: `{ id, name, bodyId, ships, mines, massDriver, overLimit, minerals: Map(MaterialID -> { deposit, orbital, surface }) }` with a rate null where the app cannot work it out.
const colonies = ({ app, orbital, surface, navalAdmins, damagedShips }) => {
  const { outlook, provenance } = app
  const byId = new Map()
  const entry = (row) => {
    if (!byId.has(row.PopulationID)) {
      byId.set(row.PopulationID, { id: row.PopulationID, name: row.PopName, bodyId: row.SystemBodyID, ships: new Map(), mines: false, massDriver: Boolean(row.MassDriverExport), overLimit: false, minerals: new Map() })
    }

    return byId.get(row.PopulationID)
  }
  const mineralOf = (colony, row) => {
    if (!colony.minerals.has(row.MaterialID)) {
      colony.minerals.set(row.MaterialID, { deposit: { Amount: row.Amount, Accessibility: row.Accessibility, HalfOriginalAmount: row.HalfOriginalAmount, OriginalAcc: row.OriginalAcc }, orbital: 0, surface: 0 })
    }

    return colony.minerals.get(row.MaterialID)
  }

  orbital.forEach((row) => {
    const colony = entry(row)
    const mineral = mineralOf(colony, row)

    colony.ships.set(row.ShipID, row)
    colony.overLimit = colony.overLimit || row.Diameter > row.MaximumOrbitalMiningDiameter
    mineral.orbital = addRate(mineral.orbital, provenance.valueOrNull(outlook.orbitalRateResult(row, navalAdmins)))
  })

  surface.forEach((row) => {
    const colony = entry(row)
    const mineral = mineralOf(colony, row)

    colony.massDriver = colony.massDriver || Boolean(row.MassDriverExport)

    if (!row.MassDriverExport) {
      colony.mines = true
      mineral.surface = addRate(mineral.surface, provenance.valueOrNull(outlook.surfaceRateResult({ ...row, CivilianMineCount: 0 })))
    }
  })

  byId.forEach((colony) => {
    colony.damaged = [...colony.ships.keys()].some((shipId) => damagedShips.has(shipId))
  })

  return byId
}

const tagsOf = (app, colony, shared) => {
  const ships = [...colony.ships.values()]
  const tags = []

  if (ships.length) {
    tags.push(colony.mines ? 'mixed: colony mines and orbital miners' : 'orbital miners only')
    tags.push(ships.length > 1 ? 'overlapping: 2+ ships at the colony' : 'a single ship')
    tags.push(ships.every((ship) => ship.MiningModules === 1) ? 'one-module ships only' : ships.some((ship) => ship.MiningModules === 1) ? 'one-module and larger ships together' : 'ships of 2+ modules only')
    tags.push(ships.some((ship) => ship.CurrentCrew < ship.ClassCrew) ? 'undermanned ship' : 'full crew')
    tags.push(ships.some((ship) => ship.CommanderBonus !== 1) ? 'commander mining bonus above 1' : 'no commander mining bonus (1)')
    tags.push(ships.some((ship) => app.minerals.navalAdminChainBonus(colony.admins, ship.SystemID, ship.NavalAdminCommandID) !== 1) ? 'naval admin chain above 1' : 'no naval admin chain (1)')
  } else {
    tags.push('colony mines only')
  }

  if (shared) {
    tags.push('body shared with a second mining colony of the race')
  }

  const deposits = [...colony.minerals.values()].map((mineral) => mineral.deposit)

  tags.push(deposits.some((deposit) => isDeclining(app.minerals, deposit)) ? 'a deposit below half (accessibility declining)' : 'deposits at or above half (accessibility flat)')

  if (deposits.some((deposit) => deposit.Accessibility <= LOW_ACCESSIBILITY)) {
    tags.push(`a deposit at accessibility ${LOW_ACCESSIBILITY} or less`)
  }

  return tags
}

const runRace = async (app, database, save, label, increments) => {
  const { minerals, mining, naval } = app
  const ids = { GameID: save.game, RaceID: save.race }
  const [race] = await rowsOf(database, `select NPR, MineProduction, MaximumOrbitalMiningDiameter from FCT_Race where RaceID = ${save.race}`)
  const [game] = await rowsOf(database, `select GameTime from FCT_Game where GameID = ${save.game}`)
  const [{ Present: ledgerTable }] = await rowsOf(database, "select count(*) as Present from sqlite_master where type = 'table' and name = 'FCT_RaceMineralData'")

  if (!race || !game) {
    console.log(`SKIP  ${label}: game ${save.game} race ${save.race} is not in ${database.file}`)
    return
  }

  const navalAdmins = await naval.loadNavalAdmins(database, { ...ids, bonusId: mining.MINING_BONUS, share: 'Industrial' })
  const orbital = await rowsOf(database, mining.orbitalMiningQuery(ids))
  const surface = await rowsOf(database, mining.surfaceMiningQuery(ids))
  const [{ AllMiners: allMiners }] = await rowsOf(database, `select count(distinct FCT_Ship.ShipID) as AllMiners from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.MiningModules > 0 inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = ${save.game} and FCT_Ship.RaceID = ${save.race}`)
  const damagedShips = new Set((await rowsOf(database, `select distinct FCT_DamagedComponent.ShipID from FCT_DamagedComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_DamagedComponent.ComponentID where FCT_ShipDesignComponents.ComponentTypeID = 38 and FCT_DamagedComponent.Number > 0 and FCT_DamagedComponent.GameID = ${save.game}`)).map((row) => row.ShipID))
  const orbitalShips = new Set(orbital.map((row) => row.ShipID))
  const byColony = colonies({ app, orbital, surface, navalAdmins, damagedShips })

  byColony.forEach((colony) => {
    colony.admins = navalAdmins
  })

  const bodyColonies = new Map()

  byColony.forEach((colony) => bodyColonies.set(colony.bodyId, [...(bodyColonies.get(colony.bodyId) || []), colony]))

  const orbitalColonies = [...byColony.values()].filter((colony) => colony.ships.size)
  const surfaceOnly = [...byColony.values()].filter((colony) => !colony.ships.size && !colony.massDriver)

  console.log(`INFO  ${label}: ${database.file} game ${save.game} race ${save.race} (NPR ${race.NPR}), MineProduction ${race.MineProduction} t per module a year, orbital limit ${race.MaximumOrbitalMiningDiameter} km, game time ${game.GameTime}`)
  console.log(`INFO  ${label}: ${orbitalShips.size} orbital miner ships read by the page at ${orbitalColonies.length} colonies (${allMiners} ships with mining modules in the race in all; the rest are not at a colony they are assigned to), ${surfaceOnly.length} colonies with mines only, ${damagedShips.size} ships with a damaged mining module`)

  if (!orbitalColonies.length) {
    console.log(`UNSUPPORTED  ${label}: no orbital miner ship is assigned to a colony of this race in this save, so there is nothing of the orbital estimate to calibrate; one-module, short-crew, commander, admin and accessibility cases are all unsupported here`)
  }

  if (race.NPR) {
    console.log(`UNSUPPORTED  ${label}: the race is an NPR; the game keeps no mineral ledger for an NPR race, so its ${orbitalShips.size} orbital miners have no observed quantity (not agreement, not 0)`)
    return
  }

  if (!ledgerTable) {
    console.log(`UNSUPPORTED  ${label}: the save has no mineral ledger table (a save before 2.6)`)
    return
  }

  const production = minerals.PRODUCTION_TYPES.join(', ')
  const ticks = (await rowsOf(database, `select distinct Time from FCT_RaceMineralData where GameID = ${save.game} and RaceID = ${save.race} and MineralDataType in (${production}) and Time > ${game.GameTime - WINDOW_DAYS * 86400} order by Time`)).map((row) => row.Time)
  const [retained] = await rowsOf(database, `select min(Time) as First, max(Time) as Last, count(*) as Rows from FCT_RaceMineralData where GameID = ${save.game} and RaceID = ${save.race}`)

  if (ticks.length < 2) {
    console.log(`UNSUPPORTED  ${label}: the ledger holds ${ticks.length} production increments in the last ${WINDOW_DAYS} days, and a rate needs two ticks to give the years an increment covers`)
    return
  }

  const window = ticks.slice(-(increments + 1))
  const steps = window.slice(1).map((time, index) => ({ time, seconds: time - window[index], years: (time - window[index]) / SECONDS_PER_YEAR }))
  const last = steps[steps.length - 1]
  const ledgerRows = await rowsOf(database, `select PopulationID, MineralID, Time, Amount from FCT_RaceMineralData where GameID = ${save.game} and RaceID = ${save.race} and MineralDataType = 1 and Time > ${window[0]}`)
  const ledger = new Map()

  ledgerRows.forEach((row) => {
    const key = `${row.PopulationID}:${row.MineralID}:${row.Time}`

    ledger.set(key, (ledger.get(key) || 0) + row.Amount)
  })

  const observedAt = (colony, materialId, step) => ledger.get(`${colony.id}:${materialId}:${step.time}`) || 0
  const windowText = (list) => `${list.length} increments from ${days(game.GameTime - window[0])} to ${days(game.GameTime - list[list.length - 1].time)} days before the save`

  console.log(`INFO  ${label}: ledger of the race holds ${retained.Rows} rows from ${days(game.GameTime - retained.First)} to ${days(game.GameTime - retained.Last)} days before the save; ${ticks.length} production increments in the last ${WINDOW_DAYS} days; window ${windowText(steps)}; last increment ${last.seconds} s (${(last.years * 365).toFixed(3)} days) long, ending ${days(game.GameTime - last.time)} days before the save`)

  const cases = []
  const lastLedgerColonies = new Set(ledgerRows.filter((row) => row.Time === last.time).map((row) => row.PopulationID))

  byColony.forEach((colony) => {
    if (colony.massDriver || (colony.overLimit && !colony.mines) || colony.damaged) {
      return
    }

    const shared = (bodyColonies.get(colony.bodyId) || []).length > 1
    const tags = tagsOf(app, colony, shared)

    colony.minerals.forEach((mineral, materialId) => {
      const rate = mineral.orbital === null || mineral.surface === null ? null : mineral.orbital + mineral.surface

      if (rate === null) {
        cases.push({ colony, materialId, tags, unsupported: 'the app has no rate for this colony (an input is unknown)' })
        return
      }

      const declining = isDeclining(minerals, mineral.deposit)
      const used = declining ? [last] : steps
      const expected = used.reduce((total, step) => total + rate * step.years, 0)
      const observed = used.reduce((total, step) => total + observedAt(colony, materialId, step), 0)
      const lastExpected = rate * last.years
      const lastObserved = observedAt(colony, materialId, last)

      cases.push({ colony, materialId, tags, rate, declining, accessibility: mineral.deposit.Accessibility, used, expected, observed, relative: expected ? observed / expected - 1 : null, lastExpected, lastObserved, lastRelative: lastExpected ? lastObserved / lastExpected - 1 : null })
    })
  })

  const readable = cases.filter((item) => !item.unsupported)

  cases.filter((item) => item.unsupported).forEach((item) => console.log(`UNSUPPORTED  ${label}: colony ${item.colony.id} ${item.colony.name} mineral ${item.materialId}: ${item.unsupported}`))

  // One line per colony: the totals over its minerals at the last increment, the residual and the window.
  const perColony = new Map()

  readable.filter((item) => item.colony.ships.size).forEach((item) => {
    const total = perColony.get(item.colony.id) || { colony: item.colony, expected: 0, observed: 0, tags: item.tags, declining: 0, flat: 0 }

    total.expected += item.lastExpected
    total.observed += item.lastObserved
    total[item.declining ? 'declining' : 'flat']++
    perColony.set(item.colony.id, total)
  })

  perColony.forEach((total) => {
    const { colony } = total
    const modules = [...colony.ships.values()].reduce((sum, ship) => sum + ship.MiningModules, 0)

    console.log(`CASE  ${label}: colony ${colony.id} "${colony.name}" ${colony.ships.size} ships ${modules} modules | ${total.tags.slice(0, 6).join('; ')} | last increment (${days(game.GameTime - last.time)} d before the save, ${last.seconds} s): expected ${tonnes(total.expected)} t, observed ${tonnes(total.observed)} t, residual ${tonnes(total.observed - total.expected)} t (${percent(total.expected ? total.observed / total.expected - 1 : null)}) over ${total.flat} flat and ${total.declining} declining deposits`)
  })

  const orbitalCases = readable.filter((item) => item.colony.ships.size)
  const flat = orbitalCases.filter((item) => !item.declining && item.expected > 0)
  const declining = orbitalCases.filter((item) => item.declining && item.lastExpected > 0)
  const worst = (list, pick) => list.reduce((maximum, item) => Math.max(maximum, Math.abs(pick(item))), 0)

  if (orbitalCases.length) {
    check(`${label}: orbital colonies at the ledger: ${new Set(orbitalCases.map((item) => item.colony.id)).size} colonies, ${orbitalCases.length} colony-mineral cases are compared and none lacks a ledger amount where the app expects mining`, orbitalCases.every((item) => item.lastExpected === 0 || item.lastObserved > 0), `${orbitalCases.filter((item) => item.lastExpected > 0 && !(item.lastObserved > 0)).length} without a ledger amount`)
    check(`${label}: flat deposits, last increment: ${flat.length} cases, expected equals observed within ${FLAT_TOLERANCE}`, flat.length > 0 && flat.every((item) => Math.abs(item.lastRelative) <= FLAT_TOLERANCE), `max |residual| ${percent(worst(flat, (item) => item.lastRelative))}, median ${percent(median(flat.map((item) => item.lastRelative)))}`)
    check(`${label}: flat deposits over the whole window (${windowText(steps)}): ${flat.length} cases, expected equals observed within ${WINDOW_TOLERANCE * 100}% (the save keeps only the final state, so a ship, crew or command that changed inside the window leaves a small earlier-increment residual)`, flat.length > 0 && flat.every((item) => Math.abs(item.relative) <= WINDOW_TOLERANCE), `max |residual| ${percent(worst(flat, (item) => item.relative))}; ${flat.filter((item) => Math.abs(item.relative) > FLAT_TOLERANCE).length} cases outside ${FLAT_TOLERANCE}, all of which agree within ${FLAT_TOLERANCE} at the last increment`)

    const bounded = (item) => item.lastRelative >= -FLAT_TOLERANCE && item.lastRelative <= (DECLINE_STEPS * ACCESSIBILITY_STEP) / item.accessibility + FLAT_TOLERANCE

    check(`${label}: declining deposits, last increment: ${declining.length} cases, the ledger is the expectation or up to ${DECLINE_STEPS} accessibility steps of ${ACCESSIBILITY_STEP} above it`, declining.every(bounded), `steps seen ${[...new Set(declining.map((item) => Math.round((item.lastRelative * item.accessibility) / ACCESSIBILITY_STEP)))].sort().join(', ') || 'none'}; max residual ${percent(worst(declining, (item) => item.lastRelative))}; ${declining.filter((item) => !bounded(item)).length} outside`)
  }

  const classes = new Map()

  orbitalCases.forEach((item) => item.tags.forEach((tag) => classes.set(tag, [...(classes.get(tag) || []), item])))
  ;[...classes.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([tag, list]) => {
    const exact = list.filter((item) => !item.declining && item.expected > 0)
    const colonyCount = new Set(list.map((item) => item.colony.id)).size

    console.log(`CLASS  ${label}: ${tag}: ${colonyCount} colonies, ${list.length} cases; flat deposits: ${exact.length} cases, max |residual| ${exact.length ? percent(worst(exact, (item) => item.relative)) : 'n/a'} over ${exact.length ? windowText(steps) : 'no window'}; last increment, all deposits: median ${percent(median(list.map((item) => item.lastRelative)))}`)
  })

  const wanted = [
    ['one-module ships only', 'a ship with one orbital mining module'],
    ['overlapping: 2+ ships at the colony', 'several miners at one colony'],
    ['ships of 2+ modules only', 'larger miners'],
    ['mixed: colony mines and orbital miners', 'colony mines and orbital miners at one colony'],
    ['body shared with a second mining colony of the race', 'a body two colonies of the race mine'],
    ['commander mining bonus above 1', 'a commander with a mining bonus'],
    ['no commander mining bonus (1)', 'a ship without a commander mining bonus'],
    ['naval admin chain above 1', 'a naval admin chain bonus'],
    ['no naval admin chain (1)', 'a ship outside any naval admin chain'],
    ['full crew', 'a fully crewed ship'],
    ['undermanned ship', 'an undermanned ship'],
    ['a deposit below half (accessibility declining)', 'a deposit below half its original amount'],
    ['deposits at or above half (accessibility flat)', 'deposits at or above half their original amount'],
    [`a deposit at accessibility ${LOW_ACCESSIBILITY} or less`, `a deposit at accessibility ${LOW_ACCESSIBILITY} or less`],
  ]

  if (orbitalCases.length) {
    wanted.forEach(([tag, text]) => {
      const list = classes.get(tag) || []

      console.log(list.length ? `COVERED  ${label}: ${text}: ${new Set(list.map((item) => item.colony.id)).size} colonies` : `UNSUPPORTED  ${label}: ${text}: no such case in this save, so the estimate is checked against nothing there`)
    })
    console.log(`INFO  ${label}: commander bonuses seen ${[...new Set(orbital.map((row) => row.CommanderBonus))].sort().join(', ')}; naval admin chains seen ${[...new Set(orbital.map((row) => Number(minerals.navalAdminChainBonus(navalAdmins, row.SystemID, row.NavalAdminCommandID).toFixed(6))))].sort().join(', ')}; modules per ship seen ${[...new Set(orbital.map((row) => row.MiningModules))].sort((a, b) => a - b).join(', ')}; crew shares seen ${[...new Set(orbital.map((row) => (row.ClassCrew > 0 ? Math.min(1, row.CurrentCrew / row.ClassCrew) : 1)))].sort().join(', ')}; accessibility from ${Math.min(...orbital.map((row) => row.Accessibility))} to ${Math.max(...orbital.map((row) => row.Accessibility))}`)
  }

  // Colonies that ship their civilian complexes' output by mass driver: the game logs no mining for them, and the correction carries their output, orbital miners included.
  const exported = [...byColony.values()].filter((colony) => colony.massDriver)

  if (exported.length) {
    const unlogged = minerals.unloggedMining({ surface: surface.filter((row) => row.MassDriverExport), orbital: orbital.filter((row) => row.MassDriverExport), navalAdmins })
    const expectedUnlogged = {}

    exported.forEach((colony) => colony.minerals.forEach((mineral, materialId) => {
      const rate = mineral.orbital

      expectedUnlogged[materialId] = expectedUnlogged[materialId] === null || rate === null ? null : (expectedUnlogged[materialId] || 0) + rate
    }))

    const orbitalExported = exported.filter((colony) => colony.ships.size)
    const withLedger = exported.filter((colony) => ledgerRows.some((row) => row.PopulationID === colony.id))

    check(`${label}: mass-driver export colonies (${exported.length}, ${orbitalExported.length} with orbital miners) have no ledger mining in the window, as the correction assumes`, withLedger.length === 0, `${withLedger.length} with ledger mining`)

    if (orbitalExported.length) {
      check(`${label}: the unlogged-mining correction holds the orbital rate of those colonies' miners (CMC correction kept)`, Object.entries(expectedUnlogged).every(([materialId, rate]) => (rate === null ? unlogged[materialId] === null : unlogged[materialId] !== null && unlogged[materialId] >= rate - 1e-9)), `${Object.keys(unlogged).length} minerals corrected`)
    } else {
      console.log(`UNSUPPORTED  ${label}: no mass-driver export colony of this race has orbital miners, so the correction's hold on an orbital rate has no case here`)
    }
  } else {
    console.log(`UNSUPPORTED  ${label}: no colony of this race exports its civilian complexes' minerals by mass driver, so the correction has no case here`)
  }

  // Colonies whose orbital miners are all over the race's diameter limit: the app expects 0 and the ledger, where the race keeps one, none.
  const over = [...byColony.values()].filter((colony) => colony.overLimit && !colony.mines && !colony.massDriver)

  if (over.length) {
    const zero = over.every((colony) => [...colony.minerals.values()].every((mineral) => mineral.orbital === 0))
    const logged = over.filter((colony) => ledgerRows.some((row) => row.PopulationID === colony.id))

    check(`${label}: colonies over the orbital diameter limit (${over.length}): the app expects 0 and the ledger holds no mining for them in the window`, zero && logged.length === 0, `${logged.length} with ledger mining`)
  } else if (orbitalCases.length) {
    console.log(`UNSUPPORTED  ${label}: no orbital miner of this race sits over the diameter limit, so the limit is checked against nothing in the ledger here`)
  }

  if (damagedShips.size) {
    console.log(`UNSUPPORTED  ${label}: ${damagedShips.size} ships have a damaged mining module; the page counts the class's modules, so those colonies are left out of the comparison and nothing is asserted about them`)
  } else if (orbitalCases.length) {
    console.log(`UNSUPPORTED  ${label}: no ship has a damaged orbital mining module, so the page's use of the class's whole module count is checked against nothing here`)
  }

  // Everything the ledger shows mined at the last increment is a colony the app reads (an orbital miner or a mine it knows of).
  const known = new Set(byColony.keys())
  const unexplained = [...lastLedgerColonies].filter((id) => !known.has(id))

  check(`${label}: every colony the ledger shows mining at the last increment is read by the app (${lastLedgerColonies.size} colonies)`, unexplained.length === 0, `${unexplained.length} not read: ${unexplained.slice(0, 5).join(', ')}`)

  // The same machinery on colony mines alone: it shows the increments and the year used are right for the save, so a residual in the orbital cases is not the clock.
  const harness = readable.filter((item) => !item.colony.ships.size && !item.declining && item.expected > 0)

  if (harness.length) {
    check(`${label}: harness, colony mines only (${new Set(harness.map((item) => item.colony.id)).size} colonies, ${harness.length} flat cases over ${windowText(steps)}): expected equals observed within ${SURFACE_TOLERANCE * 100}%`, harness.every((item) => Math.abs(item.relative) <= SURFACE_TOLERANCE), `max |residual| ${percent(worst(harness, (item) => item.relative))}, median ${percent(median(harness.map((item) => item.relative)))}`)
  }
}

const main = async () => {
  const { saves, increments } = parseArguments(process.argv.slice(2))
  const utilities = await loadUtilities(['minerals', 'mining-data', 'naval-admins', 'mineral-outlook', 'provenance'])
  const app = { minerals: utilities.minerals, mining: utilities['mining-data'], naval: utilities['naval-admins'], outlook: utilities['mineral-outlook'], provenance: utilities.provenance }

  worked(app)

  for (const [position, save] of saves.entries()) {
    const label = `save ${position + 1}`
    const database = await openSave(save.file)

    if (!database) {
      console.log(`SKIP  ${label}: ${save.file} is not there (not run)`)
      continue
    }

    try {
      await runRace(app, database, save, label, increments)
    } finally {
      database.close()
    }
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
