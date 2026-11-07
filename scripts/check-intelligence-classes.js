/*
  Checks the alien class branches and the communication progress of the Intelligence page (utilities/intelligence.js `classType`, `classBranch`, `CLASS_BRANCHES`, `prisonersSql`, `prisonerRating`, `diplomacyShipsSql`, `contactRatings`, `attemptOutcome`, `attemptRows`, `attemptWording`, pages/intelligence.vue): which branch of the game's class tree an observed class sits under (Military, Commercial, Light Naval, Unknown) and, for a race the player has no communication with, the prisoners processed and the rating they add, the sources of the contact rating and what an attempt does in each band of the roll.

  Run: bun scripts/check-intelligence-classes.js [--no-mutations]

  The rules are the game's, and none is compared with a played 3.1 save (the owner's decision AE-31 Q7: no played save is supplied, so the figures are worked from the rules and the planted copies of the interim fixture carry the cases):
  - the branch: the game works the type of every class out each time the intelligence window is drawn, Light Naval for a class whose observed size is above 0 and at most 20, else Military for engine type 1, Commercial for 2 and Unknown for any other, and saves it in `AlienClassType`;
  - the prisoners: an attempt adds `processed / 200` (integer division) to a contact rating below 1, over the prisoner groups the viewing race holds of the alien race, and holds the rating at 1; the game stops a group of a race it has no communication with at 200 processed; the groups are saved in FCT_Prisoners;
  - the contact rating: 0 without a system where each race currently detects the other, else 0.5 or the best captain's Communications bonus on a ship with an undamaged Diplomacy Module (a bonus the commander has no row for is 1 for a multiplier);
  - the outcome of an attempt: the game's cascade of the roll and the rating into the attempt's progress.

  - `type`: the branch of a class from its observed size and engine, as an if-chain written here from the rule reads it, over a grid of sizes (none, 0, a fraction, 19.99, 20, 20.0001, a large one) and engines; a size or an engine the save does not hold is unavailable and named where it decides; the saved type is read beside it and a class saved under another type is marked with it;
  - `fixture`: on the interim 3.1 fixture (saves/AuroraDB-310-spookyerol-migrated.db, game 141, race 784) the 18 classes of the race sit one each under a branch (8 Military, 2 Commercial, 1 Light Naval, 7 Unknown), the branch of every one equal to the type the game saved for it, and the page's read names the saved type;
  - `page`: the page's own script groups the classes of each alien race by the branch and not by the saved type (a copy with every saved type 0, one with two swapped), at the limits of 20 and just above, a class with no saved size or engine is placed under Unknown and said not to be placed, and the table sorts the branches in the game's order, inside one by class name or the column picked;
  - `prisoners`: the groups the race holds of each alien race (the groups on colonies of another race, of another game, or of another race's prisoners never counted), the processed count over all the groups together, the rating one for each full 200, held at 1, a race with none held a real 0 and a group with no saved count unavailable;
  - `rating`: the ships with a working Diplomacy Module read from planted ships (a damaged module, a module of unknown damage, a ship of another race, no captain, a captain who died, a captain with no Communications row at 1, a Communications row stored with no value unknown and never 1), the rating rows from them and what the prisoners add to a rating below 1, and a blocked Communications bonus leaving the captains' rows out and named;
  - `outcome`: what an attempt does at a roll and a rating, as the game's cascade reads it, over a grid of rolls and ratings with every edge, and the game's wording of a change;
  - `communication`: the page's own script shows the prisoners processed and the rating they add beside a race's communication while it is not established, the panel of the selected race with the prisoners, the rating rows and the bands, and no panel once communication is established;
  - `capability`: the registry no longer declares the saved type as read by another item, the page's reads name it and the prisoners and the ships, a save without the saved type or the prisoners cannot give the page, and Communications is a gated bonus of the page;
  - `text`: the class table is grouped by the branch under the game's own headings, the foots open with what the panel is for and state the limits of the rules in the impersonal voice with no release named, and the page help and the rule notes say the same.
  - `played`: where the file is present, the played 3.2.0 save (saves/AuroraDB-320-fetterkrolle-1.db, game 161, race 909, an owner-supplied campaign that has met no alien race and holds no prisoner) is a real witness of the empty case: the class, prisoner and diplomacy-ship reads run on a save the 3.x game wrote and give nothing, the page shows no race, class or communication panel, the Intelligence report is whole, Communications is named as the save names it and is not blocked, and the captains hold it as a multiplier; skipped, and said so, where the file is not present;

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
const { attrsOf, renderTree, treeOf } = require('./lib/vue-render')

const root = path.resolve(__dirname, '..')
const SAVE = 'saves/AuroraDB-310-spookyerol-migrated.db'
const GAME = 141
const RACE = 784
const PLAYED = 'saves/AuroraDB-320-fetterkrolle-1.db'
const PLAYED_GAME = 161
const PLAYED_RACE = 909
const PLAYED_PRESENT = fs.existsSync(path.join(root, PLAYED))
const WITNESS = PLAYED_PRESENT ? ['played'] : []
// The races the player has met: the Starfarers (communication attempted), the Karachi Federation (established) and the Precursors (attempted, a fixed relationship).
const STARFARERS = 787
const KARACHI = 789
const PRECURSORS = 786
const OTHER_EMPIRE = 785
const NOTED = new Set()

const FILES = {
  intelligence: path.join(root, 'src', 'renderer', 'utilities', 'intelligence.js'),
  capabilities: path.join(root, 'src', 'renderer', 'utilities', 'capabilities.js'),
  glossary: path.join(root, 'src', 'renderer', 'utilities', 'glossary.js'),
  intelligencePage: path.join(root, 'src', 'renderer', 'pages', 'intelligence.vue'),
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
  modules: memo(() => loadUtilities(['intelligence', 'capabilities', 'glossary'], { stubs: STUBS, sources: { intelligence: texts.intelligence, capabilities: texts.capabilities, glossary: texts.glossary } })),
  page: memo(() => loadPage('pages/intelligence', { stubs: STUBS, modules: { 'utilities/appearance': APPEARANCE }, sources: { 'pages/intelligence': texts.intelligencePage, 'utilities/intelligence': texts.intelligence, 'utilities/capabilities': texts.capabilities, 'utilities/glossary': texts.glossary } })),
})

// ---- The fixture, as in-memory copies ------------------------------------------------------------------------------
let BYTES = null
const COPIES = new Map()
let HOLDERS = null

// What the plants refer to, read from the saved rows: the colonies of the player's race and of another empire, the first species and the ships and commanders the diplomacy plants use.
const holdersOf = (database) => {
  const colonies = database.query(`select PopulationID from FCT_Population where GameID = ${GAME} and RaceID = ${RACE} order by PopulationID limit 2`).all().map((row) => row.PopulationID)
  const other = database.query(`select PopulationID from FCT_Population where GameID = ${GAME} and RaceID = ${OTHER_EMPIRE} order by PopulationID limit 1`).get().PopulationID
  const species = database.query('select min(SpeciesID) as SpeciesID from FCT_Species').get().SpeciesID
  const griffins = database.query(`select ShipID from FCT_Ship where GameID = ${GAME} and RaceID = ${RACE} and ShipClassID = 63034 order by ShipID limit 8`).all().map((row) => row.ShipID)
  const captainOf = (ship) => database.query(`select CommanderID from FCT_Commander where CommandType = 1 and CommandID = ${ship} and Deceased = 0 limit 1`).get().CommanderID

  return { colonies, other, species, griffins, captains: griffins.map(captainOf), alien: database.query(`select ShipID from FCT_Ship where GameID = ${GAME} and RaceID = ${OTHER_EMPIRE} limit 1`).get().ShipID }
}

const prisoners = (holders, population, race, held, processed, game = GAME) => `insert into FCT_Prisoners (GameID, PopulationID, PrisonerRaceID, PrisonerSpeciesID, NumPrisoners, NumProcessed) values (${game}, ${population}, ${race}, ${holders.species}, ${held}, ${processed === null ? 'null' : processed})`

const classOf = (name, set) => `update FCT_AlienClass set ${set} where GameID = ${GAME} and ViewRaceID = ${RACE} and ClassName = '${name}'`

const DIPLOMACY_CLASS = 63064
const DIPLOMACY_MODULE = 65902

const PLANTS = {
  intact: () => [],
  // The saved type of every class the player's race has observed is the default, as for a class the window was never drawn for.
  stale: () => [`update FCT_AlienClass set AlienClassType = 0 where GameID = ${GAME} and ViewRaceID = ${RACE}`],
  // Two classes saved under each other's type.
  swapped: () => [classOf('Micah', 'AlienClassType = 2'), classOf('Allman', 'AlienClassType = 3')],
  // The limits of 20 hull spaces, and a size of nothing: Allman (engine 1) at 20, Comigan (1) just above, Elric (1) at 0, Hillman (1) a fraction, Manticore (2) at 20, Nuernberg (2) just above, Berlin (0) at 20, Unna (0) just above, Micah (0) just above.
  limits: () => [classOf('Allman', 'TCS = 20'), classOf('Comigan', 'TCS = 20.0001'), classOf('Elric', 'TCS = 0'), classOf('Hillman', 'TCS = 0.5'), classOf('Manticore', 'TCS = 20'), classOf('Nuernberg', 'TCS = 20.0001'), classOf('Berlin', 'TCS = 20'), classOf('Unna', 'TCS = 20.0001'), classOf('Micah', 'TCS = 20.0001')],
  // No saved size (Allman), and a large class with no saved engine (Berlin) and a small one with none (Micah, which its size decides).
  unsaved: () => [classOf('Allman', 'TCS = null'), classOf('Berlin', 'TCS = 30, EngineType = null'), classOf('Micah', 'EngineType = null')],
  // Prisoners: the Starfarers' two groups on the player's colonies (199 processed in all), a group on another empire's colony and one of another game that never count; the Precursors' one group at 399 processed; the Karachi Federation's one group of 250, a race the player is in communication with.
  held: (h) => [prisoners(h, h.colonies[0], STARFARERS, 500, 199), prisoners(h, h.colonies[1], STARFARERS, 300, 0), prisoners(h, h.other, STARFARERS, 900, 400), prisoners(h, h.colonies[0], STARFARERS, 50, 50, 999), prisoners(h, h.colonies[0], PRECURSORS, 600, 399), prisoners(h, h.colonies[0], KARACHI, 250, 250)],
  // The edges of the rating: three groups of 150 (450 together, so 1 although each is under 200), one of exactly 200, two of the Karachi Federation of which one has no saved count (so the sum of the other is not the whole).
  edges: (h) => [prisoners(h, h.colonies[0], STARFARERS, 150, 150), prisoners(h, h.colonies[1], STARFARERS, 150, 150), prisoners(h, h.colonies[0], STARFARERS, 150, 150), prisoners(h, h.colonies[0], PRECURSORS, 300, 200), prisoners(h, h.colonies[1], KARACHI, 100, null), prisoners(h, h.colonies[0], KARACHI, 100, 50)],
  // The Precursors with no communication at all, and the Starfarers with 400 processed.
  silent: (h) => [`update FCT_AlienRace set CommStatus = 0 where GameID = ${GAME} and ViewRaceID = ${RACE} and AlienRaceID = ${PRECURSORS}`, prisoners(h, h.colonies[0], PRECURSORS, 250, 80), prisoners(h, h.colonies[0], STARFARERS, 600, 400)],
  // A prisoner count that cannot be summed: the Starfarers' group of 100 on one colony has no saved processed count, beside a group of 100 with 50 processed on the other.
  blank: (h) => [prisoners(h, h.colonies[0], STARFARERS, 100, null), prisoners(h, h.colonies[1], STARFARERS, 100, 50)],
  // The statuses of communication the game runs no attempt for, with prisoners held: the Precursors communication impossible (399 processed), the Starfarers a status the game does not name (400 processed); the Karachi Federation stay in communication.
  states: (h) => [`update FCT_AlienRace set CommStatus = 3 where GameID = ${GAME} and ViewRaceID = ${RACE} and AlienRaceID = ${PRECURSORS}`, `update FCT_AlienRace set CommStatus = 9 where GameID = ${GAME} and ViewRaceID = ${RACE} and AlienRaceID = ${STARFARERS}`, prisoners(h, h.colonies[0], PRECURSORS, 600, 399), prisoners(h, h.colonies[0], STARFARERS, 600, 400), prisoners(h, h.colonies[0], KARACHI, 250, 250)],
  // Griffins made diplomacy ships: the first with a captain whose Communications is 1.4, the second a captain with no such row, the third with no captain, the fourth with its module wholly damaged, the fifth with a damage row that has no number, the sixth with a dead captain; a ship of another empire of the same class.
  ships: (h) => [
    `update FCT_Ship set ShipClassID = ${DIPLOMACY_CLASS} where ShipID in (${h.griffins.slice(0, 6).join(', ')}, ${h.alien})`,
    `insert into FCT_CommanderBonuses (CommanderID, BonusID, BonusValue, GameID) values (${h.captains[0]}, 22, 1.4, ${GAME})`,
    `delete from FCT_CommanderBonuses where CommanderID = ${h.captains[1]} and BonusID = 22`,
    `update FCT_Commander set CommandType = 0, CommandID = 0 where CommanderID = ${h.captains[2]}`,
    `insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) values (${h.griffins[3]}, ${DIPLOMACY_MODULE}, ${GAME}, 1)`,
    `insert into FCT_DamagedComponent (ShipID, ComponentID, GameID, Number) values (${h.griffins[4]}, ${DIPLOMACY_MODULE}, ${GAME}, null)`,
    `update FCT_Commander set Deceased = 1 where CommanderID = ${h.captains[5]}`,
  ],
  // Three Griffins made diplomacy ships: the first with a captain whose Communications row is stored with no value (the migrated schema permits a NULL BonusValue), the second with a captain who has no such row at all, the third with no captain. The row that is stored but holds no value is unknown and never the default 1; the captain with no row counts 1.
  nullBonus: (h) => [
    `update FCT_Ship set ShipClassID = ${DIPLOMACY_CLASS} where ShipID in (${h.griffins.slice(0, 3).join(', ')})`,
    `delete from FCT_CommanderBonuses where BonusID = 22 and CommanderID in (${h.captains.slice(0, 3).join(', ')})`,
    `insert into FCT_CommanderBonuses (CommanderID, BonusID, BonusValue, GameID) values (${h.captains[0]}, 22, null, ${GAME})`,
    `update FCT_Commander set CommandType = 0, CommandID = 0 where CommanderID = ${h.captains[2]}`,
  ],
  droppedType: () => ['alter table FCT_AlienClass drop column AlienClassType'],
  droppedPrisoners: () => ['drop table FCT_Prisoners'],
  renamedBonus: () => ['update DIM_CommanderBonusType set Description = \'Communications (renamed)\' where BonusID = 22'],
}

// The statements of a plant, each on a fresh copy of the saved bytes (a plant that needs another's rows is a list of both).
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

    HOLDERS = HOLDERS || holdersOf(database)
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

// ---- The rules, written here from the game's rules ---------------------------------------------------------------------------
// The type of a class from its observed size and engine.
const oracleType = (size, engine) => {
  if (size > 0 && size <= 20) {
    return 3
  } else if (engine === 1) {
    return 2
  } else if (engine === 2) {
    return 1
  }

  return 0
}

// Whether the game's rule can be applied: a size that is not saved decides nothing, and an engine that is not saved matters where the size does not make the class Light Naval.
const oracleDecides = (size, engine) => size !== null && ((size > 0 && size <= 20) || engine !== null)

const BRANCH_OF = { 0: 'Unknown', 1: 'Commercial', 2: 'Military', 3: 'Light Naval' }

// The change to the progress a roll sets at a rating, and the progress description of the change.
const oracleChange = (roll, rating) => {
  if (roll > 90) {
    return 10 * rating
  } else if (roll > 80) {
    return 5 * rating
  } else if (roll > 70) {
    return 3 * rating
  } else if (roll > 50) {
    return 2 * rating
  } else if (roll > 25) {
    return rating
  } else if (roll > 0) {
    return -1 * rating
  } else if (roll > -25) {
    return -2 * rating
  }

  return roll > -50 ? -3 * rating : -500
}

const oracleWording = (change) => {
  if (change >= 10) {
    return 'significant progress'
  } else if (change >= 5) {
    return 'moderate progress'
  } else if (change >= 3) {
    return 'minor progress'
  } else if (change >= 2) {
    return 'limited progress'
  } else if (change >= 1) {
    return 'minimal progress'
  } else if (change >= 0) {
    return 'glacial progress'
  } else if (change >= -1) {
    return 'no progress; the contact team is struggling to make a breakthrough'
  } else if (change >= -2) {
    return 'no progress; the contact team has begun to consider that communication may prove impossible'
  } else if (change >= -3) {
    return 'no progress; the contact team is advising that communication may prove impossible'
  }

  return null
}

const near = (a, b) => Math.abs(a - b) < 1e-9

const value = (result) => (result && result.status !== 'unavailable' ? result.value : null)
const missing = (result) => (result && result.status === 'unavailable' ? result.inputs.missing : [])

// ---- What the save holds, in SQL written here -----------------------------------------------------------------------
const oracleClasses = (database) => database.query(`select AlienClassID, AlienRaceID, ClassName, TCS, EngineType, AlienClassType from FCT_AlienClass where GameID = ${GAME} and ViewRaceID = ${RACE} order by AlienRaceID, ClassName`).all()

// The prisoners of one alien race on the player's colonies: the groups, the prisoners and the processed.
const oraclePrisoners = (database, race) => {
  const rows = database.query(`select NumPrisoners, NumProcessed from FCT_Prisoners where GameID = ${GAME} and PrisonerRaceID = ${race} and PopulationID in (select PopulationID from FCT_Population where GameID = ${GAME} and RaceID = ${RACE})`).all()

  return { groups: rows.length, held: rows.reduce((total, row) => total + row.NumPrisoners, 0), processed: rows.reduce((total, row) => total + (row.NumProcessed || 0), 0), atLimit: rows.filter((row) => row.NumProcessed >= 200).length }
}

// The ships of the player's race whose class mounts a Diplomacy Module, with the modules left working and the captain's Communications.
const oracleDiplomacy = (database) => {
  const ships = database.query(`select s.ShipID, s.ShipClassID from FCT_Ship s where s.GameID = ${GAME} and s.RaceID = ${RACE} and exists (select 1 from FCT_ClassComponent c inner join FCT_ShipDesignComponents d on d.SDComponentID = c.ComponentID where c.ClassID = s.ShipClassID and d.ComponentTypeID = 67) order by s.ShipID`).all()

  return ships.map((ship) => {
    const modules = database.query(`select c.ComponentID, c.NumComponent, d.ComponentValue from FCT_ClassComponent c inner join FCT_ShipDesignComponents d on d.SDComponentID = c.ComponentID where c.ClassID = ${ship.ShipClassID} and d.ComponentTypeID = 67`).all()
    const damage = (module) => database.query(`select Number from FCT_DamagedComponent where ShipID = ${ship.ShipID} and ComponentID = ${module.ComponentID}`).all()
    const unknown = modules.some((module) => module.NumComponent === null || damage(module).some((row) => row.Number === null))
    const working = unknown ? null : modules.reduce((total, module) => total + Math.max(module.NumComponent - (damage(module)[0] ? damage(module)[0].Number : 0), 0) * module.ComponentValue, 0)
    const captain = database.query(`select CommanderID, Name from FCT_Commander where GameID = ${GAME} and RaceID = ${RACE} and CommandType = 1 and CommandID = ${ship.ShipID} and Deceased = 0`).get()
    const bonus = captain ? database.query(`select BonusValue from FCT_CommanderBonuses where CommanderID = ${captain.CommanderID} and BonusID = 22`).get() : null

    return { ShipID: ship.ShipID, Working: working, CaptainID: captain ? captain.CommanderID : null, CaptainName: captain ? captain.Name : null, Communications: bonus ? bonus.BonusValue : null, CommunicationsStored: bonus ? 1 : 0 }
  })
}

const isAvailableResult = (result) => Boolean(result) && result.status !== 'unavailable'

// The bonus a captain's row gives: the stored value, 1 for a captain with no row at all, null for a row stored without a value (unknown).
const oracleBonus = (ship) => (ship.Communications === null ? (ship.CommunicationsStored === 1 ? null : 1) : ship.Communications)

// The keys of the rows the contact rating gives for the ships with a working module and a captain, the best Communications first (a captain with no stored row counts 1, one whose row has no value last), then by ship.
const captainedKeys = (ships) => ships.filter((ship) => ship.Working > 0 && ship.CaptainID !== null).sort((a, b) => {
  const left = oracleBonus(a)
  const right = oracleBonus(b)

  if (left === right) {
    return a.ShipID - b.ShipID
  }

  return left === null ? 1 : right === null ? -1 : right - left
}).map((ship) => `ship:${ship.ShipID}`)

// ---- The page's own glue, from its source ---------------------------------------------------------------------------
const INPUTS = ['races', 'ships', 'classes', 'systems', 'raceOptions', 'prisoners', 'diplomacyShips']

const pageOf = async (w, database, selectedId = null, blocked = [], { game = GAME, race = RACE } = {}) => {
  const options = await w.page()
  const page = instantiate(options, { $store: { getters: { StartYear: 2000, historyRecorded: true, config: { get: (_key, fallback) => fallback }, 'capabilities/blockedBonuses': new Set(blocked) }, state: { history: { revision: 0 } }, dispatch: () => Promise.resolve() }, database: loaderOf(database), GameID: game, RaceID: race, data: { selectedId } })

  for (const name of INPUTS) {
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

// The tree of the Communication attempt card of the page's own template, drawn for a page instance.
const cardTree = (text, page) => {
  const opener = '<v-card v-if="attempt"'
  const from = text.indexOf(opener)

  assert.ok(from >= 0, `the Intelligence page's template has the card ${opener}`)

  const block = text.slice(from, text.indexOf('</v-card>', from) + '</v-card>'.length)
  const { tree, errors } = renderTree(`<template><div>${block}</div></template>`, { attempt: page.attempt, COMMUNICATION_RULES: [], unknown: (result) => result, rating: (number) => page.rating(number) })

  assert.deepEqual(errors, [], 'the extracted card compiles')

  return tree
}

// The text of that card.
const cardText = (text, page) => flat(cardTree(text, page)).replace(/\s+/g, ' ').trim()

// The results the card's marks carry, in the order they are drawn.
const cardMarks = (text, page) => treeOf(cardTree(text, page)).filter((node) => node.tag === 'provenance-mark').map((node) => attrsOf(node).result).filter(Boolean)

const rendered = (source, vm) => {
  const { tree, errors } = renderTree(`<template><div>${source}</div></template>`, vm)

  assert.deepEqual(errors, [], 'the extracted template compiles')

  return tree
}

// The text of a foot opening at `opener`, without its markup.
const footOf = (text, opener) => {
  const start = text.indexOf(opener)

  assert.ok(start >= 0, `the page has the foot ${opener}`)

  return text.slice(start, text.indexOf('</div>', start)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

const factOf = (facts, label) => {
  const found = facts.find((entry) => entry.label === label)

  assert.ok(found, `the facts hold ${label}: ${JSON.stringify(facts.map((entry) => entry.label))}`)

  return found
}

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('type', 'the branch of a class is the game\'s: Light Naval for an observed size above 0 and up to 20 hull spaces (the limit included) whatever the engine, else Military for engine 1, Commercial for 2 and Unknown for any other, a size that is not saved or an engine that is not where the size does not decide unavailable and named, the saved type read beside it and a class saved under another type marked with it, and the branches in the order the game draws them', async (w) => {
  const { intelligence: i } = await w.modules()
  const sizes = [null, 0, 0.5, 1, 19.99, 20, 20.0001, 21, 1109, 15360]
  const engines = [null, 0, 1, 2, 3, 4, 5]

  assert.deepEqual([...i.CLASS_BRANCHES], ['Military', 'Commercial', 'Light Naval', 'Unknown'], 'the branches in the order the game draws them')
  assert.deepEqual(i.CLASS_TYPES, BRANCH_OF, 'the types the game names')
  assert.equal(i.LIGHT_NAVAL_SIZE, 20, 'the limit is 20 hull spaces')

  for (const size of sizes) {
    for (const engine of engines) {
      const result = i.classType({ TCS: size, EngineType: engine, AlienClassType: null })
      const label = `size ${size}, engine ${engine}`

      if (!oracleDecides(size, engine)) {
        assert.equal(result.status, 'unavailable', `${label} decides nothing, so there is no branch`)
        assert.ok(missing(result).some((entry) => (size === null ? /size/ : /engine/).test(entry)), `${label} names what is missing: ${missing(result).join(', ')}`)
        assert.equal(i.classBranch(result), 'Unknown', `${label} sits under Unknown`)
      } else {
        assert.notEqual(result.status, 'unavailable', `${label} has a branch`)
        assert.deepEqual([value(result).type, value(result).label, i.classBranch(result)], [oracleType(size, engine), BRANCH_OF[oracleType(size, engine)], BRANCH_OF[oracleType(size, engine)]], `${label} is read as the game's rule reads it`)
        assert.equal(result.status, 'confirmed', `${label} is a confirmed figure`)
      }
    }
  }

  const saved = (stored, size = 554, engine = 1) => i.classType({ TCS: size, EngineType: engine, AlienClassType: stored })

  assert.deepEqual([value(saved(2)).differs, value(saved(2)).storedLabel], [false, 'Military'], 'a class saved under the type the rule gives is not marked')
  assert.deepEqual([value(saved(0)).differs, value(saved(0)).storedLabel], [true, 'Unknown'], 'a class saved under another type is marked with it')
  assert.ok(saved(0).assumptions.some((entry) => /The saved type is Unknown/.test(entry) && /Military/.test(entry)), `and says so: ${saved(0).assumptions.join(' | ')}`)
  assert.equal(saved(2).assumptions.length, 0, 'a class saved under the same type says nothing more')
  assert.deepEqual([value(saved(null)).differs, value(saved(null)).storedLabel], [null, null], 'a class with no saved type is not marked')
  assert.equal(value(saved(9)).storedLabel, 'Type 9', 'a saved type the game does not name is read by its number')
  assert.equal(value(saved(9)).differs, true, 'and differs')
  assert.equal(value(saved(3, 20, 0)).differs, false, 'a class of 20 hull spaces saved as Light Naval is the rule\'s')
})

check('fixture', 'on the fixture the 18 classes of the race sit one each under a branch (8 Military, 2 Commercial, 1 Light Naval, 7 Unknown) and the branch of every one is the type the game saved for it, as the rule gives it from the observed size and engine, the page\'s read names the saved type, and what the fixture cannot show is named as worked from the rules', async (w) => {
  const { intelligence: i } = await w.modules()
  const database = copyOf('intact')
  const classes = oracleClasses(database)

  assert.equal(classes.length, 18, 'the race has observed 18 classes')

  const counts = {}

  for (const row of classes) {
    const result = i.classType(row)

    assert.notEqual(result.status, 'unavailable', `${row.ClassName} has a branch`)
    assert.equal(value(result).type, row.AlienClassType, `${row.ClassName}: the branch is the type the game saved, ${row.AlienClassType}`)
    assert.equal(value(result).type, oracleType(row.TCS, row.EngineType), `${row.ClassName}: and the game's rule`)
    assert.equal(value(result).differs, false, `${row.ClassName} is not marked`)
    counts[i.classBranch(result)] = (counts[i.classBranch(result)] || 0) + 1
  }

  assert.deepEqual(counts, { Military: 8, Commercial: 2, 'Light Naval': 1, Unknown: 7 }, 'every class is under one of the four branches and all four have a class')

  const text = w.texts.intelligencePage
  const query = text.slice(text.indexOf('    classes: {\n      get: tracked(\'classes\''), text.indexOf('    populations: {'))

  assert.ok(/FCT_AlienClass\.AlienClassType/.test(query), 'the page\'s classes read names the saved type')

  const other = database.query(`select count(*) as N from FCT_AlienClass where GameID = ${GAME} and ViewRaceID <> ${RACE}`).get().N
  const stored = database.query(`select count(*) as N from FCT_AlienClass where GameID = ${GAME} and ViewRaceID <> ${RACE} and AlienClassType <> 0`).get().N

  // The classes of the other viewers were never drawn in a window, so their saved types are the default: not a case the page shows.
  if (!NOTED.has('fixture')) {
    NOTED.add('fixture')
    console.log(`NOTE  fixture: the type of every class the race has observed matches the saved one; ${stored} of the ${other} classes of other viewing races hold a saved type other than the default (the window was never drawn for them); the rules of observation are worked from the game's rules, not compared with a played 3.1 save`)
  }
})

check('page', 'the page\'s own script groups the classes of each alien race by the branch the rule gives and not by the saved type (every saved type 0, two swapped), at the limits of 20 hull spaces and just above and for a size of nothing, a class with no saved size or engine under Unknown and said not to be placed, marks a class saved under another type, and sorts the branches in the game\'s order, inside one by class name or the column picked', async (w) => {
  const rowsOf = async (database, race) => (await pageOf(w, database, race)).selectedClasses
  const everyClass = async (database) => (await Promise.all([PRECURSORS, STARFARERS, KARACHI].map((race) => rowsOf(database, race)))).flat()
  const branchOf = (rows) => Object.fromEntries(rows.map((row) => [row.ClassName, row.branch]))
  const intact = await everyClass(copyOf('intact'))

  assert.equal(intact.length, 18, 'the three races hold the 18 classes')
  assert.deepEqual(Object.fromEntries(intact.map((row) => [row.ClassName, row.branch])), Object.fromEntries(oracleClasses(copyOf('intact')).map((row) => [row.ClassName, BRANCH_OF[row.AlienClassType]])), 'each under the branch of its saved type as saved')
  assert.ok(intact.every((row) => row.typeNote === ''), 'none is marked')

  const stale = await everyClass(copyOf('stale'))

  assert.deepEqual(branchOf(stale), branchOf(intact), 'with every saved type 0 the branches are as before: the rule decides, not the saved type')
  assert.equal(stale.filter((row) => row.typeNote === `Saved as Unknown; the observed size and engine place the class under ${row.branch}`).length, 11, 'the 11 classes whose type the rule moves off Unknown are marked with the saved type and the branch the rule gives')
  assert.ok(stale.filter((row) => row.branch === 'Unknown').every((row) => row.typeNote === ''), 'and the 7 that are Unknown are not')

  const swapped = await everyClass(copyOf('swapped'))

  assert.deepEqual(branchOf(swapped), branchOf(intact), 'two classes saved under each other\'s type stay where the rule puts them')
  assert.deepEqual(swapped.filter((row) => row.typeNote).map((row) => [row.ClassName, row.typeNote]).sort(), [['Allman', 'Saved as Light Naval; the observed size and engine place the class under Military'], ['Micah', 'Saved as Military; the observed size and engine place the class under Light Naval']], 'and are marked')

  const limits = branchOf(await everyClass(copyOf('limits')))

  assert.deepEqual([limits.Allman, limits.Comigan, limits.Elric, limits.Hillman, limits.Manticore, limits.Nuernberg, limits.Berlin, limits.Unna, limits.Micah], ['Light Naval', 'Military', 'Military', 'Light Naval', 'Light Naval', 'Commercial', 'Light Naval', 'Unknown', 'Unknown'], 'at 20 hull spaces a class is Light Naval whatever its engine, just above it its engine decides, and a size of nothing leaves it to the engine')

  const unsaved = await everyClass(copyOf('unsaved'))
  const noSize = unsaved.find((row) => row.ClassName === 'Allman')
  const noEngine = unsaved.find((row) => row.ClassName === 'Berlin')
  const small = unsaved.find((row) => row.ClassName === 'Micah')

  assert.deepEqual([noSize.branch, noEngine.branch, small.branch], ['Unknown', 'Unknown', 'Light Naval'], 'a class with no saved size or engine is under Unknown, and one the size decides keeps its branch without the engine')
  assert.ok(/^Not placed: .*observed size.* not saved$/.test(noSize.typeNote) && /^Not placed: .*observed engine.* not saved$/.test(noEngine.typeNote) && small.typeNote === '', `the first two say what keeps them from a branch: ${noSize.typeNote} | ${noEngine.typeNote}`)

  const page = await pageOf(w, copyOf('intact'), PRECURSORS)
  const order = (rows) => rows.map((row) => `${row.branch}:${row.ClassName}`)
  const sorted = page.sortClasses(page.selectedClasses.slice().reverse(), ['branch'], [false])

  assert.deepEqual(sorted.map((row) => row.branch).filter((branch, index, all) => all.indexOf(branch) === index), ['Military', 'Commercial', 'Light Naval', 'Unknown'], 'the branches come in the game\'s order')
  assert.deepEqual(order(sorted.filter((row) => row.branch === 'Military')), order(sorted.filter((row) => row.branch === 'Military')).slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), 'and the classes of one branch by name')

  const bySize = page.sortClasses(page.selectedClasses.slice(), ['branch', 'TCS'], [false, true]).filter((row) => row.branch === 'Military')

  assert.deepEqual(bySize.map((row) => row.TCS), bySize.map((row) => row.TCS).slice().sort((a, b) => b - a), 'a column picked sorts inside each branch, here the size from the largest')
  assert.deepEqual(page.sortClasses(page.selectedClasses.slice(), ['branch', 'TCS'], [false, true]).map((row) => row.branch).filter((branch, index, all) => all.indexOf(branch) === index), ['Military', 'Commercial', 'Light Naval', 'Unknown'], 'and the branches keep their order')

  // The class cell of the page's own template: a class saved under another type shows the saved type beside its name, one saved under the type the rule gives shows nothing.
  const staleRows = await everyClass(copyOf('stale'))
  const cell = rendered(`<v-data-table :items="rows">${templateBlock(w.texts.intelligencePage, '<template #[`item.ClassName`]')}</v-data-table>`, { rows: [], engineType: (code) => `engine ${code}`, classRole: (code) => `role ${code}`, flagged: (result) => result })
  const classCell = treeOf(cell).find((node) => node.tag === 'v-data-table').data.scopedSlots['item.ClassName']
  const staleItem = staleRows.find((row) => row.branch === 'Military' && row.typeNote)

  assert.ok(staleItem, 'a class the rule places under Military is saved under another type in the stale copy')

  const intactItem = intact.find((row) => row.ClassName === staleItem.ClassName)
  const staleText = flat(classCell({ item: staleItem })).replace(/\s+/g, ' ')

  assert.ok(staleText.includes(`${staleItem.ClassName} `) && staleText.includes('Saved as Unknown; the observed size and engine place the class under Military'), `the cell shows the saved type beside the name: ${staleText}`)
  assert.ok(!/Saved as/.test(flat(classCell({ item: intactItem }))), 'a class saved under the type the rule gives shows no saved type')
  assert.deepEqual(treeOf(classCell({ item: staleItem })).filter((node) => node.tag === 'provenance-mark').map((node) => value(attrsOf(node).result).differs), [true], 'and the mark of the note carries the result that differs')
})

check('prisoners', 'the prisoners are read for the player\'s colonies only (a colony of another empire, a group of another game and of another race\'s prisoners never counted), the processed count is the sum over all the groups of the race and the rating one for each full 200 of it, held at 1, a race with none held a real 0 and a group with no saved count unavailable', async (w) => {
  const { intelligence: i } = await w.modules()

  for (const [plant, races] of [['held', [STARFARERS, PRECURSORS, KARACHI]], ['edges', [STARFARERS, PRECURSORS, KARACHI]], ['silent', [STARFARERS, PRECURSORS]]]) {
    const database = copyOf(plant)
    const rows = database.query(i.prisonersSql(GAME, RACE)).all()

    assert.deepEqual(rows.map((row) => row.AlienRaceID).sort(), [...races].sort(), `${plant}: one row for each race the player holds prisoners of`)

    for (const race of races) {
      const row = rows.find((entry) => entry.AlienRaceID === race)
      const wanted = oraclePrisoners(database, race)
      const result = i.prisonerRating(row)

      if (plant === 'edges' && race === KARACHI) {
        assert.equal(result.status, 'unavailable', 'a group with no saved processed count leaves the figure unavailable')
        assert.ok(missing(result).some((entry) => /processed/.test(entry)), 'and names it')

        continue
      }

      assert.deepEqual([row.Groups, row.Held, row.Processed, row.AtLimit], [wanted.groups, wanted.held, wanted.processed, wanted.atLimit], `${plant}, race ${race}: the groups, prisoners, processed and groups at the limit as the rows say`)
      assert.deepEqual([value(result).groups, value(result).held, value(result).processed, value(result).added], [wanted.groups, wanted.held, wanted.processed, Math.min(1, Math.floor(wanted.processed / 200))], `${plant}, race ${race}: the rating is one for each full 200 processed over all the groups, held at 1`)
      assert.equal(value(result).toNext, value(result).added ? 0 : 200 - wanted.processed, `${plant}, race ${race}: the prisoners still to process for it`)
    }
  }

  const held = copyOf('held').query(i.prisonersSql(GAME, RACE)).all()
  const starfarers = value(i.prisonerRating(held.find((row) => row.AlienRaceID === STARFARERS)))

  assert.deepEqual([starfarers.groups, starfarers.held, starfarers.processed, starfarers.added, starfarers.toNext, starfarers.atLimit], [2, 800, 199, 0, 1, 0], '199 processed adds nothing, and one more would; the colony of another empire and the group of another game are not counted')
  assert.equal(value(i.prisonerRating(held.find((row) => row.AlienRaceID === PRECURSORS))).added, 1, '399 processed adds 1, not 1.995: the division is whole')

  const edges = copyOf('edges').query(i.prisonersSql(GAME, RACE)).all()

  assert.equal(value(i.prisonerRating(edges.find((row) => row.AlienRaceID === STARFARERS))).added, 1, 'three groups of 150 add 1 together although none reaches 200')
  assert.deepEqual([value(i.prisonerRating(edges.find((row) => row.AlienRaceID === PRECURSORS))).added, value(i.prisonerRating(edges.find((row) => row.AlienRaceID === PRECURSORS))).atLimit], [1, 1], 'a group at exactly 200 adds 1 and is at the limit')

  const none = i.prisonerRating(undefined)

  assert.deepEqual(value(none), { groups: 0, held: 0, processed: 0, atLimit: 0, added: 0, toNext: 200 }, 'a race with no prisoner held is a real 0, not unavailable')
  assert.equal(copyOf('intact').query(i.prisonersSql(GAME, RACE)).all().length, 0, 'the fixture holds no prisoner, so the cases are planted')
  assert.equal(i.prisonerRating({ Groups: 2, Held: 10, HeldKnown: 1, Processed: 5, ProcessedKnown: 2, AtLimit: 0 }).status, 'estimated', 'the rating is an estimate of the rule, not compared with a saved attempt')
  assert.equal(value(i.prisonerRating({ Groups: 2, Held: 10, HeldKnown: 1, Processed: 5, ProcessedKnown: 2, AtLimit: 0 })).held, null, 'a group with no saved prisoner count leaves the held figure unknown, not 0')

  if (!NOTED.has('prisoners')) {
    NOTED.add('prisoners')
    console.log('NOTE  prisoners: the fixture holds no prisoner group (FCT_Prisoners is empty), so every case is planted from the game\'s rule; worked from the rule, not fixture-verified')
  }
})

check('rating', 'the ships with a working Diplomacy Module are read from planted ships as the rows say (a module wholly damaged not working, one of unknown damage unknown, a ship of another empire left out, a ship with no captain or a dead captain uncaptained, a captain with no Communications row at 1, a Communications row stored with no value unknown and never 1), the contact rating rows follow from them with the prisoners adding to a rating below 1 only, and a blocked Communications bonus leaves the captains\' rows out and names it', async (w) => {
  const { intelligence: i } = await w.modules()
  const database = copyOf('ships')
  const read = database.query(i.diplomacyShipsSql(GAME, RACE)).all()
  const wanted = oracleDiplomacy(database)

  assert.deepEqual(read.map((row) => ({ ShipID: row.ShipID, Working: row.Working, CaptainID: row.CaptainID, CaptainName: row.CaptainName, Communications: row.Communications, CommunicationsStored: row.CommunicationsStored })), wanted, 'the read gives each ship of the race with a Diplomacy Module, its modules left, captain and Communications as the rows say')
  assert.equal(read.length, 7, 'the original Astrid and the six planted ships, not the ship of the other empire')
  assert.deepEqual(read.filter((row) => row.Working === null).map((row) => row.ShipID), [HOLDERS.griffins[4]], 'a damage row with no number leaves the modules unknown')
  assert.deepEqual(read.filter((row) => row.Working === 0).map((row) => row.ShipID), [HOLDERS.griffins[3]], 'a module wholly damaged is not working')
  assert.deepEqual(read.filter((row) => row.CaptainID === null).map((row) => row.ShipID).sort(), [HOLDERS.griffins[2], HOLDERS.griffins[5]].sort(), 'a ship whose captain left the post, or died, has none')
  assert.equal(read.find((row) => row.ShipID === HOLDERS.griffins[0]).Communications, 1.4, 'the captain\'s Communications is read')
  assert.equal(read.find((row) => row.ShipID === HOLDERS.griffins[1]).Communications, null, 'a captain with no Communications row has none stored')
  assert.equal(copyOf('intact').query(i.diplomacyShipsSql(GAME, RACE)).all().length, 1, 'the fixture has one ship with a Diplomacy Module')

  const none = i.prisonerRating(undefined)
  const rated = (prisoner, blocked) => i.contactRatings(read, prisoner, blocked)
  const rowsOf = (result) => Object.fromEntries(value(result).rows.map((row) => [row.key, row.rating]))
  const original = wanted.find((row) => row.ShipID === 196330)
  const plain = rated(none)

  assert.deepEqual([value(plain).working, value(plain).crewed], [5, 3], 'five ships have a module working and three of them a captain')
  assert.deepEqual(Object.keys(rowsOf(plain)), ['none', 'bare', 'uncrewed', ...captainedKeys(wanted)], 'the rows are the two without a ship, one for the ships without a captain and one for each captain, the best bonus first')
  assert.equal(rowsOf(plain).none, 0, 'with no contact the rating is 0')
  assert.equal(rowsOf(plain).bare, 0.5, 'with contact and no diplomacy ship there 0.5')
  assert.equal(rowsOf(plain).uncrewed, 0.5, 'with a module and no captain 0.5')
  assert.equal(rowsOf(plain)[`ship:${HOLDERS.griffins[0]}`], 1.4, 'with a captain it is the captain\'s Communications')
  assert.equal(rowsOf(plain)[`ship:${HOLDERS.griffins[1]}`], 1, 'a captain with no Communications row counts 1')
  assert.equal(rowsOf(plain)['ship:196330'], original.Communications === null ? 1 : original.Communications, 'the original ship as stored')
  assert.ok(plain.assumptions.some((entry) => /no stored Communications row has the bonus 1/.test(entry)), 'and says it counted a missing row as 1')
  assert.ok(missing(plain).length === 0 || plain.inputs.missing.some((entry) => /Diplomacy Modules of 1 ship/.test(entry)), 'the ship of unknown damage is named')
  assert.ok(plain.inputs.missing.some((entry) => /the working Diplomacy Modules of 1 ship$/.test(entry)), `the ship whose modules are unknown is named: ${plain.inputs.missing.join(' | ')}`)

  const added = { ...rowsOf(rated(i.prisonerRating({ Groups: 1, Held: 500, HeldKnown: 1, Processed: 250, ProcessedKnown: 1, AtLimit: 1 }))) }

  assert.deepEqual([added.none, added.bare, added.uncrewed, added[`ship:${HOLDERS.griffins[0]}`], added[`ship:${HOLDERS.griffins[1]}`]], [1, 1, 1, 1.4, 1], 'with 200 processed the prisoners lift a rating below 1 to 1 and leave one above it as it is')

  const short = rowsOf(rated(i.prisonerRating({ Groups: 1, Held: 500, HeldKnown: 1, Processed: 199, ProcessedKnown: 1, AtLimit: 0 })))

  assert.deepEqual([short.none, short.bare], [0, 0.5], 'with 199 they add nothing')
  const blank = i.prisonerRating({ Groups: 1, Held: 1, HeldKnown: 1, Processed: null, ProcessedKnown: 0, AtLimit: 0 })
  const unsettled = rated(blank)
  const unsettledRows = Object.fromEntries(value(unsettled).rows.map((row) => [row.key, row]))
  const baseOf = (key) => unsettledRows[key].base

  assert.equal(blank.status, 'unavailable', 'prisoners with no saved processed count are unavailable')
  assert.deepEqual(unsettled.inputs.missing.filter((entry) => /prisoner/.test(entry)), ['the processed count of the prisoner groups'], 'and the rating says it lacks them, naming the input')

  for (const key of ['none', 'bare', 'uncrewed']) {
    assert.ok(baseOf(key) < 1, `${key} rests on the prisoners (a base of ${baseOf(key)})`)
    assert.equal(unsettledRows[key].rating, null, `${key}: a rating below 1 with prisoners of unknown count has no figure, not ${unsettledRows[key].rating}`)
    assert.deepEqual([(unsettledRows[key].result || {}).status, ((unsettledRows[key].result || {}).inputs || {}).missing], ['unavailable', ['the processed count of the prisoner groups']], `${key}: and says which input it lacks`)
  }

  for (const key of [`ship:${HOLDERS.griffins[0]}`, `ship:${HOLDERS.griffins[1]}`, 'ship:196330']) {
    assert.equal(unsettledRows[key].rating, unsettledRows[key].base, `${key}: a rating of 1 or more does not rest on the prisoners and stays`)
    assert.equal(unsettledRows[key].result, null, `${key}: and has no missing input`)
  }

  const edgeShips = [0.8, 1, 1.2].map((bonus, index) => ({ ShipID: 900 + index, ShipName: `Edge ${bonus}`, Working: 1, CaptainID: 800 + index, CaptainName: `Captain ${index}`, Communications: bonus }))
  const edge = value(i.contactRatings(edgeShips, blank)).rows.filter((row) => row.key.startsWith('ship:'))

  assert.deepEqual(edge.map((row) => [row.base, row.rating]), [[1.2, 1.2], [1, 1], [0.8, null]], 'at the edge a captain of 1 or 1.2 rates as it is and one of 0.8, below 1, has no figure')
  assert.deepEqual(value(i.contactRatings(edgeShips, none)).rows.filter((row) => row.key.startsWith('ship:')).map((row) => [row.base, row.rating, row.result]), [[1.2, 1.2, null], [1, 1, null], [0.8, 0.8, null]], 'with the prisoners known and none held every rating is its base and none lacks anything')

  // A captain whose Communications row is stored with no value: the row is there and the value is unknown, so the rating has no figure and names the value it lacks, while a captain with no row at all still counts 1.
  const unknownBonus = copyOf('nullBonus')
  const bonusRead = unknownBonus.query(i.diplomacyShipsSql(GAME, RACE)).all()
  const storedShip = bonusRead.find((row) => row.ShipID === HOLDERS.griffins[0])
  const absentShip = bonusRead.find((row) => row.ShipID === HOLDERS.griffins[1])
  const unknown = i.contactRatings(bonusRead, none)
  const unknownRows = Object.fromEntries(value(unknown).rows.map((row) => [row.key, row]))
  const storedRow = unknownRows[`ship:${HOLDERS.griffins[0]}`]
  const absentRow = unknownRows[`ship:${HOLDERS.griffins[1]}`]

  assert.deepEqual([storedShip.Communications, storedShip.CommunicationsStored], [null, 1], 'a Communications row stored with no value is read as present with no value')
  assert.deepEqual([absentShip.Communications, absentShip.CommunicationsStored], [null, 0], 'a captain with no Communications row at all is read as absent')
  assert.deepEqual([storedRow.base, storedRow.rating], [null, null], 'a stored row with no value has no base and no figure: the default 1 is not given to it')
  assert.deepEqual([(storedRow.result || {}).status, ((storedRow.result || {}).inputs || {}).missing], ['unavailable', [`the stored Communications bonus of captain ${storedShip.CaptainName}`]], 'and it names the value the row lacks')
  assert.deepEqual([absentRow.base, absentRow.rating, absentRow.result], [1, 1, null], 'a captain with no row at all still counts 1')
  assert.equal(unknownRows.none.rating, 0, 'the row without contact is as it is')
  assert.equal(unknownRows.bare.rating, 0.5, 'and so is the one with contact and no ship')
  assert.equal(unknownRows.uncrewed.rating, 0.5, 'and the one for a ship with no captain')
  assert.ok(unknown.assumptions.some((entry) => /no stored Communications row has the bonus 1/.test(entry)), 'the result says the missing row counts 1, which is not said of the unknown one')
  assert.deepEqual(unknown.inputs.missing.filter((entry) => /Communications bonus/.test(entry)), ['the stored Communications bonus of 1 captain'], 'and the rating names the unknown bonus among what it lacks')
  assert.deepEqual(value(unknown).unresolved.map((column) => [column.key, column.result.status]), [['bonus', 'unavailable']], 'one reason is given for the rating with no figure')
  assert.equal(value(unknown).unresolved[0].result.inputs.missing[0], 'the stored Communications bonus of 1 captain', 'and the column names it')

  const unknownWithBlank = i.contactRatings(bonusRead, blank)

  assert.deepEqual(value(unknownWithBlank).unresolved.map((column) => column.key), ['prisoners', 'bonus'], 'the prisoners of unknown count and the unknown bonus are told apart')

  const gated = rated(none, new Set([22]))

  assert.deepEqual(Object.keys(rowsOf(gated)), ['none', 'bare', 'uncrewed'], 'with the Communications bonus blocked no captain\'s row is given')
  assert.ok(gated.inputs.missing.some((entry) => /bonus 22, Communications/.test(entry)), 'and the bonus is named')
  assert.equal(value(gated).crewed, 3, 'the ships with a captain are still counted')
  assert.equal(rated(none, new Set([39])).inputs.missing.some((entry) => /bonus/.test(entry)), false, 'another blocked bonus changes nothing')
  assert.equal(Object.keys(rowsOf(i.contactRatings([], none))).join(), 'none,bare', 'with no ship there are the two rows')
})

check('outcome', 'what an attempt does at a roll and a rating is the game\'s cascade (100 or more establishes communication, a change of ten, five, three, two or one times the rating above 90, 80, 70, 50 and 25, minus one, two and three times above 0, -25 and -50, and -500 below), its wording the game\'s, every edge as the cascade reads it, and a change below -3 ends the attempts', async (w) => {
  const { intelligence: i } = await w.modules()
  const rolls = [-100, -75, -50.5, -50, -49.5, -30, -25.5, -25, -24.5, -1, 0, 0.5, 10, 25, 25.5, 40, 50, 50.5, 60, 70, 70.5, 75, 80, 80.5, 85, 90, 90.5, 95, 99.5, 99.99, 100, 100.5, 150]
  const ratings = [0.5, 1, 1.05, 1.25, 1.4, 1.5]

  for (const rating of ratings) {
    for (const roll of rolls) {
      const result = i.attemptOutcome(roll, rating)
      const label = `roll ${roll}, rating ${rating}`

      if (roll >= 100) {
        assert.deepEqual([value(result).established, value(result).change, value(result).impossible], [true, null, false], `${label} establishes communication`)

        continue
      }

      const change = oracleChange(roll, rating)
      const wording = oracleWording(change)

      assert.ok(near(value(result).change, change), `${label}: the change is ${change}, not ${value(result).change}`)
      assert.deepEqual([value(result).established, value(result).impossible, value(result).wording], [false, wording === null, wording === null ? 'communication impossible' : wording], `${label}: the wording is the game's`)
    }
  }

  assert.deepEqual(['>= 100 is 100.0', 99.999].map((roll) => typeof roll === 'number' && value(i.attemptOutcome(roll, 1)).established), [false, false], 'a roll under 100 does not establish it')
  assert.equal(value(i.attemptOutcome(-50, 1)).impossible, true, 'a roll of -50 or less ends the attempts')
  assert.equal(value(i.attemptOutcome(-49.5, 1.4)).impossible, true, 'a change of -3 times a rating of 1.4 is -4.2, below -3, and ends them')
  assert.equal(value(i.attemptOutcome(-49.5, 1)).impossible, false, 'at a rating of 1 the same roll is -3 and does not')
  assert.equal(i.attemptOutcome(null, 1).status, 'unavailable', 'no roll, no outcome')
  assert.equal(i.attemptOutcome(50, null).status, 'unavailable', 'no rating, no outcome')
  assert.deepEqual(missing(i.attemptOutcome(null, null)), ['the roll', 'the contact rating'], 'both missing are named')

  const words = [[10, 'significant progress'], [9.99, 'moderate progress'], [5, 'moderate progress'], [4.99, 'minor progress'], [3, 'minor progress'], [2, 'limited progress'], [1, 'minimal progress'], [0.5, 'glacial progress'], [0, 'glacial progress'], [-0.5, 'no progress; the contact team is struggling to make a breakthrough'], [-1, 'no progress; the contact team is struggling to make a breakthrough'], [-2, 'no progress; the contact team has begun to consider that communication may prove impossible'], [-3, 'no progress; the contact team is advising that communication may prove impossible'], [-3.01, null]]

  for (const [change, wording] of words) {
    assert.equal(i.attemptWording(change), wording, `a change of ${change} is worded ${wording}`)
  }

  for (const rating of [0.5, 1, 1.4]) {
    const rows = i.attemptRows(rating)

    assert.deepEqual(rows.map((row) => row.label), ['100 or more', 'Above 90, below 100', 'Above 80, up to 90', 'Above 70, up to 80', 'Above 50, up to 70', 'Above 25, up to 50', 'Above 0, up to 25', 'Above -25, up to 0', 'Above -50, up to -25', '-50 or less'], 'the bands of the roll, the best first')
    const changes = rows.map((row) => (value(row.outcome).established || value(row.outcome).impossible ? null : value(row.outcome).change))
    const wantedChanges = [null, 10, 5, 3, 2, 1, -1, -2, -3, null].map((factor) => (factor === null || factor * rating < -3 ? null : factor * rating))

    assert.deepEqual(changes.map((change) => change === null), wantedChanges.map((change) => change === null), `the bands that give a change at ${rating}`)
    assert.ok(changes.every((change, index) => change === null || near(change, wantedChanges[index])), `the change of each band at ${rating}: ${changes.join(', ')}`)
    assert.equal(value(rows[0].outcome).established, true, 'the first band establishes communication')
    assert.equal(value(rows[rows.length - 1].outcome).impossible, true, 'the last ends the attempts')
  }
})

check('communication', 'the page\'s own script shows beside the communication of a race that is not established the prisoners processed and the rating they add (and nothing for a race with none held or one that is established), the panel of the selected race with the prisoners held and processed, the rows of the contact rating from the ships and the bands of the roll at the lowest and the highest rating, and no panel for a race in communication; a blocked Communications bonus leaves the captains\' rows out', async (w) => {
  const rowOf = (page, id) => page.rows.find((row) => row.AlienRaceID === id)
  const held = await pageOf(w, copyOf('held'), STARFARERS)

  assert.equal(rowOf(held, STARFARERS).prisonerText, '199 prisoners processed: adds nothing to the contact rating yet', 'the Starfarers: 199 processed, which add nothing')
  assert.equal(rowOf(held, PRECURSORS).prisonerText, '399 prisoners processed: adds 1 to the contact rating', 'the Precursors: 399 processed add 1')
  assert.equal(rowOf(held, KARACHI).prisonerText, '', 'the Karachi Federation are in communication, so nothing')
  assert.equal(rowOf(held, KARACHI).communication, 'Communication established', 'as its communication says')

  const intact = await pageOf(w, copyOf('intact'), STARFARERS)

  assert.ok(intact.rows.every((row) => row.prisonerText === ''), 'with no prisoner held no race shows any')
  assert.ok(isAvailableResult(rowOf(intact, STARFARERS).prisonerResult) && rowOf(intact, STARFARERS).prisonerResult.value.groups === 0, 'a race with none held is a real 0')

  const silent = await pageOf(w, copyOf('silent'), PRECURSORS)

  assert.equal(rowOf(silent, PRECURSORS).communication, 'No communication', 'the Precursors have none at all')
  assert.equal(rowOf(silent, PRECURSORS).prisonerText, '80 prisoners processed: would add nothing yet to the contact rating of an attempt, and no attempt is running', 'and still show what is processed, saying that no attempt is running')
  assert.equal(rowOf(silent, STARFARERS).prisonerText, '400 prisoners processed: adds 1 to the contact rating', '400 processed add 1, and no more')

  const panel = held.attempt
  const label = (name) => factOf(panel.facts, name)

  assert.deepEqual(panel.facts.map((fact) => fact.label), ['Translation progress', 'Prisoners held', 'Prisoners processed', 'Rating from the prisoners', 'Ships with a working Diplomacy Module'], 'the facts of the panel')
  assert.equal(label('Translation progress').value, '0', 'the translation progress as stored')
  assert.equal(label('Prisoners held').value, '800 in 2 groups', 'the Starfarers\' prisoners on the player\'s colonies')
  assert.equal(label('Prisoners processed').value, '199', 'processed, none at the limit')
  assert.equal(label('Rating from the prisoners').value, 'Nothing yet: 1 more processed adds 1', 'what is still wanted')
  assert.equal(label('Ships with a working Diplomacy Module').value, '1 (1 with a captain)', 'the fixture\'s one diplomacy ship')
  assert.deepEqual(panel.ratings.map((row) => row.key), ['none', 'bare', 'ship:196330'], 'the rows: no contact, contact, the one ship')

  const precursors = (await pageOf(w, copyOf('held'), PRECURSORS)).attempt

  assert.equal(factOf(precursors.facts, 'Rating from the prisoners').value, '+1, the most they add', 'the Precursors\' prisoners add 1')
  assert.equal(factOf(precursors.facts, 'Prisoners processed').value, '399, 1 group at the limit of 200', 'with the group at the limit')
  assert.ok(precursors.ratings.every((row) => (row.base < 1 ? row.rating === 1 : row.rating === row.base)), 'a rating below 1 is lifted to 1 and one above is as it is')
  assert.deepEqual(precursors.columns.map((column) => column.rating), [...new Set(precursors.ratings.map((row) => row.rating).filter((rating) => rating > 0))].sort((a, b) => a - b).filter((_rating, index, all) => index === 0 || index === all.length - 1), 'the bands are shown at the lowest and the highest rating')
  assert.equal(precursors.bands.length, 10, 'ten bands of the roll')
  assert.ok(precursors.bands.every((band) => band.cells.length === precursors.columns.length), 'each with a cell for each rating')
  assert.equal(precursors.bands[0].cells[0], 'Communication established', 'the first band establishes communication')
  assert.equal(precursors.bands[1].cells[0], `+${10 * precursors.columns[0].rating}: significant progress`, 'the next is ten times the rating')

  const ships = await pageOf(w, copyOf('ships'), STARFARERS)
  const crews = ships.attempt.ratings

  assert.deepEqual(crews.map((row) => row.key), ['none', 'bare', 'uncrewed', ...captainedKeys(oracleDiplomacy(copyOf('ships')))], 'the planted ships give their rows')
  assert.equal(crews.find((row) => row.key === `ship:${HOLDERS.griffins[1]}`).rating, 1, 'a captain with no Communications row rates 1')
  assert.equal(crews.find((row) => row.key === `ship:${HOLDERS.griffins[0]}`).rating, 1.4, 'a captain with a bonus of 1.4 rates 1.4')
  assert.deepEqual(ships.attempt.columns.map((column) => column.rating), [0.5, 1.4], 'the bands are shown at 0.5 and 1.4')
  assert.deepEqual(ships.attempt.bands.map((band) => band.cells[0]), ['Communication established', '+5: moderate progress', '+2.5: limited progress', '+1.5: minimal progress', '+1: minimal progress', '+0.5: glacial progress', '\u22120.5: no progress; the contact team is struggling to make a breakthrough', '\u22121: no progress; the contact team is struggling to make a breakthrough', '\u22121.5: no progress; the contact team has begun to consider that communication may prove impossible', 'Communication impossible'], 'what an attempt does in each band at the rating 0.5')
  assert.deepEqual(ships.attempt.bands.map((band) => band.cells[1]), ['Communication established', '+14: significant progress', '+7: moderate progress', '+4.2: minor progress', '+2.8: limited progress', '+1.4: minimal progress', '\u22121.4: no progress; the contact team has begun to consider that communication may prove impossible', '\u22122.8: no progress; the contact team is advising that communication may prove impossible', 'Communication impossible', 'Communication impossible'], 'and at the rating 1.4')
  assert.equal(ships.attempt.columns.length, 2, 'the lowest and the highest rating are two columns')
  assert.equal(ships.attempt.columns[1].rating, Math.max(1.4, ...crews.map((row) => row.rating)), 'the highest is the best captain\'s')
  assert.equal(factOf(ships.attempt.facts, 'Ships with a working Diplomacy Module').value, '5 (3 with a captain)', 'five ships have a working module, three a captain')

  const blocked = await pageOf(w, copyOf('ships'), STARFARERS, [22])

  assert.deepEqual(blocked.attempt.ratings.map((row) => row.key), ['none', 'bare', 'uncrewed'], 'with the Communications bonus blocked the page gives no captain\'s row')

  const established = await pageOf(w, copyOf('held'), KARACHI)

  assert.equal(established.attempt, null, 'a race in communication has no panel')

  const card = cardText(w.texts.intelligencePage, held)
  const preCard = cardText(w.texts.intelligencePage, await pageOf(w, copyOf('held'), PRECURSORS))

  assert.ok(/^Communication attempt\s*Attempts running\s*Translation progress\s*0\s*Prisoners held\s*800 in 2 groups\s*Prisoners processed\s*199\s*Rating from the prisoners\s*Nothing yet: 1 more processed adds 1\s*Ships with a working Diplomacy Module\s*1 \(1 with a captain\)\s*Contact rating when\s*Rating\s*The two races detect nothing/.test(card), `the card draws the facts and the rating table: ${card.slice(0, 400)}`)
  assert.ok(/At rating 0\.5.*Above 90, below 100\s*\+5: moderate progress/.test(card) && /100 or more\s*Communication established/.test(card) && /-50 or less\s*Communication impossible/.test(card), `and the bands of the roll: ${card.slice(300, 900)}`)
  assert.ok(!/and the prisoners'/.test(card), 'with 199 processed no rating row says the prisoners add anything')
  assert.ok(/The two races detect nothing of each other in a system in common\s*1 \(0 and the prisoners' 1, held at 1\)/.test(preCard), `with 399 processed the first row says what the prisoners add: ${preCard.slice(0, 700)}`)
  assert.ok(/Use it to see how an attempt at communication with the selected race stands and what the prisoners add to it\./.test(card), 'and the foot')

  const unavailableHeld = await pageOf(w, copyOf('edges'), KARACHI)

  assert.equal(rowOf(unavailableHeld, KARACHI).prisonerText, '', 'established, so no prisoners shown even where a count is not saved')

  const none = await pageOf(w, copyOf('edges'), STARFARERS)

  assert.equal(rowOf(none, STARFARERS).prisonerText, '450 prisoners processed: adds 1 to the contact rating', 'three groups of 150 show 450 and 1')

  // Prisoners of unknown count: a rating below 1 has no figure, in its row and in a column of the bands that says so, and a rating of 1 or more keeps its figure.
  const blank = await pageOf(w, copyOf('blank', 'ships'), STARFARERS)
  const unsure = blank.attempt
  const lacking = ['the processed count of the prisoner groups']
  const byKey = Object.fromEntries(unsure.ratings.map((row) => [row.key, row]))
  const knownBases = oracleDiplomacy(copyOf('blank', 'ships')).filter((ship) => ship.Working > 0 && ship.CaptainID !== null).map((ship) => (ship.Communications === null ? 1 : ship.Communications)).filter((base) => base >= 1)
  const unsureMarks = cardMarks(w.texts.intelligencePage, blank).filter((result) => result.status === 'unavailable' && result.rule.id === 'intelligence.contactRating')
  const unsureCard = cardText(w.texts.intelligencePage, blank)

  assert.equal(rowOf(blank, STARFARERS).prisonerText, 'Prisoners processed: —', 'the races table gives no figure for prisoners of unknown count')
  assert.equal(unsure.active, true, 'the Starfarers are attempting')
  assert.deepEqual(['Prisoners held', 'Prisoners processed', 'Rating from the prisoners'].map((name) => factOf(unsure.facts, name).value), ['—', '—', '—'], 'the prisoner facts have no figure')
  assert.deepEqual(['none', 'bare', 'uncrewed'].map((key) => [byKey[key].rating, (byKey[key].result || {}).status, ((byKey[key].result || {}).inputs || {}).missing]), [[null, 'unavailable', lacking], [null, 'unavailable', lacking], [null, 'unavailable', lacking]], 'a rating below 1 has no figure and names the input it lacks')
  assert.deepEqual([`ship:${HOLDERS.griffins[0]}`, `ship:${HOLDERS.griffins[1]}`].map((key) => [byKey[key].rating, byKey[key].result]), [[1.4, null], [1, null]], 'a rating of 1 or more keeps its figure')
  assert.deepEqual(unsure.columns.map((column) => column.rating), [...new Set([Math.min(...knownBases), Math.max(...knownBases)]), null], 'the bands are given at the lowest and the highest rating that has a figure, and in a last column with none')
  assert.deepEqual(unsure.columns.map((column) => column.result === null), [...new Set([Math.min(...knownBases), Math.max(...knownBases)])].map(() => true).concat(false), 'which alone carries what it lacks')

  const last = unsure.columns.length - 1

  assert.deepEqual(unsure.bands.map((band) => band.cells[last]), new Array(10).fill('—'), 'no outcome is given in the column that rests on the prisoners, not even the roll that establishes communication')
  assert.ok(unsure.bands.every((band) => band.results.slice(0, last).every((result) => result === null) && (band.results[last] || {}).status === 'unavailable' && ((band.results[last] || {}).inputs || { missing: [] }).missing[0] === lacking[0]), 'each of its cells names the input')
  assert.deepEqual(unsure.bands.map((band) => band.cells[last - 1]).slice(0, 3), ['Communication established', '+14: significant progress', '+7: moderate progress'], 'and the column of the best rating that has a figure, 1.4, is as it is with prisoners known')
  assert.equal(unsureMarks.length, 3 + 1 + 10, `the three rating rows, the header and the ten cells of that column each carry a mark that names the input: ${unsureMarks.length}`)
  assert.ok(/The two races detect nothing of each other in a system in common\s*—\s*They do, and no ship with a working Diplomacy Module is there\s*—/.test(unsureCard) && /At a rating that rests on the prisoners/.test(unsureCard), `and the card draws a dash for them: ${unsureCard.slice(250, 700)}`)
  assert.equal(cardMarks(w.texts.intelligencePage, held).filter((result) => result.status === 'unavailable' && result.rule.id === 'intelligence.contactRating').length, 0, 'with the prisoners known no mark of the kind is drawn')

  // A captain's Communications row stored with no value: the page gives that captain no rating and draws a column of the roll that says so, while the captain with no row at all keeps 1, and the cells of the unknown column have no outcome.
  const nullBonus = await pageOf(w, copyOf('nullBonus'), STARFARERS)
  const unknownPanel = nullBonus.attempt
  const unknownByKey = Object.fromEntries(unknownPanel.ratings.map((row) => [row.key, row]))
  const unknownLacking = 'the stored Communications bonus of 1 captain'

  assert.equal(unknownByKey[`ship:${HOLDERS.griffins[0]}`].rating, null, 'the captain whose Communications row holds no value has no rating')
  assert.equal(unknownByKey[`ship:${HOLDERS.griffins[1]}`].rating, 1, 'the captain with no such row at all still rates 1')
  assert.deepEqual(unknownPanel.columns.map((column) => [column.rating, column.label]), [[0.5, 'At rating 0.5'], [1, 'At rating 1'], [null, 'At a rating that rests on a Communications bonus that is not saved']], 'the bands are given at the lowest and the highest rating that has a figure, and in a last column that says which input it lacks')
  assert.equal((unknownPanel.columns[2].result || { inputs: { missing: [] } }).inputs.missing[0], unknownLacking, 'and that column names the unknown bonus')

  const unknownLast = unknownPanel.columns.length - 1

  assert.deepEqual(unknownPanel.bands.map((band) => band.cells[unknownLast]), new Array(10).fill('—'), 'no outcome is given at the unknown bonus, not even the roll that establishes communication')
  assert.ok(unknownPanel.bands.every((band) => (band.results[unknownLast] || {}).status === 'unavailable' && ((band.results[unknownLast] || {}).inputs || { missing: [] }).missing[0] === unknownLacking), 'each of its cells names the input')
  assert.deepEqual(unknownPanel.bands.map((band) => band.cells[0]).slice(0, 3), ['Communication established', '+5: moderate progress', '+2.5: limited progress'], 'the column of the lowest rating that has a figure, 0.5, is as it is')

  const unknownCard = cardText(w.texts.intelligencePage, nullBonus)

  assert.ok(/At a rating that rests on a Communications bonus that is not saved/.test(unknownCard), `the card draws that column: ${unknownCard.slice(0, 700)}`)
  assert.equal(cardMarks(w.texts.intelligencePage, nullBonus).filter((result) => result.status === 'unavailable' && result.rule.id === 'intelligence.contactRating').length, 1 + 1 + 10, 'the rating row, the header and the ten cells of that column each carry a mark that names the input')

  // The statuses the game runs no attempt for: the prisoners stay and no rating or roll is given.
  const inactive = async (copy, race) => (await pageOf(w, copy, race)).attempt
  const stated = copyOf('states')
  const noComm = await inactive(copyOf('silent'), PRECURSORS)
  const impossible = await inactive(stated, PRECURSORS)
  const unnamed = await inactive(stated, STARFARERS)
  const attempting = (await pageOf(w, copyOf('held'), STARFARERS)).attempt

  assert.deepEqual([attempting.active, attempting.notice], [true, ''], 'the status Attempting communication runs attempts and has no notice')

  for (const [name, panel] of [['no communication', noComm], ['impossible', impossible], ['a status the game does not name', unnamed]]) {
    assert.equal(panel.active, false, `${name}: no attempt runs`)
    assert.deepEqual([panel.ratings, panel.columns, panel.bands], [[], [], []], `${name}: no rating, column or roll is given for an attempt that does not run`)
    assert.deepEqual(panel.facts.map((fact) => fact.label), ['Prisoners held', 'Prisoners processed', 'Rating the prisoners would add'], `${name}: the prisoners stay`)
  }

  assert.equal(noComm.notice, 'No attempt is running: the status is No communication. The game runs attempts only while the status is Attempting communication, which the Diplomacy window sets from no communication.', 'no communication: the notice says the game runs none and how one starts')
  assert.equal(impossible.notice, 'No attempt is running: communication is impossible. The game runs attempts only while the status is Attempting communication and starts none for a race whose communication is impossible.', 'impossible: the notice says none is started')
  assert.equal(unnamed.notice, 'No attempt is running: the status is Status 9. The game runs attempts only while the status is Attempting communication.', 'a status the game does not name: the notice says the game runs none')
  assert.deepEqual(noComm.facts.map((fact) => fact.value), ['250 in 1 group', '80', 'Nothing yet: 120 more processed adds 1'], 'no communication: the prisoners as held')
  assert.deepEqual(impossible.facts.map((fact) => fact.value), ['600 in 1 group', '399, 1 group at the limit of 200', '+1, the most they add'], 'impossible: the prisoners as held')
  assert.deepEqual(unnamed.facts.map((fact) => fact.value), ['600 in 1 group', '400, 1 group at the limit of 200', '+1, the most they add'], 'and for the status the game does not name')

  const statesPage = await pageOf(w, stated, PRECURSORS)

  assert.equal(rowOf(statesPage, PRECURSORS).prisonerText, '399 prisoners processed: would add 1 to the contact rating of an attempt, and no attempt is running', 'the races table says no attempt runs for a race whose communication is impossible')
  assert.equal(rowOf(statesPage, STARFARERS).prisonerText, '400 prisoners processed: would add 1 to the contact rating of an attempt, and no attempt is running', 'and for the status the game does not name')
  assert.equal(rowOf(statesPage, KARACHI).prisonerText, '', 'and nothing for the race in communication')

  const impossibleCard = cardText(w.texts.intelligencePage, statesPage)

  assert.ok(/^Communication attempt\s*No attempt running\s*No attempt is running: communication is impossible\./.test(impossibleCard), `the card of a race whose communication is impossible says no attempt runs: ${impossibleCard.slice(0, 300)}`)
  assert.ok(/Prisoners processed\s*399, 1 group at the limit of 200\s*Rating the prisoners would add\s*\+1, the most they add/.test(impossibleCard), 'and keeps the prisoners')
  assert.ok(!/Contact rating when|At rating|Attempts running|Translation progress|Communication established/.test(impossibleCard), `and draws no rating, roll or running attempt: ${impossibleCard}`)
  assert.ok(/^Communication attempt\s*Attempts running\s*Translation progress/.test(unsureCard), 'while the card of an attempting race says attempts run')
})

check('capability', 'the registry no longer declares the saved type as read by another item, the page\'s reads name it and the prisoners and the ships as inputs of the route, a save without the saved type or the prisoners cannot give the page (the report is unsupported, naming the input and the field), and Communications is a gated bonus of the Intelligence page', async (w) => {
  const { capabilities: k } = await w.modules()
  const inputs = k.INPUTS['/intelligence']
  const named = (key) => inputs.find((entry) => entry.key === key)

  assert.ok(!k.DECLARED.some((entry) => entry.table === 'FCT_AlienClass' && entry.columns.includes('AlienClassType')), 'the registry does not declare the saved type as read later')
  assert.ok((named('classes').reads.FCT_AlienClass || []).includes('AlienClassType'), 'the classes read names FCT_AlienClass.AlienClassType')
  assert.ok((named('prisoners').reads.FCT_Prisoners || []).includes('NumProcessed') && (named('prisoners').reads.FCT_Prisoners || []).includes('PrisonerRaceID'), 'the prisoners read names FCT_Prisoners')
  assert.ok((named('diplomacyShips').reads.FCT_DamagedComponent || []).includes('Number') && (named('diplomacyShips').reads.FCT_CommanderBonuses || []).includes('BonusValue'), 'the ships read names the damage and the bonus')
  assert.equal(named('prisoners').optional || false, false, 'an ordinary input, not an optional one')
  assert.ok(!named('diplomacyShips').reads.FCT_Commander.includes('*'), 'the ships read names the columns of the commander it takes, none built by name')

  const whole = (await k.preflight(loaderOf(copyOf('intact')))).reports['/intelligence']

  assert.equal(whole.status, 'supported', `the fixture's Intelligence report is whole, not ${whole.status}`)

  for (const [name, key, field] of [['droppedType', 'classes', 'FCT_AlienClass.AlienClassType'], ['droppedPrisoners', 'prisoners', 'FCT_Prisoners.NumProcessed']]) {
    const report = (await k.preflight(loaderOf(copyOf(name)))).reports['/intelligence']

    assert.equal(report.status, 'unsupported', `a save without ${field} cannot give the page, not ${report.status}`)
    assert.ok(report.missing.some((entry) => entry.key === key && entry.fields.some((one) => one === field || one.startsWith(field.split('.')[0]))), `the report names the input ${key} and ${field}: ${JSON.stringify(report.missing.map((entry) => [entry.key, entry.fields]))}`)
  }

  assert.deepEqual(k.BONUS_NAMES[22].routes, ['/intelligence'], 'Communications is a bonus of the Intelligence page')
  assert.equal(k.BONUS_NAMES[22].name, 'Communications', 'by the name the save holds')
  assert.ok(k.BONUS_NAMES[39].routes.includes('/commanders') && k.BONUS_NAMES[39].name === 'Light Tactical', 'and Light Tactical of the Commanders page')

  const renamed = await k.preflight(loaderOf(copyOf('renamedBonus')))

  assert.notEqual(renamed.reports['/intelligence'].status, 'supported', 'a save whose Communications row is renamed no longer gives the page whole')
  assert.ok(k.blockedBonuses(renamed.gates).has(22), 'and the bonus is blocked')
  assert.ok(!k.blockedBonuses((await k.preflight(loaderOf(copyOf('intact')))).gates).has(22), 'a save that holds it as expected blocks nothing')
})

check('text', 'the class table is grouped by the branch under the game\'s own headings, the foots of the classes and the communication open with what they are for and state the limits of the rules in the impersonal voice with no release named, the input labels name the new reads, and the page help and the rule notes say the same', async (w) => {
  const text = w.texts.intelligencePage
  const { glossary: g, intelligence: i } = await w.modules()
  const table = text.slice(text.indexOf('<v-data-table v-if="selectedClasses.length"'), text.indexOf('>', text.indexOf('<v-data-table v-if="selectedClasses.length"')))

  assert.ok(/group-by="branch"/.test(table) && /:custom-sort="sortClasses"/.test(table), `the class table is grouped by the branch and sorted by the game's order: ${table.slice(0, 160)}`)

  const header = rendered(`<v-data-table :items="rows" group-by="branch">${templateBlock(text, '<template #[`group.header`]')}</v-data-table>`, { rows: [] })
  const slot = treeOf(header).find((node) => node.tag === 'v-data-table').data.scopedSlots['group.header']
  const shown = (group, items) => flat(slot({ group, items, headers: [1, 2, 3], isOpen: true, toggle: () => {} })).replace(/mdi-[\w-]+/g, ' ').replace(/\s+/g, ' ').trim()

  assert.equal(shown('Military', [1, 2]), 'Ship Classes - Military 2 classes', 'the group header carries the game\'s heading and the count')
  assert.equal(shown('Light Naval', [1]), 'Ship Classes - Light Naval 1 class', 'a branch of one class says class')

  const classes = footOf(text, '<div v-if="detailView === \'classes\'" class="panel-foot caption text--secondary">')
  const attempt = footOf(text, '<div class="panel-foot caption text--secondary">\n                Use it to see how an attempt at communication')

  assert.ok(/^Use it to see which branch of the game's class tree an observed class sits under/.test(classes), 'the classes foot opens with what the panel is for')
  assert.ok(/Light Naval when the observed size is above 0 and at most 20 hull spaces \(1,000 tons, the limit included\)/.test(classes), `it states the limit of the rule: ${classes}`)
  assert.ok(/otherwise Military for a military engine, Commercial for a commercial one and Unknown for any other engine or none seen/.test(classes), 'and the engines')
  assert.ok(/an active sensor contact raises the observed size to the largest seen, which makes a class of 20 hull spaces or fewer Light Naval whatever its designation/.test(classes) && /a kill raises the observed size to the hull's, which moves a Light Naval class above 20 hull spaces to Military/.test(classes), 'and the rules of observation')
  assert.ok(!/1000 tons|less than 1000/.test(classes), 'the forum\'s figure of 1000 tons is not used: the game says 20 hull spaces')
  assert.ok(/^Use it to see how an attempt at communication with the selected race stands/.test(attempt), 'the communication foot opens with what the panel is for')
  assert.ok(/add 1 for each full 200 processed, up to 1 in all/.test(attempt) && /A roll of 100 or more establishes communication/.test(attempt) && /a change below -3 ends the attempts/.test(attempt), `it states the rules: ${attempt}`)
  assert.ok(/is not saved, so the rating is listed by its sources/.test(attempt), 'and that the rating is shown by its sources, since where the races detect each other is not saved')
  assert.ok(/The game runs attempts only while the status is Attempting communication; with another status the panel keeps the prisoners and says that no attempt is running, and shows no rating or roll/.test(attempt), 'the communication foot says that only the status Attempting communication runs attempts and what the panel then shows')
  assert.ok(/Where the processed count of a prisoner group is not saved, a rating below 1 has no figure, since the prisoners could add nothing or 1 to it, and the roll column that rests on it has none either; a rating of 1 or more does not rest on the prisoners and stays/.test(attempt), 'and that a rating below 1 has no figure where the prisoners\' count is not saved')
  assert.ok(/The game saves that type with the class and works it out again only when it draws the window, so a saved type can lag behind what has been observed since: the classes are grouped by the type the size and engine give, and a class saved under another type is marked with the type it was saved as, beside its name, never left out/.test(classes), 'the classes foot says that the grouping is by the recomputed type and the saved type is shown beside it')

  for (const [name, words] of [['classes foot', classes], ['communication foot', attempt]]) {
    assert.ok(!/\b(I|we|you|your|our)\b/i.test(words), `the ${name} is in the impersonal voice`)
    assert.ok(!/\d+\.\d+\.\d+|\b[23]\.[01]\b/.test(words), `the ${name} names no release`)
  }

  const labels = text.slice(text.indexOf('const INPUT_LABELS = {'), text.indexOf('\n}', text.indexOf('const INPUT_LABELS = {')))

  assert.ok(/prisoners: 'the prisoners held'/.test(labels) && /diplomacyShips: 'the ships with a Diplomacy Module'/.test(labels), 'the page labels the new reads, so a failed one names it')

  const usage = g.PAGE_HELP['/intelligence'].usage.join(' ')

  assert.ok(/Classes are grouped into Military, Commercial, Light Naval and Unknown branches/.test(usage) && /a class saved under another type is marked/.test(usage), 'the page help names the branches')
  assert.ok(/Communication attempt appears for a race the player has not established communication with/.test(usage) && /the prisoners processed and the rating they add/.test(usage), 'and the communication panel')
  assert.ok(/while the status is Attempting communication, the only status the game runs attempts for/.test(usage) && /with another status it says that no attempt is running/.test(usage) && /A rating that rests on prisoners whose processed count is not saved has no figure/.test(usage), 'and that only the status Attempting communication runs attempts and that a rating resting on unknown prisoners has no figure')

  const rule = (id, note) => assert.ok(note.test(i.classType({ TCS: 5, EngineType: 1, AlienClassType: 3 }).rule.note), id)

  rule('the class rule\'s note states the limit', /above 0 and at most 20 hull spaces \(1,000 tons, the limit included\)/)
  assert.ok(/one for each full 200 processed, counted over all the race's groups of that race together/.test(i.prisonerRating(undefined).rule.note), 'the prisoner rule\'s note says how the 200 are counted')
  assert.ok(/a captain with no stored Communications row counts as 1/.test(i.contactRatings([], i.prisonerRating(undefined)).rule.note), 'the contact rule\'s note says how a missing bonus counts')
  assert.ok(/A change below -3 ends the attempts/.test(i.attemptOutcome(50, 1).rule.note), 'the outcome rule\'s note says when the attempts end')
  assert.ok(/The game runs an attempt only for a race whose communication status is Attempting communication/.test(i.attemptOutcome(50, 1).rule.note), 'the outcome rule\'s note says that only that status runs attempts')

  const outcomeAt = w.texts.intelligence.indexOf("registerRule({\n  id: 'intelligence.attemptOutcome'")
  const outcomeComment = w.texts.intelligence.slice(0, outcomeAt).trimEnd().split('\n').pop()

  assert.ok(outcomeAt > 0 && outcomeComment.startsWith('// The outcome rule: '), 'a comment above the outcome rule states it in plain words')
  for (const words of ['the game runs an attempt only for a race whose communication status is Attempting communication', 'the Diplomacy window starts one only from no communication', 'communication that is impossible is final']) {
    assert.ok(outcomeComment.includes(words), `the outcome comment states: ${words}`)
  }

  assert.ok(/A rating below 1 rests on what the prisoners add, so where a group's processed count is not saved such a rating is unavailable and names it/.test(i.contactRatings([], i.prisonerRating(undefined)).rule.note) && /a rating of 1 or more does not rest on the prisoners and stays as it is/.test(i.contactRatings([], i.prisonerRating(undefined)).rule.note), 'the contact rule\'s note says that a rating below 1 has no figure where the prisoners\' count is not saved')
  assert.ok(/so the page groups by the recomputed type and reads the saved type beside it: a class whose saved type differs is marked with it, never hidden/.test(i.classType({ TCS: 5, EngineType: 1, AlienClassType: 3 }).rule.note), 'the class rule\'s note says that the grouping is by the recomputed type and the saved type is read beside it')
  assert.ok(i.classType({ TCS: 5, EngineType: 1, AlienClassType: 3 }).rule.versions.join() === '3.2.x' && i.attemptOutcome(50, 1).rule.versions.join() === '3.2.x', 'each rule is registered for the line it was read from')
})

check('played', 'on the played 3.2.0 save, which has met no alien race, the class, prisoner and diplomacy-ship reads run and give nothing, the page shows no race, class or communication panel, the Intelligence report is whole, Communications is named as the save names it and is not blocked, and the captains hold it as a multiplier', async (w) => {
  if (!PLAYED_PRESENT) {
    console.log(`SKIP  played: ${PLAYED} is not present`)
    return
  }

  const { intelligence: i, capabilities: k } = await w.modules()
  const database = playedCopy()
  const count = (table, where) => database.query(`select count(*) as n from ${table} where ${where}`).get().n

  assert.equal(count('FCT_AlienClass', `GameID = ${PLAYED_GAME}`), 0, 'the save holds no observed class')
  assert.equal(count('FCT_AlienRace', `GameID = ${PLAYED_GAME}`), 0, 'no alien race')
  assert.equal(count('FCT_Prisoners', `GameID = ${PLAYED_GAME}`), 0, 'and no prisoner')
  assert.deepEqual(database.query(i.prisonersSql(PLAYED_GAME, PLAYED_RACE)).all(), [], 'the prisoner read runs and gives nothing')
  assert.deepEqual(database.query(i.diplomacyShipsSql(PLAYED_GAME, PLAYED_RACE)).all(), [], 'so does the read of the ships with a Diplomacy Module')

  const page = await pageOf(w, database, null, [], { game: PLAYED_GAME, race: PLAYED_RACE })

  assert.equal(page.rows.length, 0, 'the page lists no race')
  assert.equal(page.selectedClasses.length, 0, 'no class')
  assert.equal(page.attempt, null, 'and no communication panel')

  const preflight = await k.preflight(loaderOf(database))

  assert.equal(preflight.reports['/intelligence'].status, 'supported', `the Intelligence report of a played save is whole, not ${preflight.reports['/intelligence'].status}`)
  assert.ok(!k.blockedBonuses(preflight.gates).has(22), 'Communications is not blocked')

  const stored = database.query('select Description, Percentage from DIM_CommanderBonusType where BonusID = 22').get()

  assert.ok(k.BONUS_NAMES[22], 'the registry names the bonus')
  assert.equal(k.BONUS_NAMES[22].name, stored.Description, 'as the played save names it')
  assert.equal(k.BONUS_NAMES[22].percentage, stored.Percentage === 1, 'a multiplier as the save says')

  const held = database.query(`select count(*) as n, min(FCT_CommanderBonuses.BonusValue) as lowest from FCT_CommanderBonuses inner join FCT_Commander on FCT_Commander.CommanderID = FCT_CommanderBonuses.CommanderID where FCT_Commander.GameID = ${PLAYED_GAME} and FCT_Commander.RaceID = ${PLAYED_RACE} and FCT_CommanderBonuses.BonusID = 22`).get()

  assert.ok(held.n > 0, 'captains of the race hold it')
  assert.ok(held.lowest > 1, `as a multiplier above 1, the lowest ${held.lowest}`)
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'a class of exactly 20 hull spaces is not Light Naval', target: 'intelligence', from: 'else if (row.TCS > 0 && row.TCS <= LIGHT_NAVAL_SIZE) {', to: 'else if (row.TCS > 0 && row.TCS < LIGHT_NAVAL_SIZE) {', fails: ['type', 'page'] },
  { name: 'a size of nothing is Light Naval', target: 'intelligence', from: 'else if (row.TCS > 0 && row.TCS <= LIGHT_NAVAL_SIZE) {', to: 'else if (row.TCS <= LIGHT_NAVAL_SIZE) {', fails: ['type', 'page'] },
  { name: 'a class of up to 21 hull spaces is Light Naval', target: 'intelligence', from: 'export const LIGHT_NAVAL_SIZE = 20', to: 'export const LIGHT_NAVAL_SIZE = 21', fails: ['type', 'page'] },
  { name: 'a military engine is Commercial and a commercial one Military', target: 'intelligence', from: 'row.EngineType === MILITARY_ENGINE ? 2 : row.EngineType === COMMERCIAL_ENGINE ? 1 : 0', to: 'row.EngineType === MILITARY_ENGINE ? 1 : row.EngineType === COMMERCIAL_ENGINE ? 2 : 0', fails: ['type', 'fixture', 'page'] },
  { name: 'any other engine is Commercial', target: 'intelligence', from: 'row.EngineType === MILITARY_ENGINE ? 2 : row.EngineType === COMMERCIAL_ENGINE ? 1 : 0', to: 'row.EngineType === MILITARY_ENGINE ? 2 : 1', fails: ['type', 'fixture', 'page'] },
  { name: 'a class with no saved size is read as one of nothing', target: 'intelligence', from: 'if (!isNumber(row.TCS)) {', to: 'if (false) {', fails: ['type', 'page'] },
  { name: 'a class with no saved engine is read as Unknown', target: 'intelligence', from: '} else if (!isNumber(row.EngineType)) {', to: '} else if (false) {', fails: ['type', 'page'] },
  { name: 'a class saved under another type is not marked', target: 'intelligence', from: 'differs: stored === null ? null : stored !== type }', to: 'differs: stored === null ? null : false }', fails: ['type', 'page'] },
  { name: 'the differing saved type is not said in the result', target: 'intelligence', from: 'assumptions: value.differs ? [`The saved type is ${value.storedLabel}, as of the last time the game drew its window; the observed size and engine place the class under ${value.label}`] : [] })', to: 'assumptions: [] })', fails: ['type'] },
  { name: 'a branch the game draws first is drawn last', target: 'intelligence', from: 'export const CLASS_BRANCHES = [\'Military\', \'Commercial\', \'Light Naval\', \'Unknown\']', to: 'export const CLASS_BRANCHES = [\'Unknown\', \'Military\', \'Commercial\', \'Light Naval\']', fails: ['type', 'page'] },
  { name: 'the branch is the saved type\'s', target: 'intelligencePage', from: 'branch: classBranch(type),', to: 'branch: { 0: \'Unknown\', 1: \'Commercial\', 2: \'Military\', 3: \'Light Naval\' }[shipClass.AlienClassType] || \'Unknown\',', fails: ['page'] },
  { name: 'the classes read leaves the saved type out', target: 'intelligencePage', from: 'FCT_AlienClass.EngineType, FCT_AlienClass.AlienClassType, FCT_AlienClass.AlienClassRole', to: 'FCT_AlienClass.EngineType, FCT_AlienClass.AlienClassRole', fails: ['fixture', 'page'] },
  { name: 'the branches sort alphabetically', target: 'intelligencePage', from: 'CLASS_BRANCHES.indexOf(a.branch) - CLASS_BRANCHES.indexOf(b.branch)', to: 'a.branch.localeCompare(b.branch)', fails: ['page'] },
  { name: 'the classes of a branch ignore the column picked', target: 'intelligencePage', from: 'const sorted = keys.length ? this.sortNullLast(items, keys, sortDesc.slice(1)) :', to: 'const sorted = keys.length ? items.slice() :', fails: ['page'] },
  { name: 'the class table is not grouped', target: 'intelligencePage', from: 'item-key="AlienClassID" group-by="branch" :custom-sort="sortClasses"', to: 'item-key="AlienClassID" :custom-sort="sortNullLast"', fails: ['text'] },
  { name: 'the group header leaves the game\'s heading out', target: 'intelligencePage', from: '<span class="font-weight-medium">Ship Classes - {{ group }}</span>', to: '<span class="font-weight-medium">{{ group }}</span>', fails: ['text'] },
  { name: 'the rating is the processed over 200, not whole', target: 'intelligence', from: 'const added = Math.min(1, Math.floor(row.Processed / PRISONER_STEP))', to: 'const added = Math.min(1, row.Processed / PRISONER_STEP)', fails: ['prisoners', 'communication'] },
  { name: 'the prisoners add more than 1', target: 'intelligence', from: 'const added = Math.min(1, Math.floor(row.Processed / PRISONER_STEP))', to: 'const added = Math.floor(row.Processed / PRISONER_STEP)', fails: ['prisoners'] },
  { name: 'a group counts at 100 processed', target: 'intelligence', from: 'export const PRISONER_STEP = 200', to: 'export const PRISONER_STEP = 100', fails: ['prisoners', 'communication'] },
  { name: 'the processed count is the largest group\'s', target: 'intelligence', from: 'sum(FCT_Prisoners.NumProcessed) as Processed', to: 'max(FCT_Prisoners.NumProcessed) as Processed', fails: ['prisoners', 'communication'] },
  { name: 'the prisoners of every empire\'s colonies count', target: 'intelligence', from: ' and FCT_Population.RaceID = ${RaceID} group by', to: ' group by', fails: ['prisoners', 'communication'] },
  { name: 'the prisoners of another game count', target: 'intelligence', from: 'where FCT_Prisoners.GameID = ${GameID} and FCT_Population.GameID = ${GameID} and', to: 'where', fails: ['prisoners', 'communication'] },
  { name: 'the prisoners are not told apart by race', target: 'intelligence', from: 'group by FCT_Prisoners.PrisonerRaceID`', to: 'group by FCT_Prisoners.GameID`', fails: ['prisoners', 'communication'] },
  { name: 'a group with no saved count is counted as none', target: 'intelligence', from: '|| row.ProcessedKnown !== row.Groups ||', to: '||', fails: ['prisoners'] },
  { name: 'a race with no prisoner has no rating', target: 'intelligence', from: 'if (!row) {\n    return ofRule({ rule, value: { groups: 0, held: 0, processed: 0, atLimit: 0, added: 0, toNext: PRISONER_STEP }', to: 'if (!row) {\n    return unavailable({ rule, missing: [\'the prisoner groups\'] })\n  } else if (false) {\n    return ofRule({ rule, value: { groups: 0, held: 0, processed: 0, atLimit: 0, added: 0, toNext: PRISONER_STEP }', fails: ['prisoners', 'communication'] },
  { name: 'the held figure of a group with no saved count is 0', target: 'intelligence', from: 'held: row.HeldKnown === row.Groups && isNumber(row.Held) ? row.Held : null', to: 'held: row.Held', fails: ['prisoners'] },
  { name: 'the prisoners lower a rating that is above 1', target: 'intelligence', from: 'const withPrisoners = (base, added) => (base < 1 ? Math.min(1, roundRating(base + added)) : base)', to: 'const withPrisoners = (base, added) => Math.min(1, roundRating(base + added))', fails: ['rating', 'communication'] },
  { name: 'the prisoners add to every rating', target: 'intelligence', from: 'const withPrisoners = (base, added) => (base < 1 ? Math.min(1, roundRating(base + added)) : base)', to: 'const withPrisoners = (base, added) => base + added', fails: ['rating', 'communication'] },
  { name: 'a captain with no Communications row counts 0', target: 'intelligence', from: 'const bonusOf = (ship) => (isNumber(ship.Communications) ? ship.Communications : ship.CommunicationsStored === 1 ? null : 1)', to: 'const bonusOf = (ship) => (isNumber(ship.Communications) ? ship.Communications : 0)', fails: ['rating', 'communication'] },
  { name: 'a wholly damaged module still works', target: 'intelligence', from: 'isNumber(ship.Working) && ship.Working > 0)', to: 'isNumber(ship.Working))', fails: ['rating', 'communication'] },
  { name: 'a blocked Communications bonus is read anyway', target: 'intelligence', from: 'const gated = blocked.has(COMMUNICATIONS) && captained.length > 0', to: 'const gated = false', fails: ['rating', 'communication'] },
  { name: 'the page does not pass the blocked bonuses on', target: 'intelligencePage', from: 'contactRatings(this.diplomacyShips, prisoners, this.blockedBonuses)', to: 'contactRatings(this.diplomacyShips, prisoners)', fails: ['communication'] },
  { name: 'the damage of a module is not taken off', target: 'intelligence', from: 'max(FCT_ClassComponent.NumComponent - coalesce((select FCT_DamagedComponent.Number ${DIPLOMACY_DAMAGE}), 0), 0)', to: 'max(FCT_ClassComponent.NumComponent - 0, 0)', fails: ['rating', 'communication'] },
  { name: 'the ships of every empire count', target: 'intelligence', from: ' and FCT_Ship.RaceID = ${RaceID} and exists', to: ' and exists', fails: ['rating', 'communication'] },
  { name: 'a dead captain still commands', target: 'intelligence', from: ' and FCT_Commander.Deceased = 0 limit 1', to: ' limit 1', fails: ['rating', 'communication'] },
  { name: 'the Communications bonus is read from another row', target: 'intelligence', from: 'const COMMUNICATIONS = 22', to: 'const COMMUNICATIONS = 21', fails: ['rating', 'communication'] },
  { name: 'a roll of exactly 100 does not establish communication', target: 'intelligence', from: '} else if (roll >= ESTABLISHED_ROLL) {', to: '} else if (roll > ESTABLISHED_ROLL) {', fails: ['outcome'] },
  { name: 'a roll of exactly 90 is in the top band', target: 'intelligence', from: 'const band = ATTEMPT_BANDS.find((entry) => roll > entry.roll)', to: 'const band = ATTEMPT_BANDS.find((entry) => roll >= entry.roll)', fails: ['outcome'] },
  { name: 'the top band is five times the rating', target: 'intelligence', from: '{ roll: 90, factor: 10 }', to: '{ roll: 90, factor: 5 }', fails: ['outcome'] },
  { name: 'the band above 70 starts at 75', target: 'intelligence', from: '{ roll: 70, factor: 3 }', to: '{ roll: 75, factor: 3 }', fails: ['outcome'] },
  { name: 'a roll at -25 or below is -3 times the rating', target: 'intelligence', from: '{ roll: -25, factor: -2 }', to: '{ roll: -25, factor: -3 }', fails: ['outcome'] },
  { name: 'a roll of -50 or less is -5', target: 'intelligence', from: 'const FAILING_CHANGE = -500', to: 'const FAILING_CHANGE = -5', fails: ['outcome'] },
  { name: 'a change of 1 is limited progress', target: 'intelligence', from: '[1, \'minimal progress\']', to: '[1, \'limited progress\']', fails: ['outcome'] },
  { name: 'a change of -3 ends the attempts', target: 'intelligence', from: '[-3, \'no progress; the contact team is advising that communication may prove impossible\']', to: '[-2.5, \'no progress; the contact team is advising that communication may prove impossible\']', fails: ['outcome'] },
  { name: 'the change is not scaled by the rating', target: 'intelligence', from: 'const change = band ? roundRating(band.factor * rating) : FAILING_CHANGE', to: 'const change = band ? roundRating(band.factor) : FAILING_CHANGE', fails: ['outcome', 'communication'] },
  { name: 'the races table shows prisoners of a race in communication', target: 'intelligencePage', from: 'if (race.CommStatus === COMMUNICATION_ESTABLISHED) {\n        return \'\'\n      } else if', to: 'if (false) {\n        return \'\'\n      } else if', fails: ['communication'] },
  { name: 'the card leaves the bands of the roll out', target: 'intelligencePage', from: '<v-simple-table v-if="attempt.active && attempt.columns.length" dense class="communication-table">', to: '<v-simple-table v-if="false" dense class="communication-table">', fails: ['communication'] },
  { name: 'the rating rows do not say what the prisoners add', target: 'intelligencePage', from: ' ({{ rating(row.base) }} and the prisoners\' {{ rating(row.rating - row.base) }}, held at 1)', to: '', fails: ['communication'] },
  { name: 'the prisoners are looked up by the wrong key', target: 'intelligencePage', from: '[row.AlienRaceID, row]))', to: '[row.Groups, row]))', fails: ['communication'] },
  { name: 'the panel shows for a race in communication', target: 'intelligencePage', from: 'if (!race || race.CommStatus === COMMUNICATION_ESTABLISHED) {\n        return null', to: 'if (!race) {\n        return null', fails: ['communication'] },
  { name: 'the panel does not read the ships', target: 'intelligencePage', from: 'const ratings = contactRatings(this.diplomacyShips, prisoners, this.blockedBonuses)', to: 'const ratings = contactRatings([], prisoners, this.blockedBonuses)', fails: ['communication'] },
  { name: 'the bands are shown at one rating only', target: 'intelligencePage', from: '[Math.min(...rated), Math.max(...rated)]', to: '[Math.min(...rated)]', fails: ['communication'] },
  { name: 'the page does not label the new reads', target: 'intelligencePage', from: '  prisoners: \'the prisoners held\',\n  diplomacyShips: \'the ships with a Diplomacy Module\',\n', to: '', fails: ['text'] },
  { name: 'the classes foot gives the forum\'s figure', target: 'intelligencePage', from: 'at most 20 hull spaces (1,000 tons, the limit included)', to: 'under 1000 tons', fails: ['text'] },
  { name: 'the classes foot leaves out what a kill does', target: 'intelligencePage', from: '; and a kill raises the observed size to the hull\'s, which moves a Light Naval class above 20 hull spaces to Military.', to: '.', fails: ['text'] },
  { name: 'the communication foot leaves out where the races detect each other', target: 'intelligencePage', from: 'is not saved, so the rating is listed by its sources and not as one figure.', to: 'is not saved.', fails: ['text'] },
  { name: 'the communication foot says the attempts end at -4', target: 'intelligencePage', from: 'a change below -3 ends the attempts', to: 'a change below -4 ends the attempts', fails: ['text'] },
  { name: 'the communication foot speaks of the reader', target: 'intelligencePage', from: 'Use it to see how an attempt at communication with the selected race stands and what the prisoners add to it.', to: 'Use it to see how your attempt at communication with the selected race stands and what the prisoners add to it.', fails: ['text'] },
  { name: 'the page help leaves the branches out', target: 'glossary', from: ' Classes are grouped into Military, Commercial, Light Naval and Unknown branches as the game\\\'s own class tree draws them, and a class saved under another type is marked.', to: '', fails: ['text'] },
  { name: 'the class rule\'s note leaves out the limit', target: 'intelligence', from: 'Light Naval when the observed size is above 0 and at most 20 hull spaces (1,000 tons, the limit included), otherwise', to: 'Light Naval for a small class, otherwise', fails: ['text'] },
  { name: 'the registry declares the saved type as read by another item again', target: 'capabilities', from: 'export const DECLARED = Object.freeze([', to: 'export const DECLARED = Object.freeze([\n  Object.freeze({ item: \'AE-308-07\', readBy: \'AE-304-01\', table: \'FCT_AlienClass\', columns: Object.freeze([\'AlienClassType\']) }),', fails: ['capability'] },
  { name: 'Communications is not a gated bonus', target: 'capabilities', from: '  22: Object.freeze({ name: \'Communications\', percentage: true, routes: Object.freeze([\'/intelligence\'])', to: '  2222: Object.freeze({ name: \'Communications\', percentage: true, routes: Object.freeze([\'/intelligence\'])', fails: ['capability', ...WITNESS] },
  { name: 'the prisoners are an optional input of the Intelligence page', target: 'capabilities', from: '  \'/commanders\': (key) => key === \'navalTree\'', to: '  \'/intelligence\': (key) => key === \'prisoners\',\n  \'/commanders\': (key) => key === \'navalTree\'', fails: ['capability'] },
  { name: 'a rating below 1 with prisoners of unknown count is taken as the contact\'s part alone', target: 'intelligence', from: 'return known || row.base >= 1 ? {', to: 'return true ? {', fails: ['rating', 'communication'] },
  { name: 'a rating of 1 or more with prisoners of unknown count has no figure either', target: 'intelligence', from: 'return known || row.base >= 1 ?', to: 'return known ?', fails: ['rating', 'communication'] },
  { name: 'a rating with no figure names no input', target: 'intelligence', from: '{ ...row, rating: null, result: unsettled }', to: '{ ...row, rating: null, result: null }', fails: ['rating', 'communication'] },
  { name: 'a rating with no figure names another input', target: 'intelligence', from: 'unavailable({ rule, missing: prisoners.inputs.missing, present: prisoners.inputs.present })', to: 'unavailable({ rule, missing: [\'the contact rating\'], present: prisoners.inputs.present })', fails: ['rating', 'communication'] },
  { name: 'a stored Communications row with no value counts the default 1', target: 'intelligence', from: 'const bonusOf = (ship) => (isNumber(ship.Communications) ? ship.Communications : ship.CommunicationsStored === 1 ? null : 1)', to: 'const bonusOf = (ship) => (isNumber(ship.Communications) ? ship.Communications : 1)', fails: ['rating', 'communication'] },
  { name: 'the read does not say whether the Communications row is stored', target: 'intelligence', from: ' then 1 else 0 end as CommunicationsStored', to: ' then 1 else 0 end as CommunicationsRow', fails: ['rating', 'communication'] },
  { name: 'the row of an unknown bonus names no input', target: 'intelligence', from: 'return { ...row, rating: null, result: unavailable({ rule, missing: [`the stored Communications bonus of ${bonusOwner(row.ship)}`] }) }', to: 'return { ...row, rating: null, result: null }', fails: ['rating', 'communication'] },
  { name: 'the column of an unknown bonus is named as the prisoners\'', target: 'intelligence', from: 'label: \'At a rating that rests on a Communications bonus that is not saved\'', to: 'label: \'At a rating that rests on the prisoners\'', fails: ['communication'] },
  { name: 'the rating as a whole does not name the unknown bonus', target: 'intelligence', from: '...(bonusUnknown.length ? [`the stored Communications bonus of ${plural(bonusUnknown.length, \'captain\', \'captains\')}`] : []),', to: '', fails: ['rating'] },
  { name: 'the rating as a whole does not name the prisoners it lacks', target: 'intelligence', from: '...(known ? [] : prisoners.inputs.missing),', to: '', fails: ['rating'] },
  { name: 'the bands leave out the columns that rest on an input with no figure', target: 'intelligencePage', from: '...ratings.value.unresolved.map((column) => ({', to: '...[].map((column) => ({', fails: ['communication'] },
  { name: 'the column that rests on unknown prisoners is given outcomes', target: 'intelligencePage', from: 'result: column.result, rows: attemptRows(null) })),', to: 'result: column.result, rows: attemptRows(1) })),', fails: ['communication'] },
  { name: 'the cells of that column carry no mark', target: 'intelligencePage', from: 'results: columns.map((column) => column.result) }))', to: 'results: columns.map(() => null) }))', fails: ['communication'] },
  { name: 'the rating row of unknown prisoners draws no mark', target: 'intelligencePage', from: '<template v-if="row.rating === null">—<provenance-mark :result="row.result" /></template>', to: '<template v-if="row.rating === null">—</template>', fails: ['communication'] },
  { name: 'the cells of the roll bands draw no mark', target: 'intelligencePage', from: '{{ cell }}<provenance-mark v-if="band.results[index]" :result="band.results[index]" />', to: '{{ cell }}', fails: ['communication'] },
  { name: 'the header of that column draws no mark', target: 'intelligencePage', from: '<provenance-mark v-if="column.result" :result="column.result" /></th>', to: '</th>', fails: ['communication'] },
  { name: 'a race with no communication shows an attempt', target: 'intelligencePage', from: 'const active = race.CommStatus === ATTEMPTING_COMMUNICATION', to: 'const active = true', fails: ['communication'] },
  { name: 'a race whose communication is impossible shows an attempt', target: 'intelligencePage', from: 'const active = race.CommStatus === ATTEMPTING_COMMUNICATION', to: 'const active = race.CommStatus === ATTEMPTING_COMMUNICATION || race.CommStatus === COMMUNICATION_IMPOSSIBLE', fails: ['communication'] },
  { name: 'a status the game does not name shows an attempt', target: 'intelligencePage', from: 'const active = race.CommStatus === ATTEMPTING_COMMUNICATION', to: 'const active = race.CommStatus !== NO_COMMUNICATION && race.CommStatus !== COMMUNICATION_IMPOSSIBLE', fails: ['communication'] },
  { name: 'the rating table is drawn for an attempt that does not run', target: 'intelligencePage', from: '<v-simple-table v-if="attempt.active" dense class="communication-table">', to: '<v-simple-table v-if="true" dense class="communication-table">', fails: ['communication'] },
  { name: 'the notice that no attempt runs is not drawn', target: 'intelligencePage', from: '<div v-if="attempt.notice" class="panel-body caption warning--text">', to: '<div v-if="false" class="panel-body caption warning--text">', fails: ['communication'] },
  { name: 'the chip says attempts run whatever the status', target: 'intelligencePage', from: '{{ attempt.active ? \'Attempts running\' : \'No attempt running\' }}', to: '{{ \'Attempts running\' }}', fails: ['communication'] },
  { name: 'the races table says the prisoners add to an attempt that does not run', target: 'intelligencePage', from: 'return race.CommStatus === ATTEMPTING_COMMUNICATION ? ', to: 'return true ? ', fails: ['communication'] },
  { name: 'a panel with no attempt loses the prisoners', target: 'intelligencePage', from: 'notice: this.inactiveText(race), facts: prisonerFacts,', to: 'notice: this.inactiveText(race), facts: [],', fails: ['communication'] },
  { name: 'impossible communication is worded like no communication', target: 'intelligencePage', from: 'if (race.CommStatus === COMMUNICATION_IMPOSSIBLE) {', to: 'if (false) {', fails: ['communication'] },
  { name: 'the rating the prisoners would add is worded as one that applies', target: 'intelligencePage', from: 'label: active ? \'Rating from the prisoners\' : \'Rating the prisoners would add\'', to: 'label: \'Rating from the prisoners\'', fails: ['communication'] },
  { name: 'the communication foot leaves out which status runs attempts', target: 'intelligencePage', from: ' The game runs attempts only while the status is Attempting communication; with another status the panel keeps the prisoners and says that no attempt is running, and shows no rating or roll.', to: '', fails: ['text'] },
  { name: 'the communication foot leaves out the unknown prisoners', target: 'intelligencePage', from: ' Where the processed count of a prisoner group is not saved, a rating below 1 has no figure, since the prisoners could add nothing or 1 to it, and the roll column that rests on it has none either; a rating of 1 or more does not rest on the prisoners and stays.', to: '', fails: ['text'] },
  { name: 'the page help leaves out which status runs attempts', target: 'glossary', from: '; while the status is Attempting communication, the only status the game runs attempts for, it also shows', to: '; it also shows', fails: ['text'] },
  { name: 'the contact rule\'s note leaves out the unknown prisoners', target: 'intelligence', from: ' A rating below 1 rests on what the prisoners add, so where a group\\\'s processed count is not saved such a rating is unavailable and names it, and is never taken as the contact\\\'s part alone; a rating of 1 or more does not rest on the prisoners and stays as it is.', to: '', fails: ['text'] },
  { name: 'the outcome rule\'s note leaves out which status runs attempts', target: 'intelligence', from: ' The game runs an attempt only for a race whose communication status is Attempting communication; with any other status (none, impossible, established) no attempt runs and none of what follows applies.', to: '', fails: ['text'] },
  { name: 'the outcome comment leaves out which status runs attempts', target: 'intelligence', from: 'the game runs an attempt only for a race whose communication status is Attempting communication; ', to: '', fails: ['text'] },
  { name: 'the outcome comment leaves out the window and final status rules', target: 'intelligence', from: 'the Diplomacy window starts one only from no communication, and communication that is impossible is final', to: '', fails: ['text'] },
  { name: 'the class cell leaves out the saved type', target: 'intelligencePage', from: '<div v-if="item.typeNote" class="caption warning--text">', to: '<div v-if="false" class="caption warning--text">', fails: ['page'] },
  { name: 'the saved type is named as the rule\'s type', target: 'intelligencePage', from: '`Saved as ${result.value.storedLabel}', to: '`Saved as ${result.value.label}', fails: ['page'] },
  { name: 'the note leaves out the branch the rule gives', target: 'intelligencePage', from: '; the observed size and engine place the class under ${result.value.label}', to: '', fails: ['page'] },
  { name: 'the classes foot leaves out that the saved type lags', target: 'intelligencePage', from: ' The game saves that type with the class and works it out again only when it draws the window, so a saved type can lag behind what has been observed since: the classes are grouped by the type the size and engine give, and a class saved under another type is marked with the type it was saved as, beside its name, never left out.', to: ' A class saved under another type is marked with the type it was saved as.', fails: ['text'] },
  { name: 'the class rule\'s note says the page groups by the saved type', target: 'intelligence', from: 'so the page groups by the recomputed type and reads the saved type beside it', to: 'so the page groups by the saved type', fails: ['text'] },
]

// Rewrites that say the same thing: the limit tested the other way round, the rating's whole part taken after the cap, a flag test with its operands swapped, a band test written with a negation.
const BENIGN = [
  { name: 'the limit of 20 written with its operands swapped', target: 'intelligence', from: 'else if (row.TCS > 0 && row.TCS <= LIGHT_NAVAL_SIZE) {', to: 'else if (LIGHT_NAVAL_SIZE >= row.TCS && 0 < row.TCS) {' },
  { name: 'the whole part taken after the cap', target: 'intelligence', from: 'const added = Math.min(1, Math.floor(row.Processed / PRISONER_STEP))', to: 'const added = Math.floor(Math.min(PRISONER_STEP, row.Processed) / PRISONER_STEP)' },
  { name: 'the rating below 1 written the other way', target: 'intelligence', from: 'const withPrisoners = (base, added) => (base < 1 ?', to: 'const withPrisoners = (base, added) => (1 > base ?' },
  { name: 'the establishing roll written as a negation', target: 'intelligence', from: '} else if (roll >= ESTABLISHED_ROLL) {', to: '} else if (!(roll < ESTABLISHED_ROLL)) {' },
  { name: 'the unknown prisoner test with its operands swapped', target: 'intelligence', from: 'known || row.base >= 1 ?', to: 'row.base >= 1 || known ?' },
  { name: 'the attempting status test with its operands swapped', target: 'intelligencePage', from: 'const active = race.CommStatus === ATTEMPTING_COMMUNICATION', to: 'const active = ATTEMPTING_COMMUNICATION === race.CommStatus' },
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
