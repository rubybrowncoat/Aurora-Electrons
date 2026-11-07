/*
  Checks what the Research page and the Production page read of research on the 3.2 line: the techs the page lists for the race (the baseline, the race's own designs of the game with or without saved progress and the alien techs it is eligible for, never another race's), the points saved from cancelled research are read as stored, decimals included (FCT_PausedResearch.PointsAccumulated), a tech with saved points that the game lists but cannot start is shown as not researchable with its saved points, the research category and the research field abbreviations shown are the stored ones, the development cost shown is the stored one whatever its size, and the landing times of a project and the techs queued behind it equal the game's own arithmetic to within one increment and are dated as an estimate (utilities/research.js `scheduleProjects`, `evaluateResearch`; components/research/FieldsView.vue and PathView.vue; pages/technologies.vue; pages/production.vue and utilities/production.js `queuedRemaining`).

  Run: bun scripts/check-research-reads.js [--no-mutations]

  The fixture has no research project, queue or saved-progress row, so the checks plant rows into in-memory copies. Expected figures are worked examples, independent of the renderer calculations.
  - A project makes per-lab output times labs, research factors and elapsed years. When it lands, unused time carries into each queued technology at that technology's own field factor and stored cost less saved points.
  - The catalogue lists baseline, own-race and eligible alien technologies unless researched, running or queued. Saved progress keeps an otherwise blocked technology listed as not researchable; shield filtering and prototypes are not modelled.
  - Stored development cost is already floored at build cost and is never recomputed.
  The checks:
  - `oracle`: `scheduleProjects` against a port of that arithmetic, on hand-worked cases and 400 seeded random ones (saved points with fractions, a saved row at or above the cost, a queued tech of another field, a scientist with and without the field of the project): every landing equals the continuous time (the project's RP left over its rate, each queued tech's owed RP over its own rate, added) to 1e-9 years, and the game lands each in the end of the first increment at or after it, for increments of 1, 5 and 30 days;
  - `landing`: the same through the Research page's own reads on a copy with a project, a scientist and a queue planted (the RP of a lab worked out here from the stored race, species, colony and game rows), the Production page's own queue read, and the days its jobs give the queued techs;
  - `saved`: the saved points and the not researchable marks of `evaluateResearch` on a copy with saved rows of a ruin-only tech, techs with a prerequisite not researched, an available tech, a researched tech, a running and a queued one and another empire's, each worked out here from the saved rows, with the statuses and counts of the techs left as the fixture has them;
  - `catalogue`: the techs listed for the race include the baseline, its own designs and eligible alien technologies, but never another empire's ineligible design; saved rows preserve blocked entries and researched counts include the race's researched designs;
  - `category`: the research category of a tech is named from DIM_ResearchCategories on the Research page, in the Path view's caption and in a search match (a tech is found by its category name; a changed stored name is shown changed; a category the lookup lacks is named nowhere);
  - `landing-date`: a landing date is dated as an estimate ("about", on a project's line, on the techs queued behind it and on the Next to land tile) with the landing rule's mark on it, the day is the calendar day of the continuous time (a second either side of midnight), a landing 1.1 days away is not dated as the end of a 5-day increment, and an unknown clock is no date;
  - `view`: the Research page's tables (components/research/FieldsView.vue) and the path fact of a tech (PathView.vue) word the saved points with their decimals and mark a not researchable tech, and draw the marks; an available design of the race words its saved points and one with none words none;
  - `cost`: the cost the page shows for a tech is the stored one (the fixture's Research Rate 500 RP at 64,000, a planted 640,000 at 640,000), and no code hard-codes it;
  - `lookups`: the research field names shown are the stored abbreviations (a changed one is shown changed), and no code keeps a name the lookup replaced (the earlier abbreviations EW and MK, Jump Engines);
  - `queue`: the Production page's queue read carries the points saved on each queued tech and `queuedRemaining` is the cost less them (never below 0, null when either is not stored);
  - `rules`: the rules of the remaining RP and the landing year are registered for the 3.2 line too, and say what they now say.
  Planted rows are not a played-save witness: the carry of an increment with no queue and saved progress subsequently listed by the game are not asserted from a campaign.

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
  space: renderer('utilities', 'warnings', 'space.js'),
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
    modules: memo(() => loadUtilities(['research', 'production', 'provenance', 'math', 'warnings/common', 'warnings/space'], { stubs: STUBS, sources: { research: texts.research, production: texts.production, 'warnings/space': texts.space } })),
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

// Unresearched own-race designs use new identities and stored costs, with saved progress below cost where present. The examples include an unresearched prerequisite, an absent category lookup, an eligible alien design and an ineligible foreign design.
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
// Run a colony's project and queue in fixed increments until the final technology lands. `perLab` is annual output per lab, `bonus` the scientist's Research bonus, `specialty` the scientist's field; each queued technology owes its development cost less saved points.
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
      // Saved progress is kept with its fractions. The game stores only positive progress below the development cost; the app additionally clamps any overpaid planted row at zero owed.
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

// Raw stored inputs for a colony with the requested base and otherwise neutral per-lab factors.
const labInputs = (ResearchBase) => ({ ResearchBase, ResearchRateModifier: 1, EconomicProdModifier: 1, Efficiency: 1, RadiationLevel: 0, UnrestPoints: 0, ProductionMod: 1, ResearchSpeed: 100 })

// The rows `scheduleProjects` takes, for the parameters of the port.
const rowsFor = ({ perLab, labs, bonus, specialty, project, queue }) => {
  const projectRow = { ProjectID: 1, Name: 'Project', CommanderID: 7, ...labInputs(perLab), Facilities: labs, ResearchBonus: bonus, ScientistField: specialty, FieldID: project.field, Pause: 0, ResearchPointsRequired: project.left, LocalConstructField: null, LocalConstructBonus: null }
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

check('production-field', 'the processor multiplies 100 RP/year by the racial field factor 1.2, giving 120 RP/year and a 365-day finish for 120 RP', async (w) => {
  const { production } = await w.modules()
  const project = { ...labInputs(100), Facilities: 1, ProjectField: 3, ScientistCommandID: 1, CommanderField: 3, ActualCommanderResearchBonus: 1, ActualAnomalyBonus: 1 }
  const rate = production.researchRate(project, { 3: 1.2 })
  const finish = production.finishDays({ rule: 'production.researchFinish', rate, remaining: 120, remainingName: '120 RP' })

  assert.equal(rate.value, 120, '100 * 1.2 = 120 RP/year')
  assert.equal(finish.result.value, 365, '120 RP at 120 RP/year takes one game year')
})

check('production-queued-field', 'a queued tech chooses the scientist specialty and local construct by the queued field, not the running field', async (w) => {
  const { production } = await w.modules()
  const project = { ...labInputs(100), Facilities: 1, ProjectField: 3, ScientistCommandID: 1, CommanderField: 8, CommanderBonus: 1.25, ActualCommanderResearchBonus: 1.25, AnomalyID: 1, AnomalyField: 8, AnomalyBonus: 1.5, ActualAnomalyBonus: 1 }
  const queued = production.queuedResearch(project, { ProjectField: 8 })
  const rate = production.researchRate(queued, { 3: 1, 8: 1.2 })

  assert.equal(queued.ActualCommanderResearchBonus, 2, 'the scientist specialty factor is 4 * 1.25 - 3 = 2')
  assert.equal(queued.ActualAnomalyBonus, 1.5, 'the queued field matches the construct, irrespective of the current project field')
  assert.ok(near(rate.value, 360), '100 * 2 * 1.5 * 1.2 = 360 RP/year')
})

// A construct colony with 0.4 M surface people and an eligible orbital census at the one-million boundary.
const censusCopy = () => {
  const database = new Database(fs.readFileSync(path.join(root, SAVE)))
  const [{ SystemBodyID, SystemID, SpeciesID }] = rowsOf(database, `select SystemBodyID, SystemID, SpeciesID from FCT_Population where PopulationID = ${COLONY}`)
  const firstId = (table, key) => rowsOf(database, `select ${key} as Id from ${table} limit 1`)[0].Id

  database.run(`delete from FCT_AncientConstruct where GameID = ${GAME}`)
  database.run(`delete from FCT_Ship where GameID = ${GAME} and RaceID = ${RACE}`)
  database.run(`update FCT_SystemBody set Xcor = 123456789, Ycor = 987654321 where SystemBodyID = ${SystemBodyID}`)
  database.run(`update FCT_Population set Population = 0.4 where PopulationID = ${COLONY}`)
  database.run(`insert into FCT_AncientConstruct (AncientConstructID, GameID, SystemBodyID, Active, ResearchField, ResearchBonus) values (990001, ${GAME}, ${SystemBodyID}, 1, 3, 1.5)`)
  cloneRow(database, 'FCT_Fleet', 'FleetID', firstId('FCT_Fleet', 'FleetID'), { FleetID: 990001, GameID: GAME, RaceID: RACE, FleetName: 'Census', AssignedPopulationID: COLONY, SystemID, Xcor: 123456789, Ycor: 987654321, CivilianFunction: 0, OrbitBodyID: 0 })
  cloneRow(database, 'FCT_ShipClass', 'ShipClassID', firstId('FCT_ShipClass', 'ShipClassID'), { ShipClassID: 990001, GameID: GAME, RaceID: RACE, ArkShip: 1 })
  cloneRow(database, 'FCT_ShipDesignComponents', 'SDComponentID', firstId('FCT_ShipDesignComponents', 'SDComponentID'), { SDComponentID: 990001, ComponentTypeID: 17, SpecialFunction: 7, ComponentValue: 500000 })
  database.run(`insert into FCT_ClassComponent (GameID, ClassID, ComponentID, NumComponent) values (${GAME}, 990001, 990001, 2)`)
  for (const [ShipID, Amount] of [[990001, 2000000], [990002, 100000]]) {
    database.run(`insert into FCT_Ship (ShipID, GameID, RaceID, FleetID, ShipClassID, ShipName) values (${ShipID}, ${GAME}, ${RACE}, 990001, 990001, 'Census ship')`)
    database.run(`insert into FCT_ShipCargo (GameID, ShipID, CargoTypeID, SpeciesID, Amount) values (${GAME}, ${ShipID}, 1, ${SpeciesID}, ${Amount})`)
  }
  database.run(`insert into FCT_DamagedComponent (GameID, ShipID, ComponentID, Number) values (${GAME}, 990001, 990001, 1)`)

  return { database, SystemBodyID }
}

check('processor-inputs', 'processor rates and finish forecasts retain a dormant local construct bonus; radiation 12000 clamps research output to zero rather than a negative rate', async (w) => {
  const { database, SystemBodyID } = censusCopy()

  try {
    plantQueue(database)
    database.run('update FCT_AncientConstruct set Active = 0 where AncientConstructID = 990001')
    const dormant = await pageOn(w, database)
    const [project] = dormant.research.schedule

    assert.ok(near(project.rate, 4320), '900 * 2 * 1.6 * 1.5 = 4320 RP/year despite Active = 0')
    assert.ok(near(dormant.research.output.result.value, 4320), 'the output descendant sums the processor rate')
    const { research } = await w.modules()

    assert.ok(near(research.nextLandingResult(dormant.research.schedule, dormant.game).result.value, 0.2857638888888889), '1234.5 RP / 4320 RP/year = 0.2857638888888889 years')
    database.run(`update FCT_SystemBody set RadiationLevel = 12000 where SystemBodyID = ${SystemBodyID}`)
    const irradiated = await pageOn(w, database)

    assert.equal(irradiated.research.schedule[0].rate, 0, 'zero output is known zero, not negative or missing')
    assert.equal(irradiated.research.output.result.value, 0, 'the output descendant is zero')
    assert.equal(research.nextLandingResult(irradiated.research.schedule, irradiated.game).result.status, 'unavailable', 'zero output cannot land')
  } finally {
    database.close()
  }
})

check('production-processor', 'Production reads the processor inputs and racial field bonus, and the research completion bin uses the repaired finish', async (w) => {
  const { database, SystemBodyID } = censusCopy()

  try {
    plantQueue(database)
    const page = instantiate(await w.production(), { ...STORE, database: adapterOf(database), GameID: GAME, RaceID: RACE, data: { populationProductionModifiers: { [COLONY]: { OverallResearchModifier: 900 } }, arrivals: [] } })

    await page.runAsync('researches')
    const [job] = page.researchJobs

    assert.ok(near(job.rateResult.value, 4536), '900 * 2 * 1.6 * 1.5 * 1.05 = 4536 RP/year')
    assert.ok(near(job.days, 99.3369708994709), '1234.5 RP at 4536 RP/year takes 99.3369708994709 days')
    const { production } = await w.modules()
    const bins = production.completionBins([job], { years: 1, bins: 4 }, ['research'])

    assert.deepEqual(bins.counts.research, [0, 1, 0, 0], 'the repaired finish belongs in the second quarter')
    database.run(`update FCT_SystemBody set RadiationLevel = 12000 where SystemBodyID = ${SystemBodyID}`)
    await page.runAsync('researches')
    assert.equal(page.researchJobs[0].rateResult.value, 0, 'Production uses radiation-clamped output, not the old colony modifier')
  } finally {
    database.close()
  }
})

const researchPagesOn = async (w, database) => {
  const technologies = await pageOn(w, database)
  const production = instantiate(await w.production(), { ...STORE, database: adapterOf(database), GameID: GAME, RaceID: RACE, data: { arrivals: [] } })

  await production.runAsync('researches')

  const [project] = technologies.research.schedule

  return { technologies, production, entries: [project, ...project.queue], jobs: production.researchJobs }
}

const unknownResearchOn = async (w, database, { rates = [0, 1, 2], finishes = [0, 1, 2], missing }) => {
  const pages = await researchPagesOn(w, database)
  const { research, production } = await w.modules()

  rates.forEach((index) => {
    for (const result of [pages.entries[index].rateResult, pages.jobs[index].rateResult]) {
      assert.equal(result.status, 'unavailable', `entry ${index}: the rate must not invent a multiplier`)
      assert.ok(result.inputs.missing.some((name) => missing.test(name)), `entry ${index}: the rate names ${missing}`)
    }
  })
  finishes.forEach((index) => {
    assert.equal(pages.entries[index].yearsResult.status, 'unavailable', `entry ${index}: no Research landing is known`)
    assert.equal(pages.jobs[index].finishResult.status, 'unavailable', `entry ${index}: no Production finish is known`)
    assert.equal(pages.jobs[index].days, null, `entry ${index}: no finish day is invented`)
    assert.equal(pages.jobs[index].finishIdle, false, `entry ${index}: unknown is not idle`)
  })
  if (rates.includes(0)) {
    assert.equal(pages.technologies.research.output.result.status, 'unavailable', 'unknown running output is not summed as zero')
    const next = research.nextLandingResult(pages.technologies.research.schedule, pages.technologies.game)

    assert.equal(next.result.status, 'unavailable', 'no next landing can be claimed')
    assert.ok(next.causes.some((name) => missing.test(name)), 'the missing multiplier selection reaches the landing explanation')
  }
  const bins = production.completionBins(pages.jobs, { years: 1, bins: 4 }, ['research'])

  assert.equal(bins.skipped.unknown, finishes.length, 'unknown dates stay out of the timeline')
  assert.ok(bins.result.inputs.missing.length > 0, 'the timeline discloses excluded unknown finishes')

  return pages
}

// One orbital fixture provides a decided or undecided one-million gate for the research consumers.
const nullableCensusCopy = () => {
  const copy = censusCopy()

  copy.database.run('delete from FCT_Ship where ShipID = 990002')
  copy.database.run('delete from FCT_ShipCargo where ShipID = 990002')
  copy.database.run('update FCT_ShipCargo set Amount = 600000 where ShipID = 990001')
  copy.database.run('update FCT_ShipDesignComponents set ComponentValue = 600000 where SDComponentID = 990001')

  return copy
}

const censusRate = async (w, database, project = {}) => {
  const { research, production } = await w.modules()
  const constructs = await research.loadResearchConstructs(adapterOf(database), { GameID: GAME, RaceID: RACE })

  return production.researchRate({ ...labInputs(100), Facilities: 1, ProjectField: 3, ScientistCommandID: 1, CommanderField: 3, ActualCommanderResearchBonus: 1, ActualAnomalyBonus: 1, ...project }, research.fieldBonuses(constructs))
}

const unknownCensusWarning = async (w, database, missing) => {
  const modules = await w.modules()
  const warning = modules['warnings/space'].checks.find((one) => one.key === 'known-unexploited-constructs')
  const rows = await warning.read({ GameID: GAME, RaceID: RACE, database: adapterOf(database), count: modules['warnings/common'].counter(','), separator: ',', options: {} })

  assert.equal(rows.length, 1, 'the warning retains the unresolved construct')
  assert.ok(rows[0].unevaluated, 'neither a used nor an unused contribution is established')
  assert.ok(rows[0].unevaluated.inputs.missing.some((name) => missing.test(name)), 'the warning names the missing census selector')
}

check('census-wiring-yes', 'a decided eligible census enables the racial factor through both pages, queued finishes and the construct warning', async (w) => {
  const { database } = nullableCensusCopy()
  const modules = await w.modules()
  const warning = modules['warnings/space'].checks.find((one) => one.key === 'known-unexploited-constructs')

  try {
    database.run('update FCT_ShipCargo set Amount = 599999.5 where ShipID = 990001')
    assert.equal((await censusRate(w, database)).value, 105, 'the census decides eligibility after loading the saved people')
    plantQueue(database)
    const pages = await researchPagesOn(w, database)

    for (const [index, rate] of [4536, 2070, 4536].entries()) {
      assert.equal(pages.entries[index].rate, rate, `Technologies entry ${index} uses the eligible field factor`)
      assert.equal(pages.jobs[index].rateResult.value, rate, `Production entry ${index} uses the eligible field factor`)
      assert.ok(pages.entries[index].years > 0 && pages.jobs[index].days > 0, 'known rates retain continuous finishes')
    }
    assert.deepEqual(await warning.read({ GameID: GAME, RaceID: RACE, database: adapterOf(database), count: modules['warnings/common'].counter(','), separator: ',', options: {} }), [], 'an eligible active construct has no unused racial contribution')
  } finally {
    database.close()
  }
})

check('census-wiring-no', 'a decided ineligible census excludes the racial factor without withholding either page forecast and warns of the unused contribution', async (w) => {
  const { database } = nullableCensusCopy()
  const modules = await w.modules()
  const warning = modules['warnings/space'].checks.find((one) => one.key === 'known-unexploited-constructs')

  try {
    database.run('update FCT_ShipClass set ArkShip = 0 where ShipClassID = 990001')
    assert.equal((await censusRate(w, database)).value, 100, 'an ineligible colony adds no racial factor')
    plantQueue(database)
    const pages = await researchPagesOn(w, database)

    for (const [index, rate] of [4320, 2070, 4320].entries()) {
      assert.equal(pages.entries[index].rate, rate, `Technologies entry ${index} has no racial addition`)
      assert.equal(pages.jobs[index].rateResult.value, rate, `Production entry ${index} has no racial addition`)
      assert.ok(pages.entries[index].years > 0 && pages.jobs[index].days > 0, 'ineligibility is not an unavailable rate')
    }
    const rows = await warning.read({ GameID: GAME, RaceID: RACE, database: adapterOf(database), count: modules['warnings/common'].counter(','), separator: ',', options: {} })

    assert.equal(rows.length, 1, 'the known unused contribution warns')
    assert.equal(rows[0].unevaluated, undefined, 'the warning is evaluated, not unknown')
    assert.match(rows[0].cells.blocker, /1 million/, 'the warning states its consumer threshold')
  } finally {
    database.close()
  }
})

check('census-wiring-undecided', 'an undecided census leaves both page rates, queued finishes, aggregates and the construct warning honestly unavailable', async (w) => {
  const { database } = nullableCensusCopy()

  try {
    database.run('update FCT_ShipClass set ArkShip = null where ShipClassID = 990001')
    const unknown = await censusRate(w, database)

    assert.equal(unknown.status, 'unavailable', 'an undecided gate cannot choose a racial factor')
    assert.ok(unknown.inputs.missing.some((name) => /Ark/.test(name)), 'the census cause reaches the rate')
    plantQueue(database)
    await unknownResearchOn(w, database, { rates: [0, 2], missing: /Ark/ })
    await unknownCensusWarning(w, database, /Ark/)
  } finally {
    database.close()
  }
})

check('construct-race', 'an eligible colony of unknown race cannot supply a known racial factor or a known unused-contribution verdict', async (w) => {
  const { database } = nullableCensusCopy()

  try {
    database.run(`update FCT_Population set RaceID = null, Population = 1 where PopulationID = ${COLONY}`)
    const rate = await censusRate(w, database)

    assert.equal(rate.status, 'unavailable', 'eligibility does not decide the colony race')
    assert.ok(rate.inputs.missing.some((name) => /race.*colony/.test(name)), 'the rate names the unknown colony race')
    await unknownCensusWarning(w, database, /race.*colony/)
  } finally {
    database.close()
  }
})

check('consumer-invariant-rate', 'an unknown population gate does not withhold a known zero research rate or a neutral field contribution', async (w) => {
  const { database } = nullableCensusCopy()
  const { research } = await w.modules()

  try {
    database.run('update FCT_ShipClass set ArkShip = null where ShipClassID = 990001')
    assert.equal((await censusRate(w, database, { ResearchBase: 0 })).value, 0, 'no research output is zero under both Ark completions')
    const constructs = await research.loadResearchConstructs(adapterOf(database), { GameID: GAME, RaceID: RACE })
    const project = { ...labInputs(0), Facilities: 1, CommanderID: 1, ResearchBonus: 1, ScientistField: 3 }

    assert.equal(research.annualResearchPointsResult(project, 3, research.fieldBonuses(constructs)).value, 0, 'Technologies also retains the invariant zero rate')
    database.run('update FCT_AncientConstruct set ResearchBonus = 1, ResearchField = null where AncientConstructID = 990001')
    assert.equal((await censusRate(w, database)).value, 100, 'a neutral contribution is neutral whatever its eligibility or field')
  } finally {
    database.close()
  }
})

check('unknown-local-field', 'a present dormant local construct with no field makes running and queued rates and their descendants unknown, but an absent row is neutral', async (w) => {
  const { database } = censusCopy()

  try {
    plantQueue(database)
    database.run('update FCT_AncientConstruct set Active = 0, ResearchField = null where AncientConstructID = 990001')
    await unknownResearchOn(w, database, { missing: /construct.*field|field.*construct/ })
    database.run('delete from FCT_AncientConstruct where AncientConstructID = 990001')
    const absent = await researchPagesOn(w, database)

    assert.ok(near(absent.entries[0].rate, 2880), 'no local construct: 900 * 2 * 1.6 = 2880 RP/year')
    assert.ok(near(absent.jobs[0].rateResult.value, 2880), 'Production also uses a genuinely absent construct as neutral')
    assert.ok(absent.jobs.every((job) => job.days !== null), 'absence leaves known finish dates, unlike an unknown field')
  } finally {
    database.close()
  }
})

check('unknown-null-bonuses', 'present null construct and scientist bonuses are unknown, while a genuinely absent bonus row keeps the neutral game default', async (w) => {
  const { database } = censusCopy()

  try {
    plantQueue(database)
    database.run('update FCT_AncientConstruct set Active = 0, ResearchBonus = null where AncientConstructID = 990001')
    const construct = await unknownResearchOn(w, database, { rates: [0, 2], missing: /bonus/ })

    assert.ok(near(construct.entries[1].rate, 2070), 'a known different field does not use the null local bonus')
    assert.ok(near(construct.jobs[1].rateResult.value, 2070), 'Production also leaves the known nonmatching field rate available')
    database.run('update FCT_AncientConstruct set ResearchField = 8 where AncientConstructID = 990001')
    await unknownResearchOn(w, database, { rates: [1], finishes: [1, 2], missing: /bonus/ })
    database.run('update FCT_AncientConstruct set ResearchField = 3, ResearchBonus = 1.5 where AncientConstructID = 990001')
    database.run(`update FCT_CommanderBonuses set BonusValue = null where CommanderID = ${SCIENTIST} and BonusID = 3`)
    await unknownResearchOn(w, database, { missing: /scientist.*bonus/ })
    database.run(`delete from FCT_CommanderBonuses where CommanderID = ${SCIENTIST} and BonusID = 3`)
    const absentBonus = await researchPagesOn(w, database)

    assert.ok(near(absentBonus.entries[0].rate, 2700), 'absent percentage bonus row: 900 * 2 * 1 * 1.5 = 2700 RP/year')
    assert.ok(near(absentBonus.jobs[0].rateResult.value, 2700), 'Production distinguishes absent bonus from present null')
    assert.ok(absentBonus.jobs.every((job) => job.days !== null), 'the absent-row default leaves known forecasts')
    database.run(`update FCT_Commander set CommandID = 0 where CommanderID = ${SCIENTIST}`)
    const unstaffed = await researchPagesOn(w, database)

    assert.equal(unstaffed.entries[0].rateResult.status, 'unavailable', 'Technologies does not forecast unstaffed progress')
    assert.ok(near(unstaffed.jobs[0].rateResult.value, 2700), 'Production retains its explicit neutral no-scientist planning assumption')
    assert.ok(unstaffed.jobs[0].rateResult.assumptions.some((text) => text.includes('No scientist')), 'the planner assumption is disclosed')
  } finally {
    database.close()
  }
})

check('unknown-selection-fields', 'missing project, queue or assigned scientist fields cannot select neutral racial, specialty or local multipliers', async (w) => {
  const { production } = await w.modules()
  const rate = production.researchRate({ ...labInputs(100), Facilities: 1, ProjectField: null, ActualCommanderResearchBonus: 1, ActualAnomalyBonus: 1 }, { 3: 1.2 })

  assert.equal(rate.status, 'unavailable', '100 RP/year cannot be known when an unstored field could select the racial ×1.2')
  assert.ok(rate.inputs.missing.some((name) => /field/.test(name)), 'the missing project field is named')
  const { database } = censusCopy()

  try {
    plantQueue(database)
    database.run('update FCT_AncientConstruct set Active = 0 where AncientConstructID = 990001')
    database.run(`update FCT_ResearchProject set ResSpecID = null where ProjectID = ${PROJECT}`)
    const current = await unknownResearchOn(w, database, { rates: [0], missing: /field/ })

    assert.ok(near(current.jobs[1].rateResult.value, 2070), 'the queued tech still selects its own known field, but cannot start at a known time')
    database.run(`update FCT_ResearchProject set ResSpecID = ${FIELD} where ProjectID = ${PROJECT}`)
    database.run(`update DIM_TechType set FieldID = null where TechTypeID = (select TechTypeID from FCT_TechSystem where TechSystemID = ${QUEUED[0].tech})`)
    await unknownResearchOn(w, database, { rates: [1], finishes: [1, 2], missing: /field/ })
    database.run(`update DIM_TechType set FieldID = 8 where TechTypeID = (select TechTypeID from FCT_TechSystem where TechSystemID = ${QUEUED[0].tech})`)
    database.run(`update FCT_Commander set ResSpecID = null where CommanderID = ${SCIENTIST}`)
    const specialty = await unknownResearchOn(w, database, { missing: /scientist.*field/ })

    assert.ok(specialty.jobs.every((job) => !job.rateResult.assumptions.some((text) => text.includes('No scientist'))), 'an assigned scientist with an unknown specialty is not an absent scientist')
  } finally {
    database.close()
  }
})

check('construct-warning', 'the warning describes only the unused racial contribution, with a tenth-sized field bonus and a distinct dormant local multiplier', async (w) => {
  const { database } = censusCopy()
  const modules = await w.modules()
  const warning = modules['warnings/space'].checks.find((one) => one.key === 'known-unexploited-constructs')
  const ctx = { GameID: GAME, RaceID: RACE, database: adapterOf(database), count: modules['warnings/common'].counter(','), separator: ',', options: {} }

  try {
    database.run('delete from FCT_Ship where FleetID = 990001')
    database.run(`update FCT_Population set Population = 0.5 where PopulationID = ${COLONY}`)
    const lacking = await warning.read(ctx)

    assert.equal(lacking.length, 1, 'a known ineligible colony leaves an unused contribution')
    assert.match(lacking[0].cells.blocker, /1 million/, 'the blocker names the one-million threshold')
    assert.match(lacking[0].cells.bonus, /^5% field-wide/, 'a local +50% construct contributes +5% to the racial field factor')
    database.run(`update FCT_Population set Population = 2 where PopulationID = ${COLONY}`)
    assert.deepEqual(await warning.read(ctx), [], 'the 2 M counterexample is not falsely reported as unused')
    database.run('update FCT_AncientConstruct set Active = 0 where AncientConstructID = 990001')
    const dormant = await warning.read(ctx)

    assert.equal(dormant.length, 1, 'a dormant construct does not contribute the racial factor')
    assert.match(modules.provenance.getRule('warnings.knownUnexploitedConstructs').note, /local.*dormant|dormant.*local/, 'the explanation distinguishes the processor local bonus from the unused racial contribution')
  } finally {
    database.close()
  }
})

check('research-descendants', 'output and next landing keep the rate and all compared landing assumptions, including a project that is not the winner', async (w) => {
  const { research, provenance } = await w.modules()
  const project = { ...labInputs(100), Facilities: 1, CommanderID: 1, ResearchBonus: 1, ScientistField: 3, FieldID: 3, ResearchPointsRequired: 100, Pause: 0 }
  const schedule = research.scheduleProjects([{ ...project, ProjectID: 1, Name: 'First' }, { ...project, ProjectID: 2, Name: 'Later', ResearchPointsRequired: 200 }], [], new Map())
  const later = schedule[1]

  later.rateResult = provenance.ofRule({ rule: 'research.projectRate', value: 100, assumptions: ['The later project uses the current lab assignment'] })
  later.yearsResult = provenance.ofRule({ rule: 'research.landing', value: 2, assumptions: ['The later project keeps its scientist'] })
  const output = research.outputResult(schedule)
  const next = research.nextLandingResult(schedule, { StartYear: 2000, GameTime: 0 })

  assert.equal(output.result.value, 200, 'the two project rates sum to 200 RP/year')
  assert.ok(output.result.assumptions.includes('The later project uses the current lab assignment'), 'the total keeps each contributing rate assumption')
  assert.equal(next.project.ProjectID, 1, 'the first project lands sooner')
  assert.equal(next.result.value, 1, '100 RP at 100 RP/year is one year')
  assert.ok(next.result.assumptions.includes('The later project keeps its scientist'), 'the minimum depends on every compared landing, not just its winner')
})

check('constructs-aggregation', 'every eligible colony contributes its construct addition to the racial field factor', async (w) => {
  const { research } = await w.modules()

  assert.ok(near(research.fieldBonuses([{ FieldID: 3, ResearchBonus: 1.5 }, { FieldID: 3, ResearchBonus: 2 }])[3], 1.15), 'both eligible colonies add to the field factor: 1 + .05 + .1 = 1.15')
})

check('decimal-annual-rate', 'decimal annual RP preserves an exact one-year finish and its comparison at the last timeline-bin boundary', async (w) => {
  const { research, production } = await w.modules()
  const rate = production.researchRate({ ...labInputs(0.1), Facilities: 3, ProjectField: 3, ScientistCommandID: 1, CommanderField: 3, ActualCommanderResearchBonus: 1, ActualAnomalyBonus: 1 })
  const finish = production.finishDays({ rule: 'production.researchFinish', rate, remaining: 0.3, remainingName: '0.3 RP' })
  const bins = production.completionBins([{ type: 'research', days: finish.result.value, finishIdle: false }], { years: 1, bins: 4 }, ['research'])

  assert.equal(bins.later, 1, '0.3 RP at decimal 0.3 RP/year lands at day 365, not just before the one-year boundary')
  assert.deepEqual(bins.counts.research, [0, 0, 0, 0], 'an exact year belongs after all four quarterly bins')
  assert.equal(rate.value, 0.3, 'the annual rate is decimal 0.1 × 3, not binary 0.30000000000000004')
  assert.equal(finish.result.value, 365, 'the comparison uses an exact 365-day finish')
  const project = { ProjectID: 1, ...labInputs(0.1), Facilities: 3, CommanderID: 1, ResearchBonus: 1, ScientistField: 3, FieldID: 3, ResearchPointsRequired: 0.3, Pause: 0 }
  const [scheduled] = research.scheduleProjects([project], [], new Map())

  assert.equal(scheduled.rate, 0.3, 'Technologies uses the same decimal annual product')
  assert.equal(scheduled.years, 1, 'Technologies keeps the exact one-year landing')
})

check('decimal-per-lab-pages', 'both page reads preserve decimal per-lab products through their one-year finish and timeline boundary, with neutral and nontrivial-factor controls', async (w) => {
  const { production } = await w.modules()
  // The decimal square of 0.123456789012345 is 0.015241578753238669120562399; its nearest displayed rate is 0.01524157875323867, not a floating product converted afterwards.
  const cases = [
    { name: 'Terra per-lab counterexample', species: 0.123456789012345, base: 1, economic: 0.123456789012345, efficiency: 1, radiation: 0, unrest: 0, political: 1, speed: 100, rate: 0.01524157875323867 },
    { name: 'neutral stored factors', species: 1, base: 1, economic: 1, efficiency: 1, radiation: 0, unrest: 0, political: 1, speed: 100, rate: 1 },
    { name: 'every factor and a non-default speed', species: 0.1, base: 100, economic: 0.2, efficiency: 0.3, radiation: 5000, unrest: 75, political: 0.8, speed: 29, rate: 0.0174 },
  ]

  for (const example of cases) {
    const database = new Database(fs.readFileSync(path.join(root, SAVE)))

    try {
      plantQueue(database)
      const [{ SpeciesID, SystemBodyID, PoliticalStatus }] = rowsOf(database, `select SpeciesID, SystemBodyID, PoliticalStatus from FCT_Population where PopulationID = ${COLONY}`)

      database.run(`delete from FCT_AncientConstruct where GameID = ${GAME}`)
      database.run(`update FCT_Species set ResearchRateModifier = ${example.species} where SpeciesID = ${SpeciesID}`)
      database.run(`update FCT_Race set Research = ${example.base}, EconomicProdModifier = ${example.economic} where RaceID = ${RACE}`)
      database.run(`update FCT_Population set Efficiency = ${example.efficiency}, UnrestPoints = ${example.unrest} where PopulationID = ${COLONY}`)
      database.run(`update FCT_SystemBody set RadiationLevel = ${example.radiation} where SystemBodyID = ${SystemBodyID}`)
      database.run(`update DIM_PopPoliticalStatus set ProductionMod = ${example.political} where StatusID = ${PoliticalStatus}`)
      database.run(`update FCT_Game set ResearchSpeed = ${example.speed} where GameID = ${GAME}`)
      database.run(`update FCT_CommanderBonuses set BonusValue = 1 where CommanderID = ${SCIENTIST} and BonusID = 3`)
      database.run(`update FCT_ResearchProject set Facilities = 1, ResearchPointsRequired = ${example.rate} where ProjectID = ${PROJECT}`)
      database.run(`update FCT_TechSystem set DevelopCost = ${example.rate} where TechSystemID in (${QUEUED.map((entry) => entry.tech).join(', ')})`)
      database.run(`delete from FCT_PausedResearch where GameID = ${GAME} and RaceID = ${RACE}`)
      const pages = await researchPagesOn(w, database)

      pages.entries.forEach((entry, index) => {
        assert.equal(entry.rate, example.rate, `${example.name}: Technologies entry ${index} keeps the decimal product`)
        assert.equal(entry.years, index + 1, `${example.name}: Technologies entry ${index} lands on its exact year`)
      })
      pages.jobs.forEach((job, index) => {
        assert.equal(job.rateResult.value, example.rate, `${example.name}: Production entry ${index} keeps the decimal product`)
        assert.equal(job.days, 365 * (index + 1), `${example.name}: Production entry ${index} lands on its exact year`)
        const bins = production.completionBins([job], { years: index + 1, bins: 4 }, ['research'])

        assert.equal(bins.later, 1, `${example.name}: the exact finish stays after the last timeline bin`)
        assert.deepEqual(bins.counts.research, [0, 0, 0, 0], `${example.name}: no rounded-down finish enters the timeline`)
      })
    } finally {
      database.close()
    }
  }
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
  // Saved progress keeps a tech listed unless it is researched, running, queued or belongs to an ineligible foreign empire.
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

// The independently written catalogue predicate includes baseline, own-race and eligible alien technologies. Saved progress keeps a blocked technology listed; otherwise it needs researched prerequisites and cannot be ruin-only. Shield filtering and prototypes are not modelled.
const RESEARCHED_SQL = `select TechID from FCT_RaceTech where GameID = ${GAME} and RaceID = ${RACE}`
const SAVED_SQL = `select TechSystemID from FCT_PausedResearch where GameID = ${GAME} and RaceID = ${RACE}`
const ELIGIBLE_SQL = `select TechSystemID from FCT_EligibleProjects where GameID = ${GAME} and RaceID = ${RACE}`
const RUNNING_SQL = `select TechID from FCT_ResearchProject where GameID = ${GAME} and RaceID = ${RACE}`
const QUEUED_SQL = `select TechSystemID from FCT_ResearchQueue where GameID = ${GAME} and PopulationID in (select PopulationID from FCT_Population where GameID = ${GAME} and RaceID = ${RACE})`

const gameList = (database) => new Set(rowsOf(database, `select t.TechSystemID as ID from FCT_TechSystem as t where t.GameID in (0, ${GAME}) and (t.RaceID = 0 or t.RaceID = ${RACE} or t.TechSystemID in (${ELIGIBLE_SQL})) and (t.RuinOnly = 0 or t.TechSystemID in (${SAVED_SQL})) and (t.Prerequisite1 = 0 or t.Prerequisite1 in (${RESEARCHED_SQL}) or t.TechSystemID in (${SAVED_SQL})) and (t.Prerequisite2 = 0 or t.Prerequisite2 in (${RESEARCHED_SQL}) or t.TechSystemID in (${SAVED_SQL})) and t.TechSystemID not in (${RESEARCHED_SQL}) and t.TechSystemID not in (${RUNNING_SQL}) and t.TechSystemID not in (${QUEUED_SQL})`).map((row) => row.ID))

// The techs the race has researched that sit in a field the page shows, straight from its FCT_RaceTech rows.
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

  for (const id of ['research.remaining', 'research.landing', 'research.projectRate', 'research.output', 'research.nextLanding', 'production.researchRate', 'production.researchFinish', 'warnings.knownUnexploitedConstructs']) {
    const rule = provenance.getRule(id)

    assert.ok(rule, `${id} is registered`)
    assert.deepEqual(rule.versions, ['3.2.x'], `${id} is registered for the line`)
  }
  assert.deepEqual(provenance.getRule('production.timeline').versions, ['2.7.x'], 'the broad timeline remains held for the other formula families')

  assert.ok(/saved points are read as stored, decimals included, and the cost is the stored one whatever its size/.test(provenance.getRule('research.remaining').note), 'the remaining RP rule says what it reads')
  assert.ok(/The game hands the part of a landing increment the project does not need to the next queued tech at that tech's own rate/.test(provenance.getRule('research.landing').note), 'the landing rule says how the game carries')
  assert.ok(/first increment at or after it/.test(provenance.getRule('research.landing').note), 'and where it lands')
  assert.ok(/for a queued tech the stored development cost less the points saved on it\. The development cost is the stored one: the game floors it at the build cost when it sets it, so the figure is never recomputed here/.test(provenance.getRule('production.researchFinish').note), 'the Production research finish uses the stored development cost, floored by the game at build cost')
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
  { name: 'Technologies restores the floating-point per-lab query product', target: 'technologiesPage', from: 'FCT_Species.ResearchRateModifier, FCT_Race.Research as ResearchBase, FCT_Race.EconomicProdModifier, FCT_Population.Efficiency, FCT_SystemBody.RadiationLevel, FCT_Population.UnrestPoints, DIM_PopPoliticalStatus.ProductionMod, FCT_Game.ResearchSpeed', to: 'FCT_Species.ResearchRateModifier * FCT_Race.Research * FCT_Race.EconomicProdModifier * FCT_Population.Efficiency * max(0, 1 - FCT_SystemBody.RadiationLevel / 10000.0) * (1 - FCT_Population.UnrestPoints / 100.0) * DIM_PopPoliticalStatus.ProductionMod * (FCT_Game.ResearchSpeed / 100.0) as ResearchRateModifier, 1 as ResearchBase, 1 as EconomicProdModifier, 1 as Efficiency, 0 as RadiationLevel, 0 as UnrestPoints, 1 as ProductionMod, 100 as ResearchSpeed', fails: ['decimal-per-lab-pages'] },
  { name: 'Production restores the floating-point per-lab query product', target: 'productionPage', from: 'FCT_Species.ResearchRateModifier, FCT_Race.Research as ResearchBase, FCT_Race.EconomicProdModifier, FCT_Population.Efficiency, FCT_SystemBody.RadiationLevel, FCT_Population.UnrestPoints, DIM_PopPoliticalStatus.ProductionMod, FCT_Game.ResearchSpeed', to: 'FCT_Species.ResearchRateModifier * FCT_Race.Research * FCT_Race.EconomicProdModifier * FCT_Population.Efficiency * max(0, 1 - FCT_SystemBody.RadiationLevel / 10000.0) * (1 - FCT_Population.UnrestPoints / 100.0) * DIM_PopPoliticalStatus.ProductionMod * (FCT_Game.ResearchSpeed / 100.0) as ResearchRateModifier, 1 as ResearchBase, 1 as EconomicProdModifier, 1 as Efficiency, 0 as RadiationLevel, 0 as UnrestPoints, 1 as ProductionMod, 100 as ResearchSpeed', fails: ['decimal-per-lab-pages'] },
  { name: 'the per-lab decimal product passes through double before multiplying speed', target: 'research', from: 'return decimal.multiply(output, decimal.fromDouble(project.ResearchSpeed / 100.0))', to: 'return decimal.multiply(decimal.fromDouble(decimal.toDouble(output)), decimal.fromDouble(project.ResearchSpeed / 100.0))', fails: ['decimal-per-lab-pages'] },
  { name: 'research discards the shared census input', target: 'research', from: 'const population = totals.get(row.PopulationID)', to: 'const population = null', fails: ['census-wiring-yes'] },
  { name: 'research treats an undecided census as eligible', target: 'research', from: 'const gate = population ? valueOrNull(population.millionEligible) : null', to: 'const gate = population ? valueOrNull(population.millionEligible) !== false : null', fails: ['census-wiring-undecided'] },
  { name: 'research ignores the census colony race', target: 'research', from: 'population && population.raceMatches === true ? gate : null', to: 'population ? gate : null', fails: ['construct-race'] },
  { name: 'research treats a decided ineligible census as eligible', target: 'research', from: 'const eligible = gate === false ? false', to: 'const eligible = gate === false ? true', fails: ['census-wiring-no'] },
  { name: 'the construct warning discards the shared census input', target: 'space', from: 'const census = populationsById.get(row.PopulationID)', to: 'const census = null', fails: ['census-wiring-yes'] },
  { name: 'the construct warning treats an undecided census as ineligible', target: 'space', from: 'const gate = census ? valueOrNull(census.millionEligible) : null', to: 'const gate = census ? valueOrNull(census.millionEligible) || false : null', fails: ['census-wiring-undecided'] },
  { name: 'the construct warning ignores the census colony race', target: 'space', from: 'census && census.raceMatches === true && gate === true', to: 'census && gate === true', fails: ['construct-race'] },
  { name: 'the construct warning treats a decided ineligible census as eligible', target: 'space', from: 'const population = gate === false ? 0', to: 'const population = gate === false ? 1', fails: ['census-wiring-no'] },
  { name: 'Production withholds an invariant zero rate for a missing census', target: 'production', from: 'const zeroOutput = (outputPerLab !== null && outputPerLab.m === 0n) || project.Facilities === 0', to: 'const zeroOutput = false', fails: ['consumer-invariant-rate'] },
  { name: 'Technologies withholds an invariant zero rate for a missing census', target: 'research', from: 'const zeroOutput = (outputPerLab !== null && outputPerLab.m === 0n) || project.Facilities === 0', to: 'const zeroOutput = false', fails: ['consumer-invariant-rate'] },
  { name: 'a neutral contribution with unknown field poisons every field', target: 'research', from: 'if (row.ResearchBonus === 1)', to: 'if (false)', fails: ['consumer-invariant-rate'] },
  { name: 'Production annual RP reverts to binary multiplication', target: 'production', from: 'researchAnnualRate({ outputPerLab, facilities: project.Facilities, scientist: project.ActualCommanderResearchBonus, local: project.ActualAnomalyBonus, racial: fieldBonus })', to: 'project.ActualCommanderResearchBonus * project.ActualAnomalyBonus * fieldBonus * (Number(outputPerLab.m) / 10 ** outputPerLab.s) * project.Facilities', fails: ['decimal-annual-rate'] },
  { name: 'Technologies annual RP reverts to binary multiplication', target: 'research', from: 'researchAnnualRate({ outputPerLab, facilities: project.Facilities, scientist: researchMultiplier(project.ResearchBonus, project.ScientistField === fieldId), local, racial: fieldBonus })', to: 'decimal.toNumber(outputPerLab) * project.Facilities * researchMultiplier(project.ResearchBonus, project.ScientistField === fieldId) * local * fieldBonus', fails: ['decimal-annual-rate'] },
  { name: 'Technologies loses present local construct identity', target: 'technologiesPage', from: 'FCT_AncientConstruct.AncientConstructID as LocalConstructID', to: 'null as LocalConstructID', fails: ['unknown-local-field'] },
  { name: 'Production loses present local construct identity', target: 'productionPage', from: 'FCT_AncientConstruct.AncientConstructID as AnomalyID', to: 'null as AnomalyID', fails: ['unknown-local-field'] },
  { name: 'Technologies treats unknown local field as a definite nonmatch', target: 'research', from: 'project.LocalConstructID != null', to: 'false', fails: ['unknown-local-field'] },
  { name: 'Production treats unknown local field as a definite nonmatch', target: 'production', from: 'if (project.AnomalyID != null && !isNumber(project.AnomalyField))', to: 'if (false)', fails: ['unknown-local-field'] },
  { name: 'Production launders a present null local bonus to one', target: 'productionPage', from: 'then FCT_AncientConstruct.ResearchBonus else 1 end as ActualAnomalyBonus', to: 'then coalesce(FCT_AncientConstruct.ResearchBonus, 1) else 1 end as ActualAnomalyBonus', fails: ['unknown-null-bonuses'] },
  { name: 'Production launders a present null scientist bonus to one', target: 'productionPage', from: 'else FCT_CommanderBonuses.BonusValue end as CommanderBonus', to: 'else coalesce(FCT_CommanderBonuses.BonusValue, 1) end as CommanderBonus', fails: ['unknown-null-bonuses'] },
  { name: 'the queued raw scientist bonus launders null to one', target: 'productionPage', from: 'else VIR_ResearchBonus.CommanderBonus end as CommanderBonus', to: 'else coalesce(VIR_ResearchBonus.CommanderBonus, 1) end as CommanderBonus', fails: ['unknown-null-bonuses'] },
  { name: 'the running scientist bonus launders null to one', target: 'productionPage', from: 'case when VIR_ResearchBonus.CommandID is null then 1 when VIR_ResearchBonus.CommanderField = FCT_ResearchProject.ResSpecID then VIR_ResearchBonus.CommanderBonus * 4 - 3 else VIR_ResearchBonus.CommanderBonus end as ActualCommanderResearchBonus', to: 'coalesce(case when VIR_ResearchBonus.CommandID is null then 1 when VIR_ResearchBonus.CommanderField = FCT_ResearchProject.ResSpecID then VIR_ResearchBonus.CommanderBonus * 4 - 3 else VIR_ResearchBonus.CommanderBonus end, 1) as ActualCommanderResearchBonus', fails: ['unknown-null-bonuses'] },
  { name: 'an absent percentage bonus row is incorrectly zero', target: 'productionPage', from: 'case when FCT_CommanderBonuses.CommanderID is null then 1', to: 'case when FCT_CommanderBonuses.CommanderID is null then 0', fails: ['unknown-null-bonuses'] },
  { name: 'Production selects neutral racial bonus for an unknown tech field', target: 'production', from: 'if (!isNumber(project.ProjectField))', to: 'if (false)', fails: ['unknown-selection-fields'] },
  { name: 'Production confuses an unknown specialty with no scientist', target: 'production', from: 'if (project.ScientistCommandID != null && !isNumber(project.CommanderField))', to: 'if (false)', fails: ['unknown-selection-fields'] },
  { name: 'Production loses the racial field multiplier', target: 'production', from: 'racial: fieldBonus', to: 'racial: 1', fails: ['production-field', 'production-queued-field', 'production-processor'] },
  { name: 'the queued specialty follows the running project field', target: 'production', from: 'project.CommanderField === queue.ProjectField', to: 'project.ProjectField === queue.ProjectField', fails: ['production-queued-field'] },
  { name: 'the queued local construct follows the running project field', target: 'production', from: 'project.AnomalyField === queue.ProjectField', to: 'project.ProjectField === queue.ProjectField', fails: ['production-queued-field'] },
  { name: 'the queue keeps the old racial field', target: 'production', from: 'ProjectField: queue.ProjectField,', to: 'ProjectField: project.ProjectField,', fails: ['production-queued-field'] },
  { name: 'Technologies drops the dormant local processor bonus', target: 'technologiesPage', from: 'and FCT_AncientConstruct.GameID = FCT_ResearchProject.GameID\n', to: 'and FCT_AncientConstruct.GameID = FCT_ResearchProject.GameID and FCT_AncientConstruct.Active = 1\n', fails: ['processor-inputs'] },
  { name: 'both pages leave radiation production negative', target: 'research', from: 'decimal.negative(radiation) ? decimal.ZERO : radiation', to: 'radiation', fails: ['processor-inputs', 'production-processor'] },
  { name: 'racial field additions lose their tenth factor', target: 'research', from: '(row.ResearchBonus - 1) / 10', to: '(row.ResearchBonus - 1)', fails: ['constructs-aggregation', 'production-processor'] },
  { name: 'the construct warning retains the ten-million gate', target: 'space', from: 'population !== null && population >= 1', to: 'population !== null && population >= 10', fails: ['construct-warning'] },
  { name: 'the warning displays the local bonus as racial', target: 'space', from: '(bonus - 1) * 10', to: '(bonus - 1) * 100', fails: ['construct-warning'] },
  { name: 'output erases the contributing rate assumptions', target: 'research', from: 'project.rateResult])), compute: (values) => Object.values(values).reduce', to: 'ofRule({ rule: RATE_RULE, value: project.rate })])), compute: (values) => Object.values(values).reduce', fails: ['research-descendants'] },
  { name: 'the next landing erases the losing alternatives', target: 'research', from: 'parts: Object.fromEntries(dated.map((project, index) => [`project ${index + 1}`, project.yearsResult]))', to: 'parts: { winner: best.yearsResult }', fails: ['research-descendants'] },
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
  { name: 'the construct tenth written as a decimal multiplication', target: 'research', from: '(row.ResearchBonus - 1) / 10', to: '(row.ResearchBonus - 1) * 0.1' },
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
