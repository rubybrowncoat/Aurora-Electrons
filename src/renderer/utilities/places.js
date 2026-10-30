// The places a route can start, stop at or end, as Route Finder and the Transport page offer them. Each option is { key, kind, group, name, subtitle, icon, SystemID, Xcor, Ycor } with the source row beside it, and `searchable` adds the lowercase words a search matches. `key` comes from utilities/deep-links.js `place` and `kind` is its prefix; `group` is the picker's heading, one of `PLACE_GROUPS`. Positions are in-system km from the star, a system's own place is its centre (0, 0). The places that need a read of their own (bodies, survey locations, waypoints, wrecks, contacts and the rest) come from utilities/place-data.js.

import { place } from './deep-links'

// The picker's headings, in the order it lists them.
export const PLACE_GROUPS = Object.freeze([
  { id: 'colony', title: 'Colonies', icon: 'mdi-earth' },
  { id: 'system', title: 'Systems', icon: 'mdi-white-balance-sunny' },
  { id: 'planet', title: 'Planets', icon: 'mdi-orbit' },
  { id: 'moon', title: 'Moons', icon: 'mdi-moon-waning-crescent' },
  { id: 'asteroid', title: 'Asteroids', icon: 'mdi-chart-bubble' },
  { id: 'comet', title: 'Comets', icon: 'mdi-meteor' },
  { id: 'jump', title: 'Jump points', icon: 'mdi-transit-connection-variant' },
  { id: 'lagrange', title: 'Lagrange points', icon: 'mdi-vector-triangle' },
  { id: 'waypoint', title: 'Waypoints', icon: 'mdi-flag-variant' },
  { id: 'fleet', title: 'Fleets', icon: 'mdi-rocket-outline' },
  { id: 'survey', title: 'Survey locations', icon: 'mdi-radar' },
  { id: 'wreck', title: 'Wrecks', icon: 'mdi-skull-outline' },
  { id: 'lifepod', title: 'Life pods', icon: 'mdi-lifebuoy' },
  { id: 'contact', title: 'Contacts', icon: 'mdi-ufo-outline' },
  { id: 'aether', title: 'Aether gates', icon: 'mdi-vector-circle' },
])

const GROUP_ICON = Object.fromEntries(PLACE_GROUPS.map((group) => [group.id, group.icon]))

export const groupIcon = (group) => GROUP_ICON[group]

// `colonies`: [{ PopulationID, PopName, SystemID, Capital, Xcor, Ycor }]; `systemName(SystemID)` names the system a colony is in.
export const colonyPlaces = (colonies, systemName) => colonies.map((colony) => ({
  key: place.colony(colony.PopulationID),
  kind: 'colony',
  group: 'colony',
  name: colony.PopName,
  subtitle: `Colony in ${systemName(colony.SystemID)}${colony.Capital ? ', capital' : ''}`,
  icon: colony.Capital ? 'mdi-star-circle-outline' : GROUP_ICON.colony,
  SystemID: colony.SystemID,
  Xcor: colony.Xcor,
  Ycor: colony.Ycor,
  Capital: colony.Capital,
  colony,
}))

// `systems`: [{ SystemID, Name }], by name. A system's place is its centre.
export const systemPlaces = (systems) => systems.slice().sort((a, b) => a.Name.localeCompare(b.Name)).map((system) => ({
  key: place.system(system.SystemID),
  kind: 'system',
  group: 'system',
  name: system.Name,
  subtitle: 'System',
  icon: GROUP_ICON.system,
  SystemID: system.SystemID,
  Xcor: 0,
  Ycor: 0,
}))

// `fleets`: [{ FleetID, FleetName, SystemID, Xcor, Ycor, Speed, Ships }]; `count(number)` formats a speed. A fleet with no speed in the save is not called not moving.
export const fleetPlaces = (fleets, systemName, count) => fleets.map((fleet) => ({
  key: place.fleet(fleet.FleetID),
  kind: 'fleet',
  group: 'fleet',
  name: fleet.FleetName,
  subtitle: `Fleet in ${systemName(fleet.SystemID)}, ${!Number.isFinite(fleet.Speed) ? 'speed not recorded' : fleet.Speed > 1 ? `${count(fleet.Speed)} km/s` : 'not moving'}, ${fleet.Ships} ${fleet.Ships === 1 ? 'ship' : 'ships'}`,
  icon: GROUP_ICON.fleet,
  SystemID: fleet.SystemID,
  Xcor: fleet.Xcor,
  Ycor: fleet.Ycor,
  fleet,
}))

// The game numbers a system's jump points JP1, JP2, … by their distance from the star: { [WarpPointID]: number }. `jumpPoints`: loadJumpPoints rows.
export const jumpPointNumbers = (jumpPoints) => {
  const numbers = {}
  const bySystem = {}

  jumpPoints.forEach((jumpPoint) => {
    ;(bySystem[jumpPoint.SystemID] = bySystem[jumpPoint.SystemID] || []).push(jumpPoint)
  })
  Object.values(bySystem).forEach((list) => list.sort((a, b) => a.Distance - b.Distance || a.WarpPointID - b.WarpPointID).forEach((jumpPoint, index) => {
    numbers[jumpPoint.WarpPointID] = index + 1
  }))

  return numbers
}

// What the game calls a jump point by its number: JP1, JP2, …
export const jumpPointLabel = (number) => `JP${number}`

// What stands for the system beyond a jump point that is not explored.
export const FAR_UNKNOWN_TEXT = 'Unex'

// The game names a jump point by the system beyond it, or "Unex" while it is unexplored. A stabilised one carries "(S)". `jumpPoints`: loadJumpPoints rows.
export const jumpPointPlaces = (jumpPoints, systemName) => {
  const byId = Object.fromEntries(jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))
  const numbers = jumpPointNumbers(jumpPoints)

  return jumpPoints.map((jumpPoint) => {
    const partner = jumpPoint.Explored ? byId[jumpPoint.WPLink] : null
    const far = partner ? systemName(partner.SystemID) : FAR_UNKNOWN_TEXT
    const label = jumpPointLabel(numbers[jumpPoint.WarpPointID])
    const mark = jumpPoint.JumpGateStrength > 0 ? ' (S)' : ''

    return {
      key: place.jump(jumpPoint.WarpPointID),
      kind: 'jump',
      group: 'jump',
      name: `${label}: ${far}${mark}`,
      label,
      far,
      mark,
      subtitle: `Jump point in ${systemName(jumpPoint.SystemID)}${jumpPoint.JumpGateStrength > 0 ? ', stabilised' : ''}`,
      icon: GROUP_ICON.jump,
      SystemID: jumpPoint.SystemID,
      Xcor: jumpPoint.Xcor,
      Ycor: jumpPoint.Ycor,
      jumpPoint,
    }
  })
}

// The game numbers a system's Lagrange points LP1, LP2, … by star and distance, and names one for the planet it sits by. `points`: the routes page's Lagrange rows with `Distance`, `Component` and the body's naming fields; `bodyName(point)` names that body.
export const lagrangePlaces = (points, systemName, bodyName) => {
  const numbers = {}
  const bySystem = {}

  points.forEach((point) => {
    ;(bySystem[point.SystemID] = bySystem[point.SystemID] || []).push(point)
  })
  Object.values(bySystem).forEach((list) => list.slice().sort((a, b) => (a.Component || 0) - (b.Component || 0) || a.Distance - b.Distance || a.LagrangePointID - b.LagrangePointID).forEach((point, index) => {
    numbers[point.LagrangePointID] = index + 1
  }))

  return points.map((point) => ({
    key: place.lagrange(point.LagrangePointID),
    kind: 'lagrange',
    group: 'lagrange',
    name: `LP${numbers[point.LagrangePointID]} (${bodyName(point)})`,
    subtitle: `Lagrange point in ${systemName(point.SystemID)}`,
    icon: GROUP_ICON.lagrange,
    SystemID: point.SystemID,
    Xcor: point.Xcor,
    Ycor: point.Ycor,
  }))
}

// The options with `text`: their name and their system's, for `filterPlace`.
export const searchable = (places, systemName) => places.map((option) => ({ ...option, text: `${option.name} ${systemName(option.SystemID)}`.toLowerCase() }))

// A v-autocomplete `filter` over `searchable` options.
export const filterPlace = (item, query) => item.text.includes(query.toLowerCase())

// The place a move order sends a fleet to, as a place key, or null for one that names nothing the page offers. Orders are `FCT_MoveOrders` rows: `DestinationType` 1 is a jump point, 2 a body (15 a deep space population), 4 a survey location, 5 a waypoint, 6 a contact, 7 a life pod, 8 a wreck, 10 a fleet, 12 a Lagrange point and 14 an aether gate, with `DestinationID` the thing's own ID (the contact's `UniqueID`; a survey location's number within its system, which the caller turns into `SurveyLocationID`). A body with one of the race's own colonies on it is that colony: `PopulationID` is set and `PopulationRaceID` is the race's.
export const orderPlaceKey = (order, raceId) => {
  const id = order.DestinationID

  switch (order.DestinationType) {
    case 1: return place.jump(id)
    case 2:
    case 15: return order.PopulationID > 0 && order.PopulationRaceID === raceId ? place.colony(order.PopulationID) : place.body(id)
    case 4: return order.SurveyLocationID ? place.survey(order.SurveyLocationID) : null
    case 5: return place.waypoint(id)
    case 6: return place.contact(id)
    case 7: return place.lifepod(id)
    case 8: return place.wreck(id)
    case 10: return place.fleet(id)
    case 12: return place.lagrange(id)
    case 14: return place.aether(id)
    default: return null
  }
}
