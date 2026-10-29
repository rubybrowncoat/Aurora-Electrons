// The exports of the shared hierarchies on the Commanders page: the naval administration (utilities/naval-hierarchy.js) and the ground formations (utilities/ground-formations.js), each as a CSV with one row per entry and as a Markdown document. Both walk the model from its top-level entries, so an entry appears once, under its parent, and an entry whose parent is missing, foreign or in a loop is a top-level entry that says so. Nothing is invented: a name or holder the save does not give is an empty cell, a post whose holders cannot be told is `not settled` or `not read`, never `vacant`, and the notes list only what the model reports.
//
// The Markdown document is titled with the empire's name and holds the organisation twice: as a Mermaid flowchart of its units (every admin command; the formations that head other formations), which GitHub and Obsidian draw with nothing installed, and as a list of every entry nested under its parent. The list is indented four spaces a level, which nests the same in every Markdown reader, the CommonMark ones and those that need four spaces alike. A branch (a unit and everything under it) is exported the same way as a document of its own, so an organisation too large for one diagram is drawn a branch at a time.

import { csvCell } from './csv-cell'
import { fileSlug } from './file-slug'
import { POSTS } from './commanders'
import { fieldList } from './provenance'

export const HIERARCHY_TREES = ['naval', 'ground']

const TREE_NAMES = { naval: 'Naval command structure', ground: 'Ground command structure' }
const TREE_FILES = { naval: 'naval-structure', ground: 'ground-structure' }
const TREE_NOUNS = { naval: 'naval command structure', ground: 'ground command structure' }
const LIST_TITLES = { naval: 'Commands, fleets and ships', ground: 'Formations' }
const UNIT_NOUNS = { naval: ['admin command', 'admin commands'], ground: ['formation that heads others', 'formations that head others'] }
const UNIT_LEGENDS = { naval: 'Each admin command with the commander serving in it; an arrow leads to the commands under it.', ground: 'Each formation that heads other formations with its commander; an arrow leads to the formations under it.' }

// The most units the diagram draws. Past it the chart is too dense to read, and Mermaid's default configuration (`maxEdges`) refuses a flowchart of more than 500 arrows.
export const DIAGRAM_LIMIT = 150

// The indentation of one level of the list.
const LEVEL = '    '

// The columns of the CSV, in order.
export const HIERARCHY_COLUMNS = ['Tree', 'Game ID', 'Race ID', 'Kind', 'ID', 'Name', 'Shipping line', 'Depth', 'Path', 'Path IDs', 'Parent kind', 'Parent ID', 'Parent state', 'Post', 'Holder ID', 'Holder', 'Vacancy', 'Anchor', 'Note']

// The columns of numbers, which are never guarded against a spreadsheet formula.
const NUMBER_COLUMNS = new Set(['Game ID', 'Race ID', 'ID', 'Depth', 'Parent ID', 'Holder ID'])

// The problems that are about the structure or the posts, which the Note column and the outline list by kind.
const NOTE_KINDS = new Set(['orphan-parent', 'foreign-parent', 'parent-unknown', 'parent-cycle', 'post-shared', 'post-unsettled', 'shipping-line-unknown'])

const VACANCIES = { held: 'held', vacant: 'vacant', shared: 'several holders', unknown: 'not settled', unread: 'not read', none: 'not a post' }

const POST_OF_KIND = { formation: POSTS[5], command: POSTS[12], ship: POSTS[1] }

// The model as a list of entries in a common shape: { key, kind, id, name, parent: { kind, id, state }, children (keys), anchor (kind), post, problems }, with `roots` (keys).
const entriesOf = (model, tree) => {
  if (tree === 'naval') {
    return { entries: model.byKey, roots: model.roots }
  }

  const entries = new Map()

  model.formations.forEach((node) => {
    entries.set(`formation:${node.id}`, { key: `formation:${node.id}`, kind: 'formation', id: node.id, name: node.name, parent: { kind: node.parent.id === null ? null : 'formation', id: node.parent.id, state: node.parent.state }, children: node.children.map((id) => `formation:${id}`), anchor: node.anchor, post: node.post, problems: node.problems })
  })

  return { entries, roots: model.roots.map((id) => `formation:${id}`) }
}

// The rows of an export: one per entry, each walked from its top-level entry in tree order with its path from the top. `model` is a supported model of `tree` ('naval' or 'ground').
export const hierarchyRows = (model, tree) => {
  const { entries, roots } = entriesOf(model, tree)
  const rows = []
  const stack = roots.slice().reverse().map((key) => ({ key, path: [] }))

  while (stack.length) {
    const { key, path } = stack.pop()
    const entry = entries.get(key)
    const here = [...path, entry]
    const holders = entry.post.holders
    const anchor = entry.anchor ? entry.anchor.kind : ''

    rows.push({
      Tree: tree,
      'Game ID': model.GameID,
      'Race ID': model.RaceID,
      Kind: entry.kind,
      ID: entry.id,
      Name: entry.name,
      'Shipping line': entry.shippingLine ? 'yes' : '',
      Depth: path.length,
      Path: here.map((step) => step.name ?? '').join(' / '),
      'Path IDs': here.map((step) => step.key).join('/'),
      'Parent kind': entry.parent.kind,
      'Parent ID': entry.parent.id,
      'Parent state': entry.parent.state,
      Post: entry.post.state === 'none' ? '' : POST_OF_KIND[entry.kind],
      'Holder ID': holders.map((holder) => holder.id).join('; '),
      Holder: holders.map((holder) => holder.name ?? '').join('; '),
      Vacancy: VACANCIES[entry.post.state],
      Anchor: anchor,
      Note: entry.problems.filter((problem) => NOTE_KINDS.has(problem.kind)).map((problem) => problem.kind).join('; '),
    })

    for (let index = entry.children.length - 1; index >= 0; index--) {
      stack.push({ key: entry.children[index], path: here })
    }
  }

  return rows
}

// The CSV of a supported model: the header, then one line per entry, lines ending in a line feed.
export const hierarchyCsv = (model, tree) => {
  const line = (row) => HIERARCHY_COLUMNS.map((column) => csvCell(row[column], { guard: !NUMBER_COLUMNS.has(column) })).join(',')

  return `${[HIERARCHY_COLUMNS.join(','), ...hierarchyRows(model, tree).map(line)].join('\n')}\n`
}

// A text made safe to read as Markdown: a line break is a space, and a character Markdown reads as markup (a backslash, a backtick, `*`, `_`, brackets, angle brackets, `|`, `#`, `&`) is escaped, as is a list marker or a number with a full stop at the start.
export const markdownText = (value) => String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/[\\`*_[\]<>|#&]/g, (character) => `\\${character}`).replace(/^(\s*)([+-])/, '$1\\$2').replace(/^(\s*\d+)([.)])/, '$1\\$2')

const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`

// One line on what a supported model holds: the entries, the entries left out (the shipping lines' fleets and ships, unless they are listed), the posts and the problems.
export const hierarchySummary = (model, tree) => {
  const { summary } = model
  const posts = summary.posts
  const postText = model.holders.read ? `, posts: ${posts.held} held, ${posts.vacant} vacant, ${posts.shared} with several holders, ${posts.unknown} not settled` : ', serving commanders not read'

  if (tree === 'ground') {
    return `${counted(summary.formations, 'formation', 'formations')}${postText}; ${counted(summary.orphans + summary.foreignParents + summary.unknownParents, 'unresolved parent link', 'unresolved parent links')}, ${counted(summary.cycles, 'loop', 'loops')}`
  }

  const lineText = `${counted(summary.civilian.fleets, 'shipping-line fleet', 'shipping-line fleets')} and ${counted(summary.civilian.ships, 'shipping-line ship', 'shipping-line ships')} ${model.shippingLines ? 'included' : 'left out'}`

  return `${counted(summary.commands, 'command', 'commands')}, ${counted(summary.fleets, 'fleet', 'fleets')}, ${counted(summary.ships, 'ship', 'ships')}${postText}; ${lineText}; ${counted(summary.orphans + summary.foreignParents + summary.unknownParents, 'unresolved parent link', 'unresolved parent links')}, ${counted(summary.cycles, 'loop', 'loops')}`
}

// A unit of the diagram and a branch that can be exported on its own: an admin command of the naval tree, or a formation that heads other formations.
const isUnit = (entry, tree) => (tree === 'naval' ? entry.kind === 'command' : entry.children.length > 0)

// The rows of the branch headed by the entry `key`, from `rows` (of `hierarchyRows`, in tree order): the entry and every row after it that is deeper, with the names of the entries above it from the top. Null when the entry is not in the rows.
const branchOf = (rows, key) => {
  const start = rows.findIndex((row) => `${row.Kind}:${row.ID}` === key)

  if (start === -1) {
    return null
  }

  const depth = rows[start].Depth
  const end = rows.findIndex((row, index) => index > start && row.Depth <= depth)
  const above = []

  for (let index = start - 1, wanted = depth - 1; index >= 0 && wanted >= 0; index--) {
    if (rows[index].Depth === wanted) {
      above.unshift(rows[index].Name === null || rows[index].Name === '' ? `${rows[index].Kind} ${rows[index].ID}` : rows[index].Name)
      wanted -= 1
    }
  }

  return { rows: rows.slice(start, end === -1 ? rows.length : end), depth, above }
}

// The branches of a supported model that can be exported on their own, in tree order: each unit with its key, kind, id, name, its path from the top (names joined by ' / '), the names of the entries above it (every one a unit: a command's parent is a command, a formation's parent heads it), its depth, and the entries and the units of its branch, itself included (the units are what its diagram draws).
export const hierarchyBranches = (model, tree) => {
  const { entries } = entriesOf(model, tree)
  const branches = []
  const open = []

  hierarchyRows(model, tree).forEach((row) => {
    while (open.length && open[open.length - 1].depth >= row.Depth) {
      open.pop()
    }

    const entry = entries.get(`${row.Kind}:${row.ID}`)
    const unit = isUnit(entry, tree)

    open.forEach((branch) => {
      branch.entries += 1
      branch.units += unit ? 1 : 0
    })

    if (unit) {
      const branch = { key: entry.key, kind: entry.kind, id: entry.id, name: entry.name, path: row.Path, above: open.map((item) => item.name || `${item.kind} ${item.id}`).join(' / '), depth: row.Depth, entries: 1, units: 1 }

      branches.push(branch)
      open.push(branch)
    }
  })

  return branches
}

// One line on what a branch holds: where it sits, its entries by kind and its posts.
const branchSummary = (model, tree, branch) => {
  const kinds = (kind) => branch.rows.filter((row) => row.Kind === kind).length
  const posts = branch.rows.filter((row) => row.Post !== '')
  const vacancies = (vacancy) => posts.filter((row) => row.Vacancy === vacancy).length
  const postText = model.holders.read ? `, posts: ${vacancies(VACANCIES.held)} held, ${vacancies(VACANCIES.vacant)} vacant, ${vacancies(VACANCIES.shared)} with several holders, ${vacancies(VACANCIES.unknown)} not settled` : ', serving commanders not read'
  const place = branch.above.length ? `under ${markdownText(branch.above.join(' / '))}` : 'at the top'
  const counts = tree === 'ground' ? counted(kinds('formation'), 'formation', 'formations') : `${counted(kinds('command'), 'command', 'commands')}, ${counted(kinds('fleet'), 'fleet', 'fleets')}, ${counted(kinds('ship'), 'ship', 'ships')}`

  return `A branch of the ${TREE_NOUNS[tree]}, ${place}: ${counts}${postText}`
}

// A text made safe to stand in a quoted Mermaid label: a line break is a space, and a character that would end the label, start an entity or markup, start a directive (`%%{init: …}%%`, which Mermaid reads even inside a label) or close the Markdown fence (a quote, `#`, `%`, angle brackets, `&`, a backtick) is written as Mermaid's entity code for it.
export const mermaidText = (value) => String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/["#%<>&`]/g, (character) => `#${character.charCodeAt(0)};`)

// The organisation, or the branch (`whole` false), as the lines of a Mermaid flowchart, from the `rows` of `hierarchyRows` it holds: its units in tree order, each with its name and the commanders serving in its post (or what is known of the post), and an arrow from each unit to each unit under it. Past DIAGRAM_LIMIT units a sentence says so in place of the chart and points to the branches, and rows with no unit have no diagram.
const diagramLines = (model, tree, rows, whole) => {
  const { entries } = entriesOf(model, tree)
  const units = rows.map((row) => entries.get(`${row.Kind}:${row.ID}`)).filter((entry) => isUnit(entry, tree))

  if (!units.length) {
    return []
  }

  if (units.length > DIAGRAM_LIMIT) {
    return ['', '## Organisation', '', `The ${whole ? 'organisation' : 'branch'} has ${counted(units.length, ...UNIT_NOUNS[tree])}, more than the ${DIAGRAM_LIMIT} one diagram draws legibly, so none is drawn; the list below holds every entry. Export a branch ${whole ? 'of it' : 'within it'} on its own to draw that branch.`]
  }

  const ids = new Map(units.map((entry, index) => [entry.key, `n${index + 1}`]))
  const label = (entry) => {
    const { holders, state } = entry.post
    const serving = holders.length ? holders.map((holder) => holder.name || String(holder.id)).join(', ') : VACANCIES[state]

    return `${mermaidText(entry.name || `${entry.kind} ${entry.id}`)}<br>${mermaidText(serving)}`
  }
  const nodes = units.map((entry) => `  ${ids.get(entry.key)}["${label(entry)}"]`)
  const arrows = units.flatMap((entry) => entry.children.filter((key) => ids.has(key)).map((key) => `  ${ids.get(entry.key)} --> ${ids.get(key)}`))

  return ['', '## Organisation', '', UNIT_LEGENDS[tree], '', '```mermaid', 'flowchart LR', ...nodes, ...arrows, '```']
}

// The Markdown document of a supported model for the empire named `empire` (the race's title; without one the game and the race are named by id): the title, the summary, the diagram of the organisation, one bullet per entry nested under its parent (with the post, the holders and the notes), then the loops and the serving commanders whose post is not an entry. With `branch` (the key of a unit, as `hierarchyBranches` gives it) the document is that branch alone: titled with the branch, placed under the entries above it, its own diagram and its entries nested from the branch down; null when the model has no such entry.
export const hierarchyMarkdown = (model, tree, empire = '', branch = null) => {
  const name = String(empire ?? '').trim()
  const all = hierarchyRows(model, tree)
  const part = branch === null ? null : branchOf(all, branch)

  if (branch !== null && !part) {
    return null
  }

  const rows = part ? part.rows : all
  const base = part ? part.depth : 0
  const ids = name ? '' : `Game ${model.GameID}, race ${model.RaceID}: `
  const head = part ? [`# ${name ? `${markdownText(name)}: ` : ''}${rows[0].Name === null || rows[0].Name === '' ? `${rows[0].Kind} ${rows[0].ID}` : markdownText(rows[0].Name)} (${rows[0].Kind} ${rows[0].ID})`, '', `${ids}${branchSummary(model, tree, part)}.`] : [name ? `# ${markdownText(name)}: ${TREE_NOUNS[tree]}` : `# ${TREE_NAMES[tree]}`, '', `${name ? '' : `Game ${model.GameID}, race ${model.RaceID}: `}${hierarchySummary(model, tree)}.`]
  const lines = [...head, ...diagramLines(model, tree, rows, !part), '', `## ${LIST_TITLES[tree]}`, '']

  rows.forEach((row) => {
    const label = row.Name === null || row.Name === '' ? `${row.Kind} ${row.ID}` : markdownText(row.Name)
    const holder = row['Holder ID'] === '' ? '' : `, held by ${row.Holder === '' ? row['Holder ID'] : `${markdownText(row.Holder)} (${row['Holder ID']})`}`
    const post = row.Post === '' ? '' : ` — ${row.Post}: ${row.Vacancy}${holder}`
    const top = row.Depth > 0 || row.Anchor === 'root' ? '' : `, ${row.Anchor}`
    const notes = row.Note === '' ? '' : ` — ${row.Note.split('; ').map((note) => `\`${note}\``).join(' ')}`
    const line = row['Shipping line'] === '' ? '' : ', shipping line'

    lines.push(`${LEVEL.repeat(row.Depth - base)}- ${label} (${row.Kind} ${row.ID}${line}${top})${post}${notes}`)
  })

  if (part) {
    return `${lines.join('\n')}\n`
  }

  if (model.cycles.length) {
    lines.push('', '## Loops', '')
    model.cycles.forEach((cycle) => lines.push(`- ${cycle.members.join(', ')}, cut at ${cycle.cutAt}`))
  }

  const strays = tree === 'naval' ? model.summary.strayHolders.command + model.summary.strayHolders.ship : model.summary.strayHolders

  if (strays) {
    lines.push('', `${counted(strays, 'serving commander holds', 'serving commanders hold')} a post that is not in this outline.`)
  }

  return `${lines.join('\n')}\n`
}

// The text, the file name and the type of an export of a supported model: `format` is 'csv' or 'markdown'. Both are named for the empire (`empire`, the race's title, made a file name by `fileSlug`), and for the game and the race by id when there is no name to use. With `branch` (a unit's key) the Markdown is that branch, named with its kind and id after the structure; null when the model has no such entry. The CSV is always the whole structure.
export const hierarchyExport = (model, tree, format, empire = '', branch = null) => {
  const csv = format === 'csv'
  const slug = fileSlug(empire)
  const prefix = slug ? `${slug}-${TREE_FILES[tree]}` : `${TREE_FILES[tree]}-g${model.GameID}-r${model.RaceID}`
  const part = csv ? null : branch
  const text = csv ? hierarchyCsv(model, tree) : hierarchyMarkdown(model, tree, empire, part)

  if (text === null) {
    return null
  }

  return { text, fileName: `${prefix}${part === null ? '' : `-${part.replace(':', '-')}`}.${csv ? 'csv' : 'md'}`, type: csv ? 'text/csv' : 'text/markdown' }
}

// What the page says in place of the export, or null when the model can be exported: the model is not supported (the save lacks tables or columns), or the serving commanders could not be read (the posts then are not listed).
export const hierarchyNotice = (model, tree) => {
  if (!model.supported) {
    return `The save lacks ${fieldList(model.missing)}, so the ${TREE_NOUNS[tree]} cannot be listed.`
  }

  return model.holders.read ? null : `The save lacks ${fieldList(model.holders.missing)}, so the serving commanders are not listed.`
}
