/*
  Checks the optional longevity ranking of the civilian mining complex candidates of the Minerals page (src/renderer/utilities/cmc-candidates.js and the "Civilian mining candidates" panel of src/renderer/pages/minerals.vue).

  bun scripts/check-cmc-longevity.js [--no-mutations] [--no-saves]

  The utility is run on synthetic bodies worked by hand. Swap: a deep, slow site (80,000 t of Duranium at accessibility 0.7) and a marginal, short-lived one (10,500 t at 1, on a body rich in other minerals) change places between the headline order and the longevity preference, and editing a weight moves them again. Terms: every row lists the reserve, accessibility and lifetime terms with the raw figure, the term, the weight and the contribution, the contributions add up to the score, and the lines of the assumptions (complexes, mine equivalents of a complex, mine production, bonuses, horizon, reference) each carry a result. Lifetime: the decline model at the assumed rate, the longest of the qualifying deposits, with the radiation of the body in the rate. Unknown: a deposit, rate or lifetime the save does not record is unknown, never 0, and sorts after every known score; a known 0 ranks ahead of it. Settings: blank is unknown, negative and non-numeric entries are rejected, a weight of 0 leaves a term out, and a blank or rejected weight makes the longevity ranking unavailable with a stated reason. Headline: the default order is the page's site order and no setting changes it. Prediction: the rule notes and the panel's foot say the order is the player's own and not the game's choice of where a complex is founded.

  The page runs over scripts/lib/page-loader.js: its template is read as text and its script runs the candidates computed over deposit rows shaped like the page's query.

  The saves (saves/AuroraDB.db, saves/AuroraDB_271_skoormit_saved.db, game 138, race 785, and AuroraDB.db, game 140, race 784, read-only) give the real bodies: the page's reads run over each save and the candidates are compared with raw reads of the deposits, installations, radiation and race, the rate and lifetime with the formulas worked from those raw values, and the ranks with the order of their scores. A save that is not there is skipped.

  Each mutation of the utility or the page must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const nodeVm = require('vm')
const sqlite3 = require('sqlite3')
const Vue = require('vue')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const FILES = {
  utility: path.join(root, 'src', 'renderer', 'utilities', 'cmc-candidates.js'),
  minerals: path.join(root, 'src', 'renderer', 'utilities', 'minerals.js'),
  policy: path.join(root, 'src', 'renderer', 'utilities', 'cmc-policy.js'),
  page: path.join(root, 'src', 'renderer', 'pages', 'minerals.vue'),
}
const PERSISTED_VIEW = fs.readFileSync(path.join(root, 'src', 'renderer', 'mixins', 'persisted-view.js'), 'utf8')
const U = 'utility'
const M = 'minerals'
const P = 'page'
const NAMES = ['cmc-candidates', 'minerals', 'cmc-policy', 'provenance']
const SAVES = [
  { file: 'saves/AuroraDB.db', game: 138, race: 785 },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
  { file: 'AuroraDB.db', game: 140, race: 784 },
]

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
}
const STORE = { getters: { config: { get: () => 'Tick' } }, state: {} }

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const SHORT_LIMIT = Number(process.env.SHORT_LIMIT) || 300
const DROPPED = new Set(['rule', 'inputs', 'assumptions', 'body', 'row'])

// A table or column name as the tooltip would show it: the missing inputs of an unavailable result are prose.
const RAW_POINTER = /\b(?:FCT|DIM|VIR)_|\b[A-Za-z]+\.[A-Za-z]+\b/

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

// True, or a text with what differed (the bounded assertion's own, shortened).
const same = (actual, expected) => {
  try {
    assert.deepEqual(actual, expected)

    return true
  } catch (error) {
    return `${short(actual)} != ${short(expected)}`
  }
}

const templateErrors = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed

  return compiler.compileTemplate({ source: descriptor.template.content, filename: 'page.vue', id: 'page' }).errors.map(String)
}

const PRONOUNS = /\b(I|me|my|mine|you|your|we|our)\b/i
// The mine of the mining game is a noun: the texts of the ranking name it, so the check of them leaves it out of the pronouns.
const TEXT_PRONOUNS = /\b(I|me|my|you|your|we|our)\b/i

// ---------- the fixtures worked by hand ----------

// The assumptions of the hand-worked fixtures: their own, independent of the defaults the application ships with.
const FIXED_SETTINGS = Object.freeze({ reserveWeight: '1', accessibilityWeight: '1', lifetimeWeight: '2', complexes: '3', horizon: '100', reference: '100000' })

const fixtures = (m) => {
  const { candidates, minerals, provenance } = m
  const value = provenance.valueOrNull
  const unknown = (result) => !provenance.isAvailable(result)
  const dep = (MaterialID, Amount, Accessibility, half = Amount, original = Accessibility) => ({ MaterialID, Amount, Accessibility, HalfOriginalAmount: half, OriginalAcc: original })
  const body = (id, name, depositList, over = {}) => ({ SystemBodyID: id, name, place: 'Sol', depositList, complexes: 0, cmcInReach: true, RadiationLevel: 0, bare: false, ...over })
  const RACE = { MineProduction: 10, ComplexMining: 10 }
  const settings = (over = {}) => ({ ...FIXED_SETTINGS, ...over })
  const rank = (bodies, { race = RACE, allowed = true, over = {}, ranking = 'headline' } = {}) => candidates.candidateRanking({ bodies, race, allowed, settings: settings(over), ranking })
  const names = (result) => result.rows.map((row) => row.name)
  const lifetimeOf = (deposit, rate) => minerals.depositForecast(deposit, rate).yearsToDepletion
  // 80,000 t at 0.7: 3 complexes of 10 mine equivalents at 10 t dig 210 t a year; a score of (0.8 + 0.7 + 2 × 1) / 4.
  const deep = body(1, 'Deep', [dep(1, 80000, 0.7)])
  // 10,500 t at 1 on a body that also holds 90,000 t of three other minerals at 0.9: a high headline potential, 300 t a year, a lifetime near 90 years.
  const marginal = body(2, 'Marginal', [dep(1, 10500, 1), dep(2, 90000, 0.9), dep(3, 90000, 0.9), dep(4, 90000, 0.9)])
  // Duranium that is plentiful and perfect, with no half of the original amount recorded, on a body rich in four other minerals: the top headline body, no lifetime.
  const rich = body(4, 'Rich', [dep(1, 200000, 1, null, 1), dep(2, 200000, 1), dep(3, 200000, 1), dep(4, 200000, 1), dep(5, 200000, 1)])
  const hot = body(5, 'Hot', [dep(1, 50000, 0.9)], { RadiationLevel: 10000 })

  return { candidates, minerals, provenance, value, unknown, dep, body, RACE, settings, rank, names, lifetimeOf, deep, marginal, rich, hot }
}

// ---------- the checks that need no save ----------

const pure = (ctx) => {
  const { m } = ctx
  const f = fixtures(m)
  const { candidates, minerals, provenance, value, unknown, dep, body, rank, names, lifetimeOf, deep, marginal, rich, hot } = f
  const statements = []
  const says = (texts) => texts.every((text) => typeof text === 'string' && text.length > 0)
  const add = (name, test) => statements.push([name, test])
  const byName = (result, name) => result.rows.find((row) => row.name === name)

  // ----- the swap -----
  add('swap: the marginal site leads under the headline order and the deep one under the longevity preference', () => {
    const headline = rank([deep, marginal])
    const longevity = rank([deep, marginal], { ranking: 'longevity' })

    return same([names(headline), names(longevity), headline.shown, longevity.shown], [['Marginal', 'Deep'], ['Deep', 'Marginal'], 'headline', 'longevity'])
  })
  add('swap: the ranks follow the shown order and both ranks are given in either mode', () => {
    const headline = rank([deep, marginal])
    const longevity = rank([deep, marginal], { ranking: 'longevity' })
    const pairs = (result) => result.rows.map((row) => [row.name, row.rank, row.headlineRank, row.longevityRank])

    return same([pairs(headline), pairs(longevity)], [[['Marginal', 1, 1, 2], ['Deep', 2, 2, 1]], [['Deep', 1, 2, 1], ['Marginal', 2, 1, 2]]])
  })
  add('swap: the scores are worked by hand: (0.8 + 0.7 + 2 × 1) / 4 and (0.105 + 1 + 2 × lifetime / 100) / 4', () => {
    const result = rank([deep, marginal], { ranking: 'longevity' })
    const marginalLifetime = lifetimeOf(marginal.depositList[0], 300)
    const expected = (0.105 + 1 + 2 * (marginalLifetime / 100)) / 4

    return near(value(byName(result, 'Deep').score), 0.875) && near(value(byName(result, 'Marginal').score), expected) && marginalLifetime > 35 && marginalLifetime < 100 ? true : short([value(byName(result, 'Deep').score), value(byName(result, 'Marginal').score), expected])
  })
  add('swap: editing a weight moves the order: accessibility alone puts the marginal site first, the lifetime or the reserve alone the deep one', () => {
    const only = (over) => names(rank([deep, marginal], { ranking: 'longevity', over: { reserveWeight: '0', accessibilityWeight: '0', lifetimeWeight: '0', ...over } }))

    return same([only({ accessibilityWeight: '1' }), only({ lifetimeWeight: '1' }), only({ reserveWeight: '1' })], [['Marginal', 'Deep'], ['Deep', 'Marginal'], ['Deep', 'Marginal']])
  })
  add('swap: the headline order is the default: no ranking, an unknown ranking and the headline all give it', () => same([names(rank([deep, marginal], { ranking: undefined })), names(rank([deep, marginal], { ranking: 'nonsense' })), rank([deep, marginal], { ranking: 'nonsense' }).requested], [['Marginal', 'Deep'], ['Marginal', 'Deep'], 'headline']))
  add('swap: both modes list the same candidates', () => same([...names(rank([deep, marginal, rich, hot]))].sort(), [...names(rank([deep, marginal, rich, hot], { ranking: 'longevity' }))].sort()))

  // ----- every term and assumption is visible -----
  add('terms: every row lists the reserve, accessibility and lifetime terms with the raw figure, the term, the weight and the contribution, and they add up to the score', () => {
    const result = rank([deep, marginal], { ranking: 'longevity' })
    const row = byName(result, 'Deep')
    const sum = row.terms.reduce((total, entry) => total + entry.contribution, 0)

    return same(row.terms.map((entry) => [entry.key, typeof entry.label === 'string' && entry.label.trim() !== '', near(value(entry.raw), { reserve: 80000, accessibility: 0.7, lifetime: lifetimeOf(deep.depositList[0], 210) }[entry.key]), entry.weight]), [['reserve', true, true, 1], ['accessibility', true, true, 1], ['lifetime', true, true, 2]]) === true && new Set(row.terms.map((entry) => entry.label)).size === row.terms.length && same(row.terms.map((entry) => [entry.key, Math.round(value(entry.term) * 1e6) / 1e6, Math.round(entry.contribution * 1e6) / 1e6]), [['reserve', 0.8, 0.2], ['accessibility', 0.7, 0.175], ['lifetime', 1, 0.5]]) === true && near(sum, value(row.score)) ? true : short(row.terms)
  })
  add('terms: every figure is a result of its rule with its provenance', () => {
    const row = byName(rank([deep, marginal], { ranking: 'longevity' }), 'Deep')
    const ids = [row.reserve, row.accessibility, row.lifetime, row.score, row.lines[0].rate, row.lines[0].lifetime, ...row.terms.map((entry) => entry.term)].map((result) => result.rule.id)

    return same(ids, ['cmcCandidate.reserve', 'cmcCandidate.accessibility', 'cmcCandidate.lifetime', 'cmcCandidate.score', 'cmcCandidate.rate', 'cmcCandidate.lifetime', 'cmcCandidate.term', 'cmcCandidate.term', 'cmcCandidate.term'])
  })
  add('terms: the lines of the assumptions name the complexes, the mine equivalents of one, the mine production, the bonuses, the horizon and the reference, each with a result and its provenance', () => {
    const result = rank([deep, marginal])

    return same([result.lines.map((line) => line.key), result.lines.map((line) => line.value)], [['complexes', 'complexMining', 'mineProduction', 'bonuses', 'horizon', 'reference'], [3, 10, 10, null, 100, 100000]]) === true && result.lines.every((line) => line.result && line.result.rule && line.result.status) && says([result.lines.find((line) => line.key === 'bonuses').note]) ? true : short(result.lines)
  })
  add('terms: a deposit\'s assumed output is the complexes times the mine equivalents of one, the mine production and the accessibility', () => {
    const result = rank([deep, marginal])

    return same([value(byName(result, 'Deep').lines[0].rate), value(byName(result, 'Marginal').lines[0].rate)], [3 * 10 * 10 * 0.7, 3 * 10 * 10 * 1])
  })
  add('terms: the score is a weighted mean: doubling every weight leaves the scores and the order as they were', () => {
    const one = rank([deep, marginal, hot], { ranking: 'longevity' })
    const two = rank([deep, marginal, hot], { ranking: 'longevity', over: { reserveWeight: '2', accessibilityWeight: '2', lifetimeWeight: '4' } })

    return same(names(one), names(two)) === true && one.rows.every((row) => near(value(row.score), value(byName(two, row.name).score))) ? true : short([names(one), names(two)])
  })
  add('terms: a weight of 0 leaves its term out of the score and its contribution is 0', () => {
    const row = byName(rank([deep], { ranking: 'longevity', over: { lifetimeWeight: '0' } }), 'Deep')

    return near(value(row.score), 0.75) && near(row.terms[0].contribution, 0.4) && near(row.terms[1].contribution, 0.35) && row.terms[2].contribution === 0 ? true : short(row.terms)
  })
  add('rate: a deposit\'s assumed output counts whole mine equivalents: the complexes times the mine equivalents of one are cut to a whole number before the production and the accessibility apply, and a capacity below 1 gives an output of 0 that is known', () => {
    const row = (complexMining, complexes) => byName(rank([deep], { race: { MineProduction: 10, ComplexMining: complexMining }, over: { complexes: String(complexes) } }), 'Deep')
    const output = (complexMining, complexes) => value(row(complexMining, complexes).lines[0].rate)
    const direct = (capacity) => minerals.surfaceRate({ ManualMineCount: 0, AutomatedMineCount: 0, CivilianMineCount: capacity, PurchaseCivilianMinerals: 1, Efficiency: 1, StabilityModifier: 1, MineProduction: 10, Accessibility: 0.7, GovernorBonus: 1, SectorBonus: 1, RadiationModifier: 1 }, false)
    const got = [output(0.5, 3), output(0.5, 1), output(0.25, 10), output(1.5, 3)]
    const idle = row(0.5, 1)

    return same(got.map((rate, index) => near(rate, [7, 0, 14, 28][index])), [true, true, true, true]) === true && near(direct(1.5), 7) && near(direct(4.5), 28) && provenance.isAvailable(idle.lifetime) && value(idle.lifetime) === 0 ? true : short([got, direct(1.5), idle.lifetime])
  })
  add('rank: the mark of the rank cell belongs to the order shown: the potential in the headline order, the score in the longevity order, each unknown where its own figure is', () => {
    const shaky = body(15, 'Shaky', [dep(1, 50000, 0.9), dep(2, null, null)])
    const headline = rank([deep, shaky, rich])
    const longevity = rank([deep, shaky, rich], { ranking: 'longevity' })
    const missing = (result) => (result.inputs && result.inputs.missing) || []
    const h = (name) => byName(headline, name)
    const l = (name) => byName(longevity, name)

    return same([provenance.isAvailable(h('Deep').rankResult), h('Deep').rankResult.rule.id, value(h('Deep').rankResult) === h('Deep').potential, h('Shaky').rank, unknown(h('Shaky').rankResult), missing(h('Shaky').rankResult).length > 0, provenance.isAvailable(h('Rich').rankResult)], [true, 'minerals.bodyPotential', true, null, true, true, true]) === true && same([provenance.isAvailable(l('Deep').rankResult), l('Deep').rankResult.rule.id, provenance.isAvailable(l('Shaky').rankResult), l('Rich').rank, unknown(l('Rich').rankResult), missing(l('Rich').rankResult)], [true, 'cmcCandidate.score', true, null, true, missing(l('Rich').score)]) === true && missing(l('Rich').rankResult).length > 0 && same(missing(l('Rich').rankResult), missing(h('Shaky').rankResult)) !== true ? true : short([h('Shaky').rankResult, l('Rich').rankResult])
  })
  add('terms: the rate is the whole product: more assumed complexes dig faster and the output shows in the lines', () => {
    const six = byName(rank([deep], { over: { complexes: '6' } }), 'Deep')

    return near(value(six.lines[0].rate), 6 * 10 * 10 * 0.7) ? true : short(six.lines[0].rate)
  })

  // ----- the caps of the terms -----
  add('cap: a reserve beyond the reference counts as the reference and a lifetime beyond the horizon as the horizon', () => {
    const term = (row, key) => value(row.terms.find((entry) => entry.key === key).term)
    const big = byName(rank([deep], { over: { reference: '50000', horizon: '1000' } }), 'Deep')
    const small = byName(rank([deep, marginal], { over: { reference: '1000000', horizon: '10' } }), 'Deep')
    const capped = byName(rank([marginal], { over: { reference: '100' } }), 'Marginal')

    return near(term(big, 'reserve'), 1) && near(term(big, 'lifetime'), lifetimeOf(deep.depositList[0], 210) / 1000) && near(term(small, 'reserve'), 0.08) && near(term(small, 'lifetime'), 1) && near(term(capped, 'reserve'), 1) ? true : short([term(big, 'reserve'), term(big, 'lifetime'), term(small, 'reserve'), term(small, 'lifetime'), term(capped, 'reserve')])
  })

  // ----- the lifetime -----
  add('lifetime: a body\'s lifetime is the longest of its qualifying deposits, each from the decline model at the assumed rate', () => {
    const both = body(11, 'Both', [dep(1, 80000, 0.7), dep(11, 20000, 0.9)])
    const row = byName(rank([both]), 'Both')
    const [du, ga] = row.lines
    const expected = [lifetimeOf(both.depositList[0], 210), lifetimeOf(both.depositList[1], 270)]

    return near(value(du.lifetime), expected[0]) && near(value(ga.lifetime), expected[1]) && near(value(row.lifetime), Math.max(...expected)) && near(value(row.reserve), 100000) && near(value(row.accessibility), 0.74) ? true : short([value(du.lifetime), value(ga.lifetime), value(row.lifetime), expected])
  })
  add('lifetime: it follows the decline model, not the amount over the rate', () => {
    const row = byName(rank([marginal]), 'Marginal')
    const years = value(row.lifetime)

    return near(years, lifetimeOf(marginal.depositList[0], 300)) && years > 10500 / 300 + 1 ? true : years
  })
  add('lifetime: more assumed complexes shorten it', () => {
    const three = value(byName(rank([deep]), 'Deep').lifetime)
    const six = value(byName(rank([deep], { over: { complexes: '6' } }), 'Deep').lifetime)

    return near(six, lifetimeOf(deep.depositList[0], 420)) && six < three ? true : short([three, six])
  })
  add('lifetime: the radiation of the body lowers the rate, and a body whose radiation leaves no output has a lifetime of 0 that is known', () => {
    const half = body(12, 'Half', [dep(1, 80000, 0.7)], { RadiationLevel: 5000 })
    const row = byName(rank([half]), 'Half')
    const none = byName(rank([hot]), 'Hot')

    return near(value(row.lines[0].rate), 105) && near(value(row.lifetime), lifetimeOf(half.depositList[0], 105)) && value(none.lines[0].rate) === 0 && provenance.isAvailable(none.lifetime) && value(none.lifetime) === 0 ? true : short([row.lines[0].rate, none.lifetime])
  })

  // ----- unknown stays unknown -----
  add('unknown: a Duranium deposit with no recorded amount is a possible candidate whose figures are unknown, never 0, with no rank and last in both orders', () => {
    const open = body(7, 'Unread', [dep(1, null, 0.9)])
    const headline = rank([open, deep, marginal])
    const longevity = rank([open, deep, marginal], { ranking: 'longevity' })
    const row = byName(longevity, 'Unread')

    return same([row.status, [row.reserve, row.accessibility, row.lifetime, row.score].map(unknown), [row.reserve, row.accessibility, row.lifetime, row.score].map(value), row.rank, row.headlineRank, row.longevityRank, names(headline).slice(-1), names(longevity).slice(-1)], ['possible', [true, true, true, true], [null, null, null, null], null, null, null, ['Unread'], ['Unread']])
  })
  add('unknown: an unreadable deposit beside a qualifying one leaves the reserve unknown, not the smaller sum', () => {
    const partial = body(6, 'Partial', [dep(1, 20000, 0.9), dep(11, null, null)])
    const row = byName(rank([partial], { ranking: 'longevity' }), 'Partial')

    return row.status === 'known' && unknown(row.reserve) && unknown(row.accessibility) && unknown(row.lifetime) && unknown(row.score) && row.longevityRank === null && row.headlineRank === null && value(row.lines[0].rate) === 3 * 10 * 10 * 0.9 && unknown(row.lines[1].rate) ? true : short(row)
  })
  add('unknown: an unreadable deposit that cannot qualify is no candidate', () => same(names(rank([body(8, 'Poor', [dep(1, null, 0.3)]), body(9, 'Small', [dep(1, 5000, null)]), body(10, 'Iron', [dep(2, 99999, 1)])])), []))
  add('unknown: a race figure the save does not record leaves the rate, the lifetime and the score unknown while the reserve and the accessibility stay known', () => {
    const rows = [{ MineProduction: null, ComplexMining: 10 }, { MineProduction: 10, ComplexMining: null }, null].map((race) => byName(rank([deep], { race, ranking: 'longevity' }), 'Deep'))

    return rows.every((row) => unknown(row.lines[0].rate) && unknown(row.lifetime) && unknown(row.score) && value(row.lifetime) === null && provenance.isAvailable(row.reserve) && provenance.isAvailable(row.accessibility) && row.longevityRank === null) ? true : short(rows.map((row) => [row.lifetime, row.score]))
  })
  add('unknown: a radiation level the save does not record leaves the rate and the lifetime unknown', () => {
    const row = byName(rank([body(13, 'Unmeasured', [dep(1, 80000, 0.7)], { RadiationLevel: null })], { ranking: 'longevity' }), 'Unmeasured')

    return unknown(row.lines[0].rate) && unknown(row.lifetime) && unknown(row.score) && provenance.isAvailable(row.reserve) ? true : short(row)
  })
  add('unknown: a half of the original amount or an original accessibility the save does not record leaves the lifetime unknown and the reserve known', () => {
    const rows = [dep(1, 80000, 0.7, null, 0.7), dep(1, 80000, 0.7, 80000, null)].map((deposit, index) => byName(rank([body(14 + index, 'Gap', [deposit])], { ranking: 'longevity' }), 'Gap'))

    return rows.every((row) => unknown(row.lifetime) && unknown(row.score) && value(row.reserve) === 80000 && provenance.isAvailable(row.lines[0].rate)) ? true : short(rows.map((row) => row.lifetime))
  })
  add('unknown: an unknown score sorts after every known one, and the row keeps its headline rank', () => {
    const headline = rank([deep, marginal, rich])
    const longevity = rank([deep, marginal, rich], { ranking: 'longevity' })
    const row = byName(longevity, 'Rich')

    return same([names(headline), names(longevity), row.headlineRank, row.longevityRank, row.rank], [['Rich', 'Marginal', 'Deep'], ['Deep', 'Marginal', 'Rich'], 1, null, null])
  })
  add('unknown: a known score of 0 ranks ahead of an unknown one', () => {
    const result = rank([deep, marginal, rich, hot], { ranking: 'longevity', over: { reserveWeight: '0', accessibilityWeight: '0', lifetimeWeight: '1' } })

    return same([names(result), value(byName(result, 'Hot').score), byName(result, 'Hot').longevityRank, byName(result, 'Rich').longevityRank], [['Deep', 'Marginal', 'Hot', 'Rich'], 0, 3, null])
  })
  add('unknown: a body with no unknown deposit but an unreadable other mineral keeps its score and has no headline potential', () => {
    const shaky = body(15, 'Shaky', [dep(1, 50000, 0.9), dep(2, null, null)])
    const result = rank([shaky, deep], { ranking: 'longevity' })
    const row = byName(result, 'Shaky')

    return row.potential === null && row.headlineRank === null && provenance.isAvailable(row.score) && row.longevityRank !== null && names(rank([shaky, deep])).slice(-1)[0] === 'Shaky' ? true : short(row)
  })
  add('unknown: a game that founds no complexes, a body with a complex, one out of reach and a body not listed for its deposits have no candidates', () => same([names(rank([deep], { allowed: false })), names(rank([body(1, 'Taken', deep.depositList, { complexes: 2 })])), names(rank([body(1, 'Far', deep.depositList, { cmcInReach: false })])), names(rank([body(1, 'Bare', deep.depositList, { bare: true })])), rank([deep], { allowed: false }).allowed], [[], [], [], [], false]))
  add('unknown: a body whose civilian complex count is not recorded is a possible candidate, unranked in both orders and unknown in every figure, and a body with a complex or with none recorded is as before', () => {
    const hidden = body(1, 'Hidden', deep.depositList, { complexGaps: 1 })
    const counted = body(1, 'Counted', deep.depositList, { complexGaps: 0 })
    const taken = body(1, 'Taken', deep.depositList, { complexes: 2, complexGaps: 1 })
    const problems = []

    for (const ranking of ['headline', 'longevity']) {
      const result = rank([hidden, marginal], { ranking })
      const row = byName(result, 'Hidden')
      const control = byName(rank([counted, marginal], { ranking }), 'Counted')
      const figures = [row.reserve, row.accessibility, row.lifetime, row.score, row.potentialResult, ...row.lines.map((line) => line.rate)]

      if (row.status !== 'possible' || row.rank !== null || row.headlineRank !== null || row.longevityRank !== null || row.potential !== null || !figures.every(unknown) || !row.reserve.inputs.missing.length || !row.reserve.inputs.missing.every((text) => !RAW_POINTER.test(text)) || row.possibleBecause.length !== 1 || names(result).slice(-1)[0] !== 'Hidden' || byName(result, 'Marginal').rank !== 1) {
        problems.push(`${ranking}: ${short(row)}`)
      }

      if (control.status !== 'known' || control.headlineRank === null || control.longevityRank === null || control.possibleBecause.length !== 0 || names(rank([taken, marginal], { ranking })).includes('Taken')) {
        problems.push(`${ranking}: ${short(control)}`)
      }
    }

    return problems.length ? short(problems) : true
  })

  // ----- the settings -----
  add('settings: a blank complexes leaves every rate, lifetime and score unknown, with a note, and the reserve and accessibility known', () => {
    const result = rank([deep, marginal], { ranking: 'longevity', over: { complexes: '' } })
    const row = byName(result, 'Deep')

    return unknown(row.lines[0].rate) && unknown(row.lifetime) && unknown(row.score) && provenance.isAvailable(row.reserve) && result.notes.length === 1 && says(result.notes) && result.blocking.length === 0 && result.fellBack === false ? true : short([result.notes, row.lifetime])
  })
  add('settings: with the lifetime weight 0 a blank complexes leaves the score known', () => {
    const result = rank([deep, marginal], { ranking: 'longevity', over: { complexes: '', lifetimeWeight: '0' } })

    return result.rows.every((row) => provenance.isAvailable(row.score) && row.longevityRank !== null) && unknown(result.rows[0].lifetime) ? true : short(result.rows.map((row) => row.score))
  })
  add('settings: a blank weight makes the longevity ranking unavailable: every score unknown, the reason stated, the rows in the headline order', () => {
    const result = rank([deep, marginal], { ranking: 'longevity', over: { reserveWeight: '' } })

    return same([result.fellBack, result.shown, result.requested, names(result), result.blocking.length === 1 && says(result.blocking), result.rows.map((row) => unknown(row.score)), result.rows.map((row) => row.longevityRank)], [true, 'headline', 'longevity', ['Marginal', 'Deep'], true, [true, true], [null, null]])
  })
  add('settings: a blank weight is read as neither 0 nor the default', () => {
    const blank = rank([deep], { ranking: 'longevity', over: { lifetimeWeight: '' } })
    const zero = rank([deep], { ranking: 'longevity', over: { lifetimeWeight: '0' } })

    return unknown(blank.rows[0].score) && provenance.isAvailable(zero.rows[0].score) && blank.parsed.lifetimeWeight.value === null && blank.parsed.lifetimeWeight.state === 'blank' ? true : short([blank.parsed.lifetimeWeight, blank.rows[0].score])
  })
  add('settings: a negative, non-numeric, exponent, hexadecimal, infinite, comma or over-long entry is rejected with a reason and never becomes a value', () => {
    const entries = ['-1', '-0.5', 'abc', '1e3', '0x10', 'Infinity', '1,5', '+2', '--1', '9'.repeat(400)]
    const bad = entries.filter((text) => {
      const read = candidates.parseSettings({ reserveWeight: text }).reserveWeight

      return read.state !== 'rejected' || read.value !== null || typeof read.reason !== 'string' || !read.reason
    }).map((text) => text.slice(0, 12))

    return bad.length ? short(bad) : true
  })
  add('settings: a rejected weight makes the longevity ranking unavailable and says why, as a blank one does', () => {
    const result = rank([deep, marginal], { ranking: 'longevity', over: { accessibilityWeight: '-2' } })

    return result.fellBack === true && result.blocking.length === 1 && says(result.blocking) && result.rows.every((row) => unknown(row.score)) ? true : short([result.fellBack, result.blocking])
  })
  add('settings: the complexes must be a whole number of 1 or more, the horizon and the reference above 0, a weight of 0 is allowed', () => {
    const state = (key, text) => candidates.parseSettings({ [key]: text })[key].state
    const got = [state('complexes', '0'), state('complexes', '2.5'), state('complexes', '3'), state('horizon', '0'), state('horizon', '0.5'), state('reference', '0'), state('reference', '1'), state('lifetimeWeight', '0'), state('lifetimeWeight', '0.25')]

    return same(got, ['rejected', 'rejected', 'ok', 'rejected', 'ok', 'rejected', 'ok', 'ok', 'ok'])
  })
  add('settings: every weight 0 makes the longevity ranking unavailable with a reason', () => {
    const result = rank([deep, marginal], { ranking: 'longevity', over: { reserveWeight: '0', accessibilityWeight: '0', lifetimeWeight: '0' } })

    return result.fellBack === true && result.blocking.length > 0 && result.rows.every((row) => unknown(row.score)) && names(result)[0] === 'Marginal' ? true : short([result.blocking, result.fellBack])
  })
  add('settings: a weight of 0 leaves its term out even when its assumption is blank', () => {
    const noHorizon = rank([deep, marginal], { ranking: 'longevity', over: { lifetimeWeight: '0', horizon: '' } })
    const noReference = rank([deep, marginal], { ranking: 'longevity', over: { reserveWeight: '0', reference: '' } })

    return noHorizon.rows.every((row) => provenance.isAvailable(row.score)) && noReference.rows.every((row) => provenance.isAvailable(row.score)) && noHorizon.notes.length === 1 && says(noHorizon.notes) && noReference.notes.length === 1 && says(noReference.notes) ? true : short([noHorizon.notes, noReference.notes])
  })
  add('settings: each blank or rejected field gives a reason of its own, no two fields sharing one', () => {
    const weights = ['reserveWeight', 'accessibilityWeight', 'lifetimeWeight']
    const assumptions = ['complexes', 'horizon', 'reference']
    const lists = (text) => [...weights.map((key) => rank([deep], { ranking: 'longevity', over: { [key]: text } }).blocking), ...assumptions.map((key) => rank([deep], { ranking: 'longevity', over: { [key]: text } }).notes)]
    const problems = ['', '-1'].flatMap((text) => {
      const reasons = lists(text)

      return reasons.every((list) => list.length === 1 && says(list)) && new Set(reasons.map((list) => list[0])).size === reasons.length ? [] : [`${JSON.stringify(text)}: ${short(reasons)}`]
    })

    return problems.length ? short(problems) : true
  })
  add('settings: a blank horizon or reference leaves the term it scales unknown, with a note, while a weight above 0 asks for it', () => {
    const noHorizon = rank([deep], { ranking: 'longevity', over: { horizon: '' } })
    const noReference = rank([deep], { ranking: 'longevity', over: { reference: '' } })

    return unknown(noHorizon.rows[0].score) && unknown(noReference.rows[0].score) && provenance.isAvailable(noHorizon.rows[0].lifetime) && noHorizon.notes.length === 1 && noReference.notes.length === 1 ? true : short([noHorizon.notes, noReference.notes])
  })
  add('settings: typed text is trimmed, a leading dot or a trailing dot is a number', () => {
    const read = (text) => candidates.parseSettings({ reserveWeight: text }).reserveWeight

    return same([read(' 2 ').value, read('.5').value, read('2.').value, read('   ').state, read(undefined).state, read(3).value], [2, 0.5, 2, 'blank', 'blank', 3])
  })
  add('settings: the stored settings come back as text for every field: absent is the default, a blank or a null is blank, a number is its text, an over-long text is kept bounded', () => {
    const { normaliseSettings, DEFAULT_SETTINGS, MAX_TEXT } = candidates
    const stored = normaliseSettings({ reserveWeight: '', lifetimeWeight: 5, complexes: 'x'.repeat(30), horizon: '7' })

    return same([normaliseSettings(null), normaliseSettings([]), normaliseSettings('x'), normaliseSettings(undefined), stored, normaliseSettings({ horizon: null, reference: {}, complexes: NaN }), normaliseSettings({ ...DEFAULT_SETTINGS })], [undefined, undefined, undefined, undefined, { reserveWeight: '', accessibilityWeight: DEFAULT_SETTINGS.accessibilityWeight, lifetimeWeight: '5', complexes: 'x'.repeat(MAX_TEXT + 1), horizon: '7', reference: DEFAULT_SETTINGS.reference }, { ...DEFAULT_SETTINGS, horizon: '', reference: '', complexes: '' }, { ...DEFAULT_SETTINGS }])
  })
  add('domain: a stored text read back means what the typed text meant: the same reading, never a default, bounded in length, an over-long entry still rejected', () => {
    const { normaliseSettings, parseSettings, DEFAULT_SETTINGS, SETTING_FIELDS, MAX_TEXT, LIMITS } = candidates
    const texts = ['', '  ', '0', '2', '0.5', '.5', '2.', '-1', 'abc', '1e3', 'Infinity', '1'.repeat(MAX_TEXT), '1'.repeat(MAX_TEXT + 1), `0.${'1'.repeat(MAX_TEXT + 1)}`, '9'.repeat(400), '1'.padEnd(309, '0'), String(LIMITS.weight), String(LIMITS.weight + 1)]
    const bad = []

    texts.forEach((text) => SETTING_FIELDS.forEach((field) => {
      const typed = { ...DEFAULT_SETTINGS, [field.key]: text }
      const stored = normaliseSettings(JSON.parse(JSON.stringify(typed)))
      const back = parseSettings(stored)[field.key]
      const long = text.length > MAX_TEXT

      if (same(back, parseSettings(typed)[field.key]) !== true || stored[field.key].length > MAX_TEXT + 1 || (long && (stored[field.key] === DEFAULT_SETTINGS[field.key] || back.state !== 'rejected' || back.value !== null))) {
        bad.push([field.key, text.slice(0, 12), back.state])
      }
    }))

    return bad.length ? short(bad.slice(0, 4)) : true
  })
  add('domain: each field accepts its limit and rejects the value above it', () => {
    const { parseSettings, SETTING_FIELDS, LIMITS } = candidates
    const bad = SETTING_FIELDS.filter((field) => parseSettings({ [field.key]: String(LIMITS[field.kind]) })[field.key].state !== 'ok' || parseSettings({ [field.key]: String(LIMITS[field.kind] + 1) })[field.key].state !== 'rejected').map((field) => field.key)

    return bad.length ? short(bad) : true
  })
  add('domain: the largest weights allowed give finite scores between 0 and 1 that add up from their contributions in both orders, and an over-long weight is rejected without a throw', () => {
    const { LIMITS } = candidates
    const largest = String(LIMITS.weight)
    const over = { reserveWeight: largest, accessibilityWeight: largest, lifetimeWeight: largest }
    const modes = ['headline', 'longevity'].map((ranking) => rank([deep, marginal, hot], { ranking, over }))
    const sound = modes.every((result) => result.rows.every((row) => {
      const score = value(row.score)

      return score !== null && Number.isFinite(score) && score >= 0 && score <= 1 && near(row.terms.reduce((total, entry) => total + entry.contribution, 0), score)
    }))
    const huge = ['headline', 'longevity'].map((ranking) => rank([deep, marginal], { ranking, over: { reserveWeight: '1'.padEnd(309, '0') } }))

    return sound && huge[0].shown === 'headline' && huge[1].fellBack === true && huge[1].blocking.length === 1 && huge[1].rows.every((row) => unknown(row.score)) ? true : short([modes.map((result) => result.rows.map((row) => value(row.score))), huge[1].blocking])
  })
  add('domain: the longest text the settings read is the one the page lets be typed', () => (Number.isInteger(candidates.MAX_TEXT) && candidates.MAX_TEXT > 0 && candidates.parseSettings({ reserveWeight: `0.${'1'.repeat(candidates.MAX_TEXT - 2)}` }).reserveWeight.state === 'ok' && candidates.parseSettings({ reserveWeight: `0.${'1'.repeat(candidates.MAX_TEXT - 1)}` }).reserveWeight.state === 'rejected' ? true : candidates.MAX_TEXT))
  add('settings: the fields offered are the three weights, the complexes, the horizon and the reference, each with a label and a hint', () => same(candidates.SETTING_FIELDS.map((field) => [field.key, field.kind, !!field.label, !!field.hint]), [['reserveWeight', 'weight', true, true], ['accessibilityWeight', 'weight', true, true], ['lifetimeWeight', 'weight', true, true], ['complexes', 'count', true, true], ['horizon', 'positive', true, true], ['reference', 'positive', true, true]]))

  // ----- the headline order stays the default -----
  add('headline: the order is potential to a tenth, then accessibility, then amount, then the name: the better accessibility wins a tie of potential whatever the names', () => {
    const p = body(21, 'A P', [dep(1, 30000, 0.9)])
    const q = body(22, 'B Q', [dep(1, 30000, 0.9), dep(2, 100, 0.95)])
    const result = rank([p, q])
    const potentials = result.rows.map((row) => Math.round(row.potential * 10))

    return potentials[0] === potentials[1] && same(names(result), ['B Q', 'A P']) === true ? true : short([potentials, names(result)])
  })
  add('headline: a body whose potential is not known comes last, with no rank', () => {
    const result = rank([body(15, 'Shaky', [dep(1, 50000, 0.9), dep(2, null, null)]), deep, marginal])

    return same([names(result), result.rows.map((row) => row.rank)], [['Marginal', 'Deep', 'Shaky'], [1, 2, null]])
  })
  add('headline: with the preference off, no setting changes the candidates, their order or their ranks, and a blank weight is no fallback', () => {
    const base = rank([deep, marginal, rich, hot])
    const shape = (result) => [names(result), result.rows.map((row) => [row.rank, row.headlineRank, row.potential]), result.shown, result.fellBack]
    const variants = [{ reserveWeight: '' }, { reserveWeight: '-3', lifetimeWeight: '99' }, { complexes: '' }, { horizon: 'x', reference: '' }, { reserveWeight: '0', accessibilityWeight: '0', lifetimeWeight: '0' }, { accessibilityWeight: '50' }]

    return variants.every((over) => same(shape(rank([deep, marginal, rich, hot], { over })), shape(base)) === true) && base.shown === 'headline' && base.fellBack === false ? true : short(shape(base))
  })
  add('headline: the headline ranks are the same in both modes', () => {
    const headline = rank([deep, marginal, rich, hot])
    const longevity = rank([deep, marginal, rich, hot], { ranking: 'longevity' })

    return same(headline.rows.map((row) => [row.name, row.headlineRank]).sort(), longevity.rows.map((row) => [row.name, row.headlineRank]).sort())
  })

  // ----- the ranking is the player's own -----
  add('prediction: every text the ranking shows is in the UI voice: no first or second person', () => {
    const result = rank([deep, marginal], { ranking: 'longevity', over: { reserveWeight: '', complexes: '' } })
    const texts = [...candidates.SETTING_FIELDS.flatMap((field) => [field.label, field.hint]), ...candidates.TERMS.map((term) => term.label), ...candidates.RANKINGS.map((ranking) => ranking.label), ...result.lines.flatMap((line) => [line.label, line.note || '']), ...result.notes, ...result.blocking, ...rank([body(1, 'Hidden', deep.depositList, { complexGaps: 1 })]).rows.flatMap((row) => row.possibleBecause), ...['cmcCandidate.input', 'cmcCandidate.deposit', 'cmcCandidate.reserve', 'cmcCandidate.accessibility', 'cmcCandidate.rate', 'cmcCandidate.lifetime', 'cmcCandidate.term', 'cmcCandidate.score'].flatMap((id) => [provenance.getRule(id).note, ...(provenance.getRule(id).assumptions || [])])]
    const bad = texts.filter((text) => TEXT_PRONOUNS.test(text))

    return bad.length ? short(bad) : true
  })

  return statements
}

// ---------- the page ----------

// The template of the page as Vue 2 parses it, with the source range of each element, and the text it was parsed from.
const templateOf = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const content = (parsed.descriptor || parsed).template.content

  return { content, ast: compiler.compileTemplate({ source: content, filename: 'page.vue', id: 'page', compilerOptions: { outputSourceRange: true } }).ast || null }
}

// Visits an element of the template and everything under it: its children, its other v-if branches and its scoped slots.
const walk = (node, visit) => {
  if (!node) {
    return
  }

  visit(node)

  if (node.type !== 1) {
    return
  }

  const nested = [...node.children, ...(node.ifConditions || []).slice(1).map((condition) => condition.block), ...Object.values(node.scopedSlots || {})]

  nested.forEach((child) => walk(child, visit))
}

const elementsOf = (root, test) => {
  const hits = []

  walk(root, (node) => {
    if (node.type === 1 && test(node)) {
      hits.push(node)
    }
  })

  return hits
}

const attrOf = (el, name) => (el.attrsMap || {})[name]
const classOf = (el) => attrOf(el, 'class') || ''

// Every top-level .panel of the page's template, each compiled to a render function of its own: which of them holds the candidates is decided by what it renders, not by how its table is written.
const panelsOf = (pageText) => {
  const compiler = require('vue/compiler-sfc')
  const { content, ast } = templateOf(pageText)
  const top = (el) => {
    for (let node = el.parent; node; node = node.parent) {
      if (/\bpanel\b/.test(classOf(node))) {
        return false
      }
    }

    return true
  }

  return elementsOf(ast, (el) => el.tag === 'v-card' && /\bpanel\b/.test(classOf(el)) && top(el)).map((el) => {
    const compiled = compiler.compileTemplate({ source: `<div>${content.slice(el.start, content.indexOf('>', el.end - 1) + 1)}</div>`, filename: 'panel.vue', id: 'panel' })

    return compiled.errors.length ? { el, errors: compiled.errors.map(String) } : { el, errors: [], ...nodeVm.runInThisContext(`(function () {\n${compiled.code}\nreturn { render, staticRenderFns }\n})()`) }
  })
}

// ---------- what Vue renders ----------

Vue.config.productionTip = false
Vue.config.devtools = false

let warned = []
let thrown = []

Vue.config.warnHandler = (message) => warned.push(message)
Vue.config.errorHandler = (error) => thrown.push(error)

class MemoryConfig {
  constructor(entries = []) {
    this.values = new Map(entries)
  }

  get(key, fallback) {
    return this.values.has(key) ? JSON.parse(this.values.get(key)) : fallback
  }

  set(key, value) {
    this.values.set(key, JSON.stringify(value))
  }

  // A restart: the settings as the file holds them, read by another store.
  reopened() {
    return new MemoryConfig([...this.values])
  }
}

const KEY = 'campaign.c1.race.7'
const OTHER = 'campaign.c1.race.8'

const flush = async () => {
  await Vue.nextTick()
  await Vue.nextTick()
}

const textOf = (node) => (typeof node.text === 'string' ? node.text : (node.children || []).map(textOf).join(''))

const nodesOf = (node, test, found = []) => {
  if (test(node)) {
    found.push(node)
  }

  ;(node.children || []).forEach((child) => nodesOf(child, test, found))

  return found
}

const isMark = (node) => /provenance-mark$/.test(node.tag || '')

// The nodes a scoped slot of the table gives for the arguments.
const cellOf = (table, name, args) => {
  const slot = table.data.scopedSlots[name]

  return slot ? [].concat(slot(args) || []) : []
}

const marksOf = (nodes) => nodesOf({ children: nodes }, isMark).map((node) => node.data.attrs)
const cellText = (nodes) => nodes.map(textOf).join('')

// What a result stands for in a mark: its rule, its status and the inputs it lacks.
const standsFor = (result) => JSON.stringify([result.rule && result.rule.id, result.status, (result.inputs && result.inputs.missing) || []])

const asyncDefaults = (options) => {
  const flat = (part) => [...(part.mixins || []).flatMap(flat), part]

  return Object.fromEntries(flat(options).flatMap((part) => Object.entries(part.asyncComputed || {})).map(([name, read]) => [name, typeof read.default === 'function' ? read.default.call({}) : read.default]))
}

// ---------- an in-memory database of the tables and columns the page's reads touch ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows]))))
const closeRaw = (raw) => new Promise((resolve) => raw.close(resolve))

const MINERAL_NAMES = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']

const MEMORY_SCHEMA = {
  FCT_Game: ['GameID', 'AllowCMC'],
  FCT_Race: ['RaceID', 'GameID', 'NPR', 'MineProduction', 'MaximumOrbitalMiningDiameter'],
  DIM_PlanetaryInstallation: ['PlanetaryInstallationID', 'CivilianInstallation', 'Workers', 'MiningProductionValue', 'MassDriverValue'],
  FCT_SystemBody: ['SystemBodyID', 'SystemID', 'StarID', 'ParentBodyID', 'ParentBodyType', 'PlanetNumber', 'OrbitNumber', 'BodyClass', 'BodyTypeID', 'Radius', 'Xcor', 'Ycor', 'GroundMineralSurvey', 'OrbitalDistance', 'Eccentricity', 'RadiationLevel'],
  FCT_MineralDeposit: ['GameID', 'SystemBodyID', 'MaterialID', 'Amount', 'Accessibility', 'HalfOriginalAmount', 'OriginalAcc'],
  FCT_RaceSysSurvey: ['SystemID', 'RaceID', 'GameID', 'Name'],
  FCT_SystemBodyName: ['SystemBodyID', 'RaceID', 'Name'],
  FCT_Star: ['StarID', 'Component'],
  FCT_SystemBodySurveys: ['GameID', 'RaceID', 'SystemBodyID'],
  FCT_Population: ['PopulationID', 'GameID', 'RaceID', 'PopName', 'SystemID', 'SystemBodyID', 'Population', 'Capital', 'MassDriverDest', 'PurchaseCivilianMinerals', ...MINERAL_NAMES.flatMap((name) => [name, `Reserve${name}`])],
  FCT_PopulationInstallations: ['PopID', 'GameID', 'PlanetaryInstallationID', 'Amount'],
}

const body = (id, system, over = {}) => ({ SystemBodyID: id, SystemID: system, StarID: 1, ParentBodyID: null, ParentBodyType: null, PlanetNumber: 1, OrbitNumber: 1, BodyClass: 3, BodyTypeID: 1, Radius: 100, Xcor: null, Ycor: null, GroundMineralSurvey: 0, OrbitalDistance: 2, Eccentricity: 0, RadiationLevel: 0, ...over })
const stored = (body, material, amount, accessibility, over = {}) => ({ GameID: 1, SystemBodyID: body, MaterialID: material, Amount: amount, Accessibility: accessibility, HalfOriginalAmount: amount, OriginalAcc: accessibility, ...over })

// Game 1, race 2: body 1 (radiation 12.5) and body 2 (radiation not recorded, a moon of body 5) are surveyed by the race in a system it knows; body 3 is surveyed by another race, body 4 lies in a system the race does not know, game 9 has a deposit on body 1, and the largest mining value of an installation (25) is not a civilian one.
const MEMORY_ROWS = {
  FCT_Game: [{ GameID: 1, AllowCMC: 1 }],
  FCT_Race: [{ RaceID: 2, GameID: 1, NPR: 0, MineProduction: 10, MaximumOrbitalMiningDiameter: 200 }],
  DIM_PlanetaryInstallation: [{ PlanetaryInstallationID: 1, CivilianInstallation: 1, MiningProductionValue: 8 }, { PlanetaryInstallationID: 2, CivilianInstallation: 1, MiningProductionValue: 10 }, { PlanetaryInstallationID: 3, CivilianInstallation: 0, MiningProductionValue: 25 }],
  FCT_SystemBody: [body(1, 1, { RadiationLevel: 12.5 }), body(2, 1, { ParentBodyID: 5, ParentBodyType: 1, RadiationLevel: null }), body(3, 1), body(4, 2), body(5, 1, { OrbitalDistance: 7 })],
  FCT_MineralDeposit: [stored(1, 1, 80000, 0.7), stored(2, 1, 5000, 1, { HalfOriginalAmount: null }), stored(3, 1, 90000, 0.9), stored(4, 1, 90000, 0.9), stored(1, 1, 90000, 0.9, { GameID: 9 })],
  FCT_RaceSysSurvey: [{ SystemID: 1, RaceID: 2, GameID: 1, Name: 'Sol' }, { SystemID: 2, RaceID: 3, GameID: 1, Name: 'Elsewhere' }],
  FCT_SystemBodyName: [{ SystemBodyID: 1, RaceID: 2, Name: 'Deep' }, { SystemBodyID: 1, RaceID: 3, Name: 'Other' }],
  FCT_Star: [{ StarID: 1, Component: 1 }],
  FCT_SystemBodySurveys: [{ GameID: 1, RaceID: 2, SystemBodyID: 1 }, { GameID: 1, RaceID: 2, SystemBodyID: 2 }, { GameID: 1, RaceID: 2, SystemBodyID: 4 }, { GameID: 1, RaceID: 3, SystemBodyID: 3 }],
  FCT_Population: [],
  FCT_PopulationInstallations: [],
}

// `without` lists tables ('FCT_Star') and columns ('FCT_SystemBody.RadiationLevel') the database lacks, `rows` replaces the rows of a table.
const memoryDatabase = async (without = [], rows = {}) => {
  const raw = await new Promise((resolve, reject) => {
    const opened = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(opened)))
  })
  const run = (sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))
  const literal = (cell) => (cell === null || cell === undefined ? 'null' : typeof cell === 'string' ? `'${cell.replace(/'/g, "''")}'` : String(cell))

  for (const [table, columns] of Object.entries(MEMORY_SCHEMA)) {
    if (!without.includes(table)) {
      const kept = columns.filter((column) => !without.includes(`${table}.${column}`))

      await run(`create table ${table} (${kept.join(', ')})`)

      for (const row of rows[table] || MEMORY_ROWS[table]) {
        await run(`insert into ${table} (${kept.join(', ')}) values (${kept.map((column) => literal(row[column])).join(', ')})`)
      }
    }
  }

  return { query: (sql) => allRows(raw, sql), close: () => closeRaw(raw) }
}

const page = (ctx) => {
  const { m, pageText, pageOptions, persistedOptions, readOptions } = ctx
  const f = fixtures(m)
  const { candidates, provenance, value, unknown, rank, deep, rich, RACE } = f
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const mount = (data = {}) => instantiate(pageOptions, { $store: STORE, data })
  const row = (id, name, material, amount, accessibility, over = {}) => ({ MaterialID: material, Amount: amount, Accessibility: accessibility, HalfOriginalAmount: amount, OriginalAcc: accessibility, SystemID: 1, SystemBodyID: id, PlanetNumber: 1, OrbitNumber: 1, BodyClass: 3, BodyTypeID: 1, Radius: 100, Xcor: null, Ycor: null, GroundMineralSurvey: 0, OrbitalDistance: 2, Eccentricity: 0, RadiationLevel: 0, ParentOrbitalDistance: null, SystemBodyName: name, Component: 1, SystemName: 'Sol', ...over })
  const deposits = [row(1, 'Deep', 1, 80000, 0.7), row(2, 'Marginal', 1, 10500, 1), row(2, 'Marginal', 2, 90000, 0.9), row(2, 'Marginal', 3, 90000, 0.9), row(2, 'Marginal', 4, 90000, 0.9), row(3, 'Far', 1, 90000, 0.9, { OrbitalDistance: 200 })]
  const race = { ...RACE, MaximumOrbitalMiningDiameter: 200, AllowCMC: true }
  const panels = panelsOf(pageText)
  const panelDeposits = [...deposits, row(15, 'Shaky', 1, 50000, 0.9), row(15, 'Shaky', 2, null, null), row(16, 'Partial', 1, 20000, 0.9), row(16, 'Partial', 11, null, null), row(4, 'Rich', 1, 200000, 1, { HalfOriginalAmount: null }), row(4, 'Rich', 2, 200000, 1), row(4, 'Rich', 3, 200000, 1), row(4, 'Rich', 4, 200000, 1), row(4, 'Rich', 5, 200000, 1)]

  // The page as a real Vue instance over the real persisted-view mixin and an in-memory settings store, with the rows of the deposits read given.
  const mountPage = ({ config = new MemoryConfig(), prefix = KEY } = {}) => {
    const store = Vue.observable({ getters: { racePrefix: prefix, config, database: null, GameID: 1, RaceID: 7 }, state: {} })
    const defaults = asyncDefaults(persistedOptions)
    const vm = new Vue({
      mixins: [persistedOptions],
      data: () => ({ ...defaults, race, deposits: panelDeposits }),
      beforeCreate() {
        this.$store = store
      },
    })

    return { vm, store, config }
  }

  // The panel that renders the candidates table of the page's rows, as the nodes Vue makes of it: the panels are tried in turn and the one whose table is given the page's candidates is the panel.
  const renderPanel = (vm) => {
    const problems = []

    for (const panel of panels) {
      if (panel.errors.length) {
        problems.push(...panel.errors)
        continue
      }

      vm.$options.render = panel.render
      vm.$options.staticRenderFns = panel.staticRenderFns
      vm._staticTrees = null
      warned = []
      thrown = []

      const tree = vm._render()
      const table = nodesOf(tree, (node) => node.tag === 'v-data-table').find((node) => node.data && node.data.attrs && node.data.attrs.items === vm.candidates.rows)

      if (table) {
        return { tree, table, el: panel.el, warnings: [...warned, ...thrown.map(String)] }
      }

      problems.push(...thrown.map(String))
    }

    throw new Error(`no panel renders the candidates table${problems.length ? `: ${short(problems)}` : ''}`)
  }

  add('page: the candidates are the page\'s bodies in reach, with no complex and a qualifying deposit, in the headline order by default', () => {
    const vm = mount({ race, deposits })

    return same([vm.candidates.rows.map((item) => item.name), vm.candidates.shown, vm.cmcRanking], [['Marginal', 'Deep'], 'headline', 'headline'])
  })
  add('page: the chip of the Minerals table is unchanged and the candidates are exactly the bodies it marks that have no complex', () => {
    const vm = mount({ race, deposits })
    const chips = vm.bodies.filter((item) => item.cmcCandidate && !item.complexes && !item.bare).map((item) => item.name).sort()

    return same([chips, vm.candidates.rows.map((item) => item.name).sort(), vm.bodies.find((item) => item.name === 'Deep').cmcCandidate], [['Deep', 'Marginal'], ['Deep', 'Marginal'], 'Duranium'])
  })
  add('page: the longevity preference typed on the page reorders the candidates and the settings reach the utility', () => {
    const vm = mount({ race, deposits, cmcRanking: 'longevity', cmcPreference: { ...FIXED_SETTINGS } })
    const edited = mount({ race, deposits, cmcRanking: 'longevity', cmcPreference: { ...FIXED_SETTINGS, reserveWeight: '0', lifetimeWeight: '0' } })
    const blank = mount({ race, deposits, cmcRanking: 'longevity', cmcPreference: { ...FIXED_SETTINGS, lifetimeWeight: '' } })

    return same([vm.candidates.rows.map((item) => item.name), edited.candidates.rows.map((item) => item.name), blank.candidates.fellBack, blank.candidates.rows.map((item) => item.name)], [['Deep', 'Marginal'], ['Marginal', 'Deep'], true, ['Marginal', 'Deep']])
  })
  add('page: no race read yet, or a game that founds no complexes, leaves no candidates and no figure', () => same([mount({ deposits }).candidates.rows.length, mount({ race: { ...race, AllowCMC: false }, deposits }).candidates.rows.length], [0, 0]))
  add('page: a race with no recorded mine production leaves the rate, the lifetime and the score unknown, not 0', () => {
    const vm = mount({ race: { ...race, MineProduction: null }, deposits, cmcRanking: 'longevity', cmcPreference: { ...FIXED_SETTINGS } })
    const item = vm.candidates.rows[0]

    return !provenance.isAvailable(item.lifetime) && !provenance.isAvailable(item.score) && value(item.lifetime) === null && provenance.isAvailable(item.reserve) ? true : short(item.lifetime)
  })
  add('page: the typed text of a field is judged by settingError: none for a good one, a message for a blank and for a rejected one', () => {
    const vm = mount({ race, deposits, cmcPreference: { ...candidates.DEFAULT_SETTINGS, reserveWeight: '', accessibilityWeight: '-1', complexes: '3' } })
    const field = (key) => candidates.SETTING_FIELDS.find((item) => item.key === key)

    const got = [vm.settingError(field('lifetimeWeight')), vm.settingError(field('reserveWeight')), vm.settingError(field('accessibilityWeight'))]

    return same(got.map((messages) => messages.length), [0, 1, 1]) === true && got[1][0] !== got[2][0] && got.flat().every((message) => typeof message === 'string' && message) ? true : short(got)
  })
  add('page: the typed fields are bounded by the length the settings are read with', () => same([mount().settingMaxText], [candidates.MAX_TEXT]))
  add('page: a figure that is not known shows a dash and no number', () => {
    const vm = mount({ race, deposits })
    const row = rank([rich], { ranking: 'longevity' }).rows[0]
    const entry = row.terms.find((term) => unknown(term.term))
    const texts = entry ? [vm.yearsText(row.lifetime), vm.yearsText(row.lines[0].lifetime), vm.rankText(row.rank), vm.termText(entry)] : []

    return unknown(row.lifetime) && texts.length === 4 && texts.every((text) => text.includes('—') && !/\d/.test(text)) && /\d/.test(vm.rankText(1)) && /\d/.test(vm.yearsText(rank([deep]).rows[0].lifetime)) ? true : short(texts)
  })
  add('page: the reset puts back the defaults', () => {
    const vm = mount({ race, deposits, cmcPreference: { reserveWeight: '', accessibilityWeight: 'x', lifetimeWeight: '9', complexes: '1', horizon: '1', reference: '1' } })

    vm.resetPreference()

    return same(vm.cmcPreference, candidates.DEFAULT_SETTINGS)
  })
  add('page: the defaults of the views are the headline order and the default settings', () => {
    const vm = mount()

    return same([vm.cmcRanking, vm.cmcPreference], ['headline', candidates.DEFAULT_SETTINGS])
  })

  // ----- the page's reads over a database of the tables they touch -----
  const over = async (without, rows, test) => {
    const database = await memoryDatabase(without, rows)

    try {
      return await test(instantiate(readOptions, { $store: STORE, database, GameID: 1, RaceID: 2, data: {} }))
    } finally {
      await database.close()
    }
  }
  const attempt = (vm, name) => vm.runAsync(name).then(() => null, (error) => String(error.message))
  const failed = (message) => typeof message === 'string' && message.length > 0

  add('read: the deposit read gives the deposits of the bodies the race has surveyed in the systems it knows, each with the radiation of its body, a radiation or an amount not recorded staying null', () => over([], {}, async (vm) => {
    const rows = [...(await vm.runAsync('deposits'))].sort((a, b) => a.SystemBodyID - b.SystemBodyID || a.MaterialID - b.MaterialID)

    return same([rows.map((item) => [item.SystemBodyID, item.MaterialID]), rows.map((item) => item.RadiationLevel), rows.map((item) => item.ParentOrbitalDistance), rows.map((item) => item.HalfOriginalAmount), rows.map((item) => item.SystemBodyName), rows.map((item) => item.SystemName), vm.loadErrors.deposits], [[[1, 1], [2, 1]], [12.5, null], [null, 7], [80000, null], ['Deep', null], ['Sol', 'Sol'], null])
  }))
  add('read: the race read gives the mining production, the largest orbital mining diameter, the mining value of the best civilian complex and the game switch', () => over([], {}, async (vm) => same([await vm.runAsync('race'), vm.loadErrors.race], [{ MineProduction: 10, MaximumOrbitalMiningDiameter: 200, ComplexMining: 10, AllowCMC: true }, null])))
  add('read: no civilian installation leaves the mining value of a complex unknown and not 0', () => over([], { DIM_PlanetaryInstallation: [{ PlanetaryInstallationID: 3, CivilianInstallation: 0, MiningProductionValue: 25 }] }, async (vm) => same([await vm.runAsync('race')], [{ MineProduction: 10, MaximumOrbitalMiningDiameter: 200, ComplexMining: null, AllowCMC: true }])))
  add('read: a game without the AllowCMC column fails the read naming it, so the preflight leaves the page unsupported and a missing switch is never taken as on or off', () => over(['FCT_Game.AllowCMC'], {}, async (vm) => /AllowCMC/.test(await attempt(vm, 'race')) ? true : 'no error naming the column'))
  add('read: a column or a table the save lacks fails that read with a message and leaves its figure at the default, and the other read is unaffected', async () => {
    const noRadiation = await over(['FCT_SystemBody.RadiationLevel'], {}, async (vm) => [await attempt(vm, 'deposits'), await attempt(vm, 'race'), vm.deposits, vm.loadErrors.race, vm.race.ComplexMining])
    const noSurveys = await over(['FCT_SystemBodySurveys'], {}, async (vm) => [await attempt(vm, 'deposits'), vm.deposits])
    const noMining = await over(['DIM_PlanetaryInstallation.MiningProductionValue'], {}, async (vm) => [await attempt(vm, 'race'), vm.race, (await vm.runAsync('deposits')).length])

    return failed(noRadiation[0]) && same([noRadiation[1], noRadiation[2], noRadiation[3], noRadiation[4]], [null, [], null, 10]) === true && failed(noSurveys[0]) && same(noSurveys[1], []) === true && failed(noMining[0]) && same([noMining[1], noMining[2]], [null, 2]) === true ? true : short([noRadiation, noSurveys, noMining])
  })
  add('read: every read settles under its own name as the page\'s input, and the inputs the page names are exactly its reads', async () => {
    const keys = Object.keys(readOptions.asyncComputed).sort()
    const database = { query: () => Promise.reject(new Error('read failed')) }
    const vm = instantiate(readOptions, { $store: STORE, database, GameID: 1, RaceID: 2, data: {} })

    for (const key of keys) {
      await vm.runAsync(key).catch(() => null)
    }

    const settled = Object.keys(vm.loadErrors).sort()

    vm.loadErrors = Object.fromEntries(keys.map((key) => [key, null]))

    const loaded = vm.inputsLoaded

    vm.loadErrors = Object.fromEntries(keys.map((key) => [key, 'read failed']))

    return keys.length > 0 && same([settled, loaded, [...vm.failedInputs].sort()], [keys, true, keys]) === true && failed(vm.failedInputsText) ? true : short([keys, settled, loaded, vm.failedInputs])
  })
  add('read: a civilian installation whose count or kind the save does not record leaves the complexes on its body unknown, so the body is a possible candidate with no rank, while an absent installation is no complex and an installation of another kind does not matter', async () => {
    const colony = { PopulationID: 10, GameID: 1, RaceID: 2, PopName: 'Colony', SystemID: 1, SystemBodyID: 1, Population: 1, Capital: 0, MassDriverDest: 0, PurchaseCivilianMinerals: 1 }
    const installed = (planetary, amount) => ({ PopID: 10, GameID: 1, PlanetaryInstallationID: planetary, Amount: amount })
    const definitions = [...MEMORY_ROWS.DIM_PlanetaryInstallation, { PlanetaryInstallationID: 6, CivilianInstallation: null, Workers: 0, MiningProductionValue: 10, MassDriverValue: 0 }, { PlanetaryInstallationID: 7, CivilianInstallation: 1, Workers: 0, MiningProductionValue: null, MassDriverValue: 0 }]
    const candidateOf = (installations) => over([], { FCT_Population: [colony], FCT_PopulationInstallations: installations, DIM_PlanetaryInstallation: definitions }, async (vm) => {
      for (const key of ['race', 'deposits', 'colonies']) {
        await vm.runAsync(key)
      }

      vm.cmcPreference = { ...FIXED_SETTINGS }

      const row = vm.candidates.rows.find((item) => item.name === 'Deep')

      return row ? { status: row.status, ranks: [row.headlineRank, row.longevityRank], known: [row.reserve, row.score].map((result) => !unknown(result)), named: row.reserve.inputs.missing.length > 0, complexes: vm.bodies.find((item) => item.name === 'Deep').complexes } : null
    })
    const free = { status: 'known', ranks: [1, 1], known: [true, true], named: false, complexes: 0 }
    const unsure = { status: 'possible', ranks: [null, null], known: [false, false], named: true, complexes: 0 }
    const got = [await candidateOf([]), await candidateOf([installed(2, null)]), await candidateOf([installed(2, 2)]), await candidateOf([installed(3, null)]), await candidateOf([installed(6, 1)]), await candidateOf([installed(7, 1)])]

    return same(got, [free, unsure, null, free, unsure, unsure])
  })

  // ----- the panel, as Vue renders it over the page -----
  add('panel-render: the page template compiles and every top-level panel compiles', () => { const errors = [...templateErrors(pageText), ...panels.flatMap((panel) => panel.errors)]; return errors.length ? short(errors) : true })
  add('panel-render: the panel that renders the candidates is a top-level .panel with a data-summary of no digit and no first or second person, one panel-head, and it renders without a warning or an error', () => {
    const { vm } = mountPage()
    const { el, warnings } = renderPanel(vm)
    const summary = attrOf(el, 'data-summary') || ''
    const heads = el.children.filter((child) => child.type === 1 && /\bpanel-head\b/.test(classOf(child)))

    return heads.length === 1 && summary.length > 0 && !/\d/.test(summary) && !PRONOUNS.test(summary) && !warnings.length ? true : short([heads.length, summary, warnings])
  })
  add('panel-render: every figure carries the mark of its own result: the rank of the order shown, the potential, the reserve, the accessibility, the lifetime, the score and each term, each deposit\'s output and lifetime, the assumptions, and every mark names a result or a registered rule', () => {
    const { vm } = mountPage()
    const lacking = []
    const named = (attrs) => (attrs.result ? typeof attrs.result.status === 'string' : !!provenance.getRule(attrs.rule))

    for (const ranking of ['headline', 'longevity']) {
      vm.cmcRanking = ranking

      const { tree, table } = renderPanel(vm)
      const { rows, lines } = vm.candidates
      const missing = (what) => lacking.push(`${ranking}: ${what}`)

      if (!rows.some((row) => unknown(row.rankResult))) {
        missing('no row has an unknown rank figure to tell the marks apart')
      }

      if (!rows.some((row) => unknown(row.potentialResult) && !unknown(row.score))) {
        missing('no row has an unavailable headline beside an available longevity rank')
      }

      const entries = rows.flatMap((row) => row.lines)

      if (!entries.some((line) => line.Amount === null) || !entries.some((line) => line.Amount !== null) || !entries.some((line) => line.Accessibility === null)) {
        missing('no deposit line has a recorded amount, an unrecorded amount and an unrecorded accessibility to tell the cells apart')
      }

      entries.forEach((line) => [['Amount', line.amountResult], ['Accessibility', line.accessibilityResult]].forEach(([figure, result]) => {
        if (line[figure] === null ? !unknown(result) : value(result) !== line[figure]) {
          missing(`the ${line.mineral} ${figure} figure and its result disagree`)
        }
      }))

      rows.forEach((row) => {
        const results = (name, args = { item: row }) => marksOf(cellOf(table, name, args)).filter((attrs) => attrs.result).map((attrs) => attrs.result)
        const own = [['item.potential', [row.potentialResult]], ['item.reserve', [row.reserve]], ['item.accessibility', [row.accessibility]], ['item.lifetime', [row.lifetime]], ['item.score', [row.score, ...row.terms.map((entry) => entry.term)]], ['expanded-item', row.lines.flatMap((line) => [line.amountResult, line.accessibilityResult, line.rate, line.lifetime]), { headers: vm.candidateHeaders, item: row }]]

        own.forEach(([name, expected, args]) => {
          const found = results(name, args)

          if (!expected.every((result) => found.includes(result))) {
            missing(`${row.name}: the ${name} cell lacks a mark of its result`)
          }
        })

        const ranks = marksOf(cellOf(table, 'item.rank', { item: row })).map((attrs) => attrs.result)

        if (!ranks[0] || standsFor(ranks[0]) !== standsFor(row.rankResult)) {
          missing(`${row.name}: the rank cell does not mark the figure the order is built on`)
        }

        if (ranks.length !== 3 || ranks[1] !== row.potentialResult || ranks[2] !== row.score) {
          missing(`${row.name}: the rank cell does not mark the headline rank by the potential and the longevity rank by the score`)
        }

        ;['item.rank', 'item.potential', 'item.reserve', 'item.accessibility', 'item.lifetime', 'item.score', 'expanded-item'].forEach((name) => {
          if (!marksOf(cellOf(table, name, { headers: vm.candidateHeaders, item: row })).every(named)) {
            missing(`${row.name}: a mark in the ${name} cell names no result or rule`)
          }
        })
      })

      const marked = marksOf(tree.children || []).filter((attrs) => attrs.result).map((attrs) => attrs.result)

      if (!lines.every((line) => marked.includes(line.result))) {
        missing('an assumption has no mark of its result')
      }

      if (!vm.candidateHeaders.every((header) => header.value === 'data-table-expand' || marksOf(cellOf(table, `header.${header.value}`, { header })).some(named) || !(`header.${header.value}` in table.data.scopedSlots))) {
        missing('a header mark names no rule')
      }
    }

    return lacking.length ? short(lacking.slice(0, 4)) : true
  })
  add('panel-render: every setting is a field showing its typed text, label, hint and error and bounded in length, typing reaches the page, the ranking toggle offers both orders and sets the page, and the reset puts the defaults back', () => {
    const { vm } = mountPage()
    const typed = { ...candidates.DEFAULT_SETTINGS, reserveWeight: '', accessibilityWeight: '-1' }

    vm.cmcPreference = typed

    const { tree } = renderPanel(vm)
    const fields = nodesOf(tree, (node) => node.tag === 'v-text-field')
    const toggle = nodesOf(tree, (node) => node.tag === 'v-btn-toggle')[0]
    const lacking = []

    if (fields.length !== candidates.SETTING_FIELDS.length) {
      return `${fields.length} fields`
    }

    fields.forEach((node, index) => {
      const field = candidates.SETTING_FIELDS[index]
      const attrs = node.data.attrs

      if (attrs.label !== field.label || attrs.hint !== field.hint || attrs.maxlength !== candidates.MAX_TEXT || same(attrs['error-messages'], vm.settingError(field)) !== true || node.data.model.value !== typed[field.key]) {
        lacking.push(`${field.key}: ${short([attrs.label, attrs.hint, attrs.maxlength, attrs['error-messages'], node.data.model.value])}`)
      }
    })

    fields[3].data.model.callback('5')

    if (vm.cmcPreference.complexes !== '5' || renderPanel(vm).tree === undefined || nodesOf(renderPanel(vm).tree, (node) => node.tag === 'v-text-field')[3].data.model.value !== '5') {
      lacking.push('typing does not reach the page')
    }

    if (!toggle || toggle.data.model.value !== vm.cmcRanking || same(nodesOf(toggle, (node) => node.tag === 'v-btn').map((node) => node.data.attrs.value), candidates.RANKINGS.map((ranking) => ranking.id)) !== true) {
      lacking.push('the toggle does not offer the orders')
    } else {
      toggle.data.model.callback('longevity')

      if (vm.cmcRanking !== 'longevity' || vm.candidates.requested !== 'longevity') {
        lacking.push('the toggle does not set the order')
      }
    }

    const resets = nodesOf(renderPanel(vm).tree, (node) => node.tag === 'v-btn' && node.data && node.data.on && node.data.on.click)

    resets.forEach((node) => [].concat(node.data.on.click).forEach((handler) => handler()))

    if (!resets.length || same(vm.cmcPreference, candidates.DEFAULT_SETTINGS) !== true) {
      lacking.push('no control puts the defaults back')
    }

    return lacking.length ? short(lacking) : true
  })
  add('panel-render: the table is given the candidates in the order of the ranking, with the headers of the page and a column of each', () => {
    const { vm } = mountPage()
    const { table } = renderPanel(vm)
    const attrs = table.data.attrs
    const first = vm.candidates.rows[0]
    const missing = vm.candidateHeaders.filter((header) => header.value !== 'data-table-expand' && !(header.value in first)).map((header) => header.value)

    return attrs.headers === vm.candidateHeaders && 'disable-sort' in attrs && attrs['item-key'] in first && !missing.length && vm.candidates.rows.length > 1 && same(vm.candidates.rows.map((row) => row.key), [...new Set(vm.candidates.rows.map((row) => row.key))]) === true ? true : short([missing, attrs['item-key']])
  })
  add('panel-render: both ranks and the terms are in the cells, the assumptions and the notes and the reason of a fallback are in the panel', () => {
    const { vm } = mountPage()
    const lacking = []

    vm.cmcRanking = 'longevity'

    const { tree, table } = renderPanel(vm)

    vm.candidates.rows.forEach((row) => {
      const text = cellText(cellOf(table, 'item.rank', { item: row }))
      const score = cellText(cellOf(table, 'item.score', { item: row }))

      if (same(text.match(/#\d+|—/g), [row.rank, row.headlineRank, row.longevityRank].map((rank) => vm.rankText(rank))) !== true) {
        lacking.push(`${row.name}: ${text}`)
      }

      if (!row.terms.every((entry) => score.includes(vm.termText(entry)))) {
        lacking.push(`${row.name}: the terms are not in ${score}`)
      }
    })

    const text = textOf(tree)

    if (!vm.candidates.lines.every((line) => text.includes(line.label))) {
      lacking.push('an assumption is not named')
    }

    vm.cmcPreference = { ...candidates.DEFAULT_SETTINGS, reserveWeight: '', complexes: '' }

    const fallback = textOf(renderPanel(vm).tree)
    const { blocking, notes, fellBack } = vm.candidates

    if (!fellBack || !blocking.length || !notes.length || !blocking.every((reason) => fallback.includes(reason)) || !notes.every((note) => fallback.includes(note))) {
      lacking.push(`the fallback and the notes are not shown: ${short([blocking, notes])}`)
    }

    return lacking.length ? short(lacking) : true
  })
  add('panel-render: a figure that is not known shows a dash in its cell, never a number', () => {
    const { vm } = mountPage()

    vm.cmcPreference = { ...FIXED_SETTINGS }
    const lacking = []

    for (const ranking of ['headline', 'longevity']) {
      vm.cmcRanking = ranking

      const { table } = renderPanel(vm)
      const row = (name) => vm.candidates.rows.find((item) => item.name === name)
      const text = (slot, name) => cellText(cellOf(table, slot, { item: row(name) }))

      if (!/—/.test(text('item.reserve', 'Partial')) || !/—/.test(text('item.lifetime', 'Rich')) || /yr/.test(text('item.lifetime', 'Rich')) || !/—/.test(text('item.score', 'Rich')) || !text('item.rank', ranking === 'headline' ? 'Shaky' : 'Rich').startsWith('—')) {
        lacking.push(`${ranking}: ${short([text('item.reserve', 'Partial'), text('item.lifetime', 'Rich'), text('item.score', 'Rich'), text('item.rank', 'Rich')])}`)
      }
    }

    return lacking.length ? short(lacking) : true
  })
  add('panel-render: everything the panel shows is in the UI voice: no first or second person, in a settled and an unsettled state', () => {
    const { vm } = mountPage()
    const texts = []

    for (const [ranking, preference] of [['headline', candidates.DEFAULT_SETTINGS], ['longevity', candidates.DEFAULT_SETTINGS], ['longevity', { ...candidates.DEFAULT_SETTINGS, reserveWeight: '', accessibilityWeight: '-1', complexes: '' }]]) {
      vm.cmcRanking = ranking
      vm.cmcPreference = preference

      const { tree, table } = renderPanel(vm)

      texts.push(textOf(tree), ...vm.candidates.rows.flatMap((row) => ['item.rank', 'item.name', 'item.potential', 'item.reserve', 'item.accessibility', 'item.lifetime', 'item.score', 'expanded-item'].map((name) => cellText(cellOf(table, name, { headers: vm.candidateHeaders, item: row })))))
    }

    const bad = texts.filter((text) => TEXT_PRONOUNS.test(text))

    return texts.some((text) => text.length > 0) && !bad.length ? true : short(bad.map((text) => text.slice(0, 80)))
  })

  // ----- the preferences, kept by the real persisted view -----
  add('persist: the ranking and the settings are kept for each race: another race starts from the defaults, the first comes back as left (an over-long text still rejected), and a restart brings them back', async () => {
    const config = new MemoryConfig()
    const { vm, store } = mountPage({ config })
    const typed = { ...candidates.DEFAULT_SETTINGS, reserveWeight: '5', accessibilityWeight: '-1', lifetimeWeight: '', complexes: 'x'.repeat(30) }
    const clone = (value) => JSON.parse(JSON.stringify(value))
    const left = clone(candidates.normaliseSettings(clone(typed)))

    vm.cmcRanking = 'longevity'
    vm.cmcPreference = typed
    await flush()
    store.getters.racePrefix = OTHER
    await flush()

    const other = [vm.cmcRanking, clone(vm.cmcPreference)]

    vm.cmcPreference = { ...candidates.DEFAULT_SETTINGS, horizon: '7' }
    await flush()
    store.getters.racePrefix = KEY
    await flush()

    const back = [vm.cmcRanking, clone(vm.cmcPreference)]
    const restarted = mountPage({ config: config.reopened() }).vm
    const otherRestarted = mountPage({ config: config.reopened(), prefix: OTHER }).vm
    const parsed = candidates.parseSettings(restarted.cmcPreference)

    return same([other, back, [restarted.cmcRanking, clone(restarted.cmcPreference)], [otherRestarted.cmcRanking, clone(otherRestarted.cmcPreference)], [parsed.complexes.state, parsed.reserveWeight.state, parsed.accessibilityWeight.state, parsed.lifetimeWeight.state]], [['headline', candidates.DEFAULT_SETTINGS], ['longevity', left], ['longevity', left], ['headline', { ...candidates.DEFAULT_SETTINGS, horizon: '7' }], ['rejected', 'ok', 'rejected', 'blank']])
  })

  return statements
}

// ---------- the saves ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({ query: (sql) => allRows(raw, sql), close: () => closeRaw(raw) })
  })
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

const permutation = (ranks, count) => same([...ranks].sort((a, b) => a - b), Array.from({ length: count }, (_value, index) => index + 1))

const saveStatements = async (ctx, save) => {
  const { m, pageOptions } = ctx
  const { candidates, minerals, provenance } = m
  const value = provenance.valueOrNull
  const database = await openSave(save.file)
  const label = save.file

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const present = (await rowsOf(database, `select RaceID from FCT_Race where GameID = ${save.game} and RaceID = ${save.race}`)).length > 0

  if (!present) {
    console.log(`SKIP  ${label}: game ${save.game} race ${save.race} is not in the file`)
    await database.close()

    return { skipped: true, statements: [] }
  }

  const g = save.game
  const r = save.race
  const vm = instantiate(pageOptions, { $store: STORE, database, GameID: g, RaceID: r, data: {} })

  for (const name of Object.keys(pageOptions.asyncComputed)) {
    await vm.runAsync(name)
  }

  const surveyed = `(select FCT_SystemBodySurveys.SystemBodyID from FCT_SystemBodySurveys where FCT_SystemBodySurveys.GameID = ${g} and FCT_SystemBodySurveys.RaceID = ${r})`
  const qualifiers = new Set((await rowsOf(database, `select distinct SystemBodyID from FCT_MineralDeposit where GameID = ${g} and MaterialID in (1, 11) and Amount > 10000 and Accessibility >= 0.7 and SystemBodyID in ${surveyed}`)).map((row) => row.SystemBodyID))
  const gapBodies = new Set((await rowsOf(database, `select distinct FCT_Population.SystemBodyID from FCT_Population inner join FCT_PopulationInstallations on FCT_PopulationInstallations.PopID = FCT_Population.PopulationID inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_Population.GameID = ${g} and FCT_Population.RaceID = ${r} and FCT_PopulationInstallations.GameID = ${g} and (DIM_PlanetaryInstallation.CivilianInstallation is null or (DIM_PlanetaryInstallation.CivilianInstallation = 1 and (FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.MiningProductionValue is null)))`)).map((row) => row.SystemBodyID))
  const complexBodies = new Set((await rowsOf(database, `select distinct FCT_Population.SystemBodyID from FCT_Population inner join FCT_PopulationInstallations on FCT_PopulationInstallations.PopID = FCT_Population.PopulationID inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_Population.GameID = ${g} and FCT_Population.RaceID = ${r} and FCT_PopulationInstallations.GameID = ${g} and DIM_PlanetaryInstallation.CivilianInstallation = 1 and DIM_PlanetaryInstallation.MiningProductionValue > 0 and FCT_PopulationInstallations.Amount > 0`)).map((row) => row.SystemBodyID))
  const [raw] = await rowsOf(database, `select FCT_Race.MineProduction, (select max(MiningProductionValue) from DIM_PlanetaryInstallation where CivilianInstallation = 1) as ComplexMining, FCT_Game.AllowCMC from FCT_Race inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID where FCT_Race.GameID = ${g} and FCT_Race.RaceID = ${r}`)
  const rawDeposits = await rowsOf(database, `select FCT_MineralDeposit.SystemBodyID, FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc, FCT_SystemBody.RadiationLevel from FCT_MineralDeposit inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_MineralDeposit.SystemBodyID where FCT_MineralDeposit.GameID = ${g} and FCT_MineralDeposit.MaterialID in (1, 11) and FCT_MineralDeposit.SystemBodyID in ${surveyed}`)
  const depositOf = (bodyId, materialId) => rawDeposits.find((deposit) => deposit.SystemBodyID === bodyId && deposit.MaterialID === materialId)
  const allowed = raw.AllowCMC === 1
  const settings = FIXED_SETTINGS
  const run = (ranking, over = {}) => candidates.candidateRanking({ bodies: vm.bodies, race: vm.race, allowed: vm.raceRules.AllowCMC, settings: { ...settings, ...over }, ranking })
  const headline = run('headline')
  const longevity = run('longevity')
  const known = headline.rows.filter((row) => row.status === 'known')
  const statements = []
  const addSave = (name, test) => statements.push([`${name.slice(0, name.indexOf(':'))}: ${label}:${name.slice(name.indexOf(':') + 1)}`, test])

  addSave('save-candidates: the race and the game switch are the raw ones, and a game that founds no complexes has no candidates', () => (vm.race.MineProduction === raw.MineProduction && vm.race.ComplexMining === raw.ComplexMining && vm.raceRules.AllowCMC === allowed && (allowed || headline.rows.length === 0) ? true : short([vm.race, raw])), `${headline.rows.length} candidates`)
  addSave('save-candidates: every candidate holds a raw Duranium or Gallicite deposit that qualifies, and has no complex of the race on it', () => {
    const bad = headline.rows.filter((row) => row.status === 'known' && (!qualifiers.has(row.SystemBodyID) || complexBodies.has(row.SystemBodyID))).map((row) => row.name)

    return bad.length ? short(bad) : true
  })
  addSave('save-candidates: every raw qualifying body with no complex of the race and in reach is a candidate, and the candidates are the bodies the Minerals chip marks', () => {
    const inReach = new Set(vm.bodies.filter((body) => body.cmcInReach).map((body) => body.SystemBodyID))
    const free = allowed ? [...qualifiers].filter((id) => !complexBodies.has(id) && inReach.has(id)) : []
    const byId = (a, b) => a - b
    const expected = free.filter((id) => !gapBodies.has(id)).sort(byId)
    const unsure = free.filter((id) => gapBodies.has(id)).sort(byId)
    const chips = allowed ? vm.bodies.filter((body) => body.cmcCandidate && !body.complexes && !body.bare).map((body) => body.SystemBodyID).sort(byId) : []
    const possible = headline.rows.filter((row) => row.status === 'possible' && qualifiers.has(row.SystemBodyID)).map((row) => row.SystemBodyID).sort(byId)
    const unranked = headline.rows.filter((row) => unsure.includes(row.SystemBodyID)).every((row) => row.rank === null && row.longevityRank === null)

    return same(known.map((row) => row.SystemBodyID).sort(byId), expected) === true && same(possible, unsure) === true && unranked && same(chips, [...expected, ...unsure].sort(byId)) === true ? true : short([known.length, expected.length, unsure.length, possible.length, chips.length])
  })
  addSave('save-rate: each deposit\'s assumed output is the complexes times the raw mining value of a complex, the raw mine production, the raw accessibility and the radiation modifier', () => {
    const bad = []

    for (const row of known) {
      for (const line of row.lines.filter((item) => item.qualifies)) {
        const deposit = depositOf(row.SystemBodyID, line.MaterialID)
        const expected = Math.floor(Number(FIXED_SETTINGS.complexes) * raw.ComplexMining + 1e-9) * raw.MineProduction * deposit.Accessibility * Math.max(0, 1 - deposit.RadiationLevel / 10000)

        if (!near(value(line.rate), expected)) {
          bad.push([row.name, value(line.rate), expected])
        }
      }
    }

    return bad.length ? short(bad.slice(0, 3)) : true
  })
  addSave('save-lifetime: each lifetime is the decline model at that output from the raw deposit, and a body\'s is the longest of its deposits', () => {
    const bad = []

    for (const row of known) {
      const years = row.lines.filter((line) => line.qualifies).map((line) => {
        const deposit = depositOf(row.SystemBodyID, line.MaterialID)
        const rate = value(line.rate)

        return rate > 0 ? minerals.depositForecast({ Amount: deposit.Amount, Accessibility: deposit.Accessibility, HalfOriginalAmount: deposit.HalfOriginalAmount, OriginalAcc: deposit.OriginalAcc }, rate).yearsToDepletion : 0
      })

      if (years.some((year) => !Number.isFinite(year) && year !== Infinity) || (row.lifetime.status !== 'unavailable' && !near(value(row.lifetime), Math.max(...years)))) {
        bad.push([row.name, value(row.lifetime), years])
      }
    }

    return bad.length ? short(bad.slice(0, 3)) : true
  })
  addSave('save-reserve: each reserve is the raw sum of the qualifying deposits and each accessibility their amount-weighted mean', () => {
    const bad = []

    for (const row of known.filter((item) => provenance.isAvailable(item.reserve))) {
      const own = row.lines.filter((line) => line.qualifies).map((line) => depositOf(row.SystemBodyID, line.MaterialID))
      const total = own.reduce((sum, deposit) => sum + deposit.Amount, 0)
      const mean = own.reduce((sum, deposit) => sum + deposit.Amount * deposit.Accessibility, 0) / total

      if (!near(value(row.reserve), total) || !near(value(row.accessibility), mean)) {
        bad.push([row.name, value(row.reserve), total])
      }
    }

    return bad.length ? short(bad.slice(0, 3)) : true
  })
  addSave('save-unknown: a figure that is unknown has no value, and is unknown only where the save lacks what it rests on', () => {
    const bad = []

    for (const row of headline.rows) {
      const raws = row.lines.map((line) => depositOf(row.SystemBodyID, line.MaterialID))
      const gaps = raws.some((deposit) => deposit.HalfOriginalAmount === null || deposit.OriginalAcc === null || deposit.Amount === null || deposit.Accessibility === null) || raw.MineProduction === null || raw.ComplexMining === null || raws.some((deposit) => deposit.RadiationLevel === null) || gapBodies.has(row.SystemBodyID)

      for (const result of [row.reserve, row.accessibility, row.lifetime, row.score]) {
        if (!provenance.isAvailable(result) && (value(result) !== null || !gaps)) {
          bad.push([row.name, result.rule.id])
        }
      }

      if (!gaps && !provenance.isAvailable(row.score)) {
        bad.push([row.name, 'score'])
      }
    }

    return bad.length ? short(bad.slice(0, 3)) : true
  })
  addSave('save-order: the headline ranks are 1 to the number of known potentials and follow the existing site order', () => {
    const ranked = headline.rows.filter((row) => row.potential !== null)
    const order = ranked.every((row, index) => index === 0 || minerals.betterSite({ potential: ranked[index - 1].potential, accessibility: ranked[index - 1].best, amount: ranked[index - 1].amount }, { potential: row.potential, accessibility: row.best, amount: row.amount }) >= 0)

    return permutation(ranked.map((row) => row.headlineRank), ranked.length) === true && ranked.every((row, index) => row.rank === index + 1) && headline.rows.slice(ranked.length).every((row) => row.potential === null && row.rank === null) && order ? true : short(ranked.slice(0, 3).map((row) => [row.name, row.rank, row.potential]))
  })
  addSave('save-order: the longevity ranks are 1 to the number of known scores and follow the scores, an unknown score last', () => {
    const scored = longevity.rows.filter((row) => provenance.isAvailable(row.score))
    const descending = scored.every((row, index) => index === 0 || value(scored[index - 1].score) >= value(row.score) - 1e-9)

    return permutation(scored.map((row) => row.longevityRank), scored.length) === true && scored.every((row, index) => row.rank === index + 1) && longevity.rows.slice(scored.length).every((row) => !provenance.isAvailable(row.score) && row.rank === null) && descending && longevity.shown === 'longevity' ? true : short(scored.slice(0, 3).map((row) => [row.name, row.rank, value(row.score)]))
  })
  addSave('save-page: the page\'s candidates are the utility\'s over its own bodies, in either mode, with the headline order the default', () => {
    const asked = instantiate(pageOptions, { $store: STORE, database, GameID: g, RaceID: r, data: { race: vm.race, deposits: vm.deposits, colonies: vm.colonies, aliens: vm.aliens, miners: vm.miners, routes: vm.routes, systems: vm.systems, cmcRanking: 'longevity', cmcPreference: { ...FIXED_SETTINGS } } })

    return same(vm.candidates.rows.map((row) => row.SystemBodyID), headline.rows.map((row) => row.SystemBodyID)) === true && same(asked.candidates.rows.map((row) => row.SystemBodyID), longevity.rows.map((row) => row.SystemBodyID)) === true && vm.candidates.shown === 'headline' ? true : 'the page does not rank as the utility does'
  })
  addSave('save-off: with the preference off no setting changes the order, and with a blank weight the longevity request falls back to it', () => {
    const blank = run('longevity', { reserveWeight: '' })
    const rejected = run('headline', { reserveWeight: '-1', complexes: '' })

    return same(rejected.rows.map((row) => row.SystemBodyID), headline.rows.map((row) => row.SystemBodyID)) === true && same(blank.rows.map((row) => row.SystemBodyID), headline.rows.map((row) => row.SystemBodyID)) === true && (headline.rows.length === 0 || blank.fellBack) ? true : 'the headline order moved'
  })

  return { skipped: false, statements, close: () => database.close() }
}

// ---------- the planted faults ----------

/* eslint-disable no-template-curly-in-string */
const MUTATIONS = [
  { name: 'an unreadable deposit left out of the reserve, so the reserve is the smaller sum', file: U, find: '...openParts, ...countParts(\'cmcCandidate.reserve\') }', replace: '...countParts(\'cmcCandidate.reserve\') }', fails: ['unknown'] },
  { name: 'a blank field read as 0', file: U, find: 'return read(\'blank\', null, null)', replace: 'return read(\'ok\', 0, null)', fails: ['settings'] },
  { name: 'a negative weight accepted', file: U, find: 'const NUMBER = /^(\\d+(\\.\\d*)?|\\.\\d+)$/\n\nconst KINDS = {\n  weight: { test: (value) => value >= 0,', replace: 'const NUMBER = /^-?(\\d+(\\.\\d*)?|\\.\\d+)$/\n\nconst KINDS = {\n  weight: { test: () => true,', fails: ['settings'] },
  { name: 'a blank weight not blocking the score', file: U, find: 'const unusable = weights.filter((field) => field.state !== \'ok\').map(settingProblem)', replace: 'const unusable = weights.filter((field) => field.state === \'rejected\').map(settingProblem)', fails: ['settings'] },
  { name: 'every weight 0 accepted', file: U, find: 'return weights.some((field) => field.value > 0) ? [] : [\'Every weight is 0, so no term counts\']', replace: 'return []', fails: ['settings'] },
  { name: 'a term of weight 0 still asked for', file: U, find: 'const used = TERMS.filter((term) => ctx.weights[term.key] > 0)', replace: 'const used = TERMS.filter((term) => ctx.weights[term.key] >= 0)', fails: ['settings'] },
  { name: 'a score that ignores the lifetime term', file: U, find: 'const used = TERMS.filter((term) => ctx.weights[term.key] > 0)', replace: 'const used = TERMS.filter((term) => term.key !== \'lifetime\' && ctx.weights[term.key] > 0)', fails: ['terms', 'swap'] },
  { name: 'a contribution that is not weighted', file: U, find: 'entry.weight * entry.term.value / weightTotal', replace: 'entry.term.value / weightTotal', fails: ['terms'] },
  { name: 'a lifetime that is the amount over the rate', file: U, find: 'compute: (values) => (values.rate > 0 ? depositForecast(deposit, values.rate).yearsToDepletion : 0)', replace: 'compute: (values) => (values.rate > 0 ? deposit.Amount / values.rate : 0)', fails: ['lifetime', 'swap'] },
  { name: 'the radiation of the body ignored', file: U, find: 'RadiationModifier: 1 - values.radiation / 10000', replace: 'RadiationModifier: 1', fails: ['lifetime'] },
  { name: 'the complexes left out of the rate', file: U, find: 'CivilianMineCount: values.complexes * values.complexMining', replace: 'CivilianMineCount: values.complexMining', fails: ['terms', 'lifetime', 'save-rate'] },
  { name: 'the capacity of the complexes not cut to whole mine equivalents', file: U, find: 'surfaceRate({ ManualMineCount: 0, AutomatedMineCount: 0, CivilianMineCount: values.complexes * values.complexMining, PurchaseCivilianMinerals: 1, Efficiency: 1, StabilityModifier: 1, MineProduction: values.mineProduction, Accessibility: values.accessibility, GovernorBonus: 1, SectorBonus: 1, RadiationModifier: 1 - values.radiation / 10000 }, false)', replace: 'values.complexes * values.complexMining * values.mineProduction * values.accessibility * Math.max(0, 1 - values.radiation / 10000)', fails: ['rate'] },
  { name: 'the rank mark always the score', file: U, find: 'row.rankResult = shown === \'longevity\' ? row.score : row.potentialResult', replace: 'row.rankResult = row.score', fails: ['rank'] },
  { name: 'a stored over-long text replaced by the default', file: U, find: 'textOf(stored[key]).slice(0, MAX_TEXT + 1)', replace: '(textOf(stored[key]).length <= MAX_TEXT ? textOf(stored[key]) : DEFAULT_SETTINGS[key])', fails: ['domain'] },
  { name: 'an over-long typed text read as a number', file: U, find: 'if (raw.length > MAX_TEXT) {', replace: 'if (false) {', fails: ['domain'] },
  { name: 'a value above the limit of its kind accepted', file: U, find: 'if (value > LIMITS[field.kind]) {', replace: 'if (false) {', fails: ['domain'] },
  { name: 'an unknown score ranked first', file: U, find: 'return (x === null ? (y === null ? 0 : 1) : -1) || headlineCompare(a, b)', replace: 'return (x === null ? (y === null ? 0 : -1) : 1) || headlineCompare(a, b)', fails: ['unknown'] },
  { name: 'a possible candidate taken as a known one', file: U, find: 'status: certain ? \'known\' : \'possible\'', replace: 'status: \'known\'', fails: ['unknown'] },
  { name: 'the reserve term not capped at the reference', file: U, find: 'Math.min(values.reserve, values.reference) / values.reference', replace: 'values.reserve / values.reference', fails: ['cap'] },
  { name: 'the lifetime term not capped at the horizon', file: U, find: 'Math.min(values.lifetime, values.horizon) / values.horizon', replace: 'values.lifetime / values.horizon', fails: ['cap', 'swap'] },
  { name: 'the longevity order shown whatever is asked', file: U, find: 'const shown = fellBack ? \'headline\' : requested', replace: 'const shown = fellBack ? \'headline\' : \'longevity\'', fails: ['headline', 'swap'] },
  { name: 'a blank weight that does not fall back to the headline order', file: U, find: 'const fellBack = requested === \'longevity\' && blocking.length > 0', replace: 'const fellBack = false', fails: ['settings'] },
  { name: 'an unknown potential ranked first in the headline order', file: U, find: 'a.potential === null ? (b.potential === null ? 0 : 1) : -1', replace: 'a.potential === null ? (b.potential === null ? 0 : -1) : 1', fails: ['headline'] },
  { name: 'candidates listed in a game that founds no complexes', file: U, find: 'const base = allowed ? bodies.filter(', replace: 'const base = true ? bodies.filter(', fails: ['unknown'] },
  { name: 'the panel without its summary', file: P, find: 'data-summary="Compare surveyed bodies that could host civilian mining complexes', replace: 'data-text="Compare surveyed bodies that could host civilian mining complexes', fails: ['panel-render'] },
  { name: 'a lifetime without its mark', file: P, find: '<div class="text-no-wrap">{{ yearsText(item.lifetime) }}<provenance-mark :result="item.lifetime" /></div>', replace: '<div class="text-no-wrap">{{ yearsText(item.lifetime) }}</div>', fails: ['panel-render'] },
  { name: 'the page ranking by the headline whatever the toggle', file: P, find: 'settings: this.cmcPreference, ranking: this.cmcRanking })', replace: 'settings: this.cmcPreference, ranking: \'headline\' })', fails: ['page'] },
  { name: 'the typed settings not reaching the ranking', file: P, find: 'settings: this.cmcPreference, ranking: this.cmcRanking })', replace: 'settings: {}, ranking: this.cmcRanking })', fails: ['page'] },
  { name: 'the radiation of the body not read', file: P, find: 'FCT_SystemBody.Eccentricity, FCT_SystemBody.RadiationLevel, VIR_Parent.OrbitalDistance', replace: 'FCT_SystemBody.Eccentricity, VIR_Parent.OrbitalDistance', fails: ['read'] },
  { name: 'the mining value of a complex not returned by the race read', file: P, find: 'ComplexMining: race.ComplexMining, ', replace: '', fails: ['read'] },
  { name: 'the mining value of a complex taken over every installation, not the civilian ones', file: P, find: ' where DIM_PlanetaryInstallation.CivilianInstallation = 1) as ComplexMining', replace: ') as ComplexMining', fails: ['read'] },
  { name: 'the deposit read tracked under another name', file: P, find: 'get: tracked(\'deposits\'', replace: 'get: tracked(\'deposit\'', fails: ['read'] },
  { name: 'an unknown complex count named by its saved columns in the missing inputs', file: U, find: "const COMPLEX_COLUMNS = 'the number and type of the installations on the body'", replace: "const COMPLEX_COLUMNS = 'FCT_PopulationInstallations.Amount, DIM_PlanetaryInstallation.CivilianInstallation'", fails: ['unknown'] },
  { name: 'the complex count gaps ignored', file: U, find: 'const countOpen = (body) => body.complexGaps > 0', replace: 'const countOpen = () => false', fails: ['unknown'] },
  { name: 'a body with an unknown complex count keeping its headline rank', file: U, find: 'const potentialResult = unsure ? combine(', replace: 'const potentialResult = false ? combine(', fails: ['unknown'] },
  { name: 'the complex count gaps not carried to the body', file: P, find: 'complexGaps: sum(own, \'ComplexGaps\'),', replace: 'complexGaps: 0,', fails: ['read'] },
  { name: 'a civilian installation without a recorded amount not a gap', file: P, find: '(DIM_PlanetaryInstallation.CivilianInstallation = 1 and (FCT_PopulationInstallations.Amount is null or ', replace: '(DIM_PlanetaryInstallation.CivilianInstallation = 1 and (0 or ', fails: ['read'] },
  { name: 'an installation of another kind without a recorded amount counted as a gap', file: P, find: 'sum(case when DIM_PlanetaryInstallation.CivilianInstallation is null or (DIM_PlanetaryInstallation.CivilianInstallation = 1 and', replace: 'sum(case when FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.CivilianInstallation is null or (DIM_PlanetaryInstallation.CivilianInstallation = 1 and', fails: ['read'] },
  { name: 'the headline rank marked by a rule alone', file: P, find: 'Headline {{ rankText(item.headlineRank) }}<provenance-mark :result="item.potentialResult" />', replace: 'Headline {{ rankText(item.headlineRank) }}<provenance-mark rule="minerals.siteOrder" />', fails: ['panel-render'] },
  { name: 'the amount of a deposit without a mark', file: P, find: '{{ tons(line.Amount) }}<provenance-mark :result="line.amountResult" />', replace: '{{ tons(line.Amount) }}', fails: ['panel-render'] },
  { name: 'the accessibility of a deposit without a mark', file: P, find: '{{ plain(line.Accessibility) }}<provenance-mark :result="line.accessibilityResult" />', replace: '{{ plain(line.Accessibility) }}', fails: ['panel-render'] },
  { name: 'an unrecorded amount marked as a known figure', file: U, find: 'amountResult: fromSave(\'cmcCandidate.deposit\', deposit.Amount, DEPOSIT_COLUMNS[0])', replace: 'amountResult: ofRule({ rule: \'cmcCandidate.deposit\', value: 0, inputs: { present: [] } })', fails: ['panel-render'] },
  { name: 'the settings persisted for every race', file: P, find: 'cmcPreference: { key: \'mineralsCmcPreference\', default: { ...DEFAULT_SETTINGS }, scope: \'race\'', replace: 'cmcPreference: { key: \'mineralsCmcPreference\', default: { ...DEFAULT_SETTINGS }, scope: \'game\'', fails: ['persist'] },
  { name: 'the settings restored without normalisation', file: P, find: ', normalise: normaliseSettings }', replace: ' }', fails: ['persist'] },
  { name: 'the typed fields not bounded in length', file: P, find: ':maxlength="settingMaxText" ', replace: '', fails: ['panel-render'] },
  { name: 'the rank cell marking the score whatever the order', file: P, find: '<provenance-mark :result="item.rankResult" />', replace: '<provenance-mark :result="item.score" />', fails: ['panel-render'] },
  { name: 'the table not bound to the candidates', file: P, find: ':items="candidates.rows"', replace: ':items="deposits"', fails: ['panel-render'] },
  { name: 'the reset not wired', file: P, find: ' @click="resetPreference"', replace: '', fails: ['panel-render'] },
  { name: 'an unknown lifetime shown as a number', file: P, find: '? `${compactYears(result.value, this.separator)} yr` : \'—\'', replace: '? `${compactYears(result.value, this.separator)} yr` : \'0 yr\'', fails: ['page'] },
]
/* eslint-enable no-template-curly-in-string */

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, () => fs.readFileSync(file, 'utf8')]))

// The sources one run reads: the real ones, or the real ones with one planted fault.
const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((name) => [name, TEXTS[name]()]))

  if (mutant) {
    sources[mutant.file] = patched(path.basename(FILES[mutant.file]), sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

const contextOf = async (sources) => {
  const changed = (name) => sources[name] !== TEXTS[name]()
  const sourcesFor = { ...(changed(U) ? { 'cmc-candidates': sources[U] } : {}), ...(changed(M) ? { minerals: sources[M] } : {}) }
  const utilitySources = { ...(changed(U) ? { 'utilities/cmc-candidates': sources[U] } : {}), ...(changed(M) ? { 'utilities/minerals': sources[M] } : {}) }
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: sourcesFor })
  const pageOptions = await loadPage('pages/minerals', { stubs: STUBS, sources: { 'pages/minerals': sources[P], ...utilitySources } })
  const persistedOptions = await loadPage('pages/minerals', { stubs: STUBS, sources: { 'pages/minerals': sources[P], ...utilitySources }, modules: { 'mixins/persisted-view': PERSISTED_VIEW } })
  const readOptions = await loadPage('pages/minerals', { stubs: STUBS, sources: { 'pages/minerals': sources[P], ...utilitySources }, modules: { 'mixins/load-state': null } })

  return { m: { candidates: loaded['cmc-candidates'], minerals: loaded.minerals, policy: loaded['cmc-policy'], provenance: loaded.provenance }, pageOptions, persistedOptions, readOptions, pageText: sources[P] }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

// The statements run, as [name, result]; `keys` limits them to the checks of those keys.
const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

let useSaves = true

const statementsOf = async (ctx, withSaves) => {
  const statements = [...pure(ctx), ...page(ctx)]
  const opened = []
  const skipped = []

  if (withSaves && useSaves) {
    for (const save of SAVES) {
      const read = await saveStatements(ctx, save)

      if (read.skipped) {
        skipped.push(save.file)
      } else {
        statements.push(...read.statements)
        opened.push(read)
      }
    }
  }

  return { statements, opened, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, opened, skipped } = await statementsOf(ctx, true)

  console.log('\nCMC longevity ranking: the candidates of the Minerals page ranked by headline order or by a longevity preference, on bodies worked by hand, the page and the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  const keys = new Set(statements.map(([name]) => keyOf(name)))
  const bare = MUTATIONS.filter((mutation) => !mutation.fails.some((key) => !key.startsWith('save-') && keys.has(key))).map((mutation) => mutation.name)

  check('mutations: every planted fault names a group of checks that needs no save, so a checkout without the saves still catches it', bare.length ? short(bare) : true)

  for (const [name, result] of await runStatements(statements)) {
    check(name, result)
  }

  await Promise.all(opened.map((read) => read.close()))
}

const checkMutant = async (mutant) => {
  const began = Date.now()
  let sources

  try {
    sources = sourcesOf(mutant)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `invalid mutant: ${error.message}`)

    return
  }

  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  // The checks of the saves are witnesses: each must fail when its save is there, and none is needed when it is not. Every planted fault names a group that needs no save, and that group must fail whatever saves are present.
  const required = mutant.fails.filter((key) => !key.startsWith('save-'))
  const witnesses = mutant.fails.filter((key) => key.startsWith('save-'))
  const { statements, opened } = await statementsOf(ctx, witnesses.length > 0)
  const present = (key) => statements.some(([name]) => keyOf(name) === key)
  const named = [...required, ...witnesses.filter(present)]
  const absent = required.filter((key) => !present(key))
  const results = await runStatements(statements, named)
  const missed = named.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  await Promise.all(opened.map((read) => read.close()))
  check(`mutation caught: ${mutant.name}`, !required.length ? 'names no group of checks that needs no save' : absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--no-saves') {
      options.saves = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  useSaves = options.saves

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const extra = options.saves ? [] : ['--no-saves']
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...extra], weight: 30 }, ...wanted.map(({ id }) => ({ args: ['--part', id, ...extra], weight: 3 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names')
    wanted.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
