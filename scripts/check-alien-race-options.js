/*
  Checks the alien race options of the Intelligence page (utilities/intelligence.js `raceColour`, `colourText`, `hostileSettings`, `hostileSummary` and `raceOptionsSql`, pages/intelligence.vue): the colour each alien race was given (FCT_AlienRace.AlienRaceColour) and, for each system, whether the player's event interrupt for a hostile contact is silenced (FCT_AlienRaceSystemStatus.NoHostileInterrupt), with the statement that the setting silences nothing but that interrupt.

  Run: bun scripts/check-alien-race-options.js [--no-mutations]

  The rule is the game's: `Game.SaveRaces` saves the colour of an alien race as `Color.ToArgb()` (a signed 32-bit ARGB number, 0 for `Color.Empty`) and the load reads it back with `Color.FromArgb`; the 3D galactic map draws a race whose colour has an alpha of 0 in white (`GalacticMap3D`); `Game.SaveRaceSysSurvey` saves one FCT_AlienRaceSystemStatus row for each setting of a system of the viewing race against one alien race, and `IncrementManager.method_5` leaves the interrupt (`GameInstance.bool_0`, `bool_1`) unset for a NewHostileContact or HostileContactUpdate event of a race that is not an NPR when that row's `NoHostileInterrupt` is true, after the event has been added to the log, and does so for no other event or race. A system with no row is not silenced. Every expected figure is written here from that rule and from the saved rows, never read from the module:
  - `colour`: the stored number decoded as the game's `Color.FromArgb` reads it, built here from the four bytes (an opaque colour, a translucent one, a colour with an alpha of 0, a saved 0, the same colour written unsigned), a value that is not an integer of 32 bits unavailable and named, and the words for each;
  - `flag`: the setting of each system from the rows stored for the race and the systems it was seen in (a stored 1 silenced, a stored 0 not, the boolean, numeric and True/False forms of the stored flag, a flag that is not one unknown, a system with no row not silenced and said so, a system with a row that the race was not seen in listed, the names of the viewing race), and the summary of them in words;
  - `fixture`: on the interim 3.1 fixture (saves/AuroraDB-310-spookyerol-migrated.db, game 141, race 784) the page's reads give the three alien races with the colour the rows store and the settings the table stores, equal to SQL written here; the fixture stores no colour (every race holds 0) and no setting (the table is empty), so both are planted into in-memory copies and a saved case needs the specimen S18 of AE-310-03;
  - `page`: the page's own script, run over the fixture and the planted copies (scripts/lib/page-loader.js), reads the race options as an input of its own, shows each race's colour and its hostile contact settings system by system (a race of another viewing race never among them), with the facts of the selected race, and its rows carry the swatch only for a colour that is set;
  - `capability`: the page's reads name the two columns as an ordinary input of its route, the registry no longer declares them, and a save without either column cannot give the page (the report is unsupported, naming the input and the field);
  - `text`: the page draws the swatch beside the race's name, the colour among the facts and one chip for each system saying silenced or not silenced, and states under the facts and under Systems and species that the setting only silences the player's event interrupt (the event still logged), that a system with no stored setting is not silenced and what the colour is; the page help and the rule note say the same.

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { renderTree, treeOf, attrsOf } = require('./lib/vue-render')

const root = path.resolve(__dirname, '..')
const SAVE = 'saves/AuroraDB-310-spookyerol-migrated.db'
const GAME = 141
const RACE = 784
// The viewing race of a row of another empire, which the page of RACE never shows.
const OTHER_VIEWER = 999
const STARFARERS = 787
const KARACHI = 789
const PRECURSORS = 786
const COLOUR_MISSING = 'the colour of the race'
// The notes the check has printed, so a run with planted faults says each once.
const NOTED = new Set()

const FILES = {
  intelligence: path.join(root, 'src', 'renderer', 'utilities', 'intelligence.js'),
  capabilities: path.join(root, 'src', 'renderer', 'utilities', 'capabilities.js'),
  glossary: path.join(root, 'src', 'renderer', 'utilities', 'glossary.js'),
  intelligencePage: path.join(root, 'src', 'renderer', 'pages', 'intelligence.vue'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

// The packages the utilities and the page import, as the least the checks need of them.
const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: `import { createRequire } from 'node:module'\nexport default createRequire(${JSON.stringify(path.join(root, 'package.json'))})('dayjs')`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default createRequire(${JSON.stringify(path.join(root, 'package.json'))})('dayjs/plugin/utc.js')`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const APPEARANCE = 'export const activeAppearance = () => ({}); export const toneColor = () => undefined'

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

// ---- The modules and the page as shipped, or with edits planted ---------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => ({
  texts,
  modules: memo(async () => {
    const loaded = await loadUtilities(['intelligence', 'capabilities', 'glossary'], { stubs: STUBS, sources: { intelligence: texts.intelligence, capabilities: texts.capabilities, glossary: texts.glossary } })

    return loaded
  }),
  page: memo(() => loadPage('pages/intelligence', { stubs: STUBS, modules: { 'utilities/appearance': APPEARANCE }, sources: { 'pages/intelligence': texts.intelligencePage, 'utilities/intelligence': texts.intelligence, 'utilities/capabilities': texts.capabilities, 'utilities/glossary': texts.glossary } })),
})

// ---- The fixture, as in-memory copies ------------------------------------------------------------------------------
// The colour the game saves for (alpha, red, green, blue): `Color.ToArgb()`, a signed 32-bit number.
const argbOf = (alpha, red, green, blue) => ((alpha << 24) | (red << 16) | (green << 8) | blue) | 0

const DODGER = argbOf(255, 30, 144, 255)
const TRANSLUCENT = argbOf(128, 255, 0, 0)

// The systems the plants use, read from the saved rows: the three systems the Starfarers were seen in, one the Karachi Federation were seen in and one system of the race that neither was seen in.
const systemsOf = (database) => {
  const seen = (alien) => database.query(`select SystemID from FCT_AlienSystem where GameID = ${GAME} and DetectRaceID = ${RACE} and AlienRaceID = ${alien} order by SystemID`).all().map((row) => row.SystemID)
  const starfarers = seen(STARFARERS)
  const karachi = seen(KARACHI)
  const unseen = database.query(`select SystemID from FCT_RaceSysSurvey where GameID = ${GAME} and RaceID = ${RACE} and SystemID not in (select SystemID from FCT_AlienSystem where GameID = ${GAME} and DetectRaceID = ${RACE}) order by SystemID`).get().SystemID

  return { starfarers, karachi, unseen }
}

const status = (alien, system, protection, viewer, silenced) => `insert into FCT_AlienRaceSystemStatus (AlienRaceID, ProtectionStatusID, GameID, SystemID, ViewingRaceID, NoHostileInterrupt) values (${alien}, ${protection}, ${GAME}, ${system}, ${viewer}, ${silenced})`

const PLANTS = {
  intact: () => [],
  coloured: () => [`update FCT_AlienRace set AlienRaceColour = ${DODGER} where GameID = ${GAME} and ViewRaceID = ${RACE} and AlienRaceID = ${STARFARERS}`, `update FCT_AlienRace set AlienRaceColour = ${TRANSLUCENT} where GameID = ${GAME} and ViewRaceID = ${RACE} and AlienRaceID = ${KARACHI}`, `update FCT_AlienRace set AlienRaceColour = ${DODGER} where GameID = ${GAME} and ViewRaceID <> ${RACE} and AlienRaceID = ${STARFARERS}`],
  settings: ({ starfarers, karachi, unseen }) => [status(STARFARERS, starfarers[0], 0, RACE, 1), status(STARFARERS, unseen, 3, RACE, 0), status(KARACHI, karachi[0], 2, RACE, 1), status(PRECURSORS, starfarers[0], 1, OTHER_VIEWER, 1)],
  droppedColour: () => ['alter table FCT_AlienRace drop column AlienRaceColour'],
  droppedFlag: () => ['alter table FCT_AlienRaceSystemStatus drop column NoHostileInterrupt'],
}
let BYTES = null
const COPIES = new Map()
let SYSTEMS = null

// The saved bytes once, and a copy of them with the statements of one plant run on it, made in memory so that no file is written.
const copyOf = (name) => {
  if (!PLANTS[name]) {
    throw new Error(`no planted copy named ${name}`)
  }

  if (!COPIES.has(name)) {
    BYTES = BYTES || fs.readFileSync(path.join(root, SAVE))

    const database = Database.deserialize(BYTES)

    SYSTEMS = SYSTEMS || systemsOf(database)
    PLANTS[name](SYSTEMS).forEach((statement) => database.run(statement))
    COPIES.set(name, database)
  }

  return COPIES.get(name)
}

const closeCopies = () => {
  COPIES.forEach((database) => database.close())
  COPIES.clear()
}

const loaderOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })

// ---- What the save holds, in SQL written here -----------------------------------------------------------------------
const oracleColours = (database) => database.query(`select AlienRaceID, AlienRaceColour from FCT_AlienRace where GameID = ${GAME} and ViewRaceID = ${RACE} order by AlienRaceID`).all()

const oracleSettings = (database) => database.query(`select VIR_Status.AlienRaceID, VIR_Status.SystemID, VIR_Status.NoHostileInterrupt, (select VIR_Survey.Name from FCT_RaceSysSurvey as VIR_Survey where VIR_Survey.GameID = VIR_Status.GameID and VIR_Survey.RaceID = ${RACE} and VIR_Survey.SystemID = VIR_Status.SystemID) as Name from FCT_AlienRaceSystemStatus as VIR_Status where VIR_Status.GameID = ${GAME} and VIR_Status.ViewingRaceID = ${RACE} order by VIR_Status.AlienRaceID, VIR_Status.SystemID`).all()

// The colour the game reads back from a saved number (`Color.FromArgb`), from its four bytes: { alpha, red, green, blue } of the 32-bit pattern.
const bytesOf = (stored) => {
  const pattern = stored < 0 ? stored + 2 ** 32 : stored

  return { alpha: Math.floor(pattern / 2 ** 24) % 256, red: Math.floor(pattern / 2 ** 16) % 256, green: Math.floor(pattern / 2 ** 8) % 256, blue: pattern % 256 }
}

const hexOf = ({ red, green, blue }) => `#${[red, green, blue].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`

const value = (result) => (result && result.status !== 'unavailable' ? result.value : null)

// ---- The page's own glue, from its source ---------------------------------------------------------------------------
const pageOf = async (w, database, selectedId = null) => {
  const options = await w.page()
  const page = instantiate(options, { $store: { getters: { StartYear: 2000, historyRecorded: true }, state: { history: { revision: 0 } }, dispatch: () => Promise.resolve() }, database: loaderOf(database), GameID: GAME, RaceID: RACE, data: { selectedId } })

  for (const name of ['races', 'systems', 'raceOptions']) {
    await page.runAsync(name)
  }

  return page
}

// The text of the template from `opener` to the end of the template it opens.
const templateBlock = (text, opener) => {
  const from = text.indexOf(opener)

  if (from < 0) {
    throw new Error(`the Intelligence page's template has no ${opener} where the check looks for it`)
  }

  let depth = 0

  for (const match of text.slice(from).matchAll(/<template\b|<\/template>/g)) {
    depth += match[0] === '</template>' ? -1 : 1

    if (depth === 0) {
      return text.slice(from, from + match.index + '</template>'.length)
    }
  }

  throw new Error(`the template at ${opener} is not closed`)
}

const flat = (node) => (Array.isArray(node) ? node.map(flat).join('') : typeof node === 'string' ? node : node && typeof node === 'object' ? flat(node.children) : '')

const rendered = (source, vm) => {
  const { tree, errors } = renderTree(`<template><div>${source}</div></template>`, vm)

  assert.deepEqual(errors, [], 'the extracted template compiles')

  return tree
}

const swatches = (tree) => treeOf(tree).filter((node) => node.tag === 'span' && /\brace-colour\b/.test(String(node.data.staticClass || '')))

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('colour', 'a stored colour is read as the game reads it (the four bytes of its 32-bit ARGB number, a saved 0 or an alpha of 0 meaning none set, a translucent colour kept with its alpha, the same colour in a signed or unsigned number alike), a value that is no 32-bit integer is unavailable and named, and each reads in words', async (w) => {
  const { intelligence: i } = await w.modules()
  const colours = [[255, 255, 0, 0], [255, 0, 0, 255], [255, 0, 128, 0], [255, 30, 144, 255], [255, 255, 255, 255], [255, 0, 0, 0], [255, 1, 2, 3]]

  for (const [alpha, red, green, blue] of colours) {
    const stored = argbOf(alpha, red, green, blue)
    const expected = hexOf({ red, green, blue })
    const result = i.raceColour(stored)

    assert.equal(result.status, 'estimated', `a colour is an estimate: the reading is not compared with a saved colour (${result.status})`)
    assert.deepEqual(value(result), { set: true, hex: expected, css: expected }, `${stored} is ${expected}, not ${JSON.stringify(value(result))}`)
    assert.equal(i.colourText(result), expected, `the words for ${expected}`)

    const unsigned = i.raceColour(stored < 0 ? stored + 2 ** 32 : stored)

    assert.deepEqual(value(unsigned), value(result), `${stored} written as the unsigned ${stored < 0 ? stored + 2 ** 32 : stored} is the same colour`)
  }

  const translucent = value(i.raceColour(TRANSLUCENT))

  assert.equal(translucent.set, true, 'a translucent colour is a colour')
  assert.equal(translucent.hex, '#ff0000', 'with its red, green and blue')
  assert.equal(translucent.css, `rgba(255, 0, 0, ${Math.round((128 / 255) * 1000) / 1000})`, `and its alpha in the style, not ${translucent.css}`)

  for (const stored of [0, argbOf(0, 255, 0, 255), argbOf(0, 1, 2, 3), 16711935]) {
    const result = i.raceColour(stored)

    assert.deepEqual(value(result), { set: false, hex: null, css: null }, `${stored} has an alpha of 0 or is Color.Empty: no colour set`)
    assert.equal(i.colourText(result), 'Not set', 'which reads Not set')
  }

  for (const bad of [null, undefined, NaN, Infinity, '5', '', 1.5, 2 ** 32, -(2 ** 31) - 1, {}, [], true]) {
    const result = i.raceColour(bad)

    assert.equal(result.status, 'unavailable', `${JSON.stringify(bad)} is no 32-bit colour: unavailable, not a colour or no colour (${result.status})`)
    assert.deepEqual(result.inputs.missing, [COLOUR_MISSING], 'and it names the colour')
    assert.equal(i.colourText(result), '—', 'which reads as a dash')
  }

  assert.equal(value(i.raceColour(-(2 ** 31))).hex, '#000000', 'the lowest 32-bit number is an opaque black')
  assert.equal(value(i.raceColour(2 ** 32 - 1)).hex, '#ffffff', 'and the highest an opaque white')
})

check('flag', 'the setting of each system follows the stored rows (a stored 1 silenced, a stored 0 not, the boolean, numeric and True/False forms alike, a flag that is not one unknown), a system with no row is not silenced and says so, a stored row of a system the race was not seen in is listed, the names are the viewing race\'s and the summary says it in words', async (w) => {
  const { intelligence: i } = await w.modules()
  const seen = [{ SystemID: 1, Name: 'Sol' }, { SystemID: 2, Name: 'Alpha Centauri' }, { SystemID: 4, Name: null }]
  const stored = [{ AlienRaceID: 9, SystemID: 1, NoHostileInterrupt: 1, Name: 'Sol' }, { AlienRaceID: 9, SystemID: 3, NoHostileInterrupt: 0, Name: 'Barnard' }, { AlienRaceID: 9, SystemID: 5, NoHostileInterrupt: 1, Name: null }]
  const settings = i.hostileSettings({ seen, stored })

  assert.deepEqual(settings.map((setting) => setting.name), ['Alpha Centauri', 'Barnard', 'Sol', 'System 4', 'System 5'], 'one entry for each system seen or stored, by name, a system with no name by its id')

  const of = (id) => settings.find((setting) => setting.SystemID === id)

  assert.deepEqual([of(1).silenced, of(1).stored], [true, true], 'a stored 1 is silenced')
  assert.deepEqual([of(3).silenced, of(3).stored], [false, true], 'a stored 0 is not, though the race was not seen there')
  assert.deepEqual([of(2).silenced, of(2).stored], [false, false], 'a system with no row is not silenced')
  assert.deepEqual([of(5).silenced, of(5).stored], [true, true], 'a stored 1 of a system with no name is silenced')
  assert.ok(of(2).result.assumptions.some((text) => /no setting is stored for the system, which the game reads as not silenced/.test(text)), 'and says no setting is stored')
  assert.ok(!of(1).result.assumptions.some((text) => /no setting is stored/.test(text)), 'a stored setting makes no such assumption')
  assert.equal(of(1).result.status, 'estimated', 'a setting is an estimate: the reading is not compared with a saved setting')
  assert.equal(of(1).result.value, true, 'its result holds the flag')

  const flagOf = (flag) => i.hostileSettings({ seen: [], stored: [{ AlienRaceID: 9, SystemID: 1, NoHostileInterrupt: flag, Name: 'Sol' }] })[0]

  for (const [flag, silenced] of [[1, true], [0, false], [true, true], [false, false], ['True', true], ['false', false], [' TRUE ', true], [2, true], [-1, true]]) {
    assert.equal(flagOf(flag).silenced, silenced, `a stored ${JSON.stringify(flag)} is ${silenced ? 'silenced' : 'not silenced'}`)
  }

  for (const flag of [null, undefined, NaN, 'maybe', '', {}]) {
    const setting = flagOf(flag)

    assert.equal(setting.silenced, null, `a stored ${JSON.stringify(flag)} is no flag: unknown, never not silenced`)
    assert.equal(setting.result.status, 'unavailable', 'its result is unavailable')
    assert.deepEqual(setting.result.inputs.missing, ['the hostile contact setting'], 'and names the setting')
  }

  const summary = i.hostileSummary(settings)

  assert.equal(summary.text, 'Silenced in 2 of 5 systems', `the summary counts the silenced systems, not ${summary.text}`)
  assert.equal(summary.result.value, 2, 'its result holds the count')
  assert.ok(summary.result.assumptions.some((text) => /no setting is stored/.test(text)), 'and says a system with no setting is not silenced')
  assert.equal(i.hostileSummary(settings.filter((setting) => setting.silenced === false)).text, 'Not silenced in any system', 'no silenced system is said so')
  assert.equal(i.hostileSummary([of(1)]).text, 'Silenced in 1 of 1 system', 'one system is a system')
  assert.equal(i.hostileSummary([]).text, 'No system seen', 'no system is said so')
  assert.equal(i.hostileSummary([]).result.value, 0, 'with a count of 0')

  const unknown = i.hostileSummary([...settings, flagOf(null)])

  assert.equal(unknown.text, '2 of 6 systems silenced, 1 unknown', `a setting that is no flag is counted unknown: ${unknown.text}`)
  assert.equal(unknown.result.status, 'unavailable', 'and the summary is unavailable')
})

check('fixture', 'on the fixture the page\'s reads give the three alien races with the colour their rows store and the settings the table stores, equal to SQL written here, the stored colours read as the four bytes say, and what the fixture lacks (a colour, a setting) is named as needing a saved case', async (w) => {
  const { intelligence: i } = await w.modules()
  const database = copyOf('intact')
  const sql = i.raceOptionsSql(GAME, RACE)
  const colours = database.query(sql.colours).all().sort((a, b) => a.AlienRaceID - b.AlienRaceID)
  const settings = database.query(sql.settings).all()

  assert.deepEqual(colours.map((row) => row.AlienRaceID), [PRECURSORS, STARFARERS, KARACHI], 'the page reads the three races of the viewing race')
  assert.deepEqual(colours, oracleColours(database), 'with the colour each row stores')
  assert.deepEqual(settings, oracleSettings(database), 'and the settings the table stores for the viewing race')

  const plantedColours = copyOf('coloured').query(sql.colours).all().sort((a, b) => a.AlienRaceID - b.AlienRaceID)
  const plantedSettings = copyOf('settings').query(sql.settings).all().sort((a, b) => a.AlienRaceID - b.AlienRaceID || a.SystemID - b.SystemID)

  assert.deepEqual(plantedColours, oracleColours(copyOf('coloured')), 'a colour another viewing race gave an alien race is not read')
  assert.equal(plantedColours.filter((row) => row.AlienRaceColour !== 0).length, 2, 'the stored colours of the viewing race are read')
  assert.deepEqual(plantedSettings, oracleSettings(copyOf('settings')), 'nor a setting another viewing race stored')
  assert.equal(plantedSettings.length, 3, 'the three settings of the viewing race are read')

  for (const row of colours) {
    const result = i.raceColour(row.AlienRaceColour)
    const bytes = bytesOf(row.AlienRaceColour)

    assert.deepEqual(value(result), bytes.alpha === 0 ? { set: false, hex: null, css: null } : { set: true, hex: hexOf(bytes), css: bytes.alpha === 255 ? hexOf(bytes) : value(result).css }, `race ${row.AlienRaceID}: ${row.AlienRaceColour} read as its bytes ${JSON.stringify(bytes)} say`)
  }

  const stored = database.query('select count(*) as N from FCT_AlienRaceSystemStatus').get().N
  const coloured = database.query('select count(*) as N from FCT_AlienRace where AlienRaceColour <> 0').get().N

  // What the fixture cannot show is not guessed: a saved colour and a saved setting need a game played under 3.1 (the specimen S18 of AE-310-03).
  if (!NOTED.has('fixture')) {
    NOTED.add('fixture')
    console.log(`NOTE  fixture: ${coloured} alien races with a colour set and ${stored} stored hostile contact settings in the whole save: needs tier b (planted copies carry the cases)`)
  }

  assert.ok(coloured >= 0 && stored >= 0, 'the counts are read')
})

check('page', 'the page\'s own script reads the race options as an input of its own and shows each race\'s colour, the swatch only for a colour that is set, and for the selected race its colour and its hostile contact settings system by system with the summary among the facts, a row of another viewing race never among them, as worked out here from the saved rows', async (w) => {
  const intact = await pageOf(w, copyOf('intact'), STARFARERS)

  assert.deepEqual(intact.raceOptions.colours.map((row) => row.AlienRaceID).sort((a, b) => a - b), [PRECURSORS, STARFARERS, KARACHI], 'the page\'s input holds the colours of the three races')
  assert.deepEqual(intact.raceOptions.settings, [], 'and no setting')
  assert.ok(intact.rows.every((row) => row.colourSwatch === null && row.colourResult.value.set === false), 'as saved no race has a swatch: none set')

  const fact = (page, label) => {
    const found = page.facts.find((entry) => entry.label === label)

    assert.ok(found, `the facts of the selected race hold ${label}: ${JSON.stringify(page.facts.map((entry) => entry.label))}`)

    return found
  }

  assert.equal(fact(intact, 'Race colour').value, 'Not set', 'the colour fact reads Not set')
  assert.equal(fact(intact, 'Race colour').swatch, null, 'with no swatch')
  assert.equal(fact(intact, 'Hostile contact interrupts').value, 'Not silenced in any system', 'the hostile contact fact reads that no system is silenced')
  assert.equal(intact.selectedSettings.length, 3, 'the Starfarers\' three systems are listed')
  assert.ok(intact.selectedSettings.every((setting) => setting.stored === false && setting.silenced === false), 'each with no stored setting, not silenced')

  const coloured = await pageOf(w, copyOf('coloured'), STARFARERS)
  const oracle = Object.fromEntries(oracleColours(copyOf('coloured')).map((row) => [row.AlienRaceID, row.AlienRaceColour]))
  const rowOf = (page, id) => page.rows.find((row) => row.AlienRaceID === id)

  assert.equal(rowOf(coloured, STARFARERS).colourSwatch, hexOf(bytesOf(oracle[STARFARERS])), 'the Starfarers\' swatch is the colour their row stores')
  assert.equal(rowOf(coloured, KARACHI).colourSwatch, `rgba(255, 0, 0, ${Math.round((128 / 255) * 1000) / 1000})`, 'the Karachi Federation\'s swatch keeps its alpha')
  assert.equal(rowOf(coloured, PRECURSORS).colourSwatch, null, 'the Precursors have none set, so no swatch')
  assert.equal(fact(coloured, 'Race colour').value, hexOf(bytesOf(oracle[STARFARERS])), 'the colour fact of the selected race is its hex')
  assert.equal(fact(coloured, 'Race colour').swatch, hexOf(bytesOf(oracle[STARFARERS])), 'with its swatch')

  const planted = await pageOf(w, copyOf('settings'), STARFARERS)
  const oracleRows = oracleSettings(copyOf('settings')).filter((row) => row.AlienRaceID === STARFARERS)
  const { starfarers, unseen } = SYSTEMS
  const settingOf = (page, id) => page.selectedSettings.find((setting) => setting.SystemID === id)

  assert.equal(oracleRows.length, 2, 'the copy stores two settings of the Starfarers')
  assert.equal(planted.raceOptions.settings.every((row) => row.AlienRaceID !== PRECURSORS), true, 'the row of another viewing race is not read')
  assert.equal(planted.raceOptions.settings.length, 3, 'the three settings of the viewing race are read')
  assert.equal(planted.selectedSettings.length, starfarers.length + 1, 'the systems seen and the stored system the race was not seen in are listed')
  assert.deepEqual([settingOf(planted, starfarers[0]).silenced, settingOf(planted, starfarers[0]).stored], [true, true], 'the stored 1 is silenced')
  assert.deepEqual([settingOf(planted, unseen).silenced, settingOf(planted, unseen).stored], [false, true], 'the stored 0 is not silenced')
  assert.deepEqual([settingOf(planted, starfarers[1]).silenced, settingOf(planted, starfarers[1]).stored], [false, false], 'a system with no row is not silenced')
  assert.equal(settingOf(planted, starfarers[0]).name, oracleRows.find((row) => row.SystemID === starfarers[0]).Name, 'named as the viewing race names it')
  assert.equal(fact(planted, 'Hostile contact interrupts').value, `Silenced in 1 of ${starfarers.length + 1} systems`, 'the fact counts the silenced systems')

  const karachi = await pageOf(w, copyOf('settings'), KARACHI)

  assert.equal(karachi.selectedSettings.length, 1, 'the Karachi Federation were seen in one system')
  assert.equal(karachi.selectedSettings[0].silenced, true, 'where the setting silences it')
  assert.equal(karachi.selectedSettings.every((setting) => setting.SystemID !== starfarers[0]), true, 'and no setting of the Starfarers shows there')

  const precursors = await pageOf(w, copyOf('settings'), PRECURSORS)

  assert.ok(precursors.selectedSettings.every((setting) => setting.silenced === false && setting.stored === false), 'the setting another viewing race stored never shows for this one')
})

check('capability', 'the page\'s reads name the colour and the setting as an ordinary input of its route, the registry no longer declares either column, and a save without one of them cannot give the page: the report is unsupported, naming the input and the field', async (w) => {
  const { capabilities: k } = await w.modules()
  const input = k.INPUTS['/intelligence'].find((entry) => entry.key === 'raceOptions')

  assert.ok(input, 'the Intelligence page has the input raceOptions')
  assert.equal(input.optional, false, 'an ordinary input, not an optional one')
  assert.ok((input.reads.FCT_AlienRace || []).includes('AlienRaceColour'), 'it reads FCT_AlienRace.AlienRaceColour')
  assert.ok((input.reads.FCT_AlienRaceSystemStatus || []).includes('NoHostileInterrupt'), 'and FCT_AlienRaceSystemStatus.NoHostileInterrupt')
  assert.ok(!k.DECLARED.some((entry) => (entry.table === 'FCT_AlienRace' && entry.columns.includes('AlienRaceColour')) || (entry.table === 'FCT_AlienRaceSystemStatus' && entry.columns.includes('NoHostileInterrupt'))), 'the registry does not declare either as read later by another item')

  const whole = (await k.preflight(loaderOf(copyOf('intact')))).reports['/intelligence']

  assert.equal(whole.status, 'supported', `the fixture's Intelligence report is whole, not ${whole.status}`)

  for (const [name, field] of [['droppedColour', 'FCT_AlienRace.AlienRaceColour'], ['droppedFlag', 'FCT_AlienRaceSystemStatus.NoHostileInterrupt']]) {
    const report = (await k.preflight(loaderOf(copyOf(name)))).reports['/intelligence']

    assert.equal(report.status, 'unsupported', `a save without ${field} cannot give the page, not ${report.status}`)
    assert.ok(report.missing.some((entry) => entry.key === 'raceOptions' && entry.fields.includes(field)), `the report names the input and ${field}: ${JSON.stringify(report.missing.map((entry) => [entry.key, entry.fields]))}`)
  }
})

check('text', 'the page draws the swatch beside the race\'s name, the colour among the facts and a chip for each system saying silenced or not silenced, and states under the facts and under Systems and species that the setting only silences the player\'s event interrupt (the event still logged), that a system with no stored setting is not silenced and what the colour is, the page help and the rule notes saying the same', async (w) => {
  const text = w.texts.intelligencePage
  const { glossary: g, intelligence: i } = await w.modules()
  const cell = rendered(`<v-data-table :items="rows">${templateBlock(text, '<template #[`item.AlienRaceName`]')}</v-data-table>`, { rows: [] })
  const slot = (item) => treeOf(cell).find((node) => node.tag === 'v-data-table').data.scopedSlots['item.AlienRaceName']({ item })
  const named = slot({ AlienRaceName: 'Starfarers', Abbrev: 'SF', colourSwatch: '#1e90ff' })
  const unnamed = slot({ AlienRaceName: 'Precursors', Abbrev: 'PR', colourSwatch: null })

  assert.equal(swatches(named).length, 1, 'a race with a colour has one swatch beside its name')
  assert.equal(swatches(named)[0].data.style.background, '#1e90ff', 'in its colour')
  assert.equal(attrsOf(swatches(named)[0]).title, 'Race colour #1e90ff', 'with its colour as the title')
  assert.ok(/^Starfarers/.test(flat(named).replace(/^\s+/, '')) && /SF$/.test(flat(named)), 'and the name and abbreviation still shown')
  assert.equal(swatches(unnamed).length, 0, 'a race with none set has no swatch')

  const factsBlock = text.slice(text.indexOf('<v-row dense>\n                  <v-col v-for="fact in facts"'), text.indexOf('</v-row>', text.indexOf('<v-col v-for="fact in facts"')) + '</v-row>'.length)
  const facts = rendered(factsBlock, { facts: [{ label: 'Race colour', value: '#1e90ff', swatch: '#1e90ff', results: [] }, { label: 'Hostile contact interrupts', value: 'Not silenced in any system', swatch: undefined, results: [] }] })

  assert.equal(swatches(facts).length, 1, 'only the colour fact has a swatch')
  assert.equal(swatches(facts)[0].data.style.background, '#1e90ff', 'in its colour')
  assert.ok(/Race colour/.test(flat(facts)) && /Hostile contact interrupts/.test(flat(facts)), 'both facts are drawn with their labels')

  const from = text.indexOf('<div class="caption text--secondary mb-1 mt-3">Hostile contact interrupts</div>')
  const chipsEnd = text.indexOf('</div>', text.indexOf('No system seen.')) + '</div>'.length
  const chips = rendered(text.slice(from, chipsEnd), { selectedSettings: [{ SystemID: 1, name: 'Sol', silenced: true, stored: true, result: null }, { SystemID: 2, name: 'Alpha', silenced: false, stored: false, result: null }, { SystemID: 3, name: 'Beta', silenced: null, stored: true, result: null }] })
  const chipNodes = treeOf(chips).filter((node) => node.tag === 'v-chip')

  assert.deepEqual(chipNodes.map((node) => flat(node)), ['Sol · silenced', 'Alpha · not silenced', 'Beta · unknown'], `one chip for each system saying what its setting is: ${chipNodes.map((node) => flat(node)).join(' | ')}`)
  assert.deepEqual(chipNodes.map((node) => attrsOf(node).color), ['warning', undefined, undefined], 'a silenced system stands out')

  const empty = rendered(text.slice(from, chipsEnd), { selectedSettings: [] })

  assert.ok(/No system seen\./.test(flat(empty)), 'a race with no system seen says so')

  const foot = (opener) => {
    const start = text.indexOf(opener)

    return text.slice(start, text.indexOf('</div>', start)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  }
  const facing = foot('<div class="panel-foot caption text--secondary">\n                Use it to read where the race stands')
  const placing = foot('<div v-if="detailView === \'places\'" class="panel-foot caption text--secondary">')

  assert.ok(/^Use it to read where the race stands with the player/.test(facing), 'the facts footer opens with what the panel is for')
  assert.ok(/Race colour is the colour picked for the race in the Diplomacy window: a race with none set shows as not set/.test(facing), `it says what the colour is: ${facing}`)
  assert.ok(/It only silences the player's event interrupt for a new hostile contact or a hostile contact update: the event is still logged and shown in the event log, and nothing else about the contact changes\./.test(facing), 'it states that the setting only silences the player\'s event interrupt')
  assert.ok(/A system with no stored setting is not silenced\./.test(facing), 'and that a system with no stored setting is not silenced')
  assert.ok(/^Use it to see where the player's event interrupt for a hostile contact is silenced/.test(placing), 'the footer of Systems and species opens with what it is for')
  assert.ok(/only silences that interrupt: the event is still logged/.test(placing) && /A system with no stored setting is not silenced\./.test(placing), 'and states the same')

  for (const [label, words] of [['the facts footer', facing], ['the Systems and species footer', placing]]) {
    assert.ok(!/\b(I|we|you|your|our)\b/i.test(words), `${label} is in the impersonal voice`)
    assert.ok(!/\d+\.\d+\.\d+|\b[23]\.[01]\b/.test(words), `${label} names no release`)
  }

  const help = g.PAGE_HELP['/intelligence'].usage.find((line) => /^Race colour is the colour picked/.test(line))

  assert.ok(help, 'the page help describes the colour and the setting')
  assert.ok(/The setting only silences that interrupt, the event is still logged, and a system with no stored setting is not silenced\./.test(help), 'and the statement')

  const colourRule = i.raceColour(DODGER).rule
  const flagRule = i.hostileSettings({ seen: [], stored: [{ AlienRaceID: 1, SystemID: 1, NoHostileInterrupt: 1, Name: 'Sol' }] })[0].result.rule

  assert.ok(/saved as the colour's 32-bit ARGB number/.test(colourRule.note) && /no colour set, which the game draws as white/.test(colourRule.note), `the colour rule's note says how it is read: ${colourRule.note}`)
  assert.ok(/It only silences that interrupt: the event is still logged and nothing about the contact changes\./.test(flagRule.note) && /A system with no stored setting is not silenced\./.test(flagRule.note), `the setting rule's note states the statement: ${flagRule.note}`)

  const inputs = text.slice(text.indexOf('const INPUT_LABELS = {'), text.indexOf('\n}', text.indexOf('const INPUT_LABELS = {')))

  assert.ok(/raceOptions: 'the race colours and the hostile contact settings'/.test(inputs), 'the page labels the input, so a failed read names it')
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
const FOOT_ONLY = 'It only silences the player\'s event interrupt for a new hostile contact or a hostile contact update: the event is still logged and shown in the event log, and nothing else about the contact changes.'

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'a colour with an alpha of 0 is read as a colour', target: 'intelligence', from: 'if (alpha === 0) {', to: 'if (alpha < 0) {', fails: ['colour', 'fixture'] },
  { name: 'only a saved 0 is no colour', target: 'intelligence', from: 'if (alpha === 0) {', to: 'if (stored === 0) {', fails: ['colour'] },
  { name: 'the colour\'s red, green and blue are read from the wrong bytes', target: 'intelligence', from: 'const hex = `#${(argb & 0xffffff).toString(16).padStart(6, \'0\')}`', to: 'const hex = `#${(argb >>> 8).toString(16).padStart(6, \'0\')}`', fails: ['colour', 'page'] },
  { name: 'a translucent colour is drawn solid', target: 'intelligence', from: 'const css = alpha === 255 ? hex : `rgba(', to: 'const css = hex || `rgba(', fails: ['colour', 'page'] },
  { name: 'a number outside the 32-bit range is read as a colour', target: 'intelligence', from: 'stored < -2147483648 || stored > 4294967295', to: 'false', fails: ['colour'] },
  { name: 'a flag that is not one is read as not silenced', target: 'intelligence', from: 'value.trim().toLowerCase() === \'true\' : null)', to: 'value.trim().toLowerCase() === \'true\' : false)', fails: ['flag'] },
  { name: 'only a stored 1 is a flag (the game\'s ToBoolean reads any number but 0 as true)', target: 'intelligence', from: 'isNumber(value) ? value !== 0 :', to: 'isNumber(value) ? value === 1 :', fails: ['flag'] },
  { name: 'a system with no stored setting is silenced', target: 'intelligence', from: 'const flag = row ? storedFlag(row.NoHostileInterrupt) : false', to: 'const flag = row ? storedFlag(row.NoHostileInterrupt) : true', fails: ['flag', 'page'] },
  { name: 'a system with no stored setting says nothing of it', target: 'intelligence', from: 'assumptions: row ? [] : [NO_SETTING] })', to: 'assumptions: [] })', fails: ['flag'] },
  { name: 'the summary counts every system as silenced', target: 'intelligence', from: 'const silenced = settings.filter((setting) => setting.silenced === true).length', to: 'const silenced = settings.filter((setting) => setting.silenced !== false).length', fails: ['flag'] },
  { name: 'the settings read leaves out the viewing race', target: 'intelligence', from: ' and FCT_AlienRaceSystemStatus.ViewingRaceID = ${RaceID}`', to: '`', fails: ['fixture', 'page'] },
  { name: 'the colours read leaves the stored colour out', target: 'intelligence', from: 'select FCT_AlienRace.AlienRaceID, FCT_AlienRace.AlienRaceColour from FCT_AlienRace', to: 'select FCT_AlienRace.AlienRaceID, 0 as AlienRaceColour from FCT_AlienRace', fails: ['page'] },
  { name: 'the setting rule\'s note does not say what the setting silences', target: 'intelligence', from: 'It only silences that interrupt: the event is still logged and nothing about the contact changes. ', to: '', fails: ['text'] },
  { name: 'the page maps every colour to none', target: 'intelligencePage', from: '[row.AlienRaceID, row.AlienRaceColour]', to: '[row.AlienRaceID, 0]', fails: ['page'] },
  { name: 'the page shows the settings of every race for the selected one', target: 'intelligencePage', from: '.filter((row) => row.AlienRaceID === this.selectedId) })', to: ' })', fails: ['page'] },
  { name: 'the page does not read the settings', target: 'intelligencePage', from: 'const [settings] = await this.database.query(sql.settings)', to: 'const settings = []', fails: ['page'] },
  { name: 'the page leaves the hostile contact fact out', target: 'intelligencePage', from: '        { label: \'Hostile contact interrupts\', value: hostile.text, results: [hostile.result] },\n', to: '', fails: ['page'] },
  { name: 'the page leaves the colour fact out', target: 'intelligencePage', from: '        { label: \'Race colour\', value: colourText(race.colourResult), swatch: race.colourSwatch, results: [race.colourResult] },\n', to: '', fails: ['page'] },
  { name: 'the page does not label the input', target: 'intelligencePage', from: '  raceOptions: \'the race colours and the hostile contact settings\',\n', to: '', fails: ['text'] },
  { name: 'the races table draws no swatch', target: 'intelligencePage', from: '<span v-if="item.colourSwatch" class="race-colour" :style="{ background: item.colourSwatch }" :title="`Race colour ${item.colourSwatch}`" />', to: '', fails: ['text'] },
  { name: 'the facts draw no swatch', target: 'intelligencePage', from: '<span v-if="fact.swatch" class="race-colour" :style="{ background: fact.swatch }" />', to: '', fails: ['text'] },
  { name: 'every system chip says not silenced', target: 'intelligencePage', from: 'setting.silenced ? \'silenced\' : \'not silenced\'', to: '\'not silenced\'', fails: ['text'] },
  { name: 'a silenced system does not stand out', target: 'intelligencePage', from: ':color="setting.silenced ? \'warning\' : undefined"', to: '', fails: ['text'] },
  { name: 'the facts footer does not state what the setting silences', target: 'intelligencePage', from: FOOT_ONLY, to: '', fails: ['text'] },
  { name: 'the Systems and species view has no footer', target: 'intelligencePage', from: '<div v-if="detailView === \'places\'" class="panel-foot caption text--secondary">', to: '<div v-if="detailView === \'places\'" class="caption text--secondary">', fails: ['text'] },
  { name: 'the page help leaves the statement out', target: 'glossary', from: ' The setting only silences that interrupt, the event is still logged, and a system with no stored setting is not silenced.', to: '', fails: ['text'] },
  { name: 'the registry declares the colour as read by another item again', target: 'capabilities', from: 'export const DECLARED = Object.freeze([', to: 'export const DECLARED = Object.freeze([\n  Object.freeze({ item: \'AE-308-07\', readBy: \'AE-309-07\', table: \'FCT_AlienRace\', columns: Object.freeze([\'AlienRaceColour\']) }),', fails: ['capability'] },
  { name: 'the registry declares the setting as read by another item again', target: 'capabilities', from: 'export const DECLARED = Object.freeze([', to: 'export const DECLARED = Object.freeze([\n  Object.freeze({ item: \'AE-308-07\', readBy: \'AE-309-07\', table: \'FCT_AlienRaceSystemStatus\', columns: Object.freeze([\'NoHostileInterrupt\']) }),', fails: ['capability'] },
  { name: 'the race options are an optional input of the Intelligence page', target: 'capabilities', from: '  \'/commanders\': (key) => key === \'navalTree\' || key === \'groundTree\' || key === \'noResearch\',', to: '  \'/commanders\': (key) => key === \'navalTree\' || key === \'groundTree\' || key === \'noResearch\',\n  \'/intelligence\': (key) => key === \'raceOptions\',', fails: ['capability'] },
]

// Rewrites that say the same thing: the alpha test written with a shift, the unsigned pattern written with a mask, a flag test with its operands swapped.
const BENIGN = [
  { name: 'the alpha written as a shifted mask', target: 'intelligence', from: 'const alpha = argb >>> 24', to: 'const alpha = (argb & 0xff000000) >>> 24' },
  { name: 'the unsigned pattern written with a mask', target: 'intelligence', from: 'const argb = stored >>> 0', to: 'const argb = stored & 0xffffffff ? stored >>> 0 : 0' },
  { name: 'the number test of a flag with its operands swapped', target: 'intelligence', from: 'isNumber(value) ? value !== 0 :', to: 'isNumber(value) ? 0 !== value :' },
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
  if (!fs.existsSync(path.join(root, SAVE))) {
    console.log(`UNSUPPORTED  every check: the fixture ${SAVE} is not there`)
    console.log('0 of 0 checks passed')

    return true
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
