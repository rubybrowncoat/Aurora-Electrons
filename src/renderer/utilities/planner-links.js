// Where the Missile Designer, the Sensor Planner and Designed Tech meet: what a missile hands over to the Sensor Planner, how that handover and an identifier in a link are checked against the open save, and the words that say what a link could not open. The query keys are utilities/deep-links.js's; the arithmetic is design-rules.js's and sensor-planner.js's. The save is only read.
//
// The handover is the carried candidate, never a bare ID. A saved missile and a candidate of the designer (a reoptimised or nominated design, which is no saved MissileID) pass the same figures: the size in MSP, the evaluated range, where the figures come from (saved, researched, hypothetical or manual), the tech levels the design is built on by line, ID and kind (never a figure), and the target signature, resolution and jammer the designer assumed. A saved missile also names its MissileID, so the Sensor Planner can tell a missile that is gone, another race's, not researched or changed since the link was made; a candidate has no identity to check, so only its tech levels are checked. A scenario record is not the carrier: a record keeps inputs and a candidate is not one until it is saved, and a link written into the address stays readable on Back, Forward and reload with no record to open.
//
// The states of an identifier: `held` (a design of the race), `missing` (the save has no such design: deleted, or the link comes from another save), `other-race` (another race's design), `unowned` (no race has it), `not-researched` (the race has not researched it) and `unknown` (the save could not be read for it). A missile whose figures differ from the link's is `changed`.

import { cutText } from './deep-links'
import { SENSOR_RESOLUTIONS_HS, SENSOR_RULES } from './design-rules'
import { STATUS, getRule } from './provenance'
import { describeHypothetical, resolveChoices } from './tech-scenarios'

export const STANDING = Object.freeze({ HELD: 'held', MISSING: 'missing', OTHER_RACE: 'other-race', UNOWNED: 'unowned', NOT_RESEARCHED: 'not-researched', UNKNOWN: 'unknown', CHANGED: 'changed' })

// The most reasons a notice lists for a target that cannot be read.
const SHOWN_PROBLEMS = 6

const reads = new WeakMap()

// The start of a read of what the save says: the owner's latest read of that name (a later one makes an earlier one stale) and the save it is made against, the database, game and race, as `{ name, generation, database, game, race }`. Await after taking it and publish only while `isCurrentRead` holds, so a read that finishes after the page moved to another save or race, or to another link, changes nothing.
export const beginRead = (owner, name) => {
  const counts = reads.get(owner) || {}

  counts[name] = (counts[name] || 0) + 1
  reads.set(owner, counts)

  return { name, generation: counts[name], database: owner.database, game: owner.GameID, race: owner.RaceID }
}

export const isCurrentRead = (owner, stamp) => (reads.get(owner) || {})[stamp.name] === stamp.generation && owner.database === stamp.database && owner.GameID === stamp.game && owner.RaceID === stamp.race

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const close = (a, b) => isNumber(a) && isNumber(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

const quoted = (name) => (name ? ` (${name})` : '')

// ---- What a missile hands over ---------------------------------------------------------------------------------------

// The target a column of the Missile Designer's comparison hands to the Sensor Planner: `{ ok: true, target }` for `linkTo.sensors({ target })`, or `{ ok: false, reason }` when the size or the range is not known (a link is never made with a 0 in their place). A saved column hands over the figures the save stored, the missile's own ID and no tech; a designed column hands over its evaluated figures, no ID and the tech levels it is built on. `scenario` is the designer's `{ signature, resolution, jammer }` as numbers (`resolution` is 'best' or a number), null for what is blank or not a figure.
export const missileHandoff = (column, { signature = null, resolution = null, jammer = null } = {}) => {
  if (!column) {
    return { ok: false, reason: 'There is no missile to hand over.' }
  }

  const figure = (id) => {
    const cell = column.figures[id]

    return cell ? (column.kind === 'saved' && isNumber(cell.stored) ? cell.stored : cell.value) : null
  }

  const msp = figure('size')
  const range = figure('maxRange')
  const missing = [msp === null ? `the size${column.figures.size && column.figures.size.reason ? ` (${column.figures.size.reason})` : ''}` : '', range === null ? `the range${column.figures.maxRange && column.figures.maxRange.reason ? ` (${column.figures.maxRange.reason})` : ''}` : ''].filter(Boolean)

  if (missing.length) {
    return { ok: false, reason: `${column.name}: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not known, so nothing is handed to the Sensor Planner.` }
  }

  const saved = column.kind === 'saved'

  return { ok: true, target: { missile: saved ? column.savedId : null, name: column.name, msp, range, signature: isNumber(signature) && signature > 0 ? signature : null, resolution: resolution === 'best' || (isNumber(resolution) && SENSOR_RESOLUTIONS_HS.includes(resolution)) ? resolution : null, jammer: isNumber(jammer) && jammer >= 0 ? jammer : null, source: column.source, tech: saved ? [] : column.tech.map(({ type, id, kind }) => ({ type, id, kind })) } }
}

// ---- Identifiers against the save ------------------------------------------------------------------------------------

// What the save says of a missile ID: `row` is the stored `{ Name, Size, MaxRange, OwnerID (the race whose tech row it is), Held (1 when the race holds the design's tech) }` or null for no row.
export const missileStanding = ({ id, row, raceId }) => {
  if (!row) {
    return { id, state: STANDING.MISSING, name: '', text: `The save has no missile with the ID ${id}: the design was deleted, or the link comes from another save.` }
  }

  const name = row.Name || ''
  const owner = row.OwnerID === null || row.OwnerID === undefined ? null : row.OwnerID

  if (owner === null) {
    return { id, state: STANDING.UNOWNED, name, text: `The missile ${id}${quoted(name)} is owned by no race, so it is no design of the race.` }
  } else if (owner !== raceId) {
    return { id, state: STANDING.OTHER_RACE, name, text: `The missile ${id}${quoted(name)} belongs to another race and is not shown for the race.` }
  } else if (!row.Held) {
    return { id, state: STANDING.NOT_RESEARCHED, name, text: `The missile ${id}${quoted(name)} is owned by the race but not researched by it.` }
  }

  return { id, state: STANDING.HELD, name, size: row.Size === undefined ? null : row.Size, range: row.MaxRange === undefined ? null : row.MaxRange, text: '' }
}

// What the save says of a component design ID: `row` is the stored `{ Name, ComponentTypeID, Held (1 when the race holds it), HeldByOthers (1 when another race does) }` or null for no row.
export const componentStanding = ({ id, row }) => {
  if (!row) {
    return { id, state: STANDING.MISSING, name: '', type: null, text: `The save has no component design with the ID ${id}: it was deleted, or the link comes from another save.` }
  }

  const name = row.Name || ''
  const type = row.ComponentTypeID === undefined ? null : row.ComponentTypeID

  if (row.Held) {
    return { id, state: STANDING.HELD, name, type, text: '' }
  } else if (row.HeldByOthers) {
    return { id, state: STANDING.OTHER_RACE, name, type, text: `The design ${id}${quoted(name)} is held by another race and not by the race.` }
  }

  return { id, state: STANDING.NOT_RESEARCHED, name, type, text: `The design ${id}${quoted(name)} is held by no race, so the race has not researched it.` }
}

// A link that names a missile and, from another page, its name: `changed` when the save holds the ID under another name (the link is not re-pointed to it), else the standing as it is.
export const missileLinkState = ({ standing, name = '' }) => {
  if (standing && standing.state === STANDING.HELD && name && standing.name !== name) {
    return { ...standing, state: STANDING.CHANGED, text: `The link named the missile ${standing.id} ${cutText(name)}, and the save holds that ID under the name ${cutText(standing.name)}. It is not the design the link meant, so it is not opened.` }
  }

  return standing
}

// Why a component design a link names is not among the designs of the mode, in words, or an empty text when it is.
export const componentPlacementText = ({ standing, mode, found }) => {
  if (!standing || found) {
    return ''
  }

  if (standing.state !== STANDING.HELD) {
    return standing.text
  }

  return `The design ${standing.id}${quoted(standing.name)} is a design of the race, and the ${mode} mode does not list it. Another mode may.`
}

const RACE_TECH_HELD = 'select count(*) from FCT_RaceTech where FCT_RaceTech.GameID = :game and FCT_RaceTech.RaceID'

// Reads what the save says of a missile ID for the race: a standing, `unknown` when the read fails (an older save may lack a table).
export const loadMissileStanding = async (database, { GameID, RaceID }, id) => {
  try {
    const [rows] = await database.query(`select FCT_MissileType.Name as Name, FCT_MissileType.Size as Size, FCT_MissileType.MaxRange as MaxRange, FCT_TechSystem.RaceID as OwnerID, (${RACE_TECH_HELD} = :race and FCT_RaceTech.TechID = FCT_MissileType.MissileID) as Held from FCT_MissileType left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_MissileType.MissileID and FCT_TechSystem.TechTypeID = 122 where FCT_MissileType.GameID = :game and FCT_MissileType.MissileID = :id`, { replacements: { game: GameID, race: RaceID, id } })

    return missileStanding({ id, row: rows[0] || null, raceId: RaceID })
  } catch (error) {
    return { id, state: STANDING.UNKNOWN, name: '', text: `The missile ${id} could not be checked against the save (${error.message}).` }
  }
}

// The same for a component design ID.
export const loadComponentStanding = async (database, { GameID, RaceID }, id) => {
  try {
    const [rows] = await database.query(`select FCT_ShipDesignComponents.Name as Name, FCT_ShipDesignComponents.ComponentTypeID as ComponentTypeID, (${RACE_TECH_HELD} = :race and FCT_RaceTech.TechID = FCT_ShipDesignComponents.SDComponentID) as Held, (${RACE_TECH_HELD} <> :race and FCT_RaceTech.TechID = FCT_ShipDesignComponents.SDComponentID) as HeldByOthers from FCT_ShipDesignComponents where FCT_ShipDesignComponents.GameID in (0, :game) and FCT_ShipDesignComponents.SDComponentID = :id`, { replacements: { game: GameID, race: RaceID, id } })

    return componentStanding({ id, row: rows[0] || null })
  } catch (error) {
    return { id, state: STANDING.UNKNOWN, name: '', type: null, text: `The design ${id} could not be checked against the save (${error.message}).` }
  }
}

// ---- A handover against the save ----------------------------------------------------------------------------------

// A tech level the link names, as the open save has it: researched, hypothetical (a next level the race has not researched), now researched (a level the link took for a hypothetical one), or one that cannot be used (gone, of another line, no longer held), with the reason.
const techRow = (item, resolved, tech) => {
  const known = tech.known[item.id] || null
  const name = known ? known.name : `tech ${item.id}`
  const row = { type: item.type, id: item.id, name, kind: item.kind, known: Boolean(known), state: 'unusable', hypothetical: false, text: '' }

  if (!resolved) {
    return { ...row, text: `${name}: the tech line ${item.type} is not one the planners read.` }
  } else if (resolved.unresolved) {
    return { ...row, text: `${name}: ${resolved.unresolved.reason}` }
  } else if (resolved.hypothetical) {
    return { ...row, state: 'hypothetical', hypothetical: true, text: `${name}: a level the race has not researched.`, assumption: describeHypothetical(resolved) }
  } else if (item.kind === 'hypothetical') {
    return { ...row, state: 'now-researched', text: `${name}: the link took this level for a hypothetical one, and the race has researched it since.` }
  }

  return { ...row, state: 'researched', text: `${name}: researched.` }
}

const rows = (target, tech) => {
  const selection = Object.fromEntries(target.tech.map((item) => [item.type, { techId: item.id, source: item.kind === 'hypothetical' ? 'scenario' : 'preference' }]))
  const resolution = resolveChoices(tech, selection)

  return target.tech.map((item) => techRow(item, resolution[item.type] || null, tech))
}

const SOURCE_NOTES = Object.freeze({
  saved: 'the missile is a saved design of the race',
  researched: 'the missile is a candidate made in the Missile Designer from the tech the race has researched, and is not a saved design',
  hypothetical: 'the missile is a candidate made in the Missile Designer on tech the race has not researched',
  manual: 'the missile is a candidate made in the Missile Designer on tech figures typed there, not read from the save',
})

// A missile target (deep-links.js `queryMissileTarget`) as the Sensor Planner takes it, checked against the open save. `standing` is the saved missile's (`loadMissileStanding`), undefined while it is not read; `tech` is the race's tech (tech-scenarios.js). Returns:
// - `pending`: a saved missile whose standing is not read yet, so nothing is decided;
// - `applies`: whether the figures are put in the planner's inputs: not for a saved missile that is gone, another race's, owned by none or not researched (the reason is in `problems`), always otherwise;
// - `state`: `held` (a saved missile as the save stores it), `changed` (a saved missile whose size, range or name differ from the link's; the carried figures stand as assumed and `notes` say what the save holds now), `candidate`, or the standing's state when it does not apply;
// - `origin`: what the target's signature carries into every sizing figure, `{ name, status, present, assumptions }` (null when it does not apply): a saved missile as the save stores it has the detection rule's own status, a candidate on researched tech the same with its note, and anything hypothetical, manual, changed or with a tech level that cannot be used is assumed with each assumption named;
// - `tech`: the carried levels, each with its state in the open save.
export const resolveMissileTarget = ({ target, standing, tech }) => {
  const levels = target.tech.length && tech ? rows(target, tech) : target.tech.map((item) => ({ type: item.type, id: item.id, name: `tech ${item.id}`, kind: item.kind, known: false, state: 'unchecked', hypothetical: false, text: `tech ${item.id}: not checked, the race's tech is not read yet.` }))
  const base = { pending: false, applies: false, state: STANDING.UNKNOWN, problems: [], notes: [], origin: null, tech: levels }

  if (target.missile !== null && (standing === undefined || standing === null)) {
    return { ...base, pending: true }
  }

  if (target.missile !== null && standing.state !== STANDING.HELD) {
    return { ...base, state: standing.state, problems: [`${standing.text} The figures the link carried (${target.msp} MSP, ${target.range} km) are not applied.`] }
  }

  const notes = []
  const assumptions = [`the size and the range were handed over by the Missile Designer: ${SOURCE_NOTES[target.source]}`]
  let weakened = target.source !== 'saved' && target.source !== 'researched'
  let state = target.missile === null ? 'candidate' : STANDING.HELD

  if (target.missile !== null) {
    const changes = [!close(standing.size, target.msp) ? `its size is ${isNumber(standing.size) ? `${standing.size} MSP` : 'not stored'}, not the ${target.msp} MSP of the link` : '', !close(standing.range, target.range) ? `its range is ${isNumber(standing.range) ? `${standing.range} km` : 'not stored'}, not the ${target.range} km of the link` : '', target.name && standing.name !== target.name ? `it is named ${cutText(standing.name)}, not ${cutText(target.name)}` : ''].filter(Boolean)

    if (changes.length) {
      state = STANDING.CHANGED
      weakened = true
      notes.push(`The saved missile ${target.missile} changed since the link was made: ${changes.join('; ')}. The figures of the link are used as given.`)
      assumptions.push(`the saved missile ${target.missile} no longer stores the carried figures: ${changes.join('; ')}`)
    }
  }

  if (isNumber(target.signature)) {
    assumptions.push(`the missile was evaluated against a target signature of ${target.signature} HS, typed in the Missile Designer scenario`)
  }

  if (target.missile === null && target.source === 'researched' && !levels.length) {
    weakened = true
    notes.push('The link names no tech level for a candidate said to be built on researched tech, so that is not verified and the figures are used as assumed.')
    assumptions.push('the candidate is said to use researched tech but the link names no tech level to check it against')
  }

  levels.forEach((level) => {
    if (level.assumption) {
      assumptions.push(level.assumption)
    } else if (level.state === 'unusable') {
      weakened = true
      notes.push(`A tech level the missile is built on cannot be used: ${level.text}`)
      assumptions.push(`a tech level of the design cannot be checked: ${level.text}`)
    } else if (level.state === 'now-researched') {
      notes.push(`A tech level the missile is built on was hypothetical: ${level.text}`)
    }
  })

  const status = weakened || levels.some((level) => level.hypothetical) ? STATUS.ASSUMED : getRule(SENSOR_RULES.detection).verification

  return { ...base, applies: true, state, notes, origin: { name: cutText(target.name || (target.missile === null ? 'Candidate' : `Saved missile ${target.missile}`)), status, present: ['the missile size handed over by the Missile Designer'], assumptions } }
}

// The words for the state of a missile target that is not applied: the problems of an unreadable one, else the reason the save gave.
export const targetProblemText = ({ problems = [], resolution = null }) => {
  if (problems.length) {
    return `The missile target of the link is not applied: ${problems.slice(0, SHOWN_PROBLEMS).join('; ')}${problems.length > SHOWN_PROBLEMS ? `; and ${problems.length - SHOWN_PROBLEMS} more` : ''}.`
  }

  return resolution && resolution.problems.length ? resolution.problems[0] : ''
}
