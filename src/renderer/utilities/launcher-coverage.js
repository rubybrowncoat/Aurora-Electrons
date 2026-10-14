// The coverage of the launching ship's sensors, kept apart from the sensor of the missile itself. A missile with no sensor of its own, or one whose own sensor reaches less than the shot, is guided from the ship by its missile fire control; the ship's search sensor finds the target for the fire control to track. Both are active sensors and reach a target by the one detection rule of design-rules.js (`sensorEffectiveRange`): the maximum range, cut by the square of the target's signature over the sensor's resolution when the target is under it, and by 0.75 to the jammer less the ECCM when the target's jammer is stronger than the ECCM. This module only reads that rule for the ship's sensors and sets the result beside the figures of a missile; it depends on the sensor model alone, never on the missile designer or the optimiser that read it.
//
// A launch sensor is a saved sensor component of the race (a missile fire control or an active sensor, as the save stores it: its maximum range, resolution and ECCM) or three typed figures. A figure that is missing is unknown, never 0: the coverage is then unavailable with the reason, and so is every comparison made with it. A sensor no one chose or typed is unknown in the same way.

import { SENSOR_RULES, sensorEffectiveRange } from './design-rules'
import { isAvailable, unavailable, valueOrNull } from './provenance'

export const LAUNCH_ROLES = Object.freeze({ missileFireControl: 'missileFireControl', search: 'search' })

export const LAUNCH_ROLE_LABELS = Object.freeze({ missileFireControl: 'Missile fire control', search: 'Search sensor' })

// How closely a coverage reaches a distance: to the last binary digits of the float, as the sensor model compares ranges.
const REACH_TOLERANCE = 1e-9

const known = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// A figure typed in a field as a number: blank is not given (null, no problem), text that is not a finite number of 0 or more is a problem and no figure.
const typedFigure = (value, label) => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { value: null, problem: '' }
  }

  const number = typeof value === 'number' ? value : Number(String(value).trim())

  return Number.isFinite(number) && number >= 0 ? { value: number, problem: '' } : { value: null, problem: `${label}: enter a number of 0 or more` }
}

// A sensor with no figure at all: what a role has before a component is chosen or a figure is typed.
export const noLaunchSensor = (role) => Object.freeze({ source: 'none', role, id: null, name: '', rangeKm: null, resolution: null, eccm: null, problems: Object.freeze({}) })

// A saved sensor the selection names that is not among the sensors of the race in this save: unknown, with the reason, and never replaced by figures typed beside it.
export const launchSensorMissing = (role, id) => Object.freeze({ source: 'missing', role, id, name: '', rangeKm: null, resolution: null, eccm: null, problems: Object.freeze({}), reason: `the saved sensor ${id} is not in this save` })

// A saved sensor component (`{ id, row }` of design-data.js `loadSensorFixture`, the row the columns of the save give) as a launch sensor. Its stored maximum range, resolution and ECCM are read as stored; one the save lacks is unknown.
export const launchSensorOfComponent = (component, role) => Object.freeze({ source: 'component', role, id: component.id, name: component.row.Name || '', rangeKm: known(component.row.MaxSensorRange), resolution: known(component.row.Resolution), eccm: known(component.row.ECCM), problems: Object.freeze({}) })

// A launch sensor from typed figures: the maximum range in km, the resolution and the ECCM. A blank figure is unknown and one that is not a number is refused with its problem; neither is filled in.
export const launchSensorTyped = ({ rangeKm, resolution, eccm }, role) => {
  const range = typedFigure(rangeKm, 'Maximum range')
  const res = typedFigure(resolution, 'Resolution')
  const counter = typedFigure(eccm, 'ECCM')
  const problems = Object.fromEntries([['rangeKm', range.problem], ['resolution', res.problem], ['eccm', counter.problem]].filter(([, problem]) => problem))

  return Object.freeze({ source: 'typed', role, id: null, name: 'Typed figures', rangeKm: range.value, resolution: res.value, eccm: counter.value, problems: Object.freeze(problems) })
}

// Why a result has no value, in words.
const reasonOf = (result) => (isAvailable(result) ? '' : result.inputs.missing.join('; ') || 'not known')

// The range a launch sensor reaches a target at, as a result of the sensor detection rule: `target` is { signature, jammer, missing }, the signature in HS and the sensor jammer strength of the target (both entered, null while not) and `missing` the reasons the target's figures are not usable, if any. A sensor that is not known (none chosen, or a saved one that is not in the save), a target figure that is not usable, or a maximum range, resolution or ECCM (needed only against a jammer) that is not known gives an unavailable result that names what is missing.
export const sensorCoverage = ({ sensor, target }) => {
  if (!sensor || sensor.source === 'none') {
    return unavailable({ rule: SENSOR_RULES.detection, missing: ['a launch sensor: a saved sensor of the race or typed figures'], units: 'km' })
  }

  if (sensor.source === 'missing') {
    return unavailable({ rule: SENSOR_RULES.detection, missing: [sensor.reason], units: 'km' })
  }

  if (target.missing && target.missing.length) {
    return unavailable({ rule: SENSOR_RULES.detection, missing: [...target.missing], units: 'km' })
  }

  return sensorEffectiveRange({ rangeKm: sensor.rangeKm, signature: known(target.signature), resolution: sensor.resolution, jammer: target.jammer === null || target.jammer === undefined ? 0 : target.jammer, eccm: sensor.eccm })
}

// Whether a coverage reaches a distance: 'covers', 'short', or 'unknown' with the reason when either is not known. Nothing unknown is ever compared as 0.
export const reaches = (coverage, distanceKm, label) => {
  const range = valueOrNull(coverage)
  const distance = known(distanceKm)

  if (range === null) {
    return Object.freeze({ verdict: 'unknown', reason: reasonOf(coverage) })
  }

  if (distance === null) {
    return Object.freeze({ verdict: 'unknown', reason: `${label} is not known` })
  }

  return Object.freeze({ verdict: range >= distance * (1 - REACH_TOLERANCE) ? 'covers' : 'short', reason: '', coverageKm: range, distanceKm: distance })
}

// The coverage of the launching ship against a target, beside the missile's own figures. `mfc` and `search` are launch sensors (or null), `target` is { signature, jammer }, `missile` is { ownReachKm, flightRangeKm } as numbers or null: the reach of the missile's own sensor against the target and the missile's greatest range. Returns { mfc, search, missile, links }: `mfc` and `search` each { sensor, coverage (a result), km (null when unknown), reason }, `links.mfcOverFlight` and `links.mfcOverOwnReach` the comparisons of the fire control's coverage with the missile's flight range and with its own sensor's reach. The missile's own sensor and the ship's are never added or merged.
export const launcherCoverage = ({ mfc = null, search = null, target, missile = { ownReachKm: null, flightRangeKm: null } }) => {
  const part = (sensor, role) => {
    const chosen = sensor || noLaunchSensor(role)
    const coverage = sensorCoverage({ sensor: chosen, target })

    return Object.freeze({ sensor: chosen, coverage, km: valueOrNull(coverage), reason: reasonOf(coverage) })
  }

  const fire = part(mfc, LAUNCH_ROLES.missileFireControl)
  const scan = part(search, LAUNCH_ROLES.search)

  return Object.freeze({
    mfc: fire,
    search: scan,
    missile: Object.freeze({ ownReachKm: known(missile.ownReachKm), flightRangeKm: known(missile.flightRangeKm) }),
    links: Object.freeze({ mfcOverFlight: reaches(fire.coverage, missile.flightRangeKm, 'The missile\'s greatest range'), mfcOverOwnReach: reaches(fire.coverage, missile.ownReachKm, 'The reach of the missile\'s own sensor') }),
  })
}

const LINK_WORDS = Object.freeze({ covers: 'reaches that far', short: 'falls short of it' })

// A comparison in words: 'the fire control reaches that far (…)', or why it is unknown.
export const describeLink = (link, format = String) => (link.verdict === 'unknown' ? `unknown: ${link.reason}` : `${LINK_WORDS[link.verdict]} (${format(link.coverageKm)} km against ${format(link.distanceKm)} km)`)

const SOURCE_WORDS = Object.freeze({ none: 'none chosen', component: 'saved sensor of the race', typed: 'typed figures', missing: 'saved sensor not in this save' })

// What a panel shows: each launch sensor as a row (its source, name, maximum range, resolution and ECCM as stored or typed, null where unknown, the coverage against the target with its reason, and the problems of a typed figure) and, for each missile `{ label, ownReachKm, ownReachReason, flightRangeKm, flightRangeReason }`, its own sensor's reach and its flight range beside the fire control's coverage of each, in words. Every figure is a number or null with the reason it is not known.
export const launcherView = ({ mfc = null, search = null, target, missiles = [], format = String }) => {
  const sensors = launcherCoverage({ mfc, search, target })

  return Object.freeze({
    sensors: [sensors.mfc, sensors.search].map((part) => Object.freeze({ role: part.sensor.role, label: LAUNCH_ROLE_LABELS[part.sensor.role], source: SOURCE_WORDS[part.sensor.source], name: part.sensor.name, rangeKm: part.sensor.rangeKm, resolution: part.sensor.resolution, eccm: part.sensor.eccm, problems: part.sensor.problems, km: part.km, reason: part.reason, text: part.km === null ? `Coverage of the target unknown: ${part.reason}` : `Reaches the target at ${format(part.km)} km (${SOURCE_WORDS[part.sensor.source]}${part.sensor.name && part.sensor.source === 'component' ? `: ${part.sensor.name}` : ''}).` })),
    missiles: missiles.map((missile) => {
      const covered = launcherCoverage({ mfc, search, target, missile })

      return Object.freeze({ label: missile.label, ownReachKm: covered.missile.ownReachKm, ownReachReason: covered.missile.ownReachKm === null ? missile.ownReachReason || 'not known' : '', ownReachText: covered.missile.ownReachKm === null ? `unknown: ${missile.ownReachReason || 'not known'}` : `${format(covered.missile.ownReachKm)} km`, flightRangeKm: covered.missile.flightRangeKm, flightRangeReason: covered.missile.flightRangeKm === null ? missile.flightRangeReason || 'not known' : '', flightRangeText: covered.missile.flightRangeKm === null ? `unknown: ${missile.flightRangeReason || 'not known'}` : `${format(covered.missile.flightRangeKm)} km`, overFlight: covered.links.mfcOverFlight, overOwnReach: covered.links.mfcOverOwnReach, overFlightText: describeLink(covered.links.mfcOverFlight, format), overOwnReachText: describeLink(covered.links.mfcOverOwnReach, format) })
    }),
  })
}

const isText = (value) => typeof value === 'string'

const emptyChoice = () => ({ id: null, rangeKm: '', resolution: '', eccm: '' })

// The launch sensors as the page keeps them: for each role the id of a saved sensor of the race, or the three figures as typed.
export const emptySelection = () => Object.fromEntries(Object.values(LAUNCH_ROLES).map((role) => [role, emptyChoice()]))

// A stored selection as it is read: what is not a saved sensor's id or text is left out, so a form of an earlier build never breaks the page.
export const normaliseSelection = (stored) => {
  const source = stored && typeof stored === 'object' ? stored : {}

  return Object.fromEntries(Object.values(LAUNCH_ROLES).map((role) => {
    const choice = source[role] && typeof source[role] === 'object' ? source[role] : {}

    return [role, { id: Number.isInteger(choice.id) && choice.id > 0 ? choice.id : null, rangeKm: isText(choice.rangeKm) ? choice.rangeKm : '', resolution: isText(choice.resolution) ? choice.resolution : '', eccm: isText(choice.eccm) ? choice.eccm : '' }]
  }))
}

// The launch sensor a selection of one role stands for: the saved sensor of `components` it names (one that is not among them is missing, never the figures typed), else the figures typed (a blank one unknown), else none.
export const sensorOfSelection = (choice, components, role) => {
  if (choice.id !== null) {
    const component = components.find((item) => item.id === choice.id)

    return component ? launchSensorOfComponent(component, role) : launchSensorMissing(role, choice.id)
  }

  return [choice.rangeKm, choice.resolution, choice.eccm].some((value) => value.trim() !== '') ? launchSensorTyped(choice, role) : noLaunchSensor(role)
}
