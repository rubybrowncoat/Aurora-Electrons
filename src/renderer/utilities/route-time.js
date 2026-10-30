// How long a route takes a fleet as elapsed time: flying each leg, the jump shock a fleet waits out before its next transit, the time a transit itself takes (none) and the handling at the ends of a cycle. Shock runs while the fleet flies and while it loads, so it adds waiting only when the next jump point is reached before it has cleared. The rules and what the saves hold: docs/plans/backlog/evidence/AE-086-01.md and AE-086-02.md.

import { roundHalfEven } from './design-rules'
import { ofRule, registerRule, unavailable } from './provenance'

const TIME_VERSIONS = ['2.7.x']
const SECONDS_PER_DAY = 86400

// The delay each ship draws at a standard transit is (120 + a roll of 1 to 60) seconds times the crew multiplier.
export const SHOCK_BASE = 120
export const SHOCK_ROLL = 60
// A squadron transit draws (10 + a roll of 1 to 20) seconds times the same multiplier, against 120 + a roll of 1 to 60 for a standard transit.
export const SQUADRON_BASE = 10
export const SQUADRON_ROLL = 20
const SHOCK_WINDOWS = { standard: [SHOCK_BASE, SHOCK_ROLL], squadron: [SQUADRON_BASE, SQUADRON_ROLL] }
// DIM_MoveAction ids of the transits the walk times: 1 Standard Transit and 37 Squadron Transit. Any other transit order (94 Transit and Divide Fleet, which splits the fleet at the far side, 183 Transit by Sub-Fleet, whose validator the game does not support for a player) is not timed, and an order with no action id is not known to be either.
export const TRANSIT_MODES = { 1: 'standard', 37: 'squadron' }

// The kind of transit an order's `MoveActionID` is: 'standard', 'squadron', or 'unsupported' for every other id and for none.
export const transitModeOf = (actionId) => TRANSIT_MODES[actionId] || 'unsupported'
// The dust cap: the thinnest armour in the fleet times 2500 over the system's dust density.
export const DUST_FACTOR = 2500
// A transit relocates the fleet at no time and no distance of its own.
export const TRANSIT_SECONDS = 0

// The longest subpulse the game runs: its automatic choice for an increment over 5 days, which no increment lengthens. A retried transit waits for the next subpulse, and the saved subpulse length is only the one running when the save was written, so a plan cannot take it as the length of the subpulses ahead.
export const SUBPULSE_MAX = 21600
// The time a wait can run beyond the second the delay clears, at the longest subpulse: the retry waits for the next subpulse (one) and a delay is not run down in the subpulse that set it (another), so a transit that waits can come up to two subpulses late. A delay of 0 holds nothing, so it adds none.
export const RETRY_SLACK = 2 * SUBPULSE_MAX

export const RETRY_ASSUMPTION = 'a blocked transit is retried at the start of each subpulse, so the longest wait runs up to two subpulses past the second the delay clears (12 hours at the longest subpulse the game runs, 6 hours) and the shortest ends the second it clears; the saved subpulse length is not the length of the subpulses ahead'

registerRule({
  id: 'route.jumpShock',
  versions: TIME_VERSIONS,
  units: 's',
  verification: 'estimated',
  structure: ['FCT_Ship.GradePoints, CrewMorale, OverhaulFactor, SensorDelay, MothershipID'],
  note: 'The delay a fleet carries after a transit, as the range of what its ships can draw: every ship draws its own delay, (120 + a roll of 1 to 60) seconds for a standard transit, or (10 + a roll of 1 to 20) seconds for a squadron transit, times 2 less its crew performance (one plus the grade bonus, the square root of its grade points less 10 rounded to a whole percent, over 100, times its morale and its overhaul factor), cut to a whole number, and any ship that is not in a hangar holds the fleet back. The fleet\'s range runs from the largest lower bound to the largest upper bound of its ships. Ships in a hangar are given a delay but do not hold the fleet back. A Lagrange transfer gives none. Other transit orders (by sub-fleet, with a division of the fleet) are not timed.',
  assumptions: ['no commander or rank changes the delay', 'a delay under 0 holds nothing'],
})

registerRule({
  id: 'route.jumpWait',
  versions: TIME_VERSIONS,
  units: 's',
  verification: 'estimated',
  structure: ['route.jumpShock', 'the flight to the next jump point', 'the handling between two jumps'],
  note: 'The time a fleet waits at a jump point before it can transit: the delay it carries less the time since its last transit, which flying and loading count, and 0 when the delay has cleared. The shock is set on every ship at each transit, so a fleet waits only where it reaches a jump point sooner than the delay clears: after a short flight, or a short flight and a short stop. The game retries a blocked transit at each subpulse and the subpulse the game runs is not known ahead, so the wait is given as a range: the shortest for the lowest draws and a retry the second the delay clears, the longest for the highest draws and a retry two of the longest subpulses late. It is never a mean.',
  assumptions: [RETRY_ASSUMPTION],
})

registerRule({
  id: 'route.transitTime',
  versions: TIME_VERSIONS,
  units: 's',
  verification: 'estimated',
  structure: ['the explored jump points'],
  note: 'A transit moves the fleet to the linked jump point with no flight, no distance and no fuel of its own, so it takes 0 s: what a jump costs is the shock the fleet then waits out. Only the approach to the jump point is flown.',
})

registerRule({
  id: 'route.elapsedTime',
  versions: TIME_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['route.jumpWait', 'transport.fleetSpeed', 'the explored jump points'],
  note: 'The time from setting out to arriving: the flights at the fleet\'s one speed, the handling at the ends, the transits (none) and the waits for the jump shock. It is given at the upper case of the wait, with the lower case beside it. A fleet that already carries a delay from a jump just made starts with it as a first wait.',
  assumptions: ['one speed all the way', RETRY_ASSUMPTION],
})

registerRule({
  id: 'route.nebulaCap',
  versions: TIME_VERSIONS,
  units: 'km/s',
  verification: 'assumed',
  structure: ['FCT_System.DustDensity', 'FCT_RaceSysSurvey', 'FCT_ShipClass.ArmourThickness'],
  note: 'The speed a system\'s dust allows a fleet: the thinnest armour in the fleet times 2500 over the system\'s dust density, cut to a whole number, when that is lower than the fleet\'s speed. It is worked out for each flight in the system it is flown in. The game recomputes the maximum speed of a fleet set to it once at the start of each pass over the fleet, capped by the dust of the system the fleet is in, and a dust system entered during the pass lowers it further, so a cap outlasts the jump and the flights after it until the next pass, which begins within one longest subpulse. The lower case of a time takes the maximum back at once; the upper case flies at the lowest cap of the systems the fleet was in during the last longest subpulse, a wait at a jump point in a dust system included. A fleet not set to its maximum speed never gets it back: the cycle flies at the lowest cap of the systems it passes. A system with no dust, or no dust recorded, shows none. The race\'s own survey rows decide which systems are read, and a ship\'s damaged armour is not read, so the class\'s own thickness is taken.',
  assumptions: ['armour as the class has it, with none of it damaged'],
})

const known = (value) => Number.isFinite(value)

// A delay with the retry's allowance on it: a delay of 0 or less holds nothing and stays as it is, a delay that is not known stays null.
const retried = (delay, retry) => (delay > 0 ? delay + retry : delay)

const nameOf = (ship) => ship.ShipName || ship.ClassName || 'A ship'

// A ship's crew performance: one plus the grade bonus (the square root of its grade points less 10, rounded to a whole percent, over 100), times its morale and its overhaul factor; null while one of the three is not in the save. The same figure the ship's runtime page works from.
export const crewPerformance = (ship) => {
  const grade = ship.GradePoints

  if (!known(grade) || grade < 0 || !known(ship.CrewMorale) || !known(ship.OverhaulFactor)) {
    return null
  }

  return (1 + roundHalfEven(Math.sqrt(grade) - 10) / 100) * ship.CrewMorale * ship.OverhaulFactor
}

// The delay one ship can draw at a transit of `mode` ('standard' or 'squadron') as { performance, multiplier, lo, hi } in whole seconds, or null while its crew is not in the save. A multiplier of 0 or less leaves no delay.
export const shipShock = (ship, mode = 'standard') => {
  const performance = crewPerformance(ship)

  if (performance === null) {
    return null
  }

  const multiplier = 2 - performance
  const [base, roll] = SHOCK_WINDOWS[mode]
  const delay = (draw) => Math.max(0, Math.trunc((base + draw) * multiplier))

  return { performance, multiplier, lo: delay(1), hi: delay(roll) }
}

// The delay a fleet can carry after a transit: `participants` as `fleetProfile` gives them ({ ship, name, role }). Every ship that is not in a hangar holds the fleet back, each with its own draw, so the range runs from the largest lower bound to the largest upper bound. Gives { status: 'ok' | 'unknown' | 'none', lo, hi (seconds, null unless 'ok'), ships (each { name, window }), limiting ({ lo, hi }: the ships that set them), missing (the ships whose crew is not in the save) }. A fleet with no ship that holds it back, or with none at all, is 'none': nothing says how long it waits.
export const fleetShock = (participants, mode = 'standard') => {
  const holders = participants.filter((participant) => participant.role !== 'hangared')
  const ships = holders.map((participant) => ({ name: participant.name || nameOf(participant.ship), window: shipShock(participant.ship, mode) }))

  if (!ships.length) {
    return { status: 'none', lo: null, hi: null, ships, limiting: null, missing: ['a ship of the fleet that is not in a hangar'] }
  }

  const missing = ships.filter((entry) => !entry.window).map((entry) => `the grade points, morale or overhaul factor of ${entry.name}`)

  if (missing.length) {
    return { status: 'unknown', lo: null, hi: null, ships, limiting: null, missing }
  }

  const largest = (key) => ships.reduce((best, entry) => (entry.window[key] > best.window[key] ? entry : best))
  const lo = largest('lo')
  const hi = largest('hi')

  return { status: 'ok', lo: lo.window.lo, hi: hi.window.hi, ships, limiting: { lo: lo.name, hi: hi.name }, missing: [] }
}

// The delay a fleet still carries at the start, in seconds: the largest `SensorDelay` of the ships that hold it back (the shock timer the game counts down), 0 when none has any, null while one is not in the save. `participants` as `fleetShock` takes them.
export const startDelayOf = (participants) => {
  const holders = participants.filter((participant) => participant.role !== 'hangared')

  if (!holders.length || holders.some((participant) => !known(participant.ship.SensorDelay))) {
    return null
  }

  return Math.max(0, ...holders.map((participant) => participant.ship.SensorDelay))
}

// What a fleet's ships give a timed route besides its speed and the route: { dust, armour (the thinnest armour of any ship, null while one is not in the save), shock ({ lo, hi } or null while a crew is not in the save), squadronShock (the same at a squadron transit), shockMissing, startDelay (see `startDelayOf`), retry (the seconds the retry of a blocked transit adds to a wait at the longest, `RETRY_SLACK`), holdsSpeed (the fleet is not set to its maximum speed, so a nebula that lowers its speed lowers it for good: the game restores the maximum only for a fleet set to it, and the dust branch only ever lowers the speed), fleetShock (the full `fleetShock`) }. `participants` as `fleetProfile` gives them, `dust` as `loadSystemDust` does.
export const fleetTimingOf = (participants, dust = {}, { holdsSpeed = false } = {}) => {
  const shock = fleetShock(participants)
  const squadron = fleetShock(participants, 'squadron')
  const armours = participants.map((participant) => participant.ship.ArmourThickness)

  return { dust, armour: armours.length && armours.every(known) ? Math.min(...armours) : null, shock: shock.status === 'ok' ? { lo: shock.lo, hi: shock.hi } : null, squadronShock: squadron.status === 'ok' ? { lo: squadron.lo, hi: squadron.hi } : null, shockMissing: shock.missing, startDelay: startDelayOf(participants), retry: RETRY_SLACK, holdsSpeed, fleetShock: shock }
}

// The dust cap of a system for a fleet whose thinnest armour is `armour`: the whole number of km/s the armour allows, or null for a system with no dust (or none recorded), which has no cap. The game applies no floor, so a cap can be 0.
export const dustCap = (armour, density) => (known(density) && density > 0 && known(armour) ? Math.trunc((armour * DUST_FACTOR) / density) : null)

// The speed a fleet flies at inside each system, as the search takes it: `dust` is { [SystemID]: density } for the systems with dust, `armour` the thinnest armour in the fleet (null when not in the save). A system without dust is flown at `speed`; one with dust at the lower of `speed` and the cap, and at no known speed when the armour is not in the save or the cap is 0.
export const speedIn = ({ speed, dust = {}, armour = null }) => (systemId) => {
  const density = dust[systemId]

  if (!(known(density) && density > 0)) {
    return speed
  }

  const cap = dustCap(armour, density)

  return cap === null || !(cap > 0) ? null : Math.min(speed, cap)
}

// The speed a fleet that holds it flies at in every leg of a cycle that repeats: a nebula leaves the fleet at the lower speed for the rest of the run, the cycle comes round to it again, so each leg of the steady cycle is flown at the lowest `speedIn` of the systems the cycle flies in (`systems`), or at no known speed when one of them has none. Gives a function of the system like `speedIn`.
export const heldSpeedIn = ({ speed, dust = {}, armour = null, systems }) => {
  const each = systems.map(speedIn({ speed, dust, armour }))
  const held = each.includes(null) ? null : Math.min(speed, ...each)

  return () => held
}

// The seconds to fly `km` in a system at the speed `timing` gives there: null when no speed is known, 0 for no distance.
export const flightSeconds = (km, systemId, timing) => {
  const speed = timing.speedIn ? timing.speedIn(systemId) : timing.speed

  return known(km) && km === 0 ? 0 : known(km) && speed > 0 ? km / speed : null
}

// What a flight in `systemId` leaves of the speed a fleet set to its maximum speed flies at, for `walkEvents`: { maxSpeed (the fleet's speed), capSpeed (the cap of the system: null where it has none, 0 where `speedIn` gives it no speed, a nebula whose cap the armour in the save cannot weigh or whose cap is 0) }. A cap of 0 is a cap of no known speed: the system caps the fleet all the same, even where it flies no distance there, and the cap the fleet carries out of it leaves every flight after it without a highest case while it holds (`carriedFlight`). A fleet that is not set to its maximum speed, or has no speed, has none: its speed does not come back, so `timing` already gives it the one speed.
const speedStateOf = (systemId, timing) => {
  if (timing.holdsSpeed || !(timing.speed > 0)) {
    return {}
  }

  const cap = timing.speedIn ? timing.speedIn(systemId) : timing.speed

  return { maxSpeed: timing.speed, capSpeed: cap === null ? 0 : cap < timing.speed ? cap : null }
}

// A flight of `km` in `systemId` as an event of a journey: { kind: 'fly', km, seconds (at the speed `timing` gives there, null when no speed is known), maxSpeed, capSpeed (`speedStateOf`), step (when given) }.
export const flyEvent = (km, systemId, timing, step = null) => ({ kind: 'fly', ...(step ? { step } : {}), km, seconds: flightSeconds(km, systemId, timing), ...speedStateOf(systemId, timing) })

// The route's `steps` (`routeLegs`) as the events of a journey, each flight with the km of the step or, when `flights` ([km of each flight in order]) is given, the km that flight is flown now (a body that moved changes the legs that end at it, never the legs between two jump points), and the seconds it takes at `timing` ({ speed, speedIn, holdsSpeed }): `flyEvent` of each flight, { kind: 'jump', step } of each transit.
export const routeEvents = (steps, timing, flights = null) => {
  let flight = 0

  return steps.map((step) => {
    if (step.kind === 'jump') {
      return { kind: 'jump', step }
    }

    const km = flights ? flights[flight] : step.km

    flight += 1

    return flyEvent(km, step.SystemID, timing, step)
  })
}

// A stop where the fleet loads or unloads for `seconds`, among the events of a cycle.
export const handleEvent = (label, seconds) => ({ kind: 'handle', label, seconds })

const add = (total, seconds) => (total === null || seconds === null ? null : total + seconds)

const wait = (base, since) => (base === null || since === null ? null : Math.max(0, base - since))

// The seconds after which the delay of a start is ready for a retry at the longest: `startDelay` (seconds, or { lo, hi, ready } as `carriedDelay` gives it) with the retry's allowance on it once, null while it is not known. A range that already carries its `ready` keeps it, so a leg that begins where another ended does not charge the allowance again.
export const startReady = (startDelay, retry) => (startDelay !== null && typeof startDelay === 'object' ? (startDelay.ready !== undefined ? startDelay.ready : retried(startDelay.hi, retry)) : retried(startDelay, retry))

// The cap state of a fleet set to its maximum speed: the caps of the systems it left during the last `SUBPULSE_MAX` seconds of the walk, [{ speed, budget (the seconds it still holds) }], each kept only while no lower one holds as long, so both rise along the list; [] for none. A speed of 0 is a cap of no known speed (`speedStateOf`), the lowest of all. What is left of it after `seconds` more of the walk.
export const aged = (slow, seconds) => (known(seconds) ? slow.filter((cap) => cap.budget > seconds).map((cap) => ({ speed: cap.speed, budget: cap.budget - seconds })) : [])

// The cap state after a transit out of a system whose cap is `cap` (none where the system has no cap): the pass that let the fleet transit may have set that cap, and the next pass comes up to `SUBPULSE_MAX` seconds later, so it holds that long after the transit, however long the fleet waited there; it covers every cap held that is not lower.
export const leaving = (slow, cap) => (!known(cap) || slow.some((held) => held.speed <= cap && held.budget >= SUBPULSE_MAX) ? slow : [...slow.filter((held) => held.speed < cap), { speed: cap, budget: SUBPULSE_MAX }])

// The seconds a flight takes at the highest case and the cap state it leaves: the flight runs at the lowest cap held while it holds, then at the next, and at the speed of its system (its cap, or the maximum) once none lower is held. The game sets the speed at each pass over the fleet and only a system lowers it between passes, so the speed is never below the lowest cap of the systems the fleet was in during the last `SUBPULSE_MAX` seconds, whatever the phase of the passes; the system the fleet flies in is counted by `leaving` when it transits out. No distance takes no time at any speed, and any distance flown while a cap of no known speed holds has no known time (null), as nothing says how fast the fleet moves before the pass or that it moves at all. A flight with no speed state has its own seconds. The search of the time order prices its flights with it (utilities/jump-graph.js).
export const carriedFlight = (event, slow) => {
  if (event.maxSpeed === undefined || event.seconds === null || !known(event.km)) {
    return { seconds: event.seconds, slow: aged(slow, event.seconds) }
  }

  const inSystem = known(event.capSpeed) ? event.capSpeed : event.maxSpeed
  const held = slow.filter((cap) => cap.speed < inSystem)

  if (event.km === 0) {
    return { seconds: 0, slow: aged(held, 0) }
  }

  if (held.some((cap) => cap.speed === 0)) {
    return { seconds: null, slow: [] }
  }

  let left = event.km
  let seconds = 0

  for (const cap of held) {
    const reach = cap.speed * (cap.budget - seconds)

    if (left <= reach) {
      seconds += left / cap.speed
      left = 0
      break
    }

    left -= reach
    seconds = cap.budget
  }

  seconds += left / inSystem

  return { seconds, slow: aged(held, seconds) }
}

// Walks `events` ({ kind: 'fly' | 'handle', seconds } and { kind: 'jump' }) once, or as a cycle that repeats, and works out what each jump waits for. The delay is `shock` ({ lo, hi } seconds, null while it is not known) after each transit and `startDelay` at the start (seconds, or { lo, hi, ready } when a leg before left a range; null while it is not known); it runs down while the fleet flies and while it stops, and a jump waits for what is left. The wait is worked out at the lowest draw and at the highest, each from its own time since the last jump, so each jump's wait is its own and the totals are sums. The lowest draw is retried the second its delay clears; the highest is ready `retry` seconds (`RETRY_SLACK` of the fleet's timing, 0 for none) after its delay when that holds anything, as the game retries a blocked transit at the start of each subpulse: the ready bound of a start delay that is a range is its own `ready` (what a leg before left of that bound, the retry charged once), of a plain start delay or a shock the delay with `retry` added. In a cycle the first jump follows the last one of the cycle before, and there is no start delay.
// A flight event may carry `maxSpeed` and `capSpeed` (`flyEvent`): the fleet is set to its maximum speed, which the game recomputes at the start of each pass over the fleet, so a cap holds until that pass, which comes within `SUBPULSE_MAX` seconds. The lowest case takes the maximum back at once (`seconds`); the highest flies at the lowest cap of the systems the fleet was in during the last `SUBPULSE_MAX` seconds of the walk (`carriedFlight`, `leaving`; `secondsHi`, which each flight event of the result carries, null while a cap of no known speed holds). `slow` is the cap state ([{ speed, budget }], `aged`) a leg before ended in.
// Gives { events (each with `wait` { lo, hi } or null on a jump, `secondsHi` on a flight), jumps, flight (at the lowest case), flightHi (at the highest: the time the upper case of the total counts), km (the distance of the flights, at no speed), handling, transit, wait: { lo, hi } or null, total: { lo, hi } or null, remaining: { lo, hi, ready } or null (the delay left at the end of a walk that is not a cycle, at each end of the draw and at the end of the retry's allowance: `ready` is what a next leg that starts with it must wait for at the longest), slow (the cap state at the end), unsupported (the jump events that are not timed) }. Every figure that a missing speed, shock or start delay stands in the way of is null, never 0. A jump event may carry its own `shock` (the window its transit draws, null while it is not known; absent for the one of `shock`), and one marked `unsupported` is not timed: the walk has no wait and no total.
export const walkEvents = (events, shock, { startDelay = 0, cyclic = false, retry = 0, slow: slowStart = [] } = {}) => {
  const jumps = events.filter((event) => event.kind === 'jump').length
  const shockAfter = (event) => (event.unsupported ? null : event.shock !== undefined ? event.shock : shock)
  const limit = (key) => (first ? (startDelay !== null && typeof startDelay === 'object' ? startDelay[key] : startDelay) : carried ? carried[key] : null)
  const ready = () => (first ? startReady(startDelay, retry) : carried ? retried(carried.hi, retry) : null)
  let first = !cyclic
  let since = 0
  let sinceHi = 0
  let carried = null
  let slow = slowStart
  let here = null

  const step = (event) => {
    if (event.kind === 'fly') {
      const flown = carriedFlight(event, slow)

      since = add(since, event.seconds)
      sinceHi = add(sinceHi, flown.seconds)
      slow = flown.slow
      here = event.capSpeed

      return { ...event, secondsHi: flown.seconds }
    } else if (event.kind !== 'jump') {
      since = add(since, event.seconds)
      sinceHi = add(sinceHi, event.seconds)
      slow = aged(slow, event.seconds)

      return event
    }

    const lo = wait(limit('lo'), since)
    const hi = wait(ready(), sinceHi)

    since = 0
    sinceHi = 0
    first = false
    carried = shockAfter(event)
    slow = leaving(aged(slow, hi), here)

    return { ...event, wait: event.unsupported || lo === null || hi === null ? null : { lo, hi } }
  }

  // A cycle repeats: the first run only settles the delay, the time since the last jump and the cap its last flight leaves, which the cycle before gives the next one.
  if (cyclic) {
    events.forEach(step)
  }

  const walked = events.map(step)
  const sum = (kind, read = (event) => event.seconds) => walked.filter((event) => event.kind === kind).reduce((total, event) => add(total, read(event)), 0)
  const flight = sum('fly')
  const flightHi = sum('fly', (event) => event.secondsHi)
  const flies = walked.filter((event) => event.kind === 'fly')
  const km = flies.some((event) => !known(event.km)) ? null : flies.reduce((total, event) => total + event.km, 0)
  const handling = sum('handle')
  const waits = walked.filter((event) => event.kind === 'jump')
  const waited = (key) => waits.reduce((total, event) => (total === null || event.wait === null ? null : total + event.wait[key]), 0)
  const waiting = waited('lo') === null || waited('hi') === null ? null : { lo: waited('lo'), hi: waited('hi') }
  const total = flight === null || flightHi === null || handling === null || waiting === null ? null : { lo: flight + handling + waiting.lo, hi: flightHi + handling + waiting.hi }
  const remaining = cyclic || since === null || sinceHi === null || limit('lo') === null ? null : { lo: Math.max(0, limit('lo') - since), hi: Math.max(0, limit('hi') - sinceHi), ready: Math.max(0, ready() - sinceHi) }

  return { events: walked, jumps, flight, flightHi, km, handling, transit: TRANSIT_SECONDS * jumps, wait: waiting, total, remaining, slow, unsupported: walked.filter((event) => event.unsupported) }
}

// The delay a plan's next leg starts with: what this walk leaves of the delay at both ends of the draw and at the end of the retry's allowance, { lo, hi, ready } in seconds; null when it is not known. The cap state it leaves is `walk.slow`.
export const carriedDelay = (walk) => walk.remaining

// Whether the clock of a walk is the one of its flights at `speed` and its stops: no jump waits and no flight slower than `speed` (a nebula cap, a cap held), so the arrival at a body is one instant that `km / speed` and the stops give. A walk with no total (nothing to claim as elapsed time) is. Where it is not, the elapsed time is a range, and a body cannot be moved on to the arrival of a range.
export const flightOnly = (walk, speed) => !walk || !walk.total || (walk.wait.hi === 0 && walk.events.filter((event) => event.kind === 'fly').every((event) => event.km === 0 || (Math.abs(event.seconds * speed - event.km) <= 1e-9 * event.km && event.secondsHi === event.seconds)))

// What the search takes of a timing: the upper case of the shock and the start delay with the retry's seconds on each that holds anything (a start delay that is a range keeps the `ready` it carries), as the search prices a flight before a transit at the larger of its flight and the delay, the speed mode and the cap state the leg starts with (`slow`, as a walk before it left it), which the search carries as `walkEvents` does. `timing` is { speed, speedIn, holdsSpeed, shock ({ lo, hi } or null), startDelay (seconds, or { lo, hi, ready }), retry (seconds, none when absent), slow ([{ speed, budget }], `aged`; none when absent) }.
export const searchTiming = (timing) => ({ speed: timing.speed, speedIn: timing.speedIn || null, holdsSpeed: Boolean(timing.holdsSpeed), shock: timing.shock ? retried(timing.shock.hi, timing.retry || 0) : null, startDelay: known(delayHigh(timing.startDelay)) ? startReady(timing.startDelay, timing.retry || 0) : null, slow: timing.slow || [] })

const delayHigh = (delay) => (delay !== null && typeof delay === 'object' ? delay.hi : delay)

// What a flight lacks where the nebula caps it and the thinnest armour of the fleet is not known, or the cap is 0.
export const NEBULA_GAP = 'a speed above 0 in every system of the route, which the nebula caps by the thinnest armour of the fleet'

const START_DELAY_GAP = 'the delay the fleet starts with'

// What the squadron transit's timing counts: the shock only, the scatter of the arrival being by a drive range the save does not give here.
export const SQUADRON_ASSUMPTION = 'a squadron transit scatters the arrival by up to the range of the jump drive, which is not known, so the flight after it is counted from the jump point'

// What an order that jumps but is neither a standard nor a squadron transit lacks, one entry for each: a timing for that kind of transit.
export const unsupportedGaps = (walk) => walk.unsupported.map((event) => `a timing for the transit order ${event.label || 'of the cycle'}, which is neither a standard transit nor a squadron transit`)

// What a flight lacks where the speed has no value: the nebula's cap, or, for a fleet that is not set to its maximum speed and flies a cycle, the speed the nebula leaves it with.
const HELD_SPEED_GAP = 'a speed above 0 in every system of the cycle, which the nebula caps by the thinnest armour of the fleet and, for a fleet not set to its maximum speed, keeps it at the lowest cap'

export const nebulaGapOf = (timing) => (timing && timing.holdsSpeed ? HELD_SPEED_GAP : NEBULA_GAP)

const UNKNOWN_SPEED = 'a speed above 0 for the fleet'

// What stands in the way of timing a route with the jumps in it, as a list of what is missing, empty when nothing does: the fleet's speed, the delay its ships draw and, unless the walk is a cycle, the delay it starts with.
export const timingGaps = (timing, { cyclic = false } = {}) => [...(timing.speed > 0 ? [] : [UNKNOWN_SPEED]), ...(timing.shock ? [] : timing.shockMissing && timing.shockMissing.length ? timing.shockMissing : ['the crew of the fleet']), ...(cyclic || known(timing.startDelay) ? [] : [START_DELAY_GAP])]

// A wait as { lo, hi } in seconds: a result of `route.jumpWait` at the upper case (the value is the longest wait) or unavailable naming `missing` (`timingGaps`).
export const waitResult = (wait, missing) => (wait ? ofRule({ rule: 'route.jumpWait', value: wait.hi, inputs: { present: ['the fleet\'s crew', 'the flights'] }, units: 's' }) : unavailable({ rule: 'route.jumpWait', missing, units: 's' }))

// A journey's time as a result of `route.elapsedTime` in days at the upper case: `total` is { lo, hi } in seconds or null (unavailable, naming `missing`).
export const elapsedResult = (total, missing) => {
  if (!total) {
    return unavailable({ rule: 'route.elapsedTime', missing, units: 'days' })
  }

  return ofRule({ rule: 'route.elapsedTime', value: total.hi / SECONDS_PER_DAY, inputs: { present: ['the explored jump points', 'the fleet\'s speed', 'the fleet\'s crew'] }, units: 'days' })
}

// The DustDensity of the systems the race holds a survey row for, as { [SystemID]: density } for those with dust (a density above 0). A save with no such column, or with no survey table, has none, and a system the race has no survey row for is never read.
export const loadSystemDust = async (database, { GameID, RaceID }) => {
  const [columns] = await database.query('select name from pragma_table_info(\'FCT_System\')')

  if (!columns.some((column) => column.name === 'DustDensity')) {
    return {}
  }

  const [rows] = await database.query(`select FCT_System.SystemID, FCT_System.DustDensity from FCT_System inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_System.SystemID and FCT_RaceSysSurvey.RaceID = ${RaceID} and FCT_RaceSysSurvey.GameID = ${GameID} where FCT_System.GameID = ${GameID} and FCT_System.DustDensity > 0`)

  return Object.freeze(Object.fromEntries(rows.map((row) => [row.SystemID, row.DustDensity])))
}
