// The saves whose rows are pinned (engines, sensors, fire controls, missile designs: scripts/lib/pinned-engines.js and the pin lists of scripts/check-design-rules.js), and what identifies each. A game id and a component id are counters of one save file, so two unrelated saves reuse them, and two saves of one campaign hold different rows: a pin belongs to the saved state it was audited in, and a save is that state only when its game is the registered one by id, name, start year and game time (FCT_Game.GameTime, which only a later save of the campaign changes). The key is the label of the fixtures of scripts/lib/missile-fixtures.json and scripts/lib/sensor-fixtures.json recorded from the state, so a frozen fixture and a save read their pins by the same name.
//
// `witnessed` names the files of the repository (a path from its root: the saves/ folder) where the audit was made and that are of the line; a check that holds one of them reads its FCT_Game row and fails when the registered identity is not that row's. An empty list is a save the repository does not read (a save from before Aurora 3.0 is opened by no check): its audit rests on the extracted rows of scripts/lib/sensor-fixtures.json and scripts/lib/missile-fixtures.json. A pin is read only on its own saved state; on any other save no pin applies and every difference is a mismatch, and a pin whose row the state no longer holds is a stale pin there.

const PINNED_SAVES = Object.freeze({
  'migrated-g141': Object.freeze({ game: 141, name: 'Galactic Shogunate', startYear: 2115, gameTime: 2665307090, witnessed: Object.freeze(['saves/AuroraDB-310-spookyerol-migrated.db']) }),
  'modded-g140': Object.freeze({ game: 140, name: 'Aurelian Empire', startYear: 1, gameTime: 9485513425, witnessed: Object.freeze([]) }),
  'boscodiogigia-1973-g140': Object.freeze({ game: 140, name: 'Nazi Era', startYear: 1933, gameTime: 1277161332, witnessed: Object.freeze([]) }),
  'stock-271-g138': Object.freeze({ game: 138, name: 'EggSample', startYear: 2050, gameTime: 2316961580, witnessed: Object.freeze([]) }),
})

// The statement that reads the identity of a game from the FCT_Game table of a save: GameName, StartYear and GameTime.
const IDENTITY_SQL = 'select GameID, GameName, StartYear, GameTime from FCT_Game where GameID = :game'

// The key of the pinned saved state a game is (`{ game, name, startYear, gameTime }` as FCT_Game stores them), or null when it is none of them.
const pinnedSaveOf = ({ game, name, startYear, gameTime }) => Object.keys(PINNED_SAVES).find((key) => PINNED_SAVES[key].game === game && PINNED_SAVES[key].name === name && PINNED_SAVES[key].startYear === startYear && PINNED_SAVES[key].gameTime === gameTime) || null

// The pinned save of the game of a save database as `all(sql, parameters)` gives its rows: its key, or null.
const pinnedSaveOfGame = async (all, game) => {
  const [row] = await all(IDENTITY_SQL, { ':game': game })

  return row ? pinnedSaveOf({ game, name: row.GameName, startYear: row.StartYear, gameTime: row.GameTime }) : null
}

// Every pin of `rows` made for the pinned save `save`, carrying it: `{ save, game, ...row }`, the game being the save's own. A row that names a game of its own must name the save's.
const pinnedRows = (save, rows) => {
  if (!PINNED_SAVES[save]) {
    throw new Error(`${save} is not a pinned save`)
  }

  return rows.map((row) => {
    if (row.game !== undefined && row.game !== PINNED_SAVES[save].game) {
      throw new Error(`the pin of ${row.id} ${row.field} names game ${row.game}, not game ${PINNED_SAVES[save].game} of ${save}`)
    }

    return Object.freeze({ ...row, save, game: PINNED_SAVES[save].game })
  })
}

module.exports = { PINNED_SAVES, IDENTITY_SQL, pinnedSaveOf, pinnedSaveOfGame, pinnedRows }
