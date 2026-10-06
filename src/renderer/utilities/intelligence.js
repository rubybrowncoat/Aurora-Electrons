// Intelligence: what one race knows about the others, decoded. Codes and thresholds come from the
// maintainer's reference for Aurora 2.7.1, references/mechanics/intelligence.md; the queries and
// their sample checks are in docs/plans/aurcalcs/sql-fleet.md § 7.
// Every read goes through the viewing race's own intelligence tables. The `Actual*` columns (and
// alien ship or population IDs) point at the real objects, so they're never joined.

// FCT_AlienRace.ContactStatus
export const CONTACT_STATUS = {
  0: { label: 'Hostile', color: 'error', icon: 'mdi-sword-cross' },
  1: { label: 'Neutral', color: 'grey', icon: 'mdi-minus-circle-outline' },
  2: { label: 'Friendly', color: 'success', icon: 'mdi-handshake-outline' },
  3: { label: 'Allied', color: 'primary', icon: 'mdi-shield-star-outline' },
  4: { label: 'Civilian', color: 'grey', icon: 'mdi-ferry' },
  5: { label: 'None', color: 'grey', icon: 'mdi-help-circle-outline' },
  6: { label: 'Combat', color: 'error', icon: 'mdi-flash-alert-outline' },
}

export const contactStatus = (code) => CONTACT_STATUS[code] || { label: `Status ${code}`, color: 'grey', icon: 'mdi-help-circle-outline' }

// FCT_AlienRace.CommStatus
export const COMM_STATUS = {
  0: 'No communication',
  1: 'Attempting communication',
  2: 'Communication established',
  3: 'Communication impossible',
}

export const ATTEMPTING_COMMUNICATION = 1

// FCT_KnownSpecies.Status
export const SPECIES_STATUS = { 0: 'Discovered', 1: 'Autopsied', 2: 'Fully known' }

// FCT_AlienClass.EngineType
export const ENGINE_TYPES = { 0: 'Unknown', 1: 'Military', 2: 'Commercial', 3: 'FAC', 4: 'Survey', 5: 'Fighter' }

// FCT_AlienClass.AlienClassRole, labelled by the rule that sets it rather than the game's tentative
// names: 1 for a launcher of size 4 or more, 2 for a smaller one, 3 for a beam whose power need is
// more than twice its recharge rate, 4 for any other beam.
export const CLASS_ROLES = { 0: 'Unknown', 1: 'Large missiles', 2: 'Small missiles', 3: 'Slow-recharge beams', 4: 'Fast-recharge beams', 5: 'Unknown', 6: 'Unknown' }

// Diplomatic points where treaties and statuses change (NPRs grant above a line and revoke below it).
export const DIPLOMACY_LINES = [
  { y: -100, label: 'Hostile below' },
  { y: 200, label: 'Trade treaty' },
  { y: 800, label: 'Geological treaty, Friendly' },
  { y: 2400, label: 'Gravitational treaty' },
  { y: 4000, label: 'Allied' },
  { y: 6000, label: 'Technology treaty' },
]

// The game's own wording for a relationship's points (the bands its intelligence reports use).
export const standing = (points) => (points < -100 ? 'At war' : points < 0 ? 'Negative' : points < 200 ? 'Neutral' : points < 800 ? 'Positive' : points < 4000 ? 'Friendly' : 'Allied')

// Race intelligence points buy one random discovery each time they pass this.
export const REWARD_COST = 100

// What a colony's intelligence points reveal, above (not at) each threshold.
export const POPULATION_LEVELS = [
  { threshold: 100, label: 'Population and installations', fields: ['PopulationAmount', 'Installations'] },
  { threshold: 200, label: 'Factories, mines, spaceport and cargo station', fields: ['Factories', 'Mines', 'Spaceport', 'CargoStation'] },
  { threshold: 300, label: 'Refineries, maintenance, refuelling and ordnance stations', fields: ['Refineries', 'MaintenanceFacilities', 'RefuellingStation', 'OrdnanceTransfer'] },
  { threshold: 500, label: 'Research, ground training, naval HQ and sector command', fields: ['ResearchFacilities', 'GFTF', 'NavalHeadquarters', 'SectorCommand'] },
]

// One field of a known colony: `known` once intelligence has ever been above its threshold (the
// value is then the last one seen), `current` while it still is (the game shows it green, else red).
export const populationField = (population, field) => {
  const level = POPULATION_LEVELS.find((entry) => entry.fields.includes(field))

  return {
    value: population[field],
    known: population.MaxIntelligence > level.threshold,
    current: population.AlienPopulationIntelligencePoints > level.threshold,
  }
}

// The highest level a colony's intelligence has unlocked (0 when none).
export const populationLevel = (population) => POPULATION_LEVELS.filter((level) => population.MaxIntelligence > level.threshold).length

// Ships, tonnage and losses known over time, rebuilt from the save's own timestamps: a ship counts
// from its first detection, and a destroyed one is lost at its last damage time (or, without one,
// its last contact). `ships`: [{ FirstDetected, Destroyed, GameTimeDamaged, LastContactTime, Tons }].
// Returns [{ t, alive, tons, lost }], one point per change, ending at `now`.
export const rebuildFleet = (ships, now) => {
  const events = []

  ships.forEach((ship) => {
    events.push({ t: ship.FirstDetected || 0, alive: 1, tons: ship.Tons || 0, lost: 0 })

    if (ship.Destroyed) {
      events.push({ t: ship.GameTimeDamaged || ship.LastContactTime || ship.FirstDetected || 0, alive: -1, tons: -(ship.Tons || 0), lost: 1 })
    }
  })

  events.sort((a, b) => a.t - b.t)

  const series = []
  let state = { alive: 0, tons: 0, lost: 0 }

  events.forEach((event) => {
    state = { alive: state.alive + event.alive, tons: state.tons + event.tons, lost: state.lost + event.lost }

    if (series.length && series[series.length - 1].t === event.t) {
      series[series.length - 1] = { t: event.t, ...state }
    } else {
      series.push({ t: event.t, ...state })
    }
  })

  if (series.length && now > series[series.length - 1].t) {
    series.push({ ...series[series.length - 1], t: now })
  }

  return series
}

// Times where race intelligence fell, each one a discovery the points were spent on.
export const rewardAttempts = (snapshots) => snapshots.filter((snapshot, index) => index > 0 && snapshot.intel < snapshots[index - 1].intel).map((snapshot) => snapshot.t)

// What the viewing race knows about every alien race it has met (one row each), with the game
// time. Also the treaties each side grants: the alien's grants sit on its own record, which the
// game's Intelligence window reads too; nothing else of that record is used.
export const alienRacesSql = (GameID, RaceID) => `select FCT_AlienRace.AlienRaceID, FCT_AlienRace.AlienRaceName, FCT_AlienRace.Abbrev, FCT_AlienRace.ContactStatus, FCT_AlienRace.CommStatus, FCT_AlienRace.CommModifier, FCT_AlienRace.CommEstablished, FCT_AlienRace.DiplomaticPoints, FCT_AlienRace.AlienRaceIntelligencePoints, FCT_AlienRace.DamageCausedByAlienRace, FCT_AlienRace.FirstDetected, FCT_AlienRace.FixedRelationship, FCT_AlienRace.TradeTreaty, FCT_AlienRace.TechTreaty, FCT_AlienRace.GeoTreaty, FCT_AlienRace.GravTreaty, coalesce(VIR_Theirs.TradeTreaty, 0) as TheirTradeTreaty, coalesce(VIR_Theirs.TechTreaty, 0) as TheirTechTreaty, coalesce(VIR_Theirs.GeoTreaty, 0) as TheirGeoTreaty, coalesce(VIR_Theirs.GravTreaty, 0) as TheirGravTreaty, FCT_Game.GameTime as Now, (select count(*) from FCT_AlienClass where FCT_AlienClass.GameID = FCT_AlienRace.GameID and FCT_AlienClass.ViewRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienClass.AlienRaceID = FCT_AlienRace.AlienRaceID) as KnownClasses, (select count(*) from FCT_AlienShip where FCT_AlienShip.GameID = FCT_AlienRace.GameID and FCT_AlienShip.ViewRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienShip.AlienRaceID = FCT_AlienRace.AlienRaceID and FCT_AlienShip.Destroyed = 0) as KnownShips, (select coalesce(sum(FCT_AlienClass.TCS), 0) * 50 from FCT_AlienShip inner join FCT_AlienClass on FCT_AlienClass.AlienClassID = FCT_AlienShip.AlienClassID where FCT_AlienShip.GameID = FCT_AlienRace.GameID and FCT_AlienShip.ViewRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienShip.AlienRaceID = FCT_AlienRace.AlienRaceID and FCT_AlienShip.Destroyed = 0) as KnownTons, (select count(*) from FCT_AlienShip where FCT_AlienShip.GameID = FCT_AlienRace.GameID and FCT_AlienShip.ViewRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienShip.AlienRaceID = FCT_AlienRace.AlienRaceID and FCT_AlienShip.Destroyed = 1) as DestroyedShips, (select max(FCT_AlienShip.LastContactTime) from FCT_AlienShip where FCT_AlienShip.GameID = FCT_AlienRace.GameID and FCT_AlienShip.ViewRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienShip.AlienRaceID = FCT_AlienRace.AlienRaceID) as LastContact, (select count(*) from FCT_AlienPopulation where FCT_AlienPopulation.GameID = FCT_AlienRace.GameID and FCT_AlienPopulation.ViewingRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienPopulation.AlienRaceID = FCT_AlienRace.AlienRaceID) as KnownPopulations, (select sum(FCT_AlienPopulation.PopulationAmount) from FCT_AlienPopulation where FCT_AlienPopulation.GameID = FCT_AlienRace.GameID and FCT_AlienPopulation.ViewingRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienPopulation.AlienRaceID = FCT_AlienRace.AlienRaceID and FCT_AlienPopulation.MaxIntelligence > 100) as KnownPopulation, (select count(*) from FCT_AlienSystem where FCT_AlienSystem.GameID = FCT_AlienRace.GameID and FCT_AlienSystem.DetectRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienSystem.AlienRaceID = FCT_AlienRace.AlienRaceID) as KnownSystems, (select count(*) from FCT_AlienGroundUnitClass where FCT_AlienGroundUnitClass.GameID = FCT_AlienRace.GameID and FCT_AlienGroundUnitClass.ViewRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienGroundUnitClass.AlienRaceID = FCT_AlienRace.AlienRaceID) as GroundClasses, (select count(*) from FCT_AlienRaceSensor where FCT_AlienRaceSensor.GameID = FCT_AlienRace.GameID and FCT_AlienRaceSensor.ViewingRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienRaceSensor.AlienRaceID = FCT_AlienRace.AlienRaceID) as KnownSensors from FCT_AlienRace inner join FCT_Game on FCT_Game.GameID = FCT_AlienRace.GameID left join FCT_AlienRace as VIR_Theirs on VIR_Theirs.GameID = FCT_AlienRace.GameID and VIR_Theirs.ViewRaceID = FCT_AlienRace.AlienRaceID and VIR_Theirs.AlienRaceID = FCT_AlienRace.ViewRaceID where FCT_AlienRace.GameID = ${GameID} and FCT_AlienRace.ViewRaceID = ${RaceID} order by FCT_AlienRace.FirstDetected`

// Treaties as a bitmask, for compact snapshots: trade 1, technology 2, geological 4, gravitational 8.
const treatyMask = (row, prefix = '') => (row[`${prefix}TradeTreaty`] ? 1 : 0) + (row[`${prefix}TechTreaty`] ? 2 : 0) + (row[`${prefix}GeoTreaty`] ? 4 : 0) + (row[`${prefix}GravTreaty`] ? 8 : 0)

const round = (value, decimals = 0) => Math.round((value || 0) * 10 ** decimals) / 10 ** decimals

// The recorded part of one alien race row: what changes over time.
export const intelSnapshot = (row) => ({
  t: row.Now,
  contact: row.ContactStatus,
  comm: row.CommStatus,
  translation: round(row.CommModifier, 1),
  points: round(row.DiplomaticPoints, 1),
  intel: round(row.AlienRaceIntelligencePoints, 1),
  granted: treatyMask(row),
  received: treatyMask(row, 'Their'),
  ships: row.KnownShips || 0,
  tons: Math.round(row.KnownTons || 0),
  lost: row.DestroyedShips || 0,
  classes: row.KnownClasses || 0,
  populations: row.KnownPopulations || 0,
  population: row.KnownPopulation === null || row.KnownPopulation === undefined ? null : round(row.KnownPopulation, 2),
  systems: row.KnownSystems || 0,
  ground: row.GroundClasses || 0,
  sensors: row.KnownSensors || 0,
})

// Whether two snapshots differ in anything but their time.
export const intelChanged = (previous, next) => Object.keys(next).some((key) => key !== 't' && previous[key] !== next[key])

// Treaty names from a mask.
export const treatyNames = (mask) => [[1, 'Trade'], [2, 'Technology'], [4, 'Geological'], [8, 'Gravitational']].filter(([bit]) => mask & bit).map(([, name]) => name)

// One recorded entry per alien race the viewing race knows: [{ AlienRaceID, name, snapshot }].
export const takeIntel = async (database, { GameID, RaceID }, options = {}) => {
  const [rows] = await database.query(alienRacesSql(GameID, RaceID), options)

  return rows.map((row) => ({ AlienRaceID: row.AlienRaceID, name: row.AlienRaceName, snapshot: intelSnapshot(row) }))
}
