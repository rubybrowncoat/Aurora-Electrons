/*
  Checks the intruders warning of the Warnings page (the `intruders` check of src/renderer/utilities/warnings/space.js), the condition it shares for a contact the race holds now (src/renderer/utilities/contacts.js) and the Warnings line of the section flyout (src/renderer/utilities/peeks.js, '/warnings'), which counts the same systems.

  Run: bun scripts/check-warning-intruders.js [--no-mutations] [--no-browser] [--only=<text>,<text>]

  - Fixtures: an in-memory save whose race holds contacts now (one with a lost track beside a current one, and ones with a track whose time is not stored), contacts last detected long ago (ships, a salvo, a colony, the old track of a ship that moved on), contacts lost one sub-pulse before the game time and one a year before it, a colony held now with ground units of both kinds and a lost shipyard beside a ship of another empire that has the colony's id, empires of unknown, allied and friendly standing, systems with contacts of two empires, and a game whose time is not stored. Each check reads the rows the warning returns back through the module's word tables and compares them, system by system, with what is written here: the name, the counts, the inputs missing, each empire named under the system by its id (its name, its contacts by type, whether it is marked hostile) and the place the row's link opens; and the order of the systems with their ids.
  - Saves, read only: AuroraDB.db (game 140, race 784), saves/AuroraDB.db (game 138, race 785, which holds systems whose contacts are all lost) and saves/AuroraDB_271_skoormit_saved.db (game 138, race 785): the rows of the warning against SQL written here from the game's rules, and the flyout line against the systems the warning lists.
  - The page in a browser: the real renderer serves saves/AuroraDB.db (scripts/lib/page-server.js), the race is picked and the Warnings page opened on the check; once the page's own read of the check has settled on the copy of the save it shows, the page's section is hovered in the rail and, once the flyout's line under the page has settled, the rows a player can see are read (text nodes of shown elements only: the system, the contacts and the line naming each empire; the place the row's link opens, from the link shown) and compared with the SQL by the ids of the systems and empires, and the count of the flyout's line with the warnings shown.
  - Planted faults in copies of the rule, the shared condition, the flyout line and the page, each of which must make a check named for it fail by an assertion of its own (scripts/lib/fault-credit.js; a fault served to the browser is judged on what the page then shows), and benign rewrites (an explicit prop and event instead of v-model, a longhand v-on, a qualifier moved from the front to the back, synonyms in generated prose, the empires of a system named in another order, a parenthesised condition, the condition written the other way round) that must make none fail, alone and all together.
  - Controls of the harness: an assertion of a check is told from an error of the code under test.

  The word tables of the module (CONTACT_WORDS, OPEN_INPUTS, RACE_WORDS, WARNINGS_PEEK_WORDS) are reviewed prose: a check reads a line back through them and never asks for a wording. Prints `N of N checks passed`; any failed check sets exit code 1. A save that is not there fails its checks: none is skipped. It needs Playwright's Chromium for the browser part; with --no-browser the faults of the page are not planted, and those of the code are judged by the other checks.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const rawAssert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { startPageServer } = require('./lib/page-server')
const { observe, failedObservation, report, HarnessError } = require('./lib/browser-observe')
const { assert, through, runChecks, judged, caughtBy, unobserved } = require('./lib/fault-credit')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const FILES = {
  space: path.join(utilitiesDirectory, 'warnings', 'space.js'),
  contacts: path.join(utilitiesDirectory, 'contacts.js'),
  peeks: path.join(utilitiesDirectory, 'peeks.js'),
  page: path.join(root, 'src', 'renderer', 'pages', 'warnings.vue'),
}

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`
const real = (specifier) => `import { createRequire } from 'node:module'\nexport default ${requireOf(specifier)}`

const STUBS = {
  vue: 'export default { observable: (value) => value }',
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  'lodash/groupBy': real('lodash/groupBy'),
  'lodash/partition': real('lodash/partition'),
  dayjs: real('dayjs'),
  'dayjs/plugin/utc.js': real('dayjs/plugin/utc.js'),
  romanum: real('romanum'),
}

const argument = (name) => (process.argv.find((item) => item.startsWith(`${name}=`)) || '').slice(name.length + 1)
const options = { mutations: !process.argv.includes('--no-mutations'), browser: !process.argv.includes('--no-browser') }

let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`)
}

const lazy = (make) => {
  let held

  return () => {
    held = held || make()

    return held
  }
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The app's separator for the reads in Node: the default of the "Thousands Separator" setting.
const SEPARATOR = '\''

// ---------- reading a line back ----------

// A word table as a map from each wording to its key: an entry is a wording, or a list of them ([one, many]). Two keys worded alike cannot be read back, which fails the check that reads the line.
const wordsOf = (table, label) => {
  const map = new Map()

  Object.entries(table).forEach(([kind, forms]) => [].concat(forms).forEach((form) => {
    assert.ok(!map.has(form) || map.get(form) === kind, `${label}: "${form}" stands for both ${map.get(form)} and ${kind}`)
    map.set(form, kind)
  }))

  return map
}

// A figure as written: whole digits grouped in threes by the separator, with an optional sign (ASCII '-', U+2212 or '+'); anything else is no figure.
const figureOf = (separator, text, label) => {
  const match = new RegExp(`^([-+\\u2212])?(\\d{1,3}(?:${escapeRegex(separator)}\\d{3})+|\\d+)$`).exec(text)

  assert.ok(match, `${label}: "${text}" is no whole figure`)

  const value = Number(match[2].split(separator).join(''))

  return match[1] === '-' || match[1] === '\u2212' ? -value : value
}

// A list of counts ('7 Hostile Ships, 1 Hostile Population') read back as { kind: count } through a word table; a part that is not a figure followed by an entry of the table fails the read.
const countsOf = (separator, words, text, label) => {
  assert.ok(typeof text === 'string' && text.length > 0, `${label}: nothing is shown`)

  const counts = {}

  text.split(', ').forEach((part) => {
    const match = new RegExp(`^([-+\\u2212]?(?:\\d{1,3}(?:${escapeRegex(separator)}\\d{3})+|\\d+)) (.+)$`).exec(part)

    assert.ok(match, `${label}: "${part}" is no figure followed by words`)

    const kind = words.get(match[2])

    assert.ok(kind !== undefined, `${label}: "${match[2]}" is in no entry of the word table`)
    assert.ok(counts[kind] === undefined, `${label}: ${kind} is counted twice in "${text}"`)
    counts[kind] = figureOf(separator, match[1], label)
  })

  return counts
}

const sortedEntries = (record) => Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

// The flyout line's count of the systems with intruders, read back through its word table with `separator` grouping the figures: the line for none, or the figure of the intruders' entry (0 when the line has no such part).
const peekCount = (ctx, separator, line, label) => {
  if (line === ctx.peeks.WARNINGS_PEEK_WORDS.none) {
    return 0
  }

  const counted = Object.fromEntries(Object.entries(ctx.peeks.WARNINGS_PEEK_WORDS).filter(([kind]) => kind !== 'none'))
  const counts = countsOf(separator, wordsOf(counted, label), line, label)

  return counts.intruders === undefined ? 0 : counts.intruders
}

// ---------- what the warning gave, as a player reads it ----------

const textOf = (cell) => (cell !== null && typeof cell === 'object' ? cell.text : cell)

// The inputs a row names as missing, read back to their kinds through the module's table of them.
const missingKinds = (ctx, result, label) => {
  if (!result) {
    return []
  }

  const words = wordsOf(ctx.space.OPEN_INPUTS, 'the inputs counted apart')

  return result.inputs.missing.map((name) => {
    assert.ok(words.has(name), `${label}: the missing input "${name}" is in no entry of the table of inputs`)

    return words.get(name)
  }).sort()
}

// The line under a system that names each empire with contacts there, read back as [{ name, counts, hostile }]: the empires are parted by '; ' and the parts of each by ' — ' (the name, which may itself hold ' — ', then the counts, then the hostile mark of RACE_WORDS when there is one); the counts are read through the word table of the counts, as the words of a type whatever the standing, and the module's word for an empire whose name is not stored reads as no name (null). A part that reads as none of these fails the read.
const racesOf = (ctx, separator, text, label) => {
  assert.ok(typeof text === 'string' && text.length > 0, `${label}: no empire is named`)

  return text.split('; ').map((part) => {
    const pieces = part.split(' — ')
    const hostile = pieces.length > 2 && pieces[pieces.length - 1] === ctx.space.RACE_WORDS.hostile
    const named = pieces.length - (hostile ? 2 : 1)
    const name = pieces.slice(0, named).join(' — ')

    assert.ok(named > 0 && name.length > 0, `${label}: "${part}" names no empire`)

    const counts = Object.fromEntries(Object.entries(countsOf(separator, ctx.words, pieces[named], `${label}: the contacts of "${name}"`)).map(([kind, count]) => {
      assert.ok(kind.startsWith('neutral '), `${label}: the contacts of "${name}" are counted as ${kind}, not by type`)

      return [kind.slice('neutral '.length), count]
    }))

    return { name: name === ctx.space.RACE_WORDS.unnamed ? null : name, counts, hostile }
  })
}

// A stored text as a page shows it: runs of white space drawn as one space, none at the ends (a save stores some empire names with a leading space).
const asShown = (text) => text.replace(/\s+/g, ' ').trim()

// The empires a row names against those expected, by the id of each: a name shown stands for the empire whose stored name reads as it (through `shown`: as stored for the rows the module returns, `asShown` for the page) among those with contacts in the system (no name for the one whose name is not stored), so a name that no such empire has, or two of them named alike, fail; then each empire's contacts by type and its hostile mark are compared with its own.
const expectRaces = (seen, want, label, shown = (name) => name) => {
  const byName = new Map()

  Object.entries(want).forEach(([id, race]) => {
    const name = race.name === null ? null : shown(race.name)

    assert.ok(!byName.has(name), `${label}: the empires ${byName.get(name)} and ${id} are both named "${name}", so the line cannot tell them apart`)
    byName.set(name, id)
  })

  const named = {}

  seen.forEach((race) => {
    const id = byName.get(race.name)

    assert.ok(id !== undefined, `${label}: "${race.name}" is named, which is no empire with contacts there (${[...byName.keys()].join(', ')})`)
    assert.ok(!named[id], `${label}: the empire ${id} is named twice`)
    named[id] = { counts: sortedEntries(race.counts), hostile: race.hostile }
  })

  assert.deepEqual(Object.keys(named).sort(), Object.keys(want).sort(), `${label}: the empires named`)
  Object.entries(want).forEach(([id, race]) => assert.deepEqual(named[id], { counts: sortedEntries(race.counts), hostile: race.hostile }, `${label}: the contacts and the hostile mark of the empire ${id} (${race.name})`))
}

// The place a row's link must open: the Galaxy Map on the row's system, by the id the row is keyed by.
const linkFor = (id) => ({ path: '/map', system: id.slice('system:'.length) })

// The rows of the warning by id: { state, name, counts, missing, tone, races, link }.
const rowsSeen = (ctx, rows) => Object.fromEntries(rows.map((row) => {
  const label = `the row ${row.id}`

  return [row.id, { state: row.unevaluated ? 'unevaluated' : 'warning', name: textOf(row.cells.system), counts: countsOf(SEPARATOR, ctx.words, textOf(row.cells.contacts), `the contacts of ${label}`), missing: missingKinds(ctx, row.unevaluated || row.cells.contacts.result, label), tone: row.cells.contacts.tone || null, races: racesOf(ctx, SEPARATOR, row.caption, `the empires of ${label}`), link: row.link ? { path: row.link.path, system: row.link.query ? row.link.query.system : undefined } : null }]
}))

const expectRow = (seen, id, want, label) => {
  const got = seen[id]

  assert.ok(got, `${label}: ${id} is not listed (listed: ${Object.keys(seen).join(', ') || 'none'})`)
  assert.equal(got.state, want.state, `${label}: ${id} is listed as ${got.state}, not ${want.state}`)
  assert.equal(got.name, want.name, `${label}: the name of ${id}`)
  assert.deepEqual(sortedEntries(got.counts), sortedEntries(want.counts), `${label}: the contacts counted in ${id}`)
  assert.deepEqual(got.missing, [...want.missing].sort(), `${label}: the inputs ${id} names as missing`)
  expectRaces(got.races, want.races, `${label}: the empires named under ${id}`)
  assert.deepEqual(got.link, linkFor(id), `${label}: the place the link of ${id} opens`)
}

const expectAbsent = (seen, ids, label) => ids.forEach((id) => assert.ok(!seen[id], `${label}: ${id} is listed (${JSON.stringify(seen[id])})`))

// ---------- the fixtures ----------

const DAY = 86400
const YEAR = 31536000
const NOW = 2000000000
const SUB_PULSE = 5

// [AlienRaceID, name, ContactStatus] as race 1 sees them: hostile (0), neutral (1), not stored, allied (3), friendly (2).
const ALIENS = [[2, 'Khanate', 0], [3, 'League', 1], [4, 'Clade', null], [5, 'Union', 3], [6, 'Compact', 2]]
const SYSTEMS = [[10, 'Current'], [11, 'Faded'], [12, 'Boundary'], [13, 'Colony'], [14, 'Unknown'], [15, 'Mixed'], [16, 'Allied'], [17, 'Departed'], [19, 'Gone Unknown'], [20, 'Untimed']]
// [SystemID, ContactRaceID, ContactType, ContactID, ContactMethod, LastUpdate]: tracks of game 1 detected by race 1, in this order.
const TRACKS = [
  [10, 2, 1, 101, 1, NOW], [10, 2, 1, 101, 2, NOW - 3 * DAY], [10, 2, 1, 102, 3, NOW], [10, 2, 1, 103, 2, null], [10, 2, 1, 103, 1, NOW], [10, 2, 1, 104, 1, NOW], [10, 2, 1, 104, 2, null],
  [17, 2, 1, 101, 2, NOW - 10 * DAY],
  [11, 2, 1, 111, 2, NOW - 200 * DAY], [11, 2, 3, 112, 1, NOW - 30 * DAY], [11, 2, 4, 4501, 2, NOW - 300 * DAY], [11, 2, 4, 4501, 4, NOW - 300 * DAY],
  [12, 2, 1, 121, 1, NOW - SUB_PULSE], [12, 3, 4, 4503, 2, NOW - SUB_PULSE], [12, 2, 1, 123, 2, NOW - YEAR],
  [13, 3, 4, 4502, 2, NOW], [13, 3, 4, 4502, 4, NOW], [13, 3, 12, 4502, 1, NOW], [13, 3, 14, 4502, 1, NOW], [13, 3, 16, 4502, 1, NOW - 40 * DAY], [13, 2, 1, 4502, 1, NOW],
  [14, 4, 1, 141, 1, NOW],
  [15, 2, 1, 151, 1, NOW], [15, 4, 1, 152, 2, NOW],
  [16, 5, 1, 161, 1, NOW], [16, 6, 1, 162, 1, NOW],
  [19, 4, 1, 142, 1, NOW - 50 * DAY],
  [20, 2, 1, 171, 2, null],
]
// Game 2 stores no game time: race 7 holds a track of a hostile empire, 8, in system 30.
const CLOCKLESS = { GameID: 2, RaceID: 7, system: [30, 'Clockless'], alien: [8, 'Horde', 0], track: [30, 8, 1, 301, 1, 5000] }

// The empires a row must name, by id: { name, counts by type, hostile }.
const KHANATE = (Ship) => ({ name: 'Khanate', counts: { Ship }, hostile: true })
const CLADE = { name: 'Clade', counts: { Ship: 1 }, hostile: false }

// What the warning must list on the fixtures, by row id; every other system of the fixtures must be absent. Systems 13 and 15 hold contacts of two empires each: in 13 a neutral one with a colony and its ground units beside a hostile ship, in 15 a hostile ship beside one of an empire of unknown standing.
const FIXTURE = {
  'system:10': { state: 'warning', name: 'Current', counts: { 'hostile Ship': 4 }, missing: [], races: { 2: KHANATE(4) } },
  'system:13': { state: 'warning', name: 'Colony', counts: { 'hostile Ship': 1, 'neutral Population': 1, 'neutral GroundUnit': 1 }, missing: [], races: { 2: KHANATE(1), 3: { name: 'League', counts: { Population: 1, GroundUnit: 1 }, hostile: false } } },
  'system:14': { state: 'unevaluated', name: 'Unknown', counts: { standing: 1 }, missing: ['standing'], races: { 4: CLADE } },
  'system:15': { state: 'warning', name: 'Mixed', counts: { 'hostile Ship': 1, standing: 1 }, missing: ['standing'], races: { 2: KHANATE(1), 4: CLADE } },
  'system:20': { state: 'unevaluated', name: 'Untimed', counts: { detection: 1 }, missing: ['detection'], races: { 2: KHANATE(1) } },
  'system:30': { state: 'unevaluated', name: 'Clockless', counts: { clock: 1 }, missing: ['clock'], races: { 8: { name: 'Horde', counts: { Ship: 1 }, hostile: true } } },
}

const sqlValue = (value) => (value === null ? 'null' : typeof value === 'string' ? `'${value.replace(/'/g, '\'\'')}'` : String(value))
const insert = (table, record) => `insert into ${table} (${Object.keys(record).join(', ')}) values (${Object.values(record).map(sqlValue).join(', ')});`

const fixtureSql = () => [
  'create table FCT_Game (GameID integer, GameTime real);',
  'create table FCT_RaceSysSurvey (GameID integer, SystemID integer, RaceID integer, Name text);',
  'create table FCT_AlienRace (GameID integer, AlienRaceID integer, ViewRaceID integer, AlienRaceName text, ContactStatus integer);',
  'create table FCT_Contacts (UniqueID integer primary key, GameID integer, SystemID integer, DetectRaceID integer, ContactRaceID integer, ContactType integer, ContactID integer, ContactMethod integer, LastUpdate real);',
  'create table FCT_Ship (GameID integer, RaceID integer, ShipID integer, ShippingLineID integer);',
  'create table FCT_DamagedComponent (ShipID integer, ComponentID integer);',
  'create table FCT_ShipDesignComponents (SDComponentID integer);',
  insert('FCT_Game', { GameID: 1, GameTime: NOW }),
  insert('FCT_Game', { GameID: 2, GameTime: null }),
  ...ALIENS.map(([AlienRaceID, AlienRaceName, ContactStatus]) => insert('FCT_AlienRace', { GameID: 1, AlienRaceID, ViewRaceID: 1, AlienRaceName, ContactStatus })),
  ...SYSTEMS.map(([SystemID, Name]) => insert('FCT_RaceSysSurvey', { GameID: 1, SystemID, RaceID: 1, Name })),
  ...TRACKS.map(([SystemID, ContactRaceID, ContactType, ContactID, ContactMethod, LastUpdate]) => insert('FCT_Contacts', { GameID: 1, SystemID, DetectRaceID: 1, ContactRaceID, ContactType, ContactID, ContactMethod, LastUpdate })),
  insert('FCT_AlienRace', { GameID: 2, AlienRaceID: CLOCKLESS.alien[0], ViewRaceID: CLOCKLESS.RaceID, AlienRaceName: CLOCKLESS.alien[1], ContactStatus: CLOCKLESS.alien[2] }),
  insert('FCT_RaceSysSurvey', { GameID: 2, SystemID: CLOCKLESS.system[0], RaceID: CLOCKLESS.RaceID, Name: CLOCKLESS.system[1] }),
  insert('FCT_Contacts', { GameID: 2, SystemID: CLOCKLESS.track[0], DetectRaceID: CLOCKLESS.RaceID, ContactRaceID: CLOCKLESS.track[1], ContactType: CLOCKLESS.track[2], ContactID: CLOCKLESS.track[3], ContactMethod: CLOCKLESS.track[4], LastUpdate: CLOCKLESS.track[5] }),
].join('\n')

const allRows = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))

// A stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does.
const standIn = (raw) => ({ query: async (sql) => [await allRows(raw, sql)], close: () => new Promise((resolve) => raw.close(() => resolve())) })

const openFixture = () => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(':memory:', (error) => {
    if (error) {
      reject(error)

      return
    }

    raw.exec(fixtureSql(), (failure) => (failure ? reject(failure) : resolve(standIn(raw))))
  })
})

// ---------- the saves ----------

const SAVES = [
  { id: 'save-modded', file: 'AuroraDB.db', GameID: 140, RaceID: 784 },
  { id: 'save-egg', file: 'saves/AuroraDB.db', GameID: 138, RaceID: 785, lost: true },
  { id: 'save-stock', file: 'saves/AuroraDB_271_skoormit_saved.db', GameID: 138, RaceID: 785 },
]

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(standIn(raw))))
})

// What the warning must list on a save, in SQL written here from the game's rules (the evidence of FU-40 cites them): one contact for each subject of a type in a system (ContactType 1 a ship, 3 a salvo, 4 a colony, 12 and 14 the ground units of a colony, 16 a shipyard), held when one of its tracks carries the game time, lost when every track carries an earlier one, and not known when none is current and one has no time or the game has none; empires stored as friendly (2) or allied (3) are left out. A system with a held contact of an empire of known standing is a warning; one with only contacts that are not known is not evaluated; one with only lost contacts is not listed. Each system names every empire with a contact there that is not lost, by its id: its stored name, its contacts by type and whether it is stored as hostile (0). Also the systems the warning listed before it read the time at all.
const oracleOf = async (database, GameID, RaceID) => {
  const rows = (await database.query(`select c.SystemID as systemId, s.Name as name, a.ContactStatus as status, c.ContactRaceID as raceId, a.AlienRaceName as raceName, case c.ContactType when 1 then 'Ship' when 3 then 'Salvo' when 4 then 'Population' when 12 then 'GroundUnit' when 14 then 'GroundUnit' when 16 then 'Shipyard' end as type, c.ContactID as contactId, max(c.LastUpdate = g.GameTime) as current, coalesce(sum(c.LastUpdate = g.GameTime), 0) as currentTracks, sum(c.LastUpdate is null) as untimed, max(g.GameTime is null) as clockless, count(*) as tracks from FCT_Contacts c inner join FCT_RaceSysSurvey s on s.SystemID = c.SystemID and s.RaceID = ${RaceID} inner join FCT_AlienRace a on a.AlienRaceID = c.ContactRaceID and a.ViewRaceID = ${RaceID} left join FCT_Game g on g.GameID = c.GameID where c.GameID = ${GameID} and c.DetectRaceID = ${RaceID} and c.ContactRaceID != ${RaceID} and c.ContactType in (1, 3, 4, 12, 14, 16) and (a.ContactStatus is null or a.ContactStatus not in (2, 3)) group by c.SystemID, type, c.ContactID`))[0]
  const systems = {}
  const before = new Set()
  let tracks = 0
  let currentTracks = 0
  let contacts = 0

  rows.forEach((row) => {
    before.add(row.systemId)
    tracks += row.tracks

    const state = row.current === 1 ? 'held' : row.untimed > 0 || row.clockless === 1 ? 'open' : 'lost'

    if (state === 'lost') {
      return
    }

    currentTracks += row.currentTracks
    contacts += 1

    const id = `system:${row.systemId}`
    const missing = [...(row.status === null ? ['standing'] : []), ...(state === 'held' ? [] : [row.clockless === 1 ? 'clock' : 'detection'])]
    const kind = missing.length ? missing[0] : `${row.status === 0 ? 'hostile' : 'neutral'} ${row.type}`
    const system = systems[id] = systems[id] || { name: row.name, counts: {}, missing: new Set(), known: false, races: {} }
    const race = system.races[row.raceId] = system.races[row.raceId] || { name: row.raceName, counts: {}, hostile: row.status === 0 }

    race.counts[row.type] = (race.counts[row.type] || 0) + 1

    system.counts[kind] = (system.counts[kind] || 0) + 1
    missing.forEach((name) => system.missing.add(name))
    system.known = system.known || !missing.length
  })

  const expected = Object.fromEntries(Object.entries(systems).map(([id, system]) => [id, { state: system.known ? 'warning' : 'unevaluated', name: system.name, counts: system.counts, missing: [...system.missing], races: system.races }]))

  return { expected, before: before.size, tracks, currentTracks, contacts, warnings: Object.values(expected).filter((row) => row.state === 'warning').length }
}

// ---------- the page in a browser ----------

const BROWSER = { save: SAVES[1], game: 'EggSample', race: 'EggSample', route: '/warnings?check=intruders', path: '/warnings', check: 'intruders', read: 'readIntruders' }
const BROWSER_TIMEOUT = 120000

// What the page on screen shows of the check, and the line the open section flyout shows under the page; runs in the page. Hooks identify the elements (data attributes, and the flyout's item marked as the page on screen); what they say is read only from text nodes whose own element is shown (not hidden, not drawn with no opacity, by itself or by an ancestor), never from a container's `textContent`. A row's link is the address of the link shown among the row's actions, the place a click opens. Each row carries the group of the separator line above it: none for the warnings, `snoozed` or `unevaluated` for those listed apart.
const readScreen = (check) => {
  const shows = (element) => element.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true })
  const visible = (element) => {
    const box = element.getBoundingClientRect()

    return shows(element) && box.width > 0 && box.height > 0
  }
  const visibleText = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text = ''

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && shows(node.parentElement)) {
        text += node.textContent
      }
    }

    return text
  }
  const words = (element) => (element && visible(element) ? visibleText(element).replace(/\s+/g, ' ').trim() : undefined)
  const vm = window.$app.$route.matched[0].instances.default
  const section = document.querySelector(`[data-check="${check}"]`)
  const rows = []
  const separators = []
  const hidden = []
  let group = 'listed'

  if (section) {
    section.querySelectorAll('tbody > tr').forEach((row) => {
      const separator = row.getAttribute('data-separator')

      if (separator !== null) {
        group = separator

        if (visible(row)) {
          separators.push({ kind: separator })
        }

        return
      }

      const id = row.getAttribute('data-row')

      if (id === null) {
        return
      }

      if (!visible(row)) {
        hidden.push(id)

        return
      }

      const link = row.querySelector('td.row-actions a[href]')

      rows.push({ id, group, system: words(row.querySelector('[data-cell="system"]')), contacts: words(row.querySelector('[data-cell="contacts"]')), caption: words(row.querySelector('[data-caption]')), link: link && visible(link) ? link.getAttribute('href') : undefined })
    })
  }

  const item = document.querySelector('.section-flyout__item--active')
  const flyout = item ? { name: words(item.querySelector('.section-flyout__name')), peek: words(item.querySelector('.section-flyout__peek')) } : null

  return { separator: vm.separator, section: Boolean(section) && visible(section), rows, separators, hidden, title: words(document.querySelector('.breadcrumb__title')), flyout }
}

// Whether the page instance `uid` has its read of the check settled, on the copy of the save the app holds now, and every other read of its own too, so nothing it shows of the check waits on another.
const settledOn = ({ uid, key }) => {
  const match = window.$app.$route.matched[0]
  const vm = match && match.instances.default

  if (!vm || vm._uid !== uid || vm.loadErrors[key] === undefined || !vm.ready) {
    return false
  }

  const freshness = window.$app.$store.state.freshness
  const record = (freshness.inputs[window.$app.$route.path] || {})[key]

  return vm.loadErrors[key] !== null || Boolean(record && record.generation === freshness.generation)
}

// Whether the line of the section flyout under `route` has settled for the game, race and history revision the app shows now: its read finished (a line, or null when it failed) under the key the store gives that read, and the line, when there is one, has finished fading in on the flyout's item marked as the page on screen.
const peekSettled = (route) => {
  const store = window.$app.$store
  const { key, lines } = store.state.peeks
  const own = `${store.state.GameID}:${store.state.RaceID}:${store.state.history.revision}`

  if (!key || key.split(':').slice(1, 4).join(':') !== own || !(route in lines)) {
    return false
  }

  const span = document.querySelector('.section-flyout__item--active .section-flyout__peek > span')

  return !lines[route] || (Boolean(span) && !/(^|\s)peek-fade-/.test(span.className))
}

// The page as a player opens it: the game and race picked, the Warnings page opened on the check, and once the page's own read of the check has settled, the page's section hovered in the rail until the flyout's line under the page has settled; then the screen is read. Resolves to the record of `observe` (scripts/lib/browser-observe.js) with the value of `readScreen`.
const observePage = (browser, url) => observe(browser, async ({ page, step }) => {
  step('opening the app')
  await page.goto(url, { timeout: BROWSER_TIMEOUT })

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${BROWSER.game} ·` }).first().click({ timeout: BROWSER_TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(BROWSER.race, { exact: true }).last().click({ timeout: BROWSER_TIMEOUT })
  }

  step('waiting for the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: BROWSER_TIMEOUT })
  step(`opening ${BROWSER.route}`)
  await page.evaluate((to) => window.$app.$router.push(to, () => {}, () => {}), BROWSER.route)
  await page.waitForFunction(pageLoading.arrived, BROWSER.route, { timeout: BROWSER_TIMEOUT })

  const uid = await page.evaluate(() => window.$app.$route.matched[0].instances.default._uid)

  step('waiting for the page\'s read of the check')
  await page.waitForFunction(settledOn, { uid, key: BROWSER.read }, { timeout: BROWSER_TIMEOUT })
  await page.evaluate(async () => { await window.$app.$nextTick() })
  step('hovering the page\'s section in the rail')
  await page.locator('.rail__item--active').first().hover({ timeout: BROWSER_TIMEOUT })
  step('waiting for the flyout\'s line under the page')
  await page.waitForFunction(peekSettled, BROWSER.path, { timeout: BROWSER_TIMEOUT })
  step('reading the screen')

  return page.evaluate(readScreen, BROWSER.check)
})

// ---------- the checks ----------

// A check: `run(ctx)` returns to pass and throws (assert) to fail. Who failed: scripts/lib/fault-credit.js. The code under test runs only through `through`.
const results = []
const add = (id, name, run) => results.push({ id, name, run })

const fixtureRows = (ctx) => ctx.fixtureRows()

add('current', 'a contact with a track at the game time is listed in its system, once whatever the number of its tracks (a lost one, or one with no stored time, beside a current one), as a hostile ship, with the hostile tone', async (ctx) => {
  const seen = rowsSeen(ctx, await fixtureRows(ctx))

  expectRow(seen, 'system:10', FIXTURE['system:10'], 'the contacts held now')
  assert.equal(seen['system:10'].tone, 'error', 'the contacts of a system with a hostile contact take the hostile tone')
})

add('long-ago', 'a system whose contacts were all last detected long ago (ships, a salvo, a colony, the old track of a ship that moved on) is not listed', async (ctx) => {
  expectAbsent(rowsSeen(ctx, await fixtureRows(ctx)), ['system:11', 'system:17'], 'the contacts last detected long ago')
})

add('boundary', 'a contact last detected one sub-pulse before the game time, or exactly a year before it, is lost and its system is not listed', async (ctx) => {
  expectAbsent(rowsSeen(ctx, await fixtureRows(ctx)), ['system:12'], 'the contacts lost at the boundary')
})

add('population', 'a colony held now is one colony whatever its tracks, its ground units of both kinds are one ground unit contact, its shipyard last detected long ago is not counted, a ship with the colony\'s id is counted apart, and a colony last detected long ago is not listed', async (ctx) => {
  const seen = rowsSeen(ctx, await fixtureRows(ctx))

  expectRow(seen, 'system:13', FIXTURE['system:13'], 'the colony held now')
  expectAbsent(seen, ['system:11'], 'the colony last detected long ago')
})

add('unknown-standing', 'a held contact of an empire with no stored standing leaves a system with nothing else not evaluated and names the standing, is counted apart and named beside a known intruder, and is not listed once lost', async (ctx) => {
  const seen = rowsSeen(ctx, await fixtureRows(ctx))

  expectRow(seen, 'system:14', FIXTURE['system:14'], 'the contact of unknown standing alone')
  expectRow(seen, 'system:15', FIXTURE['system:15'], 'the contact of unknown standing beside a hostile one')
  expectAbsent(seen, ['system:19'], 'the lost contact of unknown standing')
})

add('allied', 'the held contacts of allied and friendly empires are not listed', async (ctx) => {
  expectAbsent(rowsSeen(ctx, await fixtureRows(ctx)), ['system:16'], 'the allied and friendly contacts')
})

add('races', 'each empire with contacts in a listed system is named under it by its stored name, with its own contacts by type and the hostile mark only when it is hostile; two empires in one system keep their own figures, and the row\'s link opens the Galaxy Map on the system', async (ctx) => {
  const seen = rowsSeen(ctx, await fixtureRows(ctx))

  Object.entries(FIXTURE).filter(([id]) => id !== 'system:30').forEach(([id, want]) => {
    assert.ok(seen[id], `${id} is not listed`)
    expectRaces(seen[id].races, want.races, `the empires named under ${id}`)
    assert.deepEqual(seen[id].link, linkFor(id), `the place the link of ${id} opens`)
  })
})

// The rows of the fixtures of game 1, in the order of the ids of their systems.
const FIXTURE_ORDER = ['system:10', 'system:13', 'system:14', 'system:15', 'system:20']

add('order', 'the systems are listed in the order of their ids, the ones not evaluated among them (the page sets those apart)', async (ctx) => {
  assert.deepEqual((await fixtureRows(ctx)).map((row) => row.id), FIXTURE_ORDER, 'the order of the systems listed')
})

add('unknown-time', 'a contact whose only track has no stored time, and a contact of a game whose time is not stored, leave their systems not evaluated and name the input, never a clean zero', async (ctx) => {
  expectRow(rowsSeen(ctx, await fixtureRows(ctx)), 'system:20', FIXTURE['system:20'], 'the contact with no stored time')
  expectRow(rowsSeen(ctx, await ctx.clocklessRows()), 'system:30', FIXTURE['system:30'], 'the contact of a game with no stored time')
})

add('peek-fixture', 'the flyout line counts the systems the warning lists as warnings: not those listed apart, not those whose contacts are lost', async (ctx) => {
  const warnings = Object.values(FIXTURE).filter((row) => row.state === 'warning').length
  const seen = rowsSeen(ctx, await fixtureRows(ctx))

  assert.equal(peekCount(ctx, SEPARATOR, await ctx.peekLine(ctx.fixture, 1, 1), 'the flyout line of the fixtures'), warnings, 'the flyout line of the fixtures')
  assert.equal(Object.values(seen).filter((row) => row.state === 'warning').length, warnings, 'the warnings the rule lists on the fixtures')
  assert.equal(peekCount(ctx, SEPARATOR, await ctx.peekLine(ctx.fixture, CLOCKLESS.GameID, CLOCKLESS.RaceID), 'the flyout line of the game with no time'), 0, 'the flyout line of the game with no stored time')
})

add('structure', 'the registered rule of the warning names the stored values it decides on: the contact\'s type, subject, empire, system and time, the game time and the standing', (ctx) => {
  const rule = ctx.provenance.getRule('warnings.intruders')
  const named = new Set(rule.structure.flatMap((entry) => {
    const [table, columns] = entry.split('.')

    return columns.split(',').map((column) => `${table}.${column.trim()}`)
  }))

  ;['FCT_Contacts.ContactType', 'FCT_Contacts.ContactID', 'FCT_Contacts.ContactRaceID', 'FCT_Contacts.SystemID', 'FCT_Contacts.LastUpdate', 'FCT_Game.GameTime', 'FCT_AlienRace.ContactStatus'].forEach((column) => assert.ok(named.has(column), `the rule's structure does not name ${column}`))
})

const FIRST_OR_SECOND_PERSON = /\b(?:I|me|my|mine|you|your|yours|we|us|our|ours)\b/i

add('voice', 'the rule, its note and the words of the counts, of the empires and of the flyout line speak in no first or second person', (ctx) => {
  const rule = ctx.provenance.getRule('warnings.intruders')
  const check = ctx.check
  const texts = [check.rule, rule.note, ...Object.values(ctx.space.CONTACT_WORDS).flat(), ...Object.values(ctx.space.OPEN_INPUTS), ...Object.values(ctx.space.RACE_WORDS), ...Object.values(ctx.peeks.WARNINGS_PEEK_WORDS).flat()]

  texts.forEach((text) => assert.ok(!FIRST_OR_SECOND_PERSON.test(text), `"${text}" speaks in the first or second person`))
})

SAVES.forEach((save, index) => {
  add(save.id, `${save.file} (game ${save.GameID}, race ${save.RaceID}): every row of the warning, by system, its state, name, counts, missing inputs, the empires it names (by id: name, contacts by type, hostile mark) and the place its link opens, agrees with SQL written here, and the flyout line counts its warnings${save.lost ? '; the save holds systems whose contacts are all lost' : ''}`, async (ctx) => {
    const database = ctx.saves[index]

    assert.ok(database, `${save.file} is not there`)

    const oracle = ctx.oracles[index]
    const seen = rowsSeen(ctx, await ctx.saveRows(index))

    assert.deepEqual(Object.keys(seen).sort(), Object.keys(oracle.expected).sort(), 'the systems listed')
    Object.entries(oracle.expected).forEach(([id, want]) => expectRow(seen, id, want, save.file))
    assert.equal(peekCount(ctx, SEPARATOR, await ctx.peekLine(database, save.GameID, save.RaceID), `the flyout line on ${save.file}`), oracle.warnings, `the flyout line on ${save.file}`)

    if (save.lost) {
      assert.ok(oracle.before > Object.keys(oracle.expected).length, `${save.file} holds no system whose contacts are all lost, so it does not show the defect`)
    }
  })
})

// The screen of the variant under judgement, or a failure of the check that names why there is none.
const screenOf = (ctx) => {
  assert.ok(ctx.browser && ctx.browser.value !== null && !unobserved(ctx.browser), `the page did not get through: ${ctx.browser && ctx.browser.error}`)

  return ctx.browser.value
}

add('page-rows', 'the Warnings page shows the rows of the check as SQL says: each system by its id, under the line of its group, with its name, its contacts read back through the word table, the line naming each empire there, compared by the id of the empire (its name, its contacts by type, its hostile mark), and a link that opens the Galaxy Map on the system', (ctx) => {
  const screen = screenOf(ctx)
  const oracle = ctx.oracles[SAVES.indexOf(BROWSER.save)]
  const expected = oracle.expected
  const shown = Object.fromEntries(screen.rows.map((row) => [row.id, row]))

  assert.ok(screen.section, 'the section of the check is not shown')
  assert.deepEqual(screen.hidden, [], 'rows of the check are there but cannot be seen')
  assert.deepEqual(Object.keys(shown).sort(), Object.keys(expected).sort(), 'the systems shown')
  assert.equal(screen.rows.length, Object.keys(shown).length, 'a system is shown twice')
  Object.entries(expected).forEach(([id, want]) => {
    const row = shown[id]

    assert.equal(row.group, want.state === 'warning' ? 'listed' : 'unevaluated', `the group ${id} is shown under`)
    assert.equal(row.system, asShown(want.name), `the name shown for ${id}`)
    assert.deepEqual(sortedEntries(countsOf(screen.separator, ctx.words, row.contacts, `the contacts shown for ${id}`)), sortedEntries(want.counts), `the contacts shown for ${id}`)
    expectRaces(racesOf(ctx, screen.separator, row.caption, `the empires shown under ${id}`), want.races, `the empires shown under ${id}`, asShown)
    assert.ok(row.link, `no link is shown for ${id}`)

    const target = new URL(row.link.replace(/^#/, ''), 'http://page/')

    assert.deepEqual({ path: target.pathname, system: target.searchParams.get('system') }, linkFor(id), `the place the link shown for ${id} opens ("${row.link}")`)
  })

  const apart = Object.values(expected).some((row) => row.state === 'unevaluated')

  assert.equal(screen.separators.some((separator) => separator.kind === 'unevaluated'), apart, apart ? 'the line over the rows not evaluated is not shown' : 'a line of rows not evaluated is shown')
})

add('page-peek', 'the line the section flyout shows under the Warnings page, its section hovered in the rail, counts as many systems with intruders as the page shows warnings, on a save that holds lost contacts', (ctx) => {
  const screen = screenOf(ctx)

  assert.ok(screen.flyout, 'the flyout shows no item marked as the page on screen')
  assert.equal(screen.flyout.name, screen.title, 'the item of the flyout marked as the page on screen names another page')
  assert.ok(screen.flyout.peek, 'the flyout shows no line under the page')
  assert.equal(peekCount(ctx, screen.separator, screen.flyout.peek, 'the flyout line'), screen.rows.filter((row) => row.group === 'listed').length, `the flyout line "${screen.flyout.peek}" against the warnings the page shows`)
})

// ---------- the faults and the rewrites ----------

// [name, file key, from, to, the ids of the checks one of which must fail (a fault), browser (served to the browser and the page read again)]. Anchors are code, keys and attributes.
/* eslint-disable no-template-curly-in-string */
const MUTANTS = [
  ['every stored contact is held, a lost one included', 'contacts', '\'FCT_Contacts.LastUpdate = FCT_Game.GameTime\'', '\'FCT_Contacts.LastUpdate <= FCT_Game.GameTime\'', ['long-ago', 'boundary', 'population', 'unknown-standing', 'save-egg', 'page-rows'], true],
  ['a contact lost one sub-pulse before the game time is held', 'contacts', '\'FCT_Contacts.LastUpdate = FCT_Game.GameTime\'', '\'FCT_Contacts.LastUpdate >= FCT_Game.GameTime - 5\'', ['boundary']],
  ['the rule reads every stored contact', 'space', ' and (${HELD_CONTACT}) is not 0`', '`', ['long-ago', 'boundary', 'population', 'save-egg', 'page-rows'], true],
  ['a contact with no stored time reads as held', 'space', 'contact.Held === 1 ? [] :', 'contact.Held !== 0 ? [] :', ['unknown-time']],
  ['a game time that is not stored leaves every contact out', 'space', ' and (${HELD_CONTACT}) is not 0`', ' and (${HELD_CONTACT}) = 1`', ['unknown-time']],
  ['a ship and a colony that share an id are one contact', 'space', 'const key = `${track.SystemID}:${type}:${track.ContactID}`', 'const key = `${track.SystemID}:${track.ContactID}`', ['population']],
  ['each track of a contact is a contact of its own', 'space', 'const key = `${track.SystemID}:${type}:${track.ContactID}`', 'const key = `${track.SystemID}:${type}:${track.ContactID}:${contacts.size}`', ['current', 'population']],
  ['a contact is held as its first track is', 'space', 'Held: anyOf(kept.Held, track.Held)', 'Held: kept.Held', ['current']],
  ['the systems are listed the other way round', 'space', 'verdictRows(ctx, Object.values(systems), {', 'verdictRows(ctx, Object.values(systems).reverse(), {', ['order']],
  ['a friendly empire is counted', 'space', 'if ([2, 3].includes(contact.ContactStatus)) {', 'if ([3].includes(contact.ContactStatus)) {', ['allied']],
  ['a contact of unknown standing is counted as known', 'space', 'isKnownNumber(contact.ContactStatus) ? [] : [\'standing\']', '[]', ['unknown-standing']],
  ['a neutral contact is told as a hostile one', 'space', 'contactCount(ctx, neutrals.length, `neutral ${type}`)', 'contactCount(ctx, neutrals.length, `hostile ${type}`)', ['population']],
  ['the rule\'s structure leaves out the time of a contact and the game time', 'space', '\'FCT_Contacts.ContactType, ContactID, ContactRaceID, SystemID, LastUpdate\', \'FCT_Game.GameTime\', ', '\'FCT_Contacts.ContactType, ContactID, ContactRaceID, SystemID\', ', ['structure']],
  ['the rule speaks to the player', 'space', 'rule: \'Another empire\\\'s ships, salvos', 'rule: \'Your rivals\\\' ships, salvos', ['voice']],
  ['the flyout line counts every stored contact', 'peeks', ' and ${HELD_CONTACT}) as IntruderSystems', ') as IntruderSystems', ['peek-fixture', 'save-egg', 'page-peek'], true],
  ['the flyout line counts a system whose contacts are of unknown standing', 'peeks', 'FCT_AlienRace.ContactStatus not in (2, 3) and ${HELD_CONTACT}', 'coalesce(FCT_AlienRace.ContactStatus, 0) not in (2, 3) and ${HELD_CONTACT}', ['peek-fixture']],
  ['an empire named by a name it does not have', 'space', '${Alien.AlienRaceName || RACE_WORDS.unnamed}', '${\'Wrong empire\'}', ['current', 'population', 'unknown-standing', 'unknown-time', 'races', 'save-egg', 'page-rows'], true],
  ['two empires of a system given each other\'s contacts', 'space', 'const intruderRaces = (ctx, races) => Object.values(races).map(({ Alien, Types }) => {', 'const intruderRaces = (ctx, races) => Object.values(races).map(({ Alien }, index, all) => { const { Types } = all[all.length - 1 - index]', ['population', 'races']],
  ['a neutral empire marked hostile', 'space', 'Alien.ContactStatus === HOSTILE ? ` — ${RACE_WORDS.hostile}`', '[0, 1].includes(Alien.ContactStatus) ? ` — ${RACE_WORDS.hostile}`', ['population', 'races']],
  ['the link of a row opens the map on the id of an empire', 'space', 'link: linkTo.map(system.SystemID),', 'link: linkTo.map(Object.keys(system.Races)[0]),', ['current', 'population', 'races', 'save-egg', 'page-rows'], true],
  ['a row of the check is hidden', 'page', ':data-row="row.id">', ':data-row="row.id" v-show="false">', ['page-rows', 'page-peek'], true],
  ['the check is drawn with no opacity', 'page', ':data-check="section.check.key">', ':data-check="section.check.key" style="opacity: 0">', ['page-rows'], true],
  ['the contacts cell shows the name of the row', 'page', ':data-cell="column.key">{{ cellText(row, column) }}</span><provenance-mark', ':data-cell="column.key">{{ cellText(row, section.check.columns[0]) }}</span><provenance-mark', ['page-rows'], true],
  ['the contacts are drawn by a child with no opacity', 'page', ':data-cell="column.key">{{ cellText(row, column) }}</span><provenance-mark', ':data-cell="column.key"><span style="opacity: 0">{{ cellText(row, column) }}</span></span><provenance-mark', ['page-rows'], true],
  ['the line naming the empires is drawn with no opacity', 'page', 'data-caption>', 'data-caption style="opacity: 0">', ['page-rows'], true],
  ['the table is put in a slot the table does not take', 'page', '<template #default>', '<template #defaultx>', ['page-rows'], true],
]
/* eslint-enable no-template-curly-in-string */

// Rewrites that change nothing the checks observe: each must leave every check passing.
/* eslint-disable no-template-curly-in-string */
const BENIGN = [
  ['an explicit prop and event instead of v-model on the muted switch', 'page', '<v-switch v-model="showMuted"', '<v-switch :input-value="showMuted" @change="showMuted = $event"', true],
  ['v-on longhand for the button of the other rows', 'page', '@click="toggleExpanded(section.check.key)"', 'v-on:click="toggleExpanded(section.check.key)"', true],
  ['a qualifier moved from the front to the back in a count', 'space', '\'hostile Ship\': [\'Hostile Ship\', \'Hostile Ships\']', '\'hostile Ship\': [\'Ship (hostile)\', \'Ships (hostile)\']', true],
  ['a synonym in a count', 'space', '\'hostile Population\': [\'Hostile Population\', \'Hostile Populations\']', '\'hostile Population\': [\'Hostile Colony\', \'Hostile Colonies\']', true],
  ['a synonym in the contacts counted apart', 'space', 'standing: [\'contact of unknown standing\', \'contacts of unknown standing\']', 'standing: [\'contact whose standing is not stored\', \'contacts whose standing is not stored\']', false],
  ['the words of the empires reworded in their table', 'space', 'RACE_WORDS = Object.freeze({ unnamed: \'An unknown empire\', hostile: \'Hostile\' })', 'RACE_WORDS = Object.freeze({ unnamed: \'An empire whose name is not stored\', hostile: \'At war\' })', true],
  ['the empires of a system named in another order', 'space', 'const intruderRaces = (ctx, races) => Object.values(races).map(({ Alien, Types }) => {', 'const intruderRaces = (ctx, races) => Object.values(races).reverse().map(({ Alien, Types }) => {', false],
  ['a synonym in the flyout line', 'peeks', 'intruders: [\'intruder system\', \'intruder systems\']', 'intruders: [\'system with intruders\', \'systems with intruders\']', true],
  ['a parenthesised condition in the query', 'space', ' and (${HELD_CONTACT}) is not 0`', ' and ((${HELD_CONTACT}) is not 0)`', true],
  ['a parenthesised condition in the standing test', 'space', 'if ([2, 3].includes(contact.ContactStatus)) {', 'if (([2, 3].includes(contact.ContactStatus))) {', false],
  ['the held condition written the other way round', 'contacts', '\'FCT_Contacts.LastUpdate = FCT_Game.GameTime\'', '\'FCT_Game.GameTime = FCT_Contacts.LastUpdate\'', true],
  ['full opacity on the cells of a row', 'page', '<td v-for="(column, index) in section.check.columns" :key="column.key"', '<td v-for="(column, index) in section.check.columns" :key="column.key" style="opacity: 1"', true],
  ['the column of a cell by its index', 'page', ':data-cell="column.key">{{ cellText(row, column) }}</span><provenance-mark', ':data-cell="column.key">{{ cellText(row, section.check.columns[index]) }}</span><provenance-mark', true],
  ['a row shown by an explicit v-show', 'page', ':data-row="row.id">', ':data-row="row.id" v-show="true">', true],
  ['full opacity on the check', 'page', ':data-check="section.check.key">', ':data-check="section.check.key" style="opacity: 1">', true],
  ['the table\'s slot named in longhand', 'page', '<template #default>', '<template v-slot:default>', true],
]
/* eslint-enable no-template-curly-in-string */

const cleanups = []

const finish = async (code) => {
  let failed = 0

  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failed++
      console.error(`cleanup failed: ${error && error.message ? error.message : error}`)
    }
  }

  process.exit(code || (failed ? 4 : 0))
}

const main = async () => {
  const only = argument('--only').split(',').filter(Boolean)
  const wanted = (kind, name = '') => only.length === 0 || (kind === 'control' ? only.includes('control') : only.some((text) => text !== 'control') && (name === '' || only.some((text) => name.includes(text))))
  const sources = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]))
  const texts = new Map()
  const loadedOf = (given) => loadUtilities(['provenance', 'warnings/common', 'warnings/space', 'peeks'], { stubs: STUBS, sources: { 'warnings/space': given.space, contacts: given.contacts, peeks: given.peeks }, texts })

  const fixture = await openFixture()

  cleanups.push(() => fixture.close())

  const saves = []
  const oracles = []

  for (const save of SAVES) {
    const database = await openSave(save.file)

    saves.push(database)
    oracles.push(database ? await oracleOf(database, save.GameID, save.RaceID) : null)

    if (database) {
      cleanups.push(() => database.close())
    }
  }

  let server = null
  let chrome = null
  let startFailure = null

  if (options.browser) {
    try {
      server = await startPageServer({ save: BROWSER.save.file })
      cleanups.push(() => server.stop())
      chrome = await require('playwright').chromium.launch()
      cleanups.push(() => chrome.close())
    } catch (error) {
      startFailure = String(error.message).split('\n')[0]
    }
  }

  const observeVariant = async (given) => {
    if (startFailure) {
      return failedObservation(startFailure)
    }

    const own = Object.keys(FILES).every((key) => given[key] === sources[key])

    Object.entries(FILES).forEach(([key, file]) => server.replace(file, given[key] === sources[key] ? null : given[key]))

    try {
      const seen = await observePage(chrome, server.url)

      report(own ? 'the page' : 'a variant of the page', seen)

      return seen
    } finally {
      Object.values(FILES).forEach((file) => server.replace(file, null))
    }
  }

  // The context of one variant of the sources: the modules as given, the reads they make of the fixtures and the saves, the oracles, and what the browser showed (`browser`).
  const contextOf = async (given, browser) => {
    const loaded = await loadedOf(given)
    const space = loaded['warnings/space']
    const check = space.checks.find((item) => item.key === 'intruders')

    if (!check) {
      throw new HarnessError('the module has no check keyed intruders')
    }

    const read = (database, GameID, RaceID) => through('the read of the intruders check', () => check.read({ database, GameID, RaceID, RaceNPR: false, separator: SEPARATOR, count: loaded['warnings/common'].counter(SEPARATOR), options: {} }))
    const peek = loaded.peeks
    const saveReads = new Map()
    const ctx = {
      space,
      check,
      peeks: peek,
      common: loaded['warnings/common'],
      provenance: loaded.provenance,
      words: null,
      fixture,
      saves,
      oracles,
      browser,
      fixtureRows: lazy(() => read(fixture, 1, 1)),
      clocklessRows: lazy(() => read(fixture, CLOCKLESS.GameID, CLOCKLESS.RaceID)),
      saveRows: (index) => {
        if (!saveReads.has(index)) {
          saveReads.set(index, read(saves[index], SAVES[index].GameID, SAVES[index].RaceID))
        }

        return saveReads.get(index)
      },
      peekLine: (database, GameID, RaceID) => through('the flyout line of the Warnings page', () => peek.peeks['/warnings']({ database, GameID, RaceID, separator: SEPARATOR })),
    }

    ctx.words = wordsOf(space.CONTACT_WORDS, 'the words of the counts')

    return ctx
  }
  const list = options.browser ? results : results.filter((item) => !item.id.startsWith('page-'))
  const judge = async (ctx, given = list) => judged(await runChecks(given, ctx))
  const variantOf = (edits) => edits.reduce((given, [key, from, to]) => ({ ...given, [key]: patched(FILES[key], given[key], from, to) }), { ...sources })

  // Every fault and rewrite, and the rewrites together, apply exactly once and parse before anything runs, whatever runs: an anchor gone stale stops the run at once.
  if (options.mutations) {
    ;[...MUTANTS, ...BENIGN].forEach(([, key, from, to]) => variantOf([[key, from, to]]))
    variantOf(BENIGN.map(([, key, from, to]) => [key, from, to]))
  }

  console.log('Fixtures, saves and browser')

  const baselineSeen = options.browser ? await observeVariant(sources) : null
  const baseline = await runChecks(list, await contextOf(sources, baselineSeen))

  baseline.forEach((result) => check(`${result.id}: ${result.name}`, result.ok, result.ok ? '' : `${result.kind}: ${result.detail}`))
  SAVES.forEach((save, index) => {
    const oracle = oracles[index]

    console.log(`INFO  ${save.file}: ${oracle ? `${oracle.before} systems with a stored contact of an empire not allied or friendly (${oracle.tracks} tracks); ${Object.keys(oracle.expected).length} with a contact held now or not known to be lost (${oracle.contacts} contacts, ${oracle.currentTracks} tracks at the game time), ${oracle.warnings} of them warnings` : 'not there'}`)
  })
  check('every named save is there', saves.every(Boolean), SAVES.filter((_save, index) => !saves[index]).map((save) => save.file).join(', '))

  if (options.mutations) {
    if (wanted('planted')) {
      console.log('\nPlanted faults')

      for (const [name, key, from, to, caught, browser] of MUTANTS) {
        if (!wanted('planted', name) || (key === 'page' && !options.browser)) {
          continue
        }

        const given = variantOf([[key, from, to]])
        const failed = await judge(await contextOf(given, browser && options.browser ? await observeVariant(given) : baselineSeen))
        const credited = failed.filter((result) => caught.includes(result.id) && result.kind === 'assertion')

        check(`planted: ${name}: caught by ${failed.map((result) => result.id).join(', ') || 'nothing'}; credited by ${credited.map((result) => result.id).join(', ') || 'nothing'}`, caughtBy(failed, caught), credited.map((result) => `${result.id}: ${result.detail.slice(0, 200)}`).join('; ') || `expected an assertion of one of ${caught.join(', ')}`)
      }
    }

    if (wanted('control')) {
      console.log('\nControls of the harness')

      const probe = async (body) => (await runChecks([{ id: 'probe', name: 'probe', run: body }], {}))[0]
      const stranger = () => new rawAssert.AssertionError({ message: 'thrown by the code under test' })
      const own = await probe(() => assert.equal(1, 2))
      const ordinary = await probe(() => assert.equal(1, 1))

      check('control: a failed assertion of a check is an assertion and credits the fault it is named for, and an assertion that holds passes', own.kind === 'assertion' && caughtBy([own], ['probe']) && ordinary.ok, JSON.stringify([own, ordinary]))

      const bare = [await probe(() => { throw stranger() }), await probe(() => { throw new TypeError('crash') })]
      const stopped = await judge({}, [{ id: 'probe', name: 'probe', run: async () => { throw stranger() } }]).then(() => null, (error) => error)

      check('control: an error the code under test throws where no adapter names it is no assertion of a check, credits nothing and stops the run when a fault is judged', bare.every((result) => result.kind === 'error') && !caughtBy(bare, ['probe']) && stopped instanceof HarnessError, JSON.stringify([bare, String(stopped)]))
    }

    if (wanted('benign')) {
      console.log('\nBenign rewrites')

      for (const [name, key, from, to, browser] of BENIGN) {
        if (!wanted('benign', name) || (key === 'page' && !options.browser)) {
          continue
        }

        const given = variantOf([[key, from, to]])
        const failed = await judge(await contextOf(given, browser && options.browser ? await observeVariant(given) : baselineSeen))

        check(`benign: ${name}: no check fails`, failed.length === 0, failed.map((result) => `${result.id}: ${result.detail}`).join('; '))
      }

      if (wanted('benign', 'every benign rewrite')) {
        const given = variantOf(BENIGN.map(([, key, from, to]) => [key, from, to]))
        const failed = await judge(await contextOf(given, options.browser ? await observeVariant(given) : null))

        check('benign: every benign rewrite together: no check fails', failed.length === 0, failed.map((result) => `${result.id}: ${result.detail}`).join('; '))
      }
    }
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  await finish(failures ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await finish(2)
})
