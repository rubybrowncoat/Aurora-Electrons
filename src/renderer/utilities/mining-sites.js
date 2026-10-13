// The readiness of the race's mining sites: a colony with mines (and the orbital miners assigned to it) and a fleet with orbital mining modules, each joined to its actual body, the race's own colony there and the deposits the race has surveyed. A site lists every prerequisite it lacks, separately, and the asset that owns it, so the Warnings page can link the colony or fleet to fix. A site that mines but has no export set up in the save is delivery-blocked, which is not the same as one that does not mine (a freighter can still collect minerals without a stored order). A prerequisite the save cannot decide (an unsurveyed body, an amount not stored) is unknown, never missing. Evidence: docs/plans/backlog/evidence/AE-053-01.md.

import { TARGET_STATES, targetOf } from './cmc-policy'
import { crewFraction } from './crew'
import { countText } from './math'
import { withinOrbitalReach } from './minerals'
import { registerRule, ruleSupports } from './provenance'

const SITE_VERSIONS = ['2.7.x']

registerRule({
  id: 'miningSites.deposit',
  versions: SITE_VERSIONS,
  units: 'verdict',
  verification: 'confirmed',
  structure: ['FCT_SystemBodySurveys', 'FCT_MineralDeposit.Amount'],
  note: 'A body the race has surveyed has a deposit when a stored row holds more than 0 t. A surveyed body with no row, or only rows at 0 t, has none left (never mined, or exhausted: the save does not tell them apart). A body the race has not surveyed is unknown, not empty, and so is a deposit whose amount is not stored.',
})

registerRule({
  id: 'miningSites.surface',
  versions: SITE_VERSIONS,
  units: 'verdict',
  verification: 'estimated',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MiningProductionValue, Workers, CivilianInstallation', 'FCT_Population.Efficiency, Population', 'FCT_SystemBody.RadiationLevel', 'FCT_Race.MineProduction'],
  note: 'Mines with workers need a workforce (the colony\'s efficiency above 0), automated mines and civilian complexes do not; no mine produces without a deposit, with radiation of 10000 or more or at a race mine production of 0. Read from the game\'s mining rules for 2.7, so the workforce and the radiation cut-off are unknown on a save that is not 2.7-shaped (the stored radiation level stays readable); the sample saves have no colony whose mines stand idle for these reasons.',
  assumptions: ['A colony\'s stored efficiency of 0 means its manned mines have no workers; a colony without efficiency stored and with no population has none either.'],
})

registerRule({
  id: 'miningSites.orbital',
  versions: SITE_VERSIONS,
  units: 'verdict',
  verification: 'estimated',
  structure: ['FCT_Fleet.OrbitBodyID, AssignedPopulationID', 'FCT_Population.SystemBodyID', 'FCT_SystemBody.Radius', 'FCT_Race.MaximumOrbitalMiningDiameter, MineProduction', 'FCT_Ship.CurrentCrew', 'FCT_ShipClass.Crew, MiningModules', 'FCT_ClassComponent', 'FCT_DamagedComponent'],
  note: 'Orbital mining modules add to the output of the race\'s colony on the body the fleet is at, when the fleet is assigned to that colony (an unassigned fleet is assigned to it), the body is no wider than the race\'s orbital mining limit and has a deposit; each undamaged module works at the share of the class crew aboard, so a ship with no crew aboard mines nothing. Read from the game\'s rules for 2.7; the modded sample save has no orbital miner and the stock sample\'s all work.',
  assumptions: ['A fleet assigned to a colony that no longer exists is treated as unassigned.', 'Only fleets without move orders are judged; one with orders is moving or about to.'],
})

registerRule({
  id: 'miningSites.delivery',
  versions: SITE_VERSIONS,
  units: 'verdict',
  verification: 'estimated',
  structure: ['FCT_Population.MassDriverDest, Capital, SystemID, RaceID', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MassDriverValue, ConstructionValue, OrdnanceProductionValue, FighterProductionValue', 'FCT_MoveOrders.MoveActionID, PopulationID'],
  note: 'Minerals dug at a colony have an export set up in the save when its mass drivers point at a colony of the race in the same system that has drivers of its own, when a fleet has an order to load minerals at the colony, when a colony of the race in the same system with drivers points its own drivers at it (the colony has drivers too), or when they are used where they lie (the capital, or a colony with factories). A destination that is none, gone, the colony itself, another race\'s or in another system is no export, and neither is a colony without drivers at either end. A site with none is one with no export set up, not proof that no minerals leave it: a freighter can collect them without a stored order. A loading order shows that a haul is set up, not that it runs.',
  assumptions: ['A colony that receives packets, the capital and a colony with factories use their minerals on the spot.', 'An order to load minerals, or to load or unload them to a reserve level, at the colony is a delivery path.'],
})

// The orders that load minerals at a colony (load all, load a type, load when available, load until full, load or unload to a reserve level).
export const HAUL_ORDER_ACTIONS = [62, 165, 178, 180, 223]

// DIM_ComponentType: Orbital Mining Module.
export const ORBITAL_MINING_MODULE = 38

// Radiation at which the colony's mine output modifier reaches 0.
const RADIATION_LIMIT = 10000

const VERSION_INPUT = 'the game version the mining rules are verified for (a 2.7-shaped save)'

const known = (value) => typeof value === 'number' && Number.isFinite(value)

// Three-valued verdicts: 1, 0 or null while an input is not known.
const all = (...verdicts) => (verdicts.includes(0) ? 0 : verdicts.includes(null) ? null : 1)

const any = (...verdicts) => (verdicts.includes(1) ? 1 : verdicts.includes(null) ? null : 0)

const not = (verdict) => (verdict === null ? null : 1 - verdict)

const flag = (value) => (value === 1 || value === true ? 1 : value === 0 || value === false ? 0 : null)

// Whether a sum over installations is above 0: known when it is, or when no installation is unreadable.
const positive = (sum, gaps) => (known(sum) && sum > 0 ? 1 : known(sum) && !(gaps > 0) ? 0 : null)

// A prerequisite: `verdict` 1 (met), 0 (missing) or null (not known). One that rests on a 2.7 rule is `supported` only on a 2.7-shaped save, and unknown on any other; `missing` is the text when it is lacking, `unknown` the text when not known and `inputs` the stored values that decide it.
const prerequisite = (key, owner, verdict, { missing, unknown, inputs, supported = true }) => {
  if (!supported) {
    return { key, owner, state: 'unknown', text: unknown, inputs: [VERSION_INPUT] }
  }

  return verdict === 1 ? { key, owner, state: 'met', text: null, inputs: [] } : verdict === 0 ? { key, owner, state: 'missing', text: missing, inputs: [] } : { key, owner, state: 'unknown', text: unknown, inputs }
}

const DEPOSIT_INPUT = 'the amount of a mineral deposit on the body'
const SURVEY_INPUT = 'the race\'s geological survey of the body'

// The deposits of a body as the race knows them: 'present', 'exhausted' (rows at 0 t), 'empty' (no row), 'unsurveyed' or 'unknown' (an amount is not stored).
export const depositState = (row) => {
  if (flag(row.Surveyed) !== 1) {
    return flag(row.Surveyed) === 0 ? 'unsurveyed' : 'unknown'
  } else if (!known(row.Deposits) || !known(row.DepositGaps) || !known(row.Depleted)) {
    return 'unknown'
  } else if (row.Deposits > 0) {
    return 'present'
  } else if (row.DepositGaps > 0) {
    return 'unknown'
  }

  return row.Depleted > 0 ? 'exhausted' : 'empty'
}

const depositNeed = (row, owner) => {
  const state = depositState(row)
  const verdict = state === 'present' ? 1 : state === 'empty' || state === 'exhausted' ? 0 : null

  return prerequisite('deposit', owner, verdict, {
    missing: state === 'exhausted' ? 'Every deposit on the body is exhausted' : 'No mineral deposit on the body',
    unknown: state === 'unsurveyed' ? 'Body not surveyed: its deposits are not known' : 'A deposit amount on the body is not stored',
    inputs: [state === 'unsurveyed' ? SURVEY_INPUT : DEPOSIT_INPUT],
  })
}

const mineProductionNeed = (row, owner) => prerequisite('mineProduction', owner, known(row.MineProduction) ? Number(row.MineProduction > 0) : null, { missing: 'The race has no mine production', unknown: 'The race\'s mine production is not stored', inputs: ['the race\'s mine production'] })

const DRIVER_INPUT = 'the amount or the type of an installation of the colony'

// Whether a colony's mass drivers deliver to the destination it names: drivers here and, at a destination of the race in the same system, drivers there too. `target` is the destination's state (cmc-policy.js `targetOf`), `verdict` 1, 0 or null while a driver amount or the destination is not known.
const driveOut = (row, RaceID) => {
  const drivers = positive(row.Drivers, row.DriverGaps)
  const target = targetOf(row, RaceID)
  const receiver = target === 'valid' ? positive(row.DestinationDrivers, row.DestinationGaps) : null

  return { drivers, target, receiver, verdict: target === null ? (drivers === 0 ? 0 : null) : target === 'valid' ? all(drivers, receiver) : 0 }
}

// How the minerals of a producing colony leave it: `state` 'connected' (`via`: 'drivers', 'hub', 'hauled' or 'local'), 'blocked' (no export set up in the save) or 'unknown', and the delivery prerequisites that are lacking or not known. `senders` are the other colonies of the race whose destination is this colony.
const deliveryOf = (row, { RaceID, supported, senders }) => {
  const { drivers, target, receiver, verdict: drivesOut } = driveOut(row, RaceID)
  const hub = senders.length ? any(...senders.map((sender) => driveOut(sender, RaceID).verdict)) : 0
  const hauled = known(row.HaulOrders) ? Number(row.HaulOrders > 0) : null
  const local = any(flag(row.Capital), positive(row.Factories, row.FactoryGaps))
  const paths = [['drivers', drivesOut], ['hub', hub], ['hauled', hauled], ['local', local]]
  const open = any(...paths.map(([, verdict]) => verdict))
  const [via = null] = paths.find(([, verdict]) => verdict === 1) || []
  const needs = [
    prerequisite('drivers', 'colony', drivers, { missing: 'No mass driver at the colony', unknown: 'Mass drivers of the colony are not known', inputs: [DRIVER_INPUT], supported }),
    prerequisite('destination', 'colony', target === null ? null : Number(target === 'valid'), {
      missing: target === 'none' ? (row.OtherColonies > 0 ? 'No mass driver destination' : 'No other colony of the race in the system to receive packets') : `The mass driver destination is ${TARGET_STATES[target]}, which the game does not offer`,
      unknown: 'The colony\'s mass driver destination is not known',
      inputs: ['the colony\'s mass driver destination'],
      supported,
    }),
    ...(target === 'valid' ? [prerequisite('receiver', 'colony', receiver, { missing: 'No mass driver at the destination colony', unknown: 'Mass drivers of the destination colony are not known', inputs: [DRIVER_INPUT], supported })] : []),
  ]

  if (!supported) {
    return { state: 'unknown', via: null, prerequisites: needs }
  }

  return { state: open === 1 ? 'connected' : open === 0 ? 'blocked' : 'unknown', via, prerequisites: open === 1 ? [] : needs }
}

const surfaceOf = (row, { supported, count }) => {
  const manned = positive(row.Manned, row.MineGaps)
  const automated = positive(row.Automated, row.MineGaps)
  const civilian = positive(row.Civilian, row.MineGaps)
  const capacity = any(manned, automated, civilian)

  if (capacity === 0) {
    return null
  }

  const deposit = depositNeed(row, 'colony')
  const radiation = prerequisite('radiation', 'colony', known(row.RadiationLevel) ? Number(row.RadiationLevel < RADIATION_LIMIT) : null, { missing: `Radiation of ${count(row.RadiationLevel)} stops all mine output`, unknown: 'The radiation of the body, or what it does to mine output, is not known', inputs: ['the radiation of the body'], supported: supported.surface })
  const production = mineProductionNeed(row, 'colony')
  const efficiency = known(row.Efficiency) ? Number(row.Efficiency > 0) : known(row.Population) && row.Population === 0 ? 0 : null
  const staffing = prerequisite('staffing', 'colony', manned === 0 ? 1 : efficiency, { missing: 'No workforce for the manned mines (the colony\'s efficiency is 0)', unknown: 'The colony\'s workforce is not known', inputs: ['the colony\'s efficiency'], supported: supported.surface })
  const common = all(...[deposit, radiation, production].map(verdictOf))
  const mannedWorks = all(manned, verdictOf(staffing))
  const outputWorks = all(common, any(mannedWorks, automated))
  const surfaceWorks = all(common, any(mannedWorks, automated, civilian))

  return {
    prerequisites: [deposit, radiation, production, ...(manned === 0 ? [] : [staffing])],
    idle: all(capacity, any(not(common), all(manned, not(verdictOf(staffing))))),
    works: surfaceWorks,
    outputWorks,
  }
}

const verdictOf = (need) => (need.state === 'met' ? 1 : need.state === 'missing' ? 0 : null)

const CAPACITY_INPUT = 'the amount or the type of an installation of the colony'

// One site per colony of the race with mining installations, or with orbital miners assigned to it. `fleets` are the assessed fleet sites, whose output counts at the colony they are assigned to.
const colonySites = (rows, fleets, options) => {
  const orbitalBy = {}
  const sendersBy = {}

  fleets.forEach((fleet) => {
    if (fleet.colonyId !== null) {
      ;(orbitalBy[fleet.colonyId] = orbitalBy[fleet.colonyId] || []).push(fleet)
    }
  })

  rows.forEach((row) => {
    if (Number.isInteger(row.MassDriverDest) && row.MassDriverDest > 0 && row.MassDriverDest !== row.PopulationID) {
      ;(sendersBy[row.MassDriverDest] = sendersBy[row.MassDriverDest] || []).push(row)
    }
  })

  return rows.flatMap((row) => {
    const surface = surfaceOf(row, options)
    const orbital = orbitalBy[row.PopulationID] || []

    if (!surface && !orbital.length) {
      return []
    }

    const orbitalWorks = orbital.length ? any(...orbital.map((fleet) => fleet.producing)) : 0
    const output = any(surface ? surface.outputWorks : 0, orbitalWorks)
    const producing = any(surface ? surface.works : 0, orbitalWorks)
    const delivery = output === 0 ? null : deliveryOf(row, { RaceID: options.RaceID, supported: options.supported.delivery, senders: sendersBy[row.PopulationID] || [] })
    const total = known(row.Manned) && known(row.Automated) && known(row.Civilian) && !(row.MineGaps > 0) ? row.Manned + row.Automated + row.Civilian : null

    return [{
      kind: 'colony',
      id: row.PopulationID,
      row,
      surface: Boolean(surface),
      orbital,
      capacity: total,
      capacityInputs: total === null ? [CAPACITY_INPUT] : [],
      prerequisites: surface ? surface.prerequisites : [],
      idle: surface ? surface.idle : 0,
      producing,
      output,
      delivery,
    }]
  })
}

const SHIP_MODULES_INPUT = 'the mining modules of a ship class'
const CREW_INPUTS = ['the crew aboard of a ship', 'the crew of a ship class']

// One site per fleet at a body with ships that carry mining modules (`rows`: one per ship, each with its fleet's columns).
const fleetSites = (rows, { supported, count }) => {
  const byFleet = new Map()

  rows.forEach((row) => byFleet.set(row.FleetID, [...(byFleet.get(row.FleetID) || []), row]))

  return [...byFleet.values()].map((ships) => {
    const [row] = ships
    const colonyId = Number.isInteger(row.ColonyID) ? row.ColonyID : null
    const stored = row.AssignedPopulationID
    const assignment = !Number.isInteger(stored) ? 'unknown' : stored <= 0 ? 'none' : Number.isInteger(row.AssignedID) ? 'colony' : 'gone'
    const assigned = assignment === 'colony' ? row.AssignedID : null
    const working = ships.map((ship) => (known(ship.Modules) && ship.ClassLines > 0 && known(ship.WorkingModules) ? Number(ship.WorkingModules > 0) : null))
    const crewAboard = ships.map((ship) => {
      const share = crewFraction(ship)

      return share === null ? null : Number(share > 0)
    })
    const operating = working.map((modules, index) => all(modules, crewAboard[index]))
    const crewed = crewAboard.filter((_crew, index) => working[index] !== 0)
    const needs = [
      prerequisite('colony', 'fleet', colonyId === null ? 0 : 1, { missing: 'No colony of the race on this body to take the output', unknown: 'The colony on the body is not known', inputs: ['the colonies of the race'], supported: supported.orbital }),
      prerequisite('assignment', 'fleet', assignment === 'unknown' ? null : assignment !== 'colony' || colonyId === null || assigned === colonyId ? 1 : 0, { missing: `Assigned to ${row.AssignedName || 'another colony'}, not to the colony on this body`, unknown: 'The colony the fleet is assigned to is not stored', inputs: ['the colony the fleet is assigned to'], supported: supported.orbital }),
      prerequisite('diameter', 'fleet', (() => {
        const within = withinOrbitalReach(row.Diameter, row.MaximumDiameter)

        return within === null ? null : Number(within)
      })(), { missing: `${count(row.Diameter)} km across, more than the ${count(row.MaximumDiameter)} km orbital mining can handle`, unknown: 'The body\'s diameter or the race\'s orbital mining limit is not stored', inputs: ['the diameter of the body', 'the race\'s orbital mining diameter limit'] }),
      depositNeed(row, 'fleet'),
      mineProductionNeed(row, 'fleet'),
      prerequisite('modules', 'fleet', any(...working), { missing: 'Every mining module of the fleet is damaged', unknown: 'The mining modules of the fleet are not known', inputs: [SHIP_MODULES_INPUT, 'the class components of a ship', 'the damaged components of a ship'] }),
      prerequisite('crew', 'fleet', crewed.length ? any(...crewed) : 1, { missing: 'No crew aboard the ships that carry the modules', unknown: 'The crew of a ship is not known', inputs: CREW_INPUTS }),
    ]
    const designed = ships.reduce((total, ship) => (total === null || !known(ship.Modules) ? null : total + ship.Modules), 0)

    return {
      kind: 'fleet',
      id: row.FleetID,
      row,
      colonyId: assignment === 'colony' && assigned !== colonyId ? null : colonyId,
      modules: designed,
      prerequisites: needs,
      producing: all(...needs.map(verdictOf), any(...operating)),
    }
  })
}

// The sites of a race's mining from the rows `readMiningSites` (warnings/common.js) loads. `RaceID` the race; `version` the save's formula version (capabilities.js `loadFormulaVersion`), without which the rules read from the 2.7 game are not applied and their prerequisites are unknown; `count` formats a figure in a text.
export const assessMiningSites = ({ colonies, fleets }, { RaceID, version = null, count = (value) => countText(value) } = {}) => {
  const supported = { surface: ruleSupports('miningSites.surface', version) === true, orbital: ruleSupports('miningSites.orbital', version) === true, delivery: ruleSupports('miningSites.delivery', version) === true }
  const fleetList = fleetSites(fleets, { supported, count })

  return { fleets: fleetList, colonies: colonySites(colonies, fleetList, { RaceID, supported, count }) }
}

// The prerequisites of a site that are lacking (`missingNeeds`) and those not known (`unknownNeeds`), with the delivery prerequisites of a colony site when `delivery` is true.
export const missingNeeds = (site, { delivery = false } = {}) => [...site.prerequisites, ...(delivery && site.delivery ? site.delivery.prerequisites : [])].filter((need) => need.state === 'missing')

export const unknownNeeds = (site, { delivery = false } = {}) => [...site.prerequisites, ...(delivery && site.delivery ? site.delivery.prerequisites : [])].filter((need) => need.state === 'unknown')

// A site's verdict for a check as the warnings read it: 1 (a warning), 0 (none) or null (not evaluated).
export const deliveryVerdict = (site) => (site.output === 0 || !site.delivery ? 0 : all(site.output, site.delivery.state === 'blocked' ? 1 : site.delivery.state === 'unknown' ? null : 0))
