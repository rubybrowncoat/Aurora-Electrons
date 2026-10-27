// The donor side of the fuel service: what a tanker or harvester ship holds, what its class keeps back, what the player keeps back, and whether it may give the rest to a recipient, with the first gate that stops it named. Stored fuel is inventory and never changes with permission: a ship whose transfer system is damaged, whose class has none or whose recipient is too large keeps every litre aboard and only loses the permission. The rules and what the saves hold: docs/plans/backlog/evidence/AE-083-01.md (sections 2.3, 2.4, 5, 6 and 8) and docs/plans/backlog/evidence/AE-100-01.md.

import { columnTotal } from './logistics'
import { UNKNOWN_TEXT } from './math'
import { columnsOf } from './mine-bootstrap-data'
import { ofRule, registerRule, ruleSupports, unavailable } from './provenance'

// DIM_ComponentType: Transfer - Fuel, and Harvester.
const TRANSFER_FUEL = 61
const HARVESTER = 32
// A class rate below this serves only recipients up to the size below (hull spaces, inclusive).
export const LOW_RATE_LPH = 20000
export const LOW_RATE_RECIPIENT_HS = 20

const FUEL_SERVICE_VERSIONS = ['2.7.x']
const UNVERIFIED_SAVE = 'The save is not 2.7-shaped and has no version label, so the fuel service rules are not checked for its game version.'

registerRule({
  id: 'fuelService.stored',
  versions: FUEL_SERVICE_VERSIONS,
  units: 'L',
  verification: 'confirmed',
  structure: ['FCT_Ship.Fuel', 'FCT_ShipClass.FuelCapacity'],
  note: 'The fuel aboard now, as stored. It is inventory: a ship that cannot serve a recipient keeps every litre, and the figure never changes with permission.',
})

registerRule({
  id: 'fuelService.gameMinimum',
  versions: FUEL_SERVICE_VERSIONS,
  units: 'L',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.MinimumFuel'],
  note: 'The class minimum fuel: the litres a donor keeps and never gives away. A stored class value, kept apart from the player\'s reserve.',
})

registerRule({
  id: 'fuelService.playerReserve',
  versions: FUEL_SERVICE_VERSIONS,
  units: 'L',
  verification: 'confirmed',
  structure: ['the scenario records of kind resource.reserve'],
  note: 'A level the player chose to keep aboard a ship or a ship class, read from the player\'s own record: a ship\'s own reserve over that of its class. It is a local note and no game rule: it lowers the surplus offered for service and never changes the stored fuel, the class minimum or the game\'s permission.',
})

registerRule({
  id: 'fuelService.eligibleSurplus',
  versions: FUEL_SERVICE_VERSIONS,
  units: 'L',
  verification: 'estimated',
  structure: ['FCT_Ship.Fuel', 'FCT_ShipClass.FuelTanker, MinimumFuel, RefuellingRate', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentTypeID', 'FCT_DamagedComponent'],
  note: 'The litres a donor can give a recipient: the whole litres aboard above the larger of the class minimum and the player\'s reserve, when every gate of the donor result passes; 0 when a gate fails, and no figure when a gate cannot be decided. The gates (a Tanker designation, an undamaged Transfer - Fuel system, a class rate above 0, litres above the class minimum and, for a rate under 20,000 LPH, a recipient of 20 HS or less) are the stated game rules; no save holds a damaged transfer system, so the damaged case is checked on constructed rows only.',
  assumptions: ['the throughput is the class\'s nominal rate whatever the number of undamaged systems', 'the per-ship refuel mode (stored as 0, 1 or 3) is not read: its meaning is not in the save'],
})

registerRule({
  id: 'fuelService.donor',
  versions: FUEL_SERVICE_VERSIONS,
  units: '',
  verification: 'estimated',
  structure: ['FCT_ShipClass.FuelTanker, MinimumFuel, RefuellingRate', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentTypeID', 'FCT_DamagedComponent'],
  note: 'Whether the ship may serve fuel to a recipient: allowed, blocked or unknown, with the first gate that decides it. A gate that fails blocks the ship whatever an earlier gate could not decide; with no failing gate, a gate the save cannot decide leaves the permission unknown. Hub-era saves (before 2.6) carry other refuelling rules that are not modelled, so their ships are unknown.',
  assumptions: ['the class rate is the nominal rate of one undamaged system, not scaled by the systems left'],
})

export const GATES = Object.freeze(['version', 'designation', 'system', 'rate', 'litres', 'recipient'])

// What each reason says, by its code. A gate that fails or cannot be decided gives one of these.
export const REASONS = Object.freeze({
  'hub-era': 'The save predates the 2.6 refuelling rules, which are not modelled',
  'not-designated': 'Not designated as a tanker',
  'designation-unknown': 'Whether the class is a tanker is not in the save',
  'no-system': 'The class has no Transfer - Fuel system',
  'system-unknown': 'The class\'s Transfer - Fuel systems are not in the save',
  'system-damaged': 'Every Transfer - Fuel system is damaged',
  'damage-unknown': 'A damaged Transfer - Fuel system has no count in the save',
  'no-rate': 'The class refuelling rate is 0',
  'rate-unknown': 'The class refuelling rate is not in the save',
  'no-surplus': 'No fuel above the class minimum',
  'fuel-unknown': 'The fuel aboard or the class minimum is not in the save',
  'recipient-too-large': 'A rate under 20,000 LPH serves recipients of 20 HS or less only',
  'recipient-unknown': 'The recipient\'s size is not in the save',
})

export const PERMISSION_TEXT = Object.freeze({ allowed: 'Can serve', blocked: 'Cannot serve', unknown: 'Not known' })

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const pass = (gate) => ({ gate, status: 'pass', reason: null })
const fail = (gate, reason) => ({ gate, status: 'fail', reason })
const unknown = (gate, reason) => ({ gate, status: 'unknown', reason })

// Whether a class rate is one that serves small recipients only: positive and under the threshold.
export const isLowRate = (rate) => isNumber(rate) && rate > 0 && rate < LOW_RATE_LPH

// The gates in the order the game tests them. `ship`: { FuelTanker, TransferSystems (the class's Transfer - Fuel systems, null when unknown), UndamagedTransfer (the ones this ship has left, null when a damaged row has no count), RefuellingRate, Fuel, MinimumFuel, HubEra }. `recipient`: undefined when no recipient is asked about, else { size } in hull spaces (null when not known).
const gatesOf = (ship, recipient) => {
  const designated = ship.FuelTanker === null || ship.FuelTanker === undefined ? null : Number(ship.FuelTanker) !== 0
  const abovesMinimum = isNumber(ship.Fuel) && isNumber(ship.MinimumFuel) ? Math.floor(ship.Fuel) - ship.MinimumFuel > 0 : null

  return [
    ship.HubEra ? unknown('version', 'hub-era') : pass('version'),
    designated === null ? unknown('designation', 'designation-unknown') : designated ? pass('designation') : fail('designation', 'not-designated'),
    !isNumber(ship.TransferSystems) ? unknown('system', 'system-unknown') : ship.TransferSystems <= 0 ? fail('system', 'no-system') : !isNumber(ship.UndamagedTransfer) ? unknown('system', 'damage-unknown') : ship.UndamagedTransfer <= 0 ? fail('system', 'system-damaged') : pass('system'),
    !isNumber(ship.RefuellingRate) ? unknown('rate', 'rate-unknown') : ship.RefuellingRate <= 0 ? fail('rate', 'no-rate') : pass('rate'),
    abovesMinimum === null ? unknown('litres', 'fuel-unknown') : abovesMinimum ? pass('litres') : fail('litres', 'no-surplus'),
    recipient === undefined || !isNumber(ship.RefuellingRate) || !isLowRate(ship.RefuellingRate) ? pass('recipient') : !isNumber(recipient.size) ? unknown('recipient', 'recipient-unknown') : recipient.size > LOW_RATE_RECIPIENT_HS ? fail('recipient', 'recipient-too-large') : pass('recipient'),
  ]
}

// The donor side of one fuel service. `ship` is a row of `loadFuelDonors` (or the same fields); `recipient` is { size } of the recipient in hull spaces, left out when the result is for the donor alone; `playerReserve` the litres the player keeps aboard (a number of 0 or more, null when none is set); `version` the save's formula version (`loadFormulaVersion`, null when not stated).
// The result: `permission` ('allowed', 'blocked' or 'unknown'), `gate` (the first gate that fails, or for an unknown permission the first that cannot be decided, else null), `reason` (its code in REASONS, else null), `gates` (every gate with its status), the four figures (`stored`, `minimum`, `playerReserve`, `eligibleSurplus`) and `aboveFloors` (the whole litres above the larger of the minimum and the reserve, whatever the permission), `heldByReserve` (what the player's reserve holds back above the class minimum), `recipientLimit` (the largest recipient in hull spaces a low-rate class serves, null otherwise) and `results` (the figures as provenance results). `eligibleSurplus` is `aboveFloors` when allowed, 0 when blocked and null when unknown. The stored fuel is never changed by any gate.
export const fuelDonor = (ship, { recipient, playerReserve = null, reserveRead = true, version = null } = {}) => {
  const gates = gatesOf(ship, recipient)
  const failed = gates.find((gate) => gate.status === 'fail')
  const undecided = gates.find((gate) => gate.status === 'unknown')
  const permission = failed ? 'blocked' : undecided ? 'unknown' : 'allowed'
  const decisive = failed || undecided || null
  const stored = isNumber(ship.Fuel) ? ship.Fuel : null
  const minimum = isNumber(ship.MinimumFuel) ? ship.MinimumFuel : null
  const unread = reserveRead === false
  const reserve = !unread && isNumber(playerReserve) && playerReserve >= 0 ? playerReserve : null
  const supported = ruleSupports('fuelService.eligibleSurplus', version) === true
  const assumptions = supported ? [] : [UNVERIFIED_SAVE]
  const gameAvailable = stored === null || minimum === null ? null : Math.max(0, Math.floor(stored) - minimum)
  const aboveFloors = gameAvailable === null || unread ? null : Math.max(0, Math.floor(stored) - Math.max(minimum, reserve === null ? 0 : reserve))
  const heldByReserve = gameAvailable === null || unread ? null : gameAvailable - aboveFloors
  const eligibleSurplus = permission === 'allowed' ? aboveFloors : permission === 'blocked' ? 0 : null
  const results = {
    stored: stored === null ? unavailable({ rule: 'fuelService.stored', missing: ['the fuel aboard'] }) : ofRule({ rule: 'fuelService.stored', value: stored, inputs: { present: ['the fuel aboard'] } }),
    minimum: minimum === null ? unavailable({ rule: 'fuelService.gameMinimum', missing: ['the class minimum fuel'] }) : ofRule({ rule: 'fuelService.gameMinimum', value: minimum, inputs: { present: ['the class minimum fuel'] } }),
    playerReserve: reserve === null ? null : ofRule({ rule: 'fuelService.playerReserve', value: reserve, inputs: { present: ['the player\'s reserve record'] } }),
    eligibleSurplus: eligibleSurplus === null ? unavailable({ rule: 'fuelService.eligibleSurplus', missing: [decisive ? REASONS[decisive.reason] : 'the player\'s reserve record'], present: ['the fuel aboard', 'the class minimum fuel'], assumptions }) : ofRule({ rule: 'fuelService.eligibleSurplus', value: eligibleSurplus, inputs: { present: ['the fuel aboard', 'the class minimum fuel', 'the designation', 'the transfer systems', 'the class rate'] }, assumptions }),
    permission: permission === 'unknown' ? unavailable({ rule: 'fuelService.donor', missing: [REASONS[decisive.reason]], assumptions }) : ofRule({ rule: 'fuelService.donor', value: permission, inputs: { present: ['the designation', 'the transfer systems', 'the class rate', 'the fuel aboard', 'the class minimum fuel'] }, assumptions }),
  }

  return {
    permission,
    gate: decisive ? decisive.gate : null,
    reason: decisive ? decisive.reason : null,
    gates,
    stored,
    minimum,
    playerReserve: reserve,
    reserveRead: !unread,
    aboveFloors,
    heldByReserve,
    eligibleSurplus,
    recipientLimit: isLowRate(ship.RefuellingRate) ? LOW_RATE_RECIPIENT_HS : null,
    results,
  }
}

// The words of a ship's role, a table the screen and the checks read back through. A ship that is a tanker is a service site when its class has no engines: it stays where it is and no range of its own is worked out for it.
export const ROLE_TEXT = Object.freeze({ tanker: 'Tanker', harvester: 'Harvester', neither: 'Not a tanker', site: 'service site' })

const roleParts = (ship) => [ship.FuelTanker ? ROLE_TEXT.tanker : null, ship.Harvester ? ROLE_TEXT.harvester : null].filter(Boolean)

export const roleText = (ship) => {
  const parts = roleParts(ship)
  const base = parts.length ? parts.join(' and ') : ROLE_TEXT.neither

  return ship.EnginePower === 0 ? `${base}, ${ROLE_TEXT.site}` : base
}

// Whether a ship counts among the tankers whose fuel the Fuel stock figure counts as tankers: the class is designated and has tanks.
export const countsAsTanker = (ship) => Boolean(ship.FuelTanker) && ship.FuelCapacity > 0

// Whether a ship belongs in the tanker table: designated a tanker, with a refuelling rate or with a Transfer - Fuel system. A harvester that is none of these is shown with the harvesters only.
export const isServiceShip = (ship) => Boolean(ship.FuelTanker) || ship.RefuellingRate > 0 || ship.TransferSystems > 0

// The ships of `loadFuelDonors` with their donor result: one row per ship, `donor` its `fuelDonor`, `eligibleSurplus` its surplus as a top-level value for a table sort (null when not known), `role` its words, `counted` whether its fuel is in the tanker total, and `site` for an engine-less provider. `reserveOf(ship)` is the player's reserve for it in litres, null when none is set. `totals`: the stored fuel of the counted ships (a `columnTotal` of the same rule the Fuel stock figure sums by, so the two are one number), the counted ships with no fuel aboard, the surplus that can be served and the permissions among them.
export const tankerReport = (ships, { version = null, reserveOf = () => null, reserveRead = true } = {}) => {
  const rows = ships.map((ship) => {
    const donor = fuelDonor(ship, { playerReserve: reserveOf(ship), reserveRead, version })

    return { ...ship, donor, eligibleSurplus: donor.eligibleSurplus, role: roleText(ship), counted: countsAsTanker(ship), listed: isServiceShip(ship), site: ship.EnginePower === 0 }
  })
  const counted = rows.filter((row) => row.counted)
  const stored = columnTotal('logistics.fuelStock', counted, 'Fuel', 'the fuel aboard', 'tankers')
  const known = counted.filter((row) => row.donor.eligibleSurplus !== null)
  const permissions = { allowed: 0, blocked: 0, unknown: 0 }

  counted.forEach((row) => permissions[row.donor.permission]++)

  return {
    rows,
    totals: {
      ships: counted.length,
      stored,
      empty: counted.filter((row) => row.Fuel === 0).length,
      eligible: known.length && reserveRead !== false ? known.reduce((sum, row) => sum + row.donor.eligibleSurplus, 0) : null,
      eligibleUnknown: counted.length - known.length,
      permissions,
    },
  }
}

// The component rows of a class that are of `type`, as a SQL fragment over FCT_ShipClass.
const componentRows = (type) => `from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = FCT_ShipClass.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID = ${type}`
const TRANSFER_ROWS = componentRows(TRANSFER_FUEL)
// The damage rows of the ship's component: the pattern of the engines of utilities/fleet-profile.js (a ship with no damage row has every system; a damaged row with no number leaves the count unknown).
const DAMAGE_ROWS = 'from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID'
// The Transfer - Fuel systems of the class, and those this ship has left: null where a mounted count, or a damaged row's number, is not stored.
const TRANSFER_SYSTEMS_SQL = `case when exists (select 1 ${TRANSFER_ROWS} and FCT_ClassComponent.NumComponent is null) then null else coalesce((select sum(FCT_ClassComponent.NumComponent) ${TRANSFER_ROWS}), 0) end`
const UNDAMAGED_TRANSFER_SQL = `case when exists (select 1 ${TRANSFER_ROWS} and (FCT_ClassComponent.NumComponent is null or exists (select 1 ${DAMAGE_ROWS} and FCT_DamagedComponent.Number is null))) then null else coalesce((select sum(max(FCT_ClassComponent.NumComponent - coalesce((select FCT_DamagedComponent.Number ${DAMAGE_ROWS}), 0), 0)) ${TRANSFER_ROWS}), 0) end`
// The class column that tells a save of the hub era, before 2.6 (it is absent from every 2.6 and 2.7 save). It is named through this constant so the page scan sees a column built by name, not one the read needs.
const HUB_CLASS_COLUMN = 'RefuellingHub'
// The columns of FCT_ShipClass the read takes by name: one an older save lacks reads as null (not known), never as 0.
const CLASS_COLUMNS = ['FuelCapacity', 'FuelTanker', 'MinimumFuel', 'RefuellingRate', 'EnginePower', 'Harvesters', 'Size']

// The race's ships that can serve, have fuel to offer or harvest: every ship of a class that is designated a tanker, has a refuelling rate, mounts a Transfer - Fuel system or harvests, whatever its tanks (a harvester with no tanks still has its fuel aboard and its reason), with the class's rate, minimum and designation, the systems it has and the ones it has left after damage, and the stored fuel. Whether a ship counts in the tanker total is `countsAsTanker`, not this read. One row per ship, the race's own ships only (never a shipping line's). A column an old save lacks reads as null.
export const loadFuelDonors = async (database, { GameID, RaceID }) => {
  const [shipColumns, classColumns] = await Promise.all([columnsOf(database, 'FCT_Ship'), columnsOf(database, 'FCT_ShipClass')])
  const hasClass = (name) => classColumns.size === 0 || classColumns.has(name)
  const ofClass = (name) => (hasClass(name) ? `FCT_ShipClass.${name}` : 'null')
  const fuel = shipColumns.size === 0 || shipColumns.has('Fuel') ? 'FCT_Ship.Fuel' : 'null'
  const columns = CLASS_COLUMNS.map((name) => `${ofClass(name)} as ${name}`).join(', ')
  const hub = classColumns.has(HUB_CLASS_COLUMN) ? 1 : 0
  const sql = `select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Ship.ShipClassID, FCT_ShipClass.ClassName, ${fuel} as Fuel, ${columns}, ${TRANSFER_SYSTEMS_SQL} as TransferSystems, ${UNDAMAGED_TRANSFER_SQL} as UndamagedTransfer, case when ${ofClass('Harvesters')} > 0 or exists (select 1 ${componentRows(HARVESTER)}) then 1 else 0 end as Harvester, ${hub} as HubEra from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Ship.RaceID and FCT_RaceSysSurvey.GameID = FCT_Ship.GameID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0 and (${ofClass('FuelTanker')} = 1 or ${ofClass('RefuellingRate')} > 0 or ${ofClass('Harvesters')} > 0 or exists (select 1 ${TRANSFER_ROWS}) or exists (select 1 ${componentRows(HARVESTER)})) order by FCT_Fleet.FleetName, FCT_Ship.ShipName`
  const [rows] = await database.query(sql)

  return Object.freeze(rows)
}

// What the reserve and the surplus read as while the player's reserve records are not read: the surplus of a ship that may serve is not worked out as if no reserve existed.
export const NOT_READ_TEXT = 'Not read'

// The words a screen shows for a donor result, from `fuelDonor`: the permission, the reason (null when the ship can serve), the restriction on recipients and the four figures. `litres(value)` writes a known figure with its unit. The surplus of a ship that cannot serve reads as a reason, "Blocked" (or 0 where only the minimum stops it), never as a bare 0 that would read as no fuel aboard; one that cannot be decided reads as unknown.
export const donorTexts = (donor, litres) => ({
  permission: PERMISSION_TEXT[donor.permission],
  reason: donor.reason ? REASONS[donor.reason] : null,
  limit: donor.recipientLimit ? `Serves recipients of ${donor.recipientLimit} HS or less only` : null,
  stored: donor.stored === null ? UNKNOWN_TEXT : litres(donor.stored),
  minimum: donor.minimum === null ? UNKNOWN_TEXT : litres(donor.minimum),
  reserve: donor.reserveRead === false ? NOT_READ_TEXT : donor.playerReserve === null ? 'None set' : litres(donor.playerReserve),
  surplus: donor.permission === 'unknown' ? UNKNOWN_TEXT : donor.permission === 'blocked' && donor.gate !== 'litres' ? 'Blocked' : donor.eligibleSurplus === null ? NOT_READ_TEXT : litres(donor.eligibleSurplus),
})

// The four figures of a donor, in the order a screen lists them, with their names.
export const FIGURES = Object.freeze([
  { key: 'stored', label: 'Stored fuel' },
  { key: 'minimum', label: 'Class minimum' },
  { key: 'reserve', label: 'Local reserve' },
  { key: 'surplus', label: 'Eligible surplus' },
])
