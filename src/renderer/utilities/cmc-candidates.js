// The optional longevity ranking of the civilian mining complex candidates of the Mineral Breakdown. A candidate is a surveyed body in reach of its star, with no complex on it yet, that holds more than 10,000 t of Duranium or Gallicite at accessibility 0.7 or better (minerals.js `qualifiesForCmc`); the Mineral Breakdown marks it with a CMC chip. A body with a Duranium or Gallicite deposit whose amount or accessibility is not recorded, and that could still meet the rule, is listed as a possible candidate and stays unknown in every figure. Evidence: docs/plans/backlog/evidence/AE-055-01.md.
//
// Two orders are offered. The headline order is the page's existing site order (minerals.js `betterSite`: the body's mining potential, then accessibility, then amount) and is the default. The longevity order is a preference score the player sets: the weighted mean of three terms of the qualifying deposits, each between 0 and 1: the reserve against a reference reserve, the accessibility, and the production lifetime against a horizon. The lifetime is how long assumed complexes would take to dig the deposits out (minerals.js `depositForecast`, the decline model of the Mineral Outlook). Every term, weight and assumption is a result with its provenance. Neither order is the game's own choice of where a complex is founded: the game picks by its own scoring and a dice roll, and nothing here predicts it.

import { CMC_MINERAL_IDS, MINERALS, betterSite, bodyPotentialResult, depositForecast, depositReadable, qualifiesForCmc, surfaceRate } from './minerals'
import { combine, isAvailable, ofRule, registerRule, unavailable, valueOrNull } from './provenance'

const CANDIDATE_VERSIONS = ['2.7.x']

registerRule({
  id: 'cmcCandidate.input',
  versions: CANDIDATE_VERSIONS,
  units: 'figure',
  verification: 'assumed',
  structure: ['a figure typed on the page'],
  note: 'A figure of the player\'s ranking: a weight or an assumption typed on the Mineral Breakdown and kept for the race. A blank field is not known, so what rests on it is not known; a negative or non-numeric entry is rejected and leaves the same figures unknown, never a default.',
})

registerRule({
  id: 'cmcCandidate.deposit',
  versions: CANDIDATE_VERSIONS,
  units: 't or accessibility',
  verification: 'confirmed',
  structure: ['FCT_MineralDeposit.Amount, Accessibility'],
  note: 'One figure of a deposit as the save stores it: the tonnes in the ground or the accessibility. A deposit with no recorded figure has none and shows a dash.',
})

registerRule({
  id: 'cmcCandidate.reserve',
  versions: CANDIDATE_VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_MineralDeposit.Amount, Accessibility', 'FCT_Game.AllowCMC'],
  note: 'The tonnes of Duranium and Gallicite on a candidate body that meet the deposit rule of a civilian mining complex (more than 10,000 t at accessibility 0.7 or better), as stored. The deposit rule is the one the candidate chip uses and is not reproduced against a saved founding. A Duranium or Gallicite deposit with no recorded amount or accessibility that could still meet the rule, or a colony on the body whose civilian installations are not fully recorded, leaves the reserve unknown, never a smaller sum.',
})

registerRule({
  id: 'cmcCandidate.accessibility',
  versions: CANDIDATE_VERSIONS,
  units: 'accessibility',
  verification: 'estimated',
  structure: ['FCT_MineralDeposit.Amount, Accessibility'],
  note: 'The accessibility of the qualifying Duranium and Gallicite deposits of a candidate body, weighted by their tonnes (the one deposit\'s own when there is one). A deposit with no recorded amount or accessibility that could still qualify, or a colony on the body whose civilian installations are not fully recorded, leaves it unknown.',
})

registerRule({
  id: 'cmcCandidate.rate',
  versions: CANDIDATE_VERSIONS,
  units: 't/yr',
  verification: 'assumed',
  structure: ['the mining value of a civilian mining complex', 'the race\'s mine production', 'the accessibility of the deposit', 'the body\'s radiation level'],
  note: 'What the assumed number of civilian mining complexes would dig a year from one deposit at its current accessibility, worked as the surface mining rows work it: the complexes times the mining value of one complex, cut to a whole number of mine equivalents, times the race\'s mine production times accessibility times the body\'s radiation modifier (1 less the radiation level over 10,000, never below 0). Hypothetical: no colony exists on the body, so no governor or sector bonus applies. Unknown while a figure of it is not recorded or the number of complexes is blank or rejected.',
  assumptions: ['no governor or sector bonus applies, as no colony exists on a candidate body', 'every assumed complex works the deposit from now on'],
})

registerRule({
  id: 'cmcCandidate.lifetime',
  versions: CANDIDATE_VERSIONS,
  units: 'years',
  verification: 'assumed',
  structure: ['FCT_MineralDeposit.Amount, Accessibility, HalfOriginalAmount, OriginalAcc'],
  note: 'The years until the qualifying deposits of a candidate body are dug out at the assumed rate, the longest of them: the amount above half holds accessibility, then accessibility and output fall with what is left (the decline model of the Mineral Outlook). A body whose radiation leaves the complexes no output has a production lifetime of 0. A deposit whose half of the original amount or original accessibility is not recorded has no lifetime, and neither has a body with one.',
  assumptions: ['the complexes never dig more than the assumed number', 'nothing else mines the deposits'],
})

registerRule({
  id: 'cmcCandidate.term',
  versions: CANDIDATE_VERSIONS,
  units: '0 to 1',
  verification: 'assumed',
  structure: ['the reserve, accessibility and lifetime of the candidate', 'the reserve reference and the lifetime horizon typed on the page'],
  note: 'One term of the longevity preference, between 0 and 1: the reserve over the reference reserve, the accessibility itself, or the lifetime over the horizon, the first and last capped at 1. A player\'s own scale, not a game value.',
})

registerRule({
  id: 'cmcCandidate.score',
  versions: CANDIDATE_VERSIONS,
  units: '0 to 1',
  verification: 'assumed',
  structure: ['the terms of the candidate', 'the weights typed on the page'],
  note: 'The longevity preference score: the weighted mean of the reserve, accessibility and lifetime terms, a term of weight 0 left out. A player\'s own ranking of candidates, not the game\'s selection of where a civilian mining complex is founded and not a prediction of it. Unknown when a weight is blank or rejected, when the weights are all 0, or when a term of weight above 0 is unknown.',
  assumptions: ['the weights typed on the page', 'a candidate is ranked on its qualifying deposits alone'],
})

export const RANKINGS = Object.freeze([
  Object.freeze({ id: 'headline', label: 'Headline' }),
  Object.freeze({ id: 'longevity', label: 'Longevity preference' }),
])

// The terms of the score: its key, name and the setting that weights it.
export const TERMS = Object.freeze([
  Object.freeze({ key: 'reserve', label: 'Reserve', weight: 'reserveWeight' }),
  Object.freeze({ key: 'accessibility', label: 'Accessibility', weight: 'accessibilityWeight' }),
  Object.freeze({ key: 'lifetime', label: 'Lifetime', weight: 'lifetimeWeight' }),
])

// What can be typed: `kind` 'weight' (0 or more), 'count' (a whole number from 1) or 'positive' (above 0).
export const SETTING_FIELDS = Object.freeze([
  Object.freeze({ key: 'reserveWeight', label: 'Reserve weight', kind: 'weight', hint: '0 leaves the reserve out' }),
  Object.freeze({ key: 'accessibilityWeight', label: 'Accessibility weight', kind: 'weight', hint: '0 leaves the accessibility out' }),
  Object.freeze({ key: 'lifetimeWeight', label: 'Lifetime weight', kind: 'weight', hint: '0 leaves the lifetime out' }),
  Object.freeze({ key: 'complexes', label: 'Complexes assumed', kind: 'count', hint: 'A whole number from 1' }),
  Object.freeze({ key: 'horizon', label: 'Lifetime horizon (years)', kind: 'positive', hint: 'Lifetimes beyond it count as it' }),
  Object.freeze({ key: 'reference', label: 'Reserve reference (t)', kind: 'positive', hint: 'Reserves beyond it count as it' }),
])

export const DEFAULT_SETTINGS = Object.freeze({ reserveWeight: '1', accessibilityWeight: '1', lifetimeWeight: '2', complexes: '3', horizon: '100', reference: '100000' })

// The one accepted domain of a typed setting, for live input, persistence and restoration: at most `MAX_TEXT` characters, a plain decimal, and within the limit of its kind. Anything else is rejected with a reason and stays unknown; nothing is replaced by a default.
export const MAX_TEXT = 24

// The largest value each kind accepts: low enough that no weighted mean of accepted weights overflows.
export const LIMITS = Object.freeze({ weight: 1e6, count: 1e6, positive: 1e12 })

const textOf = (value) => (typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '')

// Stored settings back as the page holds them: text for every field. A field the store lacks takes its default, a stored null or other non-text is blank (unknown), and text longer than the limit is kept just past it so that it stays rejected and the store stays bounded. Undefined for anything that is not an object (the default of the whole).
export const normaliseSettings = (stored) => {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return undefined
  }

  return Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, stored[key] === undefined ? DEFAULT_SETTINGS[key] : textOf(stored[key]).slice(0, MAX_TEXT + 1)]))
}

const NUMBER = /^(\d+(\.\d*)?|\.\d+)$/

const KINDS = {
  weight: { test: (value) => value >= 0, reason: 'a number of 0 or more' },
  count: { test: (value) => Number.isInteger(value) && value >= 1, reason: 'a whole number of 1 or more' },
  positive: { test: (value) => value > 0, reason: 'a number above 0' },
}

// One typed field read: `state` 'ok' (with `value`), 'blank' (not known) or 'rejected' (with the `reason`: too long, negative, not a number, above the limit, or what it must be). Nothing becomes a default: a blank or rejected field has no value.
const readField = (field, text) => {
  const raw = textOf(text)
  const typed = raw.trim()
  const read = (state, value, reason) => ({ key: field.key, label: field.label, kind: field.kind, state, value, reason })

  if (raw.length > MAX_TEXT) {
    return read('rejected', null, `longer than ${MAX_TEXT} characters`)
  } else if (!typed) {
    return read('blank', null, null)
  } else if (!NUMBER.test(typed)) {
    return read('rejected', null, typed.startsWith('-') && NUMBER.test(typed.slice(1)) ? 'negative' : 'not a number')
  }

  const value = Number(typed)
  const { test, reason } = KINDS[field.kind]

  if (value > LIMITS[field.kind]) {
    return read('rejected', null, `above the limit of ${LIMITS[field.kind]}`)
  }

  return test(value) ? read('ok', value, null) : read('rejected', null, `must be ${reason}`)
}

// Every setting read, by key: { key, label, kind, state, value, reason }.
export const parseSettings = (settings) => Object.fromEntries(SETTING_FIELDS.map((field) => [field.key, readField(field, settings ? settings[field.key] : undefined)]))

// What a field that is not usable lacks, as text.
export const settingProblem = (field) => `${field.label} ${field.state === 'blank' ? 'is blank' : `is rejected: ${field.reason}`}`

const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

const entered = (field) => (field.state === 'ok' ? ofRule({ rule: 'cmcCandidate.input', value: field.value, inputs: { present: [field.label] } }) : unavailable({ rule: 'cmcCandidate.input', missing: [settingProblem(field)] }))

const fromSave = (rule, value, column) => (known(value) ? ofRule({ rule, value, inputs: { present: [column] } }) : unavailable({ rule, missing: [column] }))

const DEPOSIT_COLUMNS = ['the amount', 'the accessibility']

// Whether a deposit of Duranium or Gallicite that does not qualify for certain could still qualify: its amount or accessibility is not recorded, and what is recorded does not rule it out.
const couldQualify = (deposit) => {
  const amount = known(deposit.Amount)
  const accessibility = known(deposit.Accessibility)

  return (!amount || qualifiesForCmc({ Amount: deposit.Amount, Accessibility: 1 })) && (!accessibility || qualifiesForCmc({ Amount: Infinity, Accessibility: deposit.Accessibility }))
}

const mineralName = (id) => MINERALS.find((mineral) => mineral.id === id).name

const declineResult = (deposit) => (known(deposit.HalfOriginalAmount) && known(deposit.OriginalAcc) ? ofRule({ rule: 'minerals.depletion', value: true, inputs: { present: ['FCT_MineralDeposit.HalfOriginalAmount', 'FCT_MineralDeposit.OriginalAcc'] } }) : unavailable({ rule: 'minerals.depletion', missing: ['the original amount and accessibility of the deposit'] }))

const rateResult = ({ deposit, body, race, complexes, count = null }) => combine({
  rule: 'cmcCandidate.rate',
  parts: {
    complexes,
    complexMining: fromSave('cmcCandidate.rate', race.ComplexMining, 'the mining value of a civilian mining complex'),
    mineProduction: fromSave('cmcCandidate.rate', race.MineProduction, 'the race\'s mine production'),
    accessibility: fromSave('cmcCandidate.rate', deposit.Accessibility, 'the accessibility of the deposit'),
    radiation: fromSave('cmcCandidate.rate', body.RadiationLevel, 'the body\'s radiation level'),
    ...(count ? { count } : {}),
  },
  compute: (values) => surfaceRate({ ManualMineCount: 0, AutomatedMineCount: 0, CivilianMineCount: values.complexes * values.complexMining, PurchaseCivilianMinerals: 1, Efficiency: 1, StabilityModifier: 1, MineProduction: values.mineProduction, Accessibility: values.accessibility, GovernorBonus: 1, SectorBonus: 1, RadiationModifier: 1 - values.radiation / 10000 }, false),
})

const lifetimeOfDeposit = (deposit, rate) => combine({
  rule: 'cmcCandidate.lifetime',
  parts: { rate, decline: declineResult(deposit) },
  compute: (values) => (values.rate > 0 ? depositForecast(deposit, values.rate).yearsToDepletion : 0),
})

const openResult = (deposit) => unavailable({ rule: 'cmcCandidate.reserve', missing: [`${DEPOSIT_COLUMNS.join(' or ')} of the ${mineralName(deposit.MaterialID)} deposit`] })

const COMPLEX_COLUMNS = 'the number and type of the installations on the body'

// A colony on the body with an installation whose count or kind is not recorded leaves the number of complexes on the body unknown, so the body may not be free of them: it is listed as possible and stays unknown in every figure. A body with no installation row has no complex.
const countOpen = (body) => body.complexGaps > 0

const countResult = (rule) => unavailable({ rule, missing: [COMPLEX_COLUMNS] })

// One candidate body's row, or null when the body is no candidate. `ctx` holds the race, the parsed settings and the entered results of them.
const rowOf = (body, ctx) => {
  const cmc = body.depositList.filter((deposit) => CMC_MINERAL_IDS.includes(deposit.MaterialID))
  const qualifying = cmc.filter((deposit) => qualifiesForCmc(deposit))
  const open = cmc.filter((deposit) => !qualifiesForCmc(deposit) && !depositReadable(deposit) && couldQualify(deposit))

  if (!qualifying.length && !open.length) {
    return null
  }

  const unsure = countOpen(body)
  const countParts = (rule) => (unsure ? { 'civilian complexes of the body': countResult(rule) } : {})
  const openParts = Object.fromEntries(open.map((deposit) => [`${mineralName(deposit.MaterialID)} deposit`, openResult(deposit)]))
  const qualifyingParts = (build) => Object.fromEntries(qualifying.map((deposit) => [`${mineralName(deposit.MaterialID)} deposit`, build(deposit)]))
  const total = qualifying.reduce((sum, deposit) => sum + deposit.Amount, 0)
  const reserve = combine({ rule: 'cmcCandidate.reserve', parts: { ...qualifyingParts((deposit) => fromSave('cmcCandidate.reserve', deposit.Amount, DEPOSIT_COLUMNS[0])), ...openParts, ...countParts('cmcCandidate.reserve') }, compute: () => total })
  const accessibility = combine({ rule: 'cmcCandidate.accessibility', parts: { ...qualifyingParts((deposit) => fromSave('cmcCandidate.accessibility', deposit.Accessibility, DEPOSIT_COLUMNS[1])), ...openParts, ...countParts('cmcCandidate.accessibility') }, compute: () => qualifying.reduce((sum, deposit) => sum + deposit.Accessibility * deposit.Amount, 0) / total })
  const inputs = (deposit) => ({ Amount: known(deposit.Amount) ? deposit.Amount : null, Accessibility: known(deposit.Accessibility) ? deposit.Accessibility : null, amountResult: fromSave('cmcCandidate.deposit', deposit.Amount, DEPOSIT_COLUMNS[0]), accessibilityResult: fromSave('cmcCandidate.deposit', deposit.Accessibility, DEPOSIT_COLUMNS[1]) })
  const lines = [...qualifying.map((deposit) => ({ MaterialID: deposit.MaterialID, mineral: mineralName(deposit.MaterialID), ...inputs(deposit), qualifies: true, rate: rateResult({ deposit, body, race: ctx.race, complexes: ctx.complexes, count: unsure ? countResult('cmcCandidate.rate') : null }) })), ...open.map((deposit) => ({ MaterialID: deposit.MaterialID, mineral: mineralName(deposit.MaterialID), ...inputs(deposit), qualifies: null, rate: unavailable({ rule: 'cmcCandidate.rate', missing: [`${DEPOSIT_COLUMNS.join(' or ')} of the ${mineralName(deposit.MaterialID)} deposit`, ...(unsure ? [`${COMPLEX_COLUMNS} of an installation on the body`] : [])] }) }))]
  const withLifetime = lines.map((line) => ({ ...line, lifetime: line.qualifies ? lifetimeOfDeposit(qualifying.find((deposit) => deposit.MaterialID === line.MaterialID), line.rate) : unavailable({ rule: 'cmcCandidate.lifetime', missing: line.rate.inputs.missing }) }))
  const lifetime = combine({ rule: 'cmcCandidate.lifetime', parts: Object.fromEntries(withLifetime.map((line) => [`${line.mineral} deposit`, line.lifetime])), compute: (values) => Math.max(...Object.values(values)) })
  const readable = body.depositList.filter((deposit) => depositReadable(deposit))
  const bodyPotential = bodyPotentialResult(readable, body.depositList.length - readable.length)
  const potentialResult = unsure ? combine({ rule: 'minerals.bodyPotential', parts: { 'body potential': bodyPotential, ...countParts('minerals.bodyPotential') }, compute: (values) => values['body potential'] }) : bodyPotential
  const certain = qualifying.length > 0 && !unsure

  return {
    key: body.SystemBodyID,
    SystemBodyID: body.SystemBodyID,
    body,
    name: body.name,
    place: body.place,
    status: certain ? 'known' : 'possible',
    possibleBecause: certain ? [] : [...(qualifying.length ? [] : ['a deposit is not fully recorded']), ...(unsure ? ['a colony\'s installations are not fully recorded'] : [])],
    reserve,
    accessibility,
    lifetime,
    lines: withLifetime,
    potentialResult,
    potential: valueOrNull(potentialResult),
    amount: readable.reduce((sum, deposit) => sum + deposit.Amount, 0),
    best: readable.length ? Math.max(...readable.map((deposit) => deposit.Accessibility)) : 0,
  }
}

const TERM_RULE = 'cmcCandidate.term'

const termResult = (key, row, ctx) => {
  if (key === 'reserve') {
    return combine({ rule: TERM_RULE, parts: { reserve: row.reserve, reference: ctx.entered.reference }, compute: (values) => Math.min(values.reserve, values.reference) / values.reference })
  } else if (key === 'accessibility') {
    return combine({ rule: TERM_RULE, parts: { accessibility: row.accessibility }, compute: (values) => Math.min(1, values.accessibility) })
  }

  return combine({ rule: TERM_RULE, parts: { lifetime: row.lifetime, horizon: ctx.entered.horizon }, compute: (values) => Math.min(values.lifetime, values.horizon) / values.horizon })
}

const rawOf = (key, row) => ({ reserve: row.reserve, accessibility: row.accessibility, lifetime: row.lifetime })[key]

// Why the score is not given for any candidate: a weight that is blank or rejected, or no weight above 0.
const blockingProblems = (parsed) => {
  const weights = TERMS.map((term) => parsed[term.weight])
  const unusable = weights.filter((field) => field.state !== 'ok').map(settingProblem)

  if (unusable.length) {
    return unusable
  }

  return weights.some((field) => field.value > 0) ? [] : ['Every weight is 0, so no term counts']
}

const scoreResult = (row, ctx) => {
  if (ctx.blocking.length) {
    return unavailable({ rule: 'cmcCandidate.score', missing: ctx.blocking })
  }

  const used = TERMS.filter((term) => ctx.weights[term.key] > 0)
  const total = TERMS.reduce((sum, term) => sum + ctx.weights[term.key], 0)

  return combine({ rule: 'cmcCandidate.score', parts: Object.fromEntries(used.map((term) => [term.label, row.terms.find((entry) => entry.key === term.key).term])), compute: (values) => used.reduce((sum, term) => sum + ctx.weights[term.key] * values[term.label], 0) / total })
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.SystemBodyID - b.SystemBodyID

// The headline order: the page's site order over the body's potential, accessibility and amount, a body whose potential is not known last.
const headlineCompare = (a, b) => (a.potential === null || b.potential === null ? (a.potential === null ? (b.potential === null ? 0 : 1) : -1) : betterSite({ potential: b.potential, accessibility: b.best, amount: b.amount }, { potential: a.potential, accessibility: a.best, amount: a.amount })) || byName(a, b)

const TIE = 1e-9

const longevityCompare = (a, b) => {
  const x = valueOrNull(a.score)
  const y = valueOrNull(b.score)

  if (x === null || y === null) {
    return (x === null ? (y === null ? 0 : 1) : -1) || headlineCompare(a, b)
  }

  return (Math.abs(x - y) <= TIE ? 0 : y - x) || headlineCompare(a, b)
}

const ranked = (rows, compare, counts) => {
  const order = [...rows].sort(compare)
  const ranks = new Map()

  order.filter(counts).forEach((row, index) => ranks.set(row, index + 1))

  return { order, ranks }
}

// The lines of the assumptions in force, each with the result it rests on: `value` null is a figure that is not known (or a note with none), `unit` follows a value.
const assumptionLines = (ctx) => {
  const { parsed, race } = ctx
  const line = (key, label, value, unit, result, note = null) => ({ key, label, value, unit, result, note })

  return [
    line('complexes', 'Complexes assumed on every candidate', parsed.complexes.value, '', ctx.entered.complexes, 'A founding places only a few; more are added over time'),
    line('complexMining', 'Mine equivalents of one complex', known(race.ComplexMining) ? race.ComplexMining : null, '', fromSave('cmcCandidate.rate', race.ComplexMining, 'the mining value of a civilian mining complex')),
    line('mineProduction', 'Race mine production a mine equivalent', known(race.MineProduction) ? race.MineProduction : null, ' t a year at accessibility 1', fromSave('cmcCandidate.rate', race.MineProduction, 'the race\'s mine production')),
    line('bonuses', 'Governor and sector bonuses', null, '', ofRule({ rule: 'cmcCandidate.rate', value: true, inputs: { present: ['no colony on a candidate body'] } }), 'Left out, as no colony exists; the radiation of the body lowers the output'),
    line('horizon', 'Lifetime horizon', parsed.horizon.value, ' years', ctx.entered.horizon, 'A lifetime beyond it counts as the horizon'),
    line('reference', 'Reserve reference', parsed.reference.value, ' t', ctx.entered.reference, 'A reserve beyond it counts as the reference'),
  ]
}

// The candidates, ranked. `bodies` are the page's body rows (SystemBodyID, name, place, depositList, complexes, complexGaps, cmcInReach, RadiationLevel, bare); `race` the race's { MineProduction, ComplexMining } (null before it loads); `allowed` whether the game founds complexes at all; `settings` the typed settings text; `ranking` 'headline' or 'longevity'.
// The value is { allowed, requested, shown, fellBack, rows, parsed, blocking, notes, lines }. `rows` come in the order of the shown ranking, a candidate with no rank last; each has `rank` (in the shown order), `headlineRank` and `longevityRank` (null while not known), its `terms` ({ key, label, raw, term, weight, contribution }) and its `score`. `blocking` is why no score is given at all; `notes` what leaves a column unknown (a blank or rejected assumption); a longevity request with a blocking reason is shown in the headline order (`fellBack`).
export const candidateRanking = ({ bodies, race, allowed, settings, ranking }) => {
  const parsed = parseSettings(settings)
  const saved = race || {}
  const enteredResults = Object.fromEntries(Object.keys(parsed).map((key) => [key, entered(parsed[key])]))
  const blocking = blockingProblems(parsed)
  const weights = Object.fromEntries(TERMS.map((term) => [term.key, parsed[term.weight].value]))
  const weightTotal = Object.values(weights).reduce((sum, weight) => sum + weight, 0)
  const ctx = { parsed, race: saved, entered: enteredResults, complexes: enteredResults.complexes, blocking, weights, weightTotal }
  const base = allowed ? bodies.filter((body) => !body.bare && !(body.complexes > 0) && body.cmcInReach).map((body) => rowOf(body, ctx)).filter(Boolean) : []

  base.forEach((row) => {
    row.terms = TERMS.map((term) => ({ key: term.key, label: term.label, raw: rawOf(term.key, row), term: termResult(term.key, row, ctx), weight: parsed[term.weight].value }))
    row.score = scoreResult(row, ctx)
    row.terms.forEach((entry) => {
      entry.contribution = isAvailable(row.score) ? (entry.weight === 0 ? 0 : entry.weight * entry.term.value / weightTotal) : null
    })
  })

  const headline = ranked(base, headlineCompare, (row) => row.potential !== null)
  const longevity = ranked(base, longevityCompare, (row) => isAvailable(row.score))

  base.forEach((row) => {
    row.headlineRank = headline.ranks.get(row) || null
    row.longevityRank = longevity.ranks.get(row) || null
  })

  const requested = ranking === 'longevity' ? 'longevity' : 'headline'
  const fellBack = requested === 'longevity' && blocking.length > 0
  const shown = fellBack ? 'headline' : requested
  const rows = shown === 'longevity' ? longevity.order : headline.order

  rows.forEach((row) => {
    row.rank = shown === 'longevity' ? row.longevityRank : row.headlineRank
    row.rankResult = shown === 'longevity' ? row.score : row.potentialResult
  })

  const notes = ['complexes', 'horizon', 'reference'].filter((key) => parsed[key].state !== 'ok').map((key) => `${settingProblem(parsed[key])}, so ${{ complexes: 'no lifetime is worked out', horizon: 'the lifetime term is not known', reference: 'the reserve term is not known' }[key]}`)

  return { allowed: !!allowed, requested, shown, fellBack, rows, parsed, blocking, notes, lines: assumptionLines(ctx) }
}
