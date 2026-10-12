// Where a calculated figure stands: the envelope every calculation's result travels in, and the registry of the rules that produce them. A rule is registered once, by the module that holds its helper; a result names its rule by id, so a table, a comparison and an export carry the same status, versions, inputs and assumptions without each page restating them.
//
// The envelope is { value, status, rule: { id, versions, note }, inputs: { present, missing }, units, assumptions }.
// - `status`: 'confirmed' (observed in the save, or reproduced exactly by a rule checked against saved data), 'estimated' (the rule is approximate or not checked against saved data), 'assumed' (the figure rests on a number the player entered or the planner chose) or 'unavailable' (a needed input is missing: the value is null, never 0).
// - `rule`: `id` is `<area>.<name>`, `versions` the game versions the rule is known to hold for ('2.7.x' matches every 2.7 release), `note` a neutral verification note or public source.
// - `inputs`: names of the inputs the calculation read that the save had (`present`) and had not (`missing`).
// Three things stay apart: structural support (`structure` on the rule: the tables and columns it reads), formula verification (`verification` on the rule) and scenario assumptions (`assumptions`, on the rule as its standing ones and on the result for the ones this run made).

export const STATUS = Object.freeze({
  CONFIRMED: 'confirmed',
  ESTIMATED: 'estimated',
  ASSUMED: 'assumed',
  UNAVAILABLE: 'unavailable',
})

export const STATUSES = Object.freeze(Object.values(STATUS))

// How a status reads on screen: a word and an icon whose shape differs from the others, so the four tell apart without colour.
export const STATUS_MARKS = Object.freeze({
  confirmed: Object.freeze({ label: 'Confirmed', icon: 'mdi-check-circle-outline', meaning: 'Observed in the save, or reproduced exactly by a rule checked against saved data.' }),
  estimated: Object.freeze({ label: 'Estimated', icon: 'mdi-approximately-equal', meaning: 'Worked out by a rule that is approximate or not yet checked against saved data.' }),
  assumed: Object.freeze({ label: 'Assumed', icon: 'mdi-tune-variant', meaning: 'Rests on a figure entered or chosen here rather than one the save holds.' }),
  unavailable: Object.freeze({ label: 'Unavailable', icon: 'mdi-minus-circle-outline', meaning: 'A needed input is missing, so no value is given. Unknown is not zero.' }),
})

// The weaker a status, the less a result built on it can be trusted: a figure resting on an assumption is exact given it, an estimate is not exact even then, and an unavailable input leaves nothing to compute.
const WEAKNESS = Object.freeze({ confirmed: 0, assumed: 1, estimated: 2, unavailable: 3 })

const VERIFICATIONS = Object.freeze([STATUS.CONFIRMED, STATUS.ESTIMATED, STATUS.ASSUMED])

const registry = new Map()

const listOf = (value) => Object.freeze(Array.isArray(value) ? value.map(String) : [])

const requireText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`A rule needs ${name}`)
  }
}

// Registers a rule: { id, versions, note, units, verification, structure, assumptions }. `verification` is how far the formula is checked ('confirmed', 'estimated', or 'assumed' for a planner's own policy that is no game rule); `structure` the tables and columns it reads; `assumptions` the standing ones it always makes. Registering an id again replaces it, so a hot reload keeps one entry.
export const registerRule = ({ id, versions, note, units = '', verification, structure = [], assumptions = [] }) => {
  requireText(id, 'an id')
  requireText(note, 'a verification note')

  if (!/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/.test(id)) {
    throw new Error(`Rule id ${id} is not <area>.<name>`)
  }

  if (!Array.isArray(versions) || !versions.length) {
    throw new Error(`Rule ${id} needs the versions it supports`)
  }

  if (!VERIFICATIONS.includes(verification)) {
    throw new Error(`Rule ${id} needs a verification of ${VERIFICATIONS.join(', ')}`)
  }

  const rule = Object.freeze({ id, versions: listOf(versions), note, units, verification, structure: listOf(structure), assumptions: listOf(assumptions) })

  registry.set(id, rule)

  return rule
}

export const getRule = (id) => registry.get(id) || null

export const listRules = () => [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))

const requireRule = (id) => {
  const rule = registry.get(id)

  if (!rule) {
    throw new Error(`Rule ${id} is not registered`)
  }

  return rule
}

// Whether a rule holds for a game version ('2.7.1'): true or false, or null when the version is not known. A pattern's segments match the version's one for one, 'x' matching any, and a version longer than the pattern still matches it.
export const ruleSupports = (id, gameVersion) => {
  const rule = requireRule(id)

  if (typeof gameVersion !== 'string' || !gameVersion.trim()) {
    return null
  }

  const parts = gameVersion.trim().split('.')

  return rule.versions.some((pattern) => pattern.split('.').every((segment, index) => segment === 'x' || segment === parts[index]))
}

const inputsOf = ({ present = [], missing = [] } = {}) => Object.freeze({ present: listOf(present), missing: listOf(missing) })

// A result: { value, status, rule (an id), inputs, units, assumptions }. A result that is not unavailable needs a value, and an unavailable one has none. A confirmed result cannot have missing inputs.
export const envelope = ({ value = null, status, rule, inputs, units, assumptions = [] }) => {
  const registered = requireRule(rule)

  if (!STATUSES.includes(status)) {
    throw new Error(`Unknown status ${status} for rule ${rule}`)
  }

  const unavailable = status === STATUS.UNAVAILABLE

  if (!unavailable && (value === null || value === undefined || Number.isNaN(value))) {
    throw new Error(`A ${status} result of ${rule} needs a value; use unavailable() when an input is missing`)
  }

  const kept = inputsOf(inputs)

  if (status === STATUS.CONFIRMED && kept.missing.length) {
    throw new Error(`A confirmed result of ${rule} cannot have missing inputs (${kept.missing.join(', ')})`)
  }

  return Object.freeze({
    value: unavailable ? null : value,
    status,
    rule: Object.freeze({ id: registered.id, versions: registered.versions, note: registered.note }),
    inputs: kept,
    units: units === undefined ? registered.units : units,
    assumptions: Object.freeze([...new Set([...registered.assumptions, ...listOf(assumptions)])]),
  })
}

// A result with no value, naming what is missing.
export const unavailable = ({ rule, missing = [], present = [], units, assumptions = [] }) => envelope({ status: STATUS.UNAVAILABLE, rule, inputs: { present, missing }, units, assumptions })

// A result at the rule's own verification: confirmed or estimated as registered, and assumed for a planner policy.
export const ofRule = ({ rule, value, inputs, units, assumptions = [] }) => envelope({ value, status: requireRule(rule).verification, rule, inputs, units, assumptions })

export const isAvailable = (result) => Boolean(result) && result.status !== STATUS.UNAVAILABLE

// The value, or null when the result is unavailable. Never 0 for a missing one.
export const valueOrNull = (result) => (isAvailable(result) ? result.value : null)

export const weakestStatus = (statuses) => statuses.reduce((weakest, status) => (WEAKNESS[status] > WEAKNESS[weakest] ? status : weakest), STATUS.CONFIRMED)

const unique = (lists) => [...new Set(lists.flat())]

// Builds a result of `rule` from named parts (results). Any unavailable part makes the result unavailable; otherwise `compute` gets the parts' values by name and the result takes the weakest of the parts' statuses and the rule's own verification, with every part's assumptions. Each part's own inputs carry over: the inputs an unavailable part lacks (or its name when it names none) are the result's missing ones, and the inputs an available part read, and any it lacked, stay with the result, so a derived figure keeps its inputs' provenance. `inputs` adds the ones the rule reads beyond its parts.
export const combine = ({ rule, parts, compute, units, inputs: own = {}, assumptions = [] }) => {
  const registered = requireRule(rule)
  const names = Object.keys(parts)
  const unavailableNames = names.filter((name) => !isAvailable(parts[name]))
  const availableNames = names.filter((name) => isAvailable(parts[name]))
  const inputsOfPart = (name, key) => (parts[name] && parts[name].inputs ? parts[name].inputs[key] : [])
  const carried = unique([...names.map((name) => (parts[name] ? parts[name].assumptions : [])), assumptions])
  const present = unique([...availableNames.map((name) => (inputsOfPart(name, 'present').length ? inputsOfPart(name, 'present') : [name])), own.present || []])
  const missing = unique([...unavailableNames.map((name) => (inputsOfPart(name, 'missing').length ? inputsOfPart(name, 'missing') : [name])), ...availableNames.map((name) => inputsOfPart(name, 'missing')), own.missing || []])

  if (unavailableNames.length) {
    return unavailable({ rule, missing, present, units, assumptions: carried })
  }

  const status = weakestStatus([registered.verification, ...names.map((name) => parts[name].status)])
  const value = compute(Object.fromEntries(names.map((name) => [name, parts[name].value])))

  return envelope({ value, status, rule, inputs: { present, missing }, units, assumptions: carried })
}

// The sum of results of one rule; unavailable when any is, never counting it as 0.
export const sumResults = ({ rule, results, units, assumptions = [] }) => combine({ rule, parts: Object.fromEntries(results.map((result, index) => [`term ${index + 1}`, result])), compute: (values) => Object.values(values).reduce((total, value) => total + value, 0), units, assumptions })

// Whether a result meets a test: true or false, or null when the result is unavailable. A condition passes only on `true`, so an unknown result cannot satisfy it.
export const satisfies = (result, test) => (isAvailable(result) ? Boolean(test(result.value)) : null)

export const atLeast = (result, minimum) => satisfies(result, (value) => value >= minimum)

export const atMost = (result, maximum) => satisfies(result, (value) => value <= maximum)

export const passes = (verdict) => verdict === true

const joined = (list, separator = '; ') => list.join(separator)

// A result in words for a tooltip or a screen reader: its status, rule and versions, then the assumptions and the missing inputs.
export const describeResult = (result) => {
  if (!result) {
    return ''
  }

  const mark = STATUS_MARKS[result.status]
  const parts = [`${mark.label}: ${result.rule.id}, game ${joined(result.rule.versions, ', ')}`]

  if (result.assumptions.length) {
    parts.push(`Assumes ${joined(result.assumptions)}`)
  }

  if (result.inputs.missing.length) {
    parts.push(`Missing ${joined(result.inputs.missing, ', ')}`)
  }

  return joined(parts, '. ')
}

// The fields an export carries beside a figure, so a copy keeps what a screen showed: status, rule id, versions, assumptions and missing inputs, as plain text. An unavailable result exports an empty value, never 0.
export const exportFields = (result) => ({
  value: isAvailable(result) ? result.value : '',
  status: result ? result.status : '',
  rule: result ? result.rule.id : '',
  versions: result ? joined(result.rule.versions, ', ') : '',
  assumptions: result ? joined(result.assumptions) : '',
  missing: result ? joined(result.inputs.missing, ', ') : '',
})

// A registered rule in words, for a mark that stands for the rule rather than one result: its verification, id, versions and note, then its standing assumptions.
export const describeRule = (id) => {
  const rule = requireRule(id)
  const parts = [`${STATUS_MARKS[rule.verification].label}: ${rule.id}, game ${joined(rule.versions, ', ')}. ${rule.note}`]

  if (rule.assumptions.length) {
    parts.push(`Assumes ${joined(rule.assumptions)}`)
  }

  return joined(parts.map((part) => part.replace(/\.$/, '')), '. ')
}
