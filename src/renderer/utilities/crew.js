// How short a ship's crew is and what that costs: the one crew share every figure that scales with the crew aboard takes, and the activities a deficit slows. Handling (utilities/transport.js), harvesters (logistics.js), survey (survey.js), orbital mining (minerals.js) and the crew warning (warnings/ships.js) all read the share from `crewFraction`, so the same ship gives the same number everywhere. Evidence: docs/plans/backlog/evidence/AE-103-01.md.

import { roundToDecimal } from './math'
import { ofRule, registerRule, ruleSupports, unavailable } from './provenance'

const CREW_VERSIONS = ['2.7.x']
const UNVERIFIED_SAVE = 'The save is not 2.7-shaped and has no version label, so the rule is not checked for its game version.'

// The share of its class crew a ship has aboard, as the game scales a ship's modules and its cargo handling: Current Crew / Class Crew, 1 once the class crew is aboard (an over-crewed ship is no faster) and 1 for a class without crew (the game never scales it, so there is no division by zero). A ship with no crew aboard has 0, and a missing crew or class crew gives null, never 1. `ship`: { CurrentCrew, ClassCrew }.
export const crewFraction = (ship) => {
  if (!Number.isFinite(ship.ClassCrew)) {
    return null
  } else if (!(ship.ClassCrew > 0)) {
    return 1
  } else if (!Number.isFinite(ship.CurrentCrew)) {
    return null
  }

  return Math.min(1, Math.max(0, ship.CurrentCrew) / ship.ClassCrew)
}

// The same share as an SQL expression over a ship table and its class table: null while the crew or the class crew is not in the save, like `crewFraction` (SQLite's two-argument `max` is null when either argument is).
export const crewFractionSql = (ship = 'FCT_Ship', shipClass = 'FCT_ShipClass') => `(case when ${shipClass}.Crew is null then null when ${shipClass}.Crew > 0 then min(1.0, max(0, ${ship}.CurrentCrew) * 1.0 / ${shipClass}.Crew) else 1.0 end)`

const BASE_STRUCTURE = ['FCT_Ship.CurrentCrew', 'FCT_ShipClass.Crew']
const MODULE_STRUCTURE = [...BASE_STRUCTURE, 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentTypeID', 'FCT_DamagedComponent']
const STANDING = 'Estimated: read from the game\'s rules for 2.6 and 2.7; no saved game shows a short-crewed ship doing this, so it is checked against nothing stored.'

// The activities a crew deficit slows. `types`: the module types (DIM_ComponentType) whose undamaged modules the share scales, `time` that the game lengthens the time instead of cutting a rate (the speed is the same share), `twice` that the share counts twice, `zero` what a ship with no crew aboard does where the game's rule divides by the crew.
const ACTIVITIES = [
  { key: 'handling', label: 'Cargo handling', time: true, zero: 'blocked', structure: [...BASE_STRUCTURE, 'FCT_ShipClass.CargoCapacity, ColonistCapacity, TroopCapacity'], note: 'A ship short of crew takes Class Crew / Current Crew times as long to load or unload cargo, colonists and troops, so it works at the share of its crew aboard; an over-crewed ship is no faster. The game divides by the crew, so a ship with no crew aboard has no defined time and loads nothing here (inferred, not checked against saved data). Logistics bonuses and the shuttle strength are separate terms.' },
  { key: 'survey', label: 'Survey', types: [6, 7], twice: true, structure: [...MODULE_STRUCTURE, 'FCT_Ship.CrewMorale'], note: 'A short-crewed ship\'s survey sensors run at the share of its crew aboard, and the game applies the share again to the fleet\'s running total, so a lone ship surveys at the share squared and in a fleet of several the order of the ships changes the result (survey.js). Crew morale is a separate factor.' },
  { key: 'harvesting', label: 'Harvesting', types: [32], structure: MODULE_STRUCTURE, note: 'A short-crewed ship\'s Sorium harvester modules work at the share of its crew aboard, on top of the racial rate, the commander and admin Mining bonuses and the deposit\'s accessibility (logistics.js).' },
  { key: 'mining', label: 'Orbital mining', types: [38], structure: MODULE_STRUCTURE, note: 'A short-crewed ship\'s orbital mining modules work at the share of its crew aboard, on top of the racial mine production, the Mining bonuses and the deposit\'s accessibility (minerals.js).' },
  { key: 'maintenance', label: 'Maintenance', types: [48], structure: MODULE_STRUCTURE, note: 'A short-crewed ship\'s maintenance modules give the share of their capacity that its crew aboard bears to the class crew.' },
  { key: 'salvage', label: 'Salvage', types: [39], structure: MODULE_STRUCTURE, note: 'A short-crewed ship\'s salvage modules work at the share of its crew aboard, on top of the commander\'s Production bonus.' },
  { key: 'terraforming', label: 'Terraforming', types: [33], structure: MODULE_STRUCTURE, note: 'A short-crewed ship\'s terraforming modules work at the share of its crew aboard, on top of the racial rate and the commander\'s and admin Terraforming bonuses.' },
  { key: 'stabilisation', label: 'Stabilisation', types: [29], time: true, zero: 'unsupported', structure: MODULE_STRUCTURE, note: 'A short-crewed ship takes Class Crew / Current Crew times as long to stabilise a jump point or a Lagrange point or to build a jump gate, so it works at the share of its crew aboard; the quickest ship of a fleet counts. With no crew aboard the game divides by zero and the time is not defined here.' },
]

registerRule({
  id: 'crew.fraction',
  versions: CREW_VERSIONS,
  units: '×',
  verification: 'estimated',
  structure: BASE_STRUCTURE,
  note: 'The share of its class crew a ship has aboard: Current Crew / Class Crew, at most 1, and 1 for a class without crew. Every module and handling rule below scales by it; morale and crew grade are separate factors. A crew that is not in the save gives no share.',
  assumptions: [STANDING],
})

ACTIVITIES.forEach(({ key, structure, note }) => registerRule({ id: `crew.${key}`, versions: CREW_VERSIONS, units: '×', verification: 'estimated', structure, note, assumptions: [STANDING] }))

// What the module types of an activity add up to on a ship: { designed, working } from `modules` ({ [typeId]: { designed, working } } for the class's component lines), null where the class's lines are not in the save.
const moduleCount = (modules, types) => types.reduce((total, type) => ({ designed: total.designed + (modules[type] ? modules[type].designed : 0), working: total.working + (modules[type] ? modules[type].working : 0) }), { designed: 0, working: 0 })

const percent = (share) => (share > 0 && share < 0.0005 ? 'under 0.1%' : `${roundToDecimal(share * 100, 1)}%`)

const inputsOf = (activity) => ({ present: ['the ship\'s crew and its class crew', activity.types ? 'the class\'s modules and the ship\'s damage' : 'the class\'s holds'] })

// What one activity costs a ship at crew share `fraction` (not null), as { key, label, state, factor, idle, result, text }: `factor` the share of its normal output or speed the ship keeps (0 to 1; null where the game defines none), `state` 'full' (no deficit), 'reduced', 'stopped' (a module rate scaled to 0), 'blocked' (no crew aboard, so no cargo handling) or 'unsupported' (the game's rule has no value with no crew aboard), `idle` that every module is damaged already so the deficit costs nothing now, `result` the provenance result of 'crew.<key>' (unavailable for 'unsupported') and `text` a short phrase.
const effectOf = (activity, fraction, idle, version) => {
  const rule = `crew.${activity.key}`
  const assumptions = ruleSupports(rule, version) === true ? [] : [UNVERIFIED_SAVE]
  const base = { key: activity.key, label: activity.label, idle }
  const suffix = idle ? ' (every module damaged)' : ''

  if (fraction > 0 || !activity.zero) {
    const factor = activity.twice ? fraction * fraction : fraction
    const state = fraction >= 1 ? 'full' : factor > 0 ? 'reduced' : 'stopped'
    const detail = activity.twice && fraction < 1 ? ', the share counted twice' : activity.time && fraction < 1 ? `, ${roundToDecimal(1 / fraction, 2)}× the time` : ''

    return { ...base, state, factor, result: ofRule({ rule, value: factor, inputs: inputsOf(activity), assumptions }), text: `${activity.label} ${percent(factor)}${detail}${suffix}` }
  }

  if (activity.zero === 'blocked') {
    return { ...base, state: 'blocked', factor: 0, result: ofRule({ rule, value: 0, inputs: inputsOf(activity), assumptions }), text: `${activity.label} blocked, no crew aboard${suffix}` }
  }

  return { ...base, state: 'unsupported', factor: null, result: unavailable({ rule, missing: ['the game\'s time with no crew aboard (its rule divides by the crew)'], present: inputsOf(activity).present }), text: `${activity.label} not modelled, no crew aboard${suffix}` }
}

// The activities a crew deficit slows on one ship, each as `effectOf` gives it, for the activities the ship has: a hold (`holds`, true, false or null when the class's capacities are not in the save) or modules of the types in `modules`. `modules` is { [typeId]: { designed, working } } for the class's component lines of each type, or null when the class's lines are not in the save: the modules are then unknown, not absent, and one 'unknown' entry says so. A crew that is not in the save gives that one entry alone. A ship at its full crew has entries at state 'full'. `version`: the formula version of the save (`loadFormulaVersion`).
export const crewEffects = (ship, { modules, holds, version = null }) => {
  const fraction = crewFraction(ship)

  if (fraction === null) {
    return [{ key: 'crew', label: 'Crew', state: 'unknown', factor: null, idle: false, result: unavailable({ rule: 'crew.fraction', missing: ['the ship\'s crew or its class crew'] }), text: 'Crew unknown' }]
  }

  const effects = []

  if (holds === null) {
    effects.push({ key: 'handling', label: 'Cargo handling', state: 'unknown', factor: null, idle: false, result: unavailable({ rule: 'crew.handling', missing: ['the class\'s cargo, colonist and troop capacity'] }), text: 'Cargo handling unknown' })
  } else if (holds) {
    effects.push(effectOf(ACTIVITIES[0], fraction, false, version))
  }

  if (modules === null) {
    effects.push({ key: 'modules', label: 'Modules', state: 'unknown', factor: null, idle: false, result: unavailable({ rule: 'crew.fraction', missing: ['the class\'s module lines'] }), text: 'Modules unknown' })

    return effects
  }

  ACTIVITIES.filter((activity) => activity.types).forEach((activity) => {
    const { designed, working } = moduleCount(modules, activity.types)

    if (designed > 0) {
      effects.push(effectOf(activity, fraction, working <= 0, version))
    }
  })

  return effects
}

// The module types `crewEffects` reads, for the query that gives each ship's `modules`.
export const CREW_MODULE_TYPES = ACTIVITIES.flatMap((activity) => activity.types || [])
