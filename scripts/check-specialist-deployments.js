/*
  Checks the specialist deployments of the Survey Progress page (src/renderer/utilities/specialist-deployments.js over the formation model of utilities/ground-formations.js, and the page's own reads) against figures worked out by hand, against SQL written separately here and against the saves.

  Run: bun scripts/check-specialist-deployments.js [--no-mutations] [--detail] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The groups, each check a PASS or FAIL line:
  - A constructed race of 27 formations (busy, idle, embarked, unresolved and of unknown activity; one, both or no rating; a template that names far more than the formation holds) against ground survey bodies and ruins held in a small database built here from the saves' own table definitions (a hidden body, a body in a system the race does not know, a completed body, colonies of 0, 0.9999, 1, 1.0001 and an unstored population, colonies on ruins the race has not surveyed, in a system it does not know, with no installations count, identified and used up): the states, the targets, the candidates, the troop lifts, the totals and the ground survey rates are worked out by hand.
  - The view preferences, the page's lists, sort keys and load state, on the page's pseudo instance (the page's script without its template).
  - The named saves, opened read-only: the targets, the ruins, the states, the lifts and the ground survey rates (of every colony of the race, not only those with ground survey work) are compared with SQL written separately here, and with the counts the saves are known to hold.
  - The page in a browser: the real renderer, served by Vite from a copy of a save (scripts/lib/page-server.js), is driven through its controls (each role chip, each state chip and the switch of the targets are clicked) and what it draws is read back (the rows and counts shown, the summary of every panel, the preference that is restored when the page is left and opened again). The expected rows come from the pseudo instance and SQL; nothing reads the template or the wording of a heading. The screen is read by the shared readers of scripts/lib/browser-observe.js (`installScreen`: an element counts when it is on screen with its opacity and its ancestors', and its text is the text it draws): a hook names the role or the identity of an element, and every decision is read from what the element draws, a chip's role and figure from its words through the module's own tables of roles and states and from its figure in the grouping of the setting (`labelKey`, `readFigure`), a formation's state from the words of its label through the table of states besides its hook, and the rows and the targets are set against the expected ones by their identity (`pairedBy`, `rolesRead`), never by their place.
  - The page on copies of a save that lack what one optional read of the page needs (the ancient constructs without their Active column or table, the ruins without the known-ruin table, the troop ships without the capacity column), each in a process of its own: the real capability check leaves the page in service with that input degraded, the panels are drawn, and the formations whose work cannot be told read as unknown, never as idle. The planted fault serves the capability registry with that input required, which makes the page unsupported.
  - Planted faults in a copy of the utility and of the page, each of which must make a named check fail on an assertion (a fault in the page's template is served to the browser, a figure or a label drawn wrong with its hook left as it is and a part drawn at opacity 0 among them), and benign rewrites (an explicit prop and event instead of v-model, a longhand v-on, a heading reworded, a qualifier moved from the front to the back, a synonym in generated prose, a parenthesised condition, a figure with its places named, a label looked up in the table, a part drawn at opacity 1) that must make none fail. A fault is caught only when a check named for it fails with an assertion of its own: the assertion helper of the checks marks what it throws, the code under test is run only through explicit adapters (the functions of the utility, the normalisers of the views, and the computed values, methods, reads, data and hooks of the page's pseudo instance) that turn a throw or a rejection into a marked failure naming the call, and any other exception, an AssertionError thrown by the code under test included, stops the run when a fault or a rewrite is judged. A fault credited only by such a call that threw stops the run too, unless it declares that a throw is how it is caught (`{ throws: true }`, scripts/lib/fault-credit.js `caughtBy`); each PASS line names the checks that credit it and whether each read a value or a throw.
  - Controls of the harness, each paired with the case that is as it should be: the mark of an assertion and the adapters (a throw, a rejection and a getter that throws, with an AssertionError and with any other error), a lookup and a callback of the harness that go wrong and a malformed store (each stops the run), a normaliser of a view that throws, a crash of the harness itself in the context handed to a check (on healthy code, a benign rewrite and a fault), a fault that makes a computed value throw, a failure of the page on the first start only, a child that prints a result and then fails, hangs or closes with a cleanup that fails, a result that cannot be read and one that is not two whole observations, an error raised only in the half read with an input required, the records handed to a check with an input required, whole or not, the status of the process when a cleanup fails after a failure of its own, and `--only` selecting the fault of one input in a child of its own (which judges the records of the page this run made, `--records`, and starts no browser). What the page raises (a page error, or a console error, where Vue logs what it catches) fails the observation that saw it; a cleanup that fails ends the process with a status other than 0; a record that is not whole stops the run.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2. A save that is not there fails its checks: none is skipped. The head (`head`) and every fault, control and rewrite (`planted:N`, `required:<input>`, `controls`, `benign:N`) run through scripts/lib/suite-runner.js: one after another in a worker that opens the saves, makes the copies of the browser's save, starts one page server and one browser and warms them first, each with a deadline, with a record that --resume continues and the control `control:warm-reset`, which runs a planted fault and then the head on the same server. The cases of the optional reads keep a page server of their own each, warmed in their process before they are read. --only=<text> runs the head and the variants whose names hold the text (a focused run while working; the run that counts has none).
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const rawAssert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { loadPage, instantiate } = require('./lib/page-loader')
const { startPageServer } = require('./lib/page-server')
const { observe, validate, failedObservation, completedObservation, failureLine, report, HarnessError, installScreen, readFigure, rolesRead, pairedBy, labelKey, settled } = require('./lib/browser-observe')
const { assert, through, harnessOwn, boundary, subjectModule, runChecks, judged, caughtBy, infrastructureFailure } = require('./lib/fault-credit')
const { runChild } = require('./lib/check-pool')
const { runSuite, step: sayStep } = require('./lib/suite-runner')
const { pretendBrowser, NAVIGATION_FAILED } = require('./lib/pretend-browser')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const SPEC_FILE = path.join(utilitiesDirectory, 'specialist-deployments.js')
const SURVEY_UTILITY_FILE = path.join(utilitiesDirectory, 'survey.js')
const SURVEY_FILE = path.join(root, 'src', 'renderer', 'pages', 'survey-progress.vue')

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

// The persisted view mixin, keeping the fields the page declares on the mixin (the stub of the page loader builds data only).
const VIEW_MODULE = `
  export const oneOf = (values) => (value) => values.includes(value)
  export const tableView = (key, defaults) => ({ key, default: defaults })
  export default (fields) => ({ fields, data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) })
`

const options = { mutations: !process.argv.includes('--no-mutations') }
// `--detail` prints, under the line of each planted fault, what each check credited with it said.
const detailed = process.argv.includes('--detail')

let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

const frozen = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }

  return value
}

const sorted = (list) => [...list].sort((a, b) => a - b)
const ids = (rows) => rows.map((row) => row.id)
const near = (actual, expected, message = '') => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${message} ${actual} is not ${expected}`)

// A check: `run(ctx)` returns normally to pass and throws (assert) to fail.
const results = []
const add = (id, name, run) => results.push({ id, name, run })

// Who failed: scripts/lib/fault-credit.js. A check fails by an assertion of its own (`assert` marks what it throws), and a fault is credited only when a check named for it failed with a marked assertion. The code under test (the utility module, the normalisers of the views, and the page's computed values, methods, reads, data and hooks) is run only through `through` and the `boundary`; any other exception is the harness's own, and stops the run (`runChecks` and `judge`): a lookup the harness gets wrong, a callback of the harness that throws (`harnessOwn`) or a fixture it cannot build.

// The view fields of the page, the normaliser of each behind `through`.
const subjectFields = (fields) => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, Object.fromEntries(Object.entries(field).map(([key, member]) => [key, typeof member === 'function' ? (...args) => through(`the ${key} of the view ${name}`, () => member(...args)) : member]))]))

// ---------- the constructed race ----------

const RACE = 7
const GAME = 1

let rowSequence = 0

const formationRow = (FormationID, over = {}) => ({ FormationID, Name: `Formation ${FormationID}`, Abbreviation: `F${FormationID}`, RaceID: RACE, GameID: GAME, OriginalTemplateID: 0, ReplacementTemplateID: 0, PopulationID: 0, ShipID: 0, ParentFormationID: 0, ...over })
const elementRow = (FormationID, ClassID, Units = 1) => ({ RowID: ++rowSequence, ElementID: rowSequence * 10, FormationID, ClassID, SpeciesID: 1, Units })
const classRow = (GroundUnitClassID, ClassName, ComponentA, Size = 5) => ({ GroundUnitClassID, ClassName, Size, ComponentA, ComponentB: 0, ComponentC: 0, ComponentD: 0 })

// The colonies, by id: 1 to 5 on the ground survey bodies 101 to 105 (population 0, 0.9999, 1, 1.0001 and not stored), 6 on the ruin 111 (so is colony 11, which holds no formation), 7 a quiet colony (body 120, no work, an active ancient construct), 8 on body 109 (the survey is completed), 9 in no system and 10 on no body. All are in system 50 (Sol) except 9. Colonies 12 to 17 stand where the race has not surveyed or has nothing to find: 12 on the ruin 114 the race has not surveyed, 13 on the ruin 115 in a system it does not know (Beta), 14 on the ruin 116 with no installations count, 15 on the ruin 112 whose builders are identified, 16 on the ruin 117 that is used up and not surveyed, 17 on the body 107 with ground survey potential that the race has not surveyed. Colonies 18 and 19 stand on ancient constructs: 18 on the body 122 (a construct that is not active, on a body the race has not surveyed), 19 on the body 123 (a construct with no stored state).
const POPULATIONS = [
  { PopulationID: 1, PopName: 'Zero', RaceID: RACE, SystemID: 50, SystemBodyID: 101, SystemName: 'Sol' },
  { PopulationID: 2, PopName: 'Almost one', RaceID: RACE, SystemID: 50, SystemBodyID: 102, SystemName: 'Sol' },
  { PopulationID: 3, PopName: 'Exactly one', RaceID: RACE, SystemID: 50, SystemBodyID: 103, SystemName: 'Sol' },
  { PopulationID: 4, PopName: 'Just over one', RaceID: RACE, SystemID: 50, SystemBodyID: 104, SystemName: 'Sol' },
  { PopulationID: 5, PopName: 'Not stored', RaceID: RACE, SystemID: 50, SystemBodyID: 105, SystemName: 'Sol' },
  { PopulationID: 6, PopName: 'Digsite', RaceID: RACE, SystemID: 50, SystemBodyID: 111, SystemName: 'Sol' },
  { PopulationID: 7, PopName: 'Quiet', RaceID: RACE, SystemID: 50, SystemBodyID: 120, SystemName: 'Sol' },
  { PopulationID: 8, PopName: 'Finished', RaceID: RACE, SystemID: 50, SystemBodyID: 109, SystemName: 'Sol' },
  { PopulationID: 9, PopName: 'Nowhere', RaceID: RACE, SystemID: null, SystemBodyID: 121, SystemName: null },
  { PopulationID: 10, PopName: 'Bodiless', RaceID: RACE, SystemID: 50, SystemBodyID: null, SystemName: 'Sol' },
  { PopulationID: 12, PopName: 'Unsurveyed ruin', RaceID: RACE, SystemID: 50, SystemBodyID: 114, SystemName: 'Sol' },
  { PopulationID: 13, PopName: 'Strange system', RaceID: RACE, SystemID: 51, SystemBodyID: 115, SystemName: 'Beta' },
  { PopulationID: 14, PopName: 'Uncounted ruin', RaceID: RACE, SystemID: 50, SystemBodyID: 116, SystemName: 'Sol' },
  { PopulationID: 15, PopName: 'Known builders', RaceID: RACE, SystemID: 50, SystemBodyID: 112, SystemName: 'Sol' },
  { PopulationID: 16, PopName: 'Spent ruin', RaceID: RACE, SystemID: 50, SystemBodyID: 117, SystemName: 'Sol' },
  { PopulationID: 17, PopName: 'Unsurveyed body', RaceID: RACE, SystemID: 50, SystemBodyID: 107, SystemName: 'Sol' },
  { PopulationID: 18, PopName: 'Dormant construct', RaceID: RACE, SystemID: 50, SystemBodyID: 122, SystemName: 'Sol' },
  { PopulationID: 19, PopName: 'Unstored construct', RaceID: RACE, SystemID: 50, SystemBodyID: 123, SystemName: 'Sol' },
]

// Formations: [id, location, elements [class, units]...]. Class 11 is geo (0.1 a unit), 12 xeno (0.5), 17 geo 0.2 with the xeno rating unstored, 20 geo with no size stored, 22 a class whose component the catalogue lacks, 10 infantry; every unit is 5 t.
const FORMATIONS = [
  [1, { PopulationID: 1 }, [[11, 4]]],
  [2, { PopulationID: 6 }, [[12, 2]]],
  [3, { PopulationID: 2 }, [[11, 2], [12, 2]]],
  [4, { PopulationID: 7, OriginalTemplateID: 1 }, [[11, 18]]],
  [5, { PopulationID: 7 }, [[12, 4]]],
  [6, { ShipID: 100 }, [[11, 2]]],
  [7, { PopulationID: 9 }, [[12, 2]]],
  [8, { PopulationID: 10 }, [[11, 2]]],
  [9, {}, [[11, 2]]],
  [10, { PopulationID: 1 }, [[10, 3]]],
  [11, { PopulationID: 7 }, [[17, 6]]],
  [12, { PopulationID: 6 }, [[17, 5]]],
  [13, { PopulationID: 3 }, [[11, 1]]],
  [14, { PopulationID: 7 }, [[11, 30]]],
  [15, { PopulationID: 7 }, [[20, 2]]],
  [16, { PopulationID: 7 }, []],
  [17, { PopulationID: 8 }, [[11, 2]]],
  [18, { PopulationID: 4 }, [[11, 2]]],
  [19, { PopulationID: 5 }, [[11, 2]]],
  [20, { PopulationID: 2 }, [[22, 1]]],
  [21, { ShipID: 999 }, [[11, 2]]],
  [22, { PopulationID: 12 }, [[12, 1]]],
  [23, { PopulationID: 13 }, [[12, 1]]],
  [24, { PopulationID: 14 }, [[12, 1]]],
  [25, { PopulationID: 15 }, [[12, 1]]],
  [26, { PopulationID: 16 }, [[12, 1]]],
  [27, { PopulationID: 17 }, [[11, 3]]],
  [28, { PopulationID: 18 }, [[12, 1]]],
  [29, { PopulationID: 19 }, [[12, 1]]],
  [30, { PopulationID: 18 }, [[17, 1]]],
]

const constructedRows = () => {
  rowSequence = 0

  return {
    formations: FORMATIONS.map(([id, over]) => formationRow(id, over)),
    outsideParents: [],
    elements: FORMATIONS.flatMap(([id, , elements]) => elements.map(([classId, units]) => elementRow(id, classId, units))),
    classes: [classRow(10, 'Infantry', 0), classRow(11, 'Geo Survey', 26), classRow(12, 'Xeno Survey', 64), classRow(17, 'Half rated', 27), classRow(20, 'No size', 26, null), classRow(22, 'Broken', 99)],
    components: [
      { ComponentTypeID: 26, ComponentName: 'Geo', Geosurvey: 0.1, Xenoarchaeology: 0 },
      { ComponentTypeID: 64, ComponentName: 'Xeno', Geosurvey: 0, Xenoarchaeology: 0.5 },
      { ComponentTypeID: 27, ComponentName: 'Half', Geosurvey: 0.2, Xenoarchaeology: null },
    ],
    templates: [{ TemplateID: 1, RaceID: RACE, Name: 'Nominal', Abbreviation: 'NOM', Obsolete: 0 }],
    templateElements: [{ FormationTemplateID: 1, ClassID: 11, Units: 100 }],
    ships: [{ ShipID: 100, ShipName: 'Hauler', FleetID: 500, MothershipID: 0 }],
    fleets: [{ FleetID: 500, FleetName: 'Convoy', RaceID: RACE, SystemID: 9, OrbitBodyID: 77, SystemName: 'Alpha' }],
    populations: POPULATIONS,
  }
}

// The formation commanders of the constructed race, as rows of the page's ground command read ([formation, colony, parent, Survey bonus, own size, headquarters capacity]; a commander with no Survey bonus has a bonus of null). Worked by hand: 1 stands over its capacity with the formation 10 beneath it (20 + 15 against 25), so its multiplier is 1 and the colony 1 gives 0.4 × 1 × 1; 2 is no survey formation and stands over its capacity with 12 beneath it (10 + 25 against 20), so its parent share is 0 and 12, within its own 30, keeps its bonus 2; 4 has an own size of 10.6 (cut to 10, within a capacity of 10) and keeps 1.5; 14 holds 150 with 11 and 18 beneath it (190 against 200, within), so 11 has its own 1.6 times 1 + (2 - 1) × 0.25 = 2.0, and 18, of another colony, does not take the share and has its own 2; 13 holds 5 against a capacity of 3 and has a multiplier of 1; 19 has an element whose class gives no size, so its multiplier is not known.
const commandRow = (FormationID, PopulationID, ParentFormationID, BonusValue, Size, HQCapacity, over = {}) => ({ FormationID, ParentFormationID, PopulationID, HasCommander: 1, BonusValue, Size, Elements: 1, Known: 1, Capable: 1, HQCapacity, ...over })
const COMMAND_ROWS = [
  commandRow(1, 1, 0, 2, 20, 25),
  commandRow(10, 1, 1, null, 15, 0, { HasCommander: 0 }),
  commandRow(2, 6, 0, 3, 10, 20),
  commandRow(12, 6, 2, 2, 25, 30),
  commandRow(4, 7, 0, 1.5, 10.6, 10),
  commandRow(11, 7, 14, 1.6, 30, 30),
  commandRow(14, 7, 0, 2, 150, 200),
  commandRow(18, 4, 14, 2, 10, 10),
  commandRow(13, 3, 0, 1.5, 5, 3),
  commandRow(19, 5, 0, 1.5, null, 5, { Known: 0 }),
]
// The effective multiplier of each geosurvey formation of the constructed race by those rows (null: not known), and the points a day of each colony whose rate is known, with a survey speed of 100 % (the rating times the multiplier, twice).
const MULTIPLIERS = { 1: 1, 12: 2, 4: 1.5, 11: 2, 14: 2, 15: 1, 18: 2, 13: 1, 19: null }
const DAILY = { 1: 0.4, 3: 0.1, 4: 0.8, 6: 4, 7: 21.05 }

// The states and masses the constructed race must show, by hand. Formation 4 names a template of 100 geo units and holds 18; 21 is aboard a ship the save lacks; 10, 16 and 20 are no specialists (no survey rating, no elements, a rating the save leaves unknown). A xenoarchaeology formation on a ruin outside the known targets may be at work, since the game works a ruin whatever the survey: 22 (the body not surveyed), 23 (the system not known) and 24 (no installations count) are of unknown activity, 12 too (the rating of its xenoarchaeology is not stored, where a target is); 25 (builders identified) and 26 (a used up ruin) are idle, and so is 27, a geological formation on a body the race has not surveyed, which the game does not work. The game also works a xenoarchaeology formation at a colony on an ancient construct that is not active, with no ruin and whatever the survey: 28 is busy on one (the body not surveyed by the race), 29 is of unknown activity on a construct with no stored state and 30, whose xenoarchaeology rating is not stored, on the first; 5, at a colony on an active construct, is idle.
const STATES = { busy: [1, 2, 3, 13, 18, 19, 28], idle: [4, 5, 11, 14, 15, 17, 25, 26, 27], embarked: [6], unresolved: [7, 8, 9, 21], unknown: [12, 22, 23, 24, 29, 30] }
const LISTED = sorted(Object.values(STATES).flat())
const OTHERS = [10, 16, 20]
const GEO = [1, 3, 4, 6, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19, 21, 27, 30]
const XENO = [2, 3, 5, 7, 22, 23, 24, 25, 26, 28, 29]
const MASS = { 1: 20, 2: 10, 3: 20, 4: 90, 5: 20, 6: 10, 7: 10, 8: 10, 9: 10, 11: 30, 12: 25, 13: 5, 14: 150, 15: null, 17: 10, 18: 10, 19: 10, 21: 10, 22: 5, 23: 5, 24: 5, 25: 5, 26: 5, 27: 15, 28: 5, 29: 5, 30: 5 }
const TROOPS = { classes: [{ TroopCapacity: 100, Ships: 1 }, { TroopCapacity: 40, Ships: 1 }] }
const ALL_ROLES = ['geo', 'xeno']
const ALL_STATES = ['idle', 'busy', 'embarked', 'unresolved', 'unknown']

// ---------- the small database: bodies, colonies and ruins of the constructed race ----------

// The tables the page's ground survey read, the ruin read and the construct read touch, taken from a save's own definitions.
const MEMORY_TABLES = ['FCT_SystemBody', 'FCT_SystemBodySurveys', 'FCT_RaceSysSurvey', 'FCT_SystemBodyName', 'FCT_Star', 'FCT_Population', 'DIM_Ruin', 'FCT_RuinRace', 'FCT_KnownRuinRace', 'FCT_AncientConstruct']

const body = (SystemBodyID, over = {}) => ({ SystemBodyID, GameID: GAME, SystemID: 50, StarID: 1, BodyClass: 1, PlanetNumber: 1, OrbitNumber: SystemBodyID - 100, BodyTypeID: 1, Radius: 3000, GroundMineralSurvey: 0, RuinID: 0, RuinRaceID: 0, AbandonedFactories: 0, ...over })

const colony = (PopulationID, SystemBodyID, Population, over = {}) => ({ PopulationID, GameID: GAME, RaceID: RACE, SystemBodyID, SystemID: 50, PopName: `Colony ${PopulationID}`, Population, GroundGeoSurvey: 0, ...over })

// Bodies 101 to 105 have ground survey potential and a colony of the race (a population of 0, 0.9999, 1, 1.0001 and none stored), 106 has potential and no colony (another race has one), 107 has potential and the race has not surveyed it (it has a colony), 108 is in a system the race does not know, 109 has its survey completed (and a colony). Ruins: 111 is found (two colonies), 112 identified (a colony), 113 used up, 114 unsurveyed by the race (a colony), 115 in a system the race does not know (a colony), 116 with no installations count stored (a colony), 117 used up and unsurveyed (a colony), 118 found and unsurveyed with no colony. Ancient constructs: 120 active (a colony), 122 not active and not surveyed by the race (a colony), 123 with no stored state (a colony), 125 not active with no colony of the race (another race has one).
const MEMORY = {
  FCT_SystemBody: [
    body(101, { GroundMineralSurvey: 3 }), body(102, { GroundMineralSurvey: 3 }), body(103, { GroundMineralSurvey: 2 }), body(104, { GroundMineralSurvey: 2 }), body(105, { GroundMineralSurvey: 2 }), body(106, { GroundMineralSurvey: 1 }),
    body(107, { GroundMineralSurvey: 4 }), body(108, { GroundMineralSurvey: 2, SystemID: 51 }), body(109, { GroundMineralSurvey: 0 }),
    body(111, { RuinID: 1, RuinRaceID: 3, AbandonedFactories: 5 }), body(112, { RuinID: 1, RuinRaceID: 4, AbandonedFactories: 4 }), body(113, { RuinID: 1, RuinRaceID: 3, AbandonedFactories: 0 }), body(114, { RuinID: 1, RuinRaceID: 3, AbandonedFactories: 5 }),
    body(115, { RuinID: 1, RuinRaceID: 3, AbandonedFactories: 5, SystemID: 51 }), body(116, { RuinID: 1, RuinRaceID: 3, AbandonedFactories: null }), body(117, { RuinID: 1, RuinRaceID: 3, AbandonedFactories: 0 }), body(118, { RuinID: 1, RuinRaceID: 3, AbandonedFactories: 5 }), body(120), body(121), body(122), body(123), body(125),
  ],
  FCT_SystemBodySurveys: [101, 102, 103, 104, 105, 106, 108, 109, 111, 112, 113, 115, 116, 120, 123].map((SystemBodyID) => ({ SystemBodyID, RaceID: RACE, GameID: GAME })),
  FCT_RaceSysSurvey: [{ SystemID: 50, RaceID: RACE, GameID: GAME, Name: 'Sol' }],
  FCT_SystemBodyName: [],
  FCT_Star: [{ StarID: 1, Component: 0 }],
  FCT_Population: [
    colony(1, 101, 0, { GroundGeoSurvey: 100 }), colony(2, 102, 0.9999), colony(3, 103, 1), colony(4, 104, 1.0001), colony(5, 105, null), colony(6, 111, 1000), colony(11, 111, 5), colony(7, 120, 10), colony(8, 109, 10),
    colony(12, 114, 3), colony(13, 115, 2, { SystemID: 51 }), colony(14, 116, 0), colony(15, 112, 4), colony(16, 117, 1), colony(17, 107, 2), colony(18, 122, 6), colony(19, 123, 3),
    colony(30, 106, 500, { RaceID: 8 }), colony(31, 125, 100, { RaceID: 8 }),
  ],
  DIM_Ruin: [{ RuinID: 1, Description: 'Ancient ruins' }],
  FCT_RuinRace: [{ RuinRaceID: 3, GameID: GAME, Name: 'Builders' }, { RuinRaceID: 4, GameID: GAME, Name: 'Known builders' }],
  FCT_KnownRuinRace: [{ RuinRaceID: 4, GameID: GAME, RaceID: RACE }],
  FCT_AncientConstruct: [
    { AncientConstructID: 1, GameID: GAME, SystemBodyID: 120, Active: 1 },
    { AncientConstructID: 2, GameID: GAME, SystemBodyID: 122, Active: 0 },
    { AncientConstructID: 3, GameID: GAME, SystemBodyID: 123, Active: null },
    { AncientConstructID: 4, GameID: GAME, SystemBodyID: 125, Active: 0 },
  ],
}

// The bodies the race knows and that hold ground survey work, and the ruins it has found, in the small database.
const GEO_BODIES = [101, 102, 103, 104, 105, 106]
const RUIN_STATES = { found: 1, identified: 1, used: 1, unknown: 1 }

// ---------- the saves ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => {
  raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)))
})

const runSql = (raw, sql, params = []) => new Promise((resolve, reject) => {
  raw.run(sql, params, (error) => (error ? reject(error) : resolve()))
})

const wrap = (raw) => ({ query: async (sql) => [await allRows(raw, sql)], close: () => new Promise((resolve) => raw.close(() => resolve())) })

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does.
const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(wrap(raw))))
})

// A database in memory with the tables of `source` (a save's definitions) and the rows given.
const memoryDatabase = async (source, tables) => {
  const raw = await new Promise((resolve, reject) => {
    const created = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(created)))
  })

  for (const table of MEMORY_TABLES) {
    const [[definition]] = await source.query(`select sql from sqlite_master where type = 'table' and name = '${table}'`)

    await runSql(raw, definition.sql)

    for (const row of tables[table] || []) {
      const columns = Object.keys(row)

      await runSql(raw, `insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`, columns.map((column) => row[column]))
    }
  }

  return wrap(raw)
}

// What the saves are known to hold: the specialist formations by state, the ground survey bodies the race knows, the ruins by state and those it has not surveyed, the colonies of the race.
const FIXTURES = [
  { file: 'AuroraDB.db', GameID: 140, RaceID: 784, colonies: 75, specialists: 9, states: { idle: 0, busy: 0, embarked: 9, unresolved: 0, unknown: 0 }, geoBodies: 12, geoColonies: 1, ruins: { found: 2, hidden: 2 }, constructs: { bodies: 4, inactive: 0 } },
  { file: 'artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db', GameID: 141, RaceID: 791, colonies: 102, specialists: 27, states: { idle: 27, busy: 0, embarked: 0, unresolved: 0, unknown: 0 }, geoBodies: 16, geoColonies: 2, ruins: { found: 3, hidden: 6 }, constructs: { bodies: 3, inactive: 2 } },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', GameID: 138, RaceID: 785, colonies: 101, specialists: 3, states: { idle: 2, busy: 1, embarked: 0, unresolved: 0, unknown: 0 }, geoBodies: 0, geoColonies: 0, ruins: { found: 1, hidden: 2 }, constructs: { bodies: 1, inactive: 0 } },
]

// The save's facts in SQL written here and apart from the module's: the formations with their ratings and mass, the colonies' bodies, the bodies the race knows with ground survey work, the ruins it has found and those it has not surveyed, the system of each ship, the geosurvey of each colony, and the old per-colony ground survey read of the page.
const oracle = async (database, GameID, RaceID) => {
  const q = async (sql) => (await database.query(sql))[0]
  const sum = (slot, key) => `coalesce(${slot}.${key}, 0)`
  const rating = (key) => `sum(coalesce(e.Units, 0) * (${['a', 'b', 'c', 'd'].map((slot) => sum(slot, key)).join(' + ')}))`
  const formations = await q(`select f.FormationID as id, f.PopulationID as pop, f.ShipID as ship, ${rating('Geosurvey')} as geo, ${rating('Xenoarchaeology')} as xeno, sum(coalesce(e.Units, 0) * k.Size) as mass from FCT_GroundUnitFormation f left join FCT_GroundUnitFormationElement e on e.FormationID = f.FormationID left join FCT_GroundUnitClass k on k.GroundUnitClassID = e.ClassID left join DIM_GroundComponentType a on a.ComponentTypeID = k.ComponentA left join DIM_GroundComponentType b on b.ComponentTypeID = k.ComponentB left join DIM_GroundComponentType c on c.ComponentTypeID = k.ComponentC left join DIM_GroundComponentType d on d.ComponentTypeID = k.ComponentD where f.GameID = ${GameID} and f.RaceID = ${RaceID} group by f.FormationID order by f.FormationID`)
  const populations = new Map((await q(`select PopulationID as id, SystemBodyID as body, SystemID as system, Population as population from FCT_Population where GameID = ${GameID} and RaceID = ${RaceID}`)).map((row) => [row.id, row]))
  const known = `exists (select 1 from FCT_SystemBodySurveys s where s.SystemBodyID = b.SystemBodyID and s.RaceID = ${RaceID} and s.GameID = ${GameID}) and exists (select 1 from FCT_RaceSysSurvey r where r.SystemID = b.SystemID and r.RaceID = ${RaceID} and r.GameID = ${GameID})`
  const geoAll = await q(`select b.SystemBodyID as id, b.SystemID as system from FCT_SystemBody b where b.GameID = ${GameID} and b.GroundMineralSurvey > 0`)
  const geoKnown = await q(`select b.SystemBodyID as id, b.SystemID as system from FCT_SystemBody b where b.GameID = ${GameID} and b.GroundMineralSurvey > 0 and ${known}`)
  const ruinsAll = await q(`select b.SystemBodyID as id, b.AbandonedFactories as factories, b.RuinRaceID as builders, ${known} as seen, exists (select 1 from FCT_Population p where p.SystemBodyID = b.SystemBodyID and p.RaceID = ${RaceID} and p.GameID = ${GameID}) as colony, exists (select 1 from FCT_KnownRuinRace k where k.RuinRaceID = b.RuinRaceID and k.RaceID = ${RaceID} and k.GameID = ${GameID}) as identified from FCT_SystemBody b where b.GameID = ${GameID} and b.RuinID > 0`)
  const ships = await q(`select s.ShipID as id, coalesce(fl.SystemID, fm.SystemID) as system from FCT_Ship s left join FCT_Fleet fl on fl.FleetID = s.FleetID left join FCT_Ship ms on ms.ShipID = s.MothershipID left join FCT_Fleet fm on fm.FleetID = ms.FleetID where s.ShipID in (select ShipID from FCT_GroundUnitFormation where GameID = ${GameID} and RaceID = ${RaceID} and ShipID > 0)`)
  const surveyed = await q(`select b.SystemID as system, count(*) as bodies from FCT_SystemBody b where b.GameID = ${GameID} and exists (select 1 from FCT_SystemBodySurveys s where s.SystemBodyID = b.SystemBodyID and s.RaceID = ${RaceID} and s.GameID = ${GameID}) group by b.SystemID`)
  const geoSum = ['a', 'b', 'c', 'd'].map((slot) => sum(slot, 'Geosurvey')).join(' + ')
  const ratings = await q(`select p.PopulationID as pop, sum(case when ${geoSum} > 0 then e.Units else 0 end) as units, sum(e.Units * (${geoSum})) as base from FCT_GroundUnitFormation f join FCT_Population p on p.PopulationID = f.PopulationID join FCT_GroundUnitFormationElement e on e.FormationID = f.FormationID join FCT_GroundUnitClass k on k.GroundUnitClassID = e.ClassID left join DIM_GroundComponentType a on a.ComponentTypeID = k.ComponentA left join DIM_GroundComponentType b on b.ComponentTypeID = k.ComponentB left join DIM_GroundComponentType c on c.ComponentTypeID = k.ComponentC left join DIM_GroundComponentType d on d.ComponentTypeID = k.ComponentD where f.GameID = ${GameID} and f.RaceID = ${RaceID} and p.RaceID = ${RaceID} group by p.PopulationID`)
  // What the game's multiplier of a formation's commander rests on, per formation: the commanders, the Survey bonus of the first, the size of its own elements and the largest headquarters capacity of their classes.
  // The commanders are read in one pass each: a subquery per formation scans the commander table once for each of them, and the modded save holds thousands of formations.
  const commands = await q(`with commanding as (select m.CommandID as id, count(*) as commanders from FCT_Commander m where m.CommandType = 5 and m.GameID = ${GameID} and m.RaceID = ${RaceID} group by m.CommandID), bonuses as (select m.CommandID as id, cb.BonusValue as bonus, row_number() over (partition by m.CommandID order by m.CommanderID) as place from FCT_Commander m join FCT_CommanderBonuses cb on cb.CommanderID = m.CommanderID and cb.BonusID = 2 where m.CommandType = 5 and m.GameID = ${GameID} and m.RaceID = ${RaceID}) select f.FormationID as id, f.ParentFormationID as parent, f.PopulationID as pop, coalesce(commanding.commanders, 0) as commanders, bonuses.bonus as bonus, (select coalesce(sum(e.Units * k.Size), 0) from FCT_GroundUnitFormationElement e join FCT_GroundUnitClass k on k.GroundUnitClassID = e.ClassID where e.FormationID = f.FormationID) as size, (select coalesce(max(k.HQCapacity), 0) from FCT_GroundUnitFormationElement e join FCT_GroundUnitClass k on k.GroundUnitClassID = e.ClassID where e.FormationID = f.FormationID) as capacity from FCT_GroundUnitFormation f left join commanding on commanding.id = f.FormationID left join bonuses on bonuses.id = f.FormationID and bonuses.place = 1 where f.GameID = ${GameID} and f.RaceID = ${RaceID}`)
  const commandOf = new Map(commands.map((row) => [row.id, { ...row, size: Math.trunc(row.size) }]))
  const totalSize = (id) => commandOf.get(id).size + commands.filter((row) => row.parent === id && row.id !== id).reduce((all, row) => all + totalSize(row.id), 0)
  // The headquarters capacity against the whole size, an integer division as in the game: 0 beyond the capacity, 1 within it.
  const capacityShare = (row) => (totalSize(row.id) > 0 ? Math.min(1, Math.floor(row.capacity / totalSize(row.id))) : 1)
  const ownMultiplier = (row) => (capacityShare(row) < 1 ? 1 + ((row.bonus === null ? 1 : row.bonus) - 1) * capacityShare(row) : row.bonus === null ? 1 : row.bonus)
  const parentFactor = (row) => {
    const parent = commandOf.get(row.parent)

    return parent && parent.pop > 0 && parent.pop === row.pop && parent.commanders > 0 ? (1 + ((parent.bonus === null ? 1 : parent.bonus) - 1) * 0.25 * capacityShare(parent)) * parentFactor(parent) : 1
  }
  const multiplierOf = new Map(commands.map((row) => [row.id, row.commanders > 0 ? ownMultiplier(commandOf.get(row.id)) * parentFactor(row) : 1]))
  // The ground survey a day of a colony: each geosurvey formation's rating times the multiplier of its commander, twice (the game applies it where the points of the formation are summed and again where they are added to the colony).
  const teams = ratings.map((row) => {
    const here = formations.filter((item) => item.pop === row.pop && item.geo > 0).map((item) => ({ id: item.id, base: item.geo, multiplier: multiplierOf.get(item.id) }))

    return { ...row, formations: here, perDay: here.reduce((all, item) => all + item.base * item.multiplier * item.multiplier, 0) }
  })
  const found = new Set(ruinsAll.filter((row) => row.seen && row.factories > 0 && !row.identified).map((row) => row.id))
  // Where the game may work a xenoarchaeology formation with no known target: a ruin on a colony body of the race that it has not surveyed (or in a system it does not know) with builders not identified, and a ruin whose installations left are not stored.
  const unseen = new Set(ruinsAll.filter((row) => row.colony && ((!row.seen && (row.factories === null || (row.factories > 0 && !row.identified))) || (row.seen && row.factories === null))).map((row) => row.id))
  // The ancient constructs on the bodies the race has a colony on: the game works a xenoarchaeology formation at a colony on one that is not active, with no ruin and whatever the survey, and one with no stored state may be worked.
  const constructsAll = await q(`select distinct c.SystemBodyID as id, c.Active as active from FCT_AncientConstruct c where c.GameID = ${GameID} and exists (select 1 from FCT_Population p where p.SystemBodyID = c.SystemBodyID and p.RaceID = ${RaceID} and p.GameID = ${GameID})`)
  const inactive = new Set(constructsAll.filter((row) => row.active === 0).map((row) => row.id))
  const unsure = new Set(constructsAll.filter((row) => row.active === null).map((row) => row.id))
  const geo = new Set(geoKnown.map((row) => row.id))
  const systemOf = new Map(ships.map((row) => [row.id, row.system]))
  const stateOf = (row) => {
    if (row.pop > 0) {
      const colonyRow = populations.get(row.pop)

      if (!colonyRow || !(colonyRow.system > 0) || !(colonyRow.body > 0)) {
        return 'unresolved'
      }

      if ((row.geo > 0 && geo.has(colonyRow.body)) || (row.xeno > 0 && (found.has(colonyRow.body) || inactive.has(colonyRow.body)))) {
        return 'busy'
      }

      return row.xeno > 0 && (unseen.has(colonyRow.body) || unsure.has(colonyRow.body)) ? 'unknown' : 'idle'
    }

    return row.ship > 0 && systemOf.get(row.ship) > 0 ? 'embarked' : 'unresolved'
  }
  const specialists = formations.filter((row) => row.geo > 0 || row.xeno > 0)

  return { formations, specialists, states: Object.fromEntries(specialists.map((row) => [row.id, stateOf(row)])), geoAll, geoKnown, geo, found, unseen, constructsAll, inactive, unsure, ruinsAll, surveyed: new Map(surveyed.map((row) => [row.system, row.bodies])), teams: new Map(teams.map((row) => [row.pop, row])), populations }
}

// First-fit decreasing, written here: the bays largest first, the formations largest first, each into the first bay that still has room; those left wait for another lift of the same bays. Returns { lifts, lift (id to the lift number) , none (ids larger than the largest bay) }.
const packed = (masses, bays) => {
  const biggest = Math.max(0, ...bays)
  const order = masses.filter((item) => item.mass !== null).sort((a, b) => b.mass - a.mass || a.id - b.id)
  const none = order.filter((item) => item.mass > biggest).map((item) => item.id)
  const lift = new Map()
  let waiting = order.filter((item) => item.mass <= biggest)
  let lifts = 0

  while (waiting.length) {
    lifts++

    const rooms = [...bays]
    const left = []

    waiting.forEach((item) => {
      const at = rooms.findIndex((room) => room >= item.mass)

      if (at < 0) {
        left.push(item)
      } else {
        rooms[at] -= item.mass
        lift.set(item.id, lifts)
      }
    })
    waiting = left
  }

  return { lifts, lift, none }
}

const baysOf = (troops) => troops.classes.flatMap((item) => Array(item.Ships).fill(item.TroopCapacity))

// ---------- the checks, over a context { mod, pages, templates, models, memory, saves } ----------

const idsWhere = (rows, test) => ids(rows.filter(test)).sort((a, b) => a - b)

const surveyView = (ctx, data = {}) => instantiate(ctx.pages.survey, {
  boundary,
  $store: { getters: {}, state: {} },
  data: {
    loadErrors: {},
    game: { SurveySpeed: 100 },
    groundSurveys: ctx.memory.groundSurveys,
    ruinSites: ctx.memory.ruinSites,
    constructSites: ctx.memory.constructSites,
    groundCommanders: { supported: true, rows: COMMAND_ROWS },
    troopBays: { troops: TROOPS },
    formations: ctx.models.supportedConstructed,
    ...data,
  },
})

const rowsOf = (ctx, data = {}) => surveyView(ctx, data).deployment.rows
const rowOf = (rows, id) => rows.find((row) => row.id === id)

add('rows-once', 'each geological and xenoarchaeology formation is one row, a formation with both ratings once, and the formations that are no specialist are counted apart', (ctx) => {
  const { deployment, deployTotals } = surveyView(ctx)

  assert.deepEqual(sorted(ids(deployment.rows)), LISTED)
  assert.equal(new Set(ids(deployment.rows)).size, LISTED.length)
  assert.equal(deployment.others, OTHERS.length)
  assert.equal(deployment.others + deployment.rows.length, ctx.models.constructed.formations.length)
  assert.deepEqual(idsWhere(deployment.rows, (row) => row.roleKeys.includes('geo')), GEO)
  assert.deepEqual(idsWhere(deployment.rows, (row) => row.roleKeys.includes('xeno')), XENO)
  assert.deepEqual({ formations: deployTotals.formations, geo: deployTotals.geo, xeno: deployTotals.xeno, both: deployTotals.both, others: deployTotals.others }, { formations: LISTED.length, geo: GEO.length, xeno: XENO.length, both: 1, others: OTHERS.length })
  assert.equal(deployTotals.geo + deployTotals.xeno - deployTotals.both, deployTotals.formations)
})

add('capability-actual', 'a row\'s capability, mass and location are those of the shared model\'s actual elements, never the template a formation names', (ctx) => {
  const rows = rowsOf(ctx)
  const model = new Map(ctx.models.constructed.formations.map((node) => [node.id, node]))

  assert.ok(rows.every((row) => row.geo === model.get(row.id).geo.value && row.xeno === model.get(row.id).xeno.value && row.mass === model.get(row.id).mass.value))
  near(rowOf(rows, 4).geo, 1.8)
  assert.equal(rowOf(rows, 4).xeno, 0)
  near(rowOf(rows, 3).geo, 0.2)
  near(rowOf(rows, 3).xeno, 1)
  near(rowOf(rows, 11).geo, 1.2)
  assert.equal(rowOf(rows, 11).xeno, null)
  assert.deepEqual(rows.map((row) => [row.id, row.mass]), LISTED.map((id) => [id, MASS[id]]))
  assert.deepEqual(rowOf(rows, 1).system, { id: 50, name: 'Sol' })
  assert.deepEqual(rowOf(rows, 6).system, { id: 9, name: 'Alpha' })
})

// What the utility says of a formation that is idle at a colony with no target at all, with nothing else of the page in between.
const bareState = (ctx) => {
  const node = ctx.models.constructed.formations.find((item) => item.id === 4)
  const { state, work } = ctx.mod.deploymentState(node, null, ctx.mod.indexTargets({ geo: [], xeno: [] }))

  return { state, work }
}

add('states', 'idle, busy, embarked, unresolved and unknown formations are told apart, by the body of the colony and the work on it', (ctx) => {
  assert.deepEqual(bareState(ctx), { state: 'idle', work: [] }, 'a formation where no target is stands idle')
  const rows = rowsOf(ctx)

  Object.entries(STATES).forEach(([state, list]) => assert.deepEqual(idsWhere(rows, (row) => row.state === state), list, state))
  assert.equal(new Set(rows.map((row) => row.stateOrder)).size, 5)
  assert.deepEqual(surveyView(ctx).deployTotals.states, { idle: 9, busy: 7, embarked: 1, unresolved: 4, unknown: 6 })
})

add('state-details', 'a busy formation names its work, an unresolved one says why, one that may be working says why it is not known, and an embarked one has no work', (ctx) => {
  assert.deepEqual(bareState(ctx), { state: 'idle', work: [] }, 'a formation where no target is has no work')
  const rows = rowsOf(ctx)
  const reasons = (id) => rowOf(rows, id).stateReasons.map((reason) => reason.kind)

  assert.deepEqual(rowOf(rows, 1).work.map((item) => [item.role, item.bodyId]), [['geo', 101]])
  assert.deepEqual(rowOf(rows, 28).work.map((item) => [item.role, item.bodyId, item.name]), [['xeno', 122, rowOf(rows, 28).workLabel]])
  assert.ok(rowOf(rows, 28).workLabel.length > 0)
  assert.deepEqual(rowOf(rows, 3).work.map((item) => [item.role, item.bodyId]), [['geo', 102]])
  assert.deepEqual(rowOf(rows, 2).work.map((item) => [item.role, item.bodyId]), [['xeno', 111]])
  assert.deepEqual(rowOf(rows, 4).work, [])
  assert.deepEqual([7, 8, 9, 21].map(reasons), [['system-unknown'], ['colony-body-unknown'], ['unlocated'], ['ship-missing']])
  assert.deepEqual(reasons(12), ['rating-unknown'])
  assert.deepEqual([22, 23, 24].map(reasons), [['ruin-unseen'], ['ruin-unseen'], ['ruin-unseen']])
  assert.deepEqual([29, 30].map(reasons), [['construct-unknown'], ['rating-unknown']])
  assert.deepEqual(rows.filter((row) => ![7, 8, 9, 21, 12, 22, 23, 24, 29, 30].includes(row.id) && row.stateReasons.length).map((row) => row.id), [], 'only an unresolved formation and one of unknown activity gives a reason')
  assert.deepEqual(rowOf(rows, 6).work, [])
  assert.ok(rows.filter((row) => row.state === 'unknown').every((row) => row.work.length === 0))
})

add('boundary-population', 'a colony is a candidate at any population: 0, 0.9999, 1, 1.0001 and an unstored one all take the work and the formation there, and a body with no colony of the race has none', (ctx) => {
  const vm = surveyView(ctx)
  const targets = vm.deployment.index.byRole.geo
  const byBody = new Map(targets.map((target) => [target.bodyId, target]))

  const colonyAt = (id) => (byBody.get(id) || {}).colony || {}

  assert.deepEqual([101, 102, 103, 104, 105].map((id) => colonyAt(id).population), [0, 0.9999, 1, 1.0001, null])
  assert.deepEqual([101, 102, 103, 104, 105].map((id) => colonyAt(id).id), [1, 2, 3, 4, 5])
  assert.equal(byBody.get(106).colony, null)
  assert.deepEqual([1, 3, 13, 18, 19].map((id) => rowOf(vm.deployment.rows, id).state), ['busy', 'busy', 'busy', 'busy', 'busy'])
  assert.equal(vm.deployTotals.targets.geo.colonies, 5)
  assert.equal(ctx.mod.colonyOf({ PopulationID: 0, ColonyPopulation: 500 }), null)
  assert.equal(ctx.mod.colonyOf({ PopulationID: null, ColonyPopulation: 500 }), null)
  assert.deepEqual([0, 0.9999, 1, 1.0001, null, undefined].map((population) => ctx.mod.colonyOf({ PopulationID: 8, ColonyPopulation: population }) !== null), [true, true, true, true, true, true])
})

add('targets-eligible', 'the targets are the bodies and ruins the race has surveyed in systems it knows: a hidden body, a hidden ruin, a body in an unknown system and a completed survey never enter; a ruin it has not surveyed is read only where a colony stands, never as a target', (ctx) => {
  const vm = surveyView(ctx)
  const geo = vm.groundSurveys.map((row) => row.SystemBodyID)
  const ruins = ctx.memory.ruinSites.rows.map((row) => row.SystemBodyID)

  assert.deepEqual([...new Set(geo)].sort((a, b) => a - b), GEO_BODIES)
  assert.deepEqual([...new Set(ruins)].sort((a, b) => a - b), [111, 112, 113, 114, 115, 116, 117])
  assert.deepEqual(sorted(vm.deployment.index.byRole.geo.map((target) => target.bodyId)), GEO_BODIES)
  assert.deepEqual(sorted(vm.deployment.index.byRole.xeno.map((target) => target.bodyId)), [111, 111])
  assert.deepEqual(vm.deployment.ruinStates, RUIN_STATES)
  assert.deepEqual(sorted(vm.deployment.index.unseen), [114, 115, 116])
  assert.ok(![107, 108, 109].some((id) => geo.includes(id)))
  assert.ok(!ruins.includes(118), 'a ruin the race has not surveyed, with no colony, was read')
  assert.ok(![114, 115, 116, 117].some((id) => vm.deployment.index.byBody.xeno.has(id)), 'a ruin outside the known ones is a target')
  assert.deepEqual(sorted(ctx.memory.constructSites.rows.map((row) => row.SystemBodyID)), [120, 122, 123], 'the constructs read are those on a colony body of the race, surveyed or not, and no other')
  assert.deepEqual([...vm.deployment.index.constructs.inactive.keys()], [122])
  assert.deepEqual(sorted(vm.deployment.index.constructs.unknown), [123])
  assert.ok(![120, 122, 123, 125].some((id) => vm.deployment.index.byBody.xeno.has(id)), 'an ancient construct is a target')
})

add('targets-totals', 'the candidate bodies equal the ground surveys aggregate, a formation\'s candidates are the bodies of its roles other than its work, and the sentence counts agree', (ctx) => {
  const vm = surveyView(ctx)
  const { deployment, deployTotals } = vm

  assert.equal(deployTotals.targets.geo.bodies, new Set(vm.groundRows.map((row) => row.SystemBodyID)).size)
  assert.deepEqual([deployTotals.targets.geo.bodies, deployTotals.targets.geo.colonies, deployTotals.targets.geo.systems, deployTotals.targets.xeno.bodies, deployTotals.targets.xeno.colonies, deployTotals.targets.xeno.systems], [6, 5, 1, 1, 1, 1])
  assert.deepEqual(rowOf(deployment.rows, 4).candidates, { colonies: 5, bare: 1, sameSystem: 6 })
  assert.deepEqual(rowOf(deployment.rows, 5).candidates, { colonies: 1, bare: 0, sameSystem: 1 })
  assert.deepEqual(rowOf(deployment.rows, 3).candidates, { colonies: 5, bare: 1, sameSystem: 6 })
  assert.deepEqual(rowOf(deployment.rows, 1).candidates, { colonies: 4, bare: 1, sameSystem: 5 })
  assert.deepEqual(rowOf(deployment.rows, 2).candidates, { colonies: 0, bare: 0, sameSystem: 0 })
  assert.ok(deployment.rows.every((row) => row.candidateSort === row.candidates.colonies + row.candidates.bare))
  assert.deepEqual(vm.candidateList(rowOf(deployment.rows, 4)).map((item) => item.target.bodyId).sort((a, b) => a - b), [101, 102, 103, 104, 105, 106])
  assert.equal(vm.candidateList(rowOf(deployment.rows, 1)).some((item) => item.target.bodyId === 101), false)
})

add('target-rows', 'each target is one row with its colony, the work left, the formations busy there and its status; a body with two colonies of the race has two rows', (ctx) => {
  const vm = surveyView(ctx)
  const rows = vm.targetList
  const of = (key) => rows.find((row) => row.key === key)

  assert.equal(rows.length, 6 + 2)
  assert.equal(of('geo:101:1').status, 'worked')
  assert.equal(of('geo:101:1').busy, 1)
  near(of('geo:101:1').left, 200)
  assert.equal(of('geo:106:0').status, 'no-colony')
  assert.equal(of('xeno:111:6').busy, 1)
  assert.equal(of('xeno:111:11').busy, 1)
  assert.equal(of('xeno:111:11').status, 'worked')
  assert.equal(of('xeno:111:6').left, 5)
  assert.equal(rows.filter((row) => row.status === 'unstaffed').length, 0)
  assert.equal(surveyView(ctx, { deployUnstaffed: true }).targetList.length, rows.filter((row) => row.status !== 'worked').length)
  assert.deepEqual(surveyView(ctx, { deployRoles: ['xeno'] }).targetList.map((row) => row.role), ['xeno', 'xeno'])
  assert.deepEqual(surveyView(ctx, { deployRoles: [] }).targetList, [])
})

add('lifts', 'a formation larger than the largest troop bay needs none, one that fits but must wait needs a later lift, the rest one lift; each verdict is the first-fit packing of the model\'s mass', (ctx) => {
  const vm = surveyView(ctx)
  const { rows, lifts } = vm.deployment
  const verdict = (id) => rowOf(rows, id).lift
  const pool = rows.filter((row) => row.state === 'idle').map((row) => ({ id: row.id, mass: row.mass }))
  const expected = packed(pool, baysOf(TROOPS))

  assert.deepEqual(idsWhere(rows, (row) => row.lift.kind === 'none'), [14])
  assert.deepEqual(idsWhere(rows, (row) => row.lift.kind === 'unsized'), [15])
  assert.deepEqual(idsWhere(rows, (row) => row.lift.kind === 'several'), [5, 27])
  assert.deepEqual(idsWhere(rows, (row) => row.lift.kind === 'aboard'), [6])
  assert.deepEqual(expected.none, [14])
  assert.equal(expected.lifts, 2)
  assert.equal(lifts, 2)
  ;[4, 11, 17, 25, 26, 5, 27].forEach((id) => assert.equal(verdict(id).lift, expected.lift.get(id), `formation ${id}`))
  assert.deepEqual([4, 11, 17, 25, 26].map((id) => [verdict(id).kind, verdict(id).lift, verdict(id).lifts]), [['one', 1, 2], ['one', 1, 2], ['one', 1, 2], ['one', 1, 2], ['one', 1, 2]])
  assert.deepEqual([5, 27].map((id) => [verdict(id).kind, verdict(id).lift, verdict(id).lifts]), [['several', 2, 2], ['several', 2, 2]])
  assert.equal(verdict(14).largest, 100)
  assert.ok([1, 2, 3, 13, 18, 19, 28, 7, 8, 9, 21, 12, 22, 23, 24, 29, 30].every((id) => verdict(id).kind === 'one' && verdict(id).lifts === 1), 'a formation outside the idle pool is judged alone')
  assert.ok(vm.liftLabel(verdict(14)).includes('100'))
  assert.ok(vm.liftLabel(verdict(5)).includes('2'))
  assert.ok(new Set(rows.map((row) => row.liftSort)).size > 4)
})

add('lifts-bays', 'no troop ship, unknown troop bays and a bay of 10 000 t against masses of 10 000 t are told apart', (ctx) => {
  const lifted = (troops, mass) => {
    const model = ctx.models.constructed
    const targets = { geo: [], xeno: [] }
    const rows = ctx.mod.specialistRows({ ...model, formations: model.formations.map((node) => (node.id === 4 ? { ...node, mass: { ...node.mass, value: mass } } : node)) }, targets, troops).rows

    return rowOf(rows, 4).lift
  }
  const sized = (capacities) => ({ classes: capacities.map((TroopCapacity) => ({ TroopCapacity, Ships: 1 })) })

  assert.equal(lifted(null, 90).kind, 'unknown')
  assert.equal(lifted({ classes: [] }, 90).kind, 'no-bays')
  assert.equal(lifted({ classes: [{ TroopCapacity: 100, Ships: 0 }] }, 90).kind, 'no-bays')
  assert.equal(lifted({ classes: [] }, 0).kind, 'no-bays')
  assert.equal(lifted({ classes: [{ TroopCapacity: 0, Ships: 2 }] }, 0).kind, 'one')
  assert.equal(lifted(sized([250, 1000, 5000]), 10000).kind, 'none')
  assert.equal(lifted(sized([250, 1000, 5000, 9999.9]), 10000).kind, 'none')
  assert.equal(lifted(sized([250, 1000, 5000, 10000]), 10000).kind, 'one')
  assert.equal(lifted(sized([250, 1000, 5000, 25000, 100000]), 10000).kind, 'one')
  assert.equal(lifted(sized([100]), 100).kind, 'one')
  assert.equal(lifted(sized([100]), 100.0001).kind, 'none')
  assert.equal(lifted(sized([100]), null).kind, 'unsized')
})

add('lifts-unavailable', 'with the troop bays unread every formation is unknown, never none, and with the model unsupported nothing is listed', (ctx) => {
  const unread = surveyView(ctx, { troopBays: { troops: null } }).deployment.rows

  assert.ok(unread.every((row) => row.lift.kind === 'unknown' || row.lift.kind === 'aboard'))
  assert.ok(unread.filter((row) => row.state !== 'embarked').every((row) => row.lift.kind === 'unknown'))
  assert.equal(surveyView(ctx, { formations: { supported: false, missing: ['FCT_GroundUnitFormation'] } }).deployment, null)
  assert.deepEqual(surveyView(ctx, { formations: { supported: false, missing: ['FCT_GroundUnitFormation'] } }).deployList, [])
  assert.deepEqual(surveyView(ctx, { formations: { supported: false, missing: ['FCT_GroundUnitFormation'] } }).targetList, [])
})

add('select', 'the role and state filters keep the rows in a chosen role (both once) and state, and the chip counts are those of the rows', (ctx) => {
  const vm = (data) => ids(surveyView(ctx, data).deployList).sort((a, b) => a - b)
  const { deployTotals } = surveyView(ctx)

  assert.deepEqual(vm({}), LISTED)
  assert.deepEqual(vm({ deployRoles: ['geo'] }), GEO)
  assert.deepEqual(vm({ deployRoles: ['xeno'] }), XENO)
  assert.deepEqual(vm({ deployRoles: [] }), [])
  assert.deepEqual(vm({ deployStates: ['busy'] }), STATES.busy)
  assert.deepEqual(vm({ deployStates: ['idle', 'embarked'] }), sorted([...STATES.idle, ...STATES.embarked]))
  assert.deepEqual(vm({ deployRoles: ['xeno'], deployStates: ['idle'] }), [5, 25, 26])
  assert.deepEqual(vm({ deployStates: ['unknown'] }), STATES.unknown)
  ALL_STATES.forEach((state) => assert.equal(vm({ deployStates: [state] }).length, deployTotals.states[state], state))
  ALL_ROLES.forEach((role) => assert.equal(vm({ deployRoles: [role] }).length, deployTotals[role], role))
  assert.equal(ALL_STATES.reduce((sum, state) => sum + deployTotals.states[state], 0), deployTotals.formations)
})

add('rates', 'the ground survey of a colony is the rating of each formation times the multiplier of its commander (the bonus cut to the command capacity, with the share of the superiors at the colony), counted twice, a colony with a formation of unknown rating, or a multiplier not known, has an unavailable rate', (ctx) => {
  const vm = surveyView(ctx)
  const teams = vm.colonyTeams
  const rows = new Map(vm.groundRows.map((row) => [row.PopulationID || -row.SystemBodyID, row]))
  const multipliers = (team) => Object.fromEntries(team.formations.map((item) => [item.id, item.multiplier]))

  assert.deepEqual(teams.get(1).unknown, [])
  assert.equal(teams.get(1).units, 4)
  near(teams.get(1).base, 0.4)
  assert.deepEqual(multipliers(teams.get(1)), { 1: MULTIPLIERS[1] }, 'over its capacity with the formation beneath it')
  assert.deepEqual(teams.get(2).unknown, [20])
  assert.equal(teams.get(2).units, 2)
  assert.equal(teams.get(7).units, 56)
  near(teams.get(7).base, 6.2)
  assert.deepEqual(multipliers(teams.get(7)), { 4: MULTIPLIERS[4], 11: MULTIPLIERS[11], 14: MULTIPLIERS[14], 15: MULTIPLIERS[15] }, 'a size cut to a whole number, a parent at the colony, within its capacity, and no commander')
  assert.deepEqual(Object.fromEntries(teams.get(7).formations.map((item) => [item.id, Math.round(item.base * 100) / 100])), { 4: 1.8, 11: 1.2, 14: 3, 15: 0.2 })
  assert.equal(teams.has(6), true)
  assert.equal(teams.has(9), true)
  assert.equal(teams.get(6).units, 5)
  assert.deepEqual(multipliers(teams.get(6)), { 12: MULTIPLIERS[12] }, 'the parent is over its capacity and gives no share')
  assert.deepEqual(multipliers(teams.get(4)), { 18: MULTIPLIERS[18] }, 'a parent at another colony gives no share')
  assert.deepEqual(multipliers(teams.get(3)), { 13: MULTIPLIERS[13] }, 'over its capacity by its own size')
  assert.equal(teams.get(5).formations[0].multiplier, null)
  assert.equal(rows.get(1).Units, 4)
  near(rows.get(1).PointsPerDay, DAILY[1])
  near(rows.get(3).PointsPerDay, DAILY[3])
  near(rows.get(4).PointsPerDay, DAILY[4])
  // The colony 7 has no ground survey body of its own: the row of the colony 5 is read as its row, and the formation 16 with no element (a rating the save leaves unknown) is left out of its model.
  const model = { ...ctx.models.supportedConstructed, formations: ctx.models.supportedConstructed.formations.filter((node) => node.id !== 16) }
  const atSeven = (speed) => surveyView(ctx, { game: { SurveySpeed: speed }, formations: model, groundSurveys: ctx.memory.groundSurveys.map((row) => (row.PopulationID === 5 ? { ...row, PopulationID: 7 } : row)) }).groundRows.find((row) => row.PopulationID === 7)

  near(atSeven(100).PointsPerDay, DAILY[7])
  near(atSeven(50).PointsPerDay, DAILY[7] / 2)
  assert.equal(rows.get(1).rate.status, 'estimated')
  assert.equal(rows.get(2).rate.status, 'unavailable')
  assert.equal(rows.get(2).PointsPerDay, null)
  assert.equal(rows.get(2).rateUnknown, true)
  assert.equal(rows.get(5).rate.status, 'unavailable')
  assert.equal(rows.get(5).PointsPerDay, null)
  assert.equal(rows.get(5).rateUnknown, true)
  assert.equal(rows.get(1).rateUnknown, false)
  assert.equal(rows.get(-106).Units, 0)
  assert.equal(rows.get(-106).PointsPerDay, 0)
  assert.equal(rows.get(-106).rateUnknown, false)
  assert.equal(surveyView(ctx, { game: null }).groundRows.every((row) => row.rate.status === 'unavailable'), true)
  assert.equal(rows.get(2).rate.inputs.missing.length, 1)
  assert.equal(rows.get(5).rate.inputs.missing.length, 1)
  assert.equal(rows.get(1).rate.inputs.missing.length, 0)
  assert.equal(surveyView(ctx, { formations: { supported: false, missing: ['x'] } }).groundRows.filter((row) => row.PopulationID).every((row) => row.rate.status === 'unavailable'), true)
  assert.equal(surveyView(ctx, { groundCommanders: { supported: false, missing: ['x'] } }).groundRows.filter((row) => row.PopulationID && row.Units > 0).every((row) => row.rate.status === 'unavailable'), true, 'commanders that were not read leave the rate unknown')
  assert.equal(surveyView(ctx, { groundCommanders: { supported: false, missing: ['x'] } }).groundRows.find((row) => row.PopulationID === 1).rateUnknown, true)
  // The rate and the multipliers called as they are, with figures the page never hands them: a rating that is not known is no rating of nothing, and a descendant whose class gives a size but no headquarters capacity leaves its commander's multiplier as it is.
  assert.equal(ctx.survey.groundSurveyRate([{ base: null, multiplier: 2 }], 100).status, 'unavailable')
  assert.equal(ctx.survey.groundSurveyRate([{ base: undefined, multiplier: 2 }], 100).status, 'unavailable')
  near(ctx.survey.groundSurveyRate([{ base: 0.5, multiplier: 2 }, { base: 1, multiplier: 1 }], 50).value, 1.5)
  assert.equal(ctx.survey.groundCommandMultipliers([commandRow(1, 1, 0, 2, 10, 50), commandRow(2, 1, 1, null, 20, null, { HasCommander: 0, Capable: 0 })]).get(1), 2)
})

add('headers', 'every sortable column of both tables sorts by a value its rows carry', (ctx) => {
  const vm = surveyView(ctx)

  vm.deployHeaders.filter((header) => header.value !== 'data-table-expand').forEach((header) => vm.deployList.forEach((row) => assert.ok(row[header.value] !== undefined, `row ${row.id} has no ${header.value}`)))
  vm.targetHeaders.forEach((header) => vm.targetList.forEach((row) => assert.ok(row[header.value] !== undefined, `target ${row.key} has no ${header.value}`)))
  assert.deepEqual(vm.roleChoices.map((choice) => choice.value), ALL_ROLES)
  assert.deepEqual(vm.stateChoices.map((choice) => choice.value), ALL_STATES)
})

add('views', 'the filters and the two tables are persisted views of the race, a stored value keeps the choices still offered, and the defaults show everything', (ctx) => {
  const fields = ctx.fields

  assert.deepEqual(['deployRoles', 'deployStates', 'deployUnstaffed', 'deployTable', 'targetsTable'].map((name) => [fields[name].key, fields[name].scope]), [['deployRoles', 'race'], ['deployStates', 'race'], ['deployUnstaffedOnly', 'race'], ['surveyDeployTable', 'race'], ['surveyTargetsTable', 'race']])
  assert.deepEqual([...fields.deployRoles.default], ALL_ROLES)
  assert.deepEqual([...fields.deployStates.default], ALL_STATES)
  assert.equal(fields.deployUnstaffed.default, false)
  assert.deepEqual(fields.deployRoles.normalise(['xeno', 'bogus', 'geo']), ALL_ROLES)
  assert.deepEqual(fields.deployStates.normalise(['busy', 'bogus', 'idle']), ['idle', 'busy'])
  assert.deepEqual(fields.deployRoles.normalise([]), [])
  assert.equal(fields.deployRoles.normalise('geo'), undefined)
  assert.equal(fields.deployStates.normalise(undefined), undefined)
  assert.ok(ctx.mod.rolesView.key !== 'groundRoles' && ctx.mod.statesView.key !== ctx.mod.rolesView.key)
})

add('ready', 'the page holds its content back while the commanders, the ruins or the troop ships are loading or have failed', (ctx) => {
  const keys = Object.keys(ctx.pages.survey.asyncComputed)
  const everyKey = (value) => Object.fromEntries(keys.map((key) => [key, value]))
  const vm = (loadErrors) => surveyView(ctx, { loadErrors, $store: undefined })

  assert.ok(['groundCommanders', 'ruinSites', 'constructSites', 'troopBays'].every((key) => keys.includes(key)))
  assert.equal(vm(everyKey(null)).ready, true)
  ;['groundCommanders', 'ruinSites', 'constructSites', 'troopBays'].forEach((key) => {
    assert.equal(vm({ ...everyKey(null), [key]: undefined }).ready, false, `${key} pending`)
    assert.deepEqual(vm({ ...everyKey(null), [key]: 'boom' }).failedInputs, [key], `${key} failed`)
  })
})

add('ruins-unsupported', 'a save without what the ruin read needs gives no xenoarchaeology target and says what is missing, and the geological targets stay', async (ctx) => {
  const vm = surveyView(ctx, { ruinSites: { supported: false, missing: ['FCT_KnownRuinRace'] } })

  assert.deepEqual(vm.deployment.index.byRole.xeno, [])
  assert.equal(vm.deployment.ruinStates, null)
  assert.equal(vm.deployment.index.byRole.geo.length, 6)
  assert.equal(surveyView(ctx, { ruinSites: null }).deployment.index.byRole.xeno.length, 0)
  assert.ok(vm.targetList.every((row) => row.role === 'geo'))
  assert.equal(typeof vm.ruinSummary, 'string')
  assert.equal(typeof surveyView(ctx).ruinSummary, 'string')
  assert.notEqual(vm.ruinSummary, surveyView(ctx).ruinSummary)
})

add('unknown-sites', 'a xenoarchaeology formation on a ruin the race has not fully surveyed is of unknown activity, never idle, whether the survey row of one body is missing or the ruins could not be read; a geological formation on an unsurveyed body is idle', (ctx) => {
  const kinds = (rows, id) => rowOf(rows, id).stateReasons.map((reason) => reason.kind)
  const read = ctx.memory.ruinSites
  // Only the survey row of the body 111 is taken away: its ruin is still there, and a colony stands on it.
  const unsurveyed = surveyView(ctx, { ruinSites: { supported: true, rows: read.rows.map((row) => (row.SystemBodyID === 111 ? { ...row, Surveyed: 0 } : row)) } })
  const rows = unsurveyed.deployment.rows

  assert.deepEqual(unsurveyed.deployment.index.byRole.xeno, [])
  assert.deepEqual(sorted(unsurveyed.deployment.index.unseen), [111, 114, 115, 116])
  assert.equal(unsurveyed.deployment.ruinStates.found, 0)
  assert.deepEqual(idsWhere(rows, (row) => row.state === 'unknown'), [2, 12, 22, 23, 24, 29, 30])
  assert.deepEqual(kinds(rows, 2), ['ruin-unseen'])
  assert.deepEqual(kinds(rows, 12), ['ruin-unseen'])
  assert.deepEqual(unsurveyed.deployTotals.states, { idle: 9, busy: 6, embarked: 1, unresolved: 4, unknown: 7 })
  assert.deepEqual(unsurveyed.targetList.filter((row) => row.role === 'xeno'), [])

  ;[{ supported: false, missing: ['FCT_KnownRuinRace'] }, null].forEach((ruinSites) => {
    const unread = surveyView(ctx, { ruinSites }).deployment

    assert.equal(unread.index.unseen, null)
    assert.deepEqual(idsWhere(unread.rows, (row) => row.state === 'unknown'), [2, 5, 11, 12, 22, 23, 24, 25, 26, 29, 30])
    assert.deepEqual(idsWhere(unread.rows, (row) => row.state === 'idle'), [4, 14, 15, 17, 27])
    assert.deepEqual(idsWhere(unread.rows, (row) => row.state === 'busy'), [1, 3, 13, 18, 19, 28])
    assert.deepEqual(kinds(unread.rows, 2), ['ruins-unread'])
    assert.deepEqual(unread.rows.filter((row) => row.state === 'unknown').map((row) => row.lift.kind).filter((kind) => kind !== 'one'), [])
  })

  const whole = rowsOf(ctx)

  assert.equal(rowOf(whole, 27).state, 'idle')
  assert.ok(!surveyView(ctx).deployment.index.byBody.geo.has(107), 'the unsurveyed body is a ground survey target')
  assert.deepEqual([25, 26].map((id) => rowOf(whole, id).state), ['idle', 'idle'])
})

add('construct-sites', 'a xenoarchaeology formation at a colony on an inactive ancient construct is busy with no ruin and whatever the survey, the construct is no target, an active construct is no work, one with no stored state leaves the formation of unknown activity, and constructs that could not be read leave it so too', (ctx) => {
  const read = ctx.memory.constructSites
  const withRows = (rows) => surveyView(ctx, { constructSites: { supported: true, rows } })
  const active = (body, value) => read.rows.map((row) => (row.SystemBodyID === body ? { ...row, Active: value } : row))
  const kinds = (rows, id) => rowOf(rows, id).stateReasons.map((reason) => reason.kind)
  const whole = surveyView(ctx)
  const rows = whole.deployment.rows

  assert.deepEqual(sorted(read.rows.map((row) => row.SystemBodyID)), [120, 122, 123])
  assert.equal(rowOf(rows, 28).state, 'busy')
  assert.deepEqual(rowOf(rows, 28).work.map((item) => [item.role, item.bodyId]), [['xeno', 122]])
  assert.ok(rowOf(rows, 28).work[0].name.length > 0 && rowOf(rows, 28).workLabel === rowOf(rows, 28).work[0].name, 'the work of the formation is named')
  assert.equal(whole.deployment.index.byBody.xeno.has(122), false)
  assert.ok(!whole.targetList.some((row) => row.key.split(':')[1] === '122'), 'a construct is a listed target')
  assert.equal(rowOf(rows, 5).state, 'idle')
  assert.equal(rowOf(rows, 29).state, 'unknown')
  assert.deepEqual(kinds(rows, 29), ['construct-unknown'])
  assert.equal(rowOf(rows, 30).state, 'unknown')

  // The construct on the body 120 becomes inactive: the formation 5 there is at work, the formation 11 (its xenoarchaeology rating not known) may be, and neither is left in the idle pool.
  const dormant = withRows(active(120, 0)).deployment.rows

  assert.equal(rowOf(dormant, 5).state, 'busy')
  assert.deepEqual(rowOf(dormant, 5).work.map((item) => [item.role, item.bodyId]), [['xeno', 120]])
  assert.equal(rowOf(dormant, 11).state, 'unknown')
  assert.deepEqual(kinds(dormant, 11), ['rating-unknown'])
  assert.deepEqual(idsWhere(dormant, (row) => row.state === 'idle'), [4, 14, 15, 17, 25, 26, 27])
  assert.equal(rowOf(dormant, 5).lift.kind, 'one', 'a formation at work is judged alone')

  // An inactive construct on the body of a ruin already worked: the formation is at that one work once, and the ruin's target keeps its count of formations.
  const both = withRows([...read.rows, { ...read.rows.find((row) => row.SystemBodyID === 122), SystemBodyID: 111, Active: 0 }])

  assert.equal(rowOf(both.deployment.rows, 2).work.length, 1)
  assert.equal(both.targetList.find((row) => row.key === 'xeno:111:6').busy, 1)

  // The constructs could not be read.
  ;[null, { supported: false, missing: ['FCT_AncientConstruct'] }].forEach((constructSites) => {
    const unread = surveyView(ctx, { constructSites }).deployment

    assert.equal(unread.index.constructs, null)
    assert.deepEqual(idsWhere(unread.rows, (row) => row.state === 'unknown'), [5, 11, 12, 22, 23, 24, 25, 26, 28, 29, 30])
    assert.deepEqual(idsWhere(unread.rows, (row) => row.state === 'idle'), [4, 14, 15, 17, 27])
    assert.deepEqual(idsWhere(unread.rows, (row) => row.state === 'busy'), [1, 2, 3, 13, 18, 19])
    assert.deepEqual(kinds(unread.rows, 5), ['constructs-unread'])
    assert.deepEqual(kinds(unread.rows, 28), ['constructs-unread'])
  })
})

FIXTURES.forEach((fixture, index) => {
  const label = `${fixture.file} (game ${fixture.GameID}, race ${fixture.RaceID})`
  const state = (ctx) => ctx.saves[index]

  add(`save-${index}-formations`, `${label}: the specialist formations are those with a rating in SQL, each once, and they are ${fixture.specialists} (${JSON.stringify(fixture.states)} by state)`, (ctx) => {
    const { vm, truth } = state(ctx)
    const rows = vm.deployment.rows

    assert.equal(rows.length, fixture.specialists)
    assert.deepEqual(sorted(ids(rows)), sorted(truth.specialists.map((row) => row.id)))
    assert.equal(new Set(ids(rows)).size, rows.length)
    assert.equal(vm.deployment.others, truth.formations.length - truth.specialists.length)
    assert.deepEqual(vm.deployTotals.states, fixture.states)
    rows.forEach((row) => {
      const known = truth.formations.find((item) => item.id === row.id)

      near(row.geo, known.geo, `formation ${row.id} geo`)
      near(row.xeno, known.xeno, `formation ${row.id} xeno`)
      near(row.mass, known.mass, `formation ${row.id} mass`)
    })
  })

  add(`save-${index}-states`, `${label}: every formation is idle, busy, embarked, unresolved or of unknown activity as the colony's body, the surveyed work, the ruins on colony bodies and the ship's system say in SQL`, (ctx) => {
    const { vm, truth } = state(ctx)

    vm.deployment.rows.forEach((row) => assert.equal(row.state, truth.states[row.id], `formation ${row.id}`))
  })

  add(`save-${index}-targets`, `${label}: the ground survey targets are the bodies with potential left that the race has surveyed in systems it knows (${fixture.geoBodies}, ${fixture.geoColonies} with a colony), inside the systems aggregate`, (ctx) => {
    const { vm, truth, systems } = state(ctx)
    const bodies = new Set(vm.groundRows.map((row) => row.SystemBodyID))

    assert.deepEqual(sorted(bodies), sorted(truth.geoKnown.map((row) => row.id)))
    assert.equal(bodies.size, fixture.geoBodies)
    assert.equal(vm.deployTotals.targets.geo.bodies, bodies.size)
    assert.equal(vm.deployTotals.targets.geo.colonies, fixture.geoColonies)
    assert.ok(truth.geoAll.length >= truth.geoKnown.length)

    const perSystem = new Map()

    truth.geoKnown.forEach((row) => perSystem.set(row.system, (perSystem.get(row.system) || 0) + 1))
    vm.deployment.index.bySystem.geo.forEach((targets, system) => {
      const aggregate = systems.find((row) => row.SystemID === system)

      assert.ok(aggregate, `system ${system} is in the systems aggregate`)
      assert.equal(new Set(targets.map((target) => target.bodyId)).size, perSystem.get(system))
      assert.ok(perSystem.get(system) <= aggregate.BodiesSurveyed, `system ${system}: ${perSystem.get(system)} bodies of ${aggregate.BodiesSurveyed} surveyed`)
      assert.equal(truth.surveyed.get(system), aggregate.BodiesSurveyed)
    })
  })

  add(`save-${index}-ruins`, `${label}: the ruin targets are the surveyed ruins with installations left and builders not identified (${fixture.ruins.found}); the ${fixture.ruins.hidden} ruins the race has not surveyed are read only where a colony of the race stands, and are never a target`, (ctx) => {
    const { vm, truth } = state(ctx)
    const read = new Set(state(ctx).ruinRows.map((row) => row.SystemBodyID))
    const targets = new Set(vm.deployment.index.byRole.xeno.map((target) => target.bodyId))
    const hidden = truth.ruinsAll.filter((row) => !row.seen)

    assert.deepEqual(sorted(targets), sorted(truth.found))
    assert.equal(targets.size, fixture.ruins.found)
    assert.equal(hidden.length, fixture.ruins.hidden)
    assert.ok(hidden.filter((row) => !row.colony).every((row) => !read.has(row.id)), 'a hidden ruin with no colony was read')
    assert.deepEqual(sorted(read), sorted(truth.ruinsAll.filter((row) => row.seen || row.colony).map((row) => row.id)))
    assert.ok(hidden.every((row) => !targets.has(row.id)), 'a hidden ruin is a target')
    assert.deepEqual(sorted(vm.deployment.index.unseen), sorted(truth.unseen))
    assert.equal(Object.values(vm.deployment.ruinStates).reduce((sum, count) => sum + count, 0), truth.ruinsAll.filter((row) => row.seen).length)
  })

  add(`save-${index}-constructs`, `${label}: the ancient constructs read are those on a colony body of the race (${fixture.constructs.bodies}), ${fixture.constructs.inactive} of them not active, as the SQL written here finds them, and a formation at one of the inactive ones is busy`, (ctx) => {
    const { vm, truth, constructRows } = state(ctx)
    const bodies = sorted(constructRows.map((row) => row.SystemBodyID))
    const inactive = sorted(vm.deployment.index.constructs.inactive.keys())

    assert.deepEqual(bodies, sorted(truth.constructsAll.map((row) => row.id)))
    assert.equal(bodies.length, fixture.constructs.bodies)
    assert.deepEqual(inactive, sorted(truth.inactive))
    assert.equal(inactive.length, fixture.constructs.inactive)
    assert.deepEqual(sorted(vm.deployment.index.constructs.unknown), sorted(truth.unsure))
    assert.ok(truth.specialists.filter((row) => row.xeno > 0 && row.pop > 0 && inactive.includes(truth.populations.get(row.pop).body)).every((row) => vm.deployment.rows.find((item) => item.id === row.id).state === 'busy'), 'a formation at an inactive construct is not busy')
  })

  add(`save-${index}-lifts`, `${label}: the lift of each formation is the first-fit packing, written here, of the idle formations' mass into the troop bays`, (ctx) => {
    const { vm, truth, troops } = state(ctx)
    const rows = vm.deployment.rows
    const pool = rows.filter((row) => row.state === 'idle').map((row) => ({ id: row.id, mass: truth.formations.find((item) => item.id === row.id).mass }))
    const expected = packed(pool, baysOf(troops))

    assert.deepEqual(idsWhere(rows, (row) => row.lift.kind === 'none'), sorted(expected.none))
    assert.equal(vm.deployment.lifts, pool.length ? expected.lifts : 0)
    pool.filter((item) => !expected.none.includes(item.id)).forEach((item) => {
      const verdict = rowOf(rows, item.id).lift

      assert.equal(verdict.lift, expected.lift.get(item.id), `formation ${item.id}`)
      assert.equal(verdict.kind, expected.lift.get(item.id) === 1 ? 'one' : 'several')
    })
    rows.filter((row) => row.state === 'embarked').forEach((row) => assert.equal(row.lift.kind, 'aboard'))
  })

  add(`save-${index}-rates`, `${label}: the ground survey rate of each colony is the sum, over its geosurvey formations, of the rating times the multiplier of the commander twice, by SQL and the game's rule written here`, (ctx) => {
    const { vm, truth } = state(ctx)

    vm.groundRows.filter((row) => row.PopulationID).forEach((row) => {
      const known = truth.teams.get(row.PopulationID)

      assert.equal(row.Units, known ? known.units : 0, `colony ${row.PopulationID} units`)

      if (row.rateUnknown) {
        assert.equal(row.PointsPerDay, null)
      } else {
        near(row.PointsPerDay, known ? known.perDay * (vm.game.SurveySpeed / 100) : 0, `colony ${row.PopulationID} points a day`)
      }
    })
    vm.groundRows.filter((row) => !row.PopulationID).forEach((row) => assert.deepEqual([row.Units, row.PointsPerDay], [0, 0]))
  })

  add(`save-${index}-all-rates`, `${label}: the geosurvey formations of every one of its ${fixture.colonies} colonies, with ground survey work or not, are those of the SQL read, each with its rating and the multiplier of its commander (the capacity and the superiors by the game's rule written here), in both directions`, (ctx) => {
    const { vm, truth } = state(ctx)
    const teams = vm.colonyTeams

    assert.equal(truth.populations.size, fixture.colonies)
    assert.ok([...teams.keys()].every((id) => truth.populations.has(id)), 'a team at a colony the SQL does not know')
    assert.ok([...truth.teams.keys()].every((id) => teams.has(id)), 'a colony with a ground survey team the module does not know')
    truth.populations.forEach((_colony, id) => {
      const team = teams.get(id) || { units: 0, base: 0, formations: [], unknown: [] }
      const known = truth.teams.get(id)

      assert.equal(team.units, known ? known.units : 0, `colony ${id} units`)
      near(team.base, known ? known.base : 0, `colony ${id} base`)

      const wanted = known ? known.formations : []

      assert.deepEqual(team.formations.map((item) => item.id), wanted.map((item) => item.id), `colony ${id} formations`)
      team.formations.forEach((item, at) => {
        near(item.base, wanted[at].base, `formation ${item.id} base`)
        near(item.multiplier, wanted[at].multiplier, `formation ${item.id} multiplier`)
      })
    })
  })
})

// ---------- running ----------

// The failed results of the checks over the context of a fault or a rewrite; a check that ended in an exception of its own stops the run (scripts/lib/fault-credit.js).
const judge = async (ctx, list = results) => judged(await runChecks(list, ctx))

// ---------- the page in a browser ----------

// The save the browser opens and the game and race to pick on the Empires page: a race with formations in two states and a ruin worked by one of them, which tells every control apart. Each variant of the page gets a new browser context, so nothing it stores reaches another.
const BROWSER_SAVE = 2
const BROWSER_NAMES = { game: 'EggSample', race: 'EggSample' }
const CAPABILITIES_FILE = path.join(utilitiesDirectory, 'capabilities.js')
const WITHHELD_TIMEOUT = 15000
// The bounds of the children the controls of the harness start (`checkControls`): a probe of `finish`, which prints and ends before it starts a page server (a second or two), and the run of this script on the records of the page (`--only`, 7 s measured), each over five times its measured time, a minute for the probes and two for the run.
const QUICK_LIMIT = 60000
const NESTED_LIMIT = 120000

// The formation of the browser's save that works the ruin there, and the colony it is put on in every copy below: one that holds no ruin and no ancient construct, so that the formation is idle when everything is read and only an unread ruin or construct read can leave its work in doubt.
const MOVED_FORMATION = 557
const movedStatement = (fixture) => `update FCT_GroundUnitFormation set PopulationID = (select p.PopulationID from FCT_Population p where p.GameID = ${fixture.GameID} and p.RaceID = ${fixture.RaceID} and p.SystemBodyID not in (select SystemBodyID from FCT_SystemBody where GameID = ${fixture.GameID} and AbandonedFactories > 0) and p.SystemBodyID not in (select SystemBodyID from FCT_AncientConstruct where GameID = ${fixture.GameID}) order by p.PopulationID limit 1) where FormationID = ${MOVED_FORMATION}`

// The optional reads of the page, each case with what is taken from a copy of the browser's save so that the read finds nothing, and the text of the capability registry that makes the input required (the planted fault).
const UNREAD = [
  { kind: 'construct-column', input: 'constructSites', statements: ['alter table FCT_AncientConstruct drop column Active'], from: "'ruinSites', 'constructSites', 'troopBays'", to: "'ruinSites', 'troopBays'" },
  { kind: 'construct-table', input: 'constructSites', statements: ['drop table FCT_AncientConstruct'], from: "'ruinSites', 'constructSites', 'troopBays'", to: "'ruinSites', 'troopBays'" },
  { kind: 'ruin-table', input: 'ruinSites', statements: ['drop table FCT_KnownRuinRace'], from: "'ruinSites', 'constructSites'", to: "'constructSites'" },
  { kind: 'troop-column', input: 'troopBays', statements: ['alter table FCT_ShipClass drop column TroopCapacity'], from: "'constructSites', 'troopBays'", to: "'constructSites'" },
]
const UNREAD_INPUTS = [...new Set(UNREAD.map((entry) => entry.input))]
const EMPIRE_LIST_FILE = path.join(root, 'src', 'renderer', 'components', 'navigation', 'EmpireList.vue')
const BROWSER_TIMEOUT = 120000

// What the page on screen shows; runs in the page, through the shared readers of scripts/lib/browser-observe.js (`installScreen`). Only the hooks the template carries for this are read (data attributes), each for the role or the identity of the element, with the text the element draws and whether it is on screen (`hooked`): the chips of each group with their role (and the ones Vuetify draws as on), each row of the formation table by the parts it holds (the formation's cell with its id, its name, its state with the label of the state and the work), the targets by key with the name each draws, each panel with its summary, the switch, and the grouping of the setting the figures are written in. Nothing is judged here: the check reads it in Node.
const readScreen = () => {
  const { visible, hooked } = window.__screen
  const chips = (group) => {
    const root = document.querySelector(`[data-deploy="${group}"]`)

    return root ? { entries: hooked(root, 'data-deploy-chip'), active: [...root.querySelectorAll('[data-deploy-chip].v-chip--active')].map((chip) => chip.getAttribute('data-deploy-chip')) } : { entries: [], active: [] }
  }
  const input = document.querySelector('input[data-deploy="unstaffed"]')
  const control = input && input.closest('.v-input')
  // Each row of a table that holds the cell of a formation, its parts read by their hooks.
  const formations = [...document.querySelectorAll('tr')].filter((row) => row.querySelector('[data-deploy-formation]')).map((row) => ({ cell: hooked(row, 'data-deploy-formation'), name: hooked(row, 'data-deploy-name'), state: hooked(row, 'data-deploy-state'), label: hooked(row, 'data-deploy-state-label'), work: hooked(row, 'data-deploy-work') }))
  const panels = [...document.querySelectorAll('.panel')].filter((panel) => panel.querySelector(':scope > .panel-head')).map((panel) => ({ kind: panel.hasAttribute('data-deploy') ? 'deploy' : panel.hasAttribute('data-targets') ? 'targets' : 'other', summary: panel.getAttribute('data-summary') || '', visible: visible(panel) }))

  return { panels, chips: { roles: chips('roles'), states: chips('states') }, formations, targets: hooked(document.body, 'data-target-key'), unstaffed: Boolean(input && input.checked), switchShown: control ? visible(control) : null, grouping: window.$app.$store.getters.config.get('selectedSeparator', 'Tick') }
}

// The page of the browser's save as a player uses it: the race is picked, the page opened, each role chip, each state chip and the switch are clicked (and clicked back) and the screen is read after each; then the two filters and the switch are left set, the page is left for another and opened again, and the screen is read once more. Resolves to the record of `observe` (scripts/lib/browser-observe.js: the page errors, the console errors, the failed requests and the phase are in it whether the page went through or not) with the value { initial, geoOff, ..., combined, restored }. With `unread` the page is read once, after the capability check has answered, and the value is { initial, capability }: the status of the page's report and the inputs it names as missing and degraded; a page that is not drawn is read as it is, after a short wait.
const observePage = (browser, url, { unread = false, withheld = false, timeout = BROWSER_TIMEOUT, until = null } = {}) => observe(browser, async ({ page, step }) => {
  const settle = (loading = pageLoading) => {
    step('waiting for the page to settle')

    return settled(page, { limit: timeout, loading })
  }
  const go = async (route) => {
    step(`opening ${route}`)
    await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), route)
    await page.waitForFunction(pageLoading.arrived, route, { timeout })

    if (route === '/survey-progress') {
      await page.waitForSelector('[data-deploy="panel"] [data-deploy-chip]', { state: 'attached', timeout })
    }

    await settle()
  }
  // A click commits the change through the event it dispatches, and Vue's next tick is the flush of every update and watcher it queued: the screen is read after that render.
  const press = async (selector) => {
    step(`pressing ${selector}`)
    await page.locator(selector).first().click({ timeout })
    await page.evaluate(async () => { await window.$app.$nextTick() })
  }
  const read = () => {
    step('reading the screen')

    return page.evaluate(readScreen)
  }
  const chip = (group, value) => `[data-deploy="${group}"] [data-deploy-chip="${value}"]`

  // Opening the page has the full deadline whatever `timeout` says: a page server that has just started compiles the app for its first page, and the waits `timeout` bounds are those of the case.
  step('opening the app')
  await page.goto(url, { timeout: BROWSER_TIMEOUT })
  await installScreen(page)

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${BROWSER_NAMES.game} ·` }).first().click({ timeout })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(BROWSER_NAMES.race, { exact: true }).last().click({ timeout })
  }

  step('waiting for the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout })

  if (unread) {
    // A page may not be drawn at all (a save without a table makes the landing page unsupported, and the registry with the input required withholds this one), so the pages are never waited for as loading: only the database calls are, and the chips are waited for until they are drawn or the layout shows, in place of the page, the capability state of a page the report says is unsupported.
    step('waiting for the capability report')
    await page.waitForFunction(() => Boolean(window.$app.$store.getters['capabilities/report']('/survey-progress')), null, { timeout })
    await settle(() => false)
    step('opening /survey-progress')
    await page.evaluate((target) => window.$app.$router.push(target, () => {}, () => {}), '/survey-progress')

    await page.waitForFunction(() => {
      const report = window.$app.$store.getters['capabilities/report']('/survey-progress')

      return window.$app.$route.path === '/survey-progress' && (document.querySelector('[data-deploy="panel"] [data-deploy-chip]') !== null || (Boolean(report) && report.status === 'unsupported' && document.querySelector('[data-capability-state="unsupported"]') !== null))
    }, null, { timeout: withheld ? WITHHELD_TIMEOUT : timeout }).catch(() => {})

    const drawn = await page.evaluate(() => document.querySelector('[data-deploy="panel"] [data-deploy-chip]') !== null)

    await settle(drawn ? pageLoading : () => false)

    const capability = await page.evaluate(() => {
      const report = window.$app.$store.getters['capabilities/report']('/survey-progress')

      return report ? { status: report.status, missing: report.missing.map((entry) => entry.key), degraded: report.degraded.map((entry) => entry.key) } : null
    })

    return { initial: await read(), capability }
  }

  await settle()
  await go('/survey-progress')

  const seen = { initial: await read() }

  if (until === 'initial') {
    return seen
  }

  for (const [name, group, value] of [['geo', 'roles', 'geo'], ['xeno', 'roles', 'xeno'], ['busy', 'states', 'busy'], ['idle', 'states', 'idle']]) {
    await press(chip(group, value))
    seen[`${name}Off`] = await read()
    await press(chip(group, value))
    seen[`${name}On`] = await read()
  }

  await press('.v-input--selection-controls__input:has(input[data-deploy="unstaffed"])')
  seen.unstaffedOn = await read()
  await press(chip('roles', 'geo'))
  await press(chip('states', 'idle'))
  seen.combined = await read()
  await go('/propulsion')
  await go('/survey-progress')
  seen.restored = await read()

  return seen
})

// The rows of the formation table as the page is to draw them: the formation's id (the identity of its row), its name, its state and its work, from the rows of the module.
const listedRows = (list) => list.map((row) => ({ id: row.id, name: row.name, state: row.state, work: row.workLabel || '' }))

// The screen the browser must show for the filters given, worked out from the pseudo instance's rows over the same save and the utility's own selection (the wiring is what the browser proves, the lists are checked above and against SQL).
const expectedScreen = (ctx) => {
  const { vm } = ctx.saves[BROWSER_SAVE]
  const rows = vm.deployment.rows
  const targets = ctx.mod.targetRows(vm.deployment.index, rows)
  const totals = vm.deployTotals

  return ({ roles = ALL_ROLES, states = ALL_STATES, unstaffed = false }) => ({
    formations: listedRows(ctx.mod.selectDeployments(rows, { roles, states })),
    targets: targets.filter((row) => roles.includes(row.role) && (!unstaffed || row.status !== 'worked')).map((row) => ({ key: row.key, name: row.name })),
    roles: Object.fromEntries(ALL_ROLES.map((role) => [role, { count: totals[role], on: roles.includes(role) }])),
    states: Object.fromEntries(ALL_STATES.map((state) => [state, { count: totals.states[state], on: states.includes(state) }])),
    unstaffed,
  })
}

// The module's own tables of words for the roles and the states ({ key: words }), which a chip and a label are read back through.
const labelsOf = (mod) => ({ roles: Object.fromEntries(mod.ROLE_CHOICES.map((choice) => [choice.value, choice.text])), states: Object.fromEntries(mod.STATE_CHOICES.map((choice) => [choice.value, choice.text])) })

// A chip read back from what it draws ("Geological (3)"): the key of its words through the table `labels` and its figure, read whole in the grouping of the setting, as "key figure"; null for a text of no such shape.
const chipRead = (labels, grouping) => (text) => {
  const match = /^(.*) \(([^()]*)\)$/.exec(text)

  return match ? `${labelKey(match[1], labels)} ${readFigure(match[2], grouping)}` : null
}

// The chips of both groups against the expected ones by role: each draws the words of its role and its figure, and the ones on are the ones Vuetify draws as on.
const chipProblems = (screen, want, labels) => ['roles', 'states'].flatMap((group) => {
  const { entries, active } = screen.chips[group]

  return [
    ...rolesRead(`the ${group} chips`, entries, Object.fromEntries(Object.entries(want[group]).map(([key, { count }]) => [key, `${key} ${count}`])), chipRead(labels[group], screen.grouping)),
    ...Object.entries(want[group]).filter(([key, { on }]) => active.includes(key) !== on).map(([key, { on }]) => [`the ${group} chips`, key, on ? 'is not on' : 'is on']),
  ]
})

// The rows of the formation table on screen set against the expected rows by the formation's id (the identity the hook of its cell gives), never by their place: each draws the formation's name, the words of its state (read back through the module's table of states, its hook naming the same state) and its work, or no work when it has none.
const formationProblems = (screen, rows, labels) => {
  const lines = screen.formations.map((line) => ({ ...line, ids: line.cell.filter((entry) => entry.on).map((entry) => entry.role) })).filter((line) => line.ids.length > 0)
  const { pairs, problems } = pairedBy('the formation rows', lines, rows, (line) => line.ids.join(), (row) => String(row.id))

  return [...problems, ...pairs.flatMap(([row, line]) => {
    const what = `the row of formation ${row.id}`
    const hooks = line.state.filter((entry) => entry.on).map((entry) => entry.role)

    return [
      ...rolesRead(`${what}: name`, line.name, { '': row.name }),
      ...rolesRead(`${what}: state`, line.label, { '': row.state }, (text) => labelKey(text, labels.states)),
      ...(JSON.stringify(hooks) === JSON.stringify([row.state]) ? [] : [[`${what}: the hook of the state`, hooks, row.state]]),
      ...rolesRead(`${what}: work`, line.work, { '': row.work || null }),
    ]
  })]
}

// The targets on screen set against the expected ones by key, each drawing the name of its body.
const targetProblems = (screen, rows) => {
  const { pairs, problems } = pairedBy('the targets', screen.targets.filter((entry) => entry.on), rows, (entry) => entry.role, (row) => row.key)

  return [...problems, ...pairs.filter(([row, entry]) => entry.text !== row.name).map(([row, entry]) => ['the targets', row.key, entry.text, row.name])]
}

// What a screen shows that the expected screen does not, read by role and identity: [] when it shows what is expected.
const screenProblems = (screen, want, labels) => [...chipProblems(screen, want, labels), ...formationProblems(screen, want.formations, labels), ...targetProblems(screen, want.targets), ...(screen.unstaffed === want.unstaffed ? [] : [['the switch of the targets', screen.unstaffed, want.unstaffed]])]

// The groups of the page with an element of a hook that is there and not on screen.
const hiddenOf = (screen) => [['chips', [...screen.chips.roles.entries, ...screen.chips.states.entries]], ['formations', screen.formations.flatMap((line) => line.cell)], ['targets', screen.targets], ['switch', screen.switchShown === false ? [{ on: false }] : []]].filter(([, entries]) => entries.some((entry) => !entry.on)).map(([group]) => group)

// The state the row of a formation draws, read back from the words of its label through the module's table of states: null when no row of that formation, or no single label, is on screen.
const stateShown = (screen, id, labels) => {
  const line = screen.formations.find((item) => item.cell.some((entry) => entry.on && entry.role === String(id)))
  const label = line ? line.label.filter((entry) => entry.on) : []

  return label.length === 1 ? labelKey(label[0].text, labels.states) : null
}

// The value of the observation of the page, or the failure: a record of another shape is a defect of the harness (HarnessError). An observation that failed in itself (the context did not open or close, the work threw, a server that did not start) fails the check with an error of its own, which no fault is credited for, even where a screen was kept and the page raised errors besides. A page that raised an error nothing named fails the check on an assertion, what the renderer does being behaviour (a fault in the page's template is caught that way).
const observed = (ctx) => {
  validate(ctx.browser, 'the observation of the page')

  if (infrastructureFailure(ctx.browser)) {
    throw new Error(`the browser did not get through the page ${failureLine(ctx.browser)}`)
  }

  if (ctx.browser.unexpected.length) {
    assert.fail(`the page raised an error nothing named ${failureLine(ctx.browser)}`)
  }

  return ctx.browser.value
}

// The two halves of the record of one case, each a whole record: the page as the registry has it (`real`) and with the input required (`fault`).
const halvesOf = (seen, label) => {
  if (!seen || typeof seen !== 'object') {
    throw new HarnessError(`the record of ${label} is not a record of two observations`)
  }

  return [['real', validate(seen.real, `${label}: real`)], ['fault', validate(seen.fault, `${label}: fault`)]]
}
const differs = (a, b) => assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'the control would change nothing the browser reads')

add('browser-panels', 'every panel the page draws carries a summary in its data-summary, the two new panels among them, and neither names a figure', (ctx) => {
  const { initial } = observed(ctx)

  assert.ok(initial.panels.length >= 2)
  assert.deepEqual(initial.panels.filter((panel) => !panel.summary.trim()).map((panel) => panel.kind), [])
  assert.equal(initial.panels.filter((panel) => panel.kind === 'deploy').length, 1)
  assert.equal(initial.panels.filter((panel) => panel.kind === 'targets').length, 1)
  assert.ok(initial.panels.filter((panel) => panel.kind !== 'other').every((panel) => !/\d/.test(panel.summary)))
  assert.ok(initial.panels.filter((panel) => panel.kind !== 'other').every((panel) => panel.visible), 'both panels are visible')
})

add('browser-rows', 'every formation row the page lists is on screen and draws its formation\'s name, the words of its state and its work as the rows hold them, each row by its formation, with nothing in the page that is there but not on screen', (ctx) => {
  const { initial } = observed(ctx)
  const expected = ctx.expected({}).formations

  assert.deepEqual(hiddenOf(initial), [], 'the groups with a hooked element that is there and not on screen')
  assert.ok(expected.length >= 2)
  assert.ok(expected.some((row) => row.work !== ''), 'a row of the save has work')
  assert.deepEqual(formationProblems(initial, expected, ctx.labels), [])
})

// The screen read against the screen expected, by role and identity, at one step of the drive.
const drawsAsExpected = (ctx, screen, want, step) => assert.deepEqual(screenProblems(screen, want, ctx.labels), [], step)

add('browser-roles', 'each role chip, clicked in the browser, takes its role out of the rows and the targets and brings it back, and the chips keep their counts', (ctx) => {
  const seen = observed(ctx)
  const expected = ctx.expected

  drawsAsExpected(ctx, seen.initial, expected({}), 'the page as it opens')
  differs(expected({ roles: ['xeno'] }), expected({}))
  differs(expected({ roles: ['geo'] }), expected({}))
  drawsAsExpected(ctx, seen.geoOff, expected({ roles: ['xeno'] }), 'geo off')
  drawsAsExpected(ctx, seen.geoOn, expected({}), 'geo on again')
  drawsAsExpected(ctx, seen.xenoOff, expected({ roles: ['geo'] }), 'xeno off')
  drawsAsExpected(ctx, seen.xenoOn, expected({}), 'xeno on again')
})

add('browser-states', 'each state chip, clicked in the browser, takes its state out of the rows and brings it back, and the chips keep their counts', (ctx) => {
  const seen = observed(ctx)
  const expected = ctx.expected
  const without = (state) => ALL_STATES.filter((item) => item !== state)

  differs(expected({ states: without('busy') }), expected({}))
  differs(expected({ states: without('idle') }), expected({}))
  drawsAsExpected(ctx, seen.busyOff, expected({ states: without('busy') }), 'busy off')
  drawsAsExpected(ctx, seen.busyOn, expected({}), 'busy on again')
  drawsAsExpected(ctx, seen.idleOff, expected({ states: without('idle') }), 'idle off')
  drawsAsExpected(ctx, seen.idleOn, expected({}), 'idle on again')
})

add('browser-unstaffed', 'the switch of the targets, clicked in the browser, keeps only the targets no formation works', (ctx) => {
  const seen = observed(ctx)

  differs(ctx.expected({ unstaffed: true }), ctx.expected({}))
  drawsAsExpected(ctx, seen.unstaffedOn, ctx.expected({ unstaffed: true }), 'the switch on')
})

add('browser-restored', 'the roles, the states and the switch left set are those the page shows when it is left and opened again', (ctx) => {
  const seen = observed(ctx)
  const set = { roles: ['xeno'], states: ALL_STATES.filter((state) => state !== 'idle'), unstaffed: true }

  differs(ctx.expected(set), ctx.expected({}))
  drawsAsExpected(ctx, seen.combined, ctx.expected(set), 'the filters set')
  drawsAsExpected(ctx, seen.restored, ctx.expected(set), 'the page opened again')
})

add('browser-clean', 'the page raises no error while it is driven: no page error and no console error, those that Vue catches in a handler, a watcher or a render included', (ctx) => {
  validate(ctx.browser, 'the observation of the page')
  assert.deepEqual({ errors: ctx.browser.errors, console: ctx.browser.console }, { errors: [], console: [] })
  observed(ctx)
})

const unreadRows = (ctx, name) => {
  if (ctx.unreadRows[name] instanceof Error) {
    throw ctx.unreadRows[name]
  }

  return ctx.unreadRows[name]
}

add('browser-unread', 'a save without what an optional read of the page needs leaves the page in service: the capability report is degraded by that input only, both panels are drawn, and a formation whose work cannot be told reads as unknown and not as idle', (ctx) => {
  const moved = new Map(unreadRows(ctx, 'moved').map((row) => [row.id, row.state]))

  assert.equal(moved.get(MOVED_FORMATION), 'idle', 'the moved formation is idle when everything is read')

  for (const entry of UNREAD) {
    const halves = halvesOf(ctx.unreadSeen[entry.kind], entry.kind)

    for (const [half, seen] of halves) {
      if (seen.error) {
        throw new Error(`the browser did not get through ${entry.kind} ${half} ${failureLine(seen)}`)
      }
    }

    const { initial, capability } = halves[0][1].value
    const expected = unreadRows(ctx, entry.kind)

    assert.deepEqual(capability, { status: 'degraded', missing: [], degraded: [entry.input] }, `${entry.kind}: the capability report`)
    assert.deepEqual(initial.panels.filter((panel) => panel.kind !== 'other').map((panel) => `${panel.kind} ${panel.visible}`).sort(), ['deploy true', 'targets true'], entry.kind)
    assert.deepEqual(hiddenOf(initial), [], entry.kind)
    assert.deepEqual(formationProblems(initial, expected, ctx.labels), [], entry.kind)

    const flipped = expected.filter((row) => row.state === 'unknown' && moved.get(row.id) === 'idle').map((row) => row.id)

    if (entry.input === 'troopBays') {
      assert.deepEqual(new Map(expected.map((row) => [row.id, row.state])), moved, `${entry.kind}: the troop ships do not change a state`)
    } else {
      assert.deepEqual(flipped, [MOVED_FORMATION], `${entry.kind}: the formation that was idle reads as unknown`)
      assert.equal(stateShown(initial, MOVED_FORMATION, ctx.labels), 'unknown', entry.kind)
    }
  }
})

// A fault or a benign rewrite: [name, from, to, file, expected ids (a fault; the check ids one of which must fail), browser (the page is served to the browser and driven), { throws } (a fault whose catch is a throw of the code under test, which credits it; scripts/lib/fault-credit.js `caughtBy`)].
const SPEC_RELATIVE = 'utilities/specialist-deployments'
const SURVEY_RELATIVE = 'utilities/survey'

/* eslint-disable no-template-curly-in-string */
const MUTANTS = [
  ['a formation is busy wherever it stands', 'SPECIALIST_ROLES.filter((role) => roles[role] === true && index.byBody[role].has(bodyId))', 'SPECIALIST_ROLES.filter((role) => roles[role] === true)', SPEC_FILE, ['states', 'state-details']],
  ['a row draws the geological rating as its xenoarchaeology rating', 'rows.push({ ...shared.get(node.id), roleKeys: own,', 'rows.push({ ...shared.get(node.id), xeno: shared.get(node.id).geo, roleKeys: own,', SPEC_FILE, ['capability-actual']],
  ['a ship that is not resolved still counts as embarked', "location.kind === 'ship' && location.state === 'resolved'", "location.kind === 'ship'", SPEC_FILE, ['states', 'state-details']],
  ['a colony with no residents is no candidate', 'isId(row.PopulationID) ? {', 'isId(row.PopulationID) && row.ColonyPopulation > 0 ? {', SPEC_FILE, ['boundary-population']],
  ['a formation too large for every bay is carried', "verdict(candidate.id, 'none'))", "verdict(candidate.id, 'one'))", SPEC_FILE, ['lifts', 'lifts-bays']],
  ['every formation weighs nothing for the lift', 'formation: { ownSize: row.mass }', 'formation: { ownSize: 0 }', SPEC_FILE, ['lifts', 'lifts-bays']],
  ['unread troop bays read as none', "kind: 'unknown', lift: null, lifts: null, largest }", "kind: 'none', lift: null, lifts: null, largest }", SPEC_FILE, ['lifts-unavailable']],
  ['a ruin whose builders are known is still a target', 'known: Boolean(row.Known)', 'known: false', SPEC_FILE, ['targets-eligible', 'target-rows', 'save-1-formations', 'save-1-ruins']],
  ['a ruin on a colony body the race has not surveyed is not read', 'or FCT_Population.PopulationID is not null) order by', 'or false) order by', SPEC_FILE, ['targets-eligible', 'save-1-states']],
  ['a ruin in a system the race does not know counts as surveyed', 'Boolean(row.Surveyed) && Boolean(row.SystemKnown)', 'Boolean(row.Surveyed)', SPEC_FILE, ['targets-eligible', 'target-rows']],
  ['a formation on a ruin outside the known ones is idle', 'index.unseen.has(bodyId)', 'false', SPEC_FILE, ['states', 'state-details', 'unknown-sites']],
  ['a known ruin with no installations count is no place the game may work', 'if (!RUIN_STATES.includes(state) && isId(row.PopulationID)) {', 'if (false) {', SPEC_FILE, ['targets-eligible', 'states']],
  ['a spent or identified ruin out of sight is a place the game may work', "state === 'found' || !RUIN_STATES.includes(state)", 'true', SPEC_FILE, ['targets-eligible', 'states']],
  ['a geological formation is of unknown activity wherever the ruins are unread', 'if (roles.xeno !== false) {', 'if (true) {', SPEC_FILE, ['unknown-sites']],
  ['a formation of unknown activity is packed with the idle ones', '(row) => row.state === \'idle\')', '(row) => row.state === \'idle\' || row.state === \'unknown\')', SPEC_FILE, ['lifts']],
  ['every formation is packed with the idle ones', '(row) => row.state === \'idle\')', '() => true)', SPEC_FILE, ['lifts', 'save-0-lifts']],
  ['the base rating of a colony is not summed', 'team.base += node.geo.value\n', 'team.base += 0\n', SPEC_FILE, ['save-0-all-rates', 'save-1-all-rates', 'save-2-all-rates']],
  ['a colony with a team of one formation only keeps the last', 'team.units += node.geo.from.reduce((sum, item) => sum + item.units, 0)', 'team.units = node.geo.from.reduce((sum, item) => sum + item.units, 0)', SPEC_FILE, ['rates', 'save-0-all-rates', 'save-1-all-rates', 'save-2-all-rates']],
  ['the multiplier of a formation is not taken from its commander', 'multiplier: multipliers === null ? null : multipliers.has(node.id) ? multipliers.get(node.id) : 1', 'multiplier: 1', SPEC_FILE, ['rates', 'save-2-all-rates']],
  ['a formation of unknown rating counts as unrated', 'if (node.geo.value === null) {', 'if (node.geo.value === null && false) {', SPEC_FILE, ['rates']],
  ['the state filter is ignored', 'states.includes(row.state))', 'true)', SPEC_FILE, ['select']],
  ['a formation with two ratings is counted once as geo only', 'xeno += row.roleKeys.includes(\'xeno\') ? 1 : 0', 'xeno += row.roleKeys.includes(\'xeno\') && !row.roleKeys.includes(\'geo\') ? 1 : 0', SPEC_FILE, ['rows-once', 'select']],
  ['a formation that may be working is not marked', 'roles[role] === null && index.byBody[role].has(bodyId)', 'false', SPEC_FILE, ['state-details']],
  ['a body with no colony is not told apart', "target.colony ? (here ? 'worked' : 'unstaffed') : 'no-colony'", "here ? 'worked' : 'unstaffed'", SPEC_FILE, ['target-rows']],
  ['a candidate body is counted for each of its colonies', 'const key = `${role}:${target.bodyId}`', 'const key = target.key', SPEC_FILE, ['targets-totals']],
  ['the persisted filter is shared by every race', "key: 'deployRoles', scope: 'race'", "key: 'deployRoles', scope: 'game'", SPEC_FILE, ['views']],
  ['the persisted filter shares the key of the other', "key: 'deployStates', scope: 'race'", "key: 'deployRoles', scope: 'race'", SPEC_FILE, ['views']],
  ['a body the race has not surveyed is a ground survey target', 'inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} and FCT_SystemBodySurveys.GameID = ${this.GameID} inner join FCT_RaceSysSurvey', 'left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID} and FCT_SystemBodySurveys.GameID = ${this.GameID} inner join FCT_RaceSysSurvey', SURVEY_FILE, ['targets-eligible', 'save-1-targets']],
  ['a body in a system the race does not know is a target', 'inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_Population', 'left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID} left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID} left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_Population', SURVEY_FILE, ['targets-eligible', 'ruins-unsupported']],
  ['the ground rate ignores a formation of unknown rating', 'groundSurveyRate(teamUnknown ? null : team.formations, this.surveySpeed)', 'groundSurveyRate(team ? team.formations : [], this.surveySpeed)', SURVEY_FILE, ['rates']],
  ['the commanders are not given to the colony teams', 'colonyGeoTeams(this.formationModel, this.commanderMultipliers)', 'colonyGeoTeams(this.formationModel, new Map())', SURVEY_FILE, ['rates', 'save-2-all-rates']],
  ['commanders that were not read count as none', 'groundCommandMultipliers(this.groundCommanders.rows) : null', 'groundCommandMultipliers(this.groundCommanders.rows) : new Map()', SURVEY_FILE, ['rates']],
  ['a multiplier counts once in the rate of a formation', 'total + base * multiplier * multiplier', 'total + base * multiplier', SURVEY_UTILITY_FILE, ['rates']],
  ['a multiplier that is not known counts as a rate of nothing', '} else if (formations.some((formation) => !Number.isFinite(formation.multiplier))) {', '} else if (false) {', SURVEY_UTILITY_FILE, ['rates']],
  ['the command capacity cuts nothing', '(share < 1 ? 1 + (bonus - 1) * share : bonus) * above', 'bonus * above', SURVEY_UTILITY_FILE, ['rates']],
  ['a size that is not known is taken as within the capacity', '? null : size > capacity ? 0 : 1', '? 1 : size > capacity ? 0 : 1', SURVEY_UTILITY_FILE, ['rates']],
  ['the own size of a formation is not cut to a whole number', 'Math.trunc(row.Size)', 'row.Size', SURVEY_UTILITY_FILE, ['rates']],
  ['the formations beneath a formation add nothing to its size', 'const total = (children.get(id) || []).reduce(', 'const total = [].reduce(', SURVEY_UTILITY_FILE, ['rates']],
  ['the commanders above a formation give nothing', 'const above = superiors(row, new Set([row.FormationID]))', 'const above = 1', SURVEY_UTILITY_FILE, ['rates']],
  ['a superior gives its whole bonus, not its share', '(1 + (bonus - 1) * SUPERIOR_SHARE * share) * above', '(1 + (bonus - 1) * share) * above', SURVEY_UTILITY_FILE, ['rates']],
  ['a superior over its capacity still gives its share', '(1 + (bonus - 1) * SUPERIOR_SHARE * share) * above', '(1 + (bonus - 1) * SUPERIOR_SHARE) * above', SURVEY_UTILITY_FILE, ['rates']],
  ['a superior at another colony gives its share', '|| parent.PopulationID !== row.PopulationID ', '', SURVEY_UTILITY_FILE, ['rates']],
  ['a rating that is not known is taken as a rating of nothing', ' || formations.some((formation) => !Number.isFinite(formation.base))', '', SURVEY_UTILITY_FILE, ['rates']],
  ['a descendant whose class has no headquarters capacity leaves its size unknown', 'row.Elements > row.Known || !Number.isFinite(row.Size)', 'row.Elements > row.Known || row.Elements > row.Capable || !Number.isFinite(row.Size)', SURVEY_UTILITY_FILE, ['rates']],
  ['a body with no colony is of unknown rate', 'teams.get(row.PopulationID) || NO_TEAM : null) : NO_TEAM', 'teams.get(row.PopulationID) || NO_TEAM : null) : null', SURVEY_FILE, ['save-1-rates']],
  ['the unstaffed switch does nothing', "(!this.deployUnstaffed || row.status !== 'worked')", 'true', SURVEY_FILE, ['target-rows']],
  ['the Candidates column sorts by a value the rows do not carry', "{ text: 'Candidates', value: 'candidateSort' }", "{ text: 'Candidates', value: 'candidateCount' }", SURVEY_FILE, ['headers']],
  ['a table view is shared by every race', "{ ...tableView('surveyDeployTable', { sortBy: ['stateOrder'], sortDesc: false, itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }), scope: 'race' }", "tableView('surveyDeployTable', { sortBy: ['stateOrder'], sortDesc: false, itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES })", SURVEY_FILE, ['views']],
  ['an unread ruin read leaves every formation idle', '{ targets: [], states: null, unseen: null }', '{ targets: [], states: null, unseen: new Set() }', SURVEY_FILE, ['unknown-sites']],
  ['the page forgets to wait for the constructs', "  constructSites: 'the ancient constructs',\n", '', SURVEY_FILE, ['ready']],
  ['the page does not hand the constructs to the rows', 'unseen: ruins.unseen, constructs }', 'unseen: ruins.unseen }', SURVEY_FILE, ['states', 'construct-sites']],
  ['unread constructs are taken for none', 'constructBodies(this.constructSites.rows) : null', 'constructBodies(this.constructSites.rows) : { inactive: new Map(), unknown: new Set() }', SURVEY_FILE, ['construct-sites']],
  ['an inactive construct is no work for a formation', 'index.constructs ? index.constructs.inactive.get(bodyId) : undefined', 'index.constructs ? undefined : undefined', SPEC_FILE, ['states', 'construct-sites']],
  ['an active construct is work too', 'if (state === 0) {', 'if (state === 0 || state === 1) {', SPEC_FILE, ['states', 'construct-sites']],
  ['a construct with no stored state counts as inactive', 'row.Active === null || row.Active === undefined ? null : Number(row.Active)', 'row.Active === undefined ? null : Number(row.Active)', SPEC_FILE, ['states', 'construct-sites']],
  ['a construct with no stored state leaves the formation idle', '} else if (state !== 1) {', '} else if (false) {', SPEC_FILE, ['states', 'construct-sites']],
  ['constructs that were not read leave every formation idle', "reasons.push({ kind: 'constructs-unread', message:", "({ kind: 'constructs-unread', message:", SPEC_FILE, ['construct-sites']],
  ['a construct with no stored state is not marked', "reasons.push({ kind: 'construct-unknown', message:", "({ kind: 'construct-unknown', message:", SPEC_FILE, ['states', 'state-details', 'construct-sites']],
  ['a formation of unknown rating at an inactive construct is not marked', ' || (roles.xeno === null && index.constructs && index.constructs.inactive.has(bodyId))', '', SPEC_FILE, ['construct-sites']],
  ['a construct on a body with a ruin worked is counted as a second work', "if (construct && !work.some((item) => item.role === 'xeno')) {", 'if (construct) {', SPEC_FILE, ['construct-sites']],
  ['the constructs of bodies with no colony of the race are read', 'from FCT_AncientConstruct inner join FCT_Population on', 'from FCT_AncientConstruct left join FCT_Population on', SPEC_FILE, ['targets-eligible', 'construct-sites', 'save-1-constructs']],
  ['the deployments panel has no summary', 'data-summary="Review geological survey and xenoarchaeology formations', 'data-hint="Review geological survey and xenoarchaeology formations', SURVEY_FILE, ['browser-panels'], true],
  ['the roles filter is disconnected from its chips', 'v-model="deployRoles"', ':value="deployRoles"', SURVEY_FILE, ['browser-roles', 'browser-restored'], true],
  ['the states filter is disconnected from its chips', 'v-model="deployStates"', ':value="deployStates"', SURVEY_FILE, ['browser-states', 'browser-restored'], true],
  ['the switch of the targets is disconnected', 'v-model="deployUnstaffed"', ':input-value="deployUnstaffed"', SURVEY_FILE, ['browser-unstaffed', 'browser-restored'], true],
  ['the deployments are listed for every row whatever the filters', 'selectDeployments(this.deployment.rows, { roles: this.deployRoles, states: this.deployStates })', 'this.deployment.rows', SURVEY_FILE, ['select']],
  ['the name of each formation is hidden', '<div class="font-weight-medium" data-deploy-name>', '<div v-show="false" class="font-weight-medium" data-deploy-name>', SURVEY_FILE, ['browser-rows'], true],
  ['the table of the deployments is hidden by itself', '<v-data-table :headers="deployHeaders"', '<v-data-table v-show="false" :headers="deployHeaders"', SURVEY_FILE, ['browser-rows'], true],
  ['the state cell is put in a slot the table does not use', '<template #[`item.stateOrder`]="{ item }">', '<template #[`item.state`]="{ item }">', SURVEY_FILE, ['browser-rows'], true],
  // A crash is how this fault is caught: browser-clean holds that an error Vue catches in a handler is seen, so the fault declares the throw (the shared rule judges an error the page raised as behaviour, so the credit reads as a value all the same).
  ['a native listener that throws on each role chip, which Vue catches and logs', ':data-count="deployTotals[choice.value]" filter', ':data-count="deployTotals[choice.value]" @click.native="(void 0).missing" filter', SURVEY_FILE, ['browser-clean'], true, { throws: true }],
  ['the figure of each role chip is drawn one higher, its count hook left as it is', '{{ choice.text }} ({{ count(deployTotals[choice.value]) }})', '{{ choice.text }} ({{ count(deployTotals[choice.value] + 1) }})', SURVEY_FILE, ['browser-roles', 'browser-restored'], true],
  ['the label of each state draws the words of the first state, its state hook left as it is', '{{ item.stateLabel }}', '{{ stateChoices[0].text }}', SURVEY_FILE, ['browser-rows'], true],
  ['the label of each state is drawn at opacity 0', '<span class="text-no-wrap" data-deploy-state-label>', '<span class="text-no-wrap" style="opacity: 0" data-deploy-state-label>', SURVEY_FILE, ['browser-rows'], true],
]

// Rewrites that change nothing the checks observe: each must leave every check passing. The rewrites of the page the browser draws are served as one (a family each, the chip group registered under its PascalCase name first, since the later ones are made inside it).
const BENIGN = [
  ['the equivalent forms of the page, each family once', [
    '<v-chip-group v-model="deployRoles" multiple column aria-label="Roles shown" data-deploy="roles">',
    '</v-chip-group>\n            <v-chip-group v-model="deployStates"',
    'v-model="deployRoles"',
    '<span>Specialist deployments</span>',
    ':data-count="deployTotals[choice.value]" filter',
    '{{ choice.text }} ({{ count(deployTotals[choice.value]) }})',
    '{{ item.stateLabel }}',
    '<span class="text-no-wrap" data-deploy-state-label>',
  ], [
    '<VChipGroup v-model="deployRoles" multiple column aria-label="Roles shown" data-deploy="roles">',
    '</VChipGroup>\n            <v-chip-group v-model="deployStates"',
    ':value="deployRoles" @change="deployRoles = $event"',
    '<span>Specialist placements</span>',
    ':data-count="deployTotals[choice.value]" @click.native="void 0" filter',
    '{{ choice.text }} ({{ count(deployTotals[choice.value], 0) }})',
    '{{ stateChoices.find((choice) => choice.value === item.state).text }}',
    '<span class="text-no-wrap" style="opacity: 1" data-deploy-state-label>',
  ], SURVEY_FILE, [], true],
  ['v-on longhand for a click', 'no-data-text="No formation matches the roles and states chosen" @click:row="toggleRow"', 'no-data-text="No formation matches the roles and states chosen" v-on:click:row="toggleRow"', SURVEY_FILE],
  ['a qualifier moved from the front to the back in a sentence', 'No troop bay holds it (the largest takes ${count(lift.largest)} t)', 'Held by no troop bay (the largest takes ${count(lift.largest)} t)', SPEC_FILE],
  ['a synonym in generated prose', "'Location not resolved'", "'Place not resolved'", SPEC_FILE],
  ['a parenthesised condition', 'if (roles.geo !== true && roles.xeno !== true) {', 'if ((roles.geo !== true) && (roles.xeno !== true)) {', SPEC_FILE],
  ['the multiplier of a formation squared with a power', 'total + base * multiplier * multiplier', 'total + base * (multiplier ** 2)', SURVEY_UTILITY_FILE],
  ['the share of the capacity written as a comparison with the capacity first', 'size > capacity ? 0 : 1', 'capacity >= size ? 1 : 0', SURVEY_UTILITY_FILE],
  ['the own size cut with floor, as the size is never negative', 'Math.trunc(row.Size)', 'Math.floor(row.Size)', SURVEY_UTILITY_FILE],
  ['a superior of another colony told apart with a parenthesised condition', '!(parent.PopulationID > 0) || parent.PopulationID !== row.PopulationID || !parent.HasCommander', '(!(parent.PopulationID > 0)) || (parent.PopulationID !== row.PopulationID) || (!parent.HasCommander)', SURVEY_UTILITY_FILE],
]

/* eslint-enable no-template-curly-in-string */

// What main opened and has to close before the process ends: the browser, the page server (and its copy of the save). Every one is attempted, whichever fails before it; a failure is kept and ends the process with a status of its own, never 0, unless the process already ends with a status of its own: that one is kept, and the failure of the cleanup is told beside it.
const cleanups = []
const CLEANUP_STATUS = 4
const CLEANUP_RAN = 'the cleanup that comes second ran'
const CLEANUP_PLANTED = 'a cleanup planted to fail'

// Runs every cleanup, whichever fails before it, each failure told on stderr: how many failed.
const runCleanups = async () => {
  let failed = 0

  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failed++
      console.error(`cleanup failed: ${error && error.message ? error.message : error}`)
    }
  }

  return failed
}

const finish = async (code) => {
  const failed = await runCleanups()

  if (failed && code) {
    console.error(`the status ${code} is kept, and ${failed} cleanup${failed === 1 ? '' : 's'} also failed`)
  }

  process.exit(code || (failed ? CLEANUP_STATUS : 0))
}

// Two cleanups for the controls of `finish`: the one that comes first fails or does not, the one after it says that it ran.
const plantCleanups = (failing) => {
  cleanups.push(async () => { console.log(CLEANUP_RAN) })
  cleanups.push(async () => {
    if (failing) {
      throw new Error(CLEANUP_PLANTED)
    }
  })
}

// A copy of the browser's save with the formation moved and the statements of one case run on it (`UNREAD`; none for the copy of the formation moved only).
const unreadCopy = async (name) => {
  const entry = UNREAD.find((item) => item.kind === name)
  const fixture = FIXTURES[BROWSER_SAVE]
  const copy = path.join(os.tmpdir(), `ae-unread-${process.pid}-${name}.db`)

  cleanups.push(async () => fs.rmSync(copy, { force: true, maxRetries: 10, retryDelay: 200 }))
  fs.copyFileSync(path.resolve(root, fixture.file), copy)

  const database = new sqlite3.Database(copy)

  for (const statement of [movedStatement(fixture), ...(entry ? entry.statements : [])]) {
    await new Promise((resolve, reject) => database.run(statement, (error) => (error ? reject(error) : resolve())))
  }

  await new Promise((resolve) => database.close(resolve))

  return copy
}

// A flag of the child, `--name=value`, or null.
const flagOf = (name) => {
  const given = process.argv.find((argument) => argument.startsWith(`--${name}=`))

  return given ? given.slice(name.length + 3) : null
}

// The page on the copy `file` of one case (`UNREAD`), read on the worker's own page server and browser: the page as the registry has it (`real`) and with that input made required (`fault`), each the whole record of an observation. The server is put back as it started afterwards (`reset`), the file of the registry and the copy of the save included. `control`, for the controls of the harness only: `page-failure` serves a renderer module that throws for the first start of the case only, the count of the starts being kept in `trial` outside the case so that a second start of the same case (a retry that hides the first failure) serves the healthy page and the control sees it; `fault-half:throw` serves one that raises an uncaught error for the second half after the page has been read as the registry has it.
const readUnread = async (server, chrome, entry, file, { control = '', trial = { starts: 0 }, timeout = BROWSER_TIMEOUT } = {}) => {
  const plant = (code) => server.replace(EMPIRE_LIST_FILE, patched(EMPIRE_LIST_FILE, fs.readFileSync(EMPIRE_LIST_FILE, 'utf8'), '<script>', `<script>\n${code}`))

  try {
    await server.useSave(file)

    if (control === 'page-failure') {
      trial.starts += 1

      if (trial.starts === 1) {
        plant("throw new Error('a failure planted for the first start only')")
      }
    }

    const real = await observePage(chrome, server.url, { unread: true, timeout })

    server.replace(EMPIRE_LIST_FILE, null)
    server.replace(CAPABILITIES_FILE, patched(CAPABILITIES_FILE, fs.readFileSync(CAPABILITIES_FILE, 'utf8'), entry.from, entry.to))

    if (control.startsWith('fault-half:')) {
      plant(`setTimeout(() => { ${control === 'fault-half:throw' ? "throw new Error('a failure planted for the second half only')" : 'void 0'} }, 0)`)
    }

    const fault = await observePage(chrome, server.url, { unread: true, withheld: true, timeout })

    return { real, fault }
  } finally {
    try {
      server.replace(EMPIRE_LIST_FILE, null)
      server.replace(CAPABILITIES_FILE, null)
    } finally {
      await server.reset()
    }
  }
}

// What a worker sets up once before its first variant (`setUp`, run by the runner): the utility and the page as they are, the saves and what no planted fault reaches in them, the small database, the copies of the browser's save for the optional reads, the page in a browser (one page server over a copy of the browser's save, warmed, one Chromium, a new context for each variant of the page), and what every variant is judged against, read once for the page as it is (`baseline`): the page, the cases of the optional reads and the screen expected. A fault in the template is served to the browser in place of the page's file. The setup reads the baseline before the first variant, whichever variant that is (a fresh worker's, a resumed run's, one `--variants` names), so that no variant waits for the cases, each a child under a watchdog of minutes, within a deadline set for its own work.
let ENV = null

const setUp = async () => {
  // `--records=<file>`: the records another run of this script made of the page as it is ({ seen, unread }), judged here in place of observing the page again. The control of `--only` hands its child the records of its own run: which variants a run selects has no browser surface, so that child starts no page server and no browser, and a variant it would serve to the browser gets an observation that did not happen.
  const recordsFile = flagOf('records')
  const records = recordsFile ? JSON.parse(fs.readFileSync(recordsFile, 'utf8')) : null

  const sources = { spec: fs.readFileSync(SPEC_FILE, 'utf8'), survey: fs.readFileSync(SURVEY_FILE, 'utf8'), utility: fs.readFileSync(SURVEY_UTILITY_FILE, 'utf8') }
  const texts = new Map()

  // The page, loaded with the utility text it is given: a fault planted in the utility reaches it through its import.
  const pagesOf = async (given) => {
    const survey = await loadPage('pages/survey-progress', { sources: { [SPEC_RELATIVE]: given.spec, [SURVEY_RELATIVE]: given.utility, 'pages/survey-progress': given.survey }, stubs: STUBS, modules: { 'mixins/load-state': null, 'mixins/persisted-view': VIEW_MODULE }, texts })

    return { pages: { survey }, fields: survey.mixins.find((mixin) => mixin.fields).fields }
  }
  const utilitiesOf = async (given) => {
    const loaded = await loadUtilities(['specialist-deployments', 'ground-formations', 'survey'], { stubs: STUBS, sources: { 'specialist-deployments': given.spec, survey: given.utility } })

    return { mod: loaded['specialist-deployments'], ground: loaded['ground-formations'], survey: loaded.survey }
  }

  const base = await utilitiesOf(sources)
  // The module's own tables of words, from its source as it is: a fault that changes a word in the module is then read back as another word.
  const labels = labelsOf(base.mod)
  const models = { constructed: base.ground.buildGroundFormations(frozen(constructedRows()), { GameID: GAME, RaceID: RACE }) }

  models.supportedConstructed = { supported: true, ...models.constructed }

  const databases = []

  for (const fixture of FIXTURES) {
    databases.push(await openSave(fixture.file))
  }

  const schemaSource = databases.find(Boolean)
  const memoryDb = schemaSource ? await memoryDatabase(schemaSource, MEMORY) : null

  cleanups.push(() => Promise.all([memoryDb, ...databases].filter(Boolean).map((database) => database.close())))

  // What the saves give that no planted fault reaches: the formation model, the systems, the commanders, the troop bays and the oracle.
  const saveBase = []

  for (const [index, fixture] of FIXTURES.entries()) {
    const database = databases[index]

    if (!database) {
      saveBase.push(null)
      continue
    }

    const { pages } = await pagesOf(sources)
    const probe = instantiate(pages.survey, { boundary, $store: { getters: {}, state: {} }, database, GameID: fixture.GameID, RaceID: fixture.RaceID, data: { loadErrors: {} } })

    for (const key of ['formations', 'systems', 'groundCommanders', 'troopBays']) {
      await probe.runAsync(key)
    }

    saveBase.push({ formations: probe.formations, systems: probe.systems, groundCommanders: probe.groundCommanders, troopBays: probe.troopBays, truth: await oracle(database, fixture.GameID, fixture.RaceID) })
  }

  let server = null
  let chrome = null
  let startFailure = null

  if (records) {
    startFailure = 'a run given the records of another run starts no browser'
  } else {
    try {
      server = await startPageServer({ save: FIXTURES[BROWSER_SAVE].file })
      cleanups.push(() => server.stop())
      chrome = await require('playwright').chromium.launch()
      cleanups.push(() => chrome.close())

      const warmed = await server.warm(chrome, { routes: ['/survey-progress'] })

      console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
    } catch (error) {
      startFailure = String(error.message).split('\n')[0]
    }
  }

  const observeVariant = async (text, { until = null } = {}) => {
    if (startFailure) {
      return failedObservation(startFailure)
    }

    server.replace(SURVEY_FILE, text === sources.survey ? null : text)

    try {
      const seen = await observePage(chrome, server.url, { until })

      report(text === sources.survey ? 'the page' : 'a variant of the page', seen)

      return seen
    } finally {
      server.replace(SURVEY_FILE, null)
    }
  }

  const env = { sources, server, observeVariant, baselineSeen: null, baselineUnread: {} }

  // The context of one variant of the sources: the page and the utility as given, the small database and the saves read through them, and what the browser showed (`seen`).
  const reads = new Map()
  let expected = () => {
    throw new Error('the expected screen is not worked out')
  }
  const unreadFiles = {}
  const unreadDatabases = {}
  const contextOf = async (given, seen = env.baselineSeen, unreadSeen = env.baselineUnread) => {
    const { pages, fields } = await pagesOf(given)
    const utilities = await utilitiesOf(given)
    const mod = subjectModule(utilities.mod)
    const ctx = { mod, survey: subjectModule(utilities.survey), pages, fields: subjectFields(fields), models, browser: seen, expected, labels, memory: null, saves: [], unreadSeen, unreadRows: null }

    // A read is kept for the text that makes it (the page for the ground surveys, the utility for the ruins), so a variant that changes neither does not read the saves again.
    const read = async (kind, text, label, database, ids) => {
      const key = `${kind}:${label}`

      if (!reads.has(key)) {
        reads.set(key, new Map())
      }

      if (!reads.get(key).has(text)) {
        const probe = instantiate(pages.survey, { boundary, $store: { getters: {}, state: {} }, database, GameID: ids.GameID, RaceID: ids.RaceID, data: { loadErrors: {} } })

        reads.get(key).set(text, await probe.runAsync(kind))
      }

      return reads.get(key).get(text)
    }

    ctx.memory = { groundSurveys: await read('groundSurveys', given.survey, 'memory', memoryDb, { GameID: GAME, RaceID: RACE }), ruinSites: await read('ruinSites', given.spec, 'memory', memoryDb, { GameID: GAME, RaceID: RACE }), constructSites: await read('constructSites', given.spec, 'memory', memoryDb, { GameID: GAME, RaceID: RACE }) }

    for (const [index, fixture] of FIXTURES.entries()) {
      const held = saveBase[index]

      if (!held) {
        ctx.saves.push(null)
        continue
      }

      const vm = instantiate(pages.survey, { boundary, $store: { getters: {}, state: {} }, database: databases[index], GameID: fixture.GameID, RaceID: fixture.RaceID, data: { loadErrors: {}, game: { SurveySpeed: 100 }, formations: held.formations, systems: held.systems, groundCommanders: held.groundCommanders, troopBays: held.troopBays } })

      vm.groundSurveys = await read('groundSurveys', given.survey, String(index), databases[index], fixture)
      vm.ruinSites = await read('ruinSites', given.spec, String(index), databases[index], fixture)
      vm.constructSites = await read('constructSites', given.spec, String(index), databases[index], fixture)
      ctx.saves.push({ vm, truth: held.truth, systems: held.systems, troops: held.troopBays.troops, ruinRows: vm.ruinSites.supported ? vm.ruinSites.rows : [], constructRows: vm.constructSites.supported ? vm.constructSites.rows : [] })
    }

    // The rows of the browser's save with the formation moved, as the pseudo instance gives them from each copy read by the page's own loaders: `moved` (nothing taken away) and each case.
    if (ctx.saves[BROWSER_SAVE]) {
      const fixture = FIXTURES[BROWSER_SAVE]
      const rowsOf = async (name) => {
        const database = unreadDatabases[name]
        const label = `unread-${name}`
        const data = { loadErrors: {}, game: { SurveySpeed: 100 } }

        for (const key of ['formations', 'systems', 'groundCommanders', 'troopBays']) {
          data[key] = await read(key, given.survey, label, database, fixture)
        }

        const probe = instantiate(pages.survey, { boundary, $store: { getters: {}, state: {} }, database, GameID: fixture.GameID, RaceID: fixture.RaceID, data })

        probe.groundSurveys = await read('groundSurveys', given.survey, label, database, fixture)
        probe.ruinSites = await read('ruinSites', given.spec, label, database, fixture)
        probe.constructSites = await read('constructSites', given.spec, label, database, fixture)

        return listedRows(mod.selectDeployments(probe.deployment.rows, { roles: ALL_ROLES, states: ALL_STATES }))
      }

      ctx.unreadRows = {}

      for (const name of Object.keys(unreadDatabases)) {
        // A fault planted in the utility may fail on these copies: the failure is kept for the check that reads the rows, so that it fails there and the run goes on. What it is stays what it was: a marked failure of a call of the code under test, or anything else, which stops the run there.
        ctx.unreadRows[name] = await rowsOf(name).catch((error) => error)
      }
    }

    return ctx
  }

  // The copies of the browser's save for the optional reads, and each case on the worker's own page server (`readUnread`): {real, fault}, the whole record of each observation (scripts/lib/browser-observe.js). A case is never run twice: a browser that did not get through, or that saw the page raise an error, is a failed case, with what it reported (`report`).
  for (const name of ['moved', ...UNREAD.map((entry) => entry.kind)]) {
    unreadFiles[name] = await unreadCopy(name)
    unreadDatabases[name] = await openSave(unreadFiles[name])
  }

  cleanups.push(() => Promise.all(Object.values(unreadDatabases).filter(Boolean).map((database) => database.close())))

  const unreadCase = async (entry, { control = '', quiet = false, trial = { starts: 0 } } = {}) => {
    let seen

    if (records && !control) {
      seen = records.unread[entry.kind]
    } else if (startFailure) {
      seen = { real: failedObservation(startFailure), fault: failedObservation(startFailure) }
    } else {
      try {
        sayStep(`the case ${entry.kind} of the optional reads${control ? ` (${control})` : ''}`)
        seen = await readUnread(server, chrome, entry, unreadFiles[entry.kind], { control, trial, timeout: control === 'page-failure' ? 10000 : BROWSER_TIMEOUT })
      } catch (error) {
        const message = String(error.message).slice(0, 4000)

        seen = { real: failedObservation(message, 'the case'), fault: failedObservation(message, 'the case') }
      }
    }

    // A record that is not whole is a defect of the harness and stops the run.
    const halves = halvesOf(seen, entry.kind)

    if (!quiet) {
      for (const [half, observation] of halves) {
        if (observation.error !== null && !(half === 'fault' && seen.fault.error === seen.real.error)) {
          report(`case ${entry.kind} (${half})`, observation)
        }
      }
    }

    return seen
  }

  // What every variant is judged against, worked out from the page as it is: the page, the cases of the optional reads and the screen expected. The setup reads it before the first variant; the head reads the page again on the worker's server each time it runs, so that the head run after a fault (the control of the warm page server) reads the page anew. The cases of the optional reads are each read on the worker's server too, one after another, and are kept.
  env.baseline = async () => {
    env.baselineSeen = records ? records.seen : await observeVariant(sources.survey)

    for (const entry of UNREAD.filter((item) => !env.baselineUnread[item.kind])) {
      env.baselineUnread[entry.kind] = await unreadCase(entry)
    }

    const baselineContext = await contextOf(sources)

    if (baselineContext.saves[BROWSER_SAVE]) {
      expected = expectedScreen(baselineContext)
      baselineContext.expected = expected
    }

    env.baselineContext = baselineContext

    return baselineContext
  }

  const unreadChecks = results.filter((item) => item.id === 'browser-unread')

  env.databases = databases
  env.contextOf = contextOf
  env.unreadCase = unreadCase
  // The outcome of browser-unread for the records given: the one result, or a HarnessError when a record is not whole.
  env.outcome = async (given) => (await runChecks(unreadChecks, await contextOf(sources, env.baselineSeen, given)))[0]
  // The records with the cases of one input changed, the others as they are.
  env.adapted = (input, change) => Object.fromEntries(UNREAD.map((entry) => [entry.kind, entry.input === input ? change(env.baselineUnread[entry.kind]) : env.baselineUnread[entry.kind]]))
  env.withCase = (kind, seen) => ({ ...env.baselineUnread, [kind]: seen })
  // The sources with the changes of a fault or a rewrite ([name, from, to, file, ...]; `from` and `to` are lists for the rewrites served as one, applied in turn); a fault is planted through `plantedPatch`, a rewrite of a head check's own through `patched`.
  env.variantOf = ([, from, to, file], patch = patched) => {
    const given = { ...sources }
    const key = file === SPEC_FILE ? 'spec' : file === SURVEY_UTILITY_FILE ? 'utility' : 'survey'

    for (const [index, one] of [].concat(from).entries()) {
      given[key] = patch(file, given[key], one, [].concat(to)[index])
    }

    return given
  }

  await env.baseline()

  return env
}

// The checks of the head: one for each check of the list, and the two of the saves.
const HEAD_CHECKS = results.length + 2

const checkHead = async () => {
  console.log('Constructed race, preferences, page, saves and browser')

  const baseline = await runChecks(results, await ENV.baseline())

  baseline.forEach((result) => check(result.name, result.ok, result.detail))

  const missing = FIXTURES.map((fixture, index) => (ENV.databases[index] ? null : fixture.file)).filter(Boolean)

  check('every named save is there', missing.length === 0, missing.join(', '))
  check('every save check ran', baseline.filter((result) => result.id.startsWith('save-')).length === FIXTURES.length * 8)
}

// The context of a variant. A rewrite of the template of the page changes nothing the page's script, the utility or the saves give, so a variant served to the browser takes the context of the page as it is with what the browser drew of the variant, and does not read the saves again. `until: 'initial'` ends the drive of the page after its first screen, for a fault that only checks reading that screen name.
const variantContext = async (given, browser, until = null) => (browser ? { ...ENV.baselineContext, browser: await ENV.observeVariant(given.survey, { until }) } : ENV.contextOf(given, ENV.baselineSeen))

const FIRST_SCREEN_CHECKS = ['browser-panels', 'browser-rows']

const checkPlanted = async ([name, from, to, file, caught, browser, { throws = false } = {}]) => {
  const given = ENV.variantOf([name, from, to, file], plantedPatch)
  const named = results.filter((item) => caught.includes(item.id))
  const failed = await judge(await variantContext(given, browser, caught.every((id) => FIRST_SCREEN_CHECKS.includes(id)) ? 'initial' : null), named)
  const credited = failed.filter((result) => result.kind === 'assertion')

  check(`planted: ${name}: caught by ${failed.map((result) => result.id).join(', ') || 'nothing'}; credited by ${credited.map((result) => `${result.id} (${result.threw ? 'throw' : 'value'})`).join(', ') || 'nothing'}`, caughtBy(failed, caught, { name, throws }), `expected an assertion of one of ${caught.join(', ')}; ${failed.filter((result) => caught.includes(result.id)).map((result) => `${result.id} (${result.kind}) ${result.detail.slice(0, 160)}`).join('; ') || 'none of them failed'}`)

  if (detailed) {
    credited.forEach((result) => console.log(`        ${result.id} (${result.threw ? 'throw' : 'value'}): ${result.detail.split('\n')[0].slice(0, 300)}`))
  }
}

// An input of the page that is required makes the save without it unsupported: the page the browser saw for that input is the withheld one, in both halves of the record. What fails must be the capability report of browser-unread, not a record that is not whole.
const requiredName = (input) => `${input} is required by the capability registry`

const checkRequired = async (input) => {
  const planted = await ENV.outcome(ENV.adapted(input, (seen) => ({ real: seen.fault, fault: seen.fault })))

  check(`planted: ${requiredName(input)}: caught by the capability report; credited by browser-unread (${planted.threw ? 'throw' : 'value'})`, caughtBy([planted], ['browser-unread'], { name: requiredName(input) }) && /the capability report/.test(planted.detail), `${planted.kind}: ${planted.detail}`)
}

// The controls of the harness: a case that fails must fail the check, however it fails and whatever a later start would give. Each runs the case's own function (`unreadCase`) and judges browser-unread on what it returns, and each is paired with the case that is as it should be and must pass.
const checkControls = async () => {
  const { sources, contextOf, variantOf, outcome, adapted, withCase, unreadCase, baselineSeen, baselineUnread } = ENV
  const construct = UNREAD.find((item) => item.kind === 'construct-table')
  // The runs of this script in a child (the probes of `finish` and the run on the records of this one), each under the limit given to startChild.
  const childOf = (args, limit) => {
    sayStep(`a run of this script in a child (${args.join(' ')})`)

    return runChild(__filename, args, { limit })
  }

  // Who failed. A failure is credited only when it is an assertion of a check: marked by the helper of the checks, or the failure of a call of the code under test that an adapter (`through`) names, which credits a fault only when the fault declares that a throw is how it is caught (scripts/lib/fault-credit.js `caughtBy`). An error that is anything else, an AssertionError that the code under test threw included, stops the run when a fault is judged.
  const probe = async (body) => (await runChecks([{ id: 'probe', name: 'probe', run: body }], {}))[0]
  // What crediting a fault gives: true or false, or the HarnessError that stops the run.
  const creditOf = (call) => Promise.resolve().then(call).then((credited) => credited, (error) => error)
  const stranger = () => new rawAssert.AssertionError({ message: 'thrown by the code under test' })
  const own = await probe(() => assert.equal(1, 2))
  const ordinary = await probe(() => assert.equal(1, 1))

  check('control: a failed assertion of a check is an assertion and credits the fault it is named for, and an assertion that holds passes', own.kind === 'assertion' && caughtBy([own], ['probe']) && ordinary.ok, JSON.stringify([own, ordinary]))

  const bare = [await probe(() => { throw stranger() }), await probe(async () => { throw stranger() }), await probe(() => { throw new TypeError('crash') })]
  const judgedBare = await judge({}, [{ id: 'probe', name: 'probe', run: async () => { throw stranger() } }]).then(() => null, (error) => error)

  check('control: an AssertionError or any other error that the code under test throws, where no adapter names it, is no assertion of a check, credits nothing and stops the run when a fault is judged', bare.every((result) => result.kind === 'error') && !caughtBy(bare, ['probe']) && judgedBare instanceof HarnessError, JSON.stringify([bare, String(judgedBare)]))

  const named = []

  for (const call of [() => { throw stranger() }, async () => { throw stranger() }, () => { throw new TypeError('crash') }, async () => { throw new TypeError('crash') }]) {
    named.push(await probe(async () => through('the call', call)))
  }

  const returned = await probe(() => assert.deepEqual(through('the call', () => ({ list: [1] })), { list: [1] }))

  check('control: a call of the code under test that throws or rejects, with an AssertionError or any other error, is an assertion that names the call and says that it threw, credits a fault only when the fault declares the throw and otherwise stops the run, and a call that returns gives its result', named.every((result) => result.kind === 'assertion' && result.threw === true && /^the call threw (AssertionError|TypeError)/.test(result.detail)) && (await creditOf(() => caughtBy(named, ['probe'], { name: 'a planted crash' }))) instanceof HarnessError && (await creditOf(() => caughtBy(named, ['probe'], { name: 'a planted crash', throws: true }))) === true && returned.ok, JSON.stringify([named, returned]))

  const trap = () => ({ get x () { throw new Error('a getter') } })
  const reading = []

  for (const call of [() => trap(), () => ({ list: [{ inner: trap() }] }), () => new Map([[1, trap()]]), async () => trap(), async () => [new Set([trap()])]]) {
    reading.push(await probe(async () => through('the call', call)))
  }

  const unharmed = await probe(async () => assert.deepEqual([...(await through('the call', async () => new Map([[1, { x: 1 }]]))).keys()], [1]))

  check('control: a getter that throws in what the code under test returned, nested or in a promise, a map or a set, is the failure of the call, and what has no getter is read as it is', reading.every((result) => result.kind === 'assertion' && /^the call threw Error: a getter/.test(result.detail)) && unharmed.ok, JSON.stringify([reading, unharmed]))

  // A lookup of the harness that is wrong, and a callback of the harness that throws, are the harness's: on a fault that is credited otherwise, they stop the run.
  const busyMutant = MUTANTS.find(([name]) => name === 'a formation is busy wherever it stands')
  const busyContext = await contextOf(variantOf(busyMutant, plantedPatch))
  const lookups = (name) => [{ id: 'states', name: 'states', run: async (ctx) => { await surveyView(ctx).runAsync(name) } }]
  const lookedUp = await judge(busyContext, lookups('absent')).then(() => null, (error) => error)
  const lookedUpRight = await judge(busyContext, lookups('game')).then((failed) => failed.length, (error) => error)

  check('control: a read of the page that is looked up under a name it does not have (a lookup of the harness) stops the run on a fault that states catches, and the same read under its name passes', lookedUp instanceof HarnessError && lookedUpRight === 0, `${lookedUp} ${lookedUpRight}`)

  const callbackChecks = (callback) => [{ id: 'lifts', name: 'lifts', run: (ctx) => assert.equal(ctx.mod.liftText({ kind: 'one', lifts: 2, lift: 1 }, callback), 'Lift 1 of 2') }]
  const thrownBack = await judge(busyContext, callbackChecks(harnessOwn(() => { throw new Error('the callback') }))).then(() => null, (error) => error)
  const handedBack = await judge(busyContext, callbackChecks(harnessOwn((count) => String(count)))).then((failed) => failed.length, (error) => error)

  check('control: a callback of the harness that the utility calls and that throws stops the run, and one that returns gives the words', thrownBack instanceof HarnessError && handedBack === 0, `${thrownBack} ${handedBack}`)

  const storeChecks = (getters) => [{ id: 'ready', name: 'ready', run: (ctx) => assert.equal(instantiate(ctx.pages.survey, { boundary, $store: { getters, state: {} }, data: { loadErrors: {} } }).database, null) }]
  const storeBroken = await judge(busyContext, storeChecks(null)).then(() => null, (error) => error)
  const storeWhole = await judge(busyContext, storeChecks({})).then((failed) => failed.length, (error) => error)

  check('control: a store whose getters are malformed, read by the page, stops the run, and a whole store gives the page its getters', storeBroken instanceof HarnessError && storeWhole === 0, `${storeBroken} ${storeWhole}`)

  // An observation whose context did not close fails the check with an error of its own, in the baseline and under a fault, whether or not a screen was kept and the page raised errors besides; an error the page raised that nothing named is still an assertion, and a closed context passes.
  const closed = completedObservation({ initial: {} })
  const closeFailed = { ...closed, error: 'the context did not close: planted' }
  const closeFailedRaising = { ...closeFailed, errors: ['planted'], unexpected: ['page error: planted'] }
  const raisedOnly = { ...closed, error: 'the page raised 1 unexpected error, the first: page error: planted', errors: ['planted'], unexpected: ['page error: planted'] }
  const seeing = [{ id: 'seen', name: 'seen', run: (ctx) => { observed(ctx) } }]
  const seenAs = (browser) => judge({ browser }, seeing).then((failed) => failed, (error) => error)
  const baselineOf = async (browser) => (await runChecks(seeing, { browser }))[0]

  check('control: a context that did not close fails the check with an error of its own at the baseline, whether or not the page raised errors besides, and a context that closed passes', !(await baselineOf(closeFailed)).ok && (await baselineOf(closeFailed)).kind === 'error' && (await baselineOf(closeFailedRaising)).kind === 'error' && (await baselineOf(closed)).ok, JSON.stringify([await baselineOf(closeFailed), await baselineOf(closeFailedRaising)]))
  check('control: a context that did not close stops the run when a fault is judged, whether or not the page raised errors besides, and a context that closed does not', (await seenAs(closeFailed)) instanceof HarnessError && (await seenAs(closeFailedRaising)) instanceof HarnessError && (await seenAs(closed)).length === 0, `${await seenAs(closeFailed)} ${await seenAs(closeFailedRaising)}`)
  check('control: an error the page raised that nothing named is an assertion that credits a fault', caughtBy(await seenAs(raisedOnly), ['seen']), JSON.stringify(await seenAs(raisedOnly)))

  // A normaliser of a view that throws is a failure of the page's contract, caught by views; one rewritten in an equivalent way, and the code as it is, pass.
  const normaliser = (name, to) => [name, '(stored) => (Array.isArray(stored) ?', to, SPEC_FILE]
  const viewChecks = results.filter((item) => item.id === 'views')
  const throwing = await judge(await contextOf(variantOf(normaliser('a normaliser that throws', "(stored) => (Array.isArray(stored) && (() => { throw new TypeError('planted') })() ?"), plantedPatch)), viewChecks)
  const rewritten = await judge(await contextOf(variantOf(normaliser('a normaliser written the other way round', '(stored) => (!Array.isArray(stored) ? undefined : Array.isArray(stored) ?'))), viewChecks)
  const unchanged = await judge(await contextOf(sources), viewChecks)

  check('control: a normaliser of a view that throws fails views on an assertion that names it without stopping the checks, and credits a fault only when the fault declares the throw, stopping the run otherwise', throwing.length === 1 && throwing[0].kind === 'assertion' && throwing[0].threw === true && /the normalise of the view \w+ threw TypeError/.test(throwing[0].detail) && (await creditOf(() => caughtBy(throwing, ['views'], { name: 'a normaliser that throws' }))) instanceof HarnessError && (await creditOf(() => caughtBy(throwing, ['views'], { name: 'a normaliser that throws', throws: true }))) === true, JSON.stringify(throwing))
  check('control: the normalisers rewritten in an equivalent way, and as they are, leave views passing', rewritten.length === 0 && unchanged.length === 0, JSON.stringify([rewritten, unchanged]))

  // A crash of the harness itself, planted in the context a check is handed, must end the run as a defect on any code under test: healthy, rewritten in a benign way and with a fault. The same context intact is the paired case.
  const selectChecks = results.filter((item) => item.id === 'select')

  for (const [what, entry, faulty] of [['the code as it is', null, false], ['a benign rewrite', BENIGN.find(([name]) => name === 'a parenthesised condition'), false], ['a fault', MUTANTS.find(([name]) => name === 'the state filter is ignored'), true]]) {
    const ctx = await contextOf(entry ? variantOf(entry, faulty ? plantedPatch : patched) : sources)
    const intact = await judge(ctx, selectChecks)

    check(`control: ${what}, with nothing planted in the harness, ${faulty ? 'fails the check of the fault on an assertion' : 'passes the check'}`, faulty ? intact.length === 1 && intact[0].kind === 'assertion' : intact.length === 0, JSON.stringify(intact))

    ctx.memory = undefined

    const stopped = await judge(ctx, selectChecks).then(() => null, (error) => error)

    check(`control: a crash of the harness itself, in the context of ${what}, stops the run as a defect of the harness and credits no fault`, stopped instanceof HarnessError, String(stopped))
  }

  // A fault that makes a computed value of the page throw: every check that reads it fails on an assertion that names the value, and the checks named for the fault are among them.
  const busy = await judge(busyContext)
  const crash = busy.find((result) => result.id === 'rows-once')

  check('control: a fault that makes a computed value of the page throw fails the checks that read it on an assertion naming the value, and does not stop the run', Boolean(crash) && crash.kind === 'assertion' && /the computed value \w+ threw TypeError/.test(crash.detail) && !busy.some((result) => result.kind === 'error'), JSON.stringify(busy.map((result) => [result.id, result.kind, result.detail.slice(0, 80)])))
  check('control: the same fault is caught by the checks named for it', caughtBy(busy, ['states', 'state-details']), JSON.stringify(busy.map((result) => [result.id, result.kind])))

  for (const input of UNREAD_INPUTS) {
    const neutral = await outcome(adapted(input, (seen) => ({ real: seen.real, fault: seen.fault })))

    check(`control: the substitution of the records of ${input} that keeps both halves leaves browser-unread passing`, neutral.ok, `${neutral.kind}: ${neutral.detail}`)
  }

  const trial = { starts: 0 }
  const once = await unreadCase(construct, { control: 'page-failure', quiet: true, trial })
  const onceOutcome = await outcome(withCase(construct.kind, once))

  check('control: a page failure in the half read as the registry has it, planted for the first start only, leaves browser-unread failed, the case is attempted once and not again, and the server is as it started for the next case', trial.starts === 1 && !onceOutcome.ok && /did not get through construct-table real at picking the game/.test(onceOutcome.detail), `${trial.starts} starts: ${onceOutcome.detail}`)
  check('control: the failed observation of that first start keeps its phase, the whole message and what the page and the browser reported', Boolean(once.real.error) && once.real.phase === 'picking the game' && once.real.errors.length + once.real.console.length + once.real.failed.length > 0, JSON.stringify(once.real).slice(0, 600))

  for (const failing of [true, false]) {
    const result = await childOf(['--finish-probe', failing ? 'reject' : 'resolve'], QUICK_LIMIT)
    const ranAfter = result.stdout.includes(CLEANUP_RAN)

    check(`control: the process of the check ends ${failing ? `with status ${CLEANUP_STATUS} when a cleanup fails, and still runs the cleanup after it` : 'with status 0 when every cleanup resolves'}`, failing ? result.code === CLEANUP_STATUS && ranAfter && result.stderr.includes(CLEANUP_PLANTED) : result.code === 0 && ranAfter && result.stderr.trim() === '', `${result.code} ${result.stderr.trim().slice(-300)}`)
  }

  const kept = await childOf(['--finish-probe', 'reject-after:7'], QUICK_LIMIT)
  const plain = await childOf(['--finish-probe', 'resolve-after:7'], QUICK_LIMIT)

  check('control: a process that ends with a status of its own keeps it when a cleanup fails too, runs the cleanup after it and says that the cleanup also failed', kept.code === 7 && kept.stdout.includes(CLEANUP_RAN) && kept.stderr.includes(CLEANUP_PLANTED) && kept.stderr.includes('also failed'), `${kept.code} ${kept.stderr.trim().slice(-300)}`)
  check('control: the same status with every cleanup resolved is kept, and nothing is said of a cleanup', plain.code === 7 && plain.stdout.includes(CLEANUP_RAN) && !plain.stderr.includes('also failed'), `${plain.code} ${plain.stderr.trim().slice(-300)}`)

  const raising = await unreadCase(construct, { control: 'fault-half:throw', quiet: true })
  const raisingOutcome = await outcome(withCase(construct.kind, raising))

  check('control: an uncaught error raised only in the half read with the input required fails browser-unread, and the error is kept', raising.real.error === null && raising.fault.errors.some((text) => text.includes('second half')) && !raisingOutcome.ok && /construct-table fault/.test(raisingOutcome.detail), `${raising.real.error} ${raising.fault.errors} ${raisingOutcome.detail}`)

  const whole = baselineUnread[construct.kind]
  const complete = await outcome(withCase(construct.kind, { real: whole.real, fault: whole.fault }))

  check('control: a record with both observations whole passes browser-unread', complete.ok, `${complete.kind}: ${complete.detail}`)

  for (const [what, record] of [['a record without the half read with the input required', { real: whole.real }], ['an observation whose lists are missing', { real: { ...whole.real, console: undefined }, fault: whole.fault }], ['an observation that is not a record', { real: 'seen', fault: whole.fault }], ['an observation that went through and holds no value', { real: { ...whole.real, value: null }, fault: whole.fault }], ['no record at all', undefined]]) {
    const stopped = await outcome(withCase(construct.kind, record)).then(() => null, (error) => error)

    check(`control: ${what} stops the run as a defect of the harness, and is never a fault that was caught`, stopped instanceof HarnessError, String(stopped))
  }

  // The names a run is told to select are the ones it runs, the required-input faults included: a child of its own (a run of scripts/lib/suite-runner.js, its record removed after it) runs the head, judging the records of the page this run made (`--records`), and the fault of one input, and passes.
  const recordsOut = path.join(os.tmpdir(), `ae-specialist-records-${process.pid}.json`)

  cleanups.push(async () => fs.rmSync(recordsOut, { force: true }))
  fs.writeFileSync(recordsOut, JSON.stringify({ seen: baselineSeen, unread: baselineUnread }))

  const selected = await childOf(['--only=constructSites', `--records=${recordsOut}`], NESTED_LIMIT)
  const childRecord = /^The record of this run: (.+?) \(--resume/m.exec(selected.stdout)
  const total = HEAD_CHECKS + 1

  if (childRecord) {
    fs.rmSync(path.resolve(root, childRecord[1]), { force: true })
  }

  check('control: a run told to select the fault of one input runs that one among the others and no other, and ends with every check passed', selected.code === 0 && selected.stdout.includes(`PASS  planted: ${requiredName('constructSites')}`) && !/planted: (ruinSites|troopBays)/.test(selected.stdout) && selected.stdout.includes(`${total} of ${total} checks passed`), `${selected.code} ${selected.stdout.trim().slice(-400)} ${selected.stderr.trim().slice(-300)}`)

  const navigations = [await observePage(pretendBrowser(), 'http://pretend.test/'), await observePage(pretendBrowser(), 'http://pretend.test/', { unread: true })]

  check('control: an observation whose navigation does not end, read whole or read once after the capability report, names the step of that navigation (a step is said before the call it names), so the deadline of the runner names it too', navigations.every((seen) => seen.error === NAVIGATION_FAILED && seen.phase === 'opening /survey-progress'), JSON.stringify(navigations.map((seen) => ({ error: seen.error, phase: seen.phase }))))
}

const checkBenign = async ([name, from, to, file, , browser]) => {
  const given = ENV.variantOf([name, from, to, file])
  const failed = (await judge(await variantContext(given, browser))).map((result) => result.id)

  check(`benign: ${name}: no check fails`, failed.length === 0, failed.join(', '))
}

// The deadlines, in seconds. A variant's own work: five times the slowest time measured (the head 13 s, a variant served to the browser 18 s, one in memory 2 s), at least two minutes, and for what the browser reads at least a minute past its longest step (BROWSER_TIMEOUT, 120 s for a click or a wait of the page), so that a step that does not end is named by its own timeout first. The controls of the harness start children one after another, the four probes of `finish` under QUICK_LIMIT and the run of this script on the head's records under NESTED_LIMIT (CONTROL_BOUNDS), and read four cases of the optional reads on the worker's server, each within the 180 s of a variant of the browser; their deadline is the sum of those bounds and the time measured (81 s). The setup opens the saves, makes the copies of the browser's save and starts and warms the page server, the one cold start of the run (900 s), and reads what every variant is judged against (`baseline`): the page and the cases of the optional reads, each within the 180 s of a variant of the browser; a run given the records of another (`--records`) reads neither. Between two variants and in its close a worker has the runner's 900 s.
const CONTROL_BOUNDS = 4 * QUICK_LIMIT + NESTED_LIMIT
const DEADLINES = { head: 180, browser: 180, memory: 120, controls: CONTROL_BOUNDS / 1000 + 4 * 180 + 81, setup: 900 + (flagOf('records') ? 0 : (1 + UNREAD.length) * 180) }
// The planted fault the control runs before the head: one the head's reading of the page catches.
const CONTROL_FAULT = 'the figure of each role chip is drawn one higher, its count hook left as it is'

const variantsOf = () => [
  { key: 'head', name: 'the head: the constructed race, the preferences, the page, the saves and the browser', head: true, pool: 'suite', deadline: DEADLINES.head, run: checkHead },
  ...(options.mutations ? MUTANTS.map((entry, index) => ({ key: `planted:${index}`, name: `planted: ${entry[0]}`, heading: '\nPlanted faults', pool: 'suite', deadline: entry[5] ? DEADLINES.browser : DEADLINES.memory, run: () => checkPlanted(entry) })) : []),
  ...(options.mutations ? UNREAD_INPUTS.map((input) => ({ key: `required:${input}`, name: `planted: ${requiredName(input)}`, heading: '\nPlanted faults', pool: 'suite', deadline: DEADLINES.memory, run: () => checkRequired(input) })) : []),
  ...(options.mutations ? [{ key: 'controls', name: 'the controls of the harness', heading: '\nControls of the harness', pool: 'suite', deadline: DEADLINES.controls, run: checkControls }] : []),
  ...(options.mutations ? BENIGN.map((entry, index) => ({ key: `benign:${index}`, name: `benign: ${entry[0]}`, heading: '\nBenign rewrites', pool: 'suite', deadline: entry[5] ? DEADLINES.browser : DEADLINES.memory, run: () => checkBenign(entry) })) : []),
]

const main = async () => {
  const probeAt = process.argv.indexOf('--finish-probe')

  if (probeAt !== -1) {
    // `reject`, `resolve`, `reject-after:<status>` and `resolve-after:<status>`: the cleanups fail or not, and the process ends with the status given (0 when there is none).
    const [mode, given] = String(process.argv[probeAt + 1]).split(':')

    plantCleanups(mode.startsWith('reject'))

    return finish(Number(given) || 0)
  }

  const totals = await runSuite({
    script: __filename,
    inputs: FIXTURES.map((fixture) => fixture.file),
    variants: variantsOf(),
    counts: () => ({ checks, failures }),
    prepare: async () => {
      ENV = await setUp()
    },
    afterEach: async () => {
      if (ENV && ENV.server) {
        await ENV.server.reset()
      }
    },
    close: async () => {
      const failed = await runCleanups()

      if (failed) {
        throw new Error(`${failed} cleanup${failed === 1 ? '' : 's'} failed`)
      }
    },
    control: options.mutations && !flagOf('records') ? { fault: `planted:${MUTANTS.findIndex(([name]) => name === CONTROL_FAULT)}`, head: 'head', heading: '\nThe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  await finish(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await finish(2)
})
