/*
  Checks the race's tech as the planners read it (utilities/race-tech.js, utilities/tech-scenarios.js) and the propulsion page's use of it (pages/propulsion.vue): the level the game designs with, the levels the race has researched, the techs it could research next, a choice of one of them as a hypothetical level, the results that choice makes hypothetical, and the record that keeps the choice for the race and branch (utilities/scenario-records.js).

  node scripts/check-race-tech.js [--stock <save.db> <GameID> <RaceID>] [--modded <save.db> <GameID> <RaceID>] [--no-mutations]

  Groups:
  - the game's pick: the researched level with the highest development cost (never the highest or lowest figure), so fuel consumption and thermal reduction default to the lowest figure when research followed the figure, and a race whose development order and figures disagree still gets the highest cost; every lower level, and every baseline row, stays selectable;
  - candidates: the techs the race has not researched and could, with the status of the research graph; one with a missing prerequisite is locked and says what it lacks, a ruin-only, another empire's or unreachable one is excluded, an unknown cost stays unknown, and the next level is the cheapest one researchable now;
  - choices: a researched level is the race's own tech, a candidate is hypothetical, and a choice the save cannot honour (a deleted tech, a reused ID, a level that is not on the line, one the race cannot research) is unresolved with its reason and the line uses the game's pick, never another level;
  - marking: a result built on a hypothetical level carries the assumption and is never confirmed (an estimate stays an estimate), an unavailable result stays without a value;
  - the record: a choice kept for the race and branch survives a reload, its link names the tech with a fingerprint, another race, branch or campaign sees none of it, a save rewound before it does not apply it, a tab that does not hold the file writes nothing, and a stale edit is reconciled;
  - the page: its tech lines, its results, its menu and its notices on a pseudo instance (scripts/lib/page-loader.js);
  - each save: the pick of every line against SQL, the registry against DIM_TechType and against the saves' levels, the candidates against an independent reading of the research tables, and the reactor and armour figures the registry's meaning of a tech type rests on.

  Mutants: each deliberate fault in a copy of the utilities (or of the page's script) is run with the checks it names and must fail them. Prints `N of N checks passed`; exit code 1 when a check fails.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadUtilities } = require('./lib/utilities')
const { instantiate, loadPage, replacing } = require('./lib/page-loader')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'electron-store': 'export default class {}',
}

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 260 ? `${text.slice(0, 260)}…` : text
}

const equal = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

const same = (actual, expected) => equal(actual, expected) || `${short(actual)} != ${short(expected)}`

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const drain = (iterator) => {
  let step

  do {
    step = iterator.next()
  } while (!step.done)

  return step.value
}

// A check that throws has not held, and says so.
const settle = async (test) => {
  try {
    return await test()
  } catch (error) {
    return `threw ${error.message}`
  }
}

const loadAll = async (directory = utilitiesDirectory) => {
  const loaded = await loadUtilities(['race-tech', 'tech-scenarios', 'provenance', 'scenario-records'], { stubs: STUBS, directory })

  return { rt: loaded['race-tech'], ts: loaded['tech-scenarios'], pv: loaded.provenance, sr: loaded['scenario-records'] }
}

// ---------- the synthetic race ----------

const ENGINE = 40
const FUEL = 65
const REACTOR = 41
const JUMP_EFFICIENCY = 8

const researchedRow = (id, typeId, name, cost, info, info2 = null) => ({ TechSystemID: id, GameID: 0, TechTypeID: typeId, Name: name, ComponentName: name, AdditionalInfo: info, AdditionalInfo2: info2, DevelopCost: cost })

const catalogueRow = (id, typeId, name, cost, info, extra = {}) => ({ TechSystemID: id, GameID: 0, Name: name, ComponentName: name, TechDescription: '', DevelopCost: cost, RaceID: 0, Prerequisite1: 0, Prerequisite2: 0, RuinOnly: 0, AutomaticResearch: 0, StartingSystem: 0, ConventionalSystem: 0, TechTypeID: typeId, AdditionalInfo: info, AdditionalInfo2: null, TypeName: `Type ${typeId}`, FieldID: 1, ...extra })

const RACE = 7

// The race researched two engines, three fuel levels out of order (the 0.7 level cost more to develop than the 0.5 one), and one jump efficiency.
const RESEARCHED_ROWS = [
  researchedRow(9, ENGINE, 'Engine 0', 40, 3),
  researchedRow(10, ENGINE, 'Engine A', 100, 5),
  researchedRow(61, FUEL, 'Fuel 1.0', 100, 1),
  researchedRow(63, FUEL, 'Fuel 0.5', 200, 0.5),
  researchedRow(62, FUEL, 'Fuel 0.7', 300, 0.7),
  researchedRow(80, JUMP_EFFICIENCY, 'Jump 1', 100, 4),
]

const CATALOGUE = [
  catalogueRow(9, ENGINE, 'Engine 0', 40, 3),
  catalogueRow(10, ENGINE, 'Engine A', 100, 5),
  catalogueRow(11, ENGINE, 'Engine B', 200, 8, { Prerequisite1: 10 }),
  catalogueRow(12, ENGINE, 'Engine C', 150, 9, { Prerequisite1: 13 }),
  catalogueRow(13, ENGINE, 'Engine D', 500, 12, { Prerequisite1: 10 }),
  catalogueRow(14, ENGINE, 'Engine ruin', 120, 20, { RuinOnly: 1 }),
  catalogueRow(15, ENGINE, 'Engine foreign', 130, 6, { RaceID: 99 }),
  catalogueRow(16, ENGINE, 'Engine alien', 250, 7, { RaceID: 99 }),
  catalogueRow(17, ENGINE, 'Engine needs ruin', 260, 7, { Prerequisite1: 14 }),
  catalogueRow(18, ENGINE, 'Engine active', 300, 9, { Prerequisite1: 10 }),
  catalogueRow(19, ENGINE, 'Engine queued', 310, 9, { Prerequisite1: 10 }),
  catalogueRow(20, ENGINE, 'Engine unknown cost', null, 9, { Prerequisite1: 10 }),
  catalogueRow(21, ENGINE, 'Engine cheap', 50, 4, { Prerequisite1: 10 }),
  catalogueRow(22, REACTOR, 'Reactor 1', 100, 1),
  catalogueRow(61, FUEL, 'Fuel 1.0', 100, 1),
  catalogueRow(62, FUEL, 'Fuel 0.7', 300, 0.7, { Prerequisite1: 61 }),
  catalogueRow(63, FUEL, 'Fuel 0.5', 200, 0.5, { Prerequisite1: 61 }),
  catalogueRow(64, FUEL, 'Fuel 0.4', 400, 0.4, { Prerequisite1: 62 }),
  catalogueRow(80, JUMP_EFFICIENCY, 'Jump 1', 100, 4),
  catalogueRow(81, JUMP_EFFICIENCY, 'Jump 2', 200, 6, { Prerequisite1: 80 }),
]

const RESEARCH = { raceId: RACE, researched: [9, 10, 61, 62, 63, 80], eligible: [16], projects: [{ TechID: 18, ResearchPointsRequired: 120 }], queued: [19], paused: [] }

const worldOf = (m, { catalogue = CATALOGUE, researched = RESEARCHED_ROWS, research = RESEARCH } = {}) => m.ts.withCandidates(m.rt.buildRaceTech(researched), { catalogue, ...research })

const candidate = (world, typeId, id) => world.lines[typeId].candidates.find((item) => item.id === id)

const idsOf = (items) => items.map((item) => item.id)

const choice = (techId, extra = {}) => ({ techId, source: 'scenario', ...extra })

// ---------- the repository on memory ----------

// The stores of one installation: each a JSON value read and written whole, as electron-store's `.store` is, with the store client's whole-file `update`. `owner.value` says whether this window may write, `log` the order of the asks and the writes.
const memory = () => {
  const files = new Map()
  const log = []
  const owner = { value: true }
  const store = (name) => ({
    get store () {
      return copy(files.get(name)) || {}
    },
    set store (value) {
      log.push('write')
      files.set(name, copy(value))
    },
    update (change) {
      for (;;) {
        const base = JSON.stringify(this.store)
        const next = change(JSON.parse(base))

        if (JSON.stringify(this.store) === base) {
          this.store = next

          return next
        }
      }
    },
  })

  return {
    files,
    log,
    owner,
    storage: {
      open: (campaignId) => store(`campaign-${campaignId}`),
      registry: () => ({}),
      writable: async () => {
        log.push('writable')
        await Promise.resolve()

        return owner.value
      },
    },
    writes: () => log.filter((entry) => entry === 'write').length,
  }
}

const repositoryOf = (m, mem) => {
  const adapters = m.sr.createAdapterRegistry()
  let counter = 0
  let clock = 1000

  m.ts.registerTechScenarios(adapters.register)

  return m.sr.createRepository({ storage: mem.storage, adapters, newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, now: () => ++clock })
}

const scopeIn = (m, { campaignId = 'c1', branchId = 'b1', RaceID = RACE, gameTime = 100 } = {}) => m.ts.scopeOf({ campaign: { campaignId, branchId }, RaceID, gameTime })

// A fresh store, a repository over it and the world, with the engine's choice 11 saved.
const saved = async (m, world = worldOf(m), typeId = ENGINE, techId = 11) => {
  const mem = memory()
  const repository = repositoryOf(m, mem)
  const scope = scopeIn(m)
  const outcome = await m.ts.saveChoice(repository, scope, world, m.ts.readScenario(repository, scope, world), { typeId, techId })

  return { mem, repository, scope, outcome }
}

// ---------- the checks that need no save and no page ----------

const syntheticChecks = (m) => {
  const { rt, ts, pv } = m
  const world = worldOf(m)
  const line = world.lines[ENGINE]
  const fuel = world.lines[FUEL]
  const status = (id) => (candidate(world, ENGINE, id) || {}).status
  const checks = []
  const add = (name, test) => checks.push([name, test])

  pv.registerRule({ id: 'check.figure', versions: ['2.7.x'], note: 'A figure of this check.', verification: 'confirmed' })

  const figure = (statusName, extra = {}) => (statusName === 'unavailable' ? pv.unavailable({ rule: 'check.figure', missing: ['a value'] }) : pv.envelope({ value: 5, status: statusName, rule: 'check.figure', inputs: { present: ['a'] }, units: 'km/s', ...extra }))

  // ---- the game's pick

  add('pick: the game designs with the researched level of the highest development cost', () => same([line.pick.id, idsOf(line.levels)], [10, [9, 10]]))

  add('pick: a tie in development cost goes to the first level listed', () => rt.gamePick([{ id: 1, cost: 5 }, { id: 2, cost: 5 }]).id === 1 || 'the second level of equal cost was picked')

  add('pick: a line with nothing researched has no pick and no level', () => same([world.lines[REACTOR].pick, world.lines[REACTOR].levels], [null, []]))

  add('pick: where development order and figure disagree, fuel defaults to the highest development cost, not to the lowest figure', () => {
    const infos = fuel.levels.map((item) => item.info)

    return fuel.pick.id === 62 && fuel.pick.info === 0.7 && Math.min(...infos) === 0.5 ? true : `${short(fuel.pick)} among ${short(infos)}`
  })

  add('pick: fuel and thermal reduction researched in order of their figures default to the lowest figure', () => {
    const ordered = rt.buildRaceTech([researchedRow(1, FUEL, 'F 1', 100, 1), researchedRow(2, FUEL, 'F 2', 200, 0.7), researchedRow(3, FUEL, 'F 3', 300, 0.5), researchedRow(4, 127, 'T 1', 50, 1), researchedRow(5, 127, 'T 2', 90, 0.5)])

    return ordered.lines[FUEL].pick.info === 0.5 && ordered.lines[127].pick.info === 0.5 ? true : short([ordered.lines[FUEL].pick, ordered.lines[127].pick])
  })

  add('pick: the levels below the pick stay on the line, cheapest first', () => same(idsOf(fuel.levels), [61, 63, 62]))

  add('pick: a baseline row of the catalogue (game 0) is a level, and so is a row a game adds', () => {
    const added = rt.buildRaceTech([researchedRow(1, ENGINE, 'Baseline', 10, 1), { ...researchedRow(2, ENGINE, 'Added', 20, 2), GameID: 5 }])

    return same(added.lines[ENGINE].levels.map((item) => item.baseline), [true, false])
  })

  // ---- the registry

  add('registry: the planners\' lines are the propulsion, jump, missile, sensor, armour, reactor and cloak types', () => {
    const groups = [...new Set(Object.values(rt.TECH_FAMILIES).map((item) => item.group))].sort()

    return same(groups, ['armour', 'cloak', 'jump', 'missile', 'propulsion', 'reactor', 'sensor'])
  })

  add('registry: every line is read and every type is named, grouped, given a direction and told what its figures are', () => Object.values(rt.TECH_FAMILIES).every((item) => item.name && item.group && ['higher', 'lower', 'none'].includes(item.better) && typeof item.info === 'string' && rt.RACE_TECH_TYPES.includes(item.typeId) && Object.keys(world.lines).includes(String(item.typeId))) || 'a type of the registry is not complete')

  add('registry: the missile, sensor, armour and reactor types are lines of the race', () => [10, 12, 13, 19, 20, 84, 41, 42, 153, 154, 155, 125, 129].every((typeId) => rt.techFamily(typeId)) || 'a type is not in the registry')

  // ---- the candidates

  add('candidates: a tech whose prerequisites are researched is researchable now', () => {
    const item = candidate(world, ENGINE, 11)

    return item.status === 'available' && item.researchable === true && item.missing.length === 0 ? true : short(item)
  })

  add('candidates: a tech with a missing prerequisite is locked, names what it lacks and is never researchable now', () => {
    const item = candidate(world, ENGINE, 12)

    return item.status === 'locked' && item.researchable === false && same(item.missing, [{ id: 13, name: 'Engine D' }]) === true && item.pathRp === 650 ? true : short(item)
  })

  add('candidates: a ruin-only tech is excluded and is no candidate', () => !candidate(world, ENGINE, 14) && line.excluded.some((item) => item.id === 14 && item.reason === 'ruin') ? true : short(line.excluded))

  add('candidates: another empire\'s tech is excluded, and a project the race was made eligible for is a candidate', () => !candidate(world, ENGINE, 15) && line.excluded.some((item) => item.id === 15 && item.reason === 'foreign') && candidate(world, ENGINE, 16).status === 'available' ? true : short([line.excluded, status(16)]))

  add('candidates: a tech that needs a ruin-only tech is excluded', () => !candidate(world, ENGINE, 17) && line.excluded.some((item) => item.id === 17 && item.reason === 'prerequisite') ? true : short(line.excluded))

  add('candidates: a tech in progress or queued has that status and is not researchable now', () => {
    const [active, queued] = [candidate(world, ENGINE, 18), candidate(world, ENGINE, 19)]

    return active.status === 'active' && queued.status === 'queued' && !active.researchable && !queued.researchable ? true : short([active, queued])
  })

  add('candidates: a researched tech is no candidate, and a candidate is on its own line', () => !line.candidates.some((item) => [9, 10].includes(item.id)) && idsOf(world.lines[REACTOR].candidates).join() === '22' && line.candidates.every((item) => item.typeId === ENGINE) ? true : short(idsOf(line.candidates)))

  add('candidates: an unknown development cost stays unknown, never 0', () => {
    const item = candidate(world, ENGINE, 20)

    return item.cost === null && item.pathRp === null && !ts.candidateText(item).includes('0 RP') && ts.candidateText(item).includes('not in the save') ? true : short([item.cost, item.pathRp, ts.candidateText(item)])
  })

  add('candidates: the words of a menu say researchable now only of a level that is', () => {
    const words = (id) => ts.candidateText(candidate(world, ENGINE, id), String)

    return words(11).includes('researchable now') && !words(12).includes('researchable now') && words(12).includes('locked') && words(12).includes('Engine D') && !words(18).includes('researchable now') && !words(19).includes('researchable now') ? true : short([words(11), words(12), words(18), words(19)])
  })

  add('candidates: the next level is the cheapest researchable level above the pick, never a locked or a cheaper one', () => (line.next && line.next.id === 11) && fuel.next.id === 64 && world.lines[REACTOR].next.id === 22 ? true : `${short(line.next && line.next.id)} ${short(fuel.next && fuel.next.id)}`)

  add('candidates: every candidate is researchable, locked, in progress or queued, and none is ruin-only or another empire\'s', () => {
    const rows = new Map(CATALOGUE.map((row) => [row.TechSystemID, row]))

    return Object.values(world.lines).every((entry) => entry.candidates.every((item) => ['available', 'locked', 'active', 'queued'].includes(item.status) && !rows.get(item.id).RuinOnly && (rows.get(item.id).RaceID === 0 || rows.get(item.id).RaceID === RACE || RESEARCH.eligible.includes(item.id)))) || 'a candidate is out of reach'
  })

  // ---- the choices

  add('choice: no choice designs with the game\'s pick', () => {
    const resolved = ts.resolveChoices(world, {})[ENGINE]

    return resolved.level === line.pick && resolved.kind === 'default' && !resolved.hypothetical && !resolved.unresolved ? true : short(resolved)
  })

  add('choice: a researched lower level is the race\'s own tech, and not hypothetical', () => {
    const resolved = ts.resolveChoices(world, { [ENGINE]: { techId: 9, source: 'preference' } })[ENGINE]

    return resolved.level.id === 9 && resolved.kind === 'researched' && !resolved.hypothetical ? true : short(resolved)
  })

  add('choice: a candidate chosen from the research graph is a hypothetical level', () => {
    const resolved = ts.resolveChoices(world, { [ENGINE]: choice(11) })[ENGINE]

    return resolved.level.id === 11 && resolved.kind === 'hypothetical' && resolved.hypothetical && resolved.candidate.status === 'available' ? true : short(resolved)
  })

  add('choice: a locked candidate may be chosen, and is hypothetical and not researchable', () => {
    const resolved = ts.resolveChoices(world, { [ENGINE]: choice(12) })[ENGINE]

    return resolved.hypothetical && !resolved.candidate.researchable ? true : short(resolved)
  })

  add('choice: a level the race remembered and no longer has researched is unresolved, with its reason, and the line uses the pick', () => {
    const resolved = ts.resolveChoices(world, { [ENGINE]: { techId: 11, source: 'preference' } })[ENGINE]

    return resolved.unresolved && resolved.unresolved.techId === 11 && resolved.unresolved.reason.length > 0 && resolved.level === line.pick && !resolved.hypothetical ? true : short(resolved)
  })

  add('choice: a tech the save does not have is unresolved, and the line uses the pick', () => {
    const resolved = ts.resolveChoices(world, { [ENGINE]: choice(999) })[ENGINE]

    return resolved.unresolved && resolved.unresolved.reason.includes('no tech with this ID') && resolved.level === line.pick ? true : short(resolved)
  })

  add('choice: a tech of another line, a ruin-only one and another empire\'s are unresolved', () => {
    const resolved = ts.resolveChoices(world, { [ENGINE]: choice(22), [FUEL]: choice(61, { source: 'preference' }) })
    const ruin = ts.resolveChoices(world, { [ENGINE]: choice(14) })[ENGINE]
    const foreign = ts.resolveChoices(world, { [ENGINE]: choice(15) })[ENGINE]

    return resolved[ENGINE].unresolved && ruin.unresolved && foreign.unresolved && ruin.unresolved.reason.includes('ruins') && foreign.unresolved.reason.includes('empire') && !resolved[FUEL].unresolved ? true : short([resolved[ENGINE], ruin.unresolved, foreign.unresolved])
  })

  add('choice: an unresolved choice takes no other level\'s figure', () => {
    const resolved = ts.resolveChoices(world, { [ENGINE]: choice(999), [FUEL]: { techId: 11, source: 'preference' } })

    return resolved[ENGINE].level.info === line.pick.info && resolved[FUEL].level.info === fuel.pick.info && resolved[ENGINE].level !== line.levels[0] ? true : short([resolved[ENGINE].level, resolved[FUEL].level])
  })

  add('choice: a candidate the race has researched since is its own level, not hypothetical', () => {
    const later = worldOf(m, { research: { ...RESEARCH, researched: [...RESEARCH.researched, 11] }, researched: [...RESEARCHED_ROWS, researchedRow(11, ENGINE, 'Engine B', 200, 8)] })
    const resolved = ts.resolveChoices(later, { [ENGINE]: choice(11) })[ENGINE]

    return resolved.level.id === 11 && !resolved.hypothetical && resolved.nowResearched && !resolved.unresolved ? true : short(resolved)
  })

  add('choice: a link that is missing or changed makes the choice unresolved, one that is linked does not', () => {
    const by = (state) => ts.resolveChoices(world, { [ENGINE]: choice(11, { link: { status: state } }) })[ENGINE]

    return by('missing').unresolved && by('changed').unresolved && by('unknown').unresolved && !by('linked').unresolved && by('linked').hypothetical ? true : short([by('missing'), by('linked')])
  })

  add('choice: the page\'s remembered levels and the record\'s choices make one selection, the record\'s winning', () => same(ts.selectionOf({ 40: 9, 65: 61 }, { 40: choice(11) }), { 40: choice(11), 65: { techId: 61, source: 'preference' } }))

  // ---- the marking

  add('marking: a result built on a hypothetical level carries the assumption and is never confirmed, an estimate staying one', () => {
    const resolved = ts.resolveChoices(world, { [ENGINE]: choice(11) })
    const { assumptions } = ts.hypotheticalOf(resolved, [ENGINE, FUEL])
    const marks = ['confirmed', 'estimated', 'assumed'].map((state) => ts.markHypothetical(figure(state), assumptions))

    return marks.every((mark, index) => mark.status === ['assumed', 'estimated', 'assumed'][index] && ts.isHypothetical(mark) && mark.assumptions.some((text) => text.startsWith(ts.HYPOTHETICAL_PREFIX)) && mark.value === 5 && mark.rule.id === 'check.figure') ? true : short(marks.map((mark) => [mark.status, ts.isHypothetical(mark), mark.value, mark.rule.id]))
  })

  add('marking: a result with no value stays without one, and a result of researched tech is not marked', () => {
    const assumptions = ts.hypotheticalOf(ts.resolveChoices(world, { [ENGINE]: choice(11) }), [ENGINE]).assumptions
    const none = ts.markHypothetical(figure('unavailable'), assumptions)
    const plain = figure('confirmed')

    return none.status === 'unavailable' && none.value === null && ts.markHypothetical(plain, []) === plain && !ts.isHypothetical(plain) ? true : short([none, ts.isHypothetical(plain)])
  })

  add('marking: the hypothetical assumptions of some results are listed once, and the other assumptions of a result are left out', () => {
    const assumptions = ts.hypotheticalOf(ts.resolveChoices(world, { [ENGINE]: choice(11) }), [ENGINE]).assumptions
    const marked = ts.markHypothetical(figure('confirmed', { assumptions: ['a cruise share'] }), assumptions)
    const listed = ts.hypotheticalAssumptionsOf([marked, ts.markHypothetical(figure('confirmed'), assumptions), figure('confirmed', { assumptions: ['a cruise share'] }), null])

    return listed.length === 1 && listed[0] === assumptions[0] && ts.hypotheticalAssumptionsOf([figure('confirmed')]).length === 0 && ts.hypotheticalAssumptionsOf([]).length === 0 ? true : short(listed)
  })

  add('marking: the lines of a resolution that are hypothetical are named, and only the ones asked for', () => {
    const resolved = ts.resolveChoices(world, { [ENGINE]: choice(11), [JUMP_EFFICIENCY]: choice(81) })
    const propulsion = ts.hypotheticalOf(resolved, [ENGINE, FUEL])
    const jump = ts.hypotheticalOf(resolved, [JUMP_EFFICIENCY])

    return propulsion.lines.length === 1 && jump.lines.length === 1 && propulsion.assumptions[0].includes('Engine B') && jump.assumptions[0].includes('Jump 2') && !ts.hypotheticalOf(ts.resolveChoices(world, {}), [ENGINE]).lines.length ? true : short([propulsion, jump])
  })

  add('marking: every figure of a set of results is marked, and a missing one stays missing', () => {
    const marked = ts.markAllHypothetical({ speed: figure('confirmed'), tanks: null, cost: figure('estimated') }, ['Hypothetical tech: x'])

    return marked.tanks === null && ts.isHypothetical(marked.speed) && ts.isHypothetical(marked.cost) ? true : short(marked)
  })

  // ---- the loader on a save without the optional flag

  const TECH_ROWS = ["insert into FCT_TechSystem values (10, 0, 40, 'Engine A', 'Engine A', 5, null, 100)", "insert into FCT_TechSystem values (9, 0, 40, 'Engine 0', 'Engine 0', 3, null, 40)"]
  const TECH_TABLE = 'create table FCT_TechSystem (TechSystemID integer, GameID integer, TechTypeID integer, Name text, ComponentName text, AdditionalInfo real, AdditionalInfo2 real, DevelopCost real)'

  const loaded = (race, rows) => new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3')
    const raw = new sqlite3.Database(':memory:', (openError) => {
      if (openError) {
        reject(openError)

        return
      }

      const database = { query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => raw.all(sql, Object.fromEntries([...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))].map((name) => [`:${name}`, replacements[name]])), (error, found) => (error ? reject(error) : resolve([found])))) }

      raw.exec([TECH_TABLE, ...TECH_ROWS, ...rows].join(';\n'), (execError) => {
        if (execError) {
          reject(execError)

          return
        }

        rt.loadRaceTech(database, { GameID: 1, RaceID: race }).then(resolve, reject).finally(() => raw.close())
      })
    })
  })

  add('loader: a save without FCT_RaceTech.Obsolete gives the levels, the pick and an unknown flag, never an error or false', async () => {
    const tech = await loaded(2, ['create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer)', 'insert into FCT_RaceTech values (1, 2, 9), (1, 2, 10), (1, 3, 10)'])
    const engines = tech.lines[ENGINE]

    return same([engines.levels.map((item) => [item.id, item.obsolete]), engines.pick.id], [[[9, null], [10, null]], 10])
  })

  add('loader: a save with FCT_RaceTech.Obsolete gives the flag of each level', async () => {
    const tech = await loaded(2, ['create table FCT_RaceTech (GameID integer, RaceID integer, TechID integer, Obsolete integer)', 'insert into FCT_RaceTech values (1, 2, 9, 1), (1, 2, 10, 0)'])

    return same(tech.lines[ENGINE].levels.map((item) => [item.id, item.obsolete]), [[9, true], [10, false]])
  })

  return checks
}

// ---------- the checks of the record ----------

const repositoryChecks = (m) => {
  const { ts } = m
  const checks = []
  const add = (name, test) => checks.push([name, test])
  const world = worldOf(m)

  add('record: the scope is a settled campaign and branch, a race and a game time', () => {
    const good = scopeIn(m)

    return same(good, { campaignId: 'c1', RaceID: RACE, branchId: 'b1', gameTime: 100 }) === true && ts.scopeOf({ campaign: null, RaceID: RACE, gameTime: 100 }) === null && ts.scopeOf({ campaign: { campaignId: 'c1', branchId: 'b1' }, RaceID: RACE, gameTime: Number.NaN }) === null && ts.scopeOf({ campaign: { campaignId: 'c1', branchId: 'b1' }, RaceID: null, gameTime: 1 }) === null ? true : short(good)
  })

  add('record: a choice is kept as a typed record of the branch that reads back resolved in a new repository, with a link naming the tech', async () => {
    const { mem, outcome, scope } = await saved(m)
    const reopened = repositoryOf(m, mem)
    const read = ts.readScenario(reopened, scope, world)
    const resolved = ts.resolveChoices(world, ts.selectionOf({}, read.selection))[ENGINE]
    const record = read.entry.record
    const link = record.links[0]

    return outcome.ok && record.kind === 'planner.techChoice' && record.association.policy === 'branch' && record.provenance.via === 'created' && resolved.hypothetical && resolved.level.id === 11 && link.type === 'tech' && link.id === 11 && link.fingerprint.includes('Engine B') && read.entry.links[0].status === 'linked' ? true : short([outcome, record, resolved.kind])
  })

  add('record: the record names its assumptions, and keeps the choice as the tech\'s id, name and state when chosen', async () => {
    const { repository, scope } = await saved(m)
    const entry = ts.readScenario(repository, scope, world).entry

    return entry.payload.choices[ENGINE].techId === 11 && entry.payload.choices[ENGINE].statusWhenChosen === 'available' && entry.record.assumptions[0].startsWith(ts.HYPOTHETICAL_PREFIX) ? true : short(entry.payload)
  })

  add('record: a tech deleted from the save is unresolved after a reload, and the line uses the pick', async () => {
    const { repository, scope } = await saved(m)
    const without = worldOf(m, { catalogue: CATALOGUE.filter((row) => row.TechSystemID !== 11) })
    const read = ts.readScenario(repository, scope, without)
    const resolved = ts.resolveChoices(without, read.selection)[ENGINE]

    return read.entry.links[0].status === 'missing' && resolved.unresolved && resolved.unresolved.techId === 11 && resolved.unresolved.reason.length > 0 && resolved.level === without.lines[ENGINE].pick && !resolved.hypothetical ? true : short([read.entry.links, resolved])
  })

  add('record: an ID the save reuses for another tech reads as changed and is unresolved, never rebound', async () => {
    const { repository, scope } = await saved(m)
    const reused = worldOf(m, { catalogue: CATALOGUE.map((row) => (row.TechSystemID === 11 ? { ...row, Name: 'Another engine', AdditionalInfo: 99 } : row)) })
    const read = ts.readScenario(repository, scope, reused)
    const resolved = ts.resolveChoices(reused, read.selection)[ENGINE]

    return read.entry.links[0].status === 'changed' && resolved.unresolved && resolved.unresolved.reason.includes('another tech') && resolved.level === reused.lines[ENGINE].pick && !resolved.hypothetical ? true : short([read.entry.links, resolved])
  })

  add('record: a tech the race can no longer research is unresolved with the reason', async () => {
    const { repository, scope } = await saved(m)
    const ruin = worldOf(m, { catalogue: CATALOGUE.map((row) => (row.TechSystemID === 11 ? { ...row, RuinOnly: 1 } : row)) })
    const resolved = ts.resolveChoices(ruin, ts.readScenario(repository, scope, ruin).selection)[ENGINE]

    return resolved.unresolved && resolved.unresolved.reason.includes('ruins') && resolved.level === ruin.lines[ENGINE].pick ? true : short(resolved)
  })

  add('record: another race, another branch and another campaign see nothing of it', async () => {
    const { repository } = await saved(m)
    const seen = (options) => Object.keys(ts.readScenario(repository, scopeIn(m, options), world).selection).length

    return seen({}) === 1 && seen({ RaceID: 8 }) === 0 && seen({ branchId: 'b2' }) === 0 && seen({ campaignId: 'c2' }) === 0 ? true : short([seen({}), seen({ RaceID: 8 }), seen({ branchId: 'b2' }), seen({ campaignId: 'c2' })])
  })

  add('record: a save rewound before the record does not apply it, and saving over it moves it to this save', async () => {
    const { mem, repository } = await saved(m)
    const rewound = scopeIn(m, { gameTime: 50 })
    const before = ts.readScenario(repository, rewound, world)
    const resolved = ts.resolveChoices(world, ts.selectionOf({}, before.selection))[ENGINE]
    const outcome = await ts.saveChoice(repository, rewound, world, before, { typeId: FUEL, techId: 64 })
    const after = ts.readScenario(repository, rewound, world)

    return before.entry.status === 'ahead' && before.notes.length === 1 && before.notes[0].reason.includes('later game time') && !resolved.hypothetical && resolved.kind === 'default' && outcome.ok && after.entry.status === 'current' && after.entry.record.revision === 2 && same(Object.keys(after.entry.payload.choices), ['65']) === true && mem.writes() === 2 ? true : short([before.entry.status, before.notes, outcome, after.entry && after.entry.payload])
  })

  add('record: a tab that does not hold the file writes nothing and says why', async () => {
    const { mem, repository, scope } = await saved(m)
    const writes = mem.writes()

    mem.owner.value = false

    const outcome = await ts.saveChoice(repository, scope, world, ts.readScenario(repository, scope, world), { typeId: FUEL, techId: 64 })

    return !outcome.ok && outcome.code === 'not-owner' && outcome.message.length > 0 && mem.writes() === writes ? true : short([outcome, mem.writes(), writes])
  })

  add('record: the write waits for the file to be granted', async () => {
    const { mem } = await saved(m)

    return same(mem.log, ['writable', 'write'])
  })

  add('record: a campaign not settled, and no repository, keep nothing and say so', async () => {
    const { repository } = await saved(m)
    const none = await ts.saveChoice(repository, null, world, { entry: null }, { typeId: ENGINE, techId: 11 })
    const nowhere = await ts.saveChoice(null, scopeIn(m), world, { entry: null }, { typeId: ENGINE, techId: 11 })

    return none.code === 'no-scope' && nowhere.code === 'no-repository' && ts.readScenario(null, scopeIn(m), world).entry === null && ts.readScenario(repository, null, world).entry === null ? true : short([none, nowhere])
  })

  add('record: a tech that is not a candidate of its line is refused and nothing is written', async () => {
    const mem = memory()
    const repository = repositoryOf(m, mem)
    const scope = scopeIn(m)
    const read = ts.readScenario(repository, scope, world)
    const refused = await Promise.all([10, 14, 15, 22, 999].map((techId) => ts.saveChoice(repository, scope, world, read, { typeId: ENGINE, techId })))

    return refused.every((outcome) => !outcome.ok && outcome.code === 'not-a-candidate') && mem.writes() === 0 ? true : short(refused)
  })

  add('record: clearing a choice drops it and its link, and a stale edit is reconciled over the stored one', async () => {
    const { mem, repository, scope } = await saved(m)
    const stale = ts.readScenario(repository, scope, world)
    const other = repositoryOf(m, mem)
    const fresh = ts.readScenario(other, scope, world)

    await ts.saveChoice(other, scope, world, fresh, { typeId: FUEL, techId: 64 })

    const reconciled = await ts.saveChoice(repository, scope, world, stale, { typeId: ENGINE, techId: 13 })
    const read = ts.readScenario(repository, scope, world)
    const both = same(Object.fromEntries(Object.entries(read.entry.payload.choices).map(([type, item]) => [type, item.techId])), { 40: 13, 65: 64 })
    const cleared = await ts.saveChoice(repository, scope, world, read, { typeId: ENGINE, techId: null })
    const after = ts.readScenario(repository, scope, world)

    return reconciled.ok && both === true && read.entry.record.provenance.reconciled.length === 1 && cleared.ok && same(Object.keys(after.entry.payload.choices), ['65']) === true && after.entry.record.links.length === 1 && after.entry.record.links[0].id === 64 ? true : short([reconciled, both, after.entry.payload])
  })

  add('record: choosing the tech again after its ID changed takes the new fingerprint', async () => {
    const { repository, scope } = await saved(m)
    const reused = worldOf(m, { catalogue: CATALOGUE.map((row) => (row.TechSystemID === 11 ? { ...row, Name: 'Another engine', AdditionalInfo: 99 } : row)) })
    const outcome = await ts.saveChoice(repository, scope, reused, ts.readScenario(repository, scope, reused), { typeId: ENGINE, techId: 11 })
    const read = ts.readScenario(repository, scope, reused)

    return outcome.ok && read.entry.links[0].status === 'linked' && read.entry.links[0].fingerprint.includes('Another engine') ? true : short([outcome, read.entry.links])
  })

  return checks
}

// ---------- the page ----------

const SEARCH_TECH = { engineTech: 10, fuelTech: 1, thermalTech: 1, thermalCost: 1, minThrust: 0.5, maxThrust: 1, maxSize: 3 }

const STOCK_TANKS = [[100, 5000000, 25], [20, 1000000, 10], [5, 250000, 5], [1, 50000, 2], [0.2, 10000, 0.5], [0.1, 5000, 0.3], [0.02, 1000, 0.08]].map(([sizeHS, litres, cost], index) => ({ id: index + 1, name: `Stock ${index + 1}`, sizeHS, litres, cost, crew: 0 }))

const searched = async () => {
  const { 'design-search': search } = await loadUtilities(['design-search'])
  const result = drain(search.searchPropulsion({ hullHS: 40, speed: 2000, fraction: 0.5, goal: { mode: 'range', value: 3e9 }, share: 0.5, maxCount: 30, tech: SEARCH_TECH, tanks: STOCK_TANKS }))

  return Object.freeze({ ...result, input: { engineTechName: 'Tech' }, run: { incomplete: false } })
}

const pageStatements = async (mutate, m, result) => {
  const options = await loadPage('pages/propulsion', { stubs: STUBS, mutate })
  const world = worldOf(m)
  const page = (data = {}) => instantiate(options, { $store: { getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 100 }, state: {} }, database: {}, GameID: 1, RaceID: RACE, data: { tech: world, ...data } })
  const figures = (provenance) => Object.values(provenance).filter(Boolean)
  const hypothetical = (provenance) => figures(provenance).length > 0 && figures(provenance).every((item) => m.ts.isHypothetical(item) && item.status !== 'confirmed')
  const clean = (provenance) => figures(provenance).length > 0 && figures(provenance).every((item) => !m.ts.isHypothetical(item))
  const held = { heldChoices: { [ENGINE]: { techId: 11, name: 'Engine B' } } }
  const withRecord = async (typeId = ENGINE, techId = 11) => {
    const { mem, repository } = await saved(m, world, typeId, techId)

    return { mem, records: { repository, error: null } }
  }

  return [
    ['page: with no choice every line designs with the game\'s pick and nothing is hypothetical', () => {
      const vm = page()

      return vm.techLevels[ENGINE].id === 10 && vm.techLevels[FUEL].id === 62 && vm.propulsionAssumptions.length === 0 && vm.jumpAssumptions.length === 0 && vm.techChoiceCount === 0 && vm.hypotheticalNotice === '' && vm.unresolvedChoices.length === 0 ? true : short(vm.techLevels)
    }],
    ['page: a lower researched level is a choice of the race\'s own tech and nothing is hypothetical', () => {
      const vm = page({ techChoice: { [ENGINE]: 9 } })

      return vm.techLevels[ENGINE].id === 9 && vm.techChoiceCount === 1 && vm.propulsionAssumptions.length === 0 && vm.techLines[0].selected === 9 && vm.techLines[0].candidate === null ? true : short([vm.techLevels[ENGINE], vm.techChoiceCount])
    }],
    ['page: a hypothetical next tech is the level the line designs with, marked on the line and in the notice', () => {
      const vm = page(held)
      const first = vm.techLines[0]

      return vm.techLevels[ENGINE].id === 11 && vm.propulsionAssumptions.length === 1 && vm.propulsionAssumptions[0].startsWith(m.ts.HYPOTHETICAL_PREFIX) && first.hypothetical && first.candidate === 11 && first.selected === null && vm.hypotheticalNotice.includes('Engine B') && vm.techChoiceCount === 1 ? true : short([vm.techLevels[ENGINE], vm.propulsionAssumptions, first])
    }],
    ['page: every figure of a set designed with a hypothetical level is marked hypothetical, and none otherwise', () => {
      const set = result.sets[0]

      return hypothetical(page({ ...held, result }).rowOfSet(set, 1).provenance) && clean(page({ result }).rowOfSet(set, 1).provenance) ? true : 'a row is not marked as its tech is'
    }],
    ['page: the trade-off rows and the cheapest set\'s tile are marked hypothetical too', () => {
      const vm = page({ ...held, result })
      const tile = vm.tiles[2]
      const plain = page({ result })

      return vm.tradeRows.length > 0 && vm.tradeRows.every((row) => hypothetical(row.provenance)) && tile.title.includes(m.ts.HYPOTHETICAL_PREFIX) && plain.tradeRows.every((row) => clean(row.provenance)) && !plain.tiles[2].title.includes(m.ts.HYPOTHETICAL_PREFIX) && vm.tiles[3].note.includes('hypothetical') ? true : short([vm.tradeRows.length, tile.title])
    }],
    ['page: the burn and endurance levels of a hypothetical set stay hypothetical at full power, half power and the cruise share, and those of a researched set are confirmed at full power', () => {
      const marked = page({ ...held, result }).burnLevels
      const plain = page({ result }).burnLevels
      const of = (level) => ({ burn: level.provenance.burn, days: level.provenance.days })

      return marked.length >= 2 && marked.every((level) => hypothetical(of(level))) && plain.length >= 2 && plain.every((level) => clean(of(level))) && plain[0].fraction === 1 && plain[0].provenance.burn.status === 'confirmed' && plain[0].provenance.days.status === 'confirmed' ? true : short([marked.map((level) => level.provenance.burn.status), plain.map((level) => level.provenance.burn.status)])
    }],
    ['page: a hypothetical propulsion set marks the jump drive figures that start from its hull, and a saved class\'s own row and a researched set do not', () => {
      const marked = page({ ...held, result })
      const plain = page({ result })
      const pinned = { ...plain.rowOfSet(result.sets[0], 1), key: 'class', pinned: true }
      const own = page({ ...held, result, pinnedRow: pinned, selectedKey: 'class' })

      return marked.jumpAssumptions.length === 1 && marked.jumpAssumptions[0].includes('Engine B') && marked.hypotheticalNotice.includes('Engine B') && plain.jumpAssumptions.length === 0 && own.selectedRow.pinned && own.jumpAssumptions.length === 0 ? true : short([marked.jumpAssumptions, plain.jumpAssumptions, own.jumpAssumptions])
    }],
    ['page: clearing a choice, choosing the default and choosing an earlier researched level hold for this page when the record cannot be written, and the notice says so', async () => {
      const steps = [[(vm) => vm.chooseNextTech(ENGINE, null), 10], [(vm) => vm.setTech(ENGINE, 10), 10], [(vm) => vm.setTech(ENGINE, 9), 9], [(vm) => vm.forgetChoice(ENGINE), 10]]
      const seen = []

      for (const [step, expected] of steps) {
        const { mem, records } = await withRecord()
        const vm = page({ records })
        const before = vm.techLevels[ENGINE].id
        const writes = mem.writes()

        mem.owner.value = false
        await step(vm)
        seen.push([before, vm.techLevels[ENGINE].id === expected, vm.techLines[0].hypothetical, vm.propulsionAssumptions.length, vm.scenarioNotice.includes('Another tab'), mem.writes() === writes])
      }

      const { mem, records } = await withRecord()
      const vm = page({ records })

      mem.owner.value = false
      await vm.chooseNextTech(ENGINE, null)
      mem.owner.value = true
      await vm.chooseNextTech(ENGINE, null)

      return seen.every((item) => equal(item, [11, true, false, 0, true, true])) && vm.techLevels[ENGINE].id === 10 && Object.keys(vm.scenario.selection).length === 0 && vm.scenarioMessage === '' ? true : short([seen, vm.techLevels[ENGINE].id, vm.scenarioMessage])
    }],
    ['page: a hypothetical jump efficiency marks the jump drive and not the propulsion sets', () => {
      const vm = page({ heldChoices: { [JUMP_EFFICIENCY]: { techId: 81, name: 'Jump 2' } }, result })

      return vm.jumpAssumptions.length === 1 && vm.jumpAssumptions[0].includes('Jump 2') && vm.propulsionAssumptions.length === 0 && clean(vm.rowOfSet(result.sets[0], 1).provenance) ? true : short([vm.jumpAssumptions, vm.propulsionAssumptions])
    }],
    ['page: an engine of the race\'s own fixes the design, so no result is hypothetical', () => {
      const vm = page({ ...held, result, engineId: 5, raceEngines: [{ id: 5, name: 'Own engine', sizeHS: 1, power: 10, obsolete: false }] })

      return vm.propulsionAssumptions.length === 0 && clean(vm.rowOfSet(result.sets[0], 1).provenance) ? true : short(vm.propulsionAssumptions)
    }],
    ['page: a remembered level the race no longer has is reported unresolved, and the line uses the pick', async () => {
      const vm = page({ techChoice: { [ENGINE]: 777 } })
      const before = [vm.techLevels[ENGINE].id, vm.unresolvedChoices.length, vm.techLines[0].unresolvedText, vm.propulsionAssumptions.length, vm.techChoiceCount]

      await vm.forgetChoice(ENGINE)

      return before[0] === 10 && before[1] === 1 && before[2].includes('Engine A') && before[3] === 0 && before[4] === 0 && !(ENGINE in vm.techChoice) && vm.unresolvedChoices.length === 0 ? true : short(before)
    }],
    ['page: a saved choice the save lacks is reported unresolved with its reason, and the line uses the pick', async () => {
      const { records } = await withRecord()
      const without = worldOf(m, { catalogue: CATALOGUE.filter((row) => row.TechSystemID !== 11) })
      const vm = page({ tech: without, records })

      return vm.techLevels[ENGINE].id === 10 && vm.unresolvedChoices.length === 1 && vm.unresolvedChoices[0].text.includes('no longer has this tech') && vm.propulsionAssumptions.length === 0 ? true : short([vm.techLevels[ENGINE], vm.unresolvedChoices])
    }],
    ['page: a choice saved for the race and branch is applied when the page opens', async () => {
      const { records } = await withRecord()
      const vm = page({ records })

      return vm.techLevels[ENGINE].id === 11 && vm.propulsionAssumptions.length === 1 && vm.scenario.entry.record.kind === 'planner.techChoice' ? true : short(vm.techLevels[ENGINE])
    }],
    ['page: a choice saved at a later game time is not applied, and the notice says so', async () => {
      const { records } = await withRecord()
      const vm = instantiate(options, { $store: { getters: { 'history/campaign': { campaignId: 'c1', branchId: 'b1' }, GameTime: 50 }, state: {} }, database: {}, GameID: 1, RaceID: RACE, data: { tech: world, records } })

      return vm.techLevels[ENGINE].id === 10 && vm.propulsionAssumptions.length === 0 && vm.scenarioNotice.includes('later game time') ? true : short([vm.techLevels[ENGINE].id, vm.scenarioNotice])
    }],
    ['page: choosing a next tech writes the record and marks the results, and clearing it removes both', async () => {
      const { mem, records } = await withRecord()
      const vm = page({ records: { repository: records.repository, error: null } })

      await vm.chooseNextTech(ENGINE, 13)

      const chosen = [vm.techLevels[ENGINE].id, vm.propulsionAssumptions.length, vm.scenarioMessage]

      await vm.chooseNextTech(ENGINE, null)

      return chosen[0] === 13 && chosen[1] === 1 && chosen[2] === '' && vm.techLevels[ENGINE].id === 10 && vm.propulsionAssumptions.length === 0 && mem.writes() === 3 ? true : short([chosen, vm.techLevels[ENGINE].id, mem.writes()])
    }],
    ['page: a choice that cannot be written to the record holds for this page only, marked, and the notice says why', async () => {
      const mem = memory()
      const repository = repositoryOf(m, mem)
      const vm = page({ records: { repository, error: null } })

      mem.owner.value = false
      await vm.chooseNextTech(ENGINE, 11)

      return vm.techLevels[ENGINE].id === 11 && vm.propulsionAssumptions.length === 1 && vm.scenarioNotice.includes('Another tab') && mem.writes() === 0 ? true : short([vm.techLevels[ENGINE].id, vm.scenarioNotice, mem.writes()])
    }],
    ['page: a researched level replaces a hypothetical choice of its line', async () => {
      const { records } = await withRecord()
      const vm = page({ records })

      await vm.setTech(ENGINE, 9)

      return vm.techLevels[ENGINE].id === 9 && vm.propulsionAssumptions.length === 0 && Object.keys(vm.scenario.selection).length === 0 ? true : short([vm.techLevels[ENGINE].id, vm.scenario.selection])
    }],
    ['page: the menu offers the next techs with their state, and says researchable now only of a level that is', () => {
      const vm = page()
      const first = vm.techLines[0]
      const text = (id) => first.candidates.find((item) => item.value === id).text

      return text(11).includes('researchable now') && text(12).includes('locked') && text(12).includes('Engine D') && !text(12).includes('researchable now') && !text(18).includes('researchable now') && first.next.id === 11 && first.nextText.includes('researchable now') && !first.candidates.some((item) => [14, 15, 17].includes(item.value)) && first.items.some((item) => item.text.includes('the game\'s pick')) ? true : short([text(11), text(12)])
    }],
  ]
}

const PAGE_MUTATIONS = [
  { name: 'the set\'s figures not marked hypothetical', find: 'return assumptions.length ? markAllHypothetical(figures, assumptions) : figures', replace: 'return figures', fails: ['page: every figure of a set designed with a hypothetical level', 'page: the trade-off rows and the cheapest set\'s tile'] },
  { name: 'the cheapest tile not given the assumptions', find: 'const cost = setProvenance(result.cheapest, this.fraction, this.propulsionAssumptions).cost', replace: 'const cost = setProvenance(result.cheapest, this.fraction).cost', fails: ['page: the trade-off rows and the cheapest set\'s tile'] },
  { name: 'the trade-off rows not given the assumptions', find: '        const provenance = setProvenance(set, this.fraction, this.propulsionAssumptions)\n\n        return { key', replace: '        const provenance = setProvenance(set, this.fraction)\n\n        return { key', fails: ['page: the trade-off rows and the cheapest set\'s tile'] },
  { name: 'the sets of the table not given the assumptions', find: '      const provenance = setProvenance(set, this.fraction, this.propulsionAssumptions)\n\n      return {', replace: '      const provenance = setProvenance(set, this.fraction)\n\n      return {', fails: ['page: every figure of a set designed with a hypothetical level'] },
  { name: 'an engine of the race\'s own still marks the sets hypothetical', find: 'return this.existingEngine ? EMPTY_LIST : hypotheticalOf(', replace: 'return hypotheticalOf(', fails: ['page: an engine of the race\'s own fixes the design'] },
  { name: 'the record\'s choices ignored by the lines', find: 'selectionOf(this.techChoice, this.scenarioSelection)', replace: 'selectionOf(this.techChoice, {})', fails: ['page: a choice saved for the race and branch is applied', 'page: a saved choice the save lacks is reported unresolved'] },
  { name: 'the unresolved choices not reported', find: 'this.techLines.filter((line) => line.unresolved).map(', replace: 'this.techLines.filter((line) => false).map(', fails: ['page: a remembered level the race no longer has is reported unresolved', 'page: a saved choice the save lacks is reported unresolved'] },
  { name: 'a page-only choice dropped when the record cannot be written', find: '      this.heldChoices = held\n    },', replace: '    },', fails: ['page: a choice that cannot be written to the record holds for this page only'] },
  { name: 'a researched level leaving the hypothetical choice in place', find: '      this.techChoice = choice\n\n      return this.dropScenarioChoice(type)\n    },', replace: '      this.techChoice = choice\n    },', fails: ['page: a researched level replaces a hypothetical choice of its line'] },
  { name: 'the jump drive not marked by a hypothetical efficiency', find: 'const own = hypotheticalOf(this.techResolution, [JUMP_EFFICIENCY_TECH_TYPE]).assumptions', replace: 'const own = EMPTY_LIST', fails: ['page: a hypothetical jump efficiency marks the jump drive'] },
  { name: 'the jump drive not marked by the hypothetical set it starts from', find: 'const row = this.selectedRow ? hypotheticalAssumptionsOf(Object.values(this.selectedRow.provenance)) : EMPTY_LIST', replace: 'const row = EMPTY_LIST', fails: ['page: a hypothetical propulsion set marks the jump drive figures'] },
  { name: 'the jump drive of a saved class marked by the choice of the sets', find: 'const row = this.selectedRow ? hypotheticalAssumptionsOf(Object.values(this.selectedRow.provenance)) : EMPTY_LIST', replace: 'const row = this.propulsionAssumptions', fails: ['page: a hypothetical propulsion set marks the jump drive figures'] },
  { name: 'the burn and endurance levels confirmed over a hypothetical set', find: '  return markHypothetical(result, hypotheticalAssumptionsOf([base]))', replace: '  return result', fails: ['page: the burn and endurance levels of a hypothetical set stay hypothetical'] },
  { name: 'the burn and endurance levels of a researched set marked hypothetical', find: '  return markHypothetical(result, hypotheticalAssumptionsOf([base]))', replace: '  return markHypothetical(result, [\'Hypothetical tech: any\'])', fails: ['page: the burn and endurance levels of a hypothetical set stay hypothetical'] },
  { name: 'a choice cleared for this page showing the record\'s choice again', find: '        } else {\n          delete selection[type]\n        }', replace: '        }', fails: ['page: clearing a choice, choosing the default and choosing an earlier researched level hold for this page'] },
  { name: 'a choice cleared for this page forgotten', find: '        held[type] = null\n        this.scenarioMessage = outcome.message', replace: '        delete held[type]\n        this.scenarioMessage = outcome.message', fails: ['page: clearing a choice, choosing the default and choosing an earlier researched level hold for this page'] },
]

// ---------- the mutants of the utilities ----------

const MUTATIONS = [
  { name: 'the hypothetical assumptions of a result taken with the others', file: 'tech-scenarios.js', find: 'result.assumptions.filter((assumption) => assumption.startsWith(HYPOTHETICAL_PREFIX))))]', replace: 'result.assumptions))]', fails: ['marking: the hypothetical assumptions of some results are listed once'] },
  // eslint-disable-next-line no-template-curly-in-string
  { name: 'the obsolete flag read by its table column', file: 'race-tech.js', find: '(columns.has(name) ? `${RACE_TECH_TABLE}.${name} as ${name}` : `null as ${name}`)', replace: '`${RACE_TECH_TABLE}.${name} as ${name}`', fails: ['loader: a save without'] },
  { name: 'an absent obsolete flag read as false', file: 'race-tech.js', find: 'obsolete: row.Obsolete === null ? null : Boolean(row.Obsolete),', replace: 'obsolete: Boolean(row.Obsolete),', fails: ['loader: a save without'] },
  { name: 'the game\'s pick taken by the highest figure', file: 'race-tech.js', find: '!best || item.cost > best.cost ? item : best', replace: '!best || item.info > best.info ? item : best', fails: ['pick: where development order and figure disagree'] },
  { name: 'the game\'s pick taken by the lowest figure', file: 'race-tech.js', find: '!best || item.cost > best.cost ? item : best', replace: '!best || item.info < best.info ? item : best', fails: ['pick: the game designs with the researched level of the highest development cost', 'pick: where development order and figure disagree'] },
  { name: 'the game\'s pick taken by the lowest development cost', file: 'race-tech.js', find: '!best || item.cost > best.cost ? item : best', replace: '!best || item.cost < best.cost ? item : best', fails: ['pick: the game designs with the researched level', 'pick: where development order and figure disagree', 'pick: fuel and thermal reduction researched in order'] },
  { name: 'a tie in development cost going to the last level', file: 'race-tech.js', find: '!best || item.cost > best.cost ? item : best', replace: '!best || item.cost >= best.cost ? item : best', fails: ['pick: a tie in development cost goes to the first level'] },
  { name: 'a baseline row not marked as one', file: 'race-tech.js', find: 'baseline: row.GameID === 0,\n  obsolete', replace: 'baseline: false,\n  obsolete', fails: ['pick: a baseline row of the catalogue'] },
  { name: 'the next level taken without regard to what is researchable', file: 'tech-scenarios.js', find: 'own.find((item) => item.status === AVAILABLE && (!pick || item.cost > pick.cost))', replace: 'own.find((item) => (!pick || item.cost > pick.cost))', fails: ['candidates: the next level is the cheapest researchable level'] },
  { name: 'the next level taken from below the pick', file: 'tech-scenarios.js', find: 'own.find((item) => item.status === AVAILABLE && (!pick || item.cost > pick.cost))', replace: 'own.find((item) => item.status === AVAILABLE)', fails: ['candidates: the next level is the cheapest researchable level'] },
  { name: 'a locked tech reported researchable', file: 'tech-scenarios.js', find: 'researchable: entry.status === AVAILABLE,', replace: 'researchable: true,', fails: ['candidates: a tech with a missing prerequisite is locked', 'candidates: a tech in progress or queued', 'choice: a locked candidate may be chosen'] },
  { name: 'the words of a locked tech saying it is researchable now', file: 'tech-scenarios.js', find: '} RP` : \'cost not in the save\'\n\n  if (candidate.status === AVAILABLE) {', replace: '} RP` : \'cost not in the save\'\n\n  if (candidate.status !== QUEUED) {', fails: ['candidates: the words of a menu say researchable now only of a level that is'] },
  { name: 'an unknown cost shown as a number', file: 'tech-scenarios.js', find: 'const cost = isKnownNumber(candidate.cost) ?', replace: 'const cost = true ?', fails: ['candidates: an unknown development cost stays unknown'] },
  { name: 'a candidate\'s unknown cost read as 0', file: 'tech-scenarios.js', find: 'cost: row.DevelopCost,\n  baseline: row.GameID === 0,', replace: 'cost: row.DevelopCost || 0,\n  baseline: row.GameID === 0,', fails: ['candidates: an unknown development cost stays unknown'] },
  { name: 'out-of-reach techs offered as candidates', file: 'tech-scenarios.js', find: 'if (entry.status === BLOCKED) {', replace: 'if (false) {', fails: ['candidates: a ruin-only tech is excluded', 'candidates: another empire\'s tech is excluded', 'candidates: a tech that needs a ruin-only tech', 'candidates: every candidate is researchable'] },
  { name: 'an unresolved choice falling back without a word', file: 'tech-scenarios.js', find: 'return unresolved(reasonOf(tech, typeId, choice, name))', replace: 'return [typeId, base]', fails: ['choice: a level the race remembered and no longer has researched is unresolved', 'choice: a tech the save does not have is unresolved', 'choice: a tech of another line'] },
  { name: 'an unresolved choice taking another level\'s figure', file: 'tech-scenarios.js', find: '[typeId, { ...base, requested: choice.techId, unresolved:', replace: '[typeId, { ...base, level: entry.levels[0] || entry.pick, requested: choice.techId, unresolved:', fails: ['choice: an unresolved choice takes no other level', 'record: a tech deleted from the save is unresolved'] },
  { name: 'a changed or missing link not stopping the choice', file: 'tech-scenarios.js', find: 'if (choice.link && choice.link.status !== \'linked\') {', replace: 'if (false) {', fails: ['choice: a link that is missing or changed', 'record: an ID the save reuses for another tech'] },
  { name: 'a hypothetical result not marked', file: 'tech-scenarios.js', find: 'if (!result || !assumptions.length) {', replace: 'if (true) {', fails: ['marking: a result built on a hypothetical level', 'marking: every figure of a set'] },
  { name: 'a hypothetical result keeping its status', file: 'tech-scenarios.js', find: 'weakestStatus([result.status, STATUS.ASSUMED])', replace: 'result.status', fails: ['marking: a result built on a hypothetical level carries the assumption and is never confirmed'] },
  { name: 'the hypothetical marker left off the assumptions', file: 'tech-scenarios.js', find: 'assumptions: [...result.assumptions, ...assumptions] })', replace: 'assumptions: result.assumptions })', fails: ['marking: a result built on a hypothetical level'] },
  { name: 'the link fingerprint ignoring the tech', file: 'tech-scenarios.js', find: 'fingerprint: (type, row) => [type, row.typeId, row.name, row.info, row.info2, row.cost].join(\'|\'),', replace: 'fingerprint: (type) => type,', fails: ['record: an ID the save reuses for another tech', 'record: a choice is kept as a typed record of the branch', 'record: choosing the tech again after its ID changed'] },
  { name: 'the file\'s grant not waited for', file: 'tech-scenarios.js', find: 'if (!(await repository.writable(scope.campaignId))) {', replace: 'if (!repository.writable(scope.campaignId)) {', fails: ['record: a tab that does not hold the file writes nothing'] },
  { name: 'a record made at a later game time applied', file: 'tech-scenarios.js', find: 'const applied = entry && entry.status === \'current\' ? entry : null', replace: 'const applied = entry', fails: ['record: a save rewound before the record does not apply it'] },
  { name: 'a record moved to this save not rebased', file: 'tech-scenarios.js', find: '...(entry.status === \'current\' ? {} : { rebase: true })', replace: '...{}', fails: ['record: a save rewound before the record does not apply it'] },
  { name: 'the scope ignoring the race and the branch', file: 'tech-scenarios.js', find: '{ campaignId: campaign.campaignId, RaceID, branchId: campaign.branchId, gameTime }', replace: '{ campaignId: campaign.campaignId, RaceID: 0, branchId: \'main\', gameTime }', fails: ['record: another race, another branch and another campaign', 'record: the scope is a settled campaign'] },
  { name: 'the record visible on every branch', file: 'tech-scenarios.js', find: '{ kind: TECH_SCENARIO_KIND, policy: \'branch\', ...patch }', replace: '{ kind: TECH_SCENARIO_KIND, policy: \'campaign\', ...patch }', fails: ['record: another race, another branch and another campaign', 'record: a choice is kept as a typed record of the branch'] },
  { name: 'a tech that is not a candidate accepted', file: 'tech-scenarios.js', find: 'if (!candidate) {\n    throw Object.assign(', replace: 'if (false) {\n    throw Object.assign(', fails: ['record: a tech that is not a candidate of its line is refused'] },
  { name: 'a stale edit thrown away instead of reconciled', file: 'tech-scenarios.js', find: 'if (!error || error.name !== \'RevisionConflict\') {', replace: 'if (true) {', fails: ['record: clearing a choice drops it and its link, and a stale edit is reconciled'] },
  { name: 'a link kept after its tech was chosen again', file: 'tech-scenarios.js', find: ' && choice.techId !== refresh)', replace: ')', fails: ['record: choosing the tech again after its ID changed'] },
]

const mutatedCopy = (file, from, to) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-race-tech-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8')

  if (!source.includes(from)) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation does not apply to ${file}: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

// ---------- the saves ----------

const parseArguments = (argv) => {
  const options = { modded: ['AuroraDB.db', 140, 784], stock: ['saves/AuroraDB_271_skoormit_saved.db', 138, 785], mutations: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--stock' || argv[index] === '--modded') {
      options[argv[index].slice(2)] = [argv[index + 1], Number(argv[index + 2]), Number(argv[index + 3])]
      index += 3
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const sqlite3 = require('sqlite3')
  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({
      query: (sql, { replacements = {} } = {}) => new Promise((resolve, reject) => {
        const names = [...new Set([...sql.matchAll(/:(\w+)/g)].map((match) => match[1]))]
        const parameters = Object.fromEntries(names.map((name) => [`:${name}`, replacements[name]]))

        raw.all(sql, parameters, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))
      }),
      close: () => raw.close(),
    })
  })
})

const rowsOf = async (database, sql, replacements = {}) => (await database.query(sql, { replacements }))[0]

// The checks of one save. Everything the oracle reads is SQL of its own, not the loader's.
const saveChecks = async (m, database, { GameID, RaceID }, label) => {
  const { rt, ts, pv } = m
  const tech = await ts.loadTechChoices(database, { GameID, RaceID })
  const lines = Object.values(tech.lines)
  const typeIds = rt.RACE_TECH_TYPES
  const researched = await rowsOf(database, `select t.TechTypeID, t.TechSystemID, t.GameID, t.DevelopCost, t.AdditionalInfo from FCT_RaceTech r inner join FCT_TechSystem t on t.TechSystemID = r.TechID where r.GameID = :GameID and r.RaceID = :RaceID and t.TechTypeID in (${typeIds.join(', ')}) order by t.TechTypeID, t.DevelopCost, t.TechSystemID`, { GameID, RaceID })
  const researchedIds = new Set((await rowsOf(database, 'select TechID from FCT_RaceTech where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })).map((row) => row.TechID))
  const results = []
  const add = (name, verdict, detail = '') => results.push([`${label}: ${name}`, verdict, detail])

  // The pick against SQL: the researched level of the highest development cost, the first of equal ones.
  const oracle = Object.fromEntries(typeIds.map((typeId) => {
    const own = researched.filter((row) => row.TechTypeID === typeId)
    const top = own.reduce((best, row) => (!best || row.DevelopCost > best.DevelopCost ? row : best), null)

    return [typeId, { own, top }]
  }))

  add('the pick of every line is the researched level of the highest development cost', typeIds.every((typeId) => (tech.lines[typeId].pick ? tech.lines[typeId].pick.id : null) === (oracle[typeId].top ? oracle[typeId].top.TechSystemID : null)) || typeIds.filter((typeId) => (tech.lines[typeId].pick ? tech.lines[typeId].pick.id : null) !== (oracle[typeId].top ? oracle[typeId].top.TechSystemID : null)).join(), `${typeIds.filter((typeId) => tech.lines[typeId].pick).length} of ${typeIds.length} lines have a level`)

  add('every level the race has researched of a line is a level of it', typeIds.every((typeId) => same(tech.lines[typeId].levels.map((item) => item.id).sort((a, b) => a - b), oracle[typeId].own.map((row) => row.TechSystemID).sort((a, b) => a - b)) === true) || 'a line differs from the race\'s researched techs', `${researched.length} levels`)

  add('a baseline row (game 0) the race has researched is a level, marked as baseline, and so is every other', (() => {
    const ids = new Set(lines.flatMap((entry) => entry.levels.filter((item) => item.baseline).map((item) => item.id)))
    const expected = new Set(researched.filter((row) => row.GameID === 0).map((row) => row.TechSystemID))

    return ids.size > 0 && same([...ids].sort((a, b) => a - b), [...expected].sort((a, b) => a - b)) === true ? true : `${ids.size} against ${expected.size}`
  })(), 'baseline levels')

  // Fuel consumption, thermal reduction and the minimum thrust default to the lowest figure on these saves, and the pick is the highest development cost.
  for (const typeId of [65, 127, 198]) {
    const entry = tech.lines[typeId]

    if (!entry.levels.length) {
      continue
    }

    const infos = entry.levels.map((item) => item.info)

    add(`${rt.techFamily(typeId).name} defaults to the lowest figure, the level of the highest development cost (${entry.pick.info} of ${entry.levels.length})`, entry.pick.info === Math.min(...infos) && entry.pick.cost === Math.max(...entry.levels.map((item) => item.cost)) ? true : short(entry.levels.map((item) => [item.cost, item.info])))
  }

  add('the pick is the best figure the registry names, on every line that has a direction', (() => {
    const wrong = lines.filter((entry) => entry.pick && rt.techFamily(entry.typeId).better !== 'none' && entry.pick.info !== (rt.techFamily(entry.typeId).better === 'higher' ? Math.max : Math.min)(...entry.levels.map((item) => item.info))).map((entry) => entry.typeId)

    return wrong.length ? `lines ${wrong.join()} default to another figure than the registry's best` : true
  })())

  // The registry against the save.
  const names = new Map((await rowsOf(database, 'select TechTypeID, Description from DIM_TechType')).map((row) => [row.TechTypeID, row.Description]))

  add('the registry\'s names are DIM_TechType\'s descriptions', typeIds.every((typeId) => names.get(typeId) === rt.techFamily(typeId).name) || typeIds.filter((typeId) => names.get(typeId) !== rt.techFamily(typeId).name).map((typeId) => `${typeId}: ${names.get(typeId)}`).join('; '), `${typeIds.length} types`)

  const baseline = await rowsOf(database, `select TechTypeID, DevelopCost, AdditionalInfo from FCT_TechSystem where GameID = 0 and AdditionalInfo is not null and TechTypeID in (${typeIds.join(', ')}) order by TechTypeID, DevelopCost, TechSystemID`)

  add('the baseline rows of a type run the way the registry says as their development cost rises', (() => {
    const wrong = typeIds.filter((typeId) => {
      const rows = baseline.filter((row) => row.TechTypeID === typeId)
      const { better } = rt.techFamily(typeId)

      return better !== 'none' && rows.some((row, index) => index > 0 && (better === 'higher' ? row.AdditionalInfo < rows[index - 1].AdditionalInfo : row.AdditionalInfo > rows[index - 1].AdditionalInfo))
    })

    return wrong.length ? `types ${wrong.join()} run the other way` : true
  })(), `${baseline.length} baseline rows`)

  // The candidates against the research tables read another way.
  const eligible = (await rowsOf(database, 'select TechSystemID from FCT_EligibleProjects where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID }).catch(() => [])).map((row) => row.TechSystemID)
  const busy = new Set([...(await rowsOf(database, 'select TechID from FCT_ResearchProject where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })).map((row) => row.TechID), ...(await rowsOf(database, 'select q.TechSystemID as TechID from FCT_ResearchQueue q inner join FCT_Population p on p.PopulationID = q.PopulationID and p.RaceID = :RaceID where q.GameID = :GameID', { GameID, RaceID })).map((row) => row.TechID)])
  const catalogue = await rowsOf(database, `select TechSystemID, TechTypeID, RuinOnly, RaceID, Prerequisite1, Prerequisite2 from FCT_TechSystem where (GameID = 0 or TechSystemID in (${eligible.length ? eligible.join(', ') : '0'})) and TechTypeID in (${typeIds.join(', ')})`)
  const everything = new Map((await rowsOf(database, 'select TechSystemID, RuinOnly, RaceID from FCT_TechSystem where GameID = 0')).map((row) => [row.TechSystemID, row]))
  const free = (id) => !id || researchedIds.has(id)
  const reachable = catalogue.filter((row) => !researchedIds.has(row.TechSystemID) && !busy.has(row.TechSystemID) && !row.RuinOnly && (row.RaceID === 0 || row.RaceID === RaceID || eligible.includes(row.TechSystemID)) && free(row.Prerequisite1) && free(row.Prerequisite2)).map((row) => row.TechSystemID).sort((a, b) => a - b)
  const available = lines.flatMap((entry) => entry.candidates.filter((item) => item.status === 'available')).map((item) => item.id).sort((a, b) => a - b)

  add(`the techs researchable now are the unresearched, free, reachable techs whose prerequisites are all researched (${available.length})`, same(available, reachable))

  add('no candidate of any line is ruin-only, another empire\'s unless the race was made eligible for it, or one the race has researched', (() => {
    const bad = lines.flatMap((entry) => entry.candidates).filter((item) => {
      const row = everything.get(item.id) || { RuinOnly: 0, RaceID: 0 }

      return row.RuinOnly || (row.RaceID !== 0 && row.RaceID !== RaceID && !eligible.includes(item.id)) || researchedIds.has(item.id)
    })

    return bad.length ? `${bad.length} candidates, the first ${bad[0].id}` : true
  })(), `${lines.reduce((total, entry) => total + entry.candidates.length, 0)} candidates`)

  add('a locked candidate names prerequisites the race has not researched, and a researchable one names none', lines.every((entry) => entry.candidates.every((item) => (item.status === 'locked' ? item.missing.length > 0 && item.missing.every((need) => !researchedIds.has(need.id)) : item.status === 'available' ? item.missing.length === 0 && item.researchable : !item.researchable))) || 'a candidate\'s prerequisites disagree with its status')

  add('an excluded tech is ruin-only, another empire\'s or needs one of those', lines.every((entry) => entry.excluded.every((item) => ['ruin', 'foreign', 'prerequisite', 'no-prerequisite'].includes(item.reason) && item.text.length > 0)) || 'an excluded tech has no reason', `${lines.reduce((total, entry) => total + entry.excluded.length, 0)} excluded`)

  add('the next level of a line is researchable now, above the pick, and the cheapest such', lines.every((entry) => {
    const above = entry.candidates.filter((item) => item.status === 'available' && (!entry.pick || item.cost > entry.pick.cost))
    const known = above.map((item) => item.cost).filter((cost) => cost !== null)
    const cheapest = known.length ? Math.min(...known) : null

    return entry.next === null ? above.filter((item) => item.cost !== null).length === 0 && above.length === 0 : entry.next.status === 'available' && entry.next.cost === cheapest
  }) || 'a line\'s next level is not the cheapest researchable one')

  // A hypothetical choice end to end, on a candidate of this save.
  const open = lines.find((entry) => entry.next)
  const locked = lines.find((entry) => entry.candidates.some((item) => item.status === 'locked'))

  if (open) {
    add(`a candidate of this save chosen from the research graph is hypothetical and marks a result (line ${open.typeId}, ${open.next.name})`, (() => {
      const resolved = ts.resolveChoices(tech, { [open.typeId]: { techId: open.next.id, source: 'scenario' } })[open.typeId]
      const { assumptions } = ts.hypotheticalOf(ts.resolveChoices(tech, { [open.typeId]: { techId: open.next.id, source: 'scenario' } }), [open.typeId])
      pv.registerRule({ id: 'check.figure', versions: ['2.7.x'], note: 'A figure of this check.', verification: 'confirmed' })
      const marked = ts.markHypothetical(pv.envelope({ value: 1, status: 'confirmed', rule: 'check.figure', inputs: { present: ['a'] } }), assumptions)

      return resolved.hypothetical && resolved.level.id === open.next.id && resolved.level !== open.pick && marked.status === 'assumed' && ts.isHypothetical(marked) ? true : short([resolved.kind, marked.status])
    })())
  }

  if (locked) {
    const item = locked.candidates.find((entry) => entry.status === 'locked')

    add(`a locked candidate of this save is offered as a hypothetical level and says what it needs (line ${locked.typeId}, ${item.name})`, (() => {
      const resolved = ts.resolveChoices(tech, { [locked.typeId]: { techId: item.id, source: 'scenario' } })[locked.typeId]
      const words = ts.describeHypothetical(resolved)

      return resolved.hypothetical && !resolved.candidate.researchable && words.includes('needs') && !ts.candidateText(item).includes('researchable now') ? true : short(words)
    })())
  }

  if (open) {
    add('a choice kept for the race survives a reload on this save, and is unresolved when the save no longer has the tech', await (async () => {
      const mem = memory()
      const repository = repositoryOf(m, mem)
      const scope = scopeIn(m, { RaceID })
      const outcome = await ts.saveChoice(repository, scope, tech, ts.readScenario(repository, scope, tech), { typeId: open.typeId, techId: open.next.id })
      const reopened = ts.readScenario(repositoryOf(m, mem), scope, tech)
      const back = ts.resolveChoices(tech, reopened.selection)[open.typeId]
      const lost = { ...tech, known: Object.fromEntries(Object.entries(tech.known).filter(([id]) => Number(id) !== open.next.id)), lines: { ...tech.lines, [open.typeId]: { ...open, candidates: open.candidates.filter((item) => item.id !== open.next.id), next: null } } }
      const gone = ts.resolveChoices(lost, ts.readScenario(repositoryOf(m, mem), scope, lost).selection)[open.typeId]

      return outcome.ok && back.hypothetical && back.level.id === open.next.id && gone.unresolved && gone.level === open.pick && !gone.hypothetical ? true : short([outcome, back.kind, gone.unresolved])
    })())
  }

  // The figures the registry's meaning of the reactor and armour types rests on.
  const reactors = await rowsOf(database, 'select c.Size, c.ComponentValue as cv, t1.AdditionalInfo as power, t2.AdditionalInfo as boost from FCT_ShipDesignComponents c inner join FCT_TechSystem t1 on t1.TechSystemID = c.BGTech1 and t1.TechTypeID = 41 inner join FCT_TechSystem t2 on t2.TechSystemID = c.BGTech2 and t2.TechTypeID = 42 where c.ComponentTypeID = 18')
  const reactorTotal = (await rowsOf(database, 'select count(*) as n from FCT_ShipDesignComponents where ComponentTypeID = 18'))[0].n

  add(`a reactor's power is its size to the power 1.5 times the Power Plant Technology figure times the boost, to 2 decimals (${reactors.length} reactors)`, reactors.length > 0 && reactors.length === reactorTotal && reactors.every((row) => Math.abs(Math.round((row.Size ** 1.5) * row.power * row.boost * 100) / 100 - row.cv) < 0.0051) ? true : `${reactors.length} of ${reactorTotal} reactors, the first off: ${short(reactors.find((row) => Math.abs(Math.round((row.Size ** 1.5) * row.power * row.boost * 100) / 100 - row.cv) >= 0.0051))}`)

  const plates = await rowsOf(database, 'select c.ComponentValue as cv, t1.AdditionalInfo as strength from FCT_ShipDesignComponents c inner join FCT_TechSystem t1 on t1.TechSystemID = c.BGTech1 and t1.TechTypeID = 84 where c.ComponentTypeID = 11 and c.Size = 1 and c.Name = t1.Name')

  add(`an armour plate of 1 HS has the Armour figure of its tech as its strength (${plates.length} plates)`, plates.length > 0 && plates.every((row) => row.cv === row.strength) ? true : short(plates.find((row) => row.cv !== row.strength)))

  return results
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))
  const real = await loadAll()
  const result = await searched()

  console.log('The race\'s tech: the pick, the candidates, the choices and the marking')

  for (const [name, test] of [...syntheticChecks(real), ...repositoryChecks(real)]) {
    check(name, await settle(test))
  }

  console.log('\nThe propulsion page (its script on a pseudo instance, scripts/lib/page-loader.js)')

  for (const [statement, held] of await pageStatements(null, real, result)) {
    check(statement, await settle(held))
  }

  if (options.mutations) {
    console.log('\nMutations: each must fail the checks it names')

    for (const { name, file, find, replace, fails } of MUTATIONS) {
      const began = Date.now()
      let directory = null

      try {
        directory = mutatedCopy(file, find, replace)

        const mutant = await loadAll(directory)
        const all = [...syntheticChecks(mutant), ...repositoryChecks(mutant)]
        const named = all.filter(([checkName]) => fails.some((start) => checkName.startsWith(start)))
        const absent = fails.filter((start) => !named.some(([checkName]) => checkName.startsWith(start)))
        const failed = []

        for (const [checkName, test] of named) {
          if ((await settle(test)) !== true) {
            failed.push(checkName)
          }
        }

        const missed = fails.filter((start) => !failed.some((checkName) => checkName.startsWith(start)))

        check(`mutation caught: ${name}`, absent.length ? `no check begins ${absent.join('; ')}` : missed.length ? `these checks did not fail: ${missed.join('; ')}` : true, `${failed.length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
      } catch (error) {
        check(`mutation caught: ${name}`, `does not load: ${error.message}`)
      } finally {
        if (directory) {
          fs.rmSync(directory, { recursive: true, force: true })
        }
      }
    }

    for (const { name, find, replace, fails } of PAGE_MUTATIONS) {
      const began = Date.now()

      try {
        const named = (await pageStatements(replacing(find, replace), real, result)).filter(([statement]) => fails.some((start) => statement.startsWith(start)))
        const absent = fails.filter((start) => !named.some(([statement]) => statement.startsWith(start)))
        const failed = []

        for (const [statement, held] of named) {
          if ((await settle(held)) !== true) {
            failed.push(statement)
          }
        }

        const missed = fails.filter((start) => !failed.some((statement) => statement.startsWith(start)))

        check(`page mutation caught: ${name}`, absent.length ? `no statement begins ${absent.join('; ')}` : missed.length ? `these statements did not fail: ${missed.join('; ')}` : true, `${failed.length} statements fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
      } catch (error) {
        check(`page mutation caught: ${name}`, `does not load: ${error.message}`)
      }
    }
  }

  for (const [label, [file, GameID, RaceID]] of [['modded', options.modded], ['stock', options.stock]]) {
    console.log(`\n${label} save: ${file} (game ${GameID}, race ${RaceID})`)

    const database = await openSave(file)

    if (!database) {
      console.log(`SKIP  ${file} is not there`)
      continue
    }

    for (const [name, verdict, detail] of await saveChecks(real, database, { GameID, RaceID }, label)) {
      check(name, verdict, detail)
    }

    database.close()
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
