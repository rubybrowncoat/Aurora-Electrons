// The one default save of every check script that reads a save. Each script takes its file, game and race from here when no `--save`, `--stock` or `--modded` option (or a positional save) names another, and replaces them for that run only.
//
// The default is the interim fixture of AE-310-01 (tier a): the owner's campaign "Galactic Shogunate" of the earlier line migrated to the 3.1 schema, whose stored values are the earlier game's own (sha256 449dfc4e0eba10fbd3851c00b386381313320a25525b990b8320866eb5ac49fe, 215 tables). A value only the 3.1 game writes cannot be read from it, so a rule whose oracle is such a value is reported 'needs tier b' by its check rather than passed. The played 3.1 save of AE-310-03 replaces `FIXTURE` below when it arrives; nothing else names a save as a default, so that one line moves every check that follows the default (the figures a check pins from the fixture are re-pinned with it).
const path = require('path')

const root = path.resolve(__dirname, '..', '..')

// The interim fixture as a recorded specimen: the file, the game and the race of the save that some typed oracles were taken from (the owner's captures of the Empire summary tab, the stored premiums of the saved sensors, the temperatures the earlier game stored). A check whose oracle is bound to this very save names `INTERIM`, so that it keeps reading that save when `FIXTURE` moves to a later one, and says so in its header. `file` is relative to the repository root. `gameName` and `raceName` are the names the Empires page lists, for the checks that pick the game and the race in the browser.
const INTERIM = Object.freeze({ file: 'saves/AuroraDB-310-spookyerol-migrated.db', gameId: 141, raceId: 784, gameName: 'Galactic Shogunate', raceName: 'Shogunate' })

// The default fixture: the save every check that names no other reads. The one place that names it.
const FIXTURE = INTERIM

// The fixture as the object most check scripts keep a save as.
const fixtureSave = () => ({ file: FIXTURE.file, game: FIXTURE.gameId, race: FIXTURE.raceId })

// The fixture as the `[file, GameID, RaceID]` triple of a `--stock` or `--modded` option.
const fixtureTriple = () => [FIXTURE.file, FIXTURE.gameId, FIXTURE.raceId]

const fixturePath = () => path.join(root, FIXTURE.file)

// The played saves: one campaign the game itself wrote under Aurora 3.2.0 (3.2.0 changed no table or column, so it is of the 3.2 line the app states), registered by the owner in two saves 30,804,305 s apart. They are additional witnesses, never the default: a check that takes `--save` can be run on one of them to compare a rule with values the 3.x game stored (stored colony cost, stored surface temperature, saved research, a one-year wealth ledger), and a rule is read as exercised by one only where that check names it.
// orbitalWitnessLevel is the forced-60-second-update calibration of the game's rules of AE-310-06-H1, not a historical load/session count; A's zero is only a reference. Raw saved bearings and GameTime independently support the relative levels, with no product or mutant fit. A replacement or changed level requires a named finding and reviewed hash-bound evidence, never repinning for a pass. For a future specimen, establish its hash, campaign and full ledger ancestry; select the unchanged primary circular body with the smallest period > twice the interval (ID tie-break), resolve a nonnegative minute offset within the timing allowance of the game's rules, and validate the other eligible circular/moon own bearings and calibrated ancestral pairs. Record raw fields, residuals, bounds and assumptions for review before persisting a level relative to its ancestor; ambiguous, aliased or nonuniform evidence stays diagnostic-only. See docs/plans/backlog/evidence/AE-310-06-H1-council-handoff.md.
const PLAYED = Object.freeze({ file: 'saves/AuroraDB-320-fetterkrolle-1.db', gameId: 161, raceId: 909, gameName: 'UEF', orbitalWitnessLevel: 0 })

// The later save of that campaign, 30,804,305 s after `PLAYED` (GameTime 122,529,715 s against 91,725,410 s, 0.977 of the 31,536,000 s year; 18,921 bodies of game 161 against 18,575), so a check that replays the pair reads the earlier save with `--since` and this one as its subject. It is a witness on the same terms as `PLAYED`: never the default, and read as exercising a rule only where a check names it.
const PLAYED_NEXT = Object.freeze({ file: 'saves/AuroraDB-320-fetterkrolle-2.db', gameId: 161, raceId: 909, gameName: 'UEF', orbitalWitnessLevel: 1 })

// The first of the two branches from `PLAYED_NEXT` (B), C1: 31,613,400 s after B and 62,417,705 s after `PLAYED` (A) (GameTime 154,143,115 s; 20,122 bodies of game 161 against 18,921), 124 increments after B, which the pair witness reads beside the two earlier ones. It is a witness on the same terms as `PLAYED`: never the default, and read as exercising a rule only where a check names it.
const PLAYED_C1 = Object.freeze({ file: 'saves/AuroraDB-320-fetterkrolle-3.db', gameId: 161, raceId: 909, gameName: 'UEF', orbitalWitnessLevel: 2 })

// The second of the two branches from `PLAYED_NEXT` (B), C2, saved from B as the other continuation of the campaign: 35,000,010 s after it (GameTime 157,529,725 s, 1.110 of the 31,536,000 s year; 21,065 bodies of game 161 against 18,921) in 478 increments against the 124 of `PLAYED_C1`. Both branches' ledgers diverge from the fork at 122,529,715 s at their first row (86,400 s here against 432,000 s in C1) and coincide on 21 whole 86,400 s days that both recorded at the same clock times. It was saved with `SubPulseLength` 60 s, where the three other saves store 1800; those settings are endpoint observations, not historical cadence. The witness uses the earlier save's forecast schedule and a partition-wide historical bound from the ledger, so both ancestral C2 pairs join the gate. It is a witness on the same terms as `PLAYED`: never the default, and read as exercising a rule only where a check names it.
const PLAYED_C2 = Object.freeze({ file: 'saves/AuroraDB-320-fetterkrolle-3-branched.db', gameId: 161, raceId: 909, gameName: 'UEF', orbitalWitnessLevel: 3 })

// The saves of saves/ of the 3.2 line, by file name and in the order a sorted listing gives: the fresh and the migrated 3.1 saves, the four played 3.2 saves (A, B and the two branches from B, C1 and C2) and the shipped 3.0.0, 3.1.0 and 3.2.0 databases. A check that reads every save of the line reads these and no other file of the folder (a save from before the line is read only to be refused).
const LINE_SAVE_FILES = Object.freeze(['AuroraDB-310-fresh.db', path.basename(FIXTURE.file), path.basename(PLAYED.file), path.basename(PLAYED_NEXT.file), path.basename(PLAYED_C2.file), path.basename(PLAYED_C1.file), 'AuroraDB_300_shipped.db', 'AuroraDB_310_shipped.db', 'AuroraDB_320_shipped.db'])

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

module.exports = { FIXTURE, INTERIM, PLAYED, PLAYED_NEXT, PLAYED_C1, PLAYED_C2, LINE_SAVE_FILES, fixtureSave, fixtureTriple, fixturePath, fixtureRows, playedTriple }
