// A ground formation's actual elements against the template chosen as the intent: the original template it was raised from or the replacement template it is made up to. Both come from the shared model of the race's formations (utilities/ground-formations.js); nothing is read here.
//
// The comparison is by class: for each class that the formation or the template holds, the units the formation has and the units the template calls for, so the deficit (the units short) and the excess (the units over) are exact counts. The masses are the model's own figures: the formation's actual mass and the template's intended mass, each the sum of units times the class's size per unit, so a class whose size or units the save does not give leaves that mass unknown, never 0 (the rows keep what they can still say). A formation the save has no element rows for has no known composition and is not compared, and a template that is not usable (none recorded, not stored as an id, not in the save, of another race, or listing no elements) is no comparison either: no deficit is ever worked out against nothing.
//
// Obsolescence is the template's own Obsolete flag, the only obsolete column the ground tables have (a class has none). An STO class is one with an STO weapon or STO equipment. An obsolete template that holds an STO class is a replacement review: the game's rules for refitting an STO class are not established, so nothing here claims that an obsolete STO can be upgraded. Whether the replacement template is another template than the original is a separate fact (`identity`).
//
// The transport consequence is whether the formation fits one troop bay: whole formations are carried (utilities/mine-bootstrap.js `carryFormations`), none split among ships, so a formation fits when its mass is within the largest bay. It is judged at the formation's actual mass and at the template's intended mass.

import { carryFormations } from './mine-bootstrap'

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The templates a formation can be compared with, as the page offers them.
export const BASES = Object.freeze([
  Object.freeze({ value: 'original', text: 'Original template' }),
  Object.freeze({ value: 'replacement', text: 'Replacement template' }),
])

const BASIS_KEYS = BASES.map((basis) => basis.value)

// The template chosen as the intent, a view preference of the race (`persistedView`, mixins/persisted-view.js). The replacement template is where the game makes a formation up to, so it is the default; a stored value that is not offered is dropped.
export const basisView = Object.freeze({ key: 'groundCompareBasis', scope: 'race', default: 'replacement', normalise: (stored) => (BASIS_KEYS.includes(stored) ? stored : undefined) })

// Why a template cannot be compared with, by the state the model gives it (`empty` is a template that lists no elements).
export const NO_TEMPLATE = Object.freeze({
  none: 'No template is recorded',
  unknown: 'The template is not stored as a template id',
  missing: 'The template is not in the save',
  foreign: 'The template belongs to another race',
  empty: 'The template lists no elements',
})

const STATUS_ORDER = Object.freeze({ short: 0, over: 1, unknown: 2, match: 3 })

// One class's row as it starts: nothing on either side. `item` is an element of the formation or of the template, which carry the class's name, size per unit and STO flag alike.
const emptyRow = (item) => ({ classId: item.classId, className: item.className, actual: 0, actualKnown: true, intended: 0, intendedKnown: true, size: item.size, sto: item.sto })

// The classes of the actual elements and of the template, one row per class: the units on each side (null where an element's units are not stored), the deficit and excess, the size per unit and the mass on each side.
const classRows = (node, template) => {
  const rows = new Map()
  const row = (item) => {
    if (!rows.has(item.classId)) {
      rows.set(item.classId, emptyRow(item))
    }

    return rows.get(item.classId)
  }

  node.elements.forEach((item) => {
    const found = row(item)

    if (item.units === null) {
      found.actualKnown = false
    } else {
      found.actual += item.units
    }
  })
  template.elements.forEach((item) => {
    const found = row(item)

    if (item.units === null) {
      found.intendedKnown = false
    } else {
      found.intended += item.units
    }
  })

  return Array.from(rows.values()).map((found) => {
    const actual = found.actualKnown ? found.actual : null
    const intended = found.intendedKnown ? found.intended : null
    const known = actual !== null && intended !== null
    const deficit = known ? Math.max(0, intended - actual) : null
    const excess = known ? Math.max(0, actual - intended) : null

    return {
      classId: found.classId,
      className: found.className,
      actual,
      intended,
      deficit,
      excess,
      status: !known ? 'unknown' : deficit > 0 ? 'short' : excess > 0 ? 'over' : 'match',
      size: found.size,
      actualMass: actual !== null && found.size !== null ? actual * found.size : null,
      intendedMass: intended !== null && found.size !== null ? intended * found.size : null,
      sto: found.sto,
    }
  }).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.className === null) - (b.className === null) || String(a.className).localeCompare(String(b.className)) || a.classId - b.classId)
}

// The bays of the race's troop ships (`troops`: { classes: [{ TroopCapacity, Ships }] }, null when the save does not give them) that can hold a formation: a class counts when its capacity and its number of ships are whole figures above 0.
const baysOf = (troops) => (troops && Array.isArray(troops.classes) ? troops.classes.filter((item) => item && isNumber(item.TroopCapacity) && Number.isInteger(item.Ships) && item.Ships > 0).map((item) => ({ TroopCapacity: item.TroopCapacity, Ships: item.Ships })) : [])

// Whether a formation of `mass` fits one troop bay of the race's ships (`carryFormations` of utilities/mine-bootstrap.js, whole formations only): { kind, mass, largest }, `kind` being `fits`, `oversize` (more than the largest bay holds), `no-bays` (no troop ship), `unsized` (the mass is not known) or `unknown` (the troop ships are not known). With no bay at all the kind is `no-bays`, not the `oversize` that `carryFormations` would give, so it is not asked then.
export const troopFit = (mass, troops) => {
  const known = isNumber(mass) ? mass : null

  if (!troops) {
    return { kind: 'unknown', mass: known, largest: null }
  }

  const bays = baysOf(troops)
  const largest = bays.length ? Math.max(...bays.map((bay) => bay.TroopCapacity)) : null

  if (!bays.length) {
    return { kind: known === null ? 'unsized' : 'no-bays', mass: known, largest }
  }

  const planned = carryFormations([{ formation: { ownSize: known } }], { classes: bays })

  return { kind: planned.unsized.length ? 'unsized' : planned.carried.length ? 'fits' : 'oversize', mass: known, largest }
}

// What the chosen template says of obsolescence: the template's flag (true, false, or null where the save does not store it), the STO classes among the classes compared, told apart by where they are (`templateSto`: classes the template lists; `actualOnlySto`: classes only the actual formation holds, which a transfer of units can add without touching a template), `unknownSto` the classes whose STO flag is not known, `sto` the evidence (`template` when the template lists an STO class, `actual` when only the formation holds one, `none`) and `review`, whether the template is obsolete and there is STO evidence of either kind.
const obsolescenceOf = (template, rows) => {
  const listed = new Set(template.elements.map((item) => item.classId))
  const stoRows = rows.filter((row) => row.sto === true)
  const named = (list) => list.map((row) => ({ classId: row.classId, className: row.className }))
  const templateSto = named(stoRows.filter((row) => listed.has(row.classId)))
  const actualOnlySto = named(stoRows.filter((row) => !listed.has(row.classId)))
  const sto = templateSto.length ? 'template' : actualOnlySto.length ? 'actual' : 'none'

  return { flag: template.obsolete, templateSto, actualOnlySto, stoClasses: [...templateSto, ...actualOnlySto], sto, unknownSto: rows.filter((row) => row.sto === null).length, review: template.obsolete === true && sto !== 'none' }
}

// Whether two templates are one: true when both ids are the same, false when they differ (a recorded template and none included), null where an id is not stored.
const sameTemplate = (a, b) => (isNumber(a.id) && isNumber(b.id) ? a.id === b.id : null)

const refOf = (template) => ({ id: template.id, state: template.state, name: template.name, abbreviation: template.abbreviation, obsolete: template.obsolete })

// A formation (`node` of the model) compared with its `which` template ('original' or 'replacement'), with the race's troop ships (`troops`, null when not known). Gives { which, state, reason, template, otherTemplate, identity, classes, totals, actualMass, intendedMass, massDifference, obsolescence, carry }:
// - `state` is `compared`, `no-template` (`reason` says why: none, unknown, missing, foreign or empty) or `no-elements` (the formation has no element rows). Only a compared formation has `classes`, each { classId, className, actual, intended, deficit, excess, status ('short', 'over', 'match' or 'unknown'), size, actualMass, intendedMass, sto }, and `totals` { short, over, unknown (classes), deficit, excess (units, of the classes known) }.
// - `actualMass` and `intendedMass` are the model's figures { value, from, unknown }; `massDifference` is intended minus actual when both are known, else null.
// - `identity.sameTemplate` is whether the original and replacement templates are one; `template` is the chosen one and `otherTemplate` the other, each { id, state, name, abbreviation, obsolete }, and `obsolescence` what the chosen one's flag and STO classes say.
// - `carry` is { now, intended } (`troopFit` at the actual mass and at the intended mass); with no usable template the intended mass is not known and `intended` is `unsized` (or `unknown` where the troop ships are not).
export const compareFormation = (node, which, troops = null) => {
  const template = node.templates[which]
  const other = node.templates[which === 'original' ? 'replacement' : 'original']
  const base = { which, template: refOf(template), identity: { sameTemplate: sameTemplate(node.templates.original, node.templates.replacement) }, actualMass: node.mass, carry: { now: troopFit(node.mass.value, troops), intended: null }, otherTemplate: refOf(other) }
  const empty = { classes: [], totals: { short: 0, over: 0, unknown: 0, deficit: 0, excess: 0 }, intendedMass: null, massDifference: null, obsolescence: { flag: template.obsolete, templateSto: [], actualOnlySto: [], stoClasses: [], sto: 'none', unknownSto: 0, review: false } }

  if (template.state !== 'found' || template.elements.length === 0) {
    return { ...base, ...empty, state: 'no-template', reason: template.state === 'found' ? 'empty' : template.state, carry: { ...base.carry, intended: troopFit(null, troops) } }
  }

  if (node.elements.length === 0) {
    return { ...base, ...empty, state: 'no-elements', reason: null, intendedMass: template.mass, carry: { ...base.carry, intended: troopFit(template.mass.value, troops) } }
  }

  const classes = classRows(node, template)
  const sum = (key) => classes.reduce((total, row) => total + (row[key] ?? 0), 0)

  return {
    ...base,
    state: 'compared',
    reason: null,
    classes,
    totals: { short: classes.filter((row) => row.status === 'short').length, over: classes.filter((row) => row.status === 'over').length, unknown: classes.filter((row) => row.status === 'unknown').length, deficit: sum('deficit'), excess: sum('excess') },
    intendedMass: template.mass,
    massDifference: node.mass.value !== null && template.mass.value !== null ? template.mass.value - node.mass.value : null,
    obsolescence: obsolescenceOf(template, classes),
    carry: { now: base.carry.now, intended: troopFit(template.mass.value, troops) },
  }
}

// The words of the comparison, one table for each thing the page says, so that what a sentence means is the key of its entry and its wording is the entry (a figure is written where `{name}` stands, and the page puts it in an element of its own that carries the name as its role; a mass is written with its unit inside that element, so that the word order of an entry places figures and never gives them a meaning). The builders below choose the entry and write the figures; nothing else in this file words a verdict.
export const GAP_TEXT = Object.freeze({
  short: Object.freeze(['{short} class short', '{short} classes short']),
  over: Object.freeze(['{over} over']),
  unknown: Object.freeze(['{unknown} not known']),
  complete: Object.freeze(['Complete']),
  'no-elements': Object.freeze(['No elements stored']),
})
export const GAP_JOIN = ', '
export const NOT_COMPARED_TEXT = Object.freeze({
  'no-elements': 'The save holds no element rows for the formation, so its composition is not known and nothing is compared.',
  ...Object.fromEntries(Object.entries(NO_TEMPLATE).map(([reason, words]) => [reason, `${words}, so nothing is compared.`])),
})
export const OBSOLESCENCE_TEXT = Object.freeze({
  unknown: 'Whether the template is obsolete is not stored.',
  current: 'The template is not marked obsolete.',
  obsolete: 'The template is marked obsolete.',
  review: 'The template is marked obsolete and holds STO classes: a replacement review, not a direct upgrade of the STO class.',
  'review-actual': 'The template is marked obsolete and the formation holds STO classes the template does not list: a replacement review, not a direct upgrade of the STO class.',
})
export const IDENTITY_TEXT = Object.freeze({
  same: 'The original and replacement templates are the same template.',
  differ: 'The original and replacement templates differ.',
  unknown: 'Whether the original and replacement templates differ is not stored.',
})
export const CARRY_TEXT = Object.freeze({
  fits: 'Fits one troop bay ({mass}; the largest holds {largest})',
  oversize: 'Fits no troop bay ({mass}; the largest holds {largest})',
  'no-bays': 'No troop ship has a bay',
  unsized: 'The mass is not known',
  unknown: 'The troop ships are not known',
})
export const TEMPLATE_TEXT = Object.freeze({
  none: 'No template',
  unnamed: 'Template {id}',
})

// A sentence of a table as parts, in order: { text } for words and { role, text } for a figure, written by `write`. The page draws each part in an element of its own, a figure with its role as `data-figure`.
const partsOf = (words, figures, write) => words.split(/(\{\w+\})/).filter(Boolean).map((piece) => {
  const name = /^\{(\w+)\}$/.exec(piece)

  return name ? { role: name[1], text: write(figures[name[1]]) } : { text: piece }
})
const gapPart = (kind, n) => partsOf(GAP_TEXT[kind][n === 1 ? 0 : GAP_TEXT[kind].length - 1], { [kind]: n }, String)
const textOf = (parts) => parts.map((part) => part.text).join('')
const tonnes = (count) => (value) => `${count(value)} t`

// The table's short statement of a comparison as `parts` (and as `label`, their text), with the key the column sorts by (`order`: 0 short, 1 over, 2 not known, 3 complete, 4 not compared).
export const gapOf = (comparison) => {
  if (comparison.state === 'no-elements') {
    return { label: GAP_TEXT['no-elements'][0], parts: [{ text: GAP_TEXT['no-elements'][0] }], order: 4 }
  }

  if (comparison.state === 'no-template') {
    return { label: NO_TEMPLATE[comparison.reason], parts: [{ text: NO_TEMPLATE[comparison.reason] }], order: 4 }
  }

  const { short, over, unknown } = comparison.totals
  const found = [short ? gapPart('short', short) : null, over ? gapPart('over', over) : null, unknown ? gapPart('unknown', unknown) : null].filter(Boolean)
  const parts = found.length ? found.flatMap((part, index) => (index ? [{ text: GAP_JOIN }, ...part] : part)) : [{ text: GAP_TEXT.complete[0] }]

  return { label: textOf(parts), parts, order: short ? 0 : over ? 1 : unknown ? 2 : 3 }
}

// The reason a comparison is not made, in words.
export const noComparisonText = (comparison) => NOT_COMPARED_TEXT[comparison.state === 'no-elements' ? 'no-elements' : comparison.reason]

// What obsolescence says of a comparison's template, in words. An obsolete template with STO classes is a replacement review and never a direct upgrade.
export const obsolescenceText = (obsolescence) => {
  if (obsolescence.flag === null) {
    return OBSOLESCENCE_TEXT.unknown
  }

  if (obsolescence.flag === false) {
    return OBSOLESCENCE_TEXT.current
  }

  return obsolescence.review ? OBSOLESCENCE_TEXT[obsolescence.sto === 'actual' ? 'review-actual' : 'review'] : OBSOLESCENCE_TEXT.obsolete
}

// Whether the original and replacement templates are one template, in words.
export const identityText = (comparison) => (comparison.identity.sameTemplate === true ? IDENTITY_TEXT.same : comparison.identity.sameTemplate === false ? IDENTITY_TEXT.differ : IDENTITY_TEXT.unknown)

// A troop fit (`troopFit`) in words, as parts: the mass and the largest bay are figures with the roles `mass` and `largest`, each written in tonnes by `count`. The roles are the builder's: they come from `fit`, whatever the order of the words.
export const carryParts = (fit, count) => partsOf(CARRY_TEXT[fit.kind], fit, tonnes(count))

// A template as the page names it, as parts: its own name, or its id (a figure with the role `id`) where it has none, or the fact that none is recorded.
export const templateParts = (template) => (template.id === null || template.state === 'none' ? [{ text: TEMPLATE_TEXT.none }] : template.name ? [{ text: template.name }] : partsOf(TEMPLATE_TEXT.unnamed, template, String))
