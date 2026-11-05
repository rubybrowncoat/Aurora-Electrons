/*
  Checks the organisation the game gives a ground formation (utilities/ground-organisation.js, read through utilities/ground-formations.js, shown by Survey Progress): its role, the symbol and echelon of its order-of-battle chart and the naming of its original template.

  Run: bun scripts/check-ground-organisation.js [--no-mutations]

  The rules are the game's, read from its source: the role is `GroundUnitFormation.method_15`, the symbol `GClass147.smethod_9` with `smethod_17` (the tonnage test of the elements) and the headquarters pass `smethod_12` and `smethod_14`, the echelon `smethod_18` (the place of the ground rank of the required rank's priority among the race's ground ranks), the naming `GroundUnitFormationTemplate.GenerateNextFormationName` and `NamingThemeType.method_2`, the template settings `Game.LoadGroundUnitFormationTemplates`. The game saves none of the three figures, so no saved value can confirm them; this check works them out again in SQL and arithmetic written here, from the same stored rows, and compares.
  - `role`: the five vehicle bases, infantry and static; the exact 40% and 60% ties (also with fractional sizes, where a float sum would round the wrong way); logistics against twice the rest; the order of the kinds; the class's surface-to-orbit weapon, which counts for the symbol and not for the role; a component counted once per class; a logistics vehicle that counts as a vehicle while the rest leaves logistics out.
  - `symbol`: the template's own symbol type, the auto detection in the game's order, a template that is none, missing, foreign or not stored, the headquarters pass (the commonest symbol below, ties by the order of the game's own string comparison, which puts A2 before A-2 where JavaScript's puts it after and leaves a tie it does not order unknown, only formations at the same colony, a ship-borne formation outside the chart), and the symbol types the game has no name for.
  - `echelon`: the template's own echelon, the place of the ground rank of the required rank's priority among the race's ground ranks (company to army, army above), a naval rank that holds a ground rank's priority, one whose priority no ground rank holds, a required rank of 0 or one the race has not, and ranks not read.
  - `naming`: the numbered themes, a themed template with its name count and random flag, a theme the catalogue lacks (read as the name plus a number), and the themes the 3.1 line added.
  - `unknown`: an element, class, component, size, unit type or setting the save does not give leaves the figure it feeds unknown, naming what is missing in plain words, never a table or column.
  - `fixture`: every formation of every race of two saves (the interim 3.1 save, 5,337 formations of race 784, and the played 3.2 save, 1,236 formations of eleven races) agrees with the independent working, the stored symbol text is empty in all of them, and the template settings are the ones the saves hold.
  - `planted`: game-shaped template rows on copies of the interim save (every column the game's template loader reads is stored; the settings take values of the game's enumerations): a template that sets its symbol, echelon and naming, the seven naming themes of the 3.1 line with their name counts, a theme the catalogue lacks, required ranks of 0, of a naval rank, of a naval rank whose priority no ground rank holds and of another race's, and a save without a column the rules start from, which keeps the rest of the model and reads the organisation as unknown naming the field.
  - `rows`: Survey Progress's rows carry the organisation of each formation.
  - `capability`: the registry no longer declares the template and symbol columns as read later by another item, the reports that read the formations name them, and a save without one of them degrades those reports and does not withhold the pages.
  - `text`: the expanded row of the formations table draws the organisation lines and its footer says what they are.

  A planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { renderTree, treeOf } = require('./lib/vue-render')

const root = path.resolve(__dirname, '..')

const SAVES = {
  migrated: { file: 'saves/AuroraDB-310-spookyerol-migrated.db', GameID: 141, formations: 5458, templates: 49 },
  played: { file: 'saves/AuroraDB-320-fetterkrolle-1.db', GameID: 161, formations: 1236, templates: 109 },
}
const GAME = SAVES.migrated.GameID
const RACE = 784
const IDS = { GameID: GAME, RaceID: RACE }

const FILES = {
  groundOrganisation: path.join(root, 'src', 'renderer', 'utilities', 'ground-organisation.js'),
  groundFormations: path.join(root, 'src', 'renderer', 'utilities', 'ground-formations.js'),
  remoteFormations: path.join(root, 'src', 'renderer', 'utilities', 'remote-formations.js'),
  capabilities: path.join(root, 'src', 'renderer', 'utilities', 'capabilities.js'),
  surveyPage: path.join(root, 'src', 'renderer', 'pages', 'survey-progress.vue'),
}
const MODULES = { groundOrganisation: 'ground-organisation', groundFormations: 'ground-formations', remoteFormations: 'remote-formations', capabilities: 'capabilities' }
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

// The packages the utilities import, as the least the checks need of them.
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- The modules and the page as shipped, or with edits planted ---------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => {
  const modules = memo(async () => {
    const loaded = await loadUtilities(Object.values(MODULES), { stubs: STUBS, sources: Object.fromEntries(Object.entries(MODULES).map(([target, name]) => [name, texts[target]])) })

    return Object.fromEntries(Object.entries(MODULES).map(([target, name]) => [target, loaded[name]]))
  })

  return {
    texts,
    modules,
    // The model of rows made here (the rows `groundFormationSql` selects), by the module's own builder.
    build: async (spec) => {
      const { groundFormations } = await modules()

      return groundFormations.buildGroundFormations(rowsOf(spec), { GameID: PURE_GAME, RaceID: PURE_RACE })
    },
  }
}

// ---- The saves, as in-memory copies --------------------------------------------------------------------------------
const BYTES = new Map()
const COPIES = new Map()

const bytesOf = (save) => {
  if (!BYTES.has(save)) {
    BYTES.set(save, fs.readFileSync(path.join(root, SAVES[save].file)))
  }

  return BYTES.get(save)
}

// A copy of a save with the statements of one plant run on it, made in memory so that no file is written.
const copyOf = (save, name = 'intact', statements = []) => {
  const key = `${save}:${name}`

  if (!COPIES.has(key)) {
    const database = Database.deserialize(bytesOf(save))

    statements.forEach((statement) => database.run(statement))
    COPIES.set(key, database)
  }

  return COPIES.get(key)
}

const closeCopies = () => {
  COPIES.forEach((database) => database.close())
  COPIES.clear()
}

const loaderOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })

const present = (save) => fs.existsSync(path.join(root, SAVES[save].file))

// ---- Rows the pure cases are built from -----------------------------------------------------------------------------
const PURE_GAME = 1
const PURE_RACE = 2

const equipment = (id, over = {}) => ({ ComponentTypeID: id, ComponentName: `Component ${id}`, Geosurvey: 0, Xenoarchaeology: 0, STO: 0, LogisticsPoints: 0, BombardmentWeapon: 0, AAWeapon: 0, Construction: 0, Decontamination: 0, ...over })

const COMPONENT_ROWS = [equipment(1), equipment(2, { LogisticsPoints: 5 }), equipment(3, { BombardmentWeapon: 2 }), equipment(4, { AAWeapon: 1 }), equipment(5, { Construction: 10 }), equipment(6, { Geosurvey: 1 }), equipment(7, { Xenoarchaeology: 1 }), equipment(8, { Decontamination: 1 }), equipment(9, { STO: 1 })]
const KIND = { logistics: 2, artillery: 3, antiAir: 4, construction: 5, geo: 6, xeno: 7, decon: 8, sto: 9 }

// A ground unit class: its base type (0 infantry, 5 static, 1 2 3 4 6 the vehicles), size, the kinds of equipment in its slots and what else it stores.
const unit = (id, base, size, kinds = [], over = {}) => {
  const slots = [0, 0, 0, 0]

  kinds.forEach((kind, index) => {
    slots[index] = KIND[kind]
  })

  return { GroundUnitClassID: id, ClassName: `Class ${id}`, Size: size, ComponentA: slots[0], ComponentB: slots[1], ComponentC: slots[2], ComponentD: slots[3], STOWeapon: 0, BaseType: base, HQCapacity: 0, ...over }
}

const template = (id, over = {}) => ({ TemplateID: id, RaceID: PURE_RACE, Name: `Template ${id}`, Abbreviation: `T${id}`, Obsolete: 0, NameThemeID: 0, RandomFormationNameFromTheme: 0, SymbolType: 0, EchelonLevel: 0, ...over })

// The race's eight ground ranks (ids 101 to 108, the priority the level: 1 the highest) and eight naval ranks (201 to 208).
const RANKS = [...Array.from({ length: 8 }, (_, index) => ({ RankID: 101 + index, Priority: index + 1, RankType: 1 })), ...Array.from({ length: 8 }, (_, index) => ({ RankID: 201 + index, Priority: index + 1, RankType: 0 }))]
const THEMES = [{ ThemeID: 0, Description: 'Class Name Only' }, { ThemeID: 1, Description: 'Name Plus Number' }, { ThemeID: 2, Description: 'US States' }, { ThemeID: 643, Description: 'Legendary Creatures' }, { ThemeID: 645, Description: 'WH40K Imperial Armoured Regiments' }]
const THEME_NAMES = [{ NameThemeID: 2, Names: 50 }, { NameThemeID: 643, Names: 765 }, { NameThemeID: 645, Names: 34 }]

const formationRow = (f) => ({ FormationID: f.id, Name: f.name === undefined ? `Formation ${f.id}` : f.name, Abbreviation: f.abbreviation === undefined ? '' : f.abbreviation, RaceID: PURE_RACE, GameID: PURE_GAME, OriginalTemplateID: f.template === undefined ? 0 : f.template, ReplacementTemplateID: 0, PopulationID: f.colony === undefined ? 1 : f.colony, ShipID: f.ship === undefined ? 0 : f.ship, ParentFormationID: f.parent === undefined ? 0 : f.parent, RequiredRank: f.rank === undefined ? 108 : f.rank, FormationSymbol: f.symbol === undefined ? null : f.symbol })

// The rows of `groundFormationSql` for a scenario: `classes`, `formations` ({ id, elements: [[classId, units]], template, colony, ship, parent, rank, symbol, name, abbreviation }), `templates`, and what the organisation reads besides (`ranks`, `themes`, `names`; `noRanks` and `noThemes` leave those statements out, `gaps` names the columns the save lacks).
const rowsOf = ({ classes, formations, templates = [], ranks = RANKS, themes = THEMES, names = THEME_NAMES, noRanks = false, noThemes = false, gaps = [], components = COMPONENT_ROWS }) => {
  const rows = {
    formations: formations.map(formationRow),
    outsideParents: [],
    elements: formations.flatMap((f) => (f.elements || []).map(([classId, units], index) => ({ RowID: f.id * 100 + index, ElementID: f.id * 100 + index, FormationID: f.id, ClassID: classId, SpeciesID: 1, Units: units }))),
    classes,
    components,
    templates,
    templateElements: [],
    ships: [],
    fleets: [],
    populations: [{ PopulationID: 1, PopName: 'Home', RaceID: PURE_RACE, SystemID: 1, SystemBodyID: 1, SystemName: 'Sol' }, { PopulationID: 2, PopName: 'Away', RaceID: PURE_RACE, SystemID: 1, SystemBodyID: 2, SystemName: 'Sol' }],
    organisation: { read: gaps.length === 0, gaps },
  }

  if (!noRanks) {
    rows.ranks = ranks
  }

  if (!noThemes) {
    rows.themes = themes
    rows.themeNames = names
  }

  return rows
}

// The value of a result, or a stand-in that names what is missing, so that a result that is unknown fails a comparison by its value and does not throw.
const value = (result) => (result && result.status !== 'unavailable' ? result.value : { id: null, label: `unknown (${missing(result).join(' | ')})`, source: null })
const missing = (result) => (result && result.status === 'unavailable' ? result.inputs.missing : [])

// The name and listing of the theme a template's naming uses, null for both where there is no theme, so that a missing theme fails a comparison and does not throw.
const themeBrief = (naming) => [naming.theme ? naming.theme.name : null, naming.theme ? naming.theme.listed : null]

// The organisation of the formation `id` of a scenario.
const organisationOf = async (w, spec, id = 1) => (await w.build(spec)).byId.get(id).organisation

// A scenario of one formation holding `elements` of `classes`, with the options of the formation and the templates.
const one = (classes, elements, extra = {}) => ({ classes, formations: [{ id: 1, elements, ...(extra.formation || {}) }], templates: extra.templates || [], ...(extra.spec || {}) })

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

// `kind` shares of a formation made of `size` tonnes of a class holding that kind and `rest` tonnes of plain infantry, as the role the rules give.
const SHARE_KINDS = [['artillery', 'Ground artillery'], ['antiAir', 'Ground anti-aircraft'], ['construction', 'Engineering'], ['geo', 'Survey'], ['xeno', 'Xenoarchaeology'], ['decon', 'Decontamination'], ['sto', 'Planetary defence']]
const SHARE_SYMBOLS = [['artillery', 'Artillery'], ['antiAir', 'Air Defence'], ['sto', 'Surface to Orbit'], ['construction', 'Engineer'], ['geo', 'Geosurvey'], ['xeno', 'Xenoarchaeology'], ['decon', 'Decontamination']]

check('role', 'the role follows the game: logistics beyond twice the rest, then each kind above 40% of the rest in the game\'s order, then vehicles and static units above 60%, with exact ties, and nothing else is generic', async (w) => {
  const role = async (classes, elements) => value((await organisationOf(w, one(classes, elements))).role)
  const label = async (classes, elements) => (await role(classes, elements)).label
  const plain = unit(2, 0, 100)

  for (const base of [1, 2, 3, 4, 6]) {
    assert.equal(await label([unit(1, base, 100)], [[1, 1]]), 'Ground attack', `a formation of base type ${base}, a vehicle, is ground attack`)
  }

  assert.equal(await label([unit(1, 0, 100)], [[1, 1]]), 'Generic (tentative)', 'infantry alone is generic')
  assert.equal(await label([unit(1, 5, 100)], [[1, 1]]), 'Ground defence', 'static units alone are ground defence')
  assert.equal(await label([unit(1, 1, 60), unit(2, 0, 40)], [[1, 1], [2, 1]]), 'Generic (tentative)', 'vehicles at exactly 60% are not above it')
  assert.equal(await label([unit(1, 1, 61), unit(2, 0, 39)], [[1, 1], [2, 1]]), 'Ground attack', 'vehicles at 61% are ground attack')
  assert.equal(await label([unit(1, 5, 60), unit(2, 0, 40)], [[1, 1], [2, 1]]), 'Generic (tentative)', 'static units at exactly 60% are not above it')
  assert.equal(await label([unit(1, 5, 61), unit(2, 0, 39)], [[1, 1], [2, 1]]), 'Ground defence', 'static units at 61% are ground defence')
  assert.equal(await label([unit(1, 1, 1.1), unit(2, 0, 0.2)], [[1, 3], [2, 11]]), 'Generic (tentative)', '3.3 tonnes of vehicles in 5.5 is exactly 60%, which a sum of floats would put above it')
  assert.equal(await label([unit(1, 1, 1.1), unit(2, 0, 0.2)], [[1, 4], [2, 11]]), 'Ground attack', 'and 4.4 in 6.6 is above it')
  assert.equal(await label([unit(1, 1, 100), plain], [[1, 0], [2, 1]]), 'Generic (tentative)', 'an element of no units counts for nothing')

  for (const [kind, expected] of SHARE_KINDS) {
    assert.equal(await label([unit(1, 0, 40, [kind]), unit(2, 0, 60)], [[1, 1], [2, 1]]), 'Generic (tentative)', `${kind} at exactly 40% of the rest is not above it`)
    assert.equal(await label([unit(1, 0, 41, [kind]), unit(2, 0, 59)], [[1, 1], [2, 1]]), expected, `${kind} at 41% is ${expected}`)
  }

  assert.equal(await label([unit(1, 0, 201, ['logistics']), unit(2, 0, 100)], [[1, 1], [2, 1]]), 'Ground logistics', 'logistics above twice the rest is ground logistics')
  assert.equal(await label([unit(1, 0, 200, ['logistics']), unit(2, 0, 100)], [[1, 1], [2, 1]]), 'Generic (tentative)', 'logistics at exactly twice the rest is not above it')

  const precedence = [[['artillery', 'antiAir'], 'Ground artillery'], [['antiAir', 'construction'], 'Ground anti-aircraft'], [['construction', 'geo'], 'Engineering'], [['geo', 'xeno'], 'Survey'], [['xeno', 'decon'], 'Xenoarchaeology'], [['decon', 'sto'], 'Decontamination']]

  for (const [kinds, expected] of precedence) {
    assert.equal(await label([unit(1, 0, 100, kinds)], [[1, 1]]), expected, `a class with ${kinds.join(' and ')} is ${expected}: the game tests them in that order`)
  }

  assert.equal(await label([unit(1, 1, 100, ['sto'])], [[1, 1]]), 'Planetary defence', 'a surface-to-orbit vehicle is planetary defence before it is ground attack')
  assert.equal(await label([unit(1, 1, 65, [], { ClassName: 'Mule' }), unit(2, 5, 35)], [[1, 1], [2, 1]]), 'Ground attack', 'vehicles above 60% of the rest are ground attack before static units are tested, and a class with logistics equipment is both a vehicle and logistics')
  assert.equal(await label([unit(1, 1, 65, ['logistics']), unit(2, 5, 35)], [[1, 1], [2, 1]]), 'Ground attack', 'a logistics vehicle counts as a vehicle while the rest leaves logistics out, so 65 against a rest of 35 is above 60%')
  assert.equal(await label([unit(1, 0, 100, [], { STOWeapon: 3 })], [[1, 1]]), 'Generic (tentative)', 'a class whose surface-to-orbit weapon is set counts for the symbol and not for the role')
  assert.equal(await label([unit(1, 0, 41, ['artillery', 'artillery']), unit(2, 0, 59)], [[1, 1], [2, 1]]), 'Ground artillery', 'a component twice in a class counts the class once')
  assert.equal((await role([unit(1, 0, 100)], [[1, 1]])).id, 0, 'the role is the game\'s enumeration value, generic tentative 0')
  assert.equal((await role([unit(1, 0, 201, ['logistics']), unit(2, 0, 100)], [[1, 1], [2, 1]])).id, 9, 'and ground logistics 9')
})

check('symbol', 'the symbol is the template\'s own type, else the game\'s auto detection in its order, with the headquarters pass over the formations of the same colony', async (w) => {
  const symbol = async (classes, elements, extra) => value((await organisationOf(w, one(classes, elements, extra))).symbol)
  const label = async (classes, elements, extra) => (await symbol(classes, elements, extra)).label

  assert.equal(await label([unit(1, 0, 51, [], { HQCapacity: 1000 }), unit(2, 0, 49)], [[1, 1], [2, 1]]), 'Headquarters', 'units with headquarters capacity above half of the total are a headquarters')
  assert.equal(await label([unit(1, 0, 50, [], { HQCapacity: 1000 }), unit(2, 0, 50)], [[1, 1], [2, 1]]), 'Infantry', 'exactly half is not above it')
  assert.equal(await label([unit(1, 0, 201, ['logistics']), unit(2, 0, 100)], [[1, 1], [2, 1]]), 'Supply', 'logistics above twice the rest is supply')
  assert.equal(await label([unit(1, 0, 200, ['logistics']), unit(2, 0, 100)], [[1, 1], [2, 1]]), 'Infantry', 'logistics at exactly twice the rest is infantry here, being all infantry')

  for (const [kind, expected] of SHARE_SYMBOLS) {
    assert.equal(await label([unit(1, 0, 40, [kind]), unit(2, 0, 60)], [[1, 1], [2, 1]]), 'Infantry', `${kind} at exactly 40% is not above it`)
    assert.equal(await label([unit(1, 0, 41, [kind]), unit(2, 0, 59)], [[1, 1], [2, 1]]), expected, `${kind} at 41% is ${expected}`)
  }

  for (const [kinds, expected] of [[['artillery', 'antiAir'], 'Artillery'], [['antiAir', 'sto'], 'Air Defence'], [['sto', 'construction'], 'Surface to Orbit'], [['construction', 'geo'], 'Engineer'], [['geo', 'xeno'], 'Geosurvey'], [['xeno', 'decon'], 'Xenoarchaeology']]) {
    assert.equal(await label([unit(1, 0, 100, kinds)], [[1, 1]]), expected, `a class with ${kinds.join(' and ')} is drawn ${expected}: the game tests them in that order`)
  }

  assert.equal(await label([unit(1, 0, 100, [], { STOWeapon: 3 })], [[1, 1]]), 'Surface to Orbit', 'a class whose surface-to-orbit weapon is set is drawn surface to orbit')
  assert.equal(await label([unit(1, 5, 61), unit(2, 0, 39)], [[1, 1], [2, 1]]), 'Static Defence', 'static units above 60% are static defence')
  assert.equal(await label([unit(1, 5, 60), unit(2, 1, 40)], [[1, 1], [2, 1]]), 'Generic', 'static units at exactly 60% and vehicles at 40% of the rest are neither above 60%, and with no infantry the formation is generic')
  assert.equal(await label([unit(1, 1, 61), unit(2, 5, 39)], [[1, 1], [2, 1]]), 'Armour', 'vehicles above 60% are armour')
  assert.equal(await label([unit(1, 0, 61), unit(2, 1, 39)], [[1, 1], [2, 1]]), 'Infantry', 'infantry above 60% is infantry')
  assert.equal(await label([unit(1, 0, 50), unit(2, 1, 50)], [[1, 1], [2, 1]]), 'Mechanised Infantry', 'infantry and vehicles with neither above 60% are mechanised infantry')
  assert.equal(await label([unit(1, 0, 59), unit(2, 5, 41)], [[1, 1], [2, 1]]), 'Generic', 'infantry and static units with neither above 60% and no vehicle are generic')
  assert.equal(await label([unit(1, 0, 100)], [[1, 0]]), 'Generic', 'a formation of no tonnage is generic')
  assert.equal((await symbol([unit(1, 0, 100)], [[1, 1]])).source, 'elements', 'the source is the elements')

  const infantry = [unit(1, 0, 100)]
  const settings = (over) => ({ templates: [template(10, over)], formation: { template: 10 } })
  const set = await symbol(infantry, [[1, 1]], settings({ SymbolType: 12 }))

  assert.deepEqual([set.id, set.label, set.source], [12, 'Surface to Orbit', 'template'], 'a template that sets its symbol type decides, whatever the elements are')
  assert.equal(await label(infantry, [[1, 1]], settings({ SymbolType: 0 })), 'Infantry', 'a template on Auto leaves it to the elements')
  assert.equal(await label(infantry, [[1, 1]], { templates: [template(10, { SymbolType: 3, RaceID: 99 })], formation: { template: 10 } }), 'Armour', 'a template of another race sets the symbol the same, as the game does not look at the race')
  assert.equal(await label(infantry, [[1, 1]], { formation: { template: 0 } }), 'Infantry', 'a formation with no template is worked out from its elements')
  assert.equal(await label(infantry, [[1, 1]], { formation: { template: 77 } }), 'Infantry', 'and so is one whose template is not in the save')

  for (const stored of [null, undefined, 99, -1, 1.5]) {
    const result = (await organisationOf(w, one(infantry, [[1, 1]], settings({ SymbolType: stored })))).symbol

    assert.equal(result.status, 'unavailable', `a symbol type of ${String(stored)} is unknown, never worked out from the elements`)
  }

  assert.equal(missing((await organisationOf(w, one(infantry, [[1, 1]], { formation: { template: null } }))).symbol).length, 1, 'a template id that is not stored leaves the symbol unknown')

  // The headquarters pass. The head is a class with headquarters capacity alone; each child is one class of the kind named.
  const head = unit(1, 0, 100, [], { HQCapacity: 5000 })
  const kids = { inf: unit(2, 0, 100), art: unit(3, 0, 100, ['artillery']), big: unit(4, 0, 60, ['artillery']), small: unit(5, 0, 10, [], { HQCapacity: 500 }), gen: unit(6, 0, 59), pad: unit(7, 5, 41) }
  const pass = async (children, headOver = {}, extraClasses = []) => {
    const formations = [{ id: 1, elements: [[1, 1]], name: 'Head', ...headOver }, ...children.map((child, index) => ({ id: 10 + index, parent: 1, elements: [[child.class, 1]], ...child.formation }))]
    const model = await w.build({ classes: [head, ...Object.values(kids), ...extraClasses], formations })

    return model.byId.get(1).organisation.symbol
  }
  const child = (kind, formation = {}) => ({ class: kids[kind].GroundUnitClassID, formation })

  assert.equal(value(await pass([])).label, 'Headquarters', 'a headquarters with nothing below stays a headquarters')
  assert.equal(value(await pass([child('inf')])).label, 'Infantry', 'a headquarters over infantry is drawn infantry')
  assert.equal(value(await pass([child('inf'), child('inf'), child('art')])).label, 'Infantry', 'over two infantry and one artillery it is infantry, the commonest')
  assert.equal(value(await pass([child('art'), child('inf', { abbreviation: 'B' }), child('inf', { abbreviation: 'C' })])).label, 'Infantry', 'the commonest wins whatever the order below')
  assert.equal(value(await pass([child('inf', { abbreviation: 'A' }), child('art', { abbreviation: 'B' })])).label, 'Infantry', 'a tie goes to the symbol first met in the game\'s sort, here by abbreviation')
  assert.equal(value(await pass([child('inf', { abbreviation: 'B' }), child('art', { abbreviation: 'A' })])).label, 'Artillery', 'and by abbreviation the other way')
  assert.equal(value(await pass([child('inf', { abbreviation: 'A', name: 'Z' }), child('art', { abbreviation: 'A', name: 'Y' })])).label, 'Artillery', 'and by name when the abbreviations are equal')
  assert.equal(value(await pass([child('inf', { abbreviation: 'A2' }), child('art', { abbreviation: 'A-2' })])).label, 'Infantry', 'the game\'s comparison puts A2 before A-2, where JavaScript\'s puts A-2 first, so the tie goes to infantry')
  assert.equal(value(await pass([child('art', { abbreviation: 'A-2' }), child('inf', { abbreviation: 'A2' })])).label, 'Infantry', 'the same whichever order the formations are stored in')
  assert.equal(value(await pass([child('inf', { abbreviation: 'A2', name: 'Zulu' }), child('art', { abbreviation: 'A2', name: 'Alpha' })])).label, 'Artillery', 'and by name when the abbreviations are the same')

  const unorderable = await pass([child('inf', { abbreviation: 'A\u20142' }), child('art', { abbreviation: 'A-2' })])

  assert.equal(unorderable.status, 'unavailable', 'a tie whose order the game\'s comparison does not establish here leaves the symbol unknown, not chosen')
  assert.ok(missing(unorderable).some((text) => /order the game gives two formations/.test(text)), `and says so: ${missing(unorderable).join(' | ')}`)
  assert.equal(value(await pass([child('inf', { abbreviation: 'A' }), { class: 4, formation: { abbreviation: 'B', elements: [[4, 1], [5, 1]] } }])).label, 'Artillery', 'a child holding a class with headquarters capacity is sorted before one that holds none')
  assert.equal(value(await pass([child('gen', { elements: [[6, 1], [7, 1]] }), child('gen', { elements: [[6, 1], [7, 1]] })])).label, 'Headquarters', 'generic children do not count: the headquarters stays')
  assert.equal(value(await pass([child('inf', { colony: 2 })])).label, 'Headquarters', 'a child at another colony is not in the colony\'s chart')
  assert.equal(value(await pass([child('inf', { colony: 0, ship: 9 })])).label, 'Headquarters', 'a child aboard a ship is not in it either')
  assert.equal(value(await pass([child('inf', { colony: 0, ship: 8 })], { colony: 0, ship: 9 })).label, 'Headquarters', 'a headquarters aboard a ship is in no colony\'s chart and keeps its symbol, though a formation aboard a ship is below it')
  assert.equal(value(await pass([child('inf'), child('art', { colony: 2 })])).label, 'Infantry', 'only the children of the colony are counted')

  // A headquarters below the head takes its own children's symbol first, and the head then counts that.
  const nested = await w.build({ classes: [head, kids.art, kids.inf], formations: [{ id: 1, elements: [[1, 1]] }, { id: 2, parent: 1, elements: [[1, 1]], name: 'Middle' }, { id: 3, parent: 2, elements: [[3, 1]], name: 'Leaf' }, { id: 4, parent: 1, elements: [[2, 1]], abbreviation: 'Z' }] })

  assert.equal(value(nested.byId.get(2).organisation.symbol).label, 'Artillery', 'the middle headquarters is drawn artillery')
  assert.equal(value(nested.byId.get(1).organisation.symbol).label, 'Artillery', 'and counts as that for the head, where artillery and infantry tie and the middle headquarters comes first in the sort by headquarters capacity')

  const unknownKid = await w.build({ classes: [head, unit(7, 0, 100, [], { HQCapacity: 1 }), unit(8, null, 100)], formations: [{ id: 1, elements: [[1, 1]] }, { id: 2, parent: 1, elements: [[8, 1]] }] })

  assert.equal(unknownKid.byId.get(1).organisation.symbol.status, 'unavailable', 'a child whose symbol is unknown leaves the headquarters\' symbol unknown')
})

check('headquartersOrder', 'every child of a tied commonest symbol can be first in the game\'s capacity, abbreviation and name order; an unsupported comparison cannot be hidden by an id or a per-symbol leader, and one that cannot affect the first child leaves the symbol resolved', async (w) => {
  const classes = [unit(1, 0, 100, [], { HQCapacity: 5000 }), unit(2, 0, 100), unit(3, 0, 100, ['artillery']), unit(4, 0, 10, [], { HQCapacity: 500 })]
  const children = [{ id: 2, abbreviation: 'A', elements: [[2, 1]] }, { id: 3, abbreviation: 'B', elements: [[3, 1]] }, { id: 4, abbreviation: 'C', elements: [[2, 1]] }, { id: 5, abbreviation: '\u2014', elements: [[3, 1]] }]
  const symbolOf = async (rows) => (await w.build({ classes, formations: [{ id: 1, elements: [[1, 1]] }, ...rows.map((row) => ({ parent: 1, ...row }))] })).byId.get(1).organisation.symbol
  const unresolved = await symbolOf(children)

  // Terra's counterexample, with exactly these ids and equal capacities: .NET compares the em dash before A, so the game draws Artillery. The port deliberately leaves the em dash outside its measured table and must report unknown rather than Infantry.
  assert.equal(unresolved.status, 'unavailable', '2:A Infantry, 3:B Artillery, 4:C Infantry, 5:em dash Artillery: every competing child counts, including the second artillery child hidden by the former id fallback')
  assert.ok(missing(unresolved).some((text) => /order the game gives two formations/.test(text)), `the missing comparison is named: ${missing(unresolved).join(' | ')}`)
  assert.equal((await symbolOf([...children].reverse())).status, 'unavailable', 'reversing the stored rows does not establish the missing comparison')
  assert.equal((await symbolOf(children.map((row) => ({ ...row, name: row.abbreviation, abbreviation: 'Same' })))).status, 'unavailable', 'the same counterexample in the name must not be hidden after equal abbreviations')
  assert.equal(value(await symbolOf(children.map((row) => row.id === 5 ? { ...row, abbreviation: 'D' } : row))).label, 'Infantry', 'with every comparison supported, the first of all four sorted children is A Infantry')

  const capacityFirst = children.map((row) => row.id === 2 ? { ...row, elements: [[2, 1], [4, 1]] } : row)

  assert.equal(value(await symbolOf(capacityFirst)).label, 'Infantry', 'the em dash child cannot be first when A Infantry has greater headquarters capacity: an irrelevant unsupported comparison must not make the result unknown')
  assert.equal(value(await symbolOf(children.map((row) => row.id === 5 ? { ...row, elements: [[3, 1], [4, 1]] } : row))).label, 'Artillery', 'capacity also settles the tie when the em dash child itself must be first')

  const laterNames = children.map((row) => row.id >= 4 ? { ...row, abbreviation: 'C', name: row.id === 4 ? 'A' : '\u2014' } : row)

  assert.equal(value(await symbolOf(laterNames)).label, 'Infantry', 'the unknown name comparison between the two C children cannot affect the first child A, even at equal capacities')
  assert.equal(value(await symbolOf([...laterNames].reverse())).label, 'Infantry', 'irrelevant unknown comparisons do not disturb the winner when the stored rows are reversed')

  const sameSymbolFirst = [{ id: 2, abbreviation: 'B', elements: [[3, 1]] }, { id: 3, abbreviation: '\u2014', elements: [[2, 1]] }, { id: 4, abbreviation: 'A', elements: [[2, 1]] }, { id: 5, abbreviation: 'Z', elements: [[3, 1]] }]

  assert.equal((await symbolOf(sameSymbolFirst)).status, 'unavailable', 'the order between any two possible-first children must be known in a symbol tie, even if those two carry the same symbol; an unresolved sort must not leave the B Artillery child in front of A Infantry')
})

check('echelon', 'the echelon is the template\'s own, else the place of the required rank\'s ground rank among the race\'s ground ranks from the lowest, company up to army and army above, none for a priority no ground rank holds and unknown without a rank', async (w) => {
  const infantry = [unit(1, 0, 100)]
  const echelon = async (extra) => (await organisationOf(w, one(infantry, [[1, 1]], extra))).echelon
  const byRank = async (rank, spec = {}) => value(await echelon({ formation: { rank }, spec }))
  const places = ['Company', 'Battalion', 'Regiment', 'Brigade', 'Division', 'Corps', 'Army', 'Army']

  for (const [index, expected] of places.entries()) {
    const found = await byRank(108 - index)

    assert.deepEqual([found.label, found.source], [expected, 'rank'], `the ground rank of level ${8 - index}, ${index} above the lowest, is ${expected}`)
  }

  assert.deepEqual([(await byRank(208)).label, (await byRank(208)).source, (await byRank(208)).place], ['Company', 'rank', 1], 'a naval rank draws the ground rank of its priority, here the lowest of eight, company')
  assert.equal((await byRank(201)).label, 'Army', 'the highest naval rank draws the ground rank of its priority, here the highest of eight, army')

  const unheld = await echelon({ formation: { rank: 209 }, spec: { ranks: [...RANKS, { RankID: 209, Priority: 9, RankType: 0 }] } })

  assert.deepEqual([value(unheld).label, value(unheld).id], ['None', 1], 'a rank whose priority no ground rank of the race holds draws no echelon, as the game reads the null ground rank as none')

  const unheldLines = (await w.modules()).groundOrganisation.organisationLines(await organisationOf(w, one(infantry, [[1, 1]], { formation: { rank: 209 }, spec: { ranks: [...RANKS, { RankID: 209, Priority: 9, RankType: 0 }] } })))

  assert.equal(unheldLines.find((line) => line.key === 'echelon').text, 'Echelon: None, no ground rank has the priority of the required rank', 'and the line says why the echelon is none')

  for (const stored of [0, 9999, null]) {
    const result = await echelon({ formation: { rank: stored } })

    assert.equal(result.status, 'unavailable', `a required rank of ${String(stored)} is not worked out: the game takes it from the size of the formation and the ranks below it`)
    assert.ok(missing(result).length > 0, 'and says what is missing')
  }

  const noRanks = await echelon({ spec: { noRanks: true } })

  assert.equal(noRanks.status, 'unavailable', 'ranks that were not read leave the echelon unknown')
  assert.ok(missing(noRanks).some((text) => /ranks of the race/.test(text)), `naming the ranks: ${missing(noRanks).join(' | ')}`)

  const twelve = Array.from({ length: 12 }, (_, index) => ({ RankID: 301 + index, Priority: index + 1, RankType: 1 }))
  const long = async (rank) => value(await echelon({ formation: { rank }, spec: { ranks: twelve } })).label

  assert.equal(await long(312), 'Company', 'twelve ground ranks: the lowest is company')
  assert.equal(await long(306), 'Army', 'the seventh from the lowest is army')
  assert.equal(await long(301), 'Army', 'the highest of twelve is army')

  const set = async (level) => value(await echelon({ templates: [template(10, { EchelonLevel: level })], formation: { template: 10, rank: 0 } }))

  assert.deepEqual([(await set(9)).label, (await set(9)).source], ['Brigade', 'template'], 'a template that sets its echelon decides, and an unset required rank no longer matters')
  assert.equal((await set(1)).label, 'None', 'a template echelon of 1 is no echelon')
  assert.equal((await set(2)).label, 'Team', 'a template echelon of 2 is a team')
  assert.equal((await set(12)).label, 'Army', 'and 12 an army')

  for (const stored of [null, undefined, 99, -1]) {
    const result = await echelon({ templates: [template(10, { EchelonLevel: stored })], formation: { template: 10 } })

    assert.equal(result.status, 'unavailable', `a template echelon of ${String(stored)} is unknown`)
  }

  assert.equal(value(await echelon({ templates: [template(10, { EchelonLevel: 0 })], formation: { template: 10, rank: 105 } })).label, 'Brigade', 'a template on Auto takes the rank')
  assert.equal(value(await echelon({ formation: { template: 0, rank: 105 } })).label, 'Brigade', 'a formation with no template takes the rank')
  assert.equal(value(await echelon({ formation: { template: 77, rank: 105 } })).label, 'Brigade', 'so does one whose template is not in the save')
})

check('naming', 'a template names its formations by the numbered themes (0 and 1) or from its theme, its random flag and its name count, a theme the catalogue lacks is read as the name plus a number, and the new themes read', async (w) => {
  const infantry = [unit(1, 0, 100)]
  const naming = async (over, spec = {}) => (await organisationOf(w, one(infantry, [[1, 1]], { templates: [template(10, over)], formation: { template: 10 }, spec }))).template.settings.naming
  const text = async (over, spec = {}) => {
    const { organisationLines } = await w.modules().then((m) => m.groundOrganisation)
    const organisation = await organisationOf(w, one(infantry, [[1, 1]], { templates: [template(10, over)], formation: { template: 10 }, spec }))

    return organisationLines(organisation).find((line) => line.key === 'naming').text
  }

  let found = await naming({ NameThemeID: 0 })

  assert.deepEqual([found.themeId, found.mode, ...themeBrief(found)], [0, 'numbered', 'Class Name Only', true], 'theme 0 numbers the formations')
  assert.equal(await text({ NameThemeID: 0 }), 'Naming: Class Name Only, numbered after the template name', 'and says so')
  found = await naming({ NameThemeID: 1 })
  assert.deepEqual([found.mode, themeBrief(found)[0]], ['numbered', 'Name Plus Number'], 'theme 1 numbers them too')

  found = await naming({ NameThemeID: 643, RandomFormationNameFromTheme: 1 })
  assert.deepEqual([found.themeId, found.mode, found.random, found.names, themeBrief(found)[0]], [643, 'themed', true, 765, 'Legendary Creatures'], 'a themed template with random names from 765')
  assert.equal(await text({ NameThemeID: 643, RandomFormationNameFromTheme: 1 }), 'Naming: Legendary Creatures, random names from the theme of 765 names', 'its words')
  assert.equal(await text({ NameThemeID: 643, RandomFormationNameFromTheme: 0 }), 'Naming: Legendary Creatures, names in the order of the theme of 765 names', 'without the random flag the names go in order')
  assert.equal((await naming({ NameThemeID: 645, RandomFormationNameFromTheme: 0 })).names, 34, 'another new theme has its own count')
  assert.equal((await naming({ NameThemeID: 2 })).names, 50, 'and an older one')
  assert.equal((await naming({ NameThemeID: 643, RandomFormationNameFromTheme: 2 })).random, false, 'the game takes the random flag as exactly 1')

  found = await naming({ NameThemeID: 9999 })
  assert.deepEqual([found.themeId, found.mode, ...themeBrief(found).reverse()], [9999, 'numbered', false, 'Name Plus Number'], 'a theme the catalogue lacks falls back to the name plus a number')
  assert.equal(await text({ NameThemeID: 9999 }), 'Naming: Name Plus Number (the stored theme is not in the catalogue), numbered after the template name', 'and the words say the stored theme is not in the catalogue')

  found = await naming({ NameThemeID: 643 }, { noThemes: true })
  assert.deepEqual([found.theme, found.names, found.mode], [null, null, 'themed'], 'a catalogue that was not read leaves the theme and its names unknown')
  assert.equal((await naming({ NameThemeID: null })).themeId, null, 'a theme that is not stored is null')
  assert.ok(/not stored/.test(await text({ NameThemeID: null })), 'and said not stored')
  assert.equal((await naming({ NameThemeID: 643, RandomFormationNameFromTheme: null })).random, null, 'a random flag that is not stored is null')
  assert.ok(/whether random is not stored/.test(await text({ NameThemeID: 643, RandomFormationNameFromTheme: null })), 'and said so')

  const none = await organisationOf(w, one(infantry, [[1, 1]], { formation: { template: 0 } }))

  assert.equal(none.template.state, 'none', 'no template')
  assert.equal((await w.modules()).groundOrganisation.organisationLines(none).find((line) => line.key === 'naming').text, 'Naming: no original template, so none', 'has no naming')
  assert.equal((await w.modules()).groundOrganisation.organisationLines(await organisationOf(w, one(infantry, [[1, 1]], { formation: { template: 77 } }))).find((line) => line.key === 'naming').text, 'Naming: the original template is not in the save', 'a template the save lacks is said to be missing')
})

check('unknown', 'what the save does not give leaves the figure it feeds unknown and says what is missing in plain words, never a table or a column, and a formation with no elements is not generic', async (w) => {
  const words = (result) => missing(result).join(' | ')
  const plain = (result) => assert.ok(!/\b(?:FCT|DIM|VIR)_|`|\.js\b/.test(words(result)) && missing(result).length > 0, `plain words: ${words(result)}`)
  const cases = [
    ['a size', [unit(1, 0, null)], [[1, 1]], /size of a class/],
    ['a unit count', [unit(1, 0, 100)], [[1, null]], /units of an element/],
    ['a unit type', [unit(1, null, 100)], [[1, 1]], /unit type of a class/],
    ['a unit type the game has no name for', [unit(1, 9, 100)], [[1, 1]], /unit type of a class/],
    ['a component slot', [unit(1, 0, 100, [], { ComponentB: null })], [[1, 1]], /component slot/],
    ['a component the catalogue lacks', [unit(1, 0, 100, [], { ComponentB: 77 })], [[1, 1]], /catalogue does not list/],
    ['a class the save lacks', [unit(1, 0, 100)], [[5, 1]], /class of the formation/],
  ]

  for (const [what, classes, elements, expected] of cases) {
    const organisation = await organisationOf(w, one(classes, elements))

    for (const figure of ['role', 'symbol']) {
      assert.equal(organisation[figure].status, 'unavailable', `${what} leaves the ${figure} unknown`)
      assert.ok(expected.test(words(organisation[figure])), `${what}: ${figure} names it: ${words(organisation[figure])}`)
      plain(organisation[figure])
    }
  }

  const rated = [unit(1, 0, 100, ['artillery'])]
  const lacking = await organisationOf(w, { ...one(rated, [[1, 1]]), components: COMPONENT_ROWS.map((row) => (row.ComponentTypeID === 3 ? { ...row, BombardmentWeapon: null } : row)) })

  assert.equal(lacking.role.status, 'unavailable', 'a component whose rating is not stored leaves the role unknown while it could have the trait')
  assert.ok(/bombardment weapon level/.test(words(lacking.role)), words(lacking.role))

  const decided = await organisationOf(w, { ...one([unit(1, 0, 100, ['logistics', 'artillery'])], [[1, 1]]), components: COMPONENT_ROWS.map((row) => (row.ComponentTypeID === 3 ? { ...row, BombardmentWeapon: null } : row)) })

  assert.equal(decided.role.status, 'unavailable', 'a class whose other component already has another trait is still unknown for the kind whose rating is missing')

  const empty = await organisationOf(w, { classes: [unit(1, 0, 100)], formations: [{ id: 1, elements: [] }] })

  assert.equal(empty.role.status, 'unavailable', 'a formation with no element rows has no role, not the generic one')
  assert.ok(/elements of the formation/.test(words(empty.role)), words(empty.role))
  assert.equal(empty.symbol.status, 'unavailable', 'and no symbol')

  const withSet = await organisationOf(w, { classes: [unit(1, 0, 100)], formations: [{ id: 1, elements: [], template: 10 }], templates: [template(10, { SymbolType: 3 })] })

  assert.equal(value(withSet.symbol).label, 'Armour', 'a template that sets the symbol gives it to a formation with no elements')

  const gaps = await organisationOf(w, one([unit(1, 0, 100)], [[1, 1]], { spec: { gaps: ['FCT_GroundUnitFormationTemplate.SymbolType', 'DIM_NamingTheme'] } }))

  for (const figure of ['role', 'symbol', 'echelon']) {
    assert.equal(gaps[figure].status, 'unavailable', `${figure}: a save without a column the rules start from is unknown`)
    assert.ok(missing(gaps[figure]).length === 2 && missing(gaps[figure]).every((text) => !/\b(?:FCT|DIM)_/.test(text)), `${figure} names the two fields in words: ${words(gaps[figure])}`)
  }
})

// ---- The saves, worked out again in SQL written here -----------------------------------------------------------------
const ECHELON_STEPS = ['Company', 'Battalion', 'Regiment', 'Brigade', 'Division', 'Corps', 'Army']
const SYMBOL_NAMES = ['Auto', 'Headquarters', 'Infantry', 'Armour', 'Mechanised Infantry', 'Artillery', 'Air Defence', 'Supply', 'Engineer', 'Geosurvey', 'Xenoarchaeology', 'Decontamination', 'Surface to Orbit', 'Static Defence', 'Generic']
const ECHELON_NAMES = ['Auto', 'None', 'Team', 'Squad', 'Section', 'Platoon', 'Company', 'Battalion', 'Regiment', 'Brigade', 'Division', 'Corps', 'Army']
const ROLE_NAMES = ['Generic (tentative)', 'Ground attack', 'Ground artillery', 'Ground anti-aircraft', 'Ground defence', 'Engineering', 'Survey', 'Planetary defence', 'Xenoarchaeology', 'Ground logistics', 'Decontamination']

// The elements of a race's formations with the traits of their classes, a row each: the tonnage in thousandths of a tonne, the headquarters capacity, the base type and one 0/1 flag per kind of equipment in the class's four slots.
const elementsOf = (database, ids) => database.query(`select FCT_GroundUnitFormationElement.FormationID as FormationID, FCT_GroundUnitFormationElement.Units as Units, FCT_GroundUnitClass.Size as Size, FCT_GroundUnitClass.BaseType as BaseType, FCT_GroundUnitClass.HQCapacity as HQ, FCT_GroundUnitClass.STOWeapon as StoClass,
  max(DIM_GroundComponentType.LogisticsPoints > 0) as L, max(DIM_GroundComponentType.BombardmentWeapon != 0) as B, max(DIM_GroundComponentType.AAWeapon != 0) as A, max(DIM_GroundComponentType.Construction > 0) as C, max(DIM_GroundComponentType.Geosurvey > 0) as G, max(DIM_GroundComponentType.Xenoarchaeology > 0) as X, max(DIM_GroundComponentType.Decontamination > 0) as D, max(DIM_GroundComponentType.STO > 0) as S
from FCT_GroundUnitFormationElement
inner join FCT_GroundUnitClass on FCT_GroundUnitClass.GroundUnitClassID = FCT_GroundUnitFormationElement.ClassID
left join DIM_GroundComponentType on DIM_GroundComponentType.ComponentTypeID in (FCT_GroundUnitClass.ComponentA, FCT_GroundUnitClass.ComponentB, FCT_GroundUnitClass.ComponentC, FCT_GroundUnitClass.ComponentD)
where FCT_GroundUnitFormationElement.FormationID in (select FCT_GroundUnitFormation.FormationID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${ids.GameID} and FCT_GroundUnitFormation.RaceID = ${ids.RaceID})
group by FCT_GroundUnitFormationElement.rowid`).all()

// The sums the two rules start from, in thousandths of a tonne (the saves' sizes are whole numbers of tonnes).
const sumsOf = (rows) => {
  const sums = { total: 0, logistics: 0, artillery: 0, antiAir: 0, construction: 0, geo: 0, xeno: 0, decon: 0, sto: 0, stoClass: 0, hq: 0, infantry: 0, statics: 0, vehicles: 0 }

  rows.forEach((row) => {
    const thousandths = Math.round(row.Size * 1000) * row.Units
    const own = { logistics: row.L, artillery: row.B, antiAir: row.A, construction: row.C, geo: row.G, xeno: row.X, decon: row.D, sto: row.S }

    sums.total += thousandths
    Object.entries(own).forEach(([kind, flag]) => {
      sums[kind] += flag ? thousandths : 0
    })
    sums.stoClass += row.S || row.StoClass > 0 ? thousandths : 0
    sums.hq += row.HQ > 0 ? thousandths : 0
    sums.infantry += row.BaseType === 0 ? thousandths : 0
    sums.statics += row.BaseType === 5 ? thousandths : 0
    sums.vehicles += [1, 2, 3, 4, 6].includes(row.BaseType) ? thousandths : 0
  })

  return sums
}

// `part` is more than `top` fifths of `rest`, as whole numbers.
const over = (part, rest, top) => part * 5 > rest * top

const roleWorked = (rows) => {
  const s = sumsOf(rows)
  const rest = s.total - s.logistics

  if (s.logistics > rest * 2) {
    return 9
  }

  const order = [['artillery', 2], ['antiAir', 3], ['construction', 5], ['geo', 6], ['xeno', 8], ['decon', 10], ['sto', 7]]
  const kind = order.find(([name]) => over(s[name], rest, 2))

  return kind ? kind[1] : over(s.vehicles, rest, 3) ? 1 : over(s.statics, rest, 3) ? 4 : 0
}

const symbolWorked = (rows) => {
  const s = sumsOf(rows)
  const rest = s.total - s.logistics

  if (s.total === 0) {
    return 14
  } else if (s.hq * 2 > s.total) {
    return 1
  } else if (s.logistics > rest * 2) {
    return 7
  }

  const order = [['artillery', 5, 2], ['antiAir', 6, 2], ['stoClass', 12, 2], ['construction', 8, 2], ['geo', 9, 2], ['xeno', 10, 2], ['decon', 11, 2], ['statics', 13, 3], ['vehicles', 3, 3], ['infantry', 2, 3]]
  const kind = order.find(([name, , top]) => over(s[name], rest, top))

  return kind ? kind[1] : s.infantry > 0 && s.vehicles > 0 ? 4 : 14
}

// The order the game gives two texts: .NET's culture-sensitive comparison drops a hyphen at its first level and only then puts the shorter text first, then weighs the letters and digits, the case and the places of the hyphens. Worked again here, as the game has it, so that a tie is not settled in JavaScript's order.
const WEIGHTS = ' #&()./_~+0123456789abcdefghijklmnopqrstuvwxyz'

const levelsOf = (text) => {
  const weights = []
  const cases = []
  const flags = []
  let hyphens = 0

  for (const character of String(text)) {
    if (character === '-') {
      hyphens += 1

      continue
    }

    const lower = character.toLowerCase()

    if (lower.length !== 1 || !WEIGHTS.includes(lower)) {
      return null
    }

    weights.push(WEIGHTS.indexOf(lower))
    cases.push(character === lower ? 0 : 1)
    flags.push(hyphens)
    hyphens = 0
  }

  return [weights, cases, flags, [hyphens]]
}

const listOrder = (first, second) => {
  const shared = Math.min(first.length, second.length)

  for (let index = 0; index < shared; index++) {
    if (first[index] !== second[index]) {
      return first[index] < second[index] ? -1 : 1
    }
  }

  return first.length === second.length ? 0 : first.length < second.length ? -1 : 1
}

const gameOrder = (first, second) => {
  const one = levelsOf(first)
  const other = levelsOf(second)

  if (!one || !other) {
    return null
  }

  const orders = [listOrder(one[0], other[0]), listOrder(one[1], other[1]), listOrder(one[2], other[2]), listOrder(one[3], other[3])]

  return orders.find((order) => order !== 0) || 0
}

// The whole race of a save, worked out: for each formation { role, symbol, echelon } ids, or null where the figure is unknown (no elements and no template symbol; a required rank the race does not hold).
const workedOut = (database, ids) => {
  const formations = database.query(`select FormationID, Name, Abbreviation, PopulationID, ShipID, ParentFormationID, RequiredRank, OriginalTemplateID from FCT_GroundUnitFormation where GameID = ${ids.GameID} and RaceID = ${ids.RaceID} order by FormationID`).all()
  const templates = new Map(database.query(`select TemplateID, SymbolType, EchelonLevel from FCT_GroundUnitFormationTemplate where GameID = ${ids.GameID}`).all().map((row) => [row.TemplateID, row]))
  const ranks = database.query(`select RankID, Priority, RankType from FCT_Ranks where GameID = ${ids.GameID} and RaceID = ${ids.RaceID}`).all()
  const ground = ranks.filter((rank) => rank.RankType === 1).sort((a, b) => b.Priority - a.Priority)
  const held = new Map()

  elementsOf(database, ids).forEach((row) => held.set(row.FormationID, [...(held.get(row.FormationID) || []), row]))

  const byId = new Map(formations.map((row) => [row.FormationID, { ...row, rows: held.get(row.FormationID) || [], kids: [] }]))

  byId.forEach((row) => {
    if (row.ParentFormationID > 0 && byId.has(row.ParentFormationID) && row.ParentFormationID !== row.FormationID) {
      byId.get(row.ParentFormationID).kids.push(row)
    }
  })

  const headroom = (row) => (row.rows.length ? Math.max(...row.rows.map((element) => element.HQ)) : 0)
  const place = (one, other) => {
    const capacity = headroom(other) - headroom(one)

    if (capacity) {
      return Math.sign(capacity)
    }

    const abbreviation = gameOrder(one.Abbreviation || '', other.Abbreviation || '')

    return abbreviation === null || abbreviation !== 0 ? abbreviation : gameOrder(one.Name || '', other.Name || '')
  }
  const drawn = new Map()
  const draw = (row, trail) => {
    if (drawn.has(row.FormationID)) {
      return drawn.get(row.FormationID)
    }

    const set = templates.get(row.OriginalTemplateID)
    let symbol = set && set.SymbolType > 0 ? set.SymbolType : row.rows.length ? symbolWorked(row.rows) : null

    if (symbol === 1 && row.PopulationID > 0 && !trail.has(row.FormationID)) {
      const below = row.kids.filter((kid) => kid.PopulationID === row.PopulationID)
      const symbols = below.map((kid) => draw(kid, new Set([...trail, row.FormationID])))

      if (symbols.includes(null)) {
        symbol = null
      } else if (below.length) {
        const tally = new Map()

        symbols.filter((id) => id !== 1 && id !== 14).forEach((id) => tally.set(id, (tally.get(id) || 0) + 1))

        const best = Math.max(0, ...tally.values())
        const competing = below.filter((_kid, index) => tally.get(symbols[index]) === best)
        const possible = competing.filter((kid) => competing.every((other) => place(other, kid) !== -1))

        if (possible.length) {
          const tied = [...tally.values()].filter((count) => count === best).length > 1

          symbol = tied && possible.length > 1 ? null : symbols[below.indexOf(possible[0])]
        }
      }
    }

    drawn.set(row.FormationID, symbol)

    return symbol
  }

  return new Map(formations.map((row) => {
    const mine = byId.get(row.FormationID)
    const set = templates.get(row.OriginalTemplateID)
    const rank = ranks.find((one) => one.RankID === row.RequiredRank)
    const place = rank ? ground.findIndex((one) => one.Priority === rank.Priority) : null
    const echelon = set && set.EchelonLevel > 0 ? set.EchelonLevel : row.RequiredRank > 0 && rank ? (place < 0 ? 1 : ECHELON_NAMES.indexOf(ECHELON_STEPS[Math.min(place, 6)])) : null

    return [row.FormationID, { role: mine.rows.length ? roleWorked(mine.rows) : null, symbol: draw(mine, new Set()), echelon }]
  }))
}

const racesOf = (database, save) => database.query(`select RaceID, count(*) as n from FCT_GroundUnitFormation where GameID = ${SAVES[save].GameID} group by RaceID order by RaceID`).all()

check('fixture', 'every formation of every race of the interim 3.1 save and of the played 3.2 save has the role, symbol and echelon that SQL and arithmetic written here give, the stored symbol text is empty in all of them, and the templates hold the settings the saves do', async (w) => {
  const { groundFormations: g, groundOrganisation: o } = await w.modules()
  let seen = 0

  for (const save of Object.keys(SAVES).filter(present)) {
    const database = copyOf(save)
    const races = racesOf(database, save)
    const counts = { role: new Map(), symbol: new Map(), echelon: new Map(), unknown: 0 }

    assert.equal(races.reduce((sum, race) => sum + race.n, 0), SAVES[save].formations, `${save}: the save holds ${SAVES[save].formations} formations`)
    assert.ok(save !== 'migrated' || races.some((race) => race.RaceID === RACE && race.n === 5337), 'the interim save holds 5,337 formations of race 784')

    for (const race of races) {
      const ids = { GameID: SAVES[save].GameID, RaceID: race.RaceID }
      const model = await g.loadGroundFormations(loaderOf(database), ids)

      assert.equal(model.supported, true, `${save} race ${race.RaceID}: the save is supported`)
      assert.deepEqual(model.organisation, { read: true, gaps: [] }, `${save} race ${race.RaceID}: every column the organisation starts from is read`)
      assert.equal(model.formations.length, race.n, `${save} race ${race.RaceID}: every formation of the race is in the model`)

      const worked = workedOut(database, ids)

      model.formations.forEach((node) => {
        const expected = worked.get(node.id)
        const mine = node.organisation
        const got = { role: mine.role.status === 'unavailable' ? null : value(mine.role).id, symbol: mine.symbol.status === 'unavailable' ? null : value(mine.symbol).id, echelon: mine.echelon.status === 'unavailable' ? null : value(mine.echelon).id }

        assert.deepEqual(got, expected, `${save} formation ${node.id}: role, symbol and echelon ids`)

        if (got.role !== null) {
          assert.equal(value(mine.role).label, ROLE_NAMES[got.role], `${save} formation ${node.id}: the role's name`)
        }

        if (got.symbol !== null) {
          assert.equal(value(mine.symbol).label, SYMBOL_NAMES[got.symbol], `${save} formation ${node.id}: the symbol's name`)
        }

        if (got.echelon !== null) {
          assert.equal(value(mine.echelon).label, ECHELON_NAMES[got.echelon], `${save} formation ${node.id}: the echelon's name`)
        }

        assert.equal(mine.storedSymbol, null, `${save} formation ${node.id}: the stored symbol text is empty`)

        Object.entries(got).forEach(([figure, id]) => counts[figure].set(id, (counts[figure].get(id) || 0) + 1))
        seen++
      })
    }

    assert.equal(database.query(`select count(*) as n from FCT_GroundUnitFormation where GameID = ${SAVES[save].GameID} and FormationSymbol is not null and trim(FormationSymbol) != ''`).get().n, 0, `${save}: no formation stores a symbol text, as the game neither reads nor writes the column`)

    const templates = database.query(`select count(*) as n, sum(SymbolType = 0 and EchelonLevel = 0 and NameThemeID = 0 and RandomFormationNameFromTheme in (0, 1)) as plain from FCT_GroundUnitFormationTemplate where GameID = ${SAVES[save].GameID}`).get()

    assert.deepEqual([templates.n, templates.plain], [SAVES[save].templates, SAVES[save].templates], `${save}: its templates all sit on Auto symbol and echelon with the class-name theme`)
    assert.ok(counts.role.size > 3 && counts.symbol.size > 3 && counts.echelon.size > 2, `${save}: the roles, symbols and echelons are not all one (${counts.role.size}, ${counts.symbol.size}, ${counts.echelon.size})`)
    assert.ok(o.organisationLines((await g.loadGroundFormations(loaderOf(database), { GameID: SAVES[save].GameID, RaceID: races[0].RaceID })).formations[0].organisation).length >= 4, `${save}: the lines of the first formation`)
  }

  assert.ok(seen >= SAVES.migrated.formations, `the formations compared (${seen})`)
})

// ---- Planted copies of the interim save -------------------------------------------------------------------------------
const THEME_TEMPLATES = 7

// The most-used original template of race 784 and the seven lowest template ids of the race: the plants name them. The naval ranks are the race's, one whose priority a ground rank of the race holds and one whose priority none holds, which the plant adds to the rank table.
const PICKS = memo(() => {
  const database = copyOf('migrated')
  const ranks = database.query(`select RankID as id, Priority as priority, RankType as type from FCT_Ranks where GameID = ${GAME} and RaceID = ${RACE}`).all()
  const ground = ranks.filter((rank) => rank.type === 1).sort((a, b) => b.priority - a.priority)
  const placeOf = (priority) => ground.findIndex((rank) => rank.priority === priority)
  const wanted = Math.min(3, Math.max(1, ground.length - 3))
  const naval = ranks.filter((rank) => rank.type === 0).sort((a, b) => Math.abs(placeOf(a.priority) - wanted) - Math.abs(placeOf(b.priority) - wanted) || a.priority - b.priority)[0]

  return {
    used: database.query(`select OriginalTemplateID as id, count(*) as n from FCT_GroundUnitFormation where GameID = ${GAME} and RaceID = ${RACE} group by 1 order by n desc, id limit 1`).get(),
    own: database.query(`select TemplateID as id from FCT_GroundUnitFormationTemplate where GameID = ${GAME} and RaceID = ${RACE} order by TemplateID limit ${THEME_TEMPLATES}`).all().map((row) => row.id),
    naval,
    navalPlace: placeOf(naval.priority),
    absent: { id: Math.max(...database.query('select RankID as id from FCT_Ranks').all().map((rank) => rank.id)) + 1, priority: Math.max(...ground.map((rank) => rank.priority)) + 1 },
    foreign: database.query(`select RankID as id from FCT_Ranks where GameID = ${GAME} and RaceID != ${RACE} and RankType = 1 limit 1`).get().id,
    formations: database.query(`select FormationID as id from FCT_GroundUnitFormation where GameID = ${GAME} and RaceID = ${RACE} and RequiredRank > 0 order by FormationID limit 4`).all().map((row) => row.id),
  }
})

const PLANTS = {
  explicit: () => [`update FCT_GroundUnitFormationTemplate set SymbolType = 12, EchelonLevel = 9, NameThemeID = 643, RandomFormationNameFromTheme = 1 where TemplateID = ${PICKS().used.id}`],
  themes: () => PICKS().own.map((id, index) => `update FCT_GroundUnitFormationTemplate set NameThemeID = ${642 + index}, RandomFormationNameFromTheme = ${index % 2} where TemplateID = ${id}`),
  unlisted: () => [`update FCT_GroundUnitFormationTemplate set NameThemeID = 99999 where TemplateID = ${PICKS().used.id}`],
  ranks: () => [`update FCT_GroundUnitFormation set RequiredRank = 0 where FormationID = ${PICKS().formations[0]}`, `update FCT_GroundUnitFormation set RequiredRank = ${PICKS().naval.id} where FormationID = ${PICKS().formations[1]}`, `update FCT_GroundUnitFormation set RequiredRank = ${PICKS().foreign} where FormationID = ${PICKS().formations[2]}`],
  navalAbsent: () => [`insert into FCT_Ranks (RankID, RaceID, RankName, Priority, RankType, RankAbbrev, GameID) values (${PICKS().absent.id}, ${RACE}, 'Admiral of the Void', ${PICKS().absent.priority}, 0, 'AV', ${GAME})`, `update FCT_GroundUnitFormation set RequiredRank = ${PICKS().absent.id} where FormationID = ${PICKS().formations[3]}`],
  noSymbolType: () => ['alter table FCT_GroundUnitFormationTemplate drop column SymbolType'],
  noNames: () => ['drop table DIM_NamingTheme'],
}

const planted = (name) => copyOf('migrated', name, PLANTS[name]())

// The race's model on a copy, by formation id.
const loadedOn = async (w, database) => {
  const { groundFormations: g } = await w.modules()

  return g.loadGroundFormations(loaderOf(database), IDS)
}

check('planted', 'game-shaped template rows on copies of the interim save: a template that sets its symbol, echelon and naming; the seven themes of the 3.1 line with their name counts; a theme the catalogue lacks; required ranks of 0, a naval rank, a naval rank whose priority no ground rank holds and another race\'s; and a save without a column the rules start from', async (w) => {
  if (!present('migrated')) {
    return
  }

  const { groundOrganisation: o } = await w.modules()
  const intact = await loadedOn(w, copyOf('migrated'))
  const picks = PICKS()

  // A template that sets its symbol, echelon and naming (the columns `Game.LoadGroundUnitFormationTemplates` reads).
  const explicit = await loadedOn(w, planted('explicit'))
  const users = intact.formations.filter((node) => node.templates.original.id === picks.used.id)

  assert.ok(users.length === picks.used.n && users.length > 100, `the template is the original of ${users.length} formations`)

  users.forEach((node) => {
    const now = explicit.byId.get(node.id).organisation

    assert.deepEqual([value(now.symbol).id, value(now.symbol).source, value(now.echelon).id, value(now.echelon).source], [12, 'template', 9, 'template'], `formation ${node.id}: the template's symbol type and echelon decide`)
    assert.equal(o.organisationLines(now).find((line) => line.key === 'naming').text, 'Naming: Legendary Creatures, random names from the theme of 765 names', `formation ${node.id}: the naming is the template's`)
  })

  intact.formations.filter((node) => node.templates.original.id !== picks.used.id).forEach((node) => {
    assert.deepEqual(explicit.byId.get(node.id).organisation, node.organisation, `formation ${node.id}: another template's formations are unchanged`)
  })

  // The seven themes the 3.1 line added, each readable with its own name count.
  const themed = await loadedOn(w, planted('themes'))
  const database = planted('themes')
  const checked = []

  picks.own.forEach((id, index) => {
    const description = database.query(`select Description from DIM_NamingThemeTypes where ThemeID = ${642 + index}`).get().Description
    const names = database.query(`select count(*) as n from DIM_NamingTheme where NameThemeID = ${642 + index}`).get().n
    const node = themed.formations.find((one) => one.templates.original.id === id)

    if (node) {
      const naming = node.templates.original.settings.naming

      checked.push(id)
      assert.deepEqual([naming.themeId, ...themeBrief(naming), naming.names, naming.random, naming.mode], [642 + index, description, true, names, index % 2 === 1, 'themed'], `template ${id}: theme ${642 + index} reads with its name and ${names} names`)
    }
  })

  assert.deepEqual(checked, picks.own.filter((id) => intact.formations.some((node) => node.templates.original.id === id)), 'every one of the seven templates that a formation names was read, and at least four are named')
  assert.ok(checked.length >= 4, `${checked.length} of the seven templates are the original of a formation`)

  assert.deepEqual(picks.own.map((_, index) => database.query(`select count(*) as n from DIM_NamingTheme where NameThemeID = ${642 + index}`).get().n), [50, 765, 407, 34, 97, 69, 100], 'the seven themes list 50, 765, 407, 34, 97, 69 and 100 names')

  // A theme the catalogue lacks is read as the name plus a number.
  const unlisted = await loadedOn(w, planted('unlisted'))
  const stray = unlisted.formations.find((node) => node.templates.original.id === picks.used.id)

  assert.deepEqual([themeBrief(stray.templates.original.settings.naming)[1], stray.templates.original.settings.naming.mode], [false, 'numbered'], 'a theme the catalogue lacks is not listed and numbers the formations')

  // Required ranks the game would work out itself, a naval rank, a naval rank whose priority no ground rank holds, and another race's rank.
  const ranked = await loadedOn(w, planted('ranks'))
  const [zero, naval, foreign] = picks.formations.map((id) => ranked.byId.get(id).organisation.echelon)

  assert.equal(zero.status, 'unavailable', 'a required rank of 0 leaves the echelon unknown')
  assert.ok(picks.navalPlace >= 0 && picks.navalPlace < 6, `the planted naval rank holds the priority of a ground rank inside the chart (place ${picks.navalPlace + 1})`)
  assert.deepEqual([value(naval).label, value(naval).source, value(naval).place], [ECHELON_STEPS[Math.min(picks.navalPlace, 6)], 'rank', picks.navalPlace + 1], `a naval rank draws the ground rank of its priority, here ${ECHELON_STEPS[Math.min(picks.navalPlace, 6)]}`)
  assert.equal(foreign.status, 'unavailable', 'a rank of another race is not one of the race\'s, and leaves the echelon unknown')

  const unheld = await loadedOn(w, planted('navalAbsent'))
  const absent = unheld.byId.get(picks.formations[3]).organisation.echelon

  assert.deepEqual([value(absent).label, value(absent).id], ['None', 1], `a naval rank whose priority no ground rank of the race holds draws no echelon (priority ${picks.absent.priority})`)

  // A save without the template's symbol type, and one without the naming names.
  for (const [name, field] of [['noSymbolType', /symbol type/], ['noNames', /naming/]]) {
    const lacking = await loadedOn(w, planted(name))

    assert.equal(lacking.supported, true, `${name}: the model is still read`)
    assert.equal(lacking.organisation.read, false, `${name}: the organisation is not read`)
    assert.equal(lacking.organisation.gaps.length, 1, `${name}: one field is named: ${lacking.organisation.gaps.join(', ')}`)
    assert.equal(lacking.formations.length, intact.formations.length, `${name}: every formation is in the model`)
    assert.deepEqual(lacking.formations.map((node) => [node.id, node.mass.value, node.geo.value, node.xeno.value]), intact.formations.map((node) => [node.id, node.mass.value, node.geo.value, node.xeno.value]), `${name}: the masses and ratings are unchanged`)

    const first = lacking.formations[0].organisation

    for (const figure of ['role', 'symbol', 'echelon']) {
      assert.equal(first[figure].status, 'unavailable', `${name}: the ${figure} is unknown`)
    }

    assert.ok(missing(first.role).some((text) => field.test(text)), `${name}: the missing field is named: ${missing(first.role).join(' | ')}`)
    assert.ok(missing(first.role).every((text) => !/\b(?:FCT|DIM)_/.test(text)), `${name}: in words: ${missing(first.role).join(' | ')}`)
  }
})

check('rows', 'Survey Progress\'s formation rows carry the organisation of each formation, as the model has it', async (w) => {
  if (!present('migrated')) {
    return
  }

  const { remoteFormations: r } = await w.modules()
  const loaded = await loadedOn(w, copyOf('migrated'))
  const rows = r.formationRows(loaded)

  assert.equal(rows.length, loaded.formations.length, 'one row per formation')
  rows.forEach((row) => assert.equal(row.organisation, loaded.byId.get(row.id).organisation, `formation ${row.id}: the row carries the organisation of the node`))
})

check('capability', 'the registry no longer declares the symbol and template columns as read later, the reports that read the formations name each column, and a save without one degrades those reports by their formation inputs and withholds no page', async (w) => {
  const { capabilities: k } = await w.modules()
  const declared = k.DECLARED.filter((entry) => ['FCT_GroundUnitFormation', 'FCT_GroundUnitFormationTemplate'].includes(entry.table))

  assert.deepEqual(declared.map((entry) => `${entry.table} ${entry.columns.join()}`), [], 'the pages read the columns, so the registry does not declare them')

  const wanted = { FCT_GroundUnitFormation: ['RequiredRank', 'FormationSymbol'], FCT_GroundUnitFormationTemplate: ['NameThemeID', 'RandomFormationNameFromTheme', 'SymbolType', 'EchelonLevel'], FCT_GroundUnitClass: ['BaseType', 'HQCapacity'], DIM_GroundComponentType: ['LogisticsPoints', 'BombardmentWeapon', 'AAWeapon', 'Construction', 'Decontamination'], FCT_Ranks: ['RankID', 'Priority', 'RankType'], DIM_NamingThemeTypes: ['ThemeID', 'Description'], DIM_NamingTheme: ['NameThemeID'] }

  for (const [route, key] of [['/map', 'groundFormations'], ['/survey-progress', 'formations'], ['/commanders', 'groundTree']]) {
    const input = k.INPUTS[route].find((one) => one.key === key)

    assert.ok(input && input.optional === true, `${route} ${key}: an input the page goes on without`)

    Object.entries(wanted).forEach(([table, columns]) => {
      columns.forEach((column) => assert.ok(input.reads[table] && input.reads[table].includes(column), `${route} ${key}: reads ${table}.${column}`))
    })
  }

  if (!present('migrated')) {
    return
  }

  const whole = await k.preflight(loaderOf(copyOf('migrated')))

  for (const route of ['/map', '/survey-progress', '/commanders']) {
    assert.equal(whole.reports[route].status, 'supported', `${route}: whole on the interim save`)
  }

  const lacking = await k.preflight(loaderOf(planted('noSymbolType')))

  for (const route of ['/map', '/survey-progress', '/commanders']) {
    const report = lacking.reports[route]

    assert.equal(report.status, 'degraded', `${route}: a save without the symbol type degrades the report and withholds no page, not ${report.status}`)
    assert.deepEqual(report.missing, [], `${route}: nothing the page cannot do without`)
    assert.ok(report.degraded.some((entry) => entry.fields.includes('FCT_GroundUnitFormationTemplate.SymbolType')), `${route}: the report names the column`)
  }
})

// The text of the page's template from the element of the organisation lines to the cell that ends it, empty where the template has none.
const organisationBlock = (text) => {
  const from = text.indexOf('<div v-if="item.organisation"')
  const to = text.indexOf('</td>', from)

  return from < 0 || to < from ? '' : text.slice(from, to).trimEnd()
}

check('text', 'the expanded row of the formations table draws the organisation lines of the row, and the footer of the panel says what they are', async (w) => {
  const { groundOrganisation: o } = await w.modules()
  const text = w.texts.surveyPage
  const block = organisationBlock(text)

  assert.ok(block.length > 0, 'the page\'s expanded row has the block of the organisation lines')
  const organisation = await organisationOf(w, one([unit(1, 0, 100)], [[1, 1]], { templates: [template(10, { NameThemeID: 643, RandomFormationNameFromTheme: 1 })], formation: { template: 10, rank: 105 } }))

  const { tree, errors } = renderTree(`<template><div>${block}</div></template>`, { item: { id: 7, organisation }, organisationOf: (value_) => o.organisationLines(value_) })

  assert.deepEqual(errors, [], 'the extracted block compiles')

  const nodes = treeOf(tree)
  const lines = nodes.filter((node) => node.data.attrs && 'data-organisation-line' in node.data.attrs)

  assert.deepEqual(lines.map((node) => node.data.attrs['data-organisation-line']), ['role', 'symbol', 'echelon', 'naming'], 'a line each for the role, the symbol, the echelon and the naming')
  assert.deepEqual(lines.map((node) => (Array.isArray(node.children) ? node.children.join('') : String(node.children))), [
    'Role: Generic (tentative), by the tonnage of its elements',
    'Symbol: Infantry, worked out from the elements',
    'Echelon: Brigade, from the required rank',
    'Naming: Legendary Creatures, random names from the theme of 765 names',
  ], 'in the words of the module')
  assert.ok(nodes.some((node) => node.data.attrs && node.data.attrs['data-organisation-formation'] === 7), 'the block is marked with its formation')

  const stored = await organisationOf(w, one([unit(1, 0, 100)], [[1, 1]], { formation: { symbol: ' AB ' } }))
  const storedLines = o.organisationLines(stored)

  assert.equal(stored.storedSymbol, 'AB', 'a symbol text a save holds is kept, trimmed')
  assert.deepEqual(storedLines.filter((line) => line.key === 'stored').map((line) => line.text), ['Symbol text stored with the formation: AB, which the game does not read'], 'and shown with the note that the game does not read it')
  assert.deepEqual(o.organisationLines(organisation).filter((line) => line.key === 'stored'), [], 'a formation whose symbol text is empty shows no such line')
  assert.equal((await organisationOf(w, one([unit(1, 0, 100)], [[1, 1]], { formation: { symbol: '   ' } }))).storedSymbol, null, 'a blank text is no text')

  const none = renderTree(`<template><div>${block}</div></template>`, { item: { id: 8, organisation: null }, organisationOf: (value_) => o.organisationLines(value_) })

  assert.equal(treeOf(none.tree).filter((node) => node.data.attrs && 'data-organisation-line' in node.data.attrs).length, 0, 'a row with no organisation draws no lines')

  assert.ok(/import \{ organisationLines \} from '\.\.\/utilities\/ground-organisation'/.test(text), 'the page imports the lines of the module')
  assert.ok(/organisationOf\(organisation\) \{\s*return organisationLines\(organisation\)\s*\}/.test(text), 'and its method gives them')

  const foot = text.slice(text.indexOf('Use it to find the forces stationed at no colony and where they are.'))
  const sentence = foot.slice(0, foot.indexOf('</div>'))

  assert.ok(/The expanded row also gives the role, symbol and echelon the game works out for the formation and how its original template names new formations\./.test(sentence), 'the footer says what the expanded row adds')
  assert.ok(/The game saves none of the three, so each is read from the rule of its source, and shows as unknown where the save lacks what the rule starts from or where the game would work the required rank out for itself\./.test(sentence), 'and that none is saved, so each is a reading of a rule and may be unknown')
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'a tie at the fraction of the rest counts as above it', target: 'groundOrganisation', from: 'const above = (amount, whole, top, bottom) => amount * bottom > whole * top', to: 'const above = (amount, whole, top, bottom) => amount * bottom >= whole * top', fails: ['role', 'symbol'] },
  { name: 'the tonnage of a part is not kept in whole millionths', target: 'groundOrganisation', from: 'Math.round(known.size * item.units * SIZE_SCALE)', to: 'known.size * item.units * SIZE_SCALE', fails: ['role'] },
  { name: 'logistics at exactly twice the rest give ground logistics', target: 'groundOrganisation', from: '  const rest = sums.total - sums.logistics\n\n  if (sums.logistics > rest * 2) {', to: '  const rest = sums.total - sums.logistics\n\n  if (sums.logistics >= rest * 2) {', fails: ['role'] },
  { name: 'anti-air is tested before artillery in the role', target: 'groundOrganisation', from: '[[\'artillery\', ROLE.artillery], [\'antiAir\', ROLE.antiAir]', to: '[[\'antiAir\', ROLE.antiAir], [\'artillery\', ROLE.artillery]', fails: ['role'] },
  { name: 'light vehicles are not vehicles in the role', target: 'groundOrganisation', from: 'Object.freeze([1, 2, 3, 4, 6])', to: 'Object.freeze([1, 2, 3, 4])', fails: ['role'] },
  { name: 'static units are tested before vehicles in the role', target: 'groundOrganisation', from: 'return above(sums.vehicles, rest, 3, 5) ? ROLE.attack : above(sums.statics, rest, 3, 5) ? ROLE.defence : ROLE.generic', to: 'return above(sums.statics, rest, 3, 5) ? ROLE.defence : above(sums.vehicles, rest, 3, 5) ? ROLE.attack : ROLE.generic', fails: ['role', 'fixture'] },
  { name: 'the rest of the role keeps the logistics in', target: 'groundOrganisation', from: 'const sums = tonnage(parts, (part) => part.sto === true)\n  const rest = sums.total - sums.logistics', to: 'const sums = tonnage(parts, (part) => part.sto === true)\n  const rest = sums.total', fails: ['role', 'fixture'] },
  { name: 'the role counts a class\'s surface-to-orbit weapon', target: 'groundOrganisation', from: 'const sums = tonnage(parts, (part) => part.sto === true)', to: 'const sums = tonnage(parts, (part) => part.stoClass === true)', fails: ['role'] },
  { name: 'the symbol leaves a class\'s surface-to-orbit weapon out', target: 'groundOrganisation', from: 'const sums = tonnage(parts, (part) => part.stoClass === true)', to: 'const sums = tonnage(parts, (part) => part.sto === true)', fails: ['symbol'] },
  { name: 'the headquarters needs two fifths of the total', target: 'groundOrganisation', from: 'if (above(sums.hq, sums.total, 1, 2)) {', to: 'if (above(sums.hq, sums.total, 2, 5)) {', fails: ['symbol'] },
  { name: 'surface to orbit is tested before air defence in the symbol', target: 'groundOrganisation', from: '[\'antiAir\', SYMBOL.airDefence, 2, 5], [\'sto\', SYMBOL.surfaceToOrbit, 2, 5]', to: '[\'sto\', SYMBOL.surfaceToOrbit, 2, 5], [\'antiAir\', SYMBOL.airDefence, 2, 5]', fails: ['symbol'] },
  { name: 'static defence needs only two fifths', target: 'groundOrganisation', from: '[\'statics\', SYMBOL.staticDefence, 3, 5]', to: '[\'statics\', SYMBOL.staticDefence, 2, 5]', fails: ['symbol'] },
  { name: 'any infantry or vehicles make mechanised infantry', target: 'groundOrganisation', from: 'sums.infantry > 0 && sums.vehicles > 0', to: 'sums.infantry > 0 || sums.vehicles > 0', fails: ['symbol'] },
  { name: 'supply at exactly twice the rest is supply', target: 'groundOrganisation', from: '} else if (sums.logistics > rest * 2) {', to: '} else if (sums.logistics >= rest * 2) {', fails: ['symbol'] },
  { name: 'a template on Auto is taken as the symbol type it stores', target: 'groundOrganisation', from: '    } else if (!set.auto) {\n      return ofRule({ rule, value: { id: set.value, label: set.label, source: \'template\' }, inputs: { present: [\'the symbol type of the original template\'] } })', to: '    } else if (true) {\n      return ofRule({ rule, value: { id: set.value, label: set.label, source: \'template\' }, inputs: { present: [\'the symbol type of the original template\'] } })', fails: ['symbol', 'fixture'] },
  { name: 'the symbol type of another race\'s template is ignored', target: 'groundOrganisation', from: '  if (template.state === \'found\' || template.state === \'foreign\') {\n    const set = template.settings && template.settings.symbolType', to: '  if (template.state === \'found\') {\n    const set = template.settings && template.settings.symbolType', fails: ['symbol'] },
  { name: 'a symbol type the game has no name for is taken as it is', target: 'groundOrganisation', from: 'Number.isInteger(stored) && stored >= 0 && stored < labels.length ? labels[stored] : null', to: 'Number.isInteger(stored) && stored >= 0 ? labels[stored] : null', fails: ['symbol', 'echelon'] },
  { name: 'a naval rank is no ground rank', target: 'groundOrganisation', from: '  const rank = ranks.find((one) => one.RankID === rankId)\n\n  if (!rank || !isNumber(rank.Priority)) {\n    return null\n  }', to: '  const rank = ranks.find((one) => one.RankID === rankId && one.RankType === GROUND_RANK)\n\n  if (!rank || !isNumber(rank.Priority)) {\n    return { id: ECHELON_NONE, place: -1 }\n  }', fails: ['echelon', 'planted'] },
  { name: 'the echelon stops at corps', target: 'groundOrganisation', from: 'Math.min(place, CHART_ECHELONS.length - 1)', to: 'Math.min(place, CHART_ECHELONS.length - 2)', fails: ['echelon'] },
  { name: 'the ground ranks are counted from the highest', target: 'groundOrganisation', from: '.sort((a, b) => b.Priority - a.Priority)', to: '.sort((a, b) => a.Priority - b.Priority)', fails: ['echelon', 'fixture'] },
  { name: 'a theme the catalogue lacks is not replaced by the name plus a number', target: 'groundOrganisation', from: 'const id = listed ? themeId : FALLBACK_THEME', to: 'const id = themeId', fails: ['naming', 'planted'] },
  { name: 'a random flag above 0 counts as random', target: 'groundOrganisation', from: 'row.RandomFormationNameFromTheme === 1', to: 'row.RandomFormationNameFromTheme > 0', fails: ['naming'] },
  { name: 'only theme 0 numbers the formations', target: 'groundOrganisation', from: 'const NUMBERED_THEMES = 1', to: 'const NUMBERED_THEMES = 0', fails: ['naming'] },
  { name: 'a headquarters counts the formations of every colony below it', target: 'groundOrganisation', from: 'child && child.colony === entry.colony', to: 'child', fails: ['symbol'] },
  { name: 'a generic child counts in the headquarters pass', target: 'groundOrganisation', from: 'if (idOf(child) !== SYMBOL.headquarters && idOf(child) !== SYMBOL.generic) {', to: 'if (idOf(child) !== SYMBOL.headquarters) {', fails: ['symbol'] },
  { name: 'a tie in the headquarters pass goes to the symbol met last', target: 'groundOrganisation', from: 'const pick = idOf(first[0])', to: 'const pick = idOf(candidates[candidates.length - 1])', fails: ['symbol'] },
  { name: 'the headquarters pass sorts with JavaScript\'s text comparison', target: 'groundOrganisation', from: 'const order = chartOrder(first[field] || \'\', second[field] || \'\')', to: 'const order = (first[field] || \'\').localeCompare(second[field] || \'\')', fails: ['symbol'] },
  { name: 'a tie the game\'s comparison does not order is chosen anyway', target: 'groundOrganisation', from: 'if (tied.size > 1 && first.length > 1) {', to: 'if (false) {', fails: ['symbol', 'headquartersOrder'] },
  { name: 'the per-symbol-leader shortcut hides another child that could be first', target: 'groundOrganisation', from: 'const candidates = sorted.filter((child) => tied.has(idOf(child)))', to: 'const candidates = sorted.filter((child, index) => tied.has(idOf(child)) && sorted.findIndex((other) => idOf(other) === idOf(child)) === index)', fails: ['headquartersOrder'] },
  { name: 'an id fallback establishes an unsupported chart comparison', target: 'groundOrganisation', from: '    if (order === null) {\n      return null\n', to: '    if (order === null) {\n      return first.id - second.id\n', fails: ['headquartersOrder'] },
  { name: 'the children below a headquarters are sorted by the smallest capacity first', target: 'groundOrganisation', from: 'const capacity = (second.hq ?? 0) - (first.hq ?? 0)', to: 'const capacity = (first.hq ?? 0) - (second.hq ?? 0)', fails: ['symbol'] },
  { name: 'a headquarters aboard a ship takes the symbol of the formations below', target: 'groundOrganisation', from: '|| !(entry.colony > 0)', to: '|| false', fails: ['symbol'] },
  { name: 'a formation with no element rows is classed from nothing', target: 'groundOrganisation', from: 'if (!items.length) {', to: 'if (false) {', fails: ['unknown'] },
  { name: 'a save without a column the rules start from is worked out from null columns', target: 'groundOrganisation', from: 'export const organise = ({ order, rowOf, classes, figures, ranks, ranksRead, gaps }) => {\n  if (gaps.length) {', to: 'export const organise = ({ order, rowOf, classes, figures, ranks, ranksRead, gaps }) => {\n  if (false) {', fails: ['unknown', 'planted'] },
  { name: 'the loader reports every column of the organisation as read', target: 'groundFormations', from: 'rows.organisation = { read: !gaps.length, gaps }', to: 'rows.organisation = { read: true, gaps: [] }', fails: ['planted'] },
  { name: 'the formation read leaves the required rank out', target: 'groundFormations', from: '${organisation ? \'FCT_GroundUnitFormation.RequiredRank\' : \'null as RequiredRank\'}', to: '${\'null as RequiredRank\'}', fails: ['fixture', 'planted'] },
  { name: 'a theme\'s name count is one too many', target: 'groundFormations', from: 'count(*) as Names', to: 'count(*) + 1 as Names', fails: ['planted'] },
  { name: 'the ranks of every race of the game are read', target: 'groundFormations', from: 'where FCT_Ranks.GameID = ${g} and FCT_Ranks.RaceID = ${r}`', to: 'where FCT_Ranks.GameID = ${g}`', fails: ['fixture'] },
  { name: 'a template carries no settings', target: 'groundFormations', from: 'settings: settingsOf(row, themes, counts) }', to: 'settings: null }', fails: ['fixture', 'planted'] },
  { name: 'the name counts of the themes are not passed on', target: 'groundFormations', from: 'counts: themeNameRows ? new Map(themeNameRows.map((row) => [row.NameThemeID, row.Names])) : null', to: 'counts: null', fails: ['planted'] },
  { name: 'the rows leave the organisation out', target: 'remoteFormations', from: 'mass: node.mass.value, organisation: node.organisation }', to: 'mass: node.mass.value }', fails: ['rows'] },
  { name: 'the registry declares the symbol column as read later again', target: 'capabilities', from: 'export const DECLARED = Object.freeze([', to: 'export const DECLARED = Object.freeze([\n  Object.freeze({ item: \'AE-308-07\', readBy: \'AE-309-05\', table: \'FCT_GroundUnitFormation\', columns: Object.freeze([\'FormationSymbol\']) }),', fails: ['capability'] },
  { name: 'Survey Progress cannot do without the formations', target: 'capabilities', from: '[\'formations\', \'groundCommanders\', \'ruinSites\'', to: '[\'groundCommanders\', \'ruinSites\'', fails: ['capability'] },
  { name: 'the expanded row draws no organisation', target: 'surveyPage', from: '<div v-if="item.organisation" class="caption mt-2" data-organisation', to: '<div v-if="false" class="caption mt-2" data-organisation', fails: ['text'] },
  { name: 'the organisation lines are keyed by their text', target: 'surveyPage', from: ':data-organisation-line="line.key"', to: ':data-organisation-line="line.text"', fails: ['text'] },
  { name: 'the expanded row loops over no lines', target: 'surveyPage', from: 'v-for="line in organisationOf(item.organisation)"', to: 'v-for="line in []"', fails: ['text'] },
  { name: 'the page\'s method gives no lines', target: 'surveyPage', from: 'return organisationLines(organisation)', to: 'return []', fails: ['text'] },
  { name: 'the page does not import the lines of the module', target: 'surveyPage', from: 'import { organisationLines } from \'../utilities/ground-organisation\'\n', to: '', fails: ['text'] },
  { name: 'the footer does not say what the expanded row adds', target: 'surveyPage', from: 'The expanded row also gives the role, symbol and echelon the game works out for the formation and how its original template names new formations. ', to: '', fails: ['text'] },
  { name: 'the footer says the game saves the three', target: 'surveyPage', from: 'The game saves none of the three, so each is read from the rule of its source, and shows as unknown where the save lacks what the rule starts from or where the game would work the required rank out for itself. ', to: 'The game saves all three. ', fails: ['text'] },
]

// Rewrites that say the same thing: a product with its factors the other way round, a guard written from the other side, a minimum with its operands swapped, a comparison with its operands swapped, a conditional turned round, a copy of an array taken another way, and a class and the order of the columns of a select.
const BENIGN = [
  { name: 'the product of a comparison with its factors swapped', target: 'groundOrganisation', from: 'amount * bottom > whole * top', to: 'amount * bottom > top * whole' },
  { name: 'the guard on the required rank written from the other side', target: 'groundOrganisation', from: 'const found = requiredRank > 0 ? echelonOfRank(ranks, requiredRank) : null', to: 'const found = requiredRank <= 0 ? null : echelonOfRank(ranks, requiredRank)' },
  { name: 'the cap on the echelon with its operands swapped', target: 'groundOrganisation', from: 'Math.min(place, CHART_ECHELONS.length - 1)', to: 'Math.min(CHART_ECHELONS.length - 1, place)' },
  { name: 'the automatic flag compared with its operands swapped', target: 'groundOrganisation', from: 'auto: stored === 0', to: 'auto: 0 === stored' },
  { name: 'the fallback theme chosen by the other branch', target: 'groundOrganisation', from: 'const id = listed ? themeId : FALLBACK_THEME', to: 'const id = !listed ? FALLBACK_THEME : themeId' },
  { name: 'the children copied with slice', target: 'groundOrganisation', from: 'const sorted = [...below].sort(', to: 'const sorted = below.slice().sort(' },
  { name: 'the ground ranks sorted by a negated difference', target: 'groundOrganisation', from: '.sort((a, b) => b.Priority - a.Priority)', to: '.sort((a, b) => -(a.Priority - b.Priority))' },
  { name: 'the columns of the ranks read in another order', target: 'groundFormations', from: 'select FCT_Ranks.RankID, FCT_Ranks.Priority, FCT_Ranks.RankType from FCT_Ranks', to: 'select FCT_Ranks.RankType, FCT_Ranks.Priority, FCT_Ranks.RankID from FCT_Ranks' },
  { name: 'the class of the organisation block changed', target: 'surveyPage', from: 'class="caption mt-2" data-organisation', to: 'class="caption mt-3" data-organisation' },
]
/* eslint-enable no-template-curly-in-string */

// ---- Run ------------------------------------------------------------------------------------------------------------
const run = async (checks, world) => {
  const failures = []

  for (const { name, run: body } of checks) {
    try {
      await body(world)
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

const main = async () => {
  if (!present('migrated')) {
    console.log(`UNSUPPORTED  every check that needs a save: the fixture ${SAVES.migrated.file} is not there`)
  }

  const failures = await run(CHECKS, worldOf())
  let passed = CHECKS.length - failures.length
  let total = CHECKS.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutating()) {
    FAULTS.forEach(({ name, fails }) => fails.forEach((id) => assert.ok(CHECKS.some((one) => one.name === id), `${name}: no check named ${id}`)))

    const benignOnly = await run(CHECKS, worldOf(textWith(BENIGN)))

    total += 1

    if (benignOnly.length) {
      console.log(`FAIL every rewrite applied: ${benignOnly.map(describeFailure).join('; ')}`)
    } else {
      passed += 1
    }

    const attempts = FAULTS.flatMap((fault) => [[fault, []], [fault, BENIGN]])
    const outcomes = await inParallel(attempts, async ([fault, benign]) => {
      const texts = textWith()

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

      // The rewrites go onto the faulty source where their text is still there exactly once: a fault may replace the very text a rewrite says again.
      benign.filter((edit) => texts[edit.target].split(edit.from).length === 2).forEach((edit) => {
        texts[edit.target] = patched(FILES[edit.target], texts[edit.target], edit.from, edit.to)
      })

      const world = worldOf(texts)
      const missed = []

      for (const id of fault.fails) {
        const [failed] = await run(CHECKS.filter((one) => one.name === id), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(id)
        }
      }

      return { label: `${fault.name}${benign.length ? ', on the source with every rewrite' : ''}`, missed }
    })

    outcomes.forEach((outcome) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault: ${outcome.message}`)
      } else if (outcome.missed.length) {
        console.log(`FAIL planted fault ${outcome.label}: still passes ${outcome.missed.join(', ')}`)
      } else {
        passed += 1
      }
    })
  }

  console.log(`${passed} of ${total} checks passed`)

  return passed === total
}

main()
  .then((green) => {
    closeCopies()
    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    closeCopies()
    process.exit(2)
  })
