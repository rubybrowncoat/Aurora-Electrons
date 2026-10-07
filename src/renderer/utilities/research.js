// The research domain: the tech catalogue as a graph, and what each tech is to one race.
//
// The game lists a project as researchable when its field matches, it is not ruin-only, it belongs to
// nobody or to the race (or the race made it eligible), its prerequisites are researched, and it is not
// researched, running or queued. A prerequisite id
// that has no tech row can never be researched, so a tech that needs one is out of reach for good.
// `evaluateResearch` computes that once for every tech, with the path to it, so the page only reads.

import { toBoolean } from './aurora'
import { roundToDecimal } from './math'

export const DONE = 'done'
export const ACTIVE = 'active'
export const QUEUED = 'queued'
export const AVAILABLE = 'available'
export const LOCKED = 'locked'
export const BLOCKED = 'blocked'

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

// The catalogue as `rows` from FCT_TechSystem (GameID 0, plus the race's eligible alien projects) with
// DIM_TechType's Description (TypeName) and FieldID: tech by id, with its prerequisites and dependents.
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

// Everything the race's rows say about its research, as the sets and maps `evaluateResearch` takes:
// `researched` and `eligible` are sets of tech ids, `projects` maps a running tech to its RP left,
// `queued` is a set of queued tech ids, `paused` maps a tech to the RP already banked.
export const researchState = ({ raceId, researched, eligible = [], projects = [], queued = [], paused = [] }) => ({
  raceId,
  researched: new Set(researched),
  eligible: new Set(eligible),
  projects: new Map(projects.map((project) => [project.TechID, project.ResearchPointsRequired])),
  queued: new Set(queued),
  paused: new Map(paused.map((row) => [row.TechSystemID, row.PointsAccumulated])),
})

// Per tech: { status, reason, remaining, missing, pathRp, unlocks }.
//   remaining  RP still to pay for this tech (a running project's RP left, else its cost less banked points)
//   missing    ids of the unresearched techs it needs, deepest prerequisite first, itself not included
//   pathRp     remaining of the tech plus all of `missing`: the game's "Path RP", less progress already made
//   unlocks    direct dependents that are not researched yet
export const evaluateResearch = (graph, state) => {
  const { techs } = graph
  const { raceId, researched, eligible, projects, queued, paused } = state
  const info = new Map()
  const visiting = new Set()

  const remainingOf = (tech) => {
    if (projects.has(tech.id)) {
      return projects.get(tech.id)
    }

    return Math.max(0, tech.cost - (paused.get(tech.id) || 0))
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
      return { status: BLOCKED, remaining: 0, missing: [] }
    }

    visiting.add(tech.id)

    const entry = { status: null, reason: null, remaining: remainingOf(tech), missing: [], pathRp: 0, unlocks: 0 }
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
    entry.pathRp = entry.remaining + entry.missing.reduce((sum, id) => sum + (info.has(id) ? info.get(id).remaining : 0), 0)

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

// The catalogue as lines: a tech type's techs from the cheapest up, with the race's progress on each.
// `visible` filters the techs that belong on the page (the displayed fields).
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

// A target's prerequisite chain as layers for drawing: the target, its unresearched prerequisites, and the
// researched techs it leans on directly, each in a column by its longest path from the left. Returns
// { nodes: [{ id, layer, row }], edges: [{ from, to }], layers }.
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

  layers.forEach((column) => column.sort((a, b) => graph.techs.get(a).cost - graph.techs.get(b).cost).forEach((id, index) => position.set(id, index)))

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

// A scientist on a project of the scientist's own field counts the Research bonus four times over
// (1.15 becomes 1.60); the field's ancient-construct bonus applies when the colony sits on the construct.
export const researchMultiplier = (bonus, specialised) => (specialised ? 4 * bonus - 3 : bonus)

// The race-wide bonus per field from its active ancient constructs: each adds a tenth of its bonus above 1.
// `constructs` has one row per populated colony on a construct, as the game counts them.
export const fieldBonuses = (constructs) => constructs.reduce((bonuses, row) => ({ ...bonuses, [row.FieldID]: (bonuses[row.FieldID] || 1) + (row.ResearchBonus - 1) / 10 }), {})

// RP a year the project's labs make on a tech of `fieldId`, as the game's research list shows it.
// A project with no scientist makes none.
export const annualResearchPoints = (project, fieldId, bonuses = {}) => {
  if (!project.CommanderID) {
    return 0
  }

  const local = project.LocalConstructField === fieldId ? project.LocalConstructBonus : 1

  return project.OutputPerLab * project.Facilities * researchMultiplier(project.ResearchBonus, project.ScientistField === fieldId) * local * (bonuses[fieldId] || 1)
}

// Each running project and what is queued behind it, as years from now. A queued tech starts when the one
// before it lands and is paid at the project's labs and scientist, at the queued tech's own field. A paused
// project, or one making no RP, never lands (`years` is null), and nothing behind it does.
// `projects` and `queue` are the rows as the page reads them; `paused` maps a tech id to RP already banked.
export const scheduleProjects = (projects, queue, paused, bonuses = {}) => projects.map((project) => {
  const rate = annualResearchPoints(project, project.FieldID, bonuses)
  const running = !toBoolean(project.Pause) && rate > 0
  let years = running ? project.ResearchPointsRequired / rate : null
  const entries = queue
    .filter((entry) => entry.CurrentProjectID === project.ProjectID)
    .sort((a, b) => a.ResearchOrder - b.ResearchOrder)
    .map((entry) => {
      const queuedRate = annualResearchPoints(project, entry.FieldID, bonuses)
      const remaining = Math.max(0, entry.DevelopCost - (paused.get(entry.TechID) || 0))
      const start = years
      years = years !== null && queuedRate > 0 ? years + remaining / queuedRate : null

      return { ...entry, remaining, rate: queuedRate, start, years }
    })

  return { ...project, rate, running, years: running ? project.ResearchPointsRequired / rate : null, queue: entries }
})

// "9 d", "7.5 mo", "3.4 y": a span of years as a player reads it.
export const durationLabel = (years) => {
  const days = years * 365

  if (days < 1) {
    return `${Math.max(1, Math.round(days * 24))} h`
  } else if (days < 100) {
    return `${Math.round(days)} d`
  } else if (years < 2) {
    return `${roundToDecimal(years * 12, 1)} mo`
  }

  return `${roundToDecimal(years, 1)} y`
}
