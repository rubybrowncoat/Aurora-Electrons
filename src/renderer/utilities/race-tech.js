// What the race has researched on the tech lines the design planners read, each as a ladder of levels, with the level the game itself designs with and the next one to research. The planners read the levels' figures (`info`, `info2`) and apply the design rules of design-rules.js to them.

export const ENGINE_TECH_TYPE = 40
export const FUEL_TECH_TYPE = 65
export const THERMAL_TECH_TYPE = 127
export const MAX_THRUST_TECH_TYPE = 130
export const MIN_THRUST_TECH_TYPE = 198
export const MAX_ENGINE_SIZE_TECH_TYPE = 214
export const SQUADRON_RADIUS_TECH_TYPE = 6
export const SQUADRON_SIZE_TECH_TYPE = 7
export const JUMP_EFFICIENCY_TECH_TYPE = 8

// The lines in the order the planners list them.
export const PROPULSION_TECH_TYPES = [ENGINE_TECH_TYPE, FUEL_TECH_TYPE, THERMAL_TECH_TYPE, MAX_THRUST_TECH_TYPE, MIN_THRUST_TECH_TYPE, MAX_ENGINE_SIZE_TECH_TYPE]
export const JUMP_DRIVE_TECH_TYPES = [JUMP_EFFICIENCY_TECH_TYPE, SQUADRON_SIZE_TECH_TYPE, SQUADRON_RADIUS_TECH_TYPE]
export const RACE_TECH_TYPES = [...PROPULSION_TECH_TYPES, ...JUMP_DRIVE_TECH_TYPES]

// The fixed techs the game's automatic design uses whatever the race has researched: the default squadron size and radius, and the two drive types.
const FIXED_TECHS = [819, 827, 33302, 33303]

const LEVEL_COLUMNS = 'FCT_TechSystem.TechSystemID, FCT_TechSystem.TechTypeID, FCT_TechSystem.Name, FCT_TechSystem.ComponentName, FCT_TechSystem.AdditionalInfo, FCT_TechSystem.AdditionalInfo2, FCT_TechSystem.DevelopCost'

const RESEARCHED_SQL = `select ${LEVEL_COLUMNS}, FCT_RaceTech.Obsolete from FCT_RaceTech inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID where FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID and FCT_TechSystem.TechTypeID in (${RACE_TECH_TYPES.join(', ')}) order by FCT_TechSystem.TechTypeID, FCT_TechSystem.DevelopCost, FCT_TechSystem.TechSystemID`

// The catalogue's levels the race has not researched yet, on the same lines: the base techs (game 0) that are not for ruins and belong to nobody or to the race.
const UNRESEARCHED_SQL = `select ${LEVEL_COLUMNS} from FCT_TechSystem where FCT_TechSystem.GameID = 0 and FCT_TechSystem.RuinOnly = 0 and FCT_TechSystem.RaceID in (0, :RaceID) and FCT_TechSystem.TechTypeID in (${RACE_TECH_TYPES.join(', ')}) and FCT_TechSystem.TechSystemID not in (select FCT_RaceTech.TechID from FCT_RaceTech where FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID) order by FCT_TechSystem.TechTypeID, FCT_TechSystem.DevelopCost, FCT_TechSystem.TechSystemID`

const FIXED_SQL = `select ${LEVEL_COLUMNS} from FCT_TechSystem where FCT_TechSystem.TechSystemID in (${FIXED_TECHS.join(', ')})`

const level = (row) => ({
  id: row.TechSystemID,
  typeId: row.TechTypeID,
  name: row.Name,
  componentName: row.ComponentName || row.Name,
  info: row.AdditionalInfo,
  info2: row.AdditionalInfo2,
  cost: row.DevelopCost,
  obsolete: Boolean(row.Obsolete),
})

// The level the game designs with: the researched one that cost the most to develop, which is the best one for engines and drives and the lowest figure for fuel and thermal reduction. A tie goes to the first level listed. Null for a line with no level researched.
export const gamePick = (levels) => levels.reduce((best, item) => (!best || item.cost > best.cost ? item : best), null)

// The cheapest level of `unresearched` that costs more than `pick` (any of them without a pick), as the next one to research.
const nextLevel = (pick, unresearched) => unresearched.find((item) => !pick || item.cost > pick.cost) || null

// One line of the race's tech: `levels` researched, cheapest first, the game's `pick`, and the `next` level to research, whose `cost` is its RP.
const line = (typeId, researched, unresearched) => {
  const pick = gamePick(researched)

  return { typeId, levels: researched, pick, next: nextLevel(pick, unresearched) }
}

// Per tech type of RACE_TECH_TYPES, its line; `fixed` has the fixed techs by id. A race that has researched nothing on a line has an empty `levels` and a null `pick`.
export const loadRaceTech = async (database, { GameID, RaceID }) => {
  const [[researched], [unresearched], [fixed]] = await Promise.all([
    database.query(RESEARCHED_SQL, { replacements: { GameID, RaceID } }),
    database.query(UNRESEARCHED_SQL, { replacements: { GameID, RaceID } }),
    database.query(FIXED_SQL),
  ])
  const researchedByType = {}
  const unresearchedByType = {}

  researched.forEach((row) => (researchedByType[row.TechTypeID] = researchedByType[row.TechTypeID] || []).push(level(row)))
  unresearched.forEach((row) => (unresearchedByType[row.TechTypeID] = unresearchedByType[row.TechTypeID] || []).push(level(row)))

  const lines = {}

  RACE_TECH_TYPES.forEach((typeId) => {
    lines[typeId] = line(typeId, researchedByType[typeId] || [], unresearchedByType[typeId] || [])
  })

  return Object.freeze({
    lines: Object.freeze(lines),
    fixed: Object.freeze(Object.fromEntries(fixed.map((row) => [row.TechSystemID, level(row)]))),
  })
}

// What a page holds before the race's tech is read: every line empty.
export const NO_RACE_TECH = Object.freeze({
  lines: Object.freeze(Object.fromEntries(RACE_TECH_TYPES.map((typeId) => [typeId, Object.freeze(line(typeId, [], []))]))),
  fixed: Object.freeze({}),
})
