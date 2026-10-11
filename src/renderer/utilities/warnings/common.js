import { populationName, systemBodyName } from '../aurora'
import { roundToDecimal, separatedNumber } from '../math'

// Shared by the check modules of the Warnings page. A check is
//
//   { key, group, severity, title(count, options), rule, columns, options?, clock?, read(ctx) }
//
// `key` is stable and kebab-case; `severity` one of SEVERITIES (index.js); `title` the heading over the check's rows;
// `rule` one sentence saying when the check fires; `columns` the table's `{ key, text, align? }`, the first holding the
// row's name; `options` the page options `read` depends on (so only those re-read the check when they change);
// `clock` that it depends on the game time. `read(ctx)` returns rows
//
//   { id, cells, caption?, link? }
//
// `id` is stable and unique within the check, `cells` hold a column's text or `{ text, tone }` (`tone` being
// 'success', 'warning' or 'error'), `caption` the line under the first cell and `link` a `linkTo` location.
//
// `ctx` is { database, GameID, RaceID, RaceNPR, separator, count(value, decimals), options, GameTime? }.

export const counter = (separator) => (value, decimals = 0) => separatedNumber(roundToDecimal(value || 0, decimals), separator)

export const rowsOf = async (ctx, sql) => {
  const [rows] = await ctx.database.query(sql)

  return rows
}

// `1 damaged ship`, `3 damaged ships`.
export const amount = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

// A colony row's name as plain text: its system and body, then its own name.
export const colonyText = (row) => populationName(row).replace(/&mdash;/g, '—')

export const bodyText = (row) => systemBodyName(row, { Name: row.SystemName })

// How far a 0 to 1 level is from fine: above 85% good, under 30% bad.
export const levelTone = (level) => (level > 0.85 ? 'success' : level < 0.3 ? 'error' : 'warning')

// The columns and joins that name a colony (`populationName` reads them) on a query over `FCT_Population`.
export const COLONY_COLUMNS = 'FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component'

export const COLONY_JOINS = 'left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID'

// Rows as the page keeps them: frozen, so Vue doesn't observe each cell, with the text a search looks in, and with an id made unique where a query returned one twice.
export const normalizeRows = (rows) => {
  const seen = new Map()

  return rows.map((row) => {
    const times = seen.get(row.id) || 0
    const cells = Object.values(row.cells).map((cell) => (cell !== null && typeof cell === 'object' ? cell.text : cell))

    seen.set(row.id, times + 1)

    return Object.freeze({
      ...row,
      id: times ? `${row.id}#${times + 1}` : row.id,
      text: [...cells, row.caption].filter((text) => text !== undefined && text !== null).join(' ').toLowerCase(),
    })
  })
}
