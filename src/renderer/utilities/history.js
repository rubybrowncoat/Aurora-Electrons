// Empire History: the app's own record of each race, one snapshot per game save it sees. Aurora
// keeps no history beyond a year of wealth and a few weeks of the mineral ledger, so this is the
// only way to chart growth. Each game has its own electron-store file, `history/game-<GameID>.json`
// beside the settings, never the save. See docs/plans/aurcalcs/build-3.md § Empire History.

import Config from 'electron-store'

import { toBoolean, toNumber } from './aurora'
import { intelChanged, takeIntel } from './intelligence'

// More than this many snapshots per race and the older half is thinned to every other one, so a
// long campaign keeps its whole span at a coarser grain (about 1 MB per race at the cap).
export const MAX_SNAPSHOTS = 2000

const HISTORY_FOLDER = 'history'
const historyStores = {}

// A game's history file, created on first use. Its contents:
// { gameName, races: { [RaceID]: { raceName, npr, snapshots: [...] } },
//   intel: { [ViewRaceID]: { [AlienRaceID]: { name, snapshots: [...] } } } }
export const historyConfig = (GameID) => {
  if (!historyStores[GameID]) {
    historyStores[GameID] = new Config({ cwd: HISTORY_FOLDER, name: `game-${GameID}` })
  }

  return historyStores[GameID]
}

// Player races and NPR empires are recorded. Aurora's special factions (Precursors, Invaders,
// Rakhas, Eldar, Ancients and the like, `SpecialNPRID` > 0) have no empire to chart.
export const recordsHistory = ({ NPR, SpecialNPRID }) => !toBoolean(NPR) || !(toNumber(SpecialNPRID) > 0)

// Drop every other snapshot in the older half until the list fits.
export const thinSnapshots = (snapshots, limit = MAX_SNAPSHOTS) => {
  let result = snapshots

  while (result.length > limit) {
    const half = Math.floor(result.length / 2)

    result = [...result.slice(0, half).filter((_, index) => index % 2 === 0), ...result.slice(half)]
  }

  return result
}

// Every record in `records` ({ id: { ..., snapshots } }) without its snapshots at or after `t`;
// records left empty are dropped.
const before = (records, t) => {
  const kept = {}

  Object.entries(records || {}).forEach(([id, record]) => {
    const snapshots = (record.snapshots || []).filter((snapshot) => snapshot.t < t)

    if (snapshots.length) {
      kept[id] = { ...record, snapshots }
    }
  })

  return kept
}

// Add one save's snapshots to a game's history. `history` is the file's contents (or empty), and
// everything was taken at game time `t`:
// - `races`: [{ RaceID, raceName, npr, snapshot }];
// - `intel`: { [ViewRaceID]: [{ AlienRaceID, name, snapshot }] }, what each race knows of the others.
// Rules:
// - Another game under the same GameID (another name) starts over.
// - Every record loses its snapshots at or after `t`: an older save reloaded means that future
//   didn't happen, and a save at a recorded time replaces it.
// - A race (or an alien race) missing from this save keeps its past.
// - Intelligence changes slowly, so its snapshot is kept only when something besides the time changed.
export const mergeGame = (history, { gameName, t, races, intel = {} }) => {
  const sameGame = history && history.gameName === gameName
  const merged = sameGame ? before(history.races, t) : {}
  const mergedIntel = {}

  races.forEach(({ RaceID, raceName, npr, snapshot }) => {
    merged[RaceID] = { raceName, npr, snapshots: thinSnapshots([...(merged[RaceID] ? merged[RaceID].snapshots : []), snapshot]) }
  })

  Object.entries(sameGame && history.intel ? history.intel : {}).forEach(([ViewRaceID, aliens]) => {
    mergedIntel[ViewRaceID] = before(aliens, t)
  })

  Object.entries(intel).forEach(([ViewRaceID, aliens]) => {
    const view = (mergedIntel[ViewRaceID] = mergedIntel[ViewRaceID] || {})

    aliens.forEach(({ AlienRaceID, name, snapshot }) => {
      const snapshots = view[AlienRaceID] ? view[AlienRaceID].snapshots : []
      const last = snapshots[snapshots.length - 1]

      view[AlienRaceID] = { name, snapshots: !last || intelChanged(last, snapshot) ? thinSnapshots([...snapshots, snapshot]) : snapshots }
    })
  })

  Object.keys(mergedIntel).forEach((ViewRaceID) => {
    if (!Object.keys(mergedIntel[ViewRaceID]).length) {
      delete mergedIntel[ViewRaceID]
    }
  })

  return { gameName, races: merged, intel: mergedIntel }
}

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0)

// One race's state now, compact enough to keep thousands of: population, treasury, stockpiles,
// ships, installations, research and exploration. `options` go to every query (the recorder passes
// its read transaction).
export const takeSnapshot = async (database, { GameID, RaceID }, options = {}) => {
  const query = (sql) => database.query(sql, options).then(([items]) => items)
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

// Everything one pass takes from the save: { read, failed }. `read` is [{ GameID, taken, intel }] per
// game, `taken` being [{ RaceID, raceName, npr, gameName, snapshot }] and `intel` { [ViewRaceID]:
// takeIntel() }; `failed` is the games that couldn't be read, [{ GameID, stage: 'read', error }]. It all
// happens in one read transaction, so a save written meanwhile can't give one race's snapshot the
// old save and the next one's the new. In SQLite a read transaction holds a shared lock from its
// first SELECT, which in rollback-journal mode (Aurora's) makes the game wait to commit: the reads
// are a few dozen small queries, and the history files are written after it ends.
const readSave = (database) => database.transaction(async (transaction) => {
  const options = { transaction }
  const [races] = await database.query('select FCT_Race.GameID, FCT_Race.RaceID, FCT_Race.NPR, FCT_Race.SpecialNPRID from FCT_Race', options)
  const games = {}
  const read = []
  const failed = []

  races.filter(recordsHistory).forEach((race) => {
    games[race.GameID] = [...(games[race.GameID] || []), race]
  })

  for (const [GameID, gameRaces] of Object.entries(games)) {
    const taken = []
    const intel = {}

    try {
      for (const race of gameRaces) {
        const result = await takeSnapshot(database, { GameID, RaceID: race.RaceID }, options)

        if (result) {
          taken.push({ RaceID: race.RaceID, raceName: result.raceName, npr: toBoolean(race.NPR), gameName: result.gameName, snapshot: result.snapshot })
          intel[race.RaceID] = await takeIntel(database, { GameID, RaceID: race.RaceID }, options)
        }
      }

      read.push({ GameID: Number(GameID), taken, intel })
    } catch (error) {
      failed.push({ GameID: Number(GameID), stage: 'read', error })
    }
  }

  return { read, failed }
})

// Snapshot every recorded race in the save, and what each knows of the other races, writing each
// game's history file once. A game that can't be read or written doesn't stop the others (electron-store
// throws when it can't write, as does web mode's localStorage when the quota is full); its snapshots are
// lost. `onSaved(GameID)` is called as soon as each game's file is written, so views refresh even if a
// later game fails. `isCurrent()` is asked right before each write: a pass that was superseded (a
// newer save was loaded while it read) stops there, because mergeGame trims every snapshot at or
// after its time, which for an older save would erase the newer pass's. Returns { recorded, failed,
// superseded }: how many races were saved, the games that couldn't be read or written, [{ GameID, stage:
// 'read' | 'write', error }], and whether the pass was abandoned.
export const recordHistory = async (database, { onSaved = () => {}, isCurrent = () => true } = {}) => {
  const { read, failed } = await readSave(database)
  let recorded = 0

  for (const { GameID, taken, intel } of read) {
    if (!isCurrent()) {
      return { recorded, failed, superseded: true }
    }

    if (taken.length) {
      try {
        const store = historyConfig(GameID)

        store.store = mergeGame(store.store, { gameName: taken[0].gameName, t: taken[0].snapshot.t, races: taken, intel })
      } catch (error) {
        failed.push({ GameID, stage: 'write', error })

        continue
      }

      recorded += taken.length
      onSaved(GameID)
    }
  }

  return { recorded, failed, superseded: false }
}
