/*
  Checks the idle fleets warning of the Warnings page (the `idle-fleets` check of src/renderer/utilities/warnings/fleets.js): which fleets it leaves out as parked, the places it names under the ones it lists, the option that lists the parked ones too, the title and the label of the option.

  Run: bun scripts/check-warning-idle-fleets.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  - Fixtures: an in-memory save of four systems with colonies (one with a deep space population on a body beside another body with a colony, one a rival's, one on a body with no stored position), a jump point, command types and idle fleets set at distances from them and from fleets of the race with maintenance and recreational modules: modules damaged, not counted, not stored, on a ship docked in a hangar, aboard the idle fleet itself, in another system, of another race, exactly 1 km and less than 1 km away, fleets under a Training command, under another command, under none stored and under one whose type is not stored, and fleets with no stored position. Each case is read back through the module's word tables and compared with what is written here.
  - Saves, read only: AuroraDB.db (game 140, race 784), saves/AuroraDB.db, saves/AuroraDB_271_skoormit_saved.db (game 138, race 785) and saves/AuroraDB_270_Falryx_date_issue.db (game 141, race 786): every idle fleet against SQL written here from the game's rules, with the option off and on.
  - The page in a browser: scripts/lib/page-server.js serves a copy of saves/AuroraDB.db in which one idle fleet is put beside a fleet with a maintenance module, one on the position of a colony that its orbit does not name and one without a stored position. The Warnings page is opened on the check, every row shown, the screen read, and then the option switched on and read again. Rows are paired with SQL by the id of their fleet, never by their place; the figures are read whole in the grouping of the setting, the text from the text nodes drawn, and each element by whether it is on screen.
  - Planted faults in copies of the module, the shared module and the page, each of which must make a check named for it fail by a value, never by a throw of the code under test; benign rewrites, one of each family, that must leave every check passing; controls of the harness.

  The word tables of the module (LOCATION_WORDS, PARKED_GAPS, PARKED_PLACES and the shared SEPARATOR_WORDS) are reviewed prose: a check reads a line back through them and never asks for a wording. Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2. It needs Playwright's Chromium (`bunx playwright install chromium` once).
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { runSuite } = require('./lib/suite-runner')
const { patched } = require('./lib/mutant-source')
const { observe, validate, failureLine, describe, HarnessError, installScreen, GROUPINGS, readFigure, rolesRead, pairedBy, labelKey } = require('./lib/browser-observe')
const { caughtBy, unobserved } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const FILE = {
  fleets: 'src/renderer/utilities/warnings/fleets.js',
  common: 'src/renderer/utilities/warnings/common.js',
  page: 'src/renderer/pages/warnings.vue',
}
const MODULE_NAME = { fleets: 'warnings/fleets', common: 'warnings/common' }
const DETAIL = process.argv.includes('--detail')
const TIMEOUT = 120000

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

const GROUPING = 'Tick'
const SEPARATOR = GROUPINGS[GROUPING]
const CHECK = 'idle-fleets'
const RULE = 'warnings.idleFleets'
const READ = 'readIdleFleets'
const ROUTE = `/warnings?check=${CHECK}`
const NAMES = { game: 'EggSample', race: 'EggSample' }

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 400 ? `${text.slice(0, 400)}…` : text
}

const textOf = (cell) => (cell !== null && typeof cell === 'object' ? cell.text : cell)

// A stored text as the browser draws it: runs of the white space it collapses drawn as one space, none at the ends.
const asShown = (text) => text.replace(/[ \t\n\r]+/g, ' ').replace(/^ | $/g, '')

// ---------- reading a line back ----------

// Whether a caption reads as `[kind, name]` through the module's table of the words that open it: the words of the kind, a space and the name. A name that is null (a body with no name of its own) is not compared.
const captionIs = (text, [kind, name], words) => typeof text === 'string' && Object.prototype.hasOwnProperty.call(words, kind) && (name === null ? text.startsWith(`${words[kind]} `) : text === `${words[kind]} ${name}`)

// A title as a figure and the rest: the figure read whole in the grouping, the words after it.
const titleRead = (text, grouping) => {
  const space = typeof text === 'string' ? text.indexOf(' ') : -1

  return space < 0 ? { count: null, rest: '' } : { count: readFigure(text.slice(0, space), grouping), rest: text.slice(space + 1) }
}

const FIRST_OR_SECOND_PERSON = /\b(?:I|me|my|mine|you|your|yours|we|us|our|ours)\b/i

// ---------- the fixtures ----------

// Systems and bodies: [id, system, x, y, the race's own name for the body].
const SYSTEMS = [[1, 'Alpha'], [2, 'Beta'], [3, 'Gamma'], [4, 'Delta'], [5, 'Epsilon']]
const BODIES = [
  [1, 1, 100, 100, 'Alpha Prime'], [2, 1, 500, 500, 'Gas Giant'], [3, 1, 500, 500, 'Gas Moon'], [4, 1, 900, 900, 'Free Rock'], [5, 1, 300, 300, 'Empty Rock'], [6, 1, 700, 700, 'Twin Giant'],
  [7, 1, 700, 700, 'Twin Rock'], [8, 2, 1100, 1100, 'Beta Prime'], [9, 1, 0, 0, 'Origin Rock'], [10, 3, null, null, 'Blank Rock'], [11, 1, 1300, 1300, 'Station Rock'],
]
// Colonies: [id, race, name, population, system, body]. A gas giant with a deep space population on a moon at the same place, two bodies at one place with a colony each, a rival's colony, a colony on a body at the origin and one on a body with no stored position.
const POPULATIONS = [
  [1, 1, 'Alpha Colony', 1000, 1, 1], [2, 1, 'Gas DSP', 10, 1, 3], [3, 1, 'Free DSP', 10, 1, 4], [4, 2, 'Rival Colony', 500, 1, 5], [5, 1, 'Twin Colony', 5, 1, 6], [6, 1, 'Twin DSP', 50, 1, 7],
  [7, 1, 'Beta Colony', 100, 2, 8], [8, 1, 'Origin Colony', 100, 1, 9], [9, 1, 'Blank Colony', 100, 3, 10], [10, 1, 'Station DSP', 10, 1, 11],
]
const JUMP_POINT = [1, 1, 6000, 3000]
// Components: [id, type]. Maintenance Module (48), Recreational Module (57), an engine (1) and a component with no stored type. The component 4899 has no definition row at all.
const COMPONENTS = [[4801, 48], [5701, 57], [9901, 1], [4802, null]]
// Ship classes: [id, [[component, count]]]. 0 carries no component; 3 two maintenance modules; 4 a maintenance module line with no stored count; 6 a component with no stored type; 7 a component with no definition row; 8 a maintenance module and a component with no stored type; 9 a line with no stored component; 10 an engine line whose class has no class row. The class 99, which a ship may name, has no class row and no lines, and a ship may have no class at all (null).
const CLASSES = [[1, [[4801, 1]]], [2, [[5701, 1]]], [3, [[4801, 2]]], [4, [[4801, null]]], [5, [[9901, 1]]], [6, [[4802, 1]]], [7, [[4899, 1]]], [8, [[4801, 1], [4802, 1]]], [9, [[null, 1]]], [10, [[9901, 1]]]]
// The classes with lines but no row of their own in the table of ship classes.
const MISSING_CLASS_ROWS = [10]
// Admin commands: [id, type]; type 5 is Training, 1 Naval. The command 9 is not stored.
const COMMANDS = [[7, 5], [8, 1]]
const COMMAND_TYPES = [[5, 'Training'], [1, 'Naval']]

// Idle fleets of race 1 (mobile, military, no orders, one ship unless `ships` says): [id, [system, x, y], orbit body, command, what the warning must do (out: left out as parked, listed, unevaluated), the caption it carries [kind, name], the inputs named when not evaluated, ships].
const IDLE = [
  [101, [1, 100, 100], 1, 0, 'out', ['parked', 'Alpha Colony']],
  [102, [1, 500, 500], 2, 0, 'out', ['parked', 'Gas DSP']],
  [103, [1, 900, 900], 4, 0, 'out', ['parked', 'Free DSP']],
  [104, [1, 700, 700], 6, 0, 'out', ['parked', 'Twin Colony']],
  [105, [1, 700, 700], 0, 0, 'out', ['parked', 'Twin DSP']],
  [106, [1, 300, 300], 5, 0, 'listed', ['orbiting', 'Empty Rock']],
  [107, [1, 101, 100], 1, 0, 'listed', ['orbiting', 'Alpha Prime']],
  [108, [1, 105, 100], 1, 0, 'listed', ['orbiting', 'Alpha Prime']],
  [109, [1, 1100, 1100], 0, 0, 'listed', ['deepSpace', 'Alpha']],
  [110, [1, 3000, 3000], 0, 0, 'out', ['parked', 'Depot M']],
  [111, [1, 3100, 3000], 0, 0, 'out', ['parked', 'Depot R']],
  [112, [1, 3200, 3000], 0, 0, 'listed', ['deepSpace', 'Alpha']],
  [113, [1, 3300, 3000], 0, 0, 'out', ['parked', 'Depot Mixed']],
  [114, [1, 3400, 3000], 0, 0, 'unevaluated', ['deepSpace', 'Alpha'], ['modules']],
  [115, [1, 3500, 3000], 0, 0, 'listed', ['deepSpace', 'Alpha']],
  [116, [1, 3600, 3000], 0, 0, 'out', ['parked', 'Depot Near']],
  [117, [1, 3700, 3000], 0, 0, 'listed', ['deepSpace', 'Alpha']],
  [118, [1, 3800, 3000], 0, 0, 'listed', ['deepSpace', 'Alpha'], [], 2],
  [119, [1, 3900, 3000], 0, 0, 'listed', ['deepSpace', 'Alpha']],
  [120, [1, 4000, 3000], 0, 0, 'out', ['parked', 'Depot Docked and Free']],
  [121, [1, 4100, 3000], 0, 7, 'listed', ['deepSpace', 'Alpha']],
  [122, [1, 4200, 3000], 0, 7, 'out', ['parked', 'Depot M2']],
  [123, [1, 100, 100], 1, 7, 'out', ['parked', 'Alpha Colony']],
  [124, [1, 1300, 1300], 0, 0, 'out', ['parked', 'Station DSP']],
  [125, [1, null, 0], 0, 0, 'unevaluated', ['deepSpace', 'Alpha'], ['fleet']],
  [126, [3, 0, 0], 0, 0, 'unevaluated', ['deepSpace', 'Gamma'], ['colony']],
  [127, [4, 0, 0], 0, 0, 'unevaluated', ['deepSpace', 'Delta'], ['station']],
  [128, [1, 4400, 3000], 0, null, 'unevaluated', ['deepSpace', 'Alpha'], ['command']],
  [129, [1, 4500, 3000], 0, 8, 'out', ['parked', 'Depot R4']],
  [130, [1, 4600, 3000], 0, 0, 'listed', ['deepSpace', 'Alpha']],
  [131, [1, 4700, 3000], 0, 0, 'out', ['parked', 'Depot Sure']],
  [132, [1, 4800, 3000], 0, 0, 'listed', ['deepSpace', 'Alpha']],
  [133, [1, 4900, 3000], 0, 0, 'unevaluated', ['deepSpace', 'Alpha'], ['modules']],
  [134, [1, 6000, 3000], 0, 0, 'listed', ['jumpPoint', 'Alpha']],
  [135, [1, 0, 0], 0, 0, 'out', ['parked', 'Origin Colony']],
  [136, [1, 5200, 3000], 0, 9, 'unevaluated', ['deepSpace', 'Alpha'], ['command']],
  [137, [1, 5300, 3000], 0, null, 'out', ['parked', 'Depot M3']],
  [138, [1, 100, 100], 1, null, 'out', ['parked', 'Alpha Colony']],
  [139, [1, 3000, 3600], 0, 0, 'listed', ['deepSpace', 'Alpha']],
  [140, [1, 7000, 3000], 0, 0, 'listed', ['deepSpace', 'Alpha']],
  [141, [1, 5400, 3000], 0, 0, 'unevaluated', ['deepSpace', 'Alpha'], ['componentType']],
  [142, [1, 5500, 3000], 0, 0, 'unevaluated', ['deepSpace', 'Alpha'], ['componentType']],
  [143, [1, 5600, 3000], 0, 0, 'out', ['parked', 'Depot Typed']],
  [144, [5, null, 0], 0, 0, 'unevaluated', ['deepSpace', 'Epsilon'], ['fleet']],
  [145, [5, 100, null], 0, 0, 'unevaluated', ['deepSpace', 'Epsilon'], ['fleet']],
  [146, [1, 5700, 3000], 0, 0, 'unevaluated', ['deepSpace', 'Alpha'], ['shipClass']],
  [147, [1, 5800, 3000], 0, 0, 'unevaluated', ['deepSpace', 'Alpha'], ['shipClass']],
  [148, [1, 5900, 3000], 0, 0, 'out', ['parked', 'Depot Classless Sure']],
  [149, [1, 6100, 3000], 0, 0, 'unevaluated', ['deepSpace', 'Alpha'], ['componentType']],
  [150, [1, 6200, 3000], 0, 0, 'unevaluated', ['deepSpace', 'Alpha'], ['shipClass']],
  [151, [1, 6300, 3000], 0, 0, 'out', ['parked', 'Depot Ghost Sure']],
  [152, [1, 6400, 3000], 0, 0, 'out', ['parked', 'Depot Nullcomp Sure']],
].map(([id, at, orbit, command, state, says, missing = [], ships = 1]) => ({ id, name: `Idle ${id}`, at, orbit, command, state, says, missing, ships }))

// Fleets that cannot move, of the race (or of race 2), with their ships: [fleet, name, [system, x, y], race, [[class, { docked: the index of the ship that carries it, damaged: [component, number] }]]].
const STATIONS = [
  [201, 'Depot M', [1, 3000, 3000], 1, [[1]]],
  [202, 'Depot R', [1, 3100, 3000], 1, [[2]]],
  [203, 'Depot Damaged', [1, 3200, 3000], 1, [[1, { damaged: [4801, 1] }]]],
  [204, 'Depot Mixed', [1, 3300, 3000], 1, [[3, { damaged: [4801, 1] }]]],
  [205, 'Depot Unknown', [1, 3400, 3000], 1, [[1, { damaged: [4801, null] }]]],
  [206, 'Depot Far', [1, 3501, 3000], 1, [[1]]],
  [207, 'Depot Near', [1, 3600.5, 3000], 1, [[1]]],
  [208, 'Depot Other System', [2, 3700, 3000], 1, [[1]]],
  [209, 'Depot Docked', [1, 3900, 3000], 1, [[0], [1, { docked: 0 }]]],
  [210, 'Depot Docked and Free', [1, 4000, 3000], 1, [[0], [1, { docked: 0 }], [1]]],
  [211, 'Depot R2', [1, 4100, 3000], 1, [[2]]],
  [212, 'Depot M2', [1, 4200, 3000], 1, [[1]]],
  [213, 'Depot Beside DSP', [1, 1300, 1300], 1, [[1]]],
  [214, 'Depot Unplaced', [4, null, null], 1, [[1]]],
  [215, 'Depot R3', [1, 4400, 3000], 1, [[2]]],
  [216, 'Depot R4', [1, 4500, 3000], 1, [[2]]],
  [217, 'Rival Depot', [1, 4600, 3000], 2, [[1]]],
  [218, 'Depot Unknown 2', [1, 4700, 3000], 1, [[1, { damaged: [4801, null] }]]],
  [219, 'Depot Sure', [1, 4700, 3000], 1, [[1]]],
  [220, 'Depot Engines', [1, 4800, 3000], 1, [[5]]],
  [221, 'Depot Blank', [1, 4900, 3000], 1, [[4]]],
  [222, 'Depot R5', [1, 5200, 3000], 1, [[2]]],
  [223, 'Depot M3', [1, 5300, 3000], 1, [[1]]],
  [224, 'Depot Typeless', [1, 5400, 3000], 1, [[6]]],
  [225, 'Depot Undefined', [1, 5500, 3000], 1, [[7]]],
  [226, 'Depot Typed', [1, 5600, 3000], 1, [[8]]],
  [227, 'Depot Classless', [1, 5700, 3000], 1, [[null]]],
  [228, 'Depot Ghost Class', [1, 5800, 3000], 1, [[99]]],
  [229, 'Depot Classless Sure', [1, 5900, 3000], 1, [[1], [null]]],
  [230, 'Depot Nullcomp', [1, 6100, 3000], 1, [[9]]],
  [231, 'Depot Ghost Engine', [1, 6200, 3000], 1, [[10]]],
  [232, 'Depot Ghost Sure', [1, 6300, 3000], 1, [[1], [10]]],
  [233, 'Depot Nullcomp Sure', [1, 6400, 3000], 1, [[1], [9]]],
]
// The ships of an idle fleet by the index of their class: one with no component, and for the fleet 118 a second one with a maintenance module of its own.
const OWN_SHIPS = { 118: [[0], [1]] }

const CASES = new Map(IDLE.map((entry) => [entry.id, entry]))

const GROUPS = {
  colonies: [101, 102, 103, 104, 105, 135],
  away: [106, 109, 134, 140],
  distance: [107, 108, 115, 116, 139],
  stations: [110, 111, 112, 113, 117, 118, 119, 120, 124, 130, 131, 132, 143, 148, 151, 152],
  training: [121, 122, 123, 129, 137, 138],
  open: [114, 125, 126, 127, 128, 133, 136, 141, 142, 144, 145, 146, 147, 149, 150],
}

const sqlValue = (value) => (value === null ? 'null' : typeof value === 'string' ? `'${value.replace(/'/g, '\'\'')}'` : String(value))
const insert = (table, record) => `insert into ${table} (${Object.keys(record).join(', ')}) values (${Object.values(record).map(sqlValue).join(', ')});`

const fixtureSql = () => {
  const statements = [
    'create table FCT_Fleet (FleetID integer, GameID integer, RaceID integer, FleetName text, SystemID integer, Xcor real, Ycor real, OrbitBodyID integer, ParentCommandID integer, ShippingLine integer, CivilianFunction integer, Speed integer, AnchorFleetID integer);',
    'create table FCT_Ship (ShipID integer, GameID integer, RaceID integer, FleetID integer, ShipClassID integer, MaintenanceState integer, MothershipID integer);',
    'create table FCT_RaceSysSurvey (GameID integer, SystemID integer, RaceID integer, Name text);',
    'create table FCT_SystemBody (SystemBodyID integer, StarID integer, BodyClass integer, PlanetNumber integer, OrbitNumber integer, Xcor real, Ycor real);',
    'create table FCT_SystemBodyName (SystemBodyID integer, RaceID integer, Name text);',
    'create table FCT_Star (StarID integer, Component integer);',
    'create table FCT_JumpPoint (WarpPointID integer, GameID integer, SystemID integer, Xcor real, Ycor real);',
    'create table FCT_FleetStandingOrder (FleetID integer);',
    'create table FCT_FleetConditionalOrder (FleetID integer, GameID integer);',
    'create table FCT_MoveOrders (FleetID integer);',
    'create table FCT_Population (PopulationID integer, GameID integer, RaceID integer, PopName text, Population real, SystemID integer, SystemBodyID integer);',
    'create table FCT_ClassComponent (GameID integer, ClassID integer, ComponentID integer, NumComponent real);',
    'create table FCT_ShipClass (ShipClassID integer);',
    'create table FCT_ShipDesignComponents (SDComponentID integer, ComponentTypeID integer);',
    'create table FCT_DamagedComponent (ShipID integer, GameID integer, ComponentID integer, Number real);',
    'create table FCT_NavalAdminCommand (NavalAdminCommandID integer, AdminCommandTypeID integer);',
    'create table DIM_NavalAdminCommandType (CommandTypeID integer, Description text);',
    insert('FCT_Star', { StarID: 1, Component: 1 }),
    insert('FCT_JumpPoint', { WarpPointID: JUMP_POINT[0], GameID: 1, SystemID: JUMP_POINT[1], Xcor: JUMP_POINT[2], Ycor: JUMP_POINT[3] }),
  ]

  SYSTEMS.forEach(([SystemID, Name]) => statements.push(insert('FCT_RaceSysSurvey', { GameID: 1, SystemID, RaceID: 1, Name })))
  BODIES.forEach(([SystemBodyID, , Xcor, Ycor, Name]) => statements.push(insert('FCT_SystemBody', { SystemBodyID, StarID: 1, BodyClass: 1, PlanetNumber: SystemBodyID, OrbitNumber: SystemBodyID, Xcor, Ycor }), insert('FCT_SystemBodyName', { SystemBodyID, RaceID: 1, Name })))
  POPULATIONS.forEach(([PopulationID, RaceID, PopName, Population, SystemID, SystemBodyID]) => statements.push(insert('FCT_Population', { PopulationID, GameID: 1, RaceID, PopName, Population, SystemID, SystemBodyID })))
  COMPONENTS.forEach(([SDComponentID, ComponentTypeID]) => statements.push(insert('FCT_ShipDesignComponents', { SDComponentID, ComponentTypeID })))
  CLASSES.forEach(([ClassID, lines]) => lines.forEach(([ComponentID, NumComponent]) => statements.push(insert('FCT_ClassComponent', { GameID: 1, ClassID, ComponentID, NumComponent }))))

  const classIds = [0, ...CLASSES.map(([ClassID]) => ClassID).filter((ClassID) => !MISSING_CLASS_ROWS.includes(ClassID))]

  classIds.forEach((ShipClassID) => statements.push(insert('FCT_ShipClass', { ShipClassID })))
  COMMANDS.forEach(([NavalAdminCommandID, AdminCommandTypeID]) => statements.push(insert('FCT_NavalAdminCommand', { NavalAdminCommandID, AdminCommandTypeID })))
  COMMAND_TYPES.forEach(([CommandTypeID, Description]) => statements.push(insert('DIM_NavalAdminCommandType', { CommandTypeID, Description })))

  let shipId = 1000

  const addShips = (FleetID, RaceID, specs) => {
    const ids = specs.map(() => shipId++)

    specs.forEach(([ShipClassID, extra = {}], index) => {
      statements.push(insert('FCT_Ship', { ShipID: ids[index], GameID: 1, RaceID, FleetID, ShipClassID, MaintenanceState: 0, MothershipID: extra.docked === undefined ? 0 : ids[extra.docked] }))

      if (extra.damaged) {
        statements.push(insert('FCT_DamagedComponent', { ShipID: ids[index], GameID: 1, ComponentID: extra.damaged[0], Number: extra.damaged[1] }))
      }
    })
  }

  const addFleet = (FleetID, FleetName, [SystemID, Xcor, Ycor], RaceID, OrbitBodyID, ParentCommandID, Speed) => statements.push(insert('FCT_Fleet', { FleetID, GameID: 1, RaceID, FleetName, SystemID, Xcor, Ycor, OrbitBodyID, ParentCommandID, ShippingLine: 0, CivilianFunction: 0, Speed, AnchorFleetID: 0 }))

  IDLE.forEach((entry) => {
    addFleet(entry.id, entry.name, entry.at, 1, entry.orbit, entry.command, 100)
    addShips(entry.id, 1, OWN_SHIPS[entry.id] || Array.from({ length: entry.ships }, () => [0]))
  })
  STATIONS.forEach(([id, name, at, race, specs]) => {
    addFleet(id, name, at, race, 0, 0, 0)
    addShips(id, race, specs)
  })

  return statements.join('\n')
}

const allRows = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))
const runSql = (raw, sql) => new Promise((resolve, reject) => raw.exec(sql, (error) => (error ? reject(error) : resolve())))
const closeRaw = (raw) => new Promise((resolve) => raw.close(() => resolve()))
const standIn = (raw) => ({ raw, query: async (sql) => [await allRows(raw, sql)] })

const openRaw = (file, mode) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, mode, (error) => (error ? reject(error) : resolve(raw)))
})

const openFixture = async () => {
  const raw = await openRaw(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE)

  await runSql(raw, fixtureSql())

  return standIn(raw)
}

// ---------- the saves, and what SQL written here says of them ----------

const SAVES = [
  { id: 'save-modded', file: 'AuroraDB.db', GameID: 140, RaceID: 784 },
  { id: 'save-egg', file: 'saves/AuroraDB.db', GameID: 138, RaceID: 785 },
  { id: 'save-stock', file: 'saves/AuroraDB_271_skoormit_saved.db', GameID: 138, RaceID: 785 },
  { id: 'save-falryx', file: 'saves/AuroraDB_270_Falryx_date_issue.db', GameID: 141, RaceID: 786 },
]
const PAGE_SAVE = SAVES[1]

// One row for each idle fleet by the game's rules: the fleet is mobile and military, follows no fleet, has no move order and a ship that is neither in maintenance nor carried; it is parked at a colony of the race in its system whose body lies less than 1 km away on both axes, or at another fleet of the race in its system less than 1 km away on both axes with an undamaged maintenance module (type 48) on an undocked ship, or one with a recreational module (type 57) when the fleet is not under a Training command. The name is the colony on the body the fleet orbits, else the largest colony there; failing a colony, the first fleet by name.
const truthSql = ({ GameID: g, RaceID: r }) => `with idle as (select f.FleetID, f.FleetName, f.SystemID, f.Xcor, f.Ycor, f.OrbitBodyID, f.RaceID, f.GameID, case when f.ParentCommandID = 0 then 0 else coalesce((select t.Description = 'Training' from FCT_NavalAdminCommand c join DIM_NavalAdminCommandType t on t.CommandTypeID = c.AdminCommandTypeID where c.NavalAdminCommandID = f.ParentCommandID), 0) end as Training from FCT_Fleet f where f.GameID = ${g} and f.RaceID = ${r} and f.ShippingLine = 0 and f.CivilianFunction = 0 and f.Speed > 1 and f.AnchorFleetID = 0 and not exists (select 1 from FCT_MoveOrders m where m.FleetID = f.FleetID) and exists (select 1 from FCT_Ship s where s.FleetID = f.FleetID and s.GameID = f.GameID and s.RaceID = f.RaceID and s.MaintenanceState <> 2 and s.MothershipID = 0)), working as (select s.FleetID, d.ComponentTypeID as Type, sum(max(c.NumComponent - coalesce((select sum(x.Number) from FCT_DamagedComponent x where x.ShipID = s.ShipID and x.GameID = s.GameID and x.ComponentID = c.ComponentID), 0), 0)) as Modules from FCT_Ship s join FCT_ClassComponent c on c.ClassID = s.ShipClassID join FCT_ShipDesignComponents d on d.SDComponentID = c.ComponentID and d.ComponentTypeID in (48, 57) where s.GameID = ${g} and s.RaceID = ${r} and s.MothershipID = 0 group by s.FleetID, d.ComponentTypeID) select i.FleetID, i.FleetName, i.SystemID, i.Xcor, i.Ycor, i.OrbitBodyID, i.Training, (select count(*) from FCT_Ship s where s.FleetID = i.FleetID and s.GameID = i.GameID and s.RaceID = i.RaceID) as Ships, (select p.PopName from FCT_Population p join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where p.GameID = i.GameID and p.RaceID = i.RaceID and p.SystemID = i.SystemID and abs(i.Xcor - b.Xcor) < 1 and abs(i.Ycor - b.Ycor) < 1 order by (p.SystemBodyID = i.OrbitBodyID) desc, p.Population desc, p.PopulationID limit 1) as Colony, (select count(*) from FCT_Population p join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where p.GameID = i.GameID and p.RaceID = i.RaceID and p.SystemID = i.SystemID and abs(i.Xcor - b.Xcor) < 1 and abs(i.Ycor - b.Ycor) < 1) as Colonies, (select g.FleetName from FCT_Fleet g join working w on w.FleetID = g.FleetID where g.GameID = i.GameID and g.RaceID = i.RaceID and g.FleetID <> i.FleetID and g.SystemID = i.SystemID and abs(i.Xcor - g.Xcor) < 1 and abs(i.Ycor - g.Ycor) < 1 and w.Modules > 0 and (w.Type = 48 or (w.Type = 57 and i.Training = 0)) order by g.FleetName, g.FleetID limit 1) as Station, (select count(*) from FCT_Fleet g join working w on w.FleetID = g.FleetID where g.GameID = i.GameID and g.RaceID = i.RaceID and g.FleetID <> i.FleetID and g.SystemID = i.SystemID and abs(i.Xcor - g.Xcor) < 1 and abs(i.Ycor - g.Ycor) < 1 and w.Modules > 0 and (w.Type = 48 or (w.Type = 57 and i.Training = 0))) as Stations, (select n.Name from FCT_SystemBodyName n where n.SystemBodyID = i.OrbitBodyID and n.RaceID = i.RaceID limit 1) as BodyName, (select v.Name from FCT_RaceSysSurvey v where v.SystemID = i.SystemID and v.RaceID = i.RaceID and v.GameID = i.GameID limit 1) as SystemName, (select count(*) from FCT_JumpPoint j where j.GameID = i.GameID and j.SystemID = i.SystemID and j.Xcor = i.Xcor and j.Ycor = i.Ycor) as OnJump from idle i order by i.FleetID`

// The stored values the SQL above cannot decide on when one is missing: a fleet with no stored position beyond `allowed`, a colony whose body has none, a module line with no count or a damaged row with no number, a fleet under no stored command, a ship with no mothership. A save that stores one is not judged by that SQL.
const nullsSql = ({ GameID: g, RaceID: r }, allowed) => `select (select count(*) from FCT_Fleet where GameID = ${g} and RaceID = ${r} and (SystemID is null or Xcor is null or Ycor is null) and FleetID not in (${allowed.concat([0]).join(', ')})) as Fleets, (select count(*) from FCT_Population p left join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where p.GameID = ${g} and p.RaceID = ${r} and (p.SystemID is null or b.Xcor is null or b.Ycor is null)) as Colonies, (select count(*) from FCT_Ship s join FCT_ClassComponent c on c.ClassID = s.ShipClassID join FCT_ShipDesignComponents d on d.SDComponentID = c.ComponentID and d.ComponentTypeID in (48, 57) where s.GameID = ${g} and s.RaceID = ${r} and c.NumComponent is null) as Counts, (select count(*) from FCT_DamagedComponent where GameID = ${g} and Number is null) as Damage, (select count(*) from FCT_Fleet where GameID = ${g} and RaceID = ${r} and ParentCommandID is null) as Commands, (select count(*) from FCT_Ship where GameID = ${g} and RaceID = ${r} and MothershipID is null) as Carried`

// What SQL says of the idle fleets of a game and race: { fleets: Map(id -> { id, name, ships, parked, unevaluated, caption: [kind, name or null] }), nulls: what it could not judge }.
const truthOf = async (database, ids, allowed = []) => {
  const rows = await allRows(database.raw, truthSql(ids))
  const [counts] = await allRows(database.raw, nullsSql(ids, allowed))
  const [{ Types }] = await allRows(database.raw, `select count(*) as Types from FCT_Ship s join FCT_ClassComponent c on c.ClassID = s.ShipClassID left join FCT_ShipDesignComponents d on d.SDComponentID = c.ComponentID where s.GameID = ${ids.GameID} and s.RaceID = ${ids.RaceID} and d.ComponentTypeID is null`)

  const [{ Classes }] = await allRows(database.raw, `select count(*) as Classes from FCT_Ship s left join FCT_ShipClass k on k.ShipClassID = s.ShipClassID where s.GameID = ${ids.GameID} and s.RaceID = ${ids.RaceID} and k.ShipClassID is null`)

  counts.Types = Types
  counts.Classes = Classes

  const fleets = new Map(rows.map((row) => {
    const parked = row.Colonies > 0 || row.Stations > 0
    const unevaluated = !parked && (row.SystemID === null || row.Xcor === null || row.Ycor === null)
    const caption = row.Colonies > 0 ? ['parked', row.Colony] : row.Stations > 0 ? ['parked', row.Station] : row.OrbitBodyID > 0 ? ['orbiting', row.BodyName] : row.OnJump > 0 ? ['jumpPoint', row.SystemName] : ['deepSpace', row.SystemName]

    return [row.FleetID, { id: row.FleetID, name: row.FleetName, ships: row.Ships, parked, unevaluated, caption }]
  }))

  return { fleets, nulls: Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`) }
}

// ---------- the module ----------

// The modules as given by the texts of the variant (`texts` by file key), the check, and its reading of one database: the rows by the id of the fleet, { state, name, ships, caption, missing }, with the option off and on.
const loadModules = async (texts) => {
  const sources = Object.fromEntries(['fleets', 'common'].map((key) => [MODULE_NAME[key], texts[key]]))

  return loadUtilities(['provenance', 'warnings/common', 'warnings/fleets'], { stubs: STUBS, sources, texts: ENV.cache })
}

const readRows = async (loaded, check, database, ids, on) => {
  const rows = await check.read({ database, GameID: ids.GameID, RaceID: ids.RaceID, RaceNPR: false, separator: SEPARATOR, count: loaded['warnings/common'].counter(SEPARATOR), options: { idleFleetsAtColonies: on } })
  const seen = new Map()

  rows.forEach((row) => {
    const id = Number(String(row.id).slice('fleet:'.length))

    if (seen.has(id)) {
      throw new HarnessError(`the fleet ${id} is listed twice`)
    }

    seen.set(id, { state: row.unevaluated ? 'unevaluated' : 'listed', name: textOf(row.cells.fleet), ships: textOf(row.cells.ships), caption: row.caption, missing: row.unevaluated ? [...row.unevaluated.inputs.missing].sort() : [] })
  })

  return seen
}

const FIXTURE_IDS = { GameID: 1, RaceID: 1 }

// What the module reads of the fixtures, the copy of the save and each save, and the tables of words and the rule it registers, for the variant `texts`.
const observeModule = async (texts) => {
  const loaded = await loadModules(texts)
  const fleets = loaded['warnings/fleets']
  const check = fleets.checks.find((item) => item.key === CHECK)

  if (!check) {
    throw new HarnessError(`the module has no check keyed ${CHECK}`)
  }

  const both = async (database, ids) => ({ off: await readRows(loaded, check, database, ids, false), on: await readRows(loaded, check, database, ids, true) })

  return {
    words: { ...fleets.LOCATION_WORDS },
    gaps: { ...fleets.PARKED_GAPS },
    places: fleets.PARKED_PLACES,
    separatorWords: { ...loaded['warnings/common'].SEPARATOR_WORDS },
    rule: loaded.provenance.getRule(RULE),
    ruleText: check.rule,
    fixture: await both(ENV.fixture, FIXTURE_IDS),
    copy: await both(ENV.copy.database, PAGE_SAVE),
    saves: await Promise.all(SAVES.map((save, index) => both(ENV.saves[index], save))),
  }
}

// ---------- the module's checks ----------

// The problems of the fixtures' cases `ids`: what is left out or listed with the option off (`state`), the inputs named when a case is not evaluated (`missing`), the caption under each fleet listed, with the option off or on (`says`), and the name and the number of ships of its row (`rows`).
const caseProblems = (o, ids, aspects) => ids.flatMap((id) => {
  const want = CASES.get(id)
  const off = o.fixture.off.get(id)
  const on = o.fixture.on.get(id)
  const problems = []

  if (aspects.state && (off ? off.state : 'out') !== want.state) {
    problems.push([id, 'with the option off', off ? off.state : 'out', want.state])
  }

  if (aspects.missing && want.state === 'unevaluated' && off) {
    const named = want.missing.map((kind) => o.gaps[kind])

    if (JSON.stringify(off.missing) !== JSON.stringify([...named].sort())) {
      problems.push([id, 'the inputs named', off.missing, named])
    }
  }

  if (aspects.says) {
    if (!on) {
      problems.push([id, 'with the option on', 'not listed'])
    } else if (!captionIs(on.caption, want.says, o.words)) {
      problems.push([id, 'the caption with the option on', on.caption, want.says])
    }

    if (off && !captionIs(off.caption, want.says, o.words)) {
      problems.push([id, 'the caption with the option off', off.caption, want.says])
    }
  }

  if (aspects.rows && on && (on.name !== want.name || readFigure(on.ships, GROUPING) !== want.ships)) {
    problems.push([id, 'the row', [on.name, on.ships], [want.name, want.ships]])
  }

  return problems
})

const verdictOf = (problems) => problems.length === 0 || short(problems.slice(0, 3))

// A read of a save against SQL: each idle fleet left out or listed, not evaluated when it has no stored position, and captioned by its place; with the option on every idle fleet is listed.
const againstTruth = (o, read, truth, label) => {
  if (truth.nulls.length) {
    return `SQL here cannot judge ${label}: it stores ${truth.nulls.join(', ')}`
  }

  const problems = []
  const ids = [...truth.fleets.keys()].sort((a, b) => a - b)
  const listed = [...read.on.keys()].sort((a, b) => a - b)

  if (JSON.stringify(listed) !== JSON.stringify(ids)) {
    problems.push(['the idle fleets listed with the option on', listed.length, ids.length, listed.filter((id) => !truth.fleets.has(id)).slice(0, 5), ids.filter((id) => !read.on.has(id)).slice(0, 5)])
  }

  truth.fleets.forEach((want, id) => {
    const off = read.off.get(id)
    const on = read.on.get(id)
    const state = want.parked ? 'out' : want.unevaluated ? 'unevaluated' : 'listed'

    if ((off ? off.state : 'out') !== state) {
      problems.push([id, 'with the option off', off ? off.state : 'out', state])
    }

    if (on && (!captionIs(on.caption, want.caption, o.words) || on.name !== want.name || readFigure(on.ships, GROUPING) !== want.ships)) {
      problems.push([id, 'the row with the option on', [on.name, on.ships, on.caption], [want.name, want.ships, want.caption]])
    }
  })

  return verdictOf(problems)
}

const named = (rule) => new Set(rule.structure.flatMap((entry) => {
  const [table, columns] = entry.split('.')

  return columns === undefined ? [] : columns.split(',').map((column) => `${table}.${column.trim()}`)
}))

const MODULE_CHECKS = [
  ['colonies', 'a fleet within 1 km of a colony of the race on both axes is parked there, whether its orbit names that colony or not: a deep space population beside a body, a body with a colony beside one without, a colony on the origin', (o) => verdictOf(caseProblems(o, GROUPS.colonies, { state: true }))],
  ['away', 'a fleet at a colony of another race, in deep space or at a jump point is listed, and under the place it is in', (o) => verdictOf(caseProblems(o, GROUPS.away, { state: true, says: true }))],
  ['distance', 'a fleet exactly 1 km from a colony or a fleet with a module is not parked, one less than 1 km away is, and a fleet on the position in the x axis alone is not', (o) => verdictOf(caseProblems(o, GROUPS.distance, { state: true }))],
  ['stations', 'a fleet is parked at another fleet of the race in its system with an undamaged maintenance or recreational module on a ship that is not docked, and not at one with the module damaged, docked, of another race, in another system, aboard itself or with no module', (o) => verdictOf(caseProblems(o, GROUPS.stations, { state: true }))],
  ['training', 'a fleet under a Training command is parked at a colony or a maintenance module and not at a recreational one; a fleet under another command or none, or one whose command is not stored where a maintenance module decides, is parked at either', (o) => verdictOf(caseProblems(o, GROUPS.training, { state: true }))],
  ['unevaluated', 'a fleet whose system or position, a colony\'s position, another fleet\'s position, a module count, a component type or a command type is not stored, with nothing that decides it, is not evaluated and names that input, never listed or left out as if it were known, even in a system with no colony or fleet to compare with', (o) => verdictOf(caseProblems(o, GROUPS.open, { state: true, missing: true }))],
  ['names', 'with the option on every idle fleet is listed with the place it is in: the colony on the body it orbits before the largest colony there, a colony before a fleet, the first fleet by name, the body it orbits, the jump point, or deep space', (o) => verdictOf(caseProblems(o, [...CASES.keys()], { says: true }))],
  ['option', 'the option lists every idle fleet, and with it off the fleets listed and those not evaluated are the ones the cases say, and no fleet that cannot move or is another race\'s', (o) => {
    const all = [...CASES.keys()].sort((a, b) => a - b)
    const sorted = (ids) => [...ids].sort((a, b) => a - b)
    const problems = []

    if (JSON.stringify(sorted(o.fixture.on.keys())) !== JSON.stringify(all)) {
      problems.push(['listed with the option on', sorted(o.fixture.on.keys())])
    }

    ;['listed', 'unevaluated'].forEach((state) => {
      const got = sorted([...o.fixture.off.entries()].filter(([, row]) => row.state === state).map(([id]) => id))
      const want = all.filter((id) => CASES.get(id).state === state)

      if (JSON.stringify(got) !== JSON.stringify(want)) {
        problems.push([`${state} with the option off`, got, want])
      }
    })

    return verdictOf(problems)
  }],
  ['rows', 'each row names its fleet and counts its ships, both fleets of one ship and the one with a module ship of its own', (o) => verdictOf(caseProblems(o, [...CASES.keys()], { rows: true }))],
  ['structure', 'the registered rule of the warning names the stored values it decides on: the fleet\'s system, position and command, the colonies and their bodies\' positions, the ships\' mothership and class, the module counts and types, the damaged modules and the command types', (o) => {
    const columns = named(o.rule)
    const missing = ['FCT_Fleet.SystemID', 'FCT_Fleet.Xcor', 'FCT_Fleet.Ycor', 'FCT_Fleet.ParentCommandID', 'FCT_Ship.MothershipID', 'FCT_Ship.ShipClassID', 'FCT_ShipClass.ShipClassID', 'FCT_Population.SystemBodyID', 'FCT_SystemBody.Xcor', 'FCT_SystemBody.Ycor', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID', 'FCT_DamagedComponent.Number', 'FCT_NavalAdminCommand.AdminCommandTypeID', 'DIM_NavalAdminCommandType.Description'].filter((column) => !columns.has(column))

    return missing.length === 0 || `the rule's structure does not name ${missing.join(', ')}`
  }],
  ['voice', 'the rule, its note, the places and the words of the captions and of the inputs speak in no first or second person', (o) => {
    const texts = [o.ruleText, o.rule.note, o.places, ...Object.values(o.words), ...Object.values(o.gaps)]
    const wrong = texts.filter((text) => FIRST_OR_SECOND_PERSON.test(text))

    return wrong.length === 0 || short(wrong)
  }],
  ...SAVES.map((save, index) => [save.id, `${save.file} (game ${save.GameID}, race ${save.RaceID}): every idle fleet is left out, listed or not evaluated as SQL says, with the option on each is listed under its place`, (o, t) => againstTruth(o, o.saves[index], t.saves[index], save.file)]),
  ['save-copy', 'the copy of saves/AuroraDB.db the page serves, with an idle fleet put beside a fleet with a maintenance module, one on the position of a colony its orbit does not name and one with no stored position, as SQL says', (o, t) => againstTruth(o, o.copy, t.copy, 'the copy the page serves')],
]

// ---------- the page ----------

// What the screen shows of the check; runs in the page, through the shared readers: the lines of the check's table in the order drawn, each a line over the rows listed apart or a row (its id by the hook `data-row`), a row's cells by their roles (`data-cell`, and `data-caption` as the role `caption`), the title and the foot.
const readScreen = (check) => {
  const { visible, visibleText, hooked } = window.__screen
  const section = document.querySelector(`[data-check="${CSS.escape(check)}"]`)
  const lineOf = (row) => (row.hasAttribute('data-separator') ? { separator: true, on: visible(row), text: visibleText(row) } : { id: row.getAttribute('data-row'), on: visible(row), cells: [...hooked(row, 'data-cell'), ...hooked(row, 'data-caption').map((entry) => ({ ...entry, role: 'caption' }))] })
  const lines = section ? [...section.querySelectorAll('tbody > tr')].filter((row) => row.hasAttribute('data-separator') || row.hasAttribute('data-row')).map(lineOf) : []
  const title = section && section.querySelector('.check-title')

  return { grouping: window.$app.$store.getters.config.get('selectedSeparator', 'Tick'), section: Boolean(section) && visible(section), lines, title: title && visible(title) ? visibleText(title) : undefined }
}

// Whether the page instance `uid` has its read of the check settled on the copy of the save, with the option as `on` says.
const settledOn = ({ uid, key, on }) => {
  const match = window.$app.$route.matched[0]
  const vm = match && match.instances.default

  if (!vm || vm._uid !== uid || vm.loadErrors[key] !== null || !vm.ready) {
    return false
  }

  const read = vm[key]

  return Boolean(read && read.ok && read.options.idleFleetsAtColonies === on)
}

const observePage = (browser, url) => observe(browser, async ({ page, step }) => {
  step('opening the app')
  await installScreen(page)
  await page.goto(url, { timeout: TIMEOUT })

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(NAMES.race, { exact: true }).last().click({ timeout: TIMEOUT })
  }

  step('waiting for the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
  step(`opening ${ROUTE}`)
  await page.evaluate((to) => window.$app.$router.push(to, () => {}, () => {}), ROUTE)
  await page.waitForFunction(pageLoading.arrived, ROUTE, { timeout: TIMEOUT })

  const uid = await page.evaluate(() => window.$app.$route.matched[0].instances.default._uid)

  step('waiting for the page\'s read of the check')
  await page.waitForFunction(settledOn, { uid, key: READ, on: false }, { timeout: TIMEOUT })
  await page.evaluate(async () => { await window.$app.$nextTick() })

  const showAll = async () => {
    const more = page.locator(`[data-check="${CHECK}"] .check-more button`)

    const expanded = await page.evaluate((key) => window.$app.$route.matched[0].instances.default.expanded[key] === true, CHECK)

    if (!expanded && (await more.count()) > 0) {
      step('showing every row')
      await more.first().click({ timeout: TIMEOUT })
      await page.waitForFunction((key) => window.$app.$route.matched[0].instances.default.expanded[key] === true, CHECK, { timeout: TIMEOUT })
      await page.evaluate(async () => { await window.$app.$nextTick() })
    }
  }

  await showAll()
  step('reading the screen with the option off')

  const off = await page.evaluate(readScreen, CHECK)

  step('opening the options')
  await page.locator('[aria-label="Warnings options"]').click({ timeout: TIMEOUT })

  const toggle = page.locator('.v-menu__content div.subtitle-2', { hasText: /^Idle fleets$/ }).locator('xpath=following-sibling::div[contains(@class, "v-input--switch")][1]')

  await toggle.waitFor({ state: 'attached', timeout: TIMEOUT })
  await page.waitForFunction((element) => window.__screen.visible(element.querySelector('label')), await toggle.elementHandle({ timeout: TIMEOUT }), { timeout: TIMEOUT })

  const label = await toggle.evaluate((element) => { const text = element.querySelector('label'); return { on: window.__screen.visible(text), text: window.__screen.visibleText(text) } })

  step('switching the option on')
  await toggle.locator('label').click({ timeout: TIMEOUT })
  await page.waitForFunction(settledOn, { uid, key: READ, on: true }, { timeout: TIMEOUT })
  await page.evaluate(async () => { await window.$app.$nextTick() })
  await showAll()
  step('reading the screen with the option on')

  const on = await page.evaluate(readScreen, CHECK)

  return { off, on, label }
})

// The lines of a screen the player can see, in the order drawn, each row in the group of the line over it: 'listed' before any such line, else the reason the line over it gives read back through the table of reasons.
const tableOf = (o, screen) => {
  const groups = [{ kind: 'listed', count: null, rows: [] }]

  screen.lines.filter((line) => line.on).forEach((line) => {
    if (line.separator) {
      const spaces = [...line.text.matchAll(/ /g)].map(({ index }) => index)
      const reads = spaces.map((index) => [labelKey(line.text.slice(index + 1), o.separatorWords), readFigure(line.text.slice(0, index), screen.grouping)]).filter(([kind, count]) => kind !== null && count !== null)

      if (reads.length !== 1) {
        throw new HarnessError(`the line over the rows listed apart reads ${reads.length} ways: ${line.text}`)
      }

      groups.push({ kind: reads[0][0], count: reads[0][1], rows: [] })
    } else {
      groups[groups.length - 1].rows.push(line)
    }
  })

  return groups
}

const regionRead = (what, entries, roles) => [...Object.entries(roles).flatMap(([role, [wanted, read]]) => rolesRead(what, entries.filter((entry) => entry.role === role), { [role]: wanted }, read)), ...rolesRead(what, entries.filter((entry) => !Object.prototype.hasOwnProperty.call(roles, entry.role)), {})]

// The rows a screen draws against SQL's idle fleets `fleets` ({ id, name, ships, caption, group }): each paired by the id of its fleet, in the group the reason says, with its name, its ships and the place it names, and nothing else on screen.
const pageProblems = (o, screen, fleets, label) => {
  if (!screen.section) {
    return [[label, 'the section of the check is not shown']]
  }

  const groups = tableOf(o, screen)
  const lines = groups.flatMap((group) => group.rows.map((line) => ({ ...line, group: group.kind })))
  const { pairs, problems } = pairedBy(label, lines, fleets, (line) => line.id, (fleet) => `fleet:${fleet.id}`)
  const hidden = screen.lines.filter((line) => !line.separator && !line.on).map((line) => line.id)
  const apart = fleets.filter((fleet) => fleet.group === 'unevaluated').length
  const found = groups.slice(1).map((group) => [group.kind, group.count])

  pairs.forEach(([fleet, line]) => {
    const id = `fleet:${fleet.id}`
    const drawn = regionRead(`the row ${id}`, line.cells, {
      fleet: [asShown(fleet.name), (text) => text],
      ships: [fleet.ships, (text) => readFigure(text, screen.grouping)],
      orders: [true, (text) => text.length > 0],
      caption: [true, (text) => captionIs(text, fleet.caption.map((part) => (typeof part === 'string' ? asShown(part) : part)), o.words)],
    })

    if (line.group !== fleet.group) {
      problems.push([id, 'is shown under', line.group, fleet.group])
    }

    if (drawn.length) {
      problems.push(...drawn)
    }
  })

  if (hidden.length) {
    problems.push([label, 'rows are there and cannot be seen', hidden])
  }

  if (JSON.stringify(found) !== JSON.stringify(apart ? [['unevaluated', apart]] : [])) {
    problems.push([label, 'the lines over the rows listed apart', found, apart])
  }

  return problems
}

const expectedRows = (truth, on) => [...truth.fleets.values()].filter((fleet) => on || !fleet.parked).map((fleet) => ({ ...fleet, group: !on && fleet.unevaluated ? 'unevaluated' : 'listed' }))

const PAGE_CHECKS = [
  ['page-off', 'with the option off the Warnings page lists the idle fleets away from the colonies and anchorages as SQL says, each paired by the id of its fleet, under the line of its group, with its name, its ships and the place it names, and the fleets with no stored position apart', (o, t) => {
    const problems = pageProblems(o, o.page.off, expectedRows(t.copy, false), 'the page with the option off')

    return problems.length === 0 || short(problems.slice(0, 3))
  }],
  ['page-on', 'with the option switched on the page lists every idle fleet, each under the place it is in, the fleets parked at a colony or a fleet by its name', (o, t) => {
    const problems = pageProblems(o, o.page.on, expectedRows(t.copy, true), 'the page with the option on')

    return problems.length === 0 || short(problems.slice(0, 3))
  }],
  ['page-title', 'the title counts the fleets listed and names the places the parked ones are left out at only while the option is off, and the label of the option names those places and speaks in no first or second person', (o, t) => {
    const problems = []
    const off = titleRead(o.page.off.title, o.page.off.grouping)
    const on = titleRead(o.page.on.title, o.page.on.grouping)
    const away = expectedRows(t.copy, false).filter((fleet) => fleet.group === 'listed').length

    if (off.count !== away || !off.rest.includes(o.places)) {
      problems.push(['the title with the option off', o.page.off.title, away, o.places])
    }

    if (on.count !== t.copy.fleets.size || on.rest.includes(o.places)) {
      problems.push(['the title with the option on', o.page.on.title, t.copy.fleets.size, o.places])
    }

    if (!o.page.label.on || typeof o.page.label.text !== 'string' || !o.page.label.text.includes(o.places) || FIRST_OR_SECOND_PERSON.test(o.page.label.text)) {
      problems.push(['the label of the option', o.page.label])
    }

    return problems.length === 0 || short(problems)
  }],
]

// ---------- the faults and the rewrites ----------

// [name, edits [[file, from, to]], the ids of the checks one of which must fail by a value, whether the page is read too]. Anchors are code, keys and attributes.
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  ['a colony counts only on the body the fleet orbits', [['fleets', '({ population, verdict: atPlace(fleet, population) })', '({ population, verdict: Number(population.SystemBodyID === fleet.OrbitBodyID) })']], ['colonies', 'names', 'save-modded', 'save-egg', 'save-copy', 'page-off'], true],
  ['a fleet exactly 1 km away is at the place', [['fleets', 'Math.abs(Number(fleet[axis]) - Number(other[axis])) < NEAR', 'Math.abs(Number(fleet[axis]) - Number(other[axis])) <= NEAR']], ['distance']],
  ['the system is not compared', [['fleets', 'allOf(isKnownNumber(fleet.SystemID) && isKnownNumber(other.SystemID) ? Number(fleet.SystemID) === Number(other.SystemID) : null, ...AXES.map(', 'allOf(...AXES.map(']], ['away', 'stations']],
  ['only the x axis is compared', [['fleets', '...AXES.map((axis) =>', '...AXES.slice(0, 1).map((axis) =>']], ['distance']],
  ['only the y axis is compared', [['fleets', '...AXES.map((axis) =>', '...AXES.slice(1).map((axis) =>']], ['away']],
  ['a position that is not stored is 0', [['fleets', 'isKnownNumber(fleet[axis]) && isKnownNumber(other[axis]) ? Math.abs(Number(fleet[axis]) - Number(other[axis])) < NEAR : null', 'Math.abs(Number(fleet[axis]) - Number(other[axis])) < NEAR']], ['unevaluated']],
  ['the colonies of every race are read', [['fleets', ' and FCT_Population.RaceID = ${RaceID} order by', ' order by']], ['away', 'save-copy', 'save-egg']],
  ['the fleets of every race are read as fleets with modules', [['fleets', ' and FCT_Fleet.RaceID = ${RaceID} and ${UNDOCKED} and (', ' and ${UNDOCKED} and (']], ['stations']],
  ['only maintenance modules count', [['fleets', 'in (${MAINTENANCE_MODULE}, ${RECREATIONAL_MODULE})', 'in (${MAINTENANCE_MODULE})']], ['stations']],
  ['only recreational modules count', [['fleets', 'in (${MAINTENANCE_MODULE}, ${RECREATIONAL_MODULE})', 'in (${RECREATIONAL_MODULE})']], ['stations']],
  ['the fleet counts as its own station', [['fleets', '.filter((station) => station.FleetID !== fleet.FleetID)', '.filter(() => true)']], ['stations']],
  ['a damaged module counts', [['fleets', 'max(FCT_ClassComponent.NumComponent - ${DAMAGED_MODULES}, 0)', 'max(FCT_ClassComponent.NumComponent - 0, 0)']], ['stations']],
  ['one undamaged module is not enough', [['fleets', 'modules.Working > 0 ? 1', 'modules.Working > 1 ? 1']], ['stations']],
  ['a damaged module with no stored number is not damaged', [['fleets', 'case when FCT_ClassComponent.NumComponent is null or ${DAMAGE_UNKNOWN} then null', 'case when FCT_ClassComponent.NumComponent is null then null']], ['unevaluated']],
  ['a module count that is not stored is 0', [['fleets', 'case when FCT_ClassComponent.NumComponent is null or ${DAMAGE_UNKNOWN} then null else max(FCT_ClassComponent.NumComponent - ${DAMAGED_MODULES}, 0) end', 'case when ${DAMAGE_UNKNOWN} then null else max(coalesce(FCT_ClassComponent.NumComponent, 0) - ${DAMAGED_MODULES}, 0) end']], ['unevaluated']],
  ['a ship docked in a hangar counts', [['fleets', '\'coalesce(FCT_Ship.MothershipID, 0) = 0\'', '\'1\'']], ['stations']],
  ['a Training command is ignored', [['fleets', 'isKnownNumber(fleet.Training) ? Number(!fleet.Training) : null', '1']], ['training']],
  ['any command counts as a Training command', [['fleets', 'isKnownNumber(fleet.Training) ? Number(!fleet.Training) : null', 'isKnownNumber(fleet.Training) ? Number(!fleet.ParentCommandID) : null']], ['training']],
  ['a command whose type is not stored is not a Training command', [['fleets', 'isKnownNumber(fleet.Training) ? Number(!fleet.Training) : null', 'Number(!fleet.Training)']], ['unevaluated', 'training']],
  ['a fleet under a Training command is parked nowhere', [['fleets', 'Parked: placeKnown(fleet) ? ', 'Parked: placeKnown(fleet) ? fleet.Training === 1 ? 0 : ']], ['training']],
  ['a fleet is named for its station before its colony', [['fleets', 'ParkedName: colony ? colony.PopName || UNNAMED.colony : anchorage ? anchorage.station.FleetName || UNNAMED.fleet : null', 'ParkedName: anchorage ? anchorage.station.FleetName || UNNAMED.fleet : colony ? colony.PopName || UNNAMED.colony : null']], ['names']],
  ['the colony on the body the fleet orbits has no preference', [['fleets', 'Number(b.SystemBodyID === fleet.OrbitBodyID) - Number(a.SystemBodyID === fleet.OrbitBodyID) || ', '']], ['names']],
  ['a fleet is named for the smallest colony', [['fleets', '(b.Population || 0) - (a.Population || 0)', '(a.Population || 0) - (b.Population || 0)']], ['names']],
  ['one fleet whose modules are not known beats one that is known', [['fleets', 'Parked: placeKnown(fleet) ? ', 'Parked: placeKnown(fleet) ? anchorages.some((entry) => entry.verdict === null) ? null : ']], ['stations']],
  ['a fleet whose place is not known is away', [['fleets', 'fleet.Parked === null ? null : Number(!fleet.Parked)', 'Number(!fleet.Parked)']], ['unevaluated']],
  ['a fleet not evaluated names no input', [['fleets', '...(ctx.options.idleFleetsAtColonies || fleet.Parked !== null ? [] : fleet.ParkedGaps)', '...[]']], ['unevaluated']],
  ['a position that is not stored names the fleet\'s own input', [['fleets', '...(placeKnown(other) ? [] : [name])', '...(placeKnown(other) ? [] : [PARKED_GAPS.fleet])']], ['unevaluated']],
  ['any population of the system is taken', [['fleets', 'verdict: atPlace(fleet, population) }))', 'verdict: Number(population.SystemID === fleet.SystemID) }))']], ['away']],
  ['a component line with no stored type is not a module', [['fleets', "const COMPONENT_TYPE_UNKNOWN = '(FCT_ClassComponent.ClassID is not null and FCT_ShipDesignComponents.ComponentTypeID is null)'", "const COMPONENT_TYPE_UNKNOWN = '(FCT_ClassComponent.ClassID is not null and FCT_ShipDesignComponents.SDComponentID is null)'"]], ['unevaluated']],
  ['a component with no definition row is not a module', [['fleets', 'left join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where', 'inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where']], ['unevaluated']],
  ['an untyped component line leaves the support known', [['fleets', '(modules && modules.Gaps > 0) || station.Untyped > 0 || station.Unclassed > 0 ? null : 0', '(modules && modules.Gaps > 0) || station.Unclassed > 0 ? null : 0']], ['unevaluated']],
  ['an untyped component line names no input', [['fleets', '...(supports(station, fleet) === null && station.Untyped > 0 ? [PARKED_GAPS.componentType] : []),', '...[],']], ['unevaluated']],
  ['an untyped component line outweighs a module known to work', [['fleets', 'return modules && modules.Working > 0 ? 1 :', 'return station.Untyped > 0 ? null : modules && modules.Working > 0 ? 1 :']], ['stations']],
  ['a fleet with no stored position is not evaluated only while a place it could be at is unknown', [['fleets', 'Parked: placeKnown(fleet) ? anyOf(', 'Parked: true ? anyOf(']], ['unevaluated']],
  ['a fleet at a jump point is said to be in deep space', [['fleets', '} else if (fleet.JumpPointID) {', '} else if (false) {']], ['away']],
  ['a fleet in orbit is said to be in deep space', [['fleets', '} else if (fleet.OrbitBodyID > 0) {', '} else if (false) {']], ['away']],
  ['a row counts one ship', [['fleets', 'ships: ctx.count(fleet.Ships)', 'ships: ctx.count(1)']], ['rows', 'save-modded', 'save-egg', 'page-off'], true],
  ['a ship with no stored class or one that names no class is not read for a station', [['fleets', ' or ${SHIP_CLASS_UNKNOWN} or ${COMPONENT_TYPE_UNKNOWN}) group by', ' or ${COMPONENT_TYPE_UNKNOWN}) group by']], ['unevaluated']],
  ['a ship with no stored class is a ship with no modules', [['fleets', "const SHIP_CLASS_UNKNOWN = '(FCT_Ship.ShipClassID is null or FCT_ShipClass.ShipClassID is null)'", "const SHIP_CLASS_UNKNOWN = '(FCT_Ship.ShipClassID is not null and FCT_ShipClass.ShipClassID is null)'"]], ['unevaluated']],
  ['a class that names no class is a class with no modules', [['fleets', "const SHIP_CLASS_UNKNOWN = '(FCT_Ship.ShipClassID is null or FCT_ShipClass.ShipClassID is null)'", "const SHIP_CLASS_UNKNOWN = '(FCT_Ship.ShipClassID is null)'"]], ['unevaluated']],
  ['a ship class read through an inner join', [['fleets', 'left join FCT_ShipClass on FCT_ShipClass.ShipClassID', 'inner join FCT_ShipClass on FCT_ShipClass.ShipClassID']], ['unevaluated']],
  ['a ship whose class is not stored leaves the support known', [['fleets', ' || station.Untyped > 0 || station.Unclassed > 0 ? null : 0', ' || station.Untyped > 0 ? null : 0']], ['unevaluated']],
  ['a ship whose class is not stored names no input', [['fleets', '...(supports(station, fleet) === null && station.Unclassed > 0 ? [PARKED_GAPS.shipClass] : []),', '...[],']], ['unevaluated']],
  ['a ship whose class is not stored outweighs a module known to work', [['fleets', 'return modules && modules.Working > 0 ? 1 :', 'return station.Unclassed > 0 ? null : modules && modules.Working > 0 ? 1 :']], ['stations']],
  ['the missing class of a ship is counted only while the ship has no module line of a known type', [['fleets', 'count(distinct case when ${SHIP_CLASS_UNKNOWN} then FCT_Ship.ShipID end) as Unclassed', 'count(distinct case when ${SHIP_CLASS_UNKNOWN} and FCT_ShipDesignComponents.ComponentTypeID is null then FCT_Ship.ShipID end) as Unclassed']], ['unevaluated']],
  ['a component line with no stored component is a line with no module', [['fleets', '(FCT_ClassComponent.ClassID is not null and FCT_ShipDesignComponents', '(FCT_ClassComponent.ComponentID is not null and FCT_ShipDesignComponents']], ['unevaluated']],
  ['the option does not list the fleets parked', [['fleets', 'ctx.options.idleFleetsAtColonies ? fleet.Verdict : allOf(', 'false ? fleet.Verdict : allOf(']], ['option', 'save-modded', 'save-egg', 'page-on'], true],
  ['the caption of a parked fleet is the place it orbits', [['fleets', 'if (fleet.ParkedName) {', 'if (false) {']], ['names', 'save-egg', 'page-on'], true],
  ['the title names the places with the option on too', [['fleets', 'options.idleFleetsAtColonies ? \'\' : ', 'false ? \'\' : ']], ['page-title'], true],
  ['the rule\'s structure leaves out the ships\' mothership', [['fleets', '\'FCT_Ship.MaintenanceState, MothershipID, ShipClassID\'', '\'FCT_Ship.MaintenanceState, ShipClassID\'']], ['structure']],
  ['the rule\'s structure leaves out the class table of a ship', [['fleets', ', \'FCT_ShipClass.ShipClassID\'', '']], ['structure']],
  ['the rule speaks to the player', [['fleets', 'rule: \'A mobile military fleet', 'rule: \'Your mobile military fleet']], ['voice']],
  ['a row of the check is hidden', [['page', ':data-row="row.id">', ':data-row="row.id" v-show="false">']], ['page-off', 'page-on'], true],
  ['the caption of a row is drawn with no opacity', [['page', 'data-caption>', 'data-caption style="opacity: 0">']], ['page-off', 'page-on'], true],
  ['the check is drawn with no opacity', [['page', ':data-check="section.check.key">', ':data-check="section.check.key" style="opacity: 0">']], ['page-off', 'page-on'], true],
  ['the ships cell shows the name of the fleet', [['page', ':data-cell="column.key">{{ cellText(row, column) }}</span><provenance-mark', ':data-cell="column.key">{{ cellText(row, section.check.columns[0]) }}</span><provenance-mark']], ['page-off', 'page-on'], true],
  ['the title is not given the option', [['page', 'check.title(section.rows.length, this.options)', 'check.title(section.rows.length)']], ['page-title'], true],
  ['the option is labelled with other words', [['page', ':label="idleFleetsLabel"', 'label="Include idle fleets"']], ['page-title'], true],
]

// Rewrites that change nothing the checks observe, one of each family: each must leave every check passing. `same` names the ones that also leave the screen as it is.
const BENIGN = [
  ['an explicit prop and event instead of v-model on the muted switch', [['page', '<v-switch v-model="showMuted"', '<v-switch :input-value="showMuted" @change="showMuted = $event"']], true, true],
  ['v-on longhand for the change of the option', [['page', '@change="(value) => setOption(\'idleFleetsAtColonies\', !!value)"', 'v-on:change="(value) => setOption(\'idleFleetsAtColonies\', !!value)"']], true, true],
  ['a qualifier moved from the front to the back in the title', [['fleets', '${amount(count, \'idle fleet\')}${options.idleFleetsAtColonies', '${amount(count, \'fleet\')} (idle)${options.idleFleetsAtColonies']], true, false],
  ['the words of the captions reworded in their table', [['fleets', 'LOCATION_WORDS = Object.freeze({ parked: \'At\', orbiting: \'Orbiting\', jumpPoint: \'At a jump point in\', deepSpace: \'Deep space in\' })', 'LOCATION_WORDS = Object.freeze({ parked: \'Parked at\', orbiting: \'In orbit of\', jumpPoint: \'Waiting at a jump point in\', deepSpace: \'Drifting in\' })']], true, false],
  ['the places reworded in their name', [['fleets', 'PARKED_PLACES = \'colonies and anchorages\'', 'PARKED_PLACES = \'anchorages and colonies\'']], true, false],
  ['a parenthesised condition in the query', [['fleets', ' and ${UNDOCKED} and (', ' and (${UNDOCKED}) and (']], false, true],
  ['the column of a cell by its index', [['page', ':data-cell="column.key">{{ cellText(row, column) }}</span><provenance-mark', ':data-cell="column.key">{{ cellText(row, section.check.columns[index]) }}</span><provenance-mark']], true, true],
  ['full opacity on the check', [['page', ':data-check="section.check.key">', ':data-check="section.check.key" style="opacity: 1">']], true, true],
]
/* eslint-enable no-template-curly-in-string */

// ---------- the run ----------

let ENV = null
const cleanups = []
let checks = 0
let failures = 0

const report = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

// The checks of `list` over the observation `o` and the truth: { id, name, result, kind }; a check that throws stops the run.
const judge = (o, list, ids = null) => list.filter(([id]) => !ids || ids.includes(id)).map(([id, name, test]) => {
  let result

  try {
    result = test(o, ENV.truth)
  } catch (error) {
    throw new HarnessError(`the check ${id} threw: ${error && error.message ? error.message : error}`)
  }

  return { id, name, result, kind: result === true ? null : 'assertion' }
})

const told = (label, seen) => {
  if (seen.error !== null) {
    console.error(describe(label, seen))
  }

  return seen
}

// The texts of the files with `edits` made, each applied exactly once.
const textsWith = (edits) => {
  const texts = { ...ENV.original }

  edits.forEach(([key, from, to]) => { texts[key] = patched(FILE[key], texts[key], from, to) })

  return texts
}

// The page with `edits` made to it (none for the page as it is): the files the page loads replaced in the page server for the observation, then restored.
const view = async (edits) => {
  const texts = textsWith(edits)

  edits.forEach(([key]) => ENV.server.replace(path.join(root, FILE[key]), texts[key]))

  try {
    return told(edits.length ? 'a variant of the page' : 'the page', await observePage(ENV.chrome, ENV.server.url))
  } finally {
    edits.forEach(([key]) => ENV.server.replace(path.join(root, FILE[key]), null))
  }
}

const pageSeen = (seen, label) => {
  validate(seen, label)

  if (unobserved(seen)) {
    throw new HarnessError(`${label} did not get through: ${failureLine(seen)}`)
  }

  return seen.value
}

const resultsOf = async (edits, withPage) => {
  const o = await observeModule(textsWith(edits))

  if (withPage) {
    o.page = pageSeen(await view(edits), `the page with ${edits.map(([, from]) => from).join(', ')}`)
  }

  return { results: judge(o, withPage ? [...MODULE_CHECKS, ...PAGE_CHECKS] : MODULE_CHECKS), page: o.page }
}

const checkHead = async () => {
  const o = await observeModule(ENV.original)

  judge(o, MODULE_CHECKS).forEach(({ id, name, result }) => report(`${id}: ${name}`, result))

  const seen = await view([])

  if (unobserved(seen)) {
    PAGE_CHECKS.forEach(([id, name]) => report(`${id}: ${name}`, `the page did not get through: ${failureLine(seen)}`))
  } else {
    judge({ ...o, page: seen.value }, PAGE_CHECKS).forEach(({ id, name, result }) => report(`${id}: ${name}`, result))
  }

  const own = judge({}, [['probe', 'a check that fails by its own value', () => 'what was seen']])
  const holds = judge({}, [['probe', 'a check that holds', () => true]])

  report('control: a check that fails by its own verdict credits a fault named for it, and one that holds does not', caughtBy(own, ['probe']) && !caughtBy(holds, ['probe']) ? true : 'the credit of a fault does not follow the verdict')

  const words = { parked: 'At', orbiting: 'Orbiting', jumpPoint: 'At a jump point in', deepSpace: 'Deep space in' }
  const reads = [captionIs('At a jump point in Alpha', ['jumpPoint', 'Alpha'], words), captionIs('At a jump point in Alpha', ['parked', 'a jump point in Alpha'], words), captionIs('At a jump point in Alpha', ['parked', 'Alpha'], words), captionIs('Orbiting Alpha', ['orbiting', null], words), captionIs('Alpha', ['orbiting', null], words), captionIs('Deep space in Alpha', ['parked', 'Alpha'], words), captionIs('At Alpha', ['parked', 'Alpha Colony'], words)]

  report('control: a caption reads back through the table of words as its kind and its name whole, a name that is null is not compared, and a caption of another kind or another name does not read', JSON.stringify(reads) === JSON.stringify([true, true, false, true, false, false, false]) ? true : `read ${JSON.stringify(reads)}`)

  const titles = [titleRead('29 idle fleets away from the colonies', 'Tick'), titleRead('1\'234 idle fleets', 'Tick'), titleRead('1234 idle fleets', 'Tick'), titleRead('idle', 'Tick')]

  report('control: a title reads as a figure whole in the grouping of the setting and the words after it', JSON.stringify(titles.map(({ count }) => count)) === JSON.stringify([29, 1234, null, null]) ? true : `read ${JSON.stringify(titles)}`)
}

const reportFault = ([name, , fails], results) => {
  const failed = results.filter(({ kind }) => kind === 'assertion')
  const credited = failed.filter(({ id }) => fails.includes(id))

  report(`fault caught: ${name}`, caughtBy(failed, fails, { name }) ? true : `these checks do not fail by a value: ${fails.join(', ')} (failed: ${failed.map(({ id }) => id).join(', ') || 'none'})`, `caught by ${credited.map(({ id }) => id).join(', ')}`)

  if (DETAIL) {
    credited.forEach(({ id, result }) => console.log(`         ${id}: ${String(result).slice(0, 300)}`))
  }
}

const checkFault = async (fault) => {
  reportFault(fault, (await resultsOf(fault[1], Boolean(fault[3]))).results)
}

const checkBenign = async ([name, edits, page, same]) => {
  if (page && unobserved(ENV.baseline)) {
    throw new HarnessError(`the page as it is was not observed, so the rewrite has no screen to be set against: ${failureLine(ENV.baseline)}`)
  }

  const { results, page: seen } = await resultsOf(edits, page)
  const wrong = results.filter(({ result }) => result !== true).map(({ id }) => id)
  const unchanged = !page || !same || JSON.stringify(seen) === JSON.stringify(ENV.baseline.value)

  report(`variant passes: ${name}`, wrong.length === 0 && unchanged ? true : wrong.length ? `fails ${wrong.join(', ')}` : 'the screen it draws is not the page\'s')
}

const checkEveryBenign = async () => {
  const edits = BENIGN.flatMap(([, list]) => list)
  const wrong = (await resultsOf(edits, true)).results.filter(({ result }) => result !== true).map(({ id }) => id)

  report('variant passes: every benign rewrite together', wrong.length === 0 ? true : `fails ${wrong.join(', ')}`)
}

// A copy of saves/AuroraDB.db the page serves and SQL here reads, with three idle fleets away from every colony and anchorage put elsewhere: one beside a fleet with an undamaged maintenance module on a ship that is not docked and no colony within 1 km of it, one on the position of a colony its orbit does not name (orbit 0), and one in the system of that colony with no stored position and no orbit.
const copyOfSave = async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-idle-fleets-'))
  const file = path.join(folder, 'save.db')

  fs.copyFileSync(path.join(root, PAGE_SAVE.file), file)
  cleanups.push(async () => fs.rmSync(folder, { recursive: true, force: true }))

  const raw = await openRaw(file, sqlite3.OPEN_READWRITE)

  cleanups.push(() => closeRaw(raw))

  const database = standIn(raw)
  const before = await truthOf(database, PAGE_SAVE)

  assert.ok(before.nulls.length === 0, `the save stores ${before.nulls.join(', ')}`)

  const away = [...before.fleets.values()].filter((fleet) => !fleet.parked).map((fleet) => fleet.id)
  const [station] = await allRows(raw, `select g.FleetID, g.FleetName, g.SystemID, g.Xcor, g.Ycor from FCT_Fleet g where g.GameID = ${PAGE_SAVE.GameID} and g.RaceID = ${PAGE_SAVE.RaceID} and exists (select 1 from FCT_Ship s join FCT_ClassComponent c on c.ClassID = s.ShipClassID join FCT_ShipDesignComponents d on d.SDComponentID = c.ComponentID and d.ComponentTypeID = 48 where s.FleetID = g.FleetID and s.MothershipID = 0 and c.NumComponent > coalesce((select sum(x.Number) from FCT_DamagedComponent x where x.ShipID = s.ShipID and x.ComponentID = c.ComponentID), 0)) and not exists (select 1 from FCT_Population p join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where p.GameID = g.GameID and p.RaceID = g.RaceID and p.SystemID = g.SystemID and abs(g.Xcor - b.Xcor) < 1 and abs(g.Ycor - b.Ycor) < 1) order by g.FleetID limit 1`)
  const [colony] = await allRows(raw, `select p.PopName, p.SystemID, b.Xcor, b.Ycor from FCT_Population p join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where p.GameID = ${PAGE_SAVE.GameID} and p.RaceID = ${PAGE_SAVE.RaceID} order by p.PopulationID limit 1`)

  assert.ok(station && colony && away.filter((id) => id !== station.FleetID).length >= 3, 'the save holds a fleet with a maintenance module away from every colony, a colony, and three idle fleets away from every colony and anchorage')

  const [beside, onColony, unplaced] = away.filter((id) => id !== station.FleetID)
  const moves = [
    `update FCT_Fleet set SystemID = ${station.SystemID}, Xcor = ${station.Xcor}, Ycor = ${station.Ycor}, OrbitBodyID = 0 where FleetID = ${beside}`,
    `update FCT_Fleet set SystemID = ${colony.SystemID}, Xcor = ${colony.Xcor}, Ycor = ${colony.Ycor}, OrbitBodyID = 0 where FleetID = ${onColony}`,
    `update FCT_Fleet set SystemID = ${colony.SystemID}, Xcor = null, Ycor = null, OrbitBodyID = 0 where FleetID = ${unplaced}`,
  ]

  for (const statement of moves) {
    await runSql(raw, statement)
  }

  const truth = await truthOf(database, PAGE_SAVE, [unplaced])

  assert.ok(truth.fleets.get(beside).parked, 'the fleet put beside the station is parked')
  assert.ok(truth.fleets.get(onColony).parked, 'the fleet put on a colony is parked')
  assert.ok(truth.fleets.get(unplaced).unevaluated, 'the fleet with no stored position is not evaluated')

  return { folder, file, database, truth }
}

// What a worker sets up once before its first variant: the fixtures, the saves read only, the copy of the save with its three fleets moved, what SQL says of each, the texts of the files a variant may change, and one page server over the copy, warmed, with one Chromium.
const setUp = async () => {
  const { startPageServer } = require('./lib/page-server')
  const env = { cache: new Map(), original: {}, saves: [], baseline: null }

  Object.keys(FILE).forEach((key) => { env.original[key] = fs.readFileSync(path.join(root, FILE[key]), 'utf8') })
  env.fixture = await openFixture()
  cleanups.push(() => closeRaw(env.fixture.raw))

  for (const save of SAVES) {
    const raw = await openRaw(path.join(root, save.file), sqlite3.OPEN_READONLY)

    cleanups.push(() => closeRaw(raw))
    env.saves.push(standIn(raw))
  }

  env.copy = await copyOfSave()
  env.truth = { copy: env.copy.truth, saves: [] }

  for (const [index, save] of SAVES.entries()) {
    env.truth.saves.push(await truthOf(env.saves[index], save))
  }

  env.server = await startPageServer({ save: env.copy.file })
  cleanups.push(() => env.server.stop())
  env.chrome = await require('playwright').chromium.launch()
  cleanups.push(() => env.chrome.close())

  const warmed = await env.server.warm(env.chrome, { routes: ['/warnings'] })

  console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)

  return env
}

// The deadlines, in seconds: the head reads the module on nine databases and the page twice, a module fault the module once, and a variant of the page opens the app once more; the setup is the one cold start of the run.
const DEADLINES = { head: 600, module: 240, view: 360, setup: 900 + 180 }
const CONTROL_FAULT = 'a row of the check is hidden'

const variantsOf = (mutating) => [
  { key: 'head', name: 'the head: the module on the fixtures and the saves, the page, and the controls of the harness', head: true, heading: 'The idle fleets warning (fixtures, saves, and scripts/lib/page-server.js over a copy of a save)', pool: 'suite', deadline: DEADLINES.head, run: checkHead },
  ...(mutating ? FAULTS.map((fault, index) => ({ key: `fault:${index}`, name: `fault caught: ${fault[0]}`, heading: '\nplanted faults', pool: 'suite', deadline: fault[3] ? DEADLINES.view : DEADLINES.module, run: () => checkFault(fault) })) : []),
  ...(mutating ? BENIGN.map((rewrite, index) => ({ key: `benign:${index}`, name: `variant passes: ${rewrite[0]}`, heading: '\nvariants that say the same thing', pool: 'suite', deadline: DEADLINES.view, baseline: rewrite[2], run: () => checkBenign(rewrite) })) : []),
  ...(mutating ? [{ key: 'benign:all', name: 'variant passes: every benign rewrite together', heading: '\nvariants that say the same thing', pool: 'suite', deadline: DEADLINES.view, run: checkEveryBenign }] : []),
]

const main = async () => {
  const mutating = !process.argv.includes('--no-mutations')
  const totals = await runSuite({
    script: __filename,
    inputs: SAVES.map((save) => save.file).filter((file) => file.startsWith('saves/')),
    variants: variantsOf(mutating),
    counts: () => ({ checks, failures }),
    prepare: async (queue) => {
      ENV = await setUp()

      if (queue.some((variant) => variant.baseline)) {
        ENV.baseline = await view([])
      }
    },
    afterEach: async () => {
      if (ENV && ENV.server) {
        await ENV.server.reset()
      }
    },
    close: async () => {
      const problems = []

      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup().catch((error) => problems.push(String(error && error.message ? error.message : error).split('\n')[0]))
      }

      if (problems.length) {
        throw new Error(`cleanups failed: ${problems.join(' | ')}`)
      }
    },
    control: mutating ? { fault: `fault:${FAULTS.findIndex((fault) => fault[0] === CONTROL_FAULT)}`, head: 'head', heading: '\nthe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
