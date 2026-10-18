// The selected race's naval administration as one hierarchy: the admin commands, the fleets under them and the ships in the fleets, each with the serving commander of its post (a command's admin, a ship's captain), for the export of the Commanders page. The saves are observational: a link that names nothing, or names a row of another race or game, ends visibly and never drops a row; a post whose holders cannot be told is unknown, never vacant.
//
// What the model reports and never drops:
// - Every command, fleet and ship row of the race is one entry, once. A row of another race or game is left out and counted in `summary.excluded`; a repeated row is counted in `summary.duplicateRows`.
// - A parent link (a command's parent command, a fleet's command, a ship's fleet) that names nothing of the race is an orphan (`orphan-parent`), one that names a row of another race or game is `foreign-parent`, and one that is not stored is `parent-unknown`. The entry stays unresolved: it is a top-level entry whose `anchor` says so and so is everything below it.
// - A loop in the commands' parent links ends visibly: each loop is one entry of `cycles` naming its members, the member with the lowest id is where it is cut and shown as a top-level entry, and every member carries `parent-cycle`.
// - A fleet of a shipping line and a ship of a shipping line (or in such a fleet) are civilian, not the navy. They are left out and counted in `summary.civilian`, unless the model is built `shippingLines`: then they are entries like the others, each marked `shippingLine` and counted in `summary.civilian` as well. A flag that is not stored leaves the entry in the tree with `shipping-line-unknown`, with or without the shipping lines.
// - A fleet is not a post. A command's post is the admin commander (CommandType 12) and a ship's the captain (CommandType 1).

import { findCycles, missingColumns } from './ground-formations'
import { HOLDER_COLUMNS, holderIndex, holderSql, notAPost, postCounts, postOf, postProblems, strayHolders } from './post-holders'

// The post types of the commanders who serve in an admin command and as the captain of a ship (FCT_Commander.CommandType).
const COMMAND_POST = 12
const SHIP_POST = 1

// The columns each table must have for the model to be read from a save; a save that lacks one is unsupported and the loader says which.
export const NAVAL_HIERARCHY_COLUMNS = {
  FCT_NavalAdminCommand: ['NavalAdminCommandID', 'AdminCommandName', 'ParentAdminCommandID', 'GameID', 'RaceID'],
  FCT_Fleet: ['FleetID', 'FleetName', 'ParentCommandID', 'ShippingLine', 'GameID', 'RaceID'],
  FCT_Ship: ['ShipID', 'ShipName', 'FleetID', 'ShippingLineID', 'GameID', 'RaceID'],
}

// The order of the kinds among the children of one entry.
export const NAVAL_KINDS = ['command', 'fleet', 'ship']

const isId = (value) => Number.isInteger(value) && value > 0
const kindRank = (kind) => NAVAL_KINDS.indexOf(kind)

const requireIds = ({ GameID, RaceID }) => {
  if (!Number.isInteger(GameID) || !Number.isInteger(RaceID)) {
    throw new TypeError('The naval hierarchy is read for a game and a race given as whole numbers')
  }
}

// The statements that read the model for a game and a race, each a SELECT, by name. `outsideCommands` and `outsideFleets` are the rows the race's rows name as parents that are not the race's own, so a link to another race or game can be told from a link to nothing.
export const navalHierarchySql = ({ GameID, RaceID }) => {
  requireIds({ GameID, RaceID })

  const own = (table) => `${table}.GameID = ${GameID} and ${table}.RaceID = ${RaceID}`
  const foreign = (table) => `not (${own(table)})`
  const commandParents = `select FCT_NavalAdminCommand.ParentAdminCommandID from FCT_NavalAdminCommand where ${own('FCT_NavalAdminCommand')} union select FCT_Fleet.ParentCommandID from FCT_Fleet where ${own('FCT_Fleet')}`

  return {
    commands: `select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.AdminCommandName, FCT_NavalAdminCommand.ParentAdminCommandID, FCT_NavalAdminCommand.GameID, FCT_NavalAdminCommand.RaceID from FCT_NavalAdminCommand where ${own('FCT_NavalAdminCommand')} order by FCT_NavalAdminCommand.NavalAdminCommandID`,
    outsideCommands: `select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.GameID, FCT_NavalAdminCommand.RaceID from FCT_NavalAdminCommand where FCT_NavalAdminCommand.NavalAdminCommandID in (${commandParents}) and ${foreign('FCT_NavalAdminCommand')} order by FCT_NavalAdminCommand.NavalAdminCommandID`,
    fleets: `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.ParentCommandID, FCT_Fleet.ShippingLine, FCT_Fleet.GameID, FCT_Fleet.RaceID from FCT_Fleet where ${own('FCT_Fleet')} order by FCT_Fleet.FleetID`,
    outsideFleets: `select FCT_Fleet.FleetID, FCT_Fleet.GameID, FCT_Fleet.RaceID from FCT_Fleet where FCT_Fleet.FleetID in (select FCT_Ship.FleetID from FCT_Ship where ${own('FCT_Ship')}) and ${foreign('FCT_Fleet')} order by FCT_Fleet.FleetID`,
    ships: `select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.FleetID, FCT_Ship.ShippingLineID, FCT_Ship.GameID, FCT_Ship.RaceID from FCT_Ship where ${own('FCT_Ship')} order by FCT_Ship.ShipID`,
  }
}

// The rows of one kind that belong to the race, once each: { kept, excluded, duplicates }.
const ownRows = (rows, idColumn, { GameID, RaceID }) => {
  const seen = new Set()
  const kept = []
  let excluded = 0
  let duplicates = 0

  rows.forEach((row) => {
    if (row.RaceID !== RaceID || row.GameID !== GameID) {
      excluded++
    } else if (seen.has(row[idColumn])) {
      duplicates++
    } else {
      seen.add(row[idColumn])
      kept.push(row)
    }
  })

  return { kept: kept.sort((a, b) => a[idColumn] - b[idColumn]), ids: seen, excluded, duplicates }
}

const keyOf = (kind, id) => `${kind}:${id}`

// Whether a shipping-line flag marks a civilian entry: true for a positive number, false for 0, null where the flag is not stored.
const civilianFlag = (value) => (typeof value === 'number' && Number.isFinite(value) ? value > 0 : null)

// The model of a race's naval administration from the rows of `navalHierarchySql` (the arrays `commands`, `outsideCommands`, `fleets`, `outsideFleets` and `ships`; one that is left out is empty) and, optionally, the `commanders` of `holderSql` for the types 12 and 1 (left out, the posts are unread). `options.shippingLines` (false by default) keeps the shipping lines' fleets and ships. Gives { GameID, RaceID, shippingLines, nodes, byKey, roots, cycles, problems, summary, holders }:
// - `nodes` is every entry in tree order (each entry follows its parent, the children by kind then id): { key ('command:7'), kind, id, name, shippingLine (true for a shipping line's fleet or ship, else false), parent: { kind, id, key, state: 'none' | 'resolved' | 'orphan' | 'foreign' | 'unknown' | 'cycle' }, children (keys), anchor: { kind: 'root' | 'orphan' | 'foreign' | 'unknown' | 'cycle', key }, resolved, depth, post ({ state, holders, unsettled }; a fleet is `none`), problems }.
// - `roots` are the keys of the top-level entries: those with no parent, then orphans, then the rest, each by kind then id. Every entry is under exactly one of them.
// - `cycles` are { id, members (command ids), cutAt }. `problems` is every problem of every entry, each { key, kind, message, ... }.
// - `summary` reconciles with the rows: the counts per kind, `excluded` and `duplicateRows` per kind, `civilian` ({ fleets, ships }: the shipping lines' fleets and ships of the race, listed or not), the problem counts, `posts` (the commands and ships by the state of their post) and `strayHolders` ({ command, ship }: serving commanders whose post is not an entry of the race).
export const buildNavalHierarchy = (rows, ids, options = {}) => {
  const { GameID, RaceID } = ids
  const { commands: commandRows = [], outsideCommands = [], fleets: fleetRows = [], outsideFleets = [], ships: shipRows = [], commanders: commanderRows } = rows
  const commandSet = ownRows(commandRows, 'NavalAdminCommandID', ids)
  const fleetSet = ownRows(fleetRows, 'FleetID', ids)
  const shipSet = ownRows(shipRows, 'ShipID', ids)
  const foreignCommands = new Map(outsideCommands.map((row) => [row.NavalAdminCommandID, row]))
  const foreignFleets = new Map(outsideFleets.map((row) => [row.FleetID, row]))
  const commandHolders = holderIndex(commanderRows, COMMAND_POST)
  const shipHolders = holderIndex(commanderRows, SHIP_POST)
  const shippingLines = options.shippingLines === true
  const civilianFleets = new Set(fleetSet.kept.filter((row) => civilianFlag(row.ShippingLine) === true).map((row) => row.FleetID))
  const isCivilianShip = (row) => civilianFlag(row.ShippingLineID) === true || civilianFleets.has(row.FleetID)
  const keptFleets = shippingLines ? fleetSet.kept : fleetSet.kept.filter((row) => !civilianFleets.has(row.FleetID))
  const keptFleetIds = new Set(keptFleets.map((row) => row.FleetID))
  const keptShips = shippingLines ? shipSet.kept : shipSet.kept.filter((row) => !isCivilianShip(row))
  const nodes = new Map()
  const parentOf = new Map()
  const commandParent = new Map()

  // The parent link of an entry: `raw` is the stored id, `kind` what it names, `found` whether the race has it, `foreign` the other races' and games' rows of that kind.
  const linkOf = (raw, kind, found, foreign, noun) => {
    if (raw === 0) {
      return { parent: { kind: null, id: null, key: null, state: 'none' }, problems: [] }
    }

    if (!isId(raw)) {
      return { parent: { kind: null, id: null, key: null, state: 'unknown' }, problems: [{ kind: 'parent-unknown', message: `The parent link of the ${noun} is not stored` }] }
    }

    if (found.has(raw)) {
      return { parent: { kind, id: raw, key: keyOf(kind, raw), state: 'resolved' }, problems: [] }
    }

    if (foreign.has(raw)) {
      const row = foreign.get(raw)

      return { parent: { kind, id: raw, key: keyOf(kind, raw), state: 'foreign', raceId: row.RaceID ?? null, gameId: row.GameID ?? null }, problems: [{ kind: 'foreign-parent', parentId: raw, message: `Parent ${kind} ${raw} belongs to another race or game` }] }
    }

    return { parent: { kind, id: raw, key: keyOf(kind, raw), state: 'orphan' }, problems: [{ kind: 'orphan-parent', parentId: raw, message: `Parent ${kind} ${raw} is not in the save` }] }
  }

  const add = (kind, id, name, link, post, extra = [], shippingLine = false) => {
    const key = keyOf(kind, id)

    nodes.set(key, { key, kind, id, name: name ?? null, shippingLine, parent: link.parent, children: [], anchor: null, resolved: false, depth: 0, post, problems: [...link.problems, ...extra, ...postProblems(post)] })

    if (link.parent.state === 'resolved') {
      parentOf.set(key, link.parent.key)
    }
  }

  commandSet.kept.forEach((row) => {
    const link = linkOf(row.ParentAdminCommandID, 'command', commandSet.ids, foreignCommands, 'command')

    add('command', row.NavalAdminCommandID, row.AdminCommandName, link, postOf(commandHolders, row.NavalAdminCommandID))

    if (link.parent.state === 'resolved') {
      commandParent.set(row.NavalAdminCommandID, row.ParentAdminCommandID)
    }
  })

  const unknownFlag = (value, noun) => (civilianFlag(value) === null ? [{ kind: 'shipping-line-unknown', message: `Whether the ${noun} belongs to a shipping line is not stored` }] : [])

  keptFleets.forEach((row) => {
    add('fleet', row.FleetID, row.FleetName, linkOf(row.ParentCommandID, 'command', commandSet.ids, foreignCommands, 'fleet'), notAPost(), unknownFlag(row.ShippingLine, 'fleet'), civilianFleets.has(row.FleetID))
  })

  keptShips.forEach((row) => {
    add('ship', row.ShipID, row.ShipName, linkOf(row.FleetID, 'fleet', keptFleetIds, foreignFleets, 'ship'), postOf(shipHolders, row.ShipID), unknownFlag(row.ShippingLineID, 'ship'), isCivilianShip(row))
  })

  const cycles = findCycles(commandParent).map((members) => ({ id: `cycle:${members[0]}`, members, cutAt: members[0] }))
  const cut = new Set(cycles.map((cycle) => keyOf('command', cycle.cutAt)))

  cycles.forEach((cycle) => {
    cycle.members.forEach((id) => {
      const node = nodes.get(keyOf('command', id))

      node.parent = { ...node.parent, state: cycle.cutAt === id ? 'cycle' : node.parent.state, cycleId: cycle.id }
      node.problems.push({ kind: 'parent-cycle', cycleId: cycle.id, members: cycle.members, message: `The parent links of commands ${cycle.members.join(', ')} form a loop${cycle.cutAt === id ? '; it is cut here' : ''}` })
    })
  })

  const compare = (a, b) => kindRank(a.kind) - kindRank(b.kind) || a.id - b.id

  nodes.forEach((node) => {
    if (node.parent.state === 'resolved') {
      nodes.get(node.parent.key).children.push(node.key)
    }
  })

  nodes.forEach((node) => node.children.sort((a, b) => compare(nodes.get(a), nodes.get(b))))

  const rank = (node) => (node.parent.state === 'none' ? 0 : node.parent.state === 'orphan' ? 1 : 2)
  const topLevel = Array.from(nodes.values()).filter((node) => !parentOf.has(node.key) || cut.has(node.key)).sort((a, b) => rank(a) - rank(b) || compare(a, b))
  const order = []
  const stack = []

  topLevel.slice().reverse().forEach((top) => {
    top.anchor = { kind: top.parent.state === 'none' ? 'root' : top.parent.state, key: top.key }
    top.resolved = top.parent.state === 'none'
    top.depth = 0
    stack.push(top)
  })

  while (stack.length) {
    const node = stack.pop()

    order.push(node)

    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = nodes.get(node.children[index])

      child.anchor = node.anchor
      child.resolved = node.resolved
      child.depth = node.depth + 1
      stack.push(child)
    }
  }

  const problems = order.flatMap((node) => node.problems.map((problem) => ({ key: node.key, ...problem })))
  const count = (kind) => problems.filter((problem) => problem.kind === kind).length
  const ofKind = (kind) => order.filter((node) => node.kind === kind)

  const summary = {
    commands: ofKind('command').length,
    fleets: ofKind('fleet').length,
    ships: ofKind('ship').length,
    excluded: { commands: commandSet.excluded, fleets: fleetSet.excluded, ships: shipSet.excluded },
    duplicateRows: { commands: commandSet.duplicates, fleets: fleetSet.duplicates, ships: shipSet.duplicates },
    civilian: { fleets: civilianFleets.size, ships: shipSet.kept.filter(isCivilianShip).length },
    roots: topLevel.filter((node) => node.parent.state === 'none').length,
    topLevel: topLevel.length,
    orphans: count('orphan-parent'),
    foreignParents: count('foreign-parent'),
    unknownParents: count('parent-unknown'),
    unknownShippingLines: count('shipping-line-unknown'),
    cycles: cycles.length,
    cycleMembers: cycles.reduce((sum, cycle) => sum + cycle.members.length, 0),
    unresolved: order.filter((node) => !node.resolved).length,
    posts: postCounts(order),
    strayHolders: { command: strayHolders(commandHolders, commandSet.ids), ship: strayHolders(shipHolders, shipSet.ids) },
  }

  return { GameID, RaceID, shippingLines, nodes: order, byKey: nodes, roots: topLevel.map((node) => node.key), cycles, problems, summary, holders: { read: commandHolders !== null, missing: [] } }
}

// Reads the model for a game and a race from the open save, with SELECT statements only; `shippingLines` (false by default) keeps the shipping lines' fleets and ships. A save that lacks a table or column of NAVAL_HIERARCHY_COLUMNS gives { supported: false, missing } and no figures; otherwise { supported: true, ...model } (see `buildNavalHierarchy`). The commanders are read when the save has the columns of HOLDER_COLUMNS; without them every post is `unread` and `holders` says what the save lacks.
export const loadNavalHierarchy = async (database, { GameID, RaceID, shippingLines = false }) => {
  requireIds({ GameID, RaceID })

  const missing = await missingColumns(database, NAVAL_HIERARCHY_COLUMNS)

  if (missing.length) {
    return { supported: false, missing, GameID, RaceID }
  }

  const rows = {}

  for (const [name, sql] of Object.entries(navalHierarchySql({ GameID, RaceID }))) {
    ;[rows[name]] = await database.query(sql)
  }

  const holderGaps = await missingColumns(database, HOLDER_COLUMNS)

  if (!holderGaps.length) {
    ;[rows.commanders] = await database.query(holderSql({ GameID, RaceID }, [COMMAND_POST, SHIP_POST]))
  }

  return { supported: true, ...buildNavalHierarchy(rows, { GameID, RaceID }, { shippingLines }), holders: { read: !holderGaps.length, missing: holderGaps } }
}
