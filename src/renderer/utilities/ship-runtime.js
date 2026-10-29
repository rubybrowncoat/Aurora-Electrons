// The state of the race's actual ships that maintenance and deployment planning reads, in one shared record per ship: the save's revision and game time, the overhaul and shore-leave clocks, maintenance supplies and fuel, crew, morale and grade as the save stores them, the rates AE-106-01 works out from them (design-rules.js) and the support case the ship is in (normal, overhaul, carried in a hangar or under tow). Class Planner's ships of a class and Deployment take the same records from the same read, so the same inputs give the same values in both. The rules and what the saves hold: docs/plans/backlog/evidence/AE-105-04.md.
//
// Three kinds of figure stay apart, each in its own provenance envelope: what the save stores (rule `shipRuntime.observed`, confirmed), what is calculated from it (the `shipRuntime.*` rules and `design.incrementFailureChance`, estimated: none has a saved witness beyond the overhaul date, see the evidence) and the class's own planning estimate of its maintenance life (`design.maintenanceLifeSeries`, kept on the class and assuming a fresh clock, full cover and the class's supplies, never a ship's). A condition the save does not state or the rules do not settle is unavailable and names why, never a number.

import { averageRepairCost, incrementFailureChance, maintenanceLifeSeries, roundHalfEven } from './design-rules'
import { crewFraction } from './crew'
import { loadFleetShips } from './fleet-profile'
import { loadFormulaVersion } from './capabilities'
import { columnsOf } from './mine-bootstrap-data'
import { combine, ofRule, registerRule, ruleSupports, unavailable } from './provenance'
import { SECONDS_PER_YEAR } from './transport'

const SECONDS_PER_MONTH = 2592000
const UNSUPPORTED_VERSION = 'the game version the save was played under, which the hangar and shore-leave rates are read for'
const RUNTIME_VERSIONS = ['2.7.x']
// DIM_MaintenanceState: operational and under maintenance (an overhaul).
const OPERATIONAL = 0
const UNDER_MAINTENANCE = 2
// The factor a military hangar speeds a carried ship's overhaul clock by: the clock moves five times as fast as time, so the age falls four times as fast as time passes.
const HANGAR_CLOCK_MULTIPLIER = 5
// The factor shore leave moves the deployment clock by at a full crew, the rate scaling with the crew share.
const SHORE_LEAVE_MULTIPLIER = 10

const OBSERVED = 'shipRuntime.observed'
const AGE = 'shipRuntime.maintenanceAge'
const AGE_RATE = 'shipRuntime.maintenanceAgeRate'
const YARD_AGE_RATE = 'shipRuntime.yardAgeRate'
const FAILURE_RATE = 'shipRuntime.failureRate'
const FAILURE_NOW = 'shipRuntime.failureChanceNow'
const SUPPLY_DRAW = 'shipRuntime.supplyDraw'
const CREW_PERFORMANCE = 'shipRuntime.crewPerformance'
const DEPLOYMENT_AGE = 'shipRuntime.deploymentAge'
const DEPLOYMENT_MARGIN = 'shipRuntime.deploymentMargin'
const RECOVERY = 'shipRuntime.shoreLeaveRecovery'
const RECOVERY_ETA = 'shipRuntime.shoreLeaveEta'

registerRule({
  id: OBSERVED,
  versions: RUNTIME_VERSIONS,
  verification: 'confirmed',
  structure: ['FCT_Game.GameTime', 'FCT_Ship.LastOverhaul, LastShoreLeave, CurrentMaintSupplies, Fuel, CurrentCrew, CrewMorale, GradePoints, OverhaulFactor', 'FCT_ShipClass.PlannedDeployment, MaintSupplies, BaseFailureChance, Crew'],
  note: 'A clock, stock or crew figure as the save stores it: the ship\'s state at the save\'s game time, not a forecast and not recomputed.',
})

registerRule({
  id: AGE,
  versions: RUNTIME_VERSIONS,
  units: 'years',
  verification: 'estimated',
  structure: ['FCT_Game.GameTime', 'FCT_Ship.LastOverhaul'],
  note: 'The maintenance age of a ship: the game time less the time of its last overhaul, in years of 365 days. Reproduced for one thing only: in 149 intervals of a passive campaign the overhaul date of every military ship moved by exactly the game time that passed.',
  assumptions: ['the saved overhaul time is the ship\'s clock now, so the age is the one the game would use in its next maintenance pass'],
})

registerRule({
  id: AGE_RATE,
  versions: RUNTIME_VERSIONS,
  units: 'years a year',
  verification: 'estimated',
  structure: ['FCT_Ship.LastOverhaul, MaintenanceState, MothershipID', 'FCT_ShipClass.Commercial, SupplyShip, CommercialHangar', 'FCT_Race.NPR', 'FCT_Game.NoOverhauls'],
  note: 'How the ship\'s maintenance age changes with time, where the clock rule settles it: a ship whose class is commercial (or whose race is not played) has the clock set to now, so its age is held at 0; a ship that is not commercial and sits in a military hangar has the clock moved five times as fast as time, so its age falls four years a year until it is 0. The factor 5 is read from the rules and is not measured by any saved pair (every one is clamped to now). A ship the hangar does not hold has an age that depends on the maintenance support at its location, which is not read.',
})

registerRule({
  id: YARD_AGE_RATE,
  versions: RUNTIME_VERSIONS,
  units: 'years a year',
  verification: 'estimated',
  structure: ['FCT_ShipyardTask.GameID, ShipID, Paused', 'FCT_Ship.LastOverhaul'],
  note: 'How the maintenance age of a ship in a shipyard task that is not paused changes with time: the game moves the ship\'s overhaul date forward by the time that passes, so the age stays at its saved value and the rate is 0. Read from the rules; no saved pair shows a ship in a task.',
  assumptions: ['the task stays unpaused and the ship in it'],
})

registerRule({
  id: FAILURE_RATE,
  versions: RUNTIME_VERSIONS,
  units: '% a year',
  verification: 'estimated',
  structure: ['FCT_ShipClass.BaseFailureChance', 'FCT_DamagedComponent', 'FCT_ShipDesignComponents.ComponentTypeID'],
  note: 'The ship\'s annual failure rate at a maintenance clock of one year: the class\'s stored rate (the annual failure rate rule reproduces it) while none of the ship\'s engineering is damaged. Damaged engineering raises the ship\'s own rate above the class\'s, so the figure is withheld for such a ship.',
})

registerRule({
  id: FAILURE_NOW,
  versions: RUNTIME_VERSIONS,
  units: '% a year',
  verification: 'estimated',
  structure: ['shipRuntime.failureRate', 'shipRuntime.maintenanceAge'],
  note: 'The ship\'s annual failure rate at its present clock: its annual rate times its maintenance age in years. It is the base of the chance of a failure in one increment (the increment failure chance rule), before the share of the ship left uncovered, its crew and its officers.',
})

registerRule({
  id: SUPPLY_DRAW,
  versions: RUNTIME_VERSIONS,
  units: 'MSP a year',
  verification: 'estimated',
  structure: ['design.averageRepairCost', 'shipRuntime.failureChanceNow'],
  note: 'The maintenance supplies the ship\'s failures draw in a year at its present clock: the class\'s average repair cost times the failure rate at that clock over 100, the arithmetic of the class\'s life series taken at the ship\'s own age.',
  assumptions: ['the damage of a failure is spread over the class\'s components as its damage allocation table spreads it', 'the clock keeps its present age for the year'],
})

registerRule({
  id: CREW_PERFORMANCE,
  versions: RUNTIME_VERSIONS,
  units: '×',
  verification: 'estimated',
  structure: ['FCT_Ship.GradePoints, CrewMorale, OverhaulFactor'],
  note: 'The ship\'s crew performance modifier: one plus the grade bonus (the square root of the grade points less 10, rounded to a whole percent) over 100, times its morale and its overhaul factor. It is read from the rules; no saved game states it.',
})

registerRule({
  id: DEPLOYMENT_AGE,
  versions: RUNTIME_VERSIONS,
  units: 'months',
  verification: 'estimated',
  structure: ['FCT_Game.GameTime', 'FCT_Ship.LastShoreLeave'],
  note: 'The deployment age of a ship: the game time less the time of its last shore leave, in months of 30 days. It is not reproduced against a saved pair: every ship the saves show recovering is clamped to now.',
  assumptions: ['the saved shore-leave time is the ship\'s clock now'],
})

registerRule({
  id: DEPLOYMENT_MARGIN,
  versions: RUNTIME_VERSIONS,
  units: 'months',
  verification: 'estimated',
  structure: ['shipRuntime.deploymentAge', 'FCT_ShipClass.PlannedDeployment'],
  note: 'The months of deployment a ship has left before the class\'s planned deployment: the plan less the deployment age. Below 0 the ship is overdue and its morale falls with the overrun.',
})

registerRule({
  id: RECOVERY,
  versions: RUNTIME_VERSIONS,
  units: 'months a month',
  verification: 'estimated',
  structure: ['FCT_Ship.CurrentCrew, MothershipID', 'FCT_ShipClass.Crew, PlannedDeployment, MoraleCheckRequired', 'FCT_Race.NPR'],
  note: 'The recovery of a ship\'s deployment age with time while it is at a shore-leave location (a fleet with an undamaged recreational module, or a population of the race of 0.05 or more, at the same place, not under a training command): the shore-leave time moves forward by g = 10 times the crew share (at most 10) a second, plus 1 for a ship docked in a hangar, while the game time moves 1, so the age changes by 1 less g and recovers by g less 1. At a full crew that is 9 months a month for an independent ship, none at a tenth of the crew and growth below it; a docked ship recovers 1 month a month faster, so one at a twentieth of the crew still recovers at 0.5. The location is checked before a hangar, so a docked ship at one recovers at this rate and elsewhere by its carrier\'s ratio. The factor 10 and the hangar share are read from the rules and are not measured by any saved pair.',
  assumptions: ['the ship is at a shore-leave location, which is not read here'],
})

registerRule({
  id: RECOVERY_ETA,
  versions: RUNTIME_VERSIONS,
  units: 'months',
  verification: 'estimated',
  structure: ['shipRuntime.deploymentAge', 'shipRuntime.shoreLeaveRecovery'],
  note: 'The months a ship at a shore-leave location needs to bring its deployment age to 0 under unchanged conditions: the age over the recovery. It exists only where the recovery is above 0.',
  assumptions: ['the crew, the location and the hangar do not change'],
})

const known = (value) => Number.isFinite(value)

const flag = (value) => (value === 1 || value === true ? true : value === 0 || value === false ? false : null)

// A stored figure as the save has it, or unavailable naming the column it lacks.
const observed = (name, value, units) => (known(value) ? ofRule({ rule: OBSERVED, value, inputs: { present: [name] }, units }) : unavailable({ rule: OBSERVED, missing: [name], units }))

const seen = new WeakSet()

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }

  return value
}

const lacks = (rule, missing, units) => unavailable({ rule, missing: Array.isArray(missing) ? missing : [missing], units })

// ---- The class's planning estimate -------------------------------------------------------------------------------------

// What the class gives every ship of it, shared by them: its stored supplies, failure rate and planned deployment, and the class's own planning estimate of its maintenance life (a fresh clock, full cover and the class's supplies: `life`, the series of design.maintenanceLifeSeries) with the average repair cost it rests on. `components` is the class's damage allocation rows as { chanceToHit, cost }, null when the class is not read for the race.
const classOf = (row, components) => {
  const commercial = flag(row.Commercial)
  const repairCost = components === null ? lacks('design.averageRepairCost', 'the class\'s own components (the class is not one of the race\'s)', 'MSP') : averageRepairCost({ components, maxDacRoll: row.MaxDACRoll })
  const life = commercial === null ? lacks('design.maintenanceLifeSeries', 'class type (military or commercial)') : maintenanceLifeSeries({ commercial, baseFailureChance: row.BaseFailureChance, averageRepairCost: repairCost.value, maintSupplies: row.MaintSupplies })

  return { ShipClassID: row.ShipClassID, ClassName: row.ClassName, commercial, moraleCheck: flag(row.MoraleCheckRequired), supplyShip: flag(row.SupplyShip), plannedMonths: observed('the class\'s planned deployment', row.PlannedDeployment, 'months'), maintSupplies: observed('the class\'s maintenance supplies', row.MaintSupplies, 'MSP'), failureRate: observed('the class\'s annual failure rate', row.BaseFailureChance, '% a year'), repairCost, life }
}

// ---- The support case ----------------------------------------------------------------------------------------------------

const CASE_TEXT = { normal: 'Outside a hangar, not under tow and not overhauling', overhaul: 'Under overhaul', hangared: 'Carried in a hangar', towed: 'Under tow', unknown: 'Support not known' }

// How a ship's maintenance clock runs, in the order the game takes its cases: a ship in a shipyard task that is not paused is out of maintenance and failure testing ('yard'), a race that is not played or a commercial class has its clock set to now ('reset'), a supply ship follows the maintenance cluster it is assigned to ('supply'), a ship that is not commercial in a military hangar has its clock advanced by the hangar ('advanced'), and any other ship's age follows the maintenance support at its location ('support'). A carried ship's cases are given for a 2.7 save only. A setting the game has for overhauls being off, an input the save lacks or a version the hangar rules are not read for leaves it 'unknown'. Returns { mode, reason } with a reason for every mode but 'support' and 'advanced'.
const clockModeOf = (ship, hangared, yardTask, context) => {
  const commercial = flag(ship.Commercial)
  const supply = flag(ship.SupplyShip)
  const carrierCommercial = flag(ship.CarrierCommercialHangar)

  if (context.noOverhauls === null || context.npr === null) {
    return { mode: 'unknown', reason: context.noOverhauls === null ? 'whether overhauls are switched off in this game is not in the save' : 'whether the race is played is not in the save' }
  } else if (context.noOverhauls === true) {
    return { mode: 'unknown', reason: 'the game has overhauls switched off, which the maintenance rules do not state for ships' }
  } else if (yardTask === null) {
    return { mode: 'unknown', reason: 'whether the ship is in a shipyard task that is not paused is not in the save, and the game takes such a ship out of maintenance before any other case' }
  } else if (yardTask === 'active') {
    return { mode: 'yard', reason: 'a ship in a shipyard task that is not paused is out of maintenance and failure testing: its overhaul date moves with the time that passes' }
  } else if (context.npr === true) {
    return { mode: 'reset', reason: 'a race that is not played has its ships\' clocks set to now' }
  } else if (supply === null) {
    return { mode: 'unknown', reason: 'whether the class is a supply ship is not in the save' }
  } else if (supply) {
    return { mode: 'supply', reason: 'a supply ship\'s clock follows the maintenance cluster it is assigned to, which is not read' }
  } else if (commercial === null) {
    return { mode: 'unknown', reason: 'whether the class is commercial is not in the save' }
  } else if (commercial) {
    return { mode: 'reset', reason: 'a commercial class has its clock set to now' }
  } else if (hangared && carrierCommercial === null) {
    return { mode: 'unknown', reason: 'whether the carrier has a commercial hangar is not in the save' }
  } else if (hangared && ruleSupports(AGE_RATE, context.version) !== true) {
    return { mode: 'unknown', reason: UNSUPPORTED_VERSION }
  } else if (hangared && !carrierCommercial) {
    return { mode: 'advanced', reason: `a military hangar moves the clock of a carried ship ${HANGAR_CLOCK_MULTIPLIER} times as fast as time` }
  }

  return { mode: 'support', reason: '' }
}

// A link id as the save has it (0 for none), null when the save does not have the column or the row has no number.
const idOf = (value) => (known(value) ? value : null)

// The ship's support case: 'hangared' (MothershipID), 'towed' (TractorParentShipID), 'overhaul' (MaintenanceState 2), 'normal' (state 0) or 'unknown' when a link, the state or its value is not in the save or not one the rules settle. The links are kept with it: `mothershipId` and `tractorParentShipId` (0 for none, null when unread), `tractorTargetShipId` (the ship this one tows), and for a carried ship `carrierCommercialHangar` (true or false, null when the carrier's class does not say) and `carrierFleetId`, so a carrier panel groups carried ships under their carrier with no second read. `conditions` are what is true of the ship without changing its case: { code, text }.
const supportOf = (ship, context) => {
  const hangared = known(ship.MothershipID) ? ship.MothershipID > 0 : null
  const towed = known(ship.TractorParentShipID) ? ship.TractorParentShipID > 0 : null
  const conditions = []
  const task = context.yardTasks ? context.yardTasks.get(ship.ShipID) || 'none' : null
  const yardTask = task === 'unknown' ? null : task
  let supportCase
  let reason = ''

  if (hangared === null || towed === null) {
    supportCase = 'unknown'
    reason = 'whether the ship is in a hangar or under tow is not in the save'
  } else if (hangared && towed) {
    supportCase = 'unknown'
    reason = 'the ship is both in a hangar and under tow, which the rules do not settle'
  } else if (hangared) {
    supportCase = 'hangared'
  } else if (towed) {
    supportCase = 'towed'
  } else if (!known(ship.MaintenanceState)) {
    supportCase = 'unknown'
    reason = 'the ship\'s maintenance state is not in the save'
  } else if (ship.MaintenanceState === UNDER_MAINTENANCE) {
    supportCase = 'overhaul'
  } else if (ship.MaintenanceState === OPERATIONAL) {
    supportCase = 'normal'
  } else {
    supportCase = 'unknown'
    reason = `maintenance state ${ship.MaintenanceState} is not one the rules settle`
  }

  if (hangared && known(ship.MaintenanceState) && ship.MaintenanceState !== OPERATIONAL) {
    conditions.push({ code: 'state-in-hangar', text: `the ship has maintenance state ${ship.MaintenanceState} set while carried` })
  }

  if (hangared) {
    conditions.push({ code: 'docked-clocks', text: 'a carried ship\'s clocks are shown as the save has them: the hangar moves them forward and holds them at now, and does not clear an age the ship already has' })
    conditions.push({ code: 'docked-location', text: 'a carried ship at a shore-leave location recovers at the location rate, elsewhere by its carrier\'s deployment ratio; where it is, and the carrier\'s deployment, are not read here' })
  }

  if (towed) {
    conditions.push({ code: 'tow-maintenance', text: 'how a ship under tow is maintained is not checked' })
  }

  return { case: supportCase, text: CASE_TEXT[supportCase], reason, hangared, towed, mothershipId: idOf(ship.MothershipID), carrierCommercialHangar: hangared === true ? flag(ship.CarrierCommercialHangar) : null, carrierFleetId: hangared === true ? idOf(ship.CarrierFleetID) : null, tractorParentShipId: idOf(ship.TractorParentShipID), tractorTargetShipId: idOf(ship.TractorTargetShipID), yardTask, clock: supportCase === 'towed' ? { mode: 'unknown', reason: 'how a ship under tow is maintained is not checked' } : clockModeOf(ship, hangared === true, yardTask, context), conditions }
}

// ---- The ship's figures --------------------------------------------------------------------------------------------------

const timeOf = (value, context) => (known(value) && context.gameTime !== null ? context.gameTime - value : null)

const maintenanceOf = (ship, support, crew, context, scenario) => {
  const lastOverhaul = observed('LastOverhaul', ship.LastOverhaul, 's')
  const ageSeconds = timeOf(ship.LastOverhaul, context)
  const age = ageSeconds === null ? lacks(AGE, [context.gameTime === null ? 'the game time' : null, known(ship.LastOverhaul) ? null : 'the ship\'s last overhaul time'].filter(Boolean), 'years') : ofRule({ rule: AGE, value: ageSeconds / SECONDS_PER_YEAR, inputs: { present: ['the game time', 'LastOverhaul'] } })
  const { clock } = support
  const ageRate = support.case === 'towed' || support.case === 'unknown' ? lacks(AGE_RATE, support.case === 'towed' ? clock.reason : support.reason) : clock.mode === 'yard' ? ofRule({ rule: YARD_AGE_RATE, value: 0, inputs: { present: ['the ship\'s shipyard task', 'LastOverhaul'] } }) : clock.mode === 'advanced' ? ofRule({ rule: AGE_RATE, value: 1 - HANGAR_CLOCK_MULTIPLIER, inputs: { present: ['the carrier\'s hangar type', 'the class'] }, assumptions: ['the age stops falling at 0 (the clock is held at now)'] }) : clock.mode === 'reset' ? ofRule({ rule: AGE_RATE, value: 0, inputs: { present: ['the class', 'the race'] }, assumptions: [clock.reason] }) : lacks(AGE_RATE, clock.mode === 'support' ? 'the maintenance support at the ship\'s location: the share of its maintenance that is met (not read)' : clock.reason)

  const damaged = ship.DamagedEngineering
  const classRate = ship.BaseFailureChance
  const failureRate = !known(classRate) ? lacks(FAILURE_RATE, 'the class\'s annual failure rate') : !known(damaged) ? lacks(FAILURE_RATE, 'the ship\'s damaged engineering') : damaged > 0 ? lacks(FAILURE_RATE, 'undamaged engineering: the ship has engineering damaged, which raises its own failure rate above the class\'s') : ofRule({ rule: FAILURE_RATE, value: classRate, inputs: { present: ['the class\'s annual failure rate', 'the ship\'s engineering damage'] } })
  const failureNow = failureRate.value === null || age.value === null ? lacks(FAILURE_NOW, [failureRate.value === null ? 'the annual failure rate' : null, age.value === null ? 'the maintenance age' : null].filter(Boolean)) : ofRule({ rule: FAILURE_NOW, value: failureRate.value * age.value, inputs: { present: ['the annual failure rate', 'the maintenance age'] } })
  const repairCost = ship.class.repairCost
  const supplyDraw = failureNow.value === null || repairCost.value === null ? lacks(SUPPLY_DRAW, [failureNow.value === null ? 'the failure rate at the ship\'s clock' : null, repairCost.value === null ? 'the class\'s average repair cost' : null].filter(Boolean)) : ofRule({ rule: SUPPLY_DRAW, value: repairCost.value * failureNow.value / 100, inputs: { present: ['the average repair cost', 'the failure rate at the ship\'s clock'] } })
  const tested = support.case === 'normal' || support.case === 'overhaul' || support.case === 'hangared'
  const incrementChance = !tested ? lacks('design.incrementFailureChance', support.case === 'unknown' ? support.reason : clock.reason) : clock.mode !== 'support' ? lacks('design.incrementFailureChance', clock.mode === 'advanced' ? 'a ship carried in a military hangar: the hangar moves its clock and the maintenance pass does not test it for failure' : clock.reason) : incrementFailureChance({ baseFailureChance: failureRate.value, clockYears: age.value, elapsedYears: scenario.elapsedYears, uncoveredFraction: scenario.uncoveredFraction, crewPerformance: crew.performance.value, engineeringBonus: scenario.engineeringBonus, training: scenario.training })

  return { lastOverhaul, age, ageRate, clockMode: clock.mode, clockReason: clock.reason, failureRate, failureNow, supplyDraw, incrementChance }
}

const crewOf = (ship) => {
  const fraction = crewFraction({ CurrentCrew: ship.CurrentCrew, ClassCrew: ship.ClassCrew })
  const grade = ship.GradePoints
  const performance = !known(grade) || grade < 0 || !known(ship.CrewMorale) || !known(ship.OverhaulFactor) ? lacks(CREW_PERFORMANCE, [known(grade) && grade >= 0 ? null : 'the ship\'s grade points', known(ship.CrewMorale) ? null : 'the ship\'s morale', known(ship.OverhaulFactor) ? null : 'the ship\'s overhaul factor'].filter(Boolean)) : ofRule({ rule: CREW_PERFORMANCE, value: (1 + roundHalfEven(Math.sqrt(grade) - 10) / 100) * ship.CrewMorale * ship.OverhaulFactor, inputs: { present: ['GradePoints', 'CrewMorale', 'OverhaulFactor'] } })

  return {
    current: observed('CurrentCrew', ship.CurrentCrew, 'crew'),
    required: observed('the class\'s crew', ship.ClassCrew, 'crew'),
    fraction: fraction === null ? lacks('shipRuntime.observed', 'the ship\'s crew or the class\'s crew', '×') : ofRule({ rule: OBSERVED, value: fraction, inputs: { present: ['CurrentCrew', 'the class\'s crew'] }, units: '×' }),
    morale: observed('CrewMorale', ship.CrewMorale, '×'),
    grade: observed('GradePoints', ship.GradePoints, 'points'),
    overhaulFactor: observed('OverhaulFactor', ship.OverhaulFactor, '×'),
    performance,
  }
}

// How the ship's deployment clock runs: 'reset' (the race is not played: the clock is set to now), 'exempt' (the class has no deployment check, or a plan of 0, so the clock is set to now), 'checked' (shore leave and the hangar move it, and the ship's morale falls once the age passes the plan) or 'unknown'.
const deploymentModeOf = (ship, context) => {
  const check = flag(ship.MoraleCheckRequired)

  if (context.npr === null) {
    return { mode: 'unknown', reason: 'whether the race is played is not in the save' }
  } else if (context.npr) {
    return { mode: 'reset', reason: 'a race that is not played has its ships\' clocks set to now' }
  } else if (check === null || !known(ship.PlannedDeployment)) {
    return { mode: 'unknown', reason: check === null ? 'whether the class has a deployment check is not in the save' : 'the class\'s planned deployment is not in the save' }
  } else if (!check || ship.PlannedDeployment === 0) {
    return { mode: 'exempt', reason: check ? 'the class has no planned deployment, so no ship of it is checked' : 'the class has no deployment check, so its clock is set to now' }
  }

  return { mode: 'checked', reason: '' }
}

const deploymentOf = (ship, support, crew, context) => {
  const { mode, reason } = deploymentModeOf(ship, context)
  const ageSeconds = timeOf(ship.LastShoreLeave, context)
  const age = ageSeconds === null ? lacks(DEPLOYMENT_AGE, [context.gameTime === null ? 'the game time' : null, known(ship.LastShoreLeave) ? null : 'the ship\'s last shore leave time'].filter(Boolean), 'months') : ofRule({ rule: DEPLOYMENT_AGE, value: ageSeconds / SECONDS_PER_MONTH, inputs: { present: ['the game time', 'LastShoreLeave'] } })
  const planned = known(ship.PlannedDeployment) ? observed('the class\'s planned deployment', ship.PlannedDeployment, 'months') : lacks(OBSERVED, 'the class\'s planned deployment', 'months')
  const checked = mode === 'checked'
  const margin = !checked ? lacks(DEPLOYMENT_MARGIN, reason || 'a class with a deployment check') : age.value === null ? lacks(DEPLOYMENT_MARGIN, 'the deployment age') : ofRule({ rule: DEPLOYMENT_MARGIN, value: ship.PlannedDeployment - age.value, inputs: { present: ['the deployment age', 'the class\'s planned deployment'] } })
  const overdue = margin.value === null ? null : margin.value < 0
  const gain = crew.fraction.value === null ? null : SHORE_LEAVE_MULTIPLIER * crew.fraction.value + (support.hangared === true ? 1 : 0)
  const unsupported = ruleSupports(RECOVERY, context.version) !== true
  const recovery = !checked ? lacks(RECOVERY, reason || 'a class with a deployment check') : unsupported ? lacks(RECOVERY, UNSUPPORTED_VERSION) : support.hangared === null ? lacks(RECOVERY, 'the ship\'s hangar link: whether the ship is docked is not in the save') : gain === null ? lacks(RECOVERY, 'the ship\'s crew share') : ofRule({ rule: RECOVERY, value: gain - 1, inputs: { present: ['the crew share', 'the ship\'s hangar link', 'the class\'s deployment check'] } })
  const eta = recovery.value === null ? lacks(RECOVERY_ETA, recovery.inputs.missing.length ? recovery.inputs.missing : 'the recovery') : recovery.value <= 0 ? lacks(RECOVERY_ETA, 'a recovery above 0: the age does not fall at this crew share') : age.value === null ? lacks(RECOVERY_ETA, 'the deployment age') : combine({ rule: RECOVERY_ETA, parts: { age, recovery }, compute: (values) => Math.max(0, values.age) / values.recovery })

  return { lastShoreLeave: observed('LastShoreLeave', ship.LastShoreLeave, 's'), mode, reason, age, planned, margin, overdue, recovery, eta, carried: support.hangared === true }
}

// ---- The records ---------------------------------------------------------------------------------------------------------

// The frozen per-ship records of `rows` (the ships `loadFleetShips` gives), by ShipID, from `context`: { revision, gameTime (null when unread), npr, noOverhauls (true, false or null when the save does not say), yardTasks (a Map of ShipID to 'active', 'paused' or 'unknown' for the ships the shipyard tasks name, or null when the save does not show the tasks: a ship in an active task is out of maintenance and failure testing, and with no tasks shown no ship's clock mode is known), classes ({ [ShipClassID]: the class's damage allocation components as { chanceToHit, cost }, for the race's own classes }), scenario: { elapsedYears, uncoveredFraction, engineeringBonus, training } (what the caller assumes for the failure chance of one increment, null where it assumes nothing) }. Each record has the ship's identity, `revision`, `class`, `support`, the clocks and stocks the save stores (`clocks`, `stocks`), `crew`, `maintenance` and `deployment`. The same rows and context give the same records.
export const buildShipRuntime = (rows, context) => {
  const classes = new Map()
  const classOfRow = (row) => {
    if (!classes.has(row.ShipClassID)) {
      classes.set(row.ShipClassID, classOf(row, Object.prototype.hasOwnProperty.call(context.classes, row.ShipClassID) ? context.classes[row.ShipClassID] : null))
    }

    return classes.get(row.ShipClassID)
  }
  const scenario = { elapsedYears: null, uncoveredFraction: null, engineeringBonus: null, training: null, ...context.scenario }
  const ships = [...rows].sort((a, b) => a.ShipID - b.ShipID).map((row) => {
    const ship = { ...row, class: classOfRow(row) }
    const support = supportOf(ship, context)
    const crew = crewOf(ship)
    const maintenance = maintenanceOf(ship, support, crew, context, scenario)
    const deployment = deploymentOf(ship, support, crew, context)

    return {
      ShipID: row.ShipID,
      ShipName: row.ShipName,
      ShipClassID: row.ShipClassID,
      ClassName: row.ClassName,
      FleetID: row.FleetID,
      FleetName: row.FleetName,
      revision: context.revision,
      class: ship.class,
      support: { case: support.case, text: support.text, reason: support.reason, clock: support.clock, hangared: support.hangared, towed: support.towed, mothershipId: support.mothershipId, carrierCommercialHangar: support.carrierCommercialHangar, carrierFleetId: support.carrierFleetId, tractorParentShipId: support.tractorParentShipId, tractorTargetShipId: support.tractorTargetShipId, yardTask: support.yardTask, conditions: support.conditions },
      clocks: { gameTime: context.gameTime === null ? lacks(OBSERVED, 'the game time', 's') : ofRule({ rule: OBSERVED, value: context.gameTime, inputs: { present: ['GameTime'] }, units: 's' }), lastOverhaul: maintenance.lastOverhaul, lastShoreLeave: deployment.lastShoreLeave },
      stocks: { maintSupplies: observed('CurrentMaintSupplies', row.CurrentMaintSupplies, 'MSP'), fuel: observed('Fuel', row.Fuel, 'L') },
      crew,
      maintenance: { age: maintenance.age, ageRate: maintenance.ageRate, clockMode: maintenance.clockMode, clockReason: maintenance.clockReason, failureRate: maintenance.failureRate, failureNow: maintenance.failureNow, supplyDraw: maintenance.supplyDraw, incrementChance: maintenance.incrementChance },
      deployment: { mode: deployment.mode, reason: deployment.reason, age: deployment.age, planned: deployment.planned, margin: deployment.margin, overdue: deployment.overdue, recovery: deployment.recovery, eta: deployment.eta },
    }
  })

  return deepFreeze(ships)
}

// ---- The read ------------------------------------------------------------------------------------------------------------

// The class ids asked for: null for every class of the race, otherwise the distinct whole numbers asked for, sorted, and as `invalid` whatever is not a whole number. An empty list asks for no class at all.
const requested = (classIds) => {
  if (classIds === null || classIds === undefined) {
    return null
  } else if (!Array.isArray(classIds)) {
    throw new TypeError('classIds is null (every class of the race) or a list of class ids')
  }

  return { ids: [...new Set(classIds.filter(Number.isInteger))].sort((a, b) => a - b), invalid: classIds.filter((id) => !Number.isInteger(id)) }
}

const classComponents = async (database, { GameID, RaceID, ids }) => {
  if (ids && !ids.length) {
    return {}
  }

  const components = await columnsOf(database, 'FCT_ClassComponent')
  const hit = components.size === 0 || components.has('ChanceToHit') ? 'FCT_ClassComponent.ChanceToHit' : 'null'
  const [rows] = await database.query(`select FCT_ShipClass.ShipClassID, FCT_ClassComponent.ComponentID, ${hit} as ChanceToHit, FCT_ShipDesignComponents.Cost from FCT_ShipClass left join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID left join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ShipClass.GameID = ${GameID} and FCT_ShipClass.RaceID = ${RaceID}${ids ? ` and FCT_ShipClass.ShipClassID in (${ids.join(', ')})` : ''} order by ShipClassID, ChanceToHit, ComponentID`)
  const byClass = {}

  rows.forEach((row) => {
    byClass[row.ShipClassID] = byClass[row.ShipClassID] || []

    if (row.ComponentID !== null && row.ComponentID !== undefined) {
      byClass[row.ShipClassID].push({ chanceToHit: row.ChanceToHit, cost: row.Cost })
    }
  })

  return byClass
}

// A column's value for one row of a table, null when the table has no such column or row.
const optionalValue = async (database, table, column, where) => {
  const columns = await columnsOf(database, table)

  if (!columns.has(column)) {
    return null
  }

  const [[row]] = await database.query(`select ${column} as value from ${table} where ${where}`)

  return row && row.value !== undefined ? row.value : null
}

// The ships the game's shipyard tasks name, as a Map of ShipID to 'active' (a task that is not paused: the game takes the ship out of maintenance and failure testing), 'paused' or 'unknown' (every task of the ship has an empty pause flag). Null when the save has no task table or lacks a column it is read by, so no ship's task is known.
const shipyardTasks = async (database, { GameID }) => {
  const columns = await columnsOf(database, 'FCT_ShipyardTask')

  if (!['GameID', 'ShipID', 'Paused'].every((name) => columns.has(name))) {
    return null
  }

  const [rows] = await database.query(`select ShipID, Paused from FCT_ShipyardTask where GameID = ${GameID} and ShipID > 0`)
  const tasks = new Map()

  rows.forEach((row) => {
    const paused = flag(row.Paused)
    const state = paused === false ? 'active' : paused === true ? 'paused' : 'unknown'
    const before = tasks.get(row.ShipID)

    tasks.set(row.ShipID, before === 'active' || state === 'active' ? 'active' : before === 'unknown' || state === 'unknown' ? 'unknown' : 'paused')
  })

  return tasks
}

// The race's ships of `classIds` (all its classes when null, none when an empty list), read once and worked out as `buildShipRuntime` does, for `GameID` and `RaceID` of the database at `generation` (the store's freshness generation, null when the caller has none). Only the race's own classes are read: an id that is not one of them is listed in `rejected` and no ship is read for it, and every ship read is the race's own, so no other race's ship is joined through a class. `scenario` as `buildShipRuntime` takes it. Returns { status: 'ok', revision, formulaVersion, ships, classes, rejected, problems }; `revision` is { key, generation, GameID, RaceID, gameTime } and `formulaVersion` the game version the save's schema stands for (null when it is not shown to be 2.7): the hangar and shore-leave rates are given for 2.7 only.
export const loadShipRuntime = async (database, { GameID, RaceID, classIds = null, generation = null, scenario = {} }) => {
  const asked = requested(classIds)
  const wanted = asked && asked.ids
  const [gameTimeRead, byClass, noOverhauls, npr, formulaVersion, yardTasks] = await Promise.all([optionalValue(database, 'FCT_Game', 'GameTime', `GameID = ${GameID}`), classComponents(database, { GameID, RaceID, ids: wanted }), optionalValue(database, 'FCT_Game', 'NoOverhauls', `GameID = ${GameID}`), optionalValue(database, 'FCT_Race', 'NPR', `GameID = ${GameID} and RaceID = ${RaceID}`), loadFormulaVersion(database), shipyardTasks(database, { GameID })])
  const owned = Object.keys(byClass).map(Number)
  const rejected = asked ? [...asked.invalid, ...wanted.filter((id) => !owned.includes(id))] : []
  const gameTime = known(gameTimeRead) ? gameTimeRead : null
  const revision = deepFreeze({ key: `${known(generation) ? generation : 'unread'}:${GameID}:${RaceID}:${gameTime === null ? 'unread' : gameTime}`, generation: known(generation) ? generation : null, GameID, RaceID, gameTime })
  const rows = wanted && !owned.length ? [] : await loadFleetShips(database, { GameID, RaceID, fleetWhere: wanted ? `FCT_ShipClass.ShipClassID in (${owned.join(', ')})` : '1 = 1' })
  const ships = buildShipRuntime(rows, { revision, gameTime, version: formulaVersion, npr: flag(npr), noOverhauls: flag(noOverhauls), yardTasks, classes: byClass, scenario })
  const classes = {}

  ships.forEach((ship) => {
    classes[ship.ShipClassID] = ship.class
  })

  return deepFreeze({ status: 'ok', revision, formulaVersion, ships, classes, rejected, problems: gameTime === null ? ['FCT_Game has no GameTime in this save'] : [] })
}

// Whether a projection is of the scope now open: the same game, race and save copy (the freshness generation). A projection of an earlier scope is stale and must not be shown.
export const isCurrentRuntime = (projection, { GameID, RaceID, generation = null }) => Boolean(projection) && projection.status === 'ok' && projection.revision.GameID === GameID && projection.revision.RaceID === RaceID && projection.revision.generation === (known(generation) ? generation : null)

const STALE = deepFreeze({ status: 'stale', revision: null, formulaVersion: null, ships: [], classes: {}, rejected: [], problems: [] })
const NONE = deepFreeze({ status: 'none', revision: null, formulaVersion: null, ships: [], classes: {}, rejected: [], problems: [] })

// One reader for one owner (a page): `current()` gives the scope now, { database, GameID, RaceID, generation }, and `read({ classIds, scenario })` the projection of it. A read that finishes after the scope changed (another database, game, race or save copy) or after a later read was asked for gives the stale result, { status: 'stale', ships: [] }, and nothing of its figures; a read with no database, game or race gives { status: 'none' }. `cancel()` makes any read in flight stale.
export const createRuntimeReader = (current) => {
  let latest = 0
  const same = (a, b) => Boolean(b) && a.database === b.database && a.GameID === b.GameID && a.RaceID === b.RaceID && a.generation === b.generation

  return {
    cancel() {
      latest += 1
    },

    async read({ classIds = null, scenario = {} } = {}) {
      latest += 1

      const run = latest
      const scope = current()

      if (!scope || !scope.database || !scope.GameID || !scope.RaceID) {
        return NONE
      }

      const open = { database: scope.database, GameID: scope.GameID, RaceID: scope.RaceID, generation: scope.generation }

      try {
        const projection = await loadShipRuntime(open.database, { GameID: open.GameID, RaceID: open.RaceID, classIds, generation: open.generation, scenario })

        return run === latest && same(open, current()) ? projection : STALE
      } catch (error) {
        if (run !== latest || !same(open, current())) {
          return STALE
        }

        throw error
      }
    },
  }
}
