/*
  Checks the shared hierarchies of the Commanders page (the naval command structure and the ground formations, each with the serving commander of every post, and their CSV and Markdown exports) and the roster's post, rank and age-range filters, by what they do and never by how they are written.

  Run: bun scripts/check-hierarchy-export.js [--no-mutations] [--no-saves] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<suites | save:<index> | control | mutant:<index>>[,...]]

  Each part (the suites, each save, the control and each mutant) runs in a process of its own through scripts/lib/suite-runner.js, with a deadline and a record that --resume continues; `--variants` runs exactly the parts named, in one process.

  The groups, each check a PASS or FAIL line:
  - The pure builders on constructed rows worked out by hand: the naval tree (11 commands, 8 fleets and 8 ships of the race, and the rows that must not enter it; with the shipping lines listed, 9 fleets and 10 ships), the posts and their holders, the ground formations with their commanders, the CSV and Markdown of both (the Markdown's title and file name by the empire, its list nested as a CommonMark reader and a reader that needs four spaces a level read it, and its Mermaid diagram of the organisation read back as Mermaid reads it), and the roster filters on a roster of people whose post, rank and age are stored, unknown or on the edge of a bound.
  - The SELECT statements and the loaders on an in-memory SQLite database that holds rows of another race and another game, and a save without the columns the posts need (never a save of the user).
  - The Commanders page itself, its compiled template rendered by Vue: the controls are found by driving them and seeing the roster change, the downloads by clicking the buttons and reading what they save. The shipping-line switch is driven the same way against the page's own read of the naval tree on an in-memory database, re-run as the app re-runs a read whose inputs changed, and across a reload of the saved view.
  - Every AuroraDB*.db that can be found, one check per game and race: the models (with the shipping lines left out and listed), the posts and the roster filters compared with SQL written separately here. A save without the tables or columns is reported UNSUPPORTED and a save with nothing to compare EMPTY: neither counts as agreement.
  - Planted faults in the utilities and the page, each of which must make every check it names fail.

  The checks read behaviour: the rows a control leaves in the roster, the cells a parsed CSV holds, the text a Markdown reader would show. None reads the source or the template text, the wording of a sentence or the position of an element.

  Who is credited with a planted fault: a fault counts only when every check named for it fails by an assertion of its own on a value it read, never because something threw. A check's verdict (what it returns when it does not hold) is its own assertion, and so is the failure of a call of the code under test, which runs only through explicit adapters (the functions of the utilities, and the computed values, methods, watchers, reads, data and hooks of the page) that turn a throw or a rejection into a failure marked with a symbol nothing else holds and naming the call. Such a failure says that the subject threw (`threw` on the result), and a fault that a named check catches only that way crashed the code instead of changing a value: crediting it stops the run (HarnessError, exit status 2) unless the fault declares that a throw is how it is caught. Any other exception (a lookup the harness gets wrong, a check's own mistake) is a failed check in the unmodified code, and while a fault is judged it stops the run (HarnessError), crediting nothing. What the harness hands the page (the store and the methods of the persisted-view mixin) is the harness's own: a getter of the wrong kind or one that throws, a rejecting dispatch and a throwing callback are a HarnessError, never a failure of the page. The rule is the shared scripts/lib/fault-credit.js (`caughtAll`); `--detail` prints, for a mutant part, what each named check said.

  The figures of the exports are read whole by scripts/lib/browser-observe.js `readFigure` (the CSV writes them with no grouping), and the rows of a CSV and the bullets of an outline are set against the entries of the hand-worked tree by the identity of each (`pairedBy`, and the order of the tree for the outline, whose place is its structure), the order checked on its own. The bullet a reader nests a bullet under must be its parent's bullet in the model (`nestingOf`), and the nodes and arrows of the diagram are the model's units and their links (`flowchartOf`).
*/
const fs = require('fs')
const path = require('path')
const nodeVm = require('vm')
const sqlite3 = require('sqlite3')
const Vue = require('vue')
const { compileTemplate, parse } = require('vue/compiler-sfc')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage } = require('./lib/page-loader')
const { runSuite, runnerArgs } = require('./lib/suite-runner')
const rawAssert = require('./lib/bounded-assert')
const { HarnessError, readFigure, pairedBy } = require('./lib/browser-observe')
const { failure, isMarked, isSubjectThrow, through, harnessOwn, harnessStore, boundary, subjectModule, kindOf, judged, caughtAll } = require('./lib/fault-credit')

const root = path.resolve(__dirname, '..')
const rendererDirectory = path.join(root, 'src', 'renderer')
const UTILITIES = ['csv-cell', 'file-slug', 'post-holders', 'naval-hierarchy', 'hierarchy-export', 'ground-formations', 'commanders']
const PAGE = 'pages/commanders'

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The packages the utilities import: the commanders module reads dates with dayjs and numerals with romanum.
const STUBS = {
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
}

// The persisted view as the page gets it here: each field is data with its default, and the declared fields are kept on the component options for the checks. While a check sets `globalThis.__persistedStore` (a Map by field key) the fields are restored from it when a page is created and every change is written to it, as the app's electron-store does.
const PERSISTED = `
  export const oneOf = (values) => (value) => values.includes(value)
  export const tableView = (key, defaults) => ({ key, default: defaults })
  const copy = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))
  const restored = (field) => { const stored = globalThis.__persistedStore; const value = stored && stored.has(field.key) ? stored.get(field.key) : undefined; return value !== undefined && (!field.valid || field.valid(value)) ? copy(value) : copy(field.default) }
  export default (fields) => ({ persistedFields: fields, data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, restored(field)])), watch: Object.fromEntries(Object.keys(fields).map((name) => [name, { deep: true, handler(value) { if (globalThis.__persistedStore) globalThis.__persistedStore.set(fields[name].key, copy(value)) } }])), methods: { setUnsaved(name, value) { this[name] = value } } })
`

let checks = 0
let failures = 0
let unsupportedSaves = 0
let emptySaves = 0
let skippedSaves = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

// The script's own arguments (those of scripts/lib/suite-runner.js taken out by `runnerArgs`).
const parseArguments = (argv) => {
  const options = { mutations: true, saves: true, detail: false }

  for (const argument of argv) {
    if (argument === '--no-mutations') {
      options.mutations = false
    } else if (argument === '--detail') {
      options.detail = true
    } else if (argument === '--no-saves') {
      options.saves = false
    } else {
      console.error(`Unknown argument: ${argument}`)
      process.exit(2)
    }
  }

  return options
}

const settle = async (fn) => {
  try {
    return { value: await fn() }
  } catch (error) {
    return { error }
  }
}

const frozen = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }

  return value
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sorted = (list) => [...list].sort((a, b) => a - b)
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && same(sorted(a), sorted(b))
const numbersIn = (text) => (text.match(/\d+/g) || []).map(Number)
// A whole number of an export (an id, a depth, a count), read whole as the CSV writes it, with no grouping: null for anything else.
const wholeOf = (text) => {
  const value = readFigure(text, 'None')

  return Number.isInteger(value) && value >= 0 ? value : null
}
// The figures a line of text holds, each a word read whole (`grouping` the page's setting; the words are cut at spaces, brackets, commas and semicolons): a word that is no figure is a word.
const figuresIn = (text, grouping = 'None') => text.split(/[\s();,]+/).map((word) => readFigure(word, grouping)).filter((value) => value !== null)
// The identity of a row of an export: its kind and its id, read whole.
const keyOfRow = (row) => `${row.Kind}:${wholeOf(String(row.ID))}`
// The identity of a row as a pairing of a file's rows with the hand-worked entries reads it, outside any check: a row that lacks a cell of its identity (a line break the CSV left unquoted cuts a row in pieces) has an identity no entry has, so the pairing lists it as a problem and the checks that read the rows fail on it, instead of the suite stopping before them.
const pairingIdentity = (identity) => (row) => {
  try {
    return identity(row)
  } catch (error) {
    if (!isMarked(error)) {
      throw error
    }

    return `no identity: ${error.message}`
  }
}
// The ids of a cell that lists several (the holders of a post), in the order of the cell, each read whole.
const idsIn = (text) => text.split('; ').map(wholeOf)

// ---------- who failed ----------

// scripts/lib/fault-credit.js: a check fails by an assertion of its own, and the code under test runs only through its adapters (`through`, `subjectModule`, `subjectPage` below), so that what it throws is a marked failure that names the call. Anything else a check meets is the harness's and stops the run when a fault is judged: the store (`harnessStore`) and the callbacks of the harness (`harnessOwn`) included.

// The component options of the page, each computed value, method, watcher, async read, the data and the hooks behind `through`. The persisted view (`harnessMixin`) and the store (`harnessStore`) are the harness's: what they throw is never the page's.
const HOOKS = ['beforeCreate', 'created', 'beforeMount', 'mounted', 'beforeUpdate', 'updated', 'beforeDestroy', 'destroyed', 'activated', 'deactivated']

const subjectPage = (options) => {
  const wrap = (label, member) => (typeof member === 'function' ? function (...args) { return through(label, () => member.apply(this, args), { read: false }) } : member)
  const wrapAccessors = (label, member) => (typeof member === 'function' ? wrap(label, member) : member && typeof member === 'object' ? { ...member, ...(member.get ? { get: wrap(label, member.get) } : {}), ...(member.set ? { set: wrap(label, member.set) } : {}) } : member)
  const wrapWatcher = (label, member) => (Array.isArray(member) ? member.map((item) => wrapWatcher(label, item)) : member && typeof member === 'object' ? { ...member, handler: wrap(label, member.handler) } : wrap(label, member))
  const each = (members, how, kind) => (members ? Object.fromEntries(Object.entries(members).map(([name, member]) => [name, how(`the ${kind} ${name}`, member)])) : members)
  const asyncReads = options.asyncComputed ? Object.fromEntries(Object.entries(options.asyncComputed).map(([name, member]) => [name, typeof member === 'function' ? wrap(`the read ${name}`, member) : { ...member, ...(member.get ? { get: wrap(`the read ${name}`, member.get) } : {}), ...(typeof member.default === 'function' ? { default: wrap(`the default of ${name}`, member.default) } : {}) }])) : options.asyncComputed
  const hooks = Object.fromEntries(HOOKS.filter((name) => options[name]).map((name) => [name, Array.isArray(options[name]) ? options[name].map((hook) => wrap(`the hook ${name}`, hook)) : wrap(`the hook ${name}`, options[name])]))

  return { ...options, ...hooks, data: wrap('the data of the page', options.data), computed: each(options.computed, wrapAccessors, 'computed value'), methods: each(options.methods, wrap, 'method'), watch: each(options.watch, wrapWatcher, 'watcher on'), asyncComputed: asyncReads }
}

// A stand-in for what the code under test failed to give: every read of it fails the check that makes it with the failure of the call (a failure that is not marked is the harness's, and stops the run).
const standIns = new WeakSet()

const unavailable = (error) => {
  if (!isMarked(error)) {
    throw error
  }

  const stood = new Proxy({}, { get: () => { throw error } })

  standIns.add(stood)

  return stood
}

const modelOf = (outcome) => (outcome.error === undefined ? outcome.value : unavailable(outcome.error))

// The model as the page and the exports are given it: the model with `supported: true`, or the stand-in as it is.
const supporting = (model) => (standIns.has(model) ? model : { supported: true, ...model })

// The entries of a model as the checks look them up: an entry that is not there fails the check, by an assertion, where `get` would give undefined. What the code under test is given stays the model it built.
class StrictEntries extends Map {
  get(key) {
    if (!this.has(key)) {
      throw failure(`the model has no entry ${key}`)
    }

    return super.get(key)
  }
}

const strictEntries = (model) => (standIns.has(model) ? model : { ...model, byKey: new StrictEntries(model.byKey) })

// A value the code under test was to give, or the failure of the check that reads it.
const needed = (value, what) => {
  if (value === null || value === undefined) {
    throw failure(`there is no ${what}`)
  }

  return value
}

// ---------- reading what the exports hold ----------

// A CSV as rows of cells (RFC 4180: quoted cells hold commas, doubled quotes and line breaks).
const parseCsv = (text) => {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < text.length; index++) {
    const character = text[index]

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"'
        index++
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(cell)
      cell = ''
    } else if (character === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }

  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }

  return rows
}

// The columns the exports have. A row that lacks a cell for one of them fails the check that reads it, by an assertion: the code under test left the cell out.
const CSV_COLUMNS = ['Tree', 'Game ID', 'Race ID', 'Kind', 'ID', 'Name', 'Shipping line', 'Depth', 'Path', 'Path IDs', 'Parent kind', 'Parent ID', 'Parent state', 'Post', 'Holder ID', 'Holder', 'Vacancy', 'Anchor', 'Note']

const strictRow = (row) => new Proxy(row, {
  get: (target, name) => {
    if (typeof name === 'string' && CSV_COLUMNS.includes(name) && target[name] === undefined) {
      throw failure(`the row has no cell for ${name}`)
    }

    return target[name]
  },
})

const tableOf = (text) => {
  const [header, ...rest] = parseCsv(text)

  return { header, rows: rest.map((cells) => strictRow(Object.fromEntries(header.map((name, index) => [name, cells[index]])))), widths: rest.map((cells) => cells.length) }
}

// A Markdown line's text as a reader sees it, read from the left as a reader does: a backslash escape is its character (an escaped backtick opens no code span) and a code span is its text; null when markup is left in it (an unescaped emphasis, link, table, heading or entity character).
const MARKUP = /[*_[\]<>|#&`]/
const ESCAPE_OR_SPAN = /\\([\s\S])|`([^`]*)`/g

const readMarkdown = (line) => {
  const body = line.replace(/^\s*- /, '')

  if (MARKUP.test(body.replace(ESCAPE_OR_SPAN, ''))) {
    return null
  }

  return body.replace(ESCAPE_OR_SPAN, (_match, escaped, span) => (escaped === undefined ? span : escaped))
}

// The bullets of the list of entries of an export: the first list of the document outside a fenced block (the diagram), up to the next heading (the loops).
const outlineBullets = (markdown) => {
  const bullets = []
  let fenced = false

  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) {
      fenced = !fenced
    } else if (!fenced && /^#{1,6} /.test(line) && bullets.length) {
      break
    } else if (!fenced && /^\s*- /.test(line)) {
      bullets.push(line)
    }
  }

  return bullets
}

// The parent of each bullet of a list as a reader nests it: the index of the bullet it hangs from, -1 for a bullet at the top of the list, or null when the reader would not read a line as an item of the list. `rule` is 'commonmark', as GitHub and Obsidian read a list (an item is under the open item whose text starts at or before its marker, and a marker four or more columns past that is code), or 'four', as the readers that need four spaces a level read it (the original Markdown, Python-Markdown): an item is under the item four spaces to its left.
const nestingOf = (bullets, rule) => {
  const open = []
  const parents = []

  for (const [index, line] of bullets.entries()) {
    const indent = line.match(/^( *)- /)[1].length

    if (rule === 'commonmark') {
      while (open.length && indent < open[open.length - 1].text) {
        open.pop()
      }

      if (open.length ? indent >= open[open.length - 1].text + 4 : indent > 3) {
        return null
      }

      parents.push(open.length ? open[open.length - 1].index : -1)
      open.push({ index, text: indent + 2 })
    } else {
      while (open.length && indent <= open[open.length - 1].indent) {
        open.pop()
      }

      if (indent !== (open.length ? open[open.length - 1].indent + 4 : 0)) {
        return null
      }

      parents.push(open.length ? open[open.length - 1].index : -1)
      open.push({ index, indent })
    }
  }

  return parents
}

// The bullet each entry of `order` (keys in tree order) hangs from in the model, by its place in `order`: -1 for a top-level entry. `childrenOf` gives an entry's children by key.
const parentsIn = (order, childrenOf) => {
  const parentOf = new Map(order.flatMap((key) => childrenOf(key).map((child) => [child, key])))

  return order.map((key) => (parentOf.has(key) ? order.indexOf(parentOf.get(key)) : -1))
}

// Whether a list nests as the model does under both readers, or what each reader made of it.
const nestsAs = (bullets, expected) => {
  const read = { commonmark: nestingOf(bullets, 'commonmark'), four: nestingOf(bullets, 'four') }

  return (same(read.commonmark, expected) && same(read.four, expected)) || `expected ${JSON.stringify(expected)}, a CommonMark reader read ${JSON.stringify(read.commonmark)} and a four-space reader ${JSON.stringify(read.four)}`
}

// The Mermaid flowchart of a document: { nodes: [{ id, lines }] in the order written, arrows: [[from, to]] } with each label as Mermaid shows it (an entity code is its character, `<br>` breaks the line); null when the document has no diagram, and { invalid } when a line of it is neither a node with a quoted label, nor an arrow, or a label holds a character Mermaid would read as markup.
const flowchartOf = (markdown) => {
  const lines = markdown.split('\n')
  const start = lines.indexOf('```mermaid')

  if (start === -1) {
    return null
  }

  const end = lines.indexOf('```', start + 1)
  const body = end === -1 ? [] : lines.slice(start + 1, end)

  if (!/^flowchart (LR|RL|TB|TD|BT)$/.test(body[0] || '')) {
    return { invalid: body[0] || 'no flowchart' }
  }

  const nodes = []
  const arrows = []

  for (const line of body.slice(1)) {
    const node = /^\s*(\w+)\["([^"]*)"\]$/.exec(line)
    const arrow = /^\s*(\w+) --> (\w+)$/.exec(line)

    if (node && !/[<>&`%]|#(?!\d+;)/.test(node[2].replace(/<br>/g, ''))) {
      nodes.push({ id: node[1], lines: node[2].split('<br>').map((part) => part.replace(/#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))) })
    } else if (arrow) {
      arrows.push([arrow[1], arrow[2]])
    } else {
      return { invalid: line }
    }
  }

  return { nodes, arrows }
}

// The title and the summary of a document: what comes before its first section.
const headOf = (markdown) => markdown.split('\n## ')[0]
// The title of a document as a reader shows it, or null when markup is left in it.
const titleOf = (markdown) => readMarkdown(markdown.split('\n')[0].replace(/^# /, ''))

// ---------- the constructed rows ----------

const GAME = 1
const RACE = 7
const IDS = { GameID: GAME, RaceID: RACE }
// The empire's name the exports are titled with, and the empire list of the store, which holds a race of another game under the same id and another race of the game before the selected one.
const EMPIRE = 'Test Empire'
const GAMES = [{ GameID: 2, Races: [{ RaceID: RACE, RaceTitle: 'Empire Of Another Game' }] }, { GameID: GAME, Races: [{ RaceID: 99, RaceTitle: 'Another Empire' }, { RaceID: RACE, RaceTitle: EMPIRE }] }]

const cmd = (id, name, parent, over = {}) => ({ NavalAdminCommandID: id, AdminCommandName: name, ParentAdminCommandID: parent, GameID: GAME, RaceID: RACE, ...over })
const flt = (id, name, parent, flag = 0, over = {}) => ({ FleetID: id, FleetName: name, ParentCommandID: parent, ShippingLine: flag, GameID: GAME, RaceID: RACE, ...over })
const shp = (id, name, fleet, flag = 0, over = {}) => ({ ShipID: id, ShipName: name, FleetID: fleet, ShippingLineID: flag, GameID: GAME, RaceID: RACE, ...over })
const holder = (CommanderID, Name, CommandType, CommandID, Serving = 1) => ({ CommanderID, Name, CommandType, CommandID, Serving })

// Race 7 of game 1: commands 1 to 11 (1 is the top; 2 and 3 hang from it, 4 from 2; 5 has a parent that is not in the save, 6 one of another race, 7 and 8 are each the other's parent, 9 its own, 10 stores none and has characters in its name that Markdown and Mermaid read as markup, 11 has no name), fleets 20 to 28 (22 is a shipping line's), ships 40 to 49 (43 sails in that fleet, 44 is a shipping line's own), and the rows that are not the race's: a command of another race, one of another game, a repeated command row, a fleet and a ship of another race.
const navalRows = () => ({
  commands: [
    cmd(1, 'Root Admin', 0),
    cmd(2, 'Second, Fleet', 1),
    cmd(3, '=HYPERLINK("x")', 1),
    cmd(4, '"Quoted" Admin', 2),
    cmd(5, 'Orphan Admin', 99),
    cmd(6, 'Foreign Child', 300),
    cmd(7, 'Loop Seven %%{init:', 8),
    cmd(8, 'Loop Eight %%{init: {"theme":"dark"}}%%', 7),
    cmd(9, 'Self\nParent', 9),
    cmd(10, 'No Parent <Stored> #10 & `x`', null),
    cmd(11, null, 1),
    cmd(300, 'Other Race Admin', 1, { RaceID: 8 }),
    cmd(301, 'Other Game Admin', 1, { GameID: 2 }),
    cmd(4, 'Duplicate Of Four', 1),
  ],
  outsideCommands: [{ NavalAdminCommandID: 300, GameID: GAME, RaceID: 8 }],
  fleets: [
    flt(20, 'Alpha Fleet', 1),
    flt(21, 'Line\nBreak', 2),
    flt(22, 'Merchant Line', 3, 5),
    flt(23, 'Orphan Fleet', 99),
    flt(24, 'Looped Fleet', 7),
    flt(25, 'Flag Unknown', 4, null),
    flt(26, 'Fleet No Parent', 0),
    flt(27, 'Foreign Fleet', 300),
    flt(28, 'Fleet Unstored', null),
    flt(400, 'Other Race Fleet', 1, 0, { RaceID: 8 }),
  ],
  outsideFleets: [{ FleetID: 800, GameID: GAME, RaceID: 8 }],
  ships: [
    shp(40, 'Ship Forty', 20),
    shp(41, 'Ship *Forty_One* <b> [x](y) | #1', 20),
    shp(42, '-Charlie', 21),
    shp(43, 'Merchant One', 22),
    shp(44, 'Chartered', 20, 3),
    shp(45, 'Orphan Ship', 555),
    shp(46, 'Foreign Ship', 800),
    shp(47, 'Flag Unknown Ship', 25, null),
    shp(48, 'Ship Unstored', null),
    shp(49, 'Ship No Fleet', 0),
    shp(500, 'Other Race Ship', 20, 0, { RaceID: 8 }),
  ],
  commanders: [
    holder(1001, '=cmd()', 12, 1),
    holder(1002, '+Shared A', 12, 3),
    holder(1003, 'Shared B %%{init: {"theme":"dark"}}%% %%{init:', 12, 3),
    holder(1004, 'Unsettled Admin', 12, 4, null),
    holder(2001, 'Captain One', 1, 40),
    holder(2002, 'Captain Two', 1, 42),
    holder(2003, 'Captain Three', 1, 42),
    holder(2004, 'Captain Unsettled', 1, 47, null),
    holder(2005, 'Captain Five', 1, 47),
    holder(2006, 'Captain Merchant', 1, 43),
    holder(2007, 'Captain Stray', 1, 999),
    holder(2008, 'Admin Stray', 12, 40),
    holder(2009, 'Captain Of Ship One', 1, 1),
    holder(2010, 'Ground Commander', 5, 1),
  ],
})

const NAVAL_ORDER = ['command:1', 'command:2', 'command:4', 'fleet:25', 'ship:47', 'fleet:21', 'ship:42', 'command:3', 'command:11', 'fleet:20', 'ship:40', 'ship:41', 'fleet:26', 'ship:49', 'command:5', 'fleet:23', 'ship:45', 'command:6', 'command:7', 'command:8', 'fleet:24', 'command:9', 'command:10', 'fleet:27', 'fleet:28', 'ship:46', 'ship:48']
const NAVAL_ROOTS = ['command:1', 'fleet:26', 'ship:49', 'command:5', 'fleet:23', 'ship:45', 'command:6', 'command:7', 'command:9', 'command:10', 'fleet:27', 'fleet:28', 'ship:46', 'ship:48']
const NAVAL_STATES = { 'command:1': 'none', 'command:2': 'resolved', 'command:3': 'resolved', 'command:4': 'resolved', 'command:5': 'orphan', 'command:6': 'foreign', 'command:7': 'cycle', 'command:8': 'resolved', 'command:9': 'cycle', 'command:10': 'unknown', 'command:11': 'resolved', 'fleet:20': 'resolved', 'fleet:21': 'resolved', 'fleet:23': 'orphan', 'fleet:24': 'resolved', 'fleet:25': 'resolved', 'fleet:26': 'none', 'fleet:27': 'foreign', 'fleet:28': 'unknown', 'ship:40': 'resolved', 'ship:41': 'resolved', 'ship:42': 'resolved', 'ship:45': 'orphan', 'ship:46': 'foreign', 'ship:47': 'resolved', 'ship:48': 'unknown', 'ship:49': 'none' }

// The same race with the shipping lines listed: the fleet 22 and the ships 43 and 44 enter the tree, 22 under command 3, 43 in it and 44 in fleet 20.
const SHIPPING_ORDER = ['command:1', 'command:2', 'command:4', 'fleet:25', 'ship:47', 'fleet:21', 'ship:42', 'command:3', 'fleet:22', 'ship:43', 'command:11', 'fleet:20', 'ship:40', 'ship:41', 'ship:44', 'fleet:26', 'ship:49', 'command:5', 'fleet:23', 'ship:45', 'command:6', 'command:7', 'command:8', 'fleet:24', 'command:9', 'command:10', 'fleet:27', 'fleet:28', 'ship:46', 'ship:48']

const formation = (FormationID, over = {}) => ({ FormationID, Name: `Formation ${FormationID}`, Abbreviation: `F${FormationID}`, RaceID: RACE, GameID: GAME, OriginalTemplateID: 0, ReplacementTemplateID: 0, PopulationID: 0, ShipID: 0, ParentFormationID: 0, ...over })

// Formations 1 (the top), 2 and 3 (under 1), 4 (a parent that is not in the save), 6 and 7 (each the other's parent), with the commanders of ground formations: 1 held, 2 shared, 4 unsettled, 888 a formation that does not exist, and an admin commander on formation 1.
const groundRows = () => ({
  formations: [formation(1), formation(2, { ParentFormationID: 1 }), formation(3, { ParentFormationID: 1 }), formation(4, { ParentFormationID: 99 }), formation(6, { ParentFormationID: 7 }), formation(7, { ParentFormationID: 6 })],
  commanders: [holder(5010, 'Ground One', 5, 1), holder(5020, 'Ground Two A', 5, 2), holder(5021, 'Ground Two B', 5, 2), holder(5040, 'Ground Unsettled', 5, 4, null), holder(5100, 'Admin On One', 12, 1), holder(5999, 'Ground Stray', 5, 888)],
})
// The formations of `groundRows` in tree order, each with its depth, worked out by hand.
const GROUND_TREE = [{ id: 1, depth: 0 }, { id: 2, depth: 1 }, { id: 3, depth: 1 }, { id: 4, depth: 0 }, { id: 6, depth: 0 }, { id: 7, depth: 1 }]

const GAME_TIME = 100 * 31536000

// A commander of the roster as the query gives one: `age` is stored as the graduation age with the career beginning now.
const person = (CommanderID, name, over = {}) => ({ CommanderID, Name: name, CommanderType: 0, CommandType: 0, CommandID: 0, ResSpecID: 0, FieldName: null, HealthRisk: 1, StoryCharacter: 0, RankName: null, RankAbbrev: null, RankLevel: null, GraduationAge: 20, CareerStart: GAME_TIME, GameTime: GAME_TIME, AssignmentName: null, Bonuses: null, Traits: null, ...over })
const officer = (CommanderID, name, { post, rank, age }, over = {}) => person(CommanderID, name, { CommandType: post, RankLevel: rank, RankName: rank === null ? null : `Grade ${rank}`, GraduationAge: age, ...over })

// Officers A to I and N: post (CommandType), rank (RankLevel) and age as the comments say; a null is not stored.
const people = () => [
  officer(1, 'Officer A', { post: 0, rank: 1, age: 25 }),
  officer(2, 'Officer B', { post: 1, rank: 2, age: 30 }),
  officer(3, 'Officer C', { post: 1, rank: 3, age: 30 }),
  officer(4, 'Officer D', { post: 8, rank: 3, age: 45 }),
  officer(5, 'Officer E', { post: null, rank: 2, age: 40 }),
  officer(6, 'Officer F', { post: 0, rank: null, age: 35 }),
  officer(7, 'Officer G', { post: 1, rank: 2, age: null }),
  officer(8, 'Officer H', { post: 0, rank: 1, age: 20 }, { CareerStart: null }),
  officer(9, 'Officer I', { post: 12, rank: 4, age: 60 }),
  officer(14, 'Officer N', { post: 1, rank: 2, age: null }),
]

const administrators = () => [person(20, 'Admin X', { CommanderType: 2, CommandType: 3, GraduationAge: 50 }), person(21, 'Admin Y', { CommanderType: 2, CommandType: 3, GraduationAge: 40 })]

const letter = (name) => name.replace('Officer ', '')
const idsOf = (list) => list.map((item) => item.CommanderID)

// ---------- the pure checks ----------

// The checks of one group on the modules of a variant: [{ id, name, ok, kind, threw, detail }], pushed to `results` as they are made, so a suite that stops keeps what it had. A check is `fn`, which returns true when it holds, and a string or false that says what was seen when it does not: its own assertion (`kind` is 'assertion'). What `fn` throws is an assertion only when it carries the mark (the failure of a call of the code under test, `threw` then true); a HarnessError stops the run, and any other exception (`kind` is 'error') fails the check of the unmodified code and stops the run while a fault is judged.
const collector = (results) => {
  const add = async (id, name, fn) => {
    const outcome = await settle(fn)

    if (outcome.error instanceof HarnessError) {
      throw outcome.error
    }

    const ok = outcome.error === undefined && outcome.value === true

    results.push({ id, name, ok, kind: ok ? null : outcome.error === undefined ? 'assertion' : kindOf(outcome.error), threw: outcome.error !== undefined && isSubjectThrow(outcome.error), detail: outcome.error ? outcome.error.message : typeof outcome.value === 'string' ? outcome.value : '' })
  }

  return { results, add }
}

const pureSuite = async (mods, into) => {
  const { results, add } = collector(into)
  const { csvCell, csvLine } = mods['csv-cell']
  const { buildNavalHierarchy } = mods['naval-hierarchy']
  const { buildGroundFormations } = mods['ground-formations']
  const { hierarchyRows, hierarchyCsv, hierarchyMarkdown, hierarchyExport, hierarchyBranches, hierarchyNotice, HIERARCHY_COLUMNS, DIAGRAM_LIMIT } = mods['hierarchy-export']
  const { ageBound, rosterChoices, rosterFilter } = mods.commanders

  const built = await settle(() => buildNavalHierarchy(frozen(navalRows()), IDS))
  const raw = modelOf(built)
  const unreadBuilt = await settle(() => buildNavalHierarchy((({ commanders: _commanders, ...rest }) => frozen(rest))(navalRows()), IDS))
  const unread = modelOf(unreadBuilt)
  const groundBuilt = await settle(() => buildGroundFormations(frozen(groundRows()), IDS))
  const ground = modelOf(groundBuilt)
  const groundUnread = modelOf(await settle(() => buildGroundFormations((({ commanders: _commanders, ...rest }) => frozen(rest))(groundRows()), IDS)))
  const naval = supporting(raw)
  const groundModel = supporting(ground)
  const model = strictEntries(raw)
  const node = (key) => model.byKey.get(key)
  const anchorOf = (key) => needed(node(key).anchor, `the anchor of ${key}`)
  const post = (key) => node(key).post
  const problemKinds = (key) => node(key).problems.map((problem) => problem.kind)
  const ofState = (state, source = model) => source.nodes.filter((item) => item.post.state === state).map((item) => item.key)

  await add('naval-frozen', 'the naval builder reads deep-frozen rows without writing to them', () => built.error === undefined && unreadBuilt.error === undefined)
  await add('naval-counts', 'the model holds the 11 commands, 8 fleets and 8 ships of the race and counts the rows left out', () => same([model.summary.commands, model.summary.fleets, model.summary.ships], [11, 8, 8]) && same(model.summary.excluded, { commands: 2, fleets: 1, ships: 1 }) && same(model.summary.duplicateRows, { commands: 1, fleets: 0, ships: 0 }) && model.nodes.length === 27 && node('command:4').name === '"Quoted" Admin' && !model.byKey.has('command:300') && !model.byKey.has('command:301') && !model.byKey.has('fleet:400') && !model.byKey.has('ship:500'))
  await add('naval-civilian', 'a shipping line\'s fleet and ship, and a ship in such a fleet, are left out and counted, not listed', () => ['fleet:22', 'ship:43', 'ship:44'].every((key) => !model.byKey.has(key)) && same(model.summary.civilian, { fleets: 1, ships: 2 }))
  await add('naval-civilian-flag-unknown', 'an entry whose shipping-line flag is not stored stays in the tree and says so', () => model.byKey.has('fleet:25') && model.byKey.has('ship:47') && problemKinds('fleet:25').includes('shipping-line-unknown') && problemKinds('ship:47').includes('shipping-line-unknown') && model.summary.unknownShippingLines === 2 && !problemKinds('fleet:20').includes('shipping-line-unknown'))
  await add('naval-parent-states', 'each parent link is none, resolved, orphan, foreign, unknown or the cut of a loop as the rows say', () => same(Object.fromEntries(model.nodes.map((item) => [item.key, item.parent.state]).sort(([a], [b]) => (a < b ? -1 : 1))), Object.fromEntries(Object.entries(NAVAL_STATES).sort(([a], [b]) => (a < b ? -1 : 1)))))
  await add('naval-roots', 'the top-level entries are those with no parent, then the orphans, then the rest, each by kind and id', () => same(model.roots, NAVAL_ROOTS) && model.summary.roots === 3 && model.summary.topLevel === 14)
  await add('naval-order', 'the entries follow their parents, the children by kind and id', () => same(model.nodes.map((item) => item.key), NAVAL_ORDER))
  await add('naval-partition', 'walking the top-level entries and their children reaches every entry exactly once', () => {
    const seen = []
    const queue = [...model.roots]

    while (queue.length && seen.length <= model.nodes.length + 2) {
      const key = queue.shift()

      seen.push(key)
      queue.push(...node(key).children)
    }

    return same([...seen].sort(), [...NAVAL_ORDER].sort())
  })
  await add('naval-orphans', 'an orphan, a foreign parent and a parent that is not stored each say which, and anchor what hangs from them', () => same([model.summary.orphans, model.summary.foreignParents, model.summary.unknownParents], [3, 3, 3]) && problemKinds('command:5').includes('orphan-parent') && problemKinds('command:6').includes('foreign-parent') && problemKinds('command:10').includes('parent-unknown') && !problemKinds('command:6').includes('orphan-parent') && anchorOf('command:5').kind === 'orphan' && anchorOf('command:8').key === 'command:7' && anchorOf('fleet:24').key === 'command:7' && anchorOf('ship:42').key === 'command:1' && node('ship:42').depth === 3 && model.summary.unresolved === 13)
  await add('naval-cycles', 'a loop ends at its lowest id, is listed with its members, and every member says so', () => same(model.cycles.map(({ id, members, cutAt }) => ({ id, members, cutAt })), [{ id: 'cycle:7', members: [7, 8], cutAt: 7 }, { id: 'cycle:9', members: [9], cutAt: 9 }]) && problemKinds('command:7').includes('parent-cycle') && problemKinds('command:8').includes('parent-cycle') && problemKinds('command:9').includes('parent-cycle') && model.summary.cycles === 2 && model.summary.cycleMembers === 3)
  await add('naval-posts', 'a command\'s post is held, shared, vacant or unknown by its serving admin commanders, and a ship\'s by its captains', () => same(ofState('held'), ['command:1', 'ship:47', 'ship:40']) && same(ofState('shared'), ['ship:42', 'command:3']) && same(ofState('unknown'), ['command:4']) && ofState('vacant').length === 13 && same(model.summary.posts, { held: 3, vacant: 13, shared: 2, unknown: 1, unread: 0 }))
  await add('naval-holders', 'the holders of a post are its serving commanders by id, and a commander whose status is not stored is not listed as the holder', () => same(post('command:1').holders.map((item) => item.id), [1001]) && same(post('command:3').holders.map((item) => item.id), [1002, 1003]) && same(post('ship:42').holders.map((item) => item.id), [2002, 2003]) && same(post('ship:47').holders.map((item) => item.id), [2005]) && same(post('ship:47').unsettled.map((item) => item.id), [2004]) && post('command:4').holders.length === 0 && same(post('command:4').unsettled.map((item) => item.id), [1004]) && problemKinds('command:3').includes('post-shared') && problemKinds('ship:47').includes('post-unsettled') && problemKinds('command:4').includes('post-unsettled'))
  await add('naval-post-type', 'a commander holds a post only of the type that matches: an admin commander on a ship id, a captain on a command id and a ground commander on either hold nothing', () => post('ship:40').holders.length === 1 && post('ship:40').holders[0].id === 2001 && same(post('command:1').holders.map((item) => item.id), [1001]) && model.summary.posts.held === 3)
  await add('naval-fleet-not-post', 'a fleet is not a post', () => model.nodes.filter((item) => item.kind === 'fleet').every((item) => item.post.state === 'none' && item.post.holders.length === 0))
  await add('naval-strays', 'serving commanders whose post is not an entry of the race are counted, not listed or lost', () => same(model.summary.strayHolders, { command: 1, ship: 2 }))
  await add('naval-unread', 'without the commanders every post is unread, never vacant, and the model says the holders were not read', () => unread.holders.read === false && model.holders.read === true && unread.nodes.filter((item) => item.kind !== 'fleet').every((item) => item.post.state === 'unread') && unread.nodes.filter((item) => item.kind === 'fleet').every((item) => item.post.state === 'none') && unread.summary.posts.vacant === 0 && unread.summary.posts.unread === 19)

  await add('ground-posts', 'a formation\'s post is held, shared, vacant or unknown by the serving ground commanders, whatever other posts the ids match', () => ['held', 'shared', 'vacant', 'vacant', 'unknown', 'vacant'].join() === [1, 2, 3, 6, 4, 7].map((id) => ground.byId.get(id).post.state).join() && same(ground.byId.get(1).post.holders.map((item) => item.id), [5010]) && same(ground.byId.get(2).post.holders.map((item) => item.id), [5020, 5021]) && same(ground.byId.get(4).post.unsettled.map((item) => item.id), [5040]) && same(ground.summary.posts, { held: 1, vacant: 3, shared: 1, unknown: 1, unread: 0 }) && ground.summary.strayHolders === 1)
  await add('ground-unread', 'without the commanders every formation\'s post is unread', () => groundUnread.holders.read === false && ground.holders.read === true && groundUnread.formations.every((item) => item.post.state === 'unread') && groundUnread.summary.posts.vacant === 0)

  // The CSV of the naval tree.
  const csv = hierarchyCsv(naval, 'naval')
  const table = tableOf(csv)
  // The rows of the file set against the entries of the hand-worked tree by the identity of each (its kind and its id, read whole): a row of an identity the tree lacks, a row doubled and an entry with no row are problems, never a row read in place of another.
  const paired = pairedBy('the CSV of the naval tree', table.rows, NAVAL_ORDER, pairingIdentity(keyOfRow), (key) => key)
  const byKey = Object.fromEntries(paired.pairs)
  const rowOf = (key) => needed(byKey[key], `row ${key}`)
  const unreadTable = tableOf(hierarchyCsv({ supported: true, ...unread }, 'naval'))

  await add('csv-columns', 'the file has the columns that say what an entry is, where it hangs and who holds its post, and every row is as wide as the header', () => ['Tree', 'Game ID', 'Race ID', 'Kind', 'ID', 'Name', 'Depth', 'Path', 'Parent state', 'Post', 'Holder ID', 'Holder', 'Vacancy', 'Note'].every((name) => table.header.includes(name)) && same(table.header, HIERARCHY_COLUMNS) && table.widths.every((width) => width === table.header.length) && csv.endsWith('\n') && !csv.endsWith('\n\n'))
  await add('csv-rows', 'there is one row for each entry of the model, in tree order, whose name is the entry\'s name or an empty cell', () => (paired.problems.length === 0 && same(table.rows.map(keyOfRow), NAVAL_ORDER) && paired.pairs.every(([key, row]) => { const name = model.byKey.get(key).name ?? ''; return row.Name.includes(name) && row.Name.length <= name.length + 1 }) && rowOf('command:11').Name === '' && same(hierarchyRows(naval, 'naval').map(keyOfRow), NAVAL_ORDER)) || `problems ${JSON.stringify(paired.problems).slice(0, 300)}`)
  await add('csv-scope', 'every row names the game, the race and the tree it belongs to', () => table.rows.every((row) => row['Game ID'] === '1' && row['Race ID'] === '7' && row.Tree === 'naval'))
  await add('csv-roundtrip', 'a name with a comma, a quote or a line break comes back whole from the file', () => rowOf('command:2').Name === 'Second, Fleet' && rowOf('command:4').Name === '"Quoted" Admin' && rowOf('fleet:21').Name === 'Line\nBreak')
  await add('csv-formula', 'a text that a spreadsheet would run as a formula (a name or a holder\'s name starting with = + - or @) is written so that it does not, and loses nothing', () => {
    const cells = [[rowOf('command:3').Name, '=HYPERLINK("x")'], [rowOf('ship:42').Name, '-Charlie'], [rowOf('command:1').Holder, '=cmd()'], [rowOf('command:3').Holder.split('; ')[0], '+Shared A']]

    return cells.every(([cell, original]) => !/^[=+\-@\t\r]/.test(cell) && cell.includes(original)) && table.rows.every((row) => ['Name', 'Path', 'Holder'].every((column) => !/^[=+\-@\t\r]/.test(row[column])))
  })
  await add('csv-numbers', 'the figures are written as numbers: the ids, the depth and the parent id', () => table.rows.every((row) => wholeOf(row.ID) !== null && wholeOf(row.Depth) !== null && (row['Parent ID'] === '' || wholeOf(row['Parent ID']) !== null)) && wholeOf(rowOf('ship:42').Depth) === 3 && wholeOf(rowOf('ship:42')['Parent ID']) === 21 && rowOf('ship:42')['Parent kind'] === 'fleet')
  await add('csv-paths', 'a row\'s path lists the entries from the top to itself: one step for an unresolved entry, the parent just before an entry that is resolved', () => table.rows.every((row) => {
    const steps = row['Path IDs'].split('/')
    const state = row['Parent state']

    return steps.length === wholeOf(row.Depth) + 1 && steps[steps.length - 1] === `${row.Kind}:${row.ID}` && (state === 'resolved' ? steps.length > 1 && steps[steps.length - 2] === `${row['Parent kind']}:${row['Parent ID']}` : steps.length === 1) && row.Path.split(' / ').length >= steps.length
  }) && rowOf('ship:42')['Path IDs'] === 'command:1/command:2/fleet:21/ship:42' && rowOf('ship:42').Path.endsWith('-Charlie'))
  await add('csv-unresolved', 'an entry whose parent is missing, of another race, not stored or in a loop is a top-level row with the matching note', () => [['command:5', 'orphan', 'orphan-parent'], ['command:6', 'foreign', 'foreign-parent'], ['command:10', 'unknown', 'parent-unknown'], ['command:7', 'cycle', 'parent-cycle'], ['fleet:23', 'orphan', 'orphan-parent'], ['ship:46', 'foreign', 'foreign-parent']].every(([key, state, note]) => rowOf(key)['Parent state'] === state && rowOf(key).Depth === '0' && rowOf(key).Note.split('; ').includes(note) && rowOf(key).Anchor === state) && rowOf('command:1').Anchor === 'root' && rowOf('command:2').Anchor === 'root' && rowOf('command:8')['Parent state'] === 'resolved' && rowOf('command:8').Note.split('; ').includes('parent-cycle'))
  await add('csv-notes', 'the notes list the problems the model reports for the entry, the posts\' as well', () => rowOf('command:3').Note.split('; ').includes('post-shared') && rowOf('ship:47').Note.split('; ').includes('post-unsettled') && rowOf('command:4').Note.split('; ').includes('post-unsettled') && rowOf('fleet:25').Note.split('; ').includes('shipping-line-unknown') && rowOf('command:2').Note === '' && table.rows.every((row) => row.Note.split('; ').filter(Boolean).every((note) => model.byKey.get(`${row.Kind}:${row.ID}`).problems.some((problem) => problem.kind === note))))
  await add('csv-vacancy', 'a post\'s vacancy tells held, several holders, not settled and vacant apart, a fleet is not a post, and without the commanders a post is not read, never vacant', () => {
    const wording = (source, keys) => keys.map((key) => needed(source[key], `row ${key}`).Vacancy)
    const held = wording(byKey, ['command:1', 'ship:40'])
    const shared = wording(byKey, ['command:3', 'ship:42'])
    const unknown = wording(byKey, ['command:4'])
    const vacant = wording(byKey, ['command:2', 'ship:41', 'command:5'])
    const none = wording(byKey, ['fleet:20', 'fleet:26'])
    const unreadCells = unreadTable.rows.filter((row) => row.Kind !== 'fleet').map((row) => row.Vacancy)
    const groups = [held, shared, unknown, vacant, none, [unreadCells[0]]]

    return groups.every((group) => new Set(group).size === 1 && group[0] !== '') && new Set(groups.map((group) => group[0])).size === groups.length && unreadCells.every((cell) => cell === unreadCells[0]) && none.every((cell) => rowOf('fleet:20').Post === '' && cell === none[0])
  })
  await add('csv-holders', 'the holder columns give the serving commanders of a post, ids and names in step, and nothing for a post nobody serves', () => rowOf('command:1')['Holder ID'] === '1001' && same(idsIn(rowOf('command:3')['Holder ID']), [1002, 1003]) && rowOf('command:3').Holder.includes('Shared B') && rowOf('command:3').Holder.includes('Shared A') && same(idsIn(rowOf('ship:42')['Holder ID']), [2002, 2003]) && rowOf('ship:42').Holder.includes('Captain Two') && rowOf('ship:42').Holder.includes('Captain Three') && rowOf('ship:47')['Holder ID'] === '2005' && rowOf('command:4')['Holder ID'] === '' && rowOf('command:4').Holder === '' && rowOf('command:2')['Holder ID'] === '' && rowOf('fleet:20')['Holder ID'] === '' && rowOf('command:1').Post !== '' && rowOf('ship:40').Post !== rowOf('command:1').Post)

  // The CSV of the ground formations, its rows set against the hand-worked formations by id.
  const groundTable = tableOf(hierarchyCsv(groundModel, 'ground'))
  const groundPaired = pairedBy('the CSV of the ground formations', groundTable.rows, GROUND_TREE, pairingIdentity((row) => wholeOf(row.ID)), (entry) => entry.id)
  const groundByIdentity = new Map(groundPaired.pairs.map(([entry, row]) => [entry.id, row]))
  const groundRow = (id) => needed(groundByIdentity.get(id), `ground row ${id}`)

  await add('ground-csv', 'the ground formations are exported the same way: one row each in tree order, with their paths and the commanders of their posts', () => (groundPaired.problems.length === 0 && same(groundTable.rows.map((row) => wholeOf(row.ID)), GROUND_TREE.map((entry) => entry.id)) && groundPaired.pairs.every(([entry, row]) => wholeOf(row.Depth) === entry.depth) && groundTable.rows.every((row) => row.Tree === 'ground' && row.Kind === 'formation' && row.Post !== '') && groundRow(7)['Path IDs'].split('/').length === 2 && groundRow(1)['Holder ID'] === '5010' && same(idsIn(groundRow(2)['Holder ID']), [5020, 5021]) && groundRow(3)['Holder ID'] === '' && groundRow(4)['Holder ID'] === '' && new Set([1, 2, 3, 4].map((id) => groundRow(id).Vacancy)).size === 4 && groundRow(4)['Parent state'] === 'orphan' && groundRow(6)['Parent state'] === 'cycle' && groundRow(4).Note.split('; ').includes('orphan-parent') && groundRow(6).Note.split('; ').includes('parent-cycle')) || `problems ${JSON.stringify(groundPaired.problems).slice(0, 300)}`)

  // The Markdown document. Its bullets have no ids: the place of a bullet is its place in the tree, so bullet n is the entry n of the hand-worked order, and its notes are those of the CSV row of that entry. A bullet hangs from the bullet a reader nests it under, which must be the entry's parent in the model.
  const text = hierarchyMarkdown(naval, 'naval', EMPIRE)
  const bullets = outlineBullets(text)
  const navalParents = parentsIn(NAVAL_ORDER, (key) => model.byKey.get(key).children)

  await add('md-outline', 'the list has one bullet for each entry, in tree order, each nested under the bullet of its parent as a CommonMark reader (GitHub, Obsidian) and a reader that needs four spaces a level both read it', () => bullets.length === 27 && !text.includes('\r') && nestsAs(bullets, navalParents))
  await add('md-names', 'each bullet shows its entry\'s name as written, on one line', () => bullets.length === NAVAL_ORDER.length && bullets.every((line, index) => {
    const name = model.byKey.get(NAVAL_ORDER[index]).name ?? ''
    const shown = readMarkdown(line)

    return shown !== null && shown.includes(name.replace(/\s*[\r\n]+\s*/g, ' '))
  }))
  await add('md-markup', 'a name or a holder that holds markup characters, a list marker or a number with a stop is shown as text and starts no list, link or table', () => bullets.every((line) => readMarkdown(line) !== null) && !bullets.some((line) => /^\s*- (\d+[.)]|[-+*]) /.test(line)) && bullets.every((line) => !/^\s*- [#>]/.test(line)))
  await add('md-posts', 'a bullet names the holders of its post, and says when nobody serves it', () => {
    const at = (key) => readMarkdown(bullets[NAVAL_ORDER.indexOf(key)])

    return at('command:1').includes('=cmd()') && at('command:3').includes('Shared A') && at('command:3').includes('Shared B') && at('ship:42').includes('Captain Three') && !at('command:2').includes('Captain') && [1002, 1003].every((id) => figuresIn(at('command:3')).includes(id))
  })
  await add('md-notes', 'the problems of an entry are named in its bullet', () => bullets.length === NAVAL_ORDER.length && bullets.every((line, index) => rowOf(NAVAL_ORDER[index]).Note.split('; ').filter(Boolean).every((note) => line.includes(note))))
  await add('md-ground', 'the ground list is the same: one bullet per formation, nested under its parent formation by both readers', () => {
    const groundLines = outlineBullets(hierarchyMarkdown(groundModel, 'ground', EMPIRE))

    return groundLines.length === GROUND_TREE.length && groundLines.every((line) => readMarkdown(line) !== null) && readMarkdown(groundLines[0]).includes('Ground One') && nestsAs(groundLines, parentsIn(GROUND_TREE.map((entry) => entry.id), (id) => ground.byId.get(id).children))
  })
  await add('md-empire', 'the document is titled with the empire\'s name, shown as written, and its title, its summary and both files\' names hold neither the game\'s id nor the race\'s; an accented letter is its plain letter in a file name; without a name to use, the title and the file names say the game and the race by id', () => {
    const ids = { ...naval, GameID: 9431, RaceID: 9877 }
    const named = hierarchyExport(ids, 'naval', 'markdown', 'Aurelian *Star* Empire #1')
    const unnamed = hierarchyExport(ids, 'naval', 'markdown', '')
    const symbols = hierarchyExport(ids, 'naval', 'markdown', '***')
    const groundTitle = titleOf(hierarchyMarkdown({ ...groundModel, GameID: 9431, RaceID: 9877 }, 'ground', 'Aurelian Empire'))
    const without = (text) => !numbersIn(text).includes(9431) && !numbersIn(text).includes(9877)
    const both = (text) => numbersIn(text).includes(9431) && numbersIn(text).includes(9877)
    const title = titleOf(named.text)

    const csvNamed = hierarchyExport(ids, 'naval', 'csv', 'Aurelian Empire')
    const csvUnnamed = hierarchyExport(ids, 'naval', 'csv', '')

    return (title !== null && title.includes('Aurelian *Star* Empire #1') && groundTitle !== null && groundTitle.includes('Aurelian Empire') && without(headOf(named.text)) && without(named.fileName) && /aurelian/i.test(named.fileName) && /empire/i.test(named.fileName) && named.fileName.endsWith('.md') && named.type === 'text/markdown' && both(headOf(unnamed.text)) && same(numbersIn(unnamed.fileName), [9431, 9877]) && same(numbersIn(symbols.fileName), [9431, 9877]) && without(csvNamed.fileName) && /aurelian/i.test(csvNamed.fileName) && /empire/i.test(csvNamed.fileName) && csvNamed.fileName.endsWith('.csv') && same(numbersIn(csvUnnamed.fileName), [9431, 9877]) && csvUnnamed.fileName.endsWith('.csv') && hierarchyExport(ids, 'naval', 'csv', 'Ærø Étoile Empire').fileName === 'aero-etoile-empire-naval-structure.csv') || `title ${JSON.stringify(title)}, head ${JSON.stringify(headOf(named.text).slice(0, 200))}, files ${named.fileName} ${unnamed.fileName} ${symbols.fileName} ${csvNamed.fileName} ${csvUnnamed.fileName} ${hierarchyExport(ids, 'naval', 'csv', 'Ærø Étoile Empire').fileName}`
  })

  await add('export-file-length', 'an empire of a name of more than 240 characters gives every export a name of at most 120 characters: its name cut at a word, then the structure, the branch\'s kind and id and the extension whole', () => {
    const long = `${'The Most Serene and Everlasting Imperial Commonwealth of the Seven Radiant Suns '.repeat(3)}Empire`
    const cut = 'the-most-serene-and-everlasting-imperial-commonwealth-of-the'
    const files = [
      [hierarchyExport(naval, 'naval', 'csv', long), `${cut}-naval-structure.csv`],
      [hierarchyExport(naval, 'naval', 'markdown', long), `${cut}-naval-structure.md`],
      [hierarchyExport(naval, 'naval', 'markdown', long, 'command:2'), `${cut}-naval-structure-command-2.md`],
      [hierarchyExport(groundModel, 'ground', 'csv', long), `${cut}-ground-structure.csv`],
      [hierarchyExport(groundModel, 'ground', 'markdown', long, 'formation:1'), `${cut}-ground-structure-formation-1.md`],
    ]

    return (long.length >= 240 && files.every(([file, expected]) => file !== null && file.fileName === expected && file.fileName.length <= 120)) || JSON.stringify(files.map(([file]) => file && file.fileName))
  })

  // The diagram of the organisation, read back as Mermaid reads it.
  const commandOrder = NAVAL_ORDER.filter((key) => key.startsWith('command:'))
  const arrowsOf = (chart, order) => chart.arrows.map(([from, to]) => `${order[chart.nodes.findIndex((node) => node.id === from)]}>${order[chart.nodes.findIndex((node) => node.id === to)]}`).sort()
  const shownAs = (chart, order, nameOf) => chart.nodes.length === order.length && new Set(chart.nodes.map((node) => node.id)).size === order.length && chart.nodes.every((node, index) => node.lines.length === 2 && (nameOf(order[index]) ? node.lines[0] === nameOf(order[index]).replace(/\s*[\r\n]+\s*/g, ' ') : figuresIn(node.lines[0]).includes(Number(order[index].split(':')[1]))))
  const unreadable = (chart) => (chart ? `the diagram is not read at ${JSON.stringify(chart.invalid)}` : 'there is no diagram')

  await add('md-diagram', 'the diagram draws each admin command once, in tree order, with its name as written (a line break read as a space) and the commanders serving in it, and an arrow from each command to each command under it; a quote, #, %, angle bracket, & or backtick in a name stays text, and a Mermaid directive in a name (%%{init: …}%%) is shown, not run', () => {
    const chart = flowchartOf(text)

    if (!chart || chart.invalid !== undefined) {
      return unreadable(chart)
    }

    const expected = commandOrder.flatMap((key) => model.byKey.get(key).children.filter((child) => child.startsWith('command:')).map((child) => `${key}>${child}`)).sort()
    const holdersOf = (key) => chart.nodes[commandOrder.indexOf(key)].lines[1]

    return (shownAs(chart, commandOrder, (key) => model.byKey.get(key).name) && same(arrowsOf(chart, commandOrder), expected) && expected.length === 5 && holdersOf('command:1').includes('=cmd()') && holdersOf('command:3').includes('Shared A') && holdersOf('command:3').includes('Shared B %%{init: {"theme":"dark"}}%% %%{init:') && !holdersOf('command:2').includes('=cmd()')) || `nodes ${JSON.stringify(chart.nodes).slice(0, 300)}, arrows ${JSON.stringify(arrowsOf(chart, commandOrder))} against ${JSON.stringify(expected)}`
  })
  await add('md-diagram-ground', 'the ground diagram draws the formations that head other formations, each once with its commander, and an arrow from each to each such formation under it', () => {
    const deeper = buildGroundFormations(frozen({ formations: [formation(1), formation(2, { ParentFormationID: 1 }), formation(3, { ParentFormationID: 2 }), formation(4, { ParentFormationID: 1 }), formation(5)] }), IDS)
    const charts = [flowchartOf(hierarchyMarkdown(groundModel, 'ground', EMPIRE)), flowchartOf(hierarchyMarkdown({ supported: true, ...deeper }, 'ground', EMPIRE))]
    const broken = charts.find((chart) => !chart || chart.invalid !== undefined)

    if (broken !== undefined) {
      return unreadable(broken)
    }

    const nameOf = (key) => `Formation ${key.split(':')[1]}`

    return (shownAs(charts[0], ['formation:1', 'formation:6'], nameOf) && charts[0].arrows.length === 0 && charts[0].nodes[0].lines[1].includes('Ground One') && shownAs(charts[1], ['formation:1', 'formation:2'], nameOf) && same(arrowsOf(charts[1], ['formation:1', 'formation:2']), ['formation:1>formation:2'])) || JSON.stringify(charts).slice(0, 400)
  })
  await add('md-diagram-limit', 'an organisation of as many units as the diagram limit (a whole number that keeps the arrows within the 500 Mermaid draws) is drawn whole; one more is not drawn, and the section of the diagram gives the number of units', () => {
    const flat = (count) => supporting(buildNavalHierarchy(frozen({ commands: Array.from({ length: count }, (_item, index) => cmd(index + 1, `Unit ${index + 1}`, index === 0 ? 0 : 1)) }), IDS))
    const atLimit = flowchartOf(hierarchyMarkdown(flat(DIAGRAM_LIMIT), 'naval', EMPIRE))
    const past = hierarchyMarkdown(flat(DIAGRAM_LIMIT + 1), 'naval', EMPIRE)
    const between = past.split('\n## ').slice(1, -1).join('\n')

    return (Number.isInteger(DIAGRAM_LIMIT) && DIAGRAM_LIMIT >= 1 && DIAGRAM_LIMIT <= 500 && atLimit !== null && atLimit.invalid === undefined && atLimit.nodes.length === DIAGRAM_LIMIT && atLimit.arrows.length === DIAGRAM_LIMIT - 1 && flowchartOf(past) === null && figuresIn(between).includes(DIAGRAM_LIMIT + 1) && outlineBullets(past).length === DIAGRAM_LIMIT + 1) || `limit ${DIAGRAM_LIMIT}, at the limit ${atLimit ? atLimit.nodes && atLimit.nodes.length : 'no diagram'}, past it ${JSON.stringify(between.slice(0, 300))}`
  })

  // A branch exported on its own: a unit and everything under it, the entries in the tree order of the model below the branch's head.
  const subtree = (source, key) => [key, ...source.byKey.get(key).children.flatMap((child) => subtree(source, child))]
  const keyOfBullet = (line) => { const found = line.match(/\((command|fleet|ship|formation) (\d+)[,)]/); return found ? `${found[1]}:${found[2]}` : null }

  await add('md-branch', 'a branch exported on its own lists its head and every entry under it, in tree order, nested from the head down by both readers; its title names the empire and the head, its summary the entries above it, its diagram only its own commands and their arrows, and its file the empire, the structure and the head', () => {
    const results = ['command:2', 'command:1'].map((key) => {
      const file = needed(hierarchyExport(naval, 'naval', 'markdown', EMPIRE, key), `the export of ${key}`)
      const order = subtree(model, key)
      const lines = outlineBullets(file.text)
      const chart = flowchartOf(file.text)
      const commands = order.filter((item) => item.startsWith('command:'))
      const expected = commands.flatMap((item) => model.byKey.get(item).children.filter((child) => child.startsWith('command:')).map((child) => `${item}>${child}`)).sort()

      return { key, order, lines, chart, commands, expected, file, nested: nestsAs(lines, parentsIn(order, (item) => model.byKey.get(item).children)) }
    })
    const [second, root] = results
    const fine = results.every(({ key, order, lines, chart, commands, expected, file, nested }) => same(lines.map(keyOfBullet), order) && nested === true && chart && chart.invalid === undefined && shownAs(chart, commands, (item) => model.byKey.get(item).name) && same(arrowsOf(chart, commands), expected) && titleOf(file.text) !== null && titleOf(file.text).includes(EMPIRE) && file.fileName === `test-empire-naval-structure-${key.replace(':', '-')}.md` && file.type === 'text/markdown' && !file.text.includes('\n## Loops'))

    return (fine && second.order.length === 6 && root.order.length === 12 && titleOf(second.file.text).includes('Second, Fleet') && headOf(second.file.text).includes('under Root Admin') && !headOf(root.file.text).includes('under ') && hierarchyExport(naval, 'naval', 'markdown', EMPIRE, 'command:999') === null && hierarchyExport(naval, 'naval', 'csv', EMPIRE, 'command:2').text === hierarchyCsv(naval, 'naval')) || JSON.stringify(results.map(({ key, lines, nested, file, chart }) => ({ key, bullets: lines.map(keyOfBullet), nested, file: file.fileName, head: headOf(file.text).slice(0, 200), chart: chart && (chart.invalid || chart.nodes.length) })))
  })
  await add('branch-list', 'the branches offered are every admin command, or every formation that heads others, in tree order, each with its path from the top, the entries of its branch and the units its diagram draws', () => {
    const navalBranches = hierarchyBranches(naval, 'naval')
    const deeper = { supported: true, ...buildGroundFormations(frozen({ formations: [formation(1), formation(2, { ParentFormationID: 1 }), formation(3, { ParentFormationID: 2 }), formation(4, { ParentFormationID: 1 }), formation(5)] }), IDS) }
    const groundBranches = hierarchyBranches(deeper, 'ground')
    const groundKeys = (key) => [key, ...deeper.formations.find((item) => `formation:${item.id}` === key).children.flatMap((id) => groundKeys(`formation:${id}`))]
    const groundUnits = (key) => groundKeys(key).filter((item) => deeper.formations.find((entry) => `formation:${entry.id}` === item).children.length > 0)
    const navalFine = same(navalBranches.map((branch) => branch.key), NAVAL_ORDER.filter((key) => key.startsWith('command:'))) && navalBranches.every((branch) => branch.entries === subtree(model, branch.key).length && branch.units === subtree(model, branch.key).filter((key) => key.startsWith('command:')).length)
    const groundFine = same(groundBranches.map((branch) => branch.key), ['formation:1', 'formation:2']) && groundBranches.every((branch) => branch.entries === groundKeys(branch.key).length && branch.units === groundUnits(branch.key).length)
    const second = navalBranches.find((branch) => branch.key === 'command:2')

    return (navalFine && groundFine && second && second.path === 'Root Admin / Second, Fleet' && second.above === 'Root Admin' && navalBranches[0].above === '' && second.entries === 6 && second.units === 2) || JSON.stringify({ naval: navalBranches.map(({ key, entries, units, path, above }) => ({ key, entries, units, path, above })), ground: groundBranches.map(({ key, entries, units }) => ({ key, entries, units })) })
  })
  await add('md-branch-limit', 'an organisation too large for one diagram is listed without one and says a branch can be exported; a branch of it within the limit is drawn whole, and the limit holds for a branch as well', () => {
    const big = supporting(buildNavalHierarchy(frozen({ commands: [cmd(1, 'Top', 0), cmd(2, 'Large', 1), ...Array.from({ length: DIAGRAM_LIMIT - 30 }, (_item, index) => cmd(index + 10, `Small ${index + 10}`, 2)), ...Array.from({ length: 80 }, (_item, index) => cmd(index + 1000, `Other ${index + 1000}`, 1)), cmd(3, 'Huge', 1), ...Array.from({ length: DIAGRAM_LIMIT + 1 }, (_item, index) => cmd(index + 5000, `Huge ${index + 5000}`, 3))] }), IDS))
    const whole = hierarchyMarkdown(big, 'naval', EMPIRE)
    const large = flowchartOf(needed(hierarchyMarkdown(big, 'naval', EMPIRE, 'command:2'), 'the large branch'))
    const huge = needed(hierarchyMarkdown(big, 'naval', EMPIRE, 'command:3'), 'the huge branch')
    const said = (markdown) => markdown.split('\n## ').slice(1, -1).join('\n')

    return (flowchartOf(whole) === null && /branch/i.test(said(whole)) && large !== null && large.invalid === undefined && large.nodes.length === DIAGRAM_LIMIT - 29 && large.arrows.length === DIAGRAM_LIMIT - 30 && flowchartOf(huge) === null && figuresIn(said(huge)).includes(DIAGRAM_LIMIT + 2) && outlineBullets(huge).length === DIAGRAM_LIMIT + 2) || `whole ${JSON.stringify(said(whole).slice(0, 200))}, large ${large ? large.nodes && large.nodes.length : 'no diagram'}, huge ${JSON.stringify(said(huge).slice(0, 200))}`
  })

  // The shipping lines' fleets and ships, listed when the model is built with them.
  const shippingRaw = modelOf(await settle(() => buildNavalHierarchy(frozen(navalRows()), IDS, { shippingLines: true })))
  const shipping = supporting(shippingRaw)
  const shippingModel = strictEntries(shippingRaw)
  const shippingTable = tableOf(hierarchyCsv(shipping, 'naval'))
  const LINE_KEYS = ['fleet:22', 'ship:43', 'ship:44']
  const markedKeys = (source) => source.nodes.filter((item) => item.shippingLine).map((item) => item.key).sort()
  const cellsOf = (source) => source.rows.filter((row) => row['Shipping line'] !== '').map((row) => `${row.Kind}:${row.ID}`).sort()
  const lineAt = (key) => needed(shippingTable.rows.find((row) => keyOfRow(row) === key), `shipping row ${key}`)

  await add('shipping-lines-listed', 'with the shipping lines on, their fleets and ships are listed under their parents and the rest of the tree is as it was; a fleet is still not a post', () => same(shippingModel.nodes.map((item) => item.key), SHIPPING_ORDER) && shippingModel.shippingLines === true && model.shippingLines === false && same([shippingModel.summary.commands, shippingModel.summary.fleets, shippingModel.summary.ships], [11, 9, 10]) && same(shippingModel.summary.civilian, { fleets: 1, ships: 2 }) && model.nodes.every((item) => { const other = shippingModel.byKey.get(item.key); return other && other.parent.state === item.parent.state && other.post.state === item.post.state && other.depth === item.depth }) && same(LINE_KEYS.map((key) => shippingModel.byKey.get(key).parent.key), ['command:3', 'fleet:22', 'fleet:20']) && LINE_KEYS.every((key) => shippingModel.byKey.get(key).parent.state === 'resolved') && shippingModel.byKey.get('ship:43').depth === 3 && shippingModel.byKey.get('fleet:22').post.state === 'none' && same(shippingModel.byKey.get('ship:43').post.holders.map((item) => item.id), [2006]) && shippingModel.byKey.get('ship:44').post.state === 'vacant' && same(shippingModel.summary.posts, { held: 4, vacant: 14, shared: 2, unknown: 1, unread: 0 }))
  await add('shipping-lines-marked', 'each shipping line\'s fleet and ship is marked, and no other entry is, whatever the setting', () => same(markedKeys(shippingModel), LINE_KEYS) && markedKeys(model).length === 0 && ['fleet:25', 'ship:47'].every((key) => !shippingModel.byKey.get(key).shippingLine) && shippingModel.nodes.filter((item) => item.kind === 'command').every((item) => !item.shippingLine))
  await add('shipping-lines-unknown-kept', 'an entry whose shipping-line flag is not stored says so with the shipping lines on as well as off', () => [model, shippingModel].every((source) => ['fleet:25', 'ship:47'].every((key) => source.byKey.get(key).problems.some((problem) => problem.kind === 'shipping-line-unknown')) && source.summary.unknownShippingLines === 2) && LINE_KEYS.every((key) => !shippingModel.byKey.get(key).problems.some((problem) => problem.kind === 'shipping-line-unknown')))
  await add('csv-shipping-line', 'the CSV marks each shipping line\'s fleet and ship in a column of its own with one value, and marks nothing when they are left out and for the ground formations', () => {
    const marks = shippingTable.rows.filter((row) => row['Shipping line'] !== '')

    return same(shippingTable.rows.map((row) => `${row.Kind}:${row.ID}`), SHIPPING_ORDER) && shippingTable.widths.every((width) => width === shippingTable.header.length) && same(cellsOf(shippingTable), LINE_KEYS) && new Set(marks.map((row) => row['Shipping line'])).size === 1 && cellsOf(table).length === 0 && cellsOf(groundTable).length === 0 && lineAt('fleet:22')['Parent ID'] === '3' && lineAt('fleet:22')['Parent state'] === 'resolved' && lineAt('fleet:22').Post === '' && lineAt('fleet:22')['Holder ID'] === '' && lineAt('ship:43')['Path IDs'] === 'command:1/command:3/fleet:22/ship:43' && lineAt('ship:43')['Holder ID'] === '2006' && lineAt('ship:43').Name === 'Merchant One' && lineAt('fleet:25').Note.split('; ').includes('shipping-line-unknown') && lineAt('ship:47').Note.split('; ').includes('shipping-line-unknown')
  })
  await add('md-shipping-line', 'the outline lists the shipping lines nested like the other entries and marks each of them, and only them', () => {
    const listed = outlineBullets(hierarchyMarkdown(shipping, 'naval'))
    const cleared = outlineBullets(hierarchyMarkdown({ ...shipping, byKey: new Map(Array.from(shipping.byKey, ([key, item]) => [key, { ...item, shippingLine: false }])) }, 'naval'))

    return (listed.length === SHIPPING_ORDER.length && listed.every((line) => readMarkdown(line) !== null) && same(SHIPPING_ORDER.filter((_key, index) => listed[index] !== cleared[index]), LINE_KEYS) && nestsAs(listed, parentsIn(SHIPPING_ORDER, (key) => shippingModel.byKey.get(key).children))) || `${listed.length} bullets for ${SHIPPING_ORDER.length} entries`
  })

  await add('export-file', 'an export has a file name that says the tree, the game and the race and a type that matches its format', () => {
    const csvFile = hierarchyExport(naval, 'naval', 'csv')
    const markdownFile = hierarchyExport(groundModel, 'ground', 'markdown')

    return csvFile.type === 'text/csv' && markdownFile.type === 'text/markdown' && csvFile.text === csv && markdownFile.text === hierarchyMarkdown(groundModel, 'ground') && /naval/i.test(csvFile.fileName) && /ground/i.test(markdownFile.fileName) && csvFile.fileName.endsWith('.csv') && markdownFile.fileName.endsWith('.md') && numbersIn(csvFile.fileName).join() === '1,7' && csvFile.fileName !== hierarchyExport({ ...naval, GameID: 2 }, 'naval', 'csv').fileName && csvFile.fileName !== hierarchyExport({ ...naval, RaceID: 8 }, 'naval', 'csv').fileName && csvFile.fileName !== hierarchyExport(naval, 'naval', 'markdown').fileName
  })
  await add('export-notice', 'a model that cannot be exported says what the save lacks, and one that can has nothing to say', () => hierarchyNotice(naval, 'naval') === null && hierarchyNotice(groundModel, 'ground') === null && hierarchyNotice({ supported: false, missing: ['FCT_Ship.ShippingLineID', 'FCT_Fleet'], GameID: 1, RaceID: 7 }, 'naval') === 'The save lacks the shipping line id of ship, the fleet data, so the naval command structure cannot be listed.' && hierarchyNotice({ supported: true, ...unread, holders: { read: false, missing: ['FCT_Commander.Prisoner'] } }, 'naval') === 'The save lacks the prisoner of commander, so the serving commanders are not listed.')

  await add('cell-quoting', 'a CSV cell holding a comma, quote, carriage return or line feed is quoted whole, an empty value is an empty cell and a number stays a number', () => {
    const values = ['plain', 'a,b', 'say "hi"', 'two\nlines', 'cr\rhere', '', null, undefined, 0, 12]
    const parsed = parseCsv(`${csvLine(values)}\n`)[0]

    return same(parsed, ['plain', 'a,b', 'say "hi"', 'two\nlines', 'cr\rhere', '', '', '', '0', '12']) && csvCell(null) === '' && csvCell(0) === 0
  })
  await add('cell-guard', 'a text that starts with = + - @ a tab or a carriage return is written as text with its characters kept, a number column is left alone', () => ['=1+1', '+1', '-1', '@sum', '\tx', '\rx'].every((value) => {
    const cell = parseCsv(`${csvLine([value])}\n`)[0][0]

    return !/^[=+\-@\t\r]/.test(cell) && cell.includes(value) && parseCsv(`${csvLine([value], { guard: false })}\n`)[0][0] === value
  }) && csvCell(-5, { guard: false }) === -5)

  // The roster filters.
  const roster = people()
  const filtered = (filters, list = roster) => {
    const { kept, notRated } = rosterFilter(frozen(list.map((item) => ({ ...item, bonuses: {} }))), filters)

    return { ids: kept.map(({ person: item }) => letter(item.Name)).join(''), notRated }
  }
  const unrated = (post, rank, age) => ({ post, rank, age })

  await add('filter-off', 'with no filter on, everyone is in the roster and nobody is counted as not rated', () => same(filtered({}), { ids: 'ABCDEFGHIN', notRated: unrated(0, 0, 0) }))
  await add('filter-post', 'the post filter keeps the commanders whose post it is; one whose post is not stored is left out and counted, never read as another post', () => same(filtered({ post: 1 }), { ids: 'BCGN', notRated: unrated(1, 0, 0) }) && same(filtered({ post: 0 }), { ids: 'AFH', notRated: unrated(1, 0, 0) }))
  await add('filter-rank', 'the rank filter keeps the commanders of the rank; one with no stored rank is left out and counted, never read as the lowest', () => same(filtered({ rank: 2 }), { ids: 'BEGN', notRated: unrated(0, 1, 0) }) && same(filtered({ rank: 1 }), { ids: 'AH', notRated: unrated(0, 1, 0) }))
  await add('filter-age', 'the age range keeps commanders inside it, both bounds included; one whose age cannot be worked out is left out and counted, never read as 0', () => same(filtered({ ageMin: 30, ageMax: 30 }), { ids: 'BC', notRated: unrated(0, 0, 3) }) && same(filtered({ ageMin: 35 }), { ids: 'DEFI', notRated: unrated(0, 0, 3) }) && same(filtered({ ageMax: 29.9 }), { ids: 'A', notRated: unrated(0, 0, 3) }) && same(filtered({ ageMin: 0 }).ids, 'ABCDEFI'))
  await add('filter-age-edge', 'the bounds are compared on the age as the roster shows it, to one decimal', () => {
    const edge = [officer(30, 'Officer J', { post: 0, rank: 1, age: 29.96 }), officer(31, 'Officer K', { post: 0, rank: 1, age: 29.94 }), officer(32, 'Officer L', { post: 0, rank: 1, age: 30 })]

    return filtered({ ageMin: 30 }, edge).ids === 'JL' && filtered({ ageMax: 29.9 }, edge).ids === 'K' && filtered({ ageMin: 29.9, ageMax: 29.9 }, edge).ids === 'K' && filtered({ ageMin: 30, ageMax: 30 }, edge).ids === 'JL'
  })
  await add('filter-combine', 'the filters narrow together; a commander outside one filter on a stored value is not counted as unrated by the others', () => same(filtered({ post: 1, rank: 2, ageMin: 30 }), { ids: 'B', notRated: unrated(1, 0, 2) }) && same(filtered({ post: 8, rank: 2 }), { ids: '', notRated: unrated(1, 0, 0) }) && same(filtered({ post: 1, ageMin: 40 }), { ids: '', notRated: unrated(1, 0, 2) }))
  await add('filter-inputs', 'the roster\'s other filters still apply with the new ones', () => {
    const named = filtered({ search: 'officer b', post: 1 })
    const unassigned = filtered({ unassignedOnly: true, rank: 1 })
    const narrowed = filtered({ unassignedOnly: true, ageMin: 30 })

    return named.ids === 'B' && unassigned.ids === 'AH' && same(narrowed, { ids: 'F', notRated: unrated(0, 0, 1) }) && filtered({ unassignedOnly: true, rank: 2 }).ids === '' && filtered({ search: 'zzz', post: 1 }).ids === ''
  })
  await add('age-bound', 'a bound is a number from 0 up; an empty field, text that is not a number or a negative figure is no bound', () => ['', '  ', 'abc', -1, '-3', NaN, Infinity, null, undefined].every((value) => ageBound(value) === null) && ageBound('30') === 30 && ageBound(0) === 0 && ageBound('0') === 0 && ageBound('30.5') === 30.5 && ageBound(45) === 45)
  await add('choices', 'the post and rank choices are those the type holds, posts by id and ranks from the highest, and a commander with none adds none', () => {
    const choices = rosterChoices(roster)

    return same(choices.posts.map((item) => item.value), [0, 1, 8, 12]) && same(choices.ranks.map((item) => item.value), [4, 3, 2, 1]) && choices.posts.every((item) => typeof item.text === 'string' && item.text !== '') && choices.ranks.every((item) => typeof item.text === 'string' && item.text !== '') && same(rosterChoices(administrators()).ranks, []) && same(rosterChoices([]), { posts: [], ranks: [] })
  })

  return results
}

// ---------- the loaders on an in-memory database ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => {
  raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)))
})

const runStatement = (raw, sql, params = []) => new Promise((resolve, reject) => {
  raw.run(sql, params, (error) => (error ? reject(error) : resolve()))
})

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does.
const standIn = (raw) => ({
  query: async (sql) => [await allRows(raw, sql)],
  close: () => new Promise((resolve) => raw.close(() => resolve())),
})

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(standIn(raw))))
})

// A reader that records every statement, and answers no rows to those that match `hide`.
const logging = (database, hide = null) => {
  const statements = []
  const query = (sql) => {
    statements.push(sql)

    return hide && hide.test(sql) ? Promise.resolve([[]]) : database.query(sql)
  }

  return { statements, query }
}

// An in-memory database with the given tables, `columns` { Table: [column] } less `omit` (a table name, or 'Table.Column'), filled with `data` { Table: [row] }.
const memoryDatabase = async (columns, data, omit = []) => {
  const raw = await new Promise((resolve, reject) => {
    const created = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(created)))
  })

  for (const [table, required] of Object.entries(columns)) {
    if (omit.includes(table)) {
      continue
    }

    const kept = required.filter((column) => !omit.includes(`${table}.${column}`))

    await runStatement(raw, `create table ${table} (${kept.join(', ')})`)

    for (const row of data[table] || []) {
      await runStatement(raw, `insert into ${table} (${kept.join(', ')}) values (${kept.map(() => '?').join(', ')})`, kept.map((column) => (row[column] === undefined ? null : row[column])))
    }
  }

  return { raw, database: standIn(raw) }
}

// Rows of game 1 for races 7 (the race) and 8, and game 2 for race 7. Commands 1 to 5 of the race (3 hangs from a command of race 8, 4 from one that is nowhere, 5 from one of game 2), fleets 10 and 13 of the race and 11 of a shipping line, ships 20 and 21 of the race (21 in a fleet of race 8), 22 in the shipping line's fleet and 24 a shipping line's own.
const memoryNaval = () => ({
  FCT_NavalAdminCommand: [
    { NavalAdminCommandID: 1, AdminCommandName: 'M One', ParentAdminCommandID: 0, GameID: 1, RaceID: 7 },
    { NavalAdminCommandID: 2, AdminCommandName: 'M Two', ParentAdminCommandID: 1, GameID: 1, RaceID: 7 },
    { NavalAdminCommandID: 3, AdminCommandName: 'M Three', ParentAdminCommandID: 500, GameID: 1, RaceID: 7 },
    { NavalAdminCommandID: 4, AdminCommandName: 'M Four', ParentAdminCommandID: 999, GameID: 1, RaceID: 7 },
    { NavalAdminCommandID: 5, AdminCommandName: 'M Five', ParentAdminCommandID: 600, GameID: 1, RaceID: 7 },
    { NavalAdminCommandID: 500, AdminCommandName: 'Other Race', ParentAdminCommandID: 0, GameID: 1, RaceID: 8 },
    { NavalAdminCommandID: 600, AdminCommandName: 'Other Game', ParentAdminCommandID: 0, GameID: 2, RaceID: 7 },
  ],
  FCT_Fleet: [
    { FleetID: 10, FleetName: 'M Fleet', ParentCommandID: 1, ShippingLine: 0, GameID: 1, RaceID: 7 },
    { FleetID: 11, FleetName: 'M Line', ParentCommandID: 2, ShippingLine: 3, GameID: 1, RaceID: 7 },
    { FleetID: 12, FleetName: 'Other Fleet', ParentCommandID: 1, ShippingLine: 0, GameID: 1, RaceID: 8 },
    { FleetID: 13, FleetName: 'M Foreign Parent', ParentCommandID: 500, ShippingLine: 0, GameID: 1, RaceID: 7 },
  ],
  FCT_Ship: [
    { ShipID: 20, ShipName: 'M Ship', FleetID: 10, ShippingLineID: 0, GameID: 1, RaceID: 7 },
    { ShipID: 21, ShipName: 'M Foreign Fleet', FleetID: 12, ShippingLineID: 0, GameID: 1, RaceID: 7 },
    { ShipID: 22, ShipName: 'M Merchant', FleetID: 11, ShippingLineID: 0, GameID: 1, RaceID: 7 },
    { ShipID: 23, ShipName: 'Other Ship', FleetID: 10, ShippingLineID: 0, GameID: 1, RaceID: 8 },
    { ShipID: 24, ShipName: 'M Chartered', FleetID: 10, ShippingLineID: 4, GameID: 1, RaceID: 7 },
  ],
  FCT_Commander: [
    { CommanderID: 901, Name: 'Holder A', CommandType: 12, CommandID: 1, RetireStatus: 0, Prisoner: 0, GameID: 1, RaceID: 7 },
    { CommanderID: 902, Name: 'Retired', CommandType: 12, CommandID: 2, RetireStatus: 1, Prisoner: 0, GameID: 1, RaceID: 7 },
    { CommanderID: 903, Name: 'Prisoner', CommandType: 12, CommandID: 3, RetireStatus: 0, Prisoner: 1, GameID: 1, RaceID: 7 },
    { CommanderID: 904, Name: 'Unsettled', CommandType: 12, CommandID: 4, RetireStatus: null, Prisoner: 0, GameID: 1, RaceID: 7 },
    { CommanderID: 905, Name: 'Other Race Holder', CommandType: 12, CommandID: 1, RetireStatus: 0, Prisoner: 0, GameID: 1, RaceID: 8 },
    { CommanderID: 906, Name: 'Other Game Holder', CommandType: 12, CommandID: 1, RetireStatus: 0, Prisoner: 0, GameID: 2, RaceID: 7 },
    { CommanderID: 907, Name: 'Captain', CommandType: 1, CommandID: 20, RetireStatus: 0, Prisoner: 0, GameID: 1, RaceID: 7 },
    { CommanderID: 908, Name: 'Ground', CommandType: 5, CommandID: 1, RetireStatus: 0, Prisoner: 0, GameID: 1, RaceID: 7 },
  ],
})

const READS = /^\s*(select|with)\b/i
const WRITES = /\b(insert|update|delete|drop|create|alter|replace|attach|vacuum)\b/i

const loaderSuite = async (mods, into) => {
  const { results, add } = collector(into)
  const { loadNavalHierarchy, navalHierarchySql, NAVAL_HIERARCHY_COLUMNS } = mods['naval-hierarchy']
  const { loadGroundFormations, loadGroundFormationPosts, GROUND_FORMATION_COLUMNS } = mods['ground-formations']
  const { holderSql, HOLDER_COLUMNS } = mods['post-holders']
  const columns = { ...NAVAL_HIERARCHY_COLUMNS, ...HOLDER_COLUMNS }
  const keyed = (model) => new Proxy(Object.fromEntries(model.nodes.map((item) => [item.key, item])), { get: (target, key) => (typeof key === 'string' && /^(command|fleet|ship):/.test(key) ? needed(target[key], `entry ${key}`) : target[key]) })

  const full = await memoryDatabase(columns, memoryNaval())
  const logged = logging(full.database)
  const loaded = await settle(() => loadNavalHierarchy(logged, IDS))
  const model = modelOf(loaded)
  const nodes = loaded.error !== undefined ? model : model && model.supported ? keyed(model) : unavailable(failure('the loader gave no supported model'))

  await add('loader-naval', 'the loader reads the race\'s tree from the database: parents, flags, rows of another race or game left out', () => model.supported === true && model.GameID === 1 && model.RaceID === 7 && same(model.nodes.map((item) => item.key).sort(), ['command:1', 'command:2', 'command:3', 'command:4', 'command:5', 'fleet:10', 'fleet:13', 'ship:20', 'ship:21']) && same(model.summary.civilian, { fleets: 1, ships: 2 }) && same(model.summary.excluded, { commands: 0, fleets: 0, ships: 0 }) && same(['command:3', 'command:4', 'command:5', 'fleet:13', 'ship:21', 'ship:20'].map((key) => nodes[key].parent.state), ['foreign', 'orphan', 'foreign', 'foreign', 'foreign', 'resolved']) && nodes['command:1'].parent.state === 'none')

  const loggedOn = logging(full.database)
  const loadedOn = await settle(() => loadNavalHierarchy(loggedOn, { ...IDS, shippingLines: true }))
  const modelOn = modelOf(loadedOn)

  await add('loader-shipping-lines', 'with the shipping lines on the loader lists their fleets and ships, marked, under their parents and with SELECT statements only, and with them off it lists none', () => modelOn.supported === true && modelOn.shippingLines === true && model.shippingLines === false && same(modelOn.nodes.map((item) => item.key).sort(), ['command:1', 'command:2', 'command:3', 'command:4', 'command:5', 'fleet:10', 'fleet:11', 'fleet:13', 'ship:20', 'ship:21', 'ship:22', 'ship:24']) && same(modelOn.nodes.filter((item) => item.shippingLine).map((item) => item.key).sort(), ['fleet:11', 'ship:22', 'ship:24']) && model.nodes.every((item) => !item.shippingLine) && same(['fleet:11', 'ship:22', 'ship:24'].map((key) => modelOn.byKey.get(key).parent.key), ['command:2', 'fleet:11', 'fleet:10']) && loggedOn.statements.length > 0 && loggedOn.statements.every((sql) => READS.test(sql) && !WRITES.test(sql)))
  await add('loader-holders', 'the loader reads the serving commanders of the race: a retired or captured one holds nothing, one whose status is not stored is unsettled, and another race\'s, another game\'s or another type is not read', () => nodes['command:1'].post.state === 'held' && same(nodes['command:1'].post.holders.map((item) => item.id), [901]) && nodes['command:2'].post.state === 'vacant' && nodes['command:3'].post.state === 'vacant' && nodes['command:4'].post.state === 'unknown' && same(nodes['command:4'].post.unsettled.map((item) => item.id), [904]) && nodes['ship:20'].post.state === 'held' && same(nodes['ship:20'].post.holders.map((item) => item.id), [907]) && nodes['ship:21'].post.state === 'vacant' && model.holders.read === true && model.summary.strayHolders.command === 0)
  await add('loader-select-only', 'every statement of the loader is a SELECT, and nothing writes', () => logged.statements.length > 0 && logged.statements.every((sql) => READS.test(sql) && !WRITES.test(sql)))
  await add('loader-scope', 'every statement that reads a row of the game names the game and the race', () => logged.statements.filter((sql) => /\bFCT_(Fleet|Ship|NavalAdminCommand|Commander)\b/.test(sql) && !/pragma_table_info/.test(sql)).every((sql) => /GameID = 1\b/.test(sql) && /RaceID = 7\b/.test(sql)) && logged.statements.filter((sql) => /\bFCT_Commander\b/.test(sql) && !/pragma_table_info/.test(sql)).length === 1)
  await add('loader-integers', 'the statements are built only from whole numbers', async () => {
    const refused = async (fn) => ((await settle(fn)).error || {}).original instanceof TypeError
    const names = await refused(() => navalHierarchySql({ GameID: '1 or 1=1', RaceID: 7 }))
    const holders = await refused(() => holderSql({ GameID: 1, RaceID: '7; drop table FCT_Commander' }, [12]))
    const types = await refused(() => holderSql({ GameID: 1, RaceID: 7 }, [12, '1) or (1']))
    const loads = await refused(() => loadNavalHierarchy(full.database, { GameID: 1, RaceID: 'x' }))

    return names && holders && types && loads
  })

  const noShipLine = await memoryDatabase(columns, memoryNaval(), ['FCT_Ship.ShippingLineID'])
  const unsupportedLog = logging(noShipLine.database)
  const unsupported = await settle(() => loadNavalHierarchy(unsupportedLog, IDS))

  await add('loader-unsupported', 'a save without a column the tree needs is unsupported, names the column and reads no row', () => unsupported.value && unsupported.value.supported === false && unsupported.value.missing.includes('FCT_Ship.ShippingLineID') && unsupportedLog.statements.every((sql) => /pragma_table_info/.test(sql)))

  const noPrisoner = await memoryDatabase(columns, memoryNaval(), ['FCT_Commander.Prisoner'])
  const unreadLog = logging(noPrisoner.database)
  const unreadHolders = await settle(() => loadNavalHierarchy(unreadLog, IDS))

  await add('loader-holders-optional', 'a save without the columns of the commanders still gives the tree, with every post unread and the missing column named', () => unreadHolders.value && unreadHolders.value.supported === true && unreadHolders.value.holders.read === false && unreadHolders.value.holders.missing.includes('FCT_Commander.Prisoner') && unreadHolders.value.nodes.filter((item) => item.kind !== 'fleet').every((item) => item.post.state === 'unread') && unreadLog.statements.filter((sql) => /\bFCT_Commander\b/.test(sql) && !/pragma_table_info/.test(sql)).length === 0)

  const groundColumns = { ...GROUND_FORMATION_COLUMNS, ...HOLDER_COLUMNS }
  const groundData = {
    FCT_GroundUnitFormation: [formation(1), formation(2, { ParentFormationID: 1 }), formation(50, { RaceID: 8 })],
    FCT_Commander: memoryNaval().FCT_Commander.concat([
      { CommanderID: 909, Name: 'Ground Other Race', CommandType: 5, CommandID: 50, RetireStatus: 0, Prisoner: 0, GameID: 1, RaceID: 8 },
      { CommanderID: 910, Name: 'Ground Retired', CommandType: 5, CommandID: 2, RetireStatus: 2, Prisoner: 0, GameID: 1, RaceID: 7 },
    ]),
  }
  const groundMemory = await memoryDatabase(groundColumns, groundData)
  const groundLog = logging(groundMemory.database)
  const groundLoaded = await settle(() => loadGroundFormationPosts(groundLog, IDS))

  await add('loader-ground', 'the ground loader joins the serving ground commanders of the race to their formations, and no other post, race or retired commander', () => groundLoaded.value && groundLoaded.value.supported === true && groundLoaded.value.byId.get(1).post.state === 'held' && same(groundLoaded.value.byId.get(1).post.holders.map((item) => item.id), [908]) && groundLoaded.value.byId.get(2).post.state === 'vacant' && groundLoaded.value.holders.read === true && groundLoaded.value.summary.strayHolders === 0 && groundLog.statements.every((sql) => READS.test(sql) && !WRITES.test(sql)) && groundLog.statements.filter((sql) => /\bFCT_Commander\b/.test(sql) && !/pragma_table_info/.test(sql)).every((sql) => /GameID = 1\b/.test(sql) && /RaceID = 7\b/.test(sql)))

  const groundNoCommanders = await memoryDatabase(groundColumns, groundData, ['FCT_Commander'])
  const groundUnread = await settle(() => loadGroundFormationPosts(groundNoCommanders.database, IDS))

  await add('loader-ground-unread', 'a save without the commanders table still gives the formations, with every post unread', () => groundUnread.value && groundUnread.value.supported === true && groundUnread.value.holders.read === false && groundUnread.value.holders.missing.includes('FCT_Commander') && groundUnread.value.formations.every((item) => item.post.state === 'unread'))

  const plainLog = logging(groundMemory.database)
  const groundPlainLogged = await settle(() => loadGroundFormations(plainLog, IDS))

  await add('loader-ground-default', 'the ground loader reads no commander unless asked to, so the pages that only draw the formations neither read nor require the commanders', () => groundPlainLogged.value && groundPlainLogged.value.supported === true && plainLog.statements.every((sql) => !/\bFCT_Commander\b/.test(sql)) && groundPlainLogged.value.holders.read === false && groundPlainLogged.value.formations.every((item) => item.post.state === 'unread'))

  await Promise.all([full, noShipLine, noPrisoner, groundMemory, groundNoCommanders].map((entry) => entry.database.close()))

  return results
}

// ---------- the page ----------

const templateOf = (text) => {
  const parsed = parse({ source: text })

  return (parsed.descriptor || parsed).template.content
}

const attr = (node, name) => (node.data && node.data.attrs ? node.data.attrs[name] : undefined)

const nodesOf = (tree, test, found = []) => {
  if (tree === null || tree === undefined) {
    return found
  }

  if (Array.isArray(tree)) {
    tree.forEach((item) => nodesOf(item, test, found))

    return found
  }

  if (test(tree)) {
    found.push(tree)
  }

  nodesOf(tree.children, test, found)

  return found
}

const textOf = (tree) => (tree === null || tree === undefined ? '' : Array.isArray(tree) ? tree.map(textOf).join('') : tree.tag ? textOf(tree.children) : tree.text || '')

const CORE_KEYS = ['commanders', 'bonusTypes', 'traits', 'colonies', 'ships', 'projects', 'former', 'formerHistory', 'held', 'unsettled']
const OPTIONAL_KEYS = ['navalTree', 'groundTree']
const EMPTY_READS = { commanders: [], bonusTypes: [], traits: [], colonies: [], ships: [], projects: [], former: [], formerHistory: {}, held: [], unsettled: 0, navalTree: null, groundTree: null }

const STORE = {
  getters: { config: { get: (_name, fallback) => fallback }, database: null, GameID: GAME, RaceID: RACE, StartYear: 2000, 'capabilities/report': () => null, 'capabilities/blockedBonuses': new Set() },
  state: { freshness: { inputs: {} }, empires: { games: GAMES } },
  dispatch: async () => {},
  commit: () => {},
}

// The kinds the page reads each getter of the store as: a store that hands over another kind is the harness's mistake, not a failure of the page that reads it. The database is handed over as it is, its failures being data the page has to handle.
const STORE_SHAPE = { config: ['object'], database: ['object', 'null'], GameID: ['number'], RaceID: ['number'], StartYear: ['number'], 'capabilities/report': ['function'], 'capabilities/blockedBonuses': ['object'] }
const pageStore = harnessStore(STORE, STORE_SHAPE, { raw: ['database'] })

// The persisted view is the harness's (a stand-in for the app's store): what its methods throw while the page calls them is not the page's failure.
const harnessMixin = (mixin) => (mixin && mixin.persistedFields ? { ...mixin, methods: Object.fromEntries(Object.entries(mixin.methods || {}).map(([name, method]) => [name, function (...args) { return harnessOwn(() => method.apply(this, args))() }])) } : mixin)

// The constructor of a page, for the checks that render it.
const constructorOf = (options) => Vue.extend(options)

const CONTROL_TAGS = ['v-select', 'v-autocomplete', 'v-text-field', 'v-switch', 'v-btn-toggle']

const writeOf = (node) => (value) => {
  const data = needed(node, 'control to write to').data || {}

  if (data.model) {
    data.model.callback(value)
  } else if (data.on && (data.on.input || data.on.change)) {
    [].concat(data.on.input || data.on.change).forEach((handler) => handler(value))
  } else {
    throw new Error('the control has no input handler')
  }
}

// Downloads made while `run` goes: [{ type, text, file }] from the blobs the page turns into links and the links it clicks.
const downloadsOf = async (run) => {
  const saved = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  const blobs = []
  const links = []

  globalThis.document = { createElement: () => { const link = { click() { links.push({ download: link.download }) } }; return link } }
  URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:${blobs.length}` }
  URL.revokeObjectURL = () => {}

  try {
    await run()
  } finally {
    globalThis.document = saved.document
    URL.createObjectURL = saved.create
    URL.revokeObjectURL = saved.revoke
  }

  return Promise.all(blobs.map(async (blob, index) => ({ type: blob.type, text: await blob.text(), file: links[index] ? links[index].download : null })))
}

// The page of a variant: its compiled template and its component options, with the persisted view recorded.
const loadComponent = async (variant, mods) => {
  const options = await loadPage(PAGE, { stubs: STUBS, modules: { 'mixins/persisted-view': PERSISTED, 'mixins/load-state': null }, sources: variant.sources })
  const text = variant.sources[PAGE] !== undefined ? variant.sources[PAGE] : fs.readFileSync(path.join(rendererDirectory, `${PAGE}.vue`), 'utf8')
  const compiled = compileTemplate({ source: templateOf(text), filename: 'commanders.vue' })

  if (compiled.errors.length) {
    throw new Error(`The template does not compile: ${compiled.errors.join('; ')}`)
  }

  const { render, staticRenderFns } = nodeVm.runInThisContext(`(function () {\n${compiled.code}\nreturn { render, staticRenderFns }\n})()`)
  const Component = constructorOf({ ...subjectPage(options), components: {}, mixins: [...options.mixins.map(harnessMixin), { data: () => ({ ...EMPTY_READS }) }], beforeCreate() { this.$store = pageStore }, render, staticRenderFns })

  return { Component, fields: Component.options.persistedFields, mods }
}

const pageSuite = async (variant, mods, into) => {
  const { results, add } = collector(into)
  const { Component, fields } = await loadComponent(variant, mods)
  const { buildNavalHierarchy } = mods['naval-hierarchy']
  const { buildGroundFormations } = mods['ground-formations']
  const { hierarchyRows, hierarchyCsv, hierarchyExport } = mods['hierarchy-export']
  const problems = []
  const mounted = []
  const loadedKeys = Object.fromEntries(CORE_KEYS.concat(OPTIONAL_KEYS).map((key) => [key, null]))

  Vue.config.errorHandler = (error) => { if (!probing) problems.push(`error: ${error && error.message}`) }
  Vue.config.warnHandler = (message) => { if (!probing) problems.push(`warning: ${message.split('\n')[0]}`) }

  // A model the code under test could not build is a stand-in that fails each check that reads it with the failure of the call.
  const built = (make) => {
    try {
      return Object.freeze(make())
    } catch (error) {
      return unavailable(error)
    }
  }
  const naval = built(() => supporting(buildNavalHierarchy(frozen(navalRows()), IDS)))
  const ground = built(() => supporting(buildGroundFormations(frozen(groundRows()), IDS)))
  const unread = built(() => ({ ...supporting(buildNavalHierarchy((({ commanders: _commanders, ...rest }) => frozen(rest))(navalRows()), IDS)), holders: { read: false, missing: ['FCT_Commander.Prisoner'] } }))

  const mount = (data = {}, errors = loadedKeys) => {
    const vm = new Component()

    Object.entries({ ...EMPTY_READS, ...data }).forEach(([key, value]) => { vm[key] = value })
    vm.loadErrors = { ...errors }
    mounted.push(vm)

    return vm
  }

  const withPeople = (extra = {}, errors = loadedKeys) => mount({ commanders: [...people(), ...administrators()], ...extra }, errors)
  const tree = (vm) => vm._render()
  const rosterIds = (vm) => {
    const table = nodesOf(tree(vm), (node) => node.tag === 'v-data-table' && attr(node, 'item-key') === 'CommanderID')[0]

    return table ? attr(table, 'items').map((item) => item.CommanderID) : null
  }
  const defaultOf = (field) => JSON.parse(JSON.stringify(field.default === undefined ? null : field.default))
  const reset = (vm) => Object.entries(fields).forEach(([name, field]) => { vm[name] = defaultOf(field) })
  const persistedNames = new Set(Object.keys(fields))
  const stateOf = (vm) => Object.fromEntries(Object.keys(vm.$data).filter((name) => !persistedNames.has(name) && name !== 'loadErrors').map((name) => [name, JSON.stringify(vm[name])]))
  const controls = (vm) => nodesOf(tree(vm), (node) => CONTROL_TAGS.includes(node.tag))

  // A probe writes a value to a control that may not take it; the page then fails to render, which says nothing about the page, so errors are not recorded while it reads.
  let probing = false
  const probed = (read) => {
    probing = true

    try {
      return read()
    } catch {
      return null
    } finally {
      probing = false
    }
  }

  // The control that, given `value`, leaves exactly `expected` in the roster.
  const controlFor = (vm, value, expected, rows = rosterIds) => {
    for (const node of controls(vm)) {
      reset(vm)

      try {
        writeOf(node)(value)
      } catch {
        continue
      }

      const shown = probed(() => rows(vm))

      reset(vm)

      if (shown && sameSet(shown, expected)) {
        return node
      }
    }

    return null
  }

  // Drives a control and says which stored fields moved: { persisted: [name], other: [name] }.
  const drive = (vm, node, value) => {
    reset(vm)

    const before = stateOf(vm)
    const defaults = Object.fromEntries(Object.keys(fields).map((name) => [name, JSON.stringify(vm[name])]))

    writeOf(node)(value)

    const after = stateOf(vm)
    const moved = Object.keys(fields).filter((name) => JSON.stringify(vm[name]) !== defaults[name])

    return { persisted: moved, other: Object.keys(after).filter((name) => after[name] !== before[name]) }
  }

  const POST_ONE = idsOf(people().filter((item) => item.CommandType === 1))
  const RANK_TWO = idsOf(people().filter((item) => item.RankLevel === 2))
  const AGE_MIN_35 = [4, 5, 6, 9]
  const AGE_MAX_29_9 = [1]
  const everyone = idsOf(people())
  const admins = idsOf(administrators())

  // A mounted page with its roster controls found by driving them: the control that, given a value, leaves exactly the expected commanders is the one.
  const scene = () => {
    const vm = withPeople()

    return { vm, postControl: controlFor(vm, 1, POST_ONE), rankControl: controlFor(vm, 2, RANK_TWO), minControl: controlFor(vm, '35', AGE_MIN_35), maxControl: controlFor(vm, '29.9', AGE_MAX_29_9), typeControl: controlFor(vm, 2, admins) }
  }
  const shownWith = (vm, writes) => {
    writes.forEach(([node, value]) => writeOf(node)(value))

    const shown = rosterIds(vm)

    reset(vm)

    return shown
  }

  const base = scene()
  const found = ['postControl', 'rankControl', 'minControl', 'maxControl', 'typeControl'].every((name) => base[name] !== null)

  await add('page-controls', 'the roster has a control for the post, for the rank, for each end of the age range and for the type, each found by what it does to the roster', () => found && new Set([base.postControl, base.rankControl, base.minControl, base.maxControl, base.typeControl]).size === 5 && sameSet(rosterIds(base.vm), everyone))
  await add('page-post-filter', 'a control for the post leaves the commanders of the chosen post in the roster, and none of another post or with none stored', () => found && sameSet(shownWith(base.vm, [[base.postControl, 1]]), POST_ONE) && sameSet(shownWith(base.vm, [[base.postControl, 0]]), [1, 6, 8]))
  await add('page-rank-filter', 'a control for the rank leaves the commanders of the chosen rank in the roster, and none of another rank or with none stored', () => found && sameSet(shownWith(base.vm, [[base.rankControl, 3]]), [3, 4]) && sameSet(shownWith(base.vm, [[base.rankControl, 1]]), [1, 8]))
  await add('page-age-range', 'the two age controls bound the roster from below and above, the bounds included, and a commander whose age is not known is in neither', () => found && sameSet(shownWith(base.vm, [[base.minControl, '30']]), [2, 3, 4, 5, 6, 9]) && sameSet(shownWith(base.vm, [[base.maxControl, '30']]), [1, 2, 3]) && sameSet(shownWith(base.vm, [[base.minControl, '60']]), [9]) && sameSet(shownWith(base.vm, [[base.maxControl, '25']]), [1]) && sameSet(shownWith(base.vm, [[base.minControl, '30'], [base.maxControl, '30']]), [2, 3]) && !shownWith(base.vm, [[base.minControl, '0']]).some((id) => [7, 8, 14].includes(id)))
  await add('page-age-input', 'an age field emptied, or holding text that is not a number or a negative figure, bounds nothing', () => found && ['', 'abc', '-4', ' '].every((value) => sameSet(shownWith(base.vm, [[base.maxControl, value]]), everyone) && sameSet(shownWith(base.vm, [[base.minControl, value]]), everyone)))
  await add('page-age-stored-number', 'an age bound is stored as a number, which the saved view accepts, and an emptied field stores none', () => {
    const { vm, minControl } = scene()
    const moved = drive(vm, minControl, '35')
    const [name] = moved.persisted
    const valid = fields[name] && fields[name].valid
    const stored = vm[name]

    writeOf(minControl)('')

    return moved.persisted.length === 1 && fields[name].key === 'commandersAgeMin' && stored === 35 && typeof valid === 'function' && valid(stored) === true && vm[name] === null
  })
  await add('page-filters-persisted', 'the post, rank and age bounds are stored with the page\'s saved view: each control writes one declared field and nothing else, the fields hold only what their rules accept, and no two share a key', () => {
    const { vm, postControl, rankControl, minControl, maxControl } = scene()
    const driven = [[postControl, 1], [rankControl, 2], [minControl, '35'], [maxControl, '29.9']].map(([node, value]) => drive(vm, node, value))
    const names = driven.map((entry) => entry.persisted[0])
    const keys = Object.values(fields).map((field) => field.key)
    const rule = (name) => fields[name].valid

    reset(vm)

    return driven.every((entry) => entry.persisted.length === 1 && entry.other.length === 0) && new Set(names).size === 4 && names.every((name) => typeof fields[name].key === 'string' && fields[name].key !== '' && fields[name].default === null) && new Set(keys).size === keys.length && [names[2], names[3]].every((name) => typeof rule(name) === 'function' && rule(name)(null) && rule(name)(0) && rule(name)(30.5) && !rule(name)(-1) && !rule(name)('30') && !rule(name)(NaN))
  })
  await add('page-filters-combine', 'the controls narrow the roster together', () => found && sameSet(shownWith(base.vm, [[base.postControl, 1], [base.rankControl, 2]]), [2, 7, 14]) && sameSet(shownWith(base.vm, [[base.postControl, 1], [base.rankControl, 2], [base.minControl, '30']]), [2]) && sameSet(shownWith(base.vm, [[base.postControl, 1], [base.minControl, '40']]), []))
  await add('page-not-rated', 'a commander an active filter cannot rate is not shown, and the page says how many: with the rank and the age range on, one has no rank and two no age', () => {
    const { vm, rankControl, minControl } = scene()
    const captions = () => nodesOf(tree(vm), (node) => node.tag === 'div' && /panel-body/.test(node.data && node.data.staticClass ? node.data.staticClass : '')).map(textOf)
    const before = captions()

    writeOf(rankControl)(2)
    writeOf(minControl)('30')

    const added = captions().filter((line) => !before.includes(line))

    reset(vm)

    return added.length === 1 && same(figuresIn(added[0], STORE.getters.config.get('selectedSeparator', 'Tick')).sort((a, b) => a - b), [1, 2]) && captions().filter((line) => !before.includes(line)).length === 0
  })
  await add('page-type-reset', 'changing the commander type clears the post and rank choices and keeps the age range', async () => {
    const { vm, postControl, rankControl, minControl, typeControl } = scene()

    writeOf(postControl)(1)
    writeOf(rankControl)(2)
    writeOf(minControl)('30')
    writeOf(typeControl)(2)
    await Vue.nextTick()
    writeOf(typeControl)(0)
    await Vue.nextTick()

    return sameSet(rosterIds(vm), [2, 3, 4, 5, 6, 9]) || `the roster is ${rosterIds(vm).join(',')}`
  })
  await add('page-rank-gate', 'a type whose commanders have no rank offers no rank choice and is not narrowed by a rank that is still stored', () => {
    const { vm, rankControl, typeControl } = scene()
    const [rankField] = drive(vm, rankControl, 2).persisted
    const choices = needed(rankControl, 'rank control').data.attrs.items

    reset(vm)
    writeOf(typeControl)(2)
    vm[rankField] = 2

    const offered = controls(vm).some((node) => node.data && node.data.attrs && same(node.data.attrs.items, choices))

    return typeof rankField === 'string' && !offered && sameSet(rosterIds(vm), admins)
  })
  await add('page-focus-bypass', 'a commander linked from another page is shown whatever the filters say', () => {
    const { vm, postControl, minControl } = scene()

    writeOf(postControl)(8)
    writeOf(minControl)('44')

    const narrowed = rosterIds(vm)

    vm.focusCommanderId = 2

    return sameSet(narrowed, [4]) && sameSet(rosterIds(vm), [2])
  })

  const structureTable = (vm) => nodesOf(tree(vm), (node) => node.tag === 'v-data-table' && Array.isArray(attr(node, 'items')) && attr(node, 'items').length > 0 && 'Path IDs' in attr(node, 'items')[0])[0] || null
  const structureItems = (vm) => { const table = structureTable(vm); return table ? attr(table, 'items') : null }
  const rowsOf = (model, view) => hierarchyRows(model, view)
  const sameRows = (items, expected) => items !== null && items.length === expected.length && items.every((item, index) => item['Path IDs'] === expected[index]['Path IDs'] && item.Vacancy === expected[index].Vacancy && item['Holder ID'] === expected[index]['Holder ID'] && item.Name === expected[index].Name && item.Tree === expected[index].Tree)
  const buttons = (vm) => nodesOf(tree(vm), (node) => node.tag === 'v-btn' && node.data && node.data.on && node.data.on.click)
  const clickAll = async (vm, { disabled = true } = {}) => downloadsOf(async () => buttons(vm).filter((node) => disabled || !attr(node, 'disabled')).forEach((node) => [].concat(node.data.on.click).forEach((handler) => handler({}))))

  await add('page-structure-naval', 'the command structure lists one row for each entry of the naval model, in tree order, with its holders and vacancy', () => {
    const vm = withPeople({ navalTree: naval, groundTree: ground })

    return sameRows(structureItems(vm), rowsOf(naval, 'naval')) && structureItems(vm).length === 27
  })

  const toggleFor = (vm) => {
    for (const node of controls(vm)) {
      reset(vm)

      try {
        writeOf(node)('ground')
      } catch {
        continue
      }

      const items = probed(() => structureItems(vm))

      reset(vm)

      if (items && items.length && items[0].Tree === 'ground') {
        return node
      }
    }

    return null
  }

  await add('page-structure-ground', 'a control for the structure switches to the ground formations, which are listed the same way, and the choice is stored with the saved view', () => {
    const vm = withPeople({ navalTree: naval, groundTree: ground })
    const toggle = toggleFor(vm)

    if (!toggle) {
      return 'no control shows the ground formations'
    }

    const moved = drive(vm, toggle, 'ground')

    return sameRows(structureItems(vm), rowsOf(ground, 'ground')) && moved.persisted.length === 1 && moved.other.length === 0 && fields[moved.persisted[0]].default === 'naval' && fields[moved.persisted[0]].valid('ground') === true && fields[moved.persisted[0]].valid('naval') === true && fields[moved.persisted[0]].valid('air') === false
  })
  await add('page-download', 'the two download buttons save the naval structure as a CSV and as a Markdown file, exactly the exports, the Markdown titled and named with the selected race\'s empire from the empire list', async () => {
    const vm = withPeople({ navalTree: naval, groundTree: ground })
    const saved = await clickAll(vm)
    const csv = saved.find((item) => item.type === 'text/csv')
    const markdown = saved.find((item) => item.type === 'text/markdown')
    const expected = hierarchyExport(naval, 'naval', 'markdown', EMPIRE)

    return saved.length === 2 && csv && markdown && csv.text === hierarchyCsv(naval, 'naval') && markdown.text === expected.text && markdown.file === expected.fileName && /\.csv$/.test(csv.file) && /\.md$/.test(markdown.file) && csv.file !== markdown.file
  })
  await add('page-download-ground', 'with the ground formations chosen, the buttons save the ground structure', async () => {
    const vm = withPeople({ navalTree: naval, groundTree: ground })
    const toggle = toggleFor(vm)

    if (!toggle) {
      return 'no control shows the ground formations'
    }

    writeOf(toggle)('ground')

    const saved = await clickAll(vm)

    reset(vm)

    return saved.length === 2 && needed(saved.find((item) => item.type === 'text/csv'), 'CSV download').text === hierarchyCsv(ground, 'ground') && needed(saved.find((item) => item.type === 'text/markdown'), 'Markdown download').text === hierarchyExport(ground, 'ground', 'markdown', EMPIRE).text && /ground/i.test(saved[0].file) && /ground/i.test(saved[1].file)
  })
  await add('page-download-branch', 'a control offers each admin command as a branch, by its path; with one chosen, a button saves that branch as its own Markdown file, exactly the branch export named for the empire and the head, and with none chosen it saves nothing; the choice is not stored with the saved view', async () => {
    const vm = withPeople({ navalTree: naval, groundTree: ground })
    const picker = controls(vm).find((node) => { const items = attr(node, 'items'); return Array.isArray(items) && items.length > 0 && items[0] && items[0].value === 'command:1' })

    if (!picker) {
      return 'no control offers the branches'
    }

    const offered = attr(picker, 'items')
    const moved = drive(vm, picker, 'command:2')
    const saved = await clickAll(vm)
    const expected = hierarchyExport(naval, 'naval', 'markdown', EMPIRE, 'command:2')

    if (!expected) {
      reset(vm)

      return 'the branch export of command 2 is missing'
    }

    const branch = saved.find((item) => item.file === expected.fileName)

    reset(vm)

    const secondText = (offered.find((item) => item.value === 'command:2') || { text: '' }).text

    return (same(offered.map((item) => item.value), NAVAL_ORDER.filter((key) => key.startsWith('command:'))) && secondText.startsWith('Second, Fleet') && secondText.includes('Root Admin') && saved.length === 3 && branch !== undefined && branch.text === expected.text && branch.type === 'text/markdown' && moved.persisted.length === 0) || `offered ${JSON.stringify(offered.slice(0, 3))}, saved ${JSON.stringify(saved.map((item) => item.file))}, stored ${JSON.stringify(moved.persisted)}`
  })
  await add('page-structure-unsupported', 'a save without what the structure reads shows no table and no download, and the page says which tables or columns are missing', async () => {
    const missing = { supported: false, missing: ['FCT_Ship.ShippingLineID', 'FCT_Fleet'], GameID: GAME, RaceID: RACE }
    const vm = withPeople({ navalTree: missing, groundTree: ground })
    const lines = nodesOf(tree(vm), (node) => !node.tag).map((node) => node.text || '').join('\n')
    const saved = await clickAll(vm)
    const enabled = buttons(vm).filter((node) => !attr(node, 'disabled'))

    return structureTable(vm) === null && saved.length === 0 && enabled.length === 0 && lines.includes('the shipping line id of ship') && lines.includes('the fleet data') && !/FCT_/.test(lines) && rosterIds(vm) !== null
  })
  await add('page-structure-unread', 'a save whose commanders cannot be read still lists and exports the structure, with its posts shown as not read, and the page names the missing column', async () => {
    const vm = withPeople({ navalTree: unread, groundTree: ground })
    const lines = nodesOf(tree(vm), (node) => !node.tag).map((node) => node.text || '').join('\n')
    const saved = await clickAll(vm)
    const items = needed(structureItems(vm), 'structure table')

    const posts = items.filter((item) => item.Post !== '')
    const vacant = rowsOf(naval, 'naval').find((row) => row.Post !== '' && row['Holder ID'] === '').Vacancy

    return sameRows(items, rowsOf(unread, 'naval')) && lines.includes('the prisoner of commander') && !/FCT_/.test(lines) && saved.length === 2 && posts.length > 0 && posts.every((item) => item.Vacancy === posts[0].Vacancy) && posts[0].Vacancy !== vacant
  })
  await add('page-structure-failed-read', 'a structure read that failed lists nothing from an earlier model, offers no download and shows the message', async () => {
    const vm = withPeople({ navalTree: naval, groundTree: ground }, { ...loadedKeys, navalTree: 'boom' })
    const saved = await clickAll(vm)
    const failing = nodesOf(tree(vm), (node) => node.tag === 'load-state' && attr(node, 'error') === 'boom')

    return structureTable(vm) === null && saved.length === 0 && failing.length >= 1
  })
  await add('page-structure-loading', 'while the structure is read the roster is shown, the structure shows it is loading, and nothing is exported', async () => {
    const vm = withPeople({}, Object.fromEntries(CORE_KEYS.map((key) => [key, null])))
    const saved = await clickAll(vm)
    const loading = nodesOf(tree(vm), (node) => node.tag === 'load-state' && attr(node, 'loading') === true)

    return vm.ready === true && rosterIds(vm) !== null && structureTable(vm) === null && saved.length === 0 && loading.length >= 1
  })
  await add('page-optional-read-failure', 'a failed structure read does not hold the roster back, and a failed roster read does', () => {
    const vm = withPeople({ navalTree: naval }, { ...loadedKeys, groundTree: 'no ground' })
    const core = withPeople({}, { ...loadedKeys, commanders: 'no commanders' })

    const errorsShown = (model, message) => nodesOf(tree(model), (node) => node.tag === 'load-state' && attr(node, 'error') === message).length

    return vm.ready === true && sameSet(rosterIds(vm), everyone) && core.ready === false && rosterIds(core) === null && errorsShown(vm, 'no ground') === 1 && errorsShown(core, 'no commanders') >= 1
  })
  await add('page-summaries', 'every panel carries a summary of what it shows, with no figure in it', () => {
    const panels = nodesOf(tree(withPeople({ navalTree: naval, groundTree: ground })), (node) => node.tag === 'v-card' && /(^|\s)panel(\s|$)/.test(node.data && node.data.staticClass ? node.data.staticClass : ''))

    return panels.length >= 4 && panels.every((panel) => typeof attr(panel, 'data-summary') === 'string' && attr(panel, 'data-summary').trim() !== '' && !/\d/.test(attr(panel, 'data-summary')))
  })

  // The shipping lines' switch: the page's own read of the naval tree runs against a database that holds a shipping line, and is re-run the way the app re-runs a read whose inputs changed (a computed that returns the read's promise, watched).
  const lineDatabase = await memoryDatabase({ ...mods['naval-hierarchy'].NAVAL_HIERARCHY_COLUMNS, ...mods['post-holders'].HOLDER_COLUMNS }, memoryNaval())
  const scenes = []
  const readers = []
  const OFF_ORDER = ['command:1', 'command:2', 'fleet:10', 'ship:20', 'command:4', 'command:3', 'command:5', 'fleet:13', 'ship:21']
  const ON_ORDER = ['command:1', 'command:2', 'fleet:11', 'ship:22', 'fleet:10', 'ship:20', 'ship:24', 'command:4', 'command:3', 'command:5', 'fleet:13', 'ship:21']
  const LINES = ['fleet:11', 'ship:22', 'ship:24']
  const keysOf = (vm) => { const items = structureItems(vm); return items === null ? null : items.map((item) => `${item.Kind}:${item.ID}`) }
  const marksOf = (rows) => rows.filter((row) => row['Shipping line'] !== '').map((row) => `${row.Kind}:${row.ID}`)

  // A page whose naval tree is read from the database; `settled()` waits for the read the last change started. With `find`, `index` is the place among the controls of the one that, given true, makes the page list the shipping lines, found by driving each.
  const liveScene = async ({ find = false } = {}) => {
    STORE.getters.database = lineDatabase.database

    const vm = withPeople({ groundTree: ground })
    const { get } = Component.options.asyncComputed.navalTree
    const reader = new Vue({ computed: { pending: () => get.call(vm) } })
    let latest = Promise.resolve()
    let index = -1

    reader.$watch('pending', (promise) => { latest = promise.then((value) => { vm.navalTree = value }) }, { immediate: true })
    readers.push(reader)

    const settled = async () => {
      await Vue.nextTick()
      await latest
      await Vue.nextTick()
    }

    scenes.push(settled)
    await settled()

    const count = find ? controls(vm).length : 0

    for (let at = 0; at < count && index === -1; at++) {
      let keys = null

      try {
        writeOf(controls(vm)[at])(true)
        await settled()
        keys = probed(() => keysOf(vm))
      } catch {
        keys = null
      }

      reset(vm)
      await settled()

      if (same(keys, ON_ORDER)) {
        index = at
      }
    }

    return { vm, settled, index }
  }

  await add('page-shipping-lines', 'a switch of the command structure lists the shipping lines under their parents, marks them in a column of the table, leaves the ground formations alone and takes them off again', async () => {
    const { vm, settled, index } = await liveScene({ find: true })

    if (index === -1) {
      return 'no control lists the shipping lines'
    }

    const headers = () => { const table = structureTable(vm); return table ? attr(table, 'headers').map((header) => header.value) : [] }
    const state = () => ({ keys: keysOf(vm), marks: marksOf(structureItems(vm) || []), column: headers().includes('Shipping line') })
    const off = state()

    writeOf(controls(vm)[index])(true)
    await settled()

    const on = state()

    vm.structureView = 'ground'

    const onGround = { tree: (structureItems(vm) || [{}])[0].Tree, marks: marksOf(structureItems(vm) || []) }

    vm.structureView = 'naval'
    writeOf(controls(vm)[index])(false)
    await settled()

    const back = state()

    return same(off.keys, OFF_ORDER) && off.marks.length === 0 && same(on.keys, ON_ORDER) && same(on.marks, LINES) && on.column && onGround.tree === 'ground' && onGround.marks.length === 0 && same(back.keys, OFF_ORDER) && back.marks.length === 0
  })
  await add('page-shipping-lines-download', 'with the shipping lines on the two download buttons save them, marked, in the CSV and the Markdown, and with them off the files hold none', async () => {
    const { vm, settled, index } = await liveScene({ find: true })

    if (index === -1) {
      return 'no control lists the shipping lines'
    }

    const filesOf = async () => {
      const saved = await clickAll(vm)
      const csv = saved.find((item) => item.type === 'text/csv')
      const markdown = saved.find((item) => item.type === 'text/markdown')

      return { count: saved.length, rows: csv ? tableOf(csv.text).rows : [], bullets: markdown ? outlineBullets(markdown.text) : [] }
    }
    const off = await filesOf()

    writeOf(controls(vm)[index])(true)
    await settled()

    const on = await filesOf()

    return off.count === 2 && on.count === 2 && same(off.rows.map((row) => `${row.Kind}:${row.ID}`), OFF_ORDER) && marksOf(off.rows).length === 0 && off.bullets.length === 9 && same(on.rows.map((row) => `${row.Kind}:${row.ID}`), ON_ORDER) && same(marksOf(on.rows), LINES) && on.bullets.length === 12 && on.bullets.every((line) => readMarkdown(line) !== null)
  })
  await add('page-shipping-lines-stored', 'the switch writes one declared field of the saved view, off by default, that holds only true or false', async () => {
    const { vm, index } = await liveScene({ find: true })

    if (index === -1) {
      return 'no control lists the shipping lines'
    }

    const moved = drive(vm, controls(vm)[index], true)
    const [name] = moved.persisted

    return moved.persisted.length === 1 && moved.other.length === 0 && fields[name].default === false && fields[name].valid(true) === true && fields[name].valid(false) === true && fields[name].valid('yes') === false && fields[name].valid(null) === false && typeof fields[name].key === 'string' && fields[name].key !== ''
  })
  await add('page-shipping-lines-reload', 'the switch survives a reload: a page created after it was turned on lists the shipping lines in the table and the downloads, and one created after it was turned off does not', async () => {
    const { index } = await liveScene({ find: true })

    if (index === -1) {
      return 'no control lists the shipping lines'
    }

    globalThis.__persistedStore = new Map()

    try {
      const first = await liveScene()

      writeOf(controls(first.vm)[index])(true)
      await Vue.nextTick()

      const stored = Array.from(globalThis.__persistedStore.entries())
      const reloaded = await liveScene()
      const rows = keysOf(reloaded.vm)
      const csv = (await clickAll(reloaded.vm)).find((item) => item.type === 'text/csv')

      writeOf(controls(reloaded.vm)[index])(false)
      await Vue.nextTick()

      const again = await liveScene()

      return stored.length === 1 && stored[0][1] === true && Object.values(fields).some((field) => field.key === stored[0][0]) && same(rows, ON_ORDER) && Boolean(csv) && same(marksOf(tableOf(csv.text).rows), LINES) && same(keysOf(again.vm), OFF_ORDER)
    } finally {
      globalThis.__persistedStore = null
    }
  })
  await add('page-renders', 'the page renders with the roster, the filters and the command structure, in every state above, without an error or a name it does not define', () => problems.length === 0 || problems.join(' | '))

  await settle(() => Promise.all(scenes.map((settled) => settled())))
  readers.forEach((reader) => reader.$destroy())
  STORE.getters.database = null
  await lineDatabase.database.close()

  mounted.forEach((vm) => vm.$destroy())
  Vue.config.errorHandler = undefined
  Vue.config.warnHandler = undefined

  return results
}

// ---------- the variants and the saves ----------

const originals = new Map()
const sourceOf = (file) => {
  if (!originals.has(file)) {
    originals.set(file, fs.readFileSync(path.join(rendererDirectory, `${file}${file.startsWith('pages/') ? '.vue' : '.js'}`), 'utf8'))
  }

  return originals.get(file)
}

const modulesOf = async (variant) => loadUtilities(UTILITIES, { stubs: STUBS, sources: Object.fromEntries(Object.entries(variant.sources).filter(([file]) => file.startsWith('utilities/')).map(([file, text]) => [file.slice('utilities/'.length), text])) })

const suites = async (variant) => {
  const mods = Object.fromEntries(Object.entries(await modulesOf(variant)).map(([name, mod]) => [name, subjectModule(mod)]))
  const results = []

  // A suite that throws (a fault can make a model unbuildable) adds one failing result to what it had made, so the checks of the suites say what they saw. A HarnessError goes on; any other exception that does not carry the mark is the harness's (`kind` is 'error').
  for (const run of [(into) => pureSuite(mods, into), (into) => loaderSuite(mods, into), (into) => pageSuite(variant, mods, into)]) {
    const into = []

    try {
      await run(into)
    } catch (error) {
      if (error instanceof HarnessError) {
        throw error
      }

      into.push({ id: 'crash', name: `a suite stopped: ${error.message}`, ok: false, kind: kindOf(error), threw: isSubjectThrow(error), detail: error.message })
    }

    results.push(...into)
  }

  return results
}

// The checks that failed over a variant, each by an assertion of its own: a check that ended in an exception that is no marked failure of a call says nothing about what the variant changed, so `judged` stops the run, and nothing is credited with it.
const failedOf = async (variant) => judged(await suites(variant), 'a fault')

const mutated = (file, from, to) => {
  const source = sourceOf(file)
  const occurrences = source.split(from).length - 1

  if (occurrences !== 1) {
    throw new Error(`The mutation does not apply to ${file} (${occurrences} occurrences): ${from}`)
  }

  return { sources: { [file]: source.replace(from, () => to) } }
}

const UNMODIFIED = { sources: {} }

const U = (name) => `utilities/${name}`

/* eslint-disable no-template-curly-in-string */
const MUTANTS = [
  ['a retired or unsettled commander counts as a holder', U('post-holders'), 'entry[row.Serving === 1 ? \'holders\' : \'unsettled\'].push', 'entry.holders.push', ['naval-posts', 'naval-holders', 'ground-posts', 'loader-holders']],
  ['a post is held by any commander whose id matches', U('post-holders'), 'rows.filter((row) => row.CommandType === commandType).forEach', 'rows.forEach', ['naval-post-type', 'naval-posts', 'ground-posts']],
  ['a post nobody serves is vacant even when a holder\'s status is not stored', U('post-holders'), 'holders.length ? \'held\' : unsettled.length ? \'unknown\' : \'vacant\'', 'holders.length ? \'held\' : \'vacant\'', ['naval-posts', 'ground-posts', 'loader-holders']],
  ['a post with several holders is held', U('post-holders'), 'holders.length > 1 ? \'shared\' : holders.length ? \'held\'', 'holders.length ? \'held\'', ['naval-posts', 'ground-posts']],
  ['a post whose commanders were not read is vacant', U('post-holders'), 'if (index === null) {\n    return { state: \'unread\'', 'if (index === null) {\n    return { state: \'vacant\'', ['naval-unread', 'ground-unread', 'csv-vacancy', 'loader-holders-optional']],
  ['the commanders of the statement are not limited to the race', U('post-holders'), 'FCT_Commander.RaceID = ${RaceID} and ', '', ['loader-scope', 'loader-holders']],
  ['a commander whose status is not stored is not read', U('post-holders'), '(${SERVING_COMMANDER}) is not 0', '(${SERVING_COMMANDER}) = 1', ['loader-holders']],
  ['a serving commander whose post is not listed is not a stray', U('post-holders'), '!ids.has(id)', 'ids.has(id)', ['naval-strays', 'ground-posts']],
  ['a shipping line\'s fleet is listed', U('naval-hierarchy'), '.filter((row) => civilianFlag(row.ShippingLine) === true)', '.filter(() => false)', ['naval-civilian', 'loader-naval', 'naval-counts']],
  ['a shipping line\'s ship is listed', U('naval-hierarchy'), 'civilianFlag(row.ShippingLineID) === true || civilianFleets.has(row.FleetID)', 'civilianFleets.has(row.FleetID)', ['naval-civilian', 'loader-naval']],
  ['a ship in a shipping line\'s fleet is listed', U('naval-hierarchy'), 'civilianFlag(row.ShippingLineID) === true || civilianFleets.has(row.FleetID)', 'civilianFlag(row.ShippingLineID) === true', ['naval-civilian', 'loader-naval', 'shipping-lines-marked']],
  ['a flag that is not stored makes the entry civilian', U('naval-hierarchy'), '? value > 0 : null', '? value > 0 : true', ['naval-civilian-flag-unknown', 'naval-counts']],
  ['a flag that is not stored is silent', U('naval-hierarchy'), 'civilianFlag(value) === null ? [{ kind: \'shipping-line-unknown\'', 'civilianFlag(value) === 17 ? [{ kind: \'shipping-line-unknown\'', ['naval-civilian-flag-unknown', 'csv-notes']],
  ['a loop is not cut', U('naval-hierarchy'), 'const cut = new Set(cycles.map((cycle) => keyOf(\'command\', cycle.cutAt)))', 'const cut = new Set()', ['naval-partition', 'naval-roots', 'naval-order']],
  ['a parent of another race is an orphan', U('naval-hierarchy'), 'if (foreign.has(raw)) {', 'if (false) {', ['naval-parent-states', 'naval-orphans', 'loader-naval']],
  ['an orphan parent makes the entry a top of the tree', U('naval-hierarchy'), 'key: keyOf(kind, raw), state: \'orphan\' }', 'key: keyOf(kind, raw), state: \'none\' }', ['naval-parent-states', 'naval-roots', 'naval-orphans']],
  ['a parent that is not stored is an orphan', U('naval-hierarchy'), 'if (!isId(raw)) {', 'if (false) {', ['naval-parent-states', 'naval-orphans']],
  ['a fleet is a post', U('naval-hierarchy'), 'notAPost(), unknownFlag(row.ShippingLine, \'fleet\')', 'postOf(commandHolders, row.FleetID), unknownFlag(row.ShippingLine, \'fleet\')', ['naval-fleet-not-post', 'naval-posts', 'csv-vacancy']],
  ['a repeated row is listed again', U('naval-hierarchy'), '} else if (seen.has(row[idColumn])) {', '} else if (false) {', ['naval-counts']],
  ['a row of another race is listed', U('naval-hierarchy'), 'if (row.RaceID !== RaceID || row.GameID !== GameID) {', 'if (false) {', ['naval-counts']],
  ['the depth stops at one', U('naval-hierarchy'), 'child.depth = node.depth + 1', 'child.depth = 1', ['naval-orphans']],
  ['everything below an unresolved entry is resolved', U('naval-hierarchy'), 'child.resolved = node.resolved', 'child.resolved = true', ['naval-orphans']],
  ['the fleets are not limited to the race', U('naval-hierarchy'), 'where ${own(\'FCT_Fleet\')} order by FCT_Fleet.FleetID', 'order by FCT_Fleet.FleetID', ['loader-scope', 'loader-naval']],
  ['a save without a column is read anyway', U('naval-hierarchy'), 'if (missing.length) {\n    return { supported: false', 'if (false) {\n    return { supported: false', ['loader-unsupported']],
  ['a save without the commanders\' columns reads them', U('naval-hierarchy'), 'if (!holderGaps.length) {', 'if (true) {', ['loader-holders-optional']],
  ['a ground formation\'s post is that of its parent', U('ground-formations'), 'const post = postOf(holders, row.FormationID)', 'const post = postOf(holders, row.ParentFormationID)', ['ground-posts', 'loader-ground', 'ground-csv']],
  ['a ground formation is held by an admin commander', U('ground-formations'), 'const holders = holderIndex(commanderRows, GROUND_POST)', 'const holders = holderIndex(commanderRows, 12)', ['ground-posts', 'loader-ground']],
  ['the formula guard is off', U('hierarchy-export'), 'csvCell(row[column], { guard: !NUMBER_COLUMNS.has(column) })', 'csvCell(row[column], { guard: false })', ['csv-formula']],
  ['a row\'s path is its own entry', U('hierarchy-export'), 'const here = [...path, entry]', 'const here = [entry]', ['csv-paths']],
  ['an unsettled post reads as vacant', U('hierarchy-export'), 'unknown: \'not settled\', unread: \'not read\'', 'unknown: \'vacant\', unread: \'vacant\'', ['csv-vacancy']],
  ['a post with several holders lists the first', U('hierarchy-export'), 'Holder: holders.map((holder) => holder.name ?? \'\').join(\'; \')', 'Holder: holders.length ? holders[0].name ?? \'\' : \'\'', ['csv-holders']],
  ['the notes are left empty', U('hierarchy-export'), '.filter((problem) => NOTE_KINDS.has(problem.kind))', '.filter(() => false)', ['csv-notes', 'csv-unresolved']],
  ['a name is written into Markdown as it is', U('hierarchy-export'), '.replace(/[\\\\`*_[\\]<>|#&]/g, (character) => `\\\\${character}`)', '', ['md-markup', 'md-names']],
  ['a line break in a name breaks the outline', U('hierarchy-export'), 'markdownText = (value) => String(value ?? \'\').replace(/\\s*[\\r\\n]+\\s*/g, \' \')', 'markdownText = (value) => String(value ?? \'\').replace(/\\s*[\\r\\n]+\\s*/g, \'\\n\')', ['md-names']],
  ['the outline is not nested', U('hierarchy-export'), '${LEVEL.repeat(row.Depth - base)}- ${label}', '- ${label}', ['md-outline', 'md-ground', 'md-shipping-line']],
  ['the list is indented two spaces a level', U('hierarchy-export'), 'const LEVEL = \'    \'', 'const LEVEL = \'  \'', ['md-outline', 'md-ground', 'md-shipping-line']],
  ['each entry is nested a level deeper than its parent\'s child', U('hierarchy-export'), '${LEVEL.repeat(row.Depth - base)}- ${label}', '${LEVEL.repeat(row.Depth - base + 1)}- ${label}', ['md-outline', 'md-ground', 'md-shipping-line']],
  ['the title names the game and the race whatever the empire', U('hierarchy-export'), 'name ? `# ${markdownText(name)}: ${TREE_NOUNS[tree]}` : `# ${TREE_NAMES[tree]}`', '`# ${TREE_NAMES[tree]}`', ['md-empire']],
  ['the summary names the game and the race beside the empire', U('hierarchy-export'), '`${name ? \'\' : `Game ${model.GameID}, race ${model.RaceID}: `}${hierarchySummary', '`Game ${model.GameID}, race ${model.RaceID}: ${hierarchySummary', ['md-empire']],
  ['the empire\'s name is written into the title as it is', U('hierarchy-export'), '`# ${markdownText(name)}: ${TREE_NOUNS[tree]}`', '`# ${name}: ${TREE_NOUNS[tree]}`', ['md-empire']],
  ['the files are named for the game and the race whatever the empire', U('hierarchy-export'), 'const prefix = slug ?', 'const prefix = false ?', ['md-empire', 'md-branch']],
  ['the diagram draws no arrow', U('hierarchy-export'), 'const arrows = units.flatMap(', 'const arrows = [].flatMap(', ['md-diagram', 'md-diagram-ground', 'md-diagram-limit']],
  ['an arrow leads from a unit to the unit above it', U('hierarchy-export'), '`  ${ids.get(entry.key)} --> ${ids.get(key)}`', '`  ${ids.get(key)} --> ${ids.get(entry.key)}`', ['md-diagram', 'md-diagram-ground']],
  ['a name is written into the diagram as it is', U('hierarchy-export'), '.replace(/["#%<>&`]/g, (character) => `#${character.charCodeAt(0)};`)', '', ['md-diagram']],
  ['a percent sign is written into the diagram as it is, so a name can hold a Mermaid directive', U('hierarchy-export'), '.replace(/["#%<>&`]/g,', '.replace(/["#<>&`]/g,', ['md-diagram']],
  ['a line break in a name breaks the diagram', U('hierarchy-export'), 'mermaidText = (value) => String(value ?? \'\').replace(/\\s*[\\r\\n]+\\s*/g, \' \')', 'mermaidText = (value) => String(value ?? \'\').replace(/\\s*[\\r\\n]+\\s*/g, \'\\n\')', ['md-diagram']],
  ['the diagram names no holder', U('hierarchy-export'), '<br>${mermaidText(serving)}`', '<br>`', ['md-diagram', 'md-diagram-ground']],
  ['the diagram is drawn past its limit', U('hierarchy-export'), 'if (units.length > DIAGRAM_LIMIT) {', 'if (false) {', ['md-diagram-limit']],
  ['the ground diagram draws every formation', U('hierarchy-export'), ': entry.children.length > 0)', ': true)', ['md-diagram-ground']],
  ['the page exports the Markdown without the empire\'s name', PAGE, 'format, this.empireName, branch)', 'format, \'\', branch)', ['page-download']],
  ['a branch runs on past its last entry, into the entries beside it', U('hierarchy-export'), 'index > start && row.Depth <= depth', 'index > start && row.Depth < depth', ['md-branch']],
  ['a branch is nested from the top of the structure, not from its head', U('hierarchy-export'), '${LEVEL.repeat(row.Depth - base)}- ${label}', '${LEVEL.repeat(row.Depth)}- ${label}', ['md-branch']],
  ['a branch\'s diagram draws the whole organisation', U('hierarchy-export'), 'diagramLines(model, tree, rows, !part)', 'diagramLines(model, tree, all, !part)', ['md-branch', 'md-branch-limit']],
  ['a branch\'s file is named as the whole structure\'s', U('hierarchy-export'), '${part === null ? \'\' : `-${part.replace(\':\', \'-\')}`}', '', ['md-branch']],
  ['an accented letter is dropped from a file name', U('file-slug'), '.normalize(\'NFKD\').replace(/[\\u0300-\\u036F]/g, \'\')', '', ['md-empire']],
  ['a letter no decomposition reduces is dropped from a file name', U('file-slug'), '.replace(/[æøœßđðłþı]/g, (letter) => LETTERS[letter])', '', ['md-empire']],
  ['a long name is not cut, so a file name runs past what a download takes', U('file-slug'), 'if (slug.length <= SLUG_LIMIT) {', 'if (true) {', ['export-file-length']],
  ['a branch is placed at the top whatever is above it', U('hierarchy-export'), 'const place = branch.above.length ?', 'const place = false ?', ['md-branch']],
  ['an unknown branch exports the whole structure', U('hierarchy-export'), 'if (branch !== null && !part) {\n    return null', 'if (false) {\n    return null', ['md-branch']],
  ['the branch export is the whole structure', U('hierarchy-export'), 'const part = branch === null ? null : branchOf(all, branch)', 'const part = null', ['md-branch', 'md-branch-limit']],
  ['a branch counts every entry as a unit to draw', U('hierarchy-export'), 'branch.units += unit ? 1 : 0', 'branch.units += 1', ['branch-list']],
  ['a branch closes only at a shallower entry', U('hierarchy-export'), 'open[open.length - 1].depth >= row.Depth', 'open[open.length - 1].depth > row.Depth', ['branch-list']],
  ['only the top-level units are offered as branches', U('hierarchy-export'), '    if (unit) {\n      const branch =', '    if (unit && row.Depth === 0) {\n      const branch =', ['branch-list', 'page-download-branch']],
  ['the branch button saves the whole structure', PAGE, 'this.downloadStructure(\'markdown\', this.chosenBranch)', 'this.downloadStructure(\'markdown\')', ['page-download-branch']],
  ['the branch button saves even with no branch chosen', PAGE, '      if (this.chosenBranch) {\n        this.downloadStructure', '      if (true) {\n        this.downloadStructure', ['page-download']],
  ['the branch picker offers the branches without the entries above them', PAGE, '${branch.above ? ` · under ${branch.above}` : \'\'}', '', ['page-download-branch']],
  ['the branch picker leads with the path, so the chosen branch does not read in the field', PAGE, 'text: `${branch.name || `${branch.kind} ${branch.id}`} · ', 'text: `${branch.path} · ', ['page-download-branch']],
  ['the empire is the first race of the game', PAGE, 'game && game.Races.find((entry) => entry.RaceID === this.RaceID)', 'game && game.Races[0]', ['page-download']],
  ['the empire is looked up in the first game of the list', PAGE, 'this.games.find((entry) => entry.GameID === this.GameID)', 'this.games[0]', ['page-download']],
  ['the file name has the game twice', U('hierarchy-export'), '-g${model.GameID}-r${model.RaceID}', '-g${model.GameID}-r${model.GameID}', ['export-file']],
  ['the first child of an entry is skipped', U('hierarchy-export'), 'for (let index = entry.children.length - 1; index >= 0; index--) {', 'for (let index = entry.children.length - 1; index >= 1; index--) {', ['csv-rows', 'md-outline', 'ground-csv', 'page-structure-naval']],
  ['a ground formation lists no holder', U('hierarchy-export'), 'anchor: node.anchor, post: node.post, problems: node.problems', 'anchor: node.anchor, post: { state: \'none\', holders: [], unsettled: [] }, problems: node.problems', ['ground-csv', 'md-ground']],
  ['a model that cannot be listed names the columns as stored', U('hierarchy-export'), 'return `The save lacks ${fieldList(model.missing)}, so the ${TREE_NOUNS[tree]} cannot be listed.`', 'return `The save lacks ${model.missing.join(\', \')}, so the ${TREE_NOUNS[tree]} cannot be listed.`', ['export-notice']],
  ['a model that cannot be listed has no notice', U('hierarchy-export'), 'return `The save lacks ${fieldList(model.missing)}, so the ${TREE_NOUNS[tree]} cannot be listed.`', 'return null', ['export-notice', 'page-structure-unsupported']],
  ['the serving commanders notice names the columns as stored', U('hierarchy-export'), 'The save lacks ${fieldList(model.holders.missing)}, so the serving', 'The save lacks ${model.holders.missing.join(\', \')}, so the serving', ['export-notice']],
  ['a minus sign is not guarded', U('csv-cell'), '/^[=+\\-@\\t\\r]/', '/^[=+@\\t\\r]/', ['csv-formula', 'cell-guard']],
  ['a line break does not quote a cell', U('csv-cell'), '/[",\\r\\n]/.test(text)', '/[",\\r]/.test(text)', ['csv-roundtrip', 'cell-quoting']],
  ['a quote is not doubled', U('csv-cell'), 'text.replace(/"/g, \'""\')', 'text', ['csv-roundtrip', 'cell-quoting']],
  ['an empty value is written as null', U('csv-cell'), 'text === null || text === undefined ? \'\' : text', 'text === null || text === undefined ? \'null\' : text', ['cell-quoting', 'csv-rows']],
  ['the lower bound of the age is excluded', U('commanders'), '(low === null || value >= low)', '(low === null || value > low)', ['filter-age', 'filter-age-edge', 'page-age-range']],
  ['the upper bound of the age is excluded', U('commanders'), '(high === null || value <= high)', '(high === null || value < high)', ['filter-age', 'filter-age-edge', 'page-age-range']],
  ['an unknown age is in range', U('commanders'), 'value === null ? null : (low === null', 'value === null ? true : (low === null', ['filter-age', 'filter-combine', 'page-age-range']],
  ['an unknown post is not counted', U('commanders'), 'isKnownNumber(person.CommandType) ? person.CommandType === post : null', 'person.CommandType === post', ['filter-post', 'filter-combine']],
  ['an unknown rank is the lowest', U('commanders'), 'isKnownNumber(person.RankLevel) ? person.RankLevel === rank : null', '(person.RankLevel || 0) === rank', ['filter-rank']],
  ['a commander outside one filter is counted for the others', U('commanders'), 'if (Object.values(verdicts).includes(false)) {', 'if (false) {', ['filter-combine', 'page-not-rated']],
  ['an empty age field is the bound 0', U('commanders'), 'const number = typeof value === \'string\' && value.trim() === \'\' ? NaN : Number(value)', 'const number = Number(value)', ['age-bound', 'page-age-input']],
  ['a negative age is a bound', U('commanders'), 'Number.isFinite(number) && number >= 0', 'Number.isFinite(number)', ['age-bound', 'page-age-input']],
  ['the ranks are listed from the lowest', U('commanders'), '.sort((a, b) => b.value - a.value),\n  }', '.sort((a, b) => a.value - b.value),\n  }', ['choices']],
  ['a commander with no post is a choice', U('commanders'), 'if (isKnownNumber(person.CommandType) && !posts.has(person.CommandType)) {', 'if (!posts.has(person.CommandType)) {', ['choices']],
  ['a rank still stored narrows a type without ranks', PAGE, 'rank: this.rankItems.length ? this.rankFilter : null', 'rank: this.rankFilter', ['page-rank-gate']],
  ['changing the type keeps the post and the rank', PAGE, '[\'bonusId\', \'fieldId\', \'postFilter\', \'rankFilter\'].forEach', '[\'bonusId\', \'fieldId\'].forEach', ['page-type-reset']],
  ['a linked commander is narrowed by the post filter', PAGE, 'kept: this.people.filter((person) => person.CommanderID === this.focusCommanderId).map(', 'kept: this.people.filter((person) => person.CommanderID === this.focusCommanderId).filter((person) => this.postFilter === null).map(', ['page-focus-bypass']],
  ['the age bounds are swapped', PAGE, 'ageMin: this.ageAvailable ? this.ageMin : null, ageMax: this.ageAvailable ? this.ageMax : null', 'ageMin: this.ageAvailable ? this.ageMax : null, ageMax: this.ageAvailable ? this.ageMin : null', ['page-age-stored-number']],
  ['the age field stores what was typed', PAGE, 'this[name] = ageBound(value)', 'this[name] = value', ['page-age-stored-number']],
  ['the structure shows the wrong tree', PAGE, 'this.structureView === \'naval\' ? this.navalTree : this.groundTree', 'this.structureView === \'naval\' ? this.groundTree : this.navalTree', ['page-structure-naval', 'page-structure-ground']],
  ['a failed structure read keeps listing the old model', PAGE, 'return this.structureState.failed || this.loadErrors[this.structureView === \'naval\' ? \'navalTree\' : \'groundTree\'] !== null || !model ? null : model', 'return !model ? null : model', ['page-structure-failed-read']],
  ['a failed structure read holds the roster back', PAGE, 'return CORE_INPUTS.filter((key) => this.loadErrors[key])', 'return Object.keys(INPUT_LABELS).filter((key) => this.loadErrors[key])', ['page-optional-read-failure']],
  ['the roster waits for the structure to load', PAGE, 'return allLoaded(this.loadErrors, CORE_INPUTS)', 'return allLoaded(this.loadErrors, Object.keys(INPUT_LABELS))', ['page-structure-loading', 'page-optional-read-failure']],
  ['the download is saved as plain text', PAGE, 'new Blob([file.text], { type: file.type })', 'new Blob([file.text], { type: \'text/plain\' })', ['page-download', 'page-download-ground']],
  ['the CSV button saves the Markdown', PAGE, '@click="downloadStructure(\'csv\')"', '@click="downloadStructure(\'markdown\')"', ['page-download']],
  ['the structure panel has no summary', PAGE, 'data-summary="Review naval admin commands', 'data-note="Review naval admin commands', ['page-summaries']],
  ['the post filter is not a saved field', PAGE, 'postFilter: { key: \'commandersPost\', default: null },', '', ['page-filters-persisted', 'page-post-filter', 'page-renders']],
  ['the age bound takes any value in the saved view', PAGE, 'ageMin: { key: \'commandersAgeMin\', default: null, valid: validBound },', 'ageMin: { key: \'commandersAgeMin\', default: null },', ['page-filters-persisted', 'page-age-stored-number']],
  ['a builder writes to the rows it is given', U('naval-hierarchy'), 'kept.push(row)', 'kept.push(Object.assign(row, { kept: true }))', ['naval-frozen']],
  ['a loop is cut at its last member', U('naval-hierarchy'), 'cutAt: members[0] }', 'cutAt: members[members.length - 1] }', ['naval-cycles']],
  ['the note column is not in the file', U('hierarchy-export'), '\'Anchor\', \'Note\']', '\'Anchor\']', ['csv-columns']],
  ['the race column holds the game', U('hierarchy-export'), '\'Race ID\': model.RaceID,', '\'Race ID\': model.GameID,', ['csv-scope']],
  ['the parent column holds the parent\'s key', U('hierarchy-export'), '\'Parent ID\': entry.parent.id,', '\'Parent ID\': entry.parent.key,', ['csv-numbers']],
  ['the outline does not name the holders', U('hierarchy-export'), '${row.Vacancy}${holder}', '${row.Vacancy}', ['md-posts']],
  ['an unset post filter drops a commander with no post', U('commanders'), 'post: post === null ? true :', 'post: post === null ? (isKnownNumber(person.CommandType) ? true : null) :', ['filter-off']],
  ['the unassigned-only switch is ignored', U('commanders'), '(unassignedOnly && person.CommandType !== 0) || ', '', ['filter-inputs']],
  ['the loader writes to the save', U('naval-hierarchy'), 'const holderGaps = await missingColumns(database, HOLDER_COLUMNS)', 'await database.query(\'update FCT_Fleet set FleetName = FleetName\')\n\n  const holderGaps = await missingColumns(database, HOLDER_COLUMNS)', ['loader-select-only']],
  ['the naval statements take any text for the game and the race', U('naval-hierarchy'), 'if (!Number.isInteger(GameID) || !Number.isInteger(RaceID)) {', 'if (false) {', ['loader-integers']],
  ['the holder statement takes any text for a post type', U('post-holders'), '|| !commandTypes.every(Number.isInteger)) {', '|| false) {', ['loader-integers']],
  ['a ground read without the commanders\' columns reads them anyway', U('ground-formations'), 'if (!holderGaps.length) {', 'if (true) {', ['loader-ground-unread']],
  ['the plain ground read also reads the commanders', U('ground-formations'), 'return { supported: true, ...buildGroundFormations(rows, { GameID, RaceID }) }', ';[rows.commanders] = await database.query(holderSql({ GameID, RaceID }, [GROUND_POST]))\n\n  return { supported: true, ...buildGroundFormations(rows, { GameID, RaceID }) }', ['loader-ground-default']],
  ['the rank control is hidden', PAGE, '<v-col v-if="rankItems.length" cols="12" sm="3">', '<v-col v-if="false" cols="12" sm="3">', ['page-controls']],
  ['the page passes no rank to the roster', PAGE, 'rank: this.rankItems.length ? this.rankFilter : null', 'rank: null', ['page-rank-filter']],
  ['a structure whose commanders were not read is not exported', PAGE, 'return Boolean(this.structureModel && this.structureModel.supported)', 'return Boolean(this.structureModel && this.structureModel.supported && this.structureModel.holders.read !== false)', ['page-structure-unread']],
  ['the shipping lines are never added', U('naval-hierarchy'), 'const shippingLines = options.shippingLines === true', 'const shippingLines = false', ['shipping-lines-listed', 'csv-shipping-line', 'loader-shipping-lines', 'page-shipping-lines', 'page-shipping-lines-download', 'page-shipping-lines-reload']],
  ['the shipping lines are listed whatever the setting', U('naval-hierarchy'), 'const shippingLines = options.shippingLines === true', 'const shippingLines = true', ['naval-civilian', 'naval-counts', 'loader-naval', 'page-shipping-lines', 'page-shipping-lines-download', 'page-shipping-lines-reload']],
  ['the page reads the naval tree without the setting', PAGE, 'RaceID: this.RaceID, shippingLines: this.shippingLines }', 'RaceID: this.RaceID, shippingLines: false }', ['page-shipping-lines', 'page-shipping-lines-download', 'page-shipping-lines-reload']],
  ['the model does not mark a shipping line\'s ship', U('naval-hierarchy'), 'unknownFlag(row.ShippingLineID, \'ship\'), isCivilianShip(row))', 'unknownFlag(row.ShippingLineID, \'ship\'), false)', ['shipping-lines-marked', 'loader-shipping-lines']],
  ['the CSV does not mark a shipping line', U('hierarchy-export'), '\'Shipping line\': entry.shippingLine ? \'yes\' : \'\',', '\'Shipping line\': \'\',', ['csv-shipping-line', 'page-shipping-lines', 'page-shipping-lines-download']],
  ['the outline does not mark a shipping line', U('hierarchy-export'), 'const line = row[\'Shipping line\'] === \'\' ? \'\' : \', shipping line\'', 'const line = \'\'', ['md-shipping-line']],
  ['a flag that is not stored is silent when the shipping lines are listed', U('naval-hierarchy'), 'civilianFlag(value) === null ? [{ kind: \'shipping-line-unknown\'', 'civilianFlag(value) === null && !shippingLines ? [{ kind: \'shipping-line-unknown\'', ['shipping-lines-unknown-kept']],
  ['the shipping-line switch is not a saved field', PAGE, 'shippingLines: { key: \'commandersShippingLines\', default: false, valid: (value) => typeof value === \'boolean\' },', '', ['page-shipping-lines-reload', 'page-shipping-lines-stored', 'page-renders']],
  ['an entry is left out of its parent\'s children', U('naval-hierarchy'), 'nodes.get(node.parent.key).children.push(node.key)', 'nodes.get(node.parent.key).children.push(...(node.kind === \'ship\' ? [] : [node.key]))', ['naval-partition']],
  ['the outline names no notes', U('hierarchy-export'), 'const notes = row.Note === \'\' ? \'\' :', 'const notes = true ? \'\' :', ['md-notes']],
  ['the post filter is dropped while an age bound is set', PAGE, 'post: this.postFilter, rank: this.rankItems.length', 'post: this.ageMin === null ? this.postFilter : null, rank: this.rankItems.length', ['page-filters-combine']],
]
/* eslint-enable no-template-curly-in-string */

// ---------- the saves ----------

const breadthFiles = () => {
  const listing = (directory) => (fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^AuroraDB.*\.db$/i.test(name)).sort().map((name) => path.join(directory, name)) : [])
  const artifacts = path.join(root, 'artifacts')
  const folders = fs.existsSync(artifacts) ? fs.readdirSync(artifacts, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(artifacts, entry.name)).sort() : []

  return [root, path.join(root, 'saves'), ...folders].flatMap(listing)
}

const stateOfLink = (raw, own, foreign) => (raw === 0 ? 'none' : !Number.isInteger(raw) ? 'unknown' : own.has(raw) ? 'resolved' : foreign.has(raw) ? 'foreign' : 'orphan')

// The loops of the command links, found by walking each chain: the set of the ids that lie on a loop and the id where each loop is cut.
const loopsOf = (parents) => {
  const onLoop = new Set()
  const cuts = new Set()

  parents.forEach((_parent, start) => {
    const chain = []
    let at = start

    while (parents.has(at) && !chain.includes(at) && chain.length <= parents.size) {
      chain.push(at)
      at = parents.get(at)
    }

    if (at === start && chain.length) {
      chain.forEach((id) => onLoop.add(id))
      cuts.add(Math.min(...chain))
    }
  })

  return { onLoop, cuts }
}

const independentHolders = async (database, GameID, RaceID, types) => {
  const [rows] = await database.query(`select CommanderID, CommandType, CommandID, case when RetireStatus <> 0 or Prisoner <> 0 then 'out' when RetireStatus = 0 and Prisoner = 0 then 'serving' else 'unsettled' end as Standing from FCT_Commander where GameID = ${GameID} and RaceID = ${RaceID} and CommandType in (${types.join(', ')})`)
  const posts = new Map()

  rows.forEach((row) => {
    const key = `${row.CommandType}:${row.CommandID}`
    const entry = posts.get(key) || { serving: [], unsettled: [] }

    if (row.Standing === 'serving') {
      entry.serving.push(row.CommanderID)
    } else if (row.Standing === 'unsettled') {
      entry.unsettled.push(row.CommanderID)
    }

    posts.set(key, entry)
  })

  return posts
}

const expectedState = (entry) => (!entry ? 'vacant' : entry.serving.length > 1 ? 'shared' : entry.serving.length ? 'held' : entry.unsettled.length ? 'unknown' : 'vacant')

const navalSave = async (mods, database, GameID, RaceID, shippingLines) => {
  const { loadNavalHierarchy } = mods['naval-hierarchy']
  const { hierarchyCsv, hierarchyMarkdown } = mods['hierarchy-export']
  const q = async (sql) => (await database.query(sql))[0]
  const own = `GameID = ${GameID} and RaceID = ${RaceID}`
  const problems = []
  const model = await loadNavalHierarchy(database, { GameID, RaceID, shippingLines })

  if (!model.supported) {
    return { unsupported: model.missing }
  }

  const commands = await q(`select NavalAdminCommandID as id, AdminCommandName as name, ParentAdminCommandID as parent from FCT_NavalAdminCommand where ${own}`)
  const otherCommands = new Set((await q(`select NavalAdminCommandID as id from FCT_NavalAdminCommand where not (${own})`)).map((row) => row.id))
  const fleets = await q(`select FleetID as id, FleetName as name, ParentCommandID as parent, ShippingLine as line from FCT_Fleet where ${own}`)
  const otherFleets = new Set((await q(`select FleetID as id from FCT_Fleet where not (${own})`)).map((row) => row.id))
  const ships = await q(`select ShipID as id, ShipName as name, FleetID as parent, ShippingLineID as line from FCT_Ship where ${own}`)
  const commandIds = new Set(commands.map((row) => row.id))
  const civilFlag = (value) => typeof value === 'number' && value > 0
  const civilFleets = new Set(fleets.filter((row) => civilFlag(row.line)).map((row) => row.id))
  const civilShip = (row) => civilFlag(row.line) || civilFleets.has(row.parent)
  const keptFleets = shippingLines ? fleets : fleets.filter((row) => !civilFleets.has(row.id))
  const fleetIds = new Set(keptFleets.map((row) => row.id))
  const keptShips = shippingLines ? ships : ships.filter((row) => !civilShip(row))
  const loops = loopsOf(new Map(commands.filter((row) => commandIds.has(row.parent)).map((row) => [row.id, row.parent])))
  const expected = new Map()

  commands.forEach((row) => expected.set(`command:${row.id}`, { name: row.name, state: loops.cuts.has(row.id) ? 'cycle' : stateOfLink(row.parent, commandIds, otherCommands) }))
  keptFleets.forEach((row) => expected.set(`fleet:${row.id}`, { name: row.name, state: stateOfLink(row.parent, commandIds, otherCommands) }))
  keptShips.forEach((row) => expected.set(`ship:${row.id}`, { name: row.name, state: stateOfLink(row.parent, fleetIds, otherFleets) }))

  const wrong = model.nodes.filter((item) => !expected.has(item.key) || expected.get(item.key).state !== item.parent.state || (expected.get(item.key).name ?? null) !== item.name)
  const roster = Array.from(expected.values())

  if (model.nodes.length !== expected.size || wrong.length) {
    problems.push(`${model.nodes.length} entries against ${expected.size}${wrong.length ? `, ${wrong.length} differ (first ${wrong[0].key}: ${wrong[0].parent.state} against ${expected.has(wrong[0].key) ? expected.get(wrong[0].key).state : 'none'})` : ''}`)
  }

  if (model.roots.length !== roster.filter((entry) => entry.state !== 'resolved').length) {
    problems.push(`${model.roots.length} top-level entries against ${roster.filter((entry) => entry.state !== 'resolved').length}`)
  }

  if (!same([model.summary.commands, model.summary.fleets, model.summary.ships, model.summary.civilian.fleets, model.summary.civilian.ships], [commands.length, keptFleets.length, keptShips.length, civilFleets.size, ships.filter(civilShip).length])) {
    problems.push('the counts of the kinds and of the shipping lines differ')
  }

  const civilKeys = [...fleets.filter((row) => civilFleets.has(row.id)).map((row) => `fleet:${row.id}`), ...ships.filter(civilShip).map((row) => `ship:${row.id}`)].sort()

  if (model.shippingLines !== shippingLines || !same(model.nodes.filter((item) => item.shippingLine).map((item) => item.key).sort(), shippingLines ? civilKeys : [])) {
    problems.push('the entries marked as a shipping line are not those of the shipping lines, or none should be marked')
  }

  if (model.summary.cycleMembers !== loops.onLoop.size || model.summary.cycles !== loops.cuts.size) {
    problems.push(`${model.summary.cycles} loops of ${model.summary.cycleMembers} entries against ${loops.cuts.size} of ${loops.onLoop.size}`)
  }

  const seen = new Set()
  const queue = [...model.roots]

  while (queue.length && seen.size <= model.nodes.length) {
    const key = queue.shift()

    seen.add(key)
    queue.push(...model.byKey.get(key).children)
  }

  if (seen.size !== model.nodes.length) {
    problems.push(`${seen.size} of ${model.nodes.length} entries are reached from the top`)
  }

  if (model.holders.read) {
    const holders = await independentHolders(database, GameID, RaceID, [12, 1])
    const differing = model.nodes.filter((item) => item.kind !== 'fleet').filter((item) => {
      const entry = holders.get(`${item.kind === 'command' ? 12 : 1}:${item.id}`)

      return item.post.state !== expectedState(entry) || !same(item.post.holders.map((holderRow) => holderRow.id).sort((a, b) => a - b), (entry ? entry.serving : []).sort((a, b) => a - b))
    })
    const known = (type) => (type === 12 ? commandIds : new Set(ships.map((row) => row.id)))
    const strays = Array.from(holders.entries()).filter(([key]) => !known(Number(key.split(':')[0])).has(Number(key.split(':')[1]))).reduce((sum, [, entry]) => sum + entry.serving.length, 0)

    if (differing.length) {
      problems.push(`${differing.length} posts differ (first ${differing[0].key}: ${differing[0].post.state} holding ${differing[0].post.holders.map((holderRow) => holderRow.id).join(',')})`)
    }

    if (strays !== model.summary.strayHolders.command + model.summary.strayHolders.ship) {
      problems.push(`${model.summary.strayHolders.command + model.summary.strayHolders.ship} serving commanders hold no listed post against ${strays}`)
    }
  } else if (!(model.holders.missing.length > 0 && model.nodes.filter((item) => item.kind !== 'fleet').every((item) => item.post.state === 'unread'))) {
    problems.push('the commanders were not read, yet no missing table or column is named or a post is not shown as unread')
  }

  const csvRows = tableOf(hierarchyCsv(model, 'naval')).rows
  const rowsCsv = csvRows.length
  const csvMarks = csvRows.filter((row) => row['Shipping line'] !== '').map((row) => `${row.Kind}:${row.ID}`).sort()
  const bullets = outlineBullets(hierarchyMarkdown(model, 'naval')).length

  if (!same(csvMarks, shippingLines ? civilKeys : [])) {
    problems.push(`the CSV marks ${csvMarks.length} entries as a shipping line against ${shippingLines ? civilKeys.length : 0}`)
  }

  if (rowsCsv !== model.nodes.length || bullets !== model.nodes.length) {
    problems.push(`the exports hold ${rowsCsv} rows and ${bullets} bullets for ${model.nodes.length} entries`)
  }

  return { problems, model, entries: model.nodes.length, posts: model.holders.read ? model.summary.posts : null }
}

const groundSave = async (mods, database, GameID, RaceID) => {
  const { loadGroundFormationPosts } = mods['ground-formations']
  const { hierarchyCsv } = mods['hierarchy-export']
  const model = await loadGroundFormationPosts(database, { GameID, RaceID })

  if (!model.supported) {
    return { unsupported: model.missing }
  }

  const [formations] = await database.query(`select FormationID from FCT_GroundUnitFormation where GameID = ${GameID} and RaceID = ${RaceID}`)
  const problems = []
  const ids = new Set(formations.map((row) => row.FormationID))

  if (model.holders.read) {
    const holders = await independentHolders(database, GameID, RaceID, [5])
    const differing = model.formations.filter((item) => {
      const entry = holders.get(`5:${item.id}`)

      return item.post.state !== expectedState(entry) || !same(item.post.holders.map((holderRow) => holderRow.id).sort((a, b) => a - b), (entry ? entry.serving : []).sort((a, b) => a - b))
    })
    const strays = Array.from(holders.entries()).filter(([key]) => !ids.has(Number(key.split(':')[1]))).reduce((sum, [, entry]) => sum + entry.serving.length, 0)

    if (differing.length) {
      problems.push(`${differing.length} formation posts differ (first ${differing[0].id}: ${differing[0].post.state})`)
    }

    if (strays !== model.summary.strayHolders) {
      problems.push(`${model.summary.strayHolders} serving commanders hold no formation against ${strays}`)
    }
  } else if (!(model.holders.missing.length > 0 && model.formations.every((item) => item.post.state === 'unread'))) {
    problems.push('the commanders were not read, yet no missing table or column is named or a post is not shown as unread')
  }

  const rowsCsv = parseCsv(hierarchyCsv(model, 'ground')).length - 1

  if (model.formations.length !== ids.size || rowsCsv !== ids.size) {
    problems.push(`${model.formations.length} formations and ${rowsCsv} rows against ${ids.size}`)
  }

  return { problems, entries: model.formations.length, posts: model.holders.read ? model.summary.posts : null }
}

// The roster of the game and race through the page's own read, filtered the way the page filters it, against the people worked out from SQL written here: each distinct post, rank and age bound, alone and together. Commanders whose age sits on a rounding tie are left out of the comparison and counted.
const rosterSave = async (database, GameID, RaceID) => {
  const options = await loadPage(PAGE, { stubs: STUBS })
  const vm = instantiate(options, { boundary, $store: harnessStore({ getters: { 'capabilities/report': () => null, 'capabilities/blockedBonuses': new Set() }, state: { freshness: { inputs: {} } }, dispatch: async () => {} }, STORE_SHAPE), database, GameID, RaceID })

  await vm.runAsync('commanders')

  const [rows] = await database.query(`select FCT_Commander.CommanderID, FCT_Commander.CommandType, FCT_Ranks.Priority, FCT_Ranks.RankType, FCT_Species.GraduationAge, FCT_Commander.CareerStart, FCT_Game.GameTime from FCT_Commander inner join FCT_Game on FCT_Game.GameID = FCT_Commander.GameID left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID left join FCT_Species on FCT_Species.SpeciesID = FCT_Commander.SpeciesID where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and FCT_Commander.RetireStatus = 0 and FCT_Commander.Prisoner = 0`)
  const [ranks] = await database.query(`select RankType, max(Priority) as Lowest from FCT_Ranks where GameID = ${GameID} and RaceID = ${RaceID} group by RankType`)
  const lowest = new Map(ranks.map((row) => [row.RankType, row.Lowest]))
  const facts = new Map(rows.map((row) => {
    const age = [row.GraduationAge, row.CareerStart, row.GameTime].every((value) => typeof value === 'number') ? row.GraduationAge + (row.GameTime - row.CareerStart) / 31536000 : null
    const level = typeof row.Priority === 'number' && lowest.has(row.RankType) ? lowest.get(row.RankType) - row.Priority + 1 : null

    return [row.CommanderID, { post: row.CommandType, level, age: age === null ? null : Math.round(age * 10) / 10, tie: age !== null && Math.abs(((age * 10) % 1) - 0.5) < 1e-6 }]
  }))
  const problems = []
  let compared = 0
  let ties = 0

  if (vm.commanders.length !== facts.size) {
    problems.push(`the page reads ${vm.commanders.length} commanders against ${facts.size}`)
  }

  vm.commanders.forEach((row) => {
    const fact = facts.get(row.CommanderID)

    if (!fact || fact.post !== row.CommandType || fact.level !== row.RankLevel) {
      problems.push(`commander ${row.CommanderID}: post or rank differ`)
    }
  })

  for (const typeId of [0, 1, 2, 3]) {
    const people = vm.byType[typeId]
    const posts = Array.from(new Set(people.map((item) => item.CommandType).filter((value) => Number.isInteger(value))))
    const levels = Array.from(new Set(people.map((item) => item.RankLevel).filter((value) => Number.isInteger(value))))
    const ages = people.map((item) => facts.get(item.CommanderID)).filter((fact) => fact && fact.age !== null && !fact.tie).map((fact) => fact.age).sort((a, b) => a - b)
    const median = ages.length ? ages[Math.floor(ages.length / 2)] : null
    const scenarios = [...posts.map((post) => ({ post })), ...levels.map((rank) => ({ rank })), ...(median === null ? [] : [{ ageMin: median }, { ageMax: median }, { ageMin: median, ageMax: median }]), ...(posts.length && levels.length ? [{ post: posts[0], rank: levels[0] }] : []), ...(posts.length && median !== null ? [{ post: posts[0], ageMin: median }] : [])]

    ties += people.filter((item) => facts.get(item.CommanderID) && facts.get(item.CommanderID).tie).length

    for (const filters of scenarios) {
      const ruled = (fact) => ({ post: filters.post === undefined ? true : fact.post === null ? null : fact.post === filters.post, rank: filters.rank === undefined ? true : fact.level === null ? null : fact.level === filters.rank, age: filters.ageMin === undefined && filters.ageMax === undefined ? true : fact.age === null ? null : (filters.ageMin === undefined || fact.age >= filters.ageMin) && (filters.ageMax === undefined || fact.age <= filters.ageMax) })
      const wanted = people.filter((item) => facts.get(item.CommanderID) && !facts.get(item.CommanderID).tie).filter((item) => Object.values(ruled(facts.get(item.CommanderID))).every((verdict) => verdict === true)).map((item) => item.CommanderID)

      vm.typeId = typeId
      vm.postFilter = filters.post === undefined ? null : filters.post
      vm.rankFilter = filters.rank === undefined ? null : filters.rank
      vm.ageMin = filters.ageMin === undefined ? null : filters.ageMin
      vm.ageMax = filters.ageMax === undefined ? null : filters.ageMax

      const shown = vm.rosterFiltered.kept.map(({ person: item }) => item.CommanderID).filter((id) => !facts.get(id).tie)

      compared++

      if (!sameSet(shown, wanted)) {
        problems.push(`type ${typeId} ${JSON.stringify(filters)}: ${shown.length} shown against ${wanted.length}`)
      }
    }
  }

  return { problems, people: vm.commanders.length, compared, ties }
}

const savePairs = async (database, tables) => {
  const parts = tables.map((table) => `select GameID, RaceID from ${table}`)
  const [pairs] = await database.query(`select GameID, RaceID, count(*) as n from (${parts.join(' union all ')}) group by GameID, RaceID order by GameID, RaceID`)

  return pairs
}

const saveFiles = () => breadthFiles()

const saveSection = async (index) => {
  const file = saveFiles()[index]
  const shown = path.relative(root, file).replace(/\\/g, '/')
  const database = await openSave(file)
  const mods = await modulesOf(UNMODIFIED)

  try {
    const probe = await mods['naval-hierarchy'].loadNavalHierarchy(database, { GameID: 0, RaceID: 0 })

    if (!probe.supported) {
      unsupportedSaves++
      console.log(`UNSUPPORTED  ${shown} lacks ${probe.missing.join(', ')}`)

      return
    }

    const pairs = await savePairs(database, ['FCT_NavalAdminCommand', 'FCT_Fleet', 'FCT_Ship'])

    if (!pairs.length) {
      emptySaves++
      console.log(`EMPTY  ${shown} has no command, fleet or ship row`)

      return
    }

    for (const { GameID, RaceID, n } of pairs) {
      if (!Number.isInteger(GameID) || !Number.isInteger(RaceID)) {
        skippedSaves++
        console.log(`SKIP  ${shown}: ${n} rows with a game or race that is not a whole number`)

        continue
      }

      const naval = await navalSave(mods, database, GameID, RaceID, false)
      const withLines = await navalSave(mods, database, GameID, RaceID, true)
      const groundResult = await groundSave(mods, database, GameID, RaceID)
      const label = `${shown}: game ${GameID} race ${RaceID}`

      if (naval.unsupported) {
        unsupportedSaves++
        console.log(`UNSUPPORTED  ${label} lacks ${naval.unsupported.join(', ')}`)
      } else {
        console.log(`INFO  ${label}: ${naval.entries} naval entries${naval.posts ? `, posts ${JSON.stringify(naval.posts)}` : ', commanders not read'}`)
        check(`${label}: the naval tree and its posts agree with the save`, naval.problems.length === 0, naval.problems.join('; '))
        check(`${label}: the naval tree with the shipping lines listed agrees with the save`, withLines.problems.length === 0, withLines.problems.join('; '))
      }

      if (groundResult.unsupported) {
        unsupportedSaves++
        console.log(`UNSUPPORTED  ${label} lacks ${groundResult.unsupported.join(', ')} for the ground formations`)
      } else if (groundResult.entries === 0) {
        emptySaves++
        console.log(`EMPTY  ${label} has no ground formation`)
      } else {
        console.log(`INFO  ${label}: ${groundResult.entries} formations${groundResult.posts ? `, posts ${JSON.stringify(groundResult.posts)}` : ', commanders not read'}`)
        check(`${label}: the ground formations and their posts agree with the save`, groundResult.problems.length === 0, groundResult.problems.join('; '))
      }

      const rosterOutcome = await settle(() => rosterSave(database, GameID, RaceID))

      if (rosterOutcome.error) {
        if (/no such (column|table)/i.test(rosterOutcome.error.message)) {
          unsupportedSaves++
          console.log(`UNSUPPORTED  ${label} cannot be read by the roster: ${rosterOutcome.error.message}`)
        } else {
          check(`${label}: the roster filters read the save`, false, rosterOutcome.error.message)
        }
      } else if (rosterOutcome.value.people === 0) {
        emptySaves++
        console.log(`EMPTY  ${label} has no serving commander`)
      } else {
        const { problems, people, compared, ties } = rosterOutcome.value

        console.log(`INFO  ${label}: ${people} commanders, ${compared} filter settings compared, ${ties} on a rounding tie left out`)
        check(`${label}: the post, rank and age filters keep what the save says`, problems.length === 0, problems.slice(0, 3).join('; '))
      }
    }
  } catch (error) {
    check(`${shown}: reads`, false, error.message)
  } finally {
    await database.close()
  }
}

// ---------- the parts ----------

// A mutant ([name, file, from, to, ids, { throws }]) is caught when every check named for it failed by an assertion (scripts/lib/fault-credit.js `caughtAll` over one result for each named check, the one that read a value where a check failed more than once). A named check that failed only because a call of the code under test threw credits nothing: it stops the run, unless the mutant declares `throws`. The line names each credit and its kind; `detail` prints what each named check said.
const runMutant = async ([name, file, from, to, ids, { throws = false } = {}], { detail = false } = {}) => {
  const failed = await failedOf(mutated(file, from, to))
  const named = ids.map((id) => {
    const own = failed.filter((result) => result.id === id)

    return own.find((result) => !result.threw) || own[0] || { id, ok: true, kind: null, threw: false, detail: '' }
  })
  const kindOfCredit = (result) => (result.ok ? 'held' : result.threw ? 'throw' : 'value')

  check(`mutant: ${name}: caught by ${[...new Set(failed.map((result) => result.id))].join(', ') || 'nothing'}; credited by ${named.filter((result) => !result.ok).map((result) => `${result.id} (${kindOfCredit(result)})`).join(', ') || 'nothing'}`, caughtAll(named, { name, throws }), `expected all of ${ids.join(', ')}; not failed: ${named.filter((result) => result.ok).map((result) => result.id).join(', ')}`)

  if (detail) {
    named.forEach((result) => console.log(`        ${result.id} (${kindOfCredit(result)}): ${String(result.detail).split('\n')[0].slice(0, 300)}`))
  }
}

// Controls of the credit rule, with no utility or page of the app run: each rule shown with the case that is as it should be.
const creditControls = async () => {
  const run = async (list) => {
    const into = []
    const { add } = collector(into)

    for (const [id, fn] of list) {
      await add(id, id, fn)
    }

    return into
  }
  const stopped = async (call) => {
    try {
      await call()
    } catch (error) {
      return error
    }

    return null
  }
  const stranger = () => new rawAssert.AssertionError({ message: 'thrown where no adapter names it' })
  const lookup = () => {
    const nothing = null

    return nothing.missing
  }
  const [holds, fails, looksUp, unnamed, adapted, adaptedStranger] = await run([
    ['holds', () => true],
    ['fails', () => 'what was seen'],
    ['looks-up', lookup],
    ['unnamed', () => { throw stranger() }],
    ['adapted', () => through('the utility probe', () => { throw new RangeError('inside') })],
    ['adapted-stranger', () => through('the utility probe', () => { throw stranger() })],
  ])

  check('control: a verdict that does not hold is an assertion of its check, read as a value, and credits a fault named for it, and a verdict that holds passes', holds.ok && holds.kind === null && !fails.ok && fails.kind === 'assertion' && fails.threw === false && judged([holds, fails]).map((result) => result.id).join() === 'fails' && caughtAll([fails], { name: 'a value' }) && !caughtAll([holds], { name: 'a check that holds' }), JSON.stringify([holds, fails]))
  check('control: an exception that is no marked failure (a lookup of the harness, an AssertionError that no adapter named) is no assertion, and judging it stops the run as a defect of the harness', looksUp.kind === 'error' && unnamed.kind === 'error' && (await stopped(() => judged([looksUp]))) instanceof HarnessError && (await stopped(() => judged([unnamed]))) instanceof HarnessError, JSON.stringify([looksUp.kind, unnamed.kind]))
  check('control: a call of the code under test that throws, with any error, an AssertionError included, is an assertion that names the call and says that it threw, credits a fault only when the fault declares the throw and otherwise stops the run, and a call that returns gives its result', adapted.kind === 'assertion' && adaptedStranger.kind === 'assertion' && adapted.threw === true && adaptedStranger.threw === true && /^the utility probe threw RangeError/.test(adapted.detail) && /^the utility probe threw AssertionError/.test(adaptedStranger.detail) && judged([adapted, adaptedStranger]).map((result) => result.id).join() === 'adapted,adapted-stranger' && (await stopped(() => caughtAll([adapted, fails], { name: 'a planted crash' }))) instanceof HarnessError && caughtAll([adapted, adaptedStranger], { name: 'a planted crash', throws: true }) === true && through('the utility probe', () => 5) === 5, JSON.stringify([adapted, adaptedStranger]))
  check('control: a HarnessError that a check throws is not a result, and stops the run', (await stopped(() => run([['harness', () => { throw new HarnessError('the harness is not whole') }]]))) instanceof HarnessError)

  // What the harness hands the page (its store, a callback, a method of the persisted view) and what it does wrong is the harness's: it stops the run, where the same failure inside the page is a failure of the page. Each is paired with the whole piece.
  const readsGroups = (store) => {
    const options = subjectPage({ data: () => ({}), computed: { groups() { const report = this.$store.getters['capabilities/report']('/commanders'); return report ? report.groups : null } } })
    const vm = new (constructorOf({ ...options, beforeCreate() { this.$store = harnessStore(store, STORE_SHAPE) }, render: (h) => h('div') }))()

    return vm.groups
  }
  const whole = (over = {}) => ({ getters: { ...STORE.getters, ...over }, state: {}, dispatch: async () => {} })
  const brokenReport = await stopped(() => run([['report', () => readsGroups(whole({ 'capabilities/report': null }))]]))
  const throwingReport = await stopped(() => run([['report', () => readsGroups(whole({ 'capabilities/report': () => { throw new Error('the harness getter') } }))]]))
  const wholeReport = await run([['report', () => readsGroups(whole()) === null]])
  const gettersGone = await stopped(() => run([['report', () => readsGroups({ getters: null, state: {} })]]))

  check('control: a store whose getter is not the kind the page reads it as, a getter of it that throws and a store with no getters stop the run, where the page that reads a store that is whole gets its value', brokenReport instanceof HarnessError && throwingReport instanceof HarnessError && gettersGone instanceof HarnessError && wholeReport[0].ok, `${brokenReport} ${throwingReport} ${gettersGone} ${JSON.stringify(wholeReport)}`)

  const dispatching = (store) => {
    const options = subjectPage({ data: () => ({}), methods: { go() { return this.$store.dispatch('capabilities/preflight') } } })
    const vm = new (constructorOf({ ...options, beforeCreate() { this.$store = harnessStore(store, STORE_SHAPE) }, render: (h) => h('div') }))()

    return vm.go()
  }
  const dispatchFails = await stopped(() => run([['dispatch', () => dispatching({ ...whole(), dispatch: async () => { throw new Error('the harness dispatch') } })]]))
  const dispatchWhole = await run([['dispatch', async () => { await dispatching(whole()); return true }]])

  check('control: a dispatch of the store that rejects stops the run, and one that resolves gives the page its answer', dispatchFails instanceof HarnessError && dispatchWhole[0].ok, `${dispatchFails} ${JSON.stringify(dispatchWhole)}`)

  const calling = (callback) => subjectModule({ invoke: (given) => given() }).invoke(callback)
  const callbackThrows = await stopped(() => run([['callback', () => calling(harnessOwn(() => { throw new Error('the harness callback') }))]]))
  const callbackWhole = await run([['callback', () => calling(harnessOwn(() => 7)) === 7]])

  check('control: a callback of the harness that the code under test calls and that throws stops the run, and one that returns gives its value', callbackThrows instanceof HarnessError && callbackWhole[0].ok, `${callbackThrows} ${JSON.stringify(callbackWhole)}`)

  const viaMixin = (method) => {
    const options = subjectPage({ data: () => ({}), methods: { act() { return this.helper() } } })
    const vm = new (constructorOf({ ...options, mixins: [harnessMixin({ persistedFields: {}, methods: { helper: method } })], render: (h) => h('div') }))()

    return vm.act()
  }
  const mixinThrows = await stopped(() => run([['mixin', () => viaMixin(() => { throw new Error('the persisted view') })]]))
  const mixinWhole = await run([['mixin', () => viaMixin(() => 5) === 5]])

  check('control: a method of the persisted view that the page calls and that throws stops the run, and one that returns gives its value', mixinThrows instanceof HarnessError && mixinWhole[0].ok, `${mixinThrows} ${JSON.stringify(mixinWhole)}`)

  const page = subjectPage({
    computed: { boom() { throw new Error('in a computed value') }, fine() { return 7 }, split: { get() { throw new Error('in a getter') }, set() {} } },
    methods: { act() { throw new TypeError('in a method') }, add(left, right) { return left + right } },
    watch: { value: { handler() { throw new Error('in a watcher') } } },
    asyncComputed: { later: { get() { return Promise.reject(new Error('in a read')) } } },
    created() { throw new Error('in a hook') },
  })
  const returned = { fine: page.computed.fine.call({}), sum: page.methods.add.call({}, 2, 3) }
  const thrown = [
    ['the computed value boom', () => page.computed.boom.call({})],
    ['the computed value split', () => page.computed.split.get.call({})],
    ['the method act', () => page.methods.act.call({})],
    ['the watcher on value', () => page.watch.value.handler.call({})],
    ['the hook created', () => page.created.call({})],
    ['the read later', () => page.asyncComputed.later.get.call({})],
  ]
  const pageResults = await run(thrown.map(([label, call]) => [label, call]))

  check('control: a computed value, method, watcher, hook or async read of the page that throws is an assertion that names it and says that it threw, and one that returns gives its result', pageResults.every((result) => result.kind === 'assertion' && result.threw === true && result.detail.startsWith(`${result.id} threw `)) && returned.fine === 7 && returned.sum === 5, JSON.stringify(pageResults.map((result) => [result.id, result.kind, result.detail])))

  const built = unavailable(failure('the build threw'))
  const reading = await run([['reads', () => built.nodes.length]])

  check('control: a model the code under test could not build fails each check that reads it, by an assertion, and stays that stand-in where the page and the exports are given it', reading[0].kind === 'assertion' && /the build threw/.test(reading[0].detail) && supporting(built) === built, JSON.stringify(reading))
  check('control: a build that failed otherwise than by a marked failure of a call is the harness\'s, and is not turned into a stand-in', (await stopped(() => unavailable(new Error('the harness broke')))) instanceof Error)
}

const runPart = async (part, options) => {
  const [kind, index] = part.split(':')

  if (part === 'suites') {
    console.log('Constructed rows, loaders and the page')

    ;(await suites(UNMODIFIED)).forEach((result) => check(result.name, result.ok, result.detail))
  } else if (kind === 'save') {
    await saveSection(Number(index))
  } else if (part === 'control') {
    const results = await suites(UNMODIFIED)

    check('control: the unmodified code passes every check the mutations are judged by', results.every((result) => result.ok), results.filter((result) => !result.ok).map((result) => result.id).join(', '))
    await creditControls()
  } else if (kind === 'mutant') {
    await runMutant(MUTANTS[Number(index)], options)
  } else {
    throw new Error(`No part is named ${part}`)
  }
}

// The deadlines, in seconds: five times the slowest time measured (the suites 1.8 s, a save 24 s, the control 0.6 s, a mutant 1.5 s), at least two minutes, for a busy machine. The suites build the constructed rows, the loaders and the page; a save is read and compared with SQL whole; the control runs the suites again and the controls of the credit; a mutant runs the suites over its copy.
const DEADLINES = { suites: 120, save: 120, control: 120, mutant: 120 }

// The parts, in the order they print, each in a process of its own as they ran before the runner.
const variantsOf = (options) => [
  { key: 'suites', name: 'the suites: constructed rows, loaders and the page', head: true, deadline: DEADLINES.suites, run: () => runPart('suites', options) },
  ...(options.saves ? saveFiles().map((file, index) => ({ key: `save:${index}`, name: `the save ${path.relative(root, file).replace(/\\/g, '/')}`, head: true, heading: '\nEvery save found', deadline: DEADLINES.save, run: () => runPart(`save:${index}`, options) })) : []),
  ...(options.mutations ? [{ key: 'control', name: 'control: the unmodified code and the credit of a fault', heading: '\nMutations', deadline: DEADLINES.control, run: () => runPart('control', options) }, ...MUTANTS.map(([name], index) => ({ key: `mutant:${index}`, name: `mutant: ${name}`, heading: '\nMutations', deadline: DEADLINES.mutant, run: () => runPart(`mutant:${index}`, options) }))] : []),
]

const main = async () => {
  const options = parseArguments(runnerArgs().rest)
  const totals = await runSuite({
    script: __filename,
    inputs: options.saves ? saveFiles() : [],
    variants: variantsOf(options),
    counts: () => ({ checks, failures, extra: { unsupportedSaves, emptySaves, skippedSaves } }),
  })
  const { unsupportedSaves: unsupported = 0, emptySaves: empty = 0, skippedSaves: skipped = 0 } = totals.extra

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed (${unsupported} unsupported, ${empty} empty, ${skipped} skipped)`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
