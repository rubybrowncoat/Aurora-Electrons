// Intelligence: what one race knows about the others, decoded. Codes and thresholds come from the maintainer's reference for Aurora 2.7.1, references/mechanics/intelligence.md; the queries and their sample checks are in docs/plans/aurcalcs/sql-fleet.md § 7.
// Every read goes through the viewing race's own intelligence tables. The `Actual*` columns (and alien ship or population IDs) point at the real objects, so they're never joined.

import { STATUS, UNVERIFIED_SAVE, envelope, getRule, isAvailable, ofRule, registerRule, ruleSupports, unavailable, valueOrNull, weakestStatus } from './provenance'

const INTELLIGENCE_VERSIONS = ['2.7.x']
const START_YEAR = 'the game\'s start year'

export const SECONDS_PER_YEAR = 31536000
// A class's size is stored in size units; one unit is this many tons.
export const TONS_PER_SIZE = 50
// A colony's population is shown above this much intelligence; a sensor's range and resolution above this many points; a ground unit's counters at this many.
export const POPULATION_SIZE_THRESHOLD = 100
export const SENSOR_THRESHOLD = 100
export const GROUND_THRESHOLD = 20

// The rules this module implements, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js).
registerRule({
  id: 'intelligence.standing',
  versions: INTELLIGENCE_VERSIONS,
  verification: 'confirmed',
  structure: ['FCT_AlienRace.DiplomaticPoints'],
  note: 'The bands of a race\'s diplomatic points as the game\'s intelligence reports word them: below -100 at war, below 0 negative, below 200 neutral, below 800 positive, below 4000 friendly, allied above. The band edges are the maintainer\'s reference and are not re-derived from saved data. A missing point total has no standing; a saved 0 is neutral.',
})

registerRule({
  id: 'intelligence.diplomaticPoints',
  versions: INTELLIGENCE_VERSIONS,
  units: 'points',
  verification: 'confirmed',
  structure: ['FCT_AlienRace.DiplomaticPoints'],
  note: 'The race\'s saved diplomatic points with an alien race, as stored (rounded to 0.1 in the recorded history). A missing value is unavailable, never 0; a saved 0 is a real 0.',
})

registerRule({
  id: 'intelligence.rewardAttempts',
  versions: INTELLIGENCE_VERSIONS,
  verification: 'estimated',
  structure: ['recorded history of FCT_AlienRace.AlienRaceIntelligencePoints'],
  note: 'Race intelligence points buy one random discovery each time they pass 100 (the reference\'s reward cost), so a fall between two recorded points marks a discovery. The cost is the reference\'s; that every fall is a discovery is not checked against a save, and a discovery paid for by a rise within the same interval is not seen. Two points are compared only when both are recorded.',
  assumptions: ['every fall of race intelligence between two recorded points is a discovery'],
})

registerRule({
  id: 'intelligence.fleetRebuild',
  versions: INTELLIGENCE_VERSIONS,
  units: 'ships, tons',
  verification: 'estimated',
  structure: ['FCT_AlienShip.FirstDetected, Destroyed, GameTimeDamaged, LastContactTime', 'FCT_AlienClass.TCS'],
  note: 'The tracked fleet over time from the save\'s own timestamps: a ship counts from its first detection and, once destroyed, is lost at its last damage time. The rebuild is not compared with any recorded fleet, and ships the race has not detected are not in it. A ship whose detection time, destroyed flag or loss time is missing is left out and named; the tonnage is a gap while a ship in service has no saved size.',
  assumptions: ['a destroyed ship without a damage time is lost at its last contact', 'only the ships the race has detected are counted'],
})

registerRule({
  id: 'intelligence.shipsTracked',
  versions: INTELLIGENCE_VERSIONS,
  units: 'ships',
  verification: 'confirmed',
  structure: ['FCT_AlienShip.Destroyed'],
  note: 'Counts of the race\'s saved alien ship records: those not flagged destroyed (in service) and those flagged destroyed. A ship whose destroyed flag is not saved is in neither count, so a race with such a ship has no count.',
})

registerRule({
  id: 'intelligence.tonsTracked',
  versions: INTELLIGENCE_VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_AlienClass.TCS', 'FCT_AlienShip.AlienClassID, Destroyed'],
  note: 'The stored size of an observed class times 50 tons, summed over the tracked ships in service. The 50 tons a size unit is the maintainer\'s reference, not a tonnage the save stores. A ship whose class has no saved size leaves the sum unavailable.',
  assumptions: ['one size unit of a class is 50 tons'],
})

registerRule({
  id: 'intelligence.coloniesObserved',
  versions: INTELLIGENCE_VERSIONS,
  units: 'colonies',
  verification: 'confirmed',
  structure: ['FCT_AlienPopulation.MaxIntelligence'],
  note: 'Counts of the race\'s alien colony records, and of those whose peak intelligence is above 100, where the reference says a colony\'s population shows. A colony without a saved peak intelligence cannot be counted either way.',
})

registerRule({
  id: 'intelligence.populationLevel',
  versions: INTELLIGENCE_VERSIONS,
  units: 'levels',
  verification: 'confirmed',
  structure: ['FCT_AlienPopulation.MaxIntelligence, AlienPopulationIntelligencePoints'],
  note: 'The detail of a colony its peak intelligence has unlocked: above 100 points the population and installations, above 200 factories, mines, spaceport and cargo station, above 300 refineries, maintenance, refuelling and ordnance stations, above 500 research, ground training, naval HQ and sector command. The thresholds are the maintainer\'s reference. A colony without a saved peak intelligence has no level, and a figure the colony is unlocked for but whose last value is missing is unavailable.',
})

registerRule({
  id: 'intelligence.gameYear',
  versions: INTELLIGENCE_VERSIONS,
  units: 'years',
  verification: 'confirmed',
  structure: ['FCT_Game.StartYear', 'FCT_Game.GameTime'],
  note: 'The game year of a time in seconds: the game\'s start year plus the seconds over 31,536,000 (365 days). It does not follow leap years, so it places points on a chart and is not a calendar date. Without the start year there is no year.',
})

registerRule({
  id: 'intelligence.contactDate',
  versions: INTELLIGENCE_VERSIONS,
  verification: 'estimated',
  structure: ['FCT_AlienRace.FirstDetected, CommEstablished', 'FCT_AlienShip.LastContactTime', 'FCT_Game.StartYear'],
  note: 'A time in game seconds as a calendar date counted from the game\'s start year; the conversion is not compared with a date the save stores. The last ship contact is the latest contact time over the race\'s tracked ships, and a ship with no saved contact time is not in it. A race with no tracked ship has no last contact, which is an absence; a missing time or start year is unavailable.',
})

registerRule({
  id: 'intelligence.sensorReveal',
  versions: INTELLIGENCE_VERSIONS,
  verification: 'confirmed',
  structure: ['FCT_AlienRaceSensor.IntelligencePoints'],
  note: 'A sensor\'s range and resolution are known once its intelligence points are above 100 (the maintainer\'s reference). A sensor without saved points has no verdict.',
})

registerRule({
  id: 'intelligence.groundReveal',
  versions: INTELLIGENCE_VERSIONS,
  verification: 'confirmed',
  structure: ['FCT_AlienGroundUnitClass.Hits, Penetrated, Destroyed'],
  note: 'Each of a ground unit class\'s three counters reveals what it is about at 20 points (the maintainer\'s reference). A counter without a saved value has no verdict.',
})

registerRule({
  id: 'intelligence.treaties',
  versions: INTELLIGENCE_VERSIONS,
  verification: 'confirmed',
  structure: ['FCT_AlienRace.TradeTreaty, TechTreaty, GeoTreaty, GravTreaty'],
  note: 'Which of the four treaties (trade, technology, geological, gravitational) each side grants, from the four flags of the race\'s own record and of the alien race\'s record of it. A race whose own record of the other is missing, or whose flags are not saved, has no verdict, and is not read as having no treaty.',
})

registerRule({
  id: 'intelligence.translationProgress',
  versions: INTELLIGENCE_VERSIONS,
  verification: 'estimated',
  structure: ['FCT_AlienRace.CommModifier, CommStatus'],
  note: 'The progress of an attempt at communication as the save stores it. How it rises and what completes it is not read from the reference nor checked against saved attempts.',
})

registerRule({
  id: 'intelligence.observed',
  versions: INTELLIGENCE_VERSIONS,
  verification: 'confirmed',
  structure: ['FCT_AlienClass', 'FCT_AlienPopulation', 'FCT_AlienRaceSensor', 'FCT_AlienGroundUnitClass', 'FCT_AlienRace.AlienRaceIntelligencePoints, DamageCausedByAlienRace'],
  note: 'A figure the save stores and the page shows as it is: an observed class\'s speed, armour and shields, a colony\'s signatures and counts, a sensor\'s strength and range, a ground unit\'s counters, race intelligence points and damage received. A missing one is unavailable, never 0.',
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The number, or null when it is not one: a figure the save does not hold is not 0.
const numeric = (value) => (isNumber(value) ? value : null)

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

// A stored figure of `rule` named `name`: available when the save holds it.
const storedResult = (rule, value, name) => (isNumber(value) ? ofRule({ rule, value, inputs: { present: [name] } }) : unavailable({ rule, missing: [name] }))

// A result of `rule` over named numeric inputs ([[value, name], ...]), unavailable when any is missing.
const withInputs = (rule, pairs, compute) => {
  const present = pairs.filter(([value]) => isNumber(value)).map(([, name]) => name)
  const missing = pairs.filter(([value]) => !isNumber(value)).map(([, name]) => name)

  return missing.length ? unavailable({ rule, missing, present }) : ofRule({ rule, value: compute(), inputs: { present } })
}

// A result of a rule that rests on the reference's thresholds: the rule's own verification where it holds for the save's formula version (`loadFormulaVersion`), else an estimate.
const versioned = ({ rule, value, inputs, version }) => {
  const supported = ruleSupports(rule, version) === true

  return envelope({ value, status: supported ? getRule(rule).verification : STATUS.ESTIMATED, rule, inputs, assumptions: supported ? [] : [UNVERIFIED_SAVE] })
}

// A figure of one alien race's record, or of the save, that shows as it is: unavailable (a dash on screen) when missing.
export const diplomaticPoints = (value) => storedResult('intelligence.diplomaticPoints', value, 'the diplomatic points')

export const observed = (value, name) => storedResult('intelligence.observed', value, name)

export const translationProgress = (value) => storedResult('intelligence.translationProgress', value, 'the translation progress')

// The game year of a time in seconds, as a result of 'intelligence.gameYear'.
export const gameYear = (startYear, seconds) => withInputs('intelligence.gameYear', [[startYear, START_YEAR], [seconds, 'the time']], () => startYear + seconds / SECONDS_PER_YEAR)

// A time in seconds as a result of 'intelligence.contactDate' (the value is the seconds; the page formats the date from the start year). `name` is the time's name in the missing list.
export const contactTime = (startYear, seconds, name = 'the contact time') => withInputs('intelligence.contactDate', [[startYear, START_YEAR], [seconds, name]], () => seconds)

// FCT_AlienRace.ContactStatus. `color` is a tone (see `toneColor` in appearance.js).
export const CONTACT_STATUS = {
  0: { label: 'Hostile', color: 'error', icon: 'mdi-sword-cross' },
  1: { label: 'Neutral', color: 'inactive', icon: 'mdi-minus-circle-outline' },
  2: { label: 'Friendly', color: 'success', icon: 'mdi-handshake-outline' },
  3: { label: 'Allied', color: 'primary', icon: 'mdi-shield-star-outline' },
  4: { label: 'Civilian', color: 'inactive', icon: 'mdi-ferry' },
  5: { label: 'None', color: 'inactive', icon: 'mdi-help-circle-outline' },
  6: { label: 'Combat', color: 'error', icon: 'mdi-flash-alert-outline' },
}

export const contactStatus = (code) => CONTACT_STATUS[code] || { label: isNumber(code) ? `Status ${code}` : 'Unknown', color: 'inactive', icon: 'mdi-help-circle-outline' }

// FCT_AlienRace.CommStatus
export const COMM_STATUS = {
  0: 'No communication',
  1: 'Attempting communication',
  2: 'Communication established',
  3: 'Communication impossible',
}

export const communicationLabel = (code) => COMM_STATUS[code] || (isNumber(code) ? `Status ${code}` : 'Unknown')

export const ATTEMPTING_COMMUNICATION = 1

// FCT_KnownSpecies.Status
export const SPECIES_STATUS = { 0: 'Discovered', 1: 'Autopsied', 2: 'Fully known' }

// FCT_AlienClass.EngineType
export const ENGINE_TYPES = { 0: 'Unknown', 1: 'Military', 2: 'Commercial', 3: 'FAC', 4: 'Survey', 5: 'Fighter' }

// FCT_AlienClass.AlienClassRole, labelled by the rule that sets it, since the role names themselves are uncertain: 1 for a launcher of size 4 or more, 2 for a smaller one, 3 for a beam whose power need is more than twice its recharge rate, 4 for any other beam.
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
const standingLabel = (points) => (points < -100 ? 'At war' : points < 0 ? 'Negative' : points < 200 ? 'Neutral' : points < 800 ? 'Positive' : points < 4000 ? 'Friendly' : 'Allied')

// A race's standing from its diplomatic points, as a result of 'intelligence.standing': unavailable without the points, so a missing value is never Neutral. `version`: the formula version of the save (`loadFormulaVersion`).
export const standing = (points, version = null) => (isNumber(points) ? versioned({ rule: 'intelligence.standing', value: standingLabel(points), inputs: { present: ['the diplomatic points'] }, version }) : unavailable({ rule: 'intelligence.standing', missing: ['the diplomatic points'] }))

// Race intelligence points buy one random discovery each time they pass this.
export const REWARD_COST = 100

// What a colony's intelligence points reveal, above (not at) each threshold.
export const POPULATION_LEVELS = [
  { threshold: 100, label: 'Population and installations', fields: ['PopulationAmount', 'Installations'] },
  { threshold: 200, label: 'Factories, mines, spaceport and cargo station', fields: ['Factories', 'Mines', 'Spaceport', 'CargoStation'] },
  { threshold: 300, label: 'Refineries, maintenance, refuelling and ordnance stations', fields: ['Refineries', 'MaintenanceFacilities', 'RefuellingStation', 'OrdnanceTransfer'] },
  { threshold: 500, label: 'Research, ground training, naval HQ and sector command', fields: ['ResearchFacilities', 'GFTF', 'NavalHeadquarters', 'SectorCommand'] },
]

// The highest level a colony's intelligence has unlocked (0 when none), as a result of 'intelligence.populationLevel': unavailable without the colony's peak intelligence.
export const populationLevel = (population, version = null) => (isNumber(population.MaxIntelligence) ? versioned({ rule: 'intelligence.populationLevel', value: POPULATION_LEVELS.filter((level) => population.MaxIntelligence > level.threshold).length, inputs: { present: ['the peak intelligence of the colony'] }, version }) : unavailable({ rule: 'intelligence.populationLevel', missing: ['the peak intelligence of the colony'] }))

// One field of a known colony: `known` once intelligence has ever been above its threshold (the value is then the last one seen), `current` while it still is (the game shows it green, else red). `known` and `current` are null when the intelligence they rest on is not saved, and `result` (of 'intelligence.populationLevel', its value `known`) is unavailable when `known` cannot be told or a known field's last value is not saved.
export const populationField = (population, field, version = null) => {
  const rule = 'intelligence.populationLevel'
  const level = POPULATION_LEVELS.find((entry) => entry.fields.includes(field))
  const peak = population.MaxIntelligence
  const points = population.AlienPopulationIntelligencePoints

  if (!isNumber(peak)) {
    return { value: null, known: null, current: null, result: unavailable({ rule, missing: ['the peak intelligence of the colony'] }) }
  }

  const known = peak > level.threshold
  const current = isNumber(points) ? points > level.threshold : null

  if (known && !isNumber(population[field])) {
    return { value: null, known, current, result: unavailable({ rule, missing: ['the last seen value of the field'], present: ['the peak intelligence of the colony'] }) }
  }

  return { value: known ? population[field] : null, known, current, result: versioned({ rule, value: known, inputs: { present: ['the peak intelligence of the colony'] }, version }) }
}

// The colonies counted, and those whose peak intelligence is above the population threshold, as results of 'intelligence.coloniesObserved'; the second is unavailable while a colony's peak intelligence is not saved.
export const coloniesObserved = (populations) => ofRule({ rule: 'intelligence.coloniesObserved', value: populations.length, inputs: { present: ['the colony records'] } })

export const sizedColonies = (populations, version = null) => {
  const rule = 'intelligence.coloniesObserved'
  const unknown = populations.filter((population) => !isNumber(population.MaxIntelligence)).length

  if (unknown) {
    return unavailable({ rule, missing: [`the peak intelligence of ${plural(unknown, 'colony', 'colonies')}`], present: ['the colony records'] })
  }

  return versioned({ rule, value: populations.filter((population) => population.MaxIntelligence > POPULATION_SIZE_THRESHOLD).length, inputs: { present: ['the peak intelligence of the colonies'] }, version })
}

// Whether a sensor's range and resolution are known (above the threshold), and whether a ground unit counter has revealed what it is about (at the threshold), as results of 'intelligence.sensorReveal' and 'intelligence.groundReveal' whose value is true or false; unavailable without the points.
export const sensorReveal = (points, version = null) => (isNumber(points) ? versioned({ rule: 'intelligence.sensorReveal', value: points > SENSOR_THRESHOLD, inputs: { present: ['the sensor\'s intelligence points'] }, version }) : unavailable({ rule: 'intelligence.sensorReveal', missing: ['the sensor\'s intelligence points'] }))

export const groundReveal = (points, version = null) => (isNumber(points) ? versioned({ rule: 'intelligence.groundReveal', value: points >= GROUND_THRESHOLD, inputs: { present: ['the counter'] }, version }) : unavailable({ rule: 'intelligence.groundReveal', missing: ['the counter'] }))

const isUndecided = (ship) => ship.Destroyed === null || ship.Destroyed === undefined

// The time a destroyed ship was lost: its last damage time, else its last contact, else null. A time of 0 is the save's blank.
const lossTime = (ship) => [ship.GameTimeDamaged, ship.LastContactTime].find((time) => isNumber(time) && time > 0) ?? null

// Ships, tonnage and losses known over time, rebuilt from the save's own timestamps: a ship counts from its first detection, and a destroyed one is lost at its last damage time (or, without one, its last contact). `ships`: [{ FirstDetected, Destroyed, GameTimeDamaged, LastContactTime, Tons }], `Tons` null when the class has no saved size. A result of 'intelligence.fleetRebuild' whose value is [{ t, alive, tons, lost }], one point per change, ending at `now`, with `tons` null while a ship in service has no size. A ship without its destroyed flag, its first detection or (when destroyed) a loss time is left out and named; unavailable when that leaves no ship.
const fleetEvents = (ships, now) => {
  const rule = 'intelligence.fleetRebuild'
  const events = []
  const counts = { undecided: 0, unplaced: 0, unsized: 0 }

  ships.forEach((ship) => {
    if (isUndecided(ship)) {
      counts.undecided += 1

      return
    }

    const lostAt = ship.Destroyed ? lossTime(ship) : null

    if (!isNumber(ship.FirstDetected) || (ship.Destroyed && lostAt === null)) {
      counts.unplaced += 1

      return
    }

    const sized = isNumber(ship.Tons)

    counts.unsized += sized ? 0 : 1
    events.push({ t: ship.FirstDetected, alive: 1, tons: sized ? ship.Tons : 0, unsized: sized ? 0 : 1, lost: 0 })

    if (lostAt !== null) {
      events.push({ t: lostAt, alive: -1, tons: sized ? -ship.Tons : 0, unsized: sized ? 0 : -1, lost: 1 })
    }
  })

  const missing = [
    counts.undecided ? `whether ${plural(counts.undecided, 'tracked ship is', 'tracked ships are')} destroyed` : null,
    counts.unplaced ? `the detection or loss time of ${plural(counts.unplaced, 'tracked ship', 'tracked ships')}` : null,
    counts.unsized ? `the size of ${plural(counts.unsized, 'tracked ship', 'tracked ships')}` : null,
  ].filter(Boolean)

  if (!events.length && ships.length) {
    return unavailable({ rule, missing })
  }

  events.sort((a, b) => a.t - b.t)

  const series = []
  let state = { alive: 0, tons: 0, lost: 0, unsized: 0 }

  events.forEach((event) => {
    state = { alive: state.alive + event.alive, tons: state.tons + event.tons, lost: state.lost + event.lost, unsized: state.unsized + event.unsized }

    const point = { t: event.t, alive: state.alive, tons: state.unsized > 0 ? null : state.tons, lost: state.lost }

    if (series.length && series[series.length - 1].t === event.t) {
      series[series.length - 1] = point
    } else {
      series.push(point)
    }
  })

  if (series.length && isNumber(now) && now > series[series.length - 1].t) {
    series.push({ ...series[series.length - 1], t: now })
  }

  return ofRule({ rule, value: series, inputs: { present: ['the tracked ships'], missing } })
}

// The fleet over time as it is drawn against the game year: `fleetEvents`, and unavailable (naming the start year with whatever else is missing) while the game's start year is not saved, since no point can be placed on the year axis then.
export const rebuildFleet = (ships, now, startYear) => {
  const fleet = fleetEvents(ships, now)

  if (isNumber(startYear)) {
    return fleet
  }

  return unavailable({ rule: 'intelligence.fleetRebuild', missing: [...fleet.inputs.missing, START_YEAR], present: fleet.inputs.present, assumptions: fleet.assumptions })
}

// Times where race intelligence fell between two recorded points, each one a discovery the points were spent on, as a result of 'intelligence.rewardAttempts' whose value is the times. Two points are compared only when both are recorded; unavailable when none is, and without the game's start year, which places the marks on the year axis.
export const rewardAttempts = (snapshots, version, startYear) => {
  const rule = 'intelligence.rewardAttempts'
  const unknown = snapshots.filter((snapshot) => !isNumber(snapshot.intel)).length
  const missing = [...(snapshots.length && unknown === snapshots.length ? ['the recorded race intelligence'] : []), ...(isNumber(startYear) ? [] : [START_YEAR])]

  if (missing.length) {
    return unavailable({ rule, missing })
  }

  const times = snapshots.filter((snapshot, index) => index > 0 && isNumber(snapshot.intel) && isNumber(snapshots[index - 1].intel) && snapshot.intel < snapshots[index - 1].intel).map((snapshot) => snapshot.t)

  return versioned({ rule, value: times, inputs: { present: ['the recorded race intelligence'], missing: unknown ? [`${plural(unknown, 'recorded point', 'recorded points')} without race intelligence`] : [] }, version })
}

// A recorded figure over time as a result of `rule` (named `name` in the missing list): the value is [{ x: game year, y }] with `y` null where a point has none, which a chart draws as a gap, never 0. A point without a time is left out; unavailable without the start year or when no point has the figure.
export const snapshotSeries = (snapshots, key, startYear, rule, name) => {
  if (!isNumber(startYear)) {
    return unavailable({ rule, missing: [START_YEAR] })
  }

  const points = snapshots.map((snapshot) => ({ x: valueOrNull(gameYear(startYear, snapshot.t)), y: numeric(snapshot[key]) })).filter((point) => point.x !== null)
  const gaps = points.filter((point) => point.y === null).length

  if (gaps === points.length) {
    return unavailable({ rule, missing: [name] })
  }

  const verification = getRule(rule).verification

  return envelope({ value: points, status: gaps ? weakestStatus([verification, STATUS.ESTIMATED]) : verification, rule, inputs: { present: [name], missing: gaps ? [`${plural(gaps, 'recorded point', 'recorded points')} without ${name}`] : [] } })
}

const countShips = (row, key, name) => {
  const rule = 'intelligence.shipsTracked'

  if (![row.KnownShips, row.DestroyedShips, row.TrackedShips].every(isNumber)) {
    return unavailable({ rule, missing: [name] })
  }

  const undecided = row.TrackedShips - row.KnownShips - row.DestroyedShips

  if (undecided > 0) {
    return unavailable({ rule, missing: [`whether ${plural(undecided, 'tracked ship is', 'tracked ships are')} destroyed`], present: [name] })
  }

  return ofRule({ rule, value: row[key], inputs: { present: [name] } })
}

// The tracked ships of one alien race row from `alienRacesSql` that are in service, and that are destroyed, as results of 'intelligence.shipsTracked': unavailable while a ship's destroyed flag is not saved.
export const aliveShips = (row) => countShips(row, 'KnownShips', 'the ships in service')

export const lostShips = (row) => countShips(row, 'DestroyedShips', 'the ships destroyed')

// The ships of each class in service, from the tracked ships ({ AlienClassID, Destroyed }), as results of 'intelligence.shipsTracked' by class ID: a class with no ship has a real 0, and one with a ship whose destroyed flag is not saved has no count.
export const aliveByClass = (ships, classes) => Object.fromEntries(classes.map((shipClass) => {
  const rule = 'intelligence.shipsTracked'
  const own = ships.filter((ship) => ship.AlienClassID === shipClass.AlienClassID)
  const undecided = own.filter(isUndecided).length

  return [shipClass.AlienClassID, undecided ? unavailable({ rule, missing: [`whether ${plural(undecided, 'ship is', 'ships are')} destroyed`] }) : ofRule({ rule, value: own.filter((ship) => !ship.Destroyed).length, inputs: { present: ['the ships of the class'] } })]
}))

// The tons of the tracked ships in service of one alien race row from `alienRacesSql`, as a result of 'intelligence.tonsTracked': unavailable while a ship's destroyed flag or its class's size is not saved. No ship in service is a real 0.
export const trackedTons = (row) => {
  const rule = 'intelligence.tonsTracked'
  const alive = aliveShips(row)

  if (!isAvailable(alive)) {
    return unavailable({ rule, missing: alive.inputs.missing })
  } else if (alive.value === 0) {
    return ofRule({ rule, value: 0, inputs: { present: ['the ships in service'] } })
  } else if (!isNumber(row.SizedShips) || !isNumber(row.KnownTons)) {
    return unavailable({ rule, missing: ['the sizes of the observed classes'], present: ['the ships in service'] })
  }

  const unsized = alive.value - row.SizedShips

  if (unsized > 0) {
    return unavailable({ rule, missing: [`the size of ${plural(unsized, 'tracked ship', 'tracked ships')}`], present: ['the ships in service'] })
  }

  return ofRule({ rule, value: row.KnownTons, inputs: { present: ['the ships in service', 'the class sizes'] } })
}

// The tons of an observed class from its size, as a result of 'intelligence.tonsTracked'.
export const classTons = (size) => withInputs('intelligence.tonsTracked', [[size, 'the class size']], () => size * TONS_PER_SIZE)

// The time of an alien race's last ship contact (the latest contact time over its tracked ships), as a result of 'intelligence.contactDate' whose value is the seconds; null when the race has no tracked ship, which is an absence and not an unknown. A ship with no saved contact time is named as missing.
export const lastShipContact = (row, startYear) => {
  const rule = 'intelligence.contactDate'

  if (row.TrackedShips === 0) {
    return null
  } else if (!isNumber(row.TrackedShips) || !isNumber(row.ContactTimes)) {
    return unavailable({ rule, missing: ['the contact times of the tracked ships'] })
  }

  const time = contactTime(startYear, row.LastContact, 'the contact times of the tracked ships')
  const untimed = row.TrackedShips - row.ContactTimes

  return !isAvailable(time) || untimed === 0 ? time : ofRule({ rule, value: time.value, inputs: { present: time.inputs.present, missing: [`the contact time of ${plural(untimed, 'tracked ship', 'tracked ships')}`] } })
}

// What the viewing race knows about every alien race it has met (one row each), with the game time. Also the treaties each side grants: the alien's grants sit on its own record, which the game's Intelligence window reads too; nothing else of that record is used. A treaty flag, a size or a time the save does not hold stays null, and `TrackedShips`, `SizedShips` and `ContactTimes` count the ships whose record is complete, so the helpers above can tell a partial figure from a whole one.
const SHIPS_OF_RACE = 'FCT_AlienShip.GameID = FCT_AlienRace.GameID and FCT_AlienShip.ViewRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienShip.AlienRaceID = FCT_AlienRace.AlienRaceID'

export const alienRacesSql = (GameID, RaceID) => `select FCT_AlienRace.AlienRaceID, FCT_AlienRace.AlienRaceName, FCT_AlienRace.Abbrev, FCT_AlienRace.ContactStatus, FCT_AlienRace.CommStatus, FCT_AlienRace.CommModifier, FCT_AlienRace.CommEstablished, FCT_AlienRace.DiplomaticPoints, FCT_AlienRace.AlienRaceIntelligencePoints, FCT_AlienRace.DamageCausedByAlienRace, FCT_AlienRace.FirstDetected, FCT_AlienRace.FixedRelationship, FCT_AlienRace.TradeTreaty, FCT_AlienRace.TechTreaty, FCT_AlienRace.GeoTreaty, FCT_AlienRace.GravTreaty, VIR_Theirs.AlienRaceID as TheirRecordID, VIR_Theirs.TradeTreaty as TheirTradeTreaty, VIR_Theirs.TechTreaty as TheirTechTreaty, VIR_Theirs.GeoTreaty as TheirGeoTreaty, VIR_Theirs.GravTreaty as TheirGravTreaty, FCT_Game.GameTime as Now, (select count(*) from FCT_AlienClass where FCT_AlienClass.GameID = FCT_AlienRace.GameID and FCT_AlienClass.ViewRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienClass.AlienRaceID = FCT_AlienRace.AlienRaceID) as KnownClasses, (select count(*) from FCT_AlienShip where ${SHIPS_OF_RACE}) as TrackedShips, (select count(*) from FCT_AlienShip where ${SHIPS_OF_RACE} and FCT_AlienShip.Destroyed = 0) as KnownShips, (select sum(FCT_AlienClass.TCS) * ${TONS_PER_SIZE} from FCT_AlienShip left join FCT_AlienClass on FCT_AlienClass.AlienClassID = FCT_AlienShip.AlienClassID where ${SHIPS_OF_RACE} and FCT_AlienShip.Destroyed = 0) as KnownTons, (select count(FCT_AlienClass.TCS) from FCT_AlienShip left join FCT_AlienClass on FCT_AlienClass.AlienClassID = FCT_AlienShip.AlienClassID where ${SHIPS_OF_RACE} and FCT_AlienShip.Destroyed = 0) as SizedShips, (select count(*) from FCT_AlienShip where ${SHIPS_OF_RACE} and FCT_AlienShip.Destroyed = 1) as DestroyedShips, (select max(FCT_AlienShip.LastContactTime) from FCT_AlienShip where ${SHIPS_OF_RACE}) as LastContact, (select count(FCT_AlienShip.LastContactTime) from FCT_AlienShip where ${SHIPS_OF_RACE}) as ContactTimes, (select count(*) from FCT_AlienPopulation where FCT_AlienPopulation.GameID = FCT_AlienRace.GameID and FCT_AlienPopulation.ViewingRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienPopulation.AlienRaceID = FCT_AlienRace.AlienRaceID) as KnownPopulations, (select sum(FCT_AlienPopulation.PopulationAmount) from FCT_AlienPopulation where FCT_AlienPopulation.GameID = FCT_AlienRace.GameID and FCT_AlienPopulation.ViewingRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienPopulation.AlienRaceID = FCT_AlienRace.AlienRaceID and FCT_AlienPopulation.MaxIntelligence > ${POPULATION_SIZE_THRESHOLD}) as KnownPopulation, (select count(*) from FCT_AlienSystem where FCT_AlienSystem.GameID = FCT_AlienRace.GameID and FCT_AlienSystem.DetectRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienSystem.AlienRaceID = FCT_AlienRace.AlienRaceID) as KnownSystems, (select count(*) from FCT_AlienGroundUnitClass where FCT_AlienGroundUnitClass.GameID = FCT_AlienRace.GameID and FCT_AlienGroundUnitClass.ViewRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienGroundUnitClass.AlienRaceID = FCT_AlienRace.AlienRaceID) as GroundClasses, (select count(*) from FCT_AlienRaceSensor where FCT_AlienRaceSensor.GameID = FCT_AlienRace.GameID and FCT_AlienRaceSensor.ViewingRaceID = FCT_AlienRace.ViewRaceID and FCT_AlienRaceSensor.AlienRaceID = FCT_AlienRace.AlienRaceID) as KnownSensors from FCT_AlienRace inner join FCT_Game on FCT_Game.GameID = FCT_AlienRace.GameID left join FCT_AlienRace as VIR_Theirs on VIR_Theirs.GameID = FCT_AlienRace.GameID and VIR_Theirs.ViewRaceID = FCT_AlienRace.AlienRaceID and VIR_Theirs.AlienRaceID = FCT_AlienRace.ViewRaceID where FCT_AlienRace.GameID = ${GameID} and FCT_AlienRace.ViewRaceID = ${RaceID} order by FCT_AlienRace.FirstDetected`

const TREATY_FLAGS = ['TradeTreaty', 'TechTreaty', 'GeoTreaty', 'GravTreaty']

// The treaties one side grants, as a result of 'intelligence.treaties' whose value is a bitmask (trade 1, technology 2, geological 4, gravitational 8), for compact snapshots. Unavailable when a flag is not saved, and for the alien race's side when it has no record of the race.
const treatyMask = (row, prefix, name) => {
  const rule = 'intelligence.treaties'
  const flags = TREATY_FLAGS.map((flag) => row[`${prefix}${flag}`])

  if (prefix && !isNumber(row.TheirRecordID)) {
    return unavailable({ rule, missing: ['the alien race\'s own record of the race'] })
  } else if (flags.some((flag) => flag === null || flag === undefined)) {
    return unavailable({ rule, missing: [name] })
  }

  return ofRule({ rule, value: flags.reduce((mask, flag, index) => mask + (flag ? 2 ** index : 0), 0), inputs: { present: [name] } })
}

export const treatiesGranted = (row) => treatyMask(row, '', 'the treaties the race grants')

export const treatiesReceived = (row) => treatyMask(row, 'Their', 'the treaties the alien race grants')

const round = (value, decimals = 0) => (isNumber(value) ? Math.round(value * 10 ** decimals) / 10 ** decimals : null)

// The recorded part of one alien race row: what changes over time. A figure the save does not hold is null, never 0.
export const intelSnapshot = (row) => ({
  t: row.Now,
  contact: numeric(row.ContactStatus),
  comm: numeric(row.CommStatus),
  translation: round(row.CommModifier, 1),
  points: round(row.DiplomaticPoints, 1),
  intel: round(row.AlienRaceIntelligencePoints, 1),
  granted: valueOrNull(treatiesGranted(row)),
  received: valueOrNull(treatiesReceived(row)),
  ships: valueOrNull(aliveShips(row)),
  tons: round(valueOrNull(trackedTons(row))),
  lost: valueOrNull(lostShips(row)),
  classes: numeric(row.KnownClasses),
  populations: numeric(row.KnownPopulations),
  population: round(row.KnownPopulation, 2),
  systems: numeric(row.KnownSystems),
  ground: numeric(row.GroundClasses),
  sensors: numeric(row.KnownSensors),
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
