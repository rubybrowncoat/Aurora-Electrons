import { populationName, systemBodyName } from '../aurora'
import { UNKNOWN_TEXT, countText, isKnownNumber } from '../math'
import { registerRule, unavailable } from '../provenance'

// Shared by the check modules of the Warnings page. A check is
//
//   { key, group, severity, title(count, options), rule, provenance, columns, options?, clock?, read(ctx) }
//
// `key` is stable and kebab-case; `severity` one of SEVERITIES (index.js); `title` the heading over the check's rows; `rule` one sentence saying when the check fires; `provenance` the id of the registered rule behind it (`warnings.<camelCased key>`, put there by `checksOf`); `columns` the table's `{ key, text, align? }`, the first holding the row's name; `options` the page options `read` depends on (so only those re-read the check when they change); `clock` that it depends on the game time. `read(ctx)` returns rows
//
//   { id, cells, caption?, link?, unevaluated? }
//
// `id` is stable and unique within the check, `cells` hold a column's text or `{ text, tone?, result? }` (`tone` being 'success', 'warning' or 'error'; `result` an unavailable provenance result naming the input a dash stands for), `caption` the line under the first cell and `link` a `linkTo` location. A row with `unevaluated` (an unavailable result naming the missing inputs) is one whose condition could not be decided because a stored value is missing: it is no warning, and the page lists it apart.
//
// `ctx` is { database, GameID, RaceID, RaceNPR, separator, count(value, decimals), options, GameTime?, unknown(missing) }; `unknown` is put there by `checksOf`.

const WARNING_VERSIONS = ['2.7.x']

const ruleName = (key) => key.replace(/-(\w)/g, (_match, letter) => letter.toUpperCase())

const UNKNOWN_INPUT = 'an input the check reads'

// Registers the rule behind each check of a module (`evidence` on the check: { verification, structure, note, assumptions? }) and gives the check its `provenance` id; its `read` gets `ctx.unknown(missing)`, an unavailable result of that rule naming `missing` (a list of the inputs a figure or a verdict lacks).
export const checksOf = (checks) => checks.map(({ evidence, read, ...check }) => {
  const provenance = `warnings.${ruleName(check.key)}`

  registerRule({ id: provenance, versions: WARNING_VERSIONS, units: 'rows', verification: evidence.verification, structure: evidence.structure, note: evidence.note, assumptions: evidence.assumptions })

  return { ...check, provenance, read: (ctx) => read({ ...ctx, unknown: (missing = []) => unavailable({ rule: provenance, missing: missing.length ? missing : [UNKNOWN_INPUT], units: 'rows' }) }) }
})

registerRule({
  id: 'warnings.summary',
  versions: WARNING_VERSIONS,
  units: 'rows, checks',
  verification: 'confirmed',
  structure: ['the rows each check returns', 'the muted rows and checks of the race'],
  note: 'Counts of the rows the checks return, by severity, less the muted rows and checks. A row whose condition could not be decided because a stored value is missing, and a check that could not be read, are counted apart and are in none of the warning counts.',
})

// A dash for a value that is not known (null, undefined, NaN), never 0.
export const counter = (separator) => (value, decimals = 0) => countText(value, decimals, separator)

const isMissing = (value) => value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))

// The names of the inputs a row lacks: `inputs` maps a column of the row to the words that name it.
export const lacking = (row, inputs) => Object.entries(inputs).filter(([column]) => isMissing(row[column])).map(([, name]) => name)

// Kleene logic over verdicts (1, 0, null for not known): `allOf` is 0 as soon as one is, else null when one is, else 1; `anyOf` is 1 as soon as one is, else null when one is, else 0. `false` and `true` count as 0 and 1.
const asVerdict = (value) => (value === null || value === undefined ? null : Number(Boolean(value)))

export const allOf = (...verdicts) => {
  const decided = verdicts.map(asVerdict)

  return decided.includes(0) ? 0 : decided.includes(null) ? null : 1
}

export const anyOf = (...verdicts) => {
  const decided = verdicts.map(asVerdict)

  return decided.includes(1) ? 1 : decided.includes(null) ? null : 0
}

// The rows a query kept with `Verdict` (the check's condition as the query evaluates it: 1, 0, or null while a stored value it needs is missing, SQLite's own three-valued logic): a 1 is a warning, a null a row that could not be evaluated, which `missing(item)` names, and a 0 is none. `build(item)` makes the row.
export const verdictRows = (ctx, items, { missing, build, verdict = (item) => item.Verdict }) => items.flatMap((item) => {
  const decided = verdict(item)

  if (decided === 0 || decided === false) {
    return []
  }

  const row = build(item)

  return [decided === null || decided === undefined ? { ...row, unevaluated: ctx.unknown(missing(item)) } : row]
})

// A dash standing for a figure that is not known, with the unavailable result naming the inputs (`names`, a list) it lacks.
export const unknownCell = (ctx, names) => ({ text: UNKNOWN_TEXT, result: ctx.unknown(names) })

// A figure as a cell: its text from `format` (by default a count), or a dash with the unavailable result naming `name` (one input, or a list) when the value is missing. `tone` gives the known figure its tone.
export const figure = (ctx, value, name, format = (known) => ctx.count(known), tone = null) => {
  if (!isKnownNumber(value)) {
    return unknownCell(ctx, [].concat(name))
  }

  const known = Number(value)

  return tone ? { text: format(known), tone: tone(known) } : format(known)
}

export const rowsOf = async (ctx, sql) => {
  const [rows] = await ctx.database.query(sql)

  return rows
}

// `1 damaged ship`, `3 damaged ships`.
export const amount = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

const UNKNOWN_SYSTEM = 'an unknown system'

// A system's name as plain text, never a bare `null`.
export const systemText = (row) => row.SystemName || UNKNOWN_SYSTEM

// A colony row's name as plain text: its system and body, then its own name.
export const colonyText = (row) => populationName({ ...row, SystemName: systemText(row), PopName: row.PopName || 'Unnamed colony' }).replace(/&mdash;/g, '—')

export const bodyText = (row) => systemBodyName(row, { Name: systemText(row) })

// How far a 0 to 1 level is from fine: above 85% good, under 30% bad.
export const levelTone = (level) => (level > 0.85 ? 'success' : level < 0.3 ? 'error' : 'warning')

// The columns and joins that name a colony (`populationName` reads them) on a query over `FCT_Population`.
export const COLONY_COLUMNS = 'FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component'

export const COLONY_JOINS = 'left join FCT_SystemBody on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBody.SystemBodyID = FCT_SystemBodyName.SystemBodyID and FCT_Population.RaceID = FCT_SystemBodyName.RaceID left join FCT_RaceSysSurvey on FCT_Population.SystemID = FCT_RaceSysSurvey.SystemID and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID left join FCT_Star on FCT_SystemBody.StarID = FCT_Star.StarID'

// Rows as the page keeps them: frozen, so Vue doesn't observe each cell, with the text a search looks in, and with an id made unique where a query returned one twice. A cell of a column the check shows that is missing (null or undefined) becomes a dash with an unavailable result naming the column, so no blank cell passes for a known empty one.
export const normalizeRows = (rows, check) => {
  const seen = new Map()

  return rows.map((row) => {
    const times = seen.get(row.id) || 0
    const cells = Object.fromEntries(check.columns.map((column) => [column.key, isMissing(row.cells[column.key]) ? { text: UNKNOWN_TEXT, result: unavailable({ rule: check.provenance, missing: [`the stored value behind the ${column.text} column`], units: 'rows' }) } : row.cells[column.key]]))
    const texts = Object.values(cells).map((cell) => (cell !== null && typeof cell === 'object' ? cell.text : cell))

    seen.set(row.id, times + 1)

    return Object.freeze({
      ...row,
      cells,
      id: times ? `${row.id}#${times + 1}` : row.id,
      text: [...texts, row.caption].filter((text) => text !== undefined && text !== null).join(' ').toLowerCase(),
    })
  })
}

// A ship class's name as plain text, never a bare `null`.
export const classText = (row) => (row.ClassName ? `${row.ClassName} Class` : 'An unnamed class')
