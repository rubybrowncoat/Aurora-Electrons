// The Hauling Planner's plan: what the race's colonies lack of each mineral, which colonies have some to spare, the hauls that cover each shortfall from the nearest spare stock, and what each freighter class takes to carry a haul. The rules are in docs/DATABASE.md § Hauling plan.

import { CARGO_POINTS } from './hauling'
import { routeLegs, searchRoutes } from './jump-graph'
import { hasGate, colonyEndpoint, roundTrip } from './transport'
import { registerRule } from './provenance'

// Less than a tonne is rounding.
const TONNE = 1
const SECONDS_PER_DAY = 86400

// Why a colony needs a mineral, the more pressing first, as a phrase that follows a tonnage.
export const HAUL_REASONS = {
  queue: { order: 0, label: 'for the queue' },
  reserve: { order: 1, label: 'to the reserve' },
}

const placeOf = (colony) => ({ SystemID: colony.SystemID, Xcor: colony.Xcor, Ycor: colony.Ycor })

// What a colony lacks of one mineral (a colony-minerals.js `colonyMinerals` entry), counting the mass-driver packets on their way to it as held: `queue`, what its build queue needs beyond that, and `reserve`, what it then still lacks of its reserve, counted only with `reserves`.
export const shortfallOf = (mineral, reserves = true) => {
  const held = mineral.stock + mineral.inbound
  const queue = mineral.needs - held
  const reserve = reserves ? mineral.reserve - Math.max(held, mineral.needs) : 0

  return { queue: queue >= TONNE ? queue : 0, reserve: reserve >= TONNE ? reserve : 0 }
}

// What a colony can give of one mineral: its stock above both its reserve and what its own queue needs.
export const spareOf = (mineral) => {
  const spare = mineral.stock - Math.max(mineral.reserve, mineral.needs)

  return spare >= TONNE ? spare : 0
}

// How many jump points a route crosses that aren't stabilised on both sides: a freighter without a jump drive needs a jump-capable ship with it there.
const ungatedJumps = (route) => routeLegs(route).filter((leg) => leg.kind === 'jump' && !(hasGate(leg.from) && hasGate(leg.to))).length

// The hauls that cover the shortfalls. Queue shortfalls come before reserve ones and the larger before the smaller; each draws on the colony with spare stock nearest on the charted route, then the next nearest, until it is covered, and every spare tonne is given once. `colonies`: [{ colony, minerals }], each colony with its PopulationID and place (SystemID, Xcor, Ycor); `jumpPoints`: the race's charted jump points. Returns `hauls`, one per pair of colonies, { key, from, to, km, jumps, ungated, minerals: [{ id, name, queue, reserve, tonnes }], tonnes, queue }, and `unmet`, what no colony on a charted route can cover, { key, colony, mineral, reason, tonnes }.
export const planHauls = (colonies, { jumpPoints, reserves = true }) => {
  const spare = new Map()
  const shortfalls = []

  colonies.forEach(({ colony, minerals }) => {
    minerals.forEach((mineral) => {
      const given = spareOf(mineral)
      const short = shortfallOf(mineral, reserves)

      if (given) {
        spare.set(`${colony.PopulationID}:${mineral.id}`, given)
      }

      Object.keys(HAUL_REASONS).filter((reason) => short[reason]).forEach((reason) => shortfalls.push({ colony, mineral, reason, tonnes: short[reason] }))
    })
  })

  shortfalls.sort((a, b) => HAUL_REASONS[a.reason].order - HAUL_REASONS[b.reason].order || b.tonnes - a.tonnes)

  // The other colonies on a charted route from one colony, nearest first; one search per colony that is short of something.
  const sources = new Map()
  const sourcesFor = (colony) => {
    if (!sources.has(colony.PopulationID)) {
      const search = searchRoutes(jumpPoints, [placeOf(colony)], { order: 'km' })

      sources.set(colony.PopulationID, colonies.filter((other) => other.colony.PopulationID !== colony.PopulationID).map((other) => ({ colony: other.colony, route: search.toPlace(placeOf(other.colony)) })).filter(({ route }) => route).sort((a, b) => a.route.km - b.route.km))
    }

    return sources.get(colony.PopulationID)
  }

  const hauls = new Map()
  const unmet = []

  shortfalls.forEach(({ colony, mineral, reason, tonnes }) => {
    let left = tonnes

    for (const source of sourcesFor(colony)) {
      const spareKey = `${source.colony.PopulationID}:${mineral.id}`
      const moved = Math.min(left, spare.get(spareKey) || 0)

      if (!moved) {
        continue
      }

      const key = `${source.colony.PopulationID}-${colony.PopulationID}`

      if (!hauls.has(key)) {
        hauls.set(key, { key, from: source.colony, to: colony, km: source.route.km, jumps: source.route.jumps, ungated: ungatedJumps(source.route), minerals: new Map(), tonnes: 0, queue: 0 })
      }

      const haul = hauls.get(key)

      if (!haul.minerals.has(mineral.id)) {
        haul.minerals.set(mineral.id, { id: mineral.id, name: mineral.name, queue: 0, reserve: 0, tonnes: 0 })
      }

      const carried = haul.minerals.get(mineral.id)

      carried[reason] += moved
      carried.tonnes += moved
      haul.tonnes += moved
      haul.queue += reason === 'queue' ? moved : 0
      spare.set(spareKey, spare.get(spareKey) - moved)
      left -= moved

      if (left < TONNE) {
        break
      }
    }

    if (left >= TONNE) {
      unmet.push({ key: `${colony.PopulationID}:${mineral.id}:${reason}`, colony, mineral, reason, tonnes: left })
    }
  })

  return {
    hauls: [...hauls.values()].map((haul) => ({ ...haul, minerals: [...haul.minerals.values()].sort((a, b) => b.tonnes - a.tonnes) })),
    unmet,
  }
}

// What one freighter class takes to carry a haul: the holds its cargo fills (a tonne of mineral takes two cargo points, `CARGO_POINTS.minerals`, so a hold carries half its capacity in minerals; `cargo` = 'installations' counts the haul in tonnes of installations, one cargo point each), a round trip as Transport times one (both ways at top speed, loading at the source and unloading at the destination, cargo alone, with each colony's spaceports and cargo shuttle stations from its `ShuttleCapacity` and `ServiceNames`; `status` and `problems` as roundTrip gives them), the days one ship of the class takes, and the days its `Ships` take together. The ships are taken as fully crewed and undamaged, so the loading strength is the class's `ShuttleStrength` as designed. `shipClass` carries the class figures roundTrip reads. `version` is the formula version (`loadFormulaVersion`). A trip that can't be timed has no days (null).
export const haulByClass = (haul, shipClass, shuttleTechnology, version = null, cargo = 'minerals') => {
  const trip = roundTrip([{ ...shipClass, CurrentCrew: shipClass.ClassCrew }], haul.km, { origin: colonyEndpoint(haul.from), destination: colonyEndpoint(haul.to) }, shuttleTechnology, { colonists: false, version })
  const holds = Math.ceil((haul.tonnes * CARGO_POINTS[cargo]) / shipClass.CargoCapacity)
  const tripDays = trip.tripSeconds === null ? null : trip.tripSeconds / SECONDS_PER_DAY

  return { ...trip, shipClass, holds, tripDays, oneShipDays: tripDays === null ? null : holds * tripDays, classDays: tripDays === null ? null : Math.ceil(holds / Math.max(1, shipClass.Ships)) * tripDays }
}

// The rules this module implements, registered once (utilities/provenance.js). The days a class takes lean on the loading and round-trip rules in utilities/transport.js. Evidence: docs/plans/backlog/evidence/AE-080-01.md.
registerRule({
  id: 'hauling.planTonnes',
  versions: ['2.7.x'],
  units: 't',
  verification: 'estimated',
  structure: ['FCT_Population mineral stock and reserve', 'FCT_IndustrialProjects and shipyard tasks', 'FCT_MassDriverPackets'],
  note: 'A colony is short of a mineral by what its build queue needs beyond its stock and the packets on their way, and by its reserve when that is asked for; it gives what it holds above its reserve and its own queue. Which colony covers which shortfall (the nearest with stock to spare first) is the planner\'s choice, not a game rule.',
  assumptions: ['the queue\'s needs are what the build queue asks for now', 'the nearest colony with stock to spare supplies first', 'minerals already in a freighter\'s hold are not counted'],
})

registerRule({
  id: 'hauling.haulDays',
  versions: ['2.7.x'],
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_ShipClass.CargoCapacity, MaxSpeed'],
  note: 'Holds a class needs for the haul times its round trip (`transport.roundTrip`, cargo only), for one ship and for all the class\'s ships. The ships are taken as fully crewed and undamaged.',
  assumptions: ['full holds', 'fully crewed, undamaged ships', 'top speed both ways'],
})
