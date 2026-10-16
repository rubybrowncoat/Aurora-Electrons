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
// | `/sensors`         | `mode=active`, `passive` or `beam`, `sensor=<SDComponentID>` (an existing sensor or fire control design), or in Active mode a missile as the target (the missile target keys below) |
// | `/missile-designer` | `missile=<MissileID>` (a saved missile of the race, pinned as the baseline) and `name=<its name>` (a link from another page names it, so a missile that changed is told) |
// | `/designed-tech`   | `design=<SDComponentID>` (a component design: its category opens with the design picked) or `missile=<MissileID>` (a missile design: the Missiles category opens with it picked) |
// | `/shipyards`       | `from=<ShipClassID>` and `to=<ShipClassID>` (the refit from one saved class to another) |
//
// The missile target of `/sensors` is what the Missile Designer hands over (`linkTo.sensors({ target })`): `msp=<size in MSP>` and `range=<evaluated range in km>` (the missile is the target and the range the wanted range), `src=saved`, `researched`, `hypothetical` or `manual` (where the figures come from), `missile=<MissileID>` (for `src=saved` only: a candidate is never a saved ID), `name=<the missile's name>`, `sig=<HS>` (the target signature the missile was evaluated against), `res=best` or one of the sensor resolutions in HS (design-rules.js `SENSOR_RESOLUTIONS_HS`) and `jam=<level>` (the resolution and the target's sensor jammer the sizing starts from) and `tech=<type>:<TechSystemID>:<r or h>,…` (the tech levels the design is built on, by line, id and kind: `r` researched, `h` hypothetical; a line is named once). `msp`, `range` and `src` are required; a missile target with a missing or unreadable part, a resolution the window does not offer or a line named twice is refused whole, with the reason shown on the page, and never applied in part.
//
// A mineral id is the `id` in utilities/minerals.js `MINERALS`. `<bodies>` is a JSON array of `bodyReference`s, which carry the names a page shows before its own reads are in. A `<place>` is `<kind>:<id>`, Route Finder's place key: `colony:<PopulationID>`, `fleet:<FleetID>`, `system:<SystemID>`, `body:<SystemBodyID>`, `jump:<WarpPointID>`, `lagrange:<LagrangePointID>`, `waypoint:<WaypointID>`, `wreck:<WreckID>`, `lifepod:<LifepodID>`, `survey:<SurveyLocationID>`, `contact:<UniqueID of the FCT_Contacts row>` or `aether:<AetherGateID>`. A route is `from`, the `via` places in order, then `to`; `cycle=1` closes it back to `from`, and `fleet` names the fleet whose speed and movement settings apply (a `from` that is a fleet brings its own).

import { SENSOR_RESOLUTIONS_HS } from './design-rules'

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

// A value of the query as a sentence shows it: the first 80 characters and an ellipsis, so a link that carries a very long value cannot make a notice as long. Only the words use it; the value itself is kept whole for every check and every link written from it.
export const CUT_LENGTH = 80
export const cutText = (value) => {
  const text = String(value)

  return text.length > CUT_LENGTH ? `${text.slice(0, CUT_LENGTH - 1)}…` : text
}

// ---- The missile target of the Sensor Planner ------------------------------------------------------------------------

export const MISSILE_TARGET_SOURCES = Object.freeze(['saved', 'researched', 'hypothetical', 'manual'])

// The most tech levels a link names: the designer reads a dozen lines, so a longer list is no missile of the designer's.
export const MAX_TARGET_TECH = 30

const TARGET_KEYS = Object.freeze(['msp', 'range', 'src', 'missile', 'name', 'sig', 'res', 'jam', 'tech'])
const TECH_KIND_CODES = Object.freeze({ r: 'researched', h: 'hypothetical' })

// A figure as the query writes it: to 12 significant digits, and nothing for one that is not a finite number (an unknown figure is never written as 0).
const figureText = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toPrecision(12))) : null)

// The query values of a missile target, `{ missile, name, msp, range, signature, resolution, jammer, source, tech: [{ type, id, kind }] }` with null for a part it does not have; for `linkTo.sensors({ target })`.
export const missileTargetValues = (target) => {
  if (!target) {
    return {}
  }

  const tech = Array.isArray(target.tech) ? target.tech.map(({ type, id, kind }) => `${type}:${id}:${kind === 'hypothetical' ? 'h' : 'r'}`).join(',') : null

  return { missile: target.missile, name: target.name ? String(target.name) : null, msp: figureText(target.msp), range: figureText(target.range), sig: figureText(target.signature), res: target.resolution === 'best' ? 'best' : figureText(target.resolution), jam: figureText(target.jammer), src: target.source, tech }
}

// A number the query gives: null when blank, NaN when it is not a number that is above 0 (or 0 or more with `zero`).
const queryNumber = (value, zero = false) => {
  const text = String(single(value) === undefined ? '' : single(value)).trim()

  if (text === '') {
    return null
  }

  const number = Number(text)

  return Number.isFinite(number) && (zero ? number >= 0 : number > 0) ? number : NaN
}

// The missile target a query names: null when the query has none of its keys, else `{ target, problems }`. A target with any part missing or unreadable has `target: null` and its problems in words, so a page tells why it was not applied and never applies part of it.
export const queryMissileTarget = (query) => {
  const given = (key) => query && single(query[key]) !== undefined && single(query[key]) !== ''

  if (!query || !TARGET_KEYS.some(given)) {
    return null
  }

  const problems = []
  const figure = (key, label, { required = false, zero = false } = {}) => {
    const number = queryNumber(query[key], zero)

    if (number === null && required) {
      problems.push(`${label} is missing`)
    } else if (Number.isNaN(number)) {
      problems.push(`${label} is not a number ${zero ? 'of 0 or more' : 'above 0'}`)
    }

    return Number.isNaN(number) ? null : number
  }

  const msp = figure('msp', 'the missile size (msp)', { required: true })
  const range = figure('range', 'the range', { required: true })
  const signature = figure('sig', 'the target signature (sig)')
  const jammer = figure('jam', 'the jammer (jam)', { zero: true })
  const resolutionText = String(single(query.res) === undefined ? '' : single(query.res)).trim()
  const resolutionNumber = resolutionText === '' || resolutionText === 'best' ? null : queryNumber(resolutionText)
  const source = single(query.src)
  const missile = given('missile') ? queryId(query.missile) : null
  const tech = []

  if (resolutionText !== '' && resolutionText !== 'best' && !SENSOR_RESOLUTIONS_HS.includes(resolutionNumber)) {
    problems.push(`the resolution (res) is ${cutText(resolutionText)}, not best or one of the sensor resolutions (1 to 20, 25 to 200 in fives, 220 to 500 in twenties HS)`)
  }

  if (!MISSILE_TARGET_SOURCES.includes(source)) {
    problems.push(source === undefined || source === '' ? 'where the figures come from (src) is missing' : `where the figures come from (src) is ${cutText(source)}, not one of ${MISSILE_TARGET_SOURCES.join(', ')}`)
  }

  if (given('missile') && missile === null) {
    problems.push('the missile ID (missile) is not a whole number above 0')
  }

  if (source === 'saved' && !given('missile')) {
    problems.push('a saved missile names no missile ID')
  } else if (source !== 'saved' && MISSILE_TARGET_SOURCES.includes(source) && given('missile')) {
    problems.push(`a ${source} candidate is not a saved missile and names no missile ID`)
  }

  const parts = String(single(query.tech) || '').split(',').filter((part) => part !== '')

  if (parts.length > MAX_TARGET_TECH) {
    problems.push(`${parts.length} tech levels are named, and a missile is built on at most ${MAX_TARGET_TECH}`)
  }

  parts.slice(0, MAX_TARGET_TECH).forEach((part) => {
    const match = /^(\d+):(\d+):([rh])$/.exec(part)

    if (match && Number(match[1]) > 0 && Number(match[2]) > 0) {
      if (tech.some((item) => item.type === Number(match[1]))) {
        problems.push(`the tech line ${cutText(match[1])} is named more than once (${cutText(part)}), and a line has one level`)
      } else {
        tech.push({ type: Number(match[1]), id: Number(match[2]), kind: TECH_KIND_CODES[match[3]] })
      }
    } else {
      problems.push(`the tech level "${cutText(part)}" is not <type>:<TechSystemID>:<r or h>`)
    }
  })

  if (source === 'hypothetical' && !tech.some((item) => item.kind === 'hypothetical')) {
    problems.push('a hypothetical missile names no hypothetical tech level')
  } else if ((source === 'researched' || source === 'saved') && tech.some((item) => item.kind === 'hypothetical')) {
    problems.push(`a ${source} missile names a hypothetical tech level`)
  }

  const name = given('name') ? String(single(query.name)) : ''

  return { target: problems.length ? null : { missile, name, msp, range, signature, resolution: resolutionText === '' ? null : resolutionText === 'best' ? 'best' : resolutionNumber, jammer, source, tech }, problems }
}

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
  designedTech: ({ design, missile } = {}) => link('/designed-tech', { design, missile }),
  sensors: ({ mode, sensor, target } = {}) => link('/sensors', { mode: target && !mode ? 'active' : mode, sensor, ...missileTargetValues(target) }),
  missileDesigner: ({ missile, name } = {}) => link('/missile-designer', { missile, name: missile ? name : undefined }),
  shipyards: ({ from, to } = {}) => link('/shipyards', { from, to }),
})
