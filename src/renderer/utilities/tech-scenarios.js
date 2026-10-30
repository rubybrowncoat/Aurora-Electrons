// The tech a planner designs with, and what it designs with when the player picks a level the race has not researched yet: the levels the race could research next, read from the research graph (research.js, so a tech with a missing prerequisite is never offered as researchable now), the choice of one, the results it makes hypothetical, and the record that keeps the choice for the race and branch (scenario-records.js). The researched levels and the game's pick are race-tech.js's. The save is only read.
//
// Candidates. A line's candidates are the catalogue's levels of its type that the race has not researched and could: not ruin-only, belonging to nobody or to the race (or made eligible), every prerequisite either researched or itself something the race could research. Each has the status `evaluateResearch` gives it: 'available' (every prerequisite is researched, so it is researchable now and nothing else is), 'locked' (some prerequisite is not researched: `missing` names them, deepest first, and `pathRp` is what the whole path costs), 'active' or 'queued' (a project or the queue holds it). A level that is ruin-only, another empire's or out of reach for good is in `excluded` with its reason and is never a candidate. `next` is the cheapest available candidate above the game's pick: a locked level is never the next one however cheap it is.
//
// A choice. The player picks one level of a line to design with. A researched one (any lower level, or the game's pick) is the race's own tech and makes nothing hypothetical; a candidate is a hypothetical level: every result built on it carries the assumption, and its status is at most 'assumed'. A choice the save cannot honour (the tech was deleted, its ID is another tech's now, it is ruin-only or another empire's, or the race no longer has it) is reported as unresolved with its reason and the line designs with the game's pick, visibly: the value of another level is never put in its place.
//
// The record. The hypothetical choices of a race on a branch are one record of kind 'planner.techChoice' (policy 'branch'): `payload.choices` maps a tech type to { techId, name, via, statusWhenChosen, pathRpWhenChosen }, and each choice is a link of type 'tech' whose fingerprint names the tech (its type, name, figures and development cost), so a reused ID reads as changed and a deleted one as missing, and neither is rebound. On every read the stored IDs are resolved against the open save.

import { isKnownNumber } from './math'
import { STATUS, envelope, registerRule, weakestStatus } from './provenance'
import { RACE_TECH_TYPES, TECH_FAMILIES, buildRaceTech, loadRaceTech } from './race-tech'
import { ACTIVE, AVAILABLE, BLOCK_REASONS, BLOCKED, DONE, LOCKED, QUEUED, STATUS_LABELS, buildTechGraph, evaluateResearch, researchState } from './research'

export const TECH_SCENARIO_KIND = 'planner.techChoice'
export const TECH_LINK_TYPE = 'tech'
export const HYPOTHETICAL_PREFIX = 'Hypothetical tech: '
// The only way a choice enters a record: a level of the race's next research.
export const NEXT_TECH = 'next-tech'

const SCENARIO_VERSIONS = ['2.7.x']

registerRule({
  id: 'tech.scenarioChoice',
  versions: SCENARIO_VERSIONS,
  note: 'The figure of a tech level the player picked from the race\'s next research. A planner\'s own what-if, not a game rule: the race has not researched the level.',
  verification: STATUS.ASSUMED,
  structure: ['FCT_TechSystem', 'FCT_RaceTech.TechID', 'FCT_EligibleProjects.TechSystemID', 'FCT_ResearchProject.TechID', 'FCT_ResearchQueue.TechSystemID', 'FCT_PausedResearch'],
  assumptions: ['The race researches the level before the design is built'],
})

// ---- The catalogue and the race's research ---------------------------------------------------------------------------

const CATALOGUE_COLUMNS = 'FCT_TechSystem.TechSystemID, FCT_TechSystem.GameID, FCT_TechSystem.Name, FCT_TechSystem.ComponentName, FCT_TechSystem.TechDescription, FCT_TechSystem.DevelopCost, FCT_TechSystem.RaceID, FCT_TechSystem.Prerequisite1, FCT_TechSystem.Prerequisite2, FCT_TechSystem.RuinOnly, FCT_TechSystem.AutomaticResearch, FCT_TechSystem.StartingSystem, FCT_TechSystem.ConventionalSystem, FCT_TechSystem.TechTypeID, FCT_TechSystem.AdditionalInfo, FCT_TechSystem.AdditionalInfo2, DIM_TechType.Description as TypeName, DIM_TechType.FieldID'

// The catalogue: the baseline techs (game 0) and the alien projects the race was made eligible for, which are rows of the game that holds them.
const catalogueSql = (eligible) => `select ${CATALOGUE_COLUMNS} from FCT_TechSystem inner join DIM_TechType on DIM_TechType.TechTypeID = FCT_TechSystem.TechTypeID where FCT_TechSystem.GameID = 0${eligible.length ? ` or FCT_TechSystem.TechSystemID in (${eligible.join(', ')})` : ''}`

const RESEARCHED_IDS_SQL = 'select FCT_RaceTech.TechID from FCT_RaceTech where FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID'

// The eligible projects of the race, read from FCT_EligibleProjects.
const ELIGIBLE_SQL = 'select FCT_EligibleProjects.TechSystemID from FCT_EligibleProjects where FCT_EligibleProjects.GameID = :GameID and FCT_EligibleProjects.RaceID = :RaceID'

const PROJECTS_SQL = 'select FCT_ResearchProject.TechID, FCT_ResearchProject.ResearchPointsRequired from FCT_ResearchProject where FCT_ResearchProject.GameID = :GameID and FCT_ResearchProject.RaceID = :RaceID'

// A queue belongs to a running project; the race comes through its colony.
const QUEUE_SQL = 'select FCT_ResearchQueue.TechSystemID as TechID from FCT_ResearchQueue inner join FCT_Population on FCT_Population.PopulationID = FCT_ResearchQueue.PopulationID and FCT_Population.RaceID = :RaceID where FCT_ResearchQueue.GameID = :GameID'

const PAUSED_SQL = 'select FCT_PausedResearch.TechSystemID, FCT_PausedResearch.PointsAccumulated from FCT_PausedResearch where FCT_PausedResearch.GameID = :GameID and FCT_PausedResearch.RaceID = :RaceID'

// A tech as a link's fingerprint and an unresolved choice know it.
const knownOf = (item) => ({ id: item.id, typeId: item.typeId, name: item.name, info: item.info, info2: item.info2, cost: item.cost })

const candidateOf = (row, entry, graph) => ({
  id: row.TechSystemID,
  typeId: row.TechTypeID,
  name: row.Name,
  componentName: row.ComponentName || row.Name,
  info: row.AdditionalInfo,
  info2: row.AdditionalInfo2,
  cost: row.DevelopCost,
  baseline: row.GameID === 0,
  obsolete: false,
  status: entry.status,
  statusLabel: STATUS_LABELS[entry.status],
  researchable: entry.status === AVAILABLE,
  missing: entry.missing.map((id) => ({ id, name: graph.techs.get(id).name })),
  remaining: entry.remaining,
  pathRp: entry.pathRp,
})

const byCost = (a, b) => (isKnownNumber(a.cost) ? (isKnownNumber(b.cost) ? a.cost - b.cost : -1) : isKnownNumber(b.cost) ? 1 : 0) || a.id - b.id

// The lines of `raceTech` with their candidates, what is `excluded` and the `next` level, and `known`, every tech of the catalogue and of the race by id. `research` has the rows the queries read: `catalogue` (FCT_TechSystem with DIM_TechType's Description as TypeName and FieldID), the ids `researched` and `eligible`, the `projects` ({ TechID, ResearchPointsRequired }), the `queued` ids and the `paused` rows ({ TechSystemID, PointsAccumulated }).
export const withCandidates = (raceTech, { raceId, catalogue, researched, eligible = [], projects = [], queued = [], paused = [] }) => {
  const graph = buildTechGraph(catalogue)
  const info = evaluateResearch(graph, researchState({ raceId, researched, eligible, projects, queued, paused }))
  const rows = new Map(catalogue.map((row) => [row.TechSystemID, row]))
  const candidates = {}
  const excluded = {}
  const known = {}

  catalogue.forEach((row) => {
    known[row.TechSystemID] = knownOf({ id: row.TechSystemID, typeId: row.TechTypeID, name: row.Name, info: row.AdditionalInfo, info2: row.AdditionalInfo2, cost: row.DevelopCost })
  })

  Object.values(raceTech.lines).forEach((entry) => entry.levels.forEach((item) => {
    known[item.id] = knownOf(item)
  }))

  graph.techs.forEach((tech) => {
    if (!TECH_FAMILIES[tech.typeId]) {
      return
    }

    const entry = info.get(tech.id)

    if (entry.status === DONE) {
      return
    }

    if (entry.status === BLOCKED) {
      (excluded[tech.typeId] = excluded[tech.typeId] || []).push({ id: tech.id, name: tech.name, reason: entry.reason, text: BLOCK_REASONS[entry.reason] || 'Out of reach' })
    } else {
      (candidates[tech.typeId] = candidates[tech.typeId] || []).push(candidateOf(rows.get(tech.id), entry, graph))
    }
  })

  const lines = {}

  RACE_TECH_TYPES.forEach((typeId) => {
    const entry = raceTech.lines[typeId]
    const own = (candidates[typeId] || []).sort(byCost)
    const pick = entry.pick

    lines[typeId] = Object.freeze({
      ...entry,
      candidates: own,
      excluded: (excluded[typeId] || []).sort(byCost),
      next: own.find((item) => item.status === AVAILABLE && (!pick || item.cost > pick.cost)) || null,
    })
  })

  return Object.freeze({ lines: Object.freeze(lines), fixed: raceTech.fixed, known: Object.freeze(known) })
}

// The race's tech with the candidates of every line: the researched levels and the game's pick of race-tech.js, and the research graph of the open save.
export const loadTechChoices = async (database, { GameID, RaceID }) => {
  const replacements = { GameID, RaceID }
  const eligible = await database.query(ELIGIBLE_SQL, { replacements }).then(([rows]) => rows.map((row) => Number(row.TechSystemID)).filter(Number.isInteger))
  const [raceTech, [catalogue], [researched], [projects], [queued], [paused]] = await Promise.all([
    loadRaceTech(database, { GameID, RaceID }),
    database.query(catalogueSql(eligible)),
    database.query(RESEARCHED_IDS_SQL, { replacements }),
    database.query(PROJECTS_SQL, { replacements }),
    database.query(QUEUE_SQL, { replacements }),
    database.query(PAUSED_SQL, { replacements }),
  ])

  return withCandidates(raceTech, { raceId: RaceID, catalogue, researched: researched.map((row) => row.TechID), eligible, projects, queued: queued.map((row) => row.TechID), paused })
}

// What a page holds before the race's tech is read: every line empty.
export const NO_TECH_CHOICES = withCandidates(buildRaceTech([]), { raceId: 0, catalogue: [], researched: [] })

// ---- A choice ------------------------------------------------------------------------------------------------------

const textOfRp = (value) => (isKnownNumber(value) ? `${value} RP` : 'an RP cost the save does not give')

// Why a tech is not a level of its line the race can design with, as a player reads it.
const reasonOf = (tech, typeId, choice, name) => {
  const row = tech.known[choice.techId]

  if (!row) {
    return 'The save has no tech with this ID.'
  }

  if (row.typeId !== typeId) {
    return `The ID names ${row.name}, a tech of another line.`
  }

  const blocked = tech.lines[typeId].excluded.find((item) => item.id === choice.techId)

  if (blocked) {
    return `${name} cannot be researched: ${blocked.text.toLowerCase()}.`
  }

  if (choice.source === 'preference' && tech.lines[typeId].candidates.some((item) => item.id === choice.techId)) {
    return 'The race no longer has this level researched.'
  }

  return `${name} is not a level the race has researched or can research.`
}

const LINK_REASONS = {
  missing: 'The save no longer has this tech.',
  changed: 'The ID now names another tech.',
  unknown: 'The tech could not be checked against the save.',
}

// The choices as the lines resolve them. `selection` maps a tech type to { techId, source, name, link }: `source` is 'preference' (a level the race has researched, as the page remembers it) or 'scenario' (a record's choice, whose `link` has the status the repository gave it). Per type of `tech.lines`: { typeId, level, kind, hypothetical, candidate, requested, unresolved, nowResearched }. `level` is what the line designs with: the chosen level, else the game's pick (null for a line with none). `kind` is 'default' (the game's pick), 'researched' (a lower level the race has), 'hypothetical' (a candidate) or 'none' (no level at all). An unresolved choice has `unresolved` = { techId, name, source, reason } and designs with the game's pick, never with another level's value.
export const resolveChoices = (tech, selection = {}) => Object.fromEntries(Object.entries(tech.lines).map(([key, entry]) => {
  const typeId = Number(key)
  const choice = selection[typeId]
  const base = { typeId, level: entry.pick, kind: entry.pick ? 'default' : 'none', hypothetical: false, candidate: null, requested: null, unresolved: null, nowResearched: false }

  if (!choice) {
    return [typeId, base]
  }

  const name = choice.name || (tech.known[choice.techId] ? tech.known[choice.techId].name : `tech ${choice.techId}`)
  const unresolved = (reason) => [typeId, { ...base, requested: choice.techId, unresolved: { techId: choice.techId, name, source: choice.source, reason } }]

  if (choice.link && choice.link.status !== 'linked') {
    const now = choice.link.status === 'changed' && tech.known[choice.techId] ? ` It is ${tech.known[choice.techId].name} now.` : ''

    return unresolved(`${LINK_REASONS[choice.link.status] || LINK_REASONS.unknown}${now}`)
  }

  const researched = entry.levels.find((item) => item.id === choice.techId)

  if (researched) {
    return [typeId, { ...base, level: researched, kind: entry.pick && entry.pick.id === researched.id ? 'default' : 'researched', requested: choice.techId, nowResearched: choice.source === 'scenario' }]
  }

  const candidate = choice.source === 'scenario' ? entry.candidates.find((item) => item.id === choice.techId) : null

  if (candidate) {
    return [typeId, { ...base, level: candidate, kind: 'hypothetical', hypothetical: true, candidate, requested: choice.techId }]
  }

  return unresolved(reasonOf(tech, typeId, choice, name))
}))

// The selection of a page: the researched levels it remembers (`preference`, { [typeId]: techId }) and a record's choices (`scenario`, from `scenarioSelection`). A line the record has a choice for takes the record's.
export const selectionOf = (preference = {}, scenario = {}) => {
  const selection = {}

  Object.entries(preference || {}).forEach(([typeId, techId]) => {
    selection[Number(typeId)] = { techId, source: 'preference' }
  })

  Object.entries(scenario).forEach(([typeId, choice]) => {
    selection[Number(typeId)] = choice
  })

  return selection
}

// ---- Hypothetical results --------------------------------------------------------------------------------------------

const stateOf = (candidate) => {
  if (candidate.status === AVAILABLE) {
    return `researchable now for ${textOfRp(candidate.cost)}`
  }

  if (candidate.status === LOCKED) {
    return `it needs ${candidate.missing.map((item) => item.name).join(', ')} first, ${isKnownNumber(candidate.pathRp) ? `${candidate.pathRp} RP on the whole path` : 'and the save does not give the cost of the path'}`
  }

  return candidate.status === ACTIVE ? 'being researched' : candidate.status === QUEUED ? 'queued for research' : candidate.statusLabel
}

// A candidate's status in words for a menu: researchable only when every prerequisite is researched; a locked one names what it needs and the cost of the path, and an unknown cost is said to be unknown, never 0. `format` writes a number.
export const candidateText = (candidate, format = String) => {
  const cost = isKnownNumber(candidate.cost) ? `${format(candidate.cost)} RP` : 'cost not in the save'

  if (candidate.status === AVAILABLE) {
    return `${cost} · researchable now`
  }

  if (candidate.status === LOCKED) {
    return `${cost} · locked, needs ${candidate.missing.map((item) => item.name).join(', ')} first · ${isKnownNumber(candidate.pathRp) ? `${format(candidate.pathRp)} RP on the path` : 'path cost not in the save'}`
  }

  return `${cost} · ${candidate.statusLabel.toLowerCase()}, not researched yet`
}

// The hypothetical line of a resolution in words, as the assumption its results carry.
export const describeHypothetical = (resolved) => {
  const family = TECH_FAMILIES[resolved.typeId]

  return `${HYPOTHETICAL_PREFIX}${family ? family.name : `type ${resolved.typeId}`} is ${resolved.level.name}, a level the race has not researched (${stateOf(resolved.candidate)})`
}

// The hypothetical lines among `typeIds`, and their assumptions.
export const hypotheticalOf = (resolution, typeIds) => {
  const lines = typeIds.map((typeId) => resolution[typeId]).filter((resolved) => resolved && resolved.hypothetical)

  return { lines, assumptions: lines.map(describeHypothetical) }
}

// Whether a result carries a hypothetical tech.
export const isHypothetical = (result) => Boolean(result) && result.assumptions.some((assumption) => assumption.startsWith(HYPOTHETICAL_PREFIX))

// The hypothetical-tech assumptions the given results carry (a null result carries none), each once.
export const hypotheticalAssumptionsOf = (results) => [...new Set(results.filter(Boolean).flatMap((result) => result.assumptions.filter((assumption) => assumption.startsWith(HYPOTHETICAL_PREFIX))))]

// A result built on hypothetical tech: the same value, rule and inputs, at most 'assumed' (a weaker status stays), with the assumptions added. A result with no value stays without one.
export const markHypothetical = (result, assumptions) => {
  if (!result || !assumptions.length) {
    return result
  }

  const status = result.status === STATUS.UNAVAILABLE ? STATUS.UNAVAILABLE : weakestStatus([result.status, STATUS.ASSUMED])

  return envelope({ value: result.value, status, rule: result.rule.id, inputs: result.inputs, units: result.units, assumptions: [...result.assumptions, ...assumptions] })
}

// Every result of an object of results (a null one stays null) marked as built on hypothetical tech.
export const markAllHypothetical = (results, assumptions) => Object.fromEntries(Object.entries(results).map(([key, result]) => [key, markHypothetical(result, assumptions)]))

// The choice of a line as a result: the level's figure, assumed. Null when the line's choice is not hypothetical.
export const choiceResult = (resolved) => (resolved.hypothetical && isKnownNumber(resolved.level.info) ? envelope({ value: Number(resolved.level.info), status: STATUS.ASSUMED, rule: 'tech.scenarioChoice', inputs: { present: [resolved.level.name] }, assumptions: [describeHypothetical(resolved)] }) : null)

// ---- The record ----------------------------------------------------------------------------------------------------

const NUMERIC_KEY = /^\d+$/

const isText = (value) => typeof value === 'string' && value !== ''

const CHOICE_STATUSES = [AVAILABLE, LOCKED, ACTIVE, QUEUED]

const problemsOf = (payload) => {
  const choices = payload && payload.choices

  if (choices === null || typeof choices !== 'object' || Array.isArray(choices)) {
    return ['the payload has a choices object']
  }

  return Object.entries(choices).flatMap(([typeId, choice]) => {
    const problems = []

    if (!NUMERIC_KEY.test(typeId)) {
      problems.push(`the key ${typeId} is not a tech type`)
    }

    if (choice === null || typeof choice !== 'object' || !Number.isInteger(choice.techId) || choice.techId < 1 || !isText(choice.name) || choice.via !== NEXT_TECH || !CHOICE_STATUSES.includes(choice.statusWhenChosen) || !(choice.pathRpWhenChosen === null || (typeof choice.pathRpWhenChosen === 'number' && Number.isFinite(choice.pathRpWhenChosen)))) {
      problems.push(`the choice for type ${typeId} is { techId, name, via: 'next-tech', statusWhenChosen, pathRpWhenChosen }`)
    }

    return problems
  })
}

// The adapter of the scenario repository for the hypothetical tech choices: its fingerprint is what names a tech (type, name, figures and development cost), and it resolves a link from the `known` techs of the open save (`context.known`).
export const techScenarioAdapter = Object.freeze({
  kind: TECH_SCENARIO_KIND,
  schema: 1,
  validate: problemsOf,
  fingerprint: (type, row) => [type, row.typeId, row.name, row.info, row.info2, row.cost].join('|'),
  resolve: (links, context) => links.map((link) => (context && context.known && context.known[link.id]) || null),
  versions: () => ({ 'tech.scenarioChoice': SCENARIO_VERSIONS.join(', ') }),
})

const registered = new WeakSet()

// Registers the adapter with a repository's `registerAdapter`, once per function.
export const registerTechScenarios = (register) => {
  if (registered.has(register)) {
    return
  }

  try {
    register(techScenarioAdapter)
  } catch (error) {
    if (!/registered already/.test(String(error && error.message))) {
      throw error
    }
  }

  registered.add(register)
}

// The scope of the repository for the open save, or null while it is not known: `campaign` is the store's settled campaign ({ campaignId, branchId }, null until settled), `gameTime` the game clock.
export const scopeOf = ({ campaign, RaceID, gameTime }) => (campaign && campaign.campaignId && campaign.branchId && Number.isInteger(RaceID) && Number.isFinite(gameTime) ? { campaignId: campaign.campaignId, RaceID, branchId: campaign.branchId, gameTime } : null)

const NOT_APPLIED = ['newer-schema', 'no-adapter', 'invalid-payload']

const unappliedReason = (item) => (item.flags.some((flag) => NOT_APPLIED.includes(flag)) ? 'The scenario was written by another version of the app or is not valid, so it is not applied.' : item.status === 'ahead' ? 'The scenario was saved at a later game time than this save, so it is not applied.' : 'Another scenario of the same branch is newer, so this one is not applied.')

// The scenario of the race on the branch as the open save reads it. `entry` is the newest record the adapter understands (current or ahead: the one a choice edits), `selection` the choices of `entry` as `resolveChoices` takes them (none while `entry` is ahead of the save), `notes` the records listed and not applied and why, and `error` the refusal when the file cannot be read. Nothing is written.
export const readScenario = (repository, scope, tech) => {
  const empty = { entry: null, selection: {}, notes: [], error: null }

  if (!scope || !repository) {
    return empty
  }

  let entries

  try {
    entries = repository.list(scope, { kind: TECH_SCENARIO_KIND, context: { known: tech.known } })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: { code: error.code, message: error.message } }
    }

    throw error
  }

  const editable = entries.filter((item) => !item.flags.some((flag) => NOT_APPLIED.includes(flag)))
  const entry = editable.length ? editable[editable.length - 1] : null
  const applied = entry && entry.status === 'current' ? entry : null
  const notes = entries.filter((item) => item !== applied).map((item) => ({ uuid: item.record.uuid, flags: item.flags, status: item.status, reason: unappliedReason(item) }))
  const selection = {}

  if (applied) {
    Object.entries(applied.payload.choices).forEach(([typeId, choice]) => {
      selection[Number(typeId)] = { techId: choice.techId, name: choice.name, source: 'scenario', link: applied.links.find((link) => link.type === TECH_LINK_TYPE && link.id === choice.techId) || { status: 'unknown' } }
    })
  }

  return { entry, selection, notes, error: null }
}

// The payload after one change: `{ typeId, techId }` picks a candidate of the line, `{ typeId, techId: null }` forgets the line's choice.
const changedPayload = (payload, tech, change) => {
  const choices = { ...payload.choices }
  const key = String(change.typeId)

  if (change.techId === null) {
    delete choices[key]

    return { choices }
  }

  const candidate = tech.lines[change.typeId] ? tech.lines[change.typeId].candidates.find((item) => item.id === change.techId) : null

  if (!candidate) {
    throw Object.assign(new Error(`The tech ${change.techId} is not a level the race can research on line ${change.typeId}`), { code: 'not-a-candidate' })
  }

  choices[key] = { techId: candidate.id, name: candidate.name, via: NEXT_TECH, statusWhenChosen: candidate.status, pathRpWhenChosen: isKnownNumber(candidate.pathRp) ? Number(candidate.pathRp) : null }

  return { choices }
}

// The patch of a record for a payload: the links a choice keeps are the ones stored (never re-fingerprinted: a link is not rebound), the link of the tech `refresh` just picked and any new choice link to the tech as the open save has it, and the assumptions name each hypothetical tech.
const patchOf = (payload, tech, stored, refresh = null) => ({
  payload,
  links: Object.values(payload.choices).map((choice) => stored.find((link) => link.type === TECH_LINK_TYPE && link.id === choice.techId && choice.techId !== refresh) || { type: TECH_LINK_TYPE, id: choice.techId, row: tech.known[choice.techId] }),
  assumptions: Object.values(payload.choices).map((choice) => `${HYPOTHETICAL_PREFIX}${choice.name} (tech ${choice.techId}) is a level the race has not researched`),
})

const failure = (error) => ({ ok: false, code: (error && error.code) || 'failed', message: error && error.message ? error.message : String(error) })

// Keeps a change of the hypothetical choices in the record of the race on the branch: creates it, or edits the one `current` (the result of `readScenario`) holds. In a browser the write is made only once this tab holds the file (`repository.writable`); a tab that does not, a file that cannot be written and a choice that is not a candidate answer `{ ok: false, code, message }` and write nothing. An edit made against a record another window changed meanwhile is made again over what is stored, explicitly (`reconcile`). Returns `{ ok: true, record }`.
export const saveChoice = async (repository, scope, tech, current, change) => {
  try {
    if (!repository) {
      return { ok: false, code: 'no-repository', message: 'The scenario records are not available in this window, so the choice is kept for this page only.' }
    }

    if (!scope) {
      return { ok: false, code: 'no-scope', message: 'The campaign of this save is not settled yet, so the choice is kept for this page only.' }
    }

    if (!(await repository.writable(scope.campaignId))) {
      return { ok: false, code: 'not-owner', message: 'Another tab holds the scenario file, so the choice is kept for this page only.' }
    }

    const entry = current && current.entry

    if (!entry) {
      const patch = patchOf(changedPayload({ choices: {} }, tech, change), tech, [])

      return { ok: true, record: repository.create(scope, { kind: TECH_SCENARIO_KIND, policy: 'branch', ...patch }) }
    }

    const edit = { ...patchOf(changedPayload(entry.status === 'current' ? entry.payload : { choices: {} }, tech, change), tech, entry.record.links, change.techId), ...(entry.status === 'current' ? {} : { rebase: true }) }

    try {
      return { ok: true, record: repository.update(scope, entry.record.uuid, entry.record.revision, edit) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      return { ok: true, record: repository.reconcile(scope, error, patchOf(changedPayload(error.stored.payload, tech, change), tech, error.stored.links, change.techId)) }
    }
  } catch (error) {
    return failure(error)
  }
}
