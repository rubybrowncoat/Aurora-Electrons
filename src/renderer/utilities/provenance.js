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

// A saved table or column in words for a note: `FCT_ShipClass` and `MaxSpeed` read as the max speed of ship class. Code names never reach the screen.
const spaced = (name) => name.replace(/^(FCT|DIM|VIR)_/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase()

export const inputWords = (table, column) => (column ? `the ${spaced(column)} of ${spaced(table)}` : `the ${spaced(table)} data`)

// A capability field ('Table.Column', 'Table.*' or 'Table (table)', see utilities/capabilities.js) in words, for a missing input that a note shows.
export const fieldWords = (field) => {
  const [table, column] = field.replace(/ \(table\)$/, '.*').split('.')

  return inputWords(table, column === '*' ? '' : column)
}

// Capability fields in words, as one list for a notice.
export const fieldList = (fields) => fields.map(fieldWords).join(', ')

const named = (name) => (name.includes('.') || /^(?:FCT|DIM|VIR)_/.test(name) ? fieldWords(name) : `the ${spaced(name)}`)

const namedList = (names) => names.split(', ').map(named).join(', ')

// The messages SQLite gives, with what each names: a read or a write that the save cannot take.
const DATABASE_FORMS = [
  [/^no such (?:column|table): (\S+)(?: - should this be a string literal in single-quotes\?)?$/, (_found, name) => `the save lacks ${named(name)}`],
  [/^ambiguous column name: (\S+)$/, (_found, name) => `the read names ${named(name)} ambiguously`],
  [/^table (\S+) has no column named (\S+)$/, (_found, table, column) => `the save lacks ${inputWords(table, column)}`],
  [/^NOT NULL constraint failed: ([^\s,]+(?:, [^\s,]+)*)$/, (_found, names) => `the save requires ${namedList(names)}`],
  [/^UNIQUE constraint failed: ([^\s,]+(?:, [^\s,]+)*)$/, (_found, names) => `the save already holds a row with ${namedList(names)}`],
  [/^foreign key mismatch - "([^"]*)" referencing "([^"]*)"$/, (_found, child, parent) => `the link of ${named(child)} to ${named(parent)} does not match`],
  [/^no such function: (\S+)$/, () => 'the read uses a function the save lacks'],
  [/^table (\S+) already exists$/, (_found, name) => `the save already holds ${named(name)}`],
  [/^cannot (?:UPDATE|INSERT into) generated column "([^"]*)"$/, (_found, name) => `the save does not allow writing ${named(name)}`],
  [/^cannot modify (\S+) because it is a view$/, (_found, name) => `the save does not allow writing ${named(name)}`],
  [/^cannot store \w+ value in \w+ column (\S+)$/, (_found, name) => `the save does not take that value for ${named(name)}`],
  [/^CHECK constraint failed: .*$/, () => 'a value breaks a rule of the save'],
  [/^near "[^"]*": syntax error$/, () => 'the read is malformed'],
  [/^FOREIGN KEY constraint failed$/, () => 'a link to another row of the save fails'],
  [/^datatype mismatch$/, () => 'a value is of the wrong type for the save'],
  [/^database is locked$/, () => 'the save is locked by another program'],
  [/^database table is locked$/, () => 'a table of the save is locked by a read that has not ended'],
  [/^attempt to write a readonly database$/, () => 'the save is read-only'],
  [/^unable to open database file$/, () => 'the save file cannot be opened'],
  [/^database disk image is malformed$/, () => 'the save file is damaged'],
  [/^database or disk is full$/, () => 'the save or its disk is full'],
  [/^disk I\/O error$/, () => 'the save file could not be read or written because of a disk error'],
  [/^out of memory$/, () => 'the app ran out of memory for the read'],
  [/^interrupted$/, () => 'the read was stopped'],
  [/^file is not a database$/, () => 'the file is not a database'],
]

// What a database error of a form not listed above says: a fixed sentence with nothing of the message in it, since such a message can name a column or a table in any way. The message goes to the console, once.
const UNKNOWN_DATABASE_ERROR = 'the save gave an error the app does not recognise'
const logged = new Set()

// The codes an error carries, its own and those of the error it wraps (Sequelize keeps the cause as `parent` and `original`).
const codesOf = (error) => (error && typeof error === 'object' ? [error.code, error.parent && error.parent.code, error.original && error.original.code].filter((code) => (typeof code === 'string' && code) || typeof code === 'number').map(String) : [])

// Whether an error comes from the database: SQLite's own code on it or on the error it wraps, a Sequelize error, or the text of one kept before (`SQLITE_ERROR: …`).
const fromDatabase = (error, text) => /^SQLITE_[A-Z_]+: /.test(text) || codesOf(error).some((code) => /^SQLITE/.test(code)) || Boolean(error && typeof error === 'object' && /^Sequelize/.test(error.name || ''))

// What a failed read or write says on screen: the first line of the error. An error whose cause has a code that is not SQLite's (a file that cannot be opened, wrapped or not) is shown as it is. A database message of a listed form has its SQLite code dropped and the table or column it names put in words (`no such column: FCT_Ship.CurrentCrew` reads as the save lacking the current crew of ship). A database error of any other form is a fixed sentence, and its message goes to the console. Any other text stays as it is.
export const failureWords = (error) => {
  const raw = String(error && error.message !== undefined ? error.message : error).split('\n')[0]

  if (codesOf(error).some((code) => !/^SQLITE/.test(code))) {
    return raw
  }

  // The web mode puts where the call went before the message (scripts/web/shims/web-error.js); a reason kept from there has it too.
  const stated = raw.replace(/^\[web\] \S+: /, '')
  const text = stated.replace(/^SQLITE_[A-Z_]+: /, '')
  const form = DATABASE_FORMS.find(([pattern]) => pattern.test(text))

  if (form) {
    return text.replace(form[0], form[1])
  }

  if (fromDatabase(error, stated)) {
    if (!logged.has(raw)) {
      logged.add(raw)
      console.error('A database error the app does not word', error)
    }

    return UNKNOWN_DATABASE_ERROR
  }

  return raw
}

// The assumption of a figure whose rule cannot be matched to the save: a save normally states the game rules it was played under, but a damaged one can lack the columns that tell.
export const UNVERIFIED_SAVE = 'The save does not state which game rules it was played under, so the rule is not checked against the save'

const joined = (list, separator = '; ') => list.join(separator)

// A result in words for a tooltip or a screen reader: its status and the rule's note (what the figure is read from, or why it is estimated), then the assumptions and the missing inputs. Neither the rule's id nor its game versions are shown: the id is a code name, and every save is of one line.
export const describeResult = (result) => {
  if (!result) {
    return ''
  }

  const parts = [`${STATUS_MARKS[result.status].label}: ${result.rule.note}`]

  if (result.assumptions.length) {
    parts.push(`Assumes ${joined(result.assumptions)}`)
  }

  if (result.inputs.missing.length) {
    parts.push(`Missing ${joined(result.inputs.missing, ', ')}`)
  }

  return joined(parts.map((part) => part.replace(/\.$/, '')), '. ')
}

// The fields an export carries beside a figure, so a copy keeps what a screen showed: status, rule id, assumptions and missing inputs, as plain text. An unavailable result exports an empty value, never 0.
export const exportFields = (result) => ({
  value: isAvailable(result) ? result.value : '',
  status: result ? result.status : '',
  rule: result ? result.rule.id : '',
  assumptions: result ? joined(result.assumptions) : '',
  missing: result ? joined(result.inputs.missing, ', ') : '',
})

// A registered rule in words, for a mark that stands for the rule rather than one result: its verification and note, then its standing assumptions.
export const describeRule = (id) => {
  const rule = requireRule(id)
  const parts = [`${STATUS_MARKS[rule.verification].label}: ${rule.note}`]

  if (rule.assumptions.length) {
    parts.push(`Assumes ${joined(rule.assumptions)}`)
  }

  return joined(parts.map((part) => part.replace(/\.$/, '')), '. ')
}
