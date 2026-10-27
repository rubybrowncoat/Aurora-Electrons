// The fuel ledger of a run: the litres each ship of a fleet carries from stop to stop, what a service at a stop can give it (a colony's refuelling point, or stationary tankers through the donor result of utilities/fuel-donors.js), what each source has left, how long the service takes and which ship limits the run. The rules and what the saves hold: docs/plans/backlog/evidence/AE-083-01.md (sections 2, 3, 5, 6 and 7), docs/plans/backlog/evidence/AE-100-01.md and docs/plans/backlog/evidence/AE-083-02.md.
//
// The module is pure: it takes the fleet's profile (utilities/fleet-profile.js), the legs of the run as kilometres, the stops where the fleet stands, the fuel sites a loader read (`loadFuelSites`) and the player's reserves, and searches nothing. A source shared between ships or between fleets is debited ship by ship and fleet by fleet in the game's own order, never twice: `stocks` carries what each source has available into a plan and `stocksAfter` out of it, so a host threads one fleet's draw into the next (`netLedgers`).

import { LOW_RATE_RECIPIENT_HS, REASONS as DONOR_REASONS, fuelDonor, isLowRate, loadFuelDonors } from './fuel-donors'
import { columnsOf } from './mine-bootstrap-data'
import { ofRule, registerRule, ruleSupports, unavailable } from './provenance'

const LEDGER_VERSIONS = ['2.7.x']
const UNVERIFIED_SAVE = 'The save is not 2.7-shaped and has no version label, so the fuel service rules are not checked for its game version.'
const SECONDS_PER_HOUR = 3600

registerRule({
  id: 'fuelService.legBurn',
  versions: LEDGER_VERSIONS,
  units: 'L',
  verification: 'estimated',
  structure: ['FCT_ShipClass.FuelEfficiency, EnginePower', 'FCT_ClassComponent', 'FCT_DamagedComponent', 'FCT_Ship.OverhaulFactor', 'FCT_Fleet.Speed'],
  note: 'The fuel a ship burns on a leg of a run: the litres an hour it burns at the share of its power the fleet sails at, over the hours the leg takes at the fleet\'s speed. A leg completes when the ship holds at least that much; a ship that holds less runs dry part of the way along it and holds the fleet at 1 km/s from there. Carried and towed ships burn none. The burn is the rule of the fleet profile; the leg figure is arithmetic over it and is not compared with fuel the game stores.',
  assumptions: ['the burn is the rate of the fleet\'s speed over the whole leg, as a nebula that lowers the speed lowers the power in step'],
})

registerRule({
  id: 'fuelService.colonyFill',
  versions: LEDGER_VERSIONS,
  units: 'L',
  verification: 'estimated',
  structure: ['FCT_Population.FuelStockpile', 'FCT_PopulationInstallations', 'DIM_PlanetaryInstallation.MassRefuelling', 'FCT_Race.MaxRefuellingRate'],
  note: 'What a colony gives a fleet at a stop: a colony of the race with a spaceport or refuelling station and a stock above 0 fills each ship, ship by ship, from the one stock until the stock is gone. The population count is not a gate. The planner draws only the stock above the local reserve the player keeps; the colony\'s refinery output is not counted.',
  assumptions: ['the ships are served in the order of their IDs, which the game\'s load order suggests and no save confirms: it changes which ship goes short when the stock runs out, never the total, the residual or the hours'],
})

registerRule({
  id: 'fuelService.tankerFill',
  versions: LEDGER_VERSIONS,
  units: 'L',
  verification: 'estimated',
  structure: ['FCT_Fleet.LastMoveTime', 'FCT_Game.GameTime', 'FCT_MoveOrders', 'DIM_MoveAction.StationaryAction', 'FCT_Ship.Fuel, RefuelPriority', 'FCT_ShipClass.MinimumFuel, RefuellingRate, RefuelPriority, FuelCapacity'],
  note: 'What a stationary tanker fleet gives a fleet at a stop: the fleet must not have moved in the last pulse and its first order must be a stationary one; its tankers give the fuel above the larger of the class minimum and the player\'s reserve through an undamaged Transfer - Fuel system, the one with the highest share of its tank first, to the recipients in the order of their refuelling priority, the class priority and the size of their tank. A tanker whose class rate is under 20,000 L/h serves recipients of 20 hull spaces or less only.',
  assumptions: ['a tanker\'s harvesting is not counted', 'the split between recipients when a tanker runs dry in the middle of one follows the priority order and may differ from the game\'s, which depends on the subpulse'],
})

registerRule({
  id: 'fuelService.fillHours',
  versions: LEDGER_VERSIONS,
  units: 'h',
  verification: 'estimated',
  structure: ['FCT_Race.MaxRefuellingRate', 'FCT_ShipClass.RefuellingRate'],
  note: 'The hours a service takes, from the rates and not from the length of the subpulse, which varies in a game. A colony serves each ship at the race\'s refuelling rate, so the time is that of the ship that receives most. Tankers serve one recipient at a time each, so the time is at least the litres over the rates of the eligible tankers together, and at least the largest recipient over the highest rate: a lower bound.',
  assumptions: ['the pulse in which a stock runs out is not counted'],
})

registerRule({
  id: 'fuelService.ledger',
  versions: LEDGER_VERSIONS,
  units: '',
  verification: 'estimated',
  structure: ['FCT_Ship.Fuel', 'FCT_ShipClass.FuelCapacity', 'fuelService.legBurn', 'fuelService.colonyFill', 'fuelService.tankerFill', 'fuelService.fillHours'],
  note: 'Whether a run fits the fuel the fleet carries and the services it can use: every leg completes for every ship, with the fuel each holds on leaving the stop, after the service there. A service that cannot be decided leaves the verdict unknown, whether or not the fuel aboard would carry the run.',
  assumptions: ['the fleet starts at the first stop with the fuel it has aboard now'],
})

registerRule({
  id: 'fuelService.netting',
  versions: LEDGER_VERSIONS,
  units: 'L',
  verification: 'assumed',
  structure: ['fuelService.colonyFill', 'fuelService.tankerFill'],
  note: 'The fleets shown together draw on one stock one after another in a stated order, each fleet\'s whole run before the next. It is a snapshot of what is left for each fleet, not a timeline: a fleet ahead draws its closing fill before the fleet behind draws its first.',
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// What each reason of a service says, by its code: the reasons of the donor result and the ones a colony, a stationary fleet and a shared stock add. A stop that cannot serve, or cannot be decided, gives one of these.
export const SERVICE_REASONS = Object.freeze({
  ...DONOR_REASONS,
  'no-colony': 'No colony of the race stands here',
  'points-unknown': 'The installations of the colony are not in the save',
  'no-refuelling-point': 'The colony has no spaceport or refuelling station',
  'stock-unknown': 'The fuel stock of the colony is not in the save',
  'stock-empty': 'The colony holds no fuel',
  'reserve-unread': 'The reserve records are not read',
  'held-by-reserve': 'The fuel is no more than the reserve kept',
  'rate-unknown': 'The refuelling rate of the race is not in the save',
  'taken-ahead': 'The fuel is drawn by the fleets ahead',
  'drawn-earlier': 'The fuel is drawn at an earlier stop of the run',
  'draw-ahead-unknown': 'What the fleets ahead draw is not known',
  'moved-unknown': 'Whether the fleet moved in the last pulse is not in the save',
  'moved-this-pulse': 'The fleet moved in the last pulse',
  'orders-unknown': 'The first order of the fleet is not in the save',
  'first-order-not-stationary': 'The first order of the fleet is not a stationary one',
  'no-eligible-tanker': 'No ship of the fleet can give fuel',
  'donors-unknown': 'Whether a ship of the fleet can give fuel is not in the save',
  'donors-partial': 'A ship of the fleet cannot be decided, so what the others leave short is not known',
  'order-unknown': 'The tank of a ship of the fleet is not in the save, so the order the tankers give in is not known',
  'priority-unknown': 'The refuelling priority of a ship is not in the save, so the order the ships are served in is not known',
  'required-unknown': 'What a ship must keep back, or what its run burns, is not in the save, so the litres it needs are not known',
  'sites-unread': 'The refuelling sites are not read',
  'earlier-doubt': 'An input of the run is not known from an earlier stop on, so this service is not',
})

// The kinds of service and what they are called.
export const SERVICE_KINDS = Object.freeze({ colony: 'Colony', tankers: 'Stationary tankers' })

// The words a source's heading gives its permission, by the permission of the service.
export const SERVICE_VERDICTS = Object.freeze({ allowed: 'Can serve', blocked: 'Cannot serve', unknown: 'Not known' })

// The words that mark a figure of hours as a lower bound, by the bound the service gives: `before` leads the figure ("at least 3 h") and `after` follows it ("3 h or more"). A page writes the one it uses; a reader of a written figure accepts these and no other word.
export const SERVICE_BOUNDS = Object.freeze({ 'at-least': Object.freeze({ before: 'at least', after: 'or more' }) })

const pass = (gate) => ({ gate, status: 'pass', reason: null })
const fail = (gate, reason) => ({ gate, status: 'fail', reason })
const unknown = (gate, reason) => ({ gate, status: 'unknown', reason })

const EARLIER_DOUBT = 'earlier-doubt'

// The causes of a blocked service that no demand of the run changes: a source with these reasons is no source a doubted run may touch, while any other block (a recipient too large for what is left, a stock drawn ahead) was worked out on the demand the run had when it was doubted, which the unknown input may have changed.
const FIXED_BLOCKS = new Set(['no-colony', 'no-refuelling-point', 'stock-empty', 'held-by-reserve', 'moved-this-pulse', 'first-order-not-stationary', 'no-eligible-tanker', 'no-surplus'])

// The permission a list of gates gives, as the donor result decides it: a gate that fails wins over one that cannot be decided, and with none failing the first undecided gate leaves the permission unknown.
const decide = (gates) => {
  const failed = gates.find((gate) => gate.status === 'fail')
  const undecided = gates.find((gate) => gate.status === 'unknown')
  const decisive = failed || undecided || null

  return { permission: failed ? 'blocked' : undecided ? 'unknown' : 'allowed', gate: decisive ? decisive.gate : null, reason: decisive ? decisive.reason : null, gates }
}

const colonyKey = (PopulationID) => `colony:${PopulationID}`
const tankerKey = (ShipID) => `tanker:${ShipID}`

const EMPTY_AHEAD = Object.freeze({ taken: new Map(), unknown: new Map() })

// The litres the fleets ahead took of a source, one entry per fleet.
const mergeTaken = (list) => [...list.reduce((total, item) => total.set(item.fleet, total.get(item.fleet) === null || item.litres === null ? null : (total.get(item.fleet) || 0) + item.litres), new Map())].map(([fleet, litres]) => ({ fleet, litres }))

// The fuel a ship burns on a leg: the profile's burn over the hours the leg takes at the fleet's speed, 0 for a ship that is carried or towed, null when the leg's distance or the speed is not known.
const legLitres = (participant, km, cruise) => {
  if (participant.role !== 'independent') {
    return 0
  }

  return isNumber(km) && isNumber(cruise) && cruise > 0 && isNumber(participant.burn) ? (participant.burn * km) / cruise / SECONDS_PER_HOUR : null
}

// The fuel each ship of a profile burns on a leg of `km`: [{ ship, litres }] in the order of the profile's participants, litres null where the leg's input is not known.
export const legBurn = (profile, km) => profile.participants.map((participant) => ({ ship: participant.ship, litres: legLitres(participant, km, profile.cruise) }))

const nameOf = (ship) => ship.ShipName || ship.ClassName || 'A ship'

const rank = (value) => (isNumber(value) ? value : Infinity)

// The share of a tank, 0 for a tank that holds nothing.
const fractionOf = (ship, fuel = ship.Fuel) => (isNumber(fuel) && isNumber(ship.FuelCapacity) && ship.FuelCapacity > 0 ? fuel / ship.FuelCapacity : 0)

// The recipients of a service as it takes them: one entry per ship with its fuel now (null when not known), its tank, its size in hull spaces and the litres it wants (null when not known). `ships` are the ledger's ships; `fuel` Map of the fuel each holds; `wants` Map of the litres each is to be given.
const recipientsOf = (ships, fuel, wants) => ships.map((entry) => ({ id: entry.id, name: entry.name, ship: entry.ship, fuel: fuel.get(entry.id), capacity: entry.capacity, size: entry.size, want: wants.has(entry.id) ? wants.get(entry.id) : null }))

// The hours the largest receipt takes at `rate` L/h per ship.
const hoursOf = (litres, rate) => (isNumber(rate) && rate > 0 ? litres / rate : null)

// A colony's service to the recipients. `site` is the colony row of `loadFuelSites` (null when no colony of the race stands at the stop); `recipients` in the order the game serves them (`recipientsOf`, by ID); `options`: `hubEra`, `rate` (the race's refuelling rate per ship), `reserve` (the player's reserve at the colony, 0 when the records are read and hold none, null when they are not read), `saved` (the litres above the reserve the save holds), `now` (the litres available now, after what the run and the fleets ahead drew; null when not known), `entry` (the litres available when the plan began), `ahead` ({ taken, unknown } of `netLedgers`) and `version`.
// The result: `permission` ('allowed', 'blocked' or 'unknown': unknown wherever an input of the service is not known, the recipients' litres, the reserve records, a stock a fleet ahead left not known), `gate`, `reason` and `gates`, the figures (`stock`, `reserve`, `entry`, `available`, `received`, `residual`), `perShip` (Map of ShipID to litres received), `hours` (null when not known), `limiter` ('stock', 'rate' or 'none') and `limiting` (the ship that receives most), `exhausted` (a ship was left short by the stock) and `drawn` (Map of the source's key to the litres taken).
export const colonyService = (site, recipients, { hubEra = 0, rate = null, reserve = null, saved = null, now = null, entry = null, ahead = EMPTY_AHEAD, version = null } = {}) => {
  const key = site ? colonyKey(site.PopulationID) : null
  const stock = site && isNumber(site.FuelStockpile) ? site.FuelStockpile : null
  const takenBy = key ? (ahead.taken.get(key) || []) : []
  const unknownBy = key ? (ahead.unknown.get(key) || []) : []
  const reserveRead = isNumber(reserve)
  const keys = site ? [colonyKey(site.PopulationID)] : []
  const gates = [
    hubEra ? unknown('version', 'hub-era') : pass('version'),
    site ? pass('record') : fail('record', 'no-colony'),
    !site ? pass('point') : !isNumber(site.RefuellingPoints) ? unknown('point', 'points-unknown') : site.RefuellingPoints > 0 ? pass('point') : fail('point', 'no-refuelling-point'),
    !site ? pass('stock') : stock === null ? unknown('stock', 'stock-unknown') : stock > 0 ? pass('stock') : fail('stock', 'stock-empty'),
    !site || stock === null || stock <= 0 ? pass('reserve') : !reserveRead ? unknown('reserve', 'reserve-unread') : stock > reserve ? pass('reserve') : fail('reserve', 'held-by-reserve'),
    !site || !reserveRead || saved === null || saved <= 0 ? pass('draw') : now === null ? unknown('draw', 'draw-ahead-unknown') : now > 0 ? pass('draw') : fail('draw', isNumber(entry) && entry <= 0 ? 'taken-ahead' : 'drawn-earlier'),
    !site || (isNumber(rate) && rate > 0) ? pass('rate') : unknown('rate', 'rate-unknown'),
    !site || recipients.every((recipient) => isNumber(recipient.want)) ? pass('inputs') : unknown('inputs', 'required-unknown'),
  ]
  const decided = decide(gates)
  const serves = decided.permission === 'allowed'
  const wanting = recipients.filter((recipient) => isNumber(recipient.want) && recipient.want > 0)
  const perShip = new Map()
  let left = serves && isNumber(now) ? now : 0

  if (serves) {
    wanting.forEach((recipient) => {
      const give = Math.min(recipient.want, left)

      left -= give
      perShip.set(recipient.id, give)
    })
  }

  const received = [...perShip.values()].reduce((total, litres) => total + litres, 0)
  const exhausted = serves && wanting.some((recipient) => perShip.get(recipient.id) < recipient.want)
  const largest = serves ? [...perShip.entries()].reduce((best, entryOfShip) => (!best || entryOfShip[1] > best[1] ? entryOfShip : best), null) : null
  const supported = ruleSupports('fuelService.colonyFill', version) === true
  const assumptions = [...(supported ? [] : [UNVERIFIED_SAVE]), ...(exhausted ? ['which ship goes short when the stock runs out follows the order the ships load in, which is inferred'] : [])]

  return {
    kind: 'colony',
    key,
    name: site ? site.PopName : '',
    ...decided,
    stock,
    reserve: reserveRead ? reserve : null,
    saved,
    entry,
    available: serves ? now : null,
    takenAhead: takenBy,
    unknownAhead: unknownBy,
    perShip,
    received,
    residual: serves && isNumber(now) ? left : null,
    hours: serves ? (received > 0 && largest ? hoursOf(largest[1], rate) : 0) : null,
    bound: 'exact',
    limiter: !serves ? null : exhausted ? 'stock' : received > 0 ? 'rate' : 'none',
    limiting: largest && largest[1] > 0 ? recipients.find((recipient) => recipient.id === largest[0]) : null,
    exhausted,
    rate,
    conditional: site && site.Refineries > 0 && site.FuelProdStatus ? [`Its ${site.Refineries === 1 ? 'refinery makes' : 'refineries make'} fuel, which is not counted`] : [],
    drawn: new Map(serves && key && isNumber(now) ? [[key, received]] : []),
    after: new Map(serves && key && isNumber(now) ? [[key, left]] : []),
    keys,
    assumptions,
  }
}

// The donors of a stationary fleet as the allocation takes them: the ships of the fleet with their donor result, the surplus each has entering the plan (`entrySurplus`) and now (`nowSurplus`), the richest share of the tank first.
const tankersOf = (fleet, { reserves, reserveRead, version, entrySurplus, nowSurplus }) => fleet.ships.map((ship) => {
  const donor = fuelDonor(ship, { playerReserve: reserves && reserveRead ? reserves.ship(ship) : null, reserveRead, version })
  const key = tankerKey(ship.ShipID)
  const now = nowSurplus(key, donor.eligibleSurplus)
  const fuelNow = isNumber(donor.eligibleSurplus) && isNumber(now) ? ship.Fuel - (donor.eligibleSurplus - now) : ship.Fuel

  return { ship, key, donor, name: nameOf(ship), rate: ship.RefuellingRate, saved: donor.eligibleSurplus, entry: entrySurplus(key, donor.eligibleSurplus), now, fraction: fractionOf(ship, fuelNow), orderKnown: isNumber(ship.FuelCapacity) }
}).sort((a, b) => b.fraction - a.fraction || a.ship.ShipID - b.ship.ShipID)

// Whether a tanker serves a recipient: true, false, or null when the recipient's size is not known and the tanker's rate is one that limits the size.
const servesRecipient = (tanker, recipient) => (!isLowRate(tanker.rate) ? true : !isNumber(recipient.size) ? null : recipient.size <= LOW_RATE_RECIPIENT_HS)

// What `FCT_MoveOrders` and `DIM_MoveAction` say of a first order: true for a stationary action, false for one that is not, null when not stated. The column holds the text FALSE and the number 1 side by side.
export const stationaryOf = (value) => {
  if (value === null || value === undefined) {
    return null
  }

  const text = String(value).trim().toUpperCase()

  return text === '1' || text === 'TRUE' ? true : text === '0' || text === 'FALSE' ? false : null
}

// A stationary tanker fleet's service to the recipients. `fleet` is a fleet of `loadFuelSites` ({ FleetID, FleetName, LastMoveTime, FirstOrderStationary, ships }); `recipients` in the game's order (`recipientsOf`, then by refuelling priority, class priority and the size of the tank); `options`: `gameTime`, `reserves` ({ ship(row) }) and `reserveRead`, `version`, `hubEra` as the donor result takes it from the ship row, `entrySurplus(key, saved)` and `nowSurplus(key, saved)` (the litres each tanker has entering the plan and now) and `ahead`.
// The result is the colony service's, with `tankers` (each { name, rate, permission, reason, saved, entry, drawn, residual }), `bound` 'at-least' on the hours and `drawn` the litres taken from each tanker's key. The service is not known (permission 'unknown') wherever an input of it is not: a tanker that cannot be decided, a recipient's size, litres wanted or priority, the tank that orders the tankers, and the records or the levels a fleet ahead left not known.
export const tankerService = (fleet, recipients, { gameTime = null, reserves = null, reserveRead = true, version = null, entrySurplus = (_key, saved) => saved, nowSurplus = (_key, saved) => saved, ahead = EMPTY_AHEAD } = {}) => {
  const tankers = tankersOf(fleet, { reserves, reserveRead, version, entrySurplus, nowSurplus })
  const eligible = tankers.filter((tanker) => tanker.donor.permission === 'allowed')
  const undecided = tankers.filter((tanker) => tanker.donor.permission === 'unknown')
  const movedUnknown = !isNumber(fleet.LastMoveTime) || !isNumber(gameTime)
  const orders = fleet.FirstOrderStationary
  const wanting = recipients.filter((recipient) => isNumber(recipient.want) && recipient.want > 0)
  const relevant = eligible.filter((tanker) => !wanting.length || wanting.some((recipient) => servesRecipient(tanker, recipient) !== false))
  const totalOf = (field, pool) => (pool.some((tanker) => !isNumber(tanker[field])) ? null : pool.reduce((total, tanker) => total + tanker[field], 0))
  const drawable = relevant.length ? relevant : eligible
  const entryTotal = totalOf('entry', drawable)
  const nowTotal = totalOf('now', drawable)
  const savedTotal = totalOf('saved', eligible)
  const held = eligible.reduce((total, tanker) => total + (isNumber(tanker.donor.heldByReserve) ? tanker.donor.heldByReserve : 0), 0)
  const unknownBy = [...new Set(eligible.flatMap((tanker) => ahead.unknown.get(tanker.key) || []))]
  const everyServes = (recipient) => eligible.map((tanker) => servesRecipient(tanker, recipient))
  const served = wanting.filter((recipient) => everyServes(recipient).includes(true))
  const sizeDoubt = wanting.some((recipient) => !isNumber(recipient.size) && eligible.some((tanker) => servesRecipient(tanker, recipient) === null))
  const hubEra = tankers.some((tanker) => tanker.ship.HubEra)
  const takenBy = mergeTaken([...eligible, ...undecided].flatMap((tanker) => ahead.taken.get(tanker.key) || []))
  // A tanker not decided may serve, give to or take from any recipient, so it softens every failure of the pool gates: some litres of it could cure them.
  const maybe = (gate) => (undecided.length > 0 && gate.status === 'fail' ? unknown(gate.gate, 'donors-partial') : gate)
  const givers = relevant.filter((tanker) => isNumber(tanker.now) && tanker.now > 0)
  // The first input of the service that is not known, which leaves everything the service gives not known: the litres a ship wants, the size of a recipient a low-rate tanker may or may not serve, the tank that puts the giving tankers in order and the priority that puts the recipients in order.
  const input = recipients.some((recipient) => !isNumber(recipient.want)) ? 'required-unknown' : sizeDoubt ? 'recipient-unknown' : givers.length > 1 && givers.some((tanker) => !tanker.orderKnown) ? 'order-unknown' : wanting.length > 1 && wanting.some((recipient) => !isNumber(recipient.ship.RefuelPriority) || !isNumber(recipient.ship.ClassRefuelPriority)) ? 'priority-unknown' : null
  const gates = [
    hubEra ? unknown('version', 'hub-era') : pass('version'),
    movedUnknown ? unknown('moved', 'moved-unknown') : fleet.LastMoveTime === gameTime ? fail('moved', 'moved-this-pulse') : pass('moved'),
    orders === null || orders === undefined ? unknown('stationary', 'orders-unknown') : Number(orders) === 1 ? pass('stationary') : fail('stationary', 'first-order-not-stationary'),
    eligible.length ? (undecided.length ? unknown('donors', 'donors-partial') : pass('donors')) : undecided.length ? unknown('donors', 'donors-unknown') : fail('donors', 'no-eligible-tanker'),
    maybe(!eligible.length ? pass('reserve') : savedTotal === null ? unknown('reserve', 'reserve-unread') : savedTotal > 0 ? pass('reserve') : fail('reserve', held > 0 ? 'held-by-reserve' : 'no-surplus')),
    maybe(!eligible.length || !relevant.length || savedTotal === null || savedTotal <= 0 ? pass('draw') : nowTotal === null ? unknown('draw', 'draw-ahead-unknown') : nowTotal > 0 ? pass('draw') : fail('draw', entryTotal !== null && entryTotal <= 0 ? 'taken-ahead' : 'drawn-earlier')),
    !eligible.length || !wanting.length || served.length ? pass('recipient') : sizeDoubt ? unknown('recipient', 'recipient-unknown') : undecided.length ? unknown('recipient', 'donors-partial') : fail('recipient', 'recipient-too-large'),
    input ? unknown('inputs', input) : pass('inputs'),
  ]
  const decided = decide(gates)
  const serves = decided.permission === 'allowed'
  const order = [...wanting].sort((a, b) => rank(a.ship.RefuelPriority) - rank(b.ship.RefuelPriority) || rank(a.ship.ClassRefuelPriority) - rank(b.ship.ClassRefuelPriority) || rank(a.capacity) - rank(b.capacity) || a.id - b.id)
  const left = new Map(eligible.map((tanker) => [tanker.key, isNumber(tanker.now) ? tanker.now : 0]))
  const perShip = new Map()
  const drawn = new Map()

  if (serves) {
    order.forEach((recipient) => {
      let need = recipient.want

      eligible.forEach((tanker) => {
        if (need > 0 && servesRecipient(tanker, recipient) === true && left.get(tanker.key) > 0) {
          const give = Math.min(need, left.get(tanker.key))

          need -= give
          left.set(tanker.key, left.get(tanker.key) - give)
          drawn.set(tanker.key, (drawn.get(tanker.key) || 0) + give)
          perShip.set(recipient.id, (perShip.get(recipient.id) || 0) + give)
        }
      })
    })
  }

  const received = [...perShip.values()].reduce((total, litres) => total + litres, 0)
  const exhausted = serves && served.some((recipient) => (perShip.get(recipient.id) || 0) < recipient.want)
  const rates = eligible.filter((tanker) => isNumber(tanker.now) && tanker.now > 0 && isNumber(tanker.rate) && tanker.rate > 0).map((tanker) => tanker.rate)
  const pooled = rates.reduce((total, litres) => total + litres, 0)
  const top = rates.length ? Math.max(...rates) : 0
  const largest = serves ? [...perShip.entries()].reduce((best, entryOfShip) => (!best || entryOfShip[1] > best[1] ? entryOfShip : best), null) : null
  const supported = ruleSupports('fuelService.tankerFill', version) === true
  const harvesters = tankers.filter((tanker) => tanker.ship.Harvester).length

  return {
    kind: 'tankers',
    key: `fleet:${fleet.FleetID}`,
    name: fleet.FleetName,
    ...decided,
    stock: undecided.length ? null : savedTotal,
    reserve: null,
    saved: undecided.length ? null : savedTotal,
    entry: undecided.length || sizeDoubt ? null : entryTotal,
    available: serves ? nowTotal : null,
    takenAhead: takenBy,
    unknownAhead: unknownBy,
    tankers: tankers.map((tanker) => ({ key: tanker.key, name: tanker.name, rate: tanker.rate, permission: tanker.donor.permission, reason: tanker.donor.reason, saved: tanker.saved, entry: tanker.entry, drawn: drawn.get(tanker.key) || 0, known: decided.permission !== 'unknown', residual: tanker.donor.permission === 'allowed' && isNumber(tanker.now) && isNumber(left.get(tanker.key)) && serves ? left.get(tanker.key) : null })),
    perShip,
    received,
    residual: serves && nowTotal !== null ? nowTotal - received : null,
    hours: serves ? (received > 0 && pooled > 0 ? Math.max(received / pooled, largest[1] / top) : 0) : null,
    bound: 'at-least',
    limiter: !serves ? null : exhausted ? 'stock' : received > 0 ? 'rate' : 'none',
    limiting: largest && largest[1] > 0 ? recipients.find((recipient) => recipient.id === largest[0]) : null,
    exhausted,
    rate: pooled || null,
    conditional: harvesters ? [`${harvesters === 1 ? 'A ship of the fleet harvests' : `${harvesters} ships of the fleet harvest`} fuel, which is not counted`] : [],
    drawn,
    after: new Map(serves ? eligible.map((tanker) => [tanker.key, isNumber(tanker.now) ? left.get(tanker.key) : null]) : []),
    keys: tankers.filter((tanker) => tanker.donor.permission !== 'blocked').map((tanker) => tanker.key),
    assumptions: supported ? [] : [UNVERIFIED_SAVE],
  }
}

// The colony the stop is: the colony row of the sites for the stop's PopulationID, null for a place that is no colony or one the sites do not list.
const colonyAt = (stop, sites) => (stop.PopulationID === null || stop.PopulationID === undefined ? null : sites.colonies.find((colony) => colony.PopulationID === stop.PopulationID) || null)

// The stationary fleets of the sites at a stop, by FleetID: those in orbit of the colony's body, or for a place that is no colony those in the same system at the stop's position out of any orbit. The fleet that is being planned is never its own source.
const fleetsAt = (stop, colony, sites, ownFleetId) => sites.fleets.filter((fleet) => fleet.FleetID !== ownFleetId && (colony ? isNumber(colony.SystemBodyID) && colony.SystemBodyID > 0 && fleet.OrbitBodyID === colony.SystemBodyID : fleet.SystemID === stop.SystemID && !(fleet.OrbitBodyID > 0) && fleet.Xcor === stop.Xcor && fleet.Ycor === stop.Ycor)).sort((a, b) => a.FleetID - b.FleetID)

// The litres of a source as the plan sees them: its level entering the plan (the `stocks` the host threaded in, else what the save holds) and its level now (after what this run drew). A level of null is a source whose draw is not known.
const levelsOf = (stocks) => {
  const now = new Map(stocks)

  return {
    entry: (key, saved) => (stocks.has(key) ? stocks.get(key) : saved),
    now: (key, saved) => (now.has(key) ? now.get(key) : saved),
    apply: (after) => after.forEach((level, key) => now.set(key, level)),
    taint: (keys) => keys.forEach((key) => now.set(key, null)),
    snapshot: () => new Map(now),
  }
}

const reserveOfColony = (reserves, site) => (reserves ? (reserves.colony(site.PopulationID) ?? 0) : null)

const savedOfColony = (site, reserve) => (site && isNumber(site.FuelStockpile) && isNumber(reserve) ? Math.max(0, site.FuelStockpile - reserve) : null)

// The service at a stop: the colony's, when one stands there (or nothing else does), then each stationary fleet's, each taking what the ships still want. `context`: { ships (the ledger's ships), fuel (Map of the fuel each holds now), sites, reserves ({ ship(row), colony(id) } or null while the records are not read), version, gameTime, levels, ahead, ownFleetId }; `wants` the Map of the litres each ship is to be given (a ship with no entry is not known to want any, so nothing is allocated to it and what is received is not complete). Changes nothing of `context`.
// The result: `stop`, `services` (each as `colonyService` and `tankerService` give them), `permission` ('allowed' when any serves, else 'unknown' when any cannot be decided, else 'blocked'), `received` (Map of ShipID to litres), `hours` (the hours of the services, one after another), `bound` ('at-least' when a tanker service sets the hours) and `after` (Map of each source's key to its level after the service).
export const serviceAt = (stop, context, wants) => {
  const { ships, fuel, sites, reserves, version, gameTime, levels, ahead = EMPTY_AHEAD, ownFleetId = null } = context
  const colony = colonyAt(stop, sites)
  const fleets = fleetsAt(stop, colony, sites, ownFleetId)
  const reserveRead = reserves !== null
  const tanks = ships.filter((entry) => entry.tank)
  const services = []
  const remaining = new Map(wants)
  const after = new Map()
  const take = (service) => {
    service.perShip.forEach((litres, id) => remaining.set(id, Math.max(0, remaining.get(id) - litres)))
    service.after.forEach((level, key) => after.set(key, level))
    services.push(service)
  }

  if (colony || !fleets.length) {
    const reserve = colony && reserveRead ? reserveOfColony(reserves, colony) : null
    const saved = savedOfColony(colony, reserve)
    const key = colony ? colonyKey(colony.PopulationID) : null
    const now = key ? levels.now(key, saved) : null
    const entry = key ? levels.entry(key, saved) : null

    take(colonyService(colony, recipientsOf(tanks, fuel, remaining).sort((a, b) => a.id - b.id), { hubEra: sites.hubEra, rate: sites.rates.MaxRefuellingRate, reserve, saved, now, entry, ahead, version }))
  }

  fleets.forEach((fleet) => {
    take(tankerService(fleet, recipientsOf(tanks, fuel, remaining), { gameTime, reserves, reserveRead, version, entrySurplus: (key, saved) => levels.entry(key, saved), nowSurplus: (key, saved) => levels.now(key, saved), ahead }))
  })

  const allowed = services.some((service) => service.permission === 'allowed')
  const undecided = services.some((service) => service.permission === 'unknown')
  const received = new Map()

  services.forEach((service) => service.perShip.forEach((litres, id) => received.set(id, (received.get(id) || 0) + litres)))

  return {
    stop,
    services,
    permission: allowed ? 'allowed' : undecided ? 'unknown' : 'blocked',
    received,
    hours: services.reduce((total, service) => total + (isNumber(service.hours) ? service.hours : 0), 0),
    bound: services.some((service) => service.permission === 'allowed' && service.kind === 'tankers' && service.hours > 0) ? 'at-least' : 'exact',
    after,
  }
}

// A source of a service as a run reads it from the first stop that is not known: not known, with no figure of it, whatever it would give.
const unreadPart = (part) => {
  const own = part.permission === 'unknown'

  return { ...part, permission: 'unknown', gate: own ? part.gate : 'run', reason: own ? part.reason : EARLIER_DOUBT, stock: null, saved: null, entry: null, available: null, received: null, residual: null, hours: null, limiter: null, limiting: null, perShip: new Map(), drawn: new Map(), after: new Map(), tankers: part.tankers ? part.tankers.map((tanker) => ({ ...tanker, saved: null, entry: null, drawn: null, known: false, residual: null })) : part.tankers }
}

// The service of a stop as a run reads it from the first stop that is not known: every source reads not known, nothing is received, and the hours are not known.
const unreadService = (service) => ({ ...service, services: service.services.map(unreadPart), permission: 'unknown', received: new Map(), hours: null, bound: 'exact', after: new Map() })

const NETTING_ASSUMPTION = 'the fleets draw on a shared stock one after another in the order given, each fleet\'s whole run before the next, which is not the order in time'

const sum = (values) => values.reduce((total, value) => total + value, 0)

// A fleet's ship as the ledger carries it: the profile's participant with its fuel tank. `tank` is a ship that holds fuel at all, so it is a recipient of a service.
const entryOf = (participant) => {
  const { ship } = participant
  const capacity = ship.FuelCapacity

  return { id: ship.ShipID, name: participant.name, ship, participant, role: participant.role, capacity, size: ship.Size, tank: isNumber(capacity) && capacity > 0 }
}

// What a rejected or undecided service says, as a sentence of the form "{stop}: {reason}".
const rejectionText = (entry) => (entry.reason === 'draw-ahead-unknown' && entry.unknownAhead.length ? `What ${entry.unknownAhead.join(' and ')} draws at ${entry.stopName} is not known, so what is left for this fleet is not` : `${entry.stopName}: ${entry.text}`)

// The ledger of a run. `profile` as `fleetProfile` gives it; `legs` the kilometres of each leg (one fewer than the `stops`); `stops` [{ name, PopulationID, SystemID, Xcor, Ycor }] where the fleet stands; `sites` as `loadFuelSites` gives them (null while not read); `reserves` ({ ship(row), colony(PopulationID) } or null while the records are not read); `target` 'full' (fill every tank) or 'required' (the litres the run to the next stop that serves needs, with the ship's reserve); `stocks` the levels the fleets ahead left (`stocksAfter` of their ledger); `ahead` what they drew; `cycle` whether the last stop is the first again, so the fleet is served there too; `netted` whether the fleets are drawn one after another.
// Returns `status` ('ok', 'range' when a leg runs dry with every input known, 'unknown' when an input is missing, or the profile's own status when it cannot run), `unknownAt` (the first stop the run is not known from: that stop's service and every later figure and verdict read not known, null while every input is known), `ships`, `legs` (each with the departure, arrival and shortfall of every ship), `stops` (each with the arrival, the service, what was received and the hours), `returnFuel` (Map of ShipID to litres on arrival at the last stop, before any service there), `limiting` (the ship that arrives with the least of its tank), `rejected` (every service that cannot serve or cannot be decided, by its cause), `required` (the litres per ship and stop the run to the next serving stop needs), `missing`, `stocksAfter`, `drawn` (Map of the litres taken of each source), `tainted` (the sources whose level is no longer known), `assumptions`, `results` ({ ledger }), and the total `hours` of the services.
export const fuelLedger = ({ profile, legs, stops, sites = null, reserves = null, version = null, target = 'full', stocks = new Map(), ahead = EMPTY_AHEAD, cycle = false, netted = false }) => {
  const entries = profile.status === 'ok' ? profile.participants.map(entryOf) : []
  const base = { status: profile.status, ships: entries, legs: [], stops: [], stopCount: stops.length, returnFuel: null, limiting: null, rejected: [], required: [], missing: [], stocksAfter: new Map(stocks), drawn: new Map(), tainted: [], assumptions: [], results: { ledger: null }, hours: 0, hoursAt: [], dryLeg: null, unknownAt: null, target, cycle }

  if (profile.status !== 'ok') {
    return base
  }

  const last = stops.length - 1
  const serving = (index) => index < last || cycle
  const contextOf = (levels, fuel) => ({ ships: entries, fuel, sites, reserves, version, gameTime: sites ? sites.gameTime : null, levels, ahead, ownFleetId: profile.FleetID })
  const probes = stops.map((stop, index) => (sites && serving(index) ? serviceAt(stop, contextOf(levelsOf(stocks), new Map()), new Map()) : null))
  const lacking = entries.flatMap((entry) => [...(!isNumber(entry.capacity) ? [`the fuel capacity of ${entry.name}`] : []), ...((entry.role === 'independent' || entry.tank) && !isNumber(entry.ship.Fuel) ? [`the fuel aboard ${entry.name}`] : [])])
  const supported = ruleSupports('fuelService.ledger', version) === true
  const assumptions = [...new Set(['the fleet starts at the first stop with the fuel it has aboard now', ...(supported ? [] : [UNVERIFIED_SAVE]), ...(cycle ? ['the closing visit at the first stop fills the ships again, from what the opening visit left'] : []), ...(target === 'required' ? ['each ship takes the litres the run to the next stop that serves needs, with its reserve, not a full tank'] : []), ...(netted ? [NETTING_ASSUMPTION] : [])])]

  if (lacking.length) {
    const levels = levelsOf(stocks)
    const keys = new Set(probes.flatMap((probe) => (probe ? probe.services.filter((service) => service.permission !== 'blocked').flatMap((service) => service.keys) : [])))

    levels.taint([...keys])

    return { ...base, status: 'unknown', missing: lacking, stocksAfter: levels.snapshot(), tainted: [...keys], assumptions, results: { ledger: unavailable({ rule: 'fuelService.ledger', missing: lacking, assumptions }) } }
  }

  const servableMemo = new Map()
  const servableFor = (entry) => {
    if (!servableMemo.has(entry.id)) {
      servableMemo.set(entry.id, stops.map((stop, index) => {
        if (!sites || !serving(index)) {
          return false
        }

        const { permission } = serviceAt(stop, contextOf(levelsOf(stocks), new Map()), new Map(entries.filter((other) => other.tank).map((other) => [other.id, other === entry ? 1 : 0])))

        return permission === 'allowed' ? true : permission === 'unknown' ? 'maybe' : false
      }))
    }

    return servableMemo.get(entry.id)
  }
  const litresOf = legs.map((km) => new Map(legBurn(profile, km).map(({ ship, litres }) => [ship.ShipID, litres])))
  // What the ship keeps aboard: `exact` its floor, null where the records, the designation or the class minimum leave more than one value; `low` the least value any completion gives (the reserve, or the class minimum of a ship that is a tanker), which is all a requirement needs where the tank clamps it.
  const floorOf = (entry) => {
    const reserve = reserves ? (reserves.ship(entry.ship) ?? 0) : null
    const { FuelTanker: designation, MinimumFuel: minimum } = entry.ship
    const designated = designation === null || designation === undefined ? null : Number(designation) !== 0

    if (reserve === null) {
      return { exact: null, low: designated === true && isNumber(minimum) ? minimum : 0 }
    }

    const floor = isNumber(minimum) ? Math.max(reserve, minimum) : null

    return { exact: designated === false ? reserve : floor === null ? null : designated === null && floor !== reserve ? null : floor, low: designated === true && floor !== null ? floor : reserve }
  }
  const needsFrom = (entry, from) => {
    const servable = servableFor(entry)
    const walk = (haltAtMaybe) => {
      let total = 0
      let at = from

      while (at < legs.length) {
        const litres = litresOf[at].get(entry.id)

        if (!isNumber(litres)) {
          return null
        }

        total += litres
        at += 1

        if (servable[at] === true || (haltAtMaybe && servable[at])) {
          break
        }
      }

      return total
    }
    const nearest = walk(true)

    return nearest === walk(false) ? nearest : null
  }
  const requiredAt = (entry, index, now) => {
    const needs = needsFrom(entry, index === last ? 0 : index)
    const { exact, low } = floorOf(entry)
    const room = entry.capacity - now

    return room <= 0 ? 0 : needs !== null && exact !== null ? Math.max(0, Math.min(room, needs + exact - now)) : (needs ?? 0) + low - now >= room ? room : null
  }
  const levels = levelsOf(stocks)
  const fuel = new Map(entries.map((entry) => [entry.id, isNumber(entry.ship.Fuel) ? entry.ship.Fuel : 0]))
  const stopResults = []
  const legResults = []
  const rejected = []
  const required = []
  const drawn = new Map()
  const tainted = new Set()
  let dryLeg = null
  let legUnknown = false
  // The first stop from which the run is not known: where an input of the service there is not (a record or the sites not read, a tanker that cannot be decided, a level a fleet ahead left not known, the litres a ship is to be given), that stop's service and every later figure and verdict of the run read not known, and the sources they touch are not known to the fleets behind. The stops before it keep their figures; null while every input is known.
  let unknownAt = null
  const doubt = (index) => {
    unknownAt = unknownAt === null ? index : unknownAt
  }

  for (let index = 0; index <= last && dryLeg === null && !legUnknown; index += 1) {
    const arrival = unknownAt !== null && index > unknownAt ? null : new Map(fuel)
    let service = null

    if (serving(index) && !sites) {
      doubt(index)
      rejected.push({ stop: index, stopName: stops[index].name, kind: null, source: '', permission: 'unknown', gate: 'sites', reason: 'sites-unread', text: SERVICE_REASONS['sites-unread'], ahead: [], unknownAhead: [] })
    } else if (serving(index)) {
      const wants = new Map()

      entries.filter((entry) => entry.tank).forEach((entry) => {
        const needed = requiredAt(entry, index, fuel.get(entry.id))

        required.push({ stop: index, id: entry.id, name: entry.name, litres: needed })

        if (target !== 'required') {
          wants.set(entry.id, Math.max(0, entry.capacity - fuel.get(entry.id)))
        } else if (needed !== null) {
          wants.set(entry.id, needed)
        } else {
          doubt(index)
          rejected.push({ stop: index, stopName: stops[index].name, kind: null, source: entry.name, permission: 'unknown', gate: 'required', reason: 'required-unknown', text: SERVICE_REASONS['required-unknown'], ahead: [], unknownAhead: [] })
        }
      })

      service = serviceAt(stops[index], contextOf(levels, fuel), wants)

      if (service.services.some((part) => part.permission === 'unknown')) {
        doubt(index)
      }

      if (unknownAt !== null) {
        service.services.filter((part) => part.permission !== 'blocked' || !FIXED_BLOCKS.has(part.reason)).forEach((part) => {
          levels.taint(part.keys)
          part.keys.forEach((key) => tainted.add(key))
        })
        service = unreadService(service)
      } else {
        levels.apply(service.after)
        service.received.forEach((litres, id) => fuel.set(id, fuel.get(id) + litres))
        service.services.forEach((part) => part.drawn.forEach((litres, key) => drawn.set(key, (drawn.get(key) || 0) + litres)))
      }

      service.services.filter((part) => part.permission !== 'allowed' && part.reason !== EARLIER_DOUBT).forEach((part) => {
        rejected.push({ stop: index, stopName: stops[index].name, kind: part.kind, source: part.name, permission: part.permission, gate: part.gate, reason: part.reason, text: SERVICE_REASONS[part.reason], ahead: part.takenAhead, unknownAhead: part.unknownAhead })
      })
    }

    const unread = unknownAt !== null

    stopResults.push({ index, stop: stops[index], serving: serving(index), arrival, departure: unread ? null : new Map(fuel), service, permission: service ? service.permission : serving(index) ? 'unknown' : null, received: !unread && service ? service.received : null, receivedTotal: unread ? null : service ? sum([...service.received.values()]) : 0, hours: service && !unread ? service.hours : null, bound: service ? service.bound : 'exact' })

    if (index < last) {
      const ships = entries.map((entry) => {
        const litres = litresOf[index].get(entry.id)
        const departure = fuel.get(entry.id)
        const known = isNumber(litres)
        const dry = known && departure < litres

        return unread ? { id: entry.id, name: entry.name, departure: null, litres: null, arrival: null, departureShare: null, arrivalShare: null, shortfall: 0, ranKm: null, status: 'unknown' } : { id: entry.id, name: entry.name, departure, litres: known ? litres : null, arrival: known ? Math.max(0, departure - litres) : null, departureShare: entry.tank ? departure / entry.capacity : null, arrivalShare: known && entry.tank ? Math.max(0, departure - litres) / entry.capacity : null, shortfall: dry ? litres - departure : 0, ranKm: dry ? (departure / litres) * legs[index] : null, status: !known ? 'unknown' : dry ? 'dry' : 'ok' }
      })
      const status = ships.some((row) => row.status === 'dry') ? 'dry' : ships.some((row) => row.status === 'unknown') ? 'unknown' : 'ok'

      legResults.push({ index, from: stops[index], to: stops[index + 1], km: legs[index], status, ships })
      dryLeg = status === 'dry' ? index : null
      legUnknown = !unread && status === 'unknown'

      if (!unread) {
        ships.forEach((row) => fuel.set(row.id, row.arrival === null ? row.departure : row.arrival))
      }
    }
  }

  if (legUnknown) {
    const later = probes.flatMap((probe, index) => (probe && index >= stopResults.length ? probe.services.filter((part) => part.permission !== 'blocked').flatMap((part) => part.keys) : []))

    levels.taint(later)
    later.forEach((key) => tainted.add(key))
  }

  const reached = stopResults.length === stops.length
  const dry = dryLeg !== null
  const status = dry ? 'range' : legUnknown || unknownAt !== null ? 'unknown' : 'ok'
  const unknownTexts = rejected.filter((entry) => entry.permission === 'unknown').map(rejectionText)
  const legMissing = legUnknown ? legResults.filter((leg) => leg.status === 'unknown').map((leg) => `the distance of the leg from ${leg.from.name} to ${leg.to.name}`) : []
  const missing = [...new Set([...unknownTexts, ...legMissing])]
  const tight = legResults.flatMap((leg) => leg.ships.filter((row) => row.litres > 0 && row.arrivalShare !== null).map((row) => ({ leg, row })))
  const worst = tight.reduce((best, item) => (!best || item.row.arrivalShare < best.row.arrivalShare || (item.row.arrivalShare === best.row.arrivalShare && item.row.shortfall > best.row.shortfall) ? item : best), null)
  const hours = sum(stopResults.map((stop) => (isNumber(stop.hours) ? stop.hours : 0)))
  const allAssumptions = [...new Set([...assumptions, ...stopResults.flatMap((stop) => (stop.service ? stop.service.services.flatMap((part) => part.assumptions) : []))])]

  return {
    ...base,
    status,
    legs: legResults,
    stops: stopResults,
    returnFuel: reached && !dry && !legUnknown && unknownAt === null ? stopResults[last].arrival : null,
    limiting: worst && unknownAt === null && !legUnknown ? { id: worst.row.id, name: worst.row.name, leg: worst.leg.index, stop: worst.leg.to.name, share: worst.row.arrivalShare, arrival: worst.row.arrival, dry: worst.row.status === 'dry', shortfall: worst.row.shortfall } : null,
    rejected,
    required: unknownAt === null ? required : required.map((item) => (item.stop >= unknownAt ? { ...item, litres: null } : item)),
    missing,
    stocksAfter: levels.snapshot(),
    drawn,
    tainted: [...tainted],
    assumptions: allAssumptions,
    results: { ledger: status === 'unknown' ? unavailable({ rule: 'fuelService.ledger', missing, assumptions: allAssumptions }) : ofRule({ rule: 'fuelService.ledger', value: status, assumptions: allAssumptions }) },
    hours,
    hoursAt: stopResults.map((stop) => stop.hours),
    dryLeg,
    unknownAt,
  }
}

const pushed = (map, key, item) => map.set(key, [...(map.get(key) || []), item])

// The ledgers of several fleets that draw on the same sources, in the order of `fleets` ([{ profile, legs, stops, cycle, name }]): each fleet's whole run, then the next, from the levels the one before left. `options`: `stocks` (the levels entering the first fleet), `sites`, `reserves`, `version`, `target`. Returns `ledgers` (each with `draw`: { position, of, ahead } naming the fleets before it), the `stocks` after the last fleet and the draw `order`. A fleet behind one whose draw is not known reads that source as not known.
export const netLedgers = (fleets, { stocks = new Map(), sites = null, reserves = null, version = null, target = 'full' } = {}) => {
  let current = new Map(stocks)
  const taken = new Map()
  const unknownBy = new Map()
  const copy = (map) => new Map([...map].map(([key, list]) => [key, [...list]]))
  const ledgers = fleets.map((fleet, index) => {
    const ledger = fuelLedger({ ...fleet, sites, reserves, version, target, stocks: current, ahead: { taken: copy(taken), unknown: copy(unknownBy) }, netted: fleets.length > 1 })

    new Set([...ledger.drawn.keys(), ...ledger.tainted]).forEach((key) => pushed(taken, key, { fleet: fleet.name, litres: ledger.tainted.includes(key) ? null : ledger.drawn.get(key) }))
    ledger.tainted.forEach((key) => pushed(unknownBy, key, fleet.name))
    current = ledger.stocksAfter

    return { ...ledger, draw: { position: index + 1, of: fleets.length, ahead: fleets.slice(0, index).map((other) => other.name) } }
  })

  return { ledgers, stocks: current, order: fleets.map((fleet) => fleet.name) }
}

// The ledger as table rows, one per ship that burns fuel or holds a tank: { id, name, capacity, start, legs (the leg row of the ship for each leg), received (litres at each stop, null where none served or where the run is not known from an earlier stop on), returned }. The ledger itself masks the legs and receipts from the first stop it doubts, so the rows only read them.
export const ledgerRows = (ledger) => ledger.ships.filter((entry) => entry.role === 'independent' || entry.tank).map((entry) => ({
  id: entry.id,
  name: entry.name,
  capacity: entry.capacity,
  start: ledger.stops.length ? ledger.stops[0].arrival.get(entry.id) : null,
  legs: ledger.legs.map((leg) => leg.ships.find((item) => item.id === entry.id) || null),
  received: ledger.stops.map((stop) => (stop.received ? (stop.received.get(entry.id) || 0) : null)),
  returned: ledger.returnFuel ? ledger.returnFuel.get(entry.id) : null,
}))

// The seconds a run's refuelling adds to a cycle: at the origin the opening fill and the closing fill together, between them the fills of the other stops, and the closing fill alone. None where the ledger has no stop; a stop whose hours are not known (every stop from the first doubted one on) adds none, so the seconds of a run that is not known are the lower figure the stops before its first doubt give.
export const serviceSeconds = (ledger) => {
  if (!ledger || !ledger.stops.length) {
    return null
  }

  const last = ledger.stopCount - 1
  const at = (index) => (ledger.hoursAt[index] || 0) * SECONDS_PER_HOUR
  const closing = ledger.cycle && last > 0 ? at(last) : 0
  const between = Array.from({ length: Math.max(0, (ledger.cycle ? last - 1 : last)) }, (_, index) => at(index + 1)).reduce((total, seconds) => total + seconds, 0)

  return { origin: at(0) + closing, destination: between, closing }
}

// Whether the seconds the refuelling adds to a cycle are all known: false when the ledger has no verdict (a service that cannot be decided, or any input of the run that is not known, may add a fill of any length), so that the seconds of such a run are a lower figure and not the run's time.
export const timingKnown = (ledger) => !ledger || ledger.status !== 'unknown'

const ORDINALS = ['', '1st', '2nd', '3rd']

const defaultOrdinal = (position) => ORDINALS[position] || `${position}th`

// The note a fleet row carries under the ledger's verdict: what the run draws on 'ok', why it runs dry on 'range', what is missing on 'unknown'; null when there is nothing to say. `format`: { litres(value), hours(value), ordinal(position) } writes the figures.
export const ledgerNote = (ledger, { litres = String, hours = String, ordinal = defaultOrdinal } = {}) => {
  if (ledger.status === 'unknown') {
    return ledger.missing.length ? `Not known: ${ledger.missing.join('; ')}` : null
  }

  if (ledger.status === 'range') {
    const leg = ledger.legs[ledger.dryLeg]
    const dry = leg.ships.filter((row) => row.status === 'dry').sort((a, b) => b.shortfall - a.shortfall)[0]
    const stop = ledger.stops[ledger.dryLeg]
    const why = ledger.rejected.filter((entry) => entry.stop === ledger.dryLeg && entry.permission === 'blocked')
    const reason = why.map((entry) => (entry.reason === 'taken-ahead' && entry.ahead.some((item) => item.litres !== null) ? `${entry.stopName} is drawn by ${entry.ahead.filter((item) => item.litres !== null).map((item) => item.fleet).join(' and ')} before it` : `${entry.stopName} cannot serve: ${entry.text}`))
    const gave = stop.service && stop.service.permission === 'allowed' && stop.receivedTotal > 0 ? [`${stop.stop.name} gives ${litres(stop.receivedTotal)}${stop.service.services.some((part) => part.takenAhead.some((item) => item.litres !== null)) ? ` after ${[...new Set(stop.service.services.flatMap((part) => part.takenAhead.filter((item) => item.litres !== null).map((item) => item.fleet)))].join(' and ')} draw first` : ''}`] : []

    return [`Runs dry on the way from ${leg.from.name} to ${leg.to.name}: ${dry.name} needs ${litres(dry.shortfall)} more`, ...reason, ...gave].join('. ')
  }

  const served = ledger.stops.filter((stop) => stop.service && stop.service.permission === 'allowed' && stop.receivedTotal > 0)

  if (!served.length) {
    return null
  }

  const [first] = served
  const position = ledger.draw ? ledger.draw.position : 1
  const names = [...new Set(first.service.services.flatMap((part) => part.takenAhead.filter((item) => item.litres !== null).map((item) => item.fleet)))]
  const left = sum(first.service.services.filter((part) => part.permission === 'allowed').map((part) => part.residual))

  if (position > 1 && names.length) {
    return `Draws ${ordinal(position)} at ${first.stop.name} after ${names.join(', ')}: takes ${litres(first.receivedTotal)}, leaves ${litres(left)}`
  }

  return served.map((stop) => `Refuels at ${stop.stop.name}: ${litres(stop.receivedTotal)}${isNumber(stop.hours) ? ` over ${stop.bound === 'at-least' ? `${SERVICE_BOUNDS['at-least'].before} ` : ''}${hours(stop.hours)}` : ''}`).join('; ')
}

// The colonies of the race with what a service there needs, the stationary tanker fleets and the race's refuelling rates, for `serviceAt`: { gameTime, hubEra, rates: { MaxRefuellingRate, UnderwayReplenishmentRate }, colonies: [{ PopulationID, PopName, SystemID, SystemBodyID, Population, FuelStockpile, FuelProdStatus, RefuellingPoints, Refineries }], fleets: [{ FleetID, FleetName, SystemID, OrbitBodyID, Xcor, Ycor, LastMoveTime, FirstOrderStationary, ships }] }. Every colony of the race is listed, with `RefuellingPoints` the sum of the refuelling mass of its installations, so a colony without a point reads as one. A fleet is listed when one of its ships is a tanker, a ship with a refuelling rate, a transfer system or a harvester (the rows of `loadFuelDonors`, grouped); `FirstOrderStationary` is 1 for a fleet with no orders or a first order that is a stationary action, 0 for one that is not, null when the action's flag is not in the save. A column the save lacks reads as null. Throws when a read fails.
export const loadFuelSites = async (database, { GameID, RaceID }) => {
  const [populationColumns, fleetColumns, raceColumns, classColumns] = await Promise.all([columnsOf(database, 'FCT_Population'), columnsOf(database, 'FCT_Fleet'), columnsOf(database, 'FCT_Race'), columnsOf(database, 'FCT_ShipClass')])
  const has = (columns, name) => columns.size === 0 || columns.has(name)
  const population = (name) => (has(populationColumns, name) ? `FCT_Population.${name}` : 'null')
  const fleetColumn = (name) => (has(fleetColumns, name) ? `FCT_Fleet.${name}` : 'null')
  const race = (name) => (has(raceColumns, name) ? `FCT_Race.${name}` : 'null')
  const points = 'select coalesce(sum(DIM_PlanetaryInstallation.MassRefuelling * FCT_PopulationInstallations.Amount), 0) from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and FCT_PopulationInstallations.GameID = FCT_Population.GameID'
  const refineries = 'select coalesce(sum(case when DIM_PlanetaryInstallation.RefineryProductionValue > 0 then FCT_PopulationInstallations.Amount else 0 end), 0) from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.PopID = FCT_Population.PopulationID and FCT_PopulationInstallations.GameID = FCT_Population.GameID'
  const [[games], [races], [colonies], donors] = await Promise.all([
    database.query(`select GameTime from FCT_Game where GameID = ${Number(GameID)}`),
    database.query(`select ${race('MaxRefuellingRate')} as MaxRefuellingRate, ${race('UnderwayReplenishmentRate')} as UnderwayReplenishmentRate from FCT_Race where GameID = ${Number(GameID)} and RaceID = ${Number(RaceID)}`),
    database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, ${population('SystemBodyID')} as SystemBodyID, ${population('Population')} as Population, ${population('FuelStockpile')} as FuelStockpile, ${population('FuelProdStatus')} as FuelProdStatus, (${points}) as RefuellingPoints, (${refineries}) as Refineries from FCT_Population where FCT_Population.GameID = ${Number(GameID)} and FCT_Population.RaceID = ${Number(RaceID)} order by FCT_Population.PopulationID`),
    loadFuelDonors(database, { GameID, RaceID }),
  ])
  const byFleet = donors.reduce((total, ship) => total.set(ship.FleetID, [...(total.get(ship.FleetID) || []), ship]), new Map())
  const ids = [...byFleet.keys()]
  const orders = 'select FCT_MoveOrders.MoveOrderID from FCT_MoveOrders where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID and FCT_MoveOrders.GameID = FCT_Fleet.GameID'
  const first = 'select DIM_MoveAction.StationaryAction from FCT_MoveOrders inner join DIM_MoveAction on DIM_MoveAction.MoveActionID = FCT_MoveOrders.MoveActionID where FCT_MoveOrders.FleetID = FCT_Fleet.FleetID and FCT_MoveOrders.GameID = FCT_Fleet.GameID order by FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveOrderID limit 1'
  const [fleets] = ids.length ? await database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, ${fleetColumn('OrbitBodyID')} as OrbitBodyID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, ${fleetColumn('LastMoveTime')} as LastMoveTime, (select count(*) from (${orders})) as OrderCount, (${first}) as FirstAction from FCT_Fleet where FCT_Fleet.GameID = ${Number(GameID)} and FCT_Fleet.FleetID in (${ids.map(Number).join(', ')}) order by FCT_Fleet.FleetID`) : [[]]

  return Object.freeze({
    gameTime: games.length ? games[0].GameTime : null,
    hubEra: classColumns.has('RefuellingHub') ? 1 : 0,
    rates: Object.freeze({ MaxRefuellingRate: races.length ? races[0].MaxRefuellingRate : null, UnderwayReplenishmentRate: races.length ? races[0].UnderwayReplenishmentRate : null }),
    colonies: Object.freeze(colonies),
    fleets: Object.freeze(fleets.map(({ OrderCount, FirstAction, ...fleet }) => ({ ...fleet, FirstOrderStationary: OrderCount === 0 ? 1 : stationaryOf(FirstAction) === null ? null : stationaryOf(FirstAction) ? 1 : 0, ships: byFleet.get(fleet.FleetID) }))),
  })
}
