// The Logistics bonuses that multiply a ship's own loading strength: the ship commander's, the naval admin chain's, the colony governor's and the sector's. Each is an adapter that reads one officer's bonus from what the loader (utilities/handling-support.js) read, and the product stays apart from the colony's additive support, which no officer multiplies. Evidence: docs/plans/backlog/evidence/AE-082-01.md.

import { fleetCommandChain } from './minerals'
import { registerRule } from './provenance'

// DIM_CommanderBonusType: Logistics, a percentage bonus (1.2 is 20% more).
export const LOGISTICS_BONUS = 24
// The share of a sector commander's bonus a colony in the sector receives: a quarter of the excess over 1.
const SECTOR_SHARE = 0.25

// The officers' order, as the breakdown shows them.
export const OFFICER_KEYS = ['commander', 'admin', 'governor', 'sector']

const LABELS = { commander: 'Ship commander', admin: 'Naval administration', governor: 'Colony governor', sector: 'Sector' }

// What a plan for a ship class reads instead of officers: a class carries none, so every factor is 1 by assumption, not by lack of data.
export const CLASS_ONLY = Object.freeze({ mode: 'class' })

registerRule({
  id: 'transport.logisticsBonuses',
  versions: ['2.7.x'],
  units: '×',
  verification: 'estimated',
  structure: ['FCT_CommanderBonuses.BonusValue (Logistics)', 'FCT_Commander.CommandType, CommandID', 'FCT_Fleet.ParentCommandID', 'FCT_NavalAdminCommand', 'DIM_NavalAdminCommandType.Logistics', 'FCT_RaceSysSurvey.SectorID'],
  note: 'A ship\'s own loading strength is multiplied by its commander\'s Logistics bonus, by the naval administration chain of the system where it loads (each command passes on its commander\'s bonus scaled by the command type\'s Logistics share), by the colony governor\'s bonus, and by a quarter of the excess of the sector commander\'s bonus. The colony\'s spaceport or cargo shuttle station adds the race\'s technology once more and no officer multiplies it. An officer with no Logistics bonus counts as 1. The stacking is read from the game\'s documented rules, not compared with a time the game stores.',
  assumptions: ['the naval administration chain is the one of the fleet\'s command and, for a fleet with none, the race\'s top command', 'a bonus the save cannot name counts as 1 and the figure is an estimate that errs long'],
})

const known = (key, value, text) => ({ key, label: LABELS[key], state: value === 1 ? 'none' : 'applies', value, text })

const none = (key, text) => ({ key, label: LABELS[key], state: 'none', value: 1, text })

const unknown = (key, text) => ({ key, label: LABELS[key], state: 'unknown', value: 1, text })

const multiplier = (value) => `×${Number(value.toFixed(4))}`

const has = (map, key) => Object.prototype.hasOwnProperty.call(map || {}, key)

// One officer's bonus out of a map of rows: a row with a number is the bonus, a row with no value is unknown, no row means the officer has no bonus (neutral).
const personal = (key, map, id, noun, scale = (value) => value) => {
  if (!Number.isFinite(id)) {
    return unknown(key, `${noun}'s place in the save is not known`)
  } else if (!has(map, id)) {
    return none(key, `no ${noun} with a Logistics bonus`)
  } else if (!Number.isFinite(map[id])) {
    return unknown(key, `the ${noun}'s Logistics bonus is not known from the save (a row with no value, or an assignment that is not recorded)`)
  }

  return known(key, scale(map[id]), `${noun}'s bonus ${multiplier(map[id])}`)
}

// The four officer factors one ship earns at one stop, each { key, label, state: 'applies' | 'none' | 'unknown', value (1 unless it applies), text }. `ship`: { ShipID, NavalAdminCommandID }; `endpoint`: { populationId, systemId } as `colonyEndpoint` gives them (a place with no colony has no governor or sector); `support`: what the loader read, `CLASS_ONLY` for a class plan, or null when nothing was read (every factor is then unknown, never 1).
export const officerFactors = (ship, endpoint, support) => {
  if (support === CLASS_ONLY) {
    return OFFICER_KEYS.map((key) => none(key, 'a class plan has no officers'))
  } else if (!support || support.mode !== 'loaded') {
    return OFFICER_KEYS.map((key) => unknown(key, 'the Logistics bonuses are not read'))
  }

  const gap = (key) => (support.gaps && support.gaps[key]) || null
  const given = (key, build) => (gap(key) ? unknown(key, gap(key)) : build())
  const colony = endpoint && Number.isFinite(endpoint.populationId)

  return [
    given('commander', () => personal('commander', support.commanders, ship.ShipID, 'commander')),
    given('admin', () => {
      if (!endpoint || !Number.isFinite(endpoint.systemId)) {
        return unknown('admin', 'the system where the ship loads is not known')
      } else if (ship.NavalAdminCommandID === undefined) {
        return unknown('admin', 'the fleet\'s command is not read')
      }

      const chain = fleetCommandChain(support.admins || {}, endpoint.systemId, ship.NavalAdminCommandID)

      return chain.bonus === null ? unknown('admin', chain.unknown) : chain.bonus === 1 ? none('admin', 'no command in range with a Logistics bonus') : known('admin', chain.bonus, `the chain's bonus ${multiplier(chain.bonus)}`)
    }),
    colony ? given('governor', () => personal('governor', support.governors, endpoint.populationId, 'governor')) : none('governor', 'the stop has no colony'),
    colony ? given('sector', () => (Number.isFinite(endpoint.systemId) ? personal('sector', support.sectors, endpoint.systemId, 'sector commander', (value) => 1 + (value - 1) * SECTOR_SHARE) : unknown('sector', 'the system where the ship loads is not known'))) : none('sector', 'the stop has no colony'),
  ]
}

// The factors stacked: `product` multiplies the known ones and counts each unknown as 1, `known` the factors that apply, `unknown` those the save cannot settle, and `estimate` that some factor is unknown, so the figure is long by what the missing bonuses would give.
export const stackFactors = (factors) => ({
  factors,
  product: factors.reduce((total, factor) => total * factor.value, 1),
  known: factors.filter((factor) => factor.state === 'applies'),
  unknown: factors.filter((factor) => factor.state === 'unknown'),
  estimate: factors.some((factor) => factor.state === 'unknown'),
})

// What a figure that stacks these factors says about its inputs, for a provenance result: the officers whose bonus applies are present inputs, those the save cannot settle missing ones, and an unsettled bonus is an assumption (it counts as 1, so the time errs long).
export const bonusProvenance = ({ known, unknown }) => ({
  inputs: { present: known.map((factor) => `${factor.label}'s Logistics bonus`), missing: unknown.map((factor) => `${factor.label}'s Logistics bonus`) },
  assumptions: unknown.length ? ['a Logistics bonus the save cannot settle counts as 1, so the time errs long'] : [],
})

// The factors of several stops or ships merged by officer: each officer once, an unknown one over a known one.
export const mergeFactors = (lists) => {
  const rank = { unknown: 2, applies: 1, none: 0 }
  const merged = new Map()

  lists.flat().forEach((factor) => {
    const seen = merged.get(factor.key)

    if (!seen || rank[factor.state] > rank[seen.state]) {
      merged.set(factor.key, factor)
    }
  })

  return OFFICER_KEYS.filter((key) => merged.has(key)).map((key) => merged.get(key))
}

// The officers' labels in table order, as { key, label }.
export const OFFICERS = OFFICER_KEYS.map((key) => ({ key, label: LABELS[key] }))

// A factor as a table cell: its multiplier where it applies, a dash where the officer has no bonus, the word where the save cannot say.
export const factorCell = (factor) => (factor.state === 'applies' ? multiplier(factor.value) : factor.state === 'none' ? '—' : 'Unknown')

// What the page says about how far the officers' bonuses were read, as { tone, text } or null when all were read: `state` is { loading, failed, error } (the optional read's own state) and `support` what the loader returned. A bonus that was not read counts as 1, so the loading times err long.
export const supportNote = (state, support) => {
  if (state.loading) {
    return { tone: 'text--secondary', text: 'The officers\' Logistics bonuses are being read. Until they are in, each counts as 1 and the loading times err long.' }
  } else if (state.failed) {
    return { tone: 'warning--text', text: `The officers' Logistics bonuses could not be read${state.error ? ` (${state.error})` : ''}. Each counts as 1, so the loading times err long.` }
  }

  const lacking = OFFICER_KEYS.filter((key) => support && support.gaps && support.gaps[key])

  return lacking.length ? { tone: 'warning--text', text: `Not read from the save: ${lacking.map((key) => `${LABELS[key].toLowerCase()} (${support.gaps[key]})`).join('; ')}. Each counts as 1, so the loading times err long.` } : null
}
