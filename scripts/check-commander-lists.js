/*
  Checks the commander lists of the Commanders page (src/renderer/pages/commanders.vue and utilities/commanders.js), the rank themes behind its rank names, and the naval administration shares of utilities/naval-admins.js and utilities/minerals.js: a retired commander restored to service, a commander rescued from a life pod, one captured from a foreign pod, the rank theme a race is given, the ship classes the specialist ship suggestions list, and the Light Tactical bonus a naval admin command passes down.

  Run: bun scripts/check-commander-lists.js [--no-mutations]

  The rules are the game's: restoring a commander (a restored commander is Active with health risk 1, a seniority one behind the others of the rank, and a history entry), rescuing survivors (a commander of the rescuing race found in a pod is rescued, not held: the flags stay as they were, the ship and pod pointers are cleared and a history entry is added; a commander of another race is captured: the prisoner flag is set, the processed flag cleared, the rescuing ship is the transport ship), the rank themes (the ranks a race is given are the rows of its theme in order: the naval names, abbreviations and priorities, and the ground ones counted apart, an empty abbreviation becoming R and the number), and a naval admin command's multiplier (the multiplier a command passes down is 1 plus the commander's bonus less 1 times the share of the command type, times its parent's, where the parent counts only if the child's own system is in the parent's range; the Light Tactical bonus takes the Tactical share, as the Tactical bonus does).
  - `table`: the table of the bonus and share pairs the game works with, every wrong pair refused by name, the command type column of each share in the save, and every caller in the source asking for a pair the table holds.
  - `admin`: on the interim 3.1 save (game 141, race 784) and the played 3.2 save (game 161, race 909) the commands carrying the Light Tactical bonus, the Tactical bonus and (as a control) the Mining bonus hold the stored value and the share of their command type, and the multiplier of every command at every system equals the game's recursion.
  - `lists`: the page's own roster, former and held reads, taken from its source and run on the saves and on planted copies, give the commanders of the race as the stored flags say: a retired commander in the former list and not the roster, restored in the roster and not the former list, a commander rescued from a pod of the own race in the roster and in neither other list, a commander captured from a foreign pod in the captor's held list with the processed flag clear and in the former list of the home race with the captor named, and the career entry of the capture.
  - `themes`: the ranks of every race in three saves are the ranks of one theme by the game's rule (26 of 27, the player race of the interim save holding its own), the page's rank names, abbreviations and levels are the stored ranks with the apostrophes intact, a planted theme keeps the roster whole, and the catalogue of themes is not read by the app.
  - `b024`: the ship class flag Commercial is stored on the fixture's harvester class and not on the survey class, and the page's ship rows and the specialist ship suggestions are the same whichever way it is set.
  - `text`: the Commanders page's footer says what the lists hold.

  The interim save holds no retired commander, no rescue, no capture and no theme change (every commander serving, every pod pointer empty), so those are planted into in-memory copies with the columns the game's loader reads (RetireStatus, Prisoner, Processed, HealthRisk, the transport ship, the pod pointer); the played save holds none either, so a stored case needs a game in which one happened. The ranks of 26 races and the commands of two saves are real stored witnesses.

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

const root = path.resolve(__dirname, '..')
const SAVES = {
  migrated: { file: 'saves/AuroraDB-310-spookyerol-migrated.db', GameID: 141, RaceID: 784 },
  played: { file: 'saves/AuroraDB-320-fetterkrolle-1.db', GameID: 161, RaceID: 909 },
  shipped: { file: 'saves/AuroraDB_310_shipped.db', GameID: null, RaceID: null },
}
const GAME = SAVES.migrated.GameID
const RACE = SAVES.migrated.RaceID
// The race the interim save's second foreign commander list is built from, and the classes of the harvesters and the survey ships.
const OTHER_RACE = 789
const HARVESTER_CLASS = 63048
const SURVEY_CLASS = 63083

const FILES = {
  navalAdmins: path.join(root, 'src', 'renderer', 'utilities', 'naval-admins.js'),
  minerals: path.join(root, 'src', 'renderer', 'utilities', 'minerals.js'),
  commanders: path.join(root, 'src', 'renderer', 'utilities', 'commanders.js'),
  commandersPage: path.join(root, 'src', 'renderer', 'pages', 'commanders.vue'),
}
const MODULES = { navalAdmins: 'naval-admins', minerals: 'minerals', commanders: 'commanders' }
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

// ---- The saves, as in-memory copies -----------------------------------------------------------------------------------
const present = (save) => fs.existsSync(path.join(root, SAVES[save].file))
const BYTES = new Map()
const COPIES = new Map()

const bytesOf = (save) => {
  if (!BYTES.has(save)) {
    BYTES.set(save, fs.readFileSync(path.join(root, SAVES[save].file)))
  }

  return BYTES.get(save)
}

// A copy of a save with the statements of one plant run on it, made in memory so that no file is written. `statements` is a function of the intact copy, so that a plant names rows the save holds.
const copyOf = (save, name = 'intact', statements = () => []) => {
  const key = `${save}:${name}`

  if (!COPIES.has(key)) {
    const database = Database.deserialize(bytesOf(save))

    statements(name === 'intact' ? database : copyOf(save)).forEach((statement) => database.run(statement))
    COPIES.set(key, database)
  }

  return COPIES.get(key)
}

const closeCopies = () => {
  COPIES.forEach((database) => database.close())
  COPIES.clear()
}

const loaderOf = (database) => ({ query: async (sql) => [database.query(sql).all()] })

const quote = (text) => `'${String(text).replace(/'/g, '\'\'')}'`

// ---- The rows the plants are built from, found in the intact interim copy ----------------------------------------------
const facts = memo(() => {
  const database = copyOf('migrated')
  const idle = database.query(`select FCT_Commander.CommanderID, FCT_Commander.RankID, FCT_Ranks.RankName from FCT_Commander inner join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID where FCT_Commander.GameID = ${GAME} and FCT_Commander.RaceID = ${RACE} and FCT_Commander.CommanderType = 0 and FCT_Commander.CommandType = 0 and FCT_Commander.RetireStatus = 0 and FCT_Commander.Prisoner = 0 order by FCT_Commander.CommanderID limit 2`).all()
  const captive = database.query(`select CommanderID from FCT_Commander where GameID = ${GAME} and RaceID = ${OTHER_RACE} and CommandType = 0 and RetireStatus = 0 and Prisoner = 0 order by CommanderID limit 1`).get()
  const ship = database.query(`select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_RaceSysSurvey.Name as SystemName from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Ship.RaceID where FCT_Ship.GameID = ${GAME} and FCT_Ship.RaceID = ${RACE} order by FCT_Ship.ShipID limit 1`).get()
  const time = database.query(`select GameTime from FCT_Game where GameID = ${GAME}`).get().GameTime
  const contact = database.query(`select AlienRaceName from FCT_AlienRace where GameID = ${GAME} and ViewRaceID = ${RACE} and AlienRaceID = ${OTHER_RACE}`).get().AlienRaceName
  const home = database.query(`select AlienRaceName from FCT_AlienRace where GameID = ${GAME} and ViewRaceID = ${OTHER_RACE} and AlienRaceID = ${RACE}`).get().AlienRaceName

  return { retiree: idle[0], rescued: idle[1], captive: captive.CommanderID, ship, time, contact, home }
})

const history = (id, text, time) => `insert into FCT_CommanderHistory (GameID, CommanderID, HistoryText, GameTime) values (${GAME}, ${id}, ${quote(text)}, ${time})`

// A commander retired and kept by the player (the status is set and the assignment cleared; the game saves a retired commander only when kept).
const retire = (id) => `update FCT_Commander set RetireStatus = 2, RetainRetired = 1, CommandType = 0, CommandID = 0 where CommanderID = ${id}`

// What restoring a commander stores: health risk 1, Active, a seniority one behind the other active commanders of the rank, and the history entry.
const restore = (person) => [`update FCT_Commander set HealthRisk = 1, RetireStatus = 0, Seniority = (select count(*) from FCT_Commander as VIR_Other where VIR_Other.GameID = ${GAME} and VIR_Other.RankID = ${person.RankID} and VIR_Other.RetireStatus = 0 and VIR_Other.CommanderID <> ${person.CommanderID}) + 1 where CommanderID = ${person.CommanderID}`, history(person.CommanderID, `Restored to ${person.RankName}`, facts().time)]

const PLANTS = {
  migrated: {
    intact: () => [],
    retired: ({ retiree }) => [retire(retiree.CommanderID)],
    restored: ({ retiree }) => [retire(retiree.CommanderID), ...restore(retiree)],
    // The commander of the rescuing race found in the pod: the pod and ship pointers cleared, the flags as they were, the history entry.
    rescued: ({ rescued, ship }) => [`update FCT_Commander set LifepodID = 0, TransportShipID = 0, CommandType = 0, CommandID = 0 where CommanderID = ${rescued.CommanderID}`, history(rescued.CommanderID, `Rescued from alien life pod in ${ship.SystemName}`, facts().time)],
    // The commander of another race: the prisoner flag set, the processed flag clear, the rescuing ship the transport ship, the history entry the rescuer's own name for the race.
    captured: ({ captive, ship, contact, time }) => [`update FCT_Commander set Prisoner = 1, Processed = 0, LifepodID = 0, TransportShipID = ${ship.ShipID}, CommandType = 0, CommandID = 0 where CommanderID = ${captive}`, history(captive, `Captured by ${contact}`, time)],
    commercial: () => [`update FCT_ShipClass set Commercial = 0 where ShipClassID = ${HARVESTER_CLASS}`, `update FCT_ShipClass set Commercial = 1 where ShipClassID = ${SURVEY_CLASS}`],
  },
}

const copyNamed = (name) => copyOf('migrated', name, () => PLANTS.migrated[name](facts()))

// ---- What the saves hold, in SQL written here --------------------------------------------------------------------------
const idsOf = (rows) => rows.map((row) => row.CommanderID).sort((a, b) => a - b)

const stored = (database, game, race) => ({
  roster: idsOf(database.query(`select CommanderID from FCT_Commander where GameID = ${game} and RaceID = ${race} and RetireStatus = 0 and Prisoner = 0`).all()),
  former: idsOf(database.query(`select CommanderID from FCT_Commander where GameID = ${game} and RaceID = ${race} and not (RetireStatus = 0 and Prisoner = 0)`).all()),
  held: idsOf(database.query(`select CommanderID from FCT_Commander where GameID = ${game} and RaceID <> ${race} and Prisoner = 1 and (TransportShipID in (select ShipID from FCT_Ship where RaceID = ${race}) or PopLocationID in (select PopulationID from FCT_Population where RaceID = ${race}))`).all()),
})

// The ranks of a race as the save stores them, { naval: [[name, abbreviation]], ground: [[name, abbreviation]] }, the highest rank first (priority 1).
const ranksOf = (database, race) => {
  const rows = database.query(`select RankType, RankName, RankAbbrev from FCT_Ranks where RaceID = ${race} order by RankType, Priority`).all()

  return { naval: rows.filter((row) => row.RankType === 0).map((row) => [row.RankName, row.RankAbbrev]), ground: rows.filter((row) => row.RankType === 1).map((row) => [row.RankName, row.RankAbbrev]) }
}

// The ranks the game builds for each theme and gives a race, in the game's order: a row with a naval name makes the next naval rank, a row with a ground name the next ground rank, an empty abbreviation becoming R and the rank's number.
const themesOf = (database) => {
  const themes = new Map()

  for (const row of database.query('select ThemeID, RankName, GFRankName, NavalRankAbbrev, GroundRankAbbrev from DIM_RankThemes order by ThemeID, ThemeRankID').all()) {
    const theme = themes.get(row.ThemeID) || { naval: [], ground: [] }

    themes.set(row.ThemeID, theme)

    if (row.RankName !== '') {
      theme.naval.push([row.RankName, row.NavalRankAbbrev || `R${theme.naval.length + 1}`])
    }

    if (row.GFRankName !== '') {
      theme.ground.push([row.GFRankName, row.GroundRankAbbrev || `R${theme.ground.length + 1}`])
    }
  }

  return themes
}

// ---- The page's own reads, from its source ------------------------------------------------------------------------------
// The template literal of the query after `header` in the page's script, with each placeholder filled from `values` (a placeholder the check cannot fill is the check's defect). `end` is the text that closes the literal.
const queryOf = (text, header, values, end = '`).then(([items])') => {
  const from = text.indexOf(header)
  const open = text.indexOf('this.database.query(`', from) + 'this.database.query(`'.length
  const close = text.indexOf(end, open)

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

const HEADERS = {
  roster: '    commanders: {\n      get: tracked(\'commanders\'',
  ships: '    ships: {\n      get: tracked(\'ships\'',
  former: '    former: {\n      get: tracked(\'former\'',
  history: '    formerHistory: {\n      get: tracked(\'formerHistory\'',
  held: '    held: {\n      get: tracked(\'held\'',
}

const valuesOf = (c, ids) => Object.fromEntries([...Object.entries(c.rosterParts(null, ids)).map(([name, sql]) => [`parts.${name}`, sql]), ['this.GameID', ids.GameID], ['this.RaceID', ids.RaceID], ['SERVING_COMMANDER', c.SERVING_COMMANDER]])

const readOf = (text, c, database, ids, name) => database.query(queryOf(text, HEADERS[name], valuesOf(c, ids), name === 'history' ? '`)' : undefined)).all()

const listsOf = (text, c, database, ids) => ({ roster: readOf(text, c, database, ids, 'roster'), former: readOf(text, c, database, ids, 'former'), held: readOf(text, c, database, ids, 'held'), history: readOf(text, c, database, ids, 'history') })

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))
const SOURCES = memo(() => walk(path.join(root, 'src', 'renderer')).filter((file) => /\.(js|vue)$/.test(file)).map((file) => ({ file: path.relative(root, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') })))

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

// The pairs of commander bonus row and command type column the game works with (each branch of the naval admin command's multiplier: the bonus row the commander's value is read from, the column of the command type that scales it). Survey 2, Production 5, Mining 6, Terraforming 9, Reaction 13, Tactical 21 and Light Tactical 39, Logistics 24, Engineering 28; Crew Training 1 under its own share and under Fleet Training's.
const GAME_PAIRS = [[1, 'CrewTraining'], [1, 'FleetTraining'], [2, 'Survey'], [5, 'Industrial'], [6, 'Industrial'], [9, 'Industrial'], [13, 'Reaction'], [21, 'Tactical'], [24, 'Logistics'], [28, 'Engineering'], [39, 'Tactical']]
const SHARE_COLUMNS = ['Survey', 'Industrial', 'FleetTraining', 'Engineering', 'CrewTraining', 'Tactical', 'Reaction', 'Logistics']

check('table', 'the table of bonus and share pairs is the game\'s, every wrong pair is refused by name, each share is a command type column of the save, and every caller in the source asks for a pair of the table', async (w) => {
  const { navalAdmins: n } = await w.modules()
  const table = Object.entries(n.NAVAL_ADMIN_SHARES).flatMap(([bonus, shares]) => shares.map((share) => [Number(bonus), share])).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))

  assert.deepEqual(table, [...GAME_PAIRS].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])), 'the table holds the pairs of the game\'s branches, Light Tactical with the Tactical share')
  assert.ok(table.some(([bonus, share]) => bonus === 39 && share === 'Tactical'), 'the Light Tactical bonus is scaled by the Tactical share')

  const database = loaderOf(copyOf('migrated'))
  const wrong = [[39, 'Industrial'], [39, 'Survey'], [21, 'Industrial'], [21, 'Logistics'], [6, 'Tactical'], [2, 'Industrial'], [24, 'Tactical'], [999, 'Tactical'], [999, 'Industrial'], [14, 'Industrial'], [39, undefined], [undefined, 'Tactical'], [39, 'tactical'], [39, '']]

  for (const [bonusId, share] of wrong) {
    let error = null

    try {
      await n.loadNavalAdmins(database, { GameID: GAME, RaceID: RACE, bonusId, share })
    } catch (thrown) {
      error = thrown
    }

    assert.ok(error && /is not scaled by the naval admin share/.test(error.message), `bonus ${bonusId} with share ${share} is refused: ${error ? error.message : 'it was accepted'}`)
  }

  for (const [bonusId, share] of GAME_PAIRS) {
    const admins = await n.loadNavalAdmins(database, { GameID: GAME, RaceID: RACE, bonusId, share })

    assert.ok(admins && typeof admins === 'object', `bonus ${bonusId} with share ${share} is accepted`)
  }

  for (const save of Object.keys(SAVES).filter(present)) {
    const columns = new Set(copyOf(save).query('select name from pragma_table_info(\'DIM_NavalAdminCommandType\')').all().map((row) => row.name))

    SHARE_COLUMNS.forEach((share) => assert.ok(columns.has(share), `${save}: the command type table has the column ${share}`))
    assert.ok(table.every(([, share]) => columns.has(share)), `${save}: every share of the table is a column of the command type table`)
  }

  const constants = Object.fromEntries(SOURCES().flatMap(({ text }) => [...text.matchAll(/const ([A-Z_]+) = (\d+)\b/g)].map((one) => [one[1], Number(one[2])])))
  const callers = SOURCES().flatMap(({ file, text }) => [...text.matchAll(/loadNavalAdmins\(([^)]*)\)/g)].filter((match) => /bonusId:/.test(match[1])).map((match) => {
    const bonus = /bonusId:\s*([\w.]+)/.exec(match[1])[1]
    return { file, bonusId: /^\d+$/.test(bonus) ? Number(bonus) : constants[bonus], share: (/share:\s*'(\w+)'/.exec(match[1]) || [])[1] }
  }))

  assert.ok(callers.length >= 7, `the source has at least the seven callers of loadNavalAdmins that name a bonus (${callers.length})`)
  callers.forEach(({ file, bonusId, share }) => assert.ok(GAME_PAIRS.some(([bonus, column]) => bonus === bonusId && column === share), `${file} asks for bonus ${bonusId} with share ${share}, a pair the game works with`))
})

// The multiplier of a command at a system as the game's recursion has it: 1 where the system is not in the command's range or the command has no eligible commander, else the factor of the command times the parent's at the command's own system. null where a command on the way cannot be settled.
const gameFactor = (admins, id, systemId, depth = 0) => {
  const admin = admins[id]

  if (!admin || depth > 200 || !admin.Systems.has(systemId)) {
    return 1
  } else if (admin.Unknown || (admin.Eligible && admin.BonusUnknown)) {
    return null
  } else if (!admin.Eligible) {
    return 1
  }

  const own = admin.BonusValue ? 1 + (admin.BonusValue - 1) * admin.Share : 1
  const parent = admin.ParentCommandID ? gameFactor(admins, admin.ParentCommandID, admin.SystemID, depth + 1) : 1

  return parent === null ? null : own * parent
}

const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9)

// The stored commands with the bonus, by SQL written here: { [NavalAdminCommandID]: { value, share, system } }, the commander being the one whose own command it is.
const adminsOf = (database, game, race, bonus, share) => Object.fromEntries(database.query(`select FCT_NavalAdminCommand.NavalAdminCommandID as id, FCT_CommanderBonuses.BonusValue as value, DIM_NavalAdminCommandType.${share} as share, case when FCT_NavalAdminCommand.ShipID > 0 then VIR_Fleet.SystemID else FCT_Population.SystemID end as system
  from FCT_NavalAdminCommand
  inner join DIM_NavalAdminCommandType on DIM_NavalAdminCommandType.CommandTypeID = FCT_NavalAdminCommand.AdminCommandTypeID
  left join FCT_Population on FCT_Population.PopulationID = FCT_NavalAdminCommand.PopulationID
  left join FCT_Ship on FCT_Ship.ShipID = FCT_NavalAdminCommand.ShipID
  left join FCT_Fleet as VIR_Fleet on VIR_Fleet.FleetID = FCT_Ship.FleetID
  left join FCT_Commander on FCT_Commander.CommandID = FCT_NavalAdminCommand.NavalAdminCommandID and FCT_Commander.CommandType = 12 and FCT_Commander.RaceID = FCT_NavalAdminCommand.RaceID
  left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${bonus}
  where FCT_NavalAdminCommand.GameID = ${game} and FCT_NavalAdminCommand.RaceID = ${race}`).all().map((row) => [row.id, row]))

// The commands each save holds: their number and the holders of the Light Tactical and the Tactical bonus, as probed in the save and fixed here.
const COMMANDS = { migrated: { commands: 83, 39: 22, 21: 58 }, played: { commands: 15, 39: 7, 21: 4 } }

check('admin', 'the commands that carry the Light Tactical, Tactical and Mining bonuses hold the stored value and the share of their command type, in the interim save and the played save, and the multiplier of every command at every system is the game\'s recursion', async (w) => {
  const { navalAdmins: n, minerals: m } = await w.modules()

  for (const save of ['migrated', 'played'].filter(present)) {
    const { GameID, RaceID } = SAVES[save]
    const database = copyOf(save)
    const counts = COMMANDS[save]

    assert.equal(database.query(`select count(*) as n from FCT_NavalAdminCommand where GameID = ${GameID} and RaceID = ${RaceID}`).get().n, counts.commands, `${save}: the race holds ${counts.commands} naval admin commands`)

    for (const [bonusId, share] of [[39, 'Tactical'], [21, 'Tactical'], [6, 'Industrial']]) {
      const admins = await n.loadNavalAdmins(loaderOf(database), { GameID, RaceID, bonusId, share })
      const expected = adminsOf(database, GameID, RaceID, bonusId, share)
      const holders = Object.values(expected).filter((row) => row.value !== null)

      assert.equal(Object.keys(admins).length, counts.commands, `${save}: bonus ${bonusId} reads all ${counts.commands} commands`)

      if (counts[bonusId]) {
        assert.equal(holders.length, counts[bonusId], `${save}: ${counts[bonusId]} commanders hold bonus ${bonusId}`)
      }

      assert.ok(holders.length > 0, `${save}: some command holds bonus ${bonusId}`)

      for (const [id, row] of Object.entries(expected)) {
        const got = admins[id]

        assert.ok(got, `${save}: command ${id} is read for bonus ${bonusId}`)
        assert.ok(near(got.BonusValue === undefined ? null : got.BonusValue, row.value), `${save}: command ${id} holds bonus ${bonusId} of ${row.value}, the module has ${got.BonusValue}`)
        assert.ok(near(got.Share, row.share), `${save}: command ${id} is scaled by the ${share} share ${row.share}, the module has ${got.Share}`)
        assert.equal(got.SystemID, row.system, `${save}: command ${id} sits in system ${row.system}, the module has ${got.SystemID}`)
      }

      const systems = [...new Set(Object.values(admins).flatMap((admin) => [...admin.Systems]))]
      let moved = 0
      let compared = 0

      for (const id of Object.keys(admins)) {
        for (const system of systems) {
          const chain = m.navalAdminChain(admins, system, Number(id))
          const game = gameFactor(admins, Number(id), system)

          compared += 1
          assert.ok(near(chain.bonus, game), `${save}: bonus ${bonusId}: command ${id} at system ${system} multiplies by ${chain.bonus}, the game's recursion gives ${game}`)

          if (game !== null && game !== 1) {
            moved += 1
          }
        }
      }

      assert.ok(compared > 0, `${save}: bonus ${bonusId} compared something`)

      if (bonusId !== 6 || save === 'migrated') {
        assert.ok(moved > 0 || save === 'played', `${save}: bonus ${bonusId} moves some multiplier from 1, so the comparison is not vacuous (${moved} of ${compared})`)
      }
    }
  }
})

check('lists', 'the page\'s roster, former and held reads give the commanders of the race as the stored flags say, a retired commander in the former list, restored in the roster, a commander rescued from an own pod in the roster only, and a captured commander in the captor\'s held list and the home race\'s former list with the captor named and the career entry', async (w) => {
  const { commanders: c } = await w.modules()
  const text = w.texts.commandersPage
  const f = facts()
  const read = (name, race = RACE) => {
    const copy = copyNamed(name)

    return { ...listsOf(text, c, copy, { GameID: GAME, RaceID: race }), stored: stored(copy, GAME, race) }
  }
  const agrees = (label, result) => {
    assert.deepEqual(idsOf(result.roster), result.stored.roster, `${label}: the roster is the serving commanders of the stored flags`)
    assert.deepEqual(idsOf(result.former), result.stored.former, `${label}: the former list is the others of the race`)
    assert.deepEqual(idsOf(result.held), result.stored.held, `${label}: the held list is the prisoners the race keeps`)
  }

  const intact = read('intact')

  agrees('intact', intact)
  assert.equal(intact.roster.length, 12374, 'the saved race serves 12,374 commanders, all of them')
  assert.equal(intact.former.length + intact.held.length, 0, 'and has no former commander and no prisoner')
  assert.equal(read('intact', OTHER_RACE).roster.length, 278, 'the other race serves 278')

  // Restore a retired commander.
  const retired = read('retired')

  agrees('retired', retired)
  assert.ok(!idsOf(retired.roster).includes(f.retiree.CommanderID) && idsOf(retired.former).includes(f.retiree.CommanderID), 'a retired commander is in the former list and not in the roster')
  assert.equal(retired.roster.length, intact.roster.length - 1, 'the roster is one short')
  assert.equal(retired.former.find((row) => row.CommanderID === f.retiree.CommanderID).RetireStatus, 2, 'the former list says retired')

  const restored = read('restored')

  agrees('restored', restored)
  assert.deepEqual(idsOf(restored.roster), idsOf(intact.roster), 'a restored commander is in the roster again, as before the retirement')
  assert.equal(restored.former.length, 0, 'and not in the former list')
  assert.equal(restored.roster.find((row) => row.CommanderID === f.retiree.CommanderID).HealthRisk, 1, 'with the health risk the game sets')
  assert.equal(restored.held.length, 0, 'and not held')
  assert.equal(restored.history.length, 0, 'the entry of the restoration is of a serving commander, so no former commander\'s record holds it')

  // Rescue of the own race.
  const rescued = read('rescued')

  agrees('rescued', rescued)
  assert.deepEqual(idsOf(rescued.roster), idsOf(intact.roster), 'a commander rescued from a pod of the own race serves as before')
  assert.ok(!idsOf(rescued.former).includes(f.rescued.CommanderID) && !idsOf(rescued.held).includes(f.rescued.CommanderID), 'and is neither a former commander nor held')
  assert.equal(read('rescued', OTHER_RACE).held.length, 0, 'nor held by anyone else')

  // Capture from a foreign pod.
  const captor = read('captured')
  const home = read('captured', OTHER_RACE)

  agrees('captor', captor)
  agrees('home', home)
  assert.deepEqual(idsOf(captor.roster), idsOf(intact.roster), 'the captor\'s roster is as before')
  assert.deepEqual(idsOf(captor.held), [f.captive], 'the captor holds the captured commander')

  const held = captor.held[0]

  assert.equal(held.Processed, 0, 'not yet processed')
  assert.equal(held.ShipName, f.ship.ShipName, 'on the rescuing ship')
  assert.equal(held.AlienRaceName, f.contact, 'of the race the captor knows by that name')
  assert.ok(!idsOf(home.roster).includes(f.captive), 'the home race no longer serves the commander')
  assert.equal(home.roster.length, read('intact', OTHER_RACE).roster.length - 1, 'one fewer')
  assert.deepEqual(idsOf(home.former), [f.captive], 'but lists the commander among the former')

  const taken = home.former[0]

  assert.equal(taken.Prisoner, 1, 'a prisoner')
  assert.equal(taken.CaptorID, RACE, 'of the captor')
  assert.equal(taken.CaptorName, f.home, 'named as the home race knows it')
  assert.deepEqual(home.history.map((row) => [row.CommanderID, row.HistoryText]), [[f.captive, `Captured by ${f.contact}`]], 'with the career entry of the capture')

  // The flags stored for every commander of the played save agree with the page's lists.
  if (present('played')) {
    const { GameID, RaceID } = SAVES.played
    const database = copyOf('played')
    const result = { ...listsOf(text, c, database, { GameID, RaceID }), stored: stored(database, GameID, RaceID) }

    agrees('played', result)
    assert.equal(result.roster.length, 449, 'the played race serves 449 commanders')
    assert.equal(result.former.length + result.held.length, 0, 'and has no former commander and no prisoner')
  }
})

// The ranks a theme gives, applied to a race of the played save in place (the game gives a new race new ranks; the place of each by type and priority is the same).
const themed = (race, theme) => [...theme.naval.map(([name, abbreviation], index) => `update FCT_Ranks set RankName = ${quote(name)}, RankAbbrev = ${quote(abbreviation)} where RaceID = ${race} and RankType = 0 and Priority = ${index + 1}`), ...theme.ground.map(([name, abbreviation], index) => `update FCT_Ranks set RankName = ${quote(name)}, RankAbbrev = ${quote(abbreviation)} where RaceID = ${race} and RankType = 1 and Priority = ${index + 1}`)]

// The rank of each commander of a race as the save stores it, with the level worked out here (the highest priority of the type less its own, plus 1); a commander without a rank row has none.
const rankedOf = (database, game, race) => {
  const lowest = Object.fromEntries(database.query(`select RankType, max(Priority) as Lowest from FCT_Ranks where RaceID = ${race} group by RankType`).all().map((row) => [row.RankType, row.Lowest]))

  return Object.fromEntries(database.query(`select FCT_Commander.CommanderID, FCT_Ranks.RankName, FCT_Ranks.RankAbbrev, FCT_Ranks.RankType, FCT_Ranks.Priority from FCT_Commander left join FCT_Ranks on FCT_Ranks.RankID = FCT_Commander.RankID where FCT_Commander.GameID = ${game} and FCT_Commander.RaceID = ${race} and FCT_Commander.RetireStatus = 0 and FCT_Commander.Prisoner = 0`).all().map((row) => [row.CommanderID, { name: row.RankName, abbreviation: row.RankAbbrev, level: row.Priority === null ? null : lowest[row.RankType] - row.Priority + 1 }]))
}

check('themes', 'the ranks of 26 of the 27 races of three saves are the ranks of one theme by the game\'s rule, the page\'s rank names, abbreviations and levels are the stored ranks of the race, a theme planted into a race keeps its apostrophes and levels, and the app does not read the theme catalogue', async (w) => {
  const { commanders: c } = await w.modules()
  const text = w.texts.commandersPage
  const expected = { migrated: [6, 5], played: [15, 15], shipped: [6, 6] }

  for (const save of Object.keys(SAVES).filter(present)) {
    const database = copyOf(save)
    const themes = themesOf(database)
    const races = database.query(`select distinct RaceID from FCT_Ranks ${SAVES[save].GameID ? `where GameID = ${SAVES[save].GameID}` : ''} order by RaceID`).all().map((row) => row.RaceID)
    const matched = races.filter((race) => {
      const ranks = ranksOf(database, race)

      return [...themes.values()].some((theme) => JSON.stringify(theme.naval) === JSON.stringify(ranks.naval) && JSON.stringify(theme.ground) === JSON.stringify(ranks.ground))
    })

    assert.equal(database.query('select count(*) as n from DIM_RankThemes').get().n, 568, `${save}: the catalogue holds 568 theme rows`)
    assert.equal(themes.size, database.query('select count(*) as n from DIM_RankThemeTypes').get().n, `${save}: every theme type has rows`)
    assert.equal(database.query('select count(*) as n from DIM_RankThemes where ThemeID = 90').get().n, 8, `${save}: the Egyptian theme holds 8 rows`)
    assert.deepEqual([races.length, matched.length], expected[save], `${save}: ${expected[save][1]} of ${expected[save][0]} races hold the ranks of a theme`)
  }

  for (const [save, race] of [['migrated', OTHER_RACE], ['migrated', RACE], ['played', SAVES.played.RaceID]].filter(([name]) => present(name))) {
    const { GameID } = SAVES[save]
    const database = copyOf(save)
    const rows = readOf(text, c, database, { GameID, RaceID: race }, 'roster')
    const ranked = rankedOf(database, GameID, race)

    assert.equal(rows.length, Object.keys(ranked).length, `${save} race ${race}: the roster has a row for every serving commander`)

    for (const row of rows) {
      const rank = ranked[row.CommanderID]

      assert.deepEqual([row.RankName, row.RankAbbrev, row.RankLevel], [rank.name, rank.abbreviation, rank.level], `${save} race ${race}: commander ${row.CommanderID}'s rank is ${rank.name}, ${rank.abbreviation}, level ${rank.level}, the page has ${row.RankName}, ${row.RankAbbrev}, level ${row.RankLevel}`)
    }
  }

  if (present('played')) {
    const { GameID, RaceID } = SAVES.played
    const plain = copyOf('played')
    const theme = themesOf(plain).get(90)
    const planted = copyOf('played', 'themed', () => themed(RaceID, theme))
    const rows = readOf(text, c, planted, { GameID, RaceID }, 'roster')
    const ranked = rankedOf(planted, GameID, RaceID)

    assert.deepEqual([theme.naval.length, theme.ground.length], [8, 8], 'the Egyptian theme gives 8 naval and 8 ground ranks, as many as the race holds')
    assert.deepEqual(ranksOf(planted, RaceID), { naval: theme.naval, ground: theme.ground }, 'the race holds the ranks of the theme')
    assert.ok(theme.naval.some(([name]) => name.includes('’')), 'a rank of the theme carries a typographic apostrophe')
    assert.equal(rows.length, 449, 'the roster is whole')

    for (const row of rows) {
      const rank = ranked[row.CommanderID]

      assert.deepEqual([row.RankName, row.RankAbbrev, row.RankLevel], [rank.name, rank.abbreviation, rank.level], `commander ${row.CommanderID} of the themed race: ${rank.name}, ${rank.abbreviation}, level ${rank.level}, the page has ${row.RankName}, ${row.RankAbbrev}, level ${row.RankLevel}`)
    }

    assert.ok(rows.some((row) => /’/.test(row.RankName)), 'a commander holds a rank whose name has the apostrophe, delivered intact')
    assert.ok(rows.filter((row) => row.RankLevel !== null).length > 0 && rows.filter((row) => row.RankLevel !== null).every((row) => row.RankLevel >= 1 && row.RankLevel <= 8), 'every level of a ranked commander lies within the 8 ranks')
  }

  const readers = SOURCES().filter(({ text: body }) => /DIM_RankTheme/.test(body)).map(({ file }) => file)

  assert.deepEqual(readers, [], 'no file of the source reads the rank theme catalogue: a race\'s ranks are in its own rank rows')
})

check('b024', 'the ship class flag Commercial is stored on the harvester class and not on the survey class, the page\'s ship rows and the specialist ship suggestions are the same with the flag set the other way round, and the source holds no test of it', async (w) => {
  const { commanders: c } = await w.modules()
  const text = w.texts.commandersPage
  const intact = copyOf('migrated')
  const planted = copyNamed('commercial')
  const flag = (database, id) => database.query(`select Commercial from FCT_ShipClass where ShipClassID = ${id}`).get().Commercial
  const ids = { GameID: GAME, RaceID: RACE }

  assert.deepEqual([flag(intact, HARVESTER_CLASS), flag(intact, SURVEY_CLASS)], [1, 0], 'the saved harvester class is commercial and the survey class is not')
  assert.deepEqual([flag(planted, HARVESTER_CLASS), flag(planted, SURVEY_CLASS)], [0, 1], 'the plant turns them round')

  const before = readOf(text, c, intact, ids, 'ships')
  const after = readOf(text, c, planted, ids, 'ships')

  assert.equal(before.length, 12, 'the page reads the ten harvesters and the two survey ships')
  assert.deepEqual(after, before, 'the ship rows are the same with the flag turned round')
  assert.ok(before.some((row) => row.ClassName === 'H50M Harvester') && before.some((row) => row.ClassName === 'Intrepid'), 'the commercial harvesters and the military survey ships are both listed')

  const officer = (id, level, bonus) => ({ CommanderID: id, Name: `Officer ${id}`, CommanderType: 0, CommandType: 0, RankLevel: level, bonuses: { [c.MINING]: bonus, [c.SURVEY]: bonus } })
  const held = (id, level) => ({ CommanderID: id, Name: `Holder ${id}`, CommanderType: 0, CommandType: 1, RankLevel: level, bonuses: { [c.MINING]: 1, [c.SURVEY]: 1, [c.TERRAFORMING]: 1 } })
  const holders = [...new Set(before.flatMap((row) => [row.CaptainID, row.ScienceOfficerID]).filter(Boolean))].map((id) => held(id, 3))
  const officers = [officer(10, 3, 1.3), officer(11, 4, 1.25), officer(12, 5, 1.1), ...holders]
  const outcome = (rows) => {
    const result = c.shipSuggestions(rows, officers)

    return JSON.stringify([result.rows.map((row) => [row.ship.ShipID, row.candidate && row.candidate.CommanderID, row.otherRanks]), result.unrated.map((entry) => entry.ship.ShipID)])
  }

  assert.equal(outcome(after), outcome(before), 'the specialist ship suggestions are the same')
  assert.ok(c.shipSuggestions(before, officers).rows.length > 0, 'and list ships to improve, so the comparison is not vacuous')
  assert.ok(c.shipSuggestions(before, officers).rows.some((row) => row.ship.ClassName === 'H50M Harvester') && c.shipSuggestions(before, officers).rows.some((row) => row.ship.ClassName === 'Intrepid'), 'for the commercial harvesters and the military survey ships alike')

  const scripted = ['commanders', 'commandersPage'].map((name) => w.texts[name].replace(/KillTonnageCommercial/g, '')).join('\n')

  assert.ok(!/Commercial/.test(scripted), 'neither the page nor its module tests whether a class is commercial')
})

check('text', 'the footer of the Commanders page\'s former and held lists says what they hold', async (w) => {
  const text = w.texts.commandersPage

  assert.ok(/prisoners of another race, and retired or dead commanders the player kept/.test(text), 'the former list is described as prisoners, retired and dead commanders kept by the player')
  assert.ok(/Other races' commanders this race holds prisoner, on its ships or at its colonies/.test(text), 'the held list is described')
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'Light Tactical takes the Industrial share', target: 'navalAdmins', from: '39: Object.freeze([\'Tactical\'])', to: '39: Object.freeze([\'Industrial\'])', fails: ['table'] },
  { name: 'Light Tactical has no share', target: 'navalAdmins', from: ', 39: Object.freeze([\'Tactical\']) })', to: ' })', fails: ['table'] },
  { name: 'Light Tactical takes the Survey share as well', target: 'navalAdmins', from: '39: Object.freeze([\'Tactical\'])', to: '39: Object.freeze([\'Tactical\', \'Survey\'])', fails: ['table'] },
  { name: 'Tactical takes the Engineering share', target: 'navalAdmins', from: '21: Object.freeze([\'Tactical\'])', to: '21: Object.freeze([\'Engineering\'])', fails: ['table'] },
  { name: 'Mining takes the Survey share', target: 'navalAdmins', from: '6: Object.freeze([\'Industrial\'])', to: '6: Object.freeze([\'Survey\'])', fails: ['table'] },
  { name: 'a pair the table lacks is accepted', target: 'navalAdmins', from: 'if (!(NAVAL_ADMIN_SHARES[Number(bonusId)] || []).includes(share)) {', to: 'if (false) {', fails: ['table'] },
  { name: 'a bonus the table lacks is given the Industrial share', target: 'navalAdmins', from: '(NAVAL_ADMIN_SHARES[Number(bonusId)] || []).includes(share)', to: '(NAVAL_ADMIN_SHARES[Number(bonusId)] || [\'Industrial\']).includes(share)', fails: ['table'] },
  { name: 'the share is read from the Industrial column whatever is asked', target: 'navalAdmins', from: 'DIM_NavalAdminCommandType.${share} as Share', to: 'DIM_NavalAdminCommandType.Industrial as Share', fails: ['admin'] },
  { name: 'the bonus read is the Mining one whatever is asked', target: 'navalAdmins', from: 'FCT_CommanderBonuses.BonusID = ${Number(bonusId)}', to: 'FCT_CommanderBonuses.BonusID = 6', fails: ['admin'] },
  { name: 'the chain leaves the share out', target: 'minerals', from: 'bonus *= 1 + (current.BonusValue - 1) * current.Share', to: 'bonus *= current.BonusValue', fails: ['admin'] },
  { name: 'the chain scales the bonus by the share twice', target: 'minerals', from: 'bonus *= 1 + (current.BonusValue - 1) * current.Share', to: 'bonus *= 1 + (current.BonusValue - 1) * current.Share * current.Share', fails: ['admin'] },
  { name: 'the parent is judged at the ship\'s system, not the command\'s own', target: 'minerals', from: 'location = current.SystemID', to: 'location = systemId', fails: ['admin'] },
  { name: 'a serving commander includes the prisoners', target: 'commanders', from: 'export const SERVING_COMMANDER = \'FCT_Commander.RetireStatus = 0 and FCT_Commander.Prisoner = 0\'', to: 'export const SERVING_COMMANDER = \'FCT_Commander.RetireStatus = 0\'', fails: ['lists'] },
  { name: 'a serving commander includes the retired', target: 'commanders', from: 'export const SERVING_COMMANDER = \'FCT_Commander.RetireStatus = 0 and FCT_Commander.Prisoner = 0\'', to: 'export const SERVING_COMMANDER = \'FCT_Commander.Prisoner = 0\'', fails: ['lists'] },
  { name: 'the roster takes the serving commanders by the retire status alone', target: 'commandersPage', from: 'and ${SERVING_COMMANDER} order by FCT_Commander.CommanderType', to: 'and FCT_Commander.RetireStatus = 0 order by FCT_Commander.CommanderType', fails: ['lists'] },
  { name: 'the former list is the prisoners', target: 'commandersPage', from: 'and not (${SERVING_COMMANDER})`).then(([items])', to: 'and FCT_Commander.Prisoner = 1`).then(([items])', fails: ['lists'] },
  { name: 'the former list names the captor from the pod pointer', target: 'commandersPage', from: 'VIR_HoldShip.ShipID = FCT_Commander.TransportShipID and VIR_HoldShip.RaceID <> FCT_Commander.RaceID', to: 'VIR_HoldShip.ShipID = FCT_Commander.LifepodID and VIR_HoldShip.RaceID <> FCT_Commander.RaceID', fails: ['lists'] },
  { name: 'the former list names the own race as captor', target: 'commandersPage', from: 'VIR_HoldShip.ShipID = FCT_Commander.TransportShipID and VIR_HoldShip.RaceID <> FCT_Commander.RaceID', to: 'VIR_HoldShip.ShipID = FCT_Commander.TransportShipID and VIR_HoldShip.RaceID = FCT_Commander.RaceID', fails: ['lists'] },
  { name: 'the held list takes the commanders not held', target: 'commandersPage', from: 'FCT_Commander.RaceID <> ${this.RaceID} and FCT_Commander.Prisoner = 1', to: 'FCT_Commander.RaceID <> ${this.RaceID} and FCT_Commander.Prisoner = 0', fails: ['lists'] },
  { name: 'the held list takes the own race\'s commanders', target: 'commandersPage', from: 'FCT_Commander.RaceID <> ${this.RaceID} and FCT_Commander.Prisoner = 1', to: 'FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.Prisoner = 1', fails: ['lists'] },
  { name: 'the held list takes the ship of any race', target: 'commandersPage', from: 'VIR_Ship.ShipID = FCT_Commander.TransportShipID and VIR_Ship.RaceID = ${this.RaceID}', to: 'VIR_Ship.ShipID = FCT_Commander.LifepodID and VIR_Ship.RaceID = ${this.RaceID}', fails: ['lists'] },
  { name: 'the rank abbreviation is the rank name', target: 'commanders', from: '\'FCT_Ranks.RankName, FCT_Ranks.RankAbbrev\'', to: '\'FCT_Ranks.RankName, FCT_Ranks.RankName as RankAbbrev\'', fails: ['themes'] },
  { name: 'the rank level is the priority', target: 'commanders', from: '\'VIR_Levels.Lowest - FCT_Ranks.Priority + 1 as RankLevel\'', to: '\'FCT_Ranks.Priority as RankLevel\'', fails: ['themes'] },
  { name: 'the lowest rank is taken over every race', target: 'commanders', from: 'where FCT_Ranks.GameID = ${GameID} and FCT_Ranks.RaceID = ${RaceID} group by FCT_Ranks.RankType', to: 'where FCT_Ranks.GameID = ${GameID} group by FCT_Ranks.RankType', fails: ['themes'] },
  { name: 'the ship rows leave out the commercial classes', target: 'commandersPage', from: 'and FCT_Ship.ShippingLineID = 0 and (FCT_ShipClass.Terraformers > 0', to: 'and FCT_Ship.ShippingLineID = 0 and FCT_ShipClass.Commercial = 0 and (FCT_ShipClass.Terraformers > 0', fails: ['b024'] },
  { name: 'the ship rows keep only the commercial classes', target: 'commandersPage', from: 'and FCT_Ship.ShippingLineID = 0 and (FCT_ShipClass.Terraformers > 0', to: 'and FCT_Ship.ShippingLineID = 0 and FCT_ShipClass.Commercial = 1 and (FCT_ShipClass.Terraformers > 0', fails: ['b024'] },
  { name: 'the former list is not described', target: 'commandersPage', from: 'prisoners of another race, and retired or dead commanders the player kept', to: 'commanders', fails: ['text'] },
]

// Rewrites that say the same thing: the serving test with its terms in the other order, the prisoner test of the held list written the other way round, the share table's key read through a unary plus, the chain's factor with its terms swapped.
const BENIGN = [
  { name: 'the serving test in the other order', target: 'commanders', from: 'export const SERVING_COMMANDER = \'FCT_Commander.RetireStatus = 0 and FCT_Commander.Prisoner = 0\'', to: 'export const SERVING_COMMANDER = \'FCT_Commander.Prisoner = 0 and FCT_Commander.RetireStatus = 0\'' },
  { name: 'the held test written the other way round', target: 'commandersPage', from: 'FCT_Commander.RaceID <> ${this.RaceID} and FCT_Commander.Prisoner = 1', to: '${this.RaceID} <> FCT_Commander.RaceID and 1 = FCT_Commander.Prisoner' },
  { name: 'the share table read through a unary plus', target: 'navalAdmins', from: '(NAVAL_ADMIN_SHARES[Number(bonusId)] || [])', to: '(NAVAL_ADMIN_SHARES[+bonusId] || [])' },
  { name: 'the chain\'s factor with its terms swapped', target: 'minerals', from: 'bonus *= 1 + (current.BonusValue - 1) * current.Share', to: 'bonus *= 1 + current.Share * (current.BonusValue - 1)' },
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
    console.log(`UNSUPPORTED  every check: the fixture ${SAVES.migrated.file} is not there`)
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
