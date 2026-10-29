// The figures the Galaxy Map works out from what the save stores, each with a registered rule (utilities/provenance.js). A figure whose input is missing is unavailable and says which input: the map draws it as unknown, never as zero, as the game's start, as a full score or as a neutral default. A real zero stays 0. Helpers that run for every marker give plain numbers (null when unknown) and the ones that feed a panel give results.

import { gameTime } from './aurora'
import { buildDistanceMap } from './jump-graph'
import { scaleValue } from './math'
import { UNVERIFIED_SAVE, isAvailable, ofRule, registerRule, ruleSupports, unavailable, weakestStatus } from './provenance'

const MAP_VERSIONS = ['2.7.x']

// The assumptions a rule that depends on the game version makes when the save's version is not known (`loadFormulaVersion`).
export const versionAssumptions = (rule, version) => (ruleSupports(rule, version) === true ? [] : [UNVERIFIED_SAVE])

const finite = (value) => Number.isFinite(value)

registerRule({
  id: 'map.linkDistance',
  versions: MAP_VERSIONS,
  units: 'km',
  verification: 'confirmed',
  structure: ['FCT_JumpPoint.Xcor, Ycor'],
  note: 'The length of a jump link from star to star through its jump points: each end\'s distance from its star (the hypotenuse of the stored position) added together. Arithmetic on stored values. A jump point with no stored position makes the link\'s length unknown.',
})

registerRule({
  id: 'map.galacticDistance',
  versions: MAP_VERSIONS,
  units: 'map units',
  verification: 'estimated',
  structure: ['DIM_KnownSystems.X, Y, Z'],
  note: 'The distance between two stars in the galaxy, from their stored galactic positions, scaled by a fixed factor to fit the map. The arithmetic is exact; the scale is a layout choice and not compared with the game.',
})

registerRule({
  id: 'map.jumpsFromOrigin',
  versions: MAP_VERSIONS,
  units: 'jumps',
  verification: 'confirmed',
  structure: ['FCT_JumpPoint.WPLink', 'FCT_RaceJumpPointSurvey.Explored'],
  note: 'The fewest jumps from the origin system over the links the race has explored from either side, by breadth-first search. A system no explored route reaches has no figure.',
})

registerRule({
  id: 'map.kmFromOrigin',
  versions: MAP_VERSIONS,
  units: 'km',
  verification: 'estimated',
  structure: ['FCT_JumpPoint.Xcor, Ycor, WPLink', 'FCT_RaceJumpPointSurvey.Explored, IgnoreForDistance'],
  note: 'The shortest distance in kilometres from the origin star to each system over the explored links, jump points the race marked to ignore for distance left out. Not compared with a distance the game stores.',
})

registerRule({
  id: 'map.discoveryAsOf',
  versions: MAP_VERSIONS,
  units: 'systems',
  verification: 'estimated',
  structure: ['FCT_RaceSysSurvey.DiscoveredTime', 'FCT_Game.StartYear'],
  note: 'The systems the race had found by the end of a year: the game time of each find against the end of that year counted from the game\'s start year. Systems with no stored discovery time are counted apart, not at the start.',
})

registerRule({
  id: 'map.discoveredDate',
  versions: MAP_VERSIONS,
  units: 'date',
  verification: 'estimated',
  structure: ['FCT_RaceSysSurvey.DiscoveredTime', 'FCT_Game.StartYear'],
  note: 'The calendar date the race found a system: the game start year plus the stored discovery time in seconds. A system with no stored time, or a save with no start year, has no date.',
})

registerRule({
  id: 'map.discoveryShade',
  versions: MAP_VERSIONS,
  units: 'shade',
  verification: 'assumed',
  structure: ['FCT_RaceSysSurvey.DiscoveredTime'],
  note: 'A visual scale: systems known from the start take a pale shade, and the rest a stronger one the later they were found, from the first find to the last. A single find time takes the strongest.',
})

registerRule({
  id: 'map.colonyFill',
  versions: MAP_VERSIONS,
  units: '% of 10 M people',
  verification: 'assumed',
  structure: ['FCT_Population.Population'],
  note: 'How far a system\'s colonies fill the pie in the Colonies colouring: their people against a display threshold, not a game limit. A colony with no stored population has no figure.',
  assumptions: ['10 million people fill the pie'],
})

registerRule({
  id: 'map.surveyShare',
  versions: MAP_VERSIONS,
  units: '%',
  verification: 'confirmed',
  structure: ['FCT_SystemBody', 'FCT_SystemBodySurveys', 'FCT_SurveyLocation', 'FCT_RaceSurveyLocation'],
  note: 'The share of a system\'s bodies or survey locations the race has surveyed: the surveyed count over the count of them, rounded. A system with none to survey has no share, which is not the same as none surveyed.',
})

registerRule({
  id: 'map.linkStraightShare',
  versions: MAP_VERSIONS,
  units: '%',
  verification: 'confirmed',
  note: 'The share of the map\'s links that run straight or at 45 degrees on its current layout, rounded. With no links there is nothing to measure.',
})

registerRule({
  id: 'map.markerSize',
  versions: MAP_VERSIONS,
  units: 'map units',
  verification: 'assumed',
  structure: ['FCT_Population.Population'],
  note: 'A visual scale: a marker grows with the number of colonies and the people in a system, from 44 map units to 104. It carries no game value.',
  assumptions: ['a system whose colonies have no stored population is sized by their number alone'],
})

registerRule({
  id: 'map.populationText',
  versions: MAP_VERSIONS,
  units: 'M people',
  verification: 'confirmed',
  structure: ['FCT_Population.Population'],
  note: 'The people in a system\'s colonies as stored, in millions, shown with two decimals under 10 million and none above. A colony with no stored population leaves the total unknown.',
})

registerRule({
  id: 'map.legendCount',
  versions: MAP_VERSIONS,
  units: 'systems',
  verification: 'confirmed',
  note: 'The number of systems with each colour, glyph or mark in the legend, counted from what the map shows. A system whose state is unknown is counted apart, in none of the others.',
})

const COORDINATES = 'the jump point\'s position'
const FIRST_FIND_SHADE = 0.35
const START_SHADE = 0.15

// A link's length from its jump points ([{ Xcor, Ycor }]), a result of 'map.linkDistance'.
export const linkDistance = (points) => (!points.length || points.some((point) => !finite(point.Xcor) || !finite(point.Ycor)) ? unavailable({ rule: 'map.linkDistance', missing: [COORDINATES] }) : ofRule({ rule: 'map.linkDistance', value: points.reduce((total, point) => total + Math.hypot(point.Xcor, point.Ycor), 0), inputs: { present: [COORDINATES] } }))

// The galaxy scale the map draws links by, light years times this, as the old map did, so a free layout's links stay on screen.
const GALACTIC_SCALE = 18

// A star's place in the galaxy for the free layouts, null when any of its three coordinates is missing.
export const galacticPosition = (system) => (finite(system.X) && finite(system.Y) && finite(system.Z) ? { x: system.X * GALACTIC_SCALE, y: system.Y * GALACTIC_SCALE, z: system.Z * GALACTIC_SCALE } : null)

// The distance between two stars' galactic positions (`galacticPosition`), a result of 'map.galacticDistance'.
export const galacticDistance = (a, b) => (a && b ? ofRule({ rule: 'map.galacticDistance', value: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), inputs: { present: ['both stars\' galactic positions'] } }) : unavailable({ rule: 'map.galacticDistance', missing: ['the stars\' galactic positions'] }))

// A link's length for the travel-distance layout, in the scale the layouts want, from `linkDistance`'s result, or null when it is unknown.
export const travelLength = (distance) => (isAvailable(distance) ? scaleValue(distance.value / 1e9) : null)

// Jumps from `origin` to every system an explored route reaches, over `neighbours` ({ [id]: [id] }), as { [id]: jumps }.
export const jumpsFromOrigin = (origin, neighbours) => {
  const hops = { [origin]: 0 }
  const queue = [origin]

  for (let i = 0; i < queue.length; i += 1) {
    (neighbours[queue[i]] || []).forEach((other) => {
      if (hops[other] === undefined) {
        hops[other] = hops[queue[i]] + 1
        queue.push(other)
      }
    })
  }

  return hops
}

// The farthest distance in `distances` ({ [id]: number }), or null when no system lies beyond the origin: there is then no far end to scale against, which is not a far end of 1.
export const farthestOf = (distances) => {
  const farthest = Object.values(distances).reduce((most, value) => Math.max(most, value), 0)

  return farthest > 0 ? farthest : null
}

// A system's jumps from the origin as a result of 'map.jumpsFromOrigin'; unavailable where no explored route reaches it.
export const jumpsTo = (hops, id) => (hops[id] === undefined ? unavailable({ rule: 'map.jumpsFromOrigin', missing: ['an explored route from the origin'] }) : ofRule({ rule: 'map.jumpsFromOrigin', value: hops[id], inputs: { present: ['the explored links'] } }))

// Kilometres from the origin's star to each system's on the shortest explored route: { km: { [SystemID as a string]: km }, left } with `left` the number of charted jump points with no stored position, which no route uses.
export const kmFromOrigin = (jumpPoints, rows, originId) => {
  const km = {}

  if (!originId) {
    return { km, left: 0 }
  }

  const positioned = jumpPoints.filter((jumpPoint) => finite(jumpPoint.Xcor) && finite(jumpPoint.Ycor))
  const distanceTo = buildDistanceMap(positioned, [{ SystemID: Number(originId), Xcor: 0, Ycor: 0 }])

  rows.forEach((row) => {
    const found = distanceTo({ SystemID: row.SystemID, Xcor: 0, Ycor: 0 })

    if (found) {
      km[row.id] = found.km
    }
  })

  return { km, left: jumpPoints.length - positioned.length }
}

// A discovery time is the game time in seconds the race found the system; 0 is a system known from the start, and no stored time is unknown.
export const discoveredAtStart = (time) => finite(time) && time <= 0

export const discoveryUnknown = (time) => !finite(time)

// The first and last game time the race found a system after the game began: { first, last }, or null when it found none.
export const discoveryRange = (rows) => {
  let first = null
  let last = null

  rows.forEach(({ DiscoveredTime: time }) => {
    if (finite(time) && time > 0) {
      first = first === null || time < first ? time : first
      last = last === null || time > last ? time : last
    }
  })

  return first === null ? null : { first, last }
}

// A game start year is known when it is a positive year; the store holds 0 until the game's clock is read.
const startKnown = (startYear) => finite(startYear) && startYear > 0

// The calendar year of `year` in the game's calendar, as the date shows it (four digits).
export const discoveryYearText = (startYear, year) => gameTime(startYear, 0).set('year', year).format('YYYY')

// The date a system was found as a result of 'map.discoveredDate' (value 'YYYY-MM-DD'): unavailable without a stored time or a start year. A time of 0 is the game's start date, a real answer for a system known from the start.
export const discoveredDate = (startYear, time) => {
  const missing = [discoveryUnknown(time) && 'the time the system was found', !startKnown(startYear) && 'the game\'s start year'].filter(Boolean)

  return missing.length ? unavailable({ rule: 'map.discoveredDate', missing }) : ofRule({ rule: 'map.discoveredDate', value: gameTime(startYear, time).format('YYYY-MM-DD'), inputs: { present: ['the time the system was found', 'the game\'s start year'] } })
}

// The Discovery era's As of, a result of 'map.discoveryAsOf', or null when the race found no system after the game began (`range`, from `discoveryRange`). `chosen` is the year picked or null for the last. The value is { min, max, year, cutoff, known, dated, undated }: the years the slider spans, the year shown, the game time its end comes at (null at the last year), the systems found by then, the systems with a stored time and those without one, which are in neither of the others.
export const discoveryAsOf = (rows, range, startYear, chosen) => {
  if (!range) {
    return null
  }

  if (!startKnown(startYear)) {
    return unavailable({ rule: 'map.discoveryAsOf', missing: ['the game\'s start year'] })
  }

  const start = gameTime(startYear, 0)
  const min = start.year()
  const max = gameTime(startYear, range.last).year()
  const year = chosen === null ? max : Math.min(max, Math.max(min, chosen))
  const cutoff = year < max ? start.set('year', year + 1).diff(start, 'second') : null
  const dated = rows.filter((row) => finite(row.DiscoveredTime))
  const known = cutoff === null ? dated.length : dated.filter((row) => row.DiscoveredTime < cutoff).length

  return ofRule({ rule: 'map.discoveryAsOf', value: { min, max, year, cutoff, known, dated: dated.length, undated: rows.length - dated.length }, inputs: { present: ['the time each system was found', 'the game\'s start year'] } })
}

// How strong a system's Discovery shade is, from 0.15 for a system known from the start to 1 for the last one found, or null when its time is not stored. `range` is `discoveryRange`'s answer.
export const discoveryShade = (time, range) => {
  if (discoveryUnknown(time)) {
    return null
  }

  if (time <= 0 || !range) {
    return START_SHADE
  }

  const share = range.last > range.first ? (time - range.first) / (range.last - range.first) : 1

  return FIRST_FIND_SHADE + (1 - FIRST_FIND_SHADE) * share
}

// A system's people in millions as the colonies store them, or null when it has colonies and any lacks a stored population. `system` is the systems read: { Colonies, Population, PopulationReported }, the last the number of colonies with a stored population. A system with no colonies has 0 people.
export const colonyPopulation = (system) => {
  if (!system.Colonies) {
    return 0
  }

  return system.PopulationReported === system.Colonies && finite(system.Population) ? system.Population : null
}

// The people of a system's colonies shown as text, a result of 'map.populationText'; `format(value, decimals)` formats a number.
export const populationText = (population, format) => (finite(population) ? ofRule({ rule: 'map.populationText', value: `${format(population, population < 10 ? 2 : 0)} m people`, inputs: { present: ['the colonies\' population'] } }) : unavailable({ rule: 'map.populationText', missing: ['the colonies\' population'] }))

// The people, in millions, that fill a colony's pie.
export const COLONY_FULL_MILLIONS = 10

// How full the pie of a system with `colonies` colonies and `population` million people is, in percent, or null when the population is unknown. A system with no colonies has no pie to fill, 0.
export const colonyFillPercent = (colonies, population) => {
  if (!colonies) {
    return 0
  }

  return finite(population) ? Math.min(100, (100 * Math.max(0, population)) / COLONY_FULL_MILLIONS) : null
}

// The share of `total` bodies or survey locations surveyed, in percent, or null when there are none to survey or the counts are missing: not the same as none surveyed.
export const surveyPercent = (done, total) => (finite(done) && finite(total) && total > 0 ? Math.round((100 * done) / total) : null)

export const surveyShare = (done, total) => {
  const share = surveyPercent(done, total)

  if (share !== null) {
    return ofRule({ rule: 'map.surveyShare', value: share, inputs: { present: ['the surveyed count', 'the count to survey'] } })
  }

  return unavailable({ rule: 'map.surveyShare', missing: [finite(total) && total === 0 ? 'bodies or survey locations to survey' : 'the count of bodies or survey locations'] })
}

// The share of the layout's links that run straight or at 45 degrees, a result of 'map.linkStraightShare'. `quality` is the layout's { links, straight, diagonal }; with no links it is unavailable, not a full score.
export const straightShare = (quality) => (quality && quality.links > 0 ? ofRule({ rule: 'map.linkStraightShare', value: Math.round((100 * (quality.straight + quality.diagonal)) / quality.links), inputs: { present: ['the layout\'s links'] } }) : unavailable({ rule: 'map.linkStraightShare', missing: ['a link in the layout'] }))

const MARKER_BASE_SIZE = 44

// 44 units across for a system with nobody in it, growing towards 104 with colonies and people. A system whose colonies have no stored population (null) is sized by their number alone.
export const markerSize = (colonies, population) => {
  if (!colonies) {
    return MARKER_BASE_SIZE
  }

  const count = Math.log1p(colonies) / Math.log1p(100)
  const people = finite(population) ? Math.log1p(Math.max(0, population)) / Math.log1p(10000) : null
  const blended = people === null ? count : Math.exp(0.3 * Math.log(Math.max(1e-9, count)) + 0.7 * Math.log(Math.max(1e-9, people)))

  return Math.round(MARKER_BASE_SIZE + 60 * (blended / (1 + blended)))
}

// The result that stands for several: the first unavailable one, else the weakest, or null for none.
export const weakestResult = (results) => {
  const missing = results.find((result) => !isAvailable(result))

  if (missing) {
    return missing
  }

  const status = weakestStatus(results.map((result) => result.status))

  return results.find((result) => result.status === status) || null
}
