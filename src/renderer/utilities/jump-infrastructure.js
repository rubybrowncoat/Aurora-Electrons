// What a race can say of the infrastructure at the jump points it has charted: whether a point is a gate, the stabilisation orders of its own fleets, the stationary mines and buoys of its own that sit there and the stationary objects of other races it currently detects there. A figure the save cannot support is unknown, never 0: the save keeps no probe type, nothing of an object the race has not detected and no stabilisation progress of another race.

import { jumpPointNumbers } from './places'
import { ofRule, registerRule, unavailable } from './provenance'

const VERSIONS = ['2.7.x']

// DIM_MoveAction 'Stabilise Jump Point'; a destination of type 1 is the jump point of the order.
export const STABILISE_JUMP_POINT = 64
export const JUMP_POINT_DESTINATION = 1

// An object sits at a jump point when it is in the same system within this many km of it on each axis (the stored coordinates are kilometres).
export const NEAR_KM = 1

const STRUCTURE_POINT = ['FCT_JumpPoint.JumpGateStrength', 'FCT_JumpPoint.JumpGateRaceID', 'FCT_RaceJumpPointSurvey.Charted', 'FCT_RaceSysSurvey.SystemID']

registerRule({
  id: 'jumpInfrastructure.stabilisation',
  versions: VERSIONS,
  verification: 'confirmed',
  structure: ['FCT_MoveOrders.MoveActionID', 'FCT_MoveOrders.DestinationType', 'FCT_MoveOrders.DestinationID', 'FCT_MoveOrders.Arrived', 'FCT_MoveOrders.TimeRequired', ...STRUCTURE_POINT],
  note: 'Stabilising a jump point is an order of the builder\'s own fleet (move action 64); the point holds no progress. An order that has arrived is construction in progress, counting down while its time required is above 0 and waiting for completion at 0; one that has not arrived is queued or on its way. Only the race\'s own orders are readable, so another race\'s work is not known. The time required has no verified unit, so no time left is given.',
})

registerRule({
  id: 'jumpInfrastructure.ownObjects',
  versions: VERSIONS,
  units: 'salvos',
  verification: 'estimated',
  structure: ['FCT_MissileSalvo.MissileSalvoID', 'FCT_MissileSalvo.RaceID', 'FCT_MissileSalvo.MissileSpeed', 'FCT_MissileSalvo.SystemID', 'FCT_MissileSalvo.Xcor', 'FCT_MissileSalvo.Ycor', 'FCT_MissileType.SecondStageID', ...STRUCTURE_POINT],
  note: 'Mines and sensor buoys have no table of their own: they are the race\'s stationary missile salvos, one count per salvo ID. A salvo of a design with a second stage is taken as a mine and one without as a buoy; that split matches the designs\' names in a 2.7 save but is not confirmed by the game\'s rules. A salvo counts at a point when it is in the same system within 1 km of it on each axis. A salvo counts as one object, not as the missiles in it.',
  assumptions: ['a stationary salvo of a design with a second stage is a mine', 'a stationary salvo of a design without a second stage is a buoy'],
})

registerRule({
  id: 'jumpInfrastructure.detected',
  versions: VERSIONS,
  units: 'salvos',
  verification: 'confirmed',
  structure: ['FCT_Contacts.ContactID', 'FCT_Contacts.ContactType', 'FCT_Contacts.DetectRaceID', 'FCT_Contacts.LastUpdate', 'FCT_Contacts.Speed', 'FCT_Game.GameTime', ...STRUCTURE_POINT],
  note: 'Another race\'s stationary salvos are only known as contacts. A detected salvo has one contact row for each way it was detected, so the count is of distinct salvo IDs, and counts the ones whose contact was updated at the game time now. A salvo the race has not detected is not known, so a count is no evidence that none sits there; its kind (mine or buoy) is not known either. Contacts last updated earlier are kept as earlier ones. A contact with no update time is neither current nor earlier, so the detected and earlier figures of a point it sits at are unknown.',
})

registerRule({
  id: 'jumpInfrastructure.probes',
  versions: VERSIONS,
  verification: 'estimated',
  structure: ['FCT_Ship.ShipID'],
  note: 'A probe is an ordinary ship of a class the player named: the save has no probe type, and a ship cannot be told to be a probe by its class name, so no probe count is given.',
})

// What the table says in place of a figure the save cannot give.
export const UNKNOWN_TEXT = 'Unknown'

// What the table says of a detected count of 0.
export const DETECTED_ZERO_TEXT = 'None detected'

// What the table says of the far side of a point when no system is named: the far side is explored but not charted, or the point is not explored.
export const FAR_SIDE_TEXT = Object.freeze({
  uncharted: 'Far side not charted',
  unexplored: 'Unexplored',
})

// What the Gate column says: every gate is a stabilised jump point, since the save keeps no other record of a gate (`JumpGateStrength` is 0 or 1000), and the builder is the one thing it adds. A builder of 0 is not recorded and is never taken as the race's own.
export const GATE_TEXT = Object.freeze({
  none: 'No gate',
  own: 'Gate, built by the race',
  other: 'Gate, built by another race',
  unrecorded: 'Gate, builder not recorded',
  unknown: 'Gate not recorded',
})

// What the Stabilisation column says of the race's own orders.
export const STABILISATION_TEXT = Object.freeze({
  none: 'No order of the race',
  queued: 'Ship on the way',
  running: 'Being stabilised',
  awaiting: 'Arrived, awaiting completion',
})

const STATE_RANK = Object.freeze({ none: 0, queued: 1, awaiting: 2, running: 3 })

const MISSING_POSITION = 'the jump point\'s position'

const hasPosition = (point) => Number.isFinite(point.Xcor) && Number.isFinite(point.Ycor)

const near = (point, object) => Math.abs(object.Xcor - point.Xcor) < NEAR_KM && Math.abs(object.Ycor - point.Ycor) < NEAR_KM

const groupBySystem = (rows) => {
  const groups = new Map()

  rows.forEach((row) => {
    if (!groups.has(row.SystemID)) {
      groups.set(row.SystemID, [])
    }

    groups.get(row.SystemID).push(row)
  })

  return groups
}

// The race's own stabilisation orders, the stationary salvos it owns, the contacts it holds of stationary salvos and the game time (`gameTime`), read once for a page: { orders, salvos, contacts, gameTime }. The rows stay as the save has them (a salvo or contact more than once, a design the save lacks as a null `SecondStageID`); `infrastructureRows` counts each object once.
export const loadJumpInfrastructure = async (database, { GameID, RaceID }) => {
  const [[orders], [salvos], [contacts], [games]] = await Promise.all([
    database.query(`select FCT_MoveOrders.MoveOrderID, FCT_MoveOrders.DestinationID as WarpPointID, FCT_MoveOrders.FleetID, FCT_Fleet.FleetName, FCT_MoveOrders.Arrived, FCT_MoveOrders.TimeRequired
from FCT_MoveOrders
left join FCT_Fleet on FCT_Fleet.FleetID = FCT_MoveOrders.FleetID
where FCT_MoveOrders.GameID = ${GameID} and FCT_MoveOrders.RaceID = ${RaceID} and FCT_MoveOrders.MoveActionID = ${STABILISE_JUMP_POINT} and FCT_MoveOrders.DestinationType = ${JUMP_POINT_DESTINATION}`),
    database.query(`select FCT_MissileSalvo.MissileSalvoID, FCT_MissileSalvo.SystemID, FCT_MissileSalvo.Xcor, FCT_MissileSalvo.Ycor, FCT_MissileType.SecondStageID
from FCT_MissileSalvo
left join FCT_MissileType on FCT_MissileType.MissileID = FCT_MissileSalvo.MissileID and FCT_MissileType.GameID = FCT_MissileSalvo.GameID
where FCT_MissileSalvo.GameID = ${GameID} and FCT_MissileSalvo.RaceID = ${RaceID} and FCT_MissileSalvo.MissileSpeed = 0`),
    database.query(`select FCT_Contacts.ContactID, FCT_Contacts.SystemID, FCT_Contacts.Xcor, FCT_Contacts.Ycor, FCT_Contacts.LastUpdate
from FCT_Contacts
where FCT_Contacts.GameID = ${GameID} and FCT_Contacts.DetectRaceID = ${RaceID} and FCT_Contacts.ContactType = 3 and FCT_Contacts.Speed = 0`),
    database.query(`select FCT_Game.GameTime from FCT_Game where FCT_Game.GameID = ${GameID}`),
  ])

  return Object.freeze({ orders: Object.freeze(orders), salvos: Object.freeze(salvos), contacts: Object.freeze(contacts), gameTime: games.length ? games[0].GameTime : null })
}

// The builder of each jump point gate of the game: { [WarpPointID]: the race that built it, 0 or null when the save records none }. A separate read, so a save without the column loses only the builder; `infrastructureRows` looks up only the points the race has charted.
export const loadJumpBuilders = async (database, { GameID }) => {
  const [rows] = await database.query(`select FCT_JumpPoint.WarpPointID, FCT_JumpPoint.JumpGateRaceID from FCT_JumpPoint where FCT_JumpPoint.GameID = ${GameID}`)

  return Object.freeze(Object.fromEntries(rows.map((row) => [row.WarpPointID, row.JumpGateRaceID])))
}

// The race's own orders at each point: { [WarpPointID]: [{ FleetID, FleetName, state }] }, one entry for each fleet with its furthest-along order ('running', 'awaiting' or 'queued'), each order counted once by its ID. `unknown` holds the points with an order whose arrival flag is not recorded, or that has arrived but whose time required is not recorded.
const ordersByPoint = (orders) => {
  const seen = new Set()
  const byPoint = new Map()
  const unknown = new Set()

  orders.forEach((order) => {
    if (seen.has(order.MoveOrderID)) {
      return
    }

    seen.add(order.MoveOrderID)

    const arrivedKnown = [0, 1, true, false].includes(order.Arrived)
    const arrived = Boolean(order.Arrived)

    if (!arrivedKnown || (arrived && !Number.isFinite(order.TimeRequired))) {
      unknown.add(order.WarpPointID)

      return
    }

    const state = !arrived ? 'queued' : order.TimeRequired > 0 ? 'running' : 'awaiting'
    const fleets = byPoint.get(order.WarpPointID) || new Map()
    const kept = fleets.get(order.FleetID)

    if (!kept || STATE_RANK[state] > STATE_RANK[kept.state]) {
      fleets.set(order.FleetID, { FleetID: order.FleetID, FleetName: order.FleetName, state })
    }

    byPoint.set(order.WarpPointID, fleets)
  })

  return { byPoint, unknown }
}

const gateOf = (point, RaceID, builders) => {
  if (!Number.isFinite(point.JumpGateStrength)) {
    return 'unknown'
  }

  if (!(point.JumpGateStrength > 0)) {
    return 'none'
  }

  const builder = builders ? builders[point.WarpPointID] : null

  return builder > 0 ? (builder === RaceID ? 'own' : 'other') : 'unrecorded'
}

// One row for each charted jump point of `jumpPoints` (`loadJumpPoints` rows, which hold only the points the race has charted in systems it knows): { WarpPointID, SystemID, number (the game's JP number), explored, beyondSystemID (the system beyond, only for an explored point whose far point is read, else null), gate (a key of GATE_TEXT), fleets ([{ FleetID, FleetName, state }] of the race's own orders there), stabilisation, minefields, buoys, probes, detected (results; `value` of stabilisation is a key of STABILISATION_TEXT), earlier (the distinct salvos whose contacts were last updated before now, or null) }. `facts` is `loadJumpInfrastructure`'s answer, or null when the save cannot give it: `missing` then names what is lacking and every figure that rests on it is unknown. `builders` is `loadJumpBuilders`'s answer, or null when the save lacks it: a gate is then drawn with no builder recorded. The gate column rests on neither `facts` nor `missing`.
export const infrastructureRows = (jumpPoints, facts, { RaceID, missing = [], builders = null } = {}) => {
  const numbers = jumpPointNumbers(jumpPoints)
  const byId = Object.fromEntries(jumpPoints.map((point) => [point.WarpPointID, point]))
  const withheld = facts ? [] : missing.length ? missing : ['the infrastructure of the save']
  const { byPoint, unknown: unknownOrders } = facts ? ordersByPoint(facts.orders) : { byPoint: new Map(), unknown: new Set() }
  const own = new Map()
  const contacts = new Map()

  if (facts) {
    facts.salvos.forEach((salvo) => {
      if (!own.has(salvo.MissileSalvoID)) {
        own.set(salvo.MissileSalvoID, salvo)
      }
    })
    facts.contacts.filter((contact) => !own.has(contact.ContactID)).forEach((contact) => {
      const kept = contacts.get(contact.ContactID)
      const dated = Number.isFinite(contact.LastUpdate)
      const current = Boolean(kept && kept.current) || (dated && contact.LastUpdate === facts.gameTime)

      if (!kept || (dated && (!kept.dated || contact.LastUpdate > kept.LastUpdate))) {
        contacts.set(contact.ContactID, { ...contact, dated, current })
      } else {
        kept.current = current
      }
    })
  }

  const ownBySystem = groupBySystem([...own.values()])
  const contactsBySystem = groupBySystem([...contacts.values()])
  const timeKnown = Boolean(facts) && Number.isFinite(facts.gameTime)

  return jumpPoints.map((point) => {
    const placed = hasPosition(point)
    const partner = point.Explored ? byId[point.WPLink] : null
    const fleets = [...(byPoint.get(point.WarpPointID) || new Map()).values()]
    const state = fleets.reduce((best, fleet) => (STATE_RANK[fleet.state] > STATE_RANK[best] ? fleet.state : best), 'none')
    const stabilisation = withheld.length ? unavailable({ rule: 'jumpInfrastructure.stabilisation', missing: withheld }) : unknownOrders.has(point.WarpPointID) ? unavailable({ rule: 'jumpInfrastructure.stabilisation', missing: ['whether an order has arrived, or the time required of one that has'] }) : ofRule({ rule: 'jumpInfrastructure.stabilisation', value: state, inputs: { present: ['the race\'s stabilisation orders'] } })
    const here = (rows) => (placed ? (rows.get(point.SystemID) || []) : [])
    const ownHere = here(ownBySystem)
    const mines = ownHere.filter((salvo) => hasPosition(salvo) && near(point, salvo))
    const unplacedOwn = ownHere.filter((salvo) => !hasPosition(salvo)).length
    const unclassified = mines.filter((salvo) => !Number.isFinite(salvo.SecondStageID))
    const ownMissing = withheld.length ? withheld : !placed ? [MISSING_POSITION] : unplacedOwn ? [`the position of ${unplacedOwn} stationary ${unplacedOwn === 1 ? 'salvo' : 'salvos'} in the system`] : unclassified.length ? [`the design of ${unclassified.length} stationary ${unclassified.length === 1 ? 'salvo' : 'salvos'}`] : []
    const count = (test) => (ownMissing.length ? unavailable({ rule: 'jumpInfrastructure.ownObjects', missing: ownMissing }) : ofRule({ rule: 'jumpInfrastructure.ownObjects', value: mines.filter(test).length, inputs: { present: ['the race\'s stationary salvos'] } }))
    const inSystem = here(contactsBySystem)
    const seen = inSystem.filter((contact) => hasPosition(contact) && near(point, contact))
    const unplacedSeen = inSystem.filter((contact) => !hasPosition(contact)).length
    const undatedSeen = seen.filter((contact) => !contact.dated).length
    const detectedMissing = withheld.length ? withheld : !placed ? [MISSING_POSITION] : unplacedSeen ? [`the position of ${unplacedSeen} detected stationary ${unplacedSeen === 1 ? 'salvo' : 'salvos'} in the system`] : !timeKnown ? ['the game time'] : undatedSeen ? [`the update time of ${undatedSeen} detected stationary ${undatedSeen === 1 ? 'salvo' : 'salvos'} at the point`] : []
    const detected = detectedMissing.length ? unavailable({ rule: 'jumpInfrastructure.detected', missing: detectedMissing }) : ofRule({ rule: 'jumpInfrastructure.detected', value: seen.filter((contact) => contact.current).length, inputs: { present: ['the race\'s contacts'] } })

    return {
      WarpPointID: point.WarpPointID,
      SystemID: point.SystemID,
      number: numbers[point.WarpPointID],
      explored: Boolean(point.Explored),
      beyondSystemID: partner ? partner.SystemID : null,
      gate: gateOf(point, RaceID, builders),
      fleets,
      stabilisation,
      minefields: count((salvo) => salvo.SecondStageID > 0),
      buoys: count((salvo) => salvo.SecondStageID === 0),
      probes: unavailable({ rule: 'jumpInfrastructure.probes', missing: ['a probe type in the save'] }),
      detected,
      earlier: detectedMissing.length ? null : seen.filter((contact) => !contact.current).length,
    }
  })
}
