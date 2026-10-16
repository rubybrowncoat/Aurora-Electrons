// Danger and control preferences on the routes Transport and Hauling plan: the Route Finder's entry predicate (route-plan.js `avoidance`, with the danger and control the race knows) applied to the same search (jump-graph.js `searchRoutes`), so a run's distance, fuel, time and annual capacity come from one allowed path. The origin's own system is always left freely; every other system a run enters, the destination's too, is tested. Evidence: docs/plans/backlog/evidence/AE-084-01.md.

import { columnsOf } from './mine-bootstrap-data'
import { routeLegs, routeResults, searchRoutes } from './jump-graph'
import { avoidance } from './route-plan'
import { ofRule, registerRule, unavailable } from './provenance'

// The preferences, as the Route Finder words them. `default` is the Route Finder's; a page that plans runs keeps them off until they are chosen, so its baseline route is the one it always gave.
export const AVOID_OPTIONS = [
  { key: 'avoidDanger', label: 'Avoid danger', hint: 'Skips systems whose danger rating the race\'s ships there don\'t outweigh in protection value.', default: true },
  { key: 'avoidAlien', label: 'Avoid alien systems', hint: 'Skips systems controlled by an alien race without a trade treaty.', default: false },
  { key: 'skipNoAutoRoute', label: 'Skip "no auto-route" systems', hint: 'Skips the systems flagged to keep auto-routes out.', default: false },
]

const LABELS = Object.fromEntries(AVOID_OPTIONS.map((option) => [option.key, option.label]))

const capitalised = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

// The persisted-view fields of a page's avoid preferences, kept per race under `<prefix>AvoidDanger` and the like: all off until chosen.
export const avoidFields = (prefix) => Object.fromEntries(AVOID_OPTIONS.map((option) => [option.key, { key: `${prefix}${capitalised(option.key)}`, default: false, scope: 'race', valid: (value) => typeof value === 'boolean' }]))

const VERSIONS = ['2.7.x']

registerRule({
  id: 'safeRoutes.path',
  versions: VERSIONS,
  units: 'km',
  verification: 'assumed',
  structure: ['FCT_RaceSysSurvey.DangerRating, NoAutoRoute, ControlRaceID', 'FCT_ShipClass.ProtectionValue', 'FCT_AlienRace.TradeTreaty', 'FCT_JumpPoint.WPLink', 'FCT_RaceJumpPointSurvey.Explored'],
  note: 'The distance of the shortest explored route that the avoid settings allow: the Route Finder\'s entry rule (danger rating against the protection value of the race\'s own ships there, an alien holder without a trade treaty, the no auto-route flag) applied to the destination and every system on the way, never to the system the run starts in. The settings are the player\'s choice; danger and control are what the race knows, and the danger rule is not checked against saved routes.',
  assumptions: ['a system whose rating, holder or flag the save does not hold is avoided, since a fleet entering it unchecked could be unsafe', 'a system with no ships of the race has a protection value of 0'],
})

// The systems the race knows with what the avoid preferences read, from a save that has every column: the Route Finder's own read. The danger rating is read against the protection value of the race's own ships there (the game counts every fleet present, which fog of war hides), the controlling race with the race's trade treaty, if any, and the flags the player set. Frozen rows.
export const loadAvoidSystems = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, FCT_RaceSysSurvey.DangerRating, FCT_RaceSysSurvey.NoAutoRoute, FCT_RaceSysSurvey.MilitaryRestrictedSystem, FCT_RaceSysSurvey.ControlRaceID is not null as ControlKnown, case when FCT_RaceSysSurvey.ControlRaceID is null or FCT_RaceSysSurvey.ControlRaceID in (0, ${RaceID}) then null else coalesce((select FCT_AlienRace.AlienRaceName from FCT_AlienRace where FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${RaceID} and FCT_AlienRace.GameID = ${GameID}), 'an unknown race') end as Controller, case when exists (select 1 from FCT_AlienRace where FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${RaceID} and FCT_AlienRace.GameID = ${GameID}) then (select FCT_AlienRace.TradeTreaty from FCT_AlienRace where FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${RaceID} and FCT_AlienRace.GameID = ${GameID}) else 0 end as TradeTreaty, VIR_Protection.Protection, coalesce(VIR_Protection.ProtectionShips, 0) as ProtectionShips, coalesce(VIR_Protection.ProtectionKnown, 0) as ProtectionKnown from FCT_RaceSysSurvey left join (select FCT_Fleet.SystemID, sum(FCT_ShipClass.ProtectionValue) as Protection, count(FCT_Ship.ShipID) as ProtectionShips, count(FCT_ShipClass.ProtectionValue) as ProtectionKnown from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.GameID = ${GameID} group by FCT_Fleet.SystemID) as VIR_Protection on VIR_Protection.SystemID = FCT_RaceSysSurvey.SystemID where FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}`)

  return Object.freeze(rows)
}

const PROTECTION_TABLES = { FCT_Fleet: ['FleetID', 'GameID', 'RaceID', 'SystemID'], FCT_Ship: ['FleetID', 'ShipClassID', 'ShipID'], FCT_ShipClass: ['ProtectionValue', 'ShipClassID'] }
const ALIEN_KEYS = ['AlienRaceID', 'ViewRaceID', 'GameID']

// The same rows for a page that plans runs, read from the columns the save has: a danger rating, flag, owner, trade treaty or protection value the save lacks reads as unknown (null, or an owner not recorded), and what is present keeps working, so a save that lacks one column does not take the other settings down. Frozen rows, shaped as `loadAvoidSystems` gives them.
export const loadPlannedAvoidSystems = async (database, { GameID, RaceID }) => {
  const tables = ['FCT_RaceSysSurvey', 'FCT_AlienRace', ...Object.keys(PROTECTION_TABLES)]
  const columns = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await columnsOf(database, table)])))
  const survey = columns.FCT_RaceSysSurvey
  const alien = columns.FCT_AlienRace
  const surveyColumn = (name) => (survey.has(name) ? `FCT_RaceSysSurvey.${name}` : 'null')
  const hasControl = survey.has('ControlRaceID')
  const alienRow = `FCT_AlienRace.AlienRaceID = FCT_RaceSysSurvey.ControlRaceID and FCT_AlienRace.ViewRaceID = ${RaceID} and FCT_AlienRace.GameID = ${GameID}`
  const alienKnown = ALIEN_KEYS.every((name) => alien.has(name))
  const holderName = alienKnown && alien.has('AlienRaceName') ? `coalesce((select FCT_AlienRace.AlienRaceName from FCT_AlienRace where ${alienRow}), 'an unknown race')` : "'an unknown race'"
  const controller = hasControl ? `case when FCT_RaceSysSurvey.ControlRaceID is null or FCT_RaceSysSurvey.ControlRaceID in (0, ${RaceID}) then null else ${holderName} end` : 'null'
  const contactKnown = hasControl && alienKnown
  const treatyValue = alien.has('TradeTreaty') ? `(select FCT_AlienRace.TradeTreaty from FCT_AlienRace where ${alienRow})` : 'null'
  const treaty = contactKnown ? `case when exists (select 1 from FCT_AlienRace where ${alienRow}) then ${treatyValue} else 0 end` : 'null'
  const hasProtection = Object.entries(PROTECTION_TABLES).every(([table, wanted]) => wanted.every((name) => columns[table].has(name)))
  const protection = hasProtection ? 'VIR_Protection.Protection, coalesce(VIR_Protection.ProtectionShips, 0) as ProtectionShips, coalesce(VIR_Protection.ProtectionKnown, 0) as ProtectionKnown' : 'null as Protection, null as ProtectionShips, null as ProtectionKnown'
  const protectionJoin = hasProtection ? `left join (select FCT_Fleet.SystemID, sum(FCT_ShipClass.ProtectionValue) as Protection, count(FCT_Ship.ShipID) as ProtectionShips, count(FCT_ShipClass.ProtectionValue) as ProtectionKnown from FCT_Fleet inner join FCT_Ship on FCT_Ship.FleetID = FCT_Fleet.FleetID inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Fleet.RaceID = ${RaceID} and FCT_Fleet.GameID = ${GameID} group by FCT_Fleet.SystemID) as VIR_Protection on VIR_Protection.SystemID = FCT_RaceSysSurvey.SystemID` : ''
  const [rows] = await database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name, FCT_RaceSysSurvey.Xcor, FCT_RaceSysSurvey.Ycor, ${surveyColumn('DangerRating')} as DangerRating, ${surveyColumn('NoAutoRoute')} as NoAutoRoute, ${surveyColumn('MilitaryRestrictedSystem')} as MilitaryRestrictedSystem, ${hasControl ? 'FCT_RaceSysSurvey.ControlRaceID is not null' : '0'} as ControlKnown, ${controller} as Controller, ${treaty} as TradeTreaty, ${protection} from FCT_RaceSysSurvey ${protectionJoin} where FCT_RaceSysSurvey.GameID = ${GameID} and FCT_RaceSysSurvey.RaceID = ${RaceID}`)

  return Object.freeze(rows)
}

// What kind of fact bars a system: 'unknown' when the save lacks what the preference reads (the system is avoided on an assumption), 'defined' for a flag the player set, 'observed' for a danger or a holder the race has seen.
const basisOf = (found) => (found.assumed ? 'unknown' : found.option === 'skipNoAutoRoute' ? 'defined' : 'observed')

// The avoid preferences applied to the systems the race knows. `settings`: { avoidDanger, avoidAlien, skipNoAutoRoute }; `systems`: `loadAvoidSystems` rows; `number(n)` writes a rating. Returns `active` (whether any preference is on), `details` ({ [SystemID]: { reason, assumed, option, basis } } of the systems a route may not enter), `names`, `assumed` (how many systems are avoided on an assumption) and `canEnter(SystemID)`. With nothing on, nothing is avoided and the route is the baseline.
export const avoidRules = (systems, settings, number = String) => {
  const options = { avoidDanger: Boolean(settings.avoidDanger), avoidAlien: Boolean(settings.avoidAlien), skipNoAutoRoute: Boolean(settings.skipNoAutoRoute), civilian: false }
  const active = AVOID_OPTIONS.some((option) => options[option.key])
  const details = {}
  const names = {}

  systems.forEach((system) => {
    names[system.SystemID] = system.Name

    if (active) {
      const found = avoidance(system, options, number)

      if (found) {
        details[system.SystemID] = { ...found, basis: basisOf(found) }
      }
    }
  })

  return { active, details, names, assumed: Object.values(details).filter((found) => found.assumed).length, canEnter: (systemId) => !details[systemId] }
}

const nameOf = (avoid, systemId) => avoid.names[systemId] || `System #${systemId}`

const entryOf = (avoid, systemId) => {
  const { reason, assumed, option, basis } = avoid.details[systemId]

  return { SystemID: systemId, name: nameOf(avoid, systemId), reason, assumed, option, basis }
}

// The SystemIDs a route jumps into, in order.
const enteredBy = (route) => [...new Set(routeLegs(route).filter((leg) => leg.kind === 'jump').map((leg) => leg.to.SystemID))]

// The systems a route enters that the preferences bar, in route order.
export const barredOn = (route, avoid) => (route && avoid && avoid.active ? enteredBy(route).filter((systemId) => avoid.details[systemId]).map((systemId) => entryOf(avoid, systemId)) : [])

// What the preferences changed on a route: null when the baseline route enters no barred system, else the baseline's figures, the allowed route's, the difference and the systems that were barred.
export const detourOf = (baseline, route, avoid) => {
  const barred = baseline && route ? barredOn(baseline, avoid) : []

  return barred.length ? { baseline: { jumps: baseline.jumps, km: baseline.km }, jumps: route.jumps, km: route.km, extraJumps: route.jumps - baseline.jumps, extraKm: route.km - baseline.km, barred } : null
}

const OPEN = Object.freeze({ canTransit: () => true, canEnter: () => true })

// The systems the preferences cut the destination off by: from the systems the allowed search reaches, the barred systems one explored jump away from them that the destination can still be reached from without coming back (the ones on the baseline route first, in its order, then the rest by name). Only systems the race knows are named, each with the preference that bars it and what kind of fact it rests on.
export const cutOffOf = ({ jumpPoints, origin, destination, transit = OPEN, avoid, baseline = null }) => {
  const allowed = searchRoutes(jumpPoints, [origin], { order: 'jumps', canTransit: transit.canTransit, canEnter: (systemId) => transit.canEnter(systemId) && avoid.canEnter(systemId) })
  const reached = new Set([origin.SystemID, ...jumpPoints.map((jumpPoint) => jumpPoint.SystemID).filter((systemId) => allowed.toSystem(systemId))])
  const byId = Object.fromEntries(jumpPoints.map((jumpPoint) => [jumpPoint.WarpPointID, jumpPoint]))
  const gates = new Set()

  jumpPoints.forEach((jumpPoint) => {
    const far = byId[jumpPoint.WPLink]

    if (reached.has(jumpPoint.SystemID) && jumpPoint.Explored && far && !reached.has(far.SystemID) && avoid.details[far.SystemID] && transit.canTransit(jumpPoint) && transit.canEnter(far.SystemID)) {
      gates.add(far.SystemID)
    }
  })

  const toward = [...gates].filter((systemId) => searchRoutes(jumpPoints, [{ SystemID: systemId, Xcor: 0, Ycor: 0 }], { order: 'jumps', canTransit: transit.canTransit, canEnter: (id) => transit.canEnter(id) && !reached.has(id) }).toPlace(destination))
  const onRoute = baseline ? enteredBy(baseline) : []
  const rank = (systemId) => (onRoute.includes(systemId) ? onRoute.indexOf(systemId) : onRoute.length)

  return toward.map((systemId) => ({ ...entryOf(avoid, systemId), onRoute: onRoute.includes(systemId) })).sort((a, b) => rank(a.SystemID) - rank(b.SystemID) || a.name.localeCompare(b.name))
}

// One run from `origin` to `destination` (places { SystemID, Xcor, Ycor }) as the preferences allow it. `transit` is the profile's { canTransit, canEnter } (transport.js `transitRule`) or open; `avoid` is `avoidRules`' result or null. Returns `baseline` (the route without the preferences), `route` (with them), `status` ('unreached' when not even the baseline reaches the destination, 'open' when the preferences change nothing, 'detour', or 'blocked'), `detour` and, for a blocked run, `cutOff`.
export const planRun = ({ jumpPoints, origin, destination, order = 'jumps', lagrangePoints = [], transit = OPEN, avoid = null }) => {
  const guarded = Boolean(avoid && avoid.active)
  const search = (limited) => searchRoutes(jumpPoints, [origin], { order, lagrangePoints, canTransit: transit.canTransit, canEnter: limited ? (systemId) => transit.canEnter(systemId) && avoid.canEnter(systemId) : transit.canEnter })
  const baseline = search(false).toPlace(destination)
  const route = guarded ? search(true).toPlace(destination) : baseline
  const detour = guarded ? detourOf(baseline, route, avoid) : null
  const status = !baseline ? 'unreached' : route ? (detour ? 'detour' : 'open') : 'blocked'

  return { baseline, route, status, detour, cutOff: status === 'blocked' ? cutOffOf({ jumpPoints, origin, destination, transit, avoid, baseline }) : [] }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

const BASIS_TEXT = { observed: '', unknown: ', avoided as unknown', defined: ', set by the player' }

// A barred system as text: its name, why, what kind of fact it is and the preference responsible.
export const barredText = (entry) => `${entry.name} (${entry.reason}${BASIS_TEXT[entry.basis]}; ${LABELS[entry.option]})`

const listOf = (entries, limit = 3) => {
  const texts = entries.map(barredText)

  return texts.length > limit ? `${texts.slice(0, limit).join(', ')} and ${texts.length - limit} more` : texts.length > 1 ? `${texts.slice(0, -1).join(', ')} and ${texts[texts.length - 1]}` : texts[0] || ''
}

// What a detour says: the systems avoided and what the way round costs against the baseline. `distance(km)` writes a distance.
export const detourText = (detour, distance) => `Avoids ${listOf(detour.barred)}: ${plural(detour.jumps, 'jump')} and ${distance(detour.km)} one way, against ${plural(detour.baseline.jumps, 'jump')} and ${distance(detour.baseline.km)} without the avoid settings.`

// What a blocked run says: the systems it is cut off by.
export const cutOffText = (cutOff) => (cutOff.length ? `Cut off by ${listOf(cutOff)}.` : 'Cut off by the avoid settings.')

// The route's distance as a result: the Route Finder's own when no preference is on, else the avoid rule's, which names the systems avoided on an assumption as what the save lacks. Unavailable, never 0, for no route.
export const pathResult = (route, avoid) => {
  if (!avoid || !avoid.active) {
    return routeResults(route).km
  } else if (!route) {
    return unavailable({ rule: 'safeRoutes.path', missing: ['a route the avoid settings allow'] })
  }

  const missing = avoid.assumed ? [`the rating, holder or flag of ${plural(avoid.assumed, 'avoided system')}`] : []

  return ofRule({ rule: 'safeRoutes.path', value: route.km, inputs: { present: ['the explored jump points', 'their positions', 'the danger and control the race knows'], missing }, assumptions: avoid.assumed ? [`${plural(avoid.assumed, 'system')} ${avoid.assumed === 1 ? 'is' : 'are'} avoided because the save lacks a rating, holder or flag the settings read`] : [] })
}

// The result for a run whose avoid settings are on but whose danger and control are not read: unavailable, naming that.
export const unreadResult = () => unavailable({ rule: 'safeRoutes.path', missing: ['the danger and control of the known systems (not read yet, or the read failed)'] })
