/*
  Checks the elapsed-time figures of the Routes page (src/renderer/pages/routes.vue), the round trip of the Transport page (src/renderer/pages/information.vue) and the cycle of the Hauling page (src/renderer/pages/hauling.vue) as a browser draws them: the real renderer is served by scripts/lib/page-server.js over a constructed copy of a save, opened in Chromium, driven through its controls, and what a player sees is read back through the shared readers of scripts/lib/browser-observe.js, each element found by the `data-*` hook its template carries and never by its wording.

  Run: bun scripts/check-elapsed-time-pages.js [--no-mutations] [--only=<text>|<text>...] [--probe]

  The save is a copy of saves/AuroraDB_271_skoormit_saved.db with the rows this script writes: a second way between two systems (a new pair of explored jump points, so that a way of two jumps and one of three both exist), the jump points of both ways given positions that make the two-jump way fly for hours between its jumps and the three-jump way a minute or two, two fleets with crews that draw different delays (one of them carrying a delay from a jump just made), and a speed typed into the page. The three-jump way is then the shortest and its waits make it the slower: Fewest jumps and Fastest time must choose the two-jump way, which flies about 150 times as far, and Shortest the three-jump one; a lower-case ranking would choose the three-jump way for Fastest time. Two more copies run in processes of their own (`WORLDS`): fleets that hold a speed of their own in a nebula (Hauling), and fleets set to their maximum speed with dust in the start system alone, whose cap the fleet carries past the jump into the clear system after it, so that the flight of the way is a range (Routes).
  What the page should show is worked out here, in a clock and a search of the explored jump points written from the rules of the game's jump shock and nebulae and not from the modules of the app (nothing of src/renderer/utilities is imported): the ways between the two systems are enumerated from SQL rows, each flown at the speed with the delay of the crew drawn after every jump, and the wait at a jump is the delay less the time flown since the last one, with the longest case given two of the longest subpulses (12 hours) past the second the delay clears. A system with dust is flown at the cap the thinnest armour of the fleet allows there, and the longest case keeps the cap of each system left for a longest subpulse past its transit, as the game gives the speed back only at its next pass over the fleet. The page's figures are compared with that, each by the system and stop it belongs to:
  - the route each order (Fewest jumps, Shortest, Fastest time) leaves on screen is the way that order picks in the oracle, by the names of the systems in the leg table;
  - each leg row's Flight, Transit, Wait (the range) and Elapsed (the upper case with the lower case beside it) lie within what the oracle gives, read as an interval of the width the display rounds to (a span reads 45 s, 3 min 20 s, 2 h 5 min, then 12.5 d, 4.1 mo, 2.3 y), and the Travel time tile and the start offset note agree;
  - the note under the Travel time tile gives the flight and the wait of the way, each the range from its lowest case to its highest, and their highest cases add up to the tile, where the cap carried past a jump makes the two cases of the flight differ;
  - the legs reconcile: the flights, transits and waits shown add up to the elapsed time shown;
  - without a fleet (no crew) Fastest time ranks nothing: the notice says so, the route follows the distance, and no wait is given as a figure;
  - the Transport page's round trip for a fleet shows flying, loading, transits, the wait range, the total and the round trips a year, which reconcile with one another.
  - the Travel time of the table of distances, in the time order, is the elapsed time of the way the order picks to each system, found by searching the table for the system;
  - each stop of a round trip (Transport) or of a cycle (Hauling), paired with the oracle's by the name it is drawn under (the colony's or the order's, save data either way), shows the loading strength and the hours that the cargo, the crew, the race's technology and the colony's spaceport give, worked out here from SQL rows and the rules of the game, and the Hauling sentence gives the order delays the fixture sets, read by the role of each figure and not by its wording.
  Every planted fault is served in place of the page's file and the page is read again: each must fail the checks it names by a wrong value of its own, never because the page threw (scripts/lib/fault-credit.js), and a fault under which the page raises an error it does not name is not credited. The baseline of every world and every benign rewrite is judged by `no-errors` beside its own checks, so a page that raises an error no check names never passes. Every fault is paired with a benign rewrite of the same text that must still pass. The standing faults of the in-process checks (scripts/check-fleet-profile.js, scripts/check-route-time.js) cover the modules; this script proves that their results reach the screen.

  Prints `N of N checks passed`; any failed check sets exit code 1. It needs Playwright's Chromium (`bunx playwright install chromium` once). Vite starts with a cold cache on every run, so a run takes minutes. `--only=<text>|<text>` runs the faults and rewrites whose name holds any of the texts, and `--probe` prints what each page shows and stops.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { observe, validate, failureLine, describe, failedObservation, HarnessError, installScreen, readFigure, pairedBy } = require('./lib/browser-observe')
const { caughtAll, notCaught, unobserved } = require('./lib/fault-credit')
const pageLoading = require('./page-loading')

const root = path.resolve(__dirname, '..')
const ROUTES_FILE = 'src/renderer/pages/routes.vue'
const INFORMATION_FILE = 'src/renderer/pages/information.vue'
const HAULING_FILE = 'src/renderer/pages/hauling.vue'
const SAVE = 'saves/AuroraDB_271_skoormit_saved.db'
const IDS = { GameID: 138, RaceID: 785 }
const NAMES = { game: 'EggSample', race: 'EggSample' }
const TIMEOUT = 120000
// The bound of the run of each world of its own (a child process): the run of the fleets that hold a speed (its baseline, one fault and one rewrite) was measured at 28 s alone, the run of the carried cap (its control, baseline, one fault and one rewrite) at 29 s, and the bound is more than five times either.
const WORLD_LIMIT = 150000
const SPEED = 50000
const YEAR = 31536000

// The systems of the constructed pair of ways: the direct way runs start > mid > target (two jumps), the stepping way start > near > far > target (three, through the new pair of jump points between far and target).
const SYSTEMS = { start: 21752, mid: 21756, near: 21759, far: 21766, target: 21762 }
// Two fleets of one ship each at the start of both ways: `crew` has a crew of 400 grade points at 0.9 morale (a delay of 122 to 181 s) and no delay carried; `carrying` has the save's crew (grade 1000, a delay of 94 to 140 s) and 400 s of delay carried from a jump just made.
const FLEETS = { crew: 460480, carrying: 460590 }
const CARRIED = 400
// The longest subpulse the game runs (6 hours), after which its next pass over a fleet has come round; the longest wait carries a retry of two of them.
const SUBPULSE = 21600
const RETRY = 2 * SUBPULSE
// The flights of the constructed ways, in seconds at SPEED: the stepping way is three short flights (the fleet to its first jump point, then inside near and far), the direct way two long ones, long enough to clear the delay of a jump but short of the retry's 12 hours.
const FLIGHTS = { fleetToNear: 60, insideNear: 80, insideFar: 100, fleetToMid: 10000, insideMid: 20000 }
// The colonies of the Transport run: the capital, and a colony in the target system. Their bodies are set where the star is and made to stay there, so that the run is flown from and to the points the clock below uses.
const COLONIES = { origin: 48997, destination: 49085 }
const HAULING_JS = 'src/renderer/utilities/hauling.js'
const TRANSPORT_JS = 'src/renderer/utilities/transport.js'
// The handling oracle's constants, written from the rules of the game and not imported: seconds for one point of cargo at a strength of 1, the largest craft (in hull spaces) that lands with a strength of 1, the component type of a cargo shuttle bay, the commander bonus of Logistics (the fixture removes it, so that no officer scales a strength), and the move actions that load and unload minerals.
const CARGO_SECONDS = 20
const SMALL_CRAFT = 10
const SHUTTLE_BAY = 14
const LOGISTICS_BONUS = 24
const ACTIONS = { load: 223, unload: 63 }
// The order delay (seconds) the fixture gives each fleet's load or unload order.
const DELAYS = { crew: { load: 3600 }, carrying: { unload: 5400 } }
// The worlds of their own, each a copy of the save with these rows on top: both fleets set to their maximum speed or not (`maximum`), the thinnest armour of their ships and the dust of systems of the fixture. A cap is the armour times DUST_FACTOR over the density, cut to a whole number.
const DUST_FACTOR = 2500
// The world of the fleets that hold a speed: set to a speed of their own (not their maximum), the thinnest armour is 20 and three systems of the round trip hold dust, so the fleets fly the whole cycle at the lowest of the caps and of their speed.
const HELD = { maximum: false, armour: 20, dust: { start: 5, near: 10, far: 5 } }
const HELD_SPEED = Math.min(SPEED, ...Object.values(HELD.dust).map((density) => Math.trunc((HELD.armour * DUST_FACTOR) / density)))
// The world of the carried cap: set to their maximum speed, the thinnest armour is 16 and the start system alone holds dust, a cap of 40,000 km/s under the speed. Fewest jumps takes the way through mid, whose clear flight the highest case flies at that cap for a longest subpulse past the transit, then at the speed.
const CAPPED = { maximum: true, armour: 16, dust: { start: 1 } }
const WORLDS = { held: HELD, capped: CAPPED }

const short = (value) => {
  const text = JSON.stringify(value)

  return text === undefined ? 'undefined' : text.length > 300 ? `${text.slice(0, 300)}…` : text
}

// ---------- the constructed save ----------

const openRaw = (file, mode) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(file, mode, (error) => (error ? reject(error) : resolve(raw)))
})

const all = (raw, sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))

const run = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))

// The jump point of system `from` that leads to system `to`, with the point it lands on.
const pointBetween = async (raw, from, to) => {
  const rows = await all(raw, `select a.WarpPointID as exit, b.WarpPointID as arrive from FCT_JumpPoint a inner join FCT_JumpPoint b on b.WarpPointID = a.WPLink where a.GameID = ${IDS.GameID} and a.SystemID = ${from} and b.SystemID = ${to}`)

  if (rows.length !== 1) {
    throw new Error(`The save has ${rows.length} jump points from ${from} to ${to}, not one`)
  }

  return rows[0]
}

// A copy of the save with the constructed ways, the two fleets and their crews, and the rows of `world` (one of WORLDS) when given; the folder holds only that copy.
const constructedSave = async (world = null) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-elapsed-time-'))
  const file = path.join(folder, 'constructed.db')

  fs.copyFileSync(path.join(root, SAVE), file)

  const raw = await openRaw(file, sqlite3.OPEN_READWRITE)

  try {
    const [{ top }] = await all(raw, 'select max(WarpPointID) as top from FCT_JumpPoint')
    const far = top + 1
    const target = top + 2

    for (const [id, system, link] of [[far, SYSTEMS.far, target], [target, SYSTEMS.target, far]]) {
      await run(raw, `insert into FCT_JumpPoint (WarpPointID, GameID, SystemID, Distance, Bearing, WPLink, Xcor, Ycor, JumpGateStrength, JumpGateRaceID) values (${id}, ${IDS.GameID}, ${system}, 0, 0, ${link}, 0, 0, 1000, ${IDS.RaceID})`)
      await run(raw, `insert into FCT_RaceJumpPointSurvey (GameID, RaceID, WarpPointID, Explored, Charted, AlienUnits, Hide, MilitaryRestricted, IgnoreForDistance) values (${IDS.GameID}, ${IDS.RaceID}, ${id}, 1, 1, 0, 0, 0, 0)`)
    }

    const toNear = await pointBetween(raw, SYSTEMS.start, SYSTEMS.near)
    const toFar = await pointBetween(raw, SYSTEMS.near, SYSTEMS.far)
    const toMid = await pointBetween(raw, SYSTEMS.start, SYSTEMS.mid)
    const toTarget = await pointBetween(raw, SYSTEMS.mid, SYSTEMS.target)
    const place = (id, km) => run(raw, `update FCT_JumpPoint set Xcor = ${km}, Ycor = 0, JumpGateStrength = 1000 where WarpPointID = ${id}`)
    const km = (seconds) => seconds * SPEED

    // The exits of the stepping way sit a short flight from where the fleet comes in; the exits of the direct way a long one.
    await place(toNear.exit, km(FLIGHTS.fleetToNear))
    await place(toNear.arrive, 0)
    await place(toFar.exit, km(FLIGHTS.insideNear))
    await place(toFar.arrive, 0)
    await place(far, km(FLIGHTS.insideFar))
    await place(target, 0)
    await place(toMid.exit, km(FLIGHTS.fleetToMid))
    await place(toMid.arrive, 0)
    await place(toTarget.exit, km(FLIGHTS.insideMid))
    await place(toTarget.arrive, 0)

    for (const system of Object.values(SYSTEMS)) {
      await run(raw, `update FCT_System set DustDensity = 0 where SystemID = ${system}`)
      await run(raw, `delete from FCT_LagrangePoint where SystemID = ${system}`)
    }

    // The Transport page lists the military fleets that carry cargo, each at the top speed of its class; the bodies of the two colonies stand at the star.
    await run(raw, `update FCT_Fleet set ShippingLine = 0, Speed = ${SPEED} where FleetID in (${FLEETS.crew}, ${FLEETS.carrying})`)
    await run(raw, `update FCT_ShipClass set MaxSpeed = ${SPEED}, Size = 1000.0 * EnginePower / ${SPEED} where ShipClassID in (select ShipClassID from FCT_Ship where FleetID in (${FLEETS.crew}, ${FLEETS.carrying}))`)
    await run(raw, `update FCT_SystemBody set OrbitalDistance = 0, Xcor = 0, Ycor = 0 where SystemBodyID in (select SystemBodyID from FCT_Population where PopulationID in (${COLONIES.origin}, ${COLONIES.destination}))`)

    await run(raw, `update FCT_Fleet set Xcor = 0, Ycor = 0 where FleetID in (${FLEETS.crew}, ${FLEETS.carrying})`)
    await run(raw, `update FCT_Ship set GradePoints = 400, CrewMorale = 0.9, OverhaulFactor = 1, SensorDelay = 0 where FleetID = ${FLEETS.crew}`)
    await run(raw, `update FCT_Ship set GradePoints = 1000, CrewMorale = 1, OverhaulFactor = 1, SensorDelay = ${CARRIED} where FleetID = ${FLEETS.carrying}`)
    await run(raw, `delete from FCT_CommanderBonuses where BonusID = ${LOGISTICS_BONUS}`)

    // The Hauling page lists the fleets on repeat: both fleets cycle from the capital out by the stepping way to the colony in the far system and back, loading at the capital and unloading at that colony, the crew fleet with an hour of delay on its load order and the other with an hour and a half on its unload order. No officer bonus of Logistics is left, so that the strength is the race's technology alone.
    const bodies = Object.fromEntries((await all(raw, `select PopulationID as id, SystemBodyID as body from FCT_Population where PopulationID in (${COLONIES.origin}, ${COLONIES.destination})`)).map((row) => [row.id, row.body]))
    const [{ top: orderTop }] = await all(raw, 'select max(MoveOrderID) as top from FCT_MoveOrders')
    const cycle = [
      { action: 223, role: 'load', type: 2, destination: bodies[COLONIES.origin], population: COLONIES.origin, start: SYSTEMS.start, next: 0, link: 0, text: 'Prime: Load All Minerals Until Full' },
      { action: 1, type: 1, destination: toNear.exit, population: 0, start: SYSTEMS.start, next: SYSTEMS.near, link: toNear.arrive, text: 'JP1: Faaborg (S): Standard Transit' },
      { action: 1, type: 1, destination: toFar.exit, population: 0, start: SYSTEMS.near, next: SYSTEMS.far, link: toFar.arrive, text: 'JP2: Feakle (S): Standard Transit' },
      { action: 63, role: 'unload', type: 2, destination: bodies[COLONIES.destination], population: COLONIES.destination, start: SYSTEMS.far, next: 0, link: 0, text: 'Far colony: Unload All Minerals' },
      { action: 1, type: 1, destination: toFar.arrive, population: 0, start: SYSTEMS.far, next: SYSTEMS.near, link: toFar.exit, text: 'JP3: Faaborg (S): Standard Transit' },
      { action: 1, type: 1, destination: toNear.arrive, population: 0, start: SYSTEMS.near, next: SYSTEMS.start, link: toNear.exit, text: 'JP4: Zzzyzzyvaa (S): Standard Transit' },
    ]

    for (const [index, [key, fleet]] of Object.entries(FLEETS).entries()) {
      await run(raw, `delete from FCT_MoveOrders where FleetID = ${fleet}`)
      await run(raw, `update FCT_Fleet set CycleMoves = 1 where FleetID = ${fleet}`)

      for (const [step, order] of cycle.entries()) {
        const delay = (DELAYS[key] || {})[order.role] || 0

        await run(raw, `insert into FCT_MoveOrders (MoveOrderID, GameID, RaceID, FleetID, MoveActionID, MoveOrder, StartSystemID, DestinationType, DestinationID, PopulationID, DestinationItemType, DestinationItemID, MaxItems, OrderDelay, OrbDistance, MinDistance, NewSystemID, NewWarpPointID, Description, Arrived, SurveyPointsRequired, TimeRequired, MessageText, LoadSubUnits, MinQuantity, OrderDelayRemaining) values (${orderTop + 1 + index * cycle.length + step}, ${IDS.GameID}, ${IDS.RaceID}, ${fleet}, ${order.action}, ${step + 1}, ${order.start}, ${order.type}, ${order.destination}, ${order.population}, 0, 0, 0, ${delay}, 0, 0, ${order.next}, ${order.link}, '${order.text}', 0, 0, 0, '', 0, 0, 0)`)
      }
    }

    if (world) {
      const fleets = `${FLEETS.crew}, ${FLEETS.carrying}`

      await run(raw, `update FCT_Fleet set UseMaximumSpeed = ${world.maximum ? 1 : 0} where FleetID in (${fleets})`)
      await run(raw, `update FCT_ShipClass set ArmourThickness = ${world.armour} where ShipClassID in (select ShipClassID from FCT_Ship where FleetID in (${fleets}))`)

      for (const [system, density] of Object.entries(world.dust)) {
        await run(raw, `update FCT_System set DustDensity = ${density} where SystemID = ${SYSTEMS[system]}`)
      }
    }
  } finally {
    await new Promise((resolve) => raw.close(resolve))
  }

  return { folder, file }
}

// ---------- the oracle: what the save says, and a clock written here ----------

const roundHalfEven = (value) => {
  const floor = Math.floor(value)
  const rest = value - floor

  return rest < 0.5 ? floor : rest > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1
}

// The delay a crew draws after a transit: (120 + a roll of 1 to 60) seconds times 2 less the crew's performance, cut to a whole number.
const crewDelay = (ship) => {
  const performance = (1 + roundHalfEven(Math.sqrt(ship.GradePoints) - 10) / 100) * ship.CrewMorale * ship.OverhaulFactor
  const draw = (roll) => Math.max(0, Math.trunc((120 + roll) * (2 - performance)))

  return { lo: draw(1), hi: draw(60) }
}

const retried = (delay) => (delay > 0 ? delay + RETRY : delay)

const metres = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

// Everything the oracle reads: the explored jump points of the race, the names of its systems, the dust of the systems of the fixture, the fleets with their ship and position.
const truthOf = async (file) => {
  const raw = await openRaw(file, sqlite3.OPEN_READONLY)

  try {
    const points = await all(raw, `select p.WarpPointID as id, p.SystemID as system, p.WPLink as link, p.Xcor as x, p.Ycor as y from FCT_JumpPoint p inner join FCT_RaceJumpPointSurvey s on s.WarpPointID = p.WarpPointID and s.RaceID = ${IDS.RaceID} and s.GameID = p.GameID where p.GameID = ${IDS.GameID} and s.Explored = 1 and s.Charted = 1`)
    const names = Object.fromEntries((await all(raw, `select SystemID as id, Name as name from FCT_RaceSysSurvey where GameID = ${IDS.GameID} and RaceID = ${IDS.RaceID}`)).map((row) => [row.id, row.name]))
    const [{ technology }] = await all(raw, `select CargoShuttleLoadModifier as technology from FCT_Race where GameID = ${IDS.GameID} and RaceID = ${IDS.RaceID}`)
    const dust = Object.fromEntries((await all(raw, `select SystemID as id, DustDensity as density from FCT_System where SystemID in (${Object.values(SYSTEMS).join(', ')})`)).map((row) => [row.id, row.density]))
    const colonies = Object.fromEntries((await all(raw, `select p.PopulationID as id, p.PopName as name, p.SystemID as system, b.Xcor as x, b.Ycor as y, coalesce((select sum(d.CargoShuttleValue * i.Amount) from FCT_PopulationInstallations i inner join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = i.PlanetaryInstallationID where i.PopID = p.PopulationID and i.GameID = p.GameID), 0) as service from FCT_Population p inner join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID where p.GameID = ${IDS.GameID} and p.PopulationID in (${COLONIES.origin}, ${COLONIES.destination})`)).map((row) => [row.id, row]))
    const fleets = {}

    for (const [key, id] of Object.entries(FLEETS)) {
      const [fleet] = await all(raw, `select FleetID as id, FleetName as name, SystemID as system, Xcor as x, Ycor as y from FCT_Fleet where FleetID = ${id}`)
      const ships = await all(raw, `select s.ShipID, s.ShipClassID, s.CurrentCrew, s.GradePoints, s.CrewMorale, s.OverhaulFactor, s.SensorDelay, c.CargoCapacity, c.ColonistCapacity, c.Crew as ClassCrew, c.Size, c.ArmourThickness from FCT_Ship s inner join FCT_ShipClass c on c.ShipClassID = s.ShipClassID where s.FleetID = ${id}`)
      const orders = await all(raw, `select MoveActionID, OrderDelay, Description from FCT_MoveOrders where FleetID = ${id} order by MoveOrder`)

      for (const ship of ships) {
        // The undamaged cargo shuttle bays: each class line's components less the ship's damaged ones, each at the strength of its design.
        const [{ bays }] = await all(raw, `select coalesce(sum(max(0, cc.NumComponent - coalesce((select dc.Number from FCT_DamagedComponent dc where dc.ShipID = ${ship.ShipID} and dc.GameID = ${IDS.GameID} and dc.ComponentID = cc.ComponentID), 0)) * sd.ComponentValue), 0) as bays from FCT_ClassComponent cc inner join FCT_ShipDesignComponents sd on sd.SDComponentID = cc.ComponentID where cc.ClassID = ${ship.ShipClassID} and sd.ComponentTypeID = ${SHUTTLE_BAY}`)

        ship.bays = bays
      }

      fleets[key] = { ...fleet, ships, orders }
    }

    const byId = new Map(points.map((point) => [point.id, point]))
    const hops = points.filter((point) => byId.has(point.link)).map((point) => ({ from: point.system, to: byId.get(point.link).system, exit: point, arrive: byId.get(point.link) }))

    return { names, fleets, hops, colonies, technology, dust }
  } finally {
    await new Promise((resolve) => raw.close(resolve))
  }
}

// Every way without a repeated system from `start` to `target` of at most `most` jumps, each as its list of hops.
const waysBetween = (truth, start, target, most = 5) => {
  const found = []
  const walk = (hops, seen) => {
    const here = hops.length ? hops[hops.length - 1].to : start

    if (here === target) {
      found.push(hops)

      return
    }

    if (hops.length >= most) {
      return
    }

    for (const hop of truth.hops.filter((candidate) => candidate.from === here && !seen.has(candidate.to))) {
      walk([...hops, hop], new Set([...seen, hop.to]))
    }
  }

  walk([], new Set([start]))

  return found
}

// The km/s the dust of each system of the fixture allows `fleet`: its thinnest armour times DUST_FACTOR over the density, cut to a whole number ({ [system]: cap }, none for a clear system).
const capsOf = (truth, fleet) => {
  const armour = Math.min(...fleet.ships.map((ship) => ship.ArmourThickness))

  return Object.fromEntries(Object.entries(truth.dust).filter(([, density]) => density > 0).map(([system, density]) => [system, Math.trunc((armour * DUST_FACTOR) / density)]))
}

// A way flown by a fleet set to its maximum `speed`: for each leg of flight in a system the seconds flown at the lowest case and at the highest, the wait at its jump point as { lo, hi }, and the clock after it. The delay is the one the fleet carries until its first jump and the crew's draw after each. A system with a cap in `caps` (`capsOf`) is flown at no more than it; the lowest case has the speed back at once after the transit out of it, and the highest flies at no more than that cap until a longest subpulse after the transit, on its own clock, as the game's next pass over the fleet can come that late.
const flown = (fleet, hops, speed, caps = {}) => {
  const crew = fleet.ships.map(crewDelay).reduce((best, draw) => ({ lo: Math.max(best.lo, draw.lo), hi: Math.max(best.hi, draw.hi) }), { lo: 0, hi: 0 })
  const carried = Math.max(0, ...fleet.ships.map((ship) => ship.SensorDelay))
  const left = []
  let at = { x: fleet.x, y: fleet.y }
  let lo = 0
  let hi = 0
  let km = 0

  const legs = hops.map((hop, index) => {
    const distance = metres(at, hop.exit)
    const own = hop.from in caps ? Math.min(speed, caps[hop.from]) : speed
    const seconds = distance / own
    let rest = distance
    let clock = hi

    // The highest case: at the lowest cap of a system left that still holds and is under the speed here, until the next of them runs out.
    while (rest > 0) {
      const slower = left.filter((cap) => cap.until > clock && cap.speed < own)
      const now = Math.min(own, ...slower.map((cap) => cap.speed))
      const until = Math.min(...slower.map((cap) => cap.until))
      const reach = now * (until - clock)

      if (rest <= reach) {
        clock += rest / now
        rest = 0
      } else {
        rest -= reach
        clock = until
      }
    }

    const high = clock - hi
    const limit = index === 0 ? { lo: carried, hi: carried } : crew
    const wait = { lo: Math.max(0, limit.lo - seconds), hi: Math.max(0, retried(limit.hi) - high) }

    km += distance
    lo += seconds + wait.lo
    hi += high + wait.hi
    at = hop.arrive

    if (hop.from in caps) {
      left.push({ speed: caps[hop.from], until: hi + SUBPULSE })
    }

    return { system: hop.from, to: hop.to, km: distance, flight: seconds, flightHi: high, wait, elapsed: { lo, hi } }
  })

  return { legs, hops, km, jumps: hops.length, elapsed: { lo, hi }, systems: [fleet.system, ...hops.map((hop) => hop.to)], crew, carried }
}

// The way each order picks among those between the two systems: the fewest jumps (the shorter way breaking a tie), the fewest kilometres, the least elapsed time at the upper case.
const pickOf = (ways, order) => {
  const by = { jumps: (way) => [way.jumps, way.km], km: (way) => [way.km, 0], time: (way) => [way.elapsed.hi, way.elapsed.lo] }[order]

  return ways.slice().sort((a, b) => by(a)[0] - by(b)[0] || by(a)[1] - by(b)[1])[0]
}

// The stops of a fleet's cycle as the game's rules give them, worked out from the rows read and not from the app: at each colony the slowest ship takes its cargo capacity times 20 s over its loading strength (its own term, 1 for a craft of 10 hull spaces or less and else its undamaged bays, times the race's technology, plus the technology once more at a colony with a spaceport or station) and the share of its crew aboard. The delays are those of the load and unload orders; a delay on any other order, or a berth for colonists, is a fixture this oracle does not cover.
const handlingOf = (truth, key) => {
  const fleet = truth.fleets[key]
  const other = fleet.orders.filter((order) => order.OrderDelay > 0 && !Object.values(ACTIONS).includes(order.MoveActionID))

  if (other.length || fleet.ships.some((ship) => ship.ColonistCapacity !== 0)) {
    throw new HarnessError(`the handling oracle covers cargo loads and unloads only: ${short({ other, berths: fleet.ships.map((ship) => ship.ColonistCapacity) })}`)
  }

  const stopAt = (colony, action) => {
    const times = fleet.ships.map((ship) => {
      const strength = (ship.Size <= SMALL_CRAFT ? 1 : ship.bays) * truth.technology + (colony.service >= 1 ? truth.technology : 0)
      const crew = Math.min(1, ship.CurrentCrew / ship.ClassCrew)

      return { strength, seconds: (ship.CargoCapacity * CARGO_SECONDS) / (strength * crew) }
    })
    const slowest = times.reduce((worst, one) => (one.seconds > worst.seconds ? one : worst))
    const order = fleet.orders.find((one) => one.MoveActionID === action)

    return { place: colony.name, description: order.Description, seconds: slowest.seconds, strength: slowest.strength }
  }
  const delayOf = (action) => fleet.orders.filter((order) => order.MoveActionID === action).reduce((total, order) => total + order.OrderDelay, 0)

  return { stops: [stopAt(truth.colonies[COLONIES.origin], ACTIONS.load), stopAt(truth.colonies[COLONIES.destination], ACTIONS.unload)], delay: { load: delayOf(ACTIONS.load), unload: delayOf(ACTIONS.unload) } }
}

// ---------- reading a displayed figure ----------

const DAY = 86400

// The grouping of the figures the pages write with formatters that group no digits: the spans and durations (`span` and `duration` of src/renderer/mixins/count-format.js), Hauling's fixed figures, distances and tonnes, and the strengths and hours of a stop (src/renderer/components/page/HandlingBreakdown.vue). A count (`count` of the same mixin) is written in the grouping of the setting, which each screen reads.
const PLAIN = 'None'

// A figure read whole (scripts/lib/browser-observe.js `readFigure`) in `grouping`, the name of the setting it is written in: text that is no figure stops the read, and the check that read it tells it as a wrong value.
const figure = (text, grouping = PLAIN) => {
  const value = readFigure(String(text), grouping)

  if (value === null) {
    throw new Error(`Not a figure in the grouping ${grouping}: ${text}`)
  }

  return value
}

// The words a duration's unit is written in, by the unit they name.
const UNITS = { d: 'day', day: 'day', days: 'day', h: 'hour', hr: 'hour', hrs: 'hour', hour: 'hour', hours: 'hour' }

// The seconds a displayed span can stand for, as [low, high]: a span of seconds, minutes or hours is cut to the second or minute it names, and one of days, months (30.4 days) or years (365 days) to the tenth it is rounded to. `rounded` reads a duration of the page (a figure in whole hours when it is under a day) in place of a span.
const spanInterval = (text, rounded = false) => {
  const plain = String(text).trim()
  const unit = /^(.+?) (s|min|h|d|mo|y)(?: (.+?) (s|min))?$/.exec(plain)

  if (!unit) {
    throw new Error(`A span reads in s, min, h, d, mo or y: ${plain}`)
  }

  const [, first, firstUnit, second, secondUnit] = unit
  const a = figure(first)
  const b = second === undefined ? 0 : figure(second)

  switch (firstUnit) {
    case 's':
      return [a - 0.5, a + 0.5]
    case 'min':
      return secondUnit === 's' || second === undefined ? [a * 60 + b - 0.5, a * 60 + b + 0.5] : fail(plain)
    case 'h':
      return rounded && second === undefined ? [a === 1 ? 0 : (a - 0.5) * 3600, (a + 0.5) * 3600] : secondUnit === 'min' || second === undefined ? [a * 3600 + b * 60 - 0.5, a * 3600 + b * 60 + 59.5] : fail(plain)
    case 'd':
      return [(a - 0.05) * DAY, (a + 0.05) * DAY]
    case 'mo':
      return [(a - 0.05) * 30.4 * DAY, (a + 0.05) * 30.4 * DAY]
    default:
      return [(a - 0.05) * 365 * DAY, (a + 0.05) * 365 * DAY]
  }
}

const fail = (plain) => {
  throw new Error(`A span with a second part reads in min and s, or h and min: ${plain}`)
}

const within = (interval, seconds) => seconds >= interval[0] - 1e-6 && seconds <= interval[1] + 1e-6

// What a wait cell shows: missing when no element draws it, a dash for no jump, one span or `lo to hi` as a pair of intervals, words when it gives no figure at all (the wait of a fleet whose crew is not known), and malformed when it is none of these: a cell with a digit in it that reads as no span (a bare `0`) states a figure, so it is never taken for the words.
const waitCell = (text) => {
  if (text === undefined) {
    return { kind: 'missing' }
  }

  if (text === '—') {
    return { kind: 'none' }
  }

  const parts = String(text).split(' to ')

  try {
    if (parts.length <= 2) {
      return { kind: 'range', lo: spanInterval(parts[0]), hi: spanInterval(parts[parts.length - 1]) }
    }
  } catch (error) {}

  return String(text).trim() && !/\d/.test(text) ? { kind: 'words', text } : { kind: 'malformed', text }
}

// An elapsed cell: the upper case, the text of its element, and the lower case, the text of the element that holds the span beside it when the two differ (undefined when there is none); the words around that span are not read.
const elapsedCell = (hi, lo) => {
  if (hi === '—') {
    return { kind: 'none' }
  }

  const upper = spanInterval(hi)

  return { kind: 'range', hi: upper, lo: lo === undefined ? upper : spanInterval(lo) }
}

// The text of the one element on screen that draws `role` among `entries` (as `hooked` gives them): undefined when none does, and words that are no figure when more than one does, so that a role drawn twice is never read as one of its copies.
const only = (entries, role) => {
  const drawn = entries.filter((entry) => entry.on && entry.role === role)

  return drawn.length === 1 ? drawn[0].text : drawn.length === 0 ? undefined : `(drawn ${drawn.length} times: ${drawn.map((entry) => entry.text).join(' | ')})`
}

// The figures of the sentence under an opened row by the role the page gives each (`data-part`), with the unit each is read in: the word that ends the figure's own text, or else the first word after it in the sentence as the sentence draws it. Each figure is found in the sentence's text after the one before it, in the order of the document, so the words around the figures can be any.
const partsOf = (sentence) => {
  const parts = {}
  let cursor = 0

  for (const entry of sentence.parts.filter((one) => one.on)) {
    const at = sentence.text.indexOf(entry.text, cursor)

    if (at === -1 || entry.role in parts) {
      throw new Error(`The figure ${entry.role} "${entry.text}" is not drawn once in the sentence: ${sentence.text}`)
    }

    cursor = at + entry.text.length

    const own = /^(.*\d) ([A-Za-z]+)$/.exec(entry.text)
    const next = /^[\s,.;:]*([A-Za-z]+)/.exec(sentence.text.slice(cursor))

    parts[entry.role] = { text: own ? own[1] : entry.text, unit: own ? own[2] : next ? next[1] : '' }
  }

  return parts
}

// ---------- what a browser draws ----------

// What the page on screen shows; runs in the page, through the shared readers of scripts/lib/browser-observe.js (`installScreen`: `visible`, `visibleText`, `hooked`). The hooks the templates carry find the elements and name the role of each figure (`data-leg`, `data-tile`, `data-tile-note`, `data-part`, `data-distance`, `data-cycle-row`, `data-cycle-value`, `data-stop`, `data-strength`, `data-time`, `data-haul`), never a heading, a label or other wording, and only what a player sees counts: an element is read when it is `visible` or draws text of its own, and what it says is its `visibleText`. The row a table opened is told by the name of the fleet the row above it draws (`data-fleet-name`). `spec` names the panels.
const readScreen = (spec) => {
  const { visible, visibleText, hooked } = window.__screen
  const shown = (root, selector) => (root ? [...root.querySelectorAll(selector)].filter((element) => visible(element)) : [])
  const nameIn = (row) => {
    const element = row && row.querySelector('[data-fleet-name]')

    return element ? visibleText(element) : null
  }
  const legs = document.querySelector(spec.legs)
  const distances = document.querySelector(spec.distance)
  const fleets = document.querySelector(spec.fleets)
  const opened = shown(fleets, '.v-data-table__expanded__content')

  return {
    grouping: window.$app.$store.getters.config.get('selectedSeparator', 'Tick'),
    tiles: hooked(document.body, 'data-tile'),
    tileNotes: [...document.querySelectorAll('[data-tile-note]')].map((note) => ({ tile: note.getAttribute('data-tile-note'), parts: hooked(note, 'data-part') })),
    legs: shown(legs, 'tbody > tr').map((row) => hooked(row, 'data-leg')).filter((entries) => entries.length),
    offset: shown(document, spec.offset).map((note) => hooked(note, 'data-part')),
    notice: shown(document, spec.notice).map((element) => visibleText(element)),
    distances: shown(distances, 'tbody > tr').map((row) => hooked(row, 'data-distance')).filter((entries) => entries.length),
    opened: opened.map((content) => nameIn(content.previousElementSibling)),
    cycles: opened.flatMap((content) => hooked(content, 'data-cycle-row')),
    cycleValues: opened.flatMap((content) => hooked(content, 'data-cycle-value')),
    stops: opened.flatMap((content) => shown(content, '[data-stop]').map((row) => ({ key: row.getAttribute('data-stop'), text: visibleText(row), strength: hooked(row, 'data-strength'), time: hooked(row, 'data-time') }))),
    sentences: opened.flatMap((content) => shown(content, spec.parts).map((sentence) => ({ text: visibleText(sentence), parts: hooked(sentence, 'data-part') }))),
    haul: shown(fleets, 'tbody > tr').map((row) => ({ name: nameIn(row), entries: hooked(row, 'data-haul') })).filter((row) => row.entries.length),
  }
}

const SPEC = { legs: '[data-leg-detail]', offset: '[data-start-offset]', notice: '[data-time-notice]', fleets: '[data-fleet-panel]', parts: '[data-cycle-parts]', distance: '[data-distance-panel]' }
const HAULING_SPEC = { ...SPEC, fleets: '[data-hauling-routes]' }

// A bounded wait whose end is read as it is: only its deadline is let pass, so that the check tells what the page then shows, and any other failure of the wait stops the observation.
const deadlineOnly = (error) => {
  if (error.name !== 'TimeoutError') {
    throw error
  }
}

// The page that `observe` opens, made ready: the readers of the screen put in it and the race picked on the Empires page. Gives the function that waits for the page to settle: no database call in flight for a moment and no read of the page under way, within TIMEOUT.
const prepare = async (page, url) => {
  const state = { inFlight: 0, last: Date.now() }
  const isDatabaseCall = (request) => request.url().includes('/__aurora-db/') && !new URL(request.url()).pathname.endsWith('/stat')

  page.on('request', (request) => {
    if (isDatabaseCall(request)) {
      state.inFlight++
      state.last = Date.now()
    }
  })
  page.on('requestfinished', (request) => {
    if (isDatabaseCall(request)) {
      state.inFlight--
      state.last = Date.now()
    }
  })

  const settle = async () => {
    const started = Date.now()

    while (state.inFlight > 0 || Date.now() - state.last < 1500 || await page.evaluate(pageLoading)) {
      if (Date.now() - started > TIMEOUT) {
        throw new Error(`the page did not settle (${state.inFlight} database calls in flight, ${Date.now() - state.last} ms since the last)`)
      }

      await page.waitForTimeout(250)
    }
  }

  await installScreen(page)
  await page.goto(url, { timeout: TIMEOUT })

  const picker = page.locator('.empire-list').first()

  await picker.locator('.empire-list__game').filter({ hasText: `${NAMES.game} ·` }).first().click({ timeout: TIMEOUT })

  if (!(await page.evaluate(() => Boolean(window.$app.$store.getters.RaceID)))) {
    await picker.getByText(NAMES.race, { exact: true }).last().click()
  }

  await page.waitForFunction(() => Boolean(window.$app.$store.getters.RaceID) && Boolean(window.$app.$store.getters.racePrefix), null, { timeout: TIMEOUT })
  await settle()

  return { settle }
}

// Opens a page at `target` and waits for the router to commit it.
const open = async (page, target, settle) => {
  await page.evaluate((to) => window.$app.$router.push(to, () => {}, () => {}), target)
  await page.waitForFunction(pageLoading.arrived, target, { timeout: TIMEOUT })
  await settle()
}

// Chooses an order of the Routes page by the hook of its button (the order's value) and waits until the toggle shows it pressed.
const chooseOrder = async (page, order, settle) => {
  const button = `[data-order="${order}"]`

  await page.locator(button).click({ timeout: TIMEOUT })
  await page.waitForFunction((css) => { const element = document.querySelector(css); return Boolean(element) && element.classList.contains('v-btn--active') }, button, { timeout: TIMEOUT })
  await settle()
}

// Types the speed and waits until the field holds it and the leg table has the flight column a speed brings.
const typeSpeed = async (page, speed, settle) => {
  const field = page.locator('input[data-speed]')

  await field.fill(String(speed), { timeout: TIMEOUT })
  await page.waitForFunction((typed) => document.querySelector('input[data-speed]').value === typed && document.querySelector('[data-leg-detail] [data-leg="flight"]') !== null, String(speed), { timeout: TIMEOUT })
  await settle()
}

const read = (page, spec = SPEC) => page.evaluate(readScreen, spec)

// Searches the table of distances for each system of the two ways in turn, as a player does, and reads the table after each. Each search is a step of the observation.
const searchDistances = async (page, names, step) => {
  const field = page.locator(`${SPEC.distance} .search-field input`)
  const searched = {}

  for (const system of ['mid', 'near', 'far', 'target']) {
    const name = names[SYSTEMS[system]]

    step(`the table of distances is searched for ${name}`)
    await field.fill(name, { timeout: TIMEOUT })
    // The table lists the system's row, drawn or not: a fault that hides the table leaves it filtered all the same, and the read after the wait tells what is not on screen. Bounded: a page whose table lists no such system is read as it is, so that the check tells what is missing.
    await page.waitForFunction(({ panel, wanted }) => [...document.querySelectorAll(`${panel} [data-distance="name"]`)].some((element) => element.textContent.replace(/[ \t\n\r]+/g, ' ').trim() === wanted), { panel: SPEC.distance, wanted: name }, { timeout: 20000 }).catch(deadlineOnly)

    searched[system] = (await read(page)).distances
  }

  await field.fill('', { timeout: TIMEOUT })

  return searched
}

// Everything a player does on the Routes page and what the screen shows after each step: { [name]: screen }; the runs in the time order also carry the table of distances as searched for each system.
const routesRun = async (page, settle, systemNames, step) => {
  const seen = {}
  const toTarget = (from) => `/routes?from=${from}&to=system:${SYSTEMS.target}`

  for (const [name, fleet] of Object.entries(FLEETS)) {
    await open(page, toTarget(`fleet:${fleet}`), settle)
    await typeSpeed(page, SPEED, settle)

    for (const order of ['jumps', 'km', 'time']) {
      await chooseOrder(page, order, settle)
      seen[`${name}-${order}`] = await read(page)

      if (order === 'time') {
        seen[`${name}-${order}`].searched = await searchDistances(page, systemNames, step)
      }
    }
  }

  await open(page, toTarget(`system:${SYSTEMS.start}`), settle)
  await typeSpeed(page, SPEED, settle)
  await chooseOrder(page, 'time', settle)
  seen['none-time'] = await read(page)

  return seen
}

// What a player does on the Routes page in the world of the carried cap: the crew's fleet to the target system at the speed, by Fewest jumps.
const cappedRun = async (page, settle) => {
  await open(page, `/routes?from=fleet:${FLEETS.crew}&to=system:${SYSTEMS.target}`, settle)
  await typeSpeed(page, SPEED, settle)
  await chooseOrder(page, 'jumps', settle)

  return { 'crew-jumps': await read(page) }
}

// Opens the row of each fleet (named as the save names it) of a table and reads the screen once the table holds that row open and Vue has drawn it: { [fleet]: screen }. Each row is a step of the observation.
const openEach = async (page, settle, names, spec, step) => {
  const seen = {}

  for (const [name, label] of Object.entries(names)) {
    const row = page.locator(`${spec.fleets} tbody > tr`).filter({ has: page.locator('[data-fleet-name]', { hasText: label }) })

    step(`the row of ${label} is opened`)
    await row.first().click({ timeout: TIMEOUT })
    // The expansion state of the panel's table holds the fleet, drawn or not: a fault that hides the table or gives the opened row a slot nothing consumes leaves the fleet open all the same, and the read after Vue has drawn it tells what is not on screen. Bounded: a click that opens no row is read as it is, so that the checks tell what is missing.
    await page.waitForFunction(({ panel, name }) => [...document.querySelectorAll(`${panel} .v-data-table`)].some((element) => { let vm = element.__vue__; while (vm && vm.$options.name !== 'v-data-table') { vm = vm.$parent } return Boolean(vm) && vm.items.some((item) => item.FleetName === name && vm.isExpanded(item)) }), { panel: spec.fleets, name: label }, { timeout: 20000 }).catch(deadlineOnly)
    await page.evaluate(async () => { await window.$app.$nextTick() })
    await settle()
    seen[name] = await read(page, spec)
  }

  return seen
}

// Everything a player does on the Transport page: the run between two colonies opened, and the row of each fleet opened to show its round trip.
const transportRun = async (page, settle, names, step) => {
  await open(page, `/information?from=colony:${COLONIES.origin}&to=colony:${COLONIES.destination}`, settle)

  return openEach(page, settle, names, SPEC, step)
}

// Everything a player does on the Hauling page: the table of repeating routes read, and the row of each fleet opened to show how its cycle adds up.
const haulingRun = async (page, settle, names, step) => {
  await open(page, '/hauling', settle)

  return openEach(page, settle, names, HAULING_SPEC, step)
}

// ---------- what the oracle expects of each run ----------

const RUNS = ['crew-jumps', 'crew-km', 'crew-time', 'carrying-jumps', 'carrying-km', 'carrying-time', 'none-time']
// The run of the world of the carried cap and the checks of the Routes page it is judged by: those that read a flight as one figure (`flight`, `reconcile`) and the table of distances it does not search are left to the main world.
const CAPPED_RUNS = ['crew-jumps']
const CAPPED_CHECKS = ['route', 'wait', 'elapsed', 'tile']

// The longest delay a crew can draw and the shortest, taken over the ships of a fleet that hold it back (every ship here).
const crewOf = (fleet) => fleet.ships.map(crewDelay).reduce((best, draw) => ({ lo: Math.max(best.lo, draw.lo), hi: Math.max(best.hi, draw.hi) }), { lo: 0, hi: 0 })

// The round trip of a fleet between the two colonies, as events (flights and jumps with the handling at the two ends left to `walkCycle`): out by the way of the fewest jumps, back over the same jump points.
const cycleOf = (truth, fleet, speed) => {
  const origin = truth.colonies[COLONIES.origin]
  const destination = truth.colonies[COLONIES.destination]
  const out = pickOf(waysBetween(truth, origin.system, destination.system).map((hops) => flown({ ...fleet, x: origin.x, y: origin.y }, hops, speed)), 'jumps')
  const events = [{ kind: 'load' }]
  let at = { x: origin.x, y: origin.y }

  for (const hop of out.hops) {
    events.push({ kind: 'fly', seconds: metres(at, hop.exit) / speed }, { kind: 'jump' })
    at = hop.arrive
  }

  events.push({ kind: 'fly', seconds: metres(at, destination) / speed }, { kind: 'unload' })
  at = { x: destination.x, y: destination.y }

  for (const hop of out.hops.slice().reverse()) {
    events.push({ kind: 'fly', seconds: metres(at, hop.arrive) / speed }, { kind: 'jump' })
    at = hop.exit
  }

  events.push({ kind: 'fly', seconds: metres(at, origin) / speed })

  return { events, crew: crewOf(fleet), jumps: out.jumps }
}

// A round trip repeated for ever: the delay after the last jump of a cycle carries into the first jump of the next, so the walk starts with the time flown since that jump. Handling is given by `loading` and `unloading` (seconds). Gives { flight, wait: { lo, hi } }.
const walkCycle = (cycle, loading, unloading) => {
  const seconds = (event) => (event.kind === 'fly' ? event.seconds : event.kind === 'load' ? loading : event.kind === 'unload' ? unloading : 0)
  const last = cycle.events.map((event) => event.kind).lastIndexOf('jump')
  let since = cycle.events.slice(last + 1).reduce((total, event) => total + seconds(event), 0)
  let lo = 0
  let hi = 0

  for (const event of cycle.events) {
    if (event.kind === 'jump') {
      lo += Math.max(0, cycle.crew.lo - since)
      hi += Math.max(0, retried(cycle.crew.hi) - since)
      since = 0
    } else {
      since += seconds(event)
    }
  }

  return { flight: cycle.events.filter((event) => event.kind === 'fly').reduce((total, event) => total + event.seconds, 0), wait: { lo, hi } }
}

// What every run of the Routes page must show: the way each of `runs` picks among those between the two systems, and the clock of each way for each fleet, at the caps the dust of the fixture sets for it. A run with no fleet has no crew and picks by the distance alone. `speed` is the one the cycles of Transport and Hauling are flown at.
const expectationsOf = (truth, { speed = SPEED, runs = RUNS } = {}) => {
  const between = waysBetween(truth, SYSTEMS.start, SYSTEMS.target)
  const keys = Object.keys(FLEETS)
  const caps = Object.fromEntries(keys.map((key) => [key, capsOf(truth, truth.fleets[key])]))
  const ways = Object.fromEntries(keys.map((key) => [key, between.map((hops) => flown(truth.fleets[key], hops, SPEED, caps[key]))]))
  const crewless = between.map((hops) => flown({ ...truth.fleets.crew, ships: [] }, hops, SPEED))
  const picked = Object.fromEntries(runs.map((run) => { const [who, order] = run.split('-'); return [run, who === 'none' ? pickOf(crewless, 'km') : pickOf(ways[who], order)] }))
  const cycles = Object.fromEntries(keys.map((key) => [key, cycleOf(truth, truth.fleets[key], speed)]))

  // A tonne of mineral takes two tonnes of cargo space, so a full hold moves half its capacity in tonnes a trip.
  const cargo = Object.fromEntries(keys.map((key) => [key, truth.fleets[key].ships.reduce((total, ship) => total + ship.CargoCapacity, 0) / 2]))

  const handling = Object.fromEntries(keys.map((key) => [key, handlingOf(truth, key)]))

  // What the table of distances reaches each system by, in the time order: the way of the least elapsed time from the first stop, by fleet.
  const reached = Object.fromEntries(keys.map((key) => [key, Object.fromEntries(['mid', 'near', 'far', 'target'].map((system) => [system, pickOf(waysBetween(truth, SYSTEMS.start, SYSTEMS[system]).map((hops) => flown(truth.fleets[key], hops, SPEED, caps[key])), 'time')]))]))

  return { speed, runs, ways, picked, cycles, cargo, handling, reached, names: truth.names, fleetNames: Object.fromEntries(keys.map((key) => [key, truth.fleets[key].name])), carried: Object.fromEntries(keys.map((key) => [key, Math.max(0, ...truth.fleets[key].ships.map((ship) => ship.SensorDelay))])) }
}

// ---------- the checks of one observation ----------

// A check's answer: true, or the evidence of what was seen. A figure the check cannot read is a wrong value too, and is told as one.
const verdict = (ok, evidence) => (ok ? true : short(evidence))
const readable = (read) => {
  try {
    return read()
  } catch (error) {
    return `unreadable: ${error.message}`
  }
}

// The leg table of a screen, each row by the roles of its cells: { system, flight, transit, wait, elapsed, elapsedLo }, each the text of the one element on screen that draws it.
const legTable = (screen) => screen.legs.map((entries) => ({ system: only(entries, 'system'), flight: only(entries, 'flight'), transit: only(entries, 'transit'), wait: only(entries, 'wait'), elapsed: only(entries, 'elapsed'), elapsedLo: only(entries, 'elapsed-lo') }))

const overlap = (a, b) => a[0] <= b[1] + 1e-6 && b[0] <= a[1] + 1e-6
const plus = (a, b) => [a[0] + b[0], a[1] + b[1]]

// Each of the expected runs' rows against the way the oracle picked, by the names of the systems: a run is { screen, way, run }.
const eachRun = (o, x, test) => {
  for (const run of x.runs) {
    const screen = o.routes[run]
    const way = x.picked[run]
    const answer = test({ screen, way, run, table: legTable(screen), known: !run.startsWith('none') })

    if (answer !== true) {
      return `${run}: ${answer}`
    }
  }

  return true
}

const CYCLE_KEYS = ['flight', 'handling', 'transit', 'wait', 'total', 'year']

const CHECKS = [
  ['route', 'each order leaves the way the oracle picks for it, by the names of the systems in the leg table: Fastest time with a crew a way of fewer jumps that is not the shortest, Shortest the three-jump one', (o, x) => eachRun(o, x, ({ way, table }) => {
    const expected = [...way.legs.map((leg) => x.names[leg.system]), x.names[SYSTEMS.target]]

    return verdict(JSON.stringify(table.map((row) => row.system)) === JSON.stringify(expected), { shown: table.map((row) => row.system), expected })
  })],
  ['flight', 'the Flight and Transit cells of each leg are the seconds the oracle flies in that system and none for a jump, and the row of arrival has neither', (o, x) => eachRun(o, x, ({ way, table }) => readable(() => {
    if (table.length !== way.legs.length + 1) {
      return short({ rows: table.length, expected: way.legs.length + 1 })
    }

    const wrong = way.legs.findIndex((leg, index) => !within(spanInterval(table[index].flight), leg.flight) || !within(spanInterval(table[index].transit), 0))
    const arrival = table[table.length - 1]

    return verdict(wrong === -1 && arrival.flight === '—' && arrival.transit === '—', { leg: wrong, shown: wrong === -1 ? [arrival.flight, arrival.transit] : [table[wrong].flight, table[wrong].transit], expected: wrong === -1 ? '—' : way.legs[wrong].flight })
  }))],
  ['wait', 'the Wait cell of each jump is the range the oracle works out from the crew and the time flown since the last jump (the lowest draw to the highest with the retry), or words with no figure without a crew, and none for the arrival', (o, x) => eachRun(o, x, ({ way, table, known }) => readable(() => {
    if (table.length !== way.legs.length + 1) {
      return short({ rows: table.length, expected: way.legs.length + 1 })
    }

    const wrong = way.legs.findIndex((leg, index) => {
      const cell = waitCell(table[index].wait)

      if (!known) {
        return cell.kind !== 'words'
      }

      return cell.kind !== 'range' || !within(cell.lo, leg.wait.lo) || !within(cell.hi, leg.wait.hi)
    })

    return verdict(wrong === -1 && table[table.length - 1].wait === '—', { leg: wrong, shown: wrong === -1 ? table[table.length - 1].wait : table[wrong].wait, expected: wrong === -1 ? '—' : way.legs[wrong].wait })
  }))],
  ['elapsed', 'the Elapsed cell of each row is the upper case of the clock after it with the lower case beside it, the arrival row the whole way, and a dash for each row without a crew', (o, x) => eachRun(o, x, ({ way, table, known }) => readable(() => {
    if (table.length !== way.legs.length + 1) {
      return short({ rows: table.length, expected: way.legs.length + 1 })
    }

    const clocks = [...way.legs.map((leg) => leg.elapsed), way.elapsed]
    const wrong = clocks.findIndex((clock, index) => {
      if (!known) {
        return table[index].elapsed !== '—'
      }

      const cell = elapsedCell(table[index].elapsed, table[index].elapsedLo)

      return cell.kind !== 'range' || !within(cell.hi, clock.hi) || !within(cell.lo, clock.lo)
    })

    return verdict(wrong === -1, { row: wrong, shown: table[wrong] && [table[wrong].elapsed, table[wrong].elapsedLo], expected: clocks[wrong] })
  }))],
  ['reconcile', 'the flights, transits and waits shown add up to the elapsed time shown, at the upper case and at the lower', (o, x) => eachRun(o, x, ({ table, known }) => readable(() => {
    if (!known) {
      return true
    }

    const flights = table.slice(0, -1).map((row) => plus(spanInterval(row.flight), spanInterval(row.transit)))
    const waits = table.slice(0, -1).map((row) => waitCell(row.wait))
    const arrival = table[table.length - 1]
    const total = elapsedCell(arrival.elapsed, arrival.elapsedLo)
    const sum = (key) => flights.reduce((all, interval, index) => plus(all, plus(interval, waits[index].kind === 'range' ? waits[index][key] : [NaN, NaN])), [0, 0])

    return verdict(overlap(sum('hi'), total.hi) && overlap(sum('lo'), total.lo), { upper: sum('hi'), lower: sum('lo'), shown: [arrival.elapsed, arrival.elapsedLo] })
  }))],
  ['tile', 'the Jumps tile counts the jumps of the way, the Travel time tile is the elapsed time at the upper case of that way, or the flight alone without a crew, and the note under it gives the flight and the wait of the way, each from its lowest case to its highest, whose highest cases add up to the tile (and neither without a crew)', (o, x) => eachRun(o, x, ({ screen, way, known }) => readable(() => {
    const jumps = only(screen.tiles, 'jumps')
    const time = only(screen.tiles, 'time')
    const notes = screen.tileNotes.filter((note) => note.tile === 'time')

    if (jumps === undefined || time === undefined || notes.length !== 1) {
      return short({ tiles: screen.tiles, notes: notes.length })
    }

    const seconds = known ? way.elapsed.hi : way.legs.reduce((total, leg) => total + leg.flight, 0)
    const shown = spanInterval(time, !known)
    const sum = (read) => way.legs.reduce((total, leg) => total + read(leg), 0)
    const expected = { flight: [sum((leg) => leg.flight), sum((leg) => leg.flightHi)], wait: [sum((leg) => leg.wait.lo), sum((leg) => leg.wait.hi)] }
    const flight = waitCell(only(notes[0].parts, 'flight'))
    const wait = waitCell(only(notes[0].parts, 'wait'))
    const parts = known ? flight.kind === 'range' && wait.kind === 'range' && within(flight.lo, expected.flight[0]) && within(flight.hi, expected.flight[1]) && within(wait.lo, expected.wait[0]) && within(wait.hi, expected.wait[1]) && overlap(plus(flight.hi, wait.hi), shown) : flight.kind === 'missing' && wait.kind === 'missing'

    return verdict(figure(jumps, screen.grouping) === way.jumps && within(shown, seconds) && parts, { jumps, time, note: { flight: only(notes[0].parts, 'flight'), wait: only(notes[0].parts, 'wait') }, expected: { jumps: way.jumps, seconds, ...(known ? expected : {}) } })
  }))],
  ['offset', 'a fleet that carries a delay says so with the delay it carries and a fleet that carries none says nothing', (o, x) => eachRun(o, x, ({ screen, run }) => readable(() => {
    const carried = run.startsWith('carrying') ? x.carried.carrying : 0

    if (carried === 0) {
      return verdict(screen.offset.length === 0, screen.offset)
    }

    const shown = screen.offset.length === 1 ? only(screen.offset[0], 'offset') : undefined

    return verdict(shown !== undefined && within(spanInterval(shown), carried), { offset: screen.offset, expected: carried })
  }))],
  ['notice', 'a run with no crew says that fastest time cannot rank, and a run with one says nothing', (o, x) => eachRun(o, x, ({ screen, known }) => verdict(known ? screen.notice.length === 0 : screen.notice.length === 1 && screen.notice[0].length > 0, screen.notice))],
  ['cycle-rows', 'the round trip of the fleet whose row is opened shows its six rows in order, each with a label and a figure', (o, x) => {
    for (const [name, screen] of Object.entries(o.transport)) {
      const rows = screen.cycles.filter((row) => row.on)
      const values = CYCLE_KEYS.map((key) => only(screen.cycleValues, key))

      if (JSON.stringify(screen.opened) !== JSON.stringify([x.fleetNames[name]]) || JSON.stringify(rows.map((row) => row.role)) !== JSON.stringify(CYCLE_KEYS) || values.some((value) => !value) || rows.some((row, index) => row.text.length <= values[index].length)) {
        return `${name}: ${short({ opened: screen.opened, rows: rows.map((row) => [row.role, row.text]), values })}`
      }
    }

    return true
  }],
  ['distance', 'the Travel time of the table of distances in the time order is the elapsed time of the way the oracle picks to the system, found by searching the table for it', (o, x) => {
    for (const run of ['crew-time', 'carrying-time']) {
      const screen = o.routes[run]
      const answer = readable(() => {
        if (!screen.searched) {
          return 'the table of distances was not searched'
        }

        for (const system of ['mid', 'near', 'far', 'target']) {
          const rows = screen.searched[system]
          const named = rows.filter((entries) => only(entries, 'name') === x.names[SYSTEMS[system]])

          if (named.length !== 1) {
            return short({ system, rows: rows.map((entries) => only(entries, 'name')) })
          }

          const way = x.reached[run.split('-')[0]][system]
          const cell = elapsedCell(only(named[0], 'elapsed'), only(named[0], 'elapsed-lo'))

          if (cell.kind !== 'range' || !within(cell.hi, way.elapsed.hi) || !within(cell.lo, way.elapsed.lo)) {
            return short({ system, shown: named[0], expected: way.elapsed })
          }
        }

        return true
      })

      if (answer !== true) {
        return `${run}: ${answer}`
      }
    }

    return true
  }],
  ['cycle-flight', 'the Flying, Transits and Loading and unloading rows are the flights the oracle clocks out and back, no seconds for the transits, and the two stops the oracle works out', (o, x) => cycleChecks(o, x, ({ rows, cycle, stops }) => verdict(within(spanInterval(rows.flight), cycle.flight) && within(spanInterval(rows.transit), 0) && overlap(spanInterval(rows.handling), stops.reduce((total, stop) => plus(total, stop), [0, 0])), { flight: rows.flight, transit: rows.transit, handling: rows.handling, stops, expected: cycle.flight }))],
  ['cycle-stops', 'each stop of the round trip, found by the name of its colony, gives the loading strength and the hours the oracle works out from the ship, the race\'s technology and the colony', (o, x) => stopChecks(o.transport, x, (stop) => stop.place)],
  ['cycle-wait', 'the Waiting row is the range the oracle works out for the round trip repeated, each stop being longer than the delay and its retry so that only the jumps after a short flight wait', (o, x) => cycleChecks(o, x, ({ rows, cycle, stops }) => {
    const cell = waitCell(rows.wait)
    const wait = walkCycle(cycle.cycle, stops[0][0], stops[1][0]).wait

    return verdict(stops.every((stop) => stop[0] > RETRY + cycle.cycle.crew.hi) && cell.kind === 'range' && within(cell.lo, wait.lo) && within(cell.hi, wait.hi), { wait: rows.wait, stops, expected: wait })
  })],
  ['cycle-total', 'the Round trip row is the flights, the handling and the wait added up, the lower case beside the upper', (o, x) => cycleChecks(o, x, ({ rows, cycle, stops }) => {
    const wait = walkCycle(cycle.cycle, stops[0][0], stops[1][0]).wait
    const handling = stops.reduce((total, stop) => plus(total, stop), [0, 0])
    const parts = rows.total.split(' to ')
    const lo = spanInterval(parts[0])
    const hi = spanInterval(parts[parts.length - 1])

    return verdict(parts.length <= 2 && overlap(lo, plus(handling, [cycle.flight + wait.lo, cycle.flight + wait.lo])) && overlap(hi, plus(handling, [cycle.flight + wait.hi, cycle.flight + wait.hi])), { total: rows.total, expected: { flight: cycle.flight, handling, wait } })
  })],
  ['cycle-year', 'the round trips a year are a year over the round trip at its upper case', (o, x) => cycleChecks(o, x, ({ rows, cycle, stops, grouping }) => {
    const wait = walkCycle(cycle.cycle, stops[0][0], stops[1][0]).wait
    const handling = stops.reduce((total, stop) => plus(total, stop), [0, 0])
    const shown = figure(rows.year, grouping)
    const expected = [YEAR / (cycle.flight + handling[1] + wait.hi), YEAR / (cycle.flight + handling[0] + wait.hi)]

    return verdict(overlap([shown - 0.05, shown + 0.05], expected), { year: rows.year, expected })
  })],
  ['haul-stops', 'each stop of the cycle, found by the description of its order, gives the loading strength and the hours the oracle works out from the ship, the race\'s technology and the colony', (o, x) => stopChecks(o.hauling, x, (stop) => stop.description)],
  ['haul-delay', 'the order delays of the cycle are the hours the fixture sets on the load and unload orders, and the sentence names them only when there are some', (o, x) => haulChecks(o, x, ({ parts, held }) => verdict(held.delay > 0 ? parts.delay !== undefined && Math.abs(figure(parts.delay) - held.delay / 3600) <= 0.05 + 1e-9 : parts.delay === undefined, { delay: parts.delay, expected: held.delay / 3600 }))],
  ['haul-units', 'the sentence under the opened row names the unit of each figure it gives: the days flown, and the hours of the two stops, of the order delays and of the wait', (o, x) => haulChecks(o, x, ({ parts }) => {
    const expected = { moving: 'day', handling: 'hour', wait: 'hour', ...(parts.delay === undefined ? {} : { delay: 'hour' }) }
    const shown = Object.fromEntries(Object.keys(expected).map((role) => [role, UNITS[String(parts.units[role] || '').toLowerCase()] || null]))

    return verdict(JSON.stringify(shown) === JSON.stringify(expected), { units: parts.units, expected })
  })],
  ['haul-cycle', 'the Cycle cell of a fleet is the upper case of the cycle the oracle works out (the flights, the two stops, the order delays and the wait) with the lower case beside it', (o, x) => haulChecks(o, x, ({ cell, held, cycle }) => {
    const upper = [cycle.flight + held.total + cycle.wait.hi, cycle.flight + held.total + cycle.wait.hi]
    const lower = [cycle.flight + held.total + cycle.wait.lo, cycle.flight + held.total + cycle.wait.lo]

    return verdict(Boolean(cell('cycle')) && overlap(spanInterval(cell('cycle')), upper) && Boolean(cell('cycle-low')) && overlap(spanInterval(cell('cycle-low')), lower), { cycle: [cell('cycle'), cell('cycle-low')], upper, lower })
  })],
  ['haul-parts', 'the sentence under the opened row gives the days flown (the Round trip distance over the speed), the hours the two stops take and the wait as the range the oracle works out', (o, x) => haulChecks(o, x, ({ cell, stops, cycle, parts, speed }) => {
    const handling = stops.reduce((total, stop) => plus(total, stop), [0, 0])
    const distance = /^(.+) (M|bn) km$/.exec(cell('round-trip') || '')
    const flownSeconds = distance === null ? NaN : (figure(distance[1]) * (distance[2] === 'M' ? 1e6 : 1e9)) / speed
    const hours = (text) => [(figure(text) - 0.05) * 3600, (figure(text) + 0.05) * 3600]

    return verdict(Math.abs(figure(parts.moving) * DAY - cycle.flight) <= 0.005 * DAY && Math.abs(flownSeconds - cycle.flight) <= 0.05e6 / speed && overlap(hours(parts.handling), handling) && within(hours(parts.waitLo), cycle.wait.lo) && within(hours(parts.waitHi), cycle.wait.hi), { parts, cell: cell('round-trip'), stops, expected: { flight: cycle.flight, handling, wait: cycle.wait } })
  })],
  ['haul-reconcile', 'the days flown, the hours of handling, the order delays and the wait add up to the Cycle cell, at the upper case and at the lower, and the trips a year are a year over that cycle', (o, x) => haulChecks(o, x, ({ cell, parts }) => {
    const delay = parts.delay === undefined ? [0, 0] : [(figure(parts.delay) - 0.05) * 3600, (figure(parts.delay) + 0.05) * 3600]
    const part = (wait) => [figure(parts.moving) * DAY + (figure(parts.handling) - 0.05) * 3600 + delay[0] + (figure(wait) - 0.05) * 3600 - 0.005 * DAY, figure(parts.moving) * DAY + (figure(parts.handling) + 0.05) * 3600 + delay[1] + (figure(wait) + 0.05) * 3600 + 0.005 * DAY]
    const upper = spanInterval(cell('cycle'))
    const lower = spanInterval(cell('cycle-low'))
    const trips = figure(cell('trips'))

    return verdict(overlap(part(parts.waitHi), upper) && overlap(part(parts.waitLo), lower) && overlap([trips - 0.05, trips + 0.05], [YEAR / upper[1], YEAR / upper[0]]), { parts, cycle: [cell('cycle'), cell('cycle-low')], trips: cell('trips') })
  })],
  ['haul-year', 'the trips a year are a year over the oracle\'s cycle at its upper case, and the tonnes moved a year are those trips of half the hold', (o, x) => haulChecks(o, x, ({ cell, held, cycle, cargo }) => {
    const trips = [YEAR / (cycle.flight + held.total + cycle.wait.hi), YEAR / (cycle.flight + held.total + cycle.wait.hi)]
    const shown = figure(cell('trips'))
    const moved = /^(.+?)(?: (k|M|bn))? t(?: |$)/.exec(cell('moved') || '')
    const scale = moved === null ? NaN : { k: 1e3, M: 1e6, bn: 1e9 }[moved[2]] || 1
    const step = moved === null ? NaN : moved[2] === 'k' ? 0.05e3 : moved[2] === 'M' || moved[2] === 'bn' ? 0.005 * scale : 0.5
    const tonnes = moved === null ? NaN : figure(moved[1]) * scale

    return verdict(overlap([shown - 0.05, shown + 0.05], trips) && overlap([tonnes - step, tonnes + step], [trips[0] * cargo, trips[1] * cargo]), { trips: cell('trips'), moved: cell('moved'), expected: { trips, tonnes: [trips[0] * cargo, trips[1] * cargo] } })
  })],
  ['no-errors', 'the pages raise no error', (_o, _x, seen) => verdict(seen.unexpected.length === 0, seen.unexpected.slice(0, 3))],
]

// The stops of the fleet whose row is opened against the oracle's, each paired by the name it is drawn under (`nameOf`: the colony's on Transport, the order's description on Hauling, save data either way, never the words around it), with its loading strength and its hours (`data-strength`, `data-time`) to the tenth the page rounds to.
const stopChecks = (screens, x, nameOf) => {
  for (const [name, screen] of Object.entries(screens)) {
    const answer = readable(() => {
      const wanted = x.handling[name].stops
      const identity = (line) => {
        const named = wanted.filter((stop) => line.text.includes(nameOf(stop)))

        return named.length === 1 ? nameOf(named[0]) : `${named.length} stops named in "${line.text}"`
      }
      const { pairs, problems } = pairedBy('the stops', screen.stops, wanted, identity, nameOf)

      if (problems.length || JSON.stringify(screen.opened) !== JSON.stringify([x.fleetNames[name]])) {
        return short({ opened: screen.opened, problems })
      }

      for (const [stop, line] of pairs) {
        const strength = figure(only(line.strength, ''))
        const hours = /^(.+) h$/.exec(only(line.time, '') || '')

        if (!hours || Math.abs(strength - stop.strength) > 0.05 + 1e-9 || Math.abs(figure(hours[1]) - stop.seconds / 3600) > 0.05 + 1e-9) {
          return short({ stop: nameOf(stop), shown: [only(line.strength, ''), only(line.time, '')], expected: { strength: stop.strength, hours: stop.seconds / 3600 } })
        }
      }

      return true
    })

    if (answer !== true) {
      return `${name}: ${answer}`
    }
  }

  return true
}

// The round trip of the fleet whose row is opened: the values of its rows by their keys, the two stops the oracle works out (each as an exact [seconds, seconds]) and what the oracle clocks for it.
const cycleChecks = (o, x, test) => {
  for (const [name, screen] of Object.entries(o.transport)) {
    const answer = readable(() => {
      const rows = Object.fromEntries(CYCLE_KEYS.map((key) => [key, only(screen.cycleValues, key)]))
      const stops = x.handling[name].stops.map((stop) => [stop.seconds, stop.seconds])

      if (JSON.stringify(screen.opened) !== JSON.stringify([x.fleetNames[name]]) || CYCLE_KEYS.some((key) => !rows[key])) {
        return short({ opened: screen.opened, rows })
      }

      return test({ rows, stops, grouping: screen.grouping, cycle: { ...walkCycle(x.cycles[name], stops[0][0], stops[1][0]), cycle: x.cycles[name] } })
    })

    if (answer !== true) {
      return `${name}: ${answer}`
    }
  }

  return true
}

// The cycle of each fleet on the Hauling page: its row by the fleet's name and its cells by their roles (`data-haul`), the figures of the sentence under the row it opened by theirs (`data-part`), the two stops and the order delays the oracle works out, and what the oracle clocks for it (the delays sit on the stops).
const haulChecks = (o, x, test) => {
  for (const [name, screen] of Object.entries(o.hauling)) {
    const answer = readable(() => {
      const rows = screen.haul.filter((row) => row.name === x.fleetNames[name])

      if (rows.length !== 1 || JSON.stringify(screen.opened) !== JSON.stringify([x.fleetNames[name]]) || screen.sentences.length !== 1) {
        return short({ fleets: screen.haul.map((row) => row.name), opened: screen.opened, sentences: screen.sentences.length, expected: x.fleetNames[name] })
      }

      const cell = (role) => only(rows[0].entries, role)
      const read = partsOf(screen.sentences[0])
      const wait = /^(\S+?)(?: to (\S+?))?$/.exec(read.wait ? read.wait.text : '')

      if (!read.moving || !read.handling || wait === null || !cell('cycle') || !cell('trips') || !cell('moved') || !cell('round-trip')) {
        return short({ parts: read, cells: rows[0].entries })
      }

      const parts = { moving: read.moving.text, handling: read.handling.text, waitLo: wait[1], waitHi: wait[2] || wait[1], delay: read.delay && read.delay.text, units: Object.fromEntries(Object.entries(read).map(([role, part]) => [role, part.unit])) }
      const stops = x.handling[name].stops.map((stop) => [stop.seconds, stop.seconds])
      const delay = x.handling[name].delay
      const held = { delay: delay.load + delay.unload, total: stops[0][0] + stops[1][0] + delay.load + delay.unload }

      return test({ cell, stops, parts, held, speed: x.speed, cargo: x.cargo[name], cycle: walkCycle(x.cycles[name], stops[0][0] + delay.load, stops[1][0] + delay.unload) })
    })

    if (answer !== true) {
      return `${name}: ${answer}`
    }
  }

  return true
}

const SCOPES = { routes: ['route', 'flight', 'wait', 'elapsed', 'reconcile', 'tile', 'offset', 'notice', 'distance'], transport: ['cycle-rows', 'cycle-flight', 'cycle-stops', 'cycle-wait', 'cycle-total', 'cycle-year'], hauling: ['haul-stops', 'haul-delay', 'haul-units', 'haul-cycle', 'haul-parts', 'haul-reconcile', 'haul-year'] }

// The results of the checks over the record of an observation: { id, name, result, kind }. A check fails by an assertion of its own, its verdict on what the page showed (`kind` is 'assertion'). A record with no screen to judge fails every check of the baseline, naming where it stopped (`kind` is 'unobserved', which credits nothing), and `strict` (a fault or a rewrite) prints the whole record through `print` (`describe`: the phase, the error with its call log, what the page showed then, its errors and the failed requests) and stops the run with a HarnessError, so that a page that could not be driven is never credited with a fault and the cause is told where it is first met. A check that throws is a defect of the harness.
const resultsOf = (seen, x, { ids = null, strict = true, label = 'the observation', print = (text) => console.error(text) } = {}) => {
  validate(seen, label)

  const chosen = CHECKS.filter(([id]) => !ids || ids.includes(id))

  if (unobserved(seen)) {
    if (strict) {
      print(describe(label, seen))
      throw new HarnessError(`${label} did not get through: ${failureLine(seen)}`)
    }

    return chosen.map(([id, name]) => ({ id, name, result: failureLine(seen), kind: 'unobserved' }))
  }

  const o = seen.value

  return chosen.map(([id, name, test]) => {
    let result = null

    try {
      result = Object.entries(SCOPES).some(([scope, scoped]) => scoped.includes(id) && !o[scope]) ? true : test(o, x, seen)
    } catch (error) {
      throw new HarnessError(`the check ${id} threw on ${label}: ${error && error.message ? error.message : error}`)
    }

    return { id, name, result, kind: result === true ? null : 'assertion' }
  })
}

// What an observation is judged by: the checks of a world's baseline (`ids`, every check for none) or of a rewrite (`ids`, else those of the page it rewrites), each with `no-errors` beside them, so that a page that raised an error no check named never passes, whatever figures it shows.
const judgedBy = (ids) => (ids ? [...new Set([...ids, 'no-errors'])] : null)

// The verdict on a fault: true when every check it names fails by an assertion of its own and the page raised no error under it that the fault does not name (`no-errors` among its checks), so that a fault is caught by a wrong value and never by the page throwing.
const faultVerdict = (seen, x, fault) => {
  const label = `the pages with the fault "${fault.name}"`
  const failed = resultsOf(seen, x, { ids: fault.fails, label })
  const [raised] = fault.fails.includes('no-errors') ? [{ result: true }] : resultsOf(seen, x, { ids: ['no-errors'], label })

  return raised.result !== true ? `the page raised an error under the fault, so no figure it shows is credited: ${raised.result}` : caughtAll(failed) ? true : notCaught(failed)
}

// ---------- the faults and the rewrites ----------

const swap = (from, to) => (text) => {
  if (text.split(from).length !== 2) {
    throw new Error(`The variant must apply exactly once to the page: ${from}`)
  }

  return text.replace(from, () => to)
}

const LEG_PANEL = 'data-leg-detail elevation="1">'
const EXPANDED = '            <template #expanded-item="{ headers, item }">\n              <td :colspan="headers.length" class="py-3">\n                <div v-if="item.cycleRows.length"'

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the wait cell states the shortest wait', file: ROUTES_FILE, scope: 'routes', change: swap('wait.lo === wait.hi ? this.span(wait.hi) : `${this.span(wait.lo)} to ${this.span(wait.hi)}`', 'this.span(wait.lo)'), fails: ['wait', 'reconcile'] },
  { name: 'the elapsed cell states the lower case', file: ROUTES_FILE, scope: 'routes', change: swap("{{ item.elapsed ? span(item.elapsed.hi) : '—' }}", "{{ item.elapsed ? span(item.elapsed.lo) : '—' }}"), fails: ['elapsed'] },
  { name: 'the flight cell counts the flight twice', file: ROUTES_FILE, scope: 'routes', change: swap('{{ flightText(item.flight, item.flightHi) }}', '{{ flightText(item.flight && item.flight * 2, item.flightHi && item.flightHi * 2) }}'), fails: ['flight'] },
  { name: 'the transit cell states a second for each jump', file: ROUTES_FILE, scope: 'routes', change: swap("{{ item.transit === undefined ? '—' : span(item.transit) }}", "{{ item.transit === undefined ? '—' : span(item.transit + 1) }}"), fails: ['flight'] },
  { name: 'the start offset note states a minute too much', file: ROUTES_FILE, scope: 'routes', change: swap('<span data-part="offset">{{ span(plan.time.startDelay) }}</span>', '<span data-part="offset">{{ span(plan.time.startDelay + 60) }}</span>'), fails: ['offset'] },
  { name: 'the travel time tile states half the time', file: ROUTES_FILE, scope: 'routes', change: swap('this.span(time.value * SECONDS_PER_DAY)', 'this.span(time.value * SECONDS_PER_DAY / 2)'), fails: ['tile'] },
  { name: 'the leg table is not displayed (v-show)', file: ROUTES_FILE, scope: 'routes', change: swap(LEG_PANEL, 'data-leg-detail v-show="false" elevation="1">'), fails: ['route', 'flight', 'wait', 'elapsed'] },
  { name: 'the whole page is transparent (an ancestor with no opacity)', file: ROUTES_FILE, scope: 'routes', change: swap('<v-container fluid class="routes-page">', '<v-container fluid class="routes-page" style="opacity: 0">'), fails: ['route', 'flight', 'tile'] },
  { name: 'the slot of the Wait column is one nothing consumes', file: ROUTES_FILE, scope: 'routes', change: swap('<template #[`item.wait`]="{ item }">', '<template #[`item.waits`]="{ item }">'), fails: ['wait'] },
  { name: 'fastest time ranks without a crew', file: ROUTES_FILE, scope: 'routes', change: swap("return this.order === 'time' && !(this.timing && this.timing.shock) ? 'km' : this.order", 'return this.order'), fails: ['notice'] },
  { name: 'the wait row states the shortest wait', file: INFORMATION_FILE, scope: 'transport', change: swap('text: range(trip.waitSeconds.lo, trip.waitSeconds.hi)', 'text: this.span(trip.waitSeconds.lo)'), fails: ['cycle-wait'] },
  { name: 'the round trip row states the lower case alone', file: INFORMATION_FILE, scope: 'transport', change: swap('text: range(trip.tripSecondsLow, trip.tripSeconds)', 'text: this.span(trip.tripSecondsLow)'), fails: ['cycle-total'] },
  { name: 'the flying row is the whole round trip', file: INFORMATION_FILE, scope: 'transport', change: swap("{ key: 'flight', label: 'Flying', text: this.span(trip.travelSeconds) }", "{ key: 'flight', label: 'Flying', text: this.span(trip.tripSeconds) }"), fails: ['cycle-flight'] },
  { name: 'the transit row states the flights', file: INFORMATION_FILE, scope: 'transport', change: swap("{ key: 'transit', label: 'Transits', text: this.span(trip.transitSeconds) }", "{ key: 'transit', label: 'Transits', text: this.span(trip.travelSeconds) }"), fails: ['cycle-flight'] },
  { name: 'the round trips a year follow the lower case', file: INFORMATION_FILE, scope: 'transport', change: swap('text: this.count(trip.trips, 1) }', 'text: this.count(31536000 / trip.tripSecondsLow, 1) }'), fails: ['cycle-year'] },
  { name: 'the round trip is not displayed (v-show)', file: INFORMATION_FILE, scope: 'transport', change: swap('<div v-if="item.cycleRows.length" class="mb-3" data-fleet-cycle>', '<div v-if="item.cycleRows.length" v-show="false" class="mb-3" data-fleet-cycle>'), fails: ['cycle-rows'] },
  { name: 'the fleets panel is transparent (an ancestor with no opacity)', file: INFORMATION_FILE, scope: 'transport', change: swap('data-fleet-panel elevation="1">', 'data-fleet-panel style="opacity: 0" elevation="1">'), fails: ['cycle-rows'] },
  { name: 'the slot of the opened row is one nothing consumes', file: INFORMATION_FILE, scope: 'transport', change: swap(EXPANDED, EXPANDED.replace('#expanded-item=', '#expanded-items=')), fails: ['cycle-rows'] },
  { name: 'the cycle cell states the lower case', file: HAULING_FILE, scope: 'hauling', change: swap('{{ fixed(item.year.cycleDays, 1) }} d</span>', '{{ fixed(item.year.cycleLowDays, 1) }} d</span>'), fails: ['haul-cycle'] },
  { name: 'the lower case beside the cycle states the upper', file: HAULING_FILE, scope: 'hauling', change: swap('<span data-haul="cycle-low">{{ fixed(item.year.cycleLowDays, 1) }} d</span>', '<span data-haul="cycle-low">{{ fixed(item.year.cycleDays, 1) }} d</span>'), fails: ['haul-cycle'] },
  { name: 'the wait of the cycle states the shortest wait alone', file: HAULING_FILE, scope: 'hauling', change: swap('`${this.fixed(year.waitLowDays * 24, 1)} to ${this.fixed(year.waitDays * 24, 1)} hours`', '`${this.fixed(year.waitLowDays * 24, 1)} hours`'), fails: ['haul-parts', 'haul-reconcile'] },
  { name: 'the handling of the cycle counts the hours twice', file: HAULING_FILE, scope: 'hauling', change: swap('{{ fixed(item.handlingHours, 1) }}</span> hours loading and unloading', '{{ fixed(item.handlingHours * 2, 1) }}</span> hours loading and unloading'), fails: ['haul-parts', 'haul-reconcile'] },
  { name: 'the trips a year follow the lower case', file: HAULING_FILE, scope: 'hauling', change: swap('<span data-haul="trips">{{ fixed(item.year.trips, 1) }}</span>', '<span data-haul="trips">{{ fixed(item.year.trips * item.year.cycleDays / item.year.cycleLowDays, 1) }}</span>'), fails: ['haul-year'] },
  { name: 'the sentence of the cycle is not displayed (v-show)', file: HAULING_FILE, scope: 'hauling', change: swap('class="caption text--secondary mt-2" data-cycle-parts>', 'class="caption text--secondary mt-2" v-show="false" data-cycle-parts>'), fails: ['haul-parts'] },
  { name: 'the page of the routes is transparent (an ancestor with no opacity)', file: HAULING_FILE, scope: 'hauling', change: swap('<v-container fluid class="hauling-page">', '<v-container fluid class="hauling-page" style="opacity: 0">'), fails: ['haul-cycle', 'haul-year'] },
  { name: 'the slot of the Cycle column is one nothing consumes', file: HAULING_FILE, scope: 'hauling', change: swap('<template #[`item.cycleSort`]="{ item }">', '<template #[`item.cycleSorts`]="{ item }">'), fails: ['haul-cycle'] },
  { name: 'the cycle is timed without the walk of the jump shock', file: HAULING_FILE, scope: 'hauling', change: swap('routeYear(sailing, route, cargo, handling, delay, heldWalk)', 'routeYear(sailing, route, cargo, handling, delay)'), fails: ['haul-cycle', 'haul-year'] },
  { name: 'the distance table ignores the clock of the time order', file: ROUTES_FILE, scope: 'routes', change: swap("const clock = this.planOrder === 'time' ? this.timing : null", 'const clock = null'), fails: ['distance'] },
  { name: 'the distance table states the lower case of the travel time', file: ROUTES_FILE, scope: 'routes', change: swap("{{ item.elapsed === null ? '—' : span(item.elapsed.hi) }}", "{{ item.elapsed === null ? '—' : span(item.elapsed.lo) }}"), fails: ['distance'] },
  { name: 'the order delays of the cycle count the hours twice', file: HAULING_FILE, scope: 'hauling', change: swap('<span data-part="delay">{{ fixed(item.delayHours, 1) }}</span>', '<span data-part="delay">{{ fixed(item.delayHours * 2, 1) }}</span>'), fails: ['haul-delay', 'haul-reconcile'] },
  { name: 'the walk of a cycle leaves out the delay of an order', file: HAULING_JS, scope: 'hauling', change: swap(' + (order.OrderDelay || 0)', ''), fails: ['haul-cycle', 'haul-reconcile'] },
  { name: 'a cargo point takes twice the seconds to load (Transport)', file: TRANSPORT_JS, scope: 'transport', change: swap('const HANDLING_SECONDS = { minerals: 20, installations: 20, colonists: 10 }', 'const HANDLING_SECONDS = { minerals: 40, installations: 20, colonists: 10 }'), fails: ['cycle-stops'] },
  { name: 'a cargo point takes twice the seconds to load (Hauling)', file: TRANSPORT_JS, scope: 'hauling', change: swap('const HANDLING_SECONDS = { minerals: 20, installations: 20, colonists: 10 }', 'const HANDLING_SECONDS = { minerals: 40, installations: 20, colonists: 10 }'), fails: ['haul-stops'] },
  { name: 'the days flown are named in hours', file: HAULING_FILE, scope: 'hauling', change: swap('{{ fixed(item.year.movingDays, 2) }}</span> days moving', '{{ fixed(item.year.movingDays, 2) }}</span> hours moving'), fails: ['haul-units'] },
  { name: 'the hours of handling are named in days', file: HAULING_FILE, scope: 'hauling', change: swap('{{ fixed(item.handlingHours, 1) }}</span> hours loading and unloading', '{{ fixed(item.handlingHours, 1) }}</span> days loading and unloading'), fails: ['haul-units'] },
  { name: 'the hours of order delays are named in days', file: HAULING_FILE, scope: 'hauling', change: swap('<span data-part="delay">{{ fixed(item.delayHours, 1) }}</span> hours of order delays', '<span data-part="delay">{{ fixed(item.delayHours, 1) }}</span> days of order delays'), fails: ['haul-units'] },
  { name: 'the hours of the wait are named in days', file: HAULING_FILE, scope: 'hauling', change: swap('`${this.fixed(year.waitLowDays * 24, 1)} to ${this.fixed(year.waitDays * 24, 1)} hours`', '`${this.fixed(year.waitLowDays * 24, 1)} to ${this.fixed(year.waitDays * 24, 1)} days`'), fails: ['haul-units'] },
  { name: 'a fleet at a speed of its own is restored to its maximum in each system', file: HAULING_FILE, scope: 'hauling', world: 'held', change: swap('{ holdsSpeed: profile.useMaximumSpeed === false }', '{ holdsSpeed: false }'), fails: ['haul-year'] },
  { name: 'the wait of a fleet with no crew states a bare zero', file: ROUTES_FILE, scope: 'routes', change: swap("wait === null ? 'Not known' :", "wait === null ? '0' :"), fails: ['wait'] },
  { name: 'the note of the travel time states the flight at its lowest case', file: ROUTES_FILE, scope: 'routes', world: 'capped', change: swap("{ text: this.flightText(flight, flightHi), part: 'flight' }", "{ text: this.span(flight), part: 'flight' }"), fails: ['tile'] },
]

const BENIGN = [
  { name: 'the order toggle bound by an explicit value and event', file: ROUTES_FILE, scope: 'routes', change: swap('<v-btn-toggle v-model="order" mandatory dense>', '<v-btn-toggle :value="order" mandatory dense @change="order = $event">') },
  { name: 'the wait text with its condition in brackets', file: ROUTES_FILE, scope: 'routes', change: swap("wait === null ? 'Not known' : wait.lo === wait.hi ?", "wait === null ? 'Not known' : (wait.lo === wait.hi) ?") },
  { name: 'the elapsed cell with its condition turned round', file: ROUTES_FILE, scope: 'routes', change: swap("{{ item.elapsed ? span(item.elapsed.hi) : '—' }}", "{{ !item.elapsed ? '—' : span(item.elapsed.hi) }}") },
  { name: 'the start offset note with its condition in brackets', file: ROUTES_FILE, scope: 'routes', change: swap('v-if="plan.time && plan.time.startDelay > 0"', 'v-if="plan.time && (plan.time.startDelay > 0)"') },
  { name: 'the leg table shown by v-show', file: ROUTES_FILE, scope: 'routes', change: swap(LEG_PANEL, 'data-leg-detail v-show="true" elevation="1">') },
  { name: 'the start offset sentence worded another way', file: ROUTES_FILE, scope: 'routes', change: swap('The fleet starts with <span data-part="offset">', 'The fleet sets out with <span data-part="offset">') },
  { name: 'the Wait column header reworded', file: ROUTES_FILE, scope: 'routes', change: swap("{ text: 'Wait', value: 'wait'", "{ text: 'Waiting', value: 'wait'") },
  { name: 'the range of a round trip with its condition turned round', file: INFORMATION_FILE, scope: 'transport', change: swap('(low === high ? this.span(low) : `${this.span(low)} to ${this.span(high)}`)', '(low !== high ? `${this.span(low)} to ${this.span(high)}` : this.span(low))') },
  { name: 'the flying row written as a template', file: INFORMATION_FILE, scope: 'transport', change: swap("{ key: 'flight', label: 'Flying', text: this.span(trip.travelSeconds) }", "{ key: 'flight', label: 'Flying', text: `${this.span(trip.travelSeconds)}` }") },
  { name: 'the hook of a round trip row bound by the longhand', file: INFORMATION_FILE, scope: 'transport', change: swap(':data-cycle-row="row.key"', 'v-bind:data-cycle-row="row.key"') },
  { name: 'the lower case of the cycle shown by a condition turned round', file: HAULING_FILE, scope: 'hauling', change: swap('v-if="item.year.cycleLowDays !== item.year.cycleDays"', 'v-if="item.year.cycleDays !== item.year.cycleLowDays"') },
  { name: 'the wait of the cycle with its condition turned round', file: HAULING_FILE, scope: 'hauling', change: swap('year.waitLowDays === year.waitDays ?', 'year.waitDays === year.waitLowDays ?') },
  { name: 'the sentence of the cycle shown by v-show', file: HAULING_FILE, scope: 'hauling', change: swap('class="caption text--secondary mt-2" data-cycle-parts>', 'class="caption text--secondary mt-2" v-show="true" data-cycle-parts>') },
  { name: 'the joiner of the cycle sentence with its condition turned round', file: HAULING_FILE, scope: 'hauling', change: swap("{{ item.waitText || item.delayHours > 0 ? ',' : ' and' }}", "{{ !(item.waitText || item.delayHours > 0) ? ' and' : ',' }}") },
  { name: 'the distance clock with its comparison turned round', file: ROUTES_FILE, scope: 'routes', change: swap("const clock = this.planOrder === 'time' ? this.timing : null", "const clock = this.planOrder !== 'time' ? null : this.timing") },
  { name: 'the distance cell with its condition turned round', file: ROUTES_FILE, scope: 'routes', change: swap("{{ item.elapsed === null ? '—' : span(item.elapsed.hi) }}", "{{ item.elapsed !== null ? span(item.elapsed.hi) : '—' }}") },
  { name: 'the joiner of the delay with its condition turned round', file: HAULING_FILE, scope: 'hauling', change: swap("{{ item.waitText ? ',' : ' and' }}", "{{ !item.waitText ? ' and' : ',' }}") },
  { name: 'the sentence of the cycle worded another way', file: HAULING_FILE, scope: 'hauling', change: swap('Each cycle: <span data-part="moving">', 'Per cycle: <span data-part="moving">') },
  { name: 'the days moving moved ahead of their figure', file: HAULING_FILE, scope: 'hauling', change: swap('<span data-part="moving">{{ fixed(item.year.movingDays, 2) }}</span> days moving', 'moving for <span data-part="moving">{{ fixed(item.year.movingDays, 2) }}</span> days') },
  { name: 'the handling of the cycle worded with another suffix', file: HAULING_FILE, scope: 'hauling', change: swap(' hours loading and unloading<template v-if="item.delayHours > 0">', ' hours in loading and unloading<template v-if="item.delayHours > 0">') },
  { name: 'the handling seconds listed in another order (Transport)', file: TRANSPORT_JS, scope: 'transport', change: swap('const HANDLING_SECONDS = { minerals: 20, installations: 20, colonists: 10 }', 'const HANDLING_SECONDS = { colonists: 10, installations: 20, minerals: 20 }') },
  { name: 'the handling seconds listed in another order (Hauling)', file: TRANSPORT_JS, scope: 'hauling', change: swap('const HANDLING_SECONDS = { minerals: 20, installations: 20, colonists: 10 }', 'const HANDLING_SECONDS = { colonists: 10, installations: 20, minerals: 20 }') },
  { name: 'the hours of handling named by the letter', file: HAULING_FILE, scope: 'hauling', change: swap('{{ fixed(item.handlingHours, 1) }}</span> hours loading and unloading', '{{ fixed(item.handlingHours, 1) }}</span> h loading and unloading') },
  { name: 'the hours of order delays named by their short word', file: HAULING_FILE, scope: 'hauling', change: swap('<span data-part="delay">{{ fixed(item.delayHours, 1) }}</span> hours of order delays', '<span data-part="delay">{{ fixed(item.delayHours, 1) }}</span> hrs of order delays') },
  { name: 'the unit of the days flown inside the figure\'s own text', file: HAULING_FILE, scope: 'hauling', change: swap('<span data-part="moving">{{ fixed(item.year.movingDays, 2) }}</span> days moving', '<span data-part="moving">{{ fixed(item.year.movingDays, 2) }} days</span> moving') },
  { name: 'the hours of the wait named by the short word', file: HAULING_FILE, scope: 'hauling', change: swap('`${this.fixed(year.waitLowDays * 24, 1)} to ${this.fixed(year.waitDays * 24, 1)} hours`', '`${this.fixed(year.waitLowDays * 24, 1)} to ${this.fixed(year.waitDays * 24, 1)} hrs`') },
  { name: 'the Trips column header reworded', file: HAULING_FILE, scope: 'hauling', change: swap("{ text: 'Trips / yr', value: 'tripsSort'", "{ text: 'Trips a year', value: 'tripsSort'") },
  { name: 'the speed of a fleet written with its comparison turned round', file: HAULING_FILE, scope: 'hauling', world: 'held', change: swap('{ holdsSpeed: profile.useMaximumSpeed === false }', '{ holdsSpeed: false === profile.useMaximumSpeed }') },
  { name: 'the unknown wait reworded', file: ROUTES_FILE, scope: 'routes', change: swap("wait === null ? 'Not known' :", "wait === null ? 'Unknown' :") },
  { name: 'the lower case of a leg qualified another way', file: ROUTES_FILE, scope: 'routes', change: swap('(from <span data-leg="elapsed-lo">', '(at least <span data-leg="elapsed-lo">') },
  { name: 'the lower case of a cycle qualified another way', file: HAULING_FILE, scope: 'hauling', change: swap('(from <span data-haul="cycle-low">', '(at least <span data-haul="cycle-low">') },
  { name: 'the note of the travel time worded another way', file: ROUTES_FILE, scope: 'routes', world: 'capped', change: swap("{ text: ' flying and ' }, { text: this.waitText(wait), part: 'wait' }, { text: ' waiting' }", "{ text: ' in flight, ' }, { text: this.waitText(wait), part: 'wait' }, { text: ' at jump points' }") },
]
/* eslint-enable no-template-curly-in-string */

// ---------- the run ----------

let checks = 0
let failures = 0

const report = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

// Controls of the checks that need no browser: the clock against the figures worked out by hand for the constructed save, and the reading of what the page writes.
const controls = (x) => {
  const figures = (run) => [Math.round(x.picked[run].elapsed.lo), Math.round(x.picked[run].elapsed.hi)]
  const byHand = (fleet, jumps) => x.ways[fleet].find((way) => way.jumps === jumps).elapsed
  const near = (value, expected) => Math.abs(value - expected) < 1e-6
  const clocks = (fleet, lo, hi) => [byHand(fleet, 3), byHand(fleet, 2)].every((clock, index) => near(clock.lo, lo[index]) && near(clock.hi, hi[index]))

  report('control: the crew of 400 grade points at 0.9 morale draws 122 to 181 s and the crew of 1000 draws 94 to 140 s', JSON.stringify([crewDelay({ GradePoints: 400, CrewMorale: 0.9, OverhaulFactor: 1 }), crewDelay({ GradePoints: 1000, CrewMorale: 1, OverhaulFactor: 1 })]) === '[{"lo":122,"hi":181},{"lo":94,"hi":140}]' ? true : 'the crews draw other delays')
  report('control: the oracle clocks the three-jump way at 304 to 86,822 s and the two-jump way at 30,000 to 53,381 s for the fleet with no delay carried', clocks('crew', [304, 30000], [86822, 53381]) ? true : short([byHand('crew', 3), byHand('crew', 2)]))
  report('control: the oracle clocks the three-jump way at 594 to 130,280 s and the two-jump way at 30,000 to 86,940 s for the fleet carrying 400 s', clocks('carrying', [594, 30000], [130280, 86940]) ? true : short([byHand('carrying', 3), byHand('carrying', 2)]))
  report('control: fastest time picks the two-jump way for both fleets, Shortest the three-jump way, and with no crew the distance decides; the lower case alone would pick the three-jump way', ['crew', 'carrying'].every((fleet) => x.picked[`${fleet}-time`].jumps === 2 && x.picked[`${fleet}-jumps`].jumps === 2 && x.picked[`${fleet}-km`].jumps === 3 && byHand(fleet, 3).lo < byHand(fleet, 2).lo) && x.picked['none-time'].jumps === 3 ? true : short(RUNS.map((run) => [run, x.picked[run].jumps, figures(run)])))
  report('control: the round trip is 280 s of flight with a wait of 84 to 86,602 s for the crew of 122 to 181 s and 28 to 86,520 s for the crew of 94 to 140 s, when each stop clears the delay', ['crew', 'carrying'].every((fleet, index) => { const walked = walkCycle(x.cycles[fleet], 120000, 250000); return near(walked.flight, 280) && near(walked.wait.lo, [84, 28][index]) && near(walked.wait.hi, [86602, 86520][index]) }) ? true : short(['crew', 'carrying'].map((fleet) => walkCycle(x.cycles[fleet], 120000, 250000))))
  report('control: a span reads as the interval its display stands for', [['45 s', 45], ['3 min 20 s', 200], ['2 h 5 min', 7530], ['12.5 d', 12.5 * DAY], ['4.1 mo', 4.1 * 30.4 * DAY], ['2.3 y', 2.3 * 365 * DAY], ['1234 s', 1234]].every(([text, seconds]) => within(spanInterval(text), seconds)) && !within(spanInterval('3 min 20 s'), 201) && !within(spanInterval('12.5 d'), 12.7 * DAY) && within(spanInterval('1 h', true), 240) ? true : 'a span is read as another interval')
  report('control: a span whose figure is grouped, written in another notation, or run into its unit is refused', ['1\'234 s', '1e3 s', '12.5.1 d', '45s', '3 min 20'].every((text) => { try { spanInterval(text); return false } catch (error) { return true } }) ? true : 'a span was read that is not one')
  report('control: the figures of a sentence are read with their units, whatever words sit around them, and a part that is not drawn is not read', JSON.stringify(partsOf({ text: 'Per cycle: moving for 2.50 days, 4.0 h in loading', parts: [{ role: 'moving', text: '2.50', on: true }, { role: 'delay', text: '9.0', on: false }, { role: 'handling', text: '4.0 h', on: true }] })) === '{"moving":{"text":"2.50","unit":"days"},"handling":{"text":"4.0","unit":"h"}}' ? true : 'the parts of a sentence were read otherwise')
  report('control: a role drawn once reads as its text, one not drawn as nothing, and one drawn twice as no figure', only([{ role: 'jumps', text: '3', on: true }, { role: 'time', text: '2 d', on: false }], 'jumps') === '3' && only([{ role: 'time', text: '2 d', on: false }], 'time') === undefined && readFigure(only([{ role: 'jumps', text: '3', on: true }, { role: 'jumps', text: '3', on: true }], 'jumps'), PLAIN) === null ? true : 'a role was read otherwise')
  report('control: a wait cell with no figure reads as words, and one with a digit that is no span (a bare 0) or with nothing in it reads as malformed, never as words', waitCell('Not known').kind === 'words' && waitCell('0').kind === 'malformed' && waitCell('').kind === 'malformed' && waitCell(undefined).kind === 'missing' && waitCell('2 h to 3 h').kind === 'range' ? true : short(['Not known', '0', '', undefined, '2 h to 3 h'].map(waitCell)))
  report('control: the oracle loads the 25,000 of cargo at a strength of 4 in 125,000 s and unloads at a strength of 2 in 250,000 s, and reads the delays the fixture sets', ['crew', 'carrying'].every((key) => { const { stops } = x.handling[key]; return near(stops[0].seconds, 125000) && near(stops[1].seconds, 250000) && stops[0].strength === 4 && stops[1].strength === 2 }) && JSON.stringify(x.handling.crew.delay) === '{"load":3600,"unload":0}' && JSON.stringify(x.handling.carrying.delay) === '{"load":0,"unload":5400}' ? true : short(x.handling))

  const whole = (value) => ({ value, error: null, phase: 'finished', errors: [], console: [], failed: [], unexpected: [] })
  const stopped = (call) => { try { call() } catch (error) { return error } return null }
  const nothing = { grouping: 'Tick', tiles: [], tileNotes: [], legs: [], offset: [], notice: [], distances: [], opened: [], cycles: [], cycleValues: [], stops: [], sentences: [], haul: [] }
  const empty = { routes: Object.fromEntries(RUNS.map((run) => [run, nothing])), transport: { crew: nothing, carrying: nothing }, hauling: { crew: nothing, carrying: nothing } }
  const blank = resultsOf(whole(empty), x, { ids: Object.values(SCOPES).flat(), label: 'a screen with nothing on it' })
  const broken = { ...failedObservation('locator.click: Timeout 120000ms exceeded.\nCall log:\n  - waiting for the game of the save', 'the page is opened'), scene: 'address http://127.0.0.1:1/ (loaded 1 time)\nrequests still out: GET http://127.0.0.1:1/src/main.js (120.0 s)', failed: ['GET http://127.0.0.1:1/node_modules/.vite/deps/vue.js: 504 Outdated Optimize Dep'] }
  const printed = []
  const stop = stopped(() => resultsOf(broken, x, { ids: ['route'], label: 'a page that did not open', print: (text) => printed.push(text) }))
  const untold = [broken.phase, ...broken.error.split('\n'), ...broken.scene.split('\n'), ...broken.failed].filter((line) => !printed.join('\n').includes(line))

  report('control: a screen with nothing on it fails every check by an assertion of its own, none of them by a throw', blank.every(({ result, kind }) => result !== true && kind === 'assertion') ? true : short(blank.map(({ id, result, kind }) => [id, kind, typeof result === 'string' ? result.slice(0, 60) : result])))
  report('control: an observation that did not get through fails the baseline as unobserved, credits no fault, and stops the run when a fault or a rewrite is judged, having printed its whole record once: the phase, the error with its call log, what the page showed then and the failed requests', resultsOf(broken, x, { strict: false, ids: ['route'] }).every(({ kind }) => kind === 'unobserved') && !caughtAll(resultsOf(broken, x, { strict: false, ids: ['route'] })) && stop instanceof HarnessError && printed.length === 1 && untold.length === 0 ? true : short({ stopped: Boolean(stop), printed: printed.length, untold }))
  report('control: a record of another shape stops the run as a defect of the harness', stopped(() => resultsOf({ value: {} }, x)) instanceof HarnessError ? true : 'a record of another shape was judged')

  const raised = { ...whole(empty), error: 'the page raised 1 unexpected error, the first: console error: the render threw', errors: ['the render threw'], unexpected: ['console error: the render threw'] }
  const failsNoErrors = (results) => results.some(({ id, result, kind }) => id === 'no-errors' && result !== true && kind === 'assertion')
  const probe = { name: 'a probe', fails: ['route'] }

  report('control: a page that raised an error no check named fails no-errors by an assertion in the baseline of every world and in a rewrite of every page, and credits no fault whose checks its figures fail, which the same figures credit with no error', Object.values(PLANS).every((plan) => failsNoErrors(resultsOf(raised, x, { strict: false, ids: judgedBy(plan.ids) }))) && Object.values(SCOPES).every((scoped) => failsNoErrors(resultsOf(raised, x, { ids: judgedBy(scoped) }))) && faultVerdict(raised, x, probe) !== true && faultVerdict(whole(empty), x, probe) === true ? true : 'a page that raised an error was judged as one that raised none')
}

// The control of the world of the carried cap: the oracle's clock of the way Fewest jumps takes, against the figures worked out by hand.
const cappedControls = (x) => {
  const way = x.picked['crew-jumps']
  const near = (value, expected) => Math.abs(value - expected) < 1e-6
  const legs = way.legs.map((leg) => [leg.flight, leg.flightHi, leg.wait.lo, leg.wait.hi])
  const expected = [[12500, 12500, 0, 0], [20000, 24320, 0, 19061]]

  report('control: Fewest jumps takes the way through mid: the start system flown 12,500 s at its cap of 40,000 km/s, mid 20,000 s at the lowest case and 24,320 s at the highest (21,600 s at the cap held past the transit, then 2,720 s at the speed), and a wait of 0 to 19,061 s at the second jump, 32,500 to 55,881 s in all', way.jumps === 2 && legs.length === 2 && legs.every((leg, index) => leg.every((value, at) => near(value, expected[index][at]))) && near(way.elapsed.lo, 32500) && near(way.elapsed.hi, 55881) ? true : short({ legs, elapsed: way.elapsed }))
}

// What each world runs: its title, what its checks and its child's failure are named by, the pages it drives, the checks its baseline and its rewrites are judged by (all of a page's with none), its expectations and its controls.
const PLANS = {
  main: { title: 'The elapsed-time figures of the Routes, Transport and Hauling pages in a browser (scripts/lib/page-server.js over a constructed copy of a save)', prefix: '', label: 'the main world', scopes: ['routes', 'transport', 'hauling'], ids: null, expect: (truth) => expectationsOf(truth), controls },
  held: { title: 'The Hauling page for fleets set to a speed of their own, flown in a nebula (a constructed copy of the save, in a process of its own)', prefix: 'held speed: ', label: 'the fleets that hold a speed', scopes: ['hauling'], ids: SCOPES.hauling, expect: (truth) => expectationsOf(truth, { speed: HELD_SPEED }), controls: () => {} },
  capped: { title: 'The Routes page for a fleet that carries the cap of a nebula past a jump (a constructed copy of the save, in a process of its own)', prefix: 'carried cap: ', label: 'the carried cap', scopes: ['routes'], ids: CAPPED_CHECKS, expect: (truth) => expectationsOf(truth, { runs: CAPPED_RUNS }), controls: cappedControls },
}

const runWorld = async ({ world, probing, mutating, only, wanted, mine }) => {
  const { startPageServer } = require('./lib/page-server')
  const plan = PLANS[world]
  const { folder, file } = await constructedSave(WORLDS[world] || null)
  const cleanups = [() => fs.rmSync(folder, { recursive: true, force: true })]

  console.log(plan.title)

  try {
    const truth = await truthOf(file)
    const x = plan.expect(truth)

    plan.controls(x)

    const server = await startPageServer({ save: file })

    cleanups.push(() => server.stop())

    const chrome = await require('playwright').chromium.launch()

    cleanups.push(() => chrome.close())

    const names = Object.fromEntries(Object.entries(truth.fleets).map(([key, fleet]) => [key, fleet.name]))
    const original = (name) => fs.readFileSync(path.join(root, name), 'utf8')
    const view = async (scopes, variant) => {
      if (variant) {
        server.replace(variant.file, variant.change(original(variant.file)))
      }

      try {
        return await observe(chrome, async ({ page, step }) => {
          step('the page is opened')

          const { settle } = await prepare(page, server.url)
          const seen = {}

          if (scopes.includes('routes')) {
            step('the Routes page is driven')
            seen.routes = world === 'capped' ? await cappedRun(page, settle) : await routesRun(page, settle, truth.names, step)
          }

          if (scopes.includes('transport')) {
            step('the Transport page is driven')
            seen.transport = await transportRun(page, settle, names, step)
          }

          if (scopes.includes('hauling')) {
            step('the Hauling page is driven')
            seen.hauling = await haulingRun(page, settle, names, step)
          }

          return seen
        })
      } finally {
        if (variant) {
          server.replace(variant.file, null)
        }
      }
    }

    const baseline = await view(plan.scopes)

    if (baseline.error !== null) {
      console.error(describe('the pages', baseline))
    }

    if (probing) {
      const roles = (entries) => entries.map((entry) => `${entry.role || '·'}=${entry.text}${entry.on ? '' : ' (not drawn)'}`).join(' | ')
      const stopsOf = (screen) => screen.stops.forEach((stop) => console.log(`   stop ${stop.key}: ${stop.text} [strength ${roles(stop.strength)}; time ${roles(stop.time)}]`))

      for (const [name, screen] of Object.entries((baseline.value || {}).routes || {})) {
        console.log(`== ${name} (grouping ${screen.grouping}): ${roles(screen.tiles)}\n   notes ${screen.tileNotes.map((note) => `${note.tile}: ${roles(note.parts)}`).join(' ; ')}\n   notice ${JSON.stringify(screen.notice)} offset ${screen.offset.map(roles).join(' ; ')}`)
        screen.legs.forEach((entries) => console.log(`   leg ${roles(entries)}`))
        screen.distances.forEach((entries) => console.log(`   distance ${roles(entries)}`))
      }

      for (const [name, screen] of Object.entries((baseline.value || {}).transport || {})) {
        console.log(`== transport ${name}: opened ${JSON.stringify(screen.opened)}\n   rows ${roles(screen.cycles)}\n   values ${roles(screen.cycleValues)}`)
        stopsOf(screen)
      }

      for (const [name, screen] of Object.entries((baseline.value || {}).hauling || {})) {
        console.log(`== hauling ${name}: opened ${JSON.stringify(screen.opened)}`)
        screen.haul.forEach((row) => console.log(`   ${row.name} | ${roles(row.entries)}`))
        screen.sentences.forEach((sentence) => console.log(`   sentence ${sentence.text}\n   parts ${roles(sentence.parts)}`))
        stopsOf(screen)
      }
    }

    const base = resultsOf(baseline, x, { strict: false, label: 'the pages', ids: judgedBy(plan.ids) })

    if (!only && !probing) {
      base.forEach(({ name, result }) => report(`${plan.prefix}${name}`, result))
    }

    if (mutating && !unobserved(baseline)) {
      console.log('\nplanted faults')

      for (const fault of FAULTS.filter((variant) => wanted(variant) && mine(variant))) {
        report(`fault caught: ${fault.name}`, faultVerdict(await view([fault.scope], fault), x, fault), `fails ${fault.fails.join(', ')}`)
      }

      console.log('\nrewrites that say the same thing')

      for (const variant of BENIGN.filter((one) => wanted(one) && mine(one))) {
        const seen = await view([variant.scope], variant)
        const wrong = resultsOf(seen, x, { label: `the pages rewritten as "${variant.name}"`, ids: judgedBy(plan.ids || SCOPES[variant.scope]) }).filter(({ result }) => result !== true).map(({ id }) => id)

        report(`rewrite passes: ${variant.name}`, wrong.length === 0 ? true : `fails ${wrong.join(', ')}`)
      }
    }
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve().then(cleanup).catch(() => {})
    }
  }
}

// The worlds are processes (a process starts one page server): the main one, with the fleets at their maximum speed and no dust, runs here, and each of WORLDS, a copy of the save with rows of its own, runs as a child of this one and counts in its total. Each child is bounded by WORLD_LIMIT; one that runs past it is ended and fails the run.
const main = async () => {
  const probing = process.argv.includes('--probe')
  const mutating = !process.argv.includes('--no-mutations') && !probing
  const only = (process.argv.find((argument) => argument.startsWith('--only=')) || '').slice('--only='.length).toLowerCase()
  const wanted = (variant) => !only || only.split('|').some((text) => text && variant.name.toLowerCase().includes(text))
  const world = (process.argv.find((argument) => argument.startsWith('--world=')) || '--world=main').slice('--world='.length)
  const worldOf = (variant) => variant.world || 'main'
  const mine = (variant) => worldOf(variant) === world
  const runs = (name) => !only || [...FAULTS, ...BENIGN].some((variant) => worldOf(variant) === name && wanted(variant))

  if (!PLANS[world]) {
    throw new Error(`No world ${world}: the worlds are main, ${Object.keys(WORLDS).join(', ')}`)
  }

  if (runs(world)) {
    await runWorld({ world, probing, mutating, only, wanted, mine })
  }

  if (world === 'main' && !probing) {
    const { runChild } = require('./lib/check-pool')

    for (const name of Object.keys(WORLDS).filter((one) => runs(one))) {
      const { code, stdout, stderr, timedOut } = await runChild(__filename, [...process.argv.slice(2), `--world=${name}`], { limit: WORLD_LIMIT })
      const counted = /(\d+) of (\d+) checks passed/.exec(stdout)

      process.stdout.write(`\n${stdout.replace(/\n?\d+ of \d+ checks passed\s*$/, '\n')}`)
      process.stderr.write(stderr)

      if (timedOut || counted === null || code > 1) {
        report(`the run of ${PLANS[name].label}`, `the child ended with status ${code}${timedOut ? ' past its limit' : ''} and gave no count: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`)
      } else {
        checks += Number(counted[2])
        failures += Number(counted[2]) - Number(counted[1])
      }
    }
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures === 0 && !probing ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
