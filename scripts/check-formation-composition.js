/*
  Checks the comparison of a ground formation's actual elements with the template chosen as its intent (src/renderer/utilities/formation-composition.js over the model of utilities/ground-formations.js, and the Ground formations panel of the Survey Progress page) against figures worked out by hand, against SQL written separately here and against the saves.

  Run: bun scripts/check-formation-composition.js [--no-mutations] [--no-browser] [--resume] [--only=<text>[|<text>...]] [--variants=<key>[,<key>...]]

  The groups, each check a PASS or FAIL line:
  - A constructed race of 18 formations over 14 templates: exact deficits and excess by class, the two bases told apart, a complete formation, a template that is none, foreign, missing, not stored or empty (no comparison and no invented deficit), a formation with no element rows, units and sizes that are not stored, the mass of the elements reconciled with the units and sizes, the obsolete flag apart from the identity of the templates, an obsolete template with an STO class (a replacement review) and the cases that are none, and whether a formation fits one troop bay now and at the intended mass.
  - The saves, opened read-only: every comparison of every formation, on both bases, is compared with SQL written separately here (the classes, the units on each side, the mass, the flag, the STO classes), and the saves are known to hold the counts of formations, of formations whose original and replacement templates differ and of replacement reviews pinned below.
  - The page in a browser: the real renderer, served by Vite from a copy of a save that is changed to hold a formation that is short in one class and over in another, a formation that no template covers, one with no elements and one under an obsolete template without an STO class (scripts/lib/page-server.js), is driven through its controls (the basis toggle, each row's expander, the page left and opened again) and what it draws is read back through the shared readers of scripts/lib/browser-observe.js. The expected figures come from SQL; nothing reads the template or the wording of a heading or a sentence.
  - Planted faults in copies of the utility, the model and the page, each of which must make a named check fail on an assertion of its own, by a value it reads and not by a call of the code under test that threw (scripts/lib/fault-credit.js `caughtBy`; a fault in the page is served to the browser), and benign rewrites (an explicit prop and event instead of v-model, a longhand v-on, a qualifier moved from the front to the back, a synonym in generated prose, a parenthesised condition) that must make none fail.
  - Controls of the harness: an assertion of a check is told from an error of the code under test.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2. A save that is not there fails its checks: none is skipped. The head (`head`) and every fault, control and rewrite (`planted:N`, `controls`, `benign:N`) run through scripts/lib/suite-runner.js: one after another in a worker that opens the saves, plants the copy, starts one page server and one browser and warms them first, each with a deadline, with a record that --resume continues and the control `control:warm-reset`, which runs a planted fault and then the head on the same server. --only=<text> runs the head and the variants whose names hold the text (a focused run while working; the run that counts has none).
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const rawAssert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { startPageServer } = require('./lib/page-server')
const { observe, failedObservation, report, HarnessError, installScreen, readFigure, labelKey, pairedBy, settled } = require('./lib/browser-observe')
const { assert, through, subjectModule, runChecks, judged, caughtBy, unobserved } = require('./lib/fault-credit')
const { runSuite } = require('./lib/suite-runner')
const { pretendBrowser, NAVIGATION_FAILED } = require('./lib/pretend-browser')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const COMPOSITION_FILE = path.join(utilitiesDirectory, 'formation-composition.js')
const GROUND_FILE = path.join(utilitiesDirectory, 'ground-formations.js')
const SURVEY_FILE = path.join(root, 'src', 'renderer', 'pages', 'survey-progress.vue')

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`
const real = (specifier) => `import { createRequire } from 'node:module'\nexport default ${requireOf(specifier)}`

const STUBS = {
  vue: 'export default { observable: (value) => value }',
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  'lodash/groupBy': real('lodash/groupBy'),
  'lodash/partition': real('lodash/partition'),
  dayjs: real('dayjs'),
  'dayjs/plugin/utc.js': real('dayjs/plugin/utc.js'),
  romanum: real('romanum'),
}

const argument = (name) => (process.argv.find((item) => item.startsWith(`${name}=`)) || '').slice(name.length + 1)
const options = { mutations: !process.argv.includes('--no-mutations'), browser: !process.argv.includes('--no-browser') }

let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

const frozen = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }

  return value
}

// What the player reads is taken back to facts, never forward from them. A sentence of the screen is matched, as a frame (its words, with `{role}` where a figure stands), against the entries of the module's own tables of words (the variant of the module under judgement, `ctx.comp`), and the entry it is an instance of is its meaning (its key); a sentence that holds no figure is read back through the table by `labelKey` (scripts/lib/browser-observe.js). A figure is read from the element of its own that the page marks with its role (`data-figure`), never from its place in a sentence, so the word order of an entry places figures and gives them no meaning. It is read as the whole token it is (`readFigure` in the grouping of the page's setting, and a unit where the figure has one; anything else beside the digits is no figure) and compared with the SQL oracle's figure of that role. The words of the module and its number format are never used to work out what is expected, so a fault inside them cannot move both sides of a comparison; a rewrite of the wording that keeps the meaning and the figures passes.
const atTwoDecimals = (value) => Math.round(value * 100) / 100

// The units a mass may be written in on the screen, to tonnes. A unit that is not here fails the check that meets it: a mass in another unit is not a mass in tonnes, whatever the figure.
const UNITS = Object.freeze({ t: 1, tonne: 1, tonnes: 1 })

// A figure as written, with its unit: { value, unit }, the unit being the word of letters after the last space (null where none) and the rest read whole by `readFigure` in the `grouping` of the page's setting, or null where the rest is no figure. The split takes every character the screen keeps (a line or paragraph separator among them) into the rest, where `readFigure` refuses it.
const quantityOf = (text, grouping) => {
  const [, figure, unit] = /^(.*?)(?: ([A-Za-z]+))?$/s.exec(String(text))
  const value = readFigure(figure, grouping)

  return value === null ? null : { value, unit: unit || null }
}

// The grouping of the figures the module writes with `String`, not with the count of the page's setting: the id of an unnamed template and the counts of a gap.
const UNGROUPED = 'None'

// A line of the screen as read in the page ({ text, figures: [{ role, text }] }, the figures in the order the line draws them, as `hooked` gives them) as a frame: { frame, figures }, the text of the line with the text of each figure put back as `{role}` where it stands, each figure found after the one before it; a line that is not drawn is undefined. The text of a figure is a part of the text of its line (both are the text nodes drawn, the whitespace collapsed alike), so a figure that is not found there is a defect of the reading, not of the page.
const framed = (line) => {
  if (line === undefined) {
    return undefined
  }

  let rest = line.text
  let frame = ''

  for (const figure of line.figures) {
    const at = rest.indexOf(figure.text)

    if (at < 0) {
      throw new HarnessError(`the figure "${figure.text}" (${figure.role}) is not in the text of its line "${line.text}"`)
    }

    frame += `${rest.slice(0, at)}{${figure.role}}`
    rest = rest.slice(at + figure.text.length)
  }

  return { frame: frame + rest, figures: line.figures }
}

// The parts a builder of the module gives (`{ text }` for words, `{ role, text }` for a figure) as the line the screen would show of them, `{ text, figures }`.
const lineOfParts = (parts) => ({ text: parts.map((part) => part.text).join(''), figures: parts.filter((part) => part.role !== undefined).map(({ role, text }) => ({ role, text })) })

// A line as a frame ({ frame, figures }), or a sentence as a plain string. The placeholders of a frame are the figures, in order.
const lineOf = (line) => (typeof line === 'string' ? { frame: line, figures: [] } : line)
const placeholdersOf = (words) => [...words.matchAll(/\{(\w+)\}/g)].map((match) => match[1])

// Every entry of `table` (a kind to a wording, or to a list of wordings, with `{name}` for a figure) that the line ends with: [{ kind, figures }], the figures by role as the text of their elements.
const meanings = (table, line) => {
  const { frame, figures } = lineOf(line)
  const found = []

  for (const [kind, words] of Object.entries(table)) {
    for (const form of [].concat(words)) {
      if (frame === form || frame.endsWith(` ${form}`)) {
        const names = placeholdersOf(form)
        const own = figures.slice(Math.max(0, figures.length - names.length))

        found.push({ kind, figures: Object.fromEntries(names.map((name, index) => [name, own[index] && own[index].role === name ? own[index].text : undefined])) })
      }
    }
  }

  return found
}

// The one meaning a line has by a table of the module. A line with figures writes none of them outside their elements, and no sign beside one: a sign belongs to the figure.
const meaning = (table, line, message) => {
  assert.ok(line !== undefined && line !== null, `${message}: nothing is shown`)

  const { frame } = lineOf(line)

  if (typeof line !== 'string') {
    assert.ok(!/\d/.test(frame.replace(/\{\w+\}/g, '')), `${message}: "${frame}" writes a figure outside its element`)
    assert.ok(!/[-+\u2212]\s*\{\w+\}/.test(frame), `${message}: "${frame}" writes a sign beside a figure, outside its element`)
  }

  const found = meanings(table, line)

  assert.equal(found.length, 1, `${message}: "${frame}" reads as ${found.map((item) => item.kind).join(' and ') || 'nothing the module says'}`)

  return found[0]
}

// A figure on its own (a count, or a mass with its unit): the number it shows in tonnes where it has a unit, or no digit where the save gives none.
const figureOf = (ctx, text, expected, message, unit = false, grouping = ctx.grouping) => {
  if (expected === null) {
    assert.ok(text === undefined || !/\d/.test(text), `${message}: "${text}" shows a figure the save does not give`)

    return
  }

  const read = typeof text === 'string' ? quantityOf(text, grouping) : null

  assert.ok(read !== null, `${message}: "${text}" is no figure`)

  if (unit) {
    assert.ok(read.unit !== null && Object.prototype.hasOwnProperty.call(UNITS, read.unit), `${message}: "${text}" is in a unit the check does not know`)
  } else {
    assert.equal(read.unit, null, `${message}: "${text}" carries a unit`)
  }

  assert.equal(atTwoDecimals(read.value * (unit ? UNITS[read.unit] : 1)), expected, message)
}

// What the spec rules out: that an obsolete STO class can be upgraded directly ('no direct STO upgrade is claimed', the spec of AE-119-02: an obsolete STO is shown as a replacement review, never a direct upgrade). A clause that speaks of an upgrade must say that none is made.
// Clauses end at ; : , . ( ) a dash (an en dash, an em dash or a hyphen between spaces) or 'but'. A clause claims an upgrade when it speaks of one and carries no negation of its own, so a denial elsewhere in the sentence denies nothing here and the word order of a denial does not matter. A synonym of 'upgrade' (refitted in place) is out of reach of this guard: the word tables are human-reviewed prose.
const NEGATION = /\b(?:not|cannot|can't|no|never|unsupported)\b/i
const claimsUpgrade = (sentence) => String(sentence).split(/[;:,.()\u2013\u2014]|\s-\s|\bbut\b/i).some((clause) => /upgrad/i.test(clause) && !NEGATION.test(clause))

const massFigure = (value) => (value === null ? null : atTwoDecimals(value))

// What the table says of a comparison, as parts: the kind and the count of each, from the SQL oracle's facts.
const expectedGap = (ex) => {
  if (ex.state !== 'compared') {
    return [{ kind: ex.state === 'no-elements' ? 'no-elements' : `no-template:${ex.reason}`, n: undefined }]
  }

  const rows = Object.values(ex.classes)
  const parts = ['short', 'over', 'unknown'].map((status) => ({ kind: status, n: rows.filter((row) => row.status === status).length })).filter((part) => part.n > 0)

  return parts.length ? parts : [{ kind: 'complete', n: undefined }]
}
const gapMeaning = (ctx, shown, message) => {
  const table = { ...ctx.comp.GAP_TEXT, ...Object.fromEntries(Object.entries(ctx.comp.NO_TEMPLATE).map(([reason, words]) => [`no-template:${reason}`, words])) }
  const line = framed(shown)

  assert.ok(line !== undefined, `${message}: nothing is shown`)

  let used = 0

  return line.frame.split(ctx.comp.GAP_JOIN).map((part) => {
    const count = placeholdersOf(part).length
    const found = meaning(table, { frame: part, figures: line.figures.slice(used, used + count) }, message)
    const [figure] = Object.values(found.figures)

    used += count

    if (figure === undefined) {
      return { kind: found.kind, n: undefined }
    }

    const read = quantityOf(figure, UNGROUPED)

    assert.ok(read !== null && read.unit === null, `${message}: "${figure}" is no count`)

    return { kind: found.kind, n: read.value }
  })
}
// The kind of line the screen says of an obsolescence: a review names where its STO evidence is (the template lists the class, or only the formation holds it).
const obsolescenceKind = (ex) => (ex.flag === null ? 'unknown' : ex.flag === false ? 'current' : ex.review ? (ex.sto === 'template' ? 'review' : 'review-actual') : 'obsolete')

// The line that names the template of a basis: the basis's own label, then the template's name from the save (or its id where it has no name, or the fact that there is none).
const templateRead = (ctx, shown, which, ex, message) => {
  const label = ctx.comp.BASES.find((basis) => basis.value === which).text
  const line = framed(shown)

  assert.ok(line !== undefined && line.frame.startsWith(`${label}: `), `${message}: "${line && line.frame}" does not open with the label of the ${which} basis`)

  const rest = { frame: line.frame.slice(label.length + 2), figures: line.figures }

  if (ex.templateId === 0 || ex.templateId === null) {
    assert.equal(meaning(ctx.comp.TEMPLATE_TEXT, rest, message).kind, 'none', message)
  } else if (ex.templateName) {
    assert.equal(rest.frame, ex.templateName, message)
  } else {
    const found = meaning(ctx.comp.TEMPLATE_TEXT, rest, message)

    assert.equal(found.kind, 'unnamed', message)
    figureOf(ctx, found.figures.id, ex.templateId, `the id of the template of ${message}`, false, UNGROUPED)
  }
}

// The basis buttons as the screen shows them: each button's hook, the basis its words name in the module's own labels (`BASES`), and whether it is pressed; and the same of a screen where the `on` basis is pressed.
const basisRead = (ctx, basis) => basis.map((button) => [button.value, labelKey(button.text, Object.fromEntries(ctx.comp.BASES.map((entry) => [entry.value, entry.text]))), button.on])
const basisPressed = (on) => ['original', 'replacement'].map((value) => [value, value, value === on])

const near = (actual, expected, message = '') => assert.ok(actual === expected || (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) < 1e-9), `${message} ${actual} is not ${expected}`)

// A check: `run(ctx)` returns normally to pass and throws (assert) to fail. Who failed: scripts/lib/fault-credit.js. A fault is credited only when a check named for it fails by an assertion of its own, and the code under test is run only through `through` and `subjectModule`.
const results = []
const add = (id, name, run) => results.push({ id, name, run })

// ---------- the constructed race ----------

const RACE = 7
const GAME = 1
const TROOPS = { classes: [{ TroopCapacity: 100, Ships: 1 }, { TroopCapacity: 40, Ships: 2 }] }

let rowSequence = 0

const formationRow = (FormationID, OriginalTemplateID, ReplacementTemplateID) => ({ FormationID, Name: `Formation ${FormationID}`, Abbreviation: `F${FormationID}`, RaceID: RACE, GameID: GAME, OriginalTemplateID, ReplacementTemplateID, PopulationID: 1, ShipID: 0, ParentFormationID: 0 })
const elementRow = (FormationID, ClassID, Units) => ({ RowID: ++rowSequence, ElementID: rowSequence * 10, FormationID, ClassID, SpeciesID: 1, Units })
const classRow = (GroundUnitClassID, ClassName, Size, STOWeapon, ComponentA = 0) => ({ GroundUnitClassID, ClassName, Size, ComponentA, ComponentB: 0, ComponentC: 0, ComponentD: 0, STOWeapon })
const templateRow = (TemplateID, Name, Obsolete, RaceID = RACE) => ({ TemplateID, RaceID, Name, Abbreviation: Name.slice(0, 2), Obsolete })
const templateElementRow = (FormationTemplateID, ClassID, Units) => ({ FormationTemplateID, ClassID, Units })

// 18 formations over 14 templates. Classes: 10 Infantry (size 5), 11 Artillery (8), 12 Orbital Gun (6, an STO weapon), 13 Unsized (no size), 14 Heavy (500), 15 Battery (10, STO equipment in its slot), 16 Mystery (4, whether it holds an STO weapon is not stored). Templates: 31 Line (10x10, 11x2: mass 66), 32 Fortress (obsolete; 10x4, 12x2: 32), 33 Old Line (obsolete; 10x10: 50), 34 Unflagged (the flag is not stored; 10x1, 12x1: 11), 35 Empty, 36 of another race, 37 Odd (10x1, 13x1: the size of 13 is not stored), 38 Siege (14x1: 500), 39 Line B (as 31), 40 Battery (15x2: 20), 41 Old Battery (obsolete; 15x1, 10x2: 20), 42 Mystery (obsolete; 16x1, 10x1: 9), 43 Units unknown (10 with no units stored).
const constructedRows = () => {
  rowSequence = 0

  return {
    formations: [
      formationRow(1, 31, 33),
      formationRow(2, 31, 31),
      formationRow(3, 0, 0),
      formationRow(4, 36, 32),
      formationRow(5, 35, 34),
      formationRow(6, 31, 31),
      formationRow(7, 31, 31),
      formationRow(8, 777, -5),
      formationRow(9, 31, 31),
      formationRow(10, 38, 38),
      formationRow(11, 40, 41),
      formationRow(12, 42, 42),
      formationRow(13, 31, 39),
      formationRow(14, 33, 33),
      formationRow(15, 37, 37),
      formationRow(16, 43, 43),
      formationRow(17, 31, 31),
      formationRow(18, 44, 44),
    ],
    elements: [
      elementRow(1, 10, 6), elementRow(1, 11, 3),
      elementRow(2, 10, 10), elementRow(2, 11, 2),
      elementRow(3, 10, 2),
      elementRow(4, 10, 4), elementRow(4, 12, 1),
      elementRow(5, 10, 1), elementRow(5, 12, 1),
      elementRow(7, 10, null), elementRow(7, 11, 2),
      elementRow(8, 10, 3),
      elementRow(9, 14, 1),
      elementRow(10, 10, 10), elementRow(10, 11, 2),
      elementRow(11, 15, 1), elementRow(11, 10, 2),
      elementRow(12, 16, 1), elementRow(12, 10, 1),
      elementRow(13, 10, 10), elementRow(13, 11, 2),
      elementRow(14, 10, 10),
      elementRow(15, 10, 1),
      elementRow(16, 10, 1),
      elementRow(17, 10, 5), elementRow(17, 99, 1),
      elementRow(18, 10, 5), elementRow(18, 12, 1),
    ],
    classes: [
      classRow(10, 'Infantry', 5, 0),
      classRow(11, 'Artillery', 8, 0),
      classRow(12, 'Orbital Gun', 6, 7),
      classRow(13, 'Unsized', null, 0),
      classRow(14, 'Heavy', 500, 0),
      classRow(15, 'Battery', 10, 0, 41),
      classRow(16, 'Mystery', 4, null),
    ],
    components: [{ ComponentTypeID: 41, ComponentName: 'Surface-to-Orbit Weapon', Geosurvey: 0, Xenoarchaeology: 0, STO: 1 }],
    templates: [templateRow(31, 'Line', 0), templateRow(32, 'Fortress', 1), templateRow(33, 'Old Line', 1), templateRow(34, 'Unflagged', null), templateRow(35, 'Empty', 0), templateRow(36, 'Foreign', 1, 8), templateRow(37, 'Odd', 0), templateRow(38, 'Siege', 0), templateRow(39, 'Line B', 0), templateRow(40, 'Battery', 0), templateRow(41, 'Old Battery', 1), templateRow(42, 'Mystery', 1), templateRow(43, 'Units unknown', 0), templateRow(44, 'Spent', 1)],
    templateElements: [
      templateElementRow(31, 10, 10), templateElementRow(31, 11, 2),
      templateElementRow(32, 10, 4), templateElementRow(32, 12, 2),
      templateElementRow(33, 10, 10),
      templateElementRow(34, 10, 1), templateElementRow(34, 12, 1),
      templateElementRow(36, 10, 1),
      templateElementRow(37, 10, 1), templateElementRow(37, 13, 1),
      templateElementRow(38, 14, 1),
      templateElementRow(39, 10, 10), templateElementRow(39, 11, 2),
      templateElementRow(40, 15, 2),
      templateElementRow(41, 15, 1), templateElementRow(41, 10, 2),
      templateElementRow(42, 16, 1), templateElementRow(42, 10, 1),
      templateElementRow(43, 10, null),
      templateElementRow(44, 10, 5),
    ],
    populations: [{ PopulationID: 1, PopName: 'Alpha Prime', RaceID: RACE, SystemID: 50, SystemBodyID: 5, SystemName: 'Sol' }],
  }
}

const compared = (ctx, id, which, troops = TROOPS) => ctx.comp.compareFormation(ctx.node(id), which, troops)
// The class rows of a comparison by class id; a class the comparison does not list fails the assertion that asks for it, and is no exception of the harness.
const byClass = (comparison) => {
  const rows = Object.fromEntries(comparison.classes.map((row) => [row.classId, row]))

  const get = (target, key) => {
    if (typeof key === 'string' && /^\d+$/.test(key)) {
      assert.ok(key in target, `class ${key} is not listed`)
    }

    return target[key]
  }

  return new Proxy(rows, { get })
}

const FIGURES = ['actual', 'intended', 'deficit', 'excess', 'status']

// A class row's figures, as [actual, intended, deficit, excess, status].
const figuresOf = (row) => FIGURES.map((key) => row[key])

add('deficit-excess', 'an incomplete formation shows exact deficits and excess by class, the short ones first', (ctx) => {
  const original = compared(ctx, 1, 'original')
  const rows = byClass(original)

  assert.equal(original.state, 'compared')
  assert.deepStrictEqual(figuresOf(rows[10]), [6, 10, 4, 0, 'short'])
  assert.deepStrictEqual(figuresOf(rows[11]), [3, 2, 0, 1, 'over'])
  assert.deepStrictEqual(original.totals, { short: 1, over: 1, unknown: 0, deficit: 4, excess: 1 })
  assert.deepStrictEqual(original.classes.map((row) => row.status), ['short', 'over'])

  const replacement = byClass(compared(ctx, 1, 'replacement'))

  assert.deepStrictEqual(figuresOf(replacement[10]), [6, 10, 4, 0, 'short'])
  assert.deepStrictEqual(figuresOf(replacement[11]), [3, 0, 0, 3, 'over'])

  const heavy = compared(ctx, 9, 'original')

  assert.deepStrictEqual(heavy.totals, { short: 2, over: 1, unknown: 0, deficit: 12, excess: 1 })
  assert.deepStrictEqual(heavy.classes.map((row) => row.status), ['short', 'short', 'over'])
  assert.equal(byClass(heavy)[14].intended, 0, 'a class the template does not hold is wanted in no unit')

  const siege = compared(ctx, 10, 'original')

  assert.deepStrictEqual(siege.totals, { short: 1, over: 2, unknown: 0, deficit: 1, excess: 12 })

  const stray = compared(ctx, 17, 'original')

  assert.deepStrictEqual(figuresOf(byClass(stray)[99]), [1, 0, 0, 1, 'over'])
  assert.equal(byClass(stray)[99].className, null)
})

add('basis-switch', 'switching the template changes the basis the formation is compared on', (ctx) => {
  const original = compared(ctx, 1, 'original')
  const replacement = compared(ctx, 1, 'replacement')

  assert.deepStrictEqual([original.which, replacement.which], ['original', 'replacement'])
  assert.deepStrictEqual([original.template.id, replacement.template.id], [31, 33])
  assert.deepStrictEqual([original.otherTemplate.id, replacement.otherTemplate.id], [33, 31])
  assert.notDeepEqual(replacement.totals, original.totals)
  assert.deepStrictEqual([original.intendedMass.value, replacement.intendedMass.value], [66, 50])
  assert.deepStrictEqual([original.massDifference, replacement.massDifference], [12, -4])
  assert.deepStrictEqual([original.actualMass.value, replacement.actualMass.value], [54, 54])
})

add('complete', 'a formation that holds exactly what the template calls for has no deficit and no excess', (ctx) => {
  for (const [id, which] of [[2, 'original'], [2, 'replacement'], [13, 'original'], [13, 'replacement'], [14, 'original']]) {
    const comparison = compared(ctx, id, which)

    assert.equal(comparison.state, 'compared')
    assert.deepStrictEqual(comparison.totals, { short: 0, over: 0, unknown: 0, deficit: 0, excess: 0 })
    assert.ok(comparison.classes.length > 0 && comparison.classes.every((row) => row.status === 'match' && row.deficit === 0 && row.excess === 0))
    assert.equal(ctx.comp.gapOf(comparison).order, 3)
  }
})

add('no-template', 'a template that is none, foreign, missing, not stored or empty gives no comparison and no deficit', (ctx) => {
  const cases = [[3, 'original', 'none'], [3, 'replacement', 'none'], [4, 'original', 'foreign'], [5, 'original', 'empty'], [8, 'original', 'missing'], [8, 'replacement', 'unknown']]

  for (const [id, which, reason] of cases) {
    const comparison = compared(ctx, id, which)

    assert.equal(comparison.state, 'no-template', `formation ${id} on ${which}`)
    assert.equal(comparison.reason, reason, `formation ${id} on ${which}`)
    assert.deepStrictEqual(comparison.classes, [])
    assert.deepStrictEqual(comparison.totals, { short: 0, over: 0, unknown: 0, deficit: 0, excess: 0 })
    assert.equal(comparison.intendedMass, null)
    assert.equal(comparison.massDifference, null)
    assert.equal(ctx.comp.gapOf(comparison).order, 4)
    assert.equal(comparison.obsolescence.review, false)
  }
})

add('no-elements', 'a formation the save holds no element rows for is not compared', (ctx) => {
  for (const which of ['original', 'replacement']) {
    const comparison = compared(ctx, 6, which)

    assert.equal(comparison.state, 'no-elements')
    assert.deepStrictEqual(comparison.classes, [])
    assert.deepStrictEqual(comparison.totals, { short: 0, over: 0, unknown: 0, deficit: 0, excess: 0 })
    assert.equal(comparison.massDifference, null)
    assert.equal(comparison.actualMass.value, null)
    assert.equal(ctx.comp.gapOf(comparison).order, 4)
  }
})

add('unknown-units', 'units the save does not store are unknown, never 0, and come into no total', (ctx) => {
  const comparison = compared(ctx, 7, 'original')
  const rows = byClass(comparison)

  assert.deepStrictEqual(figuresOf(rows[10]), [null, 10, null, null, 'unknown'])
  assert.deepStrictEqual(figuresOf(rows[11]), [2, 2, 0, 0, 'match'])
  assert.deepStrictEqual(comparison.totals, { short: 0, over: 0, unknown: 1, deficit: 0, excess: 0 })
  assert.equal(comparison.massDifference, null)
  assert.equal(ctx.comp.gapOf(comparison).order, 2)

  const intended = byClass(compared(ctx, 16, 'original'))

  assert.deepStrictEqual(figuresOf(intended[10]), [1, null, null, null, 'unknown'])
})

add('mass-reconcile', 'the mass reconciles with the element counts, unit by unit, on both bases', (ctx) => {
  let reconciled = 0

  for (const node of ctx.model().formations) {
    for (const which of ['original', 'replacement']) {
      const comparison = ctx.comp.compareFormation(node, which, TROOPS)

      if (comparison.state !== 'compared') {
        continue
      }

      const unitsActual = node.elements.reduce((total, item) => total + (item.units === null ? 0 : item.units), 0)
      const unitsListed = comparison.classes.reduce((total, row) => total + (row.actual === null ? 0 : row.actual), 0)

      assert.equal(unitsListed, unitsActual, `the units of formation ${node.id}`)

      const actualUnknown = comparison.classes.some((row) => row.actual === null || (row.actual > 0 && row.actualMass === null))

      assert.equal(node.mass.value === null, actualUnknown, `whether the mass of formation ${node.id} is known`)

      if (node.mass.value !== null) {
        near(comparison.classes.reduce((total, row) => total + (row.actual > 0 ? row.actualMass : 0), 0), node.mass.value, `the actual mass of formation ${node.id}`)
      }

      const template = node.templates[which]
      const intendedUnknown = comparison.classes.some((row) => row.intended === null || (row.intended > 0 && row.intendedMass === null))

      assert.equal(template.mass.value === null, intendedUnknown, `whether the intended mass of formation ${node.id} on ${which} is known`)

      if (template.mass.value !== null) {
        near(comparison.classes.reduce((total, row) => total + (row.intended > 0 ? row.intendedMass : 0), 0), template.mass.value, `the intended mass of formation ${node.id} on ${which}`)
        assert.equal(comparison.intendedMass.value, template.mass.value)
      }

      if (node.mass.value !== null && template.mass.value !== null) {
        near(comparison.massDifference, template.mass.value - node.mass.value, `the difference of formation ${node.id} on ${which}`)
      } else {
        assert.equal(comparison.massDifference, null)
      }

      reconciled++
    }
  }

  assert.equal(reconciled, 28, 'the compared formations of the constructed race')
})

add('unknown-size', 'a class with no size or units stored leaves the intended mass unknown and the counts exact', (ctx) => {
  const odd = compared(ctx, 15, 'original')

  assert.equal(odd.intendedMass.value, null)
  assert.equal(odd.massDifference, null)
  assert.deepStrictEqual(figuresOf(byClass(odd)[13]), [0, 1, 1, 0, 'short'])
  assert.equal(byClass(odd)[13].intendedMass, null)
  assert.equal(odd.actualMass.value, 5)
  assert.equal(odd.carry.intended.kind, 'unsized')

  const units = compared(ctx, 16, 'replacement')

  assert.equal(units.intendedMass.value, null)
  assert.equal(units.carry.intended.kind, 'unsized')
})

add('obsolete-flag', 'obsolescence is the flag of the chosen template, apart from whether the templates differ', (ctx) => {
  const flags = [[1, 'original', false], [1, 'replacement', true], [2, 'original', false], [4, 'replacement', true], [5, 'replacement', null], [14, 'original', true], [13, 'replacement', false], [11, 'original', false], [11, 'replacement', true]]

  for (const [id, which, flag] of flags) {
    assert.equal(compared(ctx, id, which).obsolescence.flag, flag, `formation ${id} on ${which}`)
  }

  const same = compared(ctx, 14, 'original')
  const apart = compared(ctx, 13, 'original')

  assert.deepStrictEqual([same.identity.sameTemplate, same.obsolescence.flag], [true, true])
  assert.deepStrictEqual([apart.identity.sameTemplate, apart.obsolescence.flag], [false, false])
  assert.equal(compared(ctx, 1, 'replacement').identity.sameTemplate, false)
  assert.equal(compared(ctx, 3, 'original').identity.sameTemplate, true)
  assert.equal(compared(ctx, 8, 'original').identity.sameTemplate, false)
})

add('replacement-review', 'an obsolete template with an STO class is a replacement review, and nothing else is', (ctx) => {
  const fortress = compared(ctx, 4, 'replacement')

  assert.equal(fortress.obsolescence.review, true)
  assert.deepStrictEqual(fortress.obsolescence.stoClasses, [{ classId: 12, className: 'Orbital Gun' }])
  assert.deepStrictEqual(fortress.obsolescence.templateSto, [{ classId: 12, className: 'Orbital Gun' }])
  assert.deepStrictEqual(fortress.obsolescence.actualOnlySto, [])
  assert.equal(byClass(fortress)[12].sto, true)
  assert.equal(byClass(fortress)[10].sto, false)

  const battery = compared(ctx, 11, 'replacement')

  assert.equal(battery.obsolescence.review, true, 'an STO class given by its equipment')
  assert.deepStrictEqual(battery.obsolescence.stoClasses, [{ classId: 15, className: 'Battery' }])

  for (const [id, which] of [[11, 'original'], [14, 'original'], [5, 'replacement'], [12, 'original'], [1, 'replacement'], [2, 'original']]) {
    assert.equal(compared(ctx, id, which).obsolescence.review, false, `formation ${id} on ${which}`)
  }

  assert.equal(compared(ctx, 5, 'replacement').obsolescence.stoClasses.length, 1, 'an STO class under a template whose flag is not stored is listed, and is no review')

  const mystery = compared(ctx, 12, 'replacement')

  assert.equal(mystery.obsolescence.unknownSto, 1)
  assert.equal(mystery.obsolescence.review, false, 'an obsolete template whose STO classes are not known')
  assert.equal(byClass(mystery)[16].sto, null)
  assert.deepStrictEqual(Object.keys(fortress.obsolescence).sort(), ['actualOnlySto', 'flag', 'review', 'sto', 'stoClasses', 'templateSto', 'unknownSto'], 'no upgrade is claimed')
})

add('obsolete-sto-source', 'the STO evidence of a replacement review says whether the template lists the STO class or only the formation holds it', (ctx) => {
  const ids = (list) => list.map((item) => item.classId)
  const spent = compared(ctx, 18, 'replacement')

  assert.equal(spent.obsolescence.flag, true)
  assert.equal(byClass(spent)[12].intended, 0, 'the template does not list the gun')
  assert.equal(byClass(spent)[12].actual, 1)
  assert.equal(spent.obsolescence.sto, 'actual')
  assert.equal(spent.obsolescence.review, true, 'an obsolete template with an STO class only the formation holds is a review')
  assert.deepStrictEqual(ids(spent.obsolescence.templateSto), [])
  assert.deepStrictEqual(ids(spent.obsolescence.actualOnlySto), [12])
  assert.deepStrictEqual(ids(spent.obsolescence.stoClasses), [12])

  const fortress = compared(ctx, 4, 'replacement')

  assert.equal(fortress.obsolescence.sto, 'template')
  assert.deepStrictEqual(ids(fortress.obsolescence.templateSto), [12])
  assert.deepStrictEqual(ids(fortress.obsolescence.actualOnlySto), [])
  assert.equal(compared(ctx, 11, 'replacement').obsolescence.sto, 'template', 'an STO class given by its equipment, listed by the template')

  for (const [id, which, sto, review] of [[18, 'original', 'actual', true], [14, 'original', 'none', false], [12, 'replacement', 'none', false], [5, 'replacement', 'template', false], [2, 'original', 'none', false]]) {
    assert.equal(compared(ctx, id, which).obsolescence.sto, sto, `the STO evidence of formation ${id} on ${which}`)
    assert.equal(compared(ctx, id, which).obsolescence.review, review, `the review of formation ${id} on ${which}`)
  }

  const kinds = ctx.comp.OBSOLESCENCE_TEXT

  assert.equal(meaning(kinds, ctx.comp.obsolescenceText(spent.obsolescence), 'the review of the actual-only class').kind, 'review-actual')
  assert.equal(meaning(kinds, ctx.comp.obsolescenceText(fortress.obsolescence), 'the review of the template class').kind, 'review')
})

add('carry', 'the formation fits one troop bay now and at the intended mass, or does not', (ctx) => {
  const kinds = (id, which = 'original') => {
    const comparison = compared(ctx, id, which)

    return [comparison.carry.now.kind, comparison.carry.intended.kind]
  }

  assert.deepStrictEqual(kinds(2), ['fits', 'fits'])
  assert.deepStrictEqual(kinds(9), ['oversize', 'fits'])
  assert.deepStrictEqual(kinds(10), ['fits', 'oversize'])
  assert.deepStrictEqual(kinds(7), ['unsized', 'fits'])
  assert.deepStrictEqual(kinds(6), ['unsized', 'fits'])
  assert.deepStrictEqual(kinds(3), ['fits', 'unsized'])
  assert.deepStrictEqual(compared(ctx, 9, 'original').carry.now, { kind: 'oversize', mass: 500, largest: 100 })
  assert.deepStrictEqual(compared(ctx, 10, 'original').carry.intended, { kind: 'oversize', mass: 500, largest: 100 })
  assert.deepStrictEqual(compared(ctx, 2, 'original', null).carry, { now: { kind: 'unknown', mass: 66, largest: null }, intended: { kind: 'unknown', mass: 66, largest: null } })
  assert.deepStrictEqual(compared(ctx, 2, 'original', { classes: [] }).carry.now.kind, 'no-bays')
})

add('troop-fit', 'one formation fits a bay when its mass is within the largest bay, and a zero mass with no bay does not loop', (ctx) => {
  const fit = ctx.comp.troopFit

  assert.deepStrictEqual(fit(100, TROOPS), { kind: 'fits', mass: 100, largest: 100 })
  assert.deepStrictEqual(fit(100.5, TROOPS), { kind: 'oversize', mass: 100.5, largest: 100 })
  assert.deepStrictEqual(fit(0, TROOPS), { kind: 'fits', mass: 0, largest: 100 })
  assert.equal(fit(null, TROOPS).kind, 'unsized')
  assert.equal(fit(5, null).kind, 'unknown')
  assert.equal(fit(0, { classes: [] }).kind, 'no-bays')
  assert.equal(fit(5, { classes: [] }).kind, 'no-bays')
  assert.equal(fit(null, { classes: [] }).kind, 'unsized')
  assert.equal(fit(5, { classes: [{ TroopCapacity: 100, Ships: 0 }] }).kind, 'no-bays', 'a class with no ship is no bay')
  assert.equal(fit(5, { classes: [{ TroopCapacity: 100, Ships: 2.5 }] }).kind, 'no-bays', 'a count of ships that is not whole is no bay')
  assert.equal(fit(5, { classes: [{ TroopCapacity: Number.NaN, Ships: 1 }] }).kind, 'no-bays')
  assert.equal(fit(0, { classes: [{ TroopCapacity: 10, Ships: 2 }, { TroopCapacity: 50, Ships: 0 }] }).largest, 10, 'the largest bay is one a ship has')
})

add('gap-order', 'the table orders the formations by what is short, then over, then unknown, then complete, then not compared', (ctx) => {
  const order = (id, which) => ctx.comp.gapOf(compared(ctx, id, which)).order

  assert.deepStrictEqual([order(1, 'original'), order(1, 'replacement'), order(11, 'original')], [0, 0, 0])
  assert.deepStrictEqual([order(10, 'replacement'), order(14, 'original')], [0, 3])
  assert.equal(order(17, 'original'), 0)
  assert.equal(order(7, 'original'), 2)
  assert.equal(order(2, 'original'), 3)
  assert.equal(order(3, 'original'), 4)
  assert.equal(order(6, 'original'), 4)

  const labels = new Set([compared(ctx, 1, 'original'), compared(ctx, 2, 'original'), compared(ctx, 3, 'original'), compared(ctx, 6, 'original'), compared(ctx, 7, 'original')].map((comparison) => ctx.comp.gapOf(comparison).label))

  assert.equal(labels.size, 5, 'each state reads differently')
})

// The sentences the module's builders write, judged by value with no page: the parts a builder gives (`lineOfParts`) are read back through the module's own tables of words by the readers the browser checks read the screen with (`framed`, `meaning`, `figureOf`, `gapMeaning`), so that a rewording changes nothing and a wrong figure, kind or sign does.
add('carry-text', 'the troop fit is written in the words of the module, its mass and its largest bay each a figure of its own in tonnes', (ctx) => {
  const written = (fit) => framed(lineOfParts(ctx.comp.carryParts(fit, String)))

  for (const [what, fit, kind, mass, largest] of [['formation 2 now', compared(ctx, 2, 'original').carry.now, 'fits', 66, 100], ['formation 9 now', compared(ctx, 9, 'original').carry.now, 'oversize', 500, 100]]) {
    const found = meaning(ctx.comp.CARRY_TEXT, written(fit), `the carry of ${what}`)

    assert.equal(found.kind, kind, `the carry of ${what}`)
    figureOf(ctx, found.figures.mass, mass, `the mass in the carry of ${what}`, true, UNGROUPED)
    figureOf(ctx, found.figures.largest, largest, `the largest bay in the carry of ${what}`, true, UNGROUPED)
  }

  for (const [fit, kind] of [[{ kind: 'no-bays', mass: 5, largest: null }, 'no-bays'], [{ kind: 'unsized', mass: null, largest: 100 }, 'unsized'], [{ kind: 'unknown', mass: 5, largest: null }, 'unknown']]) {
    assert.equal(meaning(ctx.comp.CARRY_TEXT, written(fit), `the carry that is ${kind}`).kind, kind)
  }
})

add('gap-text', 'the table states what is short, over, not known or complete in the words of the module, each with its own count', (ctx) => {
  for (const [id, expected] of [[1, [{ kind: 'short', n: 1 }, { kind: 'over', n: 1 }]], [9, [{ kind: 'short', n: 2 }, { kind: 'over', n: 1 }]], [7, [{ kind: 'unknown', n: 1 }]], [2, [{ kind: 'complete', n: undefined }]]]) {
    assert.deepStrictEqual(gapMeaning(ctx, lineOfParts(ctx.comp.gapOf(compared(ctx, id, 'original')).parts), `what the table says of formation ${id}`), expected, `what the table says of formation ${id}`)
  }
})

add('comparison-text', 'the reason a comparison is not made and whether the templates differ are said in the words of the module', (ctx) => {
  for (const [id, which, kind] of [[6, 'original', 'no-elements'], [3, 'original', 'none'], [4, 'original', 'foreign'], [5, 'original', 'empty'], [8, 'original', 'missing'], [8, 'replacement', 'unknown']]) {
    assert.equal(labelKey(ctx.comp.noComparisonText(compared(ctx, id, which)), ctx.comp.NOT_COMPARED_TEXT), kind, `why formation ${id} on ${which} is not compared`)
  }

  for (const [id, kind] of [[14, 'same'], [13, 'differ']]) {
    assert.equal(labelKey(ctx.comp.identityText(compared(ctx, id, 'original')), ctx.comp.IDENTITY_TEXT), kind, `whether the templates of formation ${id} differ`)
  }
})

add('view', 'the basis is a view preference of the race, with a default and a stored value that is not offered dropped', (ctx) => {
  const view = ctx.comp.basisView

  assert.equal(view.scope, 'race')
  assert.equal(view.default, 'replacement')
  assert.equal(view.normalise('original'), 'original')
  assert.equal(view.normalise('replacement'), 'replacement')
  assert.equal(view.normalise('latest'), undefined)
  assert.equal(view.normalise(null), undefined)
  assert.deepStrictEqual(ctx.comp.BASES.map((basis) => basis.value), ['original', 'replacement'])
  assert.equal(new Set(ctx.comp.BASES.map((basis) => basis.text)).size, 2)
})

add('text-policy', 'no entry of the tables of words that speak of an obsolete or an STO class claims a direct upgrade', (ctx) => {
  for (const table of ['OBSOLESCENCE_TEXT', 'CARRY_TEXT', 'GAP_TEXT', 'NOT_COMPARED_TEXT', 'IDENTITY_TEXT']) {
    for (const [kind, words] of Object.entries(ctx.comp[table])) {
      for (const form of [].concat(words)) {
        assert.ok(!claimsUpgrade(form), `${table}.${kind}: "${form}" claims an upgrade`)
      }
    }
  }

  assert.ok(claimsUpgrade('STO classes can be upgraded directly.'), 'a claim of a direct upgrade is one')
  assert.ok(!claimsUpgrade('a replacement review, not a direct upgrade of the STO class.'), 'a denial of one is not')
  assert.ok(claimsUpgrade('The template is not current; its STO classes can be upgraded directly.'), 'a claim after an unrelated negation is one')
  assert.ok(claimsUpgrade('The template is not current but its STO classes can be upgraded directly.'), 'a claim after "but" is one')
  assert.ok(!claimsUpgrade('A direct upgrade of the STO class is not supported.'), 'a denial after the word is not a claim')
  assert.ok(!claimsUpgrade('these classes cannot be upgraded directly.'), 'cannot denies')
  assert.ok(!claimsUpgrade("these classes can't be upgraded directly."), "can't denies")
  assert.ok(!claimsUpgrade('no direct upgrade is available'), 'no denies')
  assert.ok(!claimsUpgrade('The template is obsolete.'), 'a sentence without the word is none')
  assert.ok(claimsUpgrade('No replacement review is needed: STO classes can be upgraded directly.'), 'a claim after a colon is one')
  assert.ok(claimsUpgrade('No replacement review is needed \u2014 STO classes can be upgraded directly.'), 'a claim after an em dash is one')
  assert.ok(claimsUpgrade('No replacement review is needed \u2013 STO classes can be upgraded directly.'), 'a claim after an en dash is one')
  assert.ok(claimsUpgrade('No replacement review is needed (STO classes can be upgraded directly).'), 'a claim in parentheses is one')
  assert.ok(claimsUpgrade('STO classes (not current) can be upgraded directly.'), 'a claim after a parenthesised negation is one')
  assert.ok(!claimsUpgrade('a replacement review: no direct upgrade is available.'), 'a denial after a colon is none')
  assert.ok(!claimsUpgrade('a replacement review \u2014 these classes cannot be upgraded directly.'), 'a denial after a dash is none')
})

add('figure-parser', 'a figure is read as the whole token it is (scripts/lib/browser-observe.js `readFigure`) with the word of its unit after it: its sign, grouping, decimals and unit, and anything else beside the digits is no figure', (ctx) => {
  const MINUS = '\u2212'
  const cases = [
    ['Tick', "5'749 t", { value: 5749, unit: 't' }],
    ['Tick', "5'749", { value: 5749, unit: null }],
    ['Comma', '5,749 tonnes', { value: 5749, unit: 'tonnes' }],
    ['Space', '5 749 t', { value: 5749, unit: 't' }],
    ['Dash', '5-749', { value: 5749, unit: null }],
    ['Dash', '-5-749 t', { value: -5749, unit: 't' }],
    ['None', '5749', { value: 5749, unit: null }],
    ['Tick', '1\'234\'567', { value: 1234567, unit: null }],
    ['Tick', '-5\'749 t', { value: -5749, unit: 't' }],
    ['Tick', `${MINUS}5'749 t`, { value: -5749, unit: 't' }],
    ['Tick', "+5'749 t", { value: 5749, unit: 't' }],
    ['Tick', '5.0', { value: 5, unit: null }],
    ['Tick', '5.0 t', { value: 5, unit: 't' }],
    ['Tick', '1.25', { value: 1.25, unit: null }],
    ['Tick', "5'749.50 t", { value: 5749.5, unit: 't' }],
    ['Tick', '0.5', { value: 0.5, unit: null }],
    ['Tick', '0', { value: 0, unit: null }],
  ]

  for (const [grouping, text, expected] of cases) {
    assert.deepStrictEqual(quantityOf(text, grouping), expected, `"${text}" in the grouping ${grouping}`)
  }

  for (const [grouping, text] of [['Tick', ''], ['Tick', 'Unknown'], ['Tick', '5,749 t'], ['Tick', "5'74 t"], ['Tick', "5'7490"], ['Tick', '5.'], ['Tick', '.5'], ['Tick', '\u20135 t'], ['Tick', '+-5'], ['Tick', '--5'], ['Tick', `${MINUS}${MINUS}5`], ['Tick', '\u22485 t'], ['Tick', '(5 t'], ['Tick', 'x5 t'], ['Tick', '5 t t'], ['Tick', '5 5'], ['Tick', '5 749 t'], ['Space', "5'749 t"], ['Tick', '5 t.'], ['Tick', ' 5 t'], ['Tick', '5t'], ['Tick', '1\u2028t'], ['Tick', '1\u2029t'], ['Tick', '1\u2028']]) {
    assert.equal(quantityOf(text, grouping), null, `"${text}" in the grouping ${grouping} is no figure`)
  }

  const id = ctx.comp.templateParts({ id: 1234, state: 'found', name: null }).find((part) => part.role === 'id')

  assert.deepStrictEqual(id && quantityOf(id.text, UNGROUPED), { value: 1234, unit: null }, `the id of an unnamed template as the module writes it ("${id && id.text}") is read in the grouping of the figures it writes with String`)
})

add('model-template', 'the model gives each template its mass, and each class its size and STO flag', (ctx) => {
  const model = ctx.model()
  const template = (id) => model.byId.get(1).templates.original.id === id ? model.byId.get(1).templates.original : model.formations.flatMap((node) => [node.templates.original, node.templates.replacement]).find((item) => item.id === id)

  assert.equal(template(31).mass.value, 66)
  assert.equal(template(32).mass.value, 32)
  assert.equal(template(34).mass.value, 11)
  assert.equal(template(37).mass.value, null)
  assert.ok(template(37).mass.unknown.length > 0)
  assert.equal(template(43).mass.value, null)
  assert.deepStrictEqual(template(32).elements.map((item) => [item.classId, item.units, item.size, item.mass, item.sto]), [[10, 4, 5, 20, false], [12, 2, 6, 12, true]])
  assert.equal(template(41).elements[0].sto, true, 'STO equipment makes an STO class')
  assert.equal(template(42).elements[0].sto, null, 'an STO weapon that is not stored leaves the class unknown')
  assert.deepStrictEqual(template(35).elements, [])
  assert.equal(template(35).mass.value, null)
  assert.equal(model.byId.get(5).templates.original.elements.length, 0)
  assert.equal(model.byId.get(5).templates.original.mass.value, null)
  assert.equal(model.byId.get(3).templates.original.mass, null)
  assert.equal(model.byId.get(4).templates.original.mass, null)
})

// ---------- the context of the checks ----------

const lazy = (make) => {
  let held

  return () => {
    if (held === undefined) {
      held = make()
    }

    return held
  }
}

// ---------- the saves ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => {
  raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)))
})

const runSql = (raw, sql, params = []) => new Promise((resolve, reject) => {
  raw.run(sql, params, (error) => (error ? reject(error) : resolve()))
})

const standIn = (raw) => ({ query: async (sql) => [await allRows(raw, sql)], close: () => new Promise((resolve) => raw.close(() => resolve())) })

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does.
const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(standIn(raw))))
})

// The saves, with the counts they are known to hold: the formations of the race, those whose original and replacement templates differ and those whose chosen template is obsolete and holds an STO class (a replacement review), on each basis. The combined save is the one that holds obsolete templates with STO classes.
const FIXTURES = [
  { file: 'AuroraDB.db', GameID: 140, RaceID: 784, formations: 3288, differing: 0, reviews: { original: 0, replacement: 0 } },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', GameID: 138, RaceID: 785, formations: 206, differing: 65, reviews: { original: 0, replacement: 0 } },
  { file: 'artifacts/combined-map/AuroraDB_combined_maps.db', GameID: 138, RaceID: 785, formations: 2553, differing: 1128, reviews: { original: 151, replacement: 3 } },
]

// The comparison of every formation worked out in SQL written here, apart from the module's: a function of a formation id and a basis that gives { state, reason, templateId, flag, classes (by class id), actualMass, intendedMass, review, same }, and the largest bay the race's troop ships hold.
const oracleOf = async (database, GameID, RaceID) => {
  const q = async (sql) => (await database.query(sql))[0]
  const own = `select FormationID from FCT_GroundUnitFormation where GameID = ${GameID} and RaceID = ${RaceID}`
  const formations = await q(`select FormationID as id, OriginalTemplateID as original, ReplacementTemplateID as replacement from FCT_GroundUnitFormation where GameID = ${GameID} and RaceID = ${RaceID}`)
  const elements = await q(`select FormationID as owner, ClassID as class, sum(Units) as units, sum(case when Units is null then 1 else 0 end) as nulls from FCT_GroundUnitFormationElement where FormationID in (${own}) group by FormationID, ClassID`)
  const templates = await q(`select TemplateID as id, RaceID as race, Name as name, Obsolete as obsolete from FCT_GroundUnitFormationTemplate where GameID = ${GameID}`)
  const parts = await q(`select FormationTemplateID as owner, ClassID as class, sum(Units) as units, sum(case when Units is null then 1 else 0 end) as nulls from FCT_GroundUnitFormationElementTemplates where GameID = ${GameID} group by FormationTemplateID, ClassID`)
  const classes = await q('select k.GroundUnitClassID as id, k.Size as size, case when k.STOWeapon > 0 then 1 when exists (select 1 from DIM_GroundComponentType d where d.STO > 0 and d.ComponentTypeID in (k.ComponentA, k.ComponentB, k.ComponentC, k.ComponentD)) then 1 when k.STOWeapon is null then null else 0 end as sto from FCT_GroundUnitClass k')
  const largest = (await q(`select max(c.TroopCapacity) as largest from FCT_ShipClass c where c.GameID = ${GameID} and c.RaceID = ${RaceID} and c.TroopCapacity > 0 and exists (select 1 from FCT_Ship s where s.ShipClassID = c.ShipClassID and s.ShippingLineID = 0)`))[0].largest
  const group = (rows) => rows.reduce((map, row) => map.set(row.owner, [...(map.get(row.owner) || []), row]), new Map())
  const ofFormation = group(elements)
  const ofTemplate = group(parts)
  const templateById = new Map(templates.map((row) => [row.id, row]))
  const classById = new Map(classes.map((row) => [row.id, row]))
  const formationById = new Map(formations.map((row) => [row.id, row]))
  const sizeOf = (id) => (classById.has(id) && classById.get(id).size !== null && classById.get(id).size >= 0 ? classById.get(id).size : null)
  const unitsOf = (row) => (row.nulls > 0 ? null : row.units)
  const massOf = (rows) => {
    let total = 0

    for (const row of rows) {
      const units = unitsOf(row)
      const size = sizeOf(row.class)

      if (units === null || size === null) {
        return null
      }

      total += units * size
    }

    return total
  }
  const fit = (mass) => (mass === null ? 'unsized' : largest === null ? 'no-bays' : mass <= largest ? 'fits' : 'oversize')
  const of = (id, which) => {
    const formation = formationById.get(id)
    const templateId = formation[which]
    const same = formation.original === formation.replacement
    const own = ofFormation.get(id) || []
    const actualMass = own.length ? massOf(own) : null
    const base = { templateId, templateName: templateById.has(templateId) ? templateById.get(templateId).name : null, same, classes: {}, flag: null, review: false, sto: 'none', stoTemplate: [], stoActual: [], actualMass, fitNow: fit(actualMass), intendedMass: null }
    const template = templateById.get(templateId)
    const wanted = ofTemplate.get(templateId) || []

    if (templateId === 0) {
      return { ...base, state: 'no-template', reason: 'none' }
    }

    if (!template) {
      return { ...base, state: 'no-template', reason: 'missing' }
    }

    if (template.race !== RaceID) {
      return { ...base, state: 'no-template', reason: 'foreign' }
    }

    if (!wanted.length) {
      return { ...base, state: 'no-template', reason: 'empty' }
    }

    if (!own.length) {
      return { ...base, state: 'no-elements', reason: null }
    }

    const ids = [...new Set([...own.map((row) => row.class), ...wanted.map((row) => row.class)])]
    const classesOf = {}

    for (const classId of ids) {
      const actualRow = own.find((row) => row.class === classId)
      const intendedRow = wanted.find((row) => row.class === classId)
      const actual = actualRow ? unitsOf(actualRow) : 0
      const intended = intendedRow ? unitsOf(intendedRow) : 0
      const known = actual !== null && intended !== null
      const size = sizeOf(classId)
      const sto = classById.has(classId) ? classById.get(classId).sto : null

      classesOf[classId] = { actual, intended, deficit: known ? Math.max(0, intended - actual) : null, excess: known ? Math.max(0, actual - intended) : null, status: !known ? 'unknown' : intended > actual ? 'short' : actual > intended ? 'over' : 'match', actualMass: actual !== null && size !== null ? actual * size : null, intendedMass: intended !== null && size !== null ? intended * size : null, sto: sto === null ? null : sto === 1 }
    }

    const flag = template.obsolete === null ? null : Boolean(template.obsolete)

    const listed = new Set(wanted.map((row) => row.class))
    const stoOf = (inside) => Object.entries(classesOf).filter(([classId, row]) => row.sto === true && listed.has(Number(classId)) === inside).map(([classId]) => Number(classId)).sort((a, b) => a - b)
    const stoTemplate = stoOf(true)
    const stoActual = stoOf(false)
    const sto = stoTemplate.length ? 'template' : stoActual.length ? 'actual' : 'none'

    return { ...base, state: 'compared', reason: null, classes: classesOf, flag, review: flag === true && sto !== 'none', sto, stoTemplate, stoActual, intendedMass: massOf(wanted), fitNow: fit(base.actualMass), fitIntended: fit(massOf(wanted)) }
  }

  return { of, ids: formations.map((row) => row.id).sort((a, b) => a - b), largest, fit, differing: formations.filter((row) => row.original !== row.replacement).length }
}

// The first way a comparison of the module differs from the oracle's, or null.
const differenceOf = (comparison, expected) => {
  const say = (what, got, want) => `${what}: ${JSON.stringify(got)} is not ${JSON.stringify(want)}`

  if (comparison.state !== expected.state) {
    return say('state', comparison.state, expected.state)
  }

  if (comparison.reason !== expected.reason) {
    return say('reason', comparison.reason, expected.reason)
  }

  if (comparison.template.id !== expected.templateId) {
    return say('template', comparison.template.id, expected.templateId)
  }

  if (comparison.identity.sameTemplate !== expected.same) {
    return say('identity', comparison.identity.sameTemplate, expected.same)
  }

  if (comparison.actualMass.value !== expected.actualMass && !(typeof expected.actualMass === 'number' && Math.abs(comparison.actualMass.value - expected.actualMass) < 1e-6)) {
    return say('actual mass', comparison.actualMass.value, expected.actualMass)
  }

  if (comparison.carry.now.kind !== expected.fitNow) {
    return say('carry now', comparison.carry.now.kind, expected.fitNow)
  }

  if (comparison.state === 'compared' && comparison.carry.intended.kind !== expected.fitIntended) {
    return say('carry intended', comparison.carry.intended.kind, expected.fitIntended)
  }

  if (comparison.state !== 'compared') {
    return comparison.classes.length === 0 && comparison.totals.deficit === 0 && comparison.totals.excess === 0 ? null : 'a comparison that is not made holds classes or totals'
  }

  const got = byClass(comparison)
  const wanted = Object.keys(expected.classes).map(Number).sort((a, b) => a - b)

  if (JSON.stringify(Object.keys(got).map(Number).sort((a, b) => a - b)) !== JSON.stringify(wanted)) {
    return say('classes', Object.keys(got), wanted)
  }

  for (const classId of wanted) {
    for (const key of ['actual', 'intended', 'deficit', 'excess', 'status', 'sto']) {
      if (got[classId][key] !== expected.classes[classId][key]) {
        return say(`class ${classId} ${key}`, got[classId][key], expected.classes[classId][key])
      }
    }

    for (const key of ['actualMass', 'intendedMass']) {
      if (got[classId][key] !== expected.classes[classId][key] && !(typeof got[classId][key] === 'number' && Math.abs(got[classId][key] - expected.classes[classId][key]) < 1e-6)) {
        return say(`class ${classId} ${key}`, got[classId][key], expected.classes[classId][key])
      }
    }
  }

  const rows = Object.values(expected.classes)
  const totals = { short: rows.filter((row) => row.status === 'short').length, over: rows.filter((row) => row.status === 'over').length, unknown: rows.filter((row) => row.status === 'unknown').length, deficit: rows.reduce((sum, row) => sum + (row.deficit || 0), 0), excess: rows.reduce((sum, row) => sum + (row.excess || 0), 0) }

  if (JSON.stringify(comparison.totals) !== JSON.stringify(totals)) {
    return say('totals', comparison.totals, totals)
  }

  if (comparison.obsolescence.flag !== expected.flag) {
    return say('obsolete flag', comparison.obsolescence.flag, expected.flag)
  }

  if (comparison.obsolescence.review !== expected.review) {
    return say('review', comparison.obsolescence.review, expected.review)
  }

  if (comparison.obsolescence.sto !== expected.sto) {
    return say('STO evidence', comparison.obsolescence.sto, expected.sto)
  }

  for (const [key, want] of [['templateSto', expected.stoTemplate], ['actualOnlySto', expected.stoActual]]) {
    const got = comparison.obsolescence[key].map((item) => item.classId).sort((a, b) => a - b)

    if (JSON.stringify(got) !== JSON.stringify(want)) {
      return say(key, got, want)
    }
  }

  if (comparison.intendedMass.value !== expected.intendedMass && !(typeof expected.intendedMass === 'number' && Math.abs(comparison.intendedMass.value - expected.intendedMass) < 1e-6)) {
    return say('intended mass', comparison.intendedMass.value, expected.intendedMass)
  }

  return null
}

const SAVE_ENTRIES = FIXTURES.map((fixture, index) => ({ fixture, index }))

for (const { fixture, index } of SAVE_ENTRIES) {
  add(`save-${index}`, `${fixture.file} (game ${fixture.GameID}, race ${fixture.RaceID}): every comparison of every formation, on both bases, agrees with SQL written separately`, async (ctx) => {
    const held = ctx.saves[index]

    assert.ok(held, `${fixture.file} is not there`)

    const model = await ctx.saveModel(index)

    assert.equal(model.formations.length, fixture.formations, 'the formations of the race')
    assert.deepStrictEqual(held.oracle.ids, model.formations.map((node) => node.id).sort((a, b) => a - b))

    let compared = 0

    for (const node of model.formations) {
      for (const which of ['original', 'replacement']) {
        const difference = differenceOf(ctx.comp.compareFormation(node, which, held.troops), held.oracle.of(node.id, which))

        assert.equal(difference, null, `formation ${node.id} on ${which}: ${difference}`)

        if (held.oracle.of(node.id, which).state === 'compared') {
          compared++
        }
      }
    }

    assert.ok(compared > 0, 'a save in which no formation could be compared would show nothing')
  })

  add(`save-${index}-counts`, `${fixture.file}: the formations whose templates differ and the replacement reviews are the counts the save is known to hold`, async (ctx) => {
    const held = ctx.saves[index]

    assert.ok(held, `${fixture.file} is not there`)

    const model = await ctx.saveModel(index)
    const differing = model.formations.filter((node) => ctx.comp.compareFormation(node, 'original', held.troops).identity.sameTemplate === false).length

    assert.equal(differing, fixture.differing)
    assert.equal(held.oracle.differing, fixture.differing)

    for (const which of ['original', 'replacement']) {
      const reviews = model.formations.filter((node) => ctx.comp.compareFormation(node, which, held.troops).obsolescence.review).length

      assert.equal(reviews, fixture.reviews[which], `the replacement reviews on the ${which} basis are ${reviews}, not ${fixture.reviews[which]}`)
      assert.equal(model.formations.filter((node) => held.oracle.of(node.id, which).review).length, fixture.reviews[which])
    }
  })
}

// ---------- the page in a browser ----------

const BROWSER_SAVE = 1
const BROWSER_NAMES = { game: 'EggSample', race: 'EggSample' }
const BROWSER_TIMEOUT = 120000

// What the page on screen shows; runs in the page, through the shared readers of scripts/lib/browser-observe.js (`installScreen`: `visible`, `visibleText`, `hooked`). The hooks the template carries (data attributes) find the elements, never a heading or other wording, and only what a player can see counts: an element is on screen when it is `visible` or draws text of its own, and what it says is its `visibleText`. The decisions the hooks carry come back beside the words and figures the elements draw, and the checks read each decision from those words and figures too. `hidden` names the groups with a hook element that is there and not on screen; `grouping` is the page's setting of the thousands separator, in which its figures are read.
const readScreen = () => {
  const { visible, visibleText, hooked } = window.__screen
  const hidden = new Set()
  const on = (element) => Boolean(element) && (visible(element) || visibleText(element) !== '')
  const words = (element) => (on(element) ? visibleText(element) : undefined)
  const seen = (scope, selector, group) => {
    const all = [...scope.querySelectorAll(selector)]

    if (all.some((element) => !on(element))) {
      hidden.add(group)
    }

    return all.filter(on)
  }
  // A line that holds figures: its text, and each figure on screen in it by its role (`data-figure`), in the order the line draws them.
  const line = (element) => (on(element) ? { text: visibleText(element), figures: hooked(element, 'data-figure').filter((entry) => entry.on).map(({ role, text }) => ({ role, text })) } : undefined)
  const attribute = (scope, selector, name) => {
    const element = scope.querySelector(selector)

    return on(element) ? element.getAttribute(name) : undefined
  }
  const panels = [...document.querySelectorAll('.panel')].filter((panel) => panel.querySelector(':scope > .panel-head')).map((panel) => ({ compare: Boolean(panel.querySelector('[data-compare="basis"]')), summary: panel.getAttribute('data-summary') || '', visible: visible(panel) }))
  const toggle = document.querySelector('[data-compare="basis"]')
  const buttons = toggle ? seen(toggle, '[data-compare-basis]', 'basis').map((button) => ({ value: button.getAttribute('data-compare-basis'), on: button.classList.contains('v-btn--active'), text: words(button) })) : []
  const gaps = seen(document, '[data-compare-gap]', 'gaps').map((cell) => ({ id: Number(cell.getAttribute('data-compare-gap')), order: Number(cell.getAttribute('data-compare-order')), line: line(cell) }))
  const details = seen(document, '[data-compare="detail"]', 'details').map((cell) => {
    return {
      id: Number(cell.getAttribute('data-compare-formation')),
      templateId: attribute(cell, '[data-compare-template]', 'data-compare-template-id'),
      same: attribute(cell, '[data-compare-identity]', 'data-compare-same'),
      none: attribute(cell, '[data-compare-none]', 'data-compare-state') || null,
      tables: cell.querySelectorAll('[data-compare-classes]').length,
      shown: { headings: [...cell.querySelectorAll('th')].map((heading) => words(heading)), template: line(cell.querySelector('[data-compare-template]')), identity: words(cell.querySelector('[data-compare-identity]')), none: words(cell.querySelector('[data-compare-none]')), massActual: words(cell.querySelector('[data-figure="mass-actual"]')), massIntended: words(cell.querySelector('[data-figure="mass-intended"]')), carryNow: line(cell.querySelector('[data-compare-carry="now"]')), carryIntended: line(cell.querySelector('[data-compare-carry="intended"]')), obsolete: words(cell.querySelector('[data-compare="obsolete"]')), cells: seen(cell, '[data-compare-class]', 'classes').map((row) => ({ id: Number(row.getAttribute('data-compare-class-id')), cells: hooked(row, 'data-compare-cell') })) },
      classes: seen(cell, '[data-compare-class]', 'classes').map((row) => ({ id: Number(row.getAttribute('data-compare-class-id')), status: row.getAttribute('data-compare-status') })).sort((a, b) => a.id - b.id),
      carry: { now: attribute(cell, '[data-compare-carry="now"]', 'data-compare-fit') || null, intended: attribute(cell, '[data-compare-carry="intended"]', 'data-compare-fit') || null },
      obsolete: seen(cell, '[data-compare="obsolete"]', 'obsolete').map((element) => ({ flag: element.getAttribute('data-compare-flag'), review: element.getAttribute('data-compare-review') }))[0] || null,
    }
  })

  return { panels, basis: buttons, gaps, details, hidden: [...hidden].sort(), grouping: window.$app.$store.getters.config.get('selectedSeparator', 'Tick') }
}

// The parts of the page an observation may be narrowed to (`observePage` `parts`): the row of each planted formation by its key in the plan (its expander pressed, the screen read on both bases and back), and `restored` (the original basis left set, the page left and opened again). The opening screen and the remote only switch are read whatever the parts.
const PARTS = ['short', 'none', 'empty', 'obsolete', 'actualSto', 'restored']
const ROWS = PARTS.filter((part) => part !== 'restored')

// The parts each browser check reads beyond the opening screen and the presses every drive makes (browser-panels and browser-got-through read nothing else): a fault that names parts names, for each browser check it is caught by, at least one part that check reads, so that no check it names is skipped on its page (the head's check of the parts).
const READS = { 'browser-basis': ['short'], 'browser-gaps': ['short'], 'browser-switch': ['short'], 'browser-detail': ROWS, 'browser-obsolete': ROWS, 'browser-carry': ROWS, 'browser-none': ['none', 'empty'], 'browser-restored': ['restored'] }

// The page as a player uses it: the race is picked, the page opened on the system of the formations of `plan` (the link the table's own rows give), and for each formation its expander is pressed and the screen read on the replacement basis, then on the original basis (the toggle pressed) and back; then the original basis is left set, the page left for another and opened again, and the screen read once more. `parts` (a list of PARTS, or null for every part) narrows the drive to the rows and the restored screen it names: a fault names the parts its checks are caught on (MUTANTS), and the head and the rewrites drive every part. A control that is not there is recorded in `steps` (and the later reads show nothing): the observation goes on, so that the checks say what is missing. Resolves to the record of `observe` (scripts/lib/browser-observe.js) with the value { rows: { [id]: { replacement, original, back } }, initial, restored, steps }, `rows` holding the formations driven and `restored` undefined where it was not.
const observePage = (browser, url, plan, { timeout = BROWSER_TIMEOUT, viewport = null, shot = null, parts = null } = {}) => observe(browser, async ({ page, step }) => {
  const settle = () => {
    step('waiting for the page to settle')

    return settled(page, { limit: timeout, loading: pageLoading })
  }
  const route = `/survey-progress?formations=${plan.system}`
  const go = async (target) => {
    step(`opening ${target}`)
    await page.evaluate((to) => window.$app.$router.push(to, () => {}, () => {}), target)
    await page.waitForFunction(pageLoading.arrived, target, { timeout })

    if (target.startsWith('/survey-progress')) {
      await page.waitForSelector('[data-compare="basis"]', { state: 'attached', timeout })
      await page.waitForSelector('[data-compare-gap]', { state: 'attached', timeout })
    }

    await settle()
  }
  const steps = []
  // A press, then the change it is for, read once the page's own work is done: `until` is { what, done, arg, before }, `done` a condition on the page (given { arg, before }, `before` what `until.before` read just before the click). The control is pressed when it is on screen and enabled once the page has settled, and the change is read once after the page has settled again: a control that is not there is not pressed and a change that has not come is not reached, at once, recorded with the condition named, and the observation goes on so that the checks say what is missing. Only the settling and the click are bounded, by the observation's timeout, and either running out is a failure of the observation, never a press that missed.
  const press = async (name, selector, until) => {
    step(`pressing ${name}`)
    await settle()

    const before = until.before ? await page.evaluate(until.before, until.arg) : null
    const done = await page.evaluate((css) => { const element = document.querySelector(css); return Boolean(element) && window.__screen.visible(element) && !element.disabled }, selector)
    let reached = false

    if (done) {
      await page.locator(selector).first().click({ timeout })
      await page.evaluate(async () => { await window.$app.$nextTick() })
      step(`waiting for ${until.what}`)
      await settle()
      reached = await page.evaluate(until.done, { arg: until.arg, before })
    }

    steps.push({ name, done, reached, until: until.what })
    await page.evaluate(async () => { await window.$app.$nextTick() })

    return done
  }
  // The change each press is for. The remote only switch turns over and lists every planted formation; an expander puts the detail of its formation on screen, or takes it away; a basis button is active and the page compares on that basis.
  const listed = { what: 'the remote only switch turned over with every planted formation listed', before: () => { const input = document.querySelector('input[data-formations="remote"]'); return input ? input.checked : null }, done: ({ arg, before }) => { const input = document.querySelector('input[data-formations="remote"]'); return Boolean(input) && input.checked !== before && arg.every((id) => Boolean(document.querySelector(`[data-compare-gap="${id}"]`))) }, arg: plan.ids }
  const opened = (id) => ({ what: `the detail of formation ${id} on screen`, done: ({ arg }) => { const detail = document.querySelector(`[data-compare="detail"][data-compare-formation="${arg}"]`); return Boolean(detail) && window.__screen.visible(detail) }, arg: id })
  const closed = (id) => ({ what: `the detail of formation ${id} taken away`, done: ({ arg }) => !document.querySelector(`[data-compare="detail"][data-compare-formation="${arg}"]`), arg: id })
  const chosen = (value) => ({ what: `the ${value} basis active and compared on`, done: ({ arg }) => { const button = document.querySelector(`[data-compare="basis"] [data-compare-basis="${arg}"]`); const matched = window.$app.$route.matched; const shown = matched.length ? matched[matched.length - 1].instances.default : null; return Boolean(button) && button.classList.contains('v-btn--active') && Boolean(shown) && shown.formationBasis === arg }, arg: value })
  const read = () => {
    step('reading the screen')

    return page.evaluate(readScreen)
  }
  const basis = (value) => `[data-compare="basis"] [data-compare-basis="${value}"]`

  step('opening the app')
  await installScreen(page)
  await page.goto(url, { timeout })

  const picker = page.locator('.empire-list').first()

  step('picking the game')
  await picker.locator('.empire-list__game').filter({ hasText: `${BROWSER_NAMES.game} ·` }).first().click({ timeout })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    step('picking the race')
    await picker.getByText(BROWSER_NAMES.race, { exact: true }).last().click({ timeout })
  }

  step('waiting for the race')
  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout })
  await settle()
  await go(route)

  const seen = { initial: await read(), rows: {} }

  // The table lists the formations stationed at no colony by default; the switch is pressed so that the formations of the colonies are listed too.
  await press('the remote only switch', '.v-input--selection-controls__input:has(input[data-formations="remote"])', listed)

  for (const id of plan.ids.filter((one) => !parts || parts.some((key) => plan[key] === one))) {
    const entry = {}
    const expander = `tr:has([data-compare-gap="${id}"]) .v-data-table__expand-icon`

    await press(`the expander of ${id}`, expander, opened(id))
    entry.replacement = await read()

    if (shot && id === plan.ids[0]) {
      await page.locator('.panel:has([data-compare="basis"])').first().screenshot({ path: shot })
    }

    await press(`the original basis for ${id}`, basis('original'), chosen('original'))
    entry.original = await read()
    await press(`the replacement basis for ${id}`, basis('replacement'), chosen('replacement'))
    entry.back = await read()
    await press(`the expander of ${id} again`, expander, closed(id))
    seen.rows[id] = entry
  }

  if (!parts || parts.includes('restored')) {
    await press('the original basis', basis('original'), chosen('original'))
    await go('/propulsion')
    await go(route)
    seen.restored = await read()
  }

  seen.steps = steps

  return seen
}, viewport ? { viewport } : {})

// A copy of a save, changed so that one system holds formations in the states the page has to show. Resolves to { file, plan: { system, ids, short, none, empty, obsolete }, troops }, the ids being the formations F (short in one class and over in another on one basis, under an obsolete template that holds an STO class on the other), G (no template), H (no element rows) and K (under an obsolete template without an STO class). The changes are SQL on the copy; the troop bays are made as large as F's actual mass, so that F fits one bay now and not at the intended mass of the replacement template.
const plantedCopy = async (fixture) => {
  const file = path.join(os.tmpdir(), `ae-composition-${process.pid}.db`)

  fs.copyFileSync(path.resolve(root, fixture.file), file)

  const raw = await new Promise((resolve, reject) => {
    const opened = new sqlite3.Database(file, (error) => (error ? reject(error) : resolve(opened)))
  })
  const q = (sql) => allRows(raw, sql)
  const { GameID, RaceID } = fixture
  const sto = (id) => `(select 1 from FCT_GroundUnitClass k where k.GroundUnitClassID = ${id} and (k.STOWeapon > 0 or exists (select 1 from DIM_GroundComponentType d where d.STO > 0 and d.ComponentTypeID in (k.ComponentA, k.ComponentB, k.ComponentC, k.ComponentD))))`
  const candidates = await q(`select f.FormationID as id, f.OriginalTemplateID as original, f.ReplacementTemplateID as replacement, p.SystemID as system from FCT_GroundUnitFormation f inner join FCT_Population p on p.PopulationID = f.PopulationID where f.GameID = ${GameID} and f.RaceID = ${RaceID} and f.PopulationID > 0 and exists (select 1 from FCT_RaceSysSurvey s where s.SystemID = p.SystemID and s.RaceID = ${RaceID} and s.GameID = ${GameID}) and exists (select 1 from FCT_GroundUnitFormationElement e where e.FormationID = f.FormationID) order by p.SystemID, f.FormationID`)
  const totals = await q(`select p.SystemID as system, count(*) as n from FCT_GroundUnitFormation f inner join FCT_Population p on p.PopulationID = f.PopulationID where f.GameID = ${GameID} and f.RaceID = ${RaceID} group by p.SystemID`)
  const size = new Map(totals.map((row) => [row.system, row.n]))
  const classesOf = async (id) => (await q(`select ClassID as class, Units as units from FCT_GroundUnitFormationElement where FormationID = ${id} order by ElementID`))
  const holds = async (template, classId) => (await q(`select Units as units from FCT_GroundUnitFormationElementTemplates where GameID = ${GameID} and FormationTemplateID = ${template} and ClassID = ${classId}`))[0]
  const ownedTemplate = async (template) => (await q(`select 1 as ok from FCT_GroundUnitFormationTemplate where GameID = ${GameID} and TemplateID = ${template} and RaceID = ${RaceID}`)).length === 1
  const stoTemplate = async (template) => (await q(`select 1 as ok from FCT_GroundUnitFormationElementTemplates t where t.GameID = ${GameID} and t.FormationTemplateID = ${template} and exists ${sto('t.ClassID')}`)).length > 0
  const stoFormation = async (id) => (await q(`select 1 as ok from FCT_GroundUnitFormationElement e where e.FormationID = ${id} and exists ${sto('e.ClassID')}`)).length > 0
  let found = null

  for (const system of [...new Set(candidates.map((row) => row.system))]) {
    const here = candidates.filter((row) => row.system === system)

    if (size.get(system) < 4 || size.get(system) > 15 || here.length < 4) {
      continue
    }

    for (const F of here) {
      if (!(F.original > 0 && F.replacement > 0 && F.original !== F.replacement && await ownedTemplate(F.original) && await ownedTemplate(F.replacement))) {
        continue
      }

      const elements = await classesOf(F.id)
      const c1 = elements.find((item) => item.units >= 2)
      const c2 = elements.find((item) => c1 && item.class !== c1.class)

      if (!c1 || !c2 || !(await holds(F.original, c1.class)) || !(await holds(F.replacement, c1.class)) || !(await holds(F.original, c2.class)) || (await holds(F.original, c2.class)).units < 1 || await stoTemplate(F.original) || await stoTemplate(F.replacement) || await stoFormation(F.id)) {
        continue
      }

      let K = null

      for (const other of here.filter((row) => row.id !== F.id)) {
        if (other.replacement > 0 && other.replacement !== F.original && other.replacement !== F.replacement && await ownedTemplate(other.replacement) && !(await stoTemplate(other.replacement)) && !(await stoFormation(other.id)) && !(await holds(other.replacement, c1.class)) && !(await classesOf(other.id)).some((item) => item.class === c1.class)) {
          K = other

          break
        }
      }

      const rest = here.filter((row) => row.id !== F.id && (!K || row.id !== K.id))

      let J = null

      for (const other of rest.slice(2)) {
        if (other.replacement > 0 && ![F.original, F.replacement, K.replacement].includes(other.replacement) && await ownedTemplate(other.replacement) && !(await stoTemplate(other.replacement)) && !(await stoFormation(other.id)) && !(await holds(other.replacement, c1.class)) && (await classesOf(other.id)).length > 0 && !(await classesOf(other.id)).some((item) => item.class === c1.class)) {
          J = other

          break
        }
      }

      if (K && J && rest.length >= 3) {
        found = { system, F, c1, c2, K, J, G: rest[0], H: rest[1] }

        break
      }
    }

    if (found) {
      break
    }
  }

  if (!found) {
    throw new HarnessError(`${fixture.file} holds no system with the formations the browser check needs`)
  }

  const { F, c1, c2, K, J, G, H } = found

  for (const statement of [
    `update FCT_GroundUnitFormationElement set Units = Units - 1 where FormationID = ${F.id} and ClassID = ${c1.class}`,
    `update FCT_GroundUnitFormationElementTemplates set Units = Units + 3 where GameID = ${GameID} and FormationTemplateID = ${F.replacement} and ClassID = ${c1.class}`,
    `update FCT_GroundUnitFormationElementTemplates set Units = Units - 1 where GameID = ${GameID} and FormationTemplateID = ${F.original} and ClassID = ${c2.class}`,
    `update FCT_GroundUnitFormationTemplate set Obsolete = 0 where GameID = ${GameID} and TemplateID = ${F.original}`,
    `update FCT_GroundUnitFormationTemplate set Obsolete = 1 where GameID = ${GameID} and TemplateID in (${F.replacement}, ${K.replacement})`,
    `update FCT_GroundUnitClass set STOWeapon = 1 where GroundUnitClassID = ${c1.class}`,
    `update FCT_GroundUnitFormation set OriginalTemplateID = 0, ReplacementTemplateID = 0 where FormationID = ${G.id}`,
    `delete from FCT_GroundUnitFormationElement where FormationID = ${H.id}`,
    `update FCT_GroundUnitFormationTemplate set Obsolete = 1 where GameID = ${GameID} and TemplateID = ${J.replacement}`,
    `update FCT_GroundUnitFormationElement set ClassID = ${c1.class} where FormationID = ${J.id} and ElementID = (select min(ElementID) from FCT_GroundUnitFormationElement where FormationID = ${J.id})`,
  ]) {
    await runSql(raw, statement)
  }

  const mass = (await q(`select sum(e.Units * k.Size) as mass from FCT_GroundUnitFormationElement e inner join FCT_GroundUnitClass k on k.GroundUnitClassID = e.ClassID where e.FormationID = ${F.id}`))[0].mass

  await runSql(raw, `update FCT_ShipClass set TroopCapacity = ${mass} where GameID = ${GameID} and RaceID = ${RaceID} and TroopCapacity > 0`)
  await new Promise((resolve) => raw.close(() => resolve()))

  return { file, plan: { system: found.system, ids: [F.id, G.id, H.id, K.id, J.id], short: F.id, none: G.id, empty: H.id, obsolete: K.id, actualSto: J.id, c1: c1.class, c2: c2.class } }
}

// The value of the page's observation. An observation that failed in itself (the context did not open or close, the work threw: scripts/lib/fault-credit.js `unobserved`) has no screen to judge, so it is an error and no assertion of a check: the head fails on it, and a fault or a rewrite whose page did not get through stops the run (`judged`) instead of being credited, as a page that crashed changed no value a check reads.
const screenOf = (ctx) => {
  if (unobserved(ctx.browser)) {
    throw new Error(`the page did not get through: ${ctx.browser.error}`)
  }

  return ctx.browser.value
}

const shown = (ctx, id, which = 'replacement') => {
  const value = screenOf(ctx)
  const screen = value.rows[id] && value.rows[id][which]

  assert.ok(screen, `the screen of formation ${id} on the ${which} basis was not read`)

  return screen
}

// Whether the row of formation `id` was driven and read. A fault's page is driven on the parts its checks are caught on (MUTANTS `parts`), and a check skips a row or a screen that was not driven instead of failing on it, so that no part left out credits a fault; the head and the rewrites drive every part, which the head's check 'the head drives every part of the page' holds.
const wasRead = (ctx, id) => Boolean(screenOf(ctx).rows[id])
const readIds = (ctx) => ctx.plan.ids.filter((id) => wasRead(ctx, id))

// The lines of a list of the screen paired with the oracle's rows by identity (scripts/lib/browser-observe.js `pairedBy`): every row has one line of its own and every line is a row's. The pairs [row, line].
const paired = (what, lines, rows, idOfLine, idOfRow) => {
  const { pairs, problems } = pairedBy(what, lines, rows, idOfLine, idOfRow)

  assert.deepStrictEqual(problems, [], `${what}: the lines drawn are not the rows`)

  return pairs
}

// The text of each cell of a row by its role (`hooked` entries of `data-compare-cell`), from the elements on screen: a role drawn twice fails, and a role drawn by none is undefined.
const cellTexts = (entries, what) => {
  const drawn = entries.filter((entry) => entry.on)

  assert.equal(new Set(drawn.map((entry) => entry.role)).size, drawn.length, `${what}: a cell is drawn twice (${drawn.map((entry) => entry.role).join(', ')})`)

  return Object.fromEntries(drawn.map((entry) => [entry.role, entry.text]))
}

const detailOf = (screen, id) => {
  const detail = screen.details.find((item) => item.id === id)

  assert.ok(detail, `the comparison of formation ${id} is not on the screen (the details shown: ${screen.details.map((item) => item.id).join(', ') || 'none'})`)
  assert.equal(screen.details.length, 1, 'one row is expanded at a time')

  return detail
}

// Whether a detail says it is not compared, and why, as its words say it (the module's NOT_COMPARED_TEXT, read back by `labelKey`): null where no such sentence is drawn, the state the sentence stands for (`no-elements`, or `no-template` for a reason a template is missing), or what was drawn where it is no sentence of the table.
const notCompared = (ctx, text) => {
  if (text === undefined) {
    return null
  }

  const kind = labelKey(text, ctx.comp.NOT_COMPARED_TEXT)

  return kind === null ? `no sentence of the module: ${text}` : kind === 'no-elements' ? 'no-elements' : 'no-template'
}

// What the screen of a formation on a basis must show, from the oracle.
const expectedDetail = (expected) => ({
  none: expected.state === 'compared' ? null : expected.state,
  templateId: String(expected.templateId),
  classes: Object.entries(expected.classes).map(([id, row]) => ({ id: Number(id), status: row.status })).sort((a, b) => a.id - b.id),
  carry: { now: expected.fitNow, intended: expected.state === 'compared' ? expected.fitIntended : null },
  obsolete: expected.state === 'compared' ? { flag: String(expected.flag), review: String(expected.review) } : null,
})

add('browser-got-through', 'the page opens on the system of the formations and every control of the comparison is there', (ctx) => {
  const value = screenOf(ctx)

  assert.deepStrictEqual(ctx.browser.unexpected, [], 'the page raised errors no check named')
  const missed = value.steps.filter((item) => !item.reached).map((item) => (item.done ? `${item.name}: ${item.until} did not come` : `${item.name}: could not be pressed`))

  assert.deepStrictEqual(missed, [], `the presses that did not take effect: ${missed.join('; ')}`)
})

add('browser-panels', 'every panel of the page carries a summary, and the formations panel offers the comparison', (ctx) => {
  const value = screenOf(ctx)
  const { panels } = value.initial

  assert.ok(panels.length >= 3)
  assert.ok(panels.every((panel) => panel.summary.trim().length > 0 && panel.visible), `the panels with no summary: ${panels.filter((panel) => !panel.summary.trim()).length}`)
  assert.equal(panels.filter((panel) => panel.compare).length, 1)
  assert.deepStrictEqual(value.initial.hidden, [], 'the hooks that are there and are not on screen')
})

add('browser-basis', 'the basis toggle offers both templates, starts on the replacement and follows the presses', (ctx) => {
  const { initial } = screenOf(ctx)
  const short = wasRead(ctx, ctx.plan.short) ? [['the replacement basis', shown(ctx, ctx.plan.short, 'replacement').basis, 'replacement'], ['the original basis', shown(ctx, ctx.plan.short, 'original').basis, 'original'], ['the replacement basis again', shown(ctx, ctx.plan.short, 'back').basis, 'replacement']] : []

  assert.equal(new Set(initial.basis.map((button) => button.text)).size, initial.basis.length, 'each button names a different template')

  for (const [screen, basis, on] of [['the page as it opens', initial.basis, 'replacement'], ...short]) {
    assert.deepStrictEqual(basisRead(ctx, basis), basisPressed(on), `on ${screen}, each button names, in the module's own words, the template it offers, and the ${on} one is pressed`)
  }
})

add('browser-gaps', 'the table states, for every formation of the system, what the chosen basis says of it', (ctx) => {
  if (!wasRead(ctx, ctx.plan.short)) {
    return
  }

  const said = (which) => Object.fromEntries(shown(ctx, ctx.plan.short, which).gaps.map((gap) => [gap.id, gap.line && gap.line.text]))

  for (const which of ['replacement', 'original']) {
    const screen = shown(ctx, ctx.plan.short, which)

    for (const [id, gap] of paired(`the formations of the system on the ${which} basis`, screen.gaps, ctx.plan.rows, (line) => line.id, (row) => row)) {
      assert.equal(gap.order, ctx.expectedOrder(id, which), `the order of formation ${id} on the ${which} basis`)
      assert.deepStrictEqual(gapMeaning(ctx, gap.line, `what the table says of formation ${id} on the ${which} basis`), expectedGap(ctx.expected(id, which)), `what the table says of formation ${id} on the ${which} basis`)
    }
  }

  assert.notDeepEqual(said('replacement'), said('original'), 'switching the basis changes what the table says')
})

add('browser-detail', 'the expander shows the exact class figures and masses of each formation on the basis chosen', (ctx) => {
  for (const id of readIds(ctx)) {
    for (const which of ['replacement', 'original']) {
      const detail = detailOf(shown(ctx, id, which), id)
      const expected = expectedDetail(ctx.expected(id, which))

      assert.equal(detail.none, expected.none, `formation ${id} on ${which}`)
      assert.equal(notCompared(ctx, detail.shown.none), expected.none, `what the screen says of whether formation ${id} on ${which} is compared`)
      assert.equal(detail.templateId, expected.templateId, `the template shown for formation ${id} on ${which}`)
      assert.deepStrictEqual(detail.classes, expected.classes, `the classes of formation ${id} on ${which}`)

      const ex = ctx.expected(id, which)
      const message = `formation ${id} on ${which}`

      templateRead(ctx, detail.shown.template, which, ex, `the template line of ${message}`)
      assert.equal(labelKey(detail.shown.identity, ctx.comp.IDENTITY_TEXT), ex.same ? 'same' : 'differ', `what the screen says of the templates of ${message}`)
      figureOf(ctx, detail.shown.massActual, massFigure(ex.actualMass), `the actual mass of ${message}`, true)
      figureOf(ctx, detail.shown.massIntended, ex.state === 'compared' ? massFigure(ex.intendedMass) : null, `the intended mass of ${message}`, true)

      if (ex.state === 'compared') {
        const units = detail.shown.headings.map((heading) => (/\(([^)]*)\)/.exec(heading) || [])[1]).filter((unit) => unit !== undefined)

        assert.equal(units.length, 2, `the units the heading of the masses of ${message} gives`)
        units.forEach((unit) => assert.ok(UNITS[unit] === 1, `the masses of ${message} are headed in "${unit}", which is not tonnes`))
      }

      for (const [classId, row] of paired(`the classes written for ${message}`, detail.shown.cells, Object.keys(ex.classes).map(Number), (line) => line.id, (key) => key)) {
        const own = ex.classes[classId]
        const cells = cellTexts(row.cells, `class ${classId} of ${message}`)

        figureOf(ctx, cells.actual, own.actual, `the units held, class ${classId} of ${message}`)
        figureOf(ctx, cells.intended, own.intended, `the units wanted, class ${classId} of ${message}`)
        figureOf(ctx, cells.short, own.deficit, `the units short, class ${classId} of ${message}`)
        figureOf(ctx, cells.over, own.excess, `the units over, class ${classId} of ${message}`)
        figureOf(ctx, cells['mass-actual'], massFigure(own.actualMass), `the mass held, class ${classId} of ${message}`)
        figureOf(ctx, cells['mass-intended'], massFigure(own.intendedMass), `the mass wanted, class ${classId} of ${message}`)
      }
    }
  }

  if (wasRead(ctx, ctx.plan.short)) {
    const short = detailOf(shown(ctx, ctx.plan.short, 'original'), ctx.plan.short)
    const over = detailOf(shown(ctx, ctx.plan.short, 'replacement'), ctx.plan.short)

    assert.ok(short.classes.some((row) => row.status === 'short'), 'a class that is short')
    assert.ok(over.classes.some((row) => row.status === 'over') || short.classes.some((row) => row.status === 'over'), 'a class that is over')
  }
})

add('browser-switch', 'switching the template changes the basis the detail shows', (ctx) => {
  const id = ctx.plan.short

  if (!wasRead(ctx, id)) {
    return
  }

  const replacement = detailOf(shown(ctx, id, 'replacement'), id)
  const original = detailOf(shown(ctx, id, 'original'), id)
  const back = detailOf(shown(ctx, id, 'back'), id)

  assert.notEqual(replacement.templateId, original.templateId)
  assert.notDeepEqual(replacement.classes, original.classes)
  assert.notEqual(replacement.shown.template && replacement.shown.template.text, original.shown.template && original.shown.template.text, 'the template is named differently on the two bases')
  templateRead(ctx, replacement.shown.template, 'replacement', ctx.expected(id, 'replacement'), 'the replacement template of the formation')
  templateRead(ctx, original.shown.template, 'original', ctx.expected(id, 'original'), 'the original template of the formation')
  assert.deepStrictEqual(back, replacement)
  assert.equal(replacement.same, 'false')
  assert.equal(labelKey(replacement.shown.identity, ctx.comp.IDENTITY_TEXT), 'differ', 'what the screen says of the templates of the formation')
})

add('browser-none', 'a formation with no usable template or no elements is shown as not compared, with no class and no deficit', (ctx) => {
  for (const [id, state] of [[ctx.plan.none, 'no-template'], [ctx.plan.empty, 'no-elements']].filter(([id]) => wasRead(ctx, id))) {
    for (const which of ['replacement', 'original']) {
      const detail = detailOf(shown(ctx, id, which), id)

      assert.equal(detail.none, state)
      assert.equal(labelKey(detail.shown.none, ctx.comp.NOT_COMPARED_TEXT), state === 'no-elements' ? 'no-elements' : ctx.expected(id, which).reason, `what the screen says of formation ${id} on ${which}`)
      assert.deepStrictEqual(detail.classes, [])
      assert.equal(detail.tables, 0, 'no table of classes is drawn')
      assert.equal(detail.shown.massIntended, undefined, 'no intended mass is shown')
      assert.equal(detail.carry.intended, null)
      assert.equal(detail.obsolete, null)
    }
  }
})

add('browser-obsolete', 'an obsolete template with an STO class is a replacement review, an obsolete one without is not, and the identity of the templates is apart', (ctx) => {
  const short = ctx.plan.short

  if (wasRead(ctx, short)) {
    const flagged = detailOf(shown(ctx, short, 'replacement'), short).obsolete
    const unflagged = detailOf(shown(ctx, short, 'original'), short).obsolete

    assert.deepStrictEqual(flagged, { flag: 'true', review: 'true' })
    assert.deepStrictEqual(unflagged, { flag: 'false', review: 'false' })
  }

  if (wasRead(ctx, ctx.plan.obsolete)) {
    for (const which of ['replacement', 'original']) {
      const other = detailOf(shown(ctx, ctx.plan.obsolete, which), ctx.plan.obsolete)
      const expected = ctx.expected(ctx.plan.obsolete, which)

      assert.deepStrictEqual(other.obsolete, { flag: String(expected.flag), review: 'false' })
      assert.equal(other.same, String(expected.same))
      assert.equal(labelKey(other.shown.identity, ctx.comp.IDENTITY_TEXT), expected.same ? 'same' : 'differ', `what the screen says of the templates of the obsolete formation on ${which}`)
    }

    assert.equal(detailOf(shown(ctx, ctx.plan.obsolete, 'replacement'), ctx.plan.obsolete).obsolete.flag, 'true')
  }

  for (const id of readIds(ctx)) {
    for (const which of ['replacement', 'original']) {
      const detail = detailOf(shown(ctx, id, which), id)
      const ex = ctx.expected(id, which)
      const message = `the obsolescence of formation ${id} on ${which}`

      if (ex.state !== 'compared') {
        assert.equal(detail.shown.obsolete, undefined, message)
      } else {
        assert.equal(labelKey(detail.shown.obsolete, ctx.comp.OBSOLESCENCE_TEXT), obsolescenceKind(ex), `what the screen says of ${message}`)
        assert.ok(!claimsUpgrade(detail.shown.obsolete), `${message}: "${detail.shown.obsolete}" claims a direct upgrade`)
      }
    }
  }

  for (const [id, kind, message] of [[ctx.plan.short, 'review', 'an obsolete template with an STO class is told as a replacement review'], [ctx.plan.actualSto, 'review-actual', 'an STO class only the formation holds is told as such'], [ctx.plan.obsolete, 'obsolete', 'an obsolete template with no STO class is not']].filter(([id]) => wasRead(ctx, id))) {
    assert.equal(labelKey(detailOf(shown(ctx, id, 'replacement'), id).shown.obsolete, ctx.comp.OBSOLESCENCE_TEXT), kind, message)
  }
})

add('browser-carry', 'the detail says whether the formation fits one troop bay now and at the intended mass', (ctx) => {
  for (const id of readIds(ctx)) {
    for (const which of ['replacement', 'original']) {
      const detail = detailOf(shown(ctx, id, which), id)
      const expected = expectedDetail(ctx.expected(id, which))

      assert.deepStrictEqual(detail.carry, expected.carry, `formation ${id} on ${which}`)

      const ex = ctx.expected(id, which)
      const read = (shownLine, kind, mass, message) => {
        const line = framed(shownLine)
        const found = meaning(ctx.comp.CARRY_TEXT, line, message)
        const wanted = kind === 'fits' || kind === 'oversize' ? { mass: massFigure(mass), largest: massFigure(ctx.largest) } : {}

        assert.equal(found.kind, kind, `what the screen says of ${message}`)
        assert.deepStrictEqual(Object.keys(found.figures).sort(), Object.keys(wanted).sort(), `the figures written for ${message}`)

        for (const [role, figure] of Object.entries(wanted)) {
          figureOf(ctx, found.figures[role], figure, `the ${role} of ${message}`, true)
        }

        assert.ok(!claimsUpgrade(line.frame), `${message}: "${line.frame}" claims an upgrade`)
      }

      read(detail.shown.carryNow, ex.fitNow, ex.actualMass, `the carry now of formation ${id} on ${which}`)

      if (ex.state === 'compared') {
        read(detail.shown.carryIntended, ex.fitIntended, ex.intendedMass, `the carry at the intended mass of formation ${id} on ${which}`)
      } else {
        assert.equal(detail.shown.carryIntended, undefined, `no carry at an intended mass for formation ${id} on ${which}`)
      }
    }
  }

  if (wasRead(ctx, ctx.plan.short)) {
    const detail = detailOf(shown(ctx, ctx.plan.short, 'replacement'), ctx.plan.short)

    assert.deepStrictEqual(detail.carry, { now: 'fits', intended: 'oversize' })
  }
})

add('browser-restored', 'the basis left set is the one the page opens on again', (ctx) => {
  const { restored } = screenOf(ctx)

  if (restored === undefined) {
    return
  }

  assert.deepStrictEqual(basisRead(ctx, restored.basis), basisPressed('original'), 'once the basis is restored, each button names, in the module\'s own words, the template it offers, and the original one is pressed')

  for (const [id, gap] of paired('the formations of the system once the basis is restored', restored.gaps, ctx.plan.rows, (line) => line.id, (row) => row)) {
    assert.equal(gap.order, ctx.expectedOrder(id, 'original'), `the order of formation ${id} once the basis is restored`)
    assert.deepStrictEqual(gapMeaning(ctx, gap.line, `what the table says of formation ${id} once the basis is restored`), expectedGap(ctx.expected(id, 'original')), `what the table says of formation ${id} once the basis is restored`)
  }
})

// ---------- the faults and the rewrites ----------

// A fault or a benign rewrite: [name, from, to, file, the ids of the checks one of which must fail (a fault), browser (the page is served to the browser and driven), parts (a browser fault: the PARTS of the page its checks are caught on, the drive narrowed to them, with a part each browser check it names reads (READS); [] for the opening screen and the remote only switch alone)]. `from` and `to` may be lists of replacements made in order, each in `file` or, where `file` is a list too, in the file at its place. A rewrite names no parts: its page is driven on every part.
/* eslint-disable no-template-curly-in-string */
const MUTANTS = [
  ['the deficit is not worked out', 'Math.max(0, intended - actual)', '0', COMPOSITION_FILE, ['deficit-excess', 'complete', 'mass-reconcile', 'save-0', 'save-1', 'save-2']],
  ['the excess is not worked out', 'Math.max(0, actual - intended)', '0', COMPOSITION_FILE, ['deficit-excess', 'save-0', 'save-1', 'save-2']],
  ['a class that only the template holds is dropped', 'template.elements.forEach((item) => {\n    const found = row(item)', 'template.elements.filter((item) => rows.has(item.classId)).forEach((item) => {\n    const found = row(item)', COMPOSITION_FILE, ['deficit-excess', 'save-1', 'save-2']],
  ['a template with no elements is compared', "if (template.state !== 'found' || template.elements.length === 0) {", "if (template.state !== 'found') {", COMPOSITION_FILE, ['no-template']],
  ['a formation with no elements is compared', 'if (node.elements.length === 0) {', 'if (false) {', COMPOSITION_FILE, ['no-elements']],
  ['units that are not stored count as none', 'found.actualKnown = false', 'found.actual += 0', COMPOSITION_FILE, ['unknown-units']],
  ['the intended units that are not stored count as none', 'found.intendedKnown = false', 'found.intended += 0', COMPOSITION_FILE, ['unknown-units']],
  ['the classes are not ordered by their status', 'STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||', '', COMPOSITION_FILE, ['deficit-excess']],
  ['the table orders over before short', 'order: short ? 0 : over ? 1 : unknown ? 2 : 3', 'order: over ? 1 : short ? 0 : unknown ? 2 : 3', COMPOSITION_FILE, ['gap-order']],
  ['an unknown class is complete', "status: !known ? 'unknown' : deficit > 0 ? 'short' : excess > 0 ? 'over' : 'match'", "status: deficit > 0 ? 'short' : excess > 0 ? 'over' : 'match'", COMPOSITION_FILE, ['unknown-units']],
  ['the intended mass is the actual one', 'intendedMass: template.mass,\n    massDifference:', 'intendedMass: node.mass,\n    massDifference:', COMPOSITION_FILE, ['basis-switch', 'mass-reconcile']],
  ['the mass difference is reversed', 'template.mass.value - node.mass.value', 'node.mass.value - template.mass.value', COMPOSITION_FILE, ['basis-switch', 'mass-reconcile']],
  ['the obsolescence is read from the other template', 'obsolescence: obsolescenceOf(template, classes),', 'obsolescence: { ...obsolescenceOf(template, classes), flag: other.obsolete },', COMPOSITION_FILE, ['obsolete-flag']],
  ['the obsolescence is the identity of the templates', 'obsolescence: obsolescenceOf(template, classes),', 'obsolescence: { ...obsolescenceOf(template, classes), flag: sameTemplate(node.templates.original, node.templates.replacement) === false },', COMPOSITION_FILE, ['obsolete-flag']],
  ['every STO class is a review', "review: template.obsolete === true && sto !== 'none'", "review: sto !== 'none'", COMPOSITION_FILE, ['replacement-review']],
  ['a template whose flag is not stored is a review', "review: template.obsolete === true && sto !== 'none'", "review: template.obsolete !== false && sto !== 'none'", COMPOSITION_FILE, ['replacement-review']],
  ['every obsolete template is a review', "review: template.obsolete === true && sto !== 'none'", 'review: template.obsolete === true', COMPOSITION_FILE, ['replacement-review']],
  ['a class whose STO flag is not known is no STO class', 'stoRows = rows.filter((row) => row.sto === true)', 'stoRows = rows.filter((row) => row.sto !== false)', COMPOSITION_FILE, ['replacement-review']],
  ['the templates are the same when the ids differ', 'a.id === b.id : null', 'a.id !== b.id : null', COMPOSITION_FILE, ['obsolete-flag']],
  ['the carry at the intended mass is judged at the actual mass', 'intended: troopFit(template.mass.value, troops) },\n  }', 'intended: troopFit(node.mass.value, troops) },\n  }', COMPOSITION_FILE, ['carry']],
  ['a formation too large for every bay fits', ": planned.carried.length ? 'fits' : 'oversize'", ": 'fits'", COMPOSITION_FILE, ['carry', 'troop-fit']],
  ['a formation of no known mass fits', 'const known = isNumber(mass) ? mass : null', 'const known = isNumber(mass) ? mass : 0', COMPOSITION_FILE, ['carry', 'troop-fit']],
  ['a count of ships that is not whole makes a bay', 'Number.isInteger(item.Ships) && item.Ships > 0).map((item) => ({ TroopCapacity: item.TroopCapacity, Ships: item.Ships }))', 'Number.isFinite(item.Ships) && item.Ships >= 1).map((item) => ({ TroopCapacity: item.TroopCapacity, Ships: Math.floor(item.Ships) }))', COMPOSITION_FILE, ['troop-fit']],
  ['the troop ships that are not known read as none', "if (!troops) {\n    return { kind: 'unknown'", "if (!troops) {\n    return { kind: 'no-bays'", COMPOSITION_FILE, ['carry', 'troop-fit']],
  ['the default basis is the original template', "default: 'replacement'", "default: 'original'", COMPOSITION_FILE, ['view']],
  ['a stored basis that is not offered is kept', '(BASIS_KEYS.includes(stored) ? stored : undefined)', 'stored', COMPOSITION_FILE, ['view']],
  ['the template mass leaves out the first class', "figure(items, classes, figures, 'size') : { value: null", "figure(items.slice(1), classes, figures, 'size') : { value: null", GROUND_FILE, ['model-template', 'mass-reconcile', 'save-1', 'save-2']],
  ['no class is an STO class by its weapon', 'let found = known && row.STOWeapon > 0', 'let found = false', GROUND_FILE, ['model-template', 'replacement-review']],
  ['no class is an STO class by its equipment', '} else if (component && component.STO > 0) {', '} else if (false) {', GROUND_FILE, ['model-template', 'replacement-review']],
  ['a class that is not known to be STO is not an STO class', 'return found ? true : known ? false : null', 'return found', GROUND_FILE, ['model-template', 'replacement-review']],
  ['the formations panel has no summary', 'data-summary="Review ground formations', 'data-hint="Review ground formations', SURVEY_FILE, ['browser-panels'], true, []],
  ['the basis toggle is disconnected', 'v-model="formationBasis"', ':value="formationBasis"', SURVEY_FILE, ['browser-basis', 'browser-switch', 'browser-detail'], true, ['short']],
  ['the rows cannot be expanded', 'show-expand single-expand :expanded.sync="formationExpanded"', 'single-expand :expanded.sync="formationExpanded"', SURVEY_FILE, ['browser-got-through', 'browser-detail'], true, ['short']],
  ['the table compares with the original template whatever the toggle says', 'compareFormation(node, this.formationBasis, this.troopBays.troops)', "compareFormation(node, 'original', this.troopBays.troops)", SURVEY_FILE, ['browser-gaps', 'browser-detail', 'browser-switch'], true, ['short']],
  ['the column that orders the table orders nothing', 'gapOrder: this.formationCompared.get(row.id).gap.order', 'gapOrder: 0', SURVEY_FILE, ['browser-gaps'], true, ['short']],
  ['the column of the units short shows the excess', 'data-compare-cell="short">{{ unitsText(row.deficit) }}', 'data-compare-cell="short">{{ unitsText(row.excess) }}', SURVEY_FILE, ['browser-detail'], true, ['short']],
  ['the basis is not kept for the race', 'formationBasis: basisView,', 'formationBasis: { ...basisView, normalise: () => undefined },', SURVEY_FILE, ['browser-restored'], true, ['restored']],
  ['the obsolescence line is drawn with no opacity', 'class="caption" data-compare="obsolete"', 'class="caption" style="opacity:0" data-compare="obsolete"', SURVEY_FILE, ['browser-obsolete'], true, ['short']],
  ['the table of the classes is drawn with no opacity', 'class="mb-2" data-compare-classes>', 'class="mb-2" style="opacity:0" data-compare-classes>', SURVEY_FILE, ['browser-detail'], true, ['short']],
  ['the detail is put in a slot the table does not take', '<template #expanded-item="{ headers, item }">\n                <td :colspan="headers.length" class="py-3" data-compare="detail"', '<template #expanded-itemx="{ headers, item }">\n                <td :colspan="headers.length" class="py-3" data-compare="detail"', SURVEY_FILE, ['browser-detail'], true, ['short']],
  ['the replacement view is labelled as the original template', '{{ basisText(compareOf(item).which) }}', "{{ basisText('original') }}", SURVEY_FILE, ['browser-detail'], true, ['short']],
  ['the carry text gives a formation too large for the bay the verdict of one that fits', 'CARRY_TEXT[fit.kind], fit, tonnes(count))', "CARRY_TEXT[fit.kind === 'oversize' ? 'fits' : fit.kind], fit, tonnes(count))", COMPOSITION_FILE, ['carry-text']],
  ['the gap writes seven more classes short', "gapPart('short', short)", "gapPart('short', short + 7)", COMPOSITION_FILE, ['gap-text']],
  ['the gap writes the classes over as short', "over ? gapPart('over', over) : null", "over ? gapPart('short', over) : null", COMPOSITION_FILE, ['gap-text']],
  ['the obsolescence of a template with an STO class is told as an obsolete template', "obsolescence.review ? OBSOLESCENCE_TEXT[obsolescence.sto === 'actual' ? 'review-actual' : 'review'] : OBSOLESCENCE_TEXT.obsolete", "obsolescence.review ? OBSOLESCENCE_TEXT.obsolete : OBSOLESCENCE_TEXT[obsolescence.sto === 'actual' ? 'review-actual' : 'review']", COMPOSITION_FILE, ['obsolete-sto-source']],
  ['a formation with no elements is told as one with an empty template', "comparison.state === 'no-elements' ? 'no-elements' : comparison.reason]", "comparison.state === 'no-elements' ? 'empty' : comparison.reason]", COMPOSITION_FILE, ['comparison-text']],
  ['the templates that differ are told to be the same', 'sameTemplate === true ? IDENTITY_TEXT.same : comparison.identity.sameTemplate === false ? IDENTITY_TEXT.differ', 'sameTemplate === true ? IDENTITY_TEXT.differ : comparison.identity.sameTemplate === false ? IDENTITY_TEXT.same', COMPOSITION_FILE, ['comparison-text']],
  ['the replacement template carries the label of the original one', "text: 'Replacement template' }", "text: 'Original template' }", COMPOSITION_FILE, ['view', 'browser-basis']],
  ['the name of the other template is shown', 'templateOf(compareOf(item).template)', 'templateOf(compareOf(item).otherTemplate)', SURVEY_FILE, ['browser-detail', 'browser-switch'], true, ['short']],
  ['the carry builder writes the masses in kilograms', '`${count(value)} t`', '`${count(value)} kg`', COMPOSITION_FILE, ['carry-text']],
  ['the union of the classes is the template STO evidence', 'const templateSto = named(stoRows.filter((row) => listed.has(row.classId)))', 'const templateSto = named(stoRows)', COMPOSITION_FILE, ['obsolete-sto-source', 'browser-obsolete']],
  ['an STO class only the formation holds is shown as none', 'const actualOnlySto = named(stoRows.filter((row) => !listed.has(row.classId)))', 'const actualOnlySto = []', COMPOSITION_FILE, ['obsolete-sto-source', 'browser-obsolete']],
  ['the review of an actual-only STO class is worded as that of a template class', "obsolescence.review ? OBSOLESCENCE_TEXT[obsolescence.sto === 'actual' ? 'review-actual' : 'review'] : OBSOLESCENCE_TEXT.obsolete", 'obsolescence.review ? OBSOLESCENCE_TEXT.review : OBSOLESCENCE_TEXT.obsolete', COMPOSITION_FILE, ['obsolete-sto-source', 'browser-obsolete']],
  ['the obsolescence text is drawn by a child with no opacity', '{{ obsolescenceLabel(compareOf(item).obsolescence) }}</div>', '<span style="opacity: 0">{{ obsolescenceLabel(compareOf(item).obsolescence) }}</span></div>', SURVEY_FILE, ['browser-obsolete'], true, ['short']],
  ['the figures of the carry are drawn by a child with no opacity', 'At the intended mass: <span v-for="(part, index) in carryOf(compareOf(item).carry.intended)" :key="index" :data-figure="part.role">{{ part.text }}</span>', 'At the intended mass: <span v-for="(part, index) in carryOf(compareOf(item).carry.intended)" :key="index" :data-figure="part.role"><span :style="{ opacity: part.role ? 0 : 1 }">{{ part.text }}</span></span>', SURVEY_FILE, ['browser-carry'], true, ['short']],
  ['the figure of a mass is drawn by a child with no opacity', 'data-figure="mass-actual">{{ massText(compareOf(item).actualMass.value) }} t</span>', 'data-figure="mass-actual"><span style="opacity: 0">{{ massText(compareOf(item).actualMass.value) }} t</span></span>', SURVEY_FILE, ['browser-detail'], true, ['short']],
  ['the carry builder swaps the mass and the largest bay under a wording that names the bay first', ["fits: 'Fits one troop bay ({mass}; the largest holds {largest})'", "oversize: 'Fits no troop bay ({mass}; the largest holds {largest})'", 'partsOf(CARRY_TEXT[fit.kind], fit, tonnes(count))'], ["fits: 'Fits one troop bay (the largest holds {largest}; mass {mass})'", "oversize: 'Fits no troop bay (the largest holds {largest}; mass {mass})'", 'partsOf(CARRY_TEXT[fit.kind], { ...fit, mass: fit.largest, largest: fit.mass }, tonnes(count))'], COMPOSITION_FILE, ['carry-text']],
  ['the carry builder writes the mass with the sign U+2212', '`${count(value)} t`', '`\u2212${count(value)} t`', COMPOSITION_FILE, ['carry-text']],
  ['the entry for a carry that fits no bay puts a U+2212 before the mass', "oversize: 'Fits no troop bay ({mass}; the largest holds {largest})'", "oversize: 'Fits no troop bay (\u2212{mass}; the largest holds {largest})'", COMPOSITION_FILE, ['carry-text']],
  ['a class count is written with the sign U+2212', '<td class="text-right" data-compare-cell="actual">{{ unitsText(row.actual) }}</td>', '<td class="text-right" data-compare-cell="actual">\u2212{{ unitsText(row.actual) }}</td>', SURVEY_FILE, ['browser-detail'], true, ['short']],
  ['the caption writes the actual mass as the intended one', 'data-figure="mass-intended">{{ massText(compareOf(item).intendedMass.value) }} t</span>', 'data-figure="mass-intended">{{ massText(compareOf(item).actualMass.value) }} t</span>', SURVEY_FILE, ['browser-detail'], true, ['short']],
  ['the entry for a carry that fits writes a figure of its own', "fits: 'Fits one troop bay ({mass}; the largest holds {largest})'", "fits: 'Fits one troop bay (12 t; the largest holds {largest})'", COMPOSITION_FILE, ['carry-text']],
  ['the review claims an upgrade after a colon', "review: 'The template is marked obsolete and holds STO classes: a replacement review, not a direct upgrade of the STO class.'", "review: 'No replacement review is needed: STO classes can be upgraded directly.'", COMPOSITION_FILE, ['text-policy']],
  ['the review claims an upgrade after an em dash', "review: 'The template is marked obsolete and holds STO classes: a replacement review, not a direct upgrade of the STO class.'", "review: 'No replacement review is needed \u2014 STO classes can be upgraded directly.'", COMPOSITION_FILE, ['text-policy']],
  ['the review claims an upgrade in parentheses', "review: 'The template is marked obsolete and holds STO classes: a replacement review, not a direct upgrade of the STO class.'", "review: 'No replacement review is needed (STO classes can be upgraded directly).'", COMPOSITION_FILE, ['text-policy']],
  ['the review claims an upgrade after an unrelated negation', "review: 'The template is marked obsolete and holds STO classes: a replacement review, not a direct upgrade of the STO class.'", "review: 'The template is not current; its STO classes can be upgraded directly.'", COMPOSITION_FILE, ['text-policy']],
  ['the review is a claim of a direct upgrade', "review: 'The template is marked obsolete and holds STO classes: a replacement review, not a direct upgrade of the STO class.'", "review: 'STO classes can be upgraded directly.'", COMPOSITION_FILE, ['text-policy']],
  ['the caption writes the masses in kilograms', 'actualMass.value) }} t</span> actual', 'actualMass.value) }} kg</span> actual', SURVEY_FILE, ['browser-detail'], true, ['short']],
  ['the heading of the masses names kilograms', '<th class="text-right">Actual mass (t)</th>', '<th class="text-right">Actual mass (kg)</th>', SURVEY_FILE, ['browser-detail'], true, ['short']],
  ['a formation with no template shows classes', 'v-else dense class="mb-2"', 'dense class="mb-2"', SURVEY_FILE, ['browser-none'], true, ['none']],
  ['the remote only switch turns over and lists nothing more', '<v-switch v-model="remoteOnly"', '<v-switch :input-value="remoteOnly"', SURVEY_FILE, ['browser-got-through'], true, []],
  ['the basis buttons say the replacement template once the original basis is chosen', '{{ basis.text }}', "{{ formationBasis === 'original' ? bases.find((entry) => entry.value === 'replacement').text : basis.text }}", SURVEY_FILE, ['browser-basis', 'browser-restored'], true, ['short', 'restored']],
]

// One equivalent rewrite of each family, made together in the panel and its module so that the page is driven once for all of them: [file, from, to], made in order. The families the lane brief names: the toggle bound by an explicit prop and event instead of `v-model`, a listener written `v-on:`, a word moved in a sentence, synonyms in the generated prose, a sentence in parentheses. The controls the reviews asked for: the line and the table at full opacity (R119-1), the slot of the detail written long-hand (R119-1), each displayed binding written another way (R119-3), the label of a template in another word (R119-5), the review denied after a colon and after a dash in one sentence (R119-6), the review of an actual-only STO class reworded (R119-7), the carry worded with the largest bay first (R119-9), a mass with an explicit plus and in tonnes written in full, in the carry and in the heading (R119-8, R119-4), each text drawn by a child at full opacity (R161-9) and the kind of the review chosen the other way round. No two of them change the same text, apart from the obsolescence line and the carry at the intended mass, each drawn by a child and then written another way in the text the one before left, so a check that reads what one of them changes fails here as it fails on that one alone.
const EQUIVALENTS = [
  [SURVEY_FILE, 'v-model="formationBasis"', ':value="formationBasis" @change="formationBasis = $event"'],
  [SURVEY_FILE, 'no-data-text="No formation matches the roles and the scope chosen" @click:row="toggleRow"', 'no-data-text="No formation matches the roles and the scope chosen" v-on:click:row="toggleRow"'],
  [COMPOSITION_FILE, "fits: 'Fits one troop bay ({mass}; the largest holds {largest})'", "fits: 'Fits one troop bay (the largest holds {largest}; mass {mass})'"],
  [COMPOSITION_FILE, "oversize: 'Fits no troop bay ({mass}; the largest holds {largest})'", "oversize: 'Held by no troop bay (the largest holds {largest}; mass {mass})'"],
  [COMPOSITION_FILE, "unsized: 'The mass is not known'", "unsized: 'The mass is unknown'"],
  [COMPOSITION_FILE, "'no-bays': 'No troop ship has a bay'", "'no-bays': 'No troop ship holds a bay'"],
  [SURVEY_FILE, 'class="caption" data-compare="obsolete"', 'class="caption" style="opacity:1" data-compare="obsolete"'],
  [SURVEY_FILE, 'class="mb-2" data-compare-classes>', 'class="mb-2" style="opacity:1" data-compare-classes>'],
  [SURVEY_FILE, '<template #expanded-item="{ headers, item }">\n                <td :colspan="headers.length" class="py-3" data-compare="detail"', '<template v-slot:expanded-item="{ headers, item }">\n                <td :colspan="headers.length" class="py-3" data-compare="detail"'],
  [SURVEY_FILE, '{{ basis.text }}', '{{ bases.find((entry) => entry.value === basis.value).text }}'],
  [SURVEY_FILE, '{{ basisText(compareOf(item).which) }}', '{{ bases.find((basis) => basis.value === compareOf(item).which).text }}'],
  [SURVEY_FILE, '{{ obsolescenceLabel(compareOf(item).obsolescence) }}</div>', '<span style="opacity: 1">{{ obsolescenceLabel(compareOf(item).obsolescence) }}</span></div>'],
  [SURVEY_FILE, '{{ obsolescenceLabel(compareOf(item).obsolescence) }}', '{{ (obsolescenceLabel(compareOf(item).obsolescence)) }}'],
  [SURVEY_FILE, 'At the intended mass: <span v-for="(part, index) in carryOf(compareOf(item).carry.intended)" :key="index" :data-figure="part.role">{{ part.text }}</span>', 'At the intended mass: <span v-for="(part, index) in carryOf(compareOf(item).carry.intended)" :key="index" :data-figure="part.role"><span :style="{ opacity: part.role ? 1 : 1 }">{{ part.text }}</span></span>'],
  [SURVEY_FILE, 'carryOf(compareOf(item).carry.intended)', "carryOf(compareOf(item).carry['intended'])"],
  [SURVEY_FILE, '(part, index) in item.gapParts"', '(part, index) in [...item.gapParts]"'],
  [SURVEY_FILE, 'templateOf(compareOf(item).template)', "templateOf(compareOf(item)['template'])"],
  [SURVEY_FILE, 'data-figure="mass-actual">{{ massText(compareOf(item).actualMass.value) }} t</span>', 'data-figure="mass-actual"><span style="opacity: 1">{{ massText(compareOf(item).actualMass.value) }} t</span></span>'],
  [SURVEY_FILE, '<th class="text-right">Actual mass (t)</th>', '<th class="text-right">Actual mass (tonnes)</th>'],
  [SURVEY_FILE, '{{ identityLabel(compareOf(item)) }}', '{{ (identityLabel(compareOf(item))) }}'],
  [COMPOSITION_FILE, '`${count(value)} t`', '`+${count(value)} tonnes`'],
  [COMPOSITION_FILE, "review: 'The template is marked obsolete and holds STO classes: a replacement review, not a direct upgrade of the STO class.'", "review: 'The template is marked obsolete and holds STO classes: no direct upgrade is available \u2014 a replacement review, as these classes cannot be upgraded directly.'"],
  [COMPOSITION_FILE, "'review-actual': 'The template is marked obsolete and the formation holds STO classes the template does not list: a replacement review, not a direct upgrade of the STO class.'", "'review-actual': 'The template is marked obsolete and the formation holds STO classes the template does not list: it is a replacement review and not a direct upgrade of the STO class.'"],
  [COMPOSITION_FILE, "obsolescence.review ? OBSOLESCENCE_TEXT[obsolescence.sto === 'actual' ? 'review-actual' : 'review'] : OBSOLESCENCE_TEXT.obsolete", "obsolescence.review ? OBSOLESCENCE_TEXT[obsolescence.sto !== 'actual' ? 'review' : 'review-actual'] : OBSOLESCENCE_TEXT.obsolete"],
  [COMPOSITION_FILE, "'no-elements': 'The save holds no element rows for the formation, so its composition is not known and nothing is compared.'", "'no-elements': 'The save holds no element rows for the formation, so its composition is unknown and nothing is compared.'"],
  [COMPOSITION_FILE, "text: 'Original template' }", "text: 'Initial template' }"],
  [COMPOSITION_FILE, "'The original and replacement templates differ.'", "'The original and the replacement templates are two.'"],
]

// Rewrites that change nothing the checks observe: each must leave every check passing.
const BENIGN = [
  ['a parenthesised condition', "if (template.state !== 'found' || template.elements.length === 0) {", "if ((template.state !== 'found') || (template.elements.length === 0)) {", COMPOSITION_FILE],
  ['an equivalent test of the troop ships', 'if (!troops) {\n    return { kind: \'unknown\'', 'if (troops === null || troops === undefined) {\n    return { kind: \'unknown\'', COMPOSITION_FILE],
  ['one equivalent rewrite of each family, made together', EQUIVALENTS.map(([, from]) => from), EQUIVALENTS.map(([, , to]) => to), EQUIVALENTS.map(([file]) => file), [], true],
]
/* eslint-enable no-template-curly-in-string */

const cleanups = []

const finish = async (code) => {
  let failed = 0

  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failed++
      console.error(`cleanup failed: ${error && error.message ? error.message : error}`)
    }
  }

  process.exit(code || (failed ? 4 : 0))
}

// The formations the table shows for the link of a system: those at a colony in it, and those aboard a ship whose fleet is in it.
const rowsOfSystemSql = ({ GameID, RaceID }, system) => `select f.FormationID as id from FCT_GroundUnitFormation f where f.GameID = ${GameID} and f.RaceID = ${RaceID} and ((f.PopulationID > 0 and exists (select 1 from FCT_Population p where p.PopulationID = f.PopulationID and p.SystemID = ${system})) or (coalesce(f.PopulationID, 0) <= 0 and f.ShipID > 0 and (select coalesce(fl.SystemID, fm.SystemID) from FCT_Ship s left join FCT_Fleet fl on fl.FleetID = s.FleetID left join FCT_Ship ms on ms.ShipID = s.MothershipID left join FCT_Fleet fm on fm.FleetID = ms.FleetID where s.ShipID = f.ShipID) = ${system}))`

// What a worker sets up once before its first variant (`setUp`, run by the runner): the saves and their oracle, and in the browser a changed copy of a save, served by one page server (warmed) to one Chromium, with what the oracle holds of it. Its functions judge a variant of the sources. A start of the browser that does not get through is kept as `startFailure`, and every observation of the worker is then one that did not happen; a copy of the save that does not hold the planted formations is a defect of the harness, which fails the worker's setup.
let ENV = null

const setUp = async () => {
  const sources = { composition: fs.readFileSync(COMPOSITION_FILE, 'utf8'), ground: fs.readFileSync(GROUND_FILE, 'utf8'), survey: fs.readFileSync(SURVEY_FILE, 'utf8') }
  const texts = new Map()
  const loadedOf = (given) => loadUtilities(['ground-formations', 'formation-composition'], { stubs: STUBS, sources: { 'formation-composition': given.composition, 'ground-formations': given.ground }, texts })

  const databases = []
  const oracles = []

  for (const fixture of FIXTURES) {
    const database = await openSave(fixture.file)

    databases.push(database)
    oracles.push(database ? await oracleOf(database, fixture.GameID, fixture.RaceID) : null)
  }

  cleanups.push(() => Promise.all(databases.filter(Boolean).map((database) => database.close())))

  // The browser's save, changed as `plantedCopy` says, and what the oracle holds of it.
  let server = null
  let chrome = null
  let startFailure = null
  let planted = null
  let plantedDatabase = null
  let plantedOracle = null
  let plantedRows = null

  if (options.browser) {
    try {
      const fixture = FIXTURES[BROWSER_SAVE]

      planted = await plantedCopy(fixture)
      cleanups.push(async () => fs.rmSync(planted.file, { force: true }))
      plantedDatabase = await openSave(planted.file)
      cleanups.push(() => plantedDatabase.close())
      plantedOracle = await oracleOf(plantedDatabase, fixture.GameID, fixture.RaceID)
      plantedRows = (await plantedDatabase.query(rowsOfSystemSql(fixture, planted.plan.system)))[0].map((row) => row.id).sort((a, b) => a - b)

      if (plantedRows.length > 15 || planted.plan.ids.some((id) => !plantedRows.includes(id))) {
        throw new HarnessError(`the formations of system ${planted.plan.system} are ${plantedRows.join(', ')}`)
      }

      server = await startPageServer({ save: planted.file })
      cleanups.push(() => server.stop())
      chrome = await require('playwright').chromium.launch()
      cleanups.push(() => chrome.close())

      const warmed = await server.warm(chrome, { routes: ['/survey-progress'] })

      console.log(`INFO  the page server warmed in ${warmed.seconds.toFixed(1)} s, ${warmed.attempts} attempt${warmed.attempts === 1 ? '' : 's'}`)
    } catch (error) {
      if (error instanceof HarnessError) {
        throw error
      }

      startFailure = String(error.message).split('\n')[0]
    }
  }

  const env = { sources, server, chrome, planted, startFailure, baselineSeen: undefined }

  env.observeVariant = async (given, parts = null) => {
    if (startFailure) {
      return failedObservation(startFailure)
    }

    const served = [[SURVEY_FILE, given.survey, sources.survey], [COMPOSITION_FILE, given.composition, sources.composition]]
    const own = served.every(([, text, kept]) => text === kept)

    served.forEach(([file, text, kept]) => server.replace(file, text === kept ? null : text))

    try {
      const seen = await observePage(chrome, server.url, planted.plan, { parts })

      report(own ? 'the page' : 'a variant of the page', seen)

      return seen
    } finally {
      served.forEach(([file]) => server.replace(file, null))
    }
  }

  // The page as it is, observed by the head or, in a worker that does not run it, the first time a variant needs it.
  env.baseline = async () => {
    if (env.baselineSeen === undefined) {
      env.baselineSeen = options.browser ? await env.observeVariant(sources) : null
    }

    return env.baselineSeen
  }

  const modelCache = new Map()

  // The context of one variant of the sources: the modules as given (the constructed model built by the model as given, the saves read by it), the oracle, and what the browser showed (`seen`) in the grouping of the page's own setting. The code under test runs only through scripts/lib/fault-credit.js `subjectModule` and `through`: a call of it that throws fails the check that made it, marked as a throw, and a fault credited by such failures alone is a defect of the harness (`caughtBy`).
  env.contextOf = async (given, seen) => {
    const loaded = await loadedOf(given)
    const comp = subjectModule(loaded['formation-composition'])
    const ground = loaded['ground-formations']
    const own = new Map()
    const model = lazy(() => frozen(through('the model builder', () => ground.buildGroundFormations(frozen(constructedRows()), { GameID: GAME, RaceID: RACE }), { read: false })))
    const saveModel = async (index) => {
      const kept = given.ground === sources.ground ? modelCache : own

      if (!kept.has(index)) {
        kept.set(index, await through('the ground formation loader', () => ground.loadGroundFormations(databases[index], { GameID: FIXTURES[index].GameID, RaceID: FIXTURES[index].RaceID }), { read: false }))
      }

      return kept.get(index)
    }
    const ctx = { comp, grouping: seen && seen.value ? seen.value.initial.grouping : null, model, node: (id) => model().byId.get(id), saves: databases.map((database, index) => (database ? { oracle: oracles[index], troops: { classes: oracles[index].largest === null ? [] : [{ TroopCapacity: oracles[index].largest, Ships: 1 }] } } : null)), saveModel, browser: seen, plan: null, expected: null, expectedOrder: null }

    if (plantedOracle) {
      const expected = (id, which) => plantedOracle.of(id, which)

      ctx.plan = { ...planted.plan, rows: plantedRows }
      ctx.largest = plantedOracle.largest
      ctx.expected = expected
      ctx.expectedOrder = (id, which) => {
        const ex = expected(id, which)
        const classes = Object.values(ex.classes)

        return ex.state !== 'compared' ? 4 : classes.some((row) => row.status === 'short') ? 0 : classes.some((row) => row.status === 'over') ? 1 : classes.some((row) => row.status === 'unknown') ? 2 : 3
      }
    }

    return ctx
  }
  env.databases = databases
  env.plantedRows = plantedRows
  env.list = options.browser ? results : results.filter((item) => !item.id.startsWith('browser-'))
  env.judge = async (ctx, given = env.list) => judged(await runChecks(given, ctx))
  env.variantOf = ([, from, to, file], patch = patched) => {
    const given = { ...sources }

    for (const [index, one] of [].concat(from).entries()) {
      const target = Array.isArray(file) ? file[index] : file
      const key = target === COMPOSITION_FILE ? 'composition' : target === GROUND_FILE ? 'ground' : 'survey'

      given[key] = patch(target, given[key], one, [].concat(to)[index])
    }

    return given
  }

  return env
}

const checkHead = async () => {
  const { sources, server, chrome, planted, startFailure, databases, list } = ENV

  console.log('Constructed race, saves and browser')

  ENV.baselineSeen = options.browser ? await ENV.observeVariant(sources) : null

  const baselineSeen = ENV.baselineSeen

  // --shots=<dir>: the Ground formations panel, its first planted formation expanded, as pictures at three window sizes.
  if (options.browser && !startFailure && argument('--shots')) {
    for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440]]) {
      const shot = path.join(argument('--shots'), `ground-formations-${width}x${height}.png`)

      await observePage(chrome, server.url, planted.plan, { viewport: { width, height }, shot })
      console.log(`INFO  picture ${shot}`)
    }
  }

  if (process.env.CHECK_VERBOSE && baselineSeen) {
    console.log(JSON.stringify({ error: baselineSeen.error, phase: baselineSeen.phase, steps: baselineSeen.value && baselineSeen.value.steps, gaps: baselineSeen.value && baselineSeen.value.initial.gaps, hidden: baselineSeen.value && baselineSeen.value.initial.hidden, plan: planted && planted.plan, rows: ENV.plantedRows }))
  }

  const baselineContext = await ENV.contextOf(sources, baselineSeen)
  const baseline = await runChecks(list, baselineContext)

  baseline.forEach((result) => check(result.name, result.ok, result.detail))

  const missing = FIXTURES.filter((_fixture, index) => !databases[index]).map((fixture) => fixture.file)

  check('every named save is there', missing.length === 0, missing.join(', '))
  check('every save check ran', baseline.filter((result) => result.id.startsWith('save-')).length === FIXTURES.length * 2)

  const narrowed = [...MUTANTS.filter(([, , , , caught, browser, parts]) => parts !== undefined && (browser !== true || !Array.isArray(parts) || parts.some((part) => !PARTS.includes(part)) || caught.some((id) => READS[id] && !READS[id].some((part) => parts.includes(part))))), ...BENIGN.filter((entry) => entry[6] !== undefined)].map(([name]) => name)
  const undriven = !options.browser || unobserved(baselineSeen) ? [] : [...planted.plan.ids.filter((id) => !(baselineSeen.value.rows[id] && ['replacement', 'original', 'back'].every((which) => baselineSeen.value.rows[id][which]))), ...(baselineSeen.value.restored === undefined ? ['restored'] : [])]

  check('the head drives every part of the page; a fault names parts only where its page is driven in the browser, only parts the page has, and for each browser check it is caught by a part that check reads; and no rewrite names any', narrowed.length === 0 && undriven.length === 0, [...narrowed, ...undriven].join(', '))
}

const checkPlanted = async ([name, from, to, file, caught, browser, parts]) => {
  const given = ENV.variantOf([name, from, to, file], plantedPatch)
  const seen = browser ? await ENV.observeVariant(given, parts) : caught.some((id) => id.startsWith('browser-')) ? await ENV.baseline() : null
  const failed = await ENV.judge(await ENV.contextOf(given, seen), ENV.list.filter((item) => caught.includes(item.id)))
  const named = failed.filter((result) => caught.includes(result.id) && result.kind === 'assertion')

  check(`planted: ${name}: caught by ${failed.map((result) => result.id).join(', ') || 'nothing'}; credited by ${named.map((result) => `${result.id} (${result.threw ? 'throw' : 'value'}: ${result.detail.slice(0, 120)})`).join(', ') || 'nothing'}`, caughtBy(failed, caught, { name }), `expected an assertion of one of ${caught.join(', ')}; ${failed.filter((result) => caught.includes(result.id)).map((result) => `${result.id} (${result.kind}${result.threw ? ', threw' : ''}) ${result.detail.slice(0, 160)}`).join('; ') || 'none of them failed'}`)
}

const checkControls = async () => {
  const { sources, list, judge, contextOf, variantOf } = ENV
  const baselineSeen = await ENV.baseline()
  const probe = async (body) => (await runChecks([{ id: 'probe', name: 'probe', run: body }], {}))[0]
  const stranger = () => new rawAssert.AssertionError({ message: 'thrown by the code under test' })
  const own = await probe(() => assert.equal(1, 2))
  const ordinary = await probe(() => assert.equal(1, 1))

  check('control: a failed assertion of a check is an assertion and credits the fault it is named for, and an assertion that holds passes', own.kind === 'assertion' && caughtBy([own], ['probe']) && ordinary.ok, JSON.stringify([own, ordinary]))

  const bare = [await probe(() => { throw stranger() }), await probe(() => { throw new TypeError('crash') })]
  const stopped = await judge({}, [{ id: 'probe', name: 'probe', run: async () => { throw stranger() } }]).then(() => null, (error) => error)

  check('control: an error that the code under test throws, where no adapter names it, is no assertion of a check, credits nothing and stops the run when a fault is judged', bare.every((result) => result.kind === 'error') && !caughtBy(bare, ['probe']) && stopped instanceof HarnessError, JSON.stringify([bare, String(stopped)]))

  const thrown = await contextOf(variantOf(['a model that throws', 'return { size: isNumber(row.Size)', 'throw new Error(\'planted\'); return { size: isNumber(row.Size)', GROUND_FILE]), baselineSeen)
  const crashed = await runChecks(list.filter((item) => item.id === 'model-template'), thrown)
  const credit = (fault) => {
    try {
      return caughtBy(crashed, ['model-template'], fault)
    } catch (error) {
      return error
    }
  }
  const undeclared = credit({ name: 'a model that throws' })

  check('control: a model that throws fails its check as a call of the code under test that threw, and that failure alone credits no fault: the run stops on it, unless the fault declares a throw as the way it is caught', crashed.length === 1 && crashed[0].kind === 'assertion' && crashed[0].threw === true && undeclared instanceof HarnessError && credit({ name: 'a model that throws', throws: true }) === true, JSON.stringify([crashed, String(undeclared)]))

  if (options.browser) {
    const lost = await contextOf(sources, failedObservation('planted: the browser did not start'))
    const unseen = await runChecks(list.filter((item) => item.id === 'browser-detail'), lost)
    const halted = await judge(lost, list.filter((item) => item.id === 'browser-detail')).then(() => null, (error) => error)

    check('control: a page that did not get through is an error of the harness and no value a check read: the head fails on it, and a fault judged on it stops the run', unseen.length === 1 && unseen[0].kind === 'error' && halted instanceof HarnessError, JSON.stringify([unseen, String(halted)]))
  }

  const navigation = await observePage(pretendBrowser(), 'http://pretend.test/', { system: 7, ids: [] })

  check('control: an observation whose navigation does not end names the step of that navigation (a step is said before the call it names), so the deadline of the runner names it too', navigation.error === NAVIGATION_FAILED && navigation.phase === 'opening /survey-progress?formations=7', JSON.stringify({ error: navigation.error, phase: navigation.phase }))
}

const checkBenign = async ([name, from, to, file, , browser]) => {
  const given = ENV.variantOf([name, from, to, file])
  const failed = (await ENV.judge(await ENV.contextOf(given, browser ? await ENV.observeVariant(given) : await ENV.baseline()))).map((result) => result.id)

  check(`benign: ${name}: no check fails`, failed.length === 0, failed.join(', '))
}

// The deadlines, in seconds: five times the slowest time measured (the head 21 s, a variant served to the browser 21 s, one in memory 29 s), at least two minutes, and for what the browser reads at least a minute past its longest step (BROWSER_TIMEOUT, 120 s for a click or a wait of the page), so that a step that does not end fails by its own timeout, named, before the deadline runs out. The head drives every part of the page and reads every save; a variant served to the browser drives the parts it names, the others run in memory over the saves; the controls of the harness run in memory. The setup opens the saves, plants the copy and starts and warms the page server, the one cold start of the run.
const DEADLINES = { head: 180, browser: 180, memory: 180, setup: 900 }
// The planted fault the control runs before the head: one the head's reading of the page catches.
const CONTROL_FAULT = 'the column of the units short shows the excess'

const variantsOf = () => [
  { key: 'head', name: 'the head: the constructed race, the saves and the browser', head: true, pool: 'suite', deadline: DEADLINES.head, run: checkHead },
  ...(options.mutations ? MUTANTS.filter(([, , , , , browser]) => !browser || options.browser).map((entry) => ({ key: `planted:${MUTANTS.indexOf(entry)}`, name: `planted: ${entry[0]}`, heading: '\nPlanted faults', pool: 'suite', deadline: entry[5] ? DEADLINES.browser : DEADLINES.memory, run: () => checkPlanted(entry) })) : []),
  ...(options.mutations ? [{ key: 'controls', name: 'the controls of the harness', heading: '\nControls of the harness', pool: 'suite', deadline: DEADLINES.memory, run: checkControls }] : []),
  ...(options.mutations ? BENIGN.filter(([, , , , , browser]) => !browser || options.browser).map((entry) => ({ key: `benign:${BENIGN.indexOf(entry)}`, name: `benign: ${entry[0]}`, heading: '\nBenign rewrites', pool: 'suite', deadline: entry[5] ? DEADLINES.browser : DEADLINES.memory, run: () => checkBenign(entry) })) : []),
]

const main = async () => {
  const totals = await runSuite({
    script: __filename,
    inputs: FIXTURES.map((fixture) => fixture.file),
    variants: variantsOf(),
    counts: () => ({ checks, failures }),
    prepare: async () => {
      ENV = await setUp()
    },
    afterEach: async () => {
      if (ENV && ENV.server) {
        await ENV.server.reset()
      }
    },
    close: async () => {
      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup()
      }
    },
    control: options.mutations && options.browser ? { fault: `planted:${MUTANTS.findIndex(([name]) => name === CONTROL_FAULT)}`, head: 'head', heading: '\nThe control of the warm page server' } : null,
    setup: DEADLINES.setup,
  })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  await finish(totals.harness.length ? 2 : totals.failures ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await finish(2)
})
