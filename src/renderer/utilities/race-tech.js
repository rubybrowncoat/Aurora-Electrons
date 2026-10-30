// What the race has researched on the tech lines the design planners read, each as a ladder of levels, and the level the game itself designs with. The planners read the levels' figures (`info`, `info2`) and apply the design rules of design-rules.js to them. The levels the race could research next, with what each still needs, are tech-scenarios.js's: they need the research graph, which this module leaves out so that a check can load it alone.

// The lines of the propulsion and jump drive planners.
export const ENGINE_TECH_TYPE = 40
export const FUEL_TECH_TYPE = 65
export const THERMAL_TECH_TYPE = 127
export const MAX_THRUST_TECH_TYPE = 130
export const MIN_THRUST_TECH_TYPE = 198
export const MAX_ENGINE_SIZE_TECH_TYPE = 214
export const SQUADRON_RADIUS_TECH_TYPE = 6
export const SQUADRON_SIZE_TECH_TYPE = 7
export const JUMP_EFFICIENCY_TECH_TYPE = 8

// The lines of the missile, sensor, armour, reactor and cloak planners, as DIM_TechType names them.
export const MISSILE_LAUNCHER_SIZE_TECH_TYPE = 10
export const MISSILE_WARHEAD_TECH_TYPE = 12
export const MISSILE_RELOAD_TECH_TYPE = 13
export const REDUCED_SIZE_LAUNCHER_TECH_TYPE = 129
export const LASER_WARHEAD_EFFICIENCY_TECH_TYPE = 274
export const TERMINAL_GUIDANCE_TECH_TYPE = 275
export const MISSILE_RETARGETING_TECH_TYPE = 276
export const LASER_WARHEAD_FOCUS_TECH_TYPE = 277
export const MISSILE_ECM_TECH_TYPE = 279
export const MULTIPLE_WARHEADS_TECH_TYPE = 280
export const DECOY_MISSILE_TECH_TYPE = 281
export const THERMAL_SENSOR_TECH_TYPE = 19
export const ACTIVE_SENSOR_TECH_TYPE = 20
export const EM_SENSOR_TECH_TYPE = 125
export const GRAV_SURVEY_TECH_TYPE = 88
export const GEO_SURVEY_TECH_TYPE = 89
export const ACTIVE_SENSOR_KIND_TECH_TYPE = 152
export const ECCM_TECH_TYPE = 83
export const HARDENING_TECH_TYPE = 139
export const TRACKING_TIME_TECH_TYPE = 165
export const FIRE_CONTROL_RANGE_TECH_TYPE = 4
export const FIRE_CONTROL_SPEED_TECH_TYPE = 5
export const SINGLE_WEAPON_TECH_TYPE = 268
export const FIRE_CONTROL_SIZE_RANGE_TECH_TYPE = 17
export const FIRE_CONTROL_SIZE_TRACKING_TECH_TYPE = 18
export const ARMOUR_TECH_TYPE = 84
export const REACTOR_TECH_TYPE = 41
export const REACTOR_BOOST_TECH_TYPE = 42
export const CLOAK_EFFICIENCY_TECH_TYPE = 153
export const CLOAK_REDUCTION_TECH_TYPE = 154
export const CLOAK_MIN_SIZE_TECH_TYPE = 155

// One tech type of the registry. `name` is DIM_TechType's Description (a check reads it against each save), `group` the planner family it belongs to, `better` which way the figure `info` runs when it gets better ('higher', 'lower', or 'none' for a switch or a level with no best end; a check reads it against each save's levels, ordered by development cost), and `info` and `info2` what `AdditionalInfo` and `AdditionalInfo2` of a level of the type are, or null for a figure the planners do not read. A figure the registry gives no meaning is one nobody has verified: it stays out of every rule.
const family = (typeId, name, group, better, info, info2 = null) => Object.freeze({ typeId, name, group, better, info, info2 })

const FAMILY_LIST = [
  family(ENGINE_TECH_TYPE, 'Engine Technology', 'propulsion', 'higher', 'engine power per HS at a thrust modifier of 1 (EP/HS)'),
  family(FUEL_TECH_TYPE, 'Fuel Consumption', 'propulsion', 'lower', 'litres per engine power hour at a thrust modifier of 1 and an engine of 10 HS (L/EP h)'),
  family(THERMAL_TECH_TYPE, 'Thermal Reduction', 'propulsion', 'lower', 'the multiplier on an engine\'s thermal signature', 'the multiplier on an engine\'s BP cost, applied when `info` is under 1'),
  family(MAX_THRUST_TECH_TYPE, 'Max Engine Thrust Modifier', 'propulsion', 'higher', 'the greatest thrust modifier of an engine'),
  family(MIN_THRUST_TECH_TYPE, 'Min Engine Thrust Modifier', 'propulsion', 'lower', 'the least thrust modifier of an engine'),
  family(MAX_ENGINE_SIZE_TECH_TYPE, 'Maximum Engine Size', 'propulsion', 'higher', 'the largest engine (HS)'),
  family(JUMP_EFFICIENCY_TECH_TYPE, 'Jump Drive Efficiency', 'jump', 'higher', 'the drive\'s efficiency: the ship size it moves per HS of drive, before the size scaling'),
  family(SQUADRON_SIZE_TECH_TYPE, 'Max Jump Squadron Size', 'jump', 'higher', 'ships a squadron jump carries', 'the factor on the drive\'s BP cost'),
  family(SQUADRON_RADIUS_TECH_TYPE, 'Max Squadron Jump Radius', 'jump', 'higher', 'the radius of a squadron jump (km)', 'the factor on the drive\'s BP cost'),
  family(MISSILE_LAUNCHER_SIZE_TECH_TYPE, 'Missile Launcher Size', 'missile', 'higher', 'the largest missile a launcher takes'),
  family(REDUCED_SIZE_LAUNCHER_TECH_TYPE, 'Reduced Size Launchers', 'missile', 'lower', 'the launcher\'s size as a share of a standard launcher', 'the reload rate as a multiple of a standard launcher\'s'),
  family(MISSILE_WARHEAD_TECH_TYPE, 'Missile Warhead Strength', 'missile', 'higher', 'warhead strength per MSP of warhead'),
  family(MISSILE_RELOAD_TECH_TYPE, 'Missile Launcher Reload Rate', 'missile', 'higher', 'the reload rate level'),
  family(LASER_WARHEAD_EFFICIENCY_TECH_TYPE, 'Laser Warhead Damage Efficiency', 'missile', 'higher', 'the share of the warhead\'s strength a laser warhead keeps (%)'),
  family(TERMINAL_GUIDANCE_TECH_TYPE, 'Active Terminal Guidance', 'missile', 'higher', 'the multiplier on the missile\'s hit chance'),
  family(MISSILE_RETARGETING_TECH_TYPE, 'Missile Retargeting', 'missile', 'higher', 'whether a missile can retarget (1) or not (0)'),
  family(LASER_WARHEAD_FOCUS_TECH_TYPE, 'Laser Warhead Focus', 'missile', 'higher', 'the range a laser warhead is focused to (km)'),
  family(MISSILE_ECM_TECH_TYPE, 'Missile ECM', 'missile', 'higher', 'the missile\'s ECM level'),
  family(MULTIPLE_WARHEADS_TECH_TYPE, 'Multiple Warheads', 'missile', 'higher', 'whether a missile can carry several warheads (1) or not (0)'),
  family(DECOY_MISSILE_TECH_TYPE, 'Decoy Missiles', 'missile', 'higher', 'whether a decoy missile can be designed (1)'),
  family(THERMAL_SENSOR_TECH_TYPE, 'Thermal Sensor Sensitivity', 'sensor', 'higher', 'the sensitivity of a thermal sensor'),
  family(ACTIVE_SENSOR_TECH_TYPE, 'Active Sensor Strength', 'sensor', 'higher', 'the strength of an active sensor per HS'),
  family(EM_SENSOR_TECH_TYPE, 'EM Sensor Sensitivity', 'sensor', 'higher', 'the sensitivity of an EM sensor'),
  family(GRAV_SURVEY_TECH_TYPE, 'Grav Survey Sensors', 'sensor', 'higher', 'survey points of a gravitational survey sensor'),
  family(GEO_SURVEY_TECH_TYPE, 'Geo Survey Sensors', 'sensor', 'higher', 'survey points of a geological survey sensor'),
  family(ACTIVE_SENSOR_KIND_TECH_TYPE, 'Active Sensor Type', 'sensor', 'higher', 'the kind of active sensor: a search sensor (0) or a missile fire control (1)'),
  family(ECCM_TECH_TYPE, 'ECCM', 'sensor', 'higher', 'the ECCM rating', 'the factor on the BP cost of the component'),
  family(HARDENING_TECH_TYPE, 'Hardening', 'sensor', 'lower', 'the chance to damage a hardened component takes (%)', 'the factor on the BP cost of the component'),
  family(TRACKING_TIME_TECH_TYPE, 'Max Tracking Time Bonus', 'sensor', 'higher', 'the longest tracking time that earns the bonus against missiles (s)'),
  family(FIRE_CONTROL_RANGE_TECH_TYPE, 'Fire Control Distance Rating', 'sensor', 'higher', 'the range rating of a beam fire control (km)'),
  family(FIRE_CONTROL_SPEED_TECH_TYPE, 'Fire Control Speed Rating', 'sensor', 'higher', 'the tracking speed rating of a beam fire control (km/s)'),
  family(SINGLE_WEAPON_TECH_TYPE, 'Single Weapon Fire Control', 'sensor', 'none', 'the weapon number of a beam fire control: 1 for a multi-weapon control, 0.5 for a single-weapon control, which halves the size and cost'),
  family(FIRE_CONTROL_SIZE_RANGE_TECH_TYPE, 'Fire Control Size vs Range', 'sensor', 'none', 'the size and range factor of a beam fire control the level\'s name gives (0.9x, 1x, 2x; it does not rise with development cost in every step)'),
  family(FIRE_CONTROL_SIZE_TRACKING_TECH_TYPE, 'Fire Control Size vs Tracking Speed', 'sensor', 'none', 'the size and tracking speed factor of a beam fire control the level\'s name gives (it does not rise with development cost in every step)'),
  family(ARMOUR_TECH_TYPE, 'Armour', 'armour', 'higher', 'armour strength per HS of plate (the stored strength of a 1 HS plate)'),
  family(REACTOR_TECH_TYPE, 'Power Plant Technology', 'reactor', 'higher', 'the reactor\'s power per HS to the power of 1.5, before the boost'),
  family(REACTOR_BOOST_TECH_TYPE, 'Power vs Efficiency', 'reactor', 'higher', 'the multiplier on the reactor\'s power (the boost)', 'the reactor\'s chance to explode (%)'),
  family(CLOAK_EFFICIENCY_TECH_TYPE, 'Cloaking Efficiency', 'cloak', 'higher', 'the ship size (HS) a cloak covers per HS of cloak'),
  family(CLOAK_REDUCTION_TECH_TYPE, 'Cloaking Sensor Reduction', 'cloak', 'lower', 'the share of the cross-section that remains under the cloak'),
  family(CLOAK_MIN_SIZE_TECH_TYPE, 'Minimum Cloak Size', 'cloak', 'lower', 'the smallest cloak (HS)'),
]

// Every tech type the planners read, by id.
export const TECH_FAMILIES = Object.freeze(Object.fromEntries(FAMILY_LIST.map((item) => [item.typeId, item])))

export const techFamily = (typeId) => TECH_FAMILIES[typeId] || null

const typesOf = (group) => Object.freeze(FAMILY_LIST.filter((item) => item.group === group).map((item) => item.typeId))

// The lines in the order the planners list them.
export const PROPULSION_TECH_TYPES = typesOf('propulsion')
export const JUMP_DRIVE_TECH_TYPES = typesOf('jump')
export const MISSILE_TECH_TYPES = typesOf('missile')
export const SENSOR_TECH_TYPES = typesOf('sensor')
export const ARMOUR_TECH_TYPES = typesOf('armour')
export const REACTOR_TECH_TYPES = typesOf('reactor')
export const CLOAK_TECH_TYPES = typesOf('cloak')
export const RACE_TECH_TYPES = Object.freeze(FAMILY_LIST.map((item) => item.typeId))

// The tech line each figure of the sensor and fire control planner reads, by the role of the figure (design-data.js SENSOR_TECH numbers the same types for the saved components).
export const SENSOR_PLANNER_LINES = Object.freeze({ strength: ACTIVE_SENSOR_TECH_TYPE, em: EM_SENSOR_TECH_TYPE, thermal: THERMAL_SENSOR_TECH_TYPE, hardening: HARDENING_TECH_TYPE, eccm: ECCM_TECH_TYPE, distance: FIRE_CONTROL_RANGE_TECH_TYPE, speed: FIRE_CONTROL_SPEED_TECH_TYPE, singleWeapon: SINGLE_WEAPON_TECH_TYPE })

// The fixed techs the game's automatic design uses whatever the race has researched: the default squadron size and radius, and the two drive types.
const FIXED_TECHS = [819, 827, 33302, 33303]

const LEVEL_COLUMNS = 'FCT_TechSystem.TechSystemID, FCT_TechSystem.GameID, FCT_TechSystem.TechTypeID, FCT_TechSystem.Name, FCT_TechSystem.ComponentName, FCT_TechSystem.AdditionalInfo, FCT_TechSystem.AdditionalInfo2, FCT_TechSystem.DevelopCost'

const RACE_TECH_TABLE = 'FCT_RaceTech'

// The columns a save may lack and the planners go on without: the obsolete flag of a researched level. It decides neither ownership nor the game's pick, so a save without it gives a level whose flag is null (unknown), and no query names the column by its table.
const RACE_TECH_OPTIONAL = ['Obsolete']

const optionalColumns = (columns) => RACE_TECH_OPTIONAL.map((name) => (columns.has(name) ? `${RACE_TECH_TABLE}.${name} as ${name}` : `null as ${name}`)).join(', ')

// The levels the race has researched, whichever game they belong to: the baseline rows (game 0) and the rows a game adds.
const researchedSql = (columns) => `select ${LEVEL_COLUMNS}, ${optionalColumns(columns)} from FCT_RaceTech inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID where FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID and FCT_TechSystem.TechTypeID in (${RACE_TECH_TYPES.join(', ')}) order by FCT_TechSystem.TechTypeID, FCT_TechSystem.DevelopCost, FCT_TechSystem.TechSystemID`

const FIXED_SQL = `select ${LEVEL_COLUMNS} from FCT_TechSystem where FCT_TechSystem.TechSystemID in (${FIXED_TECHS.join(', ')})`

// A level as the planners read it: the figures (`info`, `info2`), the development cost, and whether the row is a baseline row of the catalogue (game 0) or one the game added.
export const level = (row) => ({
  id: row.TechSystemID,
  typeId: row.TechTypeID,
  name: row.Name,
  componentName: row.ComponentName || row.Name,
  info: row.AdditionalInfo,
  info2: row.AdditionalInfo2,
  cost: row.DevelopCost,
  baseline: row.GameID === 0,
  obsolete: row.Obsolete === null ? null : Boolean(row.Obsolete),
})

// The level the game designs with: the researched one that cost the most to develop, which is the best one for engines and drives and the lowest figure for fuel and thermal reduction. It is never the one with the highest or the lowest figure. A tie goes to the first level listed. Null for a line with no level researched.
export const gamePick = (levels) => levels.reduce((best, item) => (!best || item.cost > best.cost ? item : best), null)

// One line of the race's tech: its `levels` researched, cheapest first, and the game's `pick`.
const line = (typeId, researched) => ({ typeId, levels: researched, pick: gamePick(researched) })

// The lines from the rows the queries give: `researched` the race's levels (ordered by type, then development cost) and `fixed` the fixed techs.
export const buildRaceTech = (researched, fixed = []) => {
  const researchedByType = {}

  researched.forEach((row) => (researchedByType[row.TechTypeID] = researchedByType[row.TechTypeID] || []).push(level(row)))

  const lines = {}

  RACE_TECH_TYPES.forEach((typeId) => {
    lines[typeId] = line(typeId, researchedByType[typeId] || [])
  })

  return Object.freeze({
    lines: Object.freeze(lines),
    fixed: Object.freeze(Object.fromEntries(fixed.map((row) => [row.TechSystemID, level(row)]))),
  })
}

// Per tech type of RACE_TECH_TYPES, its line; `fixed` has the fixed techs by id. A race that has researched nothing on a line has an empty `levels` and a null `pick`.
export const loadRaceTech = async (database, { GameID, RaceID }) => {
  const [[columnRows], [fixed]] = await Promise.all([database.query(`select name from pragma_table_info('${RACE_TECH_TABLE}')`), database.query(FIXED_SQL)])
  const [researched] = await database.query(researchedSql(new Set(columnRows.map((row) => row.name))), { replacements: { GameID, RaceID } })

  return buildRaceTech(researched, fixed)
}

// What a page holds before the race's tech is read: every line empty.
export const NO_RACE_TECH = buildRaceTech([])
