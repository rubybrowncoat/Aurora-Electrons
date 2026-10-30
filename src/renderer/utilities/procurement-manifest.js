// The net component procurement manifest of a shipbuilding goal: for one or more hull plans (a class and a hull count each) and the colony the hulls are to be built at, what each component the classes mount is needed in total, what the colonies' stock and the queued component projects supply, and what is still short, kept apart as available stock, held-back stock, queued manufacture and net shortage. Pure functions on plain rows in and out. The components are identified by the component's own ID (the ID the class mounts, the stock and the project name), never by name. A unit of stock or of a queued project is given to one plan only: the plans are served in the order they are listed, each from the stock at the build colony first, then the stock elsewhere (the colonies in the build colony's system first), then the projects queued at the build colony and then those elsewhere, so two plans that mount the same component divide what exists between them and never each count all of it.

import { csvCell } from './csv-cell'
import { buildableOf } from './component-calc'
import { registerRule } from './provenance'

registerRule({
  id: 'production.procurementManifest',
  versions: ['2.7.x'],
  units: 'component units',
  verification: 'estimated',
  structure: ['FCT_ClassComponent.NumComponent', 'FCT_PopComponent.Amount', 'FCT_IndustrialProjects.ProductionID, ProductionType 3, Amount, PartialCompletion, Pause, Queue', 'FCT_ShipyardTask.TaskTypeID, UseComponents, ClassID, RefitID', 'FCT_ShipDesignComponents.Size, Cost', 'FCT_Population.SystemID'],
  note: 'What a batch of hulls needs of each component, less what is free to use: the stock at the build colony, the stock at other colonies (which has to be moved) and the units that component projects already queued will deliver, each unit given to one plan only. A shortage is what is left. Stock whose amount is not known, stock held back by a claim that is not known and a queue that was not read are never counted as supply, so the shortage is then an upper bound and says so. Units already queued by the game are the stored remaining amount plus the part-built unit, rounded to whole units; a paused project is listed apart and does not count as supply. The tons to move come from the design data\'s size of the component.',
  assumptions: ['The components are needed at the build colony', 'A queued project finishes its units and nothing else uses them', 'A unit at another colony is moved to the build colony; cargo already on the way is not counted'],
})

registerRule({
  id: 'production.procurementReservations',
  versions: ['2.7.x'],
  units: 'component units',
  verification: 'estimated',
  structure: ['FCT_ShipyardTask.TaskTypeID, UseComponents, ClassID, RefitID, PopulationID', 'FCT_ClassComponent.NumComponent'],
  note: 'Which stock is claimed by work already queued. A shipyard task takes the stored components it uses when it is made (the stock is debited then and a deleted task does not give them back), so a construction or refit task in the save holds nothing of the stock it was made from: the stock is net of it. The claims that remain are the ones a task has not yet taken: an automatic refit makes its next task from the ship\'s class when the last one ends and takes the stock again for it, and how many of those follow is not stored. A colony with such a task holds back its stock of the components the refit adds, and one whose task cannot be read, or whose type or class is not known, holds back all its stock of the components of the plans, until the claim is known. A repair or a scrap takes no component stock. Read from the game\'s rules; no saved game shows a task taking stock after it was made.',
  assumptions: ['A task takes the stock only when it is made', 'An automatic refit whose Use Components flag is off takes none'],
})

const EPSILON = 1e-9

export const TASK_TYPE = Object.freeze({ CONSTRUCTION: 0, REPAIR: 1, REFIT: 2, SCRAP: 3, AUTO_REFIT: 4 })

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const whole = (value) => isNumber(value) && Number.isInteger(value) && value >= 1

// A figure rounded for a record that is read by a person or a spreadsheet: four decimals, no float dust.
const rounded = (value) => (isNumber(value) ? Number(value.toFixed(4)) : null)

const colonyOf = (colonies, id) => (colonies && colonies[id]) || { id: Number(id), name: `Colony #${id}`, systemId: null, systemName: null }

// The units a component project will deliver: the remaining amount the game stores plus the part-built unit, which is a whole number of units (a project of 47 units with 0.0498 of one done stores 46.9502). Null when either figure is not known.
export const projectUnits = (project) => (isNumber(project.amount) && isNumber(project.partial) ? Math.max(0, Math.floor(project.amount + project.partial + 1e-6)) : null)

// The queued component projects (shipyard-less manufacture by a colony) of each component: { [componentId]: { active: { [populationId]: units }, paused: { [populationId]: units }, uncertain: [{ populationId, state, units }], unknown: [reason] } }. A project counts toward `active` when it is not paused (running or waiting in the queue); one whose pause flag or units are not known is counted in neither, is listed in `unknown` with the reason, and is kept in `uncertain` with its colony, its state ('queued', 'paused' or 'not known' for a pause flag that is not stored) and its units (null when not known), so that its location is not lost.
export const queuedOf = (projects) => {
  const byComponent = {}

  projects.forEach((project) => {
    const entry = (byComponent[project.componentId] = byComponent[project.componentId] || { active: {}, paused: {}, uncertain: [], unknown: [] })
    const units = projectUnits(project)
    const name = project.name || `project ${project.id}`

    const pauseKnown = project.paused !== null && project.paused !== undefined
    const paused = project.paused === 1 || project.paused === true

    if (units === null || !pauseKnown) {
      entry.unknown.push(units === null ? `the units left of ${name}` : `whether ${name} is paused`)
      entry.uncertain.push({ populationId: project.populationId, state: pauseKnown ? (paused ? 'paused' : 'queued') : 'not known', units })
    } else {
      const side = paused ? entry.paused : entry.active

      side[project.populationId] = (side[project.populationId] || 0) + units
    }
  })

  return byComponent
}

// The claims on a colony's component stock that queued work still holds, as { claims, tasks }. `tasks`: the race's shipyard tasks [{ id, populationId, typeId, classId, refitId, useComponents, totalBP, classCost }]; `parts`: the components of each class, { [classId]: [{ componentId, count }] }; `read`: whether the tasks were read at all; `entered`: stock the player holds back by hand, [{ populationId, componentId, units }]. A claim is { populationId (null: every colony), componentId (null: every component), units (a number when proven, null when it is not known), proof ('proven' or 'unknown'), source ('task', 'entered' or 'unread'), reason }. `tasks` of the result is one row per task with what it holds: 'taken' (made with the stock it uses; nothing is held), 'none' (takes no stock), 'successors' (an automatic refit that may take stock again) or 'unknown'.
export const reservationsOf = ({ tasks = [], parts = {}, read = true, entered = [] }) => {
  const claims = []
  const rows = []

  if (!read) {
    claims.push({ populationId: null, componentId: null, units: null, proof: 'unknown', source: 'unread', reason: 'the shipyard tasks were not read' })
  }

  const additions = (task) => {
    const target = parts[task.refitId]
    const source = parts[task.classId]

    if (!target || !source) {
      return null
    }

    const had = Object.fromEntries(source.map((part) => [part.componentId, part.count]))

    return target.filter((part) => !isNumber(part.count) || !isNumber(had[part.componentId]) || part.count > had[part.componentId]).map((part) => part.componentId)
  }

  tasks.forEach((task) => {
    const base = { taskId: task.id, populationId: task.populationId, typeId: task.typeId, classId: task.classId, refitId: task.refitId === undefined ? null : task.refitId, useComponents: task.useComponents === undefined ? null : task.useComponents, credited: isNumber(task.classCost) && isNumber(task.totalBP) && task.typeId === TASK_TYPE.CONSTRUCTION ? Math.max(0, task.classCost - task.totalBP) : null }

    if (task.typeId === TASK_TYPE.CONSTRUCTION || task.typeId === TASK_TYPE.REFIT) {
      rows.push({ ...base, state: 'taken', reason: 'The stock this task uses was taken when it was made.' })
    } else if (task.typeId === TASK_TYPE.REPAIR || task.typeId === TASK_TYPE.SCRAP) {
      rows.push({ ...base, state: 'none', reason: 'A repair or a scrap takes no component stock.' })
    } else if (task.typeId === TASK_TYPE.AUTO_REFIT) {
      if (task.useComponents === 0) {
        rows.push({ ...base, state: 'none', reason: 'An automatic refit with Use Components off takes no stock.' })
      } else {
        const ids = additions(task)
        const reason = `An automatic refit makes a new task for each ship still to refit and takes the stock again, and how many follow is not stored${task.useComponents === 1 ? '' : '; its Use Components flag is not known either'}.`

        if (ids === null) {
          claims.push({ populationId: task.populationId, componentId: null, units: null, proof: 'unknown', source: 'task', taskId: task.id, reason: `${reason} The classes it refits between are not known, so every component stays held back.` })
        } else {
          ids.forEach((componentId) => claims.push({ populationId: task.populationId, componentId, units: null, proof: 'unknown', source: 'task', taskId: task.id, reason }))
        }

        rows.push({ ...base, state: 'successors', reason })
      }
    } else {
      const reason = 'The task type is not known, so what stock it holds is not known.'

      claims.push({ populationId: task.populationId === undefined ? null : task.populationId, componentId: null, units: null, proof: 'unknown', source: 'task', taskId: task.id, reason })
      rows.push({ ...base, state: 'unknown', reason })
    }
  })

  entered.forEach((entry) => {
    const proven = isNumber(entry.units) && entry.units >= 0

    claims.push({ populationId: entry.populationId, componentId: entry.componentId, units: proven ? entry.units : null, proof: proven ? 'proven' : 'unknown', source: 'entered', reason: proven ? 'Held back by hand.' : 'The amount held back by hand is not a number of 0 or more, so all the stock of the component there is held back.' })
  })

  return { claims, tasks: rows }
}

// What the claims on one colony's stock of one component come to: { proven (units), unknown (reasons) }.
const claimedAt = (claims, populationId, componentId) => {
  const matching = claims.filter((claim) => (claim.populationId === null || claim.populationId === populationId) && (claim.componentId === null || claim.componentId === componentId))

  return { proven: matching.filter((claim) => claim.proof === 'proven').reduce((sum, claim) => sum + claim.units, 0), unknown: [...new Set(matching.filter((claim) => claim.proof !== 'proven').map((claim) => claim.reason))] }
}

// The hull plans reduced to what is needed of each component (route: 'project', 'hull', 'stock' for an alien component that has to be in stock, or 'unknown'): [{ componentId, name, typeId, route, why, cost, perPlan: [{ planId, needed }], needed, unknown }] in the order components first appear. `plans`: [{ id, classId, hulls }], `parts`: { [classId]: [part] } as `sourcesOf` shapes them.
const needsOf = (plans, parts) => {
  const byComponent = new Map()

  plans.forEach((plan) => {
    ;(parts[plan.classId] || []).forEach((part) => {
      if (!byComponent.has(part.componentId)) {
        const buildability = buildableOf(part)
        // The route follows from the race's research first: a component the race has not researched (an alien one) is made by neither a project nor the shipyard and has to be in stock before the hull is built, whatever its other flags say; whether the race has researched it being unknown leaves the route unknown. Only then do the other restrictions (armour, a prototype, a civilian line's, obsolete) decide between a project and the hull.
        const route = part.researched === 0 ? 'stock' : !isNumber(part.researched) ? 'unknown' : buildability.buildable === true ? 'project' : buildability.buildable === false ? 'hull' : 'unknown'
        const why = part.researched === 0 ? 'the race has not researched it, so it has to be in stock' : !isNumber(part.researched) ? 'whether the race has researched the component is not known' : buildability.why || (buildability.missing || []).join('; ')

        byComponent.set(part.componentId, { componentId: part.componentId, name: part.name, typeId: part.typeId, route, why, cost: isNumber(part.cost) ? part.cost : null, perPlan: [], unknown: [] })
      }

      const row = byComponent.get(part.componentId)
      const needed = isNumber(part.count) ? part.count * plan.hulls : null

      if (needed === null) {
        row.unknown.push(`how many ${part.name} a hull of ${plan.className} mounts`)
      }

      row.perPlan.push({ planId: plan.id, needed })
    })
  })

  return [...byComponent.values()].map((row) => ({ ...row, needed: row.perPlan.some((entry) => entry.needed === null) ? null : row.perPlan.reduce((sum, entry) => sum + entry.needed, 0) }))
}

// A colony's stock of a component: 0 where there is no row (the game keeps a row only for what a colony holds), null where a row is there with no amount.
const heldAt = (stock, populationId, componentId) => {
  const colony = stock && stock[populationId]

  if (!colony || !Object.prototype.hasOwnProperty.call(colony, componentId)) {
    return 0
  }

  return isNumber(colony[componentId]) ? Math.max(0, colony[componentId]) : null
}

// The tons one unit of a component weighs in cargo, from the design data's size, or null where it is not known.
const tonsOf = (components, componentId) => {
  const component = components && components[componentId]

  return component && isNumber(component.tons) ? component.tons : null
}

// Sorted so that the colonies in the build colony's system come first, then the larger holdings, then by ID: a fixed order, so the same input gives the same answer.
const nearestFirst = (a, b) => Number(b.sameSystem === true) - Number(a.sameSystem === true) || b.units - a.units || a.populationId - b.populationId

// The manifest of the plans. Input:
//   plans: [{ id, classId, className, hulls }] in the order they are served; hulls a whole number of 1 or more.
//   parts: { [classId]: [part] } (`sourcesOf`).
//   stock: { [populationId]: { [componentId]: units or null } } (`sourcesOf`).
//   colonies: { [populationId]: { id, name, systemId, systemName } }.
//   targetId: the colony the hulls are built at.
//   projects: [{ id, populationId, componentId, amount, partial, paused, name }] (the component projects of the race); `projectsRead` whether they were read.
//   tasks: [...] and `tasksRead` as for `reservationsOf`; `entered`: stock held back by hand.
//   components: { [componentId]: { tons } } from the design data (`procurement-data.js`).
// Returns { invalid } for an input that cannot be reconciled, otherwise { plans, target, rows, moves, claims, tasks, totals, unknown }.
export const reconcile = ({ plans, parts, stock, colonies, targetId, projects = [], projectsRead = true, tasks = [], tasksRead = true, entered = [], components = {} }) => {
  if (!plans.length) {
    return { invalid: 'a hull plan' }
  }

  const badPlan = plans.find((plan) => !whole(plan.hulls))

  if (badPlan) {
    return { invalid: `the number of hulls of ${badPlan.className || 'the plan'} (a whole number of 1 or more)`, planId: badPlan.id }
  }

  if (targetId === null || targetId === undefined) {
    return { invalid: 'the colony the components are needed at' }
  }

  const target = colonyOf(colonies, targetId)
  const needs = needsOf(plans, parts)
  const queued = queuedOf(projects)
  const reservations = reservationsOf({ tasks, parts, read: tasksRead, entered })
  const problems = plans.filter((plan) => !(parts[plan.classId] || []).length).map((plan) => `${plan.className || 'A class'} mounts no component`)

  const holders = (componentId) => Object.keys(stock || {}).map(Number).filter((populationId) => Object.prototype.hasOwnProperty.call(stock[populationId], componentId))
  const sameSystem = (populationId) => (target.systemId === null || target.systemId === undefined ? null : colonyOf(colonies, populationId).systemId === target.systemId)
  const placeOf = (populationId) => { const colony = colonyOf(colonies, populationId); return { populationId, name: colony.name, systemId: colony.systemId === undefined ? null : colony.systemId, systemName: colony.systemName === undefined ? null : colony.systemName } }

  const rows = needs.map((need) => {
    const unknown = [...need.unknown]
    const places = [...new Set([Number(targetId), ...holders(need.componentId)])]
    const lots = []
    let stockLocal = 0
    let stockRemote = 0
    let stockLocalUnknown = false
    let stockRemoteUnknown = false
    let provenHeld = 0
    let unknownHeld = 0
    let availableLocal = 0
    let availableRemote = 0

    places.forEach((populationId) => {
      const held = heldAt(stock, populationId, need.componentId)
      const claim = claimedAt(reservations.claims, populationId, need.componentId)
      const here = populationId === Number(targetId)

      if (held === null) {
        unknown.push(`the stock of ${need.name} at ${colonyOf(colonies, populationId).name}`)

        if (here) {
          stockLocalUnknown = true
        } else {
          stockRemoteUnknown = true
        }

        return
      }

      const proven = Math.min(held, claim.proven)
      const back = claim.unknown.length ? held : proven
      const free = held - back

      // The proven part of the claims stays proven (capped by the stock); with a claim that is not known the rest of the stock there is held back as uncertain.
      provenHeld += proven

      if (claim.unknown.length) {
        unknownHeld += held - proven

        if (held > EPSILON) {
          unknown.push(`the claims on the stock of ${need.name} at ${colonyOf(colonies, populationId).name}`)
        }
      }

      if (here) {
        stockLocal += held
        availableLocal += free
      } else {
        stockRemote += held
        availableRemote += free
      }

      if (free > EPSILON) {
        lots.push({ kind: 'stock', here, units: free, populationId, sameSystem: here ? true : sameSystem(populationId) })
      }
    })

    const project = queued[need.componentId] || { active: {}, paused: {}, uncertain: [], unknown: [] }

    if (!projectsRead) {
      unknown.push(`the component projects queued for ${need.name} (they were not read)`)
    }

    project.unknown.forEach((text) => unknown.push(text))

    const queuedPlaces = Object.entries(project.active).map(([populationId, units]) => ({ populationId: Number(populationId), units, here: Number(populationId) === Number(targetId) })).map((entry) => ({ ...entry, sameSystem: entry.here ? true : sameSystem(entry.populationId) }))
    const pausedUnits = Object.values(project.paused).reduce((sum, units) => sum + units, 0)
    const queuedLocal = queuedPlaces.filter((entry) => entry.here).reduce((sum, entry) => sum + entry.units, 0)
    const queuedRemote = queuedPlaces.filter((entry) => !entry.here).reduce((sum, entry) => sum + entry.units, 0)
    const isHere = (entry) => Number(entry.populationId) === Number(targetId)
    // A project whose units (or pause flag) are not known makes the total it would belong to not known; the known projects stay as a subtotal beside it.
    const queuedLocalUnknown = project.uncertain.some((entry) => entry.state !== 'paused' && isHere(entry))
    const queuedRemoteUnknown = project.uncertain.some((entry) => entry.state !== 'paused' && !isHere(entry))
    const pausedUnknown = project.uncertain.some((entry) => entry.state !== 'queued')

    // The supply in the order it is used: stock here, stock elsewhere, queue here, queue elsewhere.
    const supply = [
      ...lots.filter((lot) => lot.here).map((lot) => ({ ...lot })),
      ...lots.filter((lot) => !lot.here).sort(nearestFirst).map((lot) => ({ ...lot })),
      ...queuedPlaces.filter((entry) => entry.here).map((entry) => ({ kind: 'queued', ...entry })),
      ...queuedPlaces.filter((entry) => !entry.here).sort(nearestFirst).map((entry) => ({ kind: 'queued', ...entry })),
    ]

    const used = need.needed === null ? { stockLocal: null, stockRemote: null, queuedLocal: null, queuedRemote: null } : { stockLocal: 0, stockRemote: 0, queuedLocal: 0, queuedRemote: 0 }
    const moves = []
    const perPlan = []
    let net = null

    if (need.needed !== null) {
      supply.forEach((lot) => { lot.left = lot.units })

      need.perPlan.forEach((entry) => {
        let left = entry.needed
        const taken = { stockLocal: 0, stockRemote: 0, queuedLocal: 0, queuedRemote: 0 }

        supply.forEach((lot) => {
          const take = Math.min(left, lot.left)

          if (take <= EPSILON) {
            return
          }

          const key = `${lot.kind === 'stock' ? 'stock' : 'queued'}${lot.here ? 'Local' : 'Remote'}`

          lot.left -= take
          left -= take
          taken[key] += take
          used[key] += take

          if (!lot.here) {
            const existing = moves.find((move) => move.populationId === lot.populationId && move.stage === lot.kind)

            if (existing) {
              existing.units += take
            } else {
              moves.push({ ...placeOf(lot.populationId), colonyName: placeOf(lot.populationId).name, componentId: need.componentId, componentName: need.name, stage: lot.kind, units: take, sameSystem: lot.sameSystem })
            }
          }
        })

        perPlan.push({ planId: entry.planId, needed: entry.needed, ...taken, short: left > EPSILON ? left : 0 })
      })

      net = perPlan.reduce((sum, entry) => sum + entry.short, 0)
    } else {
      need.perPlan.forEach((entry) => perPlan.push({ planId: entry.planId, needed: entry.needed, stockLocal: null, stockRemote: null, queuedLocal: null, queuedRemote: null, short: null }))
    }

    const tonsPerUnit = tonsOf(components, need.componentId)

    // Where the component is being made, whether or not any of it is used: each colony with an active project (with how much of it the plans use), with a paused one (which is not supply) and with one whose units or pause flag are not known (which is not supply either). A colony with a project of units not known keeps its entry: `units` is the known part (null when none is known) and `incomplete` says that more is made there than `units`.
    const made = new Map()
    const keep = (populationId, state, units) => {
      const key = `${populationId}-${state}`
      const entry = made.get(key) || { populationId: Number(populationId), state, known: 0, hasKnown: false, incomplete: false }

      if (units === null) {
        entry.incomplete = true
      } else {
        entry.known += units
        entry.hasKnown = true
      }

      made.set(key, entry)
    }

    queuedPlaces.forEach((entry) => keep(entry.populationId, 'queued', entry.units))
    Object.entries(project.paused).forEach(([populationId, units]) => keep(populationId, 'paused', units))
    project.uncertain.forEach((entry) => keep(entry.populationId, entry.state, entry.units))

    const manufacture = [...made.values()].map((entry) => {
      const here = entry.populationId === Number(targetId)
      const lot = entry.state === 'queued' ? supply.find((candidate) => candidate.kind === 'queued' && candidate.populationId === entry.populationId) : null
      const usedHere = lot && need.needed !== null ? lot.units - lot.left : null

      return { ...placeOf(entry.populationId), here, sameSystem: here ? true : sameSystem(entry.populationId), state: entry.state, units: entry.hasKnown ? entry.known : null, incomplete: entry.incomplete, used: usedHere, unused: usedHere === null || entry.incomplete ? null : lot.units - usedHere }
    })
    const spare = need.needed === null || stockLocalUnknown || stockRemoteUnknown ? null : Math.max(0, availableLocal + availableRemote - used.stockLocal - used.stockRemote)

    return {
      componentId: need.componentId,
      name: need.name,
      typeId: need.typeId,
      route: need.route,
      why: need.why,
      cost: need.cost,
      needed: need.needed,
      perPlan,
      stock: { local: stockLocalUnknown ? null : stockLocal, remote: stockRemoteUnknown ? null : stockRemote, known: { local: stockLocal, remote: stockRemote } },
      reserved: { proven: provenHeld, unknown: unknownHeld },
      available: { local: stockLocalUnknown ? null : availableLocal, remote: stockRemoteUnknown ? null : availableRemote, known: { local: availableLocal, remote: availableRemote } },
      used,
      spare,
      queued: { local: queuedLocalUnknown ? null : queuedLocal, remote: queuedRemoteUnknown ? null : queuedRemote, paused: pausedUnknown ? null : pausedUnits, known: { local: queuedLocal, remote: queuedRemote, paused: pausedUnits } },
      manufacture,
      net,
      netBasis: need.needed === null ? 'not known' : unknown.length && net > EPSILON ? 'at most' : 'exact',
      shortBP: net !== null && need.cost !== null && need.route !== 'stock' ? net * need.cost : null,
      moves: moves.map((move) => ({ ...move, tonsPerUnit, tons: tonsPerUnit === null ? null : move.units * tonsPerUnit })),
      tonsPerUnit,
      unknown,
    }
  })

  const moves = rows.flatMap((row) => row.moves)
  const sumOf = (list, value) => list.reduce((sum, row) => sum + value(row), 0)
  const known = rows.filter((row) => row.net !== null)
  const costed = known.filter((row) => row.shortBP !== null)
  // A component whose need is not known leaves every total that adds the need or what it takes not known: the total is null, with the known part beside it.
  const unknownNeed = rows.some((row) => row.needed === null)
  const byRoute = (route) => (rows.some((row) => row.route === route && row.net === null) ? null : sumOf(rows.filter((row) => row.route === route), (row) => row.net))

  return {
    invalid: null,
    problems,
    target: { ...placeOf(Number(targetId)) },
    plans: plans.map((plan) => ({ id: plan.id, classId: plan.classId, className: plan.className, hulls: plan.hulls })),
    rows,
    moves,
    manufacture: rows.flatMap((row) => row.manufacture.map((entry) => ({ ...entry, componentId: row.componentId, componentName: row.name, colonyName: entry.name }))),
    claims: reservations.claims,
    tasks: reservations.tasks,
    totals: {
      needed: unknownNeed ? null : sumOf(rows, (row) => row.needed),
      neededKnown: sumOf(rows.filter((row) => row.needed !== null), (row) => row.needed),
      net: unknownNeed ? null : sumOf(known, (row) => row.net),
      netKnown: sumOf(known, (row) => row.net),
      netProject: byRoute('project'),
      netHull: byRoute('hull'),
      netStock: byRoute('stock'),
      netRouteUnknown: byRoute('unknown'),
      shortBP: sumOf(costed, (row) => row.shortBP),
      shortBPKnown: rows.every((row) => row.route === 'stock' || row.shortBP !== null),
      units: unknownNeed ? null : sumOf(moves, (move) => move.units),
      unitsKnown: sumOf(moves, (move) => move.units),
      tons: unknownNeed || !moves.every((move) => move.tons !== null) ? null : sumOf(moves, (move) => move.tons),
      tonsKnown: sumOf(moves.filter((move) => move.tons !== null), (move) => move.tons),
      unknownRows: rows.filter((row) => row.netBasis !== 'exact').length,
    },
    unknown: [...new Set(rows.flatMap((row) => row.unknown))],
  }
}

// The colony that holds the most of what the plans need, a colony with a shipyard first: where the hulls are most likely built. Null when there is no colony.
export const defaultTarget = ({ plans, parts, stock, colonies }) => {
  const ids = new Set(plans.flatMap((plan) => (parts[plan.classId] || []).map((part) => part.componentId)))
  const held = (populationId) => [...ids].reduce((sum, componentId) => sum + (heldAt(stock, populationId, componentId) || 0), 0)
  const list = Object.values(colonies || {})

  return list.reduce((best, colony) => {
    const yards = Number(isNumber(colony.yards) && colony.yards > 0)

    if (!best) {
      return colony
    }

    const bestYards = Number(isNumber(best.yards) && best.yards > 0)

    return yards > bestYards || (yards === bestYards && held(colony.id) > held(best.id)) ? colony : best
  }, null)
}

const cell = (value) => csvCell(typeof value === 'number' ? rounded(value) : value, { guard: typeof value !== 'number' })

export const CSV_COLUMNS = Object.freeze(['Record', 'Component ID', 'Component', 'Route', 'Colony ID', 'Colony', 'System', 'Plan', 'Hulls', 'Needed', 'Stock here', 'Stock elsewhere', 'Reserved (proven)', 'Held back (claim not known)', 'Available here', 'Available elsewhere', 'Used here', 'Used elsewhere', 'Queued here', 'Queued elsewhere', 'Queued paused', 'Used from queue here', 'Used from queue elsewhere', 'Spare stock', 'Net shortage', 'Net shortage basis', 'Shortage BP', 'Units to move', 'Tons to move', 'Manufacture state', 'Manufactured units', 'Used by plans', 'Not used by plans', 'Note', 'Rule'])

const RULE = 'production.procurementManifest'

const ROUTE_TEXT = Object.freeze({ project: 'component project', hull: 'built with the hull', stock: 'stock required (not researched by the race)' })

const record = (fields) => CSV_COLUMNS.map((column) => cell(fields[column])).join(',')

const BASIS_NOTE = Object.freeze({ exact: '', 'at most': 'upper bound: some supply is not known and is not counted', 'not known': 'not known' })

// The manifest as a CSV: a `context` record for each plan and for what the read could not tell, a `component` record for each component with the figures kept apart, a `plan` record for each plan and component (each unit of supply appears under one plan only), a `manufacture` record for each colony with a queued or paused component project (with how much of its output the plans use, which is independent of what is moved), a `transport` record for each place stock or a queued project has to be moved from, and a `reservation` record for each claim on the stock. A figure that is not known is an empty cell, never 0.
export const manifestCsv = (manifest) => {
  const lines = [CSV_COLUMNS.map(cell).join(',')]
  const planOf = (id) => manifest.plans.find((plan) => plan.id === id)

  manifest.plans.forEach((plan) => lines.push(record({ Record: 'context', Plan: plan.className, Hulls: plan.hulls, Colony: manifest.target.name, 'Colony ID': manifest.target.populationId, System: manifest.target.systemName, Note: `Plan ${plan.className} x ${plan.hulls}, needed at ${manifest.target.name}`, Rule: RULE })))
  manifest.unknown.forEach((text) => lines.push(record({ Record: 'context', Note: `Not known: ${text}`, Rule: RULE })))
  manifest.problems.forEach((text) => lines.push(record({ Record: 'context', Note: text, Rule: RULE })))

  manifest.rows.forEach((row) => {
    lines.push(record({ Record: 'component', 'Component ID': row.componentId, Component: row.name, Route: ROUTE_TEXT[row.route] || 'not known', 'Colony ID': manifest.target.populationId, Colony: manifest.target.name, Needed: row.needed, 'Stock here': row.stock.local, 'Stock elsewhere': row.stock.remote, 'Reserved (proven)': row.reserved.proven, 'Held back (claim not known)': row.reserved.unknown, 'Available here': row.available.local, 'Available elsewhere': row.available.remote, 'Used here': row.used.stockLocal, 'Used elsewhere': row.used.stockRemote, 'Queued here': row.queued.local, 'Queued elsewhere': row.queued.remote, 'Queued paused': row.queued.paused, 'Used from queue here': row.used.queuedLocal, 'Used from queue elsewhere': row.used.queuedRemote, 'Spare stock': row.spare, 'Net shortage': row.net, 'Net shortage basis': row.netBasis, 'Shortage BP': row.shortBP, 'Units to move': row.needed === null ? null : row.moves.reduce((sum, move) => sum + move.units, 0), 'Tons to move': row.needed === null ? null : row.moves.every((move) => move.tons !== null) ? row.moves.reduce((sum, move) => sum + move.tons, 0) : null, Note: [row.why, BASIS_NOTE[row.netBasis], ...row.unknown].filter(Boolean).join('; '), Rule: RULE }))

    row.perPlan.forEach((entry) => lines.push(record({ Record: 'plan', 'Component ID': row.componentId, Component: row.name, Plan: (planOf(entry.planId) || {}).className, Hulls: (planOf(entry.planId) || {}).hulls, Needed: entry.needed, 'Used here': entry.stockLocal, 'Used elsewhere': entry.stockRemote, 'Used from queue here': entry.queuedLocal, 'Used from queue elsewhere': entry.queuedRemote, 'Net shortage': entry.short, Rule: RULE })))
  })

  manifest.manufacture.forEach((entry) => lines.push(record({ Record: 'manufacture', 'Component ID': entry.componentId, Component: entry.componentName, 'Colony ID': entry.populationId, Colony: entry.colonyName, System: entry.systemName, 'Manufacture state': entry.state, 'Manufactured units': entry.incomplete ? null : entry.units, 'Used by plans': entry.used, 'Not used by plans': entry.unused, Note: `${entry.here ? 'made at the colony the components are needed at' : entry.sameSystem === true ? 'made in the same system' : entry.sameSystem === false ? 'made in another system' : 'made elsewhere'}${entry.state === 'paused' ? '; paused, so not counted as supply' : entry.state === 'not known' ? '; whether it is paused is not known, so not counted as supply' : ''}${entry.incomplete ? `; units not known${entry.units === null ? '' : ` beyond the ${cell(entry.units)} known`}` : ''}`, Rule: RULE })))

  manifest.moves.forEach((move) => lines.push(record({ Record: 'transport', 'Component ID': move.componentId, Component: move.componentName, 'Colony ID': move.populationId, Colony: move.colonyName, System: move.systemName, 'Units to move': move.units, 'Tons to move': move.tons, Note: `moved from here to ${manifest.target.name}; ${move.stage === 'queued' ? 'queued for manufacture' : 'in stock'}${move.sameSystem === true ? ', in the same system' : move.sameSystem === false ? ', in another system' : ''}`, Rule: RULE })))

  manifest.claims.forEach((claim) => lines.push(record({ Record: 'reservation', 'Component ID': claim.componentId, 'Colony ID': claim.populationId, 'Reserved (proven)': claim.proof === 'proven' ? claim.units : null, 'Held back (claim not known)': claim.proof === 'proven' ? null : 'held', Note: `${claim.source}: ${claim.reason}`, Rule: 'production.procurementReservations' })))

  return lines.join('\n')
}

// The manifest as plain text for a clipboard: the plans, then a line for each component with what is short first, then what has to be moved.
export const manifestText = (manifest, { count = (value) => String(rounded(value)) } = {}) => {
  const lines = [`Component procurement manifest for ${manifest.plans.map((plan) => `${plan.hulls} x ${plan.className}`).join(', ')}, needed at ${manifest.target.name}`]
  const figure = (value) => (value === null ? 'not known' : count(value))
  const stockText = (total, known) => (total === null ? `not known (${figure(known)} known)` : figure(total))

  ;[...manifest.rows].sort((a, b) => (b.net || 0) - (a.net || 0)).forEach((row) => {
    lines.push(`${row.name} (ID ${row.componentId}): needed ${figure(row.needed)}; stock here ${stockText(row.stock.local, row.stock.known.local)}, elsewhere ${stockText(row.stock.remote, row.stock.known.remote)}; held back ${figure(row.reserved.proven)} proven${row.reserved.unknown > 0 ? `, ${figure(row.reserved.unknown)} by a claim not known` : ''}; available here ${stockText(row.available.local, row.available.known.local)}, elsewhere ${stockText(row.available.remote, row.available.known.remote)}; queued here ${stockText(row.queued.local, row.queued.known.local)}, elsewhere ${stockText(row.queued.remote, row.queued.known.remote)}, paused ${stockText(row.queued.paused, row.queued.known.paused)}; net shortage ${row.netBasis === 'at most' ? 'at most ' : ''}${figure(row.net)}${row.route === 'hull' ? ' (built with the hull)' : row.route === 'stock' ? ' (stock required: the race has not researched it, so it cannot be made)' : ''}`)
  })

  manifest.manufacture.forEach((entry) => lines.push(`Manufacture ${stockText(entry.incomplete ? null : entry.units, entry.units === null ? 0 : entry.units)} ${entry.componentName} at ${entry.colonyName} (${entry.state === 'paused' ? 'paused, not counted as supply' : entry.state === 'not known' ? 'whether it is paused is not known, not counted as supply' : entry.used === null ? 'queued; the use by the plans is not known' : `queued; ${figure(entry.used)} used by the plans, ${entry.unused === null ? 'the rest not known' : `${figure(entry.unused)} not used`}`})`))

  manifest.moves.forEach((move) => lines.push(`Move ${figure(move.units)} ${move.componentName} from ${move.colonyName}${move.stage === 'queued' ? ' (queued for manufacture there)' : ''}${move.tons === null ? '' : `, ${figure(move.tons)} t`}`))

  if (manifest.unknown.length) {
    lines.push(`Not known: ${manifest.unknown.join('; ')}`)
  }

  return lines.join('\n')
}
