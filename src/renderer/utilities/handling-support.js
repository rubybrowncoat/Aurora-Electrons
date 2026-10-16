// The officers' Logistics bonuses the handling strength reads, from the save: ship commanders, colony governors, sector commanders and the naval admin commands. The pure adapters are in utilities/handling-bonuses.js. Evidence: docs/plans/backlog/evidence/AE-082-01.md.

import { LOGISTICS_BONUS } from './handling-bonuses'
import { NAVAL_ADMIN_RANK_READS, loadNavalAdmins, navalAdminReads } from './naval-admins'
import { columnsOf, gaps } from './mine-bootstrap-data'

const NO_BLOCKED = new Set()
// FCT_Commander.CommandType: what a commander commands, by its CommandID.
const COMMAND_TYPES = { commander: 1, governor: 3, sector: 4 }

const OFFICER_READS = { FCT_Commander: ['CommanderID', 'RaceID', 'CommandType', 'CommandID'], FCT_CommanderBonuses: ['CommanderID', 'BonusID', 'BonusValue'] }
const SECTOR_READS = { FCT_RaceSysSurvey: ['SystemID', 'RaceID', 'SectorID'] }
// What the pages read of a fleet to name the command its ships answer to.
const FLEET_READS = { FCT_Fleet: ['ParentCommandID'] }

const reason = (list) => `the save lacks ${list.join(', ')}`

// The tables and columns of several reads put together, { [table]: [column] }.
const unionOf = (...lists) => lists.reduce((all, list) => {
  Object.entries(list).forEach(([table, columns]) => {
    all[table] = [...new Set([...(all[table] || []), ...columns])]
  })

  return all
}, {})

// A map { [id]: value } from rows; a row whose bonus has no value keeps null, so the officer is unknown rather than neutral.
const byId = (rows, idOf) => Object.fromEntries(rows.map((row) => [idOf(row), Number.isFinite(row.BonusValue) ? row.BonusValue : null]))

// The sector commanders' bonuses by system from the survey's rows: a system whose sector is not recorded (null) is unknown, one in no sector (0) has no sector commander, a sector whose commander has no Logistics row has no bonus, and a row with no value is unknown.
const sectorsOf = (rows) => Object.fromEntries(rows.flatMap((row) => (row.SectorID === null || row.SectorID === undefined ? [[row.SystemID, null]] : row.SectorID > 0 && row.BonusRow ? [[row.SystemID, Number.isFinite(row.BonusValue) ? row.BonusValue : null]] : [])))

// The race's Logistics bonuses as { mode: 'loaded', withheld, gaps, commanders, governors, sectors, admins }. `commanders` is { [ShipID]: bonus }, `governors` { [PopulationID]: bonus }, `sectors` { [SystemID]: the sector commander's bonus } and `admins` as `loadNavalAdmins` gives them. An officer with no entry has no Logistics bonus (neutral); an entry with null has a bonus row and no value (unknown). `gaps` holds, for each factor the save cannot settle, the reason as text (a table or column it lacks, or the bonus being withheld by `blocked`); a gap in one factor leaves the others read. A save without the officers' ranks reads the naval admin commands without them (each command's chain is then unknown). `ranks` as `loadNavalAdmins` takes it.
export const loadHandlingSupport = async (database, { GameID, RaceID, ranks = true, blocked = NO_BLOCKED }) => {
  const support = { mode: 'loaded', withheld: null, gaps: { commander: null, admin: null, governor: null, sector: null }, commanders: {}, governors: {}, sectors: {}, admins: {} }

  if (blocked.has(LOGISTICS_BONUS)) {
    const withheld = `commander bonus ${LOGISTICS_BONUS} (its lookup row in the save does not read as expected)`

    return { ...support, withheld, gaps: { commander: withheld, admin: withheld, governor: withheld, sector: withheld } }
  }

  const chainReads = unionOf(OFFICER_READS, navalAdminReads('Logistics'), FLEET_READS)
  const rankReads = unionOf(NAVAL_ADMIN_RANK_READS)
  const tables = Object.keys(unionOf(OFFICER_READS, SECTOR_READS, chainReads, rankReads))
  const columns = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await columnsOf(database, table)])))
  const lacking = (reads) => Object.entries(reads).flatMap(([table, wanted]) => gaps(table, columns[table], wanted))
  const officers = lacking(OFFICER_READS)
  const sectors = [...officers, ...lacking(SECTOR_READS)]
  const chain = lacking(chainReads)
  const ranked = ranks && !lacking(rankReads).length
  const officerRows = (type) => database.query(`select FCT_Commander.CommandID as ID, FCT_CommanderBonuses.BonusValue from FCT_CommanderBonuses inner join FCT_Commander on FCT_Commander.CommanderID = FCT_CommanderBonuses.CommanderID where FCT_CommanderBonuses.BonusID = ${LOGISTICS_BONUS} and FCT_Commander.RaceID = ${RaceID} and FCT_Commander.CommandType = ${type}`).then(([rows]) => rows)

  support.gaps.commander = officers.length ? reason(officers) : null
  support.gaps.governor = support.gaps.commander
  support.gaps.sector = sectors.length ? reason(sectors) : null
  support.gaps.admin = chain.length ? reason(chain) : null

  const [commanders, governors, sectorRows, admins] = await Promise.all([
    support.gaps.commander ? [] : officerRows(COMMAND_TYPES.commander),
    support.gaps.governor ? [] : officerRows(COMMAND_TYPES.governor),
    support.gaps.sector ? [] : database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.SectorID, FCT_CommanderBonuses.CommanderID is not null as BonusRow, FCT_CommanderBonuses.BonusValue from FCT_RaceSysSurvey left join FCT_Commander on FCT_Commander.CommandType = ${COMMAND_TYPES.sector} and FCT_Commander.CommandID = FCT_RaceSysSurvey.SectorID and FCT_Commander.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${LOGISTICS_BONUS} where FCT_RaceSysSurvey.RaceID = ${RaceID}`).then(([rows]) => rows),
    support.gaps.admin ? {} : loadNavalAdmins(database, { GameID, RaceID, bonusId: LOGISTICS_BONUS, share: 'Logistics', ranks: ranked, blocked }),
  ])

  support.commanders = byId(commanders, (row) => row.ID)
  support.governors = byId(governors, (row) => row.ID)
  support.sectors = sectorsOf(sectorRows)
  support.admins = admins

  return support
}
