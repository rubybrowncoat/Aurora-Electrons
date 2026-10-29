// Observed stock rates and cautious depletion estimates of the Empire History page: for one stock (fuel, maintenance supplies, a mineral, the treasury) of the empire or of one followed colony, the change per elapsed game year over a chosen window of recorded snapshots, and, only where the observations support it, about when the stock would reach 0 if it kept changing at that rate. Pure: it reads the snapshots and the colony record it is given (utilities/history.js, utilities/colony-series.js) and draws nothing.
//
// What a snapshot holds is a sample of the save at its game time and nothing between two saves, so every figure here is a statement about the observations of the window:
// - the rate is the net change between the first and the last observation of the window divided by the game time between them (a game year is 365 days), from the actual times of the snapshots, however unevenly they are spaced; observations at one game time count once, so no rate divides by a time of 0;
// - a stock that was not recorded (an older record, a colony that left the save or changed hands, a read that failed) is an unavailable observation, never 0, and is not a sample of the rate;
// - the series is classified: no observation, one observation, a baseline of 0, a stock already at 0, too few observations, flat or rising, a step (a transfer or spending) far larger than the other changes, a decline too slow to end within the horizon, or an ordinary decline; only the last has a depletion estimate, and it is an estimate: a window's average rate carried forward, not a prediction that the stock will run out.

import { COLONY_COLUMNS, COLONY_STATE_TEXT, COLONY_STATES } from './colony-series'
import { csvCell } from './csv-cell'
import { durationText, mineralResult, snapshotResult } from './history'
import { UNKNOWN_TEXT, countText, isKnownNumber } from './math'
import { MINERALS } from './minerals'
import { combine, exportFields, isAvailable, ofRule, registerRule, unavailable, valueOrNull } from './provenance'

const STOCK_VERSIONS = ['2.7.x']

// A game year as the history's time axis counts it (utilities/history.js `history.timeAxis`).
export const YEAR_SECONDS = 31536000

// The fewest observations at different game times a depletion estimate rests on: two observations give a rate and no more.
export const MIN_SAMPLES = 3

// A change between two neighbouring observations is a step (a transfer or spending, not a steady drain) when it is at least this share of the larger of the two stocks and its rate per game year is at least `SPIKE_RATIO` times the median rate of the window's other changes.
export const SPIKE_SHARE = 0.5

export const SPIKE_RATIO = 4

// A decline whose estimate falls more than this many game years after the last observation has no date: the window's average says nothing that far ahead.
export const HORIZON_YEARS = 1000

// How far back a window reaches, in game years before the latest snapshot of the record; 0 is every retained snapshot.
export const WINDOWS = Object.freeze([1, 2, 5, 10, 25, 0])

export const DEFAULT_WINDOW = 5

export const SCOPES = Object.freeze({ EMPIRE: 'empire', COLONY: 'colony' })

registerRule({
  id: 'stockRates.colonyStock',
  versions: STOCK_VERSIONS,
  units: 't, L, MSP',
  verification: 'confirmed',
  structure: ['FCT_Population.FuelStockpile, MaintenanceStockpile, Duranium to Gallicite'],
  note: 'The stockpile of one followed colony (fuel, maintenance supplies or one mineral) as the save showed it when the colony series took its observation. A save that did not show the colony as the one chosen (gone, held by another race, on another body, not read) or a colony with no stored amount gives no figure.',
})

registerRule({
  id: 'stockRates.rate',
  versions: STOCK_VERSIONS,
  units: 'per game year',
  verification: 'confirmed',
  structure: ['two observations of a stock in the app\'s history file', 'their game times'],
  note: 'The change of a stock between two recorded observations divided by the game time between them in game years of 365 days, from the snapshots\' own game times. It says nothing of what happened between the two observations, and two observations at one game time give no rate.',
})

registerRule({
  id: 'stockRates.relativeRate',
  versions: STOCK_VERSIONS,
  units: '% per game year',
  verification: 'confirmed',
  structure: ['the rate of a stock', 'its first observation in the window'],
  note: 'The rate of a stock as a percentage of the size of its first observation in the window per game year. It is unknown where the rate is and undefined where the first observation is 0, which no percentage is taken of.',
})

registerRule({
  id: 'stockRates.depletion',
  versions: STOCK_VERSIONS,
  units: 'game years',
  verification: 'estimated',
  structure: ['the rate of a stock over the window', 'its last observation'],
  note: 'The game years after the last observation at which the stock would reach 0 if it went on changing at the rate observed over the window: the last observed stock over the rate of decline. It is an estimate from the snapshots taken and is given only for a series that declines over at least three observations without a step far larger than its other changes, without both a large rise and a large fall that cancel, and ends within 1,000 game years. It is not a prediction that the stock will run out.',
  assumptions: ['the stock keeps changing at the average rate observed over the window', 'no delivery, transfer or spending other than those already seen in the window changes the stock', 'the estimate comes from observations only and is not a guarantee that the stock runs out'],
})

registerRule({
  id: 'stockRates.depletionEarliest',
  versions: STOCK_VERSIONS,
  units: 'game years',
  verification: 'estimated',
  structure: ['the fastest decline between two neighbouring observations in the window', 'its last observation'],
  note: 'The game years after the last observation at which the stock would reach 0 if it declined at the fastest rate seen between two neighbouring observations of the window: the cautious, earlier bound beside the estimate from the window\'s average. Given only where the estimate is. It is not a prediction that the stock will run out.',
  assumptions: ['the stock declines at the fastest rate seen between two neighbouring observations of the window', 'no delivery, transfer or spending other than those already seen in the window changes the stock', 'the estimate comes from observations only and is not a guarantee that the stock runs out'],
})

// The stocks the snapshots hold: `empire` is the field of an empire snapshot (a mineral is read by its ID), `colony` the column of a colony record, and null where the record does not keep it.
export const STOCKS = Object.freeze([
  { key: 'fuel', label: 'Fuel', unit: 'L', empire: 'fuel', colony: 'fuel' },
  { key: 'msp', label: 'Maintenance supplies', unit: 'MSP', empire: 'msp', colony: 'msp' },
  ...MINERALS.map((mineral) => ({ key: mineral.name, label: mineral.name, unit: 't', mineral: mineral.id, empire: 'minerals', colony: mineral.name })),
  { key: 'wealth', label: 'Treasury', unit: 'wealth', empire: 'wealth', colony: null },
])

export const stockOf = (key) => STOCKS.find((stock) => stock.key === key) || null

// The stocks one scope can show: the treasury is the empire's only.
export const stocksOf = (scope) => STOCKS.filter((stock) => (scope === SCOPES.COLONY ? stock.colony !== null : true))

const isTime = (value) => typeof value === 'number' && Number.isFinite(value)

// ---- Observations ----------------------------------------------------------------------------------------------------

// One stock of an empire snapshot as a result of the history's own rule, unavailable (naming the field) when the snapshot lacks it.
const empireResult = (snapshot, stock) => (stock.mineral ? mineralResult(snapshot, stock.mineral, stock.label) : snapshotResult(snapshot, stock.empire))

// The observations of an empire stock: one { t, result } for each snapshot, oldest first as given.
export const empireObservations = (snapshots, stock) => snapshots.map((snapshot) => ({ t: snapshot.t, result: empireResult(snapshot, stock) }))

// One followed colony's stock in a colony snapshot's entry `[PopulationID, state, ...values]`: the stored amount when the save showed the colony as chosen, else unavailable, naming why.
const colonyResult = (entry, stock, columns) => {
  const label = `${stock.label} stockpile of colony ${entry[0]}`

  if (entry[1] !== COLONY_STATES.OBSERVED) {
    return unavailable({ rule: 'stockRates.colonyStock', missing: [`${label} (${COLONY_STATE_TEXT[entry[1]] || 'not observed'})`], units: stock.unit })
  }

  const value = entry[2 + columns.indexOf(stock.colony)]

  return isKnownNumber(value) ? ofRule({ rule: 'stockRates.colonyStock', value: Number(value), inputs: { present: [label] }, units: stock.unit }) : unavailable({ rule: 'stockRates.colonyStock', missing: [label], units: stock.unit })
}

// The observations of one colony's stock in a race's colony record (`{ snapshots }`): a { t, result } for each snapshot that holds an entry for the colony, a snapshot taken before it was followed or after it was dropped having none. `columns` are the record's column names.
export const colonyObservations = (record, colonyId, stock, columns = COLONY_COLUMNS) => (record && Array.isArray(record.snapshots) && stock.colony !== null && columns.includes(stock.colony) ? record.snapshots.flatMap((snapshot) => {
  const entry = Array.isArray(snapshot.colonies) ? snapshot.colonies.find((candidate) => Array.isArray(candidate) && candidate[0] === colonyId) : null

  return entry ? [{ t: snapshot.t, result: colonyResult(entry, stock, columns) }] : []
}) : [])

// The game time of the latest snapshot of a record, which a window counts back from; null when it holds none.
export const latestOf = (snapshots) => {
  const times = (Array.isArray(snapshots) ? snapshots : []).map((snapshot) => snapshot.t).filter(isTime)

  return times.length ? Math.max(...times) : null
}

// ---- Analysis --------------------------------------------------------------------------------------------------------

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// The observations in time order with those at one game time counted once: the later one given stands, except that an observation of a stock never replaces one that was recorded. `duplicates` is how many were left out.
const distinct = (observations) => {
  const ordered = observations.filter((observation) => isTime(observation.t)).map((observation, index) => ({ observation, index })).sort((a, b) => a.observation.t - b.observation.t || a.index - b.index).map(({ observation }) => observation)
  const kept = []

  ordered.forEach((observation) => {
    const last = kept[kept.length - 1]

    if (!last || last.t !== observation.t) {
      kept.push(observation)
    } else if (isAvailable(observation.result) || !isAvailable(last.result)) {
      kept[kept.length - 1] = observation
    }
  })

  return { kept, duplicates: ordered.length - kept.length }
}

const MISSING = Object.freeze({
  unknown: 'an observation of the stock in the window',
  single: 'a second observation at another game time',
  'zero-baseline': 'a first observation above 0',
  empty: 'a stock above 0 at the last observation',
  insufficient: `at least ${MIN_SAMPLES} observations at different game times`,
  nondeclining: 'a declining stock',
  spike: 'a steady decline without a transfer or spending step',
  volatile: 'a window without large opposing changes (deliveries, transfers or spending that cancel)',
  distant: `a decline that ends within ${HORIZON_YEARS} game years`,
})

// How each kind of series reads in one word.
export const KIND_TEXT = Object.freeze({
  unknown: 'no observation',
  single: 'one observation',
  'zero-baseline': 'baseline of 0',
  empty: 'at 0 already',
  insufficient: 'too few observations',
  nondeclining: 'flat or rising',
  spike: 'a step, not a steady decline',
  volatile: 'large opposing changes',
  distant: 'declining too slowly',
  declining: 'declining',
})

const defaultFormat = (value, decimals = 0) => countText(value, decimals)

const defaultDate = (seconds) => String(seconds)

// The window as words: how far back it reaches from the latest snapshot and the dates it spans, a start before the game's own start read as the start.
const windowText = (years, from, latest, date) => (latest === null ? 'no snapshot is recorded' : years ? `the last ${years} game ${years === 1 ? 'year' : 'years'} before the latest snapshot (${date(Math.max(from, 0))} to ${date(latest)})` : `every retained snapshot, up to the latest (${date(latest)})`)

// The analysis of one series of observations over a window of `years` game years back from `latest` (0 is all): { stock, scope, window, rows, first, last, basis, gaps, intervals, kind, reason, rate, relative, depletion, earliest, notes, assumptions }.
// - `observations` are { t, result }, as `empireObservations` and `colonyObservations` give; those before the window's start are left out;
// - `rows` is every distinct game time in the window, { t, value, result, seconds, change, rate, spike } with the figures against the previous recorded observation (null for the first and for an observation that was not recorded) and `value` null where the stock was not recorded;
// - `rate`, `relative`, `depletion` and `earliest` are results (utilities/provenance.js), unavailable with the reason in `reason` where the observations do not support them; `depletion.value` is game years after the last observation, `depletionAt` the game time that is (null with no estimate);
// - `assumptions` and `notes` are the lines a chart, a table and an export carry beside the figures: window, first and last observation, sampling and the assumptions in force.
// `format(value, decimals)` writes a figure, `date(seconds)` a game time and `retention` is the history's own note on its sampling and thinning, kept in the notes as given.
export const analyseStock = ({ stock, scope = { kind: SCOPES.EMPIRE, name: '' }, observations, latest, years = DEFAULT_WINDOW, format = defaultFormat, date = defaultDate, retention = '' }) => {
  const from = years && latest !== null ? latest - years * YEAR_SECONDS : null
  const inWindow = observations.filter((observation) => isTime(observation.t) && (from === null || observation.t >= from) && (latest === null || observation.t <= latest))
  const { kept, duplicates } = distinct(inWindow)
  const rowsBase = kept.map((observation) => ({ t: observation.t, value: valueOrNull(observation.result), result: observation.result }))
  const known = rowsBase.filter((row) => row.value !== null)
  const unit = stock.unit
  const perYear = `${unit}/yr`
  const number = (value) => format(value, Math.abs(value) < 100 ? 1 : 0)
  const signed = (value) => (value > 0 ? `+${number(value)}` : value < 0 ? `−${number(-value)}` : number(value))
  const first = known.length ? known[0] : null
  const last = known.length ? known[known.length - 1] : null
  const windowLine = `Window: ${windowText(years, from, latest, date)}.`

  const intervals = known.slice(1).map((later, index) => {
    const earlier = known[index]
    const seconds = later.t - earlier.t
    const rate = combine({ rule: 'stockRates.rate', parts: { earlier: earlier.result, later: later.result }, compute: ({ earlier: before, later: after }) => (after - before) / (seconds / YEAR_SECONDS), units: perYear })

    return { from: earlier.t, to: later.t, seconds, change: later.value - earlier.value, rate, spike: false, large: false }
  })

  intervals.forEach((interval, index) => {
    const others = intervals.filter((_other, position) => position !== index).map((other) => Math.abs(other.rate.value))
    const larger = Math.max(Math.abs(known[index].value), Math.abs(known[index + 1].value))

    interval.large = larger > 0 && Math.abs(interval.change) >= SPIKE_SHARE * larger
    interval.spike = others.length > 0 && interval.large && Math.abs(interval.rate.value) >= SPIKE_RATIO * median(others)
  })

  const elapsed = first && last ? (last.t - first.t) / YEAR_SECONDS : 0
  const rate = known.length >= 2 ? combine({ rule: 'stockRates.rate', parts: { first: first.result, last: last.result }, compute: ({ first: before, last: after }) => (after - before) / elapsed, units: perYear, assumptions: [`the window is ${windowText(years, from, latest, date)}`] }) : unavailable({ rule: 'stockRates.rate', missing: [known.length ? MISSING.single : MISSING.unknown], units: perYear })
  const rateValue = valueOrNull(rate)
  const fastest = intervals.filter((interval) => interval.rate.value < 0).sort((a, b) => a.rate.value - b.rate.value)[0] || null
  const horizonYears = rateValue !== null && rateValue < 0 && last ? last.value / -rateValue : null

  const opposing = intervals.some((interval) => interval.large && interval.change > 0) && intervals.some((interval) => interval.large && interval.change < 0)
  const kind = !known.length ? 'unknown' : known.length === 1 ? 'single' : first.value === 0 ? 'zero-baseline' : last.value <= 0 ? 'empty' : known.length < MIN_SAMPLES ? 'insufficient' : rateValue >= 0 ? 'nondeclining' : opposing ? 'volatile' : intervals.some((interval) => interval.spike) ? 'spike' : horizonYears > HORIZON_YEARS ? 'distant' : 'declining'
  const declining = kind === 'declining'
  const windowAssumption = `the window is ${windowText(years, from, latest, date)}`
  const relative = known.length >= 2 && first.value !== 0 ? combine({ rule: 'stockRates.relativeRate', parts: { rate, baseline: first.result }, compute: ({ rate: value, baseline }) => (100 * value) / Math.abs(baseline), units: '% per game year', assumptions: [windowAssumption] }) : unavailable({ rule: 'stockRates.relativeRate', missing: [known.length >= 2 ? MISSING['zero-baseline'] : known.length ? MISSING.single : MISSING.unknown], units: '% per game year' })
  const depletion = declining ? combine({ rule: 'stockRates.depletion', parts: { rate, stock: last.result }, compute: ({ rate: value, stock: remaining }) => remaining / -value, units: 'game years', assumptions: [windowAssumption] }) : unavailable({ rule: 'stockRates.depletion', missing: [MISSING[kind] || MISSING.nondeclining], units: 'game years', assumptions: [windowAssumption] })
  const earliest = declining && fastest ? combine({ rule: 'stockRates.depletionEarliest', parts: { rate: fastest.rate, stock: last.result }, compute: ({ rate: value, stock: remaining }) => remaining / -value, units: 'game years', assumptions: [windowAssumption] }) : unavailable({ rule: 'stockRates.depletionEarliest', missing: [MISSING[kind] || MISSING.nondeclining], units: 'game years', assumptions: [windowAssumption] })
  const depletionAt = depletion.value === null ? null : last.t + depletion.value * YEAR_SECONDS
  const earliestAt = earliest.value === null ? null : last.t + earliest.value * YEAR_SECONDS

  const rows = rowsBase.map((row) => {
    const position = known.indexOf(row)
    const interval = position > 0 ? intervals[position - 1] : null

    return { ...row, seconds: interval ? interval.seconds : null, change: interval ? interval.change : null, rate: interval ? interval.rate : null, spike: interval ? interval.spike : false }
  })

  const gapSeconds = intervals.map((interval) => interval.seconds)
  const gaps = gapSeconds.length ? { count: gapSeconds.length, largest: Math.max(...gapSeconds), typical: median(gapSeconds) } : null
  const basis = { snapshots: kept.length, samples: known.length, unknown: kept.length - known.length, duplicates, intervals: intervals.length, steps: intervals.filter((interval) => interval.spike).length }
  const subject = scope.kind === SCOPES.COLONY ? `${stock.label} of colony ${scope.name}` : stock.label

  const reasons = {
    unknown: `${subject} has no recorded observation in the window${basis.unknown ? ` (${basis.unknown} not recorded)` : ''}, so there is no rate and no depletion estimate.`,
    single: `One observation of ${subject} (${number(first && first.value)} ${unit} at ${first ? date(first.t) : UNKNOWN_TEXT}): a rate needs two observations at different game times, so the rate and the depletion estimate are unknown.`,
    'zero-baseline': `${subject} was 0 ${unit} at the first observation of the window, so the relative rate is undefined and there is no depletion estimate; the change in ${unit} is shown.`,
    empty: `${subject} was ${number(last && last.value)} ${unit} at the last observation (${last ? date(last.t) : UNKNOWN_TEXT}), already at or below 0: observed, not estimated.`,
    insufficient: `Only ${basis.samples} observations at different game times; a depletion estimate needs at least ${MIN_SAMPLES}. The rate is shown and no depletion date is given.`,
    nondeclining: `${subject} was flat or rising over the window (${rateValue === null ? UNKNOWN_TEXT : signed(rateValue)} ${perYear}), so there is no finite depletion date.`,
    spike: `The window holds a change of ${number(Math.abs((intervals.find((interval) => interval.spike) || { change: 0 }).change))} ${unit} between two neighbouring observations that is far larger than its other changes, which reads as a transfer or spending and not a steady decline, so no depletion date is given.`,
    volatile: `The window holds both a large rise and a large fall between neighbouring observations (each at least ${Math.round(SPIKE_SHARE * 100)} % of the larger of its two stocks), which reads as deliveries, transfers or spending cancelling each other and not a steady decline: the window has no steady baseline to carry forward, so no depletion date is given.`,
    distant: `At the rate observed over the window ${subject} would last more than ${HORIZON_YEARS} game years after the last observation, so no depletion date is given.`,
    declining: `If ${subject} kept declining at the rate observed over the window (${signed(rateValue)} ${perYear}) it would reach 0 about ${number(depletion.value)} game years after the last observation, around ${depletionAt === null ? UNKNOWN_TEXT : date(depletionAt)}. This is an estimate from the observations taken, not a prediction that the stock runs out: deliveries, spending or transfers not seen would change it.`,
  }

  const assumptions = [windowLine, 'The rate is the net change between the first and the last observation of the window over the game time between them in game years of 365 days; what happened between observations is not known.', ...(declining ? depletion.assumptions.filter((line) => line !== windowAssumption) : [])]

  const notes = [
    windowLine,
    first ? `First observation ${date(first.t)}: ${number(first.value)} ${unit}. Last observation ${date(last.t)}: ${number(last.value)} ${unit}.` : 'No observation of the stock in the window.',
    gaps ? `Sampling: ${basis.samples} observations over ${durationText(last.t - first.t)}; ${gaps.count} ${gaps.count === 1 ? 'gap' : 'gaps'} between observations, the largest ${durationText(gaps.largest)}, typical ${durationText(gaps.typical)}.` : `Sampling: ${basis.samples} ${basis.samples === 1 ? 'observation' : 'observations'}, so there is no gap between observations to state.`,
    `Basis: ${basis.snapshots} snapshots at different game times in the window, ${basis.samples} with the stock recorded, ${basis.unknown} without${basis.duplicates ? `, ${basis.duplicates} at a game time already counted left out` : ''}${basis.steps ? `, ${basis.steps} ${basis.steps === 1 ? 'change' : 'changes'} read as a step` : ''}.`,
    rateValue === null ? 'Rate: unknown.' : `Rate: ${signed(rateValue)} ${perYear} over ${number(elapsed)} game years${valueOrNull(relative) === null ? '' : ` (${signed(valueOrNull(relative))} % of the first observation per game year)`}.`,
    reasons[kind],
    ...(declining && earliest.value !== null && fastest ? [`Cautious bound: at the fastest decline seen between two neighbouring observations (${signed(fastest.rate.value)} ${perYear}) it would reach 0 about ${number(earliest.value)} game years after the last observation, around ${date(earliestAt)}.`] : []),
    ...assumptions.slice(1).map((line) => `Assumes ${line.charAt(0).toLowerCase()}${line.slice(1)}`),
    ...(retention ? [retention] : []),
  ]

  return { stock, scope, window: { years, from, latest, text: windowText(years, from, latest, date) }, rows, first, last, basis, gaps, intervals, kind, reason: reasons[kind], rate, relative, depletion, depletionAt, earliest, earliestAt, assumptions, notes }
}

// ---- Chart, export ---------------------------------------------------------------------------------------------------

// What a chart draws: the observed stock at each distinct game time of the window (null where it was not recorded, which the line breaks at, never 0), and the average rate as a straight line from the first to the last observation where there is one.
export const chartPoints = (analysis) => ({
  observed: analysis.rows.map((row) => ({ t: row.t, value: row.value, step: row.spike })),
  average: analysis.first && analysis.last && analysis.first.t !== analysis.last.t ? [{ t: analysis.first.t, value: analysis.first.value }, { t: analysis.last.t, value: analysis.last.value }] : null,
})

export const CSV_COLUMNS = ['Record', 'Item', 'Game time (s)', 'Date', 'Value', 'Unit', 'Status', 'Rule', 'Assumptions', 'Missing inputs', 'Seconds since previous observation', 'Change since previous observation', 'Rate per game year', 'Step', 'Note']

const rowOf = (fields) => CSV_COLUMNS.map((column) => csvCell(fields[column]))

// Where the observations come from, in one line: the campaign and the shown branch, the game, the race and its ID and, for a colony, the colony and its PopulationID. `scope` is { kind, name, raceName, RaceID, colonyId, campaignId, branchId, GameID }; an ID not known is said so, never left out, so two exports of the same name from different branches differ.
const unsettled = (value) => (value === null || value === undefined || value === '' ? 'not settled' : String(value))

export const sourceText = (scope) => `campaign ${unsettled(scope.campaignId)}, branch ${unsettled(scope.branchId)}, game ${unsettled(scope.GameID)}, race ${scope.raceName || 'unnamed'} (RaceID ${unsettled(scope.RaceID)})${scope.kind === SCOPES.COLONY ? `, colony ${scope.name || 'unnamed'} (PopulationID ${unsettled(scope.colonyId)})` : ''}`

// The lines of an export in one model: `context` rows (what the figures are of, one fact a row, the results with their rule, status and assumptions) and `sample` rows (each distinct game time of the window at its exact game time). `date(seconds)` writes a game time; `retention` is the history's note on sampling and thinning.
export const exportModel = (analysis, { date = defaultDate, retention = '' } = {}) => {
  const { stock, window: span } = analysis
  const fact = (item, note, extra = {}) => ({ Record: 'context', Item: item, Note: note, ...extra })
  const fieldsOf = (result) => {
    const fields = exportFields(result)

    return { Value: fields.value, Status: fields.status, Rule: fields.rule, Assumptions: fields.assumptions, 'Missing inputs': fields.missing }
  }

  const figure = (item, result, { unit, time } = {}) => ({ Record: 'context', Item: item, Unit: unit === undefined ? result.units : unit, 'Game time (s)': time === undefined ? null : time, Date: time === undefined || time === null ? '' : date(time), ...fieldsOf(result) })

  const context = [
    fact('Scope', analysis.scope.kind === SCOPES.COLONY ? 'One followed colony' : 'The empire of the race, every colony together'),
    fact('Campaign', unsettled(analysis.scope.campaignId)),
    fact('Branch', unsettled(analysis.scope.branchId)),
    fact('Game', unsettled(analysis.scope.GameID)),
    { ...fact('Race', analysis.scope.raceName || 'unnamed'), Value: isKnownNumber(analysis.scope.RaceID) ? Number(analysis.scope.RaceID) : null, Unit: 'RaceID' },
    ...(analysis.scope.kind === SCOPES.COLONY ? [{ ...fact('Colony', analysis.scope.name || 'unnamed'), Value: isKnownNumber(analysis.scope.colonyId) ? Number(analysis.scope.colonyId) : null, Unit: 'PopulationID' }] : []),
    fact('Stock', `${stock.label} (${stock.unit})`),
    fact('Window', span.text, { 'Game time (s)': span.from, Date: span.from === null ? '' : date(span.from) }),
    fact('Latest snapshot', span.latest === null ? 'none' : date(span.latest), { 'Game time (s)': span.latest, Date: span.latest === null ? '' : date(span.latest) }),
    analysis.first ? { ...figure('First observation', analysis.first.result, { unit: stock.unit, time: analysis.first.t }), Note: 'the first recorded stock in the window' } : fact('First observation', 'none in the window'),
    analysis.last ? { ...figure('Last observation', analysis.last.result, { unit: stock.unit, time: analysis.last.t }), Note: 'the last recorded stock in the window' } : fact('Last observation', 'none in the window'),
    fact('Observations', `${analysis.basis.samples} recorded and ${analysis.basis.unknown} not recorded at ${analysis.basis.snapshots} different game times; ${analysis.basis.duplicates} at an already counted game time left out; ${analysis.basis.steps} read as a step`),
    fact('Sampling gaps', analysis.gaps ? `${analysis.gaps.count} between observations, largest ${durationText(analysis.gaps.largest)} (${analysis.gaps.largest} s), typical ${durationText(analysis.gaps.typical)} (${analysis.gaps.typical} s)` : 'no gap between observations: fewer than two'),
    fact('Classification', `${analysis.kind}: ${analysis.reason}`),
    figure('Rate', analysis.rate),
    figure('Relative rate', analysis.relative),
    { ...figure('Depletion estimate', analysis.depletion), Note: analysis.depletionAt === null ? analysis.reason : `an estimate, about ${date(analysis.depletionAt)} (game time ${Math.round(analysis.depletionAt)} s); not a prediction that the stock runs out`, 'Game time (s)': analysis.depletionAt === null ? null : Math.round(analysis.depletionAt), Date: analysis.depletionAt === null ? '' : date(analysis.depletionAt) },
    { ...figure('Earliest depletion bound', analysis.earliest), Note: analysis.earliestAt === null ? 'none' : `at the fastest decline seen between two neighbouring observations, about ${date(analysis.earliestAt)}` },
    ...analysis.assumptions.map((line) => fact('Assumption', line)),
    ...(retention ? [fact('Retention', retention)] : []),
  ]

  const samples = analysis.rows.map((row) => ({ Record: 'sample', Item: stock.label, 'Game time (s)': row.t, Date: date(row.t), Value: row.value, Unit: stock.unit, ...fieldsOf(row.result), 'Seconds since previous observation': row.seconds, 'Change since previous observation': row.change, 'Rate per game year': row.rate ? row.rate.value : null, Step: row.spike ? 'step' : '', Note: row.value === null ? `not recorded: ${row.result.inputs.missing.join(', ')}` : row.spike ? 'a change far larger than the others in the window: a transfer or spending' : '' }))

  return { columns: CSV_COLUMNS, rows: [...context, ...samples].map(rowOf) }
}

// The CSV of an analysis: the context rows, then a row for each observation of the window.
export const ratesCsv = (analysis, options = {}) => {
  const { columns, rows } = exportModel(analysis, options)

  return [columns.map((column) => csvCell(column)), ...rows].map((row) => row.join(',')).join('\n')
}

// The analysis as plain text for a clipboard: the notes the chart shows, then the observations one a line.
export const ratesText = (analysis, { date = defaultDate, format = defaultFormat, title = '' } = {}) => {
  const { stock } = analysis
  const heading = title || `${analysis.scope.kind === SCOPES.COLONY ? `Colony ${analysis.scope.name}` : 'Empire'}: ${stock.label} (${stock.unit}), rate per game year and depletion estimate`
  const lines = analysis.rows.map((row) => `${date(row.t)} (${row.t} s)\t${row.value === null ? UNKNOWN_TEXT : format(row.value, Math.abs(row.value) < 100 ? 1 : 0)} ${stock.unit}${row.value === null ? ` (not recorded: ${row.result.inputs.missing.join(', ')})` : ''}${row.rate ? `\t${format(row.rate.value, Math.abs(row.rate.value) < 100 ? 1 : 0)} ${stock.unit}/yr over ${durationText(row.seconds)}` : ''}${row.spike ? '\tstep' : ''}`)

  return [heading, `Source: ${sourceText(analysis.scope)}.`, ...analysis.notes, '', 'Observations:', ...(lines.length ? lines : ['none in the window'])].join('\n')
}
