/*
  Checks the mining-site readiness (src/renderer/utilities/mining-sites.js and the three warnings that read it) against worked fixtures and against the colonies and orbital miners saves hold, read-only.

  node scripts/check-mining-sites.js [--save <save.db> <GameID> <RaceID>]...

  With no options it runs on the repository's modded save (AuroraDB.db, game 140, race 784) and the stock 2.7.1 save one folder up (AuroraDB_271_skoormit_saved.db, game 138, race 785).

  It proves: every verdict of the model on fixtures (a deposit never surveyed against one empty or exhausted, the orbital diameter limit, crew, the colony at the body and the assignment, the workforce of manned mines, radiation and mine production, each way minerals leave a colony, a productive isolated site being delivery-blocked and never idle, a save with no version making the rules read from the game unknown), then on each save that the sites join the same colonies and fleets as a direct query, that each warning lists only the sites its verdict names and that every row names what it lacks and links the colony or fleet to fix.
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
const STUBS = {
  'electron-store': 'export default class Config { constructor() {} get store() { return {} } set store(value) {} }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const KEYS = ['wasted-mining-capacity', 'mass-driver-orphans', 'stranded-miners']

let failures = 0
let checks = 0
let mutations = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const parseArguments = (argv) => {
  const saves = []

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--save') {
      saves.push({ file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
    } else {
      console.error(`Unknown option ${argv[index]}`)
      process.exit(2)
    }
  }

  return saves.length ? saves : DEFAULT_SAVES
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

const RACE = 784
const colony = (over = {}) => ({ PopulationID: 1, PopName: 'Alpha', SystemID: 10, Population: 5, Efficiency: 1, Capital: 0, MassDriverDest: 0, MineProduction: 600, RadiationLevel: 0, Surveyed: 1, Deposits: 2, DepositGaps: 0, Depleted: 0, Manned: 3, Automated: 0, Civilian: 0, MineGaps: 0, MineNames: '3x Mine', Drivers: 0, DriverGaps: 0, Factories: 0, FactoryGaps: 0, DestinationID: null, DestinationRaceID: null, DestinationSystemID: null, DestinationDrivers: 0, DestinationGaps: 0, OtherColonies: 2, HaulOrders: 0, ...over })
const noMines = { Manned: 0, Automated: 0, Civilian: 0, MineNames: null }
const fleet = (over = {}) => ({ FleetID: 100, FleetName: 'Miner', AssignedPopulationID: 0, Diameter: 1000, MaximumDiameter: 4000, MineProduction: 600, Surveyed: 1, Deposits: 2, DepositGaps: 0, Depleted: 0, ColonyID: 1, ColonyName: 'Alpha', AssignedID: null, AssignedName: null, ShipID: 1, CurrentCrew: 10, ClassCrew: 10, Modules: 5, ClassLines: 3, WorkingModules: 5, ...over })

const worked = (model) => {
  const { assessMiningSites, depositState, missingNeeds, unknownNeeds, deliveryVerdict } = model
  const assess = (colonies, fleets = [], version = '2.7.1') => assessMiningSites({ colonies, fleets }, { RaceID: RACE, version })
  const only = (row, version) => assess([row], [], version).colonies[0]
  const keys = (needs) => needs.map((need) => need.key)
  const text = (site, options) => missingNeeds(site, options).map((need) => need.text).join('; ')
  const orbitalOnly = (over, version) => assess([colony(noMines)], [fleet(over)], version)
  const delivered = (over) => only(colony(over))

  const base = only(colony())
  check('worked: manned mines with workers on a deposit produce, and idle is 0', base.idle === 0 && base.producing === 1 && base.output === 1 && missingNeeds(base).length === 0)
  check('worked: a productive isolated site is delivery-blocked, never idle', base.delivery.state === 'blocked' && deliveryVerdict(base) === 1 && base.idle === 0)
  check('worked: an isolated site names every missing delivery prerequisite', keys(missingNeeds(base, { delivery: true })).join() === 'drivers,destination' && text(base, { delivery: true }).includes('No mass driver destination'))

  check('worked: a surveyed body with no deposit row is empty, a verdict of 0 that names the missing deposit', depositState(colony({ Deposits: 0 })) === 'empty' && only(colony({ Deposits: 0 })).idle === 1 && text(only(colony({ Deposits: 0 }))) === 'No mineral deposit on the body')
  check('worked: a surveyed body with rows at 0 t is exhausted, not empty', depositState(colony({ Deposits: 0, Depleted: 1 })) === 'exhausted' && text(only(colony({ Deposits: 0, Depleted: 1 }))).includes('exhausted'))
  const unsurveyed = only(colony({ Surveyed: 0, Deposits: 0 }))
  check('worked: an unsurveyed body is unknown, never empty: no verdict, its deposits unknown and the survey the input', depositState(colony({ Surveyed: 0 })) === 'unsurveyed' && unsurveyed.idle === null && missingNeeds(unsurveyed).length === 0 && unknownNeeds(unsurveyed).some((need) => need.key === 'deposit' && need.inputs.some((input) => input.includes('survey'))))
  check('worked: a survey that is not stored, and a deposit amount that is not stored, are unknown too', depositState(colony({ Surveyed: null })) === 'unknown' && depositState(colony({ Deposits: 0, DepositGaps: 1 })) === 'unknown' && only(colony({ Deposits: 0, DepositGaps: 1 })).idle === null)
  check('worked: a deposit present beats a gap in another row', depositState(colony({ Deposits: 1, DepositGaps: 1 })) === 'present')

  check('worked: radiation of 10000 stops the mines and 9999 does not', only(colony({ RadiationLevel: 10000 })).idle === 1 && only(colony({ RadiationLevel: 9999 })).idle === 0 && only(colony({ RadiationLevel: null })).idle === null)
  check('worked: no race mine production stops the mines, an unstored one leaves them unknown', only(colony({ MineProduction: 0 })).idle === 1 && text(only(colony({ MineProduction: 0 }))) === 'The race has no mine production' && only(colony({ MineProduction: null })).idle === null)
  const several = only(colony({ Deposits: 0, RadiationLevel: 20000, MineProduction: 0, Efficiency: 0 }))
  check('worked: every missing prerequisite is listed apart, each owned by the colony', keys(missingNeeds(several)).join() === 'deposit,radiation,mineProduction,staffing' && missingNeeds(several).every((need) => need.owner === 'colony'))

  check('worked: manned mines with an efficiency of 0 have no workforce', only(colony({ Efficiency: 0 })).idle === 1 && text(only(colony({ Efficiency: 0 }))).includes('workforce'))
  check('worked: automated mines need no workforce and ask for none', only(colony({ Manned: 0, Automated: 3, Efficiency: 0, Population: 0 })).idle === 0 && !keys(only(colony({ Manned: 0, Automated: 3, Efficiency: 0 })).prerequisites).includes('staffing'))
  const mixed = only(colony({ Automated: 3, Efficiency: 0 }))
  check('worked: manned and automated mines at a colony with no workforce: the manned mines are idle, the automated still produce, so the site is not delivery-free', mixed.idle === 1 && mixed.output === 1 && mixed.delivery.state === 'blocked')
  check('worked: an efficiency not stored falls back to the population: none means no workers, unknown population leaves it undecided', only(colony({ Efficiency: null, Population: 0 })).idle === 1 && only(colony({ Efficiency: null, Population: 5 })).idle === null)
  check('worked: a colony with no mining installation and no orbital miners is no site', assess([colony(noMines)]).colonies.length === 0)
  const gap = only(colony({ Manned: 0, MineGaps: 1, Deposits: 0 }))
  check('worked: an installation that cannot be read leaves the capacity and the verdict unknown, never 0, while a site that cannot be wasted stays 0', gap.idle === null && gap.capacity === null && gap.capacityInputs.length > 0 && only(colony({ Manned: 0, MineGaps: 1 })).idle === 0)
  const civilian = only(colony({ Manned: 0, Civilian: 3 }))
  check('worked: civilian complexes alone are no output to deliver (the stockpiling warning covers them)', civilian.idle === 0 && civilian.output === 0 && civilian.delivery === null && deliveryVerdict(civilian) === 0)

  const driver = { Drivers: 2, MassDriverDest: 2, DestinationID: 2, DestinationRaceID: RACE, DestinationSystemID: 10, DestinationDrivers: 1 }
  check('worked: drivers pointing at a colony of the race in the system that has drivers are a way out', delivered(driver).delivery.state === 'connected' && delivered(driver).delivery.via === 'drivers' && deliveryVerdict(delivered(driver)) === 0)
  check('worked: a destination without drivers is blocked and names the receiver', delivered({ ...driver, DestinationDrivers: 0 }).delivery.state === 'blocked' && keys(missingNeeds(delivered({ ...driver, DestinationDrivers: 0 }), { delivery: true })).join() === 'receiver')
  check('worked: a colony without drivers is blocked and names its drivers', keys(missingNeeds(delivered({ ...driver, Drivers: 0 }), { delivery: true })).join() === 'drivers')
  const destinations = { gone: { DestinationID: null }, self: { MassDriverDest: 1, DestinationID: 1 }, foreign: { DestinationRaceID: 5 }, elsewhere: { DestinationSystemID: 11 } }
  check('worked: a destination that is gone, the colony itself, another race\'s or in another system is no way out', Object.entries(destinations).every(([, over]) => delivered({ ...driver, ...over }).delivery.state === 'blocked' && keys(missingNeeds(delivered({ ...driver, ...over }), { delivery: true })).includes('destination')))
  check('worked: the text names which destination it is', text(delivered({ ...driver, DestinationRaceID: 5 }), { delivery: true }).includes('another race') && text(delivered({ ...driver, DestinationSystemID: 11 }), { delivery: true }).includes('another system'))
  check('worked: with no other colony of the race in the system the missing destination says so', text(delivered({ OtherColonies: 0 }), { delivery: true }).includes('No other colony'))
  check('worked: a colony with a loading order, the capital and a colony with factories use their minerals', [['hauled', { HaulOrders: 1 }], ['local', { Capital: 1 }], ['local', { Factories: 2 }]].every(([via, over]) => delivered(over).delivery.state === 'connected' && delivered(over).delivery.via === via && deliveryVerdict(delivered(over)) === 0))
  const sender = (over = {}) => colony({ ...noMines, PopulationID: 3, PopName: 'Sender', Drivers: 2, MassDriverDest: 1, DestinationID: 1, DestinationRaceID: RACE, DestinationSystemID: 10, DestinationDrivers: 1, ...over })
  const hubOf = (receiver, senders) => assess([colony(receiver), ...senders.map((row) => ({ ...row, DestinationDrivers: receiver.Drivers }))]).colonies.find((site) => site.id === 1)
  check('worked: a colony with drivers that another colony of the race in the system with drivers points at is a hub', hubOf({ Drivers: 1 }, [sender()]).delivery.state === 'connected' && hubOf({ Drivers: 1 }, [sender()]).delivery.via === 'hub' && deliveryVerdict(hubOf({ Drivers: 1 }, [sender()])) === 0)
  check('worked: a destination setting that points here proves no inbound path unless the sender has drivers, the colony has drivers, and both are in the system', [hubOf({ Drivers: 0 }, [sender()]), hubOf({ Drivers: 1 }, [sender({ Drivers: 0 })]), hubOf({ Drivers: 1 }, [sender({ SystemID: 11 })]), hubOf({ Drivers: 0 }, [sender({ Drivers: 0, SystemID: 11 })]), hubOf({ Drivers: 1 }, [sender({ DestinationRaceID: 5 })]), hubOf({ Drivers: 1 }, [sender({ DestinationID: null })])].every((site) => site.delivery.state === 'blocked' && deliveryVerdict(site) === 1))
  check('worked: a sender whose drivers cannot be read leaves the hub unknown, not blocked and not connected', hubOf({ Drivers: 1 }, [sender({ Drivers: 0, DriverGaps: 1 })]).delivery.state === 'unknown' && deliveryVerdict(hubOf({ Drivers: 1 }, [sender({ Drivers: 0, DriverGaps: 1 })])) === null)
  check('worked: one valid sender among invalid ones is enough, and a colony pointing at itself sends nothing', hubOf({ Drivers: 1 }, [sender({ PopulationID: 4, Drivers: 0 }), sender()]).delivery.via === 'hub' && assess([colony({ Drivers: 2, MassDriverDest: 1, DestinationID: 1, DestinationRaceID: RACE, DestinationSystemID: 10, DestinationDrivers: 2 })]).colonies[0].delivery.state === 'blocked')
  const undecided = delivered({ ...driver, Drivers: 0, DriverGaps: 1 })
  check('worked: drivers that cannot be read leave delivery unknown (a verdict of null), not blocked', undecided.delivery.state === 'unknown' && deliveryVerdict(undecided) === null && unknownNeeds(undecided, { delivery: true }).some((need) => need.key === 'drivers'))
  check('worked: a site with no output has no delivery to judge', only(colony({ Efficiency: 0 })).delivery === null && deliveryVerdict(only(colony({ Efficiency: 0 }))) === 0)

  const stale = only(colony({ Efficiency: 0, ...driver }), null)
  check('worked: with no game version the rules read from the game are unknown, with the version as the input; no verdict', stale.idle === null && stale.delivery.state === 'unknown' && deliveryVerdict(stale) === null && unknownNeeds(stale, { delivery: true }).some((need) => need.inputs.some((input) => input.includes('version'))))
  check('worked: with no version the stored facts still decide: an empty body is idle', only(colony({ Deposits: 0 }), null).idle === 1)
  check('worked: a 2.6 version is not the 2.7 rules either', only(colony({ Efficiency: 0 }), '2.6.4').idle === null)
  check('worked: with no version the radiation cut-off is unknown, the stored level stays readable and no output verdict is made from it', only(colony({ RadiationLevel: 10000 }), null).idle === null && only(colony({ RadiationLevel: 10000 }), null).row.RadiationLevel === 10000 && missingNeeds(only(colony({ RadiationLevel: 10000 }), null)).length === 0 && unknownNeeds(only(colony({ RadiationLevel: 10000 }), null)).some((need) => need.key === 'radiation' && need.inputs.some((input) => input.includes('version'))))
  check('worked: a 2.6 version leaves the radiation cut-off unknown too, and 2.7.1 applies it', only(colony({ RadiationLevel: 10000 }), '2.6.4').idle === null && only(colony({ RadiationLevel: 10000 }), '2.7.1').idle === 1)
  check('worked: an automated-only site on a save with no version is not judged by the radiation rule, nor reported idle, nor given a verdict of 0', only(colony({ Manned: 0, Automated: 3, RadiationLevel: 10000 }), null).idle === null && only(colony({ Manned: 0, Automated: 3 }), null).idle === null && only(colony({ Manned: 0, Automated: 3, RadiationLevel: 10000 }), '2.7.1').idle === 1 && only(colony({ Manned: 0, Automated: 3 }), '2.7.1').idle === 0)
  check('worked: with no version a missing deposit or no mine production still stops an automated-only site', only(colony({ Manned: 0, Automated: 3, Deposits: 0 }), null).idle === 1 && only(colony({ Manned: 0, Automated: 3, MineProduction: 0 }), null).idle === 1)

  const good = orbitalOnly({})
  const [site] = good.fleets
  check('worked: an orbital miner at a body with the colony, within the limit, crewed, with a deposit produces; the colony it feeds is a site', site.producing === 1 && good.colonies.length === 1 && good.colonies[0].orbital.length === 1 && good.colonies[0].output === 1)
  check('worked: a productive orbital miner at an isolated colony is delivery-blocked, not idle', good.colonies[0].delivery.state === 'blocked' && deliveryVerdict(good.colonies[0]) === 1 && good.colonies[0].idle === 0)
  const wide = orbitalOnly({ Diameter: 5000 })
  check('worked: a body wider than the orbital limit stops the miner and names both figures', wide.fleets[0].producing === 0 && missingNeeds(wide.fleets[0])[0].key === 'diameter' && missingNeeds(wide.fleets[0])[0].text.includes('5\'000') && missingNeeds(wide.fleets[0])[0].text.includes('4\'000'))
  check('worked: a body exactly at the limit is within it', orbitalOnly({ Diameter: 4000 }).fleets[0].producing === 1)
  check('worked: a ship with no crew aboard mines nothing, a partly crewed one does', orbitalOnly({ CurrentCrew: 0 }).fleets[0].producing === 0 && keys(missingNeeds(orbitalOnly({ CurrentCrew: 0 }).fleets[0])).join() === 'crew' && orbitalOnly({ CurrentCrew: 4 }).fleets[0].producing === 1)
  check('worked: modules that are all damaged mine nothing', keys(missingNeeds(orbitalOnly({ WorkingModules: 0 }).fleets[0])).join() === 'modules')
  const none = orbitalOnly({ ColonyID: null, ColonyName: null })
  check('worked: a fleet at a body with no colony of the race has nobody to take the output', none.fleets[0].producing === 0 && keys(missingNeeds(none.fleets[0])).join() === 'colony' && none.colonies.length === 0 && missingNeeds(none.fleets[0])[0].owner === 'fleet')
  const elsewhere = orbitalOnly({ AssignedPopulationID: 2, AssignedID: 2, AssignedName: 'Beta' })
  check('worked: a fleet assigned to another colony does not feed the colony at its body and names the one it is assigned to', elsewhere.fleets[0].producing === 0 && missingNeeds(elsewhere.fleets[0])[0].text.includes('Beta') && elsewhere.colonies.length === 0)
  check('worked: a fleet assigned to the colony at its body is the same as an unassigned one', orbitalOnly({ AssignedPopulationID: 1, AssignedID: 1, AssignedName: 'Alpha' }).fleets[0].producing === 1 && orbitalOnly({ AssignedPopulationID: 0 }).fleets[0].producing === 1)
  const orphaned = orbitalOnly({ AssignedPopulationID: 99, AssignedID: null })
  check('worked: a fleet assigned to a colony that is gone is taken as unassigned (the game assigns it to the colony at its body)', orphaned.fleets[0].producing === 1 && orphaned.colonies.length === 1)
  const unassigned = orbitalOnly({ AssignedPopulationID: null, AssignedID: null })
  check('worked: an assignment that is not stored is unknown, not unassigned: no verdict for the fleet, the colony it may feed has no verdict either', unassigned.fleets[0].producing === null && missingNeeds(unassigned.fleets[0]).length === 0 && unknownNeeds(unassigned.fleets[0]).some((need) => need.key === 'assignment' && need.inputs.some((input) => input.includes('assigned'))) && unassigned.colonies[0].output === null && deliveryVerdict(unassigned.colonies[0]) === null)
  const several2 = orbitalOnly({ Diameter: 5000, CurrentCrew: 0, Deposits: 0, Depleted: 1 })
  check('worked: every missing prerequisite of a fleet is listed apart: diameter, deposit and crew', keys(missingNeeds(several2.fleets[0])).join() === 'diameter,deposit,crew' && missingNeeds(several2.fleets[0]).every((need) => need.owner === 'fleet'))
  const fresh = orbitalOnly({ Surveyed: 0, Deposits: 0 })
  check('worked: an orbital miner at an unsurveyed body is unknown, never reported as stranded for it', fresh.fleets[0].producing === null && missingNeeds(fresh.fleets[0]).length === 0 && unknownNeeds(fresh.fleets[0]).some((need) => need.key === 'deposit'))
  check('worked: a class crew that is not stored leaves the crew unknown, not met', orbitalOnly({ ClassCrew: null }).fleets[0].producing === null)
  check('worked: a class with no crew requirement is crewed (the game never scales it)', orbitalOnly({ ClassCrew: 0, CurrentCrew: 0 }).fleets[0].producing === 1)
  check('worked: with no game version the colony and assignment of an orbital miner are unknown', orbitalOnly({}, null).fleets[0].producing === null && unknownNeeds(orbitalOnly({}, null).fleets[0]).some((need) => need.key === 'colony'))
  check('worked: an orbital miner that does not work gives its colony no output, and a colony with mines still counts', orbitalOnly({ Diameter: 5000 }).colonies.length === 1 && orbitalOnly({ Diameter: 5000 }).colonies[0].output === 0 && deliveryVerdict(orbitalOnly({ Diameter: 5000 }).colonies[0]) === 0)
  const two = assessMiningSites({ colonies: [colony({ Manned: 0, Automated: 0, Civilian: 0, Efficiency: 0 })], fleets: [fleet({ FleetID: 1, Diameter: 5000 }), fleet({ FleetID: 2, ShipID: 2 })] }, { RaceID: RACE, version: '2.7.1' })
  check('worked: a colony whose orbital miners include a working one has output', two.colonies[0].output === 1 && two.colonies[0].orbital.length === 2)
  check('worked: the fleet sites join the ships of one fleet into one site', assess([colony(noMines)], [fleet({ ShipID: 1 }), fleet({ ShipID: 2, CurrentCrew: 0 })]).fleets.length === 1)

  const ship = (over) => fleet({ ShipID: 1, ...over })
  const together = (...ships) => assess([colony(noMines)], ships).fleets[0]
  const uncrewed = together(ship({ ShipID: 1, CurrentCrew: 0 }), ship({ ShipID: 2, WorkingModules: 0 }))
  check('worked: an uncrewed miner beside a miner whose modules are all damaged does not produce, and the crew is what is missing', uncrewed.producing === 0 && keys(missingNeeds(uncrewed)).join() === 'crew')
  check('worked: an uncrewed miner beside a crewed miner produces, and so does a damaged miner beside a crewed one', together(ship({ ShipID: 1, CurrentCrew: 0 }), ship({ ShipID: 2 })).producing === 1 && together(ship({ ShipID: 1, WorkingModules: 0 }), ship({ ShipID: 2 })).producing === 1)
  check('worked: a crewed miner with every module damaged beside an uncrewed miner with working ones does not produce', together(ship({ ShipID: 1, WorkingModules: 0 }), ship({ ShipID: 2, CurrentCrew: 0 })).producing === 0 && together(ship({ ShipID: 1, WorkingModules: 0 }), ship({ ShipID: 2, WorkingModules: 0 })).producing === 0 && keys(missingNeeds(together(ship({ ShipID: 1, WorkingModules: 0 }), ship({ ShipID: 2, WorkingModules: 0 })))).join() === 'modules')
  check('worked: a ship whose module count is not known beside an uncrewed one leaves the fleet unknown, never producing', together(ship({ ShipID: 1, CurrentCrew: 0 }), ship({ ShipID: 2, WorkingModules: null })).producing === null && together(ship({ ShipID: 1, WorkingModules: null })).producing === null && unknownNeeds(together(ship({ ShipID: 1, WorkingModules: null }))).some((need) => need.key === 'modules'))
  check('worked: working modules and crew are met on the same ship or the fleet does not produce', together(ship({ ShipID: 1, CurrentCrew: 0 }), ship({ ShipID: 2, ClassCrew: 10, CurrentCrew: 10 }), ship({ ShipID: 3, WorkingModules: 0 })).producing === 1 && together(ship({ ShipID: 1, CurrentCrew: 0 }), ship({ ShipID: 3, WorkingModules: 0 })).producing === 0)
}

const warningsWorked = (common, mining) => {
  const { needInputs, needsCell } = common
  const ctx = { unknown: (names) => ({ unknown: names }) }
  const row = (over) => ({ ...colony(over) })
  const site = (over, version = '2.7.1') => mining.assessMiningSites({ colonies: [row(over)], fleets: [] }, { RaceID: RACE, version }).colonies[0]
  const lacks = needsCell(ctx, site({ Deposits: 0, Efficiency: 0 }))
  const unsure = needsCell(ctx, site({ Surveyed: 0, Deposits: 0 }))
  const mixed = needsCell(ctx, site({ Surveyed: 0, Deposits: 0, RadiationLevel: 20000 }))
  const gaps = needsCell(ctx, site({ Manned: 0, MineGaps: 1 }))

  check('worked: the cell of a site names every missing prerequisite, joined, with no unknown result', lacks.text === 'No mineral deposit on the body; No workforce for the manned mines (the colony\'s efficiency is 0)' && lacks.result === undefined)
  check('worked: the cell of a site with only unknown prerequisites is the unknown cell naming the survey', unsure.result && unsure.result.unknown.some((name) => name.includes('survey')))
  check('worked: a missing prerequisite beside an unknown one is named and the unknown input is carried', mixed.text.startsWith('Radiation of 20\'000') && mixed.text.includes('not surveyed') && mixed.result && mixed.result.unknown.some((name) => name.includes('survey')))
  check('worked: an installation that cannot be read names itself as the input', gaps.result && needInputs(site({ Manned: 0, MineGaps: 1 })).length > 0)
}

const rulesRegistered = (provenance) => {
  const ids = ['miningSites.deposit', 'miningSites.surface', 'miningSites.orbital', 'miningSites.delivery']

  ids.forEach((id) => check(`rule ${id} is registered with a structure and a verification`, Boolean(provenance.getRule(id)) && provenance.getRule(id).structure.length > 0 && ['confirmed', 'estimated', 'assumed'].includes(provenance.getRule(id).verification)))
  check('the game rules are bound to 2.7: true for 2.7.1, false for 2.6.4, null with no version', provenance.ruleSupports('miningSites.surface', '2.7.1') === true && provenance.ruleSupports('miningSites.surface', '2.6.4') === false && provenance.ruleSupports('miningSites.orbital', null) === null)
}

const ids = (rows) => rows.map((row) => row.id)

// Whether two lists hold the same ids, each once.
const sameIds = (actual, expected) => new Set(actual).size === actual.length && actual.length === expected.length && expected.every((id) => actual.includes(id))

// The fleet-query expression of working modules against an in-memory database: absent damage is none, an unreadable damage amount, count or type is unknown, never 0 working and never all working.
const modulesSql = async (common) => {
  const raw = new sqlite3.Database(':memory:')
  const run = (sql, ...parameters) => new Promise((resolve, reject) => raw.run(sql, parameters, (error) => (error ? reject(error) : resolve())))
  const all = (sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))

  await run('create table FCT_Ship (ShipID integer, GameID integer, ShipClassID integer)')
  await run('create table FCT_ClassComponent (ClassID integer, ComponentID integer, NumComponent integer)')
  await run('create table FCT_ShipDesignComponents (SDComponentID integer, ComponentTypeID integer)')
  await run('create table FCT_DamagedComponent (ShipID integer, GameID integer, ComponentID integer, Number integer)')
  await run('insert into FCT_ShipDesignComponents values (10, 38), (11, 38), (13, 4)')
  await run('insert into FCT_ClassComponent values (1, 10, 5), (2, 11, null), (3, 12, 3), (4, 13, 2), (5, 10, 4), (5, 13, 2)')
  await run('insert into FCT_Ship values (1, 1, 1), (2, 1, 1), (3, 1, 1), (4, 1, 1), (5, 1, 2), (6, 1, 3), (7, 1, 4), (8, 1, 5), (9, 1, 1)')
  await run('insert into FCT_DamagedComponent values (2, 1, 10, 2), (3, 1, 10, 5), (4, 1, 10, null), (9, 1, 10, 7)')

  const rows = await all(`select FCT_Ship.ShipID, ${common.WORKING_MODULES} as Working from FCT_Ship order by FCT_Ship.ShipID`)
  const working = Object.fromEntries(rows.map((row) => [row.ShipID, row.Working]))

  check('worked: a ship with no damage row has every module working, a damage row takes its count off, damage beyond the count leaves 0', working[1] === 5 && working[2] === 3 && working[3] === 0 && working[9] === 0, JSON.stringify(working))
  check('worked: a damage row whose count is not stored leaves the working modules unknown, not all working', working[4] === null)
  check('worked: a component line whose count is not stored, one whose type is not stored and a class with no mining line leave them unknown, not 0', working[5] === null && working[6] === null && working[7] === null)
  check('worked: lines of other types do not count, nor do they hide the mining ones', working[8] === 4)
  raw.close()
}

const runSave = async (utilities, save, label) => {
  const { common, index, mining, capabilities } = utilities
  const database = await openSave(save.file)

  if (!database) {
    console.log(`SKIP  ${label}: ${save.file} is not there (not run)`)
    return
  }

  try {
    const ctx = { database, GameID: save.game, RaceID: save.race, RaceNPR: false, separator: ',', options: {}, count: common.counter(',') }
    const version = await capabilities.loadFormulaVersion(database).catch(() => null)
    const model = await common.readMiningSites(ctx)
    const [[{ Fleets }]] = await database.query(`select count(distinct FCT_Fleet.FleetID) as Fleets from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.GameID = ${save.game} and FCT_Fleet.RaceID = ${save.race} and FCT_Fleet.OrbitBodyID > 0 and FCT_Ship.MothershipID = 0 and FCT_ShipClass.MiningModules > 0 and not exists (select 1 from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID and FCT_MoveOrders.GameID = FCT_Fleet.GameID)`)
    const [mineRows] = await database.query(`select FCT_Population.PopulationID from FCT_Population where FCT_Population.GameID = ${save.game} and FCT_Population.RaceID = ${save.race} and exists (select 1 from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and FCT_PopulationInstallations.Amount > 0 and DIM_PlanetaryInstallation.MiningProductionValue > 0)`)
    const [unsurveyedOrEmpty] = await database.query(`select FCT_Population.PopulationID from FCT_Population where FCT_Population.GameID = ${save.game} and FCT_Population.RaceID = ${save.race} and exists (select 1 from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and FCT_PopulationInstallations.Amount > 0 and DIM_PlanetaryInstallation.MiningProductionValue > 0) and not exists (select 1 from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = FCT_Population.SystemBodyID and FCT_MineralDeposit.GameID = FCT_Population.GameID and FCT_MineralDeposit.Amount > 0)`)

    console.log(`INFO  ${label}: ${database.file} game ${save.game} race ${save.race}, version ${version || 'not shown'}, ${model.colonies.length} colony sites, ${model.fleets.length} fleet sites`)
    check(`${label}: every fleet at a body without orders that carries mining modules is a fleet site`, model.fleets.length === Fleets, `sites ${model.fleets.length}, query ${Fleets}`)

    check(`${label}: every colony with a mining installation is a site with its own mines assessed, and no other colony is`, new Set(mineRows.map((row) => row.PopulationID)).size === model.colonies.filter((site) => site.surface).length && mineRows.every((row) => model.colonies.some((site) => site.id === row.PopulationID && site.surface)), `query ${mineRows.length}, sites ${model.colonies.filter((site) => site.surface).length}`)

    const depositGone = new Set(unsurveyedOrEmpty.map((row) => row.PopulationID))
    const reported = new Set(model.colonies.filter((site) => site.surface && ['empty', 'exhausted', 'unsurveyed', 'unknown'].includes(mining.depositState(site.row))).map((site) => site.id))

    check(`${label}: the colonies with mines and no deposit row are the sites whose deposit is empty, exhausted, unsurveyed or unknown`, [...depositGone].every((id) => reported.has(id)) && [...reported].every((id) => depositGone.has(id)), `query ${depositGone.size}, sites ${reported.size}`)

    const results = {}

    for (const key of KEYS) {
      results[key] = await index.checkByKey[key].read(ctx)
    }

    const counts = KEYS.map((key) => `${key} ${results[key].filter((row) => !row.unevaluated).length} rows, ${results[key].filter((row) => row.unevaluated).length} not evaluated`).join('; ')
    const colonyById = new Map(model.colonies.map((site) => [`colony:${site.id}`, site]))
    const fleetById = new Map(model.fleets.map((site) => [`fleet:${site.id}`, site]))
    const everyRow = KEYS.flatMap((key) => results[key].map((row) => ({ key, row })))

    console.log(`INFO  ${label}: ${counts}`)
    const expectations = {
      'wasted-mining-capacity': { kind: 'colony', sites: model.colonies.filter((site) => site.surface), verdict: (site) => site.idle },
      'mass-driver-orphans': { kind: 'colony', sites: model.colonies, verdict: mining.deliveryVerdict },
      'stranded-miners': { kind: 'fleet', sites: model.fleets, verdict: (site) => (site.producing === null ? null : 1 - site.producing) },
    }
    const expectedIds = ({ kind, sites, verdict }, wanted) => sites.filter((site) => verdict(site) === wanted).map((site) => `${kind}:${site.id}`)
    const shownIds = (rows, unevaluated) => ids(rows.filter((row) => Boolean(row.unevaluated) === unevaluated))

    check(`${label}: every row of the three warnings has a link to the colony's body (Mineral Breakdown) or the fleet (Route Finder) it names`, everyRow.every(({ key, row }) => row.link && (key === 'stranded-miners' ? row.link.path === '/routes' && row.link.query.fleet === undefined && row.link.query.from === `fleet:${fleetById.get(row.id).id}` : row.link.path === '/minerals' && JSON.parse(row.link.query.bodies)[0].SystemBodyID === colonyById.get(row.id).row.SystemBodyID)), `${everyRow.length} rows`)

    for (const key of KEYS) {
      const expectation = expectations[key]

      check(`${label}: ${key} lists exactly the sites with a verdict of 1, no more and no fewer`, sameIds(shownIds(results[key], false), expectedIds(expectation, 1)), `rows ${shownIds(results[key], false).length}, expected ${expectedIds(expectation, 1).length}`)
      check(`${label}: ${key} lists exactly the sites with a verdict of null as not evaluated`, sameIds(shownIds(results[key], true), expectedIds(expectation, null)), `rows ${shownIds(results[key], true).length}, expected ${expectedIds(expectation, null).length}`)
    }

    check(`${label}: wasted-mining-capacity and mass-driver-orphans name what they lack on every row, and a delivery warning says it reads the stored setup`, results['wasted-mining-capacity'].filter((row) => !row.unevaluated).every((row) => row.cells.reason.text && row.cells.reason.text !== 'Unknown') && results['mass-driver-orphans'].filter((row) => !row.unevaluated).every((row) => row.cells.missing.text && row.caption && row.caption.includes('no export set up')))
    check(`${label}: a warning row of stranded-miners and of mass-driver-orphans never belongs to a site that is idle for its own reasons`, ids(results['mass-driver-orphans'].filter((row) => !row.unevaluated)).every((id) => colonyById.get(id).output === 1) && ids(results['stranded-miners'].filter((row) => !row.unevaluated)).every((id) => fleetById.get(id).producing === 0 && mining.missingNeeds(fleetById.get(id)).length > 0))

    // A reader that sees no colony or fleet must fail the comparison above, whenever the save has a row to lose.
    const blind = { query: (sql) => (/from FCT_(Population|Fleet) /.test(sql) ? Promise.resolve([[]]) : database.query(sql)) }

    for (const key of KEYS) {
      const expected = [...expectedIds(expectations[key], 1), ...expectedIds(expectations[key], null)]

      if (expected.length) {
        const dropped = await index.checkByKey[key].read({ ...ctx, database: blind })

        mutations++
        check(`${label}: self-check: ${key} with every colony and fleet hidden drops ${expected.length} expected row${expected.length === 1 ? '' : 's'} and the comparison notices`, !sameIds(shownIds(dropped, false), expectedIds(expectations[key], 1)) || !sameIds(shownIds(dropped, true), expectedIds(expectations[key], null)))
      }
    }

    const tally = (list, pick) => list.reduce((aggregate, item) => ({ ...aggregate, [pick(item)]: (aggregate[pick(item)] || 0) + 1 }), {})

    console.log(`INFO  ${label}: colony deposits ${JSON.stringify(tally(model.colonies.filter((site) => site.surface), (site) => mining.depositState(site.row)))}, delivery ${JSON.stringify(tally(model.colonies.filter((site) => site.delivery), (site) => `${site.delivery.state}${site.delivery.via ? `:${site.delivery.via}` : ''}`))}, fleets producing ${JSON.stringify(tally(model.fleets, (site) => site.producing))}`)
  } finally {
    database.close()
  }
}

const main = async () => {
  const saves = parseArguments(process.argv.slice(2))
  const utilities = await loadUtilities(['mining-sites', 'provenance', 'capabilities', 'warnings/common', 'warnings/index'], { stubs: STUBS })
  const named = { mining: utilities['mining-sites'], provenance: utilities.provenance, capabilities: utilities.capabilities, common: utilities['warnings/common'], index: utilities['warnings/index'] }

  rulesRegistered(named.provenance)
  worked(named.mining)
  warningsWorked(named.common, named.mining)
  await modulesSql(named.common)

  for (const [position, save] of saves.entries()) {
    await runSave(named, save, `save ${position + 1}`)
  }

  check('the mutation self-check ran against at least one expected warning row', mutations > 0, `${mutations} warnings hidden`)
  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
