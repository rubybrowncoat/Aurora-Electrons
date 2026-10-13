// Links between pages. Each page that a link can open on one thing (its focus) reads it from these query keys, and writes its focus back to them as it changes (mixins/deep-link.js), so Back and Forward return it as it was left.
//
// | Page               | Query                                                                    |
// |--------------------|--------------------------------------------------------------------------|
// | `/map`             | `system=<SystemID>`                                                      |
// | `/minerals`        | `mineral=<mineral id>`, and `systems=<SystemID,…>` or `bodies=<bodies>`  |
// | `/habitability`    | `systems=<SystemID,…>` or `bodies=<bodies>`                              |
// | `/mineral-outlook` | `mineral=<mineral id>`                                                   |
// | `/routes`          | `from=<place>`, `via=<place,…>`, `to=<place>`, `cycle=1`, `fleet=<FleetID>` |
// | `/information`     | `from=<place>`, `to=<place>` (a colony or a system)                      |
// | `/survey-progress` | `system=<SystemID>`                                                      |
// | `/lagrange`        | `system=<SystemID>`                                                      |
// | `/intelligence`    | `race=<AlienRaceID>`                                                     |
// | `/technologies`    | `tech=<TechSystemID>` (Path view), `field=<ResearchFieldID>` (Fields view) or `view=lines` |
// | `/colony-outlook`  | `colony=<PopulationID>`                                                  |
// | `/production`      | `colony=<PopulationID>`                                                  |
// | `/commanders`      | `commander=<CommanderID>`, or `colony=<PopulationID>` for its governor   |
// | `/logistics`       | `view=fuel` or `view=maintenance`                                        |
// | `/log`             | `system=<SystemID>` or `colony=<PopulationID>`                           |
// | `/warnings`        | `check=<check key>`, or `severity=<severity key>` and `group=<group key>` |
// | `/propulsion`      | `class=<ShipClassID>` (the hull of a saved class) or `engine=<SDComponentID>` (an existing engine) |
// | `/shipyards`       | `from=<ShipClassID>` and `to=<ShipClassID>` (the refit from one saved class to another) |
//
// A mineral id is the `id` in utilities/minerals.js `MINERALS`. `<bodies>` is a JSON array of `bodyReference`s, which carry the names a page shows before its own reads are in. A `<place>` is `<kind>:<id>`, Route Finder's place key: `colony:<PopulationID>`, `fleet:<FleetID>`, `system:<SystemID>`, `body:<SystemBodyID>`, `jump:<WarpPointID>`, `lagrange:<LagrangePointID>`, `waypoint:<WaypointID>`, `wreck:<WreckID>`, `lifepod:<LifepodID>`, `survey:<SurveyLocationID>`, `contact:<UniqueID of the FCT_Contacts row>` or `aether:<AetherGateID>`. A route is `from`, the `via` places in order, then `to`; `cycle=1` closes it back to `from`, and `fleet` names the fleet whose speed and movement settings apply (a `from` that is a fleet brings its own).

// The query a link carries: the values given, as strings, and nothing for the ones left out.
export const cleanQuery = (values) => Object.fromEntries(Object.entries(values || {}).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [key, String(value)]))

// Two queries that open a page the same way.
export const sameQuery = (a, b) => {
  const left = cleanQuery(a)
  const right = cleanQuery(b)
  const keys = Object.keys(left)

  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

// The router gives a repeated key as an array; a link only ever writes it once.
const single = (value) => (Array.isArray(value) ? value[0] : value)

// An ID from the query, or null when it is missing or isn't a positive whole number.
export const queryId = (value) => {
  const id = Number(single(value))

  return Number.isInteger(id) && id > 0 ? id : null
}

// `1,2,3` as numbers, leaving out anything that isn't an ID.
export const queryIds = (value) => [...new Set(String(single(value) || '').split(',').map(queryId).filter(Boolean))]

// What the Colonization Planner and the Mineral Breakdown need to name a body before their reads are in.
export const bodyReference = (body) => ({
  SystemBodyID: body.SystemBodyID,
  SystemBodyName: body.SystemBodyName,
  SystemName: body.SystemName,
  BodyClass: body.BodyClass,
  Component: body.Component,
  PlanetNumber: body.PlanetNumber,
  OrbitNumber: body.OrbitNumber,
})

// The `bodies` query as body references; an unreadable one counts as none.
export const queryBodies = (value) => {
  try {
    const bodies = JSON.parse(single(value) || '[]')

    return Array.isArray(bodies) ? bodies.filter((body) => body && queryId(body.SystemBodyID)) : []
  } catch (error) {
    return []
  }
}

const PLACE_KINDS = ['colony', 'fleet', 'system', 'body', 'jump', 'lagrange', 'waypoint', 'wreck', 'lifepod', 'survey', 'contact', 'aether']

// Frozen, as `linkTo` is, so a page can hand them to its template through `data()` without Vue observing them.
export const place = Object.freeze(Object.fromEntries(PLACE_KINDS.map((kind) => [kind, (id) => `${kind}:${id}`])))

// `fleet:12` as { kind: 'fleet', id: 12 }, or null.
export const queryPlace = (value) => {
  const [kind, id] = String(single(value) || '').split(':')

  return PLACE_KINDS.includes(kind) && queryId(id) ? { kind, id: queryId(id) } : null
}

// `jump:3,wreck:7` as place keys, in order and with repeats; anything that isn't a place is left out.
export const queryPlaceKeys = (value) => String(single(value) || '').split(',').map(queryPlace).filter(Boolean).map(({ kind, id }) => place[kind](id))

// A route's ends in the query's terms: a first place, the places between and a last place. Given as `stops`, an ordered list, the first is `from`, the last (of two or more) is `to` and the rest are `via`; given as `from`, `via` and `to`, each stays as it is, so a link may leave out the origin.
const routeEnds = ({ from, via, to, stops }) => (stops ? { from: stops[0], via: stops.slice(1, -1), to: stops.length > 1 ? stops[stops.length - 1] : undefined } : { from, via, to })

const ids = (values) => (values && values.length ? [...new Set(values)].join(',') : null)
const bodies = (values) => (values && values.length ? JSON.stringify(values.map(bodyReference)) : null)
const link = (path, values) => ({ path, query: cleanQuery(values) })

// Router locations for `:to` and `$router.push`.
export const linkTo = Object.freeze({
  map: (systemId) => link('/map', { system: systemId }),
  minerals: ({ mineral, systems, bodies: picked } = {}) => link('/minerals', { mineral, systems: ids(systems), bodies: bodies(picked) }),
  planner: ({ systems, bodies: picked } = {}) => link('/habitability', { systems: ids(systems), bodies: bodies(picked) }),
  mineralOutlook: (mineralId) => link('/mineral-outlook', { mineral: mineralId }),
  routes: ({ cycle, fleet, ...ends } = {}) => {
    const { from, via, to } = routeEnds(ends)

    return link('/routes', { from, via: via && via.length ? via.join(',') : null, to, cycle: cycle ? 1 : null, fleet })
  },
  transport: ({ from, to } = {}) => link('/information', { from, to }),
  survey: (systemId) => link('/survey-progress', { system: systemId }),
  lagrange: (systemId) => link('/lagrange', { system: systemId }),
  intelligence: (alienRaceId) => link('/intelligence', { race: alienRaceId }),
  techTree: ({ tech, field, view } = {}) => link('/technologies', { tech, field, view }),
  colonyOutlook: (populationId) => link('/colony-outlook', { colony: populationId }),
  production: (populationId) => link('/production', { colony: populationId }),
  commanders: ({ commander, colony } = {}) => link('/commanders', { commander, colony }),
  logistics: (view) => link('/logistics', { view }),
  log: ({ system, colony } = {}) => link('/log', { system, colony }),
  warnings: ({ check, severity, group } = {}) => link('/warnings', { check, severity, group }),
  propulsion: ({ class: classId, engine } = {}) => link('/propulsion', { class: classId, engine }),
  shipyards: ({ from, to } = {}) => link('/shipyards', { from, to }),
})
