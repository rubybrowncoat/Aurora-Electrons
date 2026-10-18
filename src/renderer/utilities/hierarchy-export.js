// The exports of the shared hierarchies on the Commanders page: the naval administration (utilities/naval-hierarchy.js) and the ground formations (utilities/ground-formations.js), each as a CSV with one row per entry and as a Markdown outline. Both walk the model from its top-level entries, so an entry appears once, under its parent, and an entry whose parent is missing, foreign or in a loop is a top-level entry that says so. Nothing is invented: a name or holder the save does not give is an empty cell, a post whose holders cannot be told is `not settled` or `not read`, never `vacant`, and the notes list only what the model reports.

import { csvCell } from './csv-cell'
import { POSTS } from './commanders'

export const HIERARCHY_TREES = ['naval', 'ground']

const TREE_NAMES = { naval: 'Naval command structure', ground: 'Ground command structure' }
const TREE_FILES = { naval: 'naval-structure', ground: 'ground-structure' }
const TREE_NOUNS = { naval: 'naval command structure', ground: 'ground command structure' }

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

// The Markdown outline of a supported model: the title, the summary, one bullet per entry nested under its parent (with the post, the holders and the notes), then the loops and the serving commanders whose post is not an entry.
export const hierarchyMarkdown = (model, tree) => {
  const lines = [`# ${TREE_NAMES[tree]}`, '', `Game ${model.GameID}, race ${model.RaceID}: ${hierarchySummary(model, tree)}.`, '']

  hierarchyRows(model, tree).forEach((row) => {
    const label = row.Name === null || row.Name === '' ? `${row.Kind} ${row.ID}` : markdownText(row.Name)
    const holder = row['Holder ID'] === '' ? '' : `, held by ${row.Holder === '' ? row['Holder ID'] : `${markdownText(row.Holder)} (${row['Holder ID']})`}`
    const post = row.Post === '' ? '' : ` — ${row.Post}: ${row.Vacancy}${holder}`
    const top = row.Depth > 0 || row.Anchor === 'root' ? '' : `, ${row.Anchor}`
    const notes = row.Note === '' ? '' : ` — ${row.Note.split('; ').map((note) => `\`${note}\``).join(' ')}`
    const line = row['Shipping line'] === '' ? '' : ', shipping line'

    lines.push(`${'  '.repeat(row.Depth)}- ${label} (${row.Kind} ${row.ID}${line}${top})${post}${notes}`)
  })

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

// The text, the file name and the type of an export of a supported model: `format` is 'csv' or 'markdown'.
export const hierarchyExport = (model, tree, format) => {
  const csv = format === 'csv'

  return { text: csv ? hierarchyCsv(model, tree) : hierarchyMarkdown(model, tree), fileName: `${TREE_FILES[tree]}-g${model.GameID}-r${model.RaceID}.${csv ? 'csv' : 'md'}`, type: csv ? 'text/csv' : 'text/markdown' }
}

// What the page says in place of the export, or null when the model can be exported: the model is not supported (the save lacks tables or columns), or the serving commanders could not be read (the posts then are not listed).
export const hierarchyNotice = (model, tree) => {
  if (!model.supported) {
    return `The save lacks ${model.missing.join(', ')}, so the ${TREE_NOUNS[tree]} cannot be listed.`
  }

  return model.holders.read ? null : `The save lacks ${model.holders.missing.join(', ')}, so the serving commanders are not listed.`
}
