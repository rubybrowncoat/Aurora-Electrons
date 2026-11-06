/*
  Checks the ship Senior CO setting in the rank reads of the Commanders page and the command structure export (utilities/commanders.js `captainRank` and `specialistPost`, `rosterParts`, the page's ships and roster reads, utilities/naval-hierarchy.js and utilities/hierarchy-export.js, the `seniorCO` soft group of utilities/capabilities.js).

  Run: bun scripts/check-ship-senior-co.js [--no-mutations]

  The rule is the game's (`Ship.method_47`: the rank a ship's captain must hold is the rank its class requires, one higher for a ship whose `ShipSeniorCO` is 1 and none at all when the class already requires the highest rank of its type; `Commander.PopulateAssignmentsListView` and `Race.AutoAssignCommanders` ask it for the captain and ask the class for every other post, which keep the class rank less the post's modifier). The class's own Senior CO option is already in the stored `FCT_ShipClass.RankRequired` (`ShipClass.method_87` adds it when the class is saved), so a flagged ship in such a class takes one rank more than the class stores and the class column is not read again. Every expected figure is written here from that rule and from the saved officers, never read from the module:
  - `rank`: the captain's rank level for an unflagged ship, a flagged one, a flag that is not 1, a class row that carries its own Senior CO column (no effect), a flag or class rank that is not stored (no rank, named), a flagged ship whose class holds the highest naval rank (no rank above it, named) or whose race's number of naval ranks is not stored, a flag the save does not hold at all (no rank, the flag unknown and the setting named), and the specialist post of a terraformer, miner, harvester and survey captain, while the science officer's post stays class-relative and is not moved by, or held back by, the flag;
  - `suggestions`: the candidates the specialist ship suggestions list for a ship with a captain and for a vacant one, at the captain's rank, the other ranks counted beside them, a flagged ship at the highest rank left unrated, and a ship whose save does not hold the flag left unrated rather than given the class rank;
  - `fixture`: on the interim 3.1 fixture (scripts/lib/fixtures.js, game 141, race 784) the rank level of each of the 1,100 serving captains equals the module's for its ship (1,074 unflagged, 26 flagged ships, all of classes with the Senior CO option, so a class-level option still has one more on top), and the executive, engineering, science, tactical and air group officers hold the class rank less their modifier whether the ship is flagged or not;
  - `page`: the page's own ships read and roster read, taken from its source and run on the fixture and on planted copies (the harvester class flagged, the survey class flagged, a class at the highest and next-to-highest rank flagged, the flag not stored, the column dropped) deliver the flag, the rank count, the post's level and the mark of the roster for each officer on a flagged ship, equal to the figures worked out here, and a copy without the column leaves every captain's post unavailable and named while the science officer's post and the roster stay, the executive officers keeping their ranks;
  - `export`: the command structure model marks the 26 flagged ships, the CSV holds a `Senior CO` column (yes, no, empty where it is not stored or not a ship) and the Markdown names them, on the fixture and on a copy with a flag of 2 and one not stored, and a copy without the column still gives the same tree and both exports, with every ship's flag unknown, and the panel says the mark is not shown and the captain's rank unknown;
  - `capability`: no declared column of FCT_Ship.ShipSeniorCO is left in the registry (the page reads it), the Commanders report holds the `seniorCO` group beside the ranks and ages, and a save that lacks the column degrades the report by that group alone and leaves the ranks, the ages and the roster;
  - `text`: the Commanders page draws the Senior CO mark of the ship, the one-rank-above note of the post and the mark of the roster's assignment, from the slots of its own template, and its footer states the rule, including that a save without the setting gives no captain rank.
  The fixture holds no flagged terraformer, miner, harvester or survey ship, a ship at the highest rank or a ship with no flag stored, so those cases are planted into in-memory copies (the precedent of scripts/check-light-naval.js); a saved case needs a game played under 3.1.

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

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
const { strictRecords } = require('./lib/csv-records')
const { FIXTURE } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const SAVE = FIXTURE.file
const GAME = FIXTURE.gameId
const RACE = FIXTURE.raceId
const IDS = { GameID: GAME, RaceID: RACE }
// The 13 naval ranks of the race (RankType 0), the lowest at level 1.
const NAVAL_RANKS = 13
// The class H50M Harvester (ten ships, class rank 3, no Senior CO option) and the class Intrepid (two survey ships with a Science Department, class rank 4, with the option).
const HARVESTER_CLASS = 63048
const SURVEY_CLASS = 63083

const FILES = {
  commanders: path.join(root, 'src', 'renderer', 'utilities', 'commanders.js'),
  navalHierarchy: path.join(root, 'src', 'renderer', 'utilities', 'naval-hierarchy.js'),
  hierarchyExport: path.join(root, 'src', 'renderer', 'utilities', 'hierarchy-export.js'),
  capabilities: path.join(root, 'src', 'renderer', 'utilities', 'capabilities.js'),
  commandersPage: path.join(root, 'src', 'renderer', 'pages', 'commanders.vue'),
}
const MODULES = { commanders: 'commanders', navalHierarchy: 'naval-hierarchy', hierarchyExport: 'hierarchy-export', capabilities: 'capabilities' }
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

// The packages the utilities import, as the least the checks need of them: no date or numeral is formatted here.
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

const worldOf = (texts = { ...ORIGINALS }) => ({
  texts,
  modules: memo(async () => {
    const loaded = await loadUtilities(Object.values(MODULES), { stubs: STUBS, sources: Object.fromEntries(Object.entries(MODULES).map(([target, name]) => [name, texts[target]])) })

    return Object.fromEntries(Object.entries(MODULES).map(([target, name]) => [target, loaded[name]]))
  }),
})

// ---- The fixture, as in-memory copies ------------------------------------------------------------------------------
const PLANTS = {
  intact: [],
  harvesters: [`update FCT_Ship set ShipSeniorCO = 1 where ShipClassID = ${HARVESTER_CLASS}`],
  survey: [`update FCT_Ship set ShipSeniorCO = 1 where ShipClassID = ${SURVEY_CLASS}`],
  highest: [`update FCT_ShipClass set RankRequired = ${NAVAL_RANKS} where ShipClassID = ${HARVESTER_CLASS}`, `update FCT_Ship set ShipSeniorCO = 1 where ShipClassID = ${HARVESTER_CLASS}`],
  nextToHighest: [`update FCT_ShipClass set RankRequired = ${NAVAL_RANKS - 1} where ShipClassID = ${HARVESTER_CLASS}`, `update FCT_Ship set ShipSeniorCO = 1 where ShipClassID = ${HARVESTER_CLASS}`],
  unstored: [`update FCT_Ship set ShipSeniorCO = null where ShipClassID = ${HARVESTER_CLASS}`],
  odd: [`update FCT_Ship set ShipSeniorCO = 2 where ShipID = (select min(ShipID) from FCT_Ship where ShipClassID = ${HARVESTER_CLASS})`, `update FCT_Ship set ShipSeniorCO = null where ShipID = (select max(ShipID) from FCT_Ship where ShipClassID = ${HARVESTER_CLASS})`],
  dropped: ['alter table FCT_Ship drop column ShipSeniorCO'],
}
let BYTES = null
const COPIES = new Map()

// The saved bytes once, and a copy of them with the statements of one plant run on it, made in memory so that no file is written.
const copyOf = (name) => {
  if (!PLANTS[name]) {
    throw new Error(`no planted copy named ${name}`)
  }

  if (!COPIES.has(name)) {
    BYTES = BYTES || fs.readFileSync(path.join(root, SAVE))

    const database = Database.deserialize(BYTES)

    PLANTS[name].forEach((statement) => database.run(statement))
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
// The serving officers of the ship posts with the rank level of each (1 is the lowest naval rank), the ship's stored flag and the rank its class stores. A commander is serving while retire status and prisoner are 0.
const officersOf = (database) => database.query(`select FCT_Commander.CommanderID, FCT_Commander.CommandType, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.ShipSeniorCO, FCT_ShipClass.ClassName, FCT_ShipClass.RankRequired, FCT_ShipClass.SeniorCO as ClassSeniorCO,
  (select max(VIR_Rank.Priority) from FCT_Ranks as VIR_Rank where VIR_Rank.GameID = ${GAME} and VIR_Rank.RaceID = ${RACE} and VIR_Rank.RankType = 0) - FCT_Ranks.Priority + 1 as Level
from FCT_Commander
inner join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID
inner join FCT_Ship on FCT_Ship.ShipID = FCT_Commander.CommandID
inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID
where FCT_Commander.GameID = ${GAME} and FCT_Commander.RaceID = ${RACE} and FCT_Commander.RetireStatus = 0 and FCT_Commander.Prisoner = 0 and FCT_Commander.CommandType in (1, 8, 9, 10, 11, 15)
order by FCT_Commander.CommanderID`).all()

// The class-relative modifier of each department post (`class rank less this`), as the fixture's officers hold them: executive officer 1, chief engineer 2, science officer 1, tactical officer 2, air group commander 1.
const MODIFIERS = { 8: 1, 9: 2, 10: 1, 11: 2, 15: 1 }

// The officers on a flagged ship of a copy, by SQL written here.
const flaggedOfficers = (database) => database.query(`select FCT_Commander.CommanderID from FCT_Commander inner join FCT_Ship on FCT_Ship.ShipID = FCT_Commander.CommandID where FCT_Commander.GameID = ${GAME} and FCT_Commander.RaceID = ${RACE} and FCT_Commander.RetireStatus = 0 and FCT_Commander.Prisoner = 0 and FCT_Commander.CommandType in (1, 8, 9, 10, 11, 15) and FCT_Ship.ShipSeniorCO = 1 order by FCT_Commander.CommanderID`).all().map((row) => row.CommanderID)

// ---- The page's own reads, from its source ---------------------------------------------------------------------------
// The template literal of the query after `header` in the page's script, with each placeholder filled from `values` (a placeholder the check cannot fill is the check's defect).
const queryOf = (text, header, values) => {
  const from = text.indexOf(header)
  const open = text.indexOf('this.database.query(`', from) + 'this.database.query(`'.length
  const close = text.indexOf('`).then(([items])', open)

  if (from < 0 || open < from || close < open) {
    throw new Error(`the Commanders page's read ${header.trim()} is not where the check looks for it`)
  }

  return text.slice(open, close).replace(/\$\{([^}]+)\}/g, (_match, name) => {
    if (!(name in values)) {
      throw new Error(`the Commanders page's read has a placeholder the check cannot fill: ${name}`)
    }

    return String(values[name])
  })
}

const SHIPS_HEADER = '    ships: {\n      get: tracked(\'ships\''
const ROSTER_HEADER = '    commanders: {\n      get: tracked(\'commanders\''

const partsValues = (c, groups) => Object.fromEntries([...Object.entries(c.rosterParts(groups, IDS)).map(([name, sql]) => [`parts.${name}`, sql]), ['this.GameID', GAME], ['this.RaceID', RACE], ['SERVING_COMMANDER', c.SERVING_COMMANDER]])

const shipRows = (text, c, database, groups = null) => database.query(queryOf(text, SHIPS_HEADER, partsValues(c, groups))).all()

const rosterRows = (text, c, database, groups = null) => database.query(queryOf(text, ROSTER_HEADER, partsValues(c, groups))).all()

// ---- Rows the pure cases are built from --------------------------------------------------------------------------------
const baseShip = (overrides = {}) => ({ ShipID: 1, ShipName: 'Scout One', ClassName: 'Scout', MainFunction: 2, RankRequired: 3, ShipSeniorCO: 0, NavalRanks: NAVAL_RANKS, ClassSize: 10, Terraformers: 0, MiningModules: 0, Harvesters: 20, SciencePosts: 0, GeoSurvey: 0, GravSurvey: 0, CaptainID: 0, ScienceOfficerID: 0, ...overrides })

const value = (result) => (result && result.status !== 'unavailable' ? result.value : null)
const missing = (result) => (result && result.status === 'unavailable' ? result.inputs.missing : [])

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('rank', 'the captain\'s rank is the class rank, one higher for a flagged ship, only for a flag of exactly 1 and never read again from the class\'s own option, a flag or class rank that is not stored or a flagged ship at the highest rank gives no rank and says what is missing, a save that does not store the flag gives no captain rank either with the flag unknown and the setting named, the specialist posts follow it and the science officer\'s post stays class-relative', async (w) => {
  const { commanders: c } = await w.modules()
  const rank = (overrides) => c.captainRank(baseShip(overrides))
  const absent = 'the Senior CO setting of Scout One'

  assert.deepEqual(rank(), { level: 3, flagged: false, missing: [] }, 'an unflagged ship\'s captain holds the rank its class stores')
  assert.deepEqual(rank({ ShipSeniorCO: 1 }), { level: 4, flagged: true, missing: [] }, 'a flagged ship\'s captain holds one rank above it')
  assert.equal(rank({ ShipSeniorCO: 2 }).level, 3, 'a flag of 2 is not Senior CO: the game tests for exactly 1')
  assert.equal(rank({ ShipSeniorCO: 2 }).flagged, false, 'and is not marked flagged')
  assert.equal(rank({ SeniorCO: 1 }).level, 3, 'a class that carries the Senior CO option adds nothing to the stored rank, which already has it')
  assert.equal(rank({ SeniorCO: 1, ShipSeniorCO: 1 }).level, 4, 'a flagged ship of a class with the option takes one rank more than the class stores, not two')
  assert.equal(rank({ RankRequired: 1, ShipSeniorCO: 1 }).level, 2, 'the lowest class rank, flagged, is the second rank')
  assert.equal(rank({ RankRequired: NAVAL_RANKS - 1, ShipSeniorCO: 1 }).level, NAVAL_RANKS, 'the rank next to the highest, flagged, is the highest')

  for (const flag of [null, undefined, NaN, '', {}]) {
    const result = rank({ ShipSeniorCO: flag })

    assert.equal(result.level, null, `a flag of ${JSON.stringify(flag)} is not stored, so the rank is unknown, never an unflagged ship's (${result.level})`)
    assert.ok(result.missing.some((text) => /the Senior CO setting of Scout One/.test(text)), `it names the setting: ${result.missing.join(' | ')}`)
  }

  for (const stored of [null, undefined, NaN, 'three']) {
    const result = rank({ RankRequired: stored })

    assert.equal(result.level, null, `a class rank of ${JSON.stringify(stored)} gives no rank (${result.level})`)
    assert.ok(result.missing.some((text) => /the rank the class requires of Scout/.test(text)), `it names the class rank: ${result.missing.join(' | ')}`)
  }

  const top = rank({ RankRequired: NAVAL_RANKS, ShipSeniorCO: 1 })

  assert.equal(top.level, null, `a flagged ship whose class holds the highest naval rank has no rank above it, so no rank (${top.level})`)
  assert.ok(top.missing.some((text) => /a naval rank above the rank the class requires of Scout/.test(text)), `it says there is no rank above: ${top.missing.join(' | ')}`)
  assert.equal(rank({ RankRequired: NAVAL_RANKS }).level, NAVAL_RANKS, 'the same class unflagged holds the highest rank')

  for (const ranks of [null, undefined, NaN]) {
    const result = rank({ ShipSeniorCO: 1, NavalRanks: ranks })

    assert.equal(result.level, null, `a flagged ship with ${JSON.stringify(ranks)} naval ranks stored has no rank, as it cannot tell whether one exists above (${result.level})`)
    assert.deepEqual(result.missing, ['the naval ranks of the race'], 'it names the number of naval ranks')
  }

  assert.equal(rank({ ShipSeniorCO: 0, NavalRanks: null }).level, 3, 'an unflagged ship needs no count of the ranks')

  const unread = rank({ ShipSeniorCO: null })

  assert.deepEqual(unread, { level: null, flagged: null, missing: [absent] }, 'a save that does not store the flag gives no captain rank: the flag could have been 1, so the rank is not the class\'s')
  assert.deepEqual(rank({ ShipSeniorCO: null, RankRequired: null }), { level: null, flagged: null, missing: ['the rank the class requires of Scout', absent] }, 'a save without the flag and the class rank names both')

  const post = (overrides, blocked) => c.specialistPost(baseShip(overrides), blocked)
  const harvester = post({})
  const flagged = post({ ShipSeniorCO: 1 })

  assert.deepEqual([harvester.value.post, harvester.value.bonusId, harvester.value.level, harvester.value.seniorCO], ['captain', c.MINING, 3, false], 'the harvester\'s captain post at the class rank')
  assert.deepEqual([flagged.value.post, flagged.value.bonusId, flagged.value.level, flagged.value.seniorCO], ['captain', c.MINING, 4, true], 'the flagged harvester\'s captain post one rank up, marked')

  for (const [label, extra, bonus] of [['miner', { Harvesters: 0, MiningModules: 3 }, c.MINING], ['terraformer', { Harvesters: 0, Terraformers: 2 }, c.TERRAFORMING], ['survey captain', { Harvesters: 0, GeoSurvey: 2, ClassSize: 10 }, c.SURVEY]]) {
    assert.deepEqual([post(extra).value.level, post(extra).value.bonusId], [3, bonus], `the ${label} at the class rank`)
    assert.deepEqual([post({ ...extra, ShipSeniorCO: 1 }).value.level, post({ ...extra, ShipSeniorCO: 1 }).value.seniorCO], [4, true], `the flagged ${label} one rank up`)
  }

  const science = { Harvesters: 0, SciencePosts: 1, GeoSurvey: 2 }

  for (const flag of [0, 1, null]) {
    const result = post({ ...science, ShipSeniorCO: flag })

    assert.deepEqual([result.status !== 'unavailable' && result.value.post, result.status !== 'unavailable' && result.value.level, result.status !== 'unavailable' && result.value.seniorCO], ['science', 2, false], `the science officer of a ship with the flag ${flag} stays at the class rank less one, unmoved and not marked`)
  }

  assert.equal(post({ ...science, RankRequired: 1, ShipSeniorCO: 1 }).value.level, 1, 'the science officer of the lowest class rank stays at the lowest rank')
  const unreadPost = post({ ShipSeniorCO: null })

  assert.equal(unreadPost.status, 'unavailable', 'a ship whose save does not store the flag has no captain rank, so its captain\'s post is unavailable')
  assert.deepEqual(missing(unreadPost), [absent], 'naming the setting it would have read')
  assert.equal(post({ ShipSeniorCO: null, RankRequired: NAVAL_RANKS }).status, 'unavailable', 'a save without the flag cannot ask for a rank above the highest either: the rank stays unknown, never the stored class rank')
  assert.equal(post({ ...science, ShipSeniorCO: null }).value.level, 2, 'while the science officer\'s post of the same ship stays at the class rank less one')
  assert.equal(post({ RankRequired: NAVAL_RANKS, ShipSeniorCO: 1 }).status, 'unavailable', 'a flagged captain\'s post at the highest class rank is unavailable')
  assert.equal(post({ ...science, RankRequired: NAVAL_RANKS, ShipSeniorCO: 1 }).value.level, NAVAL_RANKS - 1, 'while the science officer of that class is at the rank below')
  assert.ok(missing(post({ ShipSeniorCO: 1 }, new Set([c.MINING]))).some((text) => /bonus 6/.test(text)), 'a blocked bonus still leaves the post unavailable')
})

check('suggestions', 'the officers the specialist ship suggestions list for a ship are of the captain\'s rank, so a flagged ship takes the candidate one rank above the class\'s, a ship with a captain and a vacant one alike, the others counted beside, a flagged ship at the highest rank is left unrated, and a ship whose save does not hold the flag is left unrated rather than offered an officer of the class rank', async (w) => {
  const { commanders: c } = await w.modules()
  const idle = (id, level, bonus, name) => ({ CommanderID: id, Name: name, CommanderType: 0, CommandType: 0, RankLevel: level, bonuses: { [c.MINING]: bonus } })
  const officers = [idle(10, 3, 1.3, 'Third'), idle(11, 4, 1.25, 'Fourth'), idle(12, 5, 1.1, 'Fifth'), { CommanderID: 90, Name: 'Serving', CommanderType: 0, CommandType: 1, RankLevel: 3, bonuses: { [c.MINING]: 1 } }]
  const listed = (ship) => c.shipSuggestions([ship], officers).rows[0]

  const vacant = listed(baseShip())
  const vacantFlagged = listed(baseShip({ ShipSeniorCO: 1 }))
  const served = listed(baseShip({ CaptainID: 90 }))
  const servedFlagged = listed(baseShip({ CaptainID: 90, ShipSeniorCO: 1 }))

  assert.equal(vacant.candidate.CommanderID, 10, 'a vacant ship of class rank 3 takes the officer of level 3')
  assert.equal(vacant.otherRanks, 2, 'and counts the officers of levels 4 and 5 beside, who have the better bonus than the neutral 1 and are at other ranks')
  assert.equal(vacantFlagged.candidate.CommanderID, 11, 'the same ship flagged takes the officer of level 4')
  assert.equal(vacantFlagged.otherRanks, 2, 'and counts the officers of levels 3 and 5 beside')
  assert.equal(vacantFlagged.post.level, 4, 'its post says level 4')
  assert.equal(served.candidate.CommanderID, 10, 'a ship with a captain of bonus 1 takes the better officer of its rank, level 3')
  assert.equal(servedFlagged.candidate.CommanderID, 11, 'the flagged ship with a captain takes the officer of level 4')
  assert.equal(servedFlagged.holder.CommanderID, 90, 'the serving captain is the holder')

  const science = listed(baseShip({ Harvesters: 0, SciencePosts: 1, GeoSurvey: 2, ShipSeniorCO: 1, ScienceOfficerID: 0 }))

  assert.ok(!science || science.post.level === 2, 'a science post is never raised by the flag')

  const top = c.shipSuggestions([baseShip({ RankRequired: NAVAL_RANKS, ShipSeniorCO: 1 })], officers)

  assert.equal(top.rows.length, 0, 'a flagged ship at the highest class rank lists no candidate')
  assert.equal(top.unrated.length, 1, 'and is left unrated')
  assert.ok(top.unrated[0].result.inputs.missing.some((text) => /a naval rank above the rank the class requires/.test(text)), 'saying that no rank is above')

  const unknownFlag = c.shipSuggestions([baseShip({ ShipSeniorCO: null })], officers)

  assert.equal(unknownFlag.rows.length, 0, 'a ship whose save does not hold the flag lists no candidate: the class rank is not its captain\'s')
  assert.equal(unknownFlag.unrated.length, 1, 'and is left unrated')
  assert.ok(missing(unknownFlag.unrated[0].result).some((text) => /the Senior CO setting of Scout One/.test(text)), 'naming the setting it would have read')
})

check('fixture', 'on the fixture the rank level of each of the 1,100 serving captains equals the module\'s for its ship (1,074 unflagged, 26 flagged, all of classes with the Senior CO option), a class-level option is in the stored rank with one more for the flag, and the executive, engineering, science, tactical and air group officers hold the class rank less their modifier, flagged ship or not', async (w) => {
  const { commanders: c } = await w.modules()
  const database = copyOf('intact')
  const officers = officersOf(database)
  const captains = officers.filter((row) => row.CommandType === 1)
  const ranksStored = database.query(`select count(*) as N from FCT_Ranks where GameID = ${GAME} and RaceID = ${RACE} and RankType = 0`).get().N

  assert.equal(ranksStored, NAVAL_RANKS, 'the race holds 13 naval ranks')
  assert.equal(captains.length, 1100, 'the fixture has 1,100 serving captains')
  assert.equal(captains.filter((row) => row.ShipSeniorCO === 1).length, 26, 'on 26 flagged ships')
  assert.equal(captains.filter((row) => row.ShipSeniorCO === 0).length, 1074, 'and 1,074 unflagged ones')
  assert.ok(captains.filter((row) => row.ShipSeniorCO === 1).every((row) => row.ClassSeniorCO === 1), 'every flagged ship is of a class with the Senior CO option')
  assert.equal(captains.filter((row) => row.ShipSeniorCO === 0 && row.ClassSeniorCO === 1).length, 135, 'while 135 unflagged captains serve in such classes')

  for (const row of captains) {
    const result = c.captainRank({ ShipID: row.ShipID, ShipName: row.ShipName, ClassName: row.ClassName, RankRequired: row.RankRequired, ShipSeniorCO: row.ShipSeniorCO, NavalRanks: ranksStored })

    assert.equal(result.level, row.Level, `${row.ShipName} (${row.ClassName}, class rank ${row.RankRequired}, flag ${row.ShipSeniorCO}): its captain holds level ${row.Level}, the module gives ${result.level}`)
  }

  assert.ok(captains.filter((row) => row.ShipSeniorCO === 0 && row.ClassSeniorCO === 1).every((row) => row.Level === row.RankRequired), 'the class\'s own option is in the stored rank: its unflagged captains hold exactly the stored rank')
  assert.ok(captains.filter((row) => row.ShipSeniorCO === 1).every((row) => row.Level === row.RankRequired + 1), 'a flagged ship in such a class holds one rank more than the class stores')

  const departments = officers.filter((row) => row.CommandType !== 1)

  assert.equal(departments.length, 231 + 455 + 2 + 267 + 10, 'the fixture has 965 serving department officers on ships: 231 executive, 455 engineering, 2 science, 267 tactical and 10 air group')

  for (const row of departments) {
    assert.equal(row.Level, row.RankRequired - MODIFIERS[row.CommandType], `${row.ShipName}: the officer of post ${row.CommandType} holds the class rank ${row.RankRequired} less ${MODIFIERS[row.CommandType]}, flagged (${row.ShipSeniorCO}) or not, not level ${row.Level}`)
  }

  assert.ok(departments.some((row) => row.CommandType === 8 && row.ShipSeniorCO === 1), 'executive officers of flagged ships are among them')

  for (const row of departments.filter((one) => one.CommandType === 10)) {
    const post = c.specialistPost(baseShip({ ShipID: row.ShipID, ShipName: row.ShipName, ClassName: row.ClassName, RankRequired: row.RankRequired, ShipSeniorCO: row.ShipSeniorCO, Harvesters: 0, SciencePosts: 1 }))

    assert.equal(value(post).level, row.Level, `${row.ShipName}: the science officer holds level ${row.Level}, the module's post is ${value(post) && value(post).level}`)
  }
})

check('page', 'the page\'s own ships and roster reads, run on the fixture and on planted copies, deliver the flag, the naval rank count, the captain\'s level and the roster mark of each officer on a flagged ship as worked out here, a flag not stored or a column the save lacks leaving the captain\'s post unavailable and named, the science post and the roster still read and the executive officers keeping their ranks, a flagged ship at the highest class rank unrated and the one below it listed', async (w) => {
  const { commanders: c } = await w.modules()
  const text = w.texts.commandersPage
  const levels = (rows) => rows.map((row) => [row.ShipID, value(c.specialistPost(row)) && value(c.specialistPost(row)).level])

  const intact = shipRows(text, c, copyOf('intact'))

  assert.equal(intact.length, 12, 'the page reads the ten harvesters and the two survey ships')
  assert.ok(intact.every((row) => row.ShipSeniorCO === 0 && row.NavalRanks === NAVAL_RANKS), 'as saved none is flagged and the page delivers the 13 naval ranks')

  intact.forEach((row) => {
    const post = value(c.specialistPost(row))

    assert.equal(post.level, 3, `${row.ShipName}: as saved the post is at level 3, the harvesters' class rank and the survey ships' science officer one below their class rank of 4`)
    assert.equal(post.seniorCO, false, `${row.ShipName}: no flag, no mark`)
  })

  const planted = shipRows(text, c, copyOf('harvesters'))
  const harvesters = planted.filter((row) => row.ClassName === 'H50M Harvester')

  assert.equal(harvesters.length, 10, 'the page reads the ten flagged harvesters')
  assert.ok(harvesters.every((row) => row.ShipSeniorCO === 1), 'each with its flag')
  assert.deepEqual(harvesters.map((row) => value(c.specialistPost(row)).level), Array(10).fill(4), 'the flagged harvesters\' captains are at level 4, the class rank 3 and one more')
  assert.ok(harvesters.every((row) => value(c.specialistPost(row)).seniorCO === true), 'and each is marked')
  assert.deepEqual(planted.filter((row) => row.ClassName === 'Intrepid').map((row) => value(c.specialistPost(row)).level), [3, 3], 'the survey ships, unflagged, are as before')

  const flaggedSurvey = shipRows(text, c, copyOf('survey')).filter((row) => row.ClassName === 'Intrepid')

  assert.equal(flaggedSurvey.length, 2, 'the two survey ships')
  assert.ok(flaggedSurvey.every((row) => row.ShipSeniorCO === 1), 'flagged in the copy')
  assert.deepEqual(flaggedSurvey.map((row) => { const post = value(c.specialistPost(row)); return [post.post, post.level, post.seniorCO] }), [['science', 3, false], ['science', 3, false]], 'the class has a Science Department, so the science officer\'s post stays at the class rank less one, unmarked')

  const captains = flaggedSurvey.map((row) => value(c.specialistPost({ ...row, SciencePosts: 0 })))

  assert.deepEqual(captains.map((post) => [post.post, post.level, post.seniorCO]), [['captain', 5, true], ['captain', 5, true]], 'the same ships without the department would have a captain at 5: the class option already in the stored 4, and one more for the flag')

  const highest = shipRows(text, c, copyOf('highest')).filter((row) => row.ClassName === 'H50M Harvester')

  assert.ok(highest.every((row) => row.RankRequired === NAVAL_RANKS && row.ShipSeniorCO === 1 && row.NavalRanks === NAVAL_RANKS), 'the copy\'s harvesters are flagged at the highest class rank')
  assert.ok(highest.every((row) => c.specialistPost(row).status === 'unavailable'), 'a flagged ship at the highest class rank has no post')
  assert.ok(highest.every((row) => missing(c.specialistPost(row)).some((entry) => /a naval rank above/.test(entry))), 'and says no rank is above')

  const next = shipRows(text, c, copyOf('nextToHighest')).filter((row) => row.ClassName === 'H50M Harvester')

  assert.deepEqual(next.map((row) => value(c.specialistPost(row)) && value(c.specialistPost(row)).level), Array(10).fill(NAVAL_RANKS), 'a flagged ship one rank below the highest takes the highest')

  const unstored = shipRows(text, c, copyOf('unstored')).filter((row) => row.ClassName === 'H50M Harvester')

  assert.ok(unstored.every((row) => row.ShipSeniorCO === null && c.specialistPost(row).status === 'unavailable'), 'a flag the save does not store gives no post, never an unflagged one')
  assert.ok(unstored.every((row) => missing(c.specialistPost(row)).some((entry) => /the Senior CO setting of/.test(entry))), 'and names it')

  const odd = shipRows(text, c, copyOf('odd')).filter((row) => row.ClassName === 'H50M Harvester').sort((a, b) => a.ShipID - b.ShipID)

  assert.equal(value(c.specialistPost(odd[0])).level, 3, 'a flag of 2 leaves the post at the class rank')
  assert.equal(c.specialistPost(odd[odd.length - 1]).status, 'unavailable', 'a flag that is null among the others is unavailable')
  assert.equal(levels(odd).filter(([, level]) => level === 3).length, 9, 'the flag of 2 and the eight unflagged harvesters are at the class rank, the one with no flag stored has none')

  const groups = { rank: true, age: true, seniorCO: false }
  const droppedShips = shipRows(text, c, copyOf('dropped'), groups)
  const without = droppedShips.filter((row) => row.ClassName === 'H50M Harvester')

  assert.equal(without.length, 10, 'a save without the column still gives the page its ships')
  assert.ok(without.every((row) => row.ShipSeniorCO === null && row.RankRequired === 3), 'with the flag null and the class rank still read')
  assert.ok(without.every((row) => c.specialistPost(row).status === 'unavailable'), 'a save without the column gives no captain rank: the flag could have raised it by one, so each captain\'s post is unavailable')
  assert.ok(without.every((row) => missing(c.specialistPost(row)).some((entry) => /the Senior CO setting of/.test(entry))), 'naming the setting it would have read')

  const surveyWithout = droppedShips.filter((row) => row.ClassName === 'Intrepid')

  assert.deepEqual(surveyWithout.map((row) => {
    const post = value(c.specialistPost(row))

    return [post.post, post.level, post.seniorCO]
  }), [['science', 3, false], ['science', 3, false]], 'while the science officers\' posts of the survey ships stay at the class rank less one, unmarked')

  const roster = rosterRows(text, c, copyOf('intact'))
  const flaggedIds = flaggedOfficers(copyOf('intact'))

  assert.equal(flaggedIds.length, 105, 'the saved officers on flagged ships are 105')
  assert.deepEqual(roster.filter((row) => row.AssignmentSeniorCO === 1).map((row) => row.CommanderID).sort((a, b) => a - b), flaggedIds, 'the roster marks exactly the officers serving on flagged ships')
  assert.ok(roster.filter((row) => row.AssignmentSeniorCO !== 1).every((row) => row.AssignmentSeniorCO === 0 || row.AssignmentSeniorCO === null), 'every other row holds no mark')
  assert.ok(roster.filter((row) => row.CommandType === 3).every((row) => row.AssignmentSeniorCO === null || row.AssignmentSeniorCO === undefined), 'a governor, on no ship, has no mark')

  const rosterFlagged = rosterRows(text, c, copyOf('harvesters'))
  const expected = flaggedOfficers(copyOf('harvesters'))

  assert.ok(expected.length > flaggedIds.length, 'the officers of the ten harvesters add to the saved ones in the copy')
  assert.deepEqual(rosterFlagged.filter((row) => row.AssignmentSeniorCO === 1).map((row) => row.CommanderID).sort((a, b) => a - b), expected, 'the roster of the copy marks them too')

  const rosterWithout = rosterRows(text, c, copyOf('dropped'), groups)

  assert.equal(rosterWithout.length, roster.length, 'a save without the column keeps the whole roster')
  assert.ok(rosterWithout.every((row) => row.AssignmentSeniorCO === null), 'with no mark')

  const executiveOf = (rows) => new Map(rows.filter((row) => row.CommandType === 8).map((row) => [row.CommanderID, row.RankLevel]))

  assert.deepEqual(executiveOf(rosterWithout), executiveOf(roster), 'and its executive officers keep their posts and the ranks they hold relative to their classes')
})

check('export', 'the command structure marks the 26 flagged ships of the fixture, its CSV holds a Senior CO column (yes, no, empty where it is not stored or the entry is no ship) and its Markdown names them, a flag of 2 is not Senior CO and a flag not stored is not no, and a copy without the column keeps the tree and both exports with every flag unknown and the panel stating that the captain\'s required rank is unknown', async (w) => {
  const { navalHierarchy: n, hierarchyExport: h } = await w.modules()
  const database = copyOf('intact')
  const flagged = database.query(`select ShipID from FCT_Ship where GameID = ${GAME} and RaceID = ${RACE} and ShipSeniorCO = 1 and coalesce(ShippingLineID, 0) <= 0 order by ShipID`).all().map((row) => row.ShipID)
  const model = await n.loadNavalHierarchy(loaderOf(database), IDS)

  assert.equal(model.supported, true, 'the save holds the columns of the structure')
  assert.equal(flagged.length, 26, 'the fixture has 26 flagged ships, none a shipping line\'s')

  const ships = model.nodes.filter((node) => node.kind === 'ship')

  assert.deepEqual(ships.filter((node) => node.seniorCO === true).map((node) => node.id).sort((a, b) => a - b), flagged, 'the model marks exactly the flagged ships')
  assert.ok(ships.filter((node) => node.seniorCO !== true).every((node) => node.seniorCO === false), 'every other ship is stored as not flagged')
  assert.ok(model.nodes.filter((node) => node.kind !== 'ship').every((node) => node.seniorCO === null), 'a command or a fleet has no flag')

  const records = strictRecords(h.hierarchyCsv(model, 'naval'))
  const header = records[0]
  const column = header.indexOf('Senior CO')

  assert.ok(column >= 0, `the CSV has a Senior CO column: ${header.join(', ')}`)
  assert.ok(records.slice(1).every((record) => record.length === header.length), 'every record as wide as the header')

  const kind = header.indexOf('Kind')
  const id = header.indexOf('ID')
  const marks = records.slice(1).filter((record) => record[kind] === 'ship')

  assert.deepEqual(marks.filter((record) => record[column] === 'yes').map((record) => Number(record[id])).sort((a, b) => a - b), flagged, 'the CSV marks the flagged ships with yes')
  assert.ok(marks.filter((record) => record[column] === 'no').length === marks.length - flagged.length, 'and every other ship with no')
  assert.ok(records.slice(1).filter((record) => record[kind] !== 'ship').every((record) => record[column] === ''), 'a command or a fleet has an empty cell')

  const markdown = h.hierarchyMarkdown(model, 'naval', 'Empire')

  assert.equal((markdown.match(/, Senior CO\b/g) || []).length, flagged.length, 'the Markdown names each flagged ship once')

  const odd = copyOf('odd')
  const [first, last] = odd.query(`select min(ShipID) as First, max(ShipID) as Last from FCT_Ship where ShipClassID = ${HARVESTER_CLASS}`).all().map((row) => [row.First, row.Last])[0]
  const oddModel = await n.loadNavalHierarchy(loaderOf(odd), IDS)
  const byId = (model_, shipId) => model_.nodes.find((node) => node.kind === 'ship' && node.id === shipId)

  assert.equal(byId(oddModel, first).seniorCO, false, 'a flag of 2 is not Senior CO')
  assert.equal(byId(oddModel, last).seniorCO, null, 'a flag that is null is not stored, not no')

  const oddRecords = strictRecords(h.hierarchyCsv(oddModel, 'naval'))
  const oddColumn = oddRecords[0].indexOf('Senior CO')
  const cell = (shipId) => oddRecords.slice(1).find((record) => record[oddRecords[0].indexOf('Kind')] === 'ship' && Number(record[oddRecords[0].indexOf('ID')]) === shipId)[oddColumn]

  assert.equal(cell(first), 'no', 'the CSV says no for the flag of 2')
  assert.equal(cell(last), '', 'and leaves the cell empty for the flag not stored')

  const dropped = await n.loadNavalHierarchy(loaderOf(copyOf('dropped')), IDS)

  assert.equal(dropped.supported, true, 'a save without the column still gives the structure')
  assert.deepEqual(dropped.seniorCO, { read: false, missing: ['FCT_Ship.ShipSeniorCO'] }, 'and says the flag was not read')
  assert.deepEqual(dropped.nodes.map((node) => node.key), model.nodes.map((node) => node.key), 'the same tree of commands, fleets and ships')
  assert.ok(dropped.nodes.filter((node) => node.kind === 'ship').every((node) => node.seniorCO === null), 'with every ship\'s flag unknown, never no')

  const droppedRecords = strictRecords(h.hierarchyCsv(dropped, 'naval'))
  const droppedColumn = droppedRecords[0].indexOf('Senior CO')

  assert.deepEqual(droppedRecords[0], records[0], 'the CSV keeps its columns')
  assert.ok(droppedRecords.slice(1).every((record) => record[droppedColumn] === ''), 'and leaves every Senior CO cell empty')
  assert.equal(h.hierarchyMarkdown(dropped, 'naval', 'Empire'), markdown.replace(/, Senior CO\b/g, ''), 'the Markdown is the same outline without the marks')
  assert.ok(h.hierarchyExport(dropped, 'naval', 'csv') && h.hierarchyExport(dropped, 'naval', 'markdown'), 'both exports still come out of the save without the column')
  assert.equal(h.hierarchyNotice(dropped, 'naval'), 'The save lacks the ship senior co of ship, so the Senior CO mark is not shown and the rank each ship\'s captain requires is unknown.', `the panel states the mark is not shown and the captain's rank unknown, not that it is the class rank: ${h.hierarchyNotice(dropped, 'naval')}`)
  assert.equal(h.hierarchyNotice(model, 'naval'), null, 'a save that stores the flag has nothing to say')
})

check('capability', 'the registry no longer declares FCT_Ship.ShipSeniorCO unread, the Commanders report holds the seniorCO group beside the ranks and the ages, and a save without the column degrades that group alone', async (w) => {
  const { capabilities: k, commanders: c } = await w.modules()

  assert.ok(!k.DECLARED.some((entry) => entry.table === 'FCT_Ship' && entry.columns.includes('ShipSeniorCO')), 'the page reads the flag, so the registry does not declare it as read later by another item')

  const group = k.SOFT['/commanders'].find((entry) => entry.key === 'seniorCO')

  assert.ok(group, 'the Commanders page has the group seniorCO')
  assert.deepEqual([...group.fields], ['FCT_Ship.ShipSeniorCO'], 'its field is the ship\'s flag')
  assert.ok(!k.SOFT['/commanders'].filter((entry) => entry.key !== 'seniorCO').some((entry) => entry.fields.includes('FCT_Ship.ShipSeniorCO')), 'no other group holds it')

  const whole = (await k.preflight(loaderOf(copyOf('intact')))).reports['/commanders']

  assert.equal(whole.status, 'supported', `the fixture's Commanders report is whole, not ${whole.status}`)
  assert.deepEqual(whole.groups, { rank: true, age: true, seniorCO: true }, 'with every group')

  const lacking = (await k.preflight(loaderOf(copyOf('dropped')))).reports['/commanders']

  assert.equal(lacking.status, 'degraded', `a save without the flag degrades the report and does not withhold the page, not ${lacking.status}`)
  assert.deepEqual(lacking.groups, { rank: true, age: true, seniorCO: false }, 'by the seniorCO group alone: the ranks and the ages stay')
  assert.ok(lacking.degraded.some((entry) => entry.key === 'seniorCO' && entry.fields.includes('FCT_Ship.ShipSeniorCO')), 'and the report names the field')
  assert.deepEqual(lacking.missing, [], 'with nothing the page cannot do without')

  const parts = c.rosterParts(lacking.groups, IDS)

  assert.ok(/null as ShipSeniorCO/.test(parts.classRank) && /FCT_ShipClass\.RankRequired/.test(parts.classRank) && !/SeniorCOStored/.test(parts.classRank), 'the ships read takes the class rank and leaves the flag as null, so the captain\'s rank is unknown rather than the class\'s')
  assert.ok(/FCT_Ship\.ShipSeniorCO, \(select count/.test(c.rosterParts(whole.groups, IDS).classRank), 'a save that stores the flag reads it')
  assert.equal(parts.shipFlag, 'null as AssignmentSeniorCO', 'the roster mark is null')
  assert.ok(/FCT_Ranks\.RankName/.test(parts.rankColumns), 'the rank names stay')
})

// The text of the template from `opener` to the end of the element or template it opens.
const blockOf = (text, opener, closer) => {
  const from = text.indexOf(opener)

  if (from < 0) {
    throw new Error(`the Commanders page's template has no ${opener} where the check looks for it`)
  }

  if (closer !== '</template>') {
    const to = text.indexOf(closer, from)

    return text.slice(from, to + closer.length)
  }

  let depth = 0

  for (const match of text.slice(from).matchAll(/<template\b|<\/template>/g)) {
    depth += match[0] === '</template>' ? -1 : 1

    if (depth === 0) {
      return text.slice(from, from + match.index + closer.length)
    }
  }

  throw new Error(`the template at ${opener} is not closed`)
}

const flat = (node) => (Array.isArray(node) ? node.map(flat).join('') : typeof node === 'string' ? node : node && typeof node === 'object' ? flat(node.children) : '')

// The slots of a table of the page's template, rendered for a row: { [slot name]: (item) => text }.
const slotsOf = (block) => {
  const componentText = `<template><div>${block}</div></template>`
  const vm = { shipRows: [1], visibleShipRows: [1], declaredText: () => '', shipHeaders: [], shipTable: { itemsPerPage: 10 }, shipPageSizes: [], rows: [], systemLink: () => '/systems/1', colonyLink: () => '/colonies/1', rankName: (level) => `Rank ${level}`, bonusText: () => '', count: String }
  const { tree, errors } = renderTree(componentText, vm)

  assert.deepEqual(errors, [], 'the extracted template compiles')

  const table = treeOf(tree).find((node) => node.tag === 'v-data-table')

  assert.ok(table && table.data.scopedSlots, 'the extracted template holds a table with slots')

  return (name, item) => flat(table.data.scopedSlots[name]({ item }))
}

check('text', 'the Commanders page draws the Senior CO mark of a ship, the one-rank-above note of the post and the mark of the roster\'s assignment from its own template, and the footer of the ships panel states the rule, including that a save without the setting gives no captain rank', async (w) => {
  const text = w.texts.commandersPage
  const ships = slotsOf(blockOf(text, '<v-data-table v-if="visibleShipRows.length"', '</v-data-table>'))
  const ship = (flag) => ships('item.ship', { ship: { ShipName: 'Hauler', ClassName: 'H50M', FleetName: 'First', SystemID: 0, SystemName: '', ShipSeniorCO: flag } })
  const post = (seniorCO) => ships('item.post', { post: { post: 'captain', label: 'Mining', level: 4, seniorCO }, postResult: null })

  assert.ok(/H50M · First · Senior CO$/.test(ship(1)), `a flagged ship carries the mark: ${ship(1)}`)

  for (const flag of [0, null, undefined, 2]) {
    assert.ok(!/Senior CO/.test(ship(flag)), `a ship with the flag ${flag} carries no mark: ${ship(flag)}`)
  }

  assert.ok(/Mining · Rank 4 · one above the class\s*$/.test(post(true)), `a captain's post raised by the flag says so: ${post(true)}`)
  assert.ok(!/one above/.test(post(false)), `a post the flag did not raise says nothing: ${post(false)}`)

  const roster = slotsOf(`<v-data-table :items="rows">${blockOf(text, '<template #[`item.assignment`]', '</template>')}</v-data-table>`)
  const assigned = (extra) => roster('item.assignment', { CommandType: 1, assignmentMark: null, post: 'Captain', AssignmentName: 'Hauler 1', AssignmentSeniorCO: 0, CommandID: 5, ...extra })

  assert.ok(/Hauler 1 · Senior CO ship$/.test(assigned({ AssignmentSeniorCO: 1 })), `an officer on a flagged ship carries the mark: ${assigned({ AssignmentSeniorCO: 1 })}`)

  for (const flag of [0, null, undefined]) {
    assert.ok(!/Senior CO/.test(assigned({ AssignmentSeniorCO: flag })), `an officer on a ship with the flag ${flag} carries no mark`)
  }

  assert.ok(!/Senior CO/.test(assigned({ CommandType: 3, AssignmentSeniorCO: null })), 'a governor carries no mark')
  assert.equal(assigned({ CommandType: 0, AssignmentSeniorCO: 1 }), 'Unassigned', 'an unassigned officer is only said so')

  const foot = blockOf(text.slice(text.indexOf('suggestionView === \'ships\'')), '<div class="panel-foot caption text--secondary">', '</div>')

  assert.ok(/^<div class="panel-foot caption text--secondary">\s*Use it to /.test(foot), 'the footer opens with what the panel is for')
  assert.ok(/the rank the class requires, which already includes the class's Senior CO option, and one rank higher for a ship set to Senior CO/.test(foot), 'it states the captain\'s rank rule')
  assert.ok(/the science officer's rank does not move with it/.test(foot), 'and that the science officer\'s rank stays')
  assert.ok(/has no rank to ask for, so it is listed as one that cannot be rated/.test(foot), 'and what a flagged ship at the highest rank is')
  assert.ok(/A save that does not store a ship's Senior CO setting leaves its captain's rank unknown/.test(foot), 'and that a ship whose setting the save does not hold has no captain rank, never the class\'s')
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the flag adds nothing to the captain\'s rank', target: 'commanders', from: 'return { level: ship.RankRequired + 1, flagged, missing }', to: 'return { level: ship.RankRequired, flagged, missing }', fails: ['rank', 'suggestions', 'fixture', 'page'] },
  { name: 'the flag adds two ranks', target: 'commanders', from: 'return { level: ship.RankRequired + 1, flagged, missing }', to: 'return { level: ship.RankRequired + 2, flagged, missing }', fails: ['rank', 'suggestions', 'fixture', 'page'] },
  { name: 'the class\'s own Senior CO option is added again to the stored rank', target: 'commanders', from: 'return { level: ship.RankRequired, flagged, missing }', to: 'return { level: ship.RankRequired + (ship.SeniorCO === 1 ? 1 : 0), flagged, missing }', fails: ['rank'] },
  { name: 'any flag above 0 counts as Senior CO', target: 'commanders', from: 'const flagged = ship.ShipSeniorCO === 1', to: 'const flagged = ship.ShipSeniorCO > 0', fails: ['rank', 'page'] },
  { name: 'a flag the save does not hold falls back to the class rank', target: 'commanders', from: '...(known ? [] : [', to: '...(true ? [] : [', fails: ['rank', 'suggestions', 'page'] },
  { name: 'a flagged ship at the highest class rank is given a rank above it', target: 'commanders', from: '} else if (ship.RankRequired + 1 > ship.NavalRanks) {', to: '} else if (false) {', fails: ['rank', 'suggestions', 'page'] },
  { name: 'a flagged ship with no count of naval ranks is given a rank anyway', target: 'commanders', from: '} else if (!isKnownNumber(ship.NavalRanks)) {', to: '} else if (false) {', fails: ['rank'] },
  { name: 'the flag moves the science officer\'s post as well', target: 'commanders', from: 'Math.max(1, ship.RankRequired - 1)', to: 'Math.max(1, ship.RankRequired - 1 + (ship.ShipSeniorCO === 1 ? 1 : 0))', fails: ['rank', 'suggestions', 'page'] },
  { name: 'the post leaves the mark of the flag out', target: 'commanders', from: 'seniorCO: science ? false : rank.flagged', to: 'seniorCO: false', fails: ['rank', 'page'] },
  { name: 'the ships read leaves the flag out', target: 'commanders', from: 'FCT_ShipClass.RankRequired, ${flagged ? `FCT_Ship.ShipSeniorCO, (select', to: 'FCT_ShipClass.RankRequired, ${flagged ? `null as ShipSeniorCO, (select', fails: ['page'] },
  { name: 'the count of naval ranks is the count of ground ranks', target: 'commanders', from: 'and FCT_Ranks.RankType = ${NAVAL_RANK_TYPE}) as NavalRanks', to: 'and FCT_Ranks.RankType = 1) as NavalRanks', fails: ['page'] },
  { name: 'the roster read leaves the flag of the ship out', target: 'commanders', from: 'shipFlag: flagged ? \'VIR_Ship.ShipSeniorCO as AssignmentSeniorCO\'', to: 'shipFlag: flagged ? \'null as AssignmentSeniorCO\'', fails: ['page'] },
  { name: 'a save without the flag column loses the ranks as well', target: 'capabilities', from: '\'FCT_ShipClass.RankRequired\']) }),', to: '\'FCT_ShipClass.RankRequired\', \'FCT_Ship.ShipSeniorCO\']) }),', fails: ['capability'] },
  { name: 'the page leaves the roster mark out of its roster read', target: 'commandersPage', from: 'end as AssignmentName, ${parts.shipFlag}', to: 'end as AssignmentName, null as AssignmentSeniorCO', fails: ['page'] },
  { name: 'the ships table draws no mark of the flag', target: 'commandersPage', from: '<span v-if="item.ship.ShipSeniorCO === 1"> · Senior CO</span>', to: '', fails: ['text'] },
  { name: 'the ships table draws a mark for any flag but 0', target: 'commandersPage', from: '<span v-if="item.ship.ShipSeniorCO === 1">', to: '<span v-if="item.ship.ShipSeniorCO !== 0">', fails: ['text'] },
  { name: 'the post cell does not say the rank is one above the class', target: 'commandersPage', from: '<span v-if="item.post.seniorCO"> · one above the class</span>', to: '', fails: ['text'] },
  { name: 'the roster draws no mark of the ship\'s flag', target: 'commandersPage', from: '<span v-if="item.AssignmentSeniorCO === 1"> · Senior CO ship</span>', to: '', fails: ['text'] },
  { name: 'the footer states no rule of the flag', target: 'commandersPage', from: 'and one rank higher for a ship set to Senior CO', to: 'and no rank higher', fails: ['text'] },
  { name: 'the footer says nothing of a save that does not store the setting', target: 'commandersPage', from: 'A save that does not store a ship\'s Senior CO setting leaves its captain\'s rank unknown, since the setting could have raised it by one, so the ship is listed under those that cannot be rated. ', to: '', fails: ['text'] },
  { name: 'the ranks of a save lose the flag group\'s column', target: 'capabilities', from: '\'FCT_Ship.ShipSeniorCO\']) }),', to: '\'FCT_Ship.ShipSeniorCO_\']) }),', fails: ['capability'] },
  { name: 'the registry declares the flag as read by another item again', target: 'capabilities', from: 'export const DECLARED = Object.freeze([', to: 'export const DECLARED = Object.freeze([\n  { item: \'AE-308-07\', readBy: \'AE-302-11\', table: \'FCT_Ship\', columns: [\'ShipSeniorCO\'] },', fails: ['capability'] },
  { name: 'the hierarchy read requires the flag column again', target: 'navalHierarchy', from: 'FCT_Ship: [\'ShipID\', \'ShipName\', \'FleetID\', \'ShippingLineID\', \'GameID\', \'RaceID\'],', to: 'FCT_Ship: [\'ShipID\', \'ShipName\', \'FleetID\', \'ShippingLineID\', \'ShipSeniorCO\', \'GameID\', \'RaceID\'],', fails: ['export'] },
  { name: 'the hierarchy reads the flag as absent though the save stores it', target: 'navalHierarchy', from: 'const seniorCO = seniorGaps.length === 0', to: 'const seniorCO = false', fails: ['export'] },
  { name: 'the structure read leaves the flag out', target: 'navalHierarchy', from: 'const seniorColumn = seniorCO ? \'FCT_Ship.ShipSeniorCO\' : \'null as ShipSeniorCO\'', to: 'const seniorColumn = \'null as ShipSeniorCO\'', fails: ['export'] },
  { name: 'a flag that is not stored reads as not flagged', target: 'navalHierarchy', from: '? value === 1 : null)', to: '? value === 1 : false)', fails: ['export'] },
  { name: 'a flag of 2 reads as flagged in the structure', target: 'navalHierarchy', from: '? value === 1 : null)', to: '? value > 0 : null)', fails: ['export'] },
  { name: 'the notice does not say the flag was not read', target: 'hierarchyExport', from: '  if (model.seniorCO && !model.seniorCO.read) {', to: '  if (false) {', fails: ['export'] },
  { name: 'the notice says the captain ranks as its class requires though the flag is unknown', target: 'hierarchyExport', from: 'and the rank each ship\'s captain requires is unknown.', to: 'and each ship\'s captain ranks as its class requires.', fails: ['export'] },
  { name: 'the CSV leaves the Senior CO cell empty', target: 'hierarchyExport', from: '\'Senior CO\': entry.seniorCO === true ? \'yes\' : entry.seniorCO === false ? \'no\' : \'\',', to: '\'Senior CO\': \'\',', fails: ['export'] },
  { name: 'the CSV says no for a flag that is not stored', target: 'hierarchyExport', from: 'entry.seniorCO === false ? \'no\' : \'\',', to: 'entry.seniorCO === true ? \'\' : \'no\',', fails: ['export'] },
  { name: 'the Markdown leaves the Senior CO mark out', target: 'hierarchyExport', from: 'const senior = row[\'Senior CO\'] === \'yes\' ? \', Senior CO\' : \'\'', to: 'const senior = \'\'', fails: ['export'] },
]

// Rewrites that say the same thing: a flag test with its operands swapped, the unflagged branch tested by comparison, the rank above written as a sum the other way round, the highest-rank test written from the other side, the structure's flag test with its operands swapped, the CSV cell's flag tests in the other order.
const BENIGN = [
  { name: 'the flag tested with its operands swapped', target: 'commanders', from: 'const flagged = ship.ShipSeniorCO === 1', to: 'const flagged = 1 === ship.ShipSeniorCO' },
  { name: 'the unflagged branch tested by comparison', target: 'commanders', from: 'if (!flagged) {', to: 'if (flagged === false) {' },
  { name: 'the rank above written as a sum the other way round', target: 'commanders', from: 'return { level: ship.RankRequired + 1, flagged, missing }', to: 'return { level: 1 + ship.RankRequired, flagged, missing }' },
  { name: 'the highest-rank test written the other way round', target: 'commanders', from: '} else if (ship.RankRequired + 1 > ship.NavalRanks) {', to: '} else if (ship.NavalRanks < ship.RankRequired + 1) {' },
  { name: 'the structure\'s flag tested with its operands swapped', target: 'navalHierarchy', from: '? value === 1 : null)', to: '? 1 === value : null)' },
  { name: 'the CSV cell tests the flag in the other order', target: 'hierarchyExport', from: '\'Senior CO\': entry.seniorCO === true ? \'yes\' : entry.seniorCO === false ? \'no\' : \'\',', to: '\'Senior CO\': entry.seniorCO === false ? \'no\' : entry.seniorCO === true ? \'yes\' : \'\',' },
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
