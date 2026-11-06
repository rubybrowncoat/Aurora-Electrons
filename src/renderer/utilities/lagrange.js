// What stabilising a Lagrange point takes and which figures of the Lagrange page are counted or drawn: the multiplier a ship's captain and crew put on the time, the days a body needs with the quickest ship, the counts the tiles show, the time an order has left and the display scale of the map. Every figure travels as a result of a registered rule (utilities/provenance.js), so an input the save lacks gives an unavailable result that names it, never a time of 0 days.

import { crewFraction } from './crew'
import { UNVERIFIED_SAVE, combine, ofRule, registerRule, ruleSupports, unavailable } from './provenance'

const LAGRANGE_VERSIONS = ['2.7.x']
// The two timing rules hold on 3.2, which skips a ship with no crew aboard and caps the duration at Int32.MaxValue seconds before converting it to an integer (`Fleet.CalculateGateBuildTime` and `Fleet.CalculateLagrangePointStabilisationTime` of the 3.1.0 source, the reference for the 3.2 line; docs `MOVEMENT_AND_LOGISTICS_REFERENCE.md` § Changes since the earlier line, line 918).
const TIMING_VERSIONS = ['3.2.x']
// Stabilising a Lagrange point takes 60 / sqrt(mass) months of 30 days.
export const BASE_DAYS = 60 * 30
const SECONDS_PER_DAY = 86400
// The game returns the duration as a 32-bit integer number of seconds, so a longer one is capped at Int32.MaxValue seconds before the conversion (3.1); the cap is carried here in days, the unit the page shows.
const MAX_SECONDS = 2147483647
const MAX_DAYS = MAX_SECONDS / SECONDS_PER_DAY

registerRule({
  id: 'lagrange.stabilisationMultiplier',
  versions: TIMING_VERSIONS,
  units: '×',
  verification: 'estimated',
  structure: ['FCT_Ship.CurrentCrew', 'FCT_ShipClass.Crew', 'FCT_DamagedComponent', 'FCT_CommanderBonuses.BonusValue'],
  note: 'A ship with an undamaged jump point stabilisation module takes 2 minus its captain\'s Production bonus times as long, and Class Crew / Current Crew times as long again while it is short of crew. The sources do not say whether the bonus divides the time or is taken off the 2, so the bonus term is not checked against a stabilisation the save records. A ship with no crew aboard is skipped and contributes nothing to the time, whatever its class needs: the game leaves it out rather than dividing by its crew.',
})

registerRule({
  id: 'lagrange.stabilisationDays',
  versions: TIMING_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Mass', 'lagrange.stabilisationMultiplier'],
  note: '60 / the square root of the body\'s mass in Earth masses months of 30 days, times the quickest usable ship\'s multiplier, and capped at 2,147,483,647 seconds (24,855.13 days), the largest duration the game\'s 32-bit integer time can hold. The trip to the body is left out.',
  assumptions: ['the quickest usable ship does the work', 'the trip to the body takes no time'],
})

registerRule({
  id: 'lagrange.pointCounts',
  versions: LAGRANGE_VERSIONS,
  units: 'bodies, systems, ships, colonies',
  verification: 'confirmed',
  structure: ['FCT_LagrangePoint', 'FCT_SystemBody', 'FCT_RaceSysSurvey', 'FCT_Population', 'FCT_Ship'],
  note: 'Counts of saved rows: the bodies and systems with a stable Lagrange point, the planets and moons still to stabilise, the race\'s colonies in a system and its ships with a stabilisation module. Nothing is calculated beyond counting them.',
})

registerRule({
  id: 'lagrange.timeLeft',
  versions: LAGRANGE_VERSIONS,
  units: 'days',
  verification: 'confirmed',
  structure: ['FCT_MoveOrders.TimeRequired', 'FCT_MoveOrders.Arrived'],
  note: 'The seconds a fleet that has arrived still needs, as the stabilise order stores them, in days.',
})

registerRule({
  id: 'lagrange.mapScale',
  versions: LAGRANGE_VERSIONS,
  units: 'dot size and colour',
  verification: 'assumed',
  note: 'A display scale, not a game rule: a dot grows and changes colour with the number of stable points in its system (none, one, two or more), and a ring marks a system with colonies.',
  assumptions: ['dot sizes and colours are a display choice'],
})

const inputsOf = (present) => ({ present })

// What a ship's captain, crew and damage make of a stabilisation: { state, result }. `state` is 'ready' (it can stabilise: `result` is the multiplier on the time), 'damaged' (a stabilisation module is damaged), 'no-crew' (no crew aboard, whatever its class needs, so the 3.1 game skips the ship and it contributes nothing to the time), 'bonus' (the captain's Production bonus is 2 or more, which the rule gives no time for) or 'unknown' (the crew or the class crew is not in the save, whether the class needs a crew or not: a class with no crew whose current crew is missing does not say there is none). `ship`: { Damaged, CurrentCrew, ClassCrew, ProductionBonus, CaptainName }, `ProductionBonus` being null when the captain has none recorded. `version`: the formula version of the save (`loadFormulaVersion`).
export const stabilisationMultiplier = (ship, version = null) => {
  const rule = 'lagrange.stabilisationMultiplier'

  if (ship.Damaged) {
    return { state: 'damaged', result: unavailable({ rule, missing: ['an undamaged jump point stabilisation module'] }) }
  }

  const fraction = crewFraction(ship)
  const aboard = Number.isFinite(ship.CurrentCrew) ? ship.CurrentCrew > 0 : null

  if (fraction === null || aboard === null) {
    return { state: 'unknown', result: unavailable({ rule, missing: ['the ship\'s crew or its class crew'] }) }
  } else if (!aboard) {
    return { state: 'no-crew', result: unavailable({ rule, missing: ['a crew aboard (the game skips a ship with no crew whatever its class needs, so it adds no time)'], present: ['the ship\'s crew and its class crew'] }) }
  }

  const bonus = Number.isFinite(ship.ProductionBonus) ? ship.ProductionBonus : 1

  if (!(bonus < 2)) {
    return { state: 'bonus', result: unavailable({ rule, missing: ['a Production bonus under 2 (the rule gives no time at 2 or more)'], present: ['the ship\'s crew and its class crew'] }) }
  }

  const assumptions = []

  if (ruleSupports(rule, version) !== true) {
    assumptions.push(UNVERIFIED_SAVE)
  }

  if (!ship.CaptainName) {
    assumptions.push('no captain aboard, so no Production bonus')
  } else if (!Number.isFinite(ship.ProductionBonus)) {
    assumptions.push('the captain has no Production bonus recorded, so no bonus')
  }

  return { state: 'ready', result: ofRule({ rule, value: (2 - bonus) * (1 / fraction), inputs: inputsOf(['the ship\'s crew and its class crew', 'the module\'s damage', 'the captain\'s Production bonus']), assumptions }) }
}

// The quickest of the ships' multipliers, as { ship, result }: `ship` the row of the quickest usable ship or null, `result` its multiplier or an unavailable result naming why no ship can time a stabilisation: no ship at all, none usable, the crew of an unready ship unknown, or a Production bonus the rule gives no time for. A ship whose crew is not in the save may be quicker, which is a stated assumption of the result. `rows`: [{ state, result }] from `stabilisationMultiplier`.
export const bestStabilisation = (rows) => {
  const rule = 'lagrange.stabilisationMultiplier'
  const ready = rows.filter((row) => row.state === 'ready').sort((a, b) => a.result.value - b.result.value)
  const unknown = rows.filter((row) => row.state === 'unknown').length
  const bonus = rows.filter((row) => row.state === 'bonus').length

  if (!ready.length) {
    const reasons = [...(unknown ? [`the crew of ${unknown === 1 ? 'a ship' : `${unknown} ships`} with a stabilisation module`] : []), ...(bonus ? [`a Production bonus under 2 for ${bonus === 1 ? 'a ship' : `${bonus} ships`} with a stabilisation module`] : [])]
    const missing = !rows.length ? ['a ship with a jump point stabilisation module'] : reasons.length ? reasons : ['a ship with an undamaged module and a crew aboard']

    return { ship: null, result: unavailable({ rule, missing }) }
  }

  const [best] = ready

  if (!unknown) {
    return { ship: best, result: best.result }
  }

  return { ship: best, result: combine({ rule, parts: { ship: best.result }, compute: ({ ship }) => ship, assumptions: [`${unknown === 1 ? 'a ship' : `${unknown} ships`} whose crew is not in the save ${unknown === 1 ? 'is' : 'are'} left out, though quicker`] }) }
}

// Days to stabilise a body of `mass` Earth masses with the quickest ship's multiplier (`bestStabilisation`'s result), capped at the game's Int32.MaxValue seconds (3.1) so that a very short crew or a tiny body gives the cap and never a figure that overflows. A mass that is missing or not above 0 gives no time, and so does a multiplier that is unavailable; the result then lists every missing input.
export const stabilisationDays = (mass, multiplier) => {
  const rule = 'lagrange.stabilisationDays'
  const massKnown = Number.isFinite(mass) && mass > 0
  const missing = [...(massKnown ? [] : ['the body\'s mass above 0']), ...(multiplier.status === 'unavailable' ? multiplier.inputs.missing : [])]

  if (missing.length) {
    return unavailable({ rule, missing, present: massKnown ? ['the body\'s mass'] : [] })
  }

  return combine({ rule, parts: { multiplier }, compute: ({ multiplier: factor }) => Math.min((BASE_DAYS / Math.sqrt(mass)) * factor, MAX_DAYS), inputs: inputsOf(['the body\'s mass']) })
}

// The days a fleet that has arrived still needs, from the order's stored seconds; unavailable when the save has none.
export const timeLeft = (seconds) => (Number.isFinite(seconds) ? ofRule({ rule: 'lagrange.timeLeft', value: Math.max(0, seconds) / SECONDS_PER_DAY, inputs: inputsOf(['the order\'s time required']) }) : unavailable({ rule: 'lagrange.timeLeft', missing: ['the order\'s time required'] }))
