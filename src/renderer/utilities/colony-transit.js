// The Colonization Planner's transit estimate: how many jumps, how far and how long one representative ship flies to a body from the race's nearest colony with people, over the jump points the race has explored (jump-graph.js `searchRoutes`, the tracing the Route Finder and the Transport page use). The ranking and the Distance column keep their own reading of distance (colonization.js `rankBodies`); this adds the figures a player sorts by when the trip matters.
//
// What the estimate rests on, each choice stated on the figure it gives:
//   - the ship is a representative one, not a fleet: the speed is entered or taken from a ship class under Transit, and with none there is a route and a distance but no time;
//   - the ship's drive decides which jump points it crosses: with a jump drive every explored jump point, without one only the points stabilised on the departure side (a one-way trip, so the far side need not be);
//   - inside a system the ship flies straight, and with Lagrange routing on it jumps between two Lagrange points at no distance when that is strictly shorter, as the game's automatic Lagrange routing does;
//   - positions are those at the save's time: planets, moons and the colonies on them keep moving, so every leg inside a system is a snapshot;
//   - only what the race knows is searched: the systems it has surveyed and the jump points it has charted and explored. Changing the speed or the drive never adds a link.

import { KM_PER_AU, routeLegs, searchRoutes } from './jump-graph'
import { combine, ofRule, registerRule, unavailable } from './provenance'
import { hasGate } from './transport'

const VERSIONS = ['2.7.x']
const SECONDS_PER_DAY = 86400
const ROUTE_INPUTS = ['the explored jump points', 'their positions', 'the colony and body positions']

registerRule({
  id: 'habitability.transitSpeed',
  versions: VERSIONS,
  units: 'km/s',
  verification: 'assumed',
  structure: ['FCT_ShipClass.MaxSpeed'],
  note: 'The one speed the representative ship flies the whole way: the figure entered under Transit, or the top speed of the ship class picked there. It is the player\'s choice, not the speed of any fleet; with none entered there is no travel time.',
  assumptions: ['one speed all the way'],
})

registerRule({
  id: 'habitability.transitRoute',
  versions: VERSIONS,
  units: 'km, jumps',
  verification: 'estimated',
  structure: ['FCT_JumpPoint.Xcor, Ycor, WPLink, JumpGateStrength', 'FCT_RaceJumpPointSurvey.Explored, Charted', 'FCT_LagrangePoint.Xcor, Ycor', 'FCT_Population.Capital, Population', 'FCT_SystemBody.Xcor, Ycor'],
  note: 'The shortest route in kilometres from the nearest colony with people to the body, over the jump points the race has charted and explored that the chosen drive may cross, with the jumps it makes. The search is the one the Route Finder uses, which reproduced the game\'s fewest-transit routes; the kilometre route is the planner\'s reading, because the game\'s automatic route takes the fewest transits and a player may queue a shorter one. Not compared with a distance the game stores.',
  assumptions: ['a one-way trip from the nearest colony with people, the capital included', 'positions as saved: bodies, moons and the colonies on them keep moving, so each leg inside a system is a snapshot', 'military restriction, danger and alien-system avoidance are not applied'],
})

registerRule({
  id: 'habitability.transitTime',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['habitability.transitRoute', 'habitability.transitSpeed'],
  note: 'The route\'s kilometres over the representative speed. A jump takes no time here; the jump shock after each, nebula and dust speed limits, acceleration and refuelling are left out, so the figure is not compared with a time the game stores.',
  assumptions: ['no jump shock, nebula limits or refuelling stops'],
})

// What a ship's drive lets it cross. A jump drive crosses every explored jump point; without one a ship transits only a point stabilised on the side it leaves from.
export const DRIVES = Object.freeze([
  Object.freeze({ id: 'drive', label: 'Jump drive', hint: 'The ship makes its own jump, so every explored jump point can be crossed.' }),
  Object.freeze({ id: 'gates', label: 'Stabilised only', hint: 'The ship has no jump drive that carries it (none, or one too small for its largest hull), so only a jump point stabilised on the side it leaves from can be crossed.' }),
])

export const DRIVE_IDS = Object.freeze(DRIVES.map((drive) => drive.id))

// What the Transit column can be sorted by. A sort puts a body with no known figure last, whichever way it runs, and breaks a tie with the second figure.
export const TRANSIT_SORTS = Object.freeze([
  Object.freeze({ id: 'time', label: 'Time', hint: 'Days at the representative speed; unknown without a speed.' }),
  Object.freeze({ id: 'distance', label: 'Distance', hint: 'Kilometres of the shortest route the ship may fly.' }),
  Object.freeze({ id: 'jumps', label: 'Jumps', hint: 'Jump points crossed, ties by distance.' }),
])

export const SORT_IDS = Object.freeze(TRANSIT_SORTS.map((sort) => sort.id))

// The basis a new visit starts from: no speed (a blank is unknown, never 0), the ship able to make its own jump and Lagrange routing on, as fleets have it unless told not to.
export const DEFAULT_BASIS = Object.freeze({ speed: null, drive: 'drive', lagrange: true })

// What the Transit column says for a body that has no estimate.
export const TRANSIT_STATE_TEXT = Object.freeze({ 'no-origin': 'No colony to fly from', 'no-position': 'No position', 'needs-drive': 'Needs a jump drive', 'no-route': 'No explored route' })

// A speed as the page keeps it: a number above 0, else null. A blank or a figure that is not a speed is unknown.
export const normaliseSpeed = (value) => {
  const speed = typeof value === 'string' && !value.trim() ? NaN : Number(value)

  return Number.isFinite(speed) && speed > 0 ? speed : null
}

const normaliseBasis = (basis) => ({ speed: normaliseSpeed(basis.speed), drive: basis.drive === 'gates' ? 'gates' : 'drive', lagrange: basis.lagrange !== false })

// Whether the drives of `sizes` (the largest rating stored of each kind, null when none is) carry a hull of `hull`: true when a stored rating does, null when none does but a rating is not stored (`unrated`, or a size that is null), so only a capacity the save does not record could, and false when every drive is rated and none does.
const carries = (sizes, unrated, hull) => {
  if (sizes.some((size) => Number.isFinite(size) && size >= hull)) {
    return true
  }

  return unrated || sizes.some((size) => !Number.isFinite(size)) ? null : false
}

// The drive a ship class stands for: 'drive' when its own jump drive is rated for its largest hull, 'gates' when it has none that carries it, null when the figures the save holds cannot settle it: no size for the hull (a size that is not stored would otherwise be read as 0, which any drive covers), a drive whose rating is not stored where no stored one already carries the hull, or an engine flag that is not stored where the ordinary and the commercial drives differ in whether they carry the hull. Military ships count ordinary jump drives only, commercial ships the commercial ones too, the ordinary among them, as `fleetCanTransit` has it. `Drive` and `AnyDrive` are the largest ratings stored of the ordinary and of every kind, `DriveUnknown` and `AnyDriveUnknown` whether a drive of that kind has no rating stored (colonization-data.js `loadTransitClasses`).
export const driveOfClass = (shipClass) => {
  const { Size: hull, MilitaryEngines: engines, Drive: ordinary, AnyDrive: any, DriveUnknown: ordinaryUnrated, AnyDriveUnknown: anyUnrated, NoKindDrive: noKind, NoKindDriveUnknown: noKindUnrated } = shipClass

  if (!Number.isFinite(hull) || hull <= 0) {
    return null
  }

  const ordinaryCarries = carries([ordinary], Boolean(ordinaryUnrated), hull)
  // A drive whose kind the save does not store may be an ordinary one: where no stored ordinary drive carries the hull, it leaves the military answer open when its rating meets the hull or is not stored. A commercial hull counts every kind, so `AnyDrive` already holds it.
  const military = ordinaryCarries === false && (noKindUnrated || (Number.isFinite(noKind) && noKind >= hull)) ? null : ordinaryCarries
  const commercial = carries([any, ordinary], Boolean(anyUnrated || ordinaryUnrated), hull)
  const unsure = engines === null || engines === undefined
  // With the engine flag unknown, either rule's answer settles it only where the other cannot disagree: no drive of any kind carries the hull, or the ordinary one does (and so does the commercial one, which counts it too).
  const known = unsure ? (commercial === false ? false : military === true ? true : null) : engines ? military : commercial

  return known === null ? null : known ? 'drive' : 'gates'
}

const hasPosition = (point) => Number.isFinite(point.Xcor) && Number.isFinite(point.Ycor)

const speedResultOf = (speed) => (speed === null ? unavailable({ rule: 'habitability.transitSpeed', missing: ['a representative speed (none entered under Transit)'] }) : ofRule({ rule: 'habitability.transitSpeed', value: speed, inputs: { present: ['the speed entered or taken from a ship class'] } }))

const jumpsText = (jumps) => `${jumps} ${jumps === 1 ? 'jump' : 'jumps'}`

// The standing assumptions of one basis, as a list for a result.
const assumptionsOf = ({ drive, lagrange }, unknownGates) => [
  drive === 'drive' ? 'every explored jump point can be crossed (the ship has a jump drive rated for its largest hull)' : 'only a jump point stabilised on the side the ship leaves from is crossed (the ship has no jump drive that carries it)',
  ...(drive === 'gates' && unknownGates ? [`${unknownGates} ${unknownGates === 1 ? 'jump point has' : 'jump points have'} no gate strength in the save and ${unknownGates === 1 ? 'is' : 'are'} not taken as stabilised`] : []),
  lagrange ? 'Lagrange point jumps are used inside a system when strictly shorter (the game\'s automatic Lagrange routing)' : 'no Lagrange point jumps are used',
]

// The basis in words, for a header or a note: "3,000 km/s, jump drive, Lagrange points". `count` writes a number.
export const basisText = (basis, count = String) => {
  const { speed, drive, lagrange } = normaliseBasis(basis)

  return [speed === null ? 'no speed' : `${count(speed)} km/s`, DRIVES.find((option) => option.id === drive).label.toLowerCase(), lagrange ? 'Lagrange points used' : 'no Lagrange points'].join(', ')
}

const missingEstimate = (state, missing, speedResult, assumptions) => {
  const route = unavailable({ rule: 'habitability.transitRoute', missing: [missing], assumptions })

  return Object.freeze({ state, route: null, km: null, au: null, jumps: null, from: null, days: null, results: Object.freeze({ route, time: combine({ rule: 'habitability.transitTime', parts: { route, speed: speedResult } }) }) })
}

// An estimator for one basis: `estimate(body)` gives the trip of a representative ship from the race's nearest colony to a body ({ SystemID, Xcor, Ycor }):
//   - `state`: 'routed', or why there is no route: 'no-origin' (no colony with people and a position), 'no-position' (the body has none in the save), 'needs-drive' (an explored route exists, but only through a jump point the ship cannot cross without a jump drive) or 'no-route' (no explored route from any colony);
//   - `km`, `au`, `jumps`, `from` (the colony the route starts at), `days` and `route` (the search's route, for `transitLegs`), all null when there is no route, and `days` null without a speed: an unknown figure is never 0;
//   - `results`: { route, time }, provenance results; `route` carries { km, au, jumps, from }, and both name what is missing when unavailable.
// `routes` is colonization-data.js `loadRoutes`, `lagrangePoints` its `loadLagrangePoints`; `basis` { speed (km/s or blank), drive, lagrange }. Only jump points of `routes` are ever crossed: the loader holds the ones the race has charted in the systems it knows, and a search crosses only the explored ones, so no basis reaches a system or a link the race does not know.
export const transitEstimator = (routes, lagrangePoints, basis) => {
  const chosen = normaliseBasis(basis)
  const { jumpPoints, colonies } = routes
  const options = { order: 'km', lagrangePoints: chosen.lagrange ? lagrangePoints : [] }
  const unknownGates = chosen.drive === 'gates' ? jumpPoints.filter((jumpPoint) => !Number.isFinite(jumpPoint.JumpGateStrength)).length : 0
  const assumptions = assumptionsOf(chosen, unknownGates)
  const hasOrigin = colonies.some(hasPosition)
  const own = searchRoutes(jumpPoints, colonies, chosen.drive === 'gates' ? { ...options, canTransit: hasGate } : options)
  const open = chosen.drive === 'gates' ? searchRoutes(jumpPoints, colonies, options) : own
  const speedResult = speedResultOf(chosen.speed)

  return (body) => {
    if (!hasOrigin) {
      return missingEstimate('no-origin', 'a colony with people and a position to fly from', speedResult, assumptions)
    } else if (!hasPosition(body)) {
      return missingEstimate('no-position', 'the body\'s position (FCT_SystemBody.Xcor, Ycor)', speedResult, assumptions)
    }

    const found = own.toPlace(body)

    if (!found) {
      return open.toPlace(body) ? missingEstimate('needs-drive', 'a route a ship without a jump drive can fly: the explored way crosses a jump point that is not stabilised', speedResult, assumptions) : missingEstimate('no-route', 'an explored route from a colony with people', speedResult, assumptions)
    }

    const km = found.km
    const au = km / KM_PER_AU
    const route = ofRule({ rule: 'habitability.transitRoute', value: { km, au, jumps: found.jumps, from: found.from }, inputs: { present: ROUTE_INPUTS }, assumptions })
    const time = combine({ rule: 'habitability.transitTime', parts: { route, speed: speedResult }, compute: (values) => values.route.km / values.speed / SECONDS_PER_DAY })

    return Object.freeze({ state: 'routed', route: found, km, au, jumps: found.jumps, from: found.from, days: time.value, results: Object.freeze({ route, time }) })
  }
}

// The two numbers a sort of the Transit column compares for an estimate, `value` then `tie`, each null when the estimate has no such figure: time by days, distance by kilometres, jumps by jumps with the kilometres breaking a tie.
export const transitSortValues = (estimate, sort) => {
  if (sort === 'jumps') {
    return { value: estimate.jumps, tie: estimate.km }
  }

  return { value: sort === 'distance' ? estimate.km : estimate.days, tie: sort === 'time' ? estimate.km : estimate.jumps }
}

// The legs flown inside each system on a route, in order: [{ SystemID, km, via }], `via` the Lagrange points a leg jumps between or null. The jumps between them take no distance.
export const transitLegs = (estimate) => (estimate.route ? routeLegs(estimate.route).filter((leg) => leg.kind === 'fly').map((leg) => ({ SystemID: leg.SystemID, km: leg.km, via: leg.via })) : [])

// The Planner's table ordered by `sortBy` ([field] or none) and `sortDesc` ([boolean]): a field that is null (a figure that does not exist) goes last whichever way the sort runs and is never read as 0; text is collated by `collate(x, y)`, numbers compare as numbers; on the Transit column a tie of known figures is broken by the item's `transitTie`. Items with no field to sort by come back as they were.
export const sortTableItems = (items, sortBy, sortDesc, collate) => {
  const [by] = sortBy

  if (!by) {
    return items
  }

  const direction = sortDesc[0] ? -1 : 1
  const compare = (x, y) => (x === y ? 0 : x === null || y === null ? (x === null ? 1 : -1) : (typeof x === 'string' ? collate(x, y) : x - y) * direction)

  return [...items].sort((a, b) => compare(a[by], b[by]) || (by === 'transitValue' && a[by] !== null ? compare(a.transitTie, b.transitTie) : 0))
}

// What an estimate says in words for a tooltip: where from, the jumps and the kilometres of each system's leg, or why there is no route. `systemName(SystemID)` and `count(value, decimals)` write a name and a number.
export const transitText = (estimate, { systemName, count }) => {
  if (estimate.state !== 'routed') {
    return `No transit estimate: ${estimate.results.route.inputs.missing[0]}.`
  }

  const legs = transitLegs(estimate)
  const flown = legs.map((leg) => `${systemName(leg.SystemID)} ${count(leg.km / KM_PER_AU, 2)} AU${leg.via ? ' (through Lagrange points)' : ''}`).join(', then ')
  const from = estimate.from && estimate.from.PopName ? estimate.from.PopName.replace(/<[^>]*>/g, '') : 'the nearest colony'

  return `From ${from}: ${jumpsText(estimate.jumps)}, ${count(estimate.au, 2)} AU in all${flown ? `, flown as ${flown}` : ''}.`
}
