/*
  What the missing naval admin ranks and a blocked Mining bonus leave unknown, for scripts/check-capabilities.js.

  The naval admin chain bonus is a multiplier the save does not settle when the officers' ranks are not in it (FCT_Commander.RankID, FCT_Ranks) and the Mining bonus (6) is a lookup row the save may not name as the planners expect. These check, on the real modules and on a copy of the save that lacks FCT_Commander.RankID:
  - the five reports that read the ranks (/production, /mineral-outlook, /habitability, /logistics, /survey-progress) are degraded by the shared group and not unsupported, and the independent figures of their pages are untouched;
  - `loadNavalAdmins` runs on that copy (no read of the missing column) and gives every command an unknown chain with the field named, and the chain, the orbital miner rate, the harvester basis, the survey rate and the terraforming rate are unavailable naming it, never a multiplier of 1;
  - a race with no command carrying the bonus still has the chain 1, which does not rest on a rank;
  - a blocked Mining bonus leaves the surface, orbital, civilian mining and harvester figures unavailable naming the lookup, and the stocks alone stay;
  - copies of the code that treat an unknown chain as 1, ignore the blocked bonus or skip the rank group fail at least one of these.
*/
const fs = require('fs')
const path = require('path')
const { Sequelize } = require('sequelize')
const { loadUtilities } = require('./utilities')
const { mutating } = require('./no-mutations')

const NAVAL_ROUTES = ['/production', '/mineral-outlook', '/habitability', '/logistics', '/survey-progress', '/hauling', '/information']
const MODULES = ['capabilities', 'minerals', 'mining-data', 'mineral-outlook', 'logistics', 'naval-admins', 'survey', 'terraform-capacity', 'cmc-policy']
const OPEN_EXISTING = 0x2

const MUTATIONS = [
  ['an unknown chain reads as a multiplier of 1', 'utilities/minerals.js', 'return { bonus: null, unknown: current.Unknown }', 'return { bonus: 1, unknown: null }'],
  ['a command without ranks is not marked unknown', 'utilities/naval-admins.js', 'Unknown: withheld || (ranks ? null : RANKS_UNKNOWN),', 'Unknown: withheld,'],
  ['a blocked Mining bonus leaves the surface rows alone', 'utilities/mining-data.js', 'blocked.has(MINING_BONUS)', 'false'],
  ['a blocked Mining bonus leaves the harvester rows alone', 'utilities/logistics.js', 'blocked.has(MINING_BONUS) ? rows.map', 'false ? rows.map'],
  ['the survey rate ignores an unknown chain', 'utilities/survey.js', 'if (adminGap || !Number.isFinite(admin)) {', 'if (false) {'],
  ['the terraforming rate ignores an unknown chain', 'utilities/terraform-capacity.js', '...(group.admin === null ? [group.adminGap || \'the naval admin chain\\\'s Terraforming bonus\'] : [])', '...[]'],
]

const adminOf = (overrides) => ({ NavalAdminCommandID: 1, SystemID: 5, ParentCommandID: 0, BonusValue: 1.2, Share: 0.05, Eligible: true, Unknown: null, Systems: new Set([5]), ...overrides })

const orbitalRow = { MiningModules: 10, MineProduction: 5, CommanderBonus: 1.1, Accessibility: 1, Diameter: 100, MaximumOrbitalMiningDiameter: 1000, ClassCrew: 100, CurrentCrew: 100, SystemID: 5, NavalAdminCommandID: 1, MaterialID: 1 }

const surfaceRow = { ManualMineCount: 5, AutomatedMineCount: 0, CivilianMineCount: 0, MineProduction: 5, Accessibility: 1, GovernorBonus: 1.1, SectorBonus: 1.02, Efficiency: 1, StabilityModifier: 1, RadiationModifier: 1, PoliticalModifier: 1, MaterialID: 1, MassDriverExport: 1 }

const harvesterRow = { ClassCrew: 100, CurrentCrew: 100, Harvesters: 10, ClassHarvesters: 10, FuelProduction: 40000, MiningBonus: 1, SoriumAccessibility: 1, SoriumAmount: 1000, Surveyed: 1, SystemBodyID: 1, Fuel: 0, FuelCapacity: 1000000, SystemID: 5, NavalAdminCommandID: 1 }

// A database that holds one naval admin command carrying the bonus, so that the load has a command to judge whatever the copy holds; the queries of the jump links answer nothing.
const oneCommand = { query: async (sql) => [/^select FCT_NavalAdminCommand.NavalAdminCommandID/.test(sql) ? [{ NavalAdminCommandID: 1, ParentCommandID: 0, SystemID: 5, BonusValue: 1.2, Share: 0.05, Radius: 2, MinimumRankPriority: 1, RankPriority: null, ShipID: 0 }] : []] }

const text = (result) => (result && result.inputs ? result.inputs.missing.join('; ') : '')

// The statements of the checks on `mods`, as [statement, held] pairs, so that the real modules and the mutants answer the same ones.
const results = async (mods, { database, race }) => {
  const { minerals, 'mining-data': miningData, 'mineral-outlook': outlook, logistics, 'naval-admins': naval, survey, 'terraform-capacity': terraform, capabilities } = mods
  const { isAvailable } = (await loadUtilities(['provenance'])).provenance
  const ranksless = Object.values(await naval.loadNavalAdmins(database, { ...race, bonusId: 6, share: 'Industrial', ranks: false }))
  const lone = Object.values(await naval.loadNavalAdmins(oneCommand, { ...race, bonusId: 6, share: 'Industrial', ranks: false }))
  const withheld = Object.values(await naval.loadNavalAdmins(database, { ...race, bonusId: 6, share: 'Industrial', ranks: false, blocked: new Set([6]) }))
  const RANK_GAP = /ranks? of (?:a|the) naval admin commanders?/
  const unknownRanks = adminOf({ Eligible: null, Unknown: 'the ranks of the naval admin commanders are not in the save' })
  const unknown = { 1: unknownRanks }
  const known = { 1: adminOf() }
  const blocked = new Set([6])
  const out = []
  const holds = (statement, held) => out.push([statement, Boolean(held)])

  holds('without the ranks, loadNavalAdmins runs on the copy and every command has an unknown chain naming the officer ranks with no rank verdict', [...ranksless, ...lone].every((admin) => admin.Eligible === null && RANK_GAP.test(admin.Unknown)) && lone.length === 1)
  holds('the chain of an in-range command with unknown ranks is unknown, null and not 1', minerals.navalAdminChain(unknown, 5, 1).bonus === null && RANK_GAP.test(minerals.navalAdminChain(unknown, 5, 1).unknown) && minerals.navalAdminChainBonus(unknown, 5, 1) === null)
  holds('the chain of a command out of range or of a known one is a number', minerals.navalAdminChain(unknown, 9, 1).bonus === 1 && Math.abs(minerals.navalAdminChain(known, 5, 1).bonus - 1.01) < 1e-9)
  holds('a race with no command carrying the bonus has the chain 1 whatever its ranks', minerals.navalAdminChain({}, 5, 0).bonus === 1)
  holds('an orbital miner under unknown ranks is unavailable, naming the ranks', !isAvailable(outlook.orbitalRateResult(orbitalRow, unknown)) && RANK_GAP.test(text(outlook.orbitalRateResult(orbitalRow, unknown))))
  holds('an orbital miner under a known chain is available and a body too wide to mine is a real 0', isAvailable(outlook.orbitalRateResult(orbitalRow, known)) && outlook.orbitalRateResult({ ...orbitalRow, Diameter: 5000 }, unknown).value === 0)
  holds('the unlogged mining of a colony with an unknown orbital miner is unknown, and the outlook has no flow for that mineral', (() => {
    const totals = minerals.unloggedMining({ surface: [], orbital: [{ ...orbitalRow, MassDriverExport: 1 }], navalAdmins: unknown })

    return totals[1] === null
  })())
  holds('a harvester under unknown ranks has an unknown basis naming the ranks, and a known chain has a rate', (() => {
    const row = { ...harvesterRow }
    const basis = logistics.harvesterBasis(row, { admin: logistics.harvesterAdminBonus(unknown, row), adminGap: logistics.harvesterAdminGap(unknown, row) })
    const sound = logistics.harvesterBasis(row, { admin: logistics.harvesterAdminBonus(known, row), adminGap: logistics.harvesterAdminGap(known, row) })

    return basis.unknown && basis.gaps.some((gap) => RANK_GAP.test(gap)) && basis.perYear === null && !sound.unknown && sound.perYear > 0
  })())
  holds('a fleet\'s survey rate under unknown ranks is unavailable naming the ranks, never the rate with a multiplier of 1', (() => {
    const ship = { ShipID: 1, Survey: 1, GeoSensors: 5, GravSensors: 5, CurrentCrew: 100, ClassCrew: 100, CrewMorale: 1, Damaged: 0 }
    const chain = minerals.navalAdminChain(unknown, 5, 1)
    const unavailableRate = survey.fleetSurveyRate([ship], 'geo', { speed: 100, admin: chain.bonus, adminGap: chain.unknown })
    const sound = survey.fleetSurveyRate([ship], 'geo', { speed: 100, admin: 1, adminGap: null })

    return !isAvailable(unavailableRate) && RANK_GAP.test(text(unavailableRate)) && (isAvailable(sound) || !/naval admin/.test(text(sound)))
  })())
  holds('a colony\'s terraforming rate under unknown ranks is unavailable naming the ranks, and its installations\' share does not hide the gap', (() => {
    const modifier = { governor: 1, sector: 1, efficiency: 1, radiation: 0, unrest: 0, status: 1 }
    const ship = { ShipID: 1, PopulationID: 1, ParentCommandID: 1, FleetSystemID: 5, crew: 1, captain: 1, captained: true, modules: 4 }
    const colony = { installations: 2, radius: 6000, modifier, ships: [ship] }
    const rate = terraform.terraformBreakdown({ raceRate: 2, speed: 100, source: colony, admins: unknown })
    const installations = terraform.terraformBreakdown({ raceRate: 2, speed: 100, source: { ...colony, ships: [] }, admins: unknown })

    return !isAvailable(rate.rate) && RANK_GAP.test(text(rate.rate)) && !isAvailable(rate.orbital) && RANK_GAP.test(text(rate.orbital)) && isAvailable(installations.installations) && isAvailable(installations.rate)
  })())
  holds('a blocked Mining bonus nulls the bonus of the surface and orbital rows and names the lookup, leaving everything else', (() => {
    const [surface] = miningData.gateMiningRows([surfaceRow], blocked)
    const [orbital] = miningData.gateMiningRows([orbitalRow], blocked)
    const [open] = miningData.gateMiningRows([surfaceRow], new Set())

    return surface.GovernorBonus === null && surface.SectorBonus === null && surface.Accessibility === 1 && /Mining/.test(surface.BonusWithheld) && orbital.CommanderBonus === null && orbital.MiningModules === 10 && open.GovernorBonus === 1.1
  })())
  holds('a surface rate under a blocked Mining bonus is unavailable naming the commander bonus 6 lookup, and a confirmed one without it', (() => {
    const [gated] = miningData.gateMiningRows([surfaceRow], blocked)
    const withheld = outlook.surfaceRateResult(gated)

    return !isAvailable(withheld) && /commander bonus 6/.test(text(withheld)) && isAvailable(outlook.surfaceRateResult(surfaceRow))
  })())
  holds('an orbital rate under a blocked Mining bonus is unavailable naming the lookup', (() => {
    const [gated] = miningData.gateMiningRows([orbitalRow], blocked)

    return !isAvailable(outlook.orbitalRateResult(gated, known)) && /commander bonus 6/.test(text(outlook.orbitalRateResult(gated, known)))
  })())
  holds('a blocked Mining bonus makes every command of the race unknown, naming the lookup, even a race whose commands carry no bonus', (() => {
    return withheld.length > 0 && withheld.every((admin) => /commander bonus 6/.test(admin.Unknown))
  })())
  holds('the harvester rows under a blocked Mining bonus have no bonus and a basis naming the lookup', (() => {
    const [row] = logistics.gateHarvesterRows([harvesterRow], blocked)
    const basis = logistics.harvesterBasis(row, {})

    return row.MiningBonus === null && basis.unknown && basis.perYear === null && basis.gaps.some((gap) => /commander bonus 6/.test(gap)) && logistics.gateHarvesterRows([harvesterRow], new Set())[0].MiningBonus === 1
  })())
  holds('the civilian mining policy under a blocked Mining bonus does not give an output', await (async () => {
    const policy = await mods['cmc-policy'].loadCmcPolicy(database, { ...race, blocked })

    return Array.isArray(policy.colonies) ? policy.colonies.every((colony) => !colony.Output || !isAvailable(mods['cmc-policy'].outputResult(colony))) : true
  })())
  holds('no blocked set and no missing ranks leaves the bonus choice to the lookup rows (BONUS_NAMES lists the pages, none exempt)', capabilities.BONUS_NAMES[6].routes.includes('/mineral-outlook') && capabilities.BONUS_NAMES[6].routes.includes('/logistics') && !('unwithheld' in capabilities.BONUS_NAMES[6]))

  return out
}

const reportChecks = (rank, check) => {
  check('naval: FCT_Commander.RankID dropped leaves the reports that read the naval admin ranks degraded by the shared group, with their independent inputs required and met', NAVAL_ROUTES.every((route) => rank.reports[route].status === 'degraded' && rank.reports[route].missing.length === 0 && rank.reports[route].groups.navalRank === false))
  check('naval: every one of them names FCT_Commander.RankID and says what is left out', NAVAL_ROUTES.every((route) => rank.reports[route].degraded.some((entry) => entry.key === 'navalRank' && entry.fields.includes('FCT_Commander.RankID') && /rates|outlook|output/.test(entry.affects))))
}

// `ctx`: { check, stubs, source, alteredCopy, mutatedCopy, preflightOf, capabilities }.
const chainChecks = async ({ check, stubs, source, alteredCopy, mutatedCopy, preflightOf, capabilities }) => {
  const copy = await alteredCopy(source, 'navalrank', ['alter table FCT_Commander drop column RankID'])
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: copy, logging: false, dialectOptions: { mode: OPEN_EXISTING } })
  const database = { query: (sql) => sequelize.query(sql, { raw: true }) }

  try {
    const [[race]] = await database.query('select FCT_NavalAdminCommand.GameID, FCT_NavalAdminCommand.RaceID, count(*) as Commands from FCT_NavalAdminCommand group by FCT_NavalAdminCommand.GameID, FCT_NavalAdminCommand.RaceID order by Commands desc limit 1')

    if (!race) {
      console.log('SKIP  naval chain: the save has no naval admin commands (not run)')

      return
    }

    reportChecks((await preflightOf(capabilities, copy)).result, check)

    const ids = { GameID: race.GameID, RaceID: race.RaceID }
    const mods = await loadUtilities(MODULES, { stubs })
    const statements = await results(mods, { database, race: ids })

    statements.forEach(([statement, held]) => check(`naval: ${statement}`, held))

    for (const [label, file, from, to] of mutating() ? MUTATIONS : []) {
      const directory = mutatedCopy(file, from, to)

      try {
        const mutants = await loadUtilities(MODULES, { stubs, directory: path.join(directory, 'utilities') })
        const broken = (await results(mutants, { database, race: ids })).filter(([, held]) => !held)

        check(`naval: a copy of the code in which ${label} fails a check`, broken.length > 0)
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  } finally {
    await sequelize.close()
    fs.rmSync(copy, { force: true })
  }
}

module.exports = { chainChecks }
