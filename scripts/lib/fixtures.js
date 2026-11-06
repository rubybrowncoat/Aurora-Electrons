// The one default save of every check script that reads a save. Each script takes its file, game and race from here when no `--save`, `--stock` or `--modded` option (or a positional save) names another, and replaces them for that run only.
//
// The default is the interim fixture of AE-310-01 (tier a): the owner's 2.7 campaign "Galactic Shogunate" migrated to the 3.1 schema, whose stored values are the 2.7 game's own (sha256 449dfc4e0eba10fbd3851c00b386381313320a25525b990b8320866eb5ac49fe, 215 tables). A value only the 3.1 game writes cannot be read from it, so a rule whose oracle is such a value is reported 'needs tier b' by its check rather than passed. The played 3.1 save of AE-310-03 replaces `FIXTURE` below when it arrives; nothing else names a save as a default, so that one line moves every check that follows the default (the figures a check pins from the fixture are re-pinned with it).
//
// The 2.x campaign saves under `artifacts/` and the named 2.x saves under `saves/` that named checks replay are recorded data, not defaults, and stay named in those checks; `convertedSave` below gives such a save the 3.1 names the app reads, and, for a check that drives the app's pages over it, the seven columns the app looks for to accept a save as of the 3.2 line.
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')

// The interim fixture as a recorded specimen: the file, the game and the race of the save that some typed oracles were taken from (the owner's captures of the Empire summary tab, the stored premiums of the saved sensors, the temperatures the 2.7 game stored). A check whose oracle is bound to this very save names `INTERIM`, so that it keeps reading that save when `FIXTURE` moves to a later one, and says so in its header. `file` is relative to the repository root. `gameName` and `raceName` are the names the Empires page lists, for the checks that pick the game and the race in the browser.
const INTERIM = Object.freeze({ file: 'saves/AuroraDB-310-spookyerol-migrated.db', gameId: 141, raceId: 784, gameName: 'Galactic Shogunate', raceName: 'Shogunate' })

// The default fixture: the save every check that names no other reads. The one place that names it.
const FIXTURE = INTERIM

// The fixture as the object most check scripts keep a save as.
const fixtureSave = () => ({ file: FIXTURE.file, game: FIXTURE.gameId, race: FIXTURE.raceId })

// The fixture as the `[file, GameID, RaceID]` triple of a `--stock` or `--modded` option.
const fixtureTriple = () => [FIXTURE.file, FIXTURE.gameId, FIXTURE.raceId]

const fixturePath = () => path.join(root, FIXTURE.file)

// The played saves: one campaign the game itself wrote under Aurora 3.2.0 (3.2.0 changed no table or column, so it is of the 3.2 line the app states), registered by the owner in two saves 30,804,305 s apart. They are additional witnesses, never the default: a check that takes `--save` can be run on one of them to compare a rule with values the 3.x game stored (stored colony cost, stored surface temperature, saved research, a one-year wealth ledger), and a rule is read as exercised by one only where that check names it.
const PLAYED = Object.freeze({ file: 'saves/AuroraDB-320-fetterkrolle-1.db', gameId: 161, raceId: 909, gameName: 'UEF' })

// The later save of that campaign, 30,804,305 s after `PLAYED` (GameTime 122,529,715 s against 91,725,410 s, 0.977 of the 31,536,000 s year; 18,921 bodies of game 161 against 18,575), so a check that replays the pair reads the earlier save with `--since` and this one as its subject. It is a witness on the same terms as `PLAYED`: never the default, and read as exercising a rule only where a check names it.
const PLAYED_NEXT = Object.freeze({ file: 'saves/AuroraDB-320-fetterkrolle-2.db', gameId: 161, raceId: 909, gameName: 'UEF' })

// The played save as the `[file, GameID, RaceID]` triple of a `--save`, `--stock` or `--modded` option.
const playedTriple = () => [PLAYED.file, PLAYED.gameId, PLAYED.raceId]

// The rows of a read-only query over the fixture, for a script that needs a value of the save before its first await (a constant that other constants are worked from). Needs bun (`bun:sqlite`).
const fixtureRows = (sql, ...params) => {
  const { Database } = require('bun:sqlite')
  const db = new Database(fixturePath(), { readonly: true })

  try {
    return db.query(sql).all(...params)
  } finally {
    db.close()
  }
}

// The one statement that gives a recorded 2.x save the 3.1 name of the star's component number (AE-308-02): the column was Component. Every other column a 2.x save lacks is read only by checks that skip it with a printed reason.
const STAR_STATEMENT = 'alter table FCT_Star rename column Component to ComponentNumber'

// The seven columns the app looks for to accept a save as of the 3.2 line (the line signature of src/renderer/utilities/capabilities.js), as [table, column, definition] with the type and the default the shipped 3.1 database gives each. A save of the earlier release has none of them and the app refuses it as such, so a check that opens one in the browser asks for them with the `line` option of `convertedSave`; they carry the defaults and no value of a game.
const LINE_COLUMNS = Object.freeze([
  ['FCT_Game', 'LostColonies', 'INTEGER default 0'],
  ['FCT_Game', 'GenerateNonOxygenRaces', 'INTEGER default 1'],
  ['FCT_Game', 'NoShieldTechnology', 'INTEGER default 0'],
  ['FCT_Game', 'OrbitalMovementInSubPulse', 'INTEGER default 0'],
  ['FCT_Ship', 'ShipSeniorCO', 'INTEGER default 0'],
  ['FCT_Race', 'NoResearchProjects', 'Boolean default FALSE'],
  ['FCT_Population', 'AlienArtifacts', 'Double default 0'],
])

// The path of a copy of a recorded 2.x save (a path relative to the repository root, or absolute) with the star's component number under its 3.1 name, applied by `STAR_STATEMENT`, with `line` also the columns of `LINE_COLUMNS` that the save lacks (`alter table <table> add column <column> <definition>`), with `columns` the further columns of the line the check names in the same form, as a module it reads needs them with their defaults (the anchors of the recovery ledger, AE-309-04), and nothing else. The copy is made once, in the temp folder, under a name taken from the source's path, size, time and statements, and read only by every later run and every child process of a run, so a campaign of large saves is copied once; a save that already has the 3.1 names is copied as it is. Needs bun (`bun:sqlite`).
const convertedSave = (file, { line = false, columns = [] } = {}) => {
  const source = path.resolve(root, file)
  const { size, mtimeMs } = fs.statSync(source)
  const added = [...(line ? LINE_COLUMNS : []), ...columns]
  const statements = [STAR_STATEMENT, ...added.map((column) => column.join(' '))]
  const key = crypto.createHash('sha1').update(`${source}|${size}|${mtimeMs}|${statements.join(';')}`).digest('hex').slice(0, 16)
  const folder = path.join(os.tmpdir(), 'aurora-electrons-converted-saves')
  const target = path.join(folder, `${path.basename(source, '.db')}-${key}.db`)

  if (fs.existsSync(target)) {
    return target
  }

  const { Database } = require('bun:sqlite')
  const partial = `${target}.${process.pid}.partial`

  fs.mkdirSync(folder, { recursive: true })
  fs.copyFileSync(source, partial)

  const db = new Database(partial)

  try {
    if (db.query('pragma table_info(FCT_Star)').all().some((column) => column.name === 'Component')) {
      db.exec(STAR_STATEMENT)
    }

    for (const [table, column, definition] of added) {
      if (!db.query(`pragma table_info(${table})`).all().some((existing) => existing.name === column)) {
        db.exec(`alter table ${table} add column ${column} ${definition}`)
      }
    }
  } finally {
    db.close()
  }

  if (fs.existsSync(target)) {
    fs.rmSync(partial, { force: true })
  } else {
    fs.renameSync(partial, target)
  }

  return target
}

module.exports = { FIXTURE, INTERIM, PLAYED, PLAYED_NEXT, STAR_STATEMENT, LINE_COLUMNS, fixtureSave, fixtureTriple, fixturePath, fixtureRows, playedTriple, convertedSave }
