// The treasury runway of the Finances page under civilian shipping scenarios: the constant-net baseline kept as it is, and what delayed contracts, government transports and new contracts do to the yearly net and to the date the treasury runs out. Every figure is a provenance result (utilities/provenance.js): a blank or missing input gives an unavailable result, never a 0.
//
// What the window holds is actual (the logged amounts, scaled to a year, as the Finances ledger scales them); what a scenario adds is an estimate that rests on the assumptions it names. The no-change scenario is the Finances runway itself, not a second calculation of it. The observed past rate of the treasury is not worked out here: it is the Stock rates panel of Empire History.
//
// Evidence: docs/plans/backlog/detailed/FINDINGS.md R-ECO-06 and R-ECO-08 and docs/plans/backlog/evidence/AE-077-01.md.

import { CIVILIAN_USES, NPR_PAYOUT_MODIFIER, payoutEstimate } from './civilian-tariff'
import { HISTORY_DAYS, SECONDS_PER_DAY, buildLedger, runwayOf } from './finances'
import { STATUS, combine, envelope, isAvailable, ofRule, registerRule, ruleSupports, sumResults, unavailable, valueOrNull, weakestStatus } from './provenance'

const VERSIONS = ['2.7.x']
const WEALTH_STRUCTURE = ['FCT_WealthData.UseID, TimeUsed, Amount', 'DIM_WealthUse.Description, Income', 'FCT_Game.GameTime']

export const SECONDS_PER_YEAR = HISTORY_DAYS * SECONDS_PER_DAY

// The horizons the scenarios are read over, in years, and the one taken until another is chosen.
export const HORIZONS = Object.freeze([5, 10, 25, 50, 100])
export const DEFAULT_HORIZON = 25

// How each civilian wealth use of the log (utilities/civilian-tariff.js `CIVILIAN_USES`) enters the treasury: 'contract' is what the race pays a shipping line for an installation delivery, 'tax' what the race takes of a delivery's fare, 'legacy' a use no current rule is found to book.
export const ROLES = Object.freeze({ 29: 'legacy', 32: 'tax', 34: 'tax', 42: 'legacy', 43: 'tax', 44: 'contract', 46: 'legacy', 47: 'tax' })
export const CONTRACT_USE = 44
export const CONTRACT_TAX_USE = 32

const usesOf = (role) => Object.keys(ROLES).filter((id) => ROLES[id] === role).map(Number)
const TAX_USES = usesOf('tax')
const LEGACY_USES = usesOf('legacy')

// The categories a planned contract can be priced in: the ones the published rates cover.
export const PLAN_CATEGORIES = Object.freeze(['cargoPoint', 'tradeGood', 'colonist', 'passenger'])

const GATE_MISSING = 'the civilian shipping rules for the save\'s game version'
const IMPLIED_MISSING = 'a shipping-line tax rate that held through the window (the logged tax on installation deliveries is below what the logged contracts alone imply at the rate set now)'
const FUTURE_TAX_MISSING = 'the future shipping-line tax rate (0 to 100 %)'
const KIND_MISSING = 'whether the race is a player\'s or computer-run'

registerRule({
  id: 'shippingRunway.taxRate',
  versions: VERSIONS,
  units: 'fraction',
  verification: 'confirmed',
  structure: ['FCT_Race.ShippingLineTax'],
  note: 'The shipping-line tax rate the race has set now, as saved: the share of a delivery\'s gross fare the race takes as tax. A save without the column, or with no value stored, gives no rate, never 0%. The save keeps only the present setting, so the rate earlier in the window is not known.',
})

registerRule({
  id: 'shippingRunway.windowTax',
  versions: VERSIONS,
  units: 'fraction',
  verification: 'assumed',
  structure: ['FCT_Race.ShippingLineTax'],
  note: 'The tax rate set now, taken to have held through the whole window. The log keeps no rate, so the logged contracts and taxes are split with this one; a rate changed within the window makes the split wrong, and a split that contradicts the logged taxes gives no figure.',
  assumptions: ['the tax rate set now held through the window'],
})

registerRule({
  id: 'shippingRunway.raceKind',
  versions: VERSIONS,
  units: 'fraction',
  verification: 'estimated',
  structure: ['FCT_Race.NPR'],
  note: 'The factor on the receipt of a shipping line: 1 for a player\'s race and 0.5 for a computer-run empire, whose lines are paid half after the tax is taken. The factor comes from the public notes and the inspected rules, not from a saved figure.',
})

registerRule({
  id: 'shippingRunway.assumption',
  versions: VERSIONS,
  units: '',
  verification: 'assumed',
  structure: [],
  note: 'A figure carried or entered for a scenario: the pause of the contracts, the future tax rate, the running cost of the government transports, the start of the new contracts. It is an assumption, not a figure of the save. A blank field is unknown and gives no scenario figure, never 0.',
})

registerRule({
  id: 'shippingRunway.windowFlow',
  versions: VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: WEALTH_STRUCTURE,
  note: 'A civilian use\'s logged amounts in the window scaled to a year by the time the window spans, as the Finances page scales every use (the Finances yearly rate). A use with no row in the window logged nothing there, which is 0 for the use; an amount missing from a logged row leaves the whole ledger without a figure. These are the actual flows of the window.',
  assumptions: ['the rate over the window holds for a year'],
})

registerRule({
  id: 'shippingRunway.contractFlow',
  versions: VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: ['FCT_WealthData Civilian Contracts and the taxes on shipping', 'FCT_Race.ShippingLineTax'],
  note: 'A shipping line that delivers installations to a colony of the race charges the race its receipt, the gross fare less the tax, under Civilian Contracts, and credits the race the tax, so the race\'s net on a delivery is the tax less the receipt: a fare of 100 at a tax of 20% takes 80 and gives 20, net -60. Trade goods, colonists and passengers carry the tax and no charge. The logged Civilian Contracts therefore imply the gross fare of the window (the receipt over one less the tax rate, a computer-run empire\'s receipt being halved), and with it the tax paired with them. The rule is the game\'s mechanics; it is compared with the saved flows only in that the logged tax on installation deliveries must cover the tax paired with the contracts.',
  assumptions: ['Civilian Contracts holds only installation deliveries', 'the tax rate set now held through the window'],
})

registerRule({
  id: 'shippingRunway.planLine',
  versions: VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: ['civilianTariff.payout', 'FCT_Race.ShippingLineTax'],
  note: 'The yearly effect on the treasury of a planned contract: the gross fare (quantity times the published rate times the one-way loaded distance in billion km, as the payout rule gives it, never halved) times the contracts a year; the race takes the tax on it, and for installation cargo it also pays the line\'s receipt, the fare less the tax (halved for a computer-run empire). Trade goods, colonists and passengers carry the tax only.',
  assumptions: ['every unit is carried the whole route one way, loaded', 'the contracts recur at the same rate every year'],
})

registerRule({
  id: 'shippingRunway.scenarioNet',
  versions: VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: ['finances.netPerYear', 'shippingRunway.windowFlow'],
  note: 'The window\'s yearly net with the civilian shipping flows replaced as the scenario states: the logged contracts and the tax paired with them out, the scenario\'s flows in. Every other flow stays as logged. With nothing replaced it is the Finances net itself.',
  assumptions: ['income and spending other than the contracts stay at the window\'s rate', 'the taxes on trade goods, colonists, passengers and fuel stay as logged'],
})

registerRule({
  id: 'shippingRunway.exhaustion',
  versions: VERSIONS,
  units: 'years',
  verification: 'estimated',
  structure: ['FCT_Race.WealthPoints', ...WEALTH_STRUCTURE],
  note: 'When the treasury is exhausted if the yearly net holds at the first figure up to the change and at the second after it: the treasury over the loss in each stretch, by the rule of the Finances runway (the Finances runway rule). A net that is not a loss never exhausts it, and an exhaustion past the horizon is reported as none within the horizon. With one net throughout it is that runway.',
  assumptions: ['the nets hold from now on'],
})

registerRule({
  id: 'shippingRunway.breakEven',
  versions: VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: ['shippingRunway.contractFlow'],
  note: 'The yearly running cost at which government transports of the contracts\' cargo leave the net as it is: the logged contracts less the tax paired with them, which a government transport neither pays nor earns. A running cost below it leaves more in the treasury than the contracts do, one above it less. The running cost itself is never assumed.',
  assumptions: ['the transports carry the whole cargo of the logged contracts'],
})

registerRule({
  id: 'shippingRunway.windowSpread',
  versions: VERSIONS,
  units: 'years',
  verification: 'estimated',
  structure: WEALTH_STRUCTURE,
  note: 'How the exhaustion moves with the window the yearly figures are scaled from: the scenario worked out again from each window the page offers. The spread is the visible part of the uncertainty of the cash flow, not an interval with a probability; unlogged changes, a rate changed within the window and later decisions are outside it.',
  assumptions: ['each window\'s rate holds from now on'],
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

// A number typed in a field: null while the field is blank or is not a number, never 0.
export const typedNumber = (text) => {
  if (typeof text === 'number') {
    return finite(text) ? text : null
  }

  if (typeof text !== 'string' || !text.trim()) {
    return null
  }

  const value = Number(text)

  return finite(value) ? value : null
}

// The race kind as the save stores it: true for a computer-run empire, false for a player's, null for a value that is neither (NULL included), never a player's by default.
const raceKindOf = (stored) => {
  if (typeof stored === 'boolean') {
    return stored
  }

  if (finite(stored)) {
    return stored !== 0
  }

  return null
}

const RACE_COLUMNS = ['ShippingLineTax', 'NPR']

// The race's shipping-line tax rate and kind as the save stores them: { rate, missing, npr }. `rate` is null (and `missing` names why) for a save without the column, without the race or with no value stored; `npr` is null for a save without the column, without the race or with no value stored. Never a default.
export const loadShippingTax = async (database, { GameID, RaceID }) => {
  const [columns] = await database.query('select name from pragma_table_info(\'FCT_Race\')')
  const stored = RACE_COLUMNS.filter((name) => columns.some((column) => column.name === name))

  if (!stored.length) {
    return { rate: null, missing: 'the race\'s shipping line tax', npr: null }
  }

  const [rows] = await database.query(`select ${stored.join(', ')} from FCT_Race where GameID = ${Number(GameID)} and RaceID = ${Number(RaceID)}`)

  if (!rows.length) {
    return { rate: null, missing: 'the race', npr: null }
  }

  const { ShippingLineTax: rate, NPR: kind } = rows[0]
  const tax = !stored.includes('ShippingLineTax') ? { rate: null, missing: 'the race\'s shipping line tax' } : rate === null || rate === undefined ? { rate: null, missing: 'a stored shipping line tax of the race' } : { rate: Number(rate), missing: '' }

  return { ...tax, npr: stored.includes('NPR') ? raceKindOf(kind) : null }
}

// The tax rate set now as a result; unavailable while the read is not in or has no value (`tax` is the object of `loadShippingTax`).
export const taxRateResult = (tax) => (tax && finite(tax.rate) && tax.rate >= 0 ? ofRule({ rule: 'shippingRunway.taxRate', value: tax.rate, inputs: { present: ['FCT_Race.ShippingLineTax'] } }) : unavailable({ rule: 'shippingRunway.taxRate', missing: [tax && tax.missing ? tax.missing : 'the race\'s shipping-line tax rate'] }))

const windowTaxResult = (rate) => combine({ rule: 'shippingRunway.windowTax', parts: { 'the tax rate set now': rate }, compute: (values) => values['the tax rate set now'] })

// The factor on a shipping line's receipt: unavailable for a race kind that is not true or false.
export const kindResult = (npr) => (typeof npr === 'boolean' ? ofRule({ rule: 'shippingRunway.raceKind', value: npr ? NPR_PAYOUT_MODIFIER : 1, inputs: { present: [npr ? 'a computer-run empire, receipts halved' : 'a player\'s race'] } }) : unavailable({ rule: 'shippingRunway.raceKind', missing: [KIND_MISSING] }))

const assumed = (value, label) => ofRule({ rule: 'shippingRunway.assumption', value, inputs: { present: [label] } })

const blank = (label) => unavailable({ rule: 'shippingRunway.assumption', missing: [label] })

// A field of years or wealth: a number of 0 or more is the assumption, anything else is unknown.
const nonNegative = (text, label) => {
  const value = typedNumber(text)

  return value !== null && value >= 0 ? assumed(value, label) : blank(label)
}

// The tax rate of the future as a fraction: the one set now while the field is untouched (`edit` null), else the percentage typed, unknown while it is blank or outside 0 to 100.
export const futureTaxResult = (edit, taxRate) => {
  if (edit === null || edit === undefined) {
    return combine({ rule: 'shippingRunway.assumption', parts: { 'the tax rate set now': taxRate }, compute: (values) => values['the tax rate set now'], assumptions: ['the tax rate set now carries on'] })
  }

  const percent = typedNumber(edit)

  return percent !== null && percent >= 0 && percent <= 100 ? assumed(percent / 100, 'the future tax rate entered') : blank(FUTURE_TAX_MISSING)
}

// The yearly amount a civilian use logged in the window, a result of 'shippingRunway.windowFlow'; 0 for a use with no row in the window.
const flowOf = (ledger, id) => {
  const category = ledger.categories.find((item) => item.id === id)

  return combine({ rule: 'shippingRunway.windowFlow', parts: { coverage: ledger.coverage }, compute: () => (category ? category.perYear : 0), inputs: { present: [category ? 'wealth history' : 'no amount of this use logged in the window'] } })
}

// The civilian uses of the window as yearly results: the contracts the race paid, the taxes it took, the uses no rule books (`legacy`), and their net (taxes less the rest). Every one is unavailable, naming the use, when the wealth use table puts a civilian use on the other side from the one the rules assume.
export const civilianFlows = (ledger) => {
  const gaps = CIVILIAN_USES.filter((use) => {
    const category = ledger.categories.find((item) => item.id === use.id)

    return category && category.income !== (use.side === 'income')
  }).map((use) => `${use.label} on the ${use.side} side of the wealth use table`)

  if (gaps.length) {
    const none = () => unavailable({ rule: 'shippingRunway.windowFlow', missing: gaps })

    return { contracts: none(), taxes: none(), contractTax: none(), legacy: none(), net: none(), gaps }
  }

  const total = (ids) => sumResults({ rule: 'shippingRunway.windowFlow', results: ids.map((id) => flowOf(ledger, id)) })
  const contracts = flowOf(ledger, CONTRACT_USE)
  const taxes = total(TAX_USES)
  const legacy = total(LEGACY_USES)
  const net = combine({ rule: 'shippingRunway.windowFlow', parts: { taxes, contracts, legacy }, compute: (values) => values.taxes - values.contracts - values.legacy })

  return { contracts, taxes, contractTax: flowOf(ledger, CONTRACT_TAX_USE), legacy, net, gaps }
}

// What the window logged apart from civilian shipping: each other use as { id, label, income, yearly }, spending first and the larger first, with the net of all of them (the Finances net less the civilian net).
export const obligations = (ledger, flows) => ({
  uses: ledger.categories.filter((category) => !(category.id in ROLES)).map((category) => ({ id: category.id, label: category.label, income: category.income, yearly: flowOf(ledger, category.id) })).sort((a, b) => Number(a.income) - Number(b.income) || (valueOrNull(b.yearly) ?? -1) - (valueOrNull(a.yearly) ?? -1) || a.label.localeCompare(b.label)),
  rest: combine({ rule: 'shippingRunway.scenarioNet', parts: { net: ledger.net, civilian: flows.net }, compute: (values) => values.net - values.civilian }),
})

const gated = (version) => ruleSupports('shippingRunway.contractFlow', version) !== true

// The pieces of the installation contracts the window logged: the gross fare a year they imply, the tax paired with it, and what the same fares cost and pay once the tax is the future one.
const contractPieces = ({ flows, windowTax, futureTax, kind, version }) => {
  const piece = (parts, compute) => (gated(version) ? unavailable({ rule: 'shippingRunway.contractFlow', missing: [GATE_MISSING] }) : combine({ rule: 'shippingRunway.contractFlow', parts, compute }))
  const taxBelowOne = isAvailable(windowTax) && windowTax.value >= 1 ? unavailable({ rule: 'shippingRunway.windowTax', missing: ['a window tax rate below 100 %'] }) : windowTax
  const raw = piece({ contracts: flows.contracts, windowTax: taxBelowOne, kind }, (values) => values.contracts / (values.kind * (1 - values.windowTax)))
  const covered = isAvailable(raw) && isAvailable(flows.contractTax) && isAvailable(taxBelowOne) && raw.value * taxBelowOne.value > flows.contractTax.value * (1 + 1e-9) + 1e-9
  const gross = covered ? unavailable({ rule: 'shippingRunway.contractFlow', missing: [IMPLIED_MISSING] }) : raw

  return {
    gross,
    pairedTax: piece({ gross, windowTax: taxBelowOne }, (values) => values.gross * values.windowTax),
    resumedSpend: piece({ gross, futureTax, kind }, (values) => values.gross * values.kind * (1 - values.futureTax)),
    resumedTax: piece({ gross, futureTax }, (values) => values.gross * values.futureTax),
  }
}

// The yearly effect of one planned contract, `line` being { category, quantity, distance, perYear } as typed: its tax, and for installation cargo the receipt the race pays.
const lineEffect = (line, { version, futureTax, kind }) => {
  const fare = payoutEstimate({ version, category: line.category, quantity: typedNumber(line.quantity), billionKm: typedNumber(line.distance), npr: false })
  const count = typedNumber(line.perYear)
  const times = count !== null && count >= 0 ? assumed(count, 'the contracts a year') : blank('the number of contracts a year')
  const installation = line.category === 'cargoPoint'

  return combine({
    rule: 'shippingRunway.planLine',
    parts: { fare, times, futureTax, kind },
    compute: (values) => {
      const gross = values.fare * values.times

      return gross * values.futureTax - (installation ? gross * values.kind * (1 - values.futureTax) : 0)
    },
  })
}

const isBlankLine = (line) => [line.quantity, line.distance, line.perYear].every((text) => text === null || text === undefined || String(text).trim() === '')

// The first time the treasury is exhausted when the net is `segments[i].net` for `segments[i].years` in turn: { state: 'covered', years: null } when it never is, { state: 'depleted', years: 0 } when it is empty under a loss now, else { state: 'lasts', years }. One segment of unbounded length is the runway of the Finances page, by the same function.
export const exhaustionOf = (balance, segments) => {
  let left = balance
  let elapsed = 0

  for (const { years, net } of segments) {
    if (!(years > 0)) {
      continue
    }

    const run = runwayOf(left, net)

    if (run.state === 'depleted') {
      return elapsed === 0 ? run : { state: 'lasts', years: elapsed }
    }

    if (run.state === 'lasts' && run.years <= years) {
      return { state: 'lasts', years: elapsed + run.years }
    }

    left += net * years
    elapsed += years
  }

  return { state: 'covered', years: null }
}

// The treasury `year` years from now under the same segments.
export const balanceAt = (balance, segments, year) => {
  let left = balance
  let from = 0

  for (const { years, net } of segments) {
    if (year <= from + years) {
      return left + net * (year - from)
    }

    left += net * years
    from += years
  }

  return left
}

// What an exhaustion means over a horizon: kind 'none' (never, the net is not a loss), 'now' (empty under a loss), 'exhausted' (within the horizon, at `years`), 'beyond' (at `years`, past the horizon) or 'unknown'.
export const verdictOf = (exhaustion, horizon) => {
  const value = valueOrNull(exhaustion)

  if (value === null) {
    return { kind: 'unknown', years: null }
  }

  if (value.state === 'covered') {
    return { kind: 'none', years: null }
  }

  if (value.state === 'depleted') {
    return { kind: 'now', years: 0 }
  }

  return { kind: value.years <= horizon ? 'exhausted' : 'beyond', years: value.years }
}

// The calendar time of an exhaustion `years` after `gameTime`.
export const exhaustionTime = (gameTime, years) => gameTime + years * SECONDS_PER_YEAR

// The years between the grid points of a trajectory: one up to 25 years of horizon, two up to 50, five beyond.
export const stepYears = (horizon) => (horizon <= 25 ? 1 : horizon <= 50 ? 2 : 5)

// The years a trajectory is read at: the grid of the horizon and every time inside it a scenario's net changes, so that a trough between two grid points is a point of the line.
export const trajectoryYears = (scenarios, horizon) => {
  const step = stepYears(horizon)
  const years = new Set()

  for (let year = 0; year <= horizon; year += step) {
    years.add(year)
  }

  scenarios.forEach((scenario) => {
    const segments = scenario.segments || []
    let from = 0

    segments.forEach((segment) => {
      from += segment.years

      if (from > 0 && from <= horizon) {
        years.add(from)
      }
    })
  })

  return [...years].sort((a, b) => a - b)
}

// The treasury at each of `years` under a scenario, [{ year, balance }], or null while the treasury or the net of any stretch is unknown.
export const trajectory = (scenario, treasury, horizon, years = trajectoryYears([scenario], horizon)) => {
  if (!scenario.segments || !isAvailable(treasury) || !scenario.segments.every((segment) => isAvailable(segment.net))) {
    return null
  }

  const segments = scenario.segments.map((segment) => ({ years: segment.years, net: segment.net.value }))

  return years.map((year) => ({ year, balance: balanceAt(treasury.value, segments, year) }))
}

// The past treasury as the log reconstructs it ({ time, balance } per cycle end, from the start of the window), then each scenario's balances at the shared years ahead: { rows: [{ time, year, history, balances }], paths: [{ id, label, points }] }. A row of the past has a `history` balance and no scenario balance, a row ahead the reverse; `year` is relative to `gameTime`.
export const balanceTimeline = ({ ledger, gameTime, scenarios, horizon }) => {
  const series = valueOrNull(ledger.treasurySeries)
  const times = ledger.firstStart === null ? [] : [ledger.firstStart, ...ledger.steps]
  const years = trajectoryYears(scenarios, horizon)
  const paths = scenarios.map((scenario) => ({ id: scenario.id, label: scenario.label, points: trajectory(scenario, ledger.treasury, horizon, years) })).filter((path) => path.points)
  const none = Object.fromEntries(paths.map((path) => [path.id, null]))
  const past = series !== null && series.length === times.length ? times.map((time, index) => ({ time, year: (time - gameTime) / SECONDS_PER_YEAR, history: series[index], balances: none })) : []
  const ahead = years.map((year, index) => ({ time: exhaustionTime(gameTime, year), year, history: null, balances: Object.fromEntries(paths.map((path) => [path.id, path.points[index].balance])) }))

  return { rows: [...past, ...ahead], paths }
}

const settled = (results) => results.every((result) => isAvailable(result))

// The scenarios of one ledger. `inputs` is { futureTax (null while untouched, else the percentage as typed), pauseYears, governmentCost, planStart, lines: [{ category, quantity, distance, perYear }] }, every field as typed. The first scenario, 'none', is the Finances runway itself: its net and its exhaustion are the ledger's own results.
export const buildScenarios = ({ ledger, version, npr, tax, inputs }) => {
  const flows = civilianFlows(ledger)
  const taxRate = taxRateResult(tax)
  const windowTax = windowTaxResult(taxRate)
  const futureTax = futureTaxResult(inputs.futureTax, taxRate)
  const kind = kindResult(npr)
  const pieces = contractPieces({ flows, windowTax, futureTax, kind, version })
  const rest = obligations(ledger, flows)
  const net = (parts, compute) => combine({ rule: 'shippingRunway.scenarioNet', parts, compute })
  const segmentYears = (segment, values, index) => (segment.hold ? values[`stretch ${index + 1}`] : segment.years)
  const exhaustion = (segments) => combine({ rule: 'shippingRunway.exhaustion', parts: Object.assign({ treasury: ledger.treasury }, ...segments.map((segment, index) => ({ [`net ${index + 1}`]: segment.net, ...(segment.hold ? { [`stretch ${index + 1}`]: segment.hold } : {}) }))), compute: (values) => exhaustionOf(values.treasury, segments.map((segment, index) => ({ years: segmentYears(segment, values, index), net: values[`net ${index + 1}`] }))) })
  const shippingNet = (first) => combine({ rule: 'shippingRunway.scenarioNet', parts: { civilian: flows.net, net: first, baseline: ledger.net }, compute: (values) => values.civilian + values.net - values.baseline })
  // The net of the first stretch that lasts: a stretch of 0 years is never in force, so it is not the net now. Unavailable while the length of a stretch before it is unknown.
  const inForce = (segments) => {
    const parts = {}

    for (let index = 0; index < segments.length; index++) {
      const { hold, years } = segments[index]

      if (hold) {
        parts[`stretch ${index + 1}`] = hold
      }

      if ((hold ? hold.value : years) > 0 || index === segments.length - 1) {
        parts.net = segments[index].net

        break
      }
    }

    return combine({ rule: 'shippingRunway.scenarioNet', parts, compute: (values) => values.net })
  }
  // `focus` is the stretch the shipping net and the change are read from: the one in force now, or (focus 1) the stretch after the first, which is future.
  const scenario = (id, label, changes, assumptions, segments, focus = 0) => {
    const now = inForce(segments)
    const shown = focus ? segments[focus].net : now
    const known = settled(segments.map((segment) => segment.net)) && segments.every((segment) => !segment.hold || isAvailable(segment.hold))

    return { id, label, changes, assumptions, focus: focus ? 'later' : 'now', segments: known ? segments.map((segment) => ({ years: segment.hold ? segment.hold.value : segment.years, net: segment.net })) : null, net: now, later: segments[segments.length - 1].net, shipping: shippingNet(shown), change: net({ net: shown, baseline: ledger.net }, (values) => values.net - values.baseline), exhaustion: exhaustion(segments) }
  }

  const pause = nonNegative(inputs.pauseYears, 'the years the contracts are paused')
  const running = nonNegative(inputs.governmentCost, 'the yearly running cost of the government transports')
  const start = nonNegative(inputs.planStart, 'the years before the new contracts start')
  const paused = net({ net: ledger.net, contracts: flows.contracts, pairedTax: pieces.pairedTax }, (values) => values.net + values.contracts - values.pairedTax)
  const resumed = net({ net: ledger.net, contracts: flows.contracts, pairedTax: pieces.pairedTax, spend: pieces.resumedSpend, tax: pieces.resumedTax }, (values) => values.net + values.contracts - values.pairedTax - values.spend + values.tax)
  const governed = net({ net: ledger.net, contracts: flows.contracts, pairedTax: pieces.pairedTax, running }, (values) => values.net + values.contracts - values.pairedTax - values.running)
  const entered = inputs.lines.filter((line) => !isBlankLine(line))
  const effect = entered.length ? sumResults({ rule: 'shippingRunway.planLine', results: entered.map((line) => lineEffect(line, { version, futureTax, kind })) }) : unavailable({ rule: 'shippingRunway.planLine', missing: ['a new contract entered'] })
  const planned = net({ base: resumed, effect }, (values) => values.base + values.effect)
  const breakEven = combine({ rule: 'shippingRunway.breakEven', parts: { contracts: flows.contracts, pairedTax: pieces.pairedTax }, compute: (values) => values.contracts - values.pairedTax })

  const none = { id: 'none', label: 'No change', changes: 'The window\'s flows carry on as logged.', assumptions: ['income and spending stay at the window\'s rate'], focus: 'now', segments: [{ years: Infinity, net: ledger.net }], net: ledger.net, later: ledger.net, shipping: flows.net, change: ofRule({ rule: 'shippingRunway.scenarioNet', value: 0, inputs: { present: ['the Finances net'] } }), exhaustion: ledger.runway }

  return {
    flows,
    rest,
    taxRate,
    windowTax,
    futureTax,
    kind,
    pieces,
    breakEven,
    pause,
    running,
    start,
    effect,
    scenarios: [
      none,
      scenario('delay', 'Contracts delayed', 'Installation contracts and the tax paired with them stop for the pause, then resume at the future tax rate.', ['the pause entered', 'the future tax rate'], [{ hold: pause, net: paused }, { years: Infinity, net: resumed }]),
      scenario('government', 'Government transports', 'Government transports carry the installations: no contract, no paired tax, and the running cost entered.', ['the running cost entered'], [{ years: Infinity, net: governed }]),
      scenario('plan', 'New contracts', 'The planned contracts start after the delay entered, over the contracts as logged at the future tax rate.', ['the planned contracts', 'the start entered', 'the future tax rate'], [{ hold: start, net: resumed }, { years: Infinity, net: planned }], 1),
    ],
  }
}

// Each window's ledger of the same treasury and wealth rows: `ledger` is the selected one as the page built it (kept as that very object), the others are built here.
export const windowLedgers = ({ treasury, wealth, windowDays, ledger, options }) => [...new Set([...options, windowDays])].sort((a, b) => a - b).map((days) => ({ days, ledger: days === windowDays ? ledger : buildLedger({ treasury, wealth, windowDays: days }) }))

// How soon an exhaustion comes, for ordering: null while unknown, 0 for a treasury already empty, the years otherwise, Infinity for never.
const orderOf = (exhaustion) => {
  const value = valueOrNull(exhaustion)

  return value === null ? null : value.state === 'covered' ? Infinity : value.state === 'depleted' ? 0 : value.years
}

// The earliest and the latest exhaustion of a scenario across the windows: { earliest: { days, order }, latest: { days, order }, known, total }, order as `orderOf`. Unavailable when no window gives a figure.
export const windowSpread = (sets, id) => {
  const rows = sets.map((set) => ({ days: set.days, result: set.built.scenarios.find((scenario) => scenario.id === id).exhaustion }))
  const known = rows.map((row) => ({ days: row.days, order: orderOf(row.result), result: row.result })).filter((row) => row.order !== null)

  if (!known.length) {
    return unavailable({ rule: 'shippingRunway.windowSpread', missing: ['a window with an exhaustion figure'] })
  }

  const sorted = known.slice().sort((a, b) => a.order - b.order)
  const unknown = rows.filter((row) => orderOf(row.result) === null).map((row) => `${row.days} d window`)

  return envelope({
    value: { earliest: { days: sorted[0].days, order: sorted[0].order }, latest: { days: sorted[sorted.length - 1].days, order: sorted[sorted.length - 1].order }, known: known.length, total: rows.length },
    status: weakestStatus(['estimated', ...known.map((row) => row.result.status)].filter((status) => status !== STATUS.UNAVAILABLE)),
    rule: 'shippingRunway.windowSpread',
    inputs: { present: known.map((row) => `${row.days} d window`), missing: unknown },
    assumptions: [...new Set(known.flatMap((row) => row.result.assumptions))],
  })
}

// Everything the panel shows: the scenarios over the selected window (`windowDays`) with their spread across the windows of `windows` (from `windowLedgers`).
export const buildShippingRunway = ({ windows, windowDays, version, npr, tax, inputs }) => {
  const sets = windows.map(({ days, ledger }) => ({ days, built: buildScenarios({ ledger, version, npr, tax, inputs }) }))
  const main = sets.find((set) => set.days === windowDays) || sets[0]

  return { ...main.built, horizon: inputs.horizon, windowDays: main.days, spread: Object.fromEntries(main.built.scenarios.map((scenario) => [scenario.id, windowSpread(sets, scenario.id)])), windows: sets.map((set) => set.days) }
}
