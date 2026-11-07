// What a civilian shipping line is paid for carrying freight, colonists and passengers in the save's game version, and how far that explains what the race spends. The payout rates are public figures per unit carried and per billion km travelled, so every estimate takes its distance in billion km and its quantity in units, and none exists for a game version the rates are not published for. The fare a trip is charged is not what the line receives: the race takes its shipping-line tax out of the fare first, and a computer-run empire's line is paid half of what is left (the receipt). A shipping-line payout is not the race's expenditure: the wealth log holds the race's own flows, and no stored or published link ties a line's receipt to one of them, so no net cost to the treasury is claimed until every civilian use is mapped.
//
// Evidence: docs/plans/backlog/detailed/FINDINGS.md R-ECO-06 and docs/plans/backlog/evidence/AE-078-01.md. The receipt is the fare less the tax on it, halved for a computer-run empire: the installation delivery charges `num2 = cargo points * 0.00015 * billion km`, takes `num3 = num2 * ShippingLineTax` off it, then halves `num2` when the race is run by the computer (the game's ship code, the delivery of an installation; the trade good, colonist and liner deliveries work the same way with their own rate).

import { countText } from './math'
import { isAvailable, ofRule, registerRule, ruleSupports, unavailable } from './provenance'

export const KM_PER_BILLION = 1e9
const TARIFF_VERSIONS = ['3.2.x']

// The factor a computer-run empire's shipping line is paid of what is left of the fare after the race takes its shipping-line tax; a player's race's line is paid all of what is left.
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
  note: 'What a shipping line is paid per unit carried and per billion km travelled, as published: 0.00015 for a colonist and for a cargo point, 0.006 for a passenger and 0.375 for a trade good (the Aurora patch notes, post on updates to shipping lines). A public statement, not checked against the save: it stores each payout but not the quantity carried, so no rate can be recomputed from it. Fuel carries no shipping-line rate: a civilian fuel purchase is paid at a rate per litre, with no distance in it, so no fare is worked out for fuel. No per-system tariff is used, and a save whose game rules are not known gets no rate.',
})

registerRule({
  id: 'civilianTariff.payout',
  versions: TARIFF_VERSIONS,
  units: 'wealth',
  verification: 'estimated',
  structure: ['civilianTariff.rates', 'the route distance'],
  note: 'The quantity carried times the category\'s published rate times the distance in billion km: the fare the trip is charged at the published rates, before the race\'s shipping-line tax. That tax comes out of the whole fare, and a computer-run empire\'s line is paid half of what is left, so the line\'s receipt is this fare less the tax on it (the receipt rule takes both). The wealth log holds no use that is stored as carrying a payout, so no cost to the race is claimed here; the plan line of the treasury runway takes the tax and the receipt out.',
  assumptions: ['every unit is carried the whole distance', 'the distance is the route travelled loaded'],
})

registerRule({
  id: 'civilianTariff.receipt',
  versions: TARIFF_VERSIONS,
  units: 'wealth',
  verification: 'estimated',
  structure: ['civilianTariff.payout', 'the race\'s shipping-line tax', 'the race\'s kind'],
  note: 'What the line is paid for the trip: the fare less the race\'s shipping-line tax, halved (0.5) for a computer-run empire\'s line, which is paid half of what is left. The tax comes out of the whole fare before the halving, so the halving never applies to a fare that already has it. The rate is the one the save holds now, so a rate changed since the trip makes the figure an estimate; a save without the rate, or without the race\'s kind, gives no figure, never the whole fare.',
  assumptions: ['the shipping-line tax rate set now held for the trip'],
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

  return ofRule({ rule: 'civilianTariff.rates', value: category.rate, inputs: { present: ['the published rate'] } })
}

// The fare a shipping line's trip is charged at the published rates for `quantity` units of a category over `billionKm` billion km, before the race's shipping-line tax. Unavailable when the rate is (see `rateOf`) and for a quantity or distance that is not a number of 0 or more.
export const payoutEstimate = ({ version, category, quantity, billionKm: distance }) => {
  const rate = rateOf(version, category)

  if (!isAvailable(rate)) {
    return unavailable({ rule: 'civilianTariff.payout', missing: rate.inputs.missing })
  }

  const missing = [...(finite(quantity) && quantity >= 0 ? [] : ['the quantity carried']), ...(finite(distance) && distance >= 0 ? [] : ['the route distance in billion km'])]

  if (missing.length) {
    return unavailable({ rule: 'civilianTariff.payout', missing, present: ['the published rate'] })
  }

  return ofRule({ rule: 'civilianTariff.payout', value: quantity * rate.value * distance, inputs: { present: ['the published rate', 'the quantity carried', 'the route distance'] } })
}

// The line's receipt of `fare`: the race's shipping-line tax comes out of the whole fare, then `modifier` (1 for a player's race, 0.5 for a computer-run empire) applies to what is left. The halving is of the fare after the tax, never of a fare that already has it.
export const receiptOf = (fare, { taxRate, modifier = 1 }) => fare * (1 - taxRate) * modifier

// What the line is paid for the trip: the published-rate fare less the race's shipping-line tax (`taxRate` is the saved share, 0 to 1), halved for a computer-run empire's line (`npr` true). Unavailable when the fare is (see `payoutEstimate`), for a tax rate that is not a share of 0 to 1, and for an `npr` that is not true or false (the race's kind is not known).
export const receiptEstimate = ({ version, category, quantity, billionKm, taxRate, npr }) => {
  const fare = payoutEstimate({ version, category, quantity, billionKm })

  if (!isAvailable(fare)) {
    return unavailable({ rule: 'civilianTariff.receipt', missing: fare.inputs.missing })
  }

  const missing = [...(finite(taxRate) && taxRate >= 0 && taxRate <= 1 ? [] : ['the race\'s shipping-line tax rate']), ...(typeof npr === 'boolean' ? [] : ['whether the race is a player\'s or computer-run'])]

  if (missing.length) {
    return unavailable({ rule: 'civilianTariff.receipt', missing, present: fare.inputs.present })
  }

  return ofRule({ rule: 'civilianTariff.receipt', value: receiptOf(fare.value, { taxRate, modifier: npr ? NPR_PAYOUT_MODIFIER : 1 }), inputs: { present: [...fare.inputs.present, 'the race\'s shipping-line tax', npr ? 'the published computer-run modifier of 0.5' : 'a player\'s race, paid all of the fare left after the tax'] } })
}

// The save's game version in words, for the chip and note beside a payout.
export const describeTariffVersion = (version) => (ruleSupports('civilianTariff.rates', version) === true ? 'Published payout rates' : 'No payout rates for this save\'s game version')

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

// Each category's rate, its published-rate fare and the line's receipt for one unit over `km` (one way), for a player's race or a computer-run empire (`npr`) at the tax rate `taxRate`: the rows a page lists, every figure a result (unavailable when a rate, the distance, the race's kind or the tax rate is not known).
export const payoutRows = ({ version, km, taxRate, npr }) => CATEGORIES.map((category) => ({ category, rate: rateOf(version, category.id), fare: payoutEstimate({ version, category: category.id, quantity: 1, billionKm: billionKm(km) }), receipt: receiptEstimate({ version, category: category.id, quantity: 1, billionKm: billionKm(km), taxRate, npr }) }))
