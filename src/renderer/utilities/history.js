// Empire History: the app's own record of each race, one snapshot per game save it sees. Aurora keeps no history beyond a year of wealth and a few weeks of the mineral ledger, so this is the only way to chart growth. Each game has its own electron-store file, `history/game-<GameID>.json` beside the settings, never the save. See docs/plans/aurcalcs/build-3.md § Empire History.

import Config from 'electron-store'

import { toBoolean, toNumber } from './aurora'
import { SERVING_COMMANDER } from './commanders'
import { intelChanged, takeIntel } from './intelligence'
import { isKnownNumber } from './math'
import { combine, ofRule, registerRule, sumResults, unavailable } from './provenance'

const HISTORY_VERSIONS = ['2.7.x']

registerRule({
  id: 'history.population',
  versions: HISTORY_VERSIONS,
  units: 'M people',
  verification: 'confirmed',
  structure: ['FCT_Population.Population'],
  note: 'The sum of the race\'s colony populations when the snapshot was taken, as stored. A colony whose population is not stored leaves the sum unknown.',
})

registerRule({
  id: 'history.colonies',
  versions: HISTORY_VERSIONS,
  units: 'colonies',
  verification: 'confirmed',
  structure: ['FCT_Population.Population'],
  note: 'The number of the race\'s colonies with a population above 0 when the snapshot was taken. A colony whose population is not stored leaves the count unknown.',
})

registerRule({
  id: 'history.treasury',
  versions: HISTORY_VERSIONS,
  units: 'wealth',
  verification: 'confirmed',
  structure: ['FCT_Race.WealthPoints'],
  note: 'The race\'s stored treasury when the snapshot was taken. A save with no stored treasury gives no figure.',
})

registerRule({
  id: 'history.income',
  versions: HISTORY_VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: ['FCT_Race.AnnualWealth'],
  note: 'The race\'s stored annual wealth when the snapshot was taken. What the column counts (income or net) is inferred from the saves and not checked against the wealth ledger.',
})

registerRule({
  id: 'history.stockpile',
  versions: HISTORY_VERSIONS,
  units: 't, L, MSP',
  verification: 'confirmed',
  structure: ['FCT_Population.FuelStockpile, MaintenanceStockpile, Duranium to Gallicite'],
  note: 'The sum of the colonies\' stockpile of one fuel, maintenance supply or mineral when the snapshot was taken, as stored. Ships\' own stocks are not in it. A colony with no stored amount leaves the sum unknown.',
})

registerRule({
  id: 'history.ships',
  versions: HISTORY_VERSIONS,
  units: 'ships',
  verification: 'confirmed',
  structure: ['FCT_Ship, FCT_ShipClass.Commercial'],
  note: 'The race\'s ships of non-shipping-line fleets, military or commercial by their class, when the snapshot was taken. No ship of a kind is a known 0.',
})

registerRule({
  id: 'history.fleetTonnage',
  versions: HISTORY_VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_ShipClass.Size', 'FCT_Ship'],
  note: 'The class size of each ship times 50 t per hull space, added up. The 50 t per hull space is the app\'s own constant and is not checked against a stored tonnage. A class with no stored size leaves the sum unknown.',
})

registerRule({
  id: 'history.installations',
  versions: HISTORY_VERSIONS,
  units: 'installations',
  verification: 'confirmed',
  structure: ['FCT_PopulationInstallations.Amount'],
  note: 'The installations of one type over the race\'s colonies, added up as stored. A type with no row is none built; a row with no stored amount leaves the type unknown.',
})

registerRule({
  id: 'history.research',
  versions: HISTORY_VERSIONS,
  units: 'RP',
  verification: 'confirmed',
  structure: ['FCT_RaceTech.TechID', 'FCT_TechSystem.DevelopCost'],
  note: 'The development cost of every technology the race has researched, added up as stored. A technology with no stored cost leaves the sum unknown.',
})

registerRule({
  id: 'history.systems',
  versions: HISTORY_VERSIONS,
  units: 'systems',
  verification: 'confirmed',
  structure: ['FCT_RaceSysSurvey'],
  note: 'The number of systems the race knows when the snapshot was taken.',
})

registerRule({
  id: 'history.commanders',
  versions: HISTORY_VERSIONS,
  units: 'commanders',
  verification: 'confirmed',
  structure: ['FCT_Commander'],
  note: 'The number of serving commanders of the race when the snapshot was taken.',
})

registerRule({
  id: 'history.change',
  versions: HISTORY_VERSIONS,
  units: 'as the figure',
  verification: 'confirmed',
  structure: ['two snapshots of the app\'s history file'],
  note: 'The difference between the latest snapshot in the window and the first. Arithmetic on two recorded figures; it is unknown when either is.',
})

registerRule({
  id: 'history.recordedSpan',
  versions: HISTORY_VERSIONS,
  units: 'years',
  verification: 'confirmed',
  structure: ['snapshot game times'],
  note: 'The span between the first and the latest snapshot and how much of the chosen window it fills. Time before the first snapshot was never observed and is not inferred.',
})

registerRule({
  id: 'history.timeAxis',
  versions: HISTORY_VERSIONS,
  units: 'game year',
  verification: 'confirmed',
  structure: ['FCT_Game.StartYear', 'snapshot game times'],
  note: 'A snapshot\'s year is the game\'s start year plus its game time over 31,536,000 s. Without a start year no calendar year can be given and the axis counts game years elapsed.',
})

// The rule each snapshot field is figured by, and the name a result gives for it when the field is missing.
export const SNAPSHOT_FIELDS = Object.freeze({
  population: { rule: 'history.population', label: 'population' },
  colonies: { rule: 'history.colonies', label: 'colony count' },
  wealth: { rule: 'history.treasury', label: 'treasury' },
  income: { rule: 'history.income', label: 'annual income' },
  fuel: { rule: 'history.stockpile', label: 'fuel stockpile' },
  msp: { rule: 'history.stockpile', label: 'maintenance supply stockpile' },
  militaryShips: { rule: 'history.ships', label: 'military ship count' },
  commercialShips: { rule: 'history.ships', label: 'commercial ship count' },
  militaryTons: { rule: 'history.fleetTonnage', label: 'military tonnage' },
  commercialTons: { rule: 'history.fleetTonnage', label: 'commercial tonnage' },
  research: { rule: 'history.research', label: 'research total' },
  systems: { rule: 'history.systems', label: 'known system count' },
  commanders: { rule: 'history.commanders', label: 'commander count' },
})

const figure = (rule, label, value, units) => (isKnownNumber(value) ? ofRule({ rule, value: Number(value), inputs: { present: [label] }, units }) : unavailable({ rule, missing: [label], units }))

// One field of a snapshot as a result of its rule: unavailable, naming the field, when the snapshot lacks it (a record from before the field was kept, or a figure the save could not give), never 0.
export const snapshotResult = (snapshot, key) => {
  const { rule, label } = SNAPSHOT_FIELDS[key]

  return figure(rule, label, snapshot ? snapshot[key] : null)
}

// One mineral's stockpile (`id` 1 to 11) in a snapshot; `name` is the mineral's name.
export const mineralResult = (snapshot, id, name) => figure('history.stockpile', `${name} stockpile`, snapshot && Array.isArray(snapshot.minerals) ? snapshot.minerals[id - 1] : null)

// One installation type's amount in a snapshot: none built when the snapshot lists installations without it, unknown when the snapshot lists none at all or a null amount for it.
export const installationResult = (snapshot, id, name) => {
  const label = `${name} installations`

  if (!snapshot || !snapshot.installations || typeof snapshot.installations !== 'object') {
    return unavailable({ rule: 'history.installations', missing: [label] })
  }

  return Object.prototype.hasOwnProperty.call(snapshot.installations, id) ? figure('history.installations', label, snapshot.installations[id]) : ofRule({ rule: 'history.installations', value: 0, inputs: { present: [label] } })
}

// The change of a figure between two results of one rule (later minus earlier); unavailable when either is.
export const changeResult = (earlier, later) => combine({ rule: 'history.change', parts: { earlier, later }, compute: ({ earlier: from, later: to }) => to - from, units: later.units })

// The sum of results of one rule (the military and commercial tonnage): unavailable when any is.
export const totalResult = (rule, results) => sumResults({ rule, results })

// More than this many snapshots per race and the older half is thinned to every other one, so a long campaign keeps its whole span at a coarser grain (about 1 MB per race at the cap).
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

// Player races and NPR empires are recorded. Aurora's special factions (Precursors, Invaders, Rakhas, Eldar, Ancients and the like, `SpecialNPRID` > 0) have no empire to chart.
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

// What a race's recording covers, from its time-ordered snapshots: { count, first, last, seconds } with the game times of the first and latest snapshot (null when there are none) and the span between them; `covered` is how much of the last `windowSeconds` that span fills, or the whole span when `windowSeconds` is 0, and `inWindow` how many snapshots fall in that window. Nothing is inferred for time before the first snapshot.
export const recordedSpan = (snapshots, windowSeconds = 0) => {
  if (!snapshots.length) {
    return { count: 0, first: null, last: null, seconds: 0, covered: 0, inWindow: 0 }
  }

  const first = snapshots[0].t
  const last = snapshots[snapshots.length - 1].t
  const seconds = last - first
  const since = windowSeconds ? last - windowSeconds : -Infinity

  return { count: snapshots.length, first, last, seconds, covered: windowSeconds ? Math.min(seconds, windowSeconds) : seconds, inWindow: snapshots.filter((snapshot) => snapshot.t >= since).length }
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

// Add one save's snapshots to a game's history. `history` is the file's contents (or empty), and everything was taken at game time `t`:
// - `races`: [{ RaceID, raceName, npr, snapshot }];
// - `intel`: { [ViewRaceID]: [{ AlienRaceID, name, snapshot }] }, what each race knows of the others.
// Rules:
// - Another game under the same GameID (another name) starts over.
// - Every record loses its snapshots at or after `t`: an older save reloaded means that future didn't happen, and a save at a recorded time replaces it.
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

// The sum of a column over rows, or null when any row has no stored value: a total with a missing term is unknown, not the sum of the rest. No rows is a known 0.
const sum = (rows, key) => (rows.every((row) => isKnownNumber(row[key])) ? rows.reduce((total, row) => total + Number(row[key]), 0) : null)

const nullable = (value) => (isKnownNumber(value) ? Number(value) : null)

const rounded = (value, scale = 1) => (value === null ? null : Math.round(value * scale) / scale)

// One race's state now, compact enough to keep thousands of: population, treasury, stockpiles, ships, installations, research and exploration. `options` go to every query (the recorder passes its read transaction).
export const takeSnapshot = async (database, { GameID, RaceID }, options = {}) => {
  const query = (sql) => database.query(sql, options).then(([items]) => items)
  const [[race], colonies, ships, installations, [counts]] = await Promise.all([
    query(`select FCT_Game.GameTime, FCT_Game.GameName, FCT_Race.RaceTitle, FCT_Race.WealthPoints, FCT_Race.AnnualWealth from FCT_Race inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`),
    query(`select FCT_Population.Population, FCT_Population.FuelStockpile, FCT_Population.MaintenanceStockpile, FCT_Population.Duranium, FCT_Population.Neutronium, FCT_Population.Corbomite, FCT_Population.Tritanium, FCT_Population.Boronide, FCT_Population.Mercassium, FCT_Population.Vendarite, FCT_Population.Sorium, FCT_Population.Uridium, FCT_Population.Corundium, FCT_Population.Gallicite from FCT_Population where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`),
    query(`select FCT_ShipClass.Commercial, count(*) as Ships, case when count(FCT_ShipClass.Size) = count(*) then sum(FCT_ShipClass.Size * 50) end as Tons from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 group by FCT_ShipClass.Commercial`),
    query(`select FCT_PopulationInstallations.PlanetaryInstallationID as ID, case when count(FCT_PopulationInstallations.Amount) = count(*) then sum(FCT_PopulationInstallations.Amount) end as Amount from FCT_PopulationInstallations inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (FCT_PopulationInstallations.Amount > 0 or FCT_PopulationInstallations.Amount is null) group by FCT_PopulationInstallations.PlanetaryInstallationID`),
    query(`select (select case when count(FCT_TechSystem.DevelopCost) = count(*) then coalesce(sum(FCT_TechSystem.DevelopCost), 0) end from FCT_RaceTech inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID where FCT_RaceTech.GameID = ${GameID} and FCT_RaceTech.RaceID = ${RaceID}) as Research, (select count(*) from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}) as Systems, (select count(*) from FCT_Commander where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and ${SERVING_COMMANDER}) as Commanders`),
  ])

  if (!race) {
    return null
  }

  // No ship of a kind is a known 0 ships and 0 t; a class with no stored size makes the tonnage null.
  const shipsOf = (commercial) => ships.find((row) => !!row.Commercial === commercial) || { Ships: 0, Tons: 0 }
  const military = shipsOf(false)
  const commercial = shipsOf(true)
  const populated = colonies.every((colony) => isKnownNumber(colony.Population))

  return {
    gameName: race.GameName,
    raceName: race.RaceTitle,
    snapshot: {
      t: race.GameTime,
      population: sum(colonies, 'Population'),
      colonies: populated ? colonies.filter((colony) => colony.Population > 0).length : null,
      wealth: nullable(race.WealthPoints),
      income: nullable(race.AnnualWealth),
      fuel: sum(colonies, 'FuelStockpile'),
      msp: sum(colonies, 'MaintenanceStockpile'),
      // Colony stockpiles, Duranium to Gallicite (mineral IDs 1–11); null where a colony has no stored amount.
      minerals: ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite'].map((name) => rounded(sum(colonies, name))),
      militaryShips: military.Ships,
      militaryTons: rounded(nullable(military.Tons)),
      commercialShips: commercial.Ships,
      commercialTons: rounded(nullable(commercial.Tons)),
      // { PlanetaryInstallationID: amount }, null for a type with a row that has no stored amount.
      installations: Object.fromEntries(installations.map((row) => [row.ID, rounded(nullable(row.Amount), 100)])),
      research: nullable(counts.Research),
      systems: counts.Systems,
      commanders: counts.Commanders,
    },
  }
}

// Everything one pass takes from the save: { read, failed }. `read` is [{ GameID, taken, intel }] per game, `taken` being [{ RaceID, raceName, npr, gameName, snapshot }] and `intel` { [ViewRaceID]: takeIntel() }; `failed` is the games that couldn't be read, [{ GameID, stage: 'read', error }]. It all happens in one read transaction, so a save written meanwhile can't give one race's snapshot the old save and the next one's the new. In SQLite a read transaction holds a shared lock from its first SELECT, which in rollback-journal mode (Aurora's) makes the game wait to commit: the reads are a few dozen small queries, and the history files are written after it ends.
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

// Snapshot every recorded race in the save, and what each knows of the other races, writing each game's history file once. A game that can't be read or written doesn't stop the others (electron-store throws when it can't write, as does web mode's localStorage when the quota is full); its snapshots are lost. `onSaved(GameID)` is called as soon as each game's file is written, so views refresh even if a later game fails. `isCurrent()` is asked right before each write: a pass that was superseded (a newer save was loaded while it read) stops there, because mergeGame trims every snapshot at or after its time, which for an older save would erase the newer pass's. Returns { recorded, failed, superseded }: how many races were saved, the games that couldn't be read or written, [{ GameID, stage: 'read' | 'write', error }], and whether the pass was abandoned.
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
