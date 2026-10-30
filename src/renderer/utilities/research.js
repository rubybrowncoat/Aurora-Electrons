// The research domain: the tech catalogue as a graph, and what each tech is to one race.
//
// The game lists a project as researchable when its field matches, it is not ruin-only, it belongs to nobody or to the race (or the race made it eligible), its prerequisites are researched, and it is not researched, running or queued. A prerequisite id that has no tech row can never be researched, so a tech that needs one is out of reach for good. `evaluateResearch` computes that once for every tech, with the path to it, so the page only reads.

import { toBoolean } from './aurora'
import { countText, isKnownNumber, UNKNOWN_TEXT } from './math'
import { combine, isAvailable, ofRule, registerRule, unavailable, valueOrNull } from './provenance'

export const DONE = 'done'
export const ACTIVE = 'active'
export const QUEUED = 'queued'
export const AVAILABLE = 'available'
export const LOCKED = 'locked'
export const BLOCKED = 'blocked'

const RESEARCH_VERSIONS = ['2.7.x']
const RATE_RULE = 'research.projectRate'
const LANDING_RULE = 'research.landing'
// The key a construct row with no research field is kept under, so every field's bonus reads as unknown.
const FIELD_UNKNOWN = 'unknown'

registerRule({
  id: 'research.researched',
  versions: RESEARCH_VERSIONS,
  units: 'technologies',
  verification: 'confirmed',
  structure: ['FCT_TechSystem', 'FCT_RaceTech.TechID', 'FCT_ResearchProject.TechID', 'FCT_ResearchQueue.TechSystemID', 'FCT_EligibleProjects.TechSystemID'],
  note: 'Count of the techs in a state (researched, running, queued, available, locked or out of reach) from the race\'s own research rows and the catalogue. Out of reach techs are left out of what the race can research. The state follows the researchable-list rule written above the evaluation and is not compared with the game\'s own count.',
})

registerRule({
  id: 'research.researchedShare',
  versions: RESEARCH_VERSIONS,
  units: 'share of what can be researched',
  verification: 'confirmed',
  structure: ['the research.researched counts'],
  note: 'Techs researched over those the race can research, researched, running, queued, available and locked. Arithmetic on two counts; with nothing to research there is no share.',
})

registerRule({
  id: 'research.available',
  versions: RESEARCH_VERSIONS,
  units: 'technologies',
  verification: 'confirmed',
  structure: ['the research.researched counts'],
  note: 'Count of techs whose prerequisites are researched and that are not researched, running or queued.',
})

registerRule({
  id: 'research.freeScientists',
  versions: RESEARCH_VERSIONS,
  units: 'scientists',
  verification: 'confirmed',
  structure: ['FCT_Commander.CommanderType, CommandType, Deceased and retirement state'],
  note: 'Count of the race\'s serving scientists with no assignment, who could start a project. A group with no rows is a known 0.',
})

registerRule({
  id: 'research.startPoints',
  versions: RESEARCH_VERSIONS,
  units: 'RP',
  verification: 'confirmed',
  structure: ['FCT_Race.StartTechPoints'],
  note: 'The race\'s starting tech points still unspent, as the save stores them.',
})

registerRule({
  id: 'research.remaining',
  versions: RESEARCH_VERSIONS,
  units: 'RP',
  verification: 'confirmed',
  structure: ['FCT_ResearchProject.ResearchPointsRequired', 'FCT_TechSystem.DevelopCost', 'FCT_PausedResearch.PointsAccumulated'],
  note: 'RP still to pay for a tech: a running project\'s stored RP left, else its development cost less the points banked in paused research (none banked is 0). Arithmetic on stored values, never below 0.',
})

registerRule({
  id: 'research.pathRp',
  versions: RESEARCH_VERSIONS,
  units: 'RP',
  verification: 'estimated',
  structure: ['the research.remaining figure of the tech and of each unresearched prerequisite'],
  note: 'RP left on the tech plus RP left on every unresearched prerequisite behind it. Whether the game\'s Path RP is the same figure is not checked.',
})

registerRule({
  id: RATE_RULE,
  versions: RESEARCH_VERSIONS,
  units: 'RP/yr',
  verification: 'estimated',
  structure: ['FCT_ResearchProject.Facilities, ResSpecID', 'FCT_Commander.ResSpecID', 'FCT_CommanderBonuses.BonusValue (Research bonus 3)', 'FCT_Species.ResearchRateModifier', 'FCT_Race.Research, EconomicProdModifier', 'FCT_Population.Efficiency, UnrestPoints', 'FCT_SystemBody.RadiationLevel', 'DIM_PopPoliticalStatus.ProductionMod', 'FCT_Game.ResearchSpeed', 'FCT_AncientConstruct.ResearchField, ResearchBonus'],
  note: 'RP a year the project\'s labs make: output per lab times the labs, the scientist\'s Research bonus (a scientist with no stored Research bonus has none, read as 1; counted four times over on a project of the scientist\'s own field), the colony\'s own ancient construct bonus and a tenth of every active construct\'s bonus above 1 for the field. A project with no scientist makes none in the research list, so it has no rate here. The rate is not compared with the game\'s research list.',
})

registerRule({
  id: 'research.output',
  versions: RESEARCH_VERSIONS,
  units: 'RP/yr',
  verification: 'estimated',
  structure: ['the research.projectRate figure of each running project'],
  note: 'Sum of the rates of the projects that are running. A paused project makes none; a project with no rate leaves the sum short and is named as missing.',
})

registerRule({
  id: 'research.labs',
  versions: RESEARCH_VERSIONS,
  units: 'labs',
  verification: 'confirmed',
  structure: ['FCT_PopulationInstallations.Amount of installations with a research value', 'FCT_ResearchProject.Facilities'],
  note: 'Labs the race has built, the labs its projects have assigned, and the labs idle (built less assigned). Counts of stored values; labs assigned beyond those built are counted apart and never make a negative.',
})

registerRule({
  id: LANDING_RULE,
  versions: RESEARCH_VERSIONS,
  units: 'years',
  verification: 'estimated',
  structure: ['FCT_ResearchProject.ResearchPointsRequired', 'FCT_ResearchQueue.ResearchOrder', 'FCT_TechSystem.DevelopCost', 'the research.projectRate figure'],
  note: 'Years until a project lands: its RP left over its rate. A queued tech starts when the one before it lands and is paid at the project\'s labs and scientist at the queued tech\'s own field. A project that is paused or makes no RP never lands, and nothing behind it does.',
})

registerRule({
  id: 'research.nextLanding',
  versions: RESEARCH_VERSIONS,
  units: 'years',
  verification: 'estimated',
  structure: ['the research.landing figure of each running project', 'FCT_Game.StartYear, GameTime'],
  note: 'The soonest landing among the running projects, dated from the game clock.',
})

// Why a tech can never be researched by the race, as a player reads it.
export const BLOCK_REASONS = {
  ruin: 'Only found in ancient ruins',
  foreign: "Another empire's technology",
  'no-prerequisite': 'Needs a technology the game does not provide',
  prerequisite: 'Needs a technology that cannot be researched',
}

export const STATUS_LABELS = {
  [DONE]: 'Researched',
  [ACTIVE]: 'In progress',
  [QUEUED]: 'Queued',
  [AVAILABLE]: 'Available',
  [LOCKED]: 'Locked',
  [BLOCKED]: 'Out of reach',
}

// The catalogue as `rows` from FCT_TechSystem (GameID 0, plus the race's eligible alien projects) with DIM_TechType's Description (TypeName) and FieldID: tech by id, with its prerequisites and dependents.
export const buildTechGraph = (rows) => {
  const techs = new Map()

  rows.forEach((row) => techs.set(row.TechSystemID, {
    id: row.TechSystemID,
    name: row.Name,
    description: row.TechDescription || '',
    cost: row.DevelopCost,
    fieldId: row.FieldID,
    typeId: row.TechTypeID,
    typeName: row.TypeName,
    raceId: row.RaceID,
    ruinOnly: toBoolean(row.RuinOnly),
    automatic: toBoolean(row.AutomaticResearch),
    starting: toBoolean(row.StartingSystem),
    conventional: toBoolean(row.ConventionalSystem),
    prerequisites: [row.Prerequisite1, row.Prerequisite2].filter((id) => id),
    dependents: [],
  }))

  techs.forEach((tech) => tech.prerequisites.forEach((id) => {
    const prerequisite = techs.get(id)

    if (prerequisite) {
      prerequisite.dependents.push(tech.id)
    }
  }))

  return { techs }
}

// Everything the race's rows say about its research, as the sets and maps `evaluateResearch` takes: `researched` and `eligible` are sets of tech ids, `projects` maps a running tech to its RP left, `queued` is a set of queued tech ids, `paused` maps a tech to the RP already banked.
export const researchState = ({ raceId, researched, eligible = [], projects = [], queued = [], paused = [] }) => ({
  raceId,
  researched: new Set(researched),
  eligible: new Set(eligible),
  projects: new Map(projects.map((project) => [project.TechID, project.ResearchPointsRequired])),
  queued: new Set(queued),
  paused: new Map(paused.map((row) => [row.TechSystemID, row.PointsAccumulated])),
})

// Per tech: { status, reason, remaining, missing, pathRp, unlocks, gaps }.
//   remaining  RP still to pay for this tech (a running project's RP left, else its cost less banked points), null when the cost, the project's RP left or the banked points are not stored
//   missing    ids of the unresearched techs it needs, deepest prerequisite first, itself not included
//   pathRp     remaining of the tech plus all of `missing`: the game's "Path RP", less progress already made; null when any of those is not known
//   unlocks    direct dependents that are not researched yet
//   gaps       { remaining, pathRp }: the stored values each of those two lacks, by name, for `remainingResult` and `pathRpResult`
export const evaluateResearch = (graph, state) => {
  const { techs } = graph
  const { raceId, researched, eligible, projects, queued, paused } = state
  const info = new Map()
  const visiting = new Set()

  const remainingOf = (tech) => {
    if (projects.has(tech.id)) {
      const left = projects.get(tech.id)

      return isKnownNumber(left) ? left : null
    }

    const banked = paused.has(tech.id) ? paused.get(tech.id) : 0

    return isKnownNumber(tech.cost) && isKnownNumber(banked) ? Math.max(0, tech.cost - banked) : null
  }

  const remainingGaps = (tech) => {
    if (projects.has(tech.id)) {
      return isKnownNumber(projects.get(tech.id)) ? [] : [`RP left on the project of ${tech.name}`]
    }

    const banked = paused.has(tech.id) ? paused.get(tech.id) : 0

    return [...(isKnownNumber(tech.cost) ? [] : [`development cost of ${tech.name}`]), ...(isKnownNumber(banked) ? [] : [`points banked on ${tech.name}`])]
  }

  const blockReason = (tech) => {
    if (tech.ruinOnly) {
      return 'ruin'
    } else if (tech.raceId !== 0 && tech.raceId !== raceId && !eligible.has(tech.id)) {
      return 'foreign'
    }

    for (const id of tech.prerequisites) {
      const prerequisite = techs.get(id)

      if (!prerequisite) {
        return researched.has(id) ? null : 'no-prerequisite'
      } else if (!researched.has(id) && visit(prerequisite).status === BLOCKED) {
        return 'prerequisite'
      }
    }

    return null
  }

  const visit = (tech) => {
    if (info.has(tech.id)) {
      return info.get(tech.id)
    }

    // A prerequisite cycle in a hand-edited save: treat the repeat as out of reach rather than recurse forever.
    if (visiting.has(tech.id)) {
      return { status: BLOCKED, remaining: 0, missing: [], gaps: { remaining: [], pathRp: [] } }
    }

    visiting.add(tech.id)

    const entry = { status: null, reason: null, remaining: remainingOf(tech), missing: [], pathRp: 0, unlocks: 0, gaps: { remaining: remainingGaps(tech), pathRp: [] } }
    const open = tech.prerequisites.filter((id) => !researched.has(id))
    const missing = new Set()

    open.forEach((id) => {
      const prerequisite = techs.get(id)

      if (prerequisite) {
        visit(prerequisite).missing.forEach((deeper) => missing.add(deeper))
        missing.add(id)
      }
    })

    entry.missing = [...missing]

    const pathGaps = new Set(entry.gaps.remaining)

    entry.missing.forEach((id) => (info.has(id) ? info.get(id).gaps.remaining : []).forEach((gap) => pathGaps.add(gap)))
    entry.gaps.pathRp = [...pathGaps]
    entry.pathRp = entry.gaps.pathRp.length ? null : entry.remaining + entry.missing.reduce((sum, id) => sum + (info.has(id) ? info.get(id).remaining : 0), 0)

    if (projects.has(tech.id)) {
      entry.status = ACTIVE
    } else if (researched.has(tech.id)) {
      entry.status = DONE
    } else if (queued.has(tech.id)) {
      entry.status = QUEUED
    } else {
      entry.reason = blockReason(tech)
      entry.status = entry.reason ? BLOCKED : open.length ? LOCKED : AVAILABLE
    }

    entry.unlocks = tech.dependents.filter((id) => !researched.has(id)).length

    visiting.delete(tech.id)
    info.set(tech.id, entry)

    return entry
  }

  techs.forEach((tech) => visit(tech))

  return info
}

const costOrder = (a, b) => (isKnownNumber(a.cost) ? (isKnownNumber(b.cost) ? a.cost - b.cost : -1) : isKnownNumber(b.cost) ? 1 : 0)

// The catalogue as lines: a tech type's techs from the cheapest up (one with no stored cost last), with the race's progress on each. `visible` filters the techs that belong on the page (the displayed fields).
export const buildLines = (graph, info, visible = () => true) => {
  const lines = new Map()

  graph.techs.forEach((tech) => {
    if (!visible(tech)) {
      return
    }

    if (!lines.has(tech.typeId)) {
      lines.set(tech.typeId, { typeId: tech.typeId, name: tech.typeName, fieldId: tech.fieldId, techs: [] })
    }

    lines.get(tech.typeId).techs.push(tech)
  })

  return [...lines.values()].map((line) => {
    line.techs.sort((a, b) => a.cost - b.cost || a.id - b.id)

    const reachable = line.techs.filter((tech) => info.get(tech.id).status !== BLOCKED)
    const done = line.techs.filter((tech) => info.get(tech.id).status === DONE)
    const next = line.techs.find((tech) => ![DONE, BLOCKED].includes(info.get(tech.id).status)) || null

    return { ...line, total: reachable.length, done: done.length, best: done[done.length - 1] || null, next }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

// The techs `visible` accepts, grouped by field and then by status: Map(fieldId -> { done: [], active: [], ... }).
export const groupTechs = (graph, info, visible = () => true) => {
  const fields = new Map()

  graph.techs.forEach((tech) => {
    if (!visible(tech)) {
      return
    }

    if (!fields.has(tech.fieldId)) {
      fields.set(tech.fieldId, { [DONE]: [], [ACTIVE]: [], [QUEUED]: [], [AVAILABLE]: [], [LOCKED]: [], [BLOCKED]: [] })
    }

    fields.get(tech.fieldId)[info.get(tech.id).status].push(tech)
  })

  return fields
}

// Counts by status for the techs `visible` accepts.
export const countStatuses = (graph, info, visible = () => true) => {
  const counts = { [DONE]: 0, [ACTIVE]: 0, [QUEUED]: 0, [AVAILABLE]: 0, [LOCKED]: 0, [BLOCKED]: 0 }

  graph.techs.forEach((tech) => {
    if (visible(tech)) {
      counts[info.get(tech.id).status] += 1
    }
  })

  return counts
}

// A target's prerequisite chain as layers for drawing: the target, its unresearched prerequisites, and the researched techs it leans on directly, each in a column by its longest path from the left. Returns { nodes: [{ id, layer, row }], edges: [{ from, to }], layers }.
export const prerequisiteChain = (graph, info, targetId) => {
  const target = graph.techs.get(targetId)
  const open = [targetId, ...info.get(targetId).missing]
  const ids = new Set(open)
  const edges = []

  // The researched prerequisites of the open techs are the leaves: what the race already has to build on.
  open.forEach((id) => {
    graph.techs.get(id).prerequisites.forEach((prerequisite) => {
      if (graph.techs.has(prerequisite)) {
        ids.add(prerequisite)
        edges.push({ from: prerequisite, to: id })
      }
    })
  })

  const layer = new Map()
  const depthOf = (id) => {
    if (layer.has(id)) {
      return layer.get(id)
    }

    const incoming = edges.filter((edge) => edge.to === id).map((edge) => edge.from)
    const depth = incoming.length ? 1 + Math.max(...incoming.map(depthOf)) : 0

    layer.set(id, depth)

    return depth
  }

  ids.forEach(depthOf)

  const layers = []

  ids.forEach((id) => (layers[layer.get(id)] = layers[layer.get(id)] || []).push(id))

  const position = new Map()
  const average = (id, side) => {
    const around = edges.filter((edge) => (side === 'in' ? edge.to === id : edge.from === id)).map((edge) => (side === 'in' ? edge.from : edge.to)).filter((other) => position.has(other))

    return around.length ? around.reduce((sum, other) => sum + position.get(other), 0) / around.length : null
  }

  layers.forEach((column) => column.sort((a, b) => costOrder(graph.techs.get(a), graph.techs.get(b))).forEach((id, index) => position.set(id, index)))

  // Pull each node toward the mean row of its neighbours, a few sweeps both ways, to cut crossings.
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const order = sweep % 2 === 0 ? layers : [...layers].reverse()

    order.forEach((column) => {
      const wanted = new Map(column.map((id) => [id, average(id, sweep % 2 === 0 ? 'in' : 'out')]))

      column.sort((a, b) => (wanted.get(a) ?? position.get(a)) - (wanted.get(b) ?? position.get(b)) || a - b).forEach((id, index) => position.set(id, index))
    })
  }

  return {
    target,
    layers: layers.length,
    nodes: [...ids].map((id) => ({ id, layer: layer.get(id), row: position.get(id) })),
    edges,
  }
}

// A scientist on a project of the scientist's own field counts the Research bonus four times over (1.15 becomes 1.60); null when the bonus is not known.
export const researchMultiplier = (bonus, specialised) => (!isKnownNumber(bonus) ? null : specialised ? 4 * bonus - 3 : bonus)

// The race-wide bonus per field from its active ancient constructs: each adds a tenth of its bonus above 1. `constructs` has one row per populated colony on a construct, as the game counts them. A field with no construct has no entry (no bonus); a construct row without its bonus makes its field's entry null, and one without a field adds an `unknown` entry that leaves every field's bonus unknown.
export const fieldBonuses = (constructs) => {
  const bonuses = {}

  constructs.forEach((row) => {
    const key = isKnownNumber(row.FieldID) ? row.FieldID : FIELD_UNKNOWN
    const current = key in bonuses ? bonuses[key] : 1

    bonuses[key] = current === null || !isKnownNumber(row.ResearchBonus) ? null : current + (row.ResearchBonus - 1) / 10
  })

  return bonuses
}

// RP a year the project's labs make on a tech of `fieldId`, as the game's research list shows it, as a result of `research.projectRate`. A project with no scientist has no rate (it makes none), and so has one whose output per lab, labs, scientist bonus, scientist field (it decides whether the bonus counts four times over), field or construct bonus is not stored.
export const annualResearchPointsResult = (project, fieldId, bonuses = {}) => {
  if (!project.CommanderID) {
    return unavailable({ rule: RATE_RULE, missing: ['a scientist on the project (a project without one makes none)'] })
  }

  const known = isKnownNumber(fieldId)
  const onConstruct = known && isKnownNumber(project.LocalConstructField) && project.LocalConstructField === fieldId
  const fieldBonus = known && fieldId in bonuses ? bonuses[fieldId] : 1
  const needed = [
    ['the colony\'s research output per lab', project.OutputPerLab],
    ['the labs assigned to the project', project.Facilities],
    ['the scientist\'s Research bonus', project.ResearchBonus],
    ['the scientist\'s research field', project.ScientistField],
    ['the research field of the tech', fieldId],
    ...(onConstruct ? [['the colony\'s ancient construct bonus', project.LocalConstructBonus]] : []),
    ['the ancient construct bonus of the field', fieldBonus],
    ...(FIELD_UNKNOWN in bonuses ? [['the research field of an ancient construct', null]] : []),
  ]
  const missing = needed.filter(([, value]) => !isKnownNumber(value)).map(([name]) => name)

  if (missing.length) {
    return unavailable({ rule: RATE_RULE, missing, present: needed.filter(([, value]) => isKnownNumber(value)).map(([name]) => name) })
  }

  const local = onConstruct ? project.LocalConstructBonus : 1

  return ofRule({ rule: RATE_RULE, value: project.OutputPerLab * project.Facilities * researchMultiplier(project.ResearchBonus, project.ScientistField === fieldId) * local * fieldBonus, inputs: { present: ['the project\'s scientist', ...needed.map(([name]) => name)] } })
}

// RP a year, or null when the project has no rate (see `annualResearchPointsResult` for why).
export const annualResearchPoints = (project, fieldId, bonuses = {}) => valueOrNull(annualResearchPointsResult(project, fieldId, bonuses))

const projectName = (project) => project.Name || 'a project'

// The RP of a tech still to pay, as a result of `research.remaining`, naming the stored values an unknown one lacks.
export const remainingResult = (entry) => (entry.gaps.remaining.length ? unavailable({ rule: 'research.remaining', missing: entry.gaps.remaining }) : ofRule({ rule: 'research.remaining', value: entry.remaining, inputs: { present: ['development cost, RP left and banked points'] } }))

// The RP to get to a tech, prerequisites included, as a result of `research.pathRp`.
export const pathRpResult = (entry) => (entry.gaps.pathRp.length ? unavailable({ rule: 'research.pathRp', missing: entry.gaps.pathRp }) : ofRule({ rule: 'research.pathRp', value: entry.pathRp, inputs: { present: ['RP left on the tech and on each prerequisite'] } }))

// Years to pay `remaining` RP at a rate result: unavailable when the RP left or the rate is not known, or the rate is not above 0.
const yearsToPay = (remaining, remainingName, rateResult) => {
  const rate = isAvailable(rateResult) && !(rateResult.value > 0) ? unavailable({ rule: RATE_RULE, missing: ['a rate above 0 (no labs are assigned)'], present: rateResult.inputs.present }) : rateResult
  const left = isKnownNumber(remaining) ? ofRule({ rule: 'research.remaining', value: remaining, inputs: { present: [remainingName] } }) : unavailable({ rule: 'research.remaining', missing: [remainingName] })

  return combine({ rule: LANDING_RULE, parts: { rate, left }, compute: (values) => values.left / values.rate })
}

const unknownPause = (project) => project.Pause === null || project.Pause === undefined

// The years until a project lands as a result of `research.landing`: a paused project, or one whose pause flag is not stored, has none.
const projectYears = (project, rateResult) => {
  if (unknownPause(project)) {
    return unavailable({ rule: LANDING_RULE, missing: [`the pause flag of ${projectName(project)}`] })
  } else if (toBoolean(project.Pause)) {
    return unavailable({ rule: LANDING_RULE, missing: [`a running project (${projectName(project)} is paused)`] })
  }

  return yearsToPay(project.ResearchPointsRequired, `RP left on ${projectName(project)}`, rateResult)
}

// Each running project and what is queued behind it, as years from now. A queued tech starts when the one before it lands and is paid at the project's labs and scientist, at the queued tech's own field. A paused project, or one making no RP, never lands (`years` is null), and nothing behind it does. `projects` and `queue` are the rows as the page reads them; `paused` maps a tech id to RP already banked. Each project and queued entry carries its `rate` and `years` as numbers (null when unknown) and as results, `rateResult` and `yearsResult`.
export const scheduleProjects = (projects, queue, paused, bonuses = {}) => projects.map((project) => {
  const rateResult = annualResearchPointsResult(project, project.FieldID, bonuses)
  const rate = valueOrNull(rateResult)
  const running = !unknownPause(project) && !toBoolean(project.Pause) && rate > 0
  const yearsResult = projectYears(project, rateResult)
  let before = yearsResult
  const entries = queue.filter((entry) => entry.CurrentProjectID === project.ProjectID).sort((a, b) => a.ResearchOrder - b.ResearchOrder).map((entry) => {
    const queuedRate = annualResearchPointsResult(project, entry.FieldID, bonuses)
    const banked = paused.has(entry.TechID) ? paused.get(entry.TechID) : 0
    const remaining = isKnownNumber(entry.DevelopCost) && isKnownNumber(banked) ? Math.max(0, entry.DevelopCost - banked) : null
    const own = yearsToPay(remaining, `development cost and banked points of ${entry.Name || 'a queued tech'}`, queuedRate)
    const start = valueOrNull(before)

    before = combine({ rule: LANDING_RULE, parts: { before, own }, compute: (values) => values.before + values.own })

    return { ...entry, remaining, rate: valueOrNull(queuedRate), rateResult: queuedRate, start, years: valueOrNull(before), yearsResult: before }
  })

  return { ...project, rate, rateResult, running, years: running ? valueOrNull(yearsResult) : null, yearsResult, queue: entries }
})

// Whether a scheduled project makes no progress for a reason the save states (paused, no scientist, no labs), as against one whose pause flag, rate or RP left the save does not give.
export const projectIdle = (project) => (!unknownPause(project) && toBoolean(project.Pause)) || !project.CommanderID || (isAvailable(project.rateResult) && !(project.rateResult.value > 0))

// The counts of the researched, reachable and available techs from `countStatuses`, and the share researched, as results. With nothing to research there is no share.
export const researchedResults = (counts) => {
  const reachable = counts[DONE] + counts[ACTIVE] + counts[QUEUED] + counts[AVAILABLE] + counts[LOCKED]
  const inputs = { present: ['the race\'s researched techs', 'the tech catalogue'] }

  return {
    done: ofRule({ rule: 'research.researched', value: counts[DONE], inputs }),
    reachable: ofRule({ rule: 'research.researched', value: reachable, inputs }),
    share: reachable > 0 ? ofRule({ rule: 'research.researchedShare', value: counts[DONE] / reachable, inputs }) : unavailable({ rule: 'research.researchedShare', missing: ['a technology the race can research'] }),
    blocked: counts[BLOCKED],
  }
}

// The count of techs available now, as a result.
export const availableResult = (counts) => ofRule({ rule: 'research.available', value: counts[AVAILABLE], inputs: { present: ['the race\'s researched techs', 'the tech catalogue'] } })

// The count of free scientists, as a result: a group with no rows is a known 0.
export const freeScientistsResult = (scientists) => ofRule({ rule: 'research.freeScientists', value: scientists.length, inputs: { present: ['the race\'s scientists'] } })

// The race's unspent starting tech points: unavailable when the race row or the column is not stored.
export const startPointsResult = (race) => (race && isKnownNumber(race.StartTechPoints) ? ofRule({ rule: 'research.startPoints', value: Number(race.StartTechPoints), inputs: { present: ['FCT_Race.StartTechPoints'] } }) : unavailable({ rule: 'research.startPoints', missing: [race ? 'the race\'s starting tech points' : 'the race row'] }))

// The RP a year all the running projects make, as `{ result, unknown, projects }`. A paused project makes none and a running one adds its rate; one with no rate (no scientist, or an unstored input) or an unstored pause flag is not counted and is named as missing, so the sum is short by it. With none counted and some unknown the result is unavailable; no projects, or every one paused, is a known 0.
export const outputResult = (schedule) => {
  const unknown = schedule.filter((project) => unknownPause(project) || (!toBoolean(project.Pause) && !isAvailable(project.rateResult)))
  const counted = schedule.filter((project) => !unknownPause(project) && !toBoolean(project.Pause) && isAvailable(project.rateResult))
  const missing = unknown.map((project) => `the rate of ${projectName(project)}`)

  if (unknown.length && !counted.length) {
    return { result: unavailable({ rule: 'research.output', missing }), unknown: unknown.length, projects: schedule.length }
  }

  return { result: ofRule({ rule: 'research.output', value: counted.reduce((total, project) => total + project.rate, 0), inputs: { present: counted.length ? counted.map((project) => `the rate of ${projectName(project)}`) : ['the research projects'], missing } }), unknown: unknown.length, projects: schedule.length }
}

// The labs built, the labs the projects assigned and those idle, as results of `research.labs`, with `over`, the labs assigned beyond those built. `labRows` have one `Labs` count per colony; a count that is not stored, or a project without its labs, makes that figure unavailable.
export const labsResults = (labRows, schedule) => {
  const gaps = labRows.filter((row) => !isKnownNumber(row.Labs)).length
  const unassigned = schedule.filter((project) => !isKnownNumber(project.Facilities)).length
  const built = gaps ? unavailable({ rule: 'research.labs', missing: [`the research facilities of ${gaps} ${gaps === 1 ? 'colony' : 'colonies'}`] }) : ofRule({ rule: 'research.labs', value: labRows.reduce((total, row) => total + Number(row.Labs), 0), inputs: { present: ['the research facilities of the race\'s colonies'] } })
  const assigned = unassigned ? unavailable({ rule: 'research.labs', missing: [`the labs of ${unassigned} ${unassigned === 1 ? 'project' : 'projects'}`] }) : ofRule({ rule: 'research.labs', value: schedule.reduce((total, project) => total + Number(project.Facilities), 0), inputs: { present: ['the labs assigned to the race\'s projects'] } })
  const idle = combine({ rule: 'research.labs', parts: { built, assigned }, compute: (values) => Math.max(0, values.built - values.assigned) })

  return { built, assigned, idle, over: isAvailable(built) && isAvailable(assigned) ? Math.max(0, assigned.value - built.value) : 0 }
}

// The running project that lands first, with its years as a result of `research.nextLanding`: `{ project, result, unknown, causes }`, `unknown` the projects that may be progressing (running, or with a pause flag or rate that is not stored) and have no landing time, which could land before the project named, and `causes` what their landing times miss. Unavailable when no running project has a landing time, and when the game clock is not stored (the landing is dated from it).
export const nextLandingResult = (schedule, game) => {
  const dated = schedule.filter((project) => project.running && isAvailable(project.yearsResult))
  const best = dated.reduce((soonest, project) => (!soonest || project.years < soonest.years ? project : soonest), null)
  const clock = [...(game && isKnownNumber(game.StartYear) ? [] : ['the game start year']), ...(game && isKnownNumber(game.GameTime) ? [] : ['the game time'])]
  const undatedProjects = schedule.filter((project) => (project.running || !projectIdle(project)) && !isAvailable(project.yearsResult))
  const undated = undatedProjects.map((project) => `the landing time of ${projectName(project)}`)
  const causes = [...new Set(undatedProjects.flatMap((project) => (project.yearsResult ? project.yearsResult.inputs.missing : [])))]

  if (!best || clock.length) {
    return { project: best, result: unavailable({ rule: 'research.nextLanding', missing: [...(best ? [] : ['a running project with a rate and RP left']), ...clock] }), unknown: undated.length, causes }
  }

  return { project: best, result: combine({ rule: 'research.nextLanding', parts: { landing: best.yearsResult }, compute: (values) => values.landing, inputs: { present: ['the game clock'], missing: undated } }), unknown: undated.length, causes }
}

// "9 d", "7.5 mo", "3.4 y": a span of years as a player reads it, the figure of a long one grouped with `separator`.
export const durationLabel = (years, separator = '\'') => {
  if (!isKnownNumber(years)) {
    return UNKNOWN_TEXT
  }

  const days = years * 365

  if (days < 1) {
    return `${Math.max(1, Math.round(days * 24))} h`
  } else if (days < 100) {
    return `${Math.round(days)} d`
  } else if (years < 2) {
    return `${countText(years * 12, 1, separator)} mo`
  }

  return `${countText(years, 1, separator)} y`
}
