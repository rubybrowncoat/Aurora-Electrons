// The race's geological survey and xenoarchaeology formations against the known work they could do, as the Survey Progress page lists them. A formation comes from the shared model of the race's formations (utilities/ground-formations.js) and appears once, with the capability its actual elements give, its location and its mass; nothing here reads a template or a second formation loader. The work is the known ground survey targets (bodies the race has surveyed, in systems it knows, with ground survey potential left) and the known ruins whose builders the race has not yet identified; a body or ruin the race has not surveyed is never a target. No assignment is issued: the page states what the save shows and what the rules say.
//
// A formation is in one of five states:
// - `embarked`: aboard a ship, which holds no colony, so no survey or recovery work reaches it.
// - `unresolved`: its place is not settled (no location stored, a ship, fleet or colony the save lacks, no system, or no body for the colony), so nothing is said of its work.
// - `busy`: stationed at a colony on a body that has work for one of its roles: ground survey potential left for a geological formation, a ruin not yet identified or an ancient construct that is not active for a xenoarchaeology one (the game works a construct with no ruin, and a construct is no listed target). The game takes such a formation into the work by itself, with no order: the save stores no task for a formation, so busy is derived from its location.
// - `unknown`: at a colony on a body with no known work for its roles, where the game may still put it to work. The game works a ruin without asking whether the race has surveyed the body, so a xenoarchaeology formation at a colony on a ruin outside the known targets (an unsurveyed body, a system the race does not know, no installations count stored, or ruins that could not be read) may be at work, and so may one at a colony whose ancient construct has no stored state or whose constructs could not be read; a rating the save leaves unknown may be doing work too. A geological formation is different: the game requires the body to be surveyed by the race, so an unsurveyed body is no work for it.
// - `idle`: at a colony on a body with no work for its roles, which nothing leaves in doubt.
// A colony needs no minimum population for this: an outpost with no residents is a colony, and a formation there works. The population of a candidate colony is shown and never tested.

import { systemBodyName } from './aurora'
import { formationPlace, formationRoles } from './ground-formations'
import { ruinState } from './map-features'
import { carryFormations } from './mine-bootstrap'
import { columnsOf, gaps } from './mine-bootstrap-data'
import { valueOrNull } from './provenance'
import { formationRows } from './remote-formations'

export const SPECIALIST_ROLES = Object.freeze(['geo', 'xeno'])

export const ROLE_CHOICES = Object.freeze([
  { value: 'geo', text: 'Geological' },
  { value: 'xeno', text: 'Xenoarchaeology' },
])

export const STATE_CHOICES = Object.freeze([
  { value: 'idle', text: 'Idle' },
  { value: 'busy', text: 'Busy' },
  { value: 'embarked', text: 'Embarked' },
  { value: 'unresolved', text: 'Location not resolved' },
  { value: 'unknown', text: 'Activity not known' },
])

const STATE_KEYS = STATE_CHOICES.map((choice) => choice.value)
const ROLE_KEYS = ROLE_CHOICES.map((choice) => choice.value)

const keptChoices = (keys) => (stored) => (Array.isArray(stored) ? keys.filter((key) => stored.includes(key)) : undefined)

// The role and state filters as view preferences of the race (`persistedView`, mixins/persisted-view.js): the roles and the states that are on. A stored value keeps only the choices still offered.
export const rolesView = Object.freeze({ key: 'deployRoles', scope: 'race', default: Object.freeze(ROLE_KEYS.slice()), normalise: keptChoices(ROLE_KEYS) })
export const statesView = Object.freeze({ key: 'deployStates', scope: 'race', default: Object.freeze(STATE_KEYS.slice()), normalise: keptChoices(STATE_KEYS) })

const STATE_ORDER = Object.fromEntries(STATE_KEYS.map((key, index) => [key, index]))
const LIFT_ORDER = { aboard: -1, one: 0, several: 1, none: 2, 'no-bays': 3, unsized: 4, unknown: 5 }

const isId = (value) => Number.isInteger(value) && value > 0

// The colony of a target row: { id, name, population }, or null for a body with none. Whether a colony is a candidate does not depend on its population: the population is carried for display (null when the save does not give it) and is never compared with a threshold.
export const colonyOf = (row) => (isId(row.PopulationID) ? { id: row.PopulationID, name: row.PopName ?? null, population: Number.isFinite(row.ColonyPopulation) ? row.ColonyPopulation : null } : null)

// The ground survey targets from the page's ground survey rows (`groundSurveys`, one per body with potential left and per colony of the race on it): { key, role: 'geo', bodyId, systemId, systemName, name, colony, potential, required, done, left }.
export const geoTargets = (rows) => rows.map((row) => {
  const done = Number.isFinite(row.PointsDone) ? row.PointsDone : 0

  return { key: `geo:${row.SystemBodyID}:${isId(row.PopulationID) ? row.PopulationID : 0}`, role: 'geo', bodyId: row.SystemBodyID, systemId: row.SystemID ?? null, systemName: row.SystemName ?? null, name: row.name, colony: colonyOf(row), potential: row.Potential, required: row.PointsRequired, done, left: Math.max(0, row.PointsRequired - done) }
})

// The ruin states of the ruins on bodies the race has surveyed in systems it knows (`loadRuinSites` rows), counted: `found` (builders not identified, work left for xenoarchaeology), `identified`, `used` (no installations left) and `unknown` (the save does not give the installations left).
const RUIN_STATES = Object.freeze(['found', 'identified', 'used'])

const stateOfRuin = (row) => valueOrNull(ruinState({ factories: Number.isFinite(row.AbandonedFactories) ? row.AbandonedFactories : null, known: Boolean(row.Known) }))

// The xenoarchaeology targets and the ruin counts from the ruin rows: `targets` is one per known ruin whose builders are not identified (and per colony of the race on it), { key, role: 'xeno', bodyId, systemId, systemName, name, colony, ruin, race: null, left (installations left) }; `states` counts the known ruins by state, the colonies of one ruin counted once. A row is known when the race has surveyed its body in a system it knows (`Surveyed` and `SystemKnown`); the read also holds the ruins on colony bodies that are not, which are never a target or counted. `unseen` is the set of bodies the game may work with no known target: a colony body with a ruin the race has not surveyed (or in a system it does not know) and whose builders are not identified or whose installations left are not stored, and a known ruin whose installations left are not stored.
export const ruinTargets = (rows) => {
  const states = { found: 0, identified: 0, used: 0, unknown: 0 }
  const counted = new Set()
  const unseen = new Set()
  const targets = []

  rows.forEach((row) => {
    const state = stateOfRuin(row)
    const known = Boolean(row.Surveyed) && Boolean(row.SystemKnown)

    if (!known) {
      if (isId(row.PopulationID) && (state === 'found' || !RUIN_STATES.includes(state))) {
        unseen.add(row.SystemBodyID)
      }

      return
    }

    if (!counted.has(row.SystemBodyID)) {
      counted.add(row.SystemBodyID)
      states[RUIN_STATES.includes(state) ? state : 'unknown']++
    }

    if (!RUIN_STATES.includes(state) && isId(row.PopulationID)) {
      unseen.add(row.SystemBodyID)
    }

    if (state === 'found') {
      targets.push({ key: `xeno:${row.SystemBodyID}:${isId(row.PopulationID) ? row.PopulationID : 0}`, role: 'xeno', bodyId: row.SystemBodyID, systemId: row.SystemID ?? null, systemName: row.SystemName ?? null, name: systemBodyName(row, { Name: row.SystemName }), colony: colonyOf(row), ruin: row.Ruin || 'Ruins', left: row.AbandonedFactories })
    }
  })

  return { targets, states, unseen }
}

// The columns the ruin read needs; a save that lacks one has no ruin targets, and the read says which.
const RUIN_COLUMNS = {
  FCT_SystemBody: ['SystemBodyID', 'SystemID', 'GameID', 'BodyClass', 'PlanetNumber', 'OrbitNumber', 'StarID', 'RuinID', 'RuinRaceID', 'AbandonedFactories'],
  FCT_SystemBodySurveys: ['SystemBodyID', 'RaceID', 'GameID'],
  FCT_RaceSysSurvey: ['SystemID', 'RaceID', 'GameID', 'Name'],
  FCT_Star: ['StarID', 'Component'],
  FCT_SystemBodyName: ['SystemBodyID', 'RaceID', 'Name'],
  DIM_Ruin: ['RuinID', 'Description'],
  FCT_RuinRace: ['RuinRaceID', 'GameID', 'Name'],
  FCT_KnownRuinRace: ['RuinRaceID', 'GameID', 'RaceID'],
  FCT_Population: ['PopulationID', 'PopName', 'Population', 'RaceID', 'GameID', 'SystemBodyID'],
}

// The ruins on the bodies the race has surveyed in the systems it knows, and those on a colony body of the race whether or not it has surveyed them, one row per ruin and per colony of the race on its body, from the same join as the map's ruins (utilities/map-features.js) with the body and the colony added: { supported: true, rows } or { supported: false, missing }. `Surveyed` and `SystemKnown` say whether the race has surveyed the body and knows its system; a row with either missing is read only for its colony, since the game works a ruin at a colony without asking for the survey. `Known` is whether the race has identified the ruin's builders.
export const loadRuinSites = async (database, { GameID, RaceID }) => {
  const missing = []

  for (const [table, wanted] of Object.entries(RUIN_COLUMNS)) {
    missing.push(...gaps(table, await columnsOf(database, table), wanted))
  }

  if (missing.length) {
    return { supported: false, missing }
  }

  const [rows] = await database.query(`select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_Star.Component, FCT_SystemBodyName.Name as SystemBodyName, FCT_RaceSysSurvey.Name as SystemName, DIM_Ruin.Description as Ruin, FCT_SystemBody.AbandonedFactories, FCT_RuinRace.Name as RuinRaceName, FCT_KnownRuinRace.RuinRaceID is not null as Known, FCT_SystemBodySurveys.SystemBodyID is not null as Surveyed, FCT_RaceSysSurvey.SystemID is not null as SystemKnown, FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population as ColonyPopulation from FCT_SystemBody left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID} left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.GameID = ${GameID} and FCT_SystemBodySurveys.RaceID = ${RaceID} inner join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID} left join DIM_Ruin on DIM_Ruin.RuinID = FCT_SystemBody.RuinID left join FCT_RuinRace on FCT_RuinRace.RuinRaceID = FCT_SystemBody.RuinRaceID and FCT_RuinRace.GameID = FCT_SystemBody.GameID left join FCT_KnownRuinRace on FCT_KnownRuinRace.RuinRaceID = FCT_SystemBody.RuinRaceID and FCT_KnownRuinRace.GameID = FCT_SystemBody.GameID and FCT_KnownRuinRace.RaceID = ${RaceID} left join FCT_Population on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} where FCT_SystemBody.GameID = ${GameID} and FCT_SystemBody.RuinID > 0 and ((FCT_SystemBodySurveys.SystemBodyID is not null and FCT_RaceSysSurvey.SystemID is not null) or FCT_Population.PopulationID is not null) order by FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_Population.PopulationID`)

  return { supported: true, rows }
}

// The columns the construct read needs; a save that lacks one has no construct read, and the read says which.
const CONSTRUCT_COLUMNS = {
  FCT_AncientConstruct: ['SystemBodyID', 'GameID', 'Active'],
  FCT_SystemBody: ['SystemBodyID', 'SystemID', 'BodyClass', 'PlanetNumber', 'OrbitNumber', 'StarID'],
  FCT_RaceSysSurvey: ['SystemID', 'RaceID', 'GameID', 'Name'],
  FCT_Star: ['StarID', 'Component'],
  FCT_SystemBodyName: ['SystemBodyID', 'RaceID', 'Name'],
  FCT_Population: ['PopulationID', 'RaceID', 'GameID', 'SystemBodyID'],
}

// The ancient constructs on the bodies the race has a colony on, whether or not it has surveyed them: the game's xenoarchaeology process works a formation at a colony on a construct that is not active and asks nothing more (no ruin, no survey), so a formation there is at work. The same table the map reads (`FCT_AncientConstruct.Active`), but not through the map's join, which keeps the bodies the race has surveyed only: { supported: true, rows } or { supported: false, missing }; a row is { SystemBodyID, SystemID, BodyClass, PlanetNumber, OrbitNumber, Component, SystemBodyName, SystemName, Active }, one per colony of the race on the body.
export const loadConstructSites = async (database, { GameID, RaceID }) => {
  const missing = []

  for (const [table, wanted] of Object.entries(CONSTRUCT_COLUMNS)) {
    missing.push(...gaps(table, await columnsOf(database, table), wanted))
  }

  if (missing.length) {
    return { supported: false, missing }
  }

  const [rows] = await database.query(`select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_Star.Component, FCT_SystemBodyName.Name as SystemBodyName, FCT_RaceSysSurvey.Name as SystemName, FCT_AncientConstruct.Active from FCT_AncientConstruct inner join FCT_Population on FCT_Population.SystemBodyID = FCT_AncientConstruct.SystemBodyID and FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_AncientConstruct.SystemBodyID inner join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${RaceID} left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID} where FCT_AncientConstruct.GameID = ${GameID} group by FCT_AncientConstruct.SystemBodyID`)

  return { supported: true, rows }
}

// The bodies the game works a xenoarchaeology formation on without any ruin, from the construct rows: `inactive` maps the id of a body whose construct is not active to { bodyId, name, kind: 'construct' } (the work a busy formation there names), `unknown` is the set of bodies whose construct has no stored state, where a formation may or may not be at work. An active construct is no work.
export const constructBodies = (rows) => {
  const inactive = new Map()
  const unknown = new Set()

  rows.forEach((row) => {
    const state = row.Active === null || row.Active === undefined ? null : Number(row.Active)

    if (state === 0) {
      inactive.set(row.SystemBodyID, { bodyId: row.SystemBodyID, name: systemBodyName(row, { Name: row.SystemName }), kind: 'construct' })
    } else if (state !== 1) {
      unknown.add(row.SystemBodyID)
    }
  })

  return { inactive, unknown }
}

// The targets by role, indexed for the join with the formations: `byRole[role]` lists them, `byBody[role]` maps a body id to its targets (a body with two colonies of the race has two) and `bySystem[role]` maps a system id to them. `bodies[role]` counts the bodies once each, `colonies[role]` those with a colony of the race, `systems[role]` the systems. `unseen` is the set of bodies where a xenoarchaeology formation may work with no known target (`ruinTargets`), or null when the ruins could not be read, so that any body may be one. `constructs` is { inactive, unknown } as `constructBodies` gives them, or null when the constructs could not be read; the constructs are work for a xenoarchaeology formation but no target.
export const indexTargets = ({ geo = [], xeno = [], unseen = new Set(), constructs = { inactive: new Map(), unknown: new Set() } }) => {
  const byRole = { geo, xeno }
  const byBody = {}
  const bySystem = {}
  const bodies = {}
  const colonies = {}
  const systems = {}

  SPECIALIST_ROLES.forEach((role) => {
    byBody[role] = new Map()
    bySystem[role] = new Map()
    byRole[role].forEach((target) => {
      byBody[role].set(target.bodyId, [...(byBody[role].get(target.bodyId) || []), target])
      bySystem[role].set(target.systemId, [...(bySystem[role].get(target.systemId) || []), target])
    })
    bodies[role] = byBody[role].size
    colonies[role] = new Set(byRole[role].filter((target) => target.colony).map((target) => target.bodyId)).size
    systems[role] = bySystem[role].size
  })

  return { byRole, byBody, bySystem, bodies, colonies, systems, unseen, constructs }
}

// The reason kinds of a place the model leaves unresolved.
const unresolvedReasons = (place) => place.reasons.filter((reason) => reason.kind !== 'system-not-surveyed')

// The state of a formation, `work` (the roles at work and the targets on its body), and the reasons when its place is not resolved or its activity is not known: { state, work: [{ role, targets }], reasons }. `place` is `formationPlace` of the formation, `index` the targets as `indexTargets` gives them.
export const deploymentState = (node, place, index) => {
  const { location } = node
  const roles = formationRoles(node)

  if (location.kind === 'ship' && location.state === 'resolved') {
    return { state: 'embarked', work: [], reasons: [] }
  }

  if (location.state === 'unresolved') {
    return { state: 'unresolved', work: [], reasons: unresolvedReasons(place) }
  }

  const bodyId = location.kind === 'colony' && location.population ? location.population.bodyId : null

  if (!isId(bodyId)) {
    return { state: 'unresolved', work: [], reasons: [{ kind: 'colony-body-unknown', message: `The body of colony ${location.population.id} is not stored` }] }
  }

  const work = SPECIALIST_ROLES.filter((role) => roles[role] === true && index.byBody[role].has(bodyId)).map((role) => ({ role, bodyId, targets: index.byBody[role].get(bodyId) }))

  const construct = roles.xeno === true && index.constructs ? index.constructs.inactive.get(bodyId) : undefined

  if (construct && !work.some((item) => item.role === 'xeno')) {
    work.push({ role: 'xeno', bodyId, targets: [construct] })
  }

  if (work.length) {
    return { state: 'busy', work, reasons: [] }
  }

  const reasons = []

  if (SPECIALIST_ROLES.some((role) => roles[role] === null && index.byBody[role].has(bodyId)) || (roles.xeno === null && index.constructs && index.constructs.inactive.has(bodyId))) {
    reasons.push({ kind: 'rating-unknown', message: 'A rating the save leaves unknown could put it to work here' })
  }

  if (roles.xeno !== false) {
    if (index.unseen === null) {
      reasons.push({ kind: 'ruins-unread', message: 'The ruins could not be read from this save, so whether it works a ruin here is not known' })
    } else if (index.unseen.has(bodyId)) {
      reasons.push({ kind: 'ruin-unseen', message: 'A ruin here is not known to the race in full, and the game works a ruin whether or not the race has surveyed its body, so whether it works here is not known' })
    }

    if (index.constructs === null) {
      reasons.push({ kind: 'constructs-unread', message: 'The ancient constructs could not be read from this save, so whether it works a construct here is not known' })
    } else if (index.constructs.unknown.has(bodyId)) {
      reasons.push({ kind: 'construct-unknown', message: 'An ancient construct here has no stored state, so whether it works here is not known' })
    }
  }

  return { state: reasons.length ? 'unknown' : 'idle', work: [], reasons }
}

// How a formation is carried by the race's troop ships (`troops`: { classes: [{ TroopCapacity, Ships }] }, or null when the save does not give the troop bays), from `carryFormations` with the model's mass as the formation's own size. Formations in `pool` are packed together, largest first, into the bays of one lift and the lifts after it; any other formation is judged alone. The result is { kind, lift, lifts, largest }: `one` (fits the first lift), `several` (fits a bay but waits for lift number `lift` of `lifts`), `none` (larger than the largest bay: no ship holds it), `no-bays` (no troop ship), `unsized` (the mass is not known) or `unknown` (the troop bays are not known).
const liftOf = (rows, troops, pool) => {
  const largest = troops ? Math.max(0, ...troops.classes.flatMap((item) => (Number.isFinite(item.TroopCapacity) ? [item.TroopCapacity] : []))) : null
  const result = new Map()
  const candidates = (list) => list.map((row) => ({ id: row.id, formation: { ownSize: row.mass } }))

  if (!troops) {
    rows.forEach((row) => result.set(row.id, { kind: 'unknown', lift: null, lifts: null, largest }))

    return { result, lifts: null }
  }

  const bays = troops.classes.reduce((sum, item) => sum + (Number.isFinite(item.TroopCapacity) ? Math.max(0, item.Ships) : 0), 0)
  const place = (list) => {
    const verdict = (id, kind, lift = null, lifts = null) => result.set(id, { kind, lift, lifts, largest })

    // With no bay at all the verdict is `no-bays` (or `unsized`), not the `none` that `carryFormations` gives a formation larger than the largest bay, so it is not asked then.
    if (bays === 0) {
      list.forEach((row) => verdict(row.id, Number.isFinite(row.mass) ? 'no-bays' : 'unsized'))

      return 0
    }

    const planned = carryFormations(candidates(list), troops)

    planned.unsized.forEach((candidate) => verdict(candidate.id, 'unsized'))
    planned.oversize.forEach((candidate) => verdict(candidate.id, 'none'))

    let step = 1
    let carried = planned.carried
    let later = planned.later

    while (carried.length) {
      carried.forEach((candidate) => verdict(candidate.id, step === 1 ? 'one' : 'several', step, planned.lifts))

      if (!later.length) {
        break
      }

      const next = carryFormations(later, troops)

      carried = next.carried
      later = next.later
      step++
    }

    return planned.lifts
  }

  const pooled = rows.filter((row) => pool(row))
  const lifts = place(pooled)

  rows.filter((row) => !pool(row)).forEach((row) => {
    if (row.state === 'embarked') {
      result.set(row.id, { kind: 'aboard', lift: null, lifts: null, largest })
    } else {
      place([row])
    }
  })

  return { result, lifts }
}

// One row for each geological or xenoarchaeology formation of the model, once (`formationRows` of utilities/remote-formations.js with the deployment columns added): its state and the work it does, its candidates counted (`candidates`: { colonies, bare, sameSystem } of the targets of its roles other than the work it is at, a candidate colony being a colony of the race on a target body and a bare one a target body with none), and how the troop ships carry it (`lift`). A formation whose roles the save does not settle, and one with neither rating, are not listed and are counted in `others`. `troops` is null when the troop bays are not known. Returns { rows, others, lifts, index }; the formations in the pool are the idle ones, packed into the troop bays together.
export const specialistRows = (model, targets, troops) => {
  const index = indexTargets(targets)
  const shared = new Map(formationRows(model).map((row) => [row.id, row]))
  const rows = []
  let others = 0

  model.formations.forEach((node) => {
    const roles = formationRoles(node)

    if (roles.geo !== true && roles.xeno !== true) {
      others++

      return
    }

    const place = formationPlace(node, model)
    const status = deploymentState(node, place, index)
    const own = SPECIALIST_ROLES.filter((role) => roles[role] === true)
    const at = new Set(status.work.flatMap((item) => item.targets.map((target) => target.bodyId)))
    const here = node.location.system ? node.location.system.id : null
    const bodies = new Map()

    own.forEach((role) => {
      index.byRole[role].forEach((target) => {
        if (at.has(target.bodyId)) {
          return
        }

        const key = `${role}:${target.bodyId}`
        const entry = bodies.get(key) || { colony: false, sameSystem: false }

        entry.colony = entry.colony || Boolean(target.colony)
        entry.sameSystem = entry.sameSystem || (here !== null && target.systemId === here)
        bodies.set(key, entry)
      })
    })

    const counted = { colonies: [...bodies.values()].filter((entry) => entry.colony).length, bare: [...bodies.values()].filter((entry) => !entry.colony).length, sameSystem: [...bodies.values()].filter((entry) => entry.sameSystem).length }

    rows.push({ ...shared.get(node.id), roleKeys: own, systemId: here, state: status.state, stateLabel: STATE_CHOICES.find((choice) => choice.value === status.state).text, stateOrder: STATE_ORDER[status.state], work: status.work.map((item) => ({ role: item.role, bodyId: item.bodyId, name: item.targets[0].name })), workLabel: status.work.map((item) => item.targets[0].name).join(', '), stateReasons: status.reasons, candidates: counted, candidateSort: counted.colonies + counted.bare, lift: null, liftSort: null })
  })

  const planned = liftOf(rows, troops, (row) => row.state === 'idle')

  rows.forEach((row) => {
    row.lift = planned.result.get(row.id)
    row.liftSort = LIFT_ORDER[row.lift.kind] * 1000 + (row.lift.lift || 0)
  })

  return { rows, others, lifts: planned.lifts, index }
}

// The targets a formation could serve, nearest first: those of its roles other than the work it is at, each { target, sameSystem, staffed } with `staffed` the busy formations at the body. Colonies of the race come before bodies with none, those in the formation's own system first, the unstaffed before the staffed, the most work left first. `row` is a row of `specialistRows`, `rows` all of them.
export const candidatesOf = (row, index, rows) => {
  const mine = new Set(row.work.map((item) => item.bodyId))
  const staffed = new Map()

  rows.filter((other) => other.state === 'busy').forEach((other) => {
    other.work.forEach((item) => staffed.set(`${item.role}:${item.bodyId}`, (staffed.get(`${item.role}:${item.bodyId}`) || 0) + 1))
  })

  return row.roleKeys.flatMap((role) => index.byRole[role]).filter((target) => !mine.has(target.bodyId)).map((target) => ({ target, sameSystem: row.systemId !== null && target.systemId === row.systemId, staffed: staffed.get(`${target.role}:${target.bodyId}`) || 0 })).sort((a, b) => Number(Boolean(b.target.colony)) - Number(Boolean(a.target.colony)) || Number(b.sameSystem) - Number(a.sameSystem) || a.staffed - b.staffed || b.target.left - a.target.left || a.target.name.localeCompare(b.target.name))
}

const plural = (count, one, many) => (count === 1 ? one : many)

// The words of a formation's troop lift (`lift` of a row), `count` formatting a number.
export const liftText = (lift, count) => {
  switch (lift.kind) {
    case 'one': return lift.lifts > 1 ? `Lift 1 of ${count(lift.lifts)}` : 'One lift'
    case 'several': return `Lift ${count(lift.lift)} of ${count(lift.lifts)}`
    case 'none': return `No troop bay holds it (the largest takes ${count(lift.largest)} t)`
    case 'no-bays': return 'No troop ship'
    case 'unsized': return 'Mass not known'
    case 'aboard': return 'Aboard a ship'
    default: return 'Troop bays not known'
  }
}

// The words of a formation's candidate counts (`candidates` of a row).
export const candidateText = (candidates, count) => {
  const parts = []

  if (candidates.colonies) {
    parts.push(`${count(candidates.colonies)} ${plural(candidates.colonies, 'colony', 'colonies')}`)
  }

  if (candidates.bare) {
    parts.push(`${count(candidates.bare)} ${plural(candidates.bare, 'body', 'bodies')} with no colony`)
  }

  if (!parts.length) {
    return 'None known'
  }

  return `${parts.join(', ')}${candidates.sameSystem ? `; ${count(candidates.sameSystem)} in its system` : ''}`
}

// One row for each target, the two roles together: { key, role, roleLabel, name, systemId, systemName, colony, left, busy, idle, status }. `busy` counts the busy formations at the target's body (a body with two colonies of the race shows the same count on both rows), `idle` the idle formations with the target's role, and `status` is `no-colony` for a body with no colony of the race, `worked` when a formation is busy there and `unstaffed` otherwise. `rows` are those of `specialistRows`, `index` its targets.
export const targetRows = (index, rows) => {
  const busy = new Map()
  const idle = { geo: 0, xeno: 0 }

  rows.forEach((row) => {
    row.work.forEach((item) => busy.set(`${item.role}:${item.bodyId}`, (busy.get(`${item.role}:${item.bodyId}`) || 0) + 1))

    if (row.state === 'idle') {
      row.roleKeys.forEach((role) => {
        idle[role]++
      })
    }
  })

  return SPECIALIST_ROLES.flatMap((role) => index.byRole[role].map((target) => {
    const here = busy.get(`${role}:${target.bodyId}`) || 0

    return { key: target.key, role, roleLabel: ROLE_CHOICES.find((choice) => choice.value === role).text, name: target.name, systemId: target.systemId, systemName: target.systemName, colony: target.colony, colonyName: target.colony ? target.colony.name || `Colony ${target.colony.id}` : 'No colony', left: target.left, busy: here, idle: idle[role], status: target.colony ? (here ? 'worked' : 'unstaffed') : 'no-colony' }
  }))
}

// The rows the table shows: the roles on (a formation with both is in both), and the states on.
export const selectDeployments = (rows, { roles, states }) => rows.filter((row) => row.roleKeys.some((role) => roles.includes(role)) && states.includes(row.state))

// The counts the chips and the foot state, over all the rows: { formations, geo, xeno, both, states: { idle, busy, embarked, unresolved, unknown }, others, targets }, with `formations = geo + xeno - both` and the states adding up to `formations`. `others` is the formations of the model that are no specialist (or whose role the save does not settle).
export const deploymentTotals = (rows, others, index) => {
  const states = { idle: 0, busy: 0, embarked: 0, unresolved: 0, unknown: 0 }
  let geo = 0
  let xeno = 0
  let both = 0

  rows.forEach((row) => {
    states[row.state]++
    geo += row.roleKeys.includes('geo') ? 1 : 0
    xeno += row.roleKeys.includes('xeno') ? 1 : 0
    both += row.roleKeys.length === 2 ? 1 : 0
  })

  return { formations: rows.length, geo, xeno, both, states, others, targets: { geo: { bodies: index.bodies.geo, colonies: index.colonies.geo, systems: index.systems.geo }, xeno: { bodies: index.bodies.xeno, colonies: index.colonies.xeno, systems: index.systems.xeno } } }
}

// The ground survey of each colony from the model's formations at it, the base of the Ground surveys table: a map from a colony's PopulationID to { units, base, perDay, unknown }. `units` adds the units of the elements with geosurvey equipment of the formations stationed there, `base` their geosurvey rating, `perDay` the rating times each formation's commander Survey bonus (`bonuses`: a map from a formation id to the bonus; 1 for none) and `unknown` lists the formations whose rating the save does not give (their units and rating are not in the sums). A formation aboard a ship is at no colony.
export const colonyGeoTeams = (model, bonuses) => {
  const teams = new Map()

  model.formations.forEach((node) => {
    const { location } = node

    if (location.kind !== 'colony' || !location.population || !isId(location.population.id)) {
      return
    }

    const team = teams.get(location.population.id) || teams.set(location.population.id, { units: 0, base: 0, perDay: 0, unknown: [] }).get(location.population.id)

    if (node.geo.value === null) {
      team.unknown.push(node.id)
    } else if (node.geo.value > 0) {
      team.units += node.geo.from.reduce((sum, item) => sum + item.units, 0)
      team.base += node.geo.value
      team.perDay += node.geo.value * (bonuses.get(node.id) ?? 1)
    }
  })

  return teams
}
