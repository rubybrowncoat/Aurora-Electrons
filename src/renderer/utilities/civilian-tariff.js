// What a civilian shipping line is paid for carrying freight, colonists and passengers in the save's game version, and how far that explains what the race spends. The payout rates are public figures per unit carried and per billion km travelled, so every estimate takes its distance in billion km and its quantity in units, and none exists for a game version the rates are not published for. A shipping-line payout is not the race's expenditure: the wealth log holds the race's own flows, and no stored or published link ties a line's payout to one of them, so no net cost to the treasury is claimed until every civilian use is mapped.
//
// Evidence: docs/plans/backlog/detailed/FINDINGS.md R-ECO-06 and docs/plans/backlog/evidence/AE-078-01.md.

import { countText } from './math'
import { isAvailable, ofRule, registerRule, ruleSupports, unavailable } from './provenance'

export const KM_PER_BILLION = 1e9
const TARIFF_VERSIONS = ['2.7.x']

// The factor a computer-run empire's shipping-line payments are multiplied by in 2.7, per the same notes; a player's race is paid the published rate as it stands.
export const NPR_PAYOUT_MODIFIER = 0.5

// The categories a shipping line is paid for, each with its published rate (wealth per unit per billion km) and the unit it counts. A rate of null is a category the published notes give no rate for: its payout is unknown, never 0.
export const CATEGORIES = Object.freeze([
  { id: 'colonist', label: 'Colonist', unit: 'colonist', rate: 0.00015 },
  { id: 'passenger', label: 'Passenger', unit: 'passenger', rate: 0.006 },
  { id: 'tradeGood', label: 'Trade good', unit: 'trade good', rate: 0.375 },
  { id: 'cargoPoint', label: 'Cargo point', unit: 'cargo point', rate: 0.00015 },
  { id: 'fuel', label: 'Fuel', unit: 'litre', rate: null },
].map((category) => Object.freeze(category)))

registerRule({
  id: 'civilianTariff.rates',
  versions: TARIFF_VERSIONS,
  units: 'wealth per unit per billion km',
  verification: 'estimated',
  structure: ['the published payout rates by category'],
  note: 'What a shipping line is paid per unit carried and per billion km travelled, as published for 2.7: 0.00015 for a colonist and for a cargo point, 0.006 for a passenger and 0.375 for a trade good (Aurora v2.7.0 patch notes, post on updates to shipping lines). A public statement, not checked against the save: it stores each payout (FCT_ShippingWealthData.Amount) but not the quantity carried, so no rate can be recomputed from it. No rate is published for fuel. No per-system tariff or earlier-version rate is used, and a game version other than 2.7 gets no rate.',
})

registerRule({
  id: 'civilianTariff.payout',
  versions: TARIFF_VERSIONS,
  units: 'wealth',
  verification: 'estimated',
  structure: ['civilianTariff.rates', 'the route distance'],
  note: 'The quantity carried times the category\'s rate (`civilianTariff.rates`) times the distance in billion km, times 0.5 for a computer-run empire (the notes set that modifier for 2.7; a player\'s race has none). It is what the shipping line earns for the trip, not what the race spends: the wealth log holds no use that is stored as carrying it.',
  assumptions: ['every unit is carried the whole distance', 'the distance is the route travelled loaded'],
})

registerRule({
  id: 'civilianTariff.netCost',
  versions: TARIFF_VERSIONS,
  units: 'wealth',
  verification: 'estimated',
  structure: ['FCT_WealthData.UseID, Amount', 'DIM_WealthUse.Description, Income', 'the civilian use table'],
  note: 'The window\'s logged amounts of the uses that carry shipping-line payouts, less the logged taxes on them. It exists only when every civilian use is placed in the table as a payout, a tax or unrelated; no source places them, so the shipped table has none placed and no net cost is given.',
})

// The wealth uses (DIM_WealthUse ids) whose names touch civilian shipping lines, with the side of the ledger they sit on. `role` places a use against a shipping-line payout: 'payout' (the use carries it), 'tax' (a levy on the flow it belongs to) or 'other'; null while no source says. Civilian mining and its mineral purchases are not shipping-line payouts and are left out.
const USES = [
  { id: 29, label: 'Purchase of Civilian Ships', side: 'spending' },
  { id: 32, label: 'Tax on Shipping Trade Goods', side: 'income' },
  { id: 34, label: 'Tax on Shipping Colonists', side: 'income' },
  { id: 42, label: 'Shipping Line Subsidy', side: 'spending' },
  { id: 43, label: 'Tax on Passenger Liners', side: 'income' },
  { id: 44, label: 'Civilian Contracts', side: 'spending' },
  { id: 46, label: 'Purchase of Civilian Fuel', side: 'spending' },
  { id: 47, label: 'Tax on Civilian Fuel', side: 'income' },
]

export const CIVILIAN_USES = Object.freeze(USES.map((use) => Object.freeze({ ...use, role: null })))

const ROLES = ['payout', 'tax', 'other']

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const RATES_MISSING = 'the civilian payout rates for the save\'s game version'

// Kilometres as billion km, the unit the rates are in.
export const billionKm = (km) => (finite(km) ? km / KM_PER_BILLION : null)

const categoryOf = (id) => CATEGORIES.find((category) => category.id === id) || null

// The rate of a category in wealth per unit per billion km: unavailable for a game version the rates are not published for (`version` is the save's formula version, null when unknown) and for a category with no published rate.
export const rateOf = (version, id) => {
  if (ruleSupports('civilianTariff.rates', version) !== true) {
    return unavailable({ rule: 'civilianTariff.rates', missing: [RATES_MISSING] })
  }

  const category = categoryOf(id)

  if (!category || category.rate === null) {
    return unavailable({ rule: 'civilianTariff.rates', missing: [`a published payout rate for ${category ? category.label.toLowerCase() : `the category "${id}"`}`] })
  }

  return ofRule({ rule: 'civilianTariff.rates', value: category.rate, inputs: { present: ['the published 2.7 rate'] } })
}

// What a shipping line is paid for carrying `quantity` units of a category over `billionKm` billion km, for a player's race (`npr` false) or a computer-run empire (`npr` true, paid at half). Unavailable when the rate is (see `rateOf`), for a quantity or distance that is not a number of 0 or more, and for an `npr` that is not true or false (the race's kind is not known).
export const payoutEstimate = ({ version, category, quantity, billionKm: distance, npr }) => {
  const rate = rateOf(version, category)

  if (!isAvailable(rate)) {
    return unavailable({ rule: 'civilianTariff.payout', missing: rate.inputs.missing })
  }

  const missing = [...(finite(quantity) && quantity >= 0 ? [] : ['the quantity carried']), ...(finite(distance) && distance >= 0 ? [] : ['the route distance in billion km']), ...(typeof npr === 'boolean' ? [] : ['whether the race is a player\'s or computer-run'])]

  if (missing.length) {
    return unavailable({ rule: 'civilianTariff.payout', missing, present: ['the published 2.7 rate'] })
  }

  return ofRule({ rule: 'civilianTariff.payout', value: quantity * rate.value * distance * (npr ? NPR_PAYOUT_MODIFIER : 1), inputs: { present: ['the published 2.7 rate', 'the quantity carried', 'the route distance', npr ? 'the published computer-run modifier of 0.5' : 'a player\'s race, paid the published rate'] } })
}

// The save's game version in words, for the chip and note beside a payout.
export const describeTariffVersion = (version) => (ruleSupports('civilianTariff.rates', version) === true ? `Payout rates of game version ${version.replace(/\.x$/, '')}` : 'No payout rates for this save\'s game version')

// Which civilian uses are placed against a shipping-line payout: `complete` when every use has a role and at least one carries the payout; `unplaced` the uses without one. `uses` is the table, CIVILIAN_USES unless a caller holds a sourced one.
export const treasuryMapping = (uses = CIVILIAN_USES) => {
  const unplaced = uses.filter((use) => !ROLES.includes(use.role))

  return { uses, unplaced, complete: !unplaced.length && uses.some((use) => use.role === 'payout') }
}

// The ledger categories (`buildLedger`'s `categories`) that are civilian uses, in the table's order.
export const civilianCategories = (categories, uses = CIVILIAN_USES) => uses.map((use) => categories.find((category) => category.id === use.id)).filter(Boolean)

// The net cost to the treasury of shipping-line payouts over a window: the logged amounts of the payout uses less the logged taxes, from `totals` ({ [UseID]: the window's amount, absent when the use logged nothing }). Unavailable for a game version the rule is not published for, and unavailable, whatever the totals, until the mapping is complete: an unplaced use could be the payout or what offsets it.
export const netCostResult = ({ version, mapping, totals }) => {
  if (ruleSupports('civilianTariff.netCost', version) !== true) {
    return unavailable({ rule: 'civilianTariff.netCost', missing: [RATES_MISSING] })
  } else if (!mapping.complete) {
    return unavailable({ rule: 'civilianTariff.netCost', missing: [`the link between shipping-line payouts and the logged treasury uses (${mapping.unplaced.length ? `${mapping.unplaced.length} of ${mapping.uses.length} civilian uses are not placed` : 'no use carries the payout'})`] })
  }

  const sum = (role) => mapping.uses.filter((use) => use.role === role).reduce((total, use) => total + (totals[use.id] || 0), 0)

  return ofRule({ rule: 'civilianTariff.netCost', value: sum('payout') - sum('tax'), inputs: { present: ['FCT_WealthData.Amount', 'the civilian use table'] } })
}

// A payout or rate as text: a dash for an unknown one, four significant digits below a thousand (so 0.00015 stays readable and never reads as 0), whole numbers with the separator from a thousand.
export const amountText = (value, separator = '\'') => {
  if (!finite(value)) {
    return '—'
  }

  return Math.abs(value) >= 1000 ? countText(value, 0, separator) : Number(value.toPrecision(4)).toFixed(12).replace(/\.?0+$/, '')
}

// Each category's rate and its payout for one unit over `km` (one way) to a player's race or a computer-run empire (`npr`): the rows a page lists, every figure a result (unavailable when a rate, the distance or the race's kind is not known).
export const payoutRows = ({ version, km, npr }) => CATEGORIES.map((category) => ({ category, rate: rateOf(version, category.id), payout: payoutEstimate({ version, category: category.id, quantity: 1, billionKm: billionKm(km), npr }) }))
