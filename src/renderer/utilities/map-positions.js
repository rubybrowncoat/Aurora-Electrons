// The Galaxy Map's Save Positions: the systems that moved are written back to the race's survey rows in one transaction, as the whole numbers the game reads. Everything goes through the one `database` the caller names, which the caller took once before the first statement: the app replaces its database when the save is reloaded or switched, and a transaction begun on one copy must never carry its statements to another (a retired copy refuses them, and the transaction rolls back).
export const savePositions = (database, { GameID, RaceID, ids, positions }) => database.transaction(async (transaction) => {
  for (const id of ids) {
    await database.query(`update FCT_RaceSysSurvey set Xcor = ${Math.round(positions[id].x)}, Ycor = ${Math.round(positions[id].y)} where FCT_RaceSysSurvey.GameID = ${Number(GameID)} and FCT_RaceSysSurvey.RaceID = ${Number(RaceID)} and FCT_RaceSysSurvey.SystemID = ${Number(id)}`, { transaction })
  }
})
