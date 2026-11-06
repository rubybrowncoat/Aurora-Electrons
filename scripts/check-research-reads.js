/*
  Checks what the Research page and the Production page read of research on the 3.2 line: the techs the page lists for the race (the baseline, the race's own designs of the game with or without saved progress and the alien techs it is eligible for, never another race's), the points saved from cancelled research are read as stored, decimals included (FCT_PausedResearch.PointsAccumulated), a tech with saved points that the game lists but cannot start is shown as not researchable with its saved points, the research category and the research field abbreviations shown are the stored ones, the development cost shown is the stored one whatever its size, and the landing times of a project and the techs queued behind it equal the game's own arithmetic to within one increment and are dated as an estimate (utilities/research.js `scheduleProjects`, `evaluateResearch`; components/research/FieldsView.vue and PathView.vue; pages/technologies.vue; pages/production.vue and utilities/production.js `queuedRemaining`).

  Run: bun scripts/check-research-reads.js [--no-mutations]

  The rules are the game's, read from the 3.1.0 source and written here, never read from the modules, and every figure is source-derived: no save played under 3.1 holds saved research or a queue (the owner's decision Q7 of AE-31: none will be supplied; the migrated fixture of scripts/lib/fixtures.js, game 141, race 784, holds no research project, queue or saved row), so each case plants its rows into in-memory copies of the fixture, as scripts/check-treasury-categories.js does. A planted tech the race designed is the copy of a design the fixture holds for the race, under a new id with a cost and no RaceTech row, as `Game.cs:31830-31849` stores one (the game and the race on the row):
  - `Population.ProcessPlayerResearchProjects` (Population.cs:781-955): a project makes `perLab * labs * factor * step` RP in an increment of `step` years, the factor the scientist's Research bonus (four times it less 3 on a tech of his own field) and the race's field bonus; a project that has not enough is left with the difference; one that has enough lands, and the part of the increment it does not need (`(made - left) / made`) goes to the techs queued behind it, each at its own field's factor, owing its development cost less the points saved on it (`PausedResearchProject`, `method_108`, Population.cs:5107-5142), each landing in that increment while the carry lasts and the first it cannot finish starting with what it still owes after the carry;
  - `Population.method_112` (Population.cs:5241-5294) lists a tech of the game that is the baseline's, the race's own or one the race is eligible for (`Game.LoadTechSystems` loads the techs of the baseline and of the game, Game.cs:22107-22112), unless it is researched, running or queued; a tech with a saved row is listed though it is found only in ruins or has a prerequisite not researched (the game colours it as not researchable); the game's NoShieldTechnology filter and its research prototypes are not modelled and not asserted;
  - `Game.CalculateDevelopmentCost` (Game.cs:30919-30933) floors the cost it stores at the build cost, so the stored `FCT_TechSystem.DevelopCost` is the cost and is never recomputed.
  The checks:
  - `oracle`: `scheduleProjects` against a port of that arithmetic, on hand-worked cases and 400 seeded random ones (saved points with fractions, a saved row at or above the cost, a queued tech of another field, a scientist with and without the field of the project): every landing equals the continuous time (the project's RP left over its rate, each queued tech's owed RP over its own rate, added) to 1e-9 years, and the game lands each in the end of the first increment at or after it, for increments of 1, 5 and 30 days;
  - `landing`: the same through the Research page's own reads on a copy with a project, a scientist and a queue planted (the RP of a lab worked out here from the stored race, species, colony and game rows), the Production page's own queue read, and the days its jobs give the queued techs;
  - `saved`: the saved points and the not researchable marks of `evaluateResearch` on a copy with saved rows of a ruin-only tech, techs with a prerequisite not researched, an available tech, a researched tech, a running and a queued one and another empire's, each worked out here from the saved rows, with the statuses and counts of the techs left as the fixture has them;
  - `catalogue`: the techs the page lists are those of the game's list for the race, written here in SQL from `Population.method_112`: the baseline, the race's own designs (one with decimal progress saved, one behind a design not researched with progress saved, one with none, one in a category the lookup lacks), the alien tech the race is eligible for with progress saved, and none of another race (an alien tech with progress saved on it included); the listed flag of every tech equals the game's rule, saved or not, and the Researched count takes in the designs the race has researched;
  - `category`: the research category of a tech is named from DIM_ResearchCategories on the Research page, in the Path view's caption and in a search match (a tech is found by its category name; a changed stored name is shown changed; a category the lookup lacks is named nowhere);
  - `landing-date`: a landing date is dated as an estimate ("about", on a project's line, on the techs queued behind it and on the Next to land tile) with the landing rule's mark on it, the day is the calendar day of the continuous time (a second either side of midnight), a landing 1.1 days away is not dated as the end of a 5-day increment, and an unknown clock is no date;
  - `view`: the Research page's tables (components/research/FieldsView.vue) and the path fact of a tech (PathView.vue) word the saved points with their decimals and mark a not researchable tech, and draw the marks; an available design of the race words its saved points and one with none words none;
  - `cost`: the cost the page shows for a tech is the stored one (the fixture's Research Rate 500 RP at 64,000, a planted 640,000 at 640,000), and no code hard-codes it;
  - `lookups`: the research field names shown are the stored abbreviations (a changed one is shown changed), and no code keeps a name the lookup replaced (the earlier abbreviations EW and MK, Jump Engines);
  - `queue`: the Production page's queue read carries the points saved on each queued tech and `queuedRemaining` is the cost less them (never below 0, null when either is not stored);
  - `rules`: the rules of the remaining RP and the landing year are registered for the 3.2 line too, and say what they now say.
  Where the source does not give a rule the check does not guess it: what a played 3.1 save holds (the carry of an increment with no queue, saved points on a tech that a game then lists) is not asserted.

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { renderTree, treeOf, attrsOf } = require('./lib/vue-render')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { FIXTURE } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const SAVE = FIXTURE.file
const GAME = FIXTURE.gameId
const RACE = FIXTURE.raceId
const NEAR = 1e-9

const renderer = (...parts) => path.join(root, 'src', 'renderer', ...parts)
const FILES = {
  research: renderer('utilities', 'research.js'),
  production: renderer('utilities', 'production.js'),
  technologiesPage: renderer('pages', 'technologies.vue'),
  productionPage: renderer('pages', 'production.vue'),
  fieldsView: renderer('components', 'research', 'FieldsView.vue'),
  pathView: renderer('components', 'research', 'PathView.vue'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))
const PAGE_SOURCES = { technologiesPage: 'pages/technologies', productionPage: 'pages/production', fieldsView: 'components/research/FieldsView', pathView: 'components/research/PathView', research: 'utilities/research', production: 'utilities/production' }

const VUEX = `
  const pairs = (list) => (Array.isArray(list) ? list.map((name) => [name, name]) : Object.entries(list))
  export const mapGetters = (namespace, list) => { const prefix = typeof namespace === 'string' ? namespace + '/' : ''; const map = typeof namespace === 'string' ? list : namespace; return Object.fromEntries(pairs(map).map(([key, name]) => [key, function () { return this.$store.getters[prefix + name] }])) }
  export const mapState = (namespace, list) => (typeof namespace === 'string' ? Object.fromEntries(pairs(list).map(([key, name]) => [key, function () { return this.$store.state[namespace][name] }])) : Object.fromEntries(pairs(namespace).map(([key, name]) => [key, function () { return this.$store.state[name] }])))
  export const mapActions = (list) => Object.fromEntries(pairs(list).map(([key, name]) => [key, function (...args) { return this.$store.dispatch(name, ...args) }]))
`
const STUBS = {
  dayjs: `import { createRequire } from 'node:module'\nexport default createRequire(${JSON.stringify(path.join(root, 'package.json'))})('dayjs')`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default createRequire(${JSON.stringify(path.join(root, 'package.json'))})('dayjs/plugin/utc.js')`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
  cytoscape: 'export default () => ({})',
  vuex: VUEX,
}
const PAGE_MODULES = {
  'components/navigation/section-style': 'export const sectionStyle = () => ({})',
  'components/research/status-style': 'export const statusStyle = () => ({}); export const STATUS_ICONS = {}; export const statusColors = () => ({})',
  'components/charts/theme': 'export const chartTheme = () => ({ categorical: [], ink: \'\', inkMuted: \'\' }); export const withAlpha = (color) => color; export const mapFont = () => ({})',
  'mixins/persisted-view': 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults }); export default (fields) => ({ data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) })',
  'mixins/load-state': null,
}
const STORE = { $store: { getters: { 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} } }

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= NEAR * Math.max(1, Math.abs(a), Math.abs(b))

// ---- The modules and the pages as shipped, or with edits planted ---------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => {
  const sources = Object.fromEntries(Object.entries(PAGE_SOURCES).map(([key, name]) => [name, texts[key]]))
  const page = (name) => memo(() => loadPage(name, { stubs: STUBS, modules: PAGE_MODULES, sources }))

  return {
    texts,
    modules: memo(() => loadUtilities(['research', 'production', 'provenance', 'math'], { stubs: STUBS, sources: { research: texts.research, production: texts.production } })),
    technologies: page('pages/technologies'),
    production: page('pages/production'),
    fieldsView: page('components/research/FieldsView'),
    pathView: page('components/research/PathView'),
  }
}

// ---- The fixture, as in-memory copies ------------------------------------------------------------------------------
const SCIENTIST = 634522
const FIELD = 3
const COLONY = 48977
const PROJECT = 9201
const PROJECT_TECH = 750
const PROJECT_LEFT = 1234.5
const LABS = 2
const QUEUED = [{ tech: 37980, order: 1, saved: 234.75 }, { tech: 763, order: 2, saved: 0 }]

// The project of the scientist 634522 (Research bonus 1.15 and Research Administration 2 stored for him, field 3) on the tech 750 (field 3, 2,000 RP, 1,234.5 RP left) with 2 of the 10 labs planted at Earth, and behind it a tech of field 8 (37980, 2,000 RP, 234.75 of them saved) and one of field 3 (763, 2,000 RP, none saved).
const plantQueue = (database) => {
  database.run(`insert into FCT_PopulationInstallations (GameID, PopID, PlanetaryInstallationID, Amount) values (${GAME}, ${COLONY}, 8, 10)`)
  database.run(`insert into FCT_ResearchProject (ProjectID, GameID, TechID, RaceID, PopulationID, Facilities, ResSpecID, ResearchPointsRequired, Pause, AssignNew) values (${PROJECT}, ${GAME}, ${PROJECT_TECH}, ${RACE}, ${COLONY}, ${LABS}, ${FIELD}, ${PROJECT_LEFT}, 0, 0)`)
  database.run(`update FCT_Commander set CommandType = 7, CommandID = ${PROJECT} where CommanderID = ${SCIENTIST}`)
  QUEUED.forEach((entry) => database.run(`insert into FCT_ResearchQueue (GameID, PopulationID, TechSystemID, CurrentProjectID, ResearchOrder) values (${GAME}, ${COLONY}, ${entry.tech}, ${PROJECT}, ${entry.order})`))
  QUEUED.filter((entry) => entry.saved > 0).forEach((entry) => database.run(`insert into FCT_PausedResearch (TechSystemID, GameID, PointsAccumulated, RaceID) values (${entry.tech}, ${GAME}, ${entry.saved}, ${RACE})`))
}

// The saved rows of the `saved` copy, by what each tech is: picked from the saved tables by SQL written here, with the points each is given.
const SAVED_POINTS = { ruin: 1500.25, lockedA: 800.75, lockedB: 410.5, available: 100.25, done: 55.5, foreign: 77.75, running: 33.25, queued: 44.5 }

const pickedTechs = (database) => {
  const rows = (sql) => database.query(sql).all().map((row) => row.TechSystemID)
  const researched = `select TechID from FCT_RaceTech where GameID = ${GAME} and RaceID = ${RACE}`
  const open = `RaceID = 0 and TechSystemID not in (${researched})`
  const ruin = rows(`select TechSystemID from FCT_TechSystem where RuinOnly = 1 and ${open} order by TechSystemID limit 1`)
  const blockedByPrerequisite = rows(`select TechSystemID from FCT_TechSystem where RuinOnly = 0 and ${open} and Prerequisite1 > 0 and Prerequisite1 not in (${researched}) order by TechSystemID limit 2`)
  const availableWhere = `RuinOnly = 0 and ${open} and (Prerequisite1 = 0 or Prerequisite1 in (${researched})) and (Prerequisite2 = 0 or Prerequisite2 in (${researched})) and TechSystemID not in (${[PROJECT_TECH, ...QUEUED.map((entry) => entry.tech)].join(', ')})`
  const available = rows(`select TechSystemID from FCT_TechSystem where ${availableWhere} order by TechSystemID limit 1`)
  const foreign = rows(`select TechSystemID from FCT_TechSystem as tech where ${availableWhere} and not exists (select 1 from FCT_TechSystem as next where next.Prerequisite1 = tech.TechSystemID or next.Prerequisite2 = tech.TechSystemID) and TechSystemID not in (${available.join(', ') || 0}) order by TechSystemID limit 1`)
  const done = rows(`select TechSystemID from FCT_TechSystem where TechSystemID in (${researched}) order by TechSystemID limit 1`)

  return { ruin: ruin[0], lockedA: blockedByPrerequisite[0], lockedB: blockedByPrerequisite[1], available: available[0], foreign: foreign[0], done: done[0], running: PROJECT_TECH, queued: QUEUED[1].tech }
}

const plantSaved = (database) => {
  const picks = pickedTechs(database)

  plantQueue(database)
  database.run(`update FCT_TechSystem set RaceID = 785 where TechSystemID = ${picks.foreign}`)
  Object.entries(picks).forEach(([kind, tech]) => {
    database.run(`delete from FCT_PausedResearch where TechSystemID = ${tech} and GameID = ${GAME} and RaceID = ${RACE}`)
    database.run(`insert into FCT_PausedResearch (TechSystemID, GameID, PointsAccumulated, RaceID) values (${tech}, ${GAME}, ${SAVED_POINTS[kind]}, ${RACE})`)
  })

  return { picks }
}

const literal = (value) => (typeof value === 'string' ? `'${value.replace(/'/g, '\'\'')}'` : String(value))

// A copy of the row of `table` whose `key` is `from`, every column kept but those of `over`.
const cloneRow = (database, table, key, from, over) => {
  const names = rowsOf(database, `select name from pragma_table_info('${table}')`).map((row) => row.name)
  const select = names.map((name) => (Object.prototype.hasOwnProperty.call(over, name) ? literal(over[name]) : `"${name}"`)).join(', ')

  database.run(`insert into ${table} (${names.map((name) => `"${name}"`).join(', ')}) select ${select} from ${table} where ${key} = ${from}`)
}

// Techs the race designed, each a row of the game and the race that the race has not researched: a copy of a design the fixture holds for the race (the game stores one under its own id with the game and the race, Game.cs:31830-31849), under a new id with its own cost (the game stores the cost it computes, floored at the build cost, Game.cs:30919-30933), and no RaceTech row. `own` is a Jump Drives design (category 22) with progress saved on it, `locked` a design behind `own` with progress saved, `bare` a design with none, `unnamed` one whose category the lookup lacks. `eligible` is an alien tech made eligible for the race (a FCT_EligibleProjects row) with progress saved on it, `foreign` one of another race that is not eligible, with progress saved on it. Progress is stored only below the cost (`Race.method_80`, Race.cs:6280-6310).
const DESIGN_COST = { own: 2500, locked: 1800, bare: 900, unnamed: 700 }
const DESIGN_SAVED = { own: 1234.75, locked: 410.25 }
const UNNAMED_CATEGORY = 9999
const ELIGIBLE_RACE = 786
const FOREIGN_RACE = 785

const plantDesigned = (database) => {
  const { picks } = plantSaved(database)
  const own = (where) => rowsOf(database, `select TechSystemID from FCT_TechSystem where GameID = ${GAME} and RaceID = ${RACE} and ${where} order by TechSystemID limit 1`)[0].TechSystemID
  const design = (source, over) => {
    const id = rowsOf(database, 'select max(TechSystemID) + 1 as Id from FCT_TechSystem')[0].Id

    cloneRow(database, 'FCT_TechSystem', 'TechSystemID', source, { TechSystemID: id, Name: `${rowsOf(database, `select Name from FCT_TechSystem where TechSystemID = ${source}`)[0].Name} II`, ...over })

    return id
  }
  const alien = (race) => rowsOf(database, `select TechSystemID as id, DevelopCost as cost from FCT_TechSystem where GameID = ${GAME} and RaceID = ${race} and Prerequisite1 = 0 and Prerequisite2 = 0 and RuinOnly = 0 and DevelopCost >= 3 order by TechSystemID limit 1`)[0]
  const save = (tech, points) => database.run(`insert into FCT_PausedResearch (TechSystemID, GameID, PointsAccumulated, RaceID) values (${tech}, ${GAME}, ${points}, ${RACE})`)
  const jump = own('CategoryID = 22')
  const plain = own('CategoryID <> 22 and Prerequisite1 = 0 and Prerequisite2 = 0')
  const planted = design(jump, { DevelopCost: DESIGN_COST.own })
  const locked = design(plain, { DevelopCost: DESIGN_COST.locked, Prerequisite1: planted })
  const bare = design(plain, { DevelopCost: DESIGN_COST.bare })
  const unnamed = design(plain, { DevelopCost: DESIGN_COST.unnamed, CategoryID: UNNAMED_CATEGORY })
  const eligible = alien(ELIGIBLE_RACE)
  const foreign = alien(FOREIGN_RACE)

  database.run(`insert into FCT_EligibleProjects (RaceID, TechSystemID, GameID) values (${RACE}, ${eligible.id}, ${GAME})`)
  save(planted, DESIGN_SAVED.own)
  save(locked, DESIGN_SAVED.locked)
  save(eligible.id, eligible.cost / 2 - 0.25)
  save(foreign.id, foreign.cost / 2 - 0.25)

  return { picks, own: planted, locked, bare, unnamed, eligible: { id: eligible.id, saved: eligible.cost / 2 - 0.25 }, foreign: { id: foreign.id, saved: foreign.cost / 2 - 0.25 } }
}

const RESEARCH_RATE_TECH = 24599

const PLANTS = {
  intact: () => ({}),
  queue: (database) => { plantQueue(database) },
  saved: plantSaved,
  dear: (database) => { database.run(`update FCT_TechSystem set DevelopCost = 640000 where TechSystemID = ${RESEARCH_RATE_TECH}`) },
  renamed: (database) => { database.run('update DIM_ResearchField set Abbreviation = \'ZZ\' where ResearchFieldID = 3') },
  designed: plantDesigned,
  designedRenamed: (database) => {
    const facts = plantDesigned(database)

    database.run('update DIM_ResearchCategories set Name = \'Zeta Drives\' where CategoryID = 22')

    return facts
  },
}
let BYTES = null
const COPIES = new Map()

const copyOf = (name) => {
  if (!PLANTS[name]) {
    throw new Error(`no planted copy named ${name}`)
  }

  if (!COPIES.has(name)) {
    BYTES = BYTES || fs.readFileSync(path.join(root, SAVE))

    const database = Database.deserialize(BYTES)
    const facts = PLANTS[name](database) || {}

    COPIES.set(name, { database, facts })
  }

  return COPIES.get(name)
}

const closeCopies = () => {
  COPIES.forEach(({ database }) => database.close())
  COPIES.clear()
}

const adapterOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })
const rowsOf = (database, sql) => database.query(sql).all()

// The Research page on a copy, its own reads run.
const READS = ['catalogue', 'researched', 'projects', 'queue', 'paused', 'labs', 'scientists', 'constructs', 'game', 'race', 'noResearch']

const pageOn = async (w, database) => {
  const options = await w.technologies()
  const vm = instantiate(options, { ...STORE, database: adapterOf(database), GameID: GAME, RaceID: RACE, data: { ready: true } })

  for (const name of READS) {
    await vm.runAsync(name)
  }

  return vm
}

// ---- The game's arithmetic, ported ---------------------------------------------------------------------------------
// One colony's project and the techs queued behind it, run an increment of `step` years at a time as the game does (Population.cs:851-949), until the last has landed: the time each lands, a whole number of increments. `perLab` RP a lab a year, `bonus` the scientist's Research bonus, `specialty` his field. `project` is { left, field }, each queued tech { field, develop, saved }.
const gameLandings = ({ perLab, labs, bonus, specialty, project, queue, step }) => {
  const factor = (field) => (field === specialty ? bonus * 4 - 3 : bonus)
  const landings = []
  const waiting = [...queue]
  let left = project.left
  let field = project.field
  let increments = 0

  for (;;) {
    increments += 1

    const made = perLab * labs * factor(field) * step

    if (made < left) {
      left -= made

      continue
    }

    landings.push(increments * step)

    let carry = left < made ? (made - left) / made : 0
    let started = false

    while (waiting.length) {
      const next = waiting.shift()
      const reach = perLab * labs * factor(next.field) * step * carry
      // The game subtracts the saved points as they are; a saved row at or above the cost cannot arise: `ResearchProject.CancelAndStoreProgress` (ResearchProject.cs:41-62) stores the cost less the RP left and only when above 0, and `Race.method_80` (Race.cs:6280-6310) stores points only below the cost (otherwise it completes the tech). The app never owes less than nothing, and the port is held to that.
      const owed = Math.max(0, next.develop - next.saved)

      if (!(owed <= reach)) {
        left = owed - reach
        field = next.field
        started = true

        break
      }

      landings.push(increments * step)

      if (reach > 0) {
        carry *= (reach - owed) / reach
      }
    }

    if (!started) {
      return landings
    }
  }
}

// The continuous time of each landing: what the game's carry adds up to (the project's RP left over its rate, then each queued tech's owed RP, never below 0, over its own rate).
const continuousLandings = ({ perLab, labs, bonus, specialty, project, queue }) => {
  const factor = (field) => (field === specialty ? bonus * 4 - 3 : bonus)
  let time = project.left / (perLab * labs * factor(project.field))

  return [time, ...queue.map((next) => (time += Math.max(0, next.develop - next.saved) / (perLab * labs * factor(next.field))))]
}

const DAY = 1 / 365
const STEPS = [1 * DAY, 5 * DAY, 30 * DAY]

// The first increment boundary at or after a time (a boundary a hair under it counts as the time).
const boundaryAfter = (time, step) => Math.ceil(time / step - 1e-9) * step

const assertLandings = (label, years, params) => {
  const continuous = continuousLandings(params)

  assert.equal(years.length, continuous.length, `${label}: a landing for the project and each queued tech`)
  years.forEach((value, index) => assert.ok(near(value, continuous[index]), `${label}: landing ${index} is ${continuous[index]} years, not ${value}`))

  for (const step of STEPS) {
    const game = gameLandings({ ...params, step })

    assert.equal(game.length, continuous.length, `${label}: the game lands each tech (${step * 365} d)`)
    game.forEach((landing, index) => {
      assert.ok(near(landing, boundaryAfter(continuous[index], step)), `${label}: in increments of ${Math.round(step * 365)} d the game lands tech ${index} at ${landing}, the first boundary at or after ${continuous[index]} is ${boundaryAfter(continuous[index], step)}`)
      assert.ok(landing >= years[index] - NEAR && landing < years[index] + step + NEAR, `${label}: the landing ${years[index]} is within one ${Math.round(step * 365)} d increment of the game's ${landing}`)
    })
  }
}

// The rows `scheduleProjects` takes, for the parameters of the port.
const rowsFor = ({ perLab, labs, bonus, specialty, project, queue }) => {
  const projectRow = { ProjectID: 1, Name: 'Project', CommanderID: 7, OutputPerLab: perLab, Facilities: labs, ResearchBonus: bonus, ScientistField: specialty, FieldID: project.field, Pause: 0, ResearchPointsRequired: project.left, LocalConstructField: null, LocalConstructBonus: null }
  const queueRows = queue.map((next, index) => ({ CurrentProjectID: 1, ResearchOrder: index + 1, TechID: 100 + index, Name: `Queued ${index}`, DevelopCost: next.develop, FieldID: next.field }))
  const paused = new Map(queue.filter((next) => next.saved !== null).map((next, index) => [100 + index, next.saved]))

  return { projects: [projectRow], queue: queueRows, paused }
}

const yearsOf = (research, params) => {
  const { projects, queue, paused } = rowsFor(params)
  const [scheduled] = research.scheduleProjects(projects, queue, paused, {})

  return [scheduled.years, ...scheduled.queue.map((entry) => entry.years)]
}

// A small seeded generator, so the random cases are the same on every run.
const generator = (seed) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6D2B79F5) >>> 0

    let t = state

    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('oracle', 'scheduleProjects gives each landing as the continuous time the game\'s carry adds up to (to 1e-9 years) and the game, run in increments of 1, 5 and 30 days, lands each in the first increment at or after it, on worked cases (saved points with fractions, a saved row above the cost, a queued tech of another field, a scientist without the field) and 400 seeded random ones', async (w) => {
  const { research } = await w.modules()
  const worked = [
    { name: 'the planted case', perLab: 900, labs: 2, bonus: 1.15, specialty: 3, project: { left: 1234.5, field: 3 }, queue: [{ field: 8, develop: 2000, saved: 234.75 }, { field: 3, develop: 2000, saved: 0 }] },
    { name: 'a scientist of no field of the queue', perLab: 700, labs: 3, bonus: 1.3, specialty: 5, project: { left: 4000.25, field: 3 }, queue: [{ field: 8, develop: 3000, saved: 1000.5 }, { field: 3, develop: 1000, saved: 0.25 }, { field: 1, develop: 5000, saved: 2500 }] },
    { name: 'a saved row above the cost', perLab: 1000, labs: 1, bonus: 1.5, specialty: 3, project: { left: 905, field: 8 }, queue: [{ field: 3, develop: 800, saved: 1200.5 }, { field: 8, develop: 2000, saved: 0 }] },
    { name: 'no queue', perLab: 900, labs: 4, bonus: 1, specialty: 2, project: { left: 5000, field: 3 }, queue: [] },
    { name: 'a decimal bonus under one', perLab: 900, labs: 2, bonus: 0.95, specialty: 3, project: { left: 700.125, field: 3 }, queue: [{ field: 3, develop: 1500, saved: 100.5 }] },
  ]

  for (const params of worked) {
    assertLandings(params.name, yearsOf(research, params), params)
  }

  const random = generator(31337)
  const between = (low, high) => low + random() * (high - low)
  const pick = (list) => list[Math.floor(random() * list.length)]

  for (let index = 0; index < 400; index++) {
    const params = {
      perLab: between(300, 1500),
      labs: 1 + Math.floor(random() * 6),
      bonus: Math.round(between(100, 190)) / 100,
      specialty: pick([1, 3, 8]),
      project: { left: Math.round(between(100, 9000) * 100) / 100, field: pick([1, 3, 8]) },
      queue: Array.from({ length: Math.floor(random() * 5) }, () => {
        const develop = Math.round(between(500, 12000))
        const saved = pick([0, Math.round(between(1, develop * 1.2) * 100) / 100, Math.round(between(1, develop) * 100) / 100])

        return { field: pick([1, 3, 8]), develop, saved }
      }),
    }

    assertLandings(`random case ${index}`, yearsOf(research, params), params)
  }
})

// What each tech of the planted queue lands at, worked out here from the stored rows of the copy: the RP of a lab from the race, species, colony and game (Aurora's research output of a colony), the bonuses of the scientist, the tech costs and the saved rows.
const plantedParams = (database) => {
  const perLab = rowsOf(database, `select FCT_Species.ResearchRateModifier * FCT_Race.Research * FCT_Race.EconomicProdModifier * FCT_Population.Efficiency * (1 - FCT_SystemBody.RadiationLevel / 10000.0) * (1 - FCT_Population.UnrestPoints / 100.0) * DIM_PopPoliticalStatus.ProductionMod * (FCT_Game.ResearchSpeed / 100.0) as PerLab from FCT_Population inner join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID inner join FCT_Game on FCT_Game.GameID = FCT_Population.GameID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID inner join DIM_PopPoliticalStatus on DIM_PopPoliticalStatus.StatusID = FCT_Population.PoliticalStatus where FCT_Population.PopulationID = ${COLONY}`)[0].PerLab
  const bonus = rowsOf(database, `select BonusValue from FCT_CommanderBonuses where CommanderID = ${SCIENTIST} and BonusID = 3`)[0].BonusValue
  const specialty = rowsOf(database, `select ResSpecID from FCT_Commander where CommanderID = ${SCIENTIST}`)[0].ResSpecID
  const techRow = (id) => rowsOf(database, `select FCT_TechSystem.DevelopCost, DIM_TechType.FieldID from FCT_TechSystem inner join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID where FCT_TechSystem.TechSystemID = ${id}`)[0]
  const saved = (id) => (rowsOf(database, `select PointsAccumulated from FCT_PausedResearch where TechSystemID = ${id} and GameID = ${GAME} and RaceID = ${RACE}`)[0] || { PointsAccumulated: 0 }).PointsAccumulated

  return { perLab, labs: LABS, bonus, specialty, project: { left: PROJECT_LEFT, field: techRow(PROJECT_TECH).FieldID }, queue: QUEUED.map((entry) => ({ field: techRow(entry.tech).FieldID, develop: techRow(entry.tech).DevelopCost, saved: saved(entry.tech) })) }
}

check('landing', 'on the copy with a project, its scientist and a queue planted, the Research page\'s own reads give the schedule whose landings are the continuous times of the game\'s arithmetic from the stored rows (900 RP a lab, 1.6 for the scientist\'s own field, 1.15 for the other), within one increment of the game\'s, and the Production page\'s queue read and jobs give the same days', async (w) => {
  const { database } = copyOf('queue')
  const params = plantedParams(database)

  assert.ok(near(params.perLab, 900), `the lab output the fixture stores is 900 RP a year, not ${params.perLab}`)
  assert.deepEqual([params.bonus, params.specialty, params.project.field], [1.15, 3, 3], 'the scientist and the project')
  assert.deepEqual(params.queue.map((entry) => [entry.field, entry.develop, entry.saved]), [[8, 2000, 234.75], [3, 2000, 0]], 'the queued techs, with the points saved on the first')

  const vm = await pageOn(w, database)
  const [scheduled] = vm.research.schedule

  assert.equal(vm.research.schedule.length, 1, 'one project is scheduled')
  assert.ok(near(scheduled.rate, 900 * 2 * (4 * 1.15 - 3)), `the project makes ${900 * 2 * (4 * 1.15 - 3)} RP a year, not ${scheduled.rate}`)
  assert.deepEqual(scheduled.queue.map((entry) => entry.remaining), [2000 - 234.75, 2000], 'what each queued tech still owes: its cost less the saved points, decimals kept')
  assert.ok(near(scheduled.queue[0].rate, 900 * 2 * 1.15) && near(scheduled.queue[1].rate, 900 * 2 * (4 * 1.15 - 3)), 'each queued tech is paid at the factor of its own field')
  assertLandings('the page', [scheduled.years, ...scheduled.queue.map((entry) => entry.years)], params)
  assert.ok(near(scheduled.queue[0].start, scheduled.years), 'the first queued tech starts when the project lands')

  const production = await w.production()
  const populations = { [COLONY]: { PopName: 'Earth', OverallResearchModifier: params.perLab } }
  const page = instantiate(production, { ...STORE, database: adapterOf(database), GameID: GAME, RaceID: RACE, data: { populationProductionModifiers: populations, arrivals: [] } })

  await page.runAsync('researches')

  const continuous = continuousLandings(params)
  const jobs = page.researchJobs

  assert.deepEqual(jobs.map((job) => job.key), [`research-${PROJECT}`, `research-${PROJECT}-1`, `research-${PROJECT}-2`], 'the Production page has the project and its two queued techs as jobs')
  jobs.forEach((job, index) => assert.ok(near(job.days, continuous[index] * 365), `the Production page lands job ${index} in ${continuous[index] * 365} days, not ${job.days}`))
})

check('saved', 'the saved points and not researchable marks of evaluateResearch on the copy with saved rows: a ruin-only tech and techs with a prerequisite not researched are listed as not researchable with their points (ruin, prerequisite), an available tech is listed as researchable, a researched, a running, a queued and another empire\'s tech are not listed, a decimal is kept as stored, and no status or count of the fixture changes', async (w) => {
  const { database, facts } = copyOf('saved')
  const base = await pageOn(w, copyOf('intact').database)
  const vm = await pageOn(w, database)
  const { info } = vm.research
  const baseInfo = base.research.info
  const { picks } = facts

  assert.ok(Object.values(picks).every((id) => Number.isInteger(id)), `the fixture offers a tech of each kind: ${JSON.stringify(picks)}`)

  const researched = new Set(rowsOf(database, `select TechID from FCT_RaceTech where GameID = ${GAME} and RaceID = ${RACE}`).map((row) => row.TechID))
  const techRow = (id) => rowsOf(database, `select RuinOnly, RaceID, Prerequisite1, Prerequisite2 from FCT_TechSystem where TechSystemID = ${id}`)[0]
  const reasons = (id) => {
    const tech = techRow(id)

    return [...(tech.RuinOnly ? ['ruin'] : []), ...([tech.Prerequisite1, tech.Prerequisite2].some((need) => need > 0 && !researched.has(need)) ? ['prerequisite'] : [])]
  }
  // Population.method_112: a saved row is listed unless the tech is researched, running or queued, or belongs to another empire (its RaceID is neither 0 nor the race's, and the race has no right to it).
  const listed = (id) => {
    const tech = techRow(id)
    const eligible = rowsOf(database, `select 1 from FCT_EligibleProjects where GameID = ${GAME} and RaceID = ${RACE} and TechSystemID = ${id}`).length > 0

    return !researched.has(id) && id !== PROJECT_TECH && !QUEUED.some((entry) => entry.tech === id) && (tech.RaceID === 0 || tech.RaceID === RACE || eligible)
  }

  for (const [kind, id] of Object.entries(picks)) {
    const entry = info.get(id)
    const points = SAVED_POINTS[kind]

    assert.ok(entry, `the ${kind} tech ${id} is in the graph`)
    assert.equal(entry.hasSaved, true, `${kind} ${id}: a saved row is seen`)
    assert.equal(entry.saved, points, `${kind} ${id}: the saved points are ${points} as stored, not ${entry.saved}`)
    assert.equal(entry.inList, listed(id), `${kind} ${id}: the game ${listed(id) ? 'lists' : 'does not list'} it`)
    assert.deepEqual(entry.notResearchable, listed(id) ? reasons(id) : [], `${kind} ${id}: why it cannot be started`)
  }

  assert.deepEqual(picks.ruin && info.get(picks.ruin).notResearchable, ['ruin'], 'a ruin-only tech is marked ruin')
  assert.deepEqual(info.get(picks.lockedA).notResearchable, ['prerequisite'], 'a tech behind a prerequisite not researched is marked prerequisite')
  assert.deepEqual(info.get(picks.available).notResearchable, [], 'an available tech is no mark')
  assert.equal(info.get(picks.available).inList, true, 'and is listed')
  assert.deepEqual([picks.done, picks.foreign, picks.running, picks.queued].map((id) => info.get(id).inList), [false, false, false, false], 'a researched, another empire\'s, a running and a queued tech are not listed')

  for (const [kind, id] of Object.entries(picks).filter(([kind]) => ['ruin', 'lockedA', 'lockedB', 'available', 'done'].includes(kind))) {
    assert.equal(info.get(id).status, baseInfo.get(id).status, `the saved row changes no status (${kind} ${id})`)
    assert.equal(info.get(id).remaining, Math.max(0, vm.research.graph.techs.get(id).cost - SAVED_POINTS[kind]), `the RP owed on ${kind} ${id} is its cost less the saved points`)
  }

  assert.equal(base.research.info.get(picks.available).notResearchable.length, 0, 'the fixture marks nothing')
  assert.equal(base.research.info.get(picks.available).hasSaved, false, 'and holds no saved row')
  const changed = [...info].filter(([id, entry]) => baseInfo.get(id).status !== entry.status).map(([id, entry]) => `${id}: ${baseInfo.get(id).status} to ${entry.status}`)
  const planted = [picks.foreign, PROJECT_TECH, ...QUEUED.map((entry) => entry.tech)]

  assert.deepEqual(changed.filter((line) => !planted.includes(Number(line.split(':')[0]))), [], 'every tech but the one another empire holds and the running and the queued ones keeps its status')
})

// The FieldsView of the Research page on a copy, for the field of a tech.
const fieldsOn = async (w, vm, fieldId) => {
  const options = await w.fieldsView()

  return instantiate(options, { ...STORE, data: { research: vm.research, fieldId, search: '' } })
}

const cellsOf = (text, vm, slot, row) => {
  const { tree } = renderTree(text, vm, { $vuetify: { breakpoint: { mdAndUp: true } } })
  const table = treeOf(tree).find((node) => node.tag === 'v-data-table' && (attrsOf(node).items || []).some((item) => item.id === row.id) && node.data.scopedSlots && node.data.scopedSlots[slot])

  assert.ok(table, `a table draws the row ${row.id} with a ${slot} cell`)

  const cell = treeOf(table.data.scopedSlots[slot]({ item: row }))
  const lines = cell.flatMap((node) => (node.children || []).filter((child) => typeof child === 'string'))
  const marked = (name) => cell.filter((node) => attrsOf(node)[name] !== undefined).map((node) => (node.children || []).filter((child) => typeof child === 'string').join(''))

  return { cell, lines, marked }
}

// The pattern of a figure as the page words it: a whole number with its separators or a decimal with its two places.
const money = (value) => String(value).replace(/(\d)(?=(\d{3})+$)/g, '$1\\D?')
const pointsPattern = (value) => (Number.isInteger(value) ? money(value) : value.toFixed(2).replace(/^(\d+)\./, (_match, whole) => `${money(whole)}\\.`))

check('view', 'the Research page\'s tables word the saved points with their decimals (a whole count for a whole figure), mark a not researchable tech with its reasons and draw the marks in data-saved and data-not-researchable, the banked line of an available tech keeps its decimals, an available design of the race words its saved points and one with none words no saved points, and the path of a ruin-only tech states its saved points and why it cannot be started', async (w) => {
  const { database, facts } = copyOf('saved')
  const vm = await pageOn(w, database)
  const { picks } = facts
  const tech = (id) => vm.research.graph.techs.get(id)
  const saved = (kind) => new RegExp(`^${pointsPattern(SAVED_POINTS[kind])} saved of ${money(tech(picks[kind]).cost)}$`)
  const text = w.texts.fieldsView

  const lockedFields = await fieldsOn(w, vm, tech(picks.lockedA).fieldId)
  const lockedRow = lockedFields.lockedRows.find((row) => row.id === picks.lockedA)

  assert.ok(lockedRow, 'the locked tech is a row of its field')
  assert.ok(saved('lockedA').test(lockedRow.saved), `the saved points of a locked tech: "${lockedRow.saved}"`)
  assert.equal(lockedRow.notResearchable, 'A prerequisite is not researched', 'and why it cannot be started')

  const lockedDrawn = cellsOf(text, lockedFields, 'item.name', lockedRow)

  assert.deepEqual(lockedDrawn.marked('data-saved'), [lockedRow.saved], 'the locked row draws its saved points once')
  assert.deepEqual(lockedDrawn.marked('data-not-researchable'), ['Not researchable: A prerequisite is not researched'], 'and its mark once')

  const blockedFields = await fieldsOn(w, vm, tech(picks.ruin).fieldId)
  const blockedRow = blockedFields.blockedRows.find((row) => row.id === picks.ruin)

  assert.ok(blockedRow && saved('ruin').test(blockedRow.saved), `the saved points of a ruin-only tech: "${blockedRow && blockedRow.saved}"`)
  assert.equal(blockedRow.notResearchable, 'Found only in ancient ruins', 'and why it cannot be started')

  const blockedDrawn = cellsOf(text, blockedFields, 'item.name', blockedRow)

  assert.deepEqual(blockedDrawn.marked('data-saved'), [blockedRow.saved], 'the out of reach row draws its saved points')
  assert.deepEqual(blockedDrawn.marked('data-not-researchable'), ['Not researchable: Found only in ancient ruins'], 'and its mark')

  const availableFields = await fieldsOn(w, vm, tech(picks.available).fieldId)
  const availableRow = availableFields.availableRows.find((row) => row.id === picks.available)

  assert.equal(availableRow.notResearchable, '', 'an available tech is not marked')
  assert.ok(saved('available').test(availableRow.saved), `but its saved points are worded: "${availableRow.saved}"`)
  assert.equal(availableRow.banked, SAVED_POINTS.available, 'its banked points are the stored ones')

  const bankedDrawn = cellsOf(text, availableFields, 'item.remaining', availableRow)

  assert.ok(bankedDrawn.lines.some((line) => new RegExp(`^${pointsPattern(SAVED_POINTS.available)} banked of ${money(tech(picks.available).cost)}$`).test(line)), `the banked line keeps its decimals: ${bankedDrawn.lines.join(' | ')}`)

  const wholeDrawn = cellsOf(text, availableFields, 'item.remaining', { ...availableRow, banked: 100 })

  assert.ok(wholeDrawn.lines.some((line) => /^100 banked of /.test(line)), `a whole figure carries no decimals: ${wholeDrawn.lines.join(' | ')}`)

  const pathOptions = await w.pathView()
  const path = (id) => instantiate(pathOptions, { ...STORE, data: { research: vm.research, targetId: id } })
  const pathFacts = path(picks.ruin).facts
  const savedFact = pathFacts.find((fact) => fact.label === 'Saved points')

  assert.ok(savedFact && new RegExp(`^${pointsPattern(SAVED_POINTS.ruin)} RP$`).test(savedFact.value), `the path states the saved points of the ruin-only tech: ${JSON.stringify(pathFacts)}`)
  assert.equal(savedFact.note, 'Not researchable: Found only in ancient ruins', 'and why it cannot be started')
  assert.ok(!path(picks.done).facts.some((fact) => fact.label === 'Saved points'), 'a researched tech states none')

  const availablePath = path(picks.available).facts[0]

  assert.ok(new RegExp(`^${pointsPattern(SAVED_POINTS.available)} banked of ${money(tech(picks.available).cost)}$`).test(availablePath.note), `the path keeps the decimals of the banked points: "${availablePath.note}"`)

  // Techs the race designed: an available design with progress saved words it with its decimals, one with none words no saved points.
  const designed = copyOf('designed')
  const designedVm = await pageOn(w, designed.database)
  const designedFields = async (id) => await fieldsOn(w, designedVm, designedVm.research.graph.techs.get(id).fieldId)
  const ownRow = (await designedFields(designed.facts.own)).availableRows.find((row) => row.id === designed.facts.own)
  const bareRow = (await designedFields(designed.facts.bare)).availableRows.find((row) => row.id === designed.facts.bare)

  assert.ok(ownRow && new RegExp(`^${pointsPattern(DESIGN_SAVED.own)} saved of ${money(DESIGN_COST.own)}$`).test(ownRow.saved), `a design of the race words its saved points: "${ownRow && ownRow.saved}"`)
  assert.ok(bareRow, 'a design with no saved row is a row of its field')
  assert.deepEqual([bareRow.saved, bareRow.notResearchable, bareRow.banked], ['', '', 0], 'and words no saved points and no mark')
})

check('cost', 'the development cost the page shows for a tech is the stored one whatever its size: the fixture\'s Research Rate 500 RP at 64,000, a planted 640,000 at 640,000 (graph, remaining and the Researched table), and no research code keeps either figure', async (w) => {
  const stored = rowsOf(copyOf('intact').database, `select Name, DevelopCost from FCT_TechSystem where TechSystemID = ${RESEARCH_RATE_TECH}`)[0]

  assert.deepEqual([stored.Name, stored.DevelopCost], ['Research Rate 500 RP', 64000], 'the fixture stores Research Rate 500 RP at 64,000')

  for (const [copy, cost] of [['intact', 64000], ['dear', 640000]]) {
    const vm = await pageOn(w, copyOf(copy).database)
    const tech = vm.research.graph.techs.get(RESEARCH_RATE_TECH)

    assert.equal(tech.cost, cost, `${copy}: the page's cost of Research Rate 500 RP`)

    const fields = await fieldsOn(w, vm, tech.fieldId)
    const row = fields.doneRows.find((one) => one.id === RESEARCH_RATE_TECH)

    assert.ok(row, `${copy}: the tech is a researched row of its field`)
    assert.equal(row.cost, cost, `${copy}: the Researched table's cost`)

    const drawn = cellsOf(w.texts.fieldsView, fields, 'item.cost', row)

    assert.ok(drawn.lines.includes(`${fields.count(cost)} RP`) && fields.count(cost).replace(/\D/g, '') === String(cost), `${copy}: the table draws ${cost}: ${drawn.lines.join(' | ')}`)
  }

  // A tech the race has not researched owes the stored cost whole.
  const { database } = copyOf('saved')
  const open = rowsOf(database, `select TechSystemID from FCT_TechSystem where RuinOnly = 0 and RaceID = 0 and Prerequisite1 = 0 and TechSystemID not in (select TechID from FCT_RaceTech where GameID = ${GAME} and RaceID = ${RACE}) order by TechSystemID limit 1`)

  if (open.length) {
    const dear = Database.deserialize(BYTES)

    dear.run(`update FCT_TechSystem set DevelopCost = 640000 where TechSystemID = ${open[0].TechSystemID}`)

    const vm = await pageOn(w, dear)

    assert.equal(vm.research.info.get(open[0].TechSystemID).remaining, 640000, 'a tech not yet researched owes its stored cost whole')
    dear.close()
  }

  const needles = [String(640000), String(64000), '640,000', '64,000', '640\'000', '64\'000']
  const researchFiles = ['utilities/research.js', 'utilities/production.js', 'pages/technologies.vue', 'pages/production.vue', 'components/research/FieldsView.vue', 'components/research/PathView.vue', 'components/research/ResearchHeader.vue']
  const found = []

  for (const file of researchFiles) {
    const full = renderer(...file.split('/'))

    if (!fs.existsSync(full)) {
      continue
    }

    const code = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    needles.filter((needle) => new RegExp(`(?<![\\d.,'])${needle.replace(/[,']/g, '\\$&')}(?![\\d])`).test(code)).forEach((needle) => found.push(`${file}: ${needle}`))
    assert.ok(!/24599|Research Rate/.test(code), `${file} names the tech or its stored name`)
  }

  assert.deepEqual(found, [], 'no research code keeps the cost of the Research Rate techs')
})

check('lookups', 'the research field names the page shows are the stored abbreviations (a changed one is shown changed) and no code keeps a name the lookup replaced (EW, MK, Jump Engines)', async (w) => {
  const stored = rowsOf(copyOf('intact').database, 'select ResearchFieldID, Abbreviation, DoNotDisplay from DIM_ResearchField order by ResearchFieldID').filter((row) => ![1, '1', true, 'TRUE'].includes(row.DoNotDisplay))

  assert.equal(stored.length, 9, 'the fixture stores nine research fields to display')

  for (const [copy, expected] of [['intact', Object.fromEntries(stored.map((row) => [row.ResearchFieldID, row.Abbreviation]))], ['renamed', { ...Object.fromEntries(stored.map((row) => [row.ResearchFieldID, row.Abbreviation])), 3: 'ZZ' }]]) {
    const vm = await pageOn(w, copyOf(copy).database)
    const fields = await fieldsOn(w, vm, 3)

    for (const row of stored) {
      assert.equal(fields.fieldAbbreviation(row.ResearchFieldID), expected[row.ResearchFieldID], `${copy}: field ${row.ResearchFieldID} is shown as ${expected[row.ResearchFieldID]}`)
    }
  }

  assert.ok(!stored.some((row) => ['EW', 'MK'].includes(row.Abbreviation)), 'the lookup of the 3.2 line has neither of the earlier abbreviations')

  const names = ['\'E' + 'W\'', '\'M' + 'K\'', 'Jump ' + 'Engines']
  const hits = []
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      walk(full)
    } else if (/\.(js|vue)$/.test(entry.name) && full !== __filename) {
      const code = fs.readFileSync(full, 'utf8')

      names.filter((name) => code.includes(name)).forEach((name) => hits.push(`${path.relative(root, full)}: ${name}`))
    }
  })

  walk(renderer())
  walk(path.join(root, 'scripts'))
  assert.deepEqual(hits, [], 'no source or script keeps one of the replaced names')
})

// The game's list of the techs a race can start, in SQL written here from Population.method_112 (Population.cs:5241-5294): a tech of the game that is the baseline's (RaceID 0), the race's or one the race is eligible for, that is not researched, running or queued, with its prerequisites researched and not found only in ruins, unless progress is saved on it (a saved tech is listed whatever stops it being started). The game's NoShieldTechnology filter and its research prototypes are not modelled.
const RESEARCHED_SQL = `select TechID from FCT_RaceTech where GameID = ${GAME} and RaceID = ${RACE}`
const SAVED_SQL = `select TechSystemID from FCT_PausedResearch where GameID = ${GAME} and RaceID = ${RACE}`
const ELIGIBLE_SQL = `select TechSystemID from FCT_EligibleProjects where GameID = ${GAME} and RaceID = ${RACE}`
const RUNNING_SQL = `select TechID from FCT_ResearchProject where GameID = ${GAME} and RaceID = ${RACE}`
const QUEUED_SQL = `select TechSystemID from FCT_ResearchQueue where GameID = ${GAME} and PopulationID in (select PopulationID from FCT_Population where GameID = ${GAME} and RaceID = ${RACE})`

const gameList = (database) => new Set(rowsOf(database, `select t.TechSystemID as ID from FCT_TechSystem as t where t.GameID in (0, ${GAME}) and (t.RaceID = 0 or t.RaceID = ${RACE} or t.TechSystemID in (${ELIGIBLE_SQL})) and (t.RuinOnly = 0 or t.TechSystemID in (${SAVED_SQL})) and (t.Prerequisite1 = 0 or t.Prerequisite1 in (${RESEARCHED_SQL}) or t.TechSystemID in (${SAVED_SQL})) and (t.Prerequisite2 = 0 or t.Prerequisite2 in (${RESEARCHED_SQL}) or t.TechSystemID in (${SAVED_SQL})) and t.TechSystemID not in (${RESEARCHED_SQL}) and t.TechSystemID not in (${RUNNING_SQL}) and t.TechSystemID not in (${QUEUED_SQL})`).map((row) => row.ID))

// The techs the race has researched that sit in a field the page shows, straight from its RaceTech rows.
const researchedShown = (database) => rowsOf(database, `select count(*) as N from FCT_RaceTech inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID and FCT_TechSystem.GameID in (0, ${GAME}) inner join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID inner join DIM_ResearchField on DIM_ResearchField.ResearchFieldID = DIM_TechType.FieldID where FCT_RaceTech.GameID = ${GAME} and FCT_RaceTech.RaceID = ${RACE} and DIM_ResearchField.DoNotDisplay not in (1, '1', 'TRUE')`)[0].N

check('catalogue', 'the Research page lists the techs the game lists for the race: the baseline, the race\'s own designs of the game (one with decimal progress saved, one behind a design not researched with progress saved, one with none) and the alien tech it is eligible for, and no tech of another race (one with progress saved on it included); the listed flag of every tech equals the game\'s list rule worked out here from the stored rows, saved or not, and the Researched count takes in the designs the race has researched', async (w) => {
  const { research } = await w.modules()
  const { database, facts } = copyOf('designed')
  const vm = await pageOn(w, database)
  const { info, graph } = vm.research
  const listed = gameList(database)
  const stored = new Map(rowsOf(database, `select TechSystemID, GameID, RaceID from FCT_TechSystem where GameID in (0, ${GAME})`).map((row) => [row.TechSystemID, row]))
  const designs = rowsOf(database, `select TechSystemID from FCT_TechSystem where GameID = ${GAME} and RaceID = ${RACE}`).map((row) => row.TechSystemID)
  const catalogue = vm.catalogue.techs.map((row) => row.TechSystemID)
  const others = rowsOf(database, `select TechSystemID from FCT_TechSystem where GameID = ${GAME} and RaceID <> ${RACE} and TechSystemID <> ${facts.eligible.id}`).map((row) => row.TechSystemID)

  assert.equal(designs.length, 177 + 3 + 1, 'the fixture holds 177 designs of the race, and 4 are planted')
  assert.equal(others.length, 61 + 92 + 58 + 61 + 28 - 1, 'the fixture holds 300 techs of the other races of the game, and one of them is made eligible')
  assert.deepEqual(designs.filter((id) => !graph.techs.has(id)), [], 'every design of the race is in the catalogue, researched or not')
  assert.deepEqual(others.filter((id) => graph.techs.has(id) || info.has(id)), [], 'no tech of another race is, but the one it is eligible for')
  assert.deepEqual(catalogue.filter((id) => stored.get(id).GameID !== 0 && stored.get(id).RaceID !== RACE && id !== facts.eligible.id), [], 'the catalogue holds nothing of another race of the game')
  assert.ok(graph.techs.has(facts.eligible.id), 'the alien tech the race is eligible for is in the catalogue')
  assert.ok(!graph.techs.has(facts.foreign.id), 'the alien tech that is not eligible is not, with progress saved on it or not')
  assert.deepEqual([...listed].filter((id) => !graph.techs.has(id)), [], 'every tech the game lists is in the catalogue')

  for (const [id, entry] of info) {
    assert.equal(entry.inList, listed.has(id), `tech ${id}: the game ${listed.has(id) ? 'lists' : 'does not list'} it (status ${entry.status}, saved ${entry.hasSaved})`)
  }

  const own = info.get(facts.own)
  const locked = info.get(facts.locked)
  const bare = info.get(facts.bare)
  const eligible = info.get(facts.eligible.id)

  assert.deepEqual([own.status, own.hasSaved, own.saved, own.inList, own.notResearchable], [research.AVAILABLE, true, DESIGN_SAVED.own, true, []], 'a design of the race with decimal progress is available, listed and keeps the progress as stored')
  assert.equal(own.remaining, DESIGN_COST.own - DESIGN_SAVED.own, 'and owes its cost less the progress')
  assert.deepEqual([locked.status, locked.hasSaved, locked.saved, locked.inList, locked.notResearchable], [research.LOCKED, true, DESIGN_SAVED.locked, true, ['prerequisite']], 'a design behind one not researched is listed with its progress and marked not researchable')
  assert.deepEqual([bare.status, bare.hasSaved, bare.saved, bare.inList, bare.notResearchable, bare.remaining], [research.AVAILABLE, false, null, true, [], DESIGN_COST.bare], 'a design with no progress is available and listed, owing its whole cost')
  assert.deepEqual([eligible.status, eligible.hasSaved, eligible.saved, eligible.inList], [research.AVAILABLE, true, facts.eligible.saved, true], 'the alien tech the race is eligible for is available and listed with its progress')
  assert.equal(info.get(facts.unnamed).inList, true, 'and so is a design whose category the lookup lacks')

  const intact = await pageOn(w, copyOf('intact').database)
  const counted = (page) => page.research.counts[research.DONE]

  assert.equal(counted(intact), researchedShown(copyOf('intact').database), 'the Researched count is the race\'s researched techs of the fields shown, its own designs included')
  assert.equal(counted(vm), researchedShown(database), 'on the copy with designs too')
  assert.ok(counted(intact) >= 177, 'the 177 researched designs are counted')
})

// The caption the Path view draws for a tech (the elements marked data-category) and the name cell of a search match.
const captionOf = async (w, vm, id) => {
  const path = instantiate(await w.pathView(), { ...STORE, data: { research: vm.research, targetId: id } })
  const { tree } = renderTree(w.texts.pathView, path, { $vuetify: { breakpoint: { mdAndUp: true } }, linkTo: { shipyards: () => ({}) } })

  return treeOf(tree).filter((node) => attrsOf(node)['data-category'] !== undefined).map((node) => (node.children || []).filter((child) => typeof child === 'string').join(''))
}

const searchOn = async (w, vm, needle) => instantiate(await w.fieldsView(), { ...STORE, data: { research: vm.research, fieldId: 3, search: needle } })

check('category', 'the Research page names the research category of a tech from DIM_ResearchCategories: the Path view\'s caption and the name cell of a search match say it (category 22 is Jump Drives as stored, Zeta Drives when the lookup says so), a tech is found by the category name, a category the lookup lacks is named nowhere, and every tech of the catalogue carries the stored id and name of its category', async (w) => {
  for (const [copy, name, needle] of [['designed', 'Jump Drives', 'jump drives'], ['designedRenamed', 'Zeta Drives', 'zeta drives']]) {
    const { database, facts } = copyOf(copy)
    const vm = await pageOn(w, database)
    const { graph, shown } = vm.research
    const storedName = rowsOf(database, 'select Name from DIM_ResearchCategories where CategoryID = 22')[0].Name
    const categories = new Map(rowsOf(database, 'select CategoryID, Name from DIM_ResearchCategories').map((row) => [row.CategoryID, row.Name]))
    const stored = new Map(rowsOf(database, 'select TechSystemID, CategoryID from FCT_TechSystem').map((row) => [row.TechSystemID, row.CategoryID]))

    assert.equal(storedName, name, `${copy}: the lookup says ${name} for category 22`)

    for (const [id, tech] of graph.techs) {
      assert.deepEqual([tech.categoryId, tech.categoryName], [stored.get(id), categories.get(stored.get(id)) || null], `${copy}: the category of tech ${id}`)
    }

    assert.equal(graph.techs.get(facts.own).categoryName, name, `${copy}: the planted Jump Drives design is in ${name}`)
    assert.equal(graph.techs.get(facts.unnamed).categoryName, null, `${copy}: a category the lookup lacks is no name`)
    assert.deepEqual(await captionOf(w, vm, facts.own), [` · ${name}`], `${copy}: the Path view's caption names the category once`)
    assert.deepEqual(await captionOf(w, vm, facts.unnamed), [], `${copy}: and names none for a category the lookup lacks`)

    const search = await searchOn(w, vm, needle)
    const inCategory = [...graph.techs.values()].filter((tech) => tech.categoryId === 22 && shown.has(tech.fieldId)).map((tech) => tech.id).sort((a, b) => a - b)

    assert.ok(inCategory.includes(facts.own), `${copy}: the planted design is in a field the page shows`)

    const found = search.matches.map((row) => row.id)

    assert.ok(inCategory.every((id) => found.includes(id)), `${copy}: searching "${needle}" finds every tech of the category`)
    assert.equal(found.includes(facts.unnamed), false, `${copy}: and not a tech of no category`)
    assert.equal(search.matches.find((row) => row.id === facts.own).category, name, `${copy}: the match row says its category`)
    assert.deepEqual(cellsOf(w.texts.fieldsView, search, 'item.name', search.matches.find((row) => row.id === facts.own)).marked('data-category'), [` · ${name}`], `${copy}: the name cell draws it once`)
  }

  const old = await searchOn(w, await pageOn(w, copyOf('designedRenamed').database), 'jump drives')

  assert.equal(old.matches.some((row) => row.id === copyOf('designedRenamed').facts.own), false, 'a category renamed in the lookup is no longer found by its old name')
})

// The calendar day of a game clock time, worked out here from the start year (the clock runs from 1 January of it, 00:00 UTC).
const isoDay = (startYear, seconds) => new Date(Date.UTC(startYear, 0, 1) + seconds * 1000).toISOString().slice(0, 10)
const SECONDS_YEAR = 31536000

check('landing-date', 'a landing date of the Research page is dated as an estimate ("about", on a project\'s line, on the techs queued behind it and on the Next to land tile) with the landing rule\'s mark on it, whose note says the game lands the tech in the first increment at or after it: the day is the calendar day of the continuous time (a second after midnight is the next day, a second before it the day), a landing 1.1 days away is dated as that and not as the end of a 5-day increment, and an unknown clock is no date', async (w) => {
  const { provenance } = await w.modules()
  const { database } = copyOf('queue')
  const vm = await pageOn(w, database)
  const params = plantedParams(database)
  const continuous = continuousLandings(params)
  const { StartYear, GameTime } = vm.research.game
  const about = (years) => `about ${isoDay(StartYear, GameTime + years * SECONDS_YEAR)}`
  const fields = await fieldsOn(w, vm, 3)
  const [project] = fields.projects

  assert.equal(project.landing.text, about(continuous[0]), 'the project is dated as about the day of its continuous landing')
  assert.deepEqual(project.queue.map((entry) => entry.landing.text), [about(continuous[1]), about(continuous[2])], 'and so is each tech queued behind it')

  for (const landing of [project.landing, ...project.queue.map((entry) => entry.landing)]) {
    assert.equal(landing.result && landing.result.rule.id, 'research.landing', 'the date carries the result of the landing rule')
    assert.ok(/first increment at or after it/.test(provenance.describeResult(landing.result)), 'whose words say where the game lands the tech')
  }

  const { tree, texts } = renderTree(w.texts.fieldsView, fields, { $vuetify: { breakpoint: { mdAndUp: true } } })
  const marks = treeOf(tree).filter((node) => node.tag === 'provenance-mark' && attrsOf(node).result === project.landing.result)

  assert.ok(texts.includes(project.landing.text), 'the page draws the date')
  assert.ok(marks.length >= 1, 'with the mark of its result beside it')

  const tile = vm.tiles.find((one) => one.label === 'Next to land')

  assert.ok(tile.note.startsWith(`${about(continuous[0])}, in `), `the Next to land tile dates it the same way: "${tile.note}"`)
  assert.ok(/first increment at or after that time/.test(tile.title), 'and its mark says where the game lands it')

  // Dates around day and increment boundaries on a clock of 10 days into the game.
  const clock = 10 * 86400
  const on = async (years, game = { StartYear: 2200, GameTime: clock }) => {
    const view = await fieldsOn(w, { research: { ...vm.research, game } }, 3)

    return view.landingOf({ years, yearsResult: project.landing.result }, project)
  }
  const midday = { StartYear: 2200, GameTime: clock + 23 * 3600 }
  const cases = [
    ['a second after midnight', 3 * 86400 + 1, '2200-01-14', null],
    ['a second before midnight', 3 * 86400 - 1, '2200-01-13', null],
    ['1.1 days away, short of the 5-day increment that ends on 2200-01-16', 1.1 * 86400, '2200-01-12', null],
    ['the same on a clock at 23:00', 1.1 * 86400, '2200-01-13', midday],
  ]

  for (const [label, seconds, day, game] of cases) {
    const landing = await on(seconds / SECONDS_YEAR, game || undefined)

    assert.equal(landing.text, `about ${day}`, `${label}: the day of the continuous time`)
    assert.equal(isoDay(2200, (game ? game.GameTime : clock) + seconds), day, `${label}: the day worked out here from the clock`)
    assert.equal(landing.result, project.landing.result, `${label}: with the result of the landing rule`)
  }

  assert.notEqual(isoDay(2200, clock + 1.1 * 86400), isoDay(2200, clock + 5 * 86400), 'the continuous day is not the end of the 5-day increment')

  const unknown = await on(0.5, { StartYear: null, GameTime: clock })

  assert.ok(!/^about/.test(unknown.text) && unknown.result.status === 'unavailable', 'a clock the save lacks gives no date and an unavailable result')
})

check('queue', 'the Production page\'s research read carries the points saved on each queued tech (234.75 as stored, 0 for none), queuedRemaining is the stored cost less them (never below 0, null when either is not stored) and the page\'s queued job owes that', async (w) => {
  const { production: p } = await w.modules()
  const { database } = copyOf('queue')
  const page = instantiate(await w.production(), { ...STORE, database: adapterOf(database), GameID: GAME, RaceID: RACE, data: { populationProductionModifiers: { [COLONY]: { PopName: 'Earth', OverallResearchModifier: 900 } }, arrivals: [] } })

  await page.runAsync('researches')
  assert.deepEqual(page.researches.queues.map((queue) => [queue.TechSystemID, queue.Saved]), QUEUED.map((entry) => [entry.tech, entry.saved]), 'the read gives the saved points of each queued tech')
  assert.deepEqual(page.researches.queues.map((queue) => p.queuedRemaining(queue)), [2000 - 234.75, 2000], 'what each owes')

  assert.equal(p.queuedRemaining({ DevelopCost: 2000, Saved: 2500.5 }), 0, 'a saved row above the cost owes nothing')
  assert.equal(p.queuedRemaining({ DevelopCost: 2000, Saved: 0 }), 2000, 'none saved owes the cost')
  assert.equal(p.queuedRemaining({ DevelopCost: 2000, Saved: 0.5 }), 1999.5, 'a fraction is kept')
  assert.equal(p.queuedRemaining({ DevelopCost: null, Saved: 5 }), null, 'a cost not stored is not known')
  assert.equal(p.queuedRemaining({ DevelopCost: 2000, Saved: null }), null, 'nor are saved points not stored')
  assert.equal(p.queuedRemaining({ DevelopCost: 640000, Saved: 40000.25 }), 599999.75, 'a large stored cost is used whole')
})

check('rules', 'the rules of the remaining RP and of the landing year are registered for the 3.2 line and say the saved points are read as stored with their decimals, the cost is the stored one and the game hands the part of an increment a project does not need to the tech behind it', async (w) => {
  const { provenance } = await w.modules()

  for (const id of ['research.remaining', 'research.landing']) {
    const rule = provenance.getRule(id)

    assert.ok(rule, `${id} is registered`)
    assert.deepEqual(rule.versions, ['3.2.x'], `${id} is registered for the line`)
  }

  assert.ok(/saved points are read as stored, decimals included, and the cost is the stored one whatever its size/.test(provenance.getRule('research.remaining').note), 'the remaining RP rule says what it reads')
  assert.ok(/The game hands the part of a landing increment the project does not need to the next queued tech at that tech's own rate/.test(provenance.getRule('research.landing').note), 'the landing rule says how the game carries')
  assert.ok(/first increment at or after it/.test(provenance.getRule('research.landing').note), 'and where it lands')
  assert.ok(/for a queued tech the stored development cost less the points saved on it\. The development cost is the stored one: the game floors it at the build cost when it sets it, so the figure is never recomputed here/.test(provenance.getRule('production.researchFinish').note), 'the Production page\'s research finish rule says the cost is the stored one, floored by the game at the build cost (Game.cs:30919-30933)')
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
const BANKED = 'const banked = paused.has(entry.TechID) ? paused.get(entry.TechID) : 0'
const REMAINING = 'const remaining = isKnownNumber(entry.DevelopCost) && isKnownNumber(banked) ? Math.max(0, entry.DevelopCost - banked) : null'
const CARRY = 'compute: (values) => values.before + values.own'
const QUEUED_RATE = 'const queuedRate = annualResearchPointsResult(project, entry.FieldID, bonuses)'
const REMAINING_ROW = 'export const queuedRemaining = (queue) => (!isNumber(queue.DevelopCost) || !isNumber(queue.Saved) ? null : Math.max(0, queue.DevelopCost - queue.Saved))'
const SAVED_ENTRY = 'entry.saved = entry.hasSaved && isKnownNumber(paused.get(tech.id)) ? paused.get(tech.id) : null'
const IN_LIST = 'entry.inList = entry.status === AVAILABLE || (entry.hasSaved && ![DONE, ACTIVE, QUEUED].includes(entry.status) && (tech.raceId === 0 || tech.raceId === raceId || eligible.has(tech.id)))'
const REASONS = 'entry.notResearchable = entry.inList ? [...(tech.ruinOnly ? [\'ruin\'] : []), ...(tech.prerequisites.some((id) => !researched.has(id)) ? [\'prerequisite\'] : [])] : []'
const POINTS = 'return this.count(value, Number.isInteger(value) ? 0 : 2)'

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the saved points are ignored in what a queued tech owes', target: 'research', from: BANKED, to: 'const banked = 0', fails: ['oracle', 'landing'] },
  { name: 'the saved points are cut to a whole number', target: 'research', from: BANKED, to: 'const banked = paused.has(entry.TechID) ? Math.trunc(paused.get(entry.TechID)) : 0', fails: ['oracle', 'landing'] },
  { name: 'a saved row above the cost owes less than nothing', target: 'research', from: REMAINING, to: 'const remaining = isKnownNumber(entry.DevelopCost) && isKnownNumber(banked) ? entry.DevelopCost - banked : null', fails: ['oracle'] },
  { name: 'a queued tech is paid at the rate of the project\'s field', target: 'research', from: QUEUED_RATE, to: 'const queuedRate = annualResearchPointsResult(project, project.FieldID, bonuses)', fails: ['oracle', 'landing'] },
  { name: 'a queued tech lands after its own time alone', target: 'research', from: CARRY, to: 'compute: (values) => values.own', fails: ['oracle', 'landing'] },
  { name: 'the landing of a queued tech is rounded up to the day', target: 'research', from: CARRY, to: 'compute: (values) => Math.ceil((values.before + values.own) * 365) / 365', fails: ['oracle', 'landing'] },
  { name: 'the carry into a queued tech is lost', target: 'research', from: CARRY, to: 'compute: (values) => Math.ceil(values.before * 365) / 365 + values.own', fails: ['oracle', 'landing'] },
  { name: 'the scientist\'s own field is not counted four times', target: 'research', from: 'specialised ? 4 * bonus - 3 : bonus', to: 'specialised ? bonus : bonus', fails: ['oracle', 'landing'] },
  { name: 'a saved row is not seen', target: 'research', from: 'entry.hasSaved = paused.has(tech.id)', to: 'entry.hasSaved = false', fails: ['saved', 'view'] },
  { name: 'the saved points are read as a whole number', target: 'research', from: SAVED_ENTRY, to: 'entry.saved = entry.hasSaved && isKnownNumber(paused.get(tech.id)) ? Math.trunc(paused.get(tech.id)) : null', fails: ['saved', 'view'] },
  { name: 'a saved row of a researched tech is listed', target: 'research', from: IN_LIST, to: 'entry.inList = entry.status === AVAILABLE || (entry.hasSaved && ![ACTIVE, QUEUED].includes(entry.status) && (tech.raceId === 0 || tech.raceId === raceId || eligible.has(tech.id)))', fails: ['saved', 'catalogue'] },
  { name: 'a saved row of another empire\'s tech is listed', target: 'research', from: IN_LIST, to: 'entry.inList = entry.status === AVAILABLE || (entry.hasSaved && ![DONE, ACTIVE, QUEUED].includes(entry.status))', fails: ['saved', 'catalogue'] },
  { name: 'a saved row of a running tech is listed', target: 'research', from: IN_LIST, to: 'entry.inList = entry.status === AVAILABLE || (entry.hasSaved && ![DONE, QUEUED].includes(entry.status) && (tech.raceId === 0 || tech.raceId === raceId || eligible.has(tech.id)))', fails: ['saved', 'catalogue'] },
  { name: 'an available tech with no saved row is not listed', target: 'research', from: IN_LIST, to: 'entry.inList = entry.hasSaved && ![DONE, ACTIVE, QUEUED].includes(entry.status) && (tech.raceId === 0 || tech.raceId === raceId || eligible.has(tech.id))', fails: ['catalogue'] },
  { name: 'a tech is listed whatever its status', target: 'research', from: IN_LIST, to: 'entry.inList = true', fails: ['saved', 'catalogue'] },
  { name: 'a ruin-only tech is never marked not researchable', target: 'research', from: REASONS, to: 'entry.notResearchable = entry.inList ? [...(tech.prerequisites.some((id) => !researched.has(id)) ? [\'prerequisite\'] : [])] : []', fails: ['saved', 'view'] },
  { name: 'a prerequisite not researched is never marked', target: 'research', from: REASONS, to: 'entry.notResearchable = entry.inList ? [...(tech.ruinOnly ? [\'ruin\'] : [])] : []', fails: ['saved', 'view'] },
  { name: 'every listed tech is marked not researchable', target: 'research', from: REASONS, to: 'entry.notResearchable = entry.inList ? [\'ruin\'] : []', fails: ['saved', 'view'] },
  { name: 'the reason of a ruin-only tech reads as another', target: 'research', from: 'ruin: \'Found only in ancient ruins\',', to: 'ruin: \'Found in ruins\',', fails: ['view'] },
  { name: 'the remaining RP rule is registered for another line only', target: 'research', from: 'const SAVED_VERSIONS = [\'3.2.x\']', to: 'const SAVED_VERSIONS = [\'3.0.x\']', fails: ['rules'] },
  { name: 'the landing rule says nothing of the carry', target: 'research', from: 'The game hands the part of a landing increment the project does not need to the next queued tech at that tech\\\'s own rate, so this figure is the carry in continuous time: the game lands the tech at the end of the first increment at or after it. ', to: '', fails: ['rules'] },
  { name: 'the points of a view are rounded to a whole number', target: 'fieldsView', from: POINTS, to: 'return this.count(value, 0)', fails: ['view'] },
  { name: 'the points of a view keep one decimal', target: 'fieldsView', from: POINTS, to: 'return this.count(value, Number.isInteger(value) ? 0 : 1)', fails: ['view'] },
  { name: 'the banked line of an available tech is rounded', target: 'fieldsView', from: '{{ points(item.banked) }} banked of', to: '{{ count(item.banked) }} banked of', fails: ['view'] },
  { name: 'the saved points of a row are not worded', target: 'fieldsView', from: 'saved: entry.hasSaved && entry.inList ? (isKnownNumber(entry.saved)', to: 'saved: false ? (isKnownNumber(entry.saved)', fails: ['view'] },
  { name: 'a listed tech with no saved row is worded as holding saved points', target: 'fieldsView', from: 'saved: entry.hasSaved && entry.inList ? (isKnownNumber(entry.saved)', to: 'saved: entry.inList ? (isKnownNumber(entry.saved)', fails: ['view'] },
  { name: 'the search leaves the category name out', target: 'fieldsView', from: ' || (tech.categoryName && tech.categoryName.toLowerCase().includes(needle))', to: '', fails: ['category'] },
  { name: 'a match row names no category', target: 'fieldsView', from: 'category: tech.categoryName,', to: 'category: null,', fails: ['category'] },
  { name: 'the date of a landing is no estimate', target: 'fieldsView', from: 'text: `about ${gameTime(StartYear, GameTime + entry.years * SECONDS_PER_YEAR).format(\'YYYY-MM-DD\')}`, result: entry.yearsResult }', to: 'text: gameTime(StartYear, GameTime + entry.years * SECONDS_PER_YEAR).format(\'YYYY-MM-DD\'), result: entry.yearsResult }', fails: ['landing-date'] },
  { name: 'the date of a landing has no mark', target: 'fieldsView', from: 'format(\'YYYY-MM-DD\')}`, result: entry.yearsResult }', to: 'format(\'YYYY-MM-DD\')}`, result: null }', fails: ['landing-date'] },
  { name: 'the date of a landing is the end of the day after', target: 'fieldsView', from: 'GameTime + entry.years * SECONDS_PER_YEAR).format(\'YYYY-MM-DD\')}`', to: 'GameTime + entry.years * SECONDS_PER_YEAR + 86400).format(\'YYYY-MM-DD\')}`', fails: ['landing-date'] },
  { name: 'the not researchable line is not marked', target: 'fieldsView', from: '<div v-if="item.notResearchable" class="caption warning--text" data-not-researchable>Not researchable: {{ item.notResearchable }}</div>\n                </template>\n                <template #[`item.needs`]', to: '<div v-if="item.notResearchable" class="caption warning--text">Not researchable: {{ item.notResearchable }}</div>\n                </template>\n                <template #[`item.needs`]', fails: ['view'] },
  { name: 'the out of reach table has no saved points', target: 'fieldsView', from: '<div v-if="item.saved" class="caption text--secondary" data-saved>{{ item.saved }}</div>\n                  <div v-if="item.notResearchable" class="caption warning--text" data-not-researchable>Not researchable: {{ item.notResearchable }}</div>\n                </template>\n                <template #[`item.cost`]', to: '</template>\n                <template #[`item.cost`]', fails: ['view'] },
  { name: 'the abbreviation of a field is fixed in the page', target: 'fieldsView', from: 'return (this.research.fields.find((field) => field.ResearchFieldID === fieldId) || {}).Abbreviation || \'\'', to: 'return ({ 3: \'DF\' })[fieldId] || (this.research.fields.find((field) => field.ResearchFieldID === fieldId) || {}).Abbreviation || \'\'', fails: ['lookups'] },
  { name: 'the path fact of a ruin-only tech states no saved points', target: 'pathView', from: '...(entry.inList ? [{ label: \'Saved points\'', to: '...(false ? [{ label: \'Saved points\'', fails: ['view'] },
  { name: 'the path fact rounds the saved points', target: 'pathView', from: 'return this.count(value, Number.isInteger(value) ? 0 : 2)', to: 'return this.count(value, 0)', fails: ['view'] },
  { name: 'the stored cost of a tech is capped at 100,000', target: 'technologiesPage', from: 'FCT_TechSystem.DevelopCost, FCT_TechSystem.RaceID,', to: 'min(FCT_TechSystem.DevelopCost, 100000) as DevelopCost, FCT_TechSystem.RaceID,', fails: ['cost'] },
  { name: 'the field abbreviation is read from a fixed list', target: 'technologiesPage', from: 'DIM_ResearchField.Abbreviation, DIM_ResearchField.DoNotDisplay from DIM_ResearchField', to: 'char(88, 88) as Abbreviation, DIM_ResearchField.DoNotDisplay from DIM_ResearchField', fails: ['lookups'] },
  { name: 'the category name is read from a fixed name', target: 'technologiesPage', from: 'select DIM_ResearchCategories.CategoryID, DIM_ResearchCategories.Name from DIM_ResearchCategories', to: 'select DIM_ResearchCategories.CategoryID, case when DIM_ResearchCategories.CategoryID = 22 then char(74, 117, 109, 112, 32, 68, 114, 105, 118, 101, 115) else DIM_ResearchCategories.Name end as Name from DIM_ResearchCategories', fails: ['category'] },
  { name: 'the category of a tech is not read', target: 'technologiesPage', from: 'FCT_TechSystem.RaceID, FCT_TechSystem.CategoryID, FCT_TechSystem.Prerequisite1', to: 'FCT_TechSystem.RaceID, FCT_TechSystem.Prerequisite1', fails: ['category'] },
  { name: 'the designs of the race are not in the catalogue', target: 'technologiesPage', from: ' or (FCT_TechSystem.GameID = ${this.GameID} and FCT_TechSystem.RaceID = ${this.RaceID})', to: '', fails: ['catalogue'] },
  { name: 'the designs of every race of the game are in the catalogue', target: 'technologiesPage', from: 'FCT_TechSystem.GameID = 0 or (FCT_TechSystem.GameID = ${this.GameID} and FCT_TechSystem.RaceID = ${this.RaceID})', to: 'FCT_TechSystem.GameID in (0, ${this.GameID})', fails: ['catalogue'] },
  { name: 'the eligible alien techs of no race are read', target: 'technologiesPage', from: 'FCT_EligibleProjects.RaceID = ${this.RaceID}', to: 'FCT_EligibleProjects.RaceID = 0', fails: ['catalogue'] },
  { name: 'the Next to land tile gives no estimate', target: 'technologiesPage', from: '`about ${this.landing(next.project.years)}, in ', to: '`${this.landing(next.project.years)}, in ', fails: ['landing-date'] },
  { name: 'the Path view names no category', target: 'pathView', from: '<span v-if="tech.categoryName" data-category> · {{ tech.categoryName }}</span>', to: '', fails: ['category'] },
  { name: 'the Production queue read ignores the saved points', target: 'productionPage', from: ' else 0 end as Saved,', to: ' else 0 end * 0 as Saved,', fails: ['queue', 'landing'] },
  { name: 'the queued tech owes its whole cost on the Production page', target: 'production', from: REMAINING_ROW, to: 'export const queuedRemaining = (queue) => (!isNumber(queue.DevelopCost) ? null : queue.DevelopCost)', fails: ['queue', 'landing'] },
  { name: 'the research finish rule says nothing of the stored cost', target: 'production', from: ' The development cost is the stored one: the game floors it at the build cost when it sets it, so the figure is never recomputed here.', to: '', fails: ['rules'] },
  { name: 'the saved points are cut to whole points on the Production page', target: 'production', from: REMAINING_ROW, to: 'export const queuedRemaining = (queue) => (!isNumber(queue.DevelopCost) || !isNumber(queue.Saved) ? null : Math.max(0, queue.DevelopCost - Math.trunc(queue.Saved)))', fails: ['queue', 'landing'] },
  { name: 'a saved row above the cost owes less than nothing on the Production page', target: 'production', from: REMAINING_ROW, to: 'export const queuedRemaining = (queue) => (!isNumber(queue.DevelopCost) || !isNumber(queue.Saved) ? null : queue.DevelopCost - queue.Saved)', fails: ['queue'] },
  { name: 'saved points that are not stored count as none on the Production page', target: 'production', from: REMAINING_ROW, to: 'export const queuedRemaining = (queue) => (!isNumber(queue.DevelopCost) ? null : Math.max(0, queue.DevelopCost - (isNumber(queue.Saved) ? queue.Saved : 0)))', fails: ['queue'] },
]

// Rewrites that say the same thing: a clamp written with a comparison, the carry written as a sum in the other order.
const BENIGN = [
  { name: 'the clamp of the owed RP written as a comparison', target: 'research', from: REMAINING, to: 'const remaining = isKnownNumber(entry.DevelopCost) && isKnownNumber(banked) ? (entry.DevelopCost - banked > 0 ? entry.DevelopCost - banked : 0) : null' },
  { name: 'the carry written as a sum in the other order', target: 'research', from: CARRY, to: 'compute: (values) => values.own + values.before' },
  { name: 'the clamp of the queued remaining written as a comparison', target: 'production', from: 'Math.max(0, queue.DevelopCost - queue.Saved)', to: '(queue.DevelopCost - queue.Saved > 0 ? queue.DevelopCost - queue.Saved : 0)' },
]
/* eslint-enable no-template-curly-in-string */

// ---- Run ------------------------------------------------------------------------------------------------------------
const run = async (checks, world) => {
  const failures = []

  for (const { name, run: body } of checks) {
    try {
      await body(world)
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

const NEEDS = Object.fromEntries(CHECKS.map((one) => [one.name, [SAVE]]))
const absent = (one) => (NEEDS[one.name] || []).filter((file) => !fs.existsSync(path.join(root, file)))

const main = async () => {
  const available = CHECKS.filter((one) => !absent(one).length)

  CHECKS.filter((one) => absent(one).length).forEach((one) => console.log(`UNSUPPORTED  ${one.name}: the fixture ${absent(one).join(', ')} is not there`))

  const failures = await run(available, worldOf())
  let passed = available.length - failures.length
  let total = available.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutating()) {
    const known = new Set(available.map(({ name }) => name))

    FAULTS.forEach(({ name, fails }) => fails.forEach((id) => assert.ok(CHECKS.some((one) => one.name === id), `${name}: no check named ${id}`)))

    const benignOnly = await run(available, worldOf(textWith(BENIGN)))

    total += 1

    if (benignOnly.length) {
      console.log(`FAIL every rewrite applied: ${benignOnly.map(describeFailure).join('; ')}`)
    } else {
      passed += 1
    }

    const attempts = FAULTS.flatMap((fault) => [[fault, []], [fault, BENIGN]])
    const outcomes = await inParallel(attempts, async ([fault, benign]) => {
      const texts = textWith()

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

      // The rewrites go onto the faulty source where their text is still there exactly once: a fault may replace the very text a rewrite says again.
      benign.filter((edit) => texts[edit.target].split(edit.from).length === 2).forEach((edit) => {
        texts[edit.target] = patched(FILES[edit.target], texts[edit.target], edit.from, edit.to)
      })

      const world = worldOf(texts)
      const named = fault.fails.filter((id) => known.has(id))
      const missed = []

      for (const id of named) {
        const [failed] = await run(CHECKS.filter((one) => one.name === id), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(id)
        }
      }

      return { label: `${fault.name}${benign.length ? ', on the source with every rewrite' : ''}`, missed, named: named.length }
    })

    outcomes.forEach((outcome) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault: ${outcome.message}`)
      } else if (!outcome.named) {
        console.log(`FAIL planted fault ${outcome.label}: none of its checks can run here`)
      } else if (outcome.missed.length) {
        console.log(`FAIL planted fault ${outcome.label}: still passes ${outcome.missed.join(', ')}`)
      } else {
        passed += 1
      }
    })
  }

  console.log(`${passed} of ${total} checks passed`)

  return passed === total
}

main()
  .then((green) => {
    closeCopies()
    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    closeCopies()
    process.exit(2)
  })
