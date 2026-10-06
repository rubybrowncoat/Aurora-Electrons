// Empire History: the app's own record of each player race, one snapshot per game save it sees.
// Aurora keeps no history beyond a year of wealth and a few weeks of the mineral ledger, so this is
// the only way to chart growth. Snapshots are kept per game and race in their own electron-store
// file (`history.json` beside the settings), never in the save. See docs/plans/aurcalcs/build-3.md.

import Config from 'electron-store'

// More than this many snapshots per race and the older half is thinned to every other one, so a
// long campaign keeps its whole span at a coarser grain (about 1 MB per race at the cap).
export const MAX_SNAPSHOTS = 2000

let historyStore = null

// The history file, created on first use.
export const historyConfig = () => {
  if (!historyStore) {
    historyStore = new Config({ name: 'history' })
  }

  return historyStore
}

export const historyKey = (GameID, RaceID) => `game.${GameID}.race.${RaceID}`

// Drop every other snapshot in the older half until the list fits.
export const thinSnapshots = (snapshots, limit = MAX_SNAPSHOTS) => {
  let result = snapshots

  while (result.length > limit) {
    const half = Math.floor(result.length / 2)

    result = [...result.slice(0, half).filter((_, index) => index % 2 === 0), ...result.slice(half)]
  }

  return result
}

// Add a snapshot to a race's record. A new game under the same IDs (another name) starts over;
// a snapshot at a time already recorded replaces it; an earlier time (an older save reloaded)
// drops what came after it, since that future didn't happen.
export const mergeSnapshot = (record, snapshot, { gameName, raceName }) => {
  const sameGame = record && record.gameName === gameName
  const kept = sameGame ? record.snapshots.filter((entry) => entry.t < snapshot.t) : []

  return { gameName, raceName, snapshots: thinSnapshots([...kept, snapshot]) }
}

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0)

// One race's state now, compact enough to keep thousands of: population, treasury, stockpiles,
// ships, installations, research and exploration.
export const takeSnapshot = async (database, { GameID, RaceID }) => {
  const query = (sql) => database.query(sql).then(([items]) => items)
  const [[race], colonies, ships, installations, [counts]] = await Promise.all([
    query(`select FCT_Game.GameTime, FCT_Game.GameName, FCT_Race.RaceTitle, FCT_Race.WealthPoints, FCT_Race.AnnualWealth from FCT_Race inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`),
    query(`select FCT_Population.Population, FCT_Population.FuelStockpile, FCT_Population.MaintenanceStockpile, FCT_Population.Duranium, FCT_Population.Neutronium, FCT_Population.Corbomite, FCT_Population.Tritanium, FCT_Population.Boronide, FCT_Population.Mercassium, FCT_Population.Vendarite, FCT_Population.Sorium, FCT_Population.Uridium, FCT_Population.Corundium, FCT_Population.Gallicite from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`),
    query(`select FCT_ShipClass.Commercial, count(*) as Ships, sum(FCT_ShipClass.Size * 50) as Tons from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 group by FCT_ShipClass.Commercial`),
    query(`select FCT_PopulationInstallations.PlanetaryInstallationID as ID, sum(FCT_PopulationInstallations.Amount) as Amount from FCT_PopulationInstallations inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_PopulationInstallations.Amount > 0 group by FCT_PopulationInstallations.PlanetaryInstallationID`),
    query(`select (select sum(FCT_TechSystem.DevelopCost) from FCT_RaceTech inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID where FCT_RaceTech.GameID = ${GameID} and FCT_RaceTech.RaceID = ${RaceID}) as Research, (select count(*) from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}) as Systems, (select count(*) from FCT_Commander where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and FCT_Commander.Deceased = 0) as Commanders`),
  ])

  if (!race) {
    return null
  }

  const shipsOf = (commercial) => ships.find((row) => !!row.Commercial === commercial) || { Ships: 0, Tons: 0 }
  const military = shipsOf(false)
  const commercial = shipsOf(true)

  return {
    gameName: race.GameName,
    raceName: race.RaceTitle,
    snapshot: {
      t: race.GameTime,
      population: sum(colonies, 'Population'),
      colonies: colonies.filter((colony) => colony.Population > 0).length,
      wealth: race.WealthPoints,
      income: race.AnnualWealth,
      fuel: sum(colonies, 'FuelStockpile'),
      msp: sum(colonies, 'MaintenanceStockpile'),
      // Colony stockpiles, Duranium to Gallicite (mineral IDs 1–11).
      minerals: ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite'].map((name) => Math.round(sum(colonies, name))),
      militaryShips: military.Ships,
      militaryTons: Math.round(military.Tons || 0),
      commercialShips: commercial.Ships,
      commercialTons: Math.round(commercial.Tons || 0),
      // { PlanetaryInstallationID: amount }
      installations: Object.fromEntries(installations.map((row) => [row.ID, Math.round(row.Amount * 100) / 100])),
      research: counts.Research || 0,
      systems: counts.Systems || 0,
      commanders: counts.Commanders || 0,
    },
  }
}

// Snapshot every player race in the save into the history file. Returns how many were recorded.
export const recordHistory = async (database) => {
  const [races] = await database.query('select FCT_Race.GameID, FCT_Race.RaceID from FCT_Race where FCT_Race.NPR = 0')
  const store = historyConfig()
  let recorded = 0

  for (const { GameID, RaceID } of races) {
    const taken = await takeSnapshot(database, { GameID, RaceID })

    if (taken) {
      const key = historyKey(GameID, RaceID)

      store.set(key, mergeSnapshot(store.get(key, null), taken.snapshot, taken))
      recorded++
    }
  }

  return recorded
}
