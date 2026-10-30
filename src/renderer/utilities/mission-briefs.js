// Mission briefs: what a ship is for, kept apart from the alternatives that are judged against it. A brief is the player's own list of requirements (size, speed, range, endurance, space beside the engines and tanks, cargo, hangar, deployment, classification) and the order in which the alternatives that meet them are preferred. It is judged against every alternative a planner has, never against a hidden score: each requirement of each alternative is pass, fail or unknown, with the figure found, the figure required, the unit and the reason, and an alternative is ranked only among its own verdict group, by the preferred axes in the order given.
//
// Hard requirements and preferences stay apart. A requirement decides the verdict (`meets` when all pass, `fails` when one fails, `open` when none fails and one is unknown, `none` when the brief sets no requirement); a preference only orders alternatives of the same verdict and never changes it. A figure an alternative does not have is unknown with its reason: it never passes and never counts as 0, and a preference on it sorts last.
//
// Units. Every figure is held in one canonical unit and the unit of a requirement is the unit of its figure. The hull is in HS (50 tons to the HS, TONS_PER_HS); a size typed in tons is converted once, on entry. A cargo capacity is in tons: each cargo hold stores 50 capacity points for every HS of its size and a class's capacity is the sum of its holds' (checked on every hold and class of the saves read by scripts/check-mission-briefs.js), so a point is a ton, and a capacity is never read as HS. A hangar capacity is in HS of the ships it holds: it is not a mass in tons and not a size of the deck (a deck of 21 HS holds 20), and the ships docked in a mother ship never total more than its capacity in the saves read. A range is in km (shown in billions of km) and an endurance in days at the cruise power the brief names.
//
// What an alternative can answer. A propulsion set is engines and fuel tanks over a hull: it answers size, speed, range, endurance, the space beside the propulsion and cost, and is unknown for cargo, hangar and deployment (the rest of the hull is not designed), and for classification unless an engine is military (a military engine makes the class military). A saved class answers everything its row in the save stores. A later whole-class planner gives richer figures through the same `alternative` shape: `{ id, name, figures }`, where a figure is a provenance result (utilities/provenance.js) or a function of the evaluation context (`{ cruiseShare }`) that returns one.
//
// Presets (survey, fighter) are starting points: each fills requirements the player can read and edit, and never writes over anything unseen. `previewPreset` lists what applying it would add, replace or leave, `applyPreview` changes only the fields the player accepted and returns a new draft, and a saved brief changes only when the player saves. A preset names the fields it does not model; they are kept as notes, evaluated as unknown and never counted in a verdict. The preset values are guidance, not game rules.
//
// Persistence. A brief is a typed record of the scenario repository (utilities/scenario-records.js) of kind `planner.missionBrief`, associated with the campaign and the race and not with a branch: a brief states what a ship is for, which no save, branch or research changes, so it is visible on every branch of the campaign. A save made at an earlier game time than the brief's is shown flagged and is not applied until the player moves it to this save. See docs/plans/backlog/evidence/AE-132-01.md.

import { TONS_PER_HS, enduranceHours } from './design-rules'
import { STATUS, combine, envelope, isAvailable, ofRule, registerRule, unavailable, weakestStatus } from './provenance'

export const BRIEF_KIND = 'planner.missionBrief'
export const BRIEF_SCHEMA = 1
export const NAME_LENGTH = 80
export const MAX_AXES = 3
export const KM_PER_BN = 1e9
export const CARGO_POINTS_PER_HS = 50

const VERSIONS = ['2.7.x']

const EMPTY_LIST = Object.freeze([])

// ---- Units ---------------------------------------------------------------------------------------------------------

// The HS of a hull of `tons` tons: 50 tons to the HS.
export const hsOfTons = (tons) => tons / TONS_PER_HS

export const tonsOfHs = (sizeHS) => sizeHS * TONS_PER_HS

// The cargo capacity a hold of `sizeHS` HS stores, in tons (50 for each HS of the hold).
export const cargoTonsOfHoldHS = (sizeHS) => sizeHS * CARGO_POINTS_PER_HS

// A class's stored cargo capacity as tons: a capacity point is a ton.
export const cargoTonsOfCapacity = (capacity) => capacity

// A class's stored hangar capacity as HS of the ships it holds: the stored figure is HS already.
export const hangarHSOfCapacity = (capacity) => capacity

// What a hangar capacity of `capacity` HS comes to in tons of hulls.
export const hangarTonsOfCapacity = (capacity) => capacity * TONS_PER_HS

// ---- Rules ---------------------------------------------------------------------------------------------------------

const rule = (id, verification, note, units, assumptions = []) => registerRule({ id, versions: VERSIONS, note, units, verification, assumptions })

rule('brief.setSize', STATUS.ASSUMED, 'The finished size of a designed set: the hull entered or taken from a saved class, with the engines and tanks the planner sized', 'HS', ['The hull is the size entered, or the size of the saved class it was taken from'])
rule('brief.setPayloadSpace', STATUS.ASSUMED, 'The finished size of a designed set less its engines and tanks: what is left of the hull for everything else', 'HS', ['The hull is the size entered, or the size of the saved class it was taken from'])
rule('brief.classSize', STATUS.CONFIRMED, 'A saved class\'s size, as the save stores it', 'HS')
rule('brief.classPayloadSpace', STATUS.CONFIRMED, 'A saved class\'s stored size less the stored sizes of its engines and fuel tanks', 'HS')
rule('brief.rangeKm', STATUS.CONFIRMED, 'The range in billions of km times 1,000,000,000', 'km')
rule('brief.cruiseEndurance', STATUS.ASSUMED, 'The fuel held over the burn at the cruise power the brief names', 'days', ['The cruise power is the one the brief names'])
rule('brief.classCargo', STATUS.CONFIRMED, 'A saved class\'s cargo capacity as the save stores it, in tons: each hold stores 50 points to the HS of its size and a point is a ton', 'tons')
rule('brief.classHangar', STATUS.CONFIRMED, 'A saved class\'s hangar capacity as the save stores it, in HS of the ships it holds', 'HS')
rule('brief.classDeployment', STATUS.CONFIRMED, 'A saved class\'s planned deployment, as the save stores it', 'months')
rule('brief.classClassification', STATUS.CONFIRMED, 'A saved class is commercial or military as the save stores it', '')
rule('brief.engineClassification', STATUS.CONFIRMED, 'A class with a military engine is military; a class with commercial engines only is not decided by them (every component, 1 HS of engineering and 3 months of deployment decide it)', '')
rule('brief.notModelled', STATUS.ASSUMED, 'A figure this alternative does not give: it is unknown, never 0', '')

// ---- What a brief asks ---------------------------------------------------------------------------------------------

// The hard requirements. `key` names the field of a brief's `requirements`, `figure` the figure of an alternative it is judged on, `comparison` is 'atLeast', 'atMost' or 'is', `unit` the canonical unit of both, and `input` how the unit is typed and shown ({ unit, scale: canonical per typed unit }).
export const REQUIREMENTS = Object.freeze([
  Object.freeze({ key: 'maxSizeHS', label: 'Ship size', figure: 'sizeHS', comparison: 'atMost', unit: 'HS', input: Object.freeze({ unit: 'HS', scale: 1, digits: 2 }), hint: 'The finished ship may be this big, hull and propulsion included.' }),
  Object.freeze({ key: 'minSpeedKmS', label: 'Speed', figure: 'speedKmS', comparison: 'atLeast', unit: 'km/s', input: Object.freeze({ unit: 'km/s', scale: 1, digits: 0 }), hint: 'The top speed at full power.' }),
  Object.freeze({ key: 'minRangeKm', label: 'Range', figure: 'rangeKm', comparison: 'atLeast', unit: 'km', input: Object.freeze({ unit: 'bn km', scale: KM_PER_BN, digits: 2 }), hint: 'The distance the fuel carries the ship, the same at any speed.' }),
  Object.freeze({ key: 'minEnduranceDays', label: 'Endurance', figure: 'enduranceDays', comparison: 'atLeast', unit: 'days', input: Object.freeze({ unit: 'days', scale: 1, digits: 1 }), needs: 'cruiseShare', hint: 'The days the fuel lasts at the cruise power below.' }),
  Object.freeze({ key: 'minPayloadHS', label: 'Space beside the engines and tanks', figure: 'payloadHS', comparison: 'atLeast', unit: 'HS', input: Object.freeze({ unit: 'HS', scale: 1, digits: 2 }), hint: 'The hull left for everything but the engines and fuel tanks.' }),
  Object.freeze({ key: 'minCargoTons', label: 'Cargo capacity', figure: 'cargoTons', comparison: 'atLeast', unit: 'tons', input: Object.freeze({ unit: 'tons', scale: 1, digits: 0 }), hint: 'The tons the cargo holds carry. A hold stores 50 tons for each HS of its size.' }),
  Object.freeze({ key: 'minHangarHS', label: 'Hangar space', figure: 'hangarHS', comparison: 'atLeast', unit: 'HS', input: Object.freeze({ unit: 'HS', scale: 1, digits: 2 }), hint: 'The HS of ships the hangars hold. A deck holds a little less than its own size.' }),
  Object.freeze({ key: 'minDeploymentMonths', label: 'Planned deployment', figure: 'deploymentMonths', comparison: 'atLeast', unit: 'months', input: Object.freeze({ unit: 'months', scale: 1, digits: 1 }), hint: 'The months of deployment the class is planned for.' }),
  Object.freeze({ key: 'classification', label: 'Classification', figure: 'classification', comparison: 'is', unit: '', values: Object.freeze(['military', 'commercial']), hint: 'Whether the class is military or commercial.' }),
])

export const REQUIREMENT_KEYS = Object.freeze(REQUIREMENTS.map((definition) => definition.key))

export const requirementOf = (key) => REQUIREMENTS.find((definition) => definition.key === key) || null

// The words the brief panel draws for the state of the draft: the chip beside its title while the draft holds changes that are not saved, and the question asked before such changes are dropped to open a blank brief or another one.
export const BRIEF_WORDS = Object.freeze({ unsaved: 'Unsaved changes', discardBlank: 'The brief has unsaved changes. Discard them to open a blank brief?', discardOther: 'The brief has unsaved changes. Discard them to open the other brief?' })

// The figures a preference can order by, with the direction a player most likely wants first.
export const AXES = Object.freeze([
  Object.freeze({ figure: 'costBP', label: 'BP of the propulsion', direction: 'min', unit: 'BP' }),
  Object.freeze({ figure: 'sizeHS', label: 'Ship size', direction: 'min', unit: 'HS' }),
  Object.freeze({ figure: 'speedKmS', label: 'Speed', direction: 'max', unit: 'km/s' }),
  Object.freeze({ figure: 'rangeKm', label: 'Range', direction: 'max', unit: 'km' }),
  Object.freeze({ figure: 'enduranceDays', label: 'Endurance', direction: 'max', unit: 'days' }),
  Object.freeze({ figure: 'payloadHS', label: 'Space beside the engines and tanks', direction: 'max', unit: 'HS' }),
  Object.freeze({ figure: 'cargoTons', label: 'Cargo capacity', direction: 'max', unit: 'tons' }),
  Object.freeze({ figure: 'hangarHS', label: 'Hangar space', direction: 'max', unit: 'HS' }),
])

export const axisOf = (figure) => AXES.find((axis) => axis.figure === figure) || null

export const DIRECTIONS = Object.freeze(['min', 'max'])

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const isPositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const equalValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- Briefs --------------------------------------------------------------------------------------------------------

// A brief with nothing required: every requirement null, no cruise power, no preference.
export const emptyBrief = (name = '') => ({ name, preset: null, requirements: Object.fromEntries(REQUIREMENT_KEYS.map((key) => [key, null])), cruiseShare: null, axes: [], unmodelled: [] })

const copyOf = (value) => JSON.parse(JSON.stringify(value))

// A brief with every field present: what a draft or a stored payload lacks is not required. Values are kept as they are (see `problemsOf` for what is valid).
export const normaliseBrief = (input) => {
  const source = isObject(input) ? input : {}
  const requirements = isObject(source.requirements) ? source.requirements : {}

  return {
    name: typeof source.name === 'string' ? source.name : '',
    preset: typeof source.preset === 'string' ? source.preset : null,
    requirements: Object.fromEntries(REQUIREMENT_KEYS.map((key) => [key, requirements[key] === undefined ? null : requirements[key]])),
    cruiseShare: source.cruiseShare === undefined ? null : source.cruiseShare,
    axes: Array.isArray(source.axes) ? source.axes.map((axis) => ({ ...axis })) : [],
    unmodelled: Array.isArray(source.unmodelled) ? source.unmodelled.map((note) => ({ ...note })) : [],
  }
}

const PAYLOAD_KEYS = ['name', 'preset', 'requirements', 'cruiseShare', 'axes', 'unmodelled']

// What is wrong with a brief to be kept: a list of problems, empty when it is valid. A requirement is null (not required) or a positive number in its canonical unit, the cruise power a share above 0 up to 1, and a preference a figure of AXES in one of two directions, each figure once.
export const problemsOf = (payload) => {
  if (!isObject(payload)) {
    return ['the brief is an object']
  }

  const problems = Object.keys(payload).filter((key) => !PAYLOAD_KEYS.includes(key)).map((key) => `${key} is not a field of a brief`)

  if (!isText(payload.name) || payload.name.length > NAME_LENGTH) {
    problems.push(`the name is 1 to ${NAME_LENGTH} characters`)
  }

  if (!(payload.preset === null || typeof payload.preset === 'string')) {
    problems.push('the preset is a name or null')
  }

  if (!isObject(payload.requirements)) {
    problems.push('the requirements are an object')
  } else {
    Object.keys(payload.requirements).filter((key) => !REQUIREMENT_KEYS.includes(key)).forEach((key) => problems.push(`${key} is not a requirement`))
    REQUIREMENTS.forEach((definition) => {
      const value = payload.requirements[definition.key]

      if (value === undefined) {
        problems.push(`the requirement ${definition.key} is given as a number or null`)
      } else if (value !== null && (definition.values ? !definition.values.includes(value) : !isPositive(value))) {
        problems.push(definition.values ? `${definition.key} is one of ${definition.values.join(', ')} or null` : `${definition.key} is a number above 0 in ${definition.unit} or null`)
      }
    })
  }

  if (!(payload.cruiseShare === null || (isPositive(payload.cruiseShare) && payload.cruiseShare <= 1))) {
    problems.push('the cruise power is a share above 0 up to 1, or null')
  }

  if (!Array.isArray(payload.axes) || payload.axes.length > MAX_AXES) {
    problems.push(`the preferences are a list of at most ${MAX_AXES}`)
  } else {
    payload.axes.forEach((axis, index) => {
      if (!isObject(axis) || !axisOf(axis.figure) || !DIRECTIONS.includes(axis.direction) || Object.keys(axis).length !== 2) {
        problems.push(`preference ${index + 1} is { figure, direction } of a listed figure and 'min' or 'max'`)
      }
    })

    if (new Set(payload.axes.map((axis) => axis && axis.figure)).size !== payload.axes.length) {
      problems.push('a figure is a preference once')
    }
  }

  if (!Array.isArray(payload.unmodelled) || payload.unmodelled.some((note) => !isObject(note) || !isText(note.key) || !isText(note.label) || !isText(note.note) || Object.keys(note).length !== 3)) {
    problems.push('the notes are a list of { key, label, note }')
  }

  return problems
}

// Whether any requirement is set.
export const requiredKeys = (brief) => REQUIREMENTS.filter((definition) => normaliseBrief(brief).requirements[definition.key] !== null).map((definition) => definition.key)

const canonical = (input) => {
  const brief = normaliseBrief(input)

  return { ...brief, axes: brief.axes.map((axis) => ({ figure: axis.figure, direction: axis.direction })), unmodelled: brief.unmodelled.map((note) => ({ key: note.key, label: note.label, note: note.note })) }
}

// Whether two briefs say the same, whatever the order of their fields.
export const sameBrief = (a, b) => equalValue(canonical(a), canonical(b))

// ---- Fields as typed -----------------------------------------------------------------------------------------------

const clean = (number) => Number(number.toPrecision(12))

// A requirement or the cruise power as the player types it: the text of a stored value in the unit shown, `''` for none.
export const typedText = (key, value, { sizeUnit = 'hs' } = {}) => {
  if (value === null || value === undefined) {
    return ''
  }

  if (key === 'cruiseShare') {
    return String(clean(value * 100))
  }

  const definition = requirementOf(key)

  if (!definition || definition.values) {
    return String(value)
  }

  return String(clean(value / typedScale(definition, sizeUnit)))
}

// How many of the canonical unit one typed unit is: tons of a size are 1/50 HS, a billion km 1e9 km.
const typedScale = (definition, sizeUnit) => (definition.key === 'maxSizeHS' && sizeUnit === 'tons' ? 1 / TONS_PER_HS : definition.input.scale)

// The unit a requirement is typed and shown in.
export const typedUnit = (definition, { sizeUnit = 'hs' } = {}) => (definition.key === 'maxSizeHS' && sizeUnit === 'tons' ? 'tons' : definition.input.unit)

// The words a field of a brief shows in place of its hint when its text is refused.
export const FIELD_ERRORS = Object.freeze({ notAFigure: 'Enter a number above 0, or leave it empty.', notAPercent: 'Enter a percent from 1 to 100.', notAField: 'Not a field of a brief.' })

// What a typed text is as a field of a brief: `{ ok, value }`, or `{ ok: false, error }` for text that is not a positive number (an empty text clears the field, and the cruise power is typed in percent from 1 to 100).
export const parseField = (key, text, { sizeUnit = 'hs' } = {}) => {
  const source = String(text === null || text === undefined ? '' : text).trim()

  if (source === '') {
    return { ok: true, value: null }
  }

  const number = Number(source)

  if (key === 'cruiseShare') {
    return Number.isFinite(number) && number >= 1 && number <= 100 ? { ok: true, value: number / 100 } : { ok: false, error: FIELD_ERRORS.notAPercent }
  }

  const definition = requirementOf(key)

  if (!definition || definition.values) {
    return { ok: false, error: FIELD_ERRORS.notAField }
  }

  return Number.isFinite(number) && number > 0 ? { ok: true, value: number * typedScale(definition, sizeUnit) } : { ok: false, error: FIELD_ERRORS.notAFigure }
}

// A draft with one field changed to `value` (a requirement key, 'cruiseShare' or 'name'), as a new object.
export const withField = (draft, key, value) => {
  const brief = copyOf(normaliseBrief(draft))

  if (key === 'name') {
    brief.name = String(value)
  } else if (key === 'cruiseShare') {
    brief.cruiseShare = value
  } else if (REQUIREMENT_KEYS.includes(key)) {
    brief.requirements[key] = value
  } else {
    throw new Error(`${key} is not a field of a brief`)
  }

  return brief
}

// A draft with the preferences `axes` (each { figure, direction }), as a new object.
export const withAxes = (draft, axes) => ({ ...copyOf(normaliseBrief(draft)), axes: axes.map((axis) => ({ figure: axis.figure, direction: axis.direction })) })

// ---- Presets -------------------------------------------------------------------------------------------------------

// The presets: guidance, not game rules. `requirements` and `cruiseShare` are the values the preset offers, `axes` its preferences, `unmodelled` the things the preset names that this planner does not model. The fighter size is the one number the saves check: no fighter class of the saves read is as big as 10 HS (500 tons).
export const PRESETS = Object.freeze({
  survey: Object.freeze({
    key: 'survey',
    label: 'Survey ship',
    summary: 'A slow hull that stays out for months: a long range and a long endurance at half power, a deployment of two years, and the cheapest propulsion among the ships that get there.',
    basis: 'Guidance, not a game rule. The sizes, speeds and deployments of the survey classes in the saves read vary widely, so every number is a starting point to edit.',
    name: 'Survey ship',
    requirements: Object.freeze({ maxSizeHS: 200, minSpeedKmS: 3000, minRangeKm: 20 * KM_PER_BN, minEnduranceDays: 90, minDeploymentMonths: 24 }),
    cruiseShare: 0.5,
    axes: Object.freeze([Object.freeze({ figure: 'rangeKm', direction: 'max' }), Object.freeze({ figure: 'costBP', direction: 'min' })]),
    unmodelled: Object.freeze([
      Object.freeze({ key: 'surveySensors', label: 'Survey sensors', note: 'The geological and gravitational survey sensors to carry are not part of a propulsion set or read from a saved class here, so they are not evaluated.' }),
      Object.freeze({ key: 'jumpTransit', label: 'Jump transit', note: 'Whether the ship jumps by itself or under tow is not part of a propulsion set, so it is not evaluated.' }),
    ]),
  }),
  fighter: Object.freeze({
    key: 'fighter',
    label: 'Fighter',
    summary: 'A small, fast military hull that works from a hangar: no more than 10 HS, a high speed, a short endurance at full power and as much hull as possible left beside the engines for weapons.',
    basis: 'Guidance, not a game rule. No fighter class of the saves read is as big as 10 HS (500 tons); the speed and endurance are starting points to edit.',
    name: 'Fighter',
    requirements: Object.freeze({ maxSizeHS: 10, minSpeedKmS: 8000, minEnduranceDays: 2, minPayloadHS: 3, classification: 'military' }),
    cruiseShare: 1,
    axes: Object.freeze([Object.freeze({ figure: 'speedKmS', direction: 'max' }), Object.freeze({ figure: 'payloadHS', direction: 'max' }), Object.freeze({ figure: 'costBP', direction: 'min' })]),
    unmodelled: Object.freeze([
      Object.freeze({ key: 'weapons', label: 'Weapons and fire control', note: 'The weapons and fire control a fighter carries are not part of a propulsion set or read from a saved class here, so they are not evaluated.' }),
      Object.freeze({ key: 'carrierHangar', label: 'Hangar space on a carrier', note: 'The hangar a fighter needs is the carrier\'s requirement, kept in the carrier\'s own brief, so it is not evaluated here.' }),
    ]),
  }),
})

export const PRESET_KEYS = Object.freeze(Object.keys(PRESETS))

const changeOf = (key, label, from, to) => ({ key, label, from, to, kind: from === null || from === undefined || from === '' ? 'add' : equalValue(from, to) ? 'same' : 'replace' })

// What applying a preset to a draft would do, field by field, and nothing changed: `{ preset, label, summary, basis, items, untouched }`. An item is { key, label, from, to, kind } with kind 'add' (the field is empty now), 'replace' (it has a value the preset would write over) or 'same'; `untouched` names the requirements the preset does not give, which stay as they are.
export const previewPreset = (draft, presetKey) => {
  const preset = PRESETS[presetKey]

  if (!preset) {
    throw new Error(`${String(presetKey)} is not a preset`)
  }

  const current = normaliseBrief(draft)
  const items = []

  if (!isText(current.name)) {
    items.push(changeOf('name', 'Name', null, preset.name))
  }

  REQUIREMENTS.filter((definition) => preset.requirements[definition.key] !== undefined).forEach((definition) => {
    items.push(changeOf(definition.key, definition.label, current.requirements[definition.key], preset.requirements[definition.key]))
  })

  if (preset.cruiseShare !== null && preset.cruiseShare !== undefined) {
    items.push(changeOf('cruiseShare', 'Cruise power', current.cruiseShare, preset.cruiseShare))
  }

  items.push({ ...changeOf('axes', 'Preferences', current.axes.length ? current.axes : null, preset.axes.map((axis) => ({ figure: axis.figure, direction: axis.direction }))) })
  preset.unmodelled.filter((note) => !current.unmodelled.some((have) => have.key === note.key)).forEach((note) => items.push({ key: `note:${note.key}`, label: note.label, from: null, to: note.note, kind: 'add' }))

  return { preset: preset.key, label: preset.label, summary: preset.summary, basis: preset.basis, items, untouched: REQUIREMENTS.filter((definition) => preset.requirements[definition.key] === undefined).map((definition) => definition.label) }
}

// The keys of a preview a review accepts without writing over anything: the fields that are empty now.
export const additionsOf = (preview) => preview.items.filter((item) => item.kind === 'add').map((item) => item.key)

// A new draft with the accepted fields of a preview written, and `{ draft, applied, skipped }`. A field the draft already has is replaced only when it is listed in `accepted`; the preview of another preset or a key that is not an item changes nothing. The draft given is never changed.
export const applyPreview = (draft, preview, accepted) => {
  const brief = copyOf(normaliseBrief(draft))
  const preset = PRESETS[preview.preset]
  const wanted = new Set(Array.isArray(accepted) ? accepted : [])
  const applied = []
  const skipped = []

  preview.items.forEach((item) => {
    if (item.kind === 'same') {
      return
    }

    if (!wanted.has(item.key)) {
      skipped.push(item.key)

      return
    }

    if (item.key === 'name') {
      brief.name = item.to
    } else if (item.key === 'cruiseShare') {
      brief.cruiseShare = item.to
    } else if (item.key === 'axes') {
      brief.axes = item.to.map((axis) => ({ figure: axis.figure, direction: axis.direction }))
    } else if (item.key.startsWith('note:')) {
      const note = preset.unmodelled.find((candidate) => `note:${candidate.key}` === item.key)

      brief.unmodelled.push({ key: note.key, label: note.label, note: note.note })
    } else {
      brief.requirements[item.key] = item.to
    }

    applied.push(item.key)
  })

  if (applied.length) {
    brief.preset = preview.preset
  }

  return { draft: brief, applied, skipped }
}

// ---- Figures -------------------------------------------------------------------------------------------------------

const NOT_MODELLED_UNIT = { cargoTons: 'tons', hangarHS: 'HS', deploymentMonths: 'months', classification: '' }

// A figure an alternative does not give, unknown with its reason.
export const unknownFigure = (reason, units = '') => unavailable({ rule: 'brief.notModelled', missing: [reason], units })

const SET_WITHOUT = {
  cargoTons: 'A propulsion set has no cargo holds and the rest of the hull is not designed here, so its cargo capacity is not known',
  hangarHS: 'A propulsion set has no hangar and the rest of the hull is not designed here, so its hangar space is not known',
  deploymentMonths: 'A propulsion set does not choose a planned deployment',
}

const CLASS_NOT_READ = 'The figures of the saved class could not be read from the save'

// The figure `key` of an alternative for the context `{ cruiseShare }`: its result, or unknown with the reason when the alternative gives none.
export const figureOf = (alternative, key, context) => {
  const given = alternative.figures ? alternative.figures[key] : undefined
  const figure = typeof given === 'function' ? given(context) : given

  return figure || unknownFigure(`This alternative gives no ${key} figure`, NOT_MODELLED_UNIT[key] || '')
}

// The status and assumptions a figure derived from a row's design takes over from the row's speed: a hypothetical tech level or an estimated rule weakens it, and every assumption of the design is kept.
const basisOf = (row) => {
  const speed = row.provenance && row.provenance.speed

  return speed ? { status: isAvailable(speed) ? speed.status : STATUS.CONFIRMED, assumptions: [...speed.assumptions] } : { status: STATUS.CONFIRMED, assumptions: [] }
}

const commercialOf = (figures) => (figures && typeof figures.commercial === 'boolean' ? figures.commercial : null)

// The alternative a row of the propulsion planner is: its figures and the reason for each it lacks. `row` is the page's row (`{ key, name, pinned, totalHS, propulsionHS, power, fuelPerEph, litres, type, provenance }`); `classFigures` is what `loadClassFigures` read for the saved class of a pinned row, or null when it could not be read, and is ignored for a designed set.
export const propulsionAlternative = (row, classFigures = null) => {
  const basis = basisOf(row)
  const burn = row.provenance ? row.provenance.burn : null
  const pinned = Boolean(row.pinned)
  const stateOf = (status) => weakestStatus([status, basis.status])
  const size = pinned ? ofRule({ rule: 'brief.classSize', value: row.totalHS, units: 'HS', inputs: { present: ['class size'] }, assumptions: basis.assumptions }) : envelope({ value: row.totalHS, status: stateOf(STATUS.ASSUMED), rule: 'brief.setSize', units: 'HS', inputs: { present: ['hull', 'engines', 'fuel tanks'] }, assumptions: basis.assumptions })
  const space = Math.max(0, row.totalHS - row.propulsionHS)
  const payload = pinned ? ofRule({ rule: 'brief.classPayloadSpace', value: space, units: 'HS', inputs: { present: ['class size', 'engine sizes', 'tank sizes'] }, assumptions: basis.assumptions }) : envelope({ value: space, status: stateOf(STATUS.ASSUMED), rule: 'brief.setPayloadSpace', units: 'HS', inputs: { present: ['hull', 'engines', 'fuel tanks'] }, assumptions: basis.assumptions })
  const rangeBn = row.provenance ? row.provenance.rangeBn : null
  const endurance = row.provenance ? row.provenance.enduranceDays : null
  const stored = (name, rule, units, figure, words = name) => {
    if (!classFigures) {
      return unavailable({ rule, units, missing: [CLASS_NOT_READ] })
    }

    const value = figure(classFigures)

    return value === null ? unavailable({ rule, units, missing: [`The save stores no ${words} for this class`] }) : ofRule({ rule, value, units, inputs: { present: [name] } })
  }
  const figures = {
    sizeHS: size,
    speedKmS: row.provenance ? row.provenance.speed : unknownFigure('The speed is not known', 'km/s'),
    rangeKm: rangeBn ? combine({ rule: 'brief.rangeKm', parts: { range: rangeBn }, compute: ({ range }) => range * KM_PER_BN, units: 'km' }) : unknownFigure('The range is not known', 'km'),
    enduranceDays: (context) => {
      if (!context || context.cruiseShare === null || context.cruiseShare === undefined) {
        return unavailable({ rule: 'brief.cruiseEndurance', units: 'days', missing: ['the cruise power the brief measures endurance at'] })
      }

      if (!endurance || !isAvailable(endurance)) {
        return unavailable({ rule: 'brief.cruiseEndurance', units: 'days', present: endurance ? endurance.inputs.present : [], missing: endurance ? endurance.inputs.missing : ['fuel and engines'] })
      }

      const hours = enduranceHours({ fuel: row.litres, enginePower: row.power, fuelPerEph: row.fuelPerEph, fraction: context.cruiseShare })

      return envelope({ value: hours / 24, status: weakestStatus([STATUS.ASSUMED, burn && isAvailable(burn) ? burn.status : STATUS.ASSUMED, basis.status]), rule: 'brief.cruiseEndurance', units: 'days', inputs: { present: ['engines', 'fuel', 'cruise power'] }, assumptions: basis.assumptions })
    },
    payloadHS: payload,
    costBP: row.provenance ? row.provenance.cost : unknownFigure('The cost is not known', 'BP'),
    cargoTons: pinned ? stored('CargoCapacity', 'brief.classCargo', 'tons', (known) => (known.cargoCapacity === null ? null : cargoTonsOfCapacity(known.cargoCapacity)), 'cargo capacity') : unknownFigure(SET_WITHOUT.cargoTons, 'tons'),
    hangarHS: pinned ? stored('ParasiteCapacity', 'brief.classHangar', 'HS', (known) => (known.hangarCapacity === null ? null : hangarHSOfCapacity(known.hangarCapacity)), 'hangar capacity') : unknownFigure(SET_WITHOUT.hangarHS, 'HS'),
    deploymentMonths: pinned ? stored('PlannedDeployment', 'brief.classDeployment', 'months', (known) => known.plannedDeployment, 'planned deployment') : unknownFigure(SET_WITHOUT.deploymentMonths, 'months'),
  }

  if (pinned) {
    const commercial = commercialOf(classFigures)

    figures.classification = commercial === null ? unavailable({ rule: 'brief.classClassification', missing: [classFigures ? 'The save stores no classification for this class' : CLASS_NOT_READ] }) : ofRule({ rule: 'brief.classClassification', value: commercial ? 'commercial' : 'military', inputs: { present: ['Commercial'] } })
  } else if (row.type === 'Military') {
    figures.classification = ofRule({ rule: 'brief.engineClassification', value: 'military', inputs: { present: ['engine kind'] } })
  } else {
    figures.classification = unknownFigure('The engines are commercial, but a military component, less than 1 HS of engineering or a deployment under 3 months also makes a class military, and the rest of the hull is not designed here')
  }

  return { id: row.key, name: row.name, pinned, figures }
}

// ---- Evaluation ----------------------------------------------------------------------------------------------------

const EPSILON = 1e-9

const slack = (value) => Math.max(Math.abs(value) * EPSILON, 1e-12)

const grouped = (value, digits) => value.toLocaleString('en-US', { maximumFractionDigits: digits })

// How the figures of a requirement are shown: the unit that goes with the number and the divisor from the figure held to that number (a range is held in km and shown in billions of km). Null for a requirement that is a word.
export const shownIn = (definition) => (definition.values ? null : { unit: definition.input.unit, scale: definition.input.scale, digits: definition.input.digits })

// A figure of a requirement in words: HS with its tons, the others in the unit they are shown in.
export const describeAmount = (definition, value) => {
  const shown = shownIn(definition)

  if (!shown) {
    return String(value)
  }

  if (definition.key === 'maxSizeHS') {
    return `${grouped(value, 2)} HS (${grouped(tonsOfHs(value), 1)} tons)`
  }

  return `${grouped(value / shown.scale, shown.digits)} ${shown.unit}`
}

const reasonOf = (definition, verdict, actual, required) => {
  const name = definition.label

  if (definition.comparison === 'is') {
    return verdict === 'pass' ? `${name} is ${actual}, as required` : `${name} is ${actual}, not the ${required} required`
  }

  const found = describeAmount(definition, actual)
  const wanted = describeAmount(definition, required)
  const gap = describeAmount(definition, Math.abs(actual - required))

  if (verdict === 'pass') {
    return `${name} is ${found}, ${definition.comparison === 'atLeast' ? 'at least' : 'at most'} the ${wanted} ${definition.comparison === 'atLeast' ? 'required' : 'allowed'}`
  }

  return definition.comparison === 'atLeast' ? `${name} is ${found}, ${gap} short of the ${wanted} required` : `${name} is ${found}, ${gap} over the ${wanted} allowed`
}

const unknownReason = (definition, figure) => {
  const missing = figure && figure.inputs && figure.inputs.missing.length ? figure.inputs.missing.join('; ') : ''

  return `${definition.label} is not known: ${missing || 'this alternative gives no figure'}`
}

// One requirement of a brief against one alternative: `{ key, label, kind: 'hard', comparison, required, actual, unit, verdict, reason, status, assumptions, figure }`; `actual` is null when the figure is unknown, and a figure that is unknown never passes.
const evaluateRequirement = (definition, brief, alternative, context) => {
  const required = brief.requirements[definition.key]
  const base = { key: definition.key, label: definition.label, kind: 'hard', comparison: definition.comparison, required, unit: definition.unit }

  if (definition.needs === 'cruiseShare' && brief.cruiseShare === null) {
    return { ...base, actual: null, verdict: 'unknown', reason: `${definition.label} needs the cruise power the brief measures it at, and the brief names none`, status: STATUS.UNAVAILABLE, assumptions: EMPTY_LIST, figure: null }
  }

  const figure = figureOf(alternative, definition.figure, context)

  if (!isAvailable(figure)) {
    return { ...base, actual: null, verdict: 'unknown', reason: unknownReason(definition, figure), status: figure.status, assumptions: figure.assumptions, figure }
  }

  const actual = figure.value
  const passed = definition.comparison === 'atLeast' ? actual >= required - slack(required) : definition.comparison === 'atMost' ? actual <= required + slack(required) : actual === required
  const verdict = passed ? 'pass' : 'fail'

  return { ...base, actual, verdict, reason: reasonOf(definition, verdict, actual, required), status: figure.status, assumptions: figure.assumptions, figure }
}

const optionalOf = (note) => ({ key: `note:${note.key}`, label: note.label, kind: 'optional', comparison: null, required: null, actual: null, unit: '', verdict: 'unknown', reason: `${note.label} is not modelled here: ${note.note}`, status: STATUS.UNAVAILABLE, assumptions: EMPTY_LIST, figure: null })

const evaluateAlternative = (brief, alternative, context, index) => {
  const hard = REQUIREMENTS.filter((definition) => brief.requirements[definition.key] !== null).map((definition) => evaluateRequirement(definition, brief, alternative, context))
  const optional = brief.unmodelled.map(optionalOf)
  const violated = hard.filter((item) => item.verdict === 'fail')
  const unknown = hard.filter((item) => item.verdict === 'unknown')
  const passed = hard.filter((item) => item.verdict === 'pass')
  const verdict = !hard.length ? 'none' : violated.length ? 'fails' : unknown.length ? 'open' : 'meets'
  const axes = brief.axes.map((axis) => ({ ...axis, figure: figureOf(alternative, axis.figure, context), key: axis.figure }))

  return { id: alternative.id, name: alternative.name, pinned: Boolean(alternative.pinned), index, verdict, requirements: [...hard, ...optional], violated, unknown, passed, optional, axes, rank: null }
}

const GROUP = { meets: 0, none: 0, open: 1, fails: 2 }

// Orders the evaluations: the meeting ones first, then the open ones, then the failing ones, each group by the preferences in their order (a figure that is unknown sorts after every known one, a tie falls to the next preference, then to the order the alternatives came in).
export const rankEvaluations = (evaluations) => {
  const compare = (a, b) => {
    if (GROUP[a.verdict] !== GROUP[b.verdict]) {
      return GROUP[a.verdict] - GROUP[b.verdict]
    }

    for (let index = 0; index < a.axes.length; index++) {
      const first = isAvailable(a.axes[index].figure) ? a.axes[index].figure.value : null
      const second = isAvailable(b.axes[index].figure) ? b.axes[index].figure.value : null

      if (first === null || second === null) {
        if (first !== second) {
          return first === null ? 1 : -1
        }

        continue
      }

      if (Math.abs(first - second) > slack(Math.max(Math.abs(first), Math.abs(second)))) {
        return a.axes[index].direction === 'min' ? first - second : second - first
      }
    }

    return a.index - b.index
  }

  return [...evaluations].sort(compare).map((item, position) => ({ ...item, rank: position + 1 }))
}

// A brief judged against every alternative: `{ brief, required, alternatives (ranked), counts }`, each alternative as `evaluateAlternative` gives it with its `rank`. A brief that requires nothing gives the verdict 'none' and orders by its preferences alone.
export const evaluateBrief = (input, alternatives) => {
  const brief = normaliseBrief(input)
  const context = { cruiseShare: brief.cruiseShare }
  const ranked = rankEvaluations(alternatives.map((alternative, index) => evaluateAlternative(brief, alternative, context, index)))
  const counts = { meets: 0, open: 0, fails: 0, none: 0 }

  ranked.forEach((item) => {
    counts[item.verdict] += 1
  })

  return { brief, required: requiredKeys(brief), alternatives: ranked, counts }
}

// The verdict of an alternative in words, naming each violated and each unknown requirement.
export const describeVerdict = (evaluation) => {
  const names = (list) => list.map((item) => item.label).join(', ')

  if (evaluation.verdict === 'none') {
    return 'The brief requires nothing'
  }

  if (evaluation.verdict === 'meets') {
    return `Meets all ${evaluation.passed.length} requirements`
  }

  return [evaluation.violated.length ? `Violates ${names(evaluation.violated)}` : '', evaluation.unknown.length ? `Unknown: ${names(evaluation.unknown)}` : ''].filter(Boolean).join('. ')
}

// The counts of a brief's evaluation in words.
export const describeCounts = (counts, total) => {
  if (!total) {
    return 'No alternative to judge yet.'
  }

  if (counts.none === total) {
    return `The brief requires nothing, so all ${total} alternatives are ordered by its preferences alone.`
  }

  return `${counts.meets} of ${total} meet every requirement, ${counts.open} stay open (none fails, at least one requirement is unknown), ${counts.fails} fail.`
}

// ---- The saved class's own figures ---------------------------------------------------------------------------------

const numberOrNull = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

// The race's classes' cargo and hangar capacity, planned deployment and classification as the save stores them, by class id: `{ cargoCapacity, hangarCapacity, plannedDeployment, commercial }`. A figure the save stores as nothing is null: unknown, never 0. A save without one of the columns fails the read, which the page reports as an input it could not read (utilities/capabilities.js), and the classes' figures stay unknown.
export const loadClassFigures = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query('select FCT_ShipClass.ShipClassID, FCT_ShipClass.CargoCapacity, FCT_ShipClass.ParasiteCapacity, FCT_ShipClass.PlannedDeployment, FCT_ShipClass.Commercial from FCT_ShipClass where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID', { replacements: { GameID, RaceID } })

  return Object.freeze(Object.fromEntries(rows.map((row) => [row.ShipClassID, Object.freeze({
    cargoCapacity: numberOrNull(row.CargoCapacity),
    hangarCapacity: numberOrNull(row.ParasiteCapacity),
    plannedDeployment: numberOrNull(row.PlannedDeployment),
    commercial: row.Commercial === null || row.Commercial === undefined ? null : Boolean(Number(row.Commercial)),
  })])))
}

export const NO_CLASS_FIGURES = Object.freeze({})

// ---- The records ---------------------------------------------------------------------------------------------------

// The adapter of the scenario repository for the briefs: a payload is a brief (`problemsOf`) and has no links, because it names nothing in a save.
export const briefAdapter = Object.freeze({
  kind: BRIEF_KIND,
  schema: BRIEF_SCHEMA,
  validate: problemsOf,
  versions: () => ({ 'brief.requirements': VERSIONS.join(', ') }),
})

const registered = new WeakSet()

// Registers the adapter with a repository's `registerAdapter`, once per function.
export const registerBriefs = (register) => {
  if (registered.has(register)) {
    return
  }

  try {
    register(briefAdapter)
  } catch (error) {
    if (!/registered already/.test(String(error && error.message))) {
      throw error
    }
  }

  registered.add(register)
}

const NOT_APPLIED = ['newer-schema', 'no-adapter', 'invalid-payload']

const unappliedReason = (item) => `A brief written by another version of the app or not valid is not listed (${item.flags.join(', ')}).`

// The briefs of the race in the campaign as the open save reads them: `{ entries, notes, error }`. An entry is `{ uuid, name, payload, revision, status, ahead, otherBranch, flags }`, oldest first; `ahead` is a brief made at a later game time than this save, which is listed and is not applied until it is moved to this save. A record the adapter does not understand is a note. Nothing is written.
export const readBriefs = (repository, scope) => {
  const empty = { entries: [], notes: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed

  try {
    listed = repository.list(scope, { kind: BRIEF_KIND })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: { code: error.code, message: error.message } }
    }

    throw error
  }

  const unreadable = (item) => item.flags.some((flag) => NOT_APPLIED.includes(flag))

  return {
    entries: listed.filter((item) => !unreadable(item)).map((item) => ({ uuid: item.record.uuid, name: item.payload.name, payload: copyOf(item.payload), revision: item.record.revision, status: item.status, ahead: item.status === 'ahead', otherBranch: item.flags.includes('other-branch'), flags: item.flags })),
    notes: listed.filter(unreadable).map((item) => ({ uuid: item.record.uuid, flags: item.flags, reason: unappliedReason(item) })),
    error: null,
  }
}

const failure = (error) => ({ ok: false, code: (error && error.code) || 'failed', message: error && error.message ? error.message : String(error) })

const assumptionsOf = (payload) => ['The thresholds are the player\'s own, not game rules', ...(payload.preset && PRESETS[payload.preset] ? [`The brief started from the ${PRESETS[payload.preset].label} preset, which is guidance and not a game rule`] : [])]

// Checks a write can be made: a repository, a settled scope and, in a browser, this tab holding the file. `{ ok: true }` or the failure to give back.
const mayWrite = async (repository, scope) => {
  if (!repository) {
    return { ok: false, code: 'no-repository', message: 'The scenario records are not available in this window, so the brief is not kept.' }
  }

  if (!scope) {
    return { ok: false, code: 'no-scope', message: 'The campaign of this save is not settled yet, so the brief is not kept.' }
  }

  if (!(await repository.writable(scope.campaignId))) {
    return { ok: false, code: 'not-owner', message: 'Another tab holds the scenario file, so the brief is not kept.' }
  }

  return { ok: true }
}

// Keeps a brief: a new record of the race in the campaign when `entry` is null, else the record `entry` names, edited over the revision the entry was read at. A stale revision is refused with the code 'revision-conflict' and the stored brief, and nothing is written, unless `overwrite` says to write over what is stored. Returns `{ ok: true, record }` or `{ ok: false, code, message }`.
export const saveBrief = async (repository, scope, { entry = null, payload, overwrite = false }) => {
  try {
    const allowed = await mayWrite(repository, scope)

    if (!allowed.ok) {
      return allowed
    }

    const problems = problemsOf(payload)

    if (problems.length) {
      return { ok: false, code: 'invalid-brief', message: `The brief is not valid: ${problems.join('; ')}` }
    }

    const patch = { payload: copyOf(payload), assumptions: assumptionsOf(payload) }

    if (!entry) {
      return { ok: true, record: repository.create(scope, { kind: BRIEF_KIND, policy: 'campaign', ...patch }) }
    }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, patch) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      if (!overwrite) {
        return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
      }

      return { ok: true, record: repository.reconcile(scope, error, patch) }
    }
  } catch (error) {
    return failure(error)
  }
}

// Moves a brief made at a later game time to the open save (its payload is not changed), so that it applies here.
export const moveBrief = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope)

    return allowed.ok ? { ok: true, record: repository.update(scope, entry.uuid, entry.revision, { rebase: true }) } : allowed
  } catch (error) {
    return failure(error)
  }
}

// Deletes a brief over the revision the entry was read at; a stale revision is refused and nothing is deleted.
export const deleteBrief = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope)

    return allowed.ok ? { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) } : allowed
  } catch (error) {
    return failure(error)
  }
}
