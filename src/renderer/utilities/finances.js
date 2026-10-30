// The wealth ledger behind the Finances page: the treasury, the income and spending of each production cycle by use, and what follows from them (yearly totals, the treasury's runway, the cycle length). Every figure is a provenance result (utilities/provenance.js): a missing input, such as no wealth history, gives an unavailable result, never a 0.

import { STATUS, STATUS_MARKS, combine, envelope, getRule, ofRule, registerRule, unavailable, valueOrNull, weakestStatus } from './provenance'

export const SECONDS_PER_DAY = 86400
// The save keeps one year of wealth history: the span a yearly figure is scaled to.
export const HISTORY_DAYS = 365
// The cycle length taken when the history holds a single cycle end, so no length can be measured.
export const DEFAULT_STEP_DAYS = 5
const VERSIONS = ['2.7.x']
const WEALTH_STRUCTURE = ['FCT_WealthData.UseID, TimeUsed, Amount', 'DIM_WealthUse.Description, Income, DisplayOrder', 'FCT_Game.GameTime']

registerRule({
  id: 'finances.treasury',
  versions: VERSIONS,
  units: 'wealth',
  verification: 'confirmed',
  structure: ['FCT_Race.WealthPoints'],
  note: 'The race\'s stored treasury, shown as saved. A save whose treasury is empty gives no figure, not a treasury of 0.',
})

registerRule({
  id: 'finances.stepLedger',
  versions: VERSIONS,
  units: 'wealth per cycle',
  verification: 'confirmed',
  structure: WEALTH_STRUCTURE,
  note: 'A cycle\'s income, spending and net are the stored amounts of its uses added up, income by the use\'s Income flag. Arithmetic on stored values; it holds only what the game logs as income or spending.',
})

registerRule({
  id: 'finances.cycleDays',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_WealthData.TimeUsed'],
  note: 'The cycle length is the shortest gap between the logged cycle ends. In the modded save every one of 73 gaps is 5 days; in the stock sample save the 723 gaps run from 30 minutes to about 2 days, so there the shortest gap is not one cycle length and the longest gap is shown beside it. One logged cycle end has no gap to measure, so a default length is assumed.',
})

registerRule({
  id: 'finances.coverage',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_WealthData.TimeUsed', 'FCT_Game.GameTime'],
  note: 'The time the logged cycles of the window span, from the end before the first one to the last end. The first cycle of a save has no earlier end, so it is taken as long as the one after it, and a window of one cycle without an earlier end takes a default length.',
})

registerRule({
  id: 'finances.windowChange',
  versions: VERSIONS,
  units: 'wealth',
  verification: 'estimated',
  structure: WEALTH_STRUCTURE,
  note: 'The net of every logged cycle in the window added up. It is the ledger\'s change, not a stored change of the treasury: the save keeps no earlier treasury to compare it with.',
})

registerRule({
  id: 'finances.categoryPerYear',
  versions: VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: WEALTH_STRUCTURE,
  note: 'The window\'s total scaled to 365 days by the time the window spans. Over the 30 days to today the modded save\'s scaled income was within 0.01% of the stored annual wealth figure (26324711 against 26325265); over 365 days it was 0.8% under. In the stock sample save the scaled income was 9% to 12% above the stored figure (256977 to 265046 against 237291), so the two do not agree there; the stored figure\'s own definition is not known here.',
  assumptions: ['the rate over the window holds for a year'],
})

registerRule({
  id: 'finances.netPerYear',
  versions: VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: WEALTH_STRUCTURE,
  note: 'The yearly income less the yearly spending, both scaled from the window. Arithmetic on the two yearly figures; the saves hold no stored net to compare it with.',
  assumptions: ['the rate over the window holds for a year'],
})

registerRule({
  id: 'finances.treasuryRunway',
  versions: VERSIONS,
  units: 'years',
  verification: 'estimated',
  structure: ['FCT_Race.WealthPoints', ...WEALTH_STRUCTURE],
  note: 'The treasury over the yearly shortfall, when the net is negative and the treasury positive; a net of zero or more never empties the treasury, and an empty or negative treasury under a negative net is depleted. Inherits the net\'s estimate; not checked against a later save.',
  assumptions: ['income and spending stay at the window\'s rate'],
})

registerRule({
  id: 'finances.categoryShare',
  versions: VERSIONS,
  units: 'fraction',
  verification: 'confirmed',
  structure: WEALTH_STRUCTURE,
  note: 'A use\'s share of its own side: its window total over the total of the income uses, or of the spending uses. Arithmetic on stored amounts; no share when the side has nothing logged.',
})

registerRule({
  id: 'finances.treasurySeries',
  versions: VERSIONS,
  units: 'wealth',
  verification: 'estimated',
  structure: ['FCT_Race.WealthPoints', ...WEALTH_STRUCTURE],
  note: 'The balance after each cycle: today\'s treasury less every later cycle\'s net. The save keeps no earlier treasury, so the series is not compared with a stored balance, and it misses whatever the game does not log as income or spending.',
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const absent = (rule, missing) => unavailable({ rule, missing: [missing] })

// A result at the rule's verification, or at the weaker of that and 'assumed' when this run made assumptions.
const resultOf = ({ rule, value, inputs, assumptions = [] }) => (assumptions.length ? envelope({ value, status: weakestStatus([getRule(rule).verification, STATUS.ASSUMED]), rule, inputs, assumptions }) : ofRule({ rule, value, inputs }))

const sortedUnique = (values) => [...new Set(values)].sort((a, b) => a - b)

// The treasury as a result; unavailable when the race has no stored treasury.
export const treasuryResult = (row) => (row && finite(row.WealthPoints) ? ofRule({ rule: 'finances.treasury', value: row.WealthPoints, inputs: { present: ['treasury'] } }) : absent('finances.treasury', 'treasury'))

// What a treasury `balance` does under a constant yearly net `rate`: covered while the net is not a loss (even in debt), depleted when the treasury is empty or negative under a loss, else it lasts the balance over the loss. The one rule the Finances runway and every scenario built on it use.
export const runwayOf = (balance, rate) => (rate >= 0 ? { state: 'covered', years: null } : balance > 0 ? { state: 'lasts', years: balance / -rate } : { state: 'depleted', years: 0 })

// The cycle length: the shortest gap between the logged cycle ends, and the longest of them (the one length when the history holds a single end).
const cycleOf = (times) => {
  const gaps = times.slice(1).map((time, index) => (time - times[index]) / SECONDS_PER_DAY).filter((gap) => gap > 0)

  if (gaps.length) {
    return { result: ofRule({ rule: 'finances.cycleDays', value: Math.min(...gaps), inputs: { present: ['wealth history'] } }), longest: Math.max(...gaps) }
  }

  if (times.length) {
    const assumption = `a ${DEFAULT_STEP_DAYS} day cycle: the wealth history holds a single cycle end, so no length can be measured`

    return { result: envelope({ value: DEFAULT_STEP_DAYS, status: STATUS.ASSUMED, rule: 'finances.cycleDays', inputs: { present: ['wealth history'] }, assumptions: [assumption] }), longest: DEFAULT_STEP_DAYS }
  }

  return { result: absent('finances.cycleDays', 'wealth history'), longest: null }
}

// The time the window's cycles span: from the logged end before the first one, else a first cycle as long as the one after it, else the default length.
const coverageOf = (steps, times) => {
  const before = times.filter((time) => time < steps[0]).pop()
  const last = steps[steps.length - 1]
  let start = before
  let status = STATUS.ESTIMATED
  const assumptions = []

  if (start === undefined && steps.length > 1) {
    start = steps[0] - (steps[1] - steps[0])
    assumptions.push('the first logged cycle is as long as the one after it')
  } else if (start === undefined) {
    start = steps[0] - DEFAULT_STEP_DAYS * SECONDS_PER_DAY
    status = STATUS.ASSUMED
    assumptions.push(`a ${DEFAULT_STEP_DAYS} day first cycle: the wealth history holds a single cycle end, so no length can be measured`)
  }

  const days = (last - start) / SECONDS_PER_DAY

  if (!finite(days) || days <= 0) {
    return { start, result: absent('finances.coverage', 'cycle length') }
  }

  return { start, result: envelope({ value: days, status, rule: 'finances.coverage', inputs: { present: ['wealth history'] }, assumptions }) }
}

const shareOf = (total, sideTotal) => (sideTotal > 0 ? ofRule({ rule: 'finances.categoryShare', value: total / sideTotal, inputs: { present: ['wealth history'] } }) : absent('finances.categoryShare', 'amounts logged above zero on the side'))

const emptyLedger = (treasury, missing, cycle) => {
  const reason = (rule) => absent(rule, missing)

  return {
    treasury: treasuryResult(treasury),
    missing,
    cycle,
    longestCycleDays: null,
    times: [],
    steps: [],
    firstStart: null,
    coverage: reason('finances.coverage'),
    categories: [],
    windowChange: reason('finances.windowChange'),
    stepLedger: reason('finances.stepLedger'),
    income: reason('finances.categoryPerYear'),
    spending: reason('finances.categoryPerYear'),
    net: reason('finances.netPerYear'),
    runway: reason('finances.treasuryRunway'),
    biggest: null,
    amountsByStep: {},
    netByStep: [],
    treasurySeries: reason('finances.treasurySeries'),
    assumptions: [],
  }
}

// The ledger of the last `windowDays` days: `treasury` is the FCT_Race and FCT_Game row ({ WealthPoints, AnnualWealth, GameTime, StartYear }), `wealth` the per-use, per-cycle rows ({ UseID, Description, Income (null when the use is not in DIM_WealthUse), DisplayOrder, TimeUsed, Amount }). Calculations run on plain numbers; results are built once per figure shown.
export const buildLedger = ({ treasury, wealth, windowDays }) => {
  const times = sortedUnique(wealth.map((row) => row.TimeUsed))
  const cycle = cycleOf(times)
  const gameTime = treasury && finite(treasury.GameTime) ? treasury.GameTime : null
  const windowRows = gameTime === null ? [] : wealth.filter((row) => row.TimeUsed > gameTime - windowDays * SECONDS_PER_DAY)
  const missing = !wealth.length ? 'wealth history' : gameTime === null ? 'game time' : !windowRows.length ? 'wealth history in the window' : windowRows.some((row) => !finite(row.Amount) || !finite(row.TimeUsed)) ? 'wealth amounts' : null

  if (missing) {
    return { ...emptyLedger(treasury, missing, cycle.result), times }
  }

  const steps = sortedUnique(windowRows.map((row) => row.TimeUsed))
  const { start: firstStart, result: coverage } = coverageOf(steps, times)
  const byId = {}
  const amountsByStep = {}

  windowRows.forEach((row) => {
    const category = (byId[row.UseID] = byId[row.UseID] || { id: row.UseID, label: row.Description, income: row.Income === null || row.Income === undefined ? false : !!row.Income, unmatched: row.Income === null || row.Income === undefined, order: row.DisplayOrder ?? 999, total: 0 })
    const step = (amountsByStep[row.TimeUsed] = amountsByStep[row.TimeUsed] || {})

    category.total += row.Amount
    step[row.UseID] = (step[row.UseID] || 0) + row.Amount
  })

  const sorted = Object.values(byId).sort((a, b) => b.income - a.income || a.order - b.order)
  const incomeTotal = sorted.filter((category) => category.income).reduce((sum, category) => sum + category.total, 0)
  const spendingTotal = sorted.filter((category) => !category.income).reduce((sum, category) => sum + category.total, 0)
  const unmatched = sorted.filter((category) => category.unmatched).map((category) => category.label)
  const signAssumptions = unmatched.length ? [`${unmatched.join(', ')} ${unmatched.length === 1 ? 'is' : 'are'} not in the wealth use table, so ${unmatched.length === 1 ? 'it counts' : 'they count'} as spending`] : []
  const inputs = { present: ['wealth history'] }
  const perYearFactor = valueOrNull(coverage) === null ? null : HISTORY_DAYS / coverage.value
  const categories = sorted.map((category) => {
    const sideTotal = category.income ? incomeTotal : spendingTotal
    const shareResult = shareOf(category.total, sideTotal)
    const share = valueOrNull(shareResult)

    return {
      ...category,
      perYear: perYearFactor === null ? null : category.total * perYearFactor,
      share,
      shareResult,
      // Each bar is the category's share of its own side, so small spending still reads; a side with nothing logged has no bar.
      barWidth: share === null ? 0 : share * 100,
    }
  })
  const side = (income) => combine({ rule: 'finances.categoryPerYear', parts: { coverage }, compute: () => categories.filter((category) => category.income === income).reduce((sum, category) => sum + category.perYear, 0), inputs, assumptions: income ? [] : signAssumptions })
  const incomeResult = side(true)
  const spendingResult = side(false)
  const net = combine({ rule: 'finances.netPerYear', parts: { income: incomeResult, spending: spendingResult }, compute: ({ income, spending }) => income - spending })
  // Read the step amounts once per category and cycle.
  const netByStep = steps.map((time) => categories.reduce((sum, category) => sum + (category.income ? 1 : -1) * ((amountsByStep[time] || {})[category.id] || 0), 0))
  const stepLedger = resultOf({ rule: 'finances.stepLedger', value: netByStep, inputs, assumptions: signAssumptions })
  const windowChange = resultOf({ rule: 'finances.windowChange', value: netByStep.reduce((sum, value) => sum + value, 0), inputs, assumptions: signAssumptions })
  const treasuryRes = treasuryResult(treasury)
  const runway = combine({
    rule: 'finances.treasuryRunway',
    parts: { treasury: treasuryRes, net },
    compute: ({ treasury: balance, net: rate }) => runwayOf(balance, rate),
  })
  const biggestCategory = spendingTotal > 0 ? categories.filter((category) => !category.income).sort((a, b) => b.total - a.total)[0] : null
  const treasurySeries = combine({
    rule: 'finances.treasurySeries',
    parts: { treasury: treasuryRes, ledger: stepLedger },
    compute: ({ treasury: end, ledger }) => {
      // Balance after each cycle: today's treasury less every later cycle's net; the first entry is the balance before the first cycle.
      let balance = end
      const balances = ledger.slice().reverse().map((rate) => {
        const after = balance

        balance -= rate

        return after
      }).reverse()

      return [balance, ...balances]
    },
  })

  return {
    treasury: treasuryRes,
    missing: null,
    cycle: cycle.result,
    longestCycleDays: cycle.longest,
    times,
    steps,
    firstStart,
    coverage,
    categories,
    windowChange,
    stepLedger,
    income: incomeResult,
    spending: spendingResult,
    net,
    runway,
    biggest: biggestCategory,
    amountsByStep,
    netByStep,
    treasurySeries,
    assumptions: signAssumptions,
  }
}

// A result in a few words for a chart tooltip: its status and rule.
export const statusText = (result) => (result ? `${STATUS_MARKS[result.status].label}: ${result.rule.id}` : '')

// Why a figure is missing, for a note under a dash: "No wealth history".
export const reasonText = (result) => {
  const missing = result && result.inputs ? result.inputs.missing : []

  return missing.length ? `No ${missing.join(' or ')}` : 'Unavailable'
}
