// The role-based missile optimiser: the missiles a race could design from the tech it holds, searched over a declared domain for the one a stated goal wants, under hard limits on size, cost, speed, range and hit chance. It is the missile counterpart of the engine search of design-search.js and follows its protocol: a typed domain (sweep-domain.js), a generator that yields its counts as it goes, a run with a budget and a status (search-run.js), and an efficient front (pareto.js, over the missile's own axes). The arithmetic is the missile rules' (design-rules.js `missileAccounting`, `evaluateMissile`, `admitMissiles`), the hit chance the combat model's (missile-hit.js) and the sensor reach the sensor model's (design-rules.js, read for the launching ship by launcher-coverage.js).
//
// The domain. Six figures are swept as typed domains: the engine size in MSP, the missile thrust modifier, the engine count, the fuel in MSP, the warhead in MSP and the warhead count; the three options a draft of the designer can switch (ECCM, terminal guidance, a laser warhead) are each off, on or either. The rest of the missile (its sensors, decoys, size limit and anything carried from a seeded design) is the base the domain is searched around. Each candidate is named by its figures alone (`candidateId`), so it has one name in every run. A warhead of 0 MSP carries no warhead: its warhead count is 1 for the accounting (the designer's default) and 0 carried, and the counts of it that differ are one candidate, counted as dropped without evaluation.
//
// The hot loop reads the raw accounting (`missileAccounting`) of each candidate, which is the arithmetic `evaluateMissile` is built on, and takes the figures of the engine from `missileEngineDesign` once for each size and thrust; the entries a result lists are admitted by `evaluateMissile` and `admitMissiles` when asked (`admitEntries`), which is what the checks hold the search against on every candidate of small domains. A candidate whose accounting is not known is rejected as unknown, never ranked and never taken as 0.
//
// The goals. Each has a hard limit set and a ranking that is a total order: the figures in the order stated are compared, and what ties on all of them is ordered by the candidate's name. The limits are the greatest size in MSP (and in BP), the least range, the least speed and the requested hit chance, whichever the goal has; a candidate is classified by the first limit it fails, in this order: its figures are not known, it is over the size, over the cost, under the speed, under the range, the goal is not defined for it (BP per warhead of a missile with no warhead), the hit chance is not known or is under the request. Three limits are monotone in the fuel at a fixed engine and warhead, and the search drops the larger fuels once one fails (over the size, over the cost, under the speed, under the hit chance, since the speed only falls as the size grows): those candidates are counted as dropped without evaluation and named by the limit that rules them out. A requested hit chance above 100 can never be met and drops every candidate at once.
//
// The result count (`keep`) changes only the list a result carries. The counts, the front, the status and the termination do not read it.

import { MISSILE_RULES, admitMissiles, agrees, evaluateMissile, missileAccounting, missileEngineDesign, missileSensorRange, missileSignature, normaliseMissileCandidate, sensorEffectiveRange } from './design-rules'
import { missileStageOf } from './design-data'
import { HIT_CAP, HIT_RULES, cappedHitChance, entered, rawHitChance } from './missile-hit'
import { DESIGN_LINES, MAX_ALTERNATIVES, NAME_LENGTH, emptyDraft, pdProblem, plannerFigure } from './missile-designer'
import { FRONT_LIMIT, createFront, describeEmpty, describeFront, normaliseAxes } from './pareto'
import { STATUS, combine, isAvailable, unavailable, valueOrNull } from './provenance'
import { TERMINATION, UNPACED, countText, createRun } from './search-run'
import { combinationCount, describeSweep, sweepDomain } from './sweep-domain'
import { hypotheticalOf, markHypothetical } from './tech-scenarios'

// What a run may spend: the candidates it evaluates and the milliseconds it runs for. A candidate costs the missile accounting and the hit chance, about a tenth of a millisecond.
export const MISSILE_BUDGET = Object.freeze({ candidates: 200000, ms: 30000 })

export const KEEP_DEFAULT = 10
export const KEEP_MAX = 1000
export const SLICE_CANDIDATES = 200

// How many looks at whether the step has run long enough pass between two reads of the clock.
const CLOCK_EVERY = 16
// What each member of the front a candidate is compared with counts for against a slice.
const FRONT_WORK = 0.01
// The hit chances held at one time, by speed, guidance and ECCM.
const HIT_MEMO_LIMIT = 100000
const HIT_TOLERANCE = 1e-9
const UNKNOWN_REASONS_KEPT = 5

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// ---- The goals -----------------------------------------------------------------------------------------------------

const axisOf = (label, noun, goal, read) => Object.freeze({ label, noun, goal, read })

// The axes of the efficient front, in the form pareto.js takes for a design family. A figure that is not known (the hit chance of a missile with no speed, BP per warhead of a missile with none, the deviation from a reference there is none of) is null, and the set takes no part on that axis.
export const MISSILE_AXES = Object.freeze({
  damage: axisOf('Damage', 'damage per warhead', 'max', (set) => finite(set.figures.damage)),
  speed: axisOf('Speed', 'speed', 'max', (set) => finite(set.figures.speed)),
  range: axisOf('Range', 'range', 'max', (set) => finite(set.figures.maxRange)),
  hitChance: axisOf('Hit chance', 'hit chance', 'max', (set) => finite(set.figures.hitChance)),
  cost: axisOf('BP', 'BP', 'min', (set) => finite(set.figures.cost)),
  size: axisOf('Size', 'size', 'min', (set) => finite(set.figures.size)),
  costPerWarhead: axisOf('BP per warhead', 'BP per warhead', 'min', (set) => finite(set.figures.costPerWarhead)),
  deviation: axisOf('Deviation', 'deviation from the reference', 'min', (set) => (set.figures.deviation ? finite(set.figures.deviation.greatest) : null)),
})

const rank = (spec) => Object.freeze(spec)

// The five goals. `needs` names the limits the goal cannot be searched without; `ties` the figures that order what ties on the objective, in order, before the candidate's name; `key(figures)` the figures as the list a ranking compares, each smaller-is-better.
export const GOALS = Object.freeze({
  warhead: rank({
    id: 'warhead',
    label: 'Greatest warhead at a hit chance',
    objective: 'The most damage per warhead among the missiles that reach the requested hit chance.',
    needs: Object.freeze(['hitChance']),
    ties: 'Ties go to the higher hit chance, then the lower BP, then the smaller size.',
    axes: Object.freeze([{ key: 'damage', goal: 'max' }, { key: 'hitChance', goal: 'max' }, { key: 'cost', goal: 'min' }]),
    key: (figures) => [-figures.damage, -figures.hitChance, figures.cost, figures.size],
  }),
  fastest: rank({
    id: 'fastest',
    label: 'Fastest',
    objective: 'The highest speed among the missiles within the limits.',
    needs: Object.freeze([]),
    ties: 'Ties go to the longer range, then the lower BP, then the smaller size.',
    axes: Object.freeze([{ key: 'speed', goal: 'max' }, { key: 'range', goal: 'max' }, { key: 'cost', goal: 'min' }]),
    key: (figures) => [-figures.speed, -figures.maxRange, figures.cost, figures.size],
  }),
  range: rank({
    id: 'range',
    label: 'Longest range',
    objective: 'The longest range among the missiles within the limits.',
    needs: Object.freeze([]),
    ties: 'Ties go to the higher speed, then the lower BP, then the smaller size.',
    axes: Object.freeze([{ key: 'range', goal: 'max' }, { key: 'speed', goal: 'max' }, { key: 'cost', goal: 'min' }]),
    key: (figures) => [-figures.maxRange, -figures.speed, figures.cost, figures.size],
  }),
  cheapest: rank({
    id: 'cheapest',
    label: 'Cheapest per warhead',
    objective: 'The lowest BP for each warhead carried among the missiles within the limits. A missile with no warhead has no BP per warhead: the goal is undefined for it and it is rejected.',
    needs: Object.freeze([]),
    ties: 'Ties go to the higher damage, then the smaller size, then the lower BP.',
    axes: Object.freeze([{ key: 'costPerWarhead', goal: 'min' }, { key: 'damage', goal: 'max' }, { key: 'range', goal: 'max' }]),
    key: (figures) => [figures.costPerWarhead, -figures.damage, figures.size, figures.cost],
  }),
  reference: rank({
    id: 'reference',
    label: 'Match a reference missile',
    objective: 'The least greatest relative deviation from the reference missile\'s speed, range and damage per warhead among the missiles within the limits. A figure the reference lacks, or has as 0, is left out.',
    needs: Object.freeze(['reference']),
    ties: 'Ties go to the lower sum of the deviations, then the lower BP, then the smaller size.',
    axes: Object.freeze([{ key: 'deviation', goal: 'min' }, { key: 'cost', goal: 'min' }, { key: 'size', goal: 'min' }]),
    key: (figures) => [figures.deviation.greatest, figures.deviation.sum, figures.cost, figures.size],
  }),
})

export const GOAL_IDS = Object.freeze(Object.keys(GOALS))

// The reference missile's figures as a goal reads them, from a saved missile's column of the designer (`figures` of cells with a `value`, null for one the save and the rules lack): the figures a deviation is taken from, the size the limit defaults to and the cost.
export const referenceOfColumn = (column) => {
  const value = (id) => (column && column.figures && column.figures[id] ? finite(column.figures[id].value) : null)

  return Object.freeze({ id: column && column.savedId ? column.savedId : null, name: column ? column.name : '', speed: value('speed'), maxRange: value('maxRange'), damage: value('damage'), size: value('size'), cost: value('cost') })
}

// ---- The domain ----------------------------------------------------------------------------------------------------

export const SWEEP_AXES = Object.freeze({
  engineMsp: Object.freeze({ label: 'Engine size', kind: 'sizeMSP', unit: 'MSP', limits: { min: 0.001 } }),
  thrust: Object.freeze({ label: 'Thrust modifier', kind: 'thrust', unit: '×', limits: { min: 0.001 } }),
  engines: Object.freeze({ label: 'Engines', kind: 'count', unit: '', limits: { min: 1 } }),
  fuelMsp: Object.freeze({ label: 'Fuel', kind: 'sizeMSP', unit: 'MSP', limits: { min: 0 } }),
  warheadMsp: Object.freeze({ label: 'Warhead', kind: 'sizeMSP', unit: 'MSP', limits: { min: 0 } }),
  warheads: Object.freeze({ label: 'Warheads', kind: 'count', unit: '', limits: { min: 1 } }),
})

export const AXIS_ORDER = Object.freeze(Object.keys(SWEEP_AXES))

export const OPTION_MODES = Object.freeze(['off', 'on', 'either'])

export const OPTION_LABELS = Object.freeze({ eccm: 'ECCM', terminal: 'Terminal guidance', laser: 'Laser warhead' })

// The loops of a search, outermost first.
const ORDER = Object.freeze(['engineMsp', 'thrust', 'engines', 'warheadMsp', 'warheads', 'eccm', 'terminal', 'laser', 'fuelMsp'])

const blank = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '')

// A swept figure's domain from the typed `{ min, max, step }`. A blank step is read as 1 only where the minimum and the maximum are the same text, which is one value whatever the step.
const axisDomain = (name, spec) => {
  const definition = SWEEP_AXES[name]
  const same = !blank(spec.min) && String(spec.min).trim() === String(spec.max).trim()

  return sweepDomain({ kind: definition.kind, min: spec.min, max: spec.max, step: blank(spec.step) && same ? '1' : spec.step, limits: definition.limits })
}

const levelOf = (value) => (finite(value) !== null && value >= 1 ? Math.trunc(value) : null)

// What an option's mode tries, as values of the candidate's option, or the reason it cannot be tried: `off` the option absent, `on` it applied at the tech line's level, `either` both.
const optionValues = (name, mode, tech) => {
  const absent = { eccm: 0, terminal: 1, laser: false }[name]
  const level = { eccm: levelOf(tech.eccm), terminal: finite(tech.terminal) !== null && tech.terminal > 1 ? tech.terminal : null, laser: finite(tech.laserEfficiency) !== null ? true : null }[name]

  if (!OPTION_MODES.includes(mode)) {
    return { values: null, error: `${OPTION_LABELS[name]}: choose off, on or either` }
  }

  if (mode === 'off') {
    return { values: [absent], error: '' }
  }

  if (level === null) {
    return { values: null, error: `${OPTION_LABELS[name]}: the tech line has no level to design with, so the option cannot be tried` }
  }

  return { values: mode === 'on' ? [level] : [absent, level], error: '' }
}

// The values the search sweeps from the typed fields (`fields`: each figure of SWEEP_AXES as { min, max, step } and each option of OPTION_LABELS as 'off', 'on' or 'either') and the tech figures: `{ ok, errors (a message for each field that is wrong, keyed 'engineMsp.min', 'terminal'), problems (the messages), axes, options, total (the candidates of the domain, null past a safe whole number), signature }`. A domain that is not ok has no values and must not run.
export const missileSweep = ({ fields, tech }) => {
  const errors = {}
  const axes = {}

  for (const name of AXIS_ORDER) {
    const domain = axisDomain(name, fields[name] || {})

    if (domain.ok) {
      axes[name] = domain
    } else {
      for (const [part, message] of Object.entries(domain.errors)) {
        errors[`${name}.${part}`] = message
      }
    }
  }

  const options = {}

  for (const name of Object.keys(OPTION_LABELS)) {
    const found = optionValues(name, fields[name], tech)

    if (found.error) {
      errors[name] = found.error
    } else {
      options[name] = found.values
    }
  }

  if (!(finite(tech.engine) > 0 && finite(tech.fuel) > 0 && finite(tech.maxThrust) > 0)) {
    errors.tech = 'The engine, fuel use and greatest thrust modifier tech lines need a level to design a missile engine'
  }

  const problems = Object.values(errors)

  if (problems.length) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors), problems: Object.freeze(problems), axes: null, options: null, total: null, signature: `invalid:${problems.join('|')}` })
  }

  const optionCount = Object.values(options).reduce((product, values) => product * values.length, 1)
  const grid = combinationCount(Object.values(axes))
  const total = grid === null || !Number.isSafeInteger(grid * optionCount) ? null : grid * optionCount
  const signature = [...AXIS_ORDER.map((name) => axes[name].signature), ...Object.keys(OPTION_LABELS).map((name) => `${name}:${options[name].join(',')}`)].join('|')

  return Object.freeze({ ok: true, errors: Object.freeze({}), problems: Object.freeze([]), axes: Object.freeze(axes), options: Object.freeze(options), total, signature })
}

// The deterministic name of a candidate from its figures: 'm:<engine size in thousandths of MSP>:<thrust in thousandths>:<engines>:<warhead thousandths>:<warheads>:<ECCM>:<terminal in thousandths>:<laser 0 or 1>:<fuel thousandths>'. A candidate has one name in every run, whatever else was searched; a warhead of 0 MSP is named with 0 warheads.
export const candidateId = ({ engineMsp, thrust, engines, warheadMsp, warheads, eccm, terminal, laser, fuelMsp }) => `m:${Math.round(engineMsp * 1000)}:${Math.round(thrust * 1000)}:${engines}:${Math.round(warheadMsp * 1000)}:${warheadMsp > 0 ? warheads : 0}:${eccm}:${Math.round(terminal * 1000)}:${laser ? 1 : 0}:${Math.round(fuelMsp * 1000)}`

// What a run of the search explores, from its sweep: `total`, the order the loops run in, each swept figure as the preview states it, and a `signature` that is the same for the same domain.
export const missileDomain = (plan) => {
  if (!plan.ok) {
    return Object.freeze({ kind: 'missile-grid', total: null, order: [], axes: {}, signature: plan.signature, idFormat: null })
  }

  const axis = (name) => ({ unit: SWEEP_AXES[name].unit, count: plan.axes[name].count, first: plan.axes[name].first, last: plan.axes[name].last, ranges: describeSweep(plan.axes[name]).ranges })

  return Object.freeze({ kind: 'missile-grid', total: plan.total, order: ORDER, axes: Object.freeze(Object.fromEntries(AXIS_ORDER.map((name) => [name, axis(name)]))), options: Object.freeze({ ...plan.options }), signature: plan.signature, idFormat: 'm:<engine MSP thousandths>:<thrust thousandths>:<engines>:<warhead MSP thousandths>:<warheads>:<ECCM>:<terminal thousandths>:<laser>:<fuel MSP thousandths>' })
}

// ---- The request ---------------------------------------------------------------------------------------------------

const numberField = (value, label, { whole = false, above = null, min = 0 } = {}) => {
  const number = entered(value)

  if (number === null) {
    return { value: null, error: `${label}: enter a number` }
  }

  if (number < min || (above !== null && !(number > above))) {
    return { value: null, error: above !== null ? `${label}: enter a number above ${above}` : `${label}: enter a number of ${min} or more` }
  }

  if (whole && !Number.isInteger(number)) {
    return { value: null, error: `${label}: enter a whole number` }
  }

  return { value: number, error: '' }
}

// The base a domain is searched around, from the draft of the designer the missile is made from: its sensors, decoys and size limit as numbers. A figure that is not one is an error of the field, never 0.
export const baseOfDraft = (draft, tech) => {
  const errors = {}
  const read = (field, label, options) => {
    const found = numberField(draft[field], label, options)

    if (found.error) {
      errors[`base.${field}`] = found.error
    }

    return found.value
  }

  const decoys = read('decoys', 'ECM decoys', { whole: true })
  const activeMsp = read('activeMsp', 'Active sensor', {})
  const thermalMsp = read('thermalMsp', 'Thermal sensor', {})
  const emMsp = read('emMsp', 'EM sensor', {})
  const geoMsp = read('geoMsp', 'Geo sensor', {})
  const sizeLimit = read('sizeLimit', 'Size limit', {})
  const resolution = blank(draft.resolution) ? null : read('resolution', 'Sensor resolution', {})
  const carried = draft.carried || {}
  const retarget = draft.options && draft.options.retarget && levelOf(tech.retarget) !== null ? levelOf(tech.retarget) : 0

  return { ok: Object.keys(errors).length === 0, errors, base: { decoys, activeMsp, thermalMsp, emMsp, geoMsp, sizeLimit, resolution, retarget, shipDecoy: Boolean(carried.shipDecoy), groundPod: Boolean(carried.groundPod), enhancedRadiation: Boolean(carried.enhancedRadiation), stages: Number(carried.stages) > 0 ? Number(carried.stages) : 0 } }
}

export const NO_BASE = Object.freeze({ decoys: 0, activeMsp: 0, thermalMsp: 0, emMsp: 0, geoMsp: 0, sizeLimit: 0, resolution: null, retarget: 0, shipDecoy: false, groundPod: false, enhancedRadiation: false, stages: 0 })

// The second stage of a seeded draft as the search reads it: null for a draft with none, the stage of the fixture when the save is open, or a missing marker (its figures are unknown) when it is not.
export const stageOfDraft = (fixture, draft) => {
  const carried = draft && draft.carried

  if (!carried || !(carried.stages > 0)) {
    return null
  }

  return fixture ? missileStageOf(fixture, { SecondStageID: carried.stageId, NumSS: carried.stages }) : { missing: true }
}

const FIELD_TEXT = Object.freeze({ goal: 'warhead', keep: '10', maxMsp: '20', maxBp: '', minRangeKm: '', minSpeed: '', hitChance: '50' })

// The form as it starts: each swept figure as { min, max, step } of text, each option as a mode, the limits as text and `axes` null for the goal's own front.
export const DEFAULT_FIELDS = Object.freeze({
  ...FIELD_TEXT,
  engineMsp: Object.freeze({ min: '1', max: '4', step: '1' }),
  thrust: Object.freeze({ min: '1', max: '2', step: '0.5' }),
  engines: Object.freeze({ min: '1', max: '2', step: '1' }),
  fuelMsp: Object.freeze({ min: '1', max: '8', step: '1' }),
  warheadMsp: Object.freeze({ min: '1', max: '4', step: '1' }),
  warheads: Object.freeze({ min: '1', max: '1', step: '' }),
  eccm: 'off',
  terminal: 'off',
  laser: 'off',
  axes: null,
})

const isText = (value) => typeof value === 'string'

// The fields a stored form holds, or the defaults for what is missing or not text: a form of an earlier build never breaks the page.
export const normaliseFields = (stored) => {
  const source = stored && typeof stored === 'object' ? stored : {}
  const fields = { axes: null }

  for (const name of Object.keys(FIELD_TEXT)) {
    fields[name] = name === 'goal' ? (GOALS[source.goal] ? source.goal : FIELD_TEXT.goal) : (isText(source[name]) ? source[name] : FIELD_TEXT[name])
  }

  for (const name of AXIS_ORDER) {
    const spec = source[name] && typeof source[name] === 'object' ? source[name] : {}

    fields[name] = Object.fromEntries(['min', 'max', 'step'].map((part) => [part, isText(spec[part]) ? spec[part] : DEFAULT_FIELDS[name][part]]))
  }

  for (const name of Object.keys(OPTION_LABELS)) {
    fields[name] = OPTION_MODES.includes(source[name]) ? source[name] : 'off'
  }

  if (Array.isArray(source.axes)) {
    try {
      fields.axes = normaliseAxes(source.axes, MISSILE_AXES).map((axis) => ({ ...axis }))
    } catch {
      fields.axes = null
    }
  }

  return fields
}

const TECH_FIELDS = Object.freeze(['engine', 'fuel', 'maxThrust', 'warhead', 'laserEfficiency', 'reactor', 'active', 'thermal', 'em', 'geo', 'eccm', 'terminal', 'retarget'])

// The tech figures a request reads, each a number or null: the lines the designer designs a missile with.
export const techOf = (figures) => Object.fromEntries(TECH_FIELDS.map((name) => [name, finite(figures && figures[name])]))

// The tech lines a search of `fields` over the draft the base is read from may read, by the names of the designer's lines: the engine lines always, the warhead when a warhead is swept (and is no ship decoy), each option that is not off, the sensors of the base and what they need. A line a search does not read does not make its figures hypothetical.
export const usedTechLines = ({ fields, baseDraft = null }) => {
  const used = new Set(['engine', 'fuel', 'maxThrust'])
  const carried = (baseDraft && baseDraft.carried) || {}
  const reads = (value) => entered(value) === null || entered(value) > 0
  const sensors = baseDraft ? ['active', 'thermal', 'em', 'geo'].filter((name) => entered(baseDraft[`${name}Msp`]) > 0) : []

  if (reads(fields.warheadMsp.max) && !carried.shipDecoy) {
    used.add('warhead')
  }

  if (fields.eccm !== 'off') {
    used.add('eccm')
  }

  if (fields.terminal !== 'off') {
    used.add('terminal')
  }

  if (fields.laser !== 'off') {
    used.add('laserEfficiency')
  }

  sensors.forEach((name) => used.add(name))

  if (sensors.length) {
    used.add('reactor')
  }

  if (sensors.includes('active')) {
    used.add('em')
  }

  if (baseDraft && baseDraft.options && baseDraft.options.retarget) {
    used.add('retarget')
  }

  return [...used]
}

// The assumptions of the hypothetical levels (tech-scenarios.js `resolveChoices`) among the lines a search reads, one for each; none for a page with no resolution.
export const techNotesOf = (resolution, { fields, baseDraft = null }) => (resolution ? hypotheticalOf(resolution, usedTechLines({ fields, baseDraft }).map((name) => DESIGN_LINES[name])).assumptions : [])

// The request of a run from the fields of the page, as the plain object the run is named by: `{ ok, errors, warnings, input }`. `fields` holds `goal`, `keep`, the swept figures and options of the sweep, the limits (`maxMsp`, `maxBp`, `minRangeKm`, `minSpeed`, `hitChance`) and `axes` (the front's, or null for the goal's own); `scenario` is the texts of the target speed, the missile jammer, the tactical modifier and the point-defence figure; `reference` is a reference missile (referenceOfColumn) or null; `baseDraft` the draft the base is read from, or null for a missile with no sensors; `stage` the second stage of a seeded design, if it has one; `techNotes` the assumptions of the hypothetical tech levels the design lines of the search read (techNotesOf), which every figure of the result then carries. A request that is not ok has an error for each field that is wrong and no input.
export const readRequest = ({ fields, scenario, tech, reference = null, baseDraft = null, stage = null, version = null, techNotes = [] }) => {
  const errors = {}
  const warnings = {}
  const goal = GOALS[fields.goal]

  if (!goal) {
    errors.goal = 'Choose one of the five goals'
  }

  const keep = numberField(fields.keep, 'Results to keep', { whole: true, above: 0 })

  if (keep.error || keep.value > KEEP_MAX) {
    errors.keep = keep.error || `Results to keep: enter a whole number from 1 to ${KEEP_MAX}`
  }

  const figures = techOf(tech)
  const plan = missileSweep({ fields, tech: figures })

  Object.assign(errors, plan.errors)

  const optional = (name, label, options) => (blank(fields[name]) ? { value: null, error: '' } : numberField(fields[name], label, options))
  const limits = { maxMsp: optional('maxMsp', 'Size limit', { above: 0 }), maxBp: optional('maxBp', 'BP limit', { above: 0 }), minRangeKm: optional('minRangeKm', 'Least range', {}), minSpeed: optional('minSpeed', 'Least speed', {}), hitChance: optional('hitChance', 'Hit chance', {}) }

  if (limits.maxMsp.value === null && !limits.maxMsp.error) {
    if (goal && goal.id === 'reference' && reference && finite(reference.size) !== null) {
      limits.maxMsp = { value: reference.size, error: '' }
    } else {
      limits.maxMsp = { value: null, error: 'Size limit: enter the greatest size in MSP' }
    }
  }

  if (goal && goal.needs.includes('hitChance') && limits.hitChance.value === null && !limits.hitChance.error) {
    limits.hitChance = { value: null, error: 'Hit chance: enter the hit chance to reach, in percent' }
  }

  for (const [name, found] of Object.entries(limits)) {
    if (found.error) {
      errors[name] = found.error
    }
  }

  const targetSpeed = entered(scenario.targetSpeed)
  const jammer = entered(scenario.jammer)
  const modifier = entered(scenario.modifier)
  const signature = blank(scenario.targetSignature) ? null : entered(scenario.targetSignature)

  if (limits.hitChance.value !== null && (targetSpeed === null || targetSpeed < 0)) {
    errors.targetSpeed = 'Target speed: enter a number of 0 or more to reach a hit chance'
  }

  if (limits.hitChance.value !== null && (jammer === null || jammer < 0)) {
    errors.jammer = 'Jammer: enter a number of 0 or more to reach a hit chance'
  }

  if (limits.hitChance.value !== null && (modifier === null || modifier <= 0)) {
    errors.modifier = 'Tactical modifier: enter a number above 0 to reach a hit chance'
  }

  const pdError = pdProblem(scenario.pd)

  if (pdError) {
    warnings.pd = pdError
  }

  const base = baseDraft ? baseOfDraft(baseDraft, figures) : { ok: true, errors: {}, base: NO_BASE }

  Object.assign(errors, base.errors)

  let axes = null

  if (goal && !fields.axes) {
    axes = goal.axes.map((axis) => ({ ...axis }))
  } else if (fields.axes) {
    try {
      axes = normaliseAxes(fields.axes, MISSILE_AXES).map((axis) => ({ ...axis }))
    } catch (error) {
      errors.axes = error.message
    }
  }

  if (goal && goal.id === 'reference') {
    const used = reference ? ['speed', 'maxRange', 'damage'].filter((name) => finite(reference[name]) !== null && reference[name] > 0) : []

    if (!used.length) {
      errors.reference = 'Reference: choose a saved missile with a speed, a range or a damage to match'
    }
  }

  if (Object.keys(errors).length) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors), warnings: Object.freeze(warnings), input: null })
  }

  const domain = Object.fromEntries([...AXIS_ORDER.map((name) => [name, { min: String(fields[name].min).trim(), max: String(fields[name].max).trim(), step: String(fields[name].step === undefined ? '' : fields[name].step).trim() }]), ...Object.keys(OPTION_LABELS).map((name) => [name, fields[name]])])

  const input = {
    goal: goal.id,
    keep: keep.value,
    tech: figures,
    base: base.base,
    stage,
    domain,
    constraints: { maxMsp: limits.maxMsp.value, maxBp: limits.maxBp.value, minRangeKm: limits.minRangeKm.value, minSpeed: limits.minSpeed.value, hitChance: limits.hitChance.value },
    scenario: { targetSpeed, jammer, modifier, targetSignature: signature, pd: pdError ? null : entered(scenario.pd) },
    reference: goal.id === 'reference' ? { id: reference.id === undefined ? null : reference.id, name: reference.name || '', speed: finite(reference.speed), maxRange: finite(reference.maxRange), damage: finite(reference.damage), size: finite(reference.size), cost: finite(reference.cost) } : null,
    axes,
    techNotes: Object.freeze(techNotes.filter(isText)),
    version,
  }

  return Object.freeze({ ok: true, errors: Object.freeze({}), warnings: Object.freeze(warnings), input })
}

// ---- Candidates ----------------------------------------------------------------------------------------------------

// A candidate of the designer's `evaluateMissile` from the figures of an entry and the request it is for: the missile of a draft, with the engine designed by the rule from the tech lines.
export const candidateOfEntry = (input, values) => {
  const { tech, base } = input

  return {
    engine: { sizeMsp: values.engineMsp, thrust: values.thrust, engineTech: tech.engine, fuelTech: tech.fuel, maxThrust: tech.maxThrust },
    engines: values.engines,
    fuelMsp: values.fuelMsp,
    warheadMsp: values.warheadMsp,
    warheads: values.warheads,
    shipDecoy: base.shipDecoy,
    decoys: base.decoys,
    activeMsp: base.activeMsp,
    thermalMsp: base.thermalMsp,
    emMsp: base.emMsp,
    geoMsp: base.geoMsp,
    sizeLimit: base.sizeLimit,
    stage: input.stage || null,
    stages: input.stage ? base.stages : 0,
    options: { eccm: values.eccm, terminal: values.terminal, retarget: base.retarget, laser: values.laser },
    tech: { warhead: tech.warhead, laserEfficiency: tech.laserEfficiency, reactor: tech.reactor, active: tech.active, thermal: tech.thermal, em: tech.em, geo: tech.geo },
    sensor: { resolution: base.resolution, emSensitivity: tech.em },
    groundPod: base.groundPod,
    enhancedRadiation: base.enhancedRadiation,
  }
}

const evaluations = new WeakMap()

// The missile rules' own evaluation of an entry of a result (design-rules.js `evaluateMissile`, against the limits of the request and its scenario), worked out when first read.
export const evaluateEntry = (input, entry) => {
  if (!evaluations.has(entry)) {
    const scenario = input.scenario.targetSpeed === null || input.scenario.jammer === null || input.scenario.modifier === null ? null : { targetSpeed: input.scenario.targetSpeed, jammer: input.scenario.jammer, modifier: input.scenario.modifier, version: input.version }

    evaluations.set(entry, evaluateMissile(candidateOfEntry(input, entry.values), { budget: { maxMsp: input.constraints.maxMsp, maxBp: input.constraints.maxBp }, scenario }))
  }

  return evaluations.get(entry)
}

// The entries sorted by the missile rules before any is listed as admitted: `{ admitted, rejected }` of `admitMissiles` over each entry's evaluation, with the entry beside it. An entry the rules do not admit is never one the search lists; the checks hold the whole search to this.
export const admitEntries = (input, entries) => {
  const sorted = admitMissiles(entries.map((entry) => evaluateEntry(input, entry)))
  const byEvaluation = new Map(entries.map((entry) => [evaluateEntry(input, entry), entry]))

  return { admitted: sorted.admitted.map((evaluation) => byEvaluation.get(evaluation)), rejected: sorted.rejected.map((item) => ({ entry: byEvaluation.get(item.evaluation), verdict: item.verdict, reasons: item.reasons })) }
}

// ---- The comparison of two candidates ------------------------------------------------------------------------------

const compareKeys = (first, second) => {
  for (let at = 0; at < first.length; at++) {
    if (first[at] !== second[at]) {
      return first[at] < second[at] ? -1 : 1
    }
  }

  return 0
}

// Whether entry `a` is listed ahead of `b`: the goal's figures in order, then the name.
const ranksAhead = (a, b) => {
  const order = compareKeys(a.key, b.key)

  return order === 0 ? a.id < b.id : order < 0
}

const insertRanked = (list, entry, keep) => {
  let low = 0
  let high = list.length

  while (low < high) {
    const middle = (low + high) >> 1

    if (ranksAhead(list[middle], entry)) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  list.splice(low, 0, entry)

  if (list.length > keep) {
    list.pop()
  }
}

// The deviation of a candidate from the reference: each figure the reference has above 0 as |figure - reference| / reference, the greatest and their sum.
const deviationOf = (figures, reference) => {
  const parts = {}
  let greatest = 0
  let sum = 0

  for (const [name, of] of [['speed', 'speed'], ['maxRange', 'maxRange'], ['damage', 'damage']]) {
    if (finite(reference[name]) !== null && reference[name] > 0) {
      const part = Math.abs(figures[of] - reference[name]) / reference[name]

      parts[name] = part
      greatest = Math.max(greatest, part)
      sum += part
    }
  }

  return { greatest, sum, parts }
}

const overLimit = (found, allowed) => found > allowed && !agrees(found, allowed)

// ---- The search ----------------------------------------------------------------------------------------------------

const NO_PRUNES = () => ({ size: 0, cost: 0, speed: 0, hit: 0, 'hit-cap': 0, 'hit-unknown': 0, unsupported: 0, redundant: 0 })

const NO_OUTCOMES = () => ({ unknown: 0, size: 0, cost: 0, speed: 0, range: 0, undefined: 0, hitUnknown: 0, hit: 0, feasible: 0 })

// Searches the domain of `input` (the request of readRequest) and yields as search-run.js has it: about every slice of work `{ progress, counts, snapshot }`. Returns { goal, entries (the best `keep`, in the goal's order), best, front (pareto.js's result for the front's axes, over every candidate that met the limits), counts (`total`, `evaluated`, `pruned`, `unexplored`, `feasible`, `retained`, `prunedBy`), outcomes (what became of each candidate evaluated: 'unknown', 'size', 'cost', 'speed', 'range', 'undefined', 'hitUnknown', 'hit' (the limit it failed first) and 'feasible'), reach ({ requestedHit, bestHit }: the best hit chance among the candidates that met every limit but the hit chance), sensor (the missile's own sensor of the base), unknownReasons, infeasible (null, or `{ kind, bestHit }` for a search that ended and found no candidate), output ({ limit, listed, omitted }), termination }. `plan` is the sweep, made once when the caller made it; `maxCandidates` stops the search at that many candidates evaluated.
export function* searchMissiles({ plan = null, maxCandidates = null, slice = SLICE_CANDIDATES, frontLimit = FRONT_LIMIT, pace = UNPACED, ...input }) {
  const sweep = plan || missileSweep({ fields: input.domain, tech: input.tech })

  if (!sweep.ok) {
    throw new Error(`The sweep cannot run. ${sweep.problems.join(' ')}`)
  }

  const goal = GOALS[input.goal]
  const { tech, base, constraints, scenario, reference, keep } = input
  const { axes, options } = sweep
  const total = sweep.total
  const exact = Number.isSafeInteger(total)
  const front = createFront(input.axes || goal.axes, { limit: frontLimit, name: (set) => set.id, catalogue: MISSILE_AXES })
  const ranked = []
  const pruned = NO_PRUNES()
  const outcomes = NO_OUTCOMES()
  const unknownReasons = new Set()
  const hitMemo = new Map()
  const requested = constraints.hitChance
  const probeValues = { engineMsp: axes.engineMsp.at(0), thrust: axes.thrust.at(0), engines: axes.engines.at(0), fuelMsp: axes.fuelMsp.at(0), warheadMsp: axes.warheadMsp.at(0), warheads: axes.warheads.at(0), eccm: options.eccm[0], terminal: options.terminal[0], laser: options.laser[0] }
  const probe = normaliseMissileCandidate(candidateOfEntry(input, probeValues))
  const hitBlocked = base.shipDecoy || base.stages > 0
  const hitUnavailable = hitBlocked || scenario.targetSpeed === null || scenario.jammer === null || scenario.modifier === null
  let evaluated = 0
  let matched = 0
  let bestHit = null
  let work = 0
  let looks = 0
  let done = 0

  const prunedSum = () => pruned.size + pruned.cost + pruned.speed + pruned.hit + pruned['hit-cap'] + pruned['hit-unknown'] + pruned.unsupported + pruned.redundant

  const retained = () => new Set([...ranked, ...front.sets()]).size

  const countsNow = () => {
    if (!exact) {
      return { total: null, evaluated, pruned: null, unexplored: null, feasible: matched, retained: retained(), prunedBy: null }
    }

    const dropped = prunedSum()

    return { total, evaluated, pruned: dropped, unexplored: total - evaluated - dropped, feasible: matched, retained: retained(), prunedBy: { ...pruned } }
  }

  // The missile's own sensor of the base, the same for every candidate: its range from the active sensor's strength in the accounting, and the reach of that range against the target's signature by the sensor model. Each is null with its reason where it is not known; the launching ship's sensors are not part of it (launcher-coverage.js).
  const sensorOf = () => {
    const none = (reason) => ({ rangeKm: null, reason, reachKm: null, reachReason: reason })

    if (!(base.activeMsp > 0)) {
      return none('the missile has no active sensor')
    }

    if (base.resolution === null || tech.em === null) {
      return none('the resolution and the EM sensitivity of the active sensor are not given')
    }

    const strength = missileAccounting(probeInput(probeValues, engineOf(probeValues.engineMsp, probeValues.thrust))).figures.strengths.active

    if (strength === null) {
      return none('the strength of the active sensor is not known: its tech level is not')
    }

    const rangeKm = missileSensorRange({ strength, emSensitivity: tech.em, resolution: base.resolution })

    if (scenario.targetSignature === null) {
      return { rangeKm, reason: '', reachKm: null, reachReason: 'a target signature of 0 or more HS is not given' }
    }

    const reach = sensorEffectiveRange({ rangeKm, signature: scenario.targetSignature, resolution: base.resolution })

    return { rangeKm, reason: '', reachKm: valueOrNull(reach), reachReason: isAvailable(reach) ? '' : reach.inputs.missing.join('; ') }
  }

  const engineOf = (sizeMsp, thrust) => ({ sizeMsp, ...missileEngineDesign({ sizeMsp, thrust, engineTech: tech.engine, fuelTech: tech.fuel, maxThrust: tech.maxThrust }) })

  // The input the accounting reads, one object the loop changes in place.
  const probeInput = (values, engine) => ({ warheadMsp: values.warheadMsp, warheads: values.warheadMsp > 0 ? values.warheads : 1, shipDecoy: probe.shipDecoy, decoys: probe.decoys, fuelMsp: values.fuelMsp, activeMsp: probe.activeMsp, thermalMsp: probe.thermalMsp, emMsp: probe.emMsp, geoMsp: probe.geoMsp, sizeLimit: probe.sizeLimit, engine, engines: values.engines, stage: probe.stage, stages: probe.stages, options: { eccm: values.eccm, terminal: values.terminal, retarget: probe.options.retarget, laser: values.laser }, tech: probe.tech, unsupported: {} })

  const sensor = sensorOf()

  const hitOf = (speed, atg, eccm) => {
    if (hitUnavailable) {
      return null
    }

    const key = `${speed}|${atg}|${eccm}`
    let found = hitMemo.get(key)

    if (found === undefined) {
      found = valueOrNull(cappedHitChance(rawHitChance({ missileSpeed: speed, targetSpeed: scenario.targetSpeed, atg, modifier: scenario.modifier, jammer: scenario.jammer, eccm, version: input.version })))

      if (hitMemo.size >= HIT_MEMO_LIMIT) {
        hitMemo.clear()
      }

      hitMemo.set(key, found)
    }

    return found
  }

  const infeasibleOf = (termination) => {
    if (termination !== TERMINATION.EXHAUSTED || matched > 0) {
      return null
    }

    if (pruned.unsupported > 0) {
      return { kind: 'unsupported', bestHit: null }
    }

    if (pruned['hit-cap'] > 0) {
      return { kind: 'hit-cap', bestHit: null }
    }

    if (pruned['hit-unknown'] > 0) {
      return { kind: 'hit-unknown', bestHit: null }
    }

    if (requested !== null && bestHit !== null && bestHit + HIT_TOLERANCE < requested) {
      return { kind: 'hit-unreachable', bestHit }
    }

    return { kind: 'limits', bestHit }
  }

  const resultOf = (termination) => ({
    goal: goal.id,
    entries: ranked.slice(),
    best: ranked[0] || null,
    front: front.result({ explored: termination === TERMINATION.EXHAUSTED, feasible: matched }),
    counts: countsNow(),
    outcomes: { ...outcomes },
    reach: { requestedHit: requested, bestHit },
    sensor,
    unknownReasons: [...unknownReasons],
    infeasible: infeasibleOf(termination),
    output: { limit: keep, listed: ranked.length, omitted: matched - ranked.length },
    termination,
  })

  const stepOf = () => ({ progress: exact && total > 0 ? Math.min(1, (evaluated + prunedSum()) / total) : done / Math.max(1, axes.engineMsp.count * axes.thrust.count * axes.engines.count), counts: countsNow(), snapshot: () => resultOf(null) })

  const due = () => {
    if (work >= slice) {
      return true
    }

    if (++looks < CLOCK_EVERY) {
      return false
    }

    looks = 0

    return pace.expired()
  }

  const dropAll = (reason) => {
    if (exact) {
      pruned[reason] = total
    }

    return resultOf(TERMINATION.EXHAUSTED)
  }

  // The options of the probe the rules do not cover (a ground pod, an enhanced radiation warhead, a retargeting level they have no saved design for) are the base's, the same for every candidate: the whole domain is outside the rules.
  if (evaluateMissile(candidateOfEntry(input, probeValues)).verdict === 'unsupported') {
    return dropAll('unsupported')
  }

  if (requested !== null && requested > HIT_CAP) {
    return dropAll('hit-cap')
  }

  if (requested !== null && hitUnavailable) {
    return dropAll('hit-unknown')
  }

  const perTail = options.eccm.length * options.terminal.length * options.laser.length * axes.fuelMsp.count
  const fuel = axes.fuelMsp

  for (let e = 0; e < axes.engineMsp.count; e++) {
    const engineMsp = axes.engineMsp.at(e)

    for (let t = 0; t < axes.thrust.count; t++) {
      const thrust = axes.thrust.at(t)
      const engine = engineOf(engineMsp, thrust)

      for (let n = 0; n < axes.engines.count; n++) {
        const engines = axes.engines.at(n)

        done++

        for (let w = 0; w < axes.warheadMsp.count; w++) {
          const warheadMsp = axes.warheadMsp.at(w)

          for (let k = 0; k < axes.warheads.count; k++) {
            if (warheadMsp === 0 && k > 0) {
              pruned.redundant += perTail * (axes.warheads.count - k)
              break
            }

            const warheads = warheadMsp > 0 ? axes.warheads.at(k) : 1

            for (const eccm of options.eccm) {
              for (const terminal of options.terminal) {
                for (const laser of options.laser) {
                  const values = { engineMsp, thrust, engines, fuelMsp: 0, warheadMsp, warheads, eccm, terminal, laser }
                  const accounting = probeInput(values, engine)

                  for (let f = 0; f < fuel.count; f++) {
                    if (maxCandidates !== null && evaluated >= maxCandidates) {
                      return resultOf(TERMINATION.CANDIDATE_BUDGET)
                    }

                    if (due()) {
                      work = 0

                      yield stepOf()
                    }

                    work++
                    evaluated++
                    values.fuelMsp = fuel.at(f)
                    accounting.fuelMsp = values.fuelMsp

                    const { figures: raw, contributions } = missileAccounting(accounting)
                    const damage = laser ? raw.laserWarhead : raw.warheadStrength
                    let reason = null

                    if (raw.size === null || raw.sizeSum === null || raw.cost === null || raw.speed === null || raw.maxRange === null || damage === null) {
                      outcomes.unknown++
                      reason = 'unknown'

                      if (unknownReasons.size < UNKNOWN_REASONS_KEPT) {
                        Object.values(contributions).filter((part) => part.unknown).forEach((part) => unknownReasons.add(part.unknown))
                      }
                    } else if (overLimit(Math.max(raw.size, raw.sizeSum), constraints.maxMsp)) {
                      outcomes.size++
                      reason = 'size'
                    } else if (constraints.maxBp !== null && overLimit(raw.cost, constraints.maxBp)) {
                      outcomes.cost++
                      reason = 'cost'
                    } else if (constraints.minSpeed !== null && raw.speed < constraints.minSpeed) {
                      outcomes.speed++
                      reason = 'speed'
                    } else if (constraints.minRangeKm !== null && raw.maxRange < constraints.minRangeKm) {
                      outcomes.range++
                      reason = 'range'
                    }

                    const carried = warheadMsp > 0 ? warheads : 0
                    let hit = null

                    if (reason === null && goal.id === 'cheapest' && carried === 0) {
                      outcomes.undefined++
                      reason = 'undefined'
                    } else if (reason === null) {
                      hit = hitOf(raw.speed, terminal, eccm)

                      if (hit !== null && (bestHit === null || hit > bestHit)) {
                        bestHit = hit
                      }

                      if (requested !== null && hit === null) {
                        outcomes.hitUnknown++
                        reason = 'hitUnknown'
                      } else if (requested !== null && hit + HIT_TOLERANCE < requested) {
                        outcomes.hit++
                        reason = 'hit'
                      }
                    }

                    if (reason === null) {
                      outcomes.feasible++
                      matched++

                      const figures = { size: raw.size, sizeSum: raw.sizeSum, cost: raw.cost, speed: raw.speed, maxRange: raw.maxRange, endurance: raw.endurance, damage, warheadsCarried: carried, hitChance: hit, costPerWarhead: carried > 0 ? raw.cost / carried : null, signature: missileSignature({ sizeMsp: raw.size }), deviation: reference ? deviationOf({ speed: raw.speed, maxRange: raw.maxRange, damage }, reference) : null }
                      const entry = { id: candidateId(values), values: { ...values }, figures, key: null }

                      entry.key = goal.key(figures)

                      if (ranked.length < keep || ranksAhead(entry, ranked[ranked.length - 1])) {
                        insertRanked(ranked, entry, keep)
                      }

                      front.offer(entry)
                      work += front.scanned * FRONT_WORK
                    } else if (reason === 'size' || reason === 'cost' || reason === 'speed' || reason === 'hit') {
                      // The size, the cost, the speed and the hit chance only get worse with more fuel at the same engine, warhead and options: the rest are ruled out.
                      const rest = fuel.count - f - 1

                      if (exact) {
                        pruned[reason] += rest
                      }

                      break
                    }
                  }

                  if (due()) {
                    work = 0

                    yield stepOf()
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return resultOf(TERMINATION.EXHAUSTED)
}

// The run of a request: its descriptor names the input and the domain, `budget` is { candidates, ms } (MISSILE_BUDGET by default; null for either is no limit), `now` the clock. A sweep that cannot run fails the run on its first step with the problems in words.
export const missileRun = (input, { budget = MISSILE_BUDGET, now, slice = SLICE_CANDIDATES } = {}) => {
  const plan = missileSweep({ fields: input.domain, tech: input.tech })

  return createRun({ kind: 'missile-search', input, domain: missileDomain(plan), budget, now, search: (pace) => searchMissiles({ ...input, plan, maxCandidates: budget.candidates, slice, pace }) })
}

// ---- Nominating -----------------------------------------------------------------------------------------------------

const numberText = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toPrecision(12))) : '')

// The draft of the designer an entry is: the figures of the entry as text over the draft the base was read from (a copy of it, with the sensors, decoys and what it carries), designed with the page's tech lines.
export const nominationDraft = (entry, { baseDraft = null, name = '' } = {}) => {
  const draft = JSON.parse(JSON.stringify(baseDraft || emptyDraft('')))
  const { values } = entry
  const options = { eccm: values.eccm > 0, terminal: values.terminal > 1, retarget: Boolean(draft.options && draft.options.retarget), laser: values.laser }

  return Object.assign(draft, { kind: 'designed', key: '', name: name.slice(0, NAME_LENGTH), techMode: 'page', engines: String(values.engines), engineMsp: numberText(values.engineMsp), thrust: numberText(values.thrust), fuelMsp: numberText(values.fuelMsp), warheadMsp: numberText(values.warheadMsp), warheads: String(values.warheads), options })
}

// The entries a request nominates as alternatives of the designer beside the baseline: the best of the list, at most `MAX_ALTERNATIVES`, each named by its goal and place.
export const nominations = (outcome, { baseDraft = null, limit = MAX_ALTERNATIVES } = {}) => {
  const result = outcome.result
  const input = outcome.descriptor.input

  if (!result) {
    return []
  }

  return result.entries.slice(0, Math.max(0, Math.min(limit, MAX_ALTERNATIVES))).map((entry, index) => nominationDraft(entry, { baseDraft, name: `${GOALS[input.goal].label} ${index + 1}` }))
}

const wholeAround = (value) => (Number.isInteger(value) && value >= 1 ? { min: String(Math.max(1, value - 1)), max: String(value + 1), step: '1' } : null)

// Five points of the sweep's own 0.001 resolution with the figure at the middle: two steps of a quarter of the figure either side (the lower ones cut at `least`), so the saved missile is itself a candidate.
const sizeAround = (value, least) => {
  if (value === 0) {
    return { min: '0', max: '2', step: '1' }
  }

  const unit = 0.001
  const units = Math.round(value / unit)
  const step = Math.max(1, Math.round(units / 4))
  const below = Math.min(2, Math.floor((units - Math.round(least / unit)) / step))
  const text = (count) => String(Number((count * unit).toPrecision(12)))

  return { min: text(units - below * step), max: text(units + 2 * step), step: text(step) }
}

// The fields that search around a saved missile's own figures, from the draft it was seeded as: the match of a reference as the goal, the engine, fuel and warhead sizes from half to one and a half times the saved ones in four steps, and the engines and warheads one fewer to one more. A figure of the draft that is not a number leaves its field out, never 0.
export const domainAround = (draft) => {
  const read = (value) => finite(entered(value))
  const fields = { goal: 'reference' }
  const sized = [['engineMsp', 0.001], ['thrust', 0.001], ['fuelMsp', 0], ['warheadMsp', 0]]

  for (const [name, least] of sized) {
    const value = read(draft[name])
    const around = value === null || value < 0 ? null : sizeAround(value, least)

    if (around) {
      fields[name] = around
    }
  }

  for (const name of ['engines', 'warheads']) {
    const around = wholeAround(read(draft[name]))

    if (around) {
      fields[name] = around
    }
  }

  return fields
}

const frontFigure = (key, set) => {
  const value = MISSILE_AXES[key].read(set)

  return key === 'deviation' && value !== null ? value * 100 : value
}

// The result an axis of the front is a figure of: the deviation, written in percent against a reference, has none.
const FRONT_RESULT = Object.freeze({ damage: 'damage', speed: 'speed', range: 'maxRange', hitChance: 'hitChance', cost: 'cost', size: 'size', costPerWarhead: 'costPerWarhead' })

// The efficient front of a result as a table: the axes it was compared on with their headings, and a row for each member with its figure on each axis (null where unknown), the provenance result of that figure (`results`, null where the figure is no result of the save, as the deviation) and how many candidates are alike it. The deviation is written in percent, as the listed candidates have it. A member need not be one of the listed candidates, so its results are worked out from its own evaluation under the request `input` the result was searched for.
export const frontTable = (front, input) => ({
  axes: front.axes.map(({ key, goal }) => ({ key, goal, label: key === 'deviation' ? 'Deviation (%)' : MISSILE_AXES[key].label })),
  rows: front.members.map((member) => ({ id: member.name, alike: member.alternativeCount, cells: front.axes.map(({ key }) => frontFigure(key, member.set)), results: front.axes.map(({ key }) => (FRONT_RESULT[key] ? resultsOf(input, member.set)[FRONT_RESULT[key]] : null)) })),
})

// ---- Telling the result --------------------------------------------------------------------------------------------

const defaultFormat = (value) => String(Number(Number(value).toPrecision(10)))

export const COLUMNS = Object.freeze([
  Object.freeze({ id: 'rank', label: 'Rank' }),
  Object.freeze({ id: 'id', label: 'Candidate' }),
  Object.freeze({ id: 'engines', label: 'Engines' }),
  Object.freeze({ id: 'engineMsp', label: 'Engine size (MSP)' }),
  Object.freeze({ id: 'thrust', label: 'Thrust modifier' }),
  Object.freeze({ id: 'fuelMsp', label: 'Fuel (MSP)' }),
  Object.freeze({ id: 'warheadMsp', label: 'Warhead (MSP)' }),
  Object.freeze({ id: 'warheads', label: 'Warheads carried' }),
  Object.freeze({ id: 'eccm', label: 'ECCM' }),
  Object.freeze({ id: 'terminal', label: 'Terminal guidance' }),
  Object.freeze({ id: 'laser', label: 'Laser warhead' }),
  Object.freeze({ id: 'size', label: 'Size (MSP)' }),
  Object.freeze({ id: 'speed', label: 'Speed (km/s)' }),
  Object.freeze({ id: 'maxRange', label: 'Range (km)' }),
  Object.freeze({ id: 'damage', label: 'Damage per warhead' }),
  Object.freeze({ id: 'hitChance', label: 'Hit chance (%)' }),
  Object.freeze({ id: 'cost', label: 'Cost (BP)' }),
  Object.freeze({ id: 'costPerWarhead', label: 'BP per warhead' }),
  Object.freeze({ id: 'deviation', label: 'Deviation (%)' }),
  Object.freeze({ id: 'planner', label: 'Planner figure' }),
])

const resultSets = new WeakMap()

const HIT_UNKNOWN = 'the hit chance is not known for this base and scenario (a missile on a second stage or with a decoy warhead has none, and the target speed, jammer and modifier must be numbers)'

// The figures of an entry as provenance results, each as the rules and the scenario give it, with the assumptions of the hypothetical tech levels the request carries: `{ size, speed, maxRange, damage, cost, hitChance, costPerWarhead, planner }`. A cost the rules extrapolate says so (estimated, by design.missileAccountingExtended), the hit chance is the combat model's estimate and the planner figure (warhead × hit chance × (1 − PD / speed)) a planner figure and no game statistic; a figure that is not known is unavailable, with why. Worked out when first read.
export const resultsOf = (input, entry) => {
  if (!resultSets.has(entry)) {
    const evaluation = evaluateEntry(input, entry)
    const { values, figures } = entry
    const { scenario } = input
    const mark = (result) => markHypothetical(result, input.techNotes)
    const size = mark(evaluation.totals.size)
    const cost = mark(evaluation.totals.cost)
    const speed = mark(evaluation.figures.speed)
    const maxRange = mark(evaluation.figures.maxRange)
    const damage = mark(values.laser ? evaluation.figures.laserWarhead : evaluation.figures.warheadStrength)
    const hitChance = mark(figures.hitChance === null ? unavailable({ rule: HIT_RULES.capped, missing: [HIT_UNKNOWN], units: '%' }) : cappedHitChance(rawHitChance({ missileSpeed: figures.speed, targetSpeed: scenario.targetSpeed, atg: values.terminal, modifier: scenario.modifier, jammer: scenario.jammer, eccm: values.eccm, version: input.version })))
    const carried = figures.warheadsCarried
    const costPerWarhead = carried > 0 ? combine({ rule: MISSILE_RULES.accounting, parts: { cost }, compute: (parts) => parts.cost / carried, units: 'BP' }) : unavailable({ rule: MISSILE_RULES.accounting, missing: ['a missile with no warhead has no BP per warhead'], units: 'BP' })
    const planner = plannerFigure({ warhead: damage, hitChance, speed, pd: scenario.pd === null ? '' : scenario.pd }).result

    resultSets.set(entry, Object.freeze({ size, speed, maxRange, damage, cost, hitChance, costPerWarhead, planner }))
  }

  return resultSets.get(entry)
}

// A cell of an entry's row as a figure or null where it is not known; nothing unknown is ever 0.
export const cellOf = (input, entry, column) => {
  const { values, figures } = entry

  switch (column) {
    case 'id': return entry.id
    case 'engines': return values.engines
    case 'engineMsp': return values.engineMsp
    case 'thrust': return values.thrust
    case 'fuelMsp': return values.fuelMsp
    case 'warheadMsp': return values.warheadMsp
    case 'warheads': return figures.warheadsCarried
    case 'eccm': return values.eccm
    case 'terminal': return values.terminal
    case 'laser': return values.laser ? 'yes' : 'no'
    case 'deviation': return figures.deviation ? figures.deviation.greatest * 100 : null
    case 'planner': return valueOrNull(resultsOf(input, entry).planner)
    default: return finite(figures[column])
  }
}

const quote = (value) => (typeof value === 'string' && /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

// What a run explored, as the one line a row of an export and a caption carry: 'complete: ...' for a run that explored its whole domain, else 'incomplete (<why it stopped>): ...' with the counts of what was explored.
export const searchLine = (outcome, format = defaultFormat) => `${outcome.incomplete ? `incomplete (${outcome.termination || outcome.status})` : 'complete'}: ${countText(outcome.counts, format)}`

const limitLines = (input, format) => {
  const { constraints, scenario } = input
  const parts = [`size at most ${format(constraints.maxMsp)} MSP`]

  if (constraints.maxBp !== null) {
    parts.push(`cost at most ${format(constraints.maxBp)} BP`)
  }

  if (constraints.minSpeed !== null) {
    parts.push(`speed at least ${format(constraints.minSpeed)} km/s`)
  }

  if (constraints.minRangeKm !== null) {
    parts.push(`range at least ${format(constraints.minRangeKm)} km`)
  }

  if (constraints.hitChance !== null) {
    parts.push(`hit chance at least ${format(constraints.hitChance)}%`)
  }

  const assumptions = [`target speed ${scenario.targetSpeed === null ? 'not given' : `${format(scenario.targetSpeed)} km/s`}`, `missile jammer ${scenario.jammer === null ? 'not given' : format(scenario.jammer)}`, `tactical modifier ${scenario.modifier === null ? 'not given' : format(scenario.modifier)}`, `point-defence figure ${scenario.pd === null ? 'not given' : `${format(scenario.pd)} km/s`}`]

  return [`Limits: ${parts.join('; ')}.`, `Assumptions: ${assumptions.join('; ')}. The hit chance is the combat model's, capped at ${HIT_CAP}%; the planner figure is warhead × hit chance × (1 − PD / speed), a planner figure and no game statistic.`]
}

// Why a search that ended found no candidate, or an empty text: an unreachable hit chance is infeasible, with the best the domain reaches.
export const describeInfeasible = (result, format = defaultFormat) => {
  if (!result || !result.infeasible) {
    return ''
  }

  const { kind, bestHit } = result.infeasible
  const request = result.reach.requestedHit

  switch (kind) {
    case 'unsupported': return 'No candidate was evaluated: an option of the base (a ground pod, an enhanced radiation warhead or a retargeting level above the validated ones) is outside the missile rules.'
    case 'hit-cap': return `Infeasible: a hit chance of ${format(request)}% can never be reached, as the combat model limits a hit chance to ${HIT_CAP}%.`
    case 'hit-unknown': return 'Infeasible: the hit chance is not known for this base and scenario (a missile on a second stage or with a decoy warhead has none, and the target speed, jammer and modifier must be numbers), so no candidate can meet a requested hit chance.'
    case 'hit-unreachable': return `Infeasible: no candidate reaches the requested hit chance of ${format(request)}%. The best among the candidates that meet the other limits is ${format(bestHit)}%.`
    default: return result.outcomes.undefined > 0 ? `Infeasible: no candidate of the domain meets every limit. ${format(result.outcomes.undefined)} candidates carry no warhead: BP per warhead is undefined for them and they are rejected.` : 'Infeasible: no candidate of the domain meets every limit.'
  }
}

// The status of a result in a sentence: which of its outcomes it is, said so that an incomplete run is never read as an answer: a run that was stopped with nothing found says none was found so far, never that none exists.
export const describeStatus = (outcome, format = defaultFormat) => {
  const result = outcome.result

  if (!result) {
    return outcome.error ? `Failed: ${outcome.error}` : 'No result yet.'
  }

  if (outcome.incomplete) {
    return result.counts.feasible === 0 ? `Incomplete (${outcome.termination || outcome.status}): none found so far. ${searchLine(outcome, format)}` : `Incomplete (${outcome.termination || outcome.status}): the best of the part explored, not of the whole domain. ${searchLine(outcome, format)}`
  }

  return result.counts.feasible === 0 ? `${describeInfeasible(result, format)} ${searchLine(outcome, format)}`.trim() : searchLine(outcome, format)
}

// The listed entries of an outcome as rows: `{ header, columns, rows, incomplete, status }` with the figures as numbers or null (unknown, never 0), and the status of the search that made them (`searchLine`) so a table of a run that was stopped is never read as the whole answer.
export const tableOf = (outcome) => {
  const result = outcome.result
  const input = outcome.descriptor.input
  const rows = result ? result.entries.map((entry, at) => ({ entry, cells: Object.fromEntries(COLUMNS.map((column) => [column.id, column.id === 'rank' ? at + 1 : cellOf(input, entry, column.id)])), results: resultsOf(input, entry) })) : []

  return { header: COLUMNS.map((column) => column.label), columns: COLUMNS, rows, incomplete: Boolean(outcome.incomplete), status: searchLine(outcome) }
}

// The export of an outcome: `{ csv, text, status, rows }`. Both carry the status of the search with the counts, so a run that was stopped or limited is never read as a whole answer, and a figure that is not known is empty in the CSV and 'unknown' in the text. A figure the save does not confirm (an extrapolated cost, the hit chance, the planner figure, anything built on a hypothetical tech level) is named with its status and rule in the CSV (`Basis`, `Assumptions`) and in the text, beside the tech assumptions the request carries.
export const exportOutcome = (outcome, format = defaultFormat) => {
  const input = outcome.descriptor.input
  const goal = GOALS[input.goal]
  const result = outcome.result
  const status = searchLine(outcome, format)
  const table = tableOf(outcome)
  const cell = (value) => (value === null || value === undefined ? '' : typeof value === 'number' ? Number(value.toPrecision(12)) : value)
  const unconfirmed = (row) => COLUMNS.filter((column) => row.results[column.id] && row.results[column.id].status !== STATUS.CONFIRMED).map((column) => ({ column, result: row.results[column.id] }))
  const basisCell = (row) => unconfirmed(row).map(({ column, result: figure }) => `${column.label}: ${figure.status} (${figure.rule.id})`).join('; ')
  const assumptionCell = (row) => [...new Set(unconfirmed(row).flatMap(({ result: figure }) => figure.assumptions))].join('; ')

  const line = (row) => [...COLUMNS.map((column) => cell(row.cells[column.id])), basisCell(row), assumptionCell(row), goal.label, status]

  const empty = [...COLUMNS.map((_column, at) => (at === 1 ? (outcome.incomplete ? 'none found so far' : 'none meets the limits') : '')), '', '', goal.label, status]
  const csv = [[...table.header, 'Basis', 'Assumptions', 'Goal', 'Search'], ...(table.rows.length ? table.rows.map(line) : [empty])].map((row) => row.map(quote).join(',')).join('\n')
  const first = `Missile optimisation, ${goal.label}. ${goal.objective} ${goal.ties}`
  const shown = (row) => unconfirmed(row).filter(({ result: figure }) => figure.status !== STATUS.UNAVAILABLE)
  const marked = (row, column) => (shown(row).some((item) => item.column === column) ? ` (${row.results[column.id].status})` : '')
  const figureText = (row, column) => (row.cells[column.id] === null ? 'unknown' : `${typeof row.cells[column.id] === 'number' ? format(row.cells[column.id]) : row.cells[column.id]}${marked(row, column)}`)
  const body = table.rows.map((row) => `${row.cells.rank}. ${row.entry.id}: ${COLUMNS.filter((column) => !['rank', 'id'].includes(column.id)).map((column) => `${column.label} ${figureText(row, column)}`).join(', ')}`)
  const grouped = new Map()

  table.rows.forEach((row) => shown(row).forEach(({ column, result: figure }) => {
    const key = `${figure.status}|${figure.rule.id}`

    grouped.set(key, grouped.get(key) || { status: figure.status, rule: figure.rule.id, labels: new Set() })
    grouped.get(key).labels.add(column.label)
  }))

  const basis = [...grouped.values()].map((group) => `Basis: ${group.status} by ${group.rule}: ${[...group.labels].join(', ')}.`)
  const figureAssumptions = [...new Set(table.rows.flatMap((row) => shown(row).flatMap(({ result: figure }) => figure.assumptions)))].filter((assumption) => !input.techNotes.includes(assumption))
  const assumed = figureAssumptions.length ? [`Assumptions of the figures: ${figureAssumptions.join('; ')}.`] : []
  const tech = input.techNotes.length ? [`Tech assumptions: ${input.techNotes.join('; ')}.`] : []
  const frontText = result && result.front ? describeMissileFront(result.front, format) : ''
  const text = [first, ...limitLines(input, format), describeStatus(outcome, format), ...(body.length ? body : [outcome.incomplete ? 'None found so far.' : 'None meets the limits.']), ...basis, ...assumed, ...tech, ...(frontText ? [`Efficient front: ${frontText}`] : [])].join('\n')

  return Object.freeze({ csv, text, status, rows: table.rows.length })
}

// The front of an outcome in words for a caption, over the missile axes: whether it is the efficient set of the whole domain or provisional.
export const describeMissileFront = (front, format = defaultFormat) => (front.members.length ? describeFront(front, format, MISSILE_AXES) : describeEmpty(front, format, MISSILE_AXES))
