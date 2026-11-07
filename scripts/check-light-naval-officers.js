/*
  Checks the light naval officer posts of the Commanders page (utilities/commanders.js `isLightNavalPost`, `specialistPost`, `declaredFunction`, `mainFunctionLabel`, `bonusSuggestionCount`, pages/commanders.vue): which ships have a captain ranked by the Light Tactical bonus, the function the player declared for a class shown beside the post, and the better assignments of those ships beside the specialist ships.

  Run: bun scripts/check-light-naval-officers.js [--no-mutations]

  The rules are the game's, and none is compared with a played 3.1 save (the owner's decision AE-31 Q7: no played save is supplied, so the figures are worked from the rules and the planted copies of the interim fixture carry the cases):
  - the post: the game scores a ship's captain by Light Tactical (bonus 39, priority 40) when the class's main function is Light Naval, whatever the size; the game's own choice gives Light Naval to an armed class of 20 hull spaces or fewer and does not run for a class whose `UserDefinedFunction` is set, so a stored Light Naval function on a larger class is there only because the player declared it; a class with no officers (`NoOfficers`) has no captain to rank; a class whose main function is not stored, or is not one the game names, may be a light naval one, so it is unrated and names the function unless its officers or size rule that out;
  - the effect on the ship: the ship's tactical multiplier takes the captain's Light Tactical in full for a ship of 20 hull spaces or fewer and half of the captain's Tactical above, so a declared Light Naval class over 20 hull spaces is ranked by Light Tactical and counts Tactical in combat;
  - the function names: the game's own, as `FCT_ShipClass.MainFunction` numbers them (the fixture holds 0, 1, 2, 3, 8, 9, 10, 11, 12, 14, 22, 23 and 27; 6 and 7 are both the survey ship).

  - `rule`: whether a ship is a light naval one, as an if-chain written here from the rule reads it, over a grid of main functions (a function not stored and one the game does not name included), officer flags, declarations and sizes (a size of 20 included, 20.0001 not), a flag, function or size that is not stored leaving it unanswered and named where it decides; the post, its share (1 up to 20 hull spaces, 0 above with half of Tactical beside it, none where the size is not stored), the rank level with and without the Senior CO flag, the blocked bonus named, the posts of the other ships unmoved by the new columns; the names of the functions; the ranking of a light naval ship by Light Tactical and not by Survey; the count of better assignments with and without the light naval rows; the rows' combat values and the count of other posts one officer is the best candidate for (alternatives, not an allocation);
  - `fixture`: on the interim 3.1 fixture (saves/AuroraDB-310-spookyerol-migrated.db, game 141, race 784) the page's own script reads 627 light naval ships of three classes (386 Griffins, 211 Raiders, 30 Lookouts), the 12 specialist ships and their rows unchanged, and the rows of the light naval view are the ones a ranking written here from the saved rows gives: the vacant Griffin to the best idle officer of the first rank, the vacant Lookout (second rank) to none with the officers of other ranks counted, each occupied post to an idle officer who beats its captain; the tile counts them with the others; nothing is declared;
  - `plants`: on planted copies, a class declared Warship leaves the view, a survey class declared Light Naval moves from the specialist ships to the light naval ones and is shown as declared, a survey class stored as Light Naval and not declared stays a survey ship, the limit of 20 hull spaces (included) with and without a declaration, a class with no officers leaving, one whose officers, size or declaration are not stored listed as one that cannot be rated and naming what is missing, no light naval class at all giving the page's empty text, an idle officer given a better Light Tactical becoming the candidate, and a blocked Light Tactical bonus rating no ship;
  - `unnamed`: classes whose main function is not stored or not one the game names, on planted copies, listed as ones that cannot be rated naming the function (the number where one is stored) and never offered a candidate, a class that no function makes light naval (no officers, not declared and over 20 hull spaces) left out of the light naval view and among the specialist ships, one that a function may make light naval (small, or declared) left out of the specialist ships;
  - `combat`: declared classes over 20 hull spaces ranked by Light Tactical and carrying half of the captain's Tactical beside it (the holder's and the candidate's values read from the save, none where the save does not confirm Tactical), the cells saying what the ranking is, what counts in combat and that the rows that name one officer are alternatives, a declared class with no stored size carrying neither;
  - `capability`: the page's reads name the three columns of the class as inputs of the route, a save without one of them cannot give the page (the report is unsupported, naming the input and the field), and Light Tactical is a gated bonus of the page;
  - `text`: the toggle, the feet and the help line say what the view is, how the post is decided, what the declared function does, what counts in combat and that the rows are alternatives, in the impersonal voice with no release named; the comment above the post rule states the rule in plain words.
  - `played`: where the file is present, the played 3.2.0 save (saves/AuroraDB-320-fetterkrolle-1.db, game 161, race 909, an owner-supplied campaign whose classes are all stored with no declaration and none as Light Naval) is a real witness of the empty case: the page's own script reads no light naval ship, the specialist ships show no declared function, the light naval view says so, the Commanders report is whole, Light Tactical is not blocked and its officers hold it as a multiplier; skipped, and said so, where the file is not present;

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
const { renderTree, treeOf } = require('./lib/vue-render')

const root = path.resolve(__dirname, '..')
const SAVE = 'saves/AuroraDB-310-spookyerol-migrated.db'
const GAME = 141
const RACE = 784
const PLAYED = 'saves/AuroraDB-320-fetterkrolle-1.db'
const PLAYED_GAME = 161
const PLAYED_RACE = 909
const PLAYED_PRESENT = fs.existsSync(path.join(root, PLAYED))
const WITNESS = PLAYED_PRESENT ? ['played'] : []
const LIGHT_TACTICAL = 39
const TACTICAL = 21
// The main functions the game names (as the stored column holds them): 4, 25 and every number above 28 are not among them.
const NAMED = [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28]
// The classes the light naval read takes: Light Naval, or a function that is not stored or not one the game names.
const WIDE = `(c.MainFunction = 3 or c.MainFunction is null or c.MainFunction not in (${NAMED.join(', ')}))`
// The classes of the fixture: the three light naval ones (Size 2.5, 5 and 5 hull spaces; the Lookout requires the second rank) and the survey class Intrepid (1,220 hull spaces, requiring the fourth rank).
const GRIFFIN = 63034
const RAIDER = 63035
const LOOKOUT = 63050
const INTREPID = 63083
const VACANT_GRIFFIN = 199440
const VACANT_LOOKOUT = 196083
const EPSILON = 1e-9

const FILES = {
  commanders: path.join(root, 'src', 'renderer', 'utilities', 'commanders.js'),
  capabilities: path.join(root, 'src', 'renderer', 'utilities', 'capabilities.js'),
  glossary: path.join(root, 'src', 'renderer', 'utilities', 'glossary.js'),
  page: path.join(root, 'src', 'renderer', 'pages', 'commanders.vue'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

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
  modules: memo(() => loadUtilities(['commanders', 'capabilities', 'glossary'], { stubs: STUBS, sources: { commanders: texts.commanders, capabilities: texts.capabilities, glossary: texts.glossary } })),
  page: memo(() => loadPage('pages/commanders', { stubs: STUBS, modules: { 'utilities/appearance': APPEARANCE }, sources: { 'pages/commanders': texts.page, 'utilities/commanders': texts.commanders, 'utilities/capabilities': texts.capabilities, 'utilities/glossary': texts.glossary } })),
})

// ---- The fixture, as in-memory copies ------------------------------------------------------------------------------
let BYTES = null
const COPIES = new Map()
let HOLDERS = null

// The idle naval officers of the first rank, the best Light Tactical first, read from the saved rows: the officer the plant lifts above the rest.
const oracleOfficers = (database) => database.query(`select c.CommanderID, c.Name, (select max(r2.Priority) from FCT_Ranks r2 where r2.GameID = ${GAME} and r2.RaceID = ${RACE} and r2.RankType = r.RankType) - r.Priority + 1 as Level, (select b.BonusValue from FCT_CommanderBonuses b where b.CommanderID = c.CommanderID and b.BonusID = ${LIGHT_TACTICAL}) as LT from FCT_Commander c inner join FCT_Ranks r on r.RankID = c.RankID where c.GameID = ${GAME} and c.RaceID = ${RACE} and c.RetireStatus = 0 and c.Prisoner = 0 and c.CommanderType = 0 and c.CommandType = 0 order by c.CommanderID`).all().map((officer) => ({ ...officer, LT: officer.LT === null ? 1 : officer.LT }))

const holdersOf = (database) => {
  const idle = oracleOfficers(database).filter((officer) => officer.Level === 1).sort((a, b) => b.LT - a.LT || a.CommanderID - b.CommanderID)
  const best = idle[0]
  const runnerUp = idle.find((officer) => officer.LT < best.LT - EPSILON)

  return { best, lifted: runnerUp, liftedTo: Math.round((best.LT + 0.2) * 100) / 100 }
}

const classOf = (id, set) => `update FCT_ShipClass set ${set} where ShipClassID = ${id}`

const PLANTS = {
  intact: () => [],
  // The Griffins declared Warship (the player picked the function), the survey class Intrepid declared Light Naval with no captain on either ship.
  declared: () => [classOf(GRIFFIN, 'UserDefinedFunction = 1, MainFunction = 2'), classOf(INTREPID, 'UserDefinedFunction = 1, MainFunction = 3'), `update FCT_Commander set CommandType = 0, CommandID = 0 where CommandType = 1 and CommandID in (select ShipID from FCT_Ship where ShipClassID = ${INTREPID})`],
  // The survey class Intrepid cut to 10 hull spaces, stored as the survey ship it is (a small class that is not Light Naval).
  smallSurvey: () => [classOf(INTREPID, 'Size = 10')],
  // The Intrepid stored as Light Naval and not declared: a larger class the game would not have chosen it for.
  stored: () => [classOf(INTREPID, 'MainFunction = 3')],
  // The limit: the Raider at 20 hull spaces (in), the Griffin just above it and not declared (out), the Lookout just above it and declared (in).
  limits: () => [classOf(RAIDER, 'Size = 20'), classOf(GRIFFIN, 'Size = 20.0001'), classOf(LOOKOUT, 'Size = 20.0001, UserDefinedFunction = 1')],
  // The Raider with no officers (out), the Lookout with no stored flag (cannot be rated), the Griffin with no stored size (the same), the Intrepid stored Light Naval with no stored declaration at 1,220 hull spaces (the same).
  unsaved: () => [classOf(RAIDER, 'NoOfficers = 1'), classOf(LOOKOUT, 'NoOfficers = null'), classOf(GRIFFIN, 'Size = null'), classOf(INTREPID, 'MainFunction = 3, UserDefinedFunction = null')],
  // The Lookout at 21 hull spaces and the Griffin at 25, both declared: ranked by Light Tactical, which gives nothing in combat there.
  large: () => [classOf(LOOKOUT, 'Size = 21, UserDefinedFunction = 1'), classOf(GRIFFIN, 'Size = 25, UserDefinedFunction = 1')],
  // The Lookout declared with no stored size.
  sizeless: () => [classOf(LOOKOUT, 'Size = null, UserDefinedFunction = 1')],
  // The best idle officer of the first rank lifted above every other's Light Tactical, holding no Tactical.
  lifted: (h) => [`delete from FCT_CommanderBonuses where CommanderID = ${h.best.CommanderID} and BonusID in (${LIGHT_TACTICAL}, ${TACTICAL})`, `insert into FCT_CommanderBonuses (CommanderID, BonusID, BonusValue, GameID) values (${h.best.CommanderID}, ${LIGHT_TACTICAL}, ${Math.round((h.best.LT + 0.3) * 100) / 100}, ${GAME})`],
  // The same officer given a Tactical of 1.4.
  tactical: (h) => [...PLANTS.lifted(h), `insert into FCT_CommanderBonuses (CommanderID, BonusID, BonusValue, GameID) values (${h.best.CommanderID}, ${TACTICAL}, 1.4, ${GAME})`],
  // The Griffins with no stored main function, the Raiders with 99 (one the game does not name), the Lookouts with none at 21 hull spaces and not declared, the Intrepid with none at 1,220 hull spaces and not declared.
  unnamed: () => [classOf(GRIFFIN, 'MainFunction = null'), classOf(RAIDER, 'MainFunction = 99'), classOf(LOOKOUT, 'MainFunction = null, Size = 21'), classOf(INTREPID, 'MainFunction = null')],
  // The Griffins with none and no officers (out), the Raiders with 99 at 30 hull spaces and not declared (out), the Lookouts with none (in, not rated), the Intrepid with none and declared (in, not rated, not a specialist ship).
  unnamedOut: () => [classOf(GRIFFIN, 'MainFunction = null, NoOfficers = 1'), classOf(RAIDER, 'MainFunction = 99, Size = 30, UserDefinedFunction = 0'), classOf(LOOKOUT, 'MainFunction = null'), classOf(INTREPID, 'MainFunction = null, UserDefinedFunction = 1')],
  // The survey class Intrepid cut to 10 hull spaces with no stored main function.
  unnamedSurvey: () => [classOf(INTREPID, 'MainFunction = null, Size = 10')],
  // Every light naval class declared something else.
  none: () => [classOf(GRIFFIN, 'UserDefinedFunction = 1, MainFunction = 2'), classOf(RAIDER, 'UserDefinedFunction = 1, MainFunction = 2'), classOf(LOOKOUT, 'UserDefinedFunction = 1, MainFunction = 2')],
  // An idle officer of the first rank with a Light Tactical better than every other's.
  better: (h) => [`delete from FCT_CommanderBonuses where CommanderID = ${h.lifted.CommanderID} and BonusID = ${LIGHT_TACTICAL}`, `insert into FCT_CommanderBonuses (CommanderID, BonusID, BonusValue, GameID) values (${h.lifted.CommanderID}, ${LIGHT_TACTICAL}, ${h.liftedTo}, ${GAME})`],
  droppedFunction: () => ['alter table FCT_ShipClass drop column UserDefinedFunction'],
  droppedOfficers: () => ['alter table FCT_ShipClass drop column NoOfficers'],
  droppedMain: () => ['alter table FCT_ShipClass drop column MainFunction'],
  renamedBonus: () => [`update DIM_CommanderBonusType set Description = 'Light Tactical (renamed)' where BonusID = ${LIGHT_TACTICAL}`],
  renamedTactical: () => [`update DIM_CommanderBonusType set Description = 'Tactical (renamed)' where BonusID = ${TACTICAL}`],
}

const copyOf = (...names) => {
  const key = names.join('+')

  names.forEach((name) => {
    if (!PLANTS[name]) {
      throw new Error(`no planted copy named ${name}`)
    }
  })

  if (!COPIES.has(key)) {
    BYTES = BYTES || fs.readFileSync(path.join(root, SAVE))

    const database = Database.deserialize(BYTES)

    HOLDERS = HOLDERS || holdersOf(Database.deserialize(BYTES))
    names.forEach((name) => PLANTS[name](HOLDERS).forEach((statement) => database.run(statement)))
    COPIES.set(key, database)
  }

  return COPIES.get(key)
}

const playedCopy = () => {
  if (!COPIES.has('played')) {
    COPIES.set('played', Database.deserialize(fs.readFileSync(path.join(root, PLAYED))))
  }

  return COPIES.get('played')
}

const closeCopies = () => {
  COPIES.forEach((database) => database.close())
  COPIES.clear()
}

const loaderOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })

// ---- What the save holds, as the ranking reads it, written here -----------------------------------------------------------
// Whether a class is a light naval one, from the stored row: a function the game names other than Light Naval is not; otherwise, no officers is not, a declaration or 20 hull spaces or fewer is, a larger class not declared is not, and null where a flag or the size that decides is not stored. A function that is not stored or not one the game names may be Light Naval, so it only rules a class out, never in.
const oracleLightNaval = (row) => {
  const known = NAMED.includes(row.MainFunction)
  const unlessUnknown = (verdict) => (known ? verdict : null)

  if (known && row.MainFunction !== 3) {
    return false
  } else if (row.NoOfficers === null || row.NoOfficers === undefined) {
    return null
  } else if (row.NoOfficers) {
    return false
  } else if (row.UserDefinedFunction === 1) {
    return unlessUnknown(true)
  } else if (row.ClassSize === null) {
    return null
  } else if (row.ClassSize <= 20) {
    return unlessUnknown(true)
  }

  return row.UserDefinedFunction === 0 ? false : null
}

const oracleShips = (database, where) => database.query(`select s.ShipID, s.ShipName, s.ShipSeniorCO, c.ClassName, c.ShipClassID, c.RankRequired, c.Size, c.MainFunction, c.UserDefinedFunction, c.NoOfficers, (select m.CommanderID from FCT_Commander m where m.GameID = ${GAME} and m.RaceID = ${RACE} and m.Deceased = 0 and m.CommandType = 1 and m.CommandID = s.ShipID order by m.rowid limit 1) as CaptainID from FCT_Ship s inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where s.GameID = ${GAME} and s.RaceID = ${RACE} and s.ShippingLineID = 0 and ${where} order by c.ClassName, s.ShipName`).all()

// What the oracle reads of a planted copy never changes with the code under test: it is worked out once per copy.
const ORACLES = new WeakMap()
const oracleMemo = (database, key, make) => {
  const kept = ORACLES.get(database) || new Map()

  ORACLES.set(database, kept)

  if (!kept.has(key)) {
    kept.set(key, make())
  }

  return kept.get(key)
}

const oracleHeld = (database, commander, bonus) => oracleMemo(database, `held ${commander} ${bonus}`, () => {
  const row = database.query(`select BonusValue from FCT_CommanderBonuses where CommanderID = ${commander} and BonusID = ${bonus}`).get()

  return row ? row.BonusValue : 1
})

// The ships of a light naval class, or one with no stored main function or one the game does not name, with the post's rank and the value the captain holds, and what counts in combat.
const oracleLightRows = (database) => oracleMemo(database, 'rows', () => oracleLightRowsOf(database))

const oracleLightRowsOf = (database) => {
  const officers = oracleOfficers(database)
  const navalRanks = database.query(`select count(*) as N from FCT_Ranks where GameID = ${GAME} and RaceID = ${RACE} and RankType = 0`).get().N
  const rows = []
  const unrated = []

  for (const ship of oracleShips(database, WIDE)) {
    const lightNaval = oracleLightNaval({ ...ship, ClassSize: ship.Size })

    if (lightNaval === false) {
      continue
    } else if (lightNaval === null) {
      unrated.push(ship.ShipID)

      continue
    }

    const level = ship.RankRequired + (ship.ShipSeniorCO === 1 ? 1 : 0)

    if (level > navalRanks) {
      unrated.push(ship.ShipID)

      continue
    }

    const current = ship.CaptainID ? oracleHeld(database, ship.CaptainID, LIGHT_TACTICAL) : null
    const better = officers.filter((officer) => officer.LT > (current ?? 1) + EPSILON).sort((a, b) => b.LT - a.LT)
    const atRank = better.filter((officer) => officer.Level === level)

    if (current !== null && !atRank.length) {
      continue
    }

    rows.push({ ShipID: ship.ShipID, level, current, best: atRank.length ? atRank[0].LT : null, bestIds: atRank.filter((officer) => Math.abs(officer.LT - atRank[0].LT) < EPSILON).map((officer) => officer.CommanderID), otherRanks: better.length - atRank.length, share: ship.Size === null ? null : ship.Size <= 20 ? 1 : 0, combat: ship.Size !== null && ship.Size > 20, currentCombat: ship.CaptainID ? oracleHeld(database, ship.CaptainID, TACTICAL) : null })
  }

  return { rows, unrated }
}

// ---- The page, as its own script runs on a copy ---------------------------------------------------------------------------
const pageOf = async (w, database, { blocked = [], view = 'governors', game = GAME, race = RACE } = {}) => {
  const options = await w.page()
  const page = instantiate(options, { $store: { getters: { StartYear: 2000, 'capabilities/blockedBonuses': new Set(blocked), 'capabilities/report': () => null, config: { get: (_key, fallback) => fallback } }, state: {}, dispatch: () => Promise.resolve() }, database: loaderOf(database), GameID: game, RaceID: race })

  for (const name of Object.keys(options.asyncComputed)) {
    await page.runAsync(name)
  }

  page.suggestionView = view

  return page
}

const near = (a, b) => Math.abs(a - b) < 1e-9

const flat = (node) => (Array.isArray(node) ? node.map(flat).join('') : typeof node === 'string' ? node : node && typeof node === 'object' ? flat(node.children) : '')

// The slots of the ships table of the page's template, rendered for a row: (name, item) => text.
const tableSlots = (text, vm) => {
  const opener = '<v-data-table v-if="visibleShipRows.length"'
  const from = text.indexOf(opener)

  assert.ok(from >= 0, `the Commanders page's template has the ships table ${opener}`)

  const block = text.slice(from, text.indexOf('</v-data-table>', from) + '</v-data-table>'.length)
  const { tree, errors } = renderTree(`<template><div>${block}</div></template>`, { visibleShipRows: [1], shipHeaders: [], shipTable: { itemsPerPage: 10 }, shipPageSizes: [], systemLink: () => '/systems/1', rankName: (level) => `Rank ${level}`, ...vm })

  assert.deepEqual(errors, [], 'the extracted template compiles')

  const table = treeOf(tree).find((node) => node.tag === 'v-data-table')

  assert.ok(table && table.data.scopedSlots, 'the extracted template holds a table with slots')

  return (name, item) => flat(table.data.scopedSlots[name]({ item }))
}

// The page's rows of the light naval view against the ranking written here.
const assertRows = (page, database, label) => {
  const wanted = oracleLightRows(database)
  const rows = page.lightRows
  const byShip = Object.fromEntries(rows.map((row) => [row.ship.ShipID, row]))

  assert.deepEqual(rows.map((row) => row.ship.ShipID).sort((a, b) => a - b), wanted.rows.map((row) => row.ShipID).sort((a, b) => a - b), `${label}: the posts to improve or fill are the ones the saved rows give`)
  assert.deepEqual(page.lightAssessment.unrated.map((entry) => entry.ship.ShipID).sort((a, b) => a - b), wanted.unrated.slice().sort((a, b) => a - b), `${label}: the ships that cannot be rated are the ones the saved rows leave unanswered`)

  for (const expected of wanted.rows) {
    const row = byShip[expected.ShipID]

    assert.equal(row.post.label, 'Light Tactical', `${label}: ship ${expected.ShipID} is ranked by Light Tactical`)
    assert.equal(row.post.level, expected.level, `${label}: ship ${expected.ShipID} needs the rank ${expected.level}`)
    assert.ok(expected.current === null ? row.current === null : near(row.current, expected.current), `${label}: ship ${expected.ShipID} holds ${expected.current}, not ${row.current}`)
    assert.equal(row.otherRanks, expected.otherRanks, `${label}: ship ${expected.ShipID} has ${expected.otherRanks} better officers of other ranks`)
    assert.equal(row.post.share, expected.share, `${label}: ship ${expected.ShipID} counts ${expected.share} of Light Tactical in combat, not ${row.post.share}`)
    assert.equal(Boolean(row.post.combat), expected.combat, `${label}: ship ${expected.ShipID} carries another bonus in combat: ${expected.combat}`)
    assert.equal(row.alsoBestFor, row.candidate ? rows.filter((other) => other.candidate && other.candidate.CommanderID === row.candidate.CommanderID).length - 1 : 0, `${label}: ship ${expected.ShipID} counts the other posts its candidate is the best for`)

    if (expected.share === null) {
      assert.ok(row.postResult.inputs.missing.some((entry) => /the size of the class of .*, which says whether Light Tactical counts in combat/.test(entry)), `${label}: ship ${expected.ShipID} names the size it lacks: ${JSON.stringify(row.postResult.inputs)}`)
    }

    if (expected.combat) {
      assert.deepEqual(row.combat && [row.combat.bonusId, row.combat.label, row.combat.share], [TACTICAL, 'Tactical', 0.5], `${label}: ship ${expected.ShipID} carries half of Tactical in combat`)
      assert.ok(expected.currentCombat === null ? row.combat.current === null : near(row.combat.current, expected.currentCombat), `${label}: ship ${expected.ShipID}'s captain holds Tactical ${expected.currentCombat}, not ${row.combat && row.combat.current}`)
      assert.ok(row.candidate ? near(row.combat.candidate, oracleHeld(database, row.candidate.CommanderID, TACTICAL)) : row.combat.candidate === null, `${label}: ship ${expected.ShipID}'s candidate holds the Tactical the save gives`)
    } else {
      assert.equal(row.combat, null, `${label}: ship ${expected.ShipID} carries nothing beside Light Tactical`)
    }

    if (expected.best === null) {
      assert.equal(row.candidate, null, `${label}: ship ${expected.ShipID} has no candidate of its rank`)
    } else {
      assert.ok(row.candidate && near(row.candidate.bonuses[LIGHT_TACTICAL], expected.best) && expected.bestIds.includes(row.candidate.CommanderID), `${label}: ship ${expected.ShipID}'s candidate is one of the best at ${expected.best}: ${row.candidate && row.candidate.CommanderID}`)
    }
  }

  return wanted
}

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

const value = (result) => (result && result.status !== 'unavailable' ? result.value : null)
const missing = (result) => (result && result.status === 'unavailable' ? result.inputs.missing : [])

const SHIP = { ShipID: 1, ShipName: 'Test 001', ClassName: 'Test', MainFunction: 3, NoOfficers: 0, UserDefinedFunction: 0, ClassSize: 5, RankRequired: 2, ShipSeniorCO: 0, NavalRanks: 10 }

check('rule', 'a ship is a light naval one when its class\'s stored main function is Light Naval, the class has officers and it is either declared or of 20 hull spaces or fewer (the limit included), unanswered and named where a flag, the function or the size that decides is not stored, a function the game names other than Light Naval is not one, its captain is ranked by Light Tactical at the rank the class requires (one higher for a ship flagged Senior CO), which counts in combat in full up to 20 hull spaces and for nothing above, where half of Tactical does, and a blocked bonus is named; the other posts are unmoved by the new columns, the function names are the game\'s, a light naval ship is ranked by Light Tactical and not by Survey, the count of better assignments takes the light naval rows, and the rows that name one officer are alternatives', async (w) => {
  const { commanders: c } = await w.modules()
  const functions = [null, 0, 2, 3, 4, 6, 99]
  const officers = [null, 0, 1, true, false]
  const declarations = [null, 0, 1, true, false]
  const sizes = [null, 0, 0.5, 19.99, 20, 20.0001, 21, 1220]

  for (const MainFunction of functions) {
    for (const NoOfficers of officers) {
      for (const UserDefinedFunction of declarations) {
        for (const ClassSize of sizes) {
          const row = { ...SHIP, MainFunction, NoOfficers, UserDefinedFunction, ClassSize }
          const stored = { MainFunction, NoOfficers: typeof NoOfficers === 'boolean' ? Number(NoOfficers) : NoOfficers, UserDefinedFunction: typeof UserDefinedFunction === 'boolean' ? Number(UserDefinedFunction) : UserDefinedFunction, ClassSize }

          assert.equal(c.isLightNavalPost(row), oracleLightNaval(stored), `function ${MainFunction}, officers ${NoOfficers}, declared ${UserDefinedFunction}, size ${ClassSize}`)
        }
      }
    }
  }

  assert.equal(c.isLightNavalPost({ ShipID: 1, ClassSize: 5, Terraformers: 0 }), null, 'a row with no main function stored may be one')

  const post = (changes, blocked) => c.specialistPost({ ...SHIP, ...changes }, blocked)
  const plain = post({})

  assert.deepEqual(value(plain), { post: 'captain', bonusId: LIGHT_TACTICAL, label: 'Light Tactical', share: 1, level: 2, seniorCO: false }, 'the captain, in full, at the rank the class requires')
  assert.deepEqual([value(post({ ShipSeniorCO: 1 })).level, value(post({ ShipSeniorCO: 1 })).seniorCO], [3, true], 'a ship flagged Senior CO needs one rank more')
  assert.equal(post({ ShipSeniorCO: 1, RankRequired: 10 }).status, 'unavailable', 'and none where the class already requires the highest rank')
  assert.ok(missing(post({ ShipSeniorCO: null })).some((entry) => /Senior CO/.test(entry)), 'a ship whose flag is not stored cannot be rated, naming it')
  assert.ok(missing(post({}, new Set([LIGHT_TACTICAL]))).some((entry) => /bonus 39, Light Tactical/.test(entry)), 'a blocked Light Tactical is named')
  assert.equal(post({}, new Set([2])).status, plain.status, 'another blocked bonus changes nothing')
  assert.deepEqual(missing(post({ NoOfficers: null })), ['whether the class of Test has officers'], 'a class with no stored officers flag is named')
  assert.deepEqual(missing(post({ ClassSize: null })), ['the size of the class of Test'], 'a class with no stored size is named where the size decides')
  assert.equal(post({ ClassSize: null, UserDefinedFunction: 1 }).status, plain.status, 'and not where the declaration decides')
  assert.deepEqual(missing(post({ NoOfficers: null, ClassSize: null, UserDefinedFunction: 1 })), ['whether the class of Test has officers'], 'a class whose officers are not stored does not need its size named where the declaration decides')
  assert.deepEqual(missing(post({ NoOfficers: null, ClassSize: null, UserDefinedFunction: 0 })), ['whether the class of Test has officers', 'the size of the class of Test'], 'and does where nothing was declared')
  assert.deepEqual(missing(post({ ClassSize: 30, UserDefinedFunction: null })), ['whether the function of the class of Test was declared'], 'a class over 20 hull spaces with no stored declaration is named')
  assert.equal(value(post({ ClassSize: 20 })).label, 'Light Tactical', 'a class of 20 hull spaces is light naval')
  assert.equal(value(post({ ClassSize: 30, UserDefinedFunction: 1 })).label, 'Light Tactical', 'a larger class is when declared')
  assert.equal(post({ ClassSize: 30, UserDefinedFunction: 0, Terraformers: 1, MiningModules: 0, Harvesters: 0 }).value.label, 'Terraforming', 'a larger class not declared is a ship of its modules')
  assert.equal(post({ NoOfficers: 1, Terraformers: 1, MiningModules: 0, Harvesters: 0 }).value.label, 'Terraforming', 'a class with no officers is too')

  // A class whose main function is not stored, or is not one the game names, may be a light naval one: no post, naming the function, unless its officers or size rule that out.
  assert.deepEqual(missing(post({ MainFunction: null })), ['the main function of the class of Test'], 'a class with no stored main function is named')
  assert.deepEqual(missing(post({ MainFunction: undefined })), ['the main function of the class of Test'], 'and so is one the row has no column for')
  assert.deepEqual(missing(post({ MainFunction: 99 })), ['the main function of the class of Test, stored as 99, which the game does not name'], 'a function the game does not name is named by its number')
  assert.deepEqual(missing(post({ MainFunction: 4 })), ['the main function of the class of Test, stored as 4, which the game does not name'], 'and so is 4, a gap in the game\'s own numbering')
  assert.deepEqual(missing(post({ MainFunction: null, NoOfficers: null, ClassSize: null, UserDefinedFunction: 0 })), ['the main function of the class of Test', 'whether the class of Test has officers', 'the size of the class of Test'], 'every input that decides is named')
  assert.equal(post({ MainFunction: null, NoOfficers: 1, Terraformers: 1, MiningModules: 0, Harvesters: 0 }).value.label, 'Terraforming', 'a class with no stored function and no officers is no light naval one: the post of its modules')
  assert.equal(post({ MainFunction: 99, ClassSize: 30, UserDefinedFunction: 0, Terraformers: 1, MiningModules: 0, Harvesters: 0 }).value.label, 'Terraforming', 'nor is one that is not declared and over 20 hull spaces')
  assert.deepEqual(missing(post({ MainFunction: null, ClassSize: 30, UserDefinedFunction: 1, Terraformers: 1, MiningModules: 0, Harvesters: 0 })), ['the main function of the class of Test'], 'but a declared one over 20 hull spaces may be, and has no post')
  assert.deepEqual(missing(post({ MainFunction: null, ClassSize: 5, UserDefinedFunction: 0, Terraformers: 1, MiningModules: 0, Harvesters: 0 })), ['the main function of the class of Test'], 'and so may a small one, never given the post of its modules')
  assert.equal(post({ MainFunction: 2, NoOfficers: null, ClassSize: null, UserDefinedFunction: null, Terraformers: 1, MiningModules: 0, Harvesters: 0 }).value.label, 'Terraforming', 'while a function the game names other than Light Naval has the post of its modules whatever else is not stored')

  // What counts in combat: Light Tactical up to 20 hull spaces, half of Tactical above.
  const over = (size, changes = {}, blocked) => post({ ClassSize: size, UserDefinedFunction: 1, ...changes }, blocked)

  assert.deepEqual([5, 20, 20.0001, 21, 1220].map((size) => value(over(size)).share), [1, 1, 0, 0, 0], 'Light Tactical counts in full up to 20 hull spaces, the limit included, and for nothing above')
  assert.deepEqual([5, 20].map((size) => value(over(size)).combat), [undefined, undefined], 'a class of 20 hull spaces or fewer has no other bonus in combat')
  assert.deepEqual([20.0001, 21, 1220].map((size) => value(over(size)).combat), new Array(3).fill({ bonusId: TACTICAL, label: 'Tactical', share: 0.5 }), 'above it half of the captain\'s Tactical counts')
  assert.deepEqual([value(over(21)).bonusId, value(over(21)).label, value(over(21)).level], [LIGHT_TACTICAL, 'Light Tactical', 2], 'while the post is still ranked by Light Tactical at the rank the class requires')
  assert.equal(over(21, {}, new Set([TACTICAL])).status, over(21).status, 'a blocked Tactical does not block the post')
  assert.equal(over(21, {}, new Set([LIGHT_TACTICAL])).status, 'unavailable', 'a blocked Light Tactical does')
  assert.deepEqual([value(over(null)).share, value(over(null)).combat], [null, undefined], 'a class with no stored size has no share and carries nothing beside Light Tactical')
  assert.deepEqual(over(null).inputs.missing, ['the size of the class of Test, which says whether Light Tactical counts in combat'], 'and names the size')
  assert.deepEqual(over(21).inputs.missing, [], 'a class with a stored size names nothing')

  // The posts the other ships hold, with the new columns and without them.
  const others = [
    { ShipID: 2, ShipName: 'Terra 001', ClassName: 'Terra', Terraformers: 2, MiningModules: 0, Harvesters: 0, SciencePosts: 0, GeoSurvey: 0, GravSurvey: 0, ClassSize: 4000, RankRequired: 3, ShipSeniorCO: 0, NavalRanks: 10 },
    { ShipID: 3, ShipName: 'Miner 001', ClassName: 'Miner', Terraformers: 0, MiningModules: 3, Harvesters: 0, SciencePosts: 0, GeoSurvey: 0, GravSurvey: 0, ClassSize: 5000, RankRequired: 3, ShipSeniorCO: 1, NavalRanks: 10 },
    { ShipID: 4, ShipName: 'Survey 001', ClassName: 'Survey', Terraformers: 0, MiningModules: 0, Harvesters: 0, SciencePosts: 1, GeoSurvey: 1, GravSurvey: 0, ClassSize: 1200, RankRequired: 4, ShipSeniorCO: 0, NavalRanks: 10 },
    { ShipID: 5, ShipName: 'Probe 001', ClassName: 'Probe', Terraformers: 0, MiningModules: 0, Harvesters: 0, SciencePosts: 0, GeoSurvey: 0, GravSurvey: 2, ClassSize: 18, RankRequired: 1, ShipSeniorCO: 0, NavalRanks: 10 },
    { ShipID: 6, ShipName: 'Scout 001', ClassName: 'Scout', Terraformers: 0, MiningModules: 0, Harvesters: 0, SciencePosts: 0, GeoSurvey: 0, GravSurvey: 2, ClassSize: 500, RankRequired: 2, ShipSeniorCO: 0, NavalRanks: 10 },
  ]

  for (const ship of others) {
    const bare = c.specialistPost({ ...ship, MainFunction: 2 })
    const extended = c.specialistPost({ ...ship, MainFunction: 2, UserDefinedFunction: 0, NoOfficers: 0 })
    const stored = c.specialistPost({ ...ship, MainFunction: 6, UserDefinedFunction: 1, NoOfficers: 0 })
    const unstored = c.specialistPost(ship)

    assert.deepEqual(value(extended), value(bare), `${ship.ClassName}: the new columns change nothing`)
    assert.deepEqual(value(stored), value(bare), `${ship.ClassName}: a declared function of another kind changes nothing`)
    assert.ok(unstored.status === 'unavailable' && /the main function of the class of/.test(missing(unstored)[0]), `${ship.ClassName}: a row with no main function stored cannot be rated, naming it`)
  }

  assert.deepEqual(others.map((ship) => c.specialistPost({ ...ship, MainFunction: 2 }).value.label), ['Terraforming', 'Mining', 'Survey', 'Survey', 'Survey (half for a captain)'], 'the labels of the other posts as before')

  // The names of the functions the game gives a class.
  assert.deepEqual([2, 3, 6, 7, 8].map(c.mainFunctionLabel), ['Warship', 'Light Naval', 'Survey Ship', 'Survey Ship', 'Freighter'], 'the game\'s names')
  assert.equal(c.mainFunctionLabel(99), 'Function 99', 'a function the game does not name is read by its number')
  assert.ok(!/\d/.test(c.mainFunctionLabel(null)) && c.mainFunctionLabel(null) === c.mainFunctionLabel(undefined), 'no function stored is not a number')
  assert.deepEqual(c.declaredFunction({ MainFunction: 2, UserDefinedFunction: 1 }), { code: 2, label: 'Warship' }, 'a declared function is named')
  assert.deepEqual(c.declaredFunction({ MainFunction: 3, UserDefinedFunction: true }), { code: 3, label: 'Light Naval' }, 'a flag stored as a boolean is read')
  assert.equal(c.declaredFunction({ MainFunction: 2, UserDefinedFunction: 0 }), null, 'a function the game worked out is not declared')
  assert.equal(c.declaredFunction({ MainFunction: 2, UserDefinedFunction: null }), null, 'a declaration that is not stored is not one')
  assert.equal(c.declaredFunction({ MainFunction: null, UserDefinedFunction: 1 }), null, 'nor is a declaration of no function')
  assert.equal(c.declaredFunction({ UserDefinedFunction: 1 }), null, 'a row without the columns')

  // A light naval ship is ranked by Light Tactical, a specialist ship by its own bonus.
  const idle = [
    { CommanderID: 10, Name: 'Survey Officer', CommandType: 0, RankLevel: 2, bonuses: { 2: 1.5, [LIGHT_TACTICAL]: 1.1 } },
    { CommanderID: 11, Name: 'Light Officer', CommandType: 0, RankLevel: 2, bonuses: { 2: 1.1, [LIGHT_TACTICAL]: 1.4 } },
    { CommanderID: 12, Name: 'Other Rank', CommandType: 0, RankLevel: 3, bonuses: { 2: 1.1, [LIGHT_TACTICAL]: 1.5 } },
  ]
  const light = c.shipSuggestions([{ ...SHIP, CaptainID: null }], idle)
  const survey = c.shipSuggestions([{ ...others[4], MainFunction: 2, CaptainID: null, ShipName: 'Scout 001' }], idle)

  assert.deepEqual([light.rows.length, light.rows[0].candidate.CommanderID, light.rows[0].otherRanks], [1, 11, 1], 'the vacant light naval post goes to the best Light Tactical of its rank, the better one of another rank counted')
  assert.equal(survey.rows[0].candidate.CommanderID, 10, 'a survey ship goes to the best Survey')
  assert.equal(light.rows[0].post.bonusId, LIGHT_TACTICAL, 'the row says which bonus')
  assert.deepEqual([light.rows[0].post.share, light.rows[0].combat, light.rows[0].alsoBestFor], [1, null, 0], 'a class of 5 hull spaces carries nothing beside Light Tactical and no other post is named')

  // A ship whose class has no stored main function, or one the game does not name, is never offered a candidate.
  const unnamed = c.shipSuggestions([{ ...SHIP, MainFunction: null, CaptainID: null }, { ...SHIP, ShipID: 2, ShipName: 'Test 002', MainFunction: 99, CaptainID: null }, { ...others[4], CaptainID: null }], idle)

  assert.deepEqual([unnamed.rows.length, unnamed.unrated.length], [0, 3], 'a ship with no stored main function or one the game does not name is not rated, nor is one with no column for it')
  assert.deepEqual([missing(unnamed.unrated[0].result), missing(unnamed.unrated[1].result)], [['the main function of the class of Test'], ['the main function of the class of Test, stored as 99, which the game does not name']], 'and the function is named')

  // The rows over the limit: what counts in combat beside the ranking, and the posts one officer is the best candidate of.
  const holders = [
    { CommanderID: 20, Name: 'Holder', CommandType: 1, RankLevel: 2, bonuses: { [LIGHT_TACTICAL]: 1.1, [TACTICAL]: 1.25 } },
    { CommanderID: 21, Name: 'Idle One', CommandType: 0, RankLevel: 2, bonuses: { [LIGHT_TACTICAL]: 1.5, [TACTICAL]: 1.3 } },
    { CommanderID: 22, Name: 'Idle Two', CommandType: 0, RankLevel: 2, bonuses: { [LIGHT_TACTICAL]: 1.2 } },
  ]
  const bigShip = (id, changes) => ({ ...SHIP, ShipID: id, ShipName: `Test ${id}`, ClassSize: 30, UserDefinedFunction: 1, CaptainID: null, ...changes })
  const posts = [bigShip(1, { CaptainID: 20 }), bigShip(2), bigShip(3, { ClassSize: 5, UserDefinedFunction: 0 }), bigShip(4, { RankRequired: 3 })]
  const alternatives = c.shipSuggestions(posts, holders)

  assert.deepEqual(alternatives.rows.map((row) => [row.ship.ShipID, row.candidate && row.candidate.CommanderID, row.alsoBestFor]), [[1, 21, 2], [2, 21, 2], [3, 21, 2], [4, null, 0]], 'a post with no candidate names no other, the others name the posts that share one officer')
  assert.deepEqual(c.shipSuggestions(posts.slice(0, 2), holders).rows.map((row) => row.alsoBestFor), [1, 1], 'two posts for one officer name one other each')
  assert.deepEqual(c.shipSuggestions(posts.slice(0, 1), holders).rows.map((row) => row.alsoBestFor), [0], 'one post names none')
  assert.deepEqual(alternatives.rows[0].combat, { bonusId: TACTICAL, label: 'Tactical', share: 0.5, current: 1.25, candidate: 1.3 }, 'the holder\'s and the candidate\'s Tactical beside the ranking over the limit')
  assert.deepEqual([alternatives.rows[0].current, alternatives.rows[0].candidate.bonuses[LIGHT_TACTICAL]], [1.1, 1.5], 'whose ranking stays Light Tactical')
  assert.equal(alternatives.rows[1].combat.current, null, 'a vacant post has no holder\'s Tactical')
  assert.equal(alternatives.rows[2].combat, null, 'a post of 5 hull spaces carries none')
  assert.deepEqual(c.shipSuggestions(posts.slice(1, 2), holders.slice(1)).rows[0].combat.candidate, 1.3, 'the candidate\'s Tactical is the one held')
  assert.equal(c.shipSuggestions(posts.slice(1, 2), [holders[2]]).rows[0].combat.candidate, 1, 'and 1 where the officer holds none')

  const gated = c.shipSuggestions(posts, holders, {}, new Set([TACTICAL]))

  assert.deepEqual([gated.rows[0].combat.current, gated.rows[0].combat.candidate, gated.rows[0].current, gated.rows[0].candidate.CommanderID], [null, null, 1.1, 21], 'a Tactical the save does not confirm gives no value and leaves the ranking as it was')
  assert.ok(/Each counts a post, and one officer can be the best candidate of many posts, so the count is of posts that an officer would improve and is neither a number of officers nor an allocation/.test(c.bonusSuggestionCount(...[1, 2, 4].map((count) => ({ rows: new Array(count).fill({}), unrated: [] }))).result.rule.note), 'the count\'s rule says it counts posts and not officers')

  const rows = (count) => ({ rows: new Array(count).fill({}), unrated: [] })
  const counted = c.bonusSuggestionCount(rows(1), rows(2), rows(4))
  const withLight = c.bonusSuggestionCount(rows(1), rows(2), rows(4), { rows: rows(8).rows, unrated: [{}, {}, {}] })

  assert.deepEqual([counted.value, counted.unknown], [7, 0], 'the count of the three kinds as before')
  assert.deepEqual([withLight.value, withLight.unknown], [15, 3], 'the light naval rows and the ships that cannot be rated are added')
})

check('fixture', 'on the fixture the page\'s own script reads 627 light naval ships of the three classes (386 Griffins, 211 Raiders, 30 Lookouts) beside the 12 specialist ships, whose rows are as before, and the rows of the light naval view are the ones a ranking written here from the saved rows gives (the vacant Griffin to the best idle officer of the first rank, the vacant Lookout of the second rank to none with the officers of other ranks counted, every occupied post to an idle officer who beats the captain), the tile counts them with the others, nothing is declared, and a blocked Light Tactical rates no ship', async (w) => {
  const { commanders: c } = await w.modules()
  const database = copyOf('intact')
  const page = await pageOf(w, database)

  assert.equal(page.lightShips.length, 627, 'the light naval ships')
  assert.deepEqual(Object.fromEntries([GRIFFIN, RAIDER, LOOKOUT].map((id) => [id, oracleShips(database, `c.ShipClassID = ${id}`).length])), { [GRIFFIN]: 386, [RAIDER]: 211, [LOOKOUT]: 30 }, 'of the three classes')
  assert.deepEqual(page.lightShips.map((ship) => ship.ShipID).sort((a, b) => a - b), oracleShips(database, WIDE).map((ship) => ship.ShipID).sort((a, b) => a - b), 'the ships of a class whose stored main function is Light Naval, or is not stored or not one the game names')
  assert.equal(page.lightNavalShips.length, 627, 'every one is a light naval ship, the classes being of 5 hull spaces or fewer')
  assert.equal(page.ships.length, 12, 'the specialist ships read are the 12 as before')
  assert.equal(page.specialistShips.length, 12, 'and every one is a specialist ship')

  const stripped = page.ships.map((ship) => ({ ...ship, MainFunction: 2, UserDefinedFunction: 0, NoOfficers: 0 }))
  const before = c.shipSuggestions(stripped, page.byType[0], page.bonusNames, page.blockedBonuses)
  const after = page.shipAssessment

  assert.deepEqual(after.rows.map((row) => [row.ship.ShipID, row.post.label, row.post.level, row.candidate && row.candidate.CommanderID, row.current]), before.rows.map((row) => [row.ship.ShipID, row.post.label, row.post.level, row.candidate && row.candidate.CommanderID, row.current]), 'the specialist rows are those the page gave before the columns were read')
  assert.equal(after.unrated.length, before.unrated.length, 'and so are the ships that cannot be rated')

  const wanted = assertRows(page, database, 'fixture')
  const vacantGriffin = page.lightRows.find((row) => row.ship.ShipID === VACANT_GRIFFIN)
  const vacantLookout = page.lightRows.find((row) => row.ship.ShipID === VACANT_LOOKOUT)
  const best = oracleOfficers(database).filter((officer) => officer.Level === 1).sort((a, b) => b.LT - a.LT)[0]

  assert.ok(vacantGriffin && vacantGriffin.holder === null && vacantGriffin.post.level === 1, 'the vacant Griffin is a post of the first rank')
  assert.ok(near(vacantGriffin.candidate.bonuses[LIGHT_TACTICAL], best.LT) && vacantGriffin.candidate.RankLevel === 1, 'and goes to the best Light Tactical of the first rank')
  assert.ok(vacantLookout && vacantLookout.holder === null && vacantLookout.post.level === 2 && vacantLookout.candidate === null, 'the vacant Lookout needs the second rank and has no candidate')
  assert.equal(vacantLookout.otherRanks, oracleOfficers(database).filter((officer) => officer.LT > 1 + EPSILON).length - oracleOfficers(database).filter((officer) => officer.Level === 2 && officer.LT > 1 + EPSILON).length, 'with the officers of other ranks counted')
  assert.ok(wanted.rows.length > 100 && page.lightRows.filter((row) => row.holder && row.candidate).every((row) => row.candidate.bonuses[LIGHT_TACTICAL] > row.current + EPSILON), 'every occupied post has an idle officer who beats its captain')
  assert.ok(page.lightRows.every((row) => row.postResult.value.share === 1), 'the captains count in full')
  assert.ok(page.lightShips.every((ship) => page.declaredText(ship) === '') && page.ships.every((ship) => page.declaredText(ship) === ''), 'no class of the fixture is declared')

  const tile = page.tiles.find((entry) => entry.label === 'Better assignments')
  const total = page.governorRows.length + page.shipRows.length + page.lightRows.length + page.researchRows.length

  assert.equal(tile.value, page.count(total), 'the tile counts the light naval rows with the others')
  assert.ok(/light naval ships/.test(tile.note) && tile.note.includes(`${page.count(page.lightRows.length)} light naval ships`), `and says how many are light naval: ${tile.note}`)

  const light = await pageOf(w, database, { view: 'lightNaval' })

  const shipIds = (rows) => rows.map((row) => row.ship.ShipID)
  const gated = await pageOf(w, database, { view: 'lightNaval', blocked: [LIGHT_TACTICAL] })

  assert.ok(light.visibleShipRows.length > 100, 'the view the toggle names has the light naval rows')
  assert.deepEqual(shipIds(light.visibleShipRows), shipIds(light.lightRows), 'and they are the light naval rows')
  assert.equal(gated.visibleShipAssessment.unrated.length, 627, 'and the ships that cannot be rated are the light naval ones')
  assert.deepEqual(shipIds(page.visibleShipRows), shipIds(page.shipRows), 'the specialist view keeps its own rows')
  assert.notEqual(page.visibleShipRows.length, light.visibleShipRows.length, 'which are not the light naval ones')

  const blocked = gated

  assert.equal(blocked.lightRows.length, 0, 'with Light Tactical blocked no light naval ship is rated')
  assert.equal(blocked.lightAssessment.unrated.length, 627, 'every one is listed as one that cannot be rated')
  assert.ok(missing(blocked.lightAssessment.unrated[0].result).some((entry) => /bonus 39, Light Tactical/.test(entry)), 'naming the bonus')
  assert.equal(blocked.shipRows.length, page.shipRows.length, 'and the specialist ships are rated as before')
})

check('plants', 'on planted copies a class declared Warship leaves the light naval view, a survey class declared Light Naval moves from the specialist ships to it and is shown as declared (with what counts in combat said beside the post), one stored Light Naval and not declared stays a survey ship, the limit of 20 hull spaces holds (included) with and without a declaration, a class with no officers leaves it, one whose officers, size or declaration are not stored is listed as one that cannot be rated naming what is missing, no light naval class at all gives the page\'s empty text, and an idle officer given a better Light Tactical becomes the candidate', async (w) => {
  const { commanders: c } = await w.modules()
  const ids = (ships) => ships.map((ship) => ship.ShipID).sort((a, b) => a - b)
  const classIds = (page, list) => [...new Set(list.map((ship) => page.lightShips.concat(page.ships).find((one) => one.ShipID === ship.ShipID).ClassName))].sort()

  // The Griffins declared Warship, the Intrepid declared Light Naval.
  const declaredCopy = copyOf('declared')
  const declared = await pageOf(w, declaredCopy)
  const intrepid = oracleShips(declaredCopy, `c.ShipClassID = ${INTREPID}`)

  assert.equal(intrepid.length, 2, 'the Intrepid has two ships')
  assert.deepEqual(ids(declared.lightNavalShips), oracleShips(declaredCopy, 'c.MainFunction = 3 and (c.NoOfficers = 0 and (c.UserDefinedFunction = 1 or c.Size <= 20))').map((ship) => ship.ShipID).sort((a, b) => a - b), 'the light naval ships are the Raiders, the Lookouts and the Intrepid')
  assert.deepEqual(classIds(declared, declared.lightNavalShips), ['B64-A Raider', 'Intrepid', 'R115 Lookout'], 'of three classes, the declared Warship no longer among them')
  assert.equal(declared.lightNavalShips.length, 211 + 30 + 2, 'the Griffins have left it')
  assert.equal(declared.specialistShips.length, 10, 'the Intrepid has left the specialist ships')
  assert.ok(declared.specialistShips.every((ship) => ship.ClassName !== 'Intrepid'), 'and is not listed twice')
  assert.equal(declared.shipAssessment.rows.concat(declared.shipAssessment.unrated).filter((entry) => entry.ship.ClassName === 'Intrepid').length, 0, 'under the specialist ships either')

  for (const ship of intrepid) {
    const row = declared.lightNavalShips.find((one) => one.ShipID === ship.ShipID)
    const post = c.specialistPost(row)

    assert.notEqual(post.status, 'unavailable', `the Intrepid ${ship.ShipID} has a post`)
    assert.deepEqual([post.value.label, post.value.bonusId, post.value.level, post.value.share, post.value.combat], ['Light Tactical', LIGHT_TACTICAL, 4 + (ship.ShipSeniorCO === 1 ? 1 : 0), 0, { bonusId: TACTICAL, label: 'Tactical', share: 0.5 }], `the Intrepid ${ship.ShipID} is ranked by its captain's Light Tactical, which counts for nothing in combat at 1,220 hull spaces, and carries half of Tactical`)
    assert.equal(declared.declaredText(row), 'Light Naval', 'and shown as declared Light Naval')
  }

  assertRows(declared, declaredCopy, 'declared')

  // The post cell of the ships table, drawn from the page's own template: the declared function beside the post label, only for a declared class.
  const cells = tableSlots(w.texts.page, { declaredText: declared.declaredText, bonusText: (id, amount) => declared.bonusText(id, amount) })
  const vacantIntrepid = declared.lightRows.find((row) => row.ship.ClassName === 'Intrepid')
  const vacantRaider = declared.lightRows.find((row) => row.ship.ClassName === 'B64-A Raider')

  assert.ok(vacantIntrepid && vacantRaider, 'the declared Intrepid and a Raider are among the light naval rows')
  assert.ok(/Light Tactical \(declared as Light Naval\) · Rank \d/.test(cells('item.post', vacantIntrepid)) && /Over 20 hull spaces Light Tactical does not count in combat/.test(cells('item.post', vacantIntrepid)), `a declared class carries the function beside the post label, and what counts in combat: ${cells('item.post', vacantIntrepid)}`)
  assert.ok(/Light Tactical · Rank \d\s*$/.test(cells('item.post', vacantRaider)) && !/declared/.test(cells('item.post', vacantRaider)), `a class the game worked out carries none: ${cells('item.post', vacantRaider)}`)
  assert.equal(declared.declaredText({ MainFunction: 2, UserDefinedFunction: 1 }), 'Warship', 'a class declared Warship is named by the game\'s word')
  assert.equal(declared.declaredText({ MainFunction: 2, UserDefinedFunction: 0 }), '', 'a function the game worked out is not shown')

  // The Intrepid stored Light Naval and not declared: 1,220 hull spaces, so the game would not have chosen it.
  const storedCopy = copyOf('stored')
  const stored = await pageOf(w, storedCopy)

  assert.equal(stored.lightShips.length, 627 + 2, 'the read takes the ships of the class')
  assert.equal(stored.lightNavalShips.length, 627, 'but they are not light naval ships')
  assert.equal(stored.specialistShips.length, 12, 'and stay among the specialist ships')
  assert.deepEqual(stored.specialistShips.filter((ship) => ship.ClassName === 'Intrepid').map((ship) => c.specialistPost(ship).value), stored.specialistShips.filter((ship) => ship.ClassName === 'Intrepid').map((ship) => c.specialistPost({ ...ship, MainFunction: 2 }).value), 'with the post of a survey ship, as when it is not stored Light Naval')
  assert.ok(stored.specialistShips.filter((ship) => ship.ClassName === 'Intrepid').every((ship) => c.specialistPost(ship).value.bonusId === 2), 'ranked by Survey')
  assertRows(stored, storedCopy, 'stored')

  // A survey class of 10 hull spaces whose function is not Light Naval stays a survey ship: the size alone does not make a class light naval.
  const smallCopy = copyOf('smallSurvey')
  const small = await pageOf(w, smallCopy)

  assert.equal(small.lightNavalShips.length, 627, 'a small class that is not stored Light Naval adds no light naval ship')
  assert.equal(small.specialistShips.length, 12, 'and stays among the specialist ships')
  assert.deepEqual(small.specialistShips.filter((ship) => ship.ClassName === 'Intrepid').map((ship) => value(c.specialistPost(ship)).label), ['Survey', 'Survey'], 'ranked as a survey ship of 20 hull spaces or fewer, in full')

  // The limit.
  const limitsCopy = copyOf('limits')
  const limits = await pageOf(w, limitsCopy)

  assert.deepEqual(classIds(limits, limits.lightNavalShips), ['B64-A Raider', 'R115 Lookout'], 'at 20 hull spaces a class is light naval, just above it only when declared')
  assert.deepEqual([limits.lightNavalShips.length, limits.lightShips.length], [211 + 30, 627], 'the Griffins are read and are not light naval')
  assertRows(limits, limitsCopy, 'limits')

  // What is not stored.
  const unsavedCopy = copyOf('unsaved')
  const unsaved = await pageOf(w, unsavedCopy)
  const unratedFor = (name) => unsaved.lightAssessment.unrated.filter((entry) => entry.ship.ClassName === name)

  assert.ok(unsaved.lightNavalShips.every((ship) => ship.ClassName !== 'B64-A Raider'), 'a class with no officers has no light naval ship')
  assert.equal(unratedFor('B64-A Raider').length, 0, 'and none that cannot be rated')
  assert.deepEqual([unratedFor('R115 Lookout').length, unratedFor('J74 Griffin').length, unratedFor('Intrepid').length], [30, 386, 2], 'the other three classes are listed as ships that cannot be rated')
  assert.deepEqual(missing(unratedFor('R115 Lookout')[0].result), ['whether the class of R115 Lookout has officers'], 'the Lookout names the officers flag')
  assert.deepEqual(missing(unratedFor('J74 Griffin')[0].result), ['the size of the class of J74 Griffin'], 'the Griffin names its size')
  assert.deepEqual(missing(unratedFor('Intrepid')[0].result), ['whether the function of the class of Intrepid was declared'], 'the Intrepid names its declaration')
  assert.equal(unsaved.lightRows.length, 0, 'and none of them is given a row')
  assert.equal(unsaved.specialistShips.length, 10, 'a ship that may be light naval is not among the specialist ships either')
  assertRows(unsaved, unsavedCopy, 'unsaved')

  // No light naval class at all.
  const none = await pageOf(w, copyOf('none'), { view: 'lightNaval' })

  assert.equal(none.lightNavalShips.length, 0, 'no light naval ship')
  assert.equal(none.visibleShipRows.length, 0, 'no row')
  assert.equal(none.shipEmptyText, 'No ship of a light naval class that has officers.', 'the page says so')

  const filled = await pageOf(w, copyOf('intact'), { view: 'lightNaval' })

  assert.ok(/^Every light naval ship/.test(filled.shipEmptyText) || filled.visibleShipRows.length > 0, 'a page with rows has no empty text to show')

  // An idle officer with a better Light Tactical.
  const betterCopy = copyOf('better')
  const better = await pageOf(w, betterCopy)
  const lifted = HOLDERS.lifted

  assertRows(better, betterCopy, 'better')

  const vacant = better.lightRows.find((row) => row.ship.ShipID === VACANT_GRIFFIN)

  assert.equal(vacant.candidate.CommanderID, lifted.CommanderID, `the vacant Griffin goes to the officer the plant lifted (${lifted.Name}) and not to ${HOLDERS.best.Name}`)
  assert.ok(near(vacant.candidate.bonuses[LIGHT_TACTICAL], HOLDERS.liftedTo), 'at the lifted bonus')
  assert.ok(better.lightRows.filter((row) => row.post.level === 1 && row.candidate).every((row) => row.candidate.CommanderID === lifted.CommanderID), 'and every post of the first rank to the same officer')
})

check('unnamed', 'a class whose main function is not stored or is not one the game names is read with the light naval ships and listed as one that cannot be rated, naming the function and never offered a candidate, and a class that no function makes light naval (no officers, or not declared and over 20 hull spaces) is left out and stays among the specialist ships; one that a function may make light naval (the survey class of 10 hull spaces, a declared class) leaves the specialist ships', async (w) => {
  const { commanders: c } = await w.modules()

  // A class whose main function is not stored, or is not one the game names: the Griffins with none, the Raiders with 99, the Lookouts with none at 21 hull spaces and not declared, the Intrepid with none at 1,220 hull spaces and not declared.
  const unnamedFor = (page, name) => page.lightAssessment.unrated.filter((entry) => entry.ship.ClassName === name)
  const unnamedCopy = copyOf('unnamed')
  const unnamed = await pageOf(w, unnamedCopy)

  assert.equal(unnamed.lightShips.length, 386 + 211 + 30 + 2, 'the read takes the ships of the four classes')
  assert.equal(unnamed.lightNavalShips.length, 386 + 211, 'the Griffins and the Raiders may be light naval ones, the Lookouts and the Intrepid, not declared and over 20 hull spaces, are not')
  assert.equal(unnamed.lightRows.length, 0, 'none is given a row')
  assert.equal(unnamed.lightAssessment.unrated.length, 386 + 211, 'and every one is listed as a ship that cannot be rated')
  assert.deepEqual(missing(unnamedFor(unnamed, 'J74 Griffin')[0].result), ['the main function of the class of J74 Griffin'], 'the Griffin names its function')
  assert.deepEqual(missing(unnamedFor(unnamed, 'B64-A Raider')[0].result), ['the main function of the class of B64-A Raider, stored as 99, which the game does not name'], 'the Raider names the number the game does not name')
  assert.equal(unnamedFor(unnamed, 'R115 Lookout').length + unnamedFor(unnamed, 'Intrepid').length, 0, 'a class not declared and over 20 hull spaces is not listed')
  assert.equal(unnamed.specialistShips.length, 12, 'and the Intrepid, which no function makes light naval, stays among the specialist ships')
  assert.deepEqual(unnamed.specialistShips.filter((ship) => ship.ClassName === 'Intrepid').map((ship) => c.specialistPost(ship).value), unnamed.specialistShips.filter((ship) => ship.ClassName === 'Intrepid').map((ship) => c.specialistPost({ ...ship, MainFunction: 6 }).value), 'with the post its modules give')
  assertRows(unnamed, unnamedCopy, 'unnamed')

  // The Griffins with none and no officers, the Raiders with 99 at 30 hull spaces and not declared, the Lookouts with none, the Intrepid with none and declared.
  const outCopy = copyOf('unnamedOut')
  const out = await pageOf(w, outCopy)

  assert.equal(out.lightShips.length, 386 + 211 + 30 + 2, 'the read takes the ships of the four classes')
  assert.equal(out.lightNavalShips.length, 30 + 2, 'only the Lookouts and the Intrepid may be light naval ones: a class with no officers, or not declared and over 20 hull spaces, is not')
  assert.deepEqual([unnamedFor(out, 'R115 Lookout').length, unnamedFor(out, 'Intrepid').length, unnamedFor(out, 'J74 Griffin').length, unnamedFor(out, 'B64-A Raider').length], [30, 2, 0, 0], 'and they are listed as ships that cannot be rated')
  assert.equal(out.specialistShips.length, 10, 'the declared Intrepid may be light naval and has left the specialist ships')
  assertRows(out, outCopy, 'unnamedOut')

  // The survey class of 10 hull spaces with no stored function: the game may have chosen Light Naval for it, so it is not offered a survey ship\'s candidate.
  const surveyCopy = copyOf('unnamedSurvey')
  const survey = await pageOf(w, surveyCopy)

  assert.equal(survey.lightNavalShips.length, 627 + 2, 'the Intrepid may be a light naval ship')
  assert.deepEqual(missing(unnamedFor(survey, 'Intrepid')[0].result), ['the main function of the class of Intrepid'], 'and is listed as one that cannot be rated, naming the function')
  assert.equal(survey.specialistShips.length, 10, 'it has left the specialist ships')
  assert.equal(survey.shipAssessment.rows.concat(survey.shipAssessment.unrated).filter((entry) => entry.ship.ClassName === 'Intrepid').length, 0, 'and is neither rated nor listed under them')
  assertRows(survey, surveyCopy, 'unnamedSurvey')
})

check('combat', 'a declared class over 20 hull spaces is ranked by Light Tactical and carries half of the captain\'s Tactical beside it, the holder\'s and the candidate\'s values read from the save, none where the save does not confirm Tactical, the cells say what the ranking is and what counts in combat and that the rows that name one officer are alternatives (one other post in the singular, none for none), and a declared class with no stored size carries neither', async (w) => {
  // Declared classes over the limit, with an idle officer lifted in Light Tactical and given a Tactical of 1.4.
  const largeCopy = copyOf('large', 'tactical')
  const large = await pageOf(w, largeCopy)
  const ofClass = (page, name) => page.lightRows.filter((row) => row.ship.ClassName === name)
  const raiderRows = ofClass(large, 'B64-A Raider')

  assert.equal(large.lightNavalShips.length, 627, 'the three classes are light naval ones, the Lookouts and the Griffins declared')
  assert.ok(ofClass(large, 'R115 Lookout').length > 0 && ofClass(large, 'J74 Griffin').length > 0 && raiderRows.length > 0, 'with rows of each')
  assertRows(large, largeCopy, 'large')
  assert.ok(ofClass(large, 'R115 Lookout').concat(ofClass(large, 'J74 Griffin')).every((row) => row.post.share === 0 && row.post.combat && row.combat.bonusId === TACTICAL), 'the Lookouts at 21 and the Griffins at 25 hull spaces count nothing of Light Tactical and carry Tactical')
  assert.ok(raiderRows.every((row) => row.post.share === 1 && !row.post.combat && row.combat === null), 'the Raiders of 5 hull spaces count it in full and carry nothing beside it')

  const vacantBig = large.lightRows.find((row) => row.ship.ShipID === VACANT_GRIFFIN)
  const occupiedBig = large.lightRows.find((row) => row.holder && row.combat)
  const occupiedSmall = raiderRows.find((row) => row.holder)

  assert.ok(vacantBig && vacantBig.candidate.CommanderID === HOLDERS.best.CommanderID && near(vacantBig.combat.candidate, 1.4) && near(vacantBig.candidate.bonuses[LIGHT_TACTICAL], Math.round((HOLDERS.best.LT + 0.3) * 100) / 100), 'the lifted officer is the candidate of the vacant Griffin by Light Tactical, with a Tactical of 1.4 beside it')
  assert.ok(vacantBig.alsoBestFor > 0 && vacantBig.alsoBestFor === large.lightRows.filter((row) => row.candidate && row.candidate.CommanderID === HOLDERS.best.CommanderID).length - 1, 'and of every other post of the first rank')
  assert.ok(occupiedBig && occupiedSmall, 'a post held by a captain, of a class over the limit and of one under it')
  assert.ok(large.lightRows.some((row) => row.holder && row.combat && Math.abs(row.combat.current - row.current) > EPSILON), 'the Tactical of a captain is another figure than the Light Tactical')

  const bigCells = tableSlots(w.texts.page, { declaredText: large.declaredText, bonusText: (id, amount) => large.bonusText(id, amount) })
  const warning = /Ranked by Light Tactical, as the game orders its assignments\. Over 20 hull spaces Light Tactical does not count in combat, which takes half of the captain's Tactical instead\./
  const holderCell = bigCells('item.holder', occupiedBig)
  const candidateCell = bigCells('item.candidate', vacantBig)
  const alsoFor = (count) => bigCells('item.candidate', { ...vacantBig, alsoBestFor: count })

  assert.ok(warning.test(bigCells('item.post', vacantBig)) && !warning.test(bigCells('item.post', occupiedSmall)), `the post cell says what the ranking is, only over the limit: ${bigCells('item.post', vacantBig)}`)
  assert.ok(holderCell.includes(large.bonusText(LIGHT_TACTICAL, occupiedBig.current)) && holderCell.includes(`In combat: ${large.bonusText(TACTICAL, occupiedBig.combat.current)}, half of it counts`) && !bigCells('item.holder', occupiedSmall).includes('In combat'), `the holder cell shows the ranking and what counts in combat: ${holderCell}`)
  assert.ok(candidateCell.includes(`In combat: ${large.bonusText(TACTICAL, 1.4)}, half of it counts`) && !bigCells('item.candidate', raiderRows.find((row) => row.candidate) || occupiedSmall).includes('In combat'), `and so does the candidate cell: ${candidateCell}`)
  assert.ok(candidateCell.includes(`Also the best candidate for ${vacantBig.alsoBestFor} other posts: alternatives for one officer, not an allocation`), `which says that the other posts are alternatives for the same officer: ${candidateCell}`)
  assert.ok(alsoFor(1).includes('Also the best candidate for 1 other post: alternatives for one officer, not an allocation') && !/Also the best candidate/.test(alsoFor(0)), 'one other post is named in the singular and none, none')

  // A Tactical that the save does not confirm: no value of it, the ranking as it was.
  const gatedT = await pageOf(w, copyOf('large', 'lifted'), { blocked: [TACTICAL] })

  assert.deepEqual(gatedT.lightRows.map((row) => [row.ship.ShipID, row.candidate && row.candidate.CommanderID]), large.lightRows.map((row) => [row.ship.ShipID, row.candidate && row.candidate.CommanderID]), 'a blocked Tactical changes no ranking')
  assert.ok(gatedT.lightRows.some((row) => row.combat) && gatedT.lightRows.filter((row) => row.combat).every((row) => row.combat.current === null && row.combat.candidate === null), 'and gives no value of it')
  assert.notEqual(gatedT.bonusText(TACTICAL, 1.4), large.bonusText(TACTICAL, 1.4), 'which the cells say')

  // A declared class with no stored size: ranked, and neither counted in full nor given another bonus.
  const sizelessCopy = copyOf('sizeless')
  const sizeless = await pageOf(w, sizelessCopy)
  const sizelessRows = ofClass(sizeless, 'R115 Lookout')

  assertRows(sizeless, sizelessCopy, 'sizeless')
  assert.ok(sizelessRows.length > 0 && sizelessRows.every((row) => row.post.share === null && !row.post.combat && row.combat === null), 'the Lookouts have no share and no other bonus')

  const sizelessPost = tableSlots(w.texts.page, { declaredText: sizeless.declaredText, bonusText: (id, amount) => sizeless.bonusText(id, amount) })('item.post', sizelessRows[0])

  assert.ok(/The size of the class is not stored, so whether Light Tactical counts in combat is not known\./.test(sizelessPost) && !/Ranked by Light Tactical/.test(sizelessPost), `and the post cell says so: ${sizelessPost}`)
})

check('capability', 'the page\'s reads name the class\'s main function, declaration and officers flag as inputs of the route for both ship reads, a save without one of them cannot give the page (the report is unsupported, naming the input and the field), and Light Tactical and Tactical are gated bonuses of the page whose renamed rows block them', async (w) => {
  const { capabilities: k } = await w.modules()
  const inputs = k.INPUTS['/commanders']
  const named = (key) => inputs.find((entry) => entry.key === key)

  for (const key of ['ships', 'lightShips']) {
    const reads = named(key).reads.FCT_ShipClass || []

    assert.ok(named(key).optional !== true, `${key} is an ordinary input of the route`)
    assert.ok(['MainFunction', 'UserDefinedFunction', 'NoOfficers', 'Size'].every((column) => reads.includes(column)), `${key} reads the columns of the class: ${reads.join(', ')}`)
  }

  assert.ok(!k.DECLARED.some((entry) => entry.table === 'FCT_ShipClass' && ['MainFunction', 'UserDefinedFunction', 'NoOfficers'].some((column) => entry.columns.includes(column))), 'the registry does not declare them as read later')

  const whole = (await k.preflight(loaderOf(copyOf('intact')))).reports['/commanders']

  assert.equal(whole.status, 'supported', `the fixture's Commanders report is whole, not ${whole.status}`)

  for (const [name, field] of [['droppedFunction', 'FCT_ShipClass.UserDefinedFunction'], ['droppedOfficers', 'FCT_ShipClass.NoOfficers'], ['droppedMain', 'FCT_ShipClass.MainFunction']]) {
    const report = (await k.preflight(loaderOf(copyOf(name)))).reports['/commanders']

    assert.equal(report.status, 'unsupported', `a save without ${field} cannot give the page, not ${report.status}`)
    assert.ok(report.missing.some((entry) => entry.key === 'lightShips' && entry.fields.includes(field)), `the report names the input lightShips and ${field}: ${JSON.stringify(report.missing.map((entry) => [entry.key, entry.fields]))}`)
  }

  assert.equal(k.BONUS_NAMES[LIGHT_TACTICAL].name, 'Light Tactical', 'the bonus the game ranks the captain of a light naval ship by')
  assert.ok(k.BONUS_NAMES[LIGHT_TACTICAL].routes.includes('/commanders'), 'is a gated bonus of the Commanders page')
  assert.equal(k.BONUS_NAMES[LIGHT_TACTICAL].percentage, true, 'a multiplier')

  const renamed = await k.preflight(loaderOf(copyOf('renamedBonus')))

  assert.ok(k.blockedBonuses(renamed.gates).has(LIGHT_TACTICAL), 'a save whose row for it is renamed blocks the bonus')
  assert.notEqual(renamed.reports['/commanders'].status, 'supported', 'and no longer gives the page whole')
  assert.ok(!k.blockedBonuses((await k.preflight(loaderOf(copyOf('intact')))).gates).has(LIGHT_TACTICAL), 'a save that holds it as expected blocks nothing')
  assert.equal(k.BONUS_NAMES[TACTICAL].name, 'Tactical', 'the bonus a declared light naval ship over 20 hull spaces takes half of in combat')
  assert.ok(k.BONUS_NAMES[TACTICAL].routes.includes('/commanders') && k.BONUS_NAMES[TACTICAL].percentage === true, 'is a gated multiplier of the Commanders page')

  const renamedTactical = await k.preflight(loaderOf(copyOf('renamedTactical')))

  assert.ok(k.blockedBonuses(renamedTactical.gates).has(TACTICAL) && !k.blockedBonuses(renamedTactical.gates).has(LIGHT_TACTICAL), 'a save whose row for it is renamed blocks it and not Light Tactical')
  assert.ok(!k.blockedBonuses((await k.preflight(loaderOf(copyOf('intact')))).gates).has(TACTICAL), 'a save that holds it as expected blocks nothing')
})

check('text', 'the toggle names the light naval ships, the feet open with what the view is for and say how the post is decided, what a declared function does, what counts in combat and that the rows are alternatives, in the impersonal voice with no release named, the view is among those the page restores, the page help and the rule\'s note say the same, and the comment above the post rule states the rule in plain words', async (w) => {
  const text = w.texts.page
  const { glossary: g, commanders: c } = await w.modules()

  assert.ok(/<v-btn value="lightNaval" small>Light naval ships \(\{\{ lightRows\.length \}\}\)<\/v-btn>/.test(text), 'the toggle names the view and counts its rows')
  assert.ok(/valid: oneOf\(\['governors', 'ships', 'lightNaval', 'research'\]\)/.test(text), 'and a stored choice of it is restored')

  const footOf = (opener) => {
    const start = text.indexOf(opener)

    assert.ok(start >= 0, `the page has the foot ${opener}`)

    return text.slice(start, text.indexOf('</div>', start)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  const specialist = footOf('Use it to check why an officer is suggested for a ship.')
  const light = footOf('Use it to check why an officer is suggested for a light naval ship.')

  assert.ok(/A function the player declared for the class shows beside the post label as declared/.test(specialist) && /a class declared Light Naval is a light naval ship and is listed under Light naval ships/.test(specialist), `the specialist foot says what a declared function does: ${specialist.slice(-300)}`)
  assert.ok(/A ship is light naval when its class's main function is Light Naval and the class has officers/.test(light), 'the light naval foot says what a light naval ship is')
  assert.ok(/as Light Naval for an armed class of 20 hull spaces or fewer, unless the player declared it, so a stored Light Naval function on a larger class counts only when it was declared/.test(light), 'how the game chooses the function and what that means for a larger class')
  assert.ok(/The captain is ranked by the Light Tactical bonus, as the game orders its assignments for that function/.test(light) && /Candidates are unassigned naval officers of exactly the post's rank/.test(light), 'the bonus and the candidates')
  assert.ok(/For a class of 20 hull spaces or fewer that bonus is also what the captain adds to the ship in combat, in full\. For a declared class over 20 hull spaces it is not: the ship's tactical multiplier takes half of the captain's Tactical there and nothing of Light Tactical, so those rows show the Tactical bonus of the holder and the candidate beside the ranking, and a candidate with a better Light Tactical is not thereby better in combat/.test(light), 'what counts in combat')
  assert.ok(/one officer can be the best for many posts, and those rows are alternatives for that officer, not an allocation/.test(light) && /one officer can be the best for several posts, and those rows are alternatives for that officer, not an allocation/.test(specialist), 'that the rows that name one officer are alternatives')
  assert.ok(/A ship whose class has no stored main function, or one the game does not name, may be light naval and is listed as one that cannot be rated, naming the function/.test(light) && /A ship whose class has no stored main function may be light naval, so it is listed there as one that cannot be rated and not here/.test(specialist), 'and what a class with no stored main function is')
  assert.ok(/only Light Naval is ranked by a bonus of its own here, so a class declared as anything else keeps the post its modules give/.test(light), 'and the limit of the declared ranking')

  for (const [name, words] of [['specialist foot', specialist], ['light naval foot', light]]) {
    assert.ok(!/\b(I|we|you|your|our)\b/i.test(words), `the ${name} is in the impersonal voice`)
    assert.ok(!/\d+\.\d+\.\d+|\b[23]\.[01]\b/.test(words), `the ${name} names no release`)
  }

  const usage = g.PAGE_HELP['/commanders'].usage[0]

  assert.ok(/Specialist ships, Light naval ships and Research/.test(usage) && /A light naval ship is ranked by its captain's Light Tactical bonus, as the game orders its assignments; for a declared class over 20 hull spaces its combat effect takes half of the Tactical bonus instead, and the row shows both\. A function the player declared for a ship's class shows beside the post label as declared/.test(usage), 'the page help names the view and the two bonuses')
  assert.ok(/A row names the best unassigned officer for its post alone, so one officer can head many rows, which are alternatives and not an allocation/.test(usage), 'and that the rows are alternatives')

  const note = c.specialistPost({ ...SHIP, ClassSize: 5 }).rule.note

  assert.ok(/A ship of a class whose stored main function is Light Naval and that has officers is a light naval ship: its captain is ranked by Light Tactical, the bonus the game's assignment order uses for that function/.test(note), 'the rule note says what a light naval ship is')
  assert.ok(/That ranking is not the effect on the ship: in combat the ship's own tactical multiplier takes the captain's Light Tactical in full for a class of 20 hull spaces or less and half of the captain's Tactical for a larger one, so for a class declared Light Naval over 20 hull spaces Light Tactical counts for nothing in combat, and the post carries the Tactical bonus beside it/.test(note), 'what counts in combat')
  assert.ok(/A class whose main function is not stored, or is one the game does not name, may be a light naval class and has no post, unless it has no officers or is not declared and over 20 hull spaces, which no function makes light naval/.test(note), 'and what a class with no stored main function is')
  assert.ok(/so a stored Light Naval function counts for a class over 20 hull spaces only when it was declared/.test(note), 'when a stored function counts')
  assert.ok(/A Light Naval class whose officers, size or declaration are not stored has no post/.test(note), 'and when there is no post')
  assert.deepEqual([...c.specialistPost({ ...SHIP }).rule.versions], ['3.2.x'], 'the rule is registered for the line it was read from')

  const source = w.texts.commanders
  const at = source.indexOf('registerRule({\n  id: POST,')
  const comment = source.slice(0, at).trimEnd().split('\n').pop()

  assert.ok(at > 0 && /^\/\/ The post rule: /.test(comment), 'a comment sits above the post rule and states it')

  for (const member of ['the game ranks the captain of a ship by the bonus of its stored main function', 'it chooses Light Naval only for a class of at most 20 hull spaces unless the player declared the function', "the ship's tactical multiplier takes the captain's Light Tactical for a ship of at most 20 hull spaces", "the captain's Tactical halved for a larger one", 'skips Light Tactical above 20 hull spaces']) {
    assert.ok(comment.includes(member), `the comment above the post rule says: ${member}`)
  }

  assert.ok(/So the ranking of a declared Light Naval class over 20 hull spaces by Light Tactical is the game's assignment order and not its effect in combat\.$/.test(comment), 'and ends with what that means for a declared class over 20 hull spaces')
  assert.ok(/Each counts a post, and one officer can be the best candidate of many posts, so the count is of posts that an officer would improve and is neither a number of officers nor an allocation/.test(source), 'the count of assignments says that it counts posts, not officers')
})

check('played', 'on the played 3.2.0 save, where no class is stored as Light Naval and none is declared, the page\'s own script reads no light naval ship, the specialist ships show no declared function, the light naval view says so, the Commanders report is whole, Light Tactical is not blocked and the officers hold it as a multiplier', async (w) => {
  if (!PLAYED_PRESENT) {
    console.log(`SKIP  played: ${PLAYED} is not present`)
    return
  }

  const { capabilities: k } = await w.modules()
  const database = playedCopy()
  const classes = database.query(`select MainFunction, UserDefinedFunction, NoOfficers, Size from FCT_ShipClass where GameID = ${PLAYED_GAME} and RaceID = ${PLAYED_RACE}`).all()

  assert.ok(classes.length > 0, 'the save holds classes of the race')
  assert.ok(classes.every((row) => row.UserDefinedFunction === 0), 'none of them is declared')
  assert.ok(classes.every((row) => oracleLightNaval(row) === false), 'none is a light naval one by the rule written here')

  const page = await pageOf(w, database, { view: 'lightNaval', game: PLAYED_GAME, race: PLAYED_RACE })

  assert.equal(page.lightShips.length, 0, 'the read of the light naval ships is empty')
  assert.equal(page.lightNavalShips.length, 0, 'so are the ships of the view')
  assert.equal(page.lightRows.length, 0, 'and its rows')
  assert.equal(page.visibleShipRows.length, 0, 'the table shows none')
  assert.equal(page.shipEmptyText, 'No ship of a light naval class that has officers.', 'the page says so')

  const specialist = await pageOf(w, database, { view: 'ships', game: PLAYED_GAME, race: PLAYED_RACE })

  assert.ok(specialist.ships.length > 0, 'the save holds specialist ships')
  assert.equal(specialist.specialistShips.length, specialist.ships.length, 'every one stays in the specialist view')
  assert.ok(specialist.ships.every((ship) => specialist.declaredText(ship) === ''), 'none shows a declared function')

  const report = (await k.preflight(loaderOf(database))).reports['/commanders']

  assert.equal(report.status, 'supported', `the Commanders report of a played save is whole, not ${report.status}`)
  assert.ok(!k.blockedBonuses((await k.preflight(loaderOf(database))).gates).has(LIGHT_TACTICAL), 'Light Tactical is not blocked')

  const stored = database.query(`select count(*) as n, min(FCT_CommanderBonuses.BonusValue) as lowest from FCT_CommanderBonuses inner join FCT_Commander on FCT_Commander.CommanderID = FCT_CommanderBonuses.CommanderID where FCT_Commander.GameID = ${PLAYED_GAME} and FCT_Commander.RaceID = ${PLAYED_RACE} and FCT_CommanderBonuses.BonusID = ${LIGHT_TACTICAL}`).get()

  assert.ok(stored.n > 0, 'officers of the race hold Light Tactical')
  assert.ok(stored.lowest > 1, `stored as a multiplier above 1, the lowest ${stored.lowest}`)
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'a class of exactly 20 hull spaces is not light naval', target: 'commanders', from: 'return ship.ClassSize <= LIGHT_NAVAL_SIZE ? true : declared === false ? false : null', to: 'return ship.ClassSize < LIGHT_NAVAL_SIZE ? true : declared === false ? false : null', fails: ['rule', 'plants'] },
  { name: 'a class over 20 hull spaces with no declaration is light naval', target: 'commanders', from: 'return ship.ClassSize <= LIGHT_NAVAL_SIZE ? true : declared === false ? false : null', to: 'return true', fails: ['rule', 'plants'] },
  { name: 'a class over 20 hull spaces with no stored declaration is not light naval', target: 'commanders', from: 'return ship.ClassSize <= LIGHT_NAVAL_SIZE ? true : declared === false ? false : null', to: 'return ship.ClassSize <= LIGHT_NAVAL_SIZE', fails: ['rule', 'plants'] },
  { name: 'a class over 20 hull spaces never light naval, declared or not', target: 'commanders', from: '  } else if (declared === true) {\n    return true\n  }\n\n  if (!isKnownNumber(ship.ClassSize)) {', to: '  }\n\n  if (!isKnownNumber(ship.ClassSize)) {', fails: ['rule', 'plants'] },
  { name: 'a class with no officers is light naval', target: 'commanders', from: '  if (officers === true) {\n    return false\n  } else if (officers === null) {', to: '  if (false) {\n    return false\n  } else if (officers === null) {', fails: ['rule', 'plants'] },
  { name: 'a class with no stored officers flag is light naval', target: 'commanders', from: '  } else if (officers === null) {\n    return null', to: '  } else if (officers === null) {\n    return true', fails: ['rule', 'plants'] },
  { name: 'a class with no stored size is not light naval', target: 'commanders', from: '  if (!isKnownNumber(ship.ClassSize)) {\n    return null\n  }\n\n  return ship.ClassSize', to: '  if (!isKnownNumber(ship.ClassSize)) {\n    return false\n  }\n\n  return ship.ClassSize', fails: ['rule', 'plants'] },
  { name: 'every main function is light naval', target: 'commanders', from: '  if (named && ship.MainFunction !== LIGHT_NAVAL_FUNCTION) {\n    return false\n  }', to: '  if (false) {\n    return false\n  }', fails: ['rule', 'plants'] },
  { name: 'the game\'s light naval function is another', target: 'commanders', from: 'const LIGHT_NAVAL_FUNCTION = 3', to: 'const LIGHT_NAVAL_FUNCTION = 2', fails: ['rule', 'fixture', 'plants'] },
  { name: 'the captain of a light naval ship is ranked by another bonus', target: 'commanders', from: 'export const LIGHT_TACTICAL = 39', to: 'export const LIGHT_TACTICAL = 38', fails: ['rule', 'fixture', 'plants'] },
  { name: 'the captain of a light naval ship counts half', target: 'commanders', from: ': post({ ...base, share: 1 })', to: ': post({ ...base, share: 0.5 })', fails: ['rule', 'fixture'] },
  { name: 'a light naval ship is ranked as a survey ship', target: 'commanders', from: '  } else if (lightNaval) {\n    return lightNavalPost()', to: '  } else if (false) {\n    return lightNavalPost()', fails: ['rule', 'fixture', 'plants'] },
  { name: 'a light naval ship that cannot be told is ranked as another', target: 'commanders', from: '  if (lightNaval === null) {\n    return unavailable', to: '  if (false) {\n    return unavailable', fails: ['rule', 'plants'] },
  { name: 'the officers flag is not named where it decides', target: 'commanders', from: '  ...(flagOf(ship.NoOfficers) === null ? [`whether the class of ${where} has officers`] : []),', to: '', fails: ['rule', 'plants'] },
  { name: 'the size is named where the declaration decides', target: 'commanders', from: '  ...(flagOf(ship.UserDefinedFunction) !== true && !isKnownNumber(ship.ClassSize) ? [`the size of the class of ${where}`] : []),', to: '  ...(!isKnownNumber(ship.ClassSize) ? [`the size of the class of ${where}`] : []),', fails: ['rule'] },
  { name: 'a blocked Light Tactical is not named', target: 'commanders', from: '...(blocked.has(value.bonusId) ? [`the save\'s row for bonus ${value.bonusId}, ${value.label}`] : [])', to: '', fails: ['rule', 'fixture'] },
  { name: 'a function is declared whatever the flag says', target: 'commanders', from: 'flagOf(ship.UserDefinedFunction) === true && isKnownNumber(ship.MainFunction) ?', to: 'isKnownNumber(ship.MainFunction) ?', fails: ['rule', 'fixture', 'plants'] },
  { name: 'a declared function is named by its number', target: 'commanders', from: 'declaredFunction = (ship) => (flagOf(ship.UserDefinedFunction) === true && isKnownNumber(ship.MainFunction) ? { code: ship.MainFunction, label: mainFunctionLabel(ship.MainFunction) } : null)', to: 'declaredFunction = (ship) => (flagOf(ship.UserDefinedFunction) === true && isKnownNumber(ship.MainFunction) ? { code: ship.MainFunction, label: `Function ${ship.MainFunction}` } : null)', fails: ['rule', 'plants'] },
  { name: 'a warship is called a cruiser', target: 'commanders', from: '2: \'Warship\'', to: '2: \'Cruiser\'', fails: ['rule', 'plants'] },
  { name: 'the second survey function is not named', target: 'commanders', from: '7: \'Survey Ship\'', to: '7: \'Survey\'', fails: ['rule'] },
  { name: 'a function the game does not name has no number', target: 'commanders', from: '`Function ${code}`', to: '\'Function\'', fails: ['rule'] },
  { name: 'the better assignments leave the light naval rows out', target: 'commanders', from: 'governors.rows.length + ships.rows.length + research.rows.length + light.rows.length', to: 'governors.rows.length + ships.rows.length + research.rows.length', fails: ['rule'] },
  { name: 'the ships that cannot be rated leave the light naval ones out', target: 'commanders', from: 'governors.unrated.length + ships.unrated.length + research.unrated.length + light.unrated.length', to: 'governors.unrated.length + ships.unrated.length + research.unrated.length', fails: ['rule'] },
  { name: 'the specialist view keeps the ships declared light naval', target: 'page', from: 'return this.ships.filter((ship) => isLightNavalPost(ship) === false)', to: 'return this.ships.filter((ship) => true)', fails: ['plants'] },
  { name: 'the specialist view leaves out the ships that may be light naval and cannot be told', target: 'page', from: 'return this.ships.filter((ship) => isLightNavalPost(ship) === false)', to: 'return this.ships.filter((ship) => isLightNavalPost(ship) !== true)', fails: ['plants'] },
  { name: 'the light naval view leaves out the ships that cannot be told', target: 'page', from: 'return this.lightShips.filter((ship) => isLightNavalPost(ship) !== false)', to: 'return this.lightShips.filter((ship) => isLightNavalPost(ship) === true)', fails: ['plants'] },
  { name: 'the light naval view takes every ship the read gives', target: 'page', from: 'return this.lightShips.filter((ship) => isLightNavalPost(ship) !== false)', to: 'return this.lightShips', fails: ['plants'] },
  { name: 'the specialist ships are ranked from the whole read', target: 'page', from: 'return shipSuggestions(this.specialistShips, this.byType[0], this.bonusNames, this.blockedBonuses)', to: 'return shipSuggestions(this.ships, this.byType[0], this.bonusNames, this.blockedBonuses)', fails: ['plants'] },
  { name: 'the light naval ships are ranked from the specialist ships', target: 'page', from: 'return shipSuggestions(this.lightNavalShips, this.byType[0], this.bonusNames, this.blockedBonuses)', to: 'return shipSuggestions(this.specialistShips, this.byType[0], this.bonusNames, this.blockedBonuses)', fails: ['fixture', 'plants'] },
  { name: 'the light naval view shows the specialist rows', target: 'page', from: 'return this.suggestionView === \'lightNaval\' ? this.lightRows : this.shipRows', to: 'return this.shipRows', fails: ['fixture'] },
  { name: 'the light naval view shows the specialist ships that cannot be rated', target: 'page', from: 'return this.suggestionView === \'lightNaval\' ? this.lightAssessment : this.shipAssessment', to: 'return this.shipAssessment', fails: ['fixture'] },
  { name: 'the light naval read takes another function', target: 'page', from: '(FCT_ShipClass.MainFunction = 3 or FCT_ShipClass.MainFunction is null', to: '(FCT_ShipClass.MainFunction = 2 or FCT_ShipClass.MainFunction is null', fails: ['fixture', 'plants', ...WITNESS] },
  { name: 'the light naval read leaves the officers flag out', target: 'page', from: 'FCT_ShipClass.NoOfficers, (select FCT_Commander.CommanderID from VIR_ShipCommanders', to: 'null as NoOfficers, (select FCT_Commander.CommanderID from VIR_ShipCommanders', fails: ['fixture', 'plants'] },
  { name: 'the light naval read leaves the size out', target: 'page', from: 'limit 1) as CaptainID, FCT_ShipClass.Size as ClassSize from FCT_Ship', to: 'limit 1) as CaptainID, null as ClassSize from FCT_Ship', fails: ['fixture', 'plants'] },
  { name: 'the light naval read takes the captain of another post', target: 'page', from: 'and Deceased = 0 and CommandType = 1 order by rowid) select', to: 'and Deceased = 0 and CommandType = 10 order by rowid) select', fails: ['fixture'] },
  { name: 'the tile leaves the light naval rows out', target: 'page', from: 'bonusSuggestionCount(this.governorAssessment, this.shipAssessment, this.researchAssessment, this.lightAssessment)', to: 'bonusSuggestionCount(this.governorAssessment, this.shipAssessment, this.researchAssessment)', fails: ['fixture'] },
  { name: 'the tile note leaves the light naval ships out', target: 'page', from: ', ${this.count(this.lightRows.length)} light naval ships', to: '', fails: ['fixture'] },
  { name: 'the declared function is shown as its number', target: 'page', from: 'return declared ? declared.label : \'\'', to: 'return declared ? `Function ${declared.code}` : \'\'', fails: ['plants'] },
  { name: 'the post cell does not show a declared function', target: 'page', from: '<span v-if="declaredText(item.ship)"> (declared as {{ declaredText(item.ship) }})</span>', to: '', fails: ['plants'] },
  { name: 'the post cell shows a declared function for every ship', target: 'page', from: '<span v-if="declaredText(item.ship)"> (declared as', to: '<span> (declared as', fails: ['plants'] },
  { name: 'the empty light naval view says nothing of officers', target: 'page', from: 'No ship of a light naval class that has officers.', to: 'No ship.', fails: ['plants'] },
  { name: 'the page does not restore the light naval view', target: 'page', from: 'valid: oneOf([\'governors\', \'ships\', \'lightNaval\', \'research\'])', to: 'valid: oneOf([\'governors\', \'ships\', \'research\'])', fails: ['text'] },
  { name: 'the toggle does not name the view', target: 'page', from: 'Light naval ships ({{ lightRows.length }})', to: 'Lights ({{ lightRows.length }})', fails: ['text'] },
  { name: 'the light naval foot does not open with its purpose', target: 'page', from: 'Use it to check why an officer is suggested for a light naval ship.', to: 'Why an officer is suggested for a light naval ship.', fails: ['text'] },
  { name: 'the light naval foot speaks of the reader', target: 'page', from: 'Use it to check why an officer is suggested for a light naval ship.', to: 'Use it to check why we suggest an officer for a light naval ship.', fails: ['text'] },
  { name: 'the light naval foot leaves out how the game chooses the function', target: 'page', from: 'The game works that function out from the class\'s size, armament and sensors, as Light Naval for an armed class of 20 hull spaces or fewer, unless the player declared it, so a stored Light Naval function on a larger class counts only when it was declared.', to: '', fails: ['text'] },
  { name: 'the light naval foot ranks the captain by half', target: 'page', from: 'The captain is ranked by the Light Tactical bonus, as the game orders its assignments for that function', to: 'The captain is ranked by half the Light Tactical bonus, as the game orders its assignments for that function', fails: ['text'] },
  { name: 'the specialist foot leaves out the declared function', target: 'page', from: ' A function the player declared for the class shows beside the post label as declared; the post follows the class\'s modules whatever it is declared as, except that a class declared Light Naval is a light naval ship and is listed under Light naval ships.', to: '', fails: ['text'] },
  { name: 'the page help leaves out the light naval view', target: 'glossary', from: 'Specialist ships, Light naval ships and Research', to: 'Specialist ships and Research', fails: ['text'] },
  { name: 'the rule note leaves out when a stored function counts', target: 'commanders', from: ' The game works the main function out from the class\\\'s size, armament and sensors unless the player declared it, so a stored Light Naval function counts for a class over 20 hull spaces only when it was declared.', to: '', fails: ['text'] },
  { name: 'Light Tactical is not a gated bonus of the page', target: 'capabilities', from: '39: Object.freeze({ name: \'Light Tactical\', percentage: true, routes: Object.freeze([\'/commanders\'])', to: '3900: Object.freeze({ name: \'Light Tactical\', percentage: true, routes: Object.freeze([\'/commanders\'])', fails: ['capability'] },
  { name: 'the registry declares the declaration column as read by another item', target: 'capabilities', from: 'export const DECLARED = Object.freeze([', to: 'export const DECLARED = Object.freeze([\n  Object.freeze({ item: \'AE-308-07\', readBy: \'AE-304-02\', table: \'FCT_ShipClass\', columns: Object.freeze([\'UserDefinedFunction\']) }),', fails: ['capability'] },
  { name: 'the light naval ships are an optional input of the page', target: 'capabilities', from: '(key) => key === \'navalTree\' || key === \'groundTree\'', to: '(key) => key === \'navalTree\' || key === \'groundTree\' || key === \'lightShips\'', fails: ['capability'] },
  { name: 'Tactical is not a gated bonus of the page', target: 'capabilities', from: '  21: Object.freeze({ name: \'Tactical\', percentage: true, routes: Object.freeze([\'/commanders\'])', to: '  2100: Object.freeze({ name: \'Tactical\', percentage: true, routes: Object.freeze([\'/commanders\'])', fails: ['capability'] },
  { name: 'a class with no stored main function is a light naval one', target: 'commanders', from: '  return named || fit === false ? fit : null', to: '  return fit', fails: ['rule', 'unnamed'] },
  { name: 'a class with no stored main function is not a light naval one', target: 'commanders', from: '  return named || fit === false ? fit : null', to: '  return named ? fit : false', fails: ['rule', 'unnamed'] },
  { name: 'a function the game does not name is taken for one it names', target: 'commanders', from: 'isKnownNumber(ship.MainFunction) && MAIN_FUNCTIONS[ship.MainFunction] !== undefined', to: 'isKnownNumber(ship.MainFunction)', fails: ['rule', 'unnamed'] },
  { name: 'the main function is not named where it decides', target: 'commanders', from: '  ...(namedFunction(ship) ? [] : [isKnownNumber', to: '  ...(true ? [] : [isKnownNumber', fails: ['rule', 'unnamed'] },
  { name: 'a function the game does not name is named without its number', target: 'commanders', from: ', stored as ${ship.MainFunction}, which the game does not name', to: '', fails: ['rule', 'unnamed'] },
  { name: 'a declared class over 20 hull spaces counts Light Tactical in full', target: 'commanders', from: 'post({ ...base, share: 0, combat: { bonusId: TACTICAL, label: \'Tactical\', share: 0.5 } })', to: 'post({ ...base, share: 1 })', fails: ['rule', 'combat'] },
  { name: 'a declared class over 20 hull spaces carries nothing in combat', target: 'commanders', from: 'post({ ...base, share: 0, combat: { bonusId: TACTICAL, label: \'Tactical\', share: 0.5 } })', to: 'post({ ...base, share: 0 })', fails: ['rule', 'combat'] },
  { name: 'a declared class over 20 hull spaces counts half of Light Tactical', target: 'commanders', from: 'post({ ...base, share: 0, combat:', to: 'post({ ...base, share: 0.5, combat:', fails: ['rule', 'combat'] },
  { name: 'a declared class over 20 hull spaces takes Light Tactical in combat', target: 'commanders', from: 'combat: { bonusId: TACTICAL, label: \'Tactical\', share: 0.5 }', to: 'combat: { bonusId: LIGHT_TACTICAL, label: \'Light Tactical\', share: 0.5 }', fails: ['rule', 'combat'] },
  { name: 'a declared class over 20 hull spaces takes all of Tactical in combat', target: 'commanders', from: 'share: 0, combat: { bonusId: TACTICAL, label: \'Tactical\', share: 0.5 }', to: 'share: 0, combat: { bonusId: TACTICAL, label: \'Tactical\', share: 1 }', fails: ['rule', 'combat'] },
  { name: 'a class of exactly 20 hull spaces carries Tactical in combat', target: 'commanders', from: 'const over = ship.ClassSize > LIGHT_NAVAL_SIZE', to: 'const over = ship.ClassSize >= LIGHT_NAVAL_SIZE', fails: ['rule', 'plants'] },
  { name: 'a class with no stored size counts Light Tactical in full', target: 'commanders', from: 'post({ ...base, share: null }, [', to: 'post({ ...base, share: 1 }, [', fails: ['rule', 'combat'] },
  { name: 'a class with no stored size does not name it', target: 'commanders', from: ', [`the size of the class of ${where}, which says whether Light Tactical counts in combat`])', to: ')', fails: ['rule', 'combat'] },
  { name: 'a blocked Tactical blocks the post', target: 'commanders', from: '...(blocked.has(value.bonusId) ? [', to: '...(blocked.has(value.bonusId) || (value.combat && blocked.has(value.combat.bonusId)) ? [', fails: ['rule', 'combat'] },
  { name: 'the rows carry no combat values', target: 'commanders', from: '      combat,\n      alsoBestFor: 0,', to: '      combat: null,\n      alsoBestFor: 0,', fails: ['rule', 'combat'] },
  { name: 'the holder\'s Tactical is read as the ranking\'s bonus', target: 'commanders', from: 'holder && !blocked.has(post.combat.bonusId) ? heldBonus(holder, post.combat.bonusId) : null', to: 'holder && !blocked.has(post.combat.bonusId) ? heldBonus(holder, post.bonusId) : null', fails: ['rule', 'combat'] },
  { name: 'the candidate\'s Tactical is read as the ranking\'s bonus', target: 'commanders', from: 'best && !blocked.has(post.combat.bonusId) ? heldBonus(best.officer, post.combat.bonusId) : null', to: 'best && !blocked.has(post.combat.bonusId) ? heldBonus(best.officer, post.bonusId) : null', fails: ['rule', 'combat'] },
  { name: 'the holder\'s Tactical is read whether the save confirms it or not', target: 'commanders', from: 'current: holder && !blocked.has(post.combat.bonusId) ?', to: 'current: holder ?', fails: ['rule', 'combat'] },
  { name: 'the candidate\'s Tactical is read whether the save confirms it or not', target: 'commanders', from: 'candidate: best && !blocked.has(post.combat.bonusId) ?', to: 'candidate: best ?', fails: ['rule', 'combat'] },
  { name: 'the rows name no other post for their candidate', target: 'commanders', from: 'row.alsoBestFor = row.candidate ? rowsOf.get(row.candidate) - 1 : 0', to: 'row.alsoBestFor = 0', fails: ['rule', 'combat'] },
  { name: 'the rows count their own post among the others', target: 'commanders', from: 'rowsOf.get(row.candidate) - 1 : 0', to: 'rowsOf.get(row.candidate) : 0', fails: ['rule', 'combat'] },
  { name: 'the comment leaves out the assignment score member', target: 'commanders', from: 'the game ranks the captain of a ship by the bonus of its stored main function, Light Naval by Light Tactical, whatever the size; ', to: '', fails: ['text'] },
  { name: 'the comment leaves out the main function member', target: 'commanders', from: 'it chooses Light Naval only for a class of at most 20 hull spaces unless the player declared the function (`UserDefinedFunction`), and loads a class with the function only when it was not declared; ', to: '', fails: ['text'] },
  { name: 'the comment leaves out the tactical multiplier member', target: 'commanders', from: "in combat the ship's tactical multiplier takes the captain's Light Tactical for a ship of at most 20 hull spaces and ", to: '', fails: ['text'] },
  { name: 'the comment leaves out the half of Tactical member', target: 'commanders', from: "the captain's Tactical halved for a larger one, and ", to: '', fails: ['text'] },
  { name: 'the comment leaves out the Light Tactical limit member', target: 'commanders', from: ', and skips Light Tactical above 20 hull spaces', to: '', fails: ['text'] },
  { name: 'the comment leaves out what the ranking is not', target: 'commanders', from: ' So the ranking of a declared Light Naval class over 20 hull spaces by Light Tactical is the game\'s assignment order and not its effect in combat.', to: '', fails: ['text'] },
  { name: 'the rule note leaves out what counts in combat', target: 'commanders', from: ' That ranking is not the effect on the ship: in combat the ship\\\'s own tactical multiplier takes the captain\\\'s Light Tactical in full for a class of 20 hull spaces or less and half of the captain\\\'s Tactical for a larger one, so for a class declared Light Naval over 20 hull spaces Light Tactical counts for nothing in combat, and the post carries the Tactical bonus beside it.', to: '', fails: ['text'] },
  { name: 'the rule note leaves out a class with no stored main function', target: 'commanders', from: ' A class whose main function is not stored, or is one the game does not name, may be a light naval class and has no post, unless it has no officers or is not declared and over 20 hull spaces, which no function makes light naval.', to: '', fails: ['text'] },
  { name: 'the count\'s rule leaves out that it counts posts', target: 'commanders', from: ' Each counts a post, and one officer can be the best candidate of many posts, so the count is of posts that an officer would improve and is neither a number of officers nor an allocation.', to: '', fails: ['text', 'rule'] },
  { name: 'the light naval read leaves out the classes with no stored main function', target: 'page', from: '(FCT_ShipClass.MainFunction = 3 or FCT_ShipClass.MainFunction is null or FCT_ShipClass.MainFunction not in (${parts.namedFunctions}))', to: '(FCT_ShipClass.MainFunction = 3 or FCT_ShipClass.MainFunction not in (${parts.namedFunctions}))', fails: ['unnamed'] },
  { name: 'the light naval read leaves out the classes with a function the game does not name', target: 'page', from: '(FCT_ShipClass.MainFunction = 3 or FCT_ShipClass.MainFunction is null or FCT_ShipClass.MainFunction not in (${parts.namedFunctions}))', to: '(FCT_ShipClass.MainFunction = 3 or FCT_ShipClass.MainFunction is null)', fails: ['unnamed'] },
  { name: 'the light naval read takes the ships of every function', target: 'page', from: 'FCT_ShipClass.MainFunction not in (${parts.namedFunctions})', to: 'FCT_ShipClass.MainFunction not in (3)', fails: ['fixture'] },
  { name: 'the list of the functions the game names leaves out the first', target: 'commanders', from: 'namedFunctions: Object.keys(MAIN_FUNCTIONS).join(\', \')', to: 'namedFunctions: Object.keys(MAIN_FUNCTIONS).slice(1).join(\', \')', fails: ['fixture'] },
  { name: 'the post cell does not say what the ranking is', target: 'page', from: '<div v-if="item.post.combat" class="caption warning--text">', to: '<div v-if="false" class="caption warning--text">', fails: ['combat'] },
  { name: 'the post cell does not say that the size is not stored', target: 'page', from: '<div v-else-if="item.post.share === null" class="caption warning--text">', to: '<div v-else-if="false" class="caption warning--text">', fails: ['combat'] },
  { name: 'the holder cell leaves out what counts in combat', target: 'page', from: '<div v-if="item.combat" class="caption text--secondary">In combat: {{ bonusText(item.combat.bonusId, item.combat.current) }}', to: '<div v-if="false" class="caption text--secondary">In combat: {{ bonusText(item.combat.bonusId, item.combat.current) }}', fails: ['combat'] },
  { name: 'the candidate cell leaves out what counts in combat', target: 'page', from: '<div v-if="item.combat" class="caption text--secondary">In combat: {{ bonusText(item.combat.bonusId, item.combat.candidate) }}', to: '<div v-if="false" class="caption text--secondary">In combat: {{ bonusText(item.combat.bonusId, item.combat.candidate) }}', fails: ['combat'] },
  { name: 'the candidate cell shows the holder\'s Tactical', target: 'page', from: 'bonusText(item.combat.bonusId, item.combat.candidate)', to: 'bonusText(item.combat.bonusId, item.combat.current)', fails: ['combat'] },
  { name: 'the holder cell shows the candidate\'s Tactical', target: 'page', from: 'bonusText(item.combat.bonusId, item.combat.current)', to: 'bonusText(item.combat.bonusId, item.combat.candidate)', fails: ['combat'] },
  { name: 'the candidate cell does not say that half of it counts', target: 'page', from: 'item.combat.candidate) }}, half of it counts', to: 'item.combat.candidate) }}', fails: ['combat'] },
  { name: 'the candidate cell leaves out the other posts', target: 'page', from: '<div v-if="item.alsoBestFor" class="caption text--secondary">', to: '<div v-if="false" class="caption text--secondary">', fails: ['combat'] },
  { name: 'the candidate cell names other posts for every row', target: 'page', from: '<div v-if="item.alsoBestFor" class="caption text--secondary">', to: '<div v-if="true" class="caption text--secondary">', fails: ['combat'] },
  { name: 'the candidate cell does not say that the posts are alternatives', target: 'page', from: ': alternatives for one officer, not an allocation</div>', to: '</div>', fails: ['combat'] },
  { name: 'the candidate cell says posts for one post', target: 'page', from: '{{ item.alsoBestFor === 1 ? \'post\' : \'posts\' }}', to: 'posts', fails: ['combat'] },
  { name: 'the candidate cell counts its own post', target: 'page', from: '{{ item.alsoBestFor }} other {{ item.alsoBestFor === 1 ? \'post\'', to: '{{ item.alsoBestFor + 1 }} other {{ item.alsoBestFor === 1 ? \'post\'', fails: ['combat'] },
  { name: 'the light naval foot leaves out what counts in combat', target: 'page', from: ' For a class of 20 hull spaces or fewer that bonus is also what the captain adds to the ship in combat, in full. For a declared class over 20 hull spaces it is not: the ship\'s tactical multiplier takes half of the captain\'s Tactical there and nothing of Light Tactical, so those rows show the Tactical bonus of the holder and the candidate beside the ranking, and a candidate with a better Light Tactical is not thereby better in combat.', to: '', fails: ['text'] },
  { name: 'the light naval foot leaves out that the rows are alternatives', target: 'page', from: ' Each row names the best unassigned officer for that post taken alone; one officer can be the best for many posts, and those rows are alternatives for that officer, not an allocation.', to: '', fails: ['text'] },
  { name: 'the specialist foot leaves out that the rows are alternatives', target: 'page', from: ' Each row names the best unassigned officer for that post taken alone; one officer can be the best for several posts, and those rows are alternatives for that officer, not an allocation.', to: '', fails: ['text'] },
  { name: 'the light naval foot leaves out a class with no stored main function', target: 'page', from: ' A ship whose class has no stored main function, or one the game does not name, may be light naval and is listed as one that cannot be rated, naming the function.', to: '', fails: ['text'] },
  { name: 'the specialist foot leaves out a class with no stored main function', target: 'page', from: ' A ship whose class has no stored main function may be light naval, so it is listed there as one that cannot be rated and not here.', to: '', fails: ['text'] },
  { name: 'the page help leaves out that the rows are alternatives', target: 'glossary', from: ' A row names the best unassigned officer for its post alone, so one officer can head many rows, which are alternatives and not an allocation.', to: '', fails: ['text'] },
  { name: 'the page help leaves out the combat effect', target: 'glossary', from: '; for a declared class over 20 hull spaces its combat effect takes half of the Tactical bonus instead, and the row shows both', to: '', fails: ['text'] },
]

// Rewrites that say the same thing: the limit with its operands swapped, the declared test with its operands swapped, a count written the other way round.
const BENIGN = [
  { name: 'the limit with its operands swapped', target: 'commanders', from: 'return ship.ClassSize <= LIGHT_NAVAL_SIZE ? true : declared === false ? false : null', to: 'return LIGHT_NAVAL_SIZE >= ship.ClassSize ? true : declared === false ? false : null' },
  { name: 'the declared test with its operands swapped', target: 'commanders', from: '  } else if (declared === true) {\n    return true', to: '  } else if (true === declared) {\n    return true' },
  { name: 'the count with its terms in another order', target: 'commanders', from: 'governors.rows.length + ships.rows.length + research.rows.length + light.rows.length', to: 'light.rows.length + research.rows.length + ships.rows.length + governors.rows.length' },
  { name: 'the unnamed test with its operands swapped', target: 'commanders', from: '  return named || fit === false ? fit : null', to: '  return fit === false || named ? fit : null' },
  { name: 'the share boundary with its operands swapped', target: 'commanders', from: 'const over = ship.ClassSize > LIGHT_NAVAL_SIZE', to: 'const over = LIGHT_NAVAL_SIZE < ship.ClassSize' },
  { name: 'the other posts counted by subtracting after the lookup in another order', target: 'commanders', from: 'rowsOf.get(row.candidate) - 1 : 0', to: '-1 + rowsOf.get(row.candidate) : 0' },
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
  console.log('NOTE  the light naval post, the limit of 20 hull spaces and the declared function are worked from the game\'s rules; no played 3.1 save is available, so the cases are planted on copies of the interim fixture and the figures are worked from the rules, not fixture-verified')

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
