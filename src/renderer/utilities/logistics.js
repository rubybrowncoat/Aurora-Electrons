// Fuel and maintenance-supply maths for the Logistics page. Sources and checks: docs/plans/aurcalcs/build-2.md § Logistics.

import { crewFraction } from './crew'
import { roundToDecimal } from './math'
import { navalAdminChainBonus } from './minerals'
import { combine, envelope, getRule, isAvailable, ofRule, registerRule, ruleSupports, unavailable, valueOrNull } from './provenance'
import { totalOf } from './production'

// The racial "Maintenance Production Rate" is BP per facility per year; 1 MSP is 0.25 BP.
export const MSP_PER_BP = 4
// A refinery turns 1 t of Sorium into 2,000 L of fuel.
export const LITRES_PER_TON = 2000
export const HOURS_PER_YEAR = 8760
// Minerals behind 1 MSP (docs `maintenance`, confirmed by the mineral ledger). `name` is also the colony's stock column; `Deposit<name>` says whether its body holds that mineral.
export const MSP_MINERALS = [
  { name: 'Duranium', perMsp: 0.1 },
  { name: 'Uridium', perMsp: 0.05 },
  { name: 'Gallicite', perMsp: 0.1 },
]

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const MODIFIER_TEXT = 'the colony\'s production modifier'

// What a production figure lacks of the colony's modifier and the `terms` ([value, text]) it multiplies with it.
const productionGaps = (modifier, terms) => [...(isNumber(modifier) ? [] : [MODIFIER_TEXT]), ...terms.filter(([value]) => !isNumber(value)).map(([, text]) => text)]

// L/yr while production is on: refineries x racial rate x the colony's production modifier, as a 'logistics.refineryOutput' result. A colony with no refineries or with production off makes 0 whatever else is missing; one whose switch, refineries, rate or modifier is not in the save has no figure. Matches the game's mineral ledger (Sorium for fuel refining) on every sample colony.
export const refineryOutput = (colony, modifier) => {
  const rule = 'logistics.refineryOutput'

  if (!isNumber(colony.FuelProdStatus)) {
    return unavailable({ rule, missing: ['whether fuel production is on'] })
  } else if (!colony.FuelProdStatus || colony.Refineries === 0) {
    return ofRule({ rule, value: 0, inputs: { present: [colony.FuelProdStatus ? 'the colony has no refineries' : 'fuel production is off'] } })
  }

  const missing = productionGaps(modifier, [[colony.Refineries, 'the colony\'s refineries'], [colony.FuelProduction, 'the race\'s fuel production rate']])

  return missing.length ? unavailable({ rule, missing }) : ofRule({ rule, value: colony.Refineries * colony.FuelProduction * modifier, inputs: { present: [MODIFIER_TEXT, 'the colony\'s refineries', 'the race\'s fuel production rate'] } })
}

// What a colony's refineries make now, as a 'logistics.refineryOutput' result: `refineryOutput`, held to 0 while the colony has under 1 t of Sorium. Unavailable while the Sorium stock is not in the save and the refineries would otherwise make something.
export const refineryYield = (colony, modifier) => {
  const output = refineryOutput(colony, modifier)

  if (isNumber(colony.Sorium)) {
    return colony.Sorium >= 1 ? output : ofRule({ rule: 'logistics.refineryOutput', value: 0, inputs: { present: ['the colony has under 1 t of Sorium'] } })
  }

  return isAvailable(output) && output.value === 0 ? output : unavailable({ rule: 'logistics.refineryOutput', missing: [...(isAvailable(output) ? [] : output.inputs.missing), 'the colony\'s Sorium stock'] })
}

// Years a colony's Sorium lasts at its refinery output (a result), as a 'logistics.soriumLasts' result: unavailable while the output or the stock is not known, and for a colony that refines nothing (the Sorium does not run down).
export const soriumLasts = (colony, output) => {
  const rule = 'logistics.soriumLasts'

  if (!isNumber(colony.Sorium)) {
    return unavailable({ rule, missing: ['the colony\'s Sorium stock'] })
  } else if (isAvailable(output) && !(output.value > 0)) {
    return unavailable({ rule, missing: ['a refinery output above 0 (the Sorium does not run down)'] })
  }

  return combine({ rule, parts: { output }, compute: (values) => colony.Sorium / (values.output / LITRES_PER_TON), inputs: { present: ['the colony\'s Sorium stock'] } })
}

// MSP/yr the facilities make while production is on, as a 'logistics.mspProduction' result; a colony with no facilities makes 0 whatever else is missing. Also ledger-checked.
export const mspProduction = (colony, modifier) => {
  const rule = 'logistics.mspProduction'

  if (colony.MaintenanceFacilities === 0) {
    return ofRule({ rule, value: 0, inputs: { present: ['the colony has no maintenance facilities'] } })
  }

  const missing = productionGaps(modifier, [[colony.MaintenanceFacilities, 'the colony\'s maintenance facilities'], [colony.MSPProduction, 'the race\'s maintenance production rate']])

  return missing.length ? unavailable({ rule, missing }) : ofRule({ rule, value: colony.MaintenanceFacilities * colony.MSPProduction * MSP_PER_BP * modifier, inputs: { present: [MODIFIER_TEXT, 'the colony\'s maintenance facilities', 'the race\'s maintenance production rate'] } })
}

// MSP a year the colony's input minerals allow: unlimited for one mined on the colony's own body, otherwise what its stockpile can make before it runs out, null where the stockpile is not in the save. Mines elsewhere, orbital mining and incoming hauls aren't visible here, so this can understate a colony that's supplied that way.
const mspMineralLimits = (colony) => MSP_MINERALS.map((mineral) => ({ name: mineral.name, msp: colony.Mines > 0 && colony[`Deposit${mineral.name}`] > 0 ? Infinity : isNumber(colony[mineral.name]) ? Math.max(0, colony[mineral.name]) / mineral.perMsp : null }))

// MSP/yr actually made, as a 'logistics.mspOutput' result: production on, and no more than the scarcest input mineral allows. Unavailable while the switch, the production or a stockpile that would limit it is not in the save; a colony making nothing makes 0.
export const mspOutput = (colony, modifier) => {
  const rule = 'logistics.mspOutput'

  if (!isNumber(colony.MaintProdStatus)) {
    return unavailable({ rule, missing: ['whether maintenance production is on'] })
  } else if (!colony.MaintProdStatus) {
    return ofRule({ rule, value: 0, inputs: { present: ['maintenance production is off'] } })
  }

  const production = mspProduction(colony, modifier)
  const limits = mspMineralLimits(colony)
  const unknown = limits.filter((limit) => limit.msp === null).map((limit) => `the colony's stock of ${limit.name}`)

  if (!isAvailable(production) || (production.value > 0 && unknown.length)) {
    return unavailable({ rule, missing: [...(isAvailable(production) ? [] : production.inputs.missing), ...unknown], present: production.inputs.present })
  }

  return combine({ rule, parts: { production }, compute: (values) => Math.min(values.production, ...limits.map(({ msp }) => (msp === null ? Infinity : msp))), inputs: { present: ['the colony\'s input mineral stock'] } })
}

// The input minerals that hold a producing colony below full production; none while its production or a stockpile is not known.
export const mspMineralShortfall = (colony, modifier) => {
  const production = mspProduction(colony, modifier)

  return colony.MaintProdStatus && isAvailable(production) ? mspMineralLimits(colony).filter(({ msp }) => msp !== null && msp < production.value).map(({ name }) => name) : []
}

// Tons the colony's facilities can maintain (docs `maintenance`, rule 6), as a number or null while any of its factors is not in the save (a colony with no facilities maintains 0 whatever else is missing). Never negative: a bombarded or rioting colony's modifier bottoms out at zero.
export const facilityCapacity = (colony) => {
  if (colony.MaintenanceFacilities === 0) {
    return 0
  }

  const factors = [colony.MaintenanceFacilities, colony.MaintenanceCapacity, colony.Efficiency, colony.CapacityModifier, colony.EconomicProdModifier]

  return factors.every(isNumber) ? Math.max(0, factors.reduce((product, factor) => product * factor, 1)) : null
}

const locationKey = (fleet) => (fleet.OrbitBodyID > 0 ? `body-${fleet.OrbitBodyID}` : `space-${fleet.SystemID}-${Math.round(fleet.Xcor)}-${Math.round(fleet.Ycor)}`)

// A stored column summed over rows, as { result, unknown, value, gap } under `rule`: a row whose figure is not a number, or whose `flags` (columns counting the ships behind it that the save does not describe) are above 0, is left out and counted. A row that is itself a sum may count, in `missingKey`, the members it left out: the row then stays in the sum as a partial figure, those members are counted as unknown and the result says so. `value` is the sum of the rest (null when no row has a figure), `gap` names what is missing, null when nothing is.
export const columnTotal = (rule, rows, key, label, noun, flags = [], missingKey = null) => {
  const missingIn = (row) => (missingKey && row[missingKey] > 0 ? row[missingKey] : 0)
  const included = (row) => isNumber(row[key]) && !flags.some((flag) => row[flag] > 0)
  const total = totalOf(rule, rows.map((row) => (included(row) ? ofRule({ rule, value: row[key], inputs: { present: [label] }, assumptions: missingIn(row) ? [`${missingIn(row)} of the ${noun} have no figure and are not counted`] : [] }) : unavailable({ rule, missing: [label] }))), noun)
  const unknown = rows.reduce((count, row) => count + (included(row) ? missingIn(row) : missingIn(row) || 1), 0)

  return { result: total.result, unknown, value: valueOrNull(total.result), gap: unknown ? `${label} of ${unknown} ${noun}` : null }
}

// The total only where every row has a figure: a partial sum would pass for the whole.
const wholeValue = (total) => (total.unknown ? null : total.value)

const CAPACITY_RULE = 'logistics.facilityCapacity'
const LOCATION_RULE = 'logistics.maintenanceLocation'
const STOCK_RULE = 'logistics.maintenanceStock'
const FLEET_RULE = 'logistics.maintainedFleet'

// Maintenance locations: every colony body, and every spot in space with ships. Ships use MSP where they are, not where they're assigned: populations there first, then supply ships, then their own. Commercial classes and craft in military hangars need none. Over capacity, every ship there is maintained at the Effective Maintenance Rate (capacity / tons) and uses that share of its MSP. `modifierOf(PopulationID)`: the colony's overall production modifier, null where it is not in the save. A colony with no production figure stays out of the location's production, potential and blocked sums and is counted in `uncounted`; a location whose colonies all lack one has null for them (and for `net`) and unavailable `productionResult`, `potentialResult` and `netResult`. A fleet row may carry `MaintainedUnknown`, `TonsUnknown`, `AnnualUnknown`, `ModulesUnknown` and `SupplyUnknown` (counts of its ships whose class or stock the save does not describe): that fleet's figure is left out. The tonnage, upkeep and capacity are whole figures or null: `capacity`, `tons`, `ships`, `required`, `rate`, `upkeep`, `net` and `runway` are null while an input is missing, each with a result (`capacityResult`, `tonsResult`, `upkeepResult`, `netResult`, `runwayResult`) that names it; `stock` and `supply` are the sum of the rows that have a figure (null when none does) with `stockUnknown` and `supplyUnknown` counting the rest and a result saying so.
export const maintenanceLocations = ({ colonies, fleets, modifierOf, maintenanceCapacity, economicModifier }) => {
  const locations = {}
  const at = (key) => (locations[key] = locations[key] || { key, colonies: [], fleets: [] })

  colonies.forEach((colony) => at(`body-${colony.SystemBodyID}`).colonies.push(colony))
  fleets.forEach((fleet) => at(locationKey(fleet)).fleets.push(fleet))

  return Object.values(locations).map((location) => {
    const capacities = location.colonies.map(facilityCapacity)
    const surfaceUnknown = capacities.filter((value) => value === null).length
    const surfaceCapacity = capacities.reduce((total, value) => total + (value ?? 0), 0)
    const modules = columnTotal(FLEET_RULE, location.fleets, 'MaintenanceModules', 'the maintenance modules aboard', 'fleets', ['ModulesUnknown'])
    const racialKnown = isNumber(maintenanceCapacity) && isNumber(economicModifier)
    const capacityGaps = [...(surfaceUnknown ? [`the maintenance facility figures of ${surfaceUnknown} ${surfaceUnknown === 1 ? 'colony' : 'colonies'}`] : []), ...(modules.gap ? [modules.gap] : []), ...(modules.value > 0 && !racialKnown ? ['the racial maintenance capacity and the economic modifier'] : [])]
    const capacity = capacityGaps.length ? null : surfaceCapacity + (modules.value > 0 ? modules.value * maintenanceCapacity * economicModifier : 0)
    const capacityResult = capacity === null ? unavailable({ rule: CAPACITY_RULE, missing: capacityGaps }) : ofRule({ rule: CAPACITY_RULE, value: capacity, inputs: { present: ['the facilities and maintenance modules there'] } })
    const tonsTotal = columnTotal(FLEET_RULE, location.fleets, 'MaintainedTons', 'the size of the maintained ships', 'fleets', ['MaintainedUnknown', 'TonsUnknown'])
    const shipsTotal = columnTotal(FLEET_RULE, location.fleets, 'MaintainedShips', 'the maintained ships', 'fleets', ['MaintainedUnknown'])
    const requiredTotal = columnTotal(FLEET_RULE, location.fleets, 'AnnualMSP', 'the maintenance cost of the ships', 'fleets', ['MaintainedUnknown', 'AnnualUnknown'])
    const tons = wholeValue(tonsTotal)
    const required = wholeValue(requiredTotal)
    const rate = tons === null ? null : tons > 0 ? (capacity === null ? null : Math.min(1, Math.max(0, capacity / tons))) : 1
    const rateGaps = tons === null ? [tonsTotal.gap] : tons > 0 && capacity === null ? capacityGaps : []
    const upkeepGaps = [...(requiredTotal.gap ? [requiredTotal.gap] : []), ...rateGaps]
    const upkeepResult = required === 0 ? ofRule({ rule: LOCATION_RULE, value: 0, inputs: { present: ['the ships there need no maintenance supplies'] } }) : upkeepGaps.length ? unavailable({ rule: LOCATION_RULE, missing: upkeepGaps }) : ofRule({ rule: LOCATION_RULE, value: required * rate, inputs: { present: ['the maintenance cost of the ships', 'the tonnage and the capacity there'] } })
    const upkeep = valueOrNull(upkeepResult)
    const outputs = location.colonies.map((colony) => mspOutput(colony, modifierOf(colony.PopulationID)))
    const potentials = location.colonies.map((colony) => mspProduction(colony, modifierOf(colony.PopulationID)))
    const made = totalOf('logistics.mspOutput', outputs, 'colonies')
    const possible = totalOf('logistics.mspProduction', potentials, 'colonies')
    const potential = valueOrNull(possible.result)
    const production = valueOrNull(made.result)
    // Output lost to input minerals running short, and which minerals.
    const blocked = location.colonies.reduce((total, colony, index) => total + (colony.MaintProdStatus && isAvailable(potentials[index]) && isAvailable(outputs[index]) ? potentials[index].value - outputs[index].value : 0), 0)
    const missing = [...new Set(location.colonies.flatMap((colony) => mspMineralShortfall(colony, modifierOf(colony.PopulationID))))]
    const stock = columnTotal(STOCK_RULE, location.colonies, 'MaintenanceStockpile', 'the colony\'s maintenance stockpile', 'colonies')
    const supply = columnTotal(STOCK_RULE, location.fleets, 'SupplyMSP', 'the spare MSP of the supply ships', 'fleets', ['SupplyUnknown'])
    const netResult = combine({ rule: LOCATION_RULE, parts: { production: made.result, upkeep: upkeepResult }, compute: (values) => values.production - values.upkeep, inputs: { present: ['the upkeep of the ships there'] } })
    const net = valueOrNull(netResult)
    const stockGaps = [stock.gap, supply.gap].filter(Boolean)
    // Years until the colonies' stock and the supply ships' spare MSP run out; none to give while the net is not negative, unavailable while the stock is not whole.
    const runwayResult = net === null || net >= 0 ? null : stockGaps.length ? unavailable({ rule: LOCATION_RULE, missing: stockGaps }) : ofRule({ rule: LOCATION_RULE, value: (stock.value + supply.value) / -net, inputs: { present: ['the stock and the supply ships\' spare MSP', 'the net MSP a year'] } })

    return {
      ...location,
      surfaceCapacity,
      capacity,
      capacityResult,
      tons,
      tonsResult: tons === null ? unavailable({ rule: FLEET_RULE, missing: [tonsTotal.gap || 'the size of the maintained ships'] }) : tonsTotal.result,
      ships: wholeValue(shipsTotal),
      required,
      rate,
      upkeep,
      upkeepResult,
      potential,
      production,
      potentialResult: possible.result,
      productionResult: made.result,
      netResult,
      uncounted: made.unknown,
      blocked,
      missing,
      stock: stock.value,
      stockResult: stock.result,
      stockUnknown: stock.unknown,
      supply: supply.value,
      supplyResult: supply.result,
      supplyUnknown: supply.unknown,
      net,
      runway: valueOrNull(runwayResult),
      runwayResult,
      // The warning level of the colonies that give one; a colony with none set does not warn.
      warningLevel: columnTotal(STOCK_RULE, location.colonies, 'WarningMSP', 'the warning level', 'colonies').value ?? 0,
    }
  })
}

// Fuel a class burns per ship and year at full power: engine power x litres per EP-hour.
export const fullPowerBurn = (shipClass) => shipClass.EnginePower * shipClass.FuelEfficiency * HOURS_PER_YEAR

// The naval admin Mining multiplier a harvester earns: its fleet's command up the chain, and for a fleet with no command the race's root command. `admins`: as `loadNavalAdmins` gives them; `ship`: { SystemID, NavalAdminCommandID }.
export const harvesterAdminBonus = (admins, ship) => {
  const root = Object.values(admins).find((admin) => !admin.ParentCommandID)

  return navalAdminChainBonus(admins, ship.SystemID, ship.NavalAdminCommandID || (root ? root.NavalAdminCommandID : 0))
}

// Reasons a harvester gives no fuel now, in the order the game tests them: no undamaged module, no room in the undamaged tanks (any room at all is filled), not at a gas giant or super-Jovian (found by the fleet's coordinates), no Sorium in the deposit. Null when it harvests.
// Three reasons mean an input is not known, and then the output is unknown rather than 0: modules or tanks the class rows do not give, and a body the race has not surveyed (the game harvests there; the deposit is not visible).
// `ship`: { Harvesters (undamaged modules, null when unknown), FuelCapacity (undamaged tanks, null when unknown), Fuel, SystemBodyID, Surveyed, SoriumAmount }.
export const harvesterIdleReason = (ship) => {
  if (!Number.isFinite(ship.Harvesters)) {
    return 'Modules unknown'
  }

  if (ship.Harvesters <= 0) {
    return 'No working module'
  }

  if (!Number.isFinite(ship.FuelCapacity)) {
    return 'Tanks unknown'
  }

  if (!(ship.Fuel < ship.FuelCapacity)) {
    return 'Tanks full'
  }

  if (!ship.SystemBodyID) {
    return 'Not at a gas giant'
  }

  if (!ship.Surveyed) {
    return 'Not surveyed'
  }

  return ship.SoriumAmount > 0 ? null : 'No Sorium'
}

const UNKNOWN_REASONS = ['Modules unknown', 'Tanks unknown', 'Not surveyed']

// Whether an idle reason stands for a missing input (the output is then unknown, not 0).
export const harvesterReasonIsUnknown = (reason) => UNKNOWN_REASONS.includes(reason)

// A rule's status for a save: the rule's own verification where it holds for the save's formula version (`loadFormulaVersion`, null when the save is not 2.7-shaped), otherwise an estimate.
const statusFor = (rule, version) => (ruleSupports(rule, version) === true ? getRule(rule).verification : 'estimated')

const UNVERIFIED_SAVE = 'The save is not 2.7-shaped and has no version label, so the rule is not checked for its game version.'

const assumptionsFor = (rule, version) => (ruleSupports(rule, version) === true ? [] : [UNVERIFIED_SAVE])

// The inputs of the unconstrained rate the save does not give.
const rateMissing = (ship) => [
  ...(Number.isFinite(ship.Harvesters) ? [] : ['the undamaged harvester modules']),
  ...(crewFraction(ship) === null ? ['the ship\'s crew'] : []),
  ...(!ship.SystemBodyID ? ['a gas giant or super-Jovian under the fleet'] : !ship.Surveyed ? ['the Sorium deposit (the body is not surveyed)'] : []),
]

// A harvester's unconstrained fuel per year, as a provenance result of 'logistics.harvesterOutput': undamaged modules x the racial rate x the commander's and naval admin Mining bonuses x the deposit's accessibility x the crew share. Unavailable (not 0) while the modules or the deposit are not known. Ignores the tanks: it is the rate at which the harvester works, not fuel that fits.
const harvesterRate = (ship, admin, version) => {
  const rule = 'logistics.harvesterOutput'
  const missing = rateMissing(ship)

  if (missing.length) {
    return unavailable({ rule, missing, present: ['the racial rate', 'the commander and naval admin bonuses', 'the crew'] })
  }

  const value = ship.Harvesters * ship.FuelProduction * ship.MiningBonus * admin * crewFraction(ship) * (ship.SoriumAccessibility || 0)

  return envelope({ value, status: statusFor(rule, version), rule, inputs: { present: ['the undamaged modules', 'the racial rate', 'the commander and naval admin bonuses', 'the crew', 'the deposit'] }, assumptions: assumptionsFor(rule, version) })
}

// One harvester's standing: why it works or not, its undamaged modules, tank room, unconstrained rate (a result and its value, null when unknown) and the years the rate takes to fill the room and the deposit's litres. `ship` is a row of the page's harvesters query; `admin` the naval admin multiplier (`harvesterAdminBonus`); `version` the formula version.
export const harvesterBasis = (ship, { admin = 1, version = null } = {}) => {
  const idle = harvesterIdleReason(ship)
  const crew = crewFraction(ship)
  const room = Number.isFinite(ship.FuelCapacity) ? Math.max(0, ship.FuelCapacity - ship.Fuel) : null
  const rate = harvesterRate(ship, admin, version)
  const perYear = rate.value
  const depositLitres = ship.Surveyed && Number.isFinite(ship.SoriumAmount) ? ship.SoriumAmount * LITRES_PER_TON : null

  return {
    idle,
    unknown: harvesterReasonIsUnknown(idle) || (idle === null && crew === null),
    crew,
    modules: ship.Harvesters,
    classModules: ship.ClassHarvesters,
    capacity: ship.FuelCapacity,
    room,
    rate,
    perYear,
    depositLitres,
    fillYears: room === null || perYear === null ? null : room === 0 ? 0 : perYear > 0 ? room / perYear : null,
  }
}

// The fuel a harvester can add over `horizon` years, as { result, litres, limit }: its rate times the horizon, held first to the Sorium the deposit has and then to the room in its tanks (the game's order). `limit`: 'tanks', 'deposit' or 'rate' for what binds, null when the harvester gives nothing now. A harvester that cannot work for a known reason gives 0 litres; a missing module count, tank capacity or deposit gives an unavailable result with null litres, never 0. Each ship is taken against the whole deposit: `harvesterReport` holds a shared deposit to what it has.
export const harvesterObtainable = (basis, horizon, version = null) => {
  const rule = 'logistics.harvesterObtainable'

  if (basis.unknown) {
    const missing = [
      ...(Number.isFinite(basis.modules) ? [] : ['the undamaged harvester modules']),
      ...(Number.isFinite(basis.capacity) ? [] : ['the undamaged tank capacity']),
      ...(basis.crew === null ? ['the ship\'s crew'] : []),
      ...(basis.idle === 'Not surveyed' ? ['the Sorium deposit (the body is not surveyed)'] : []),
    ]

    return { result: unavailable({ rule, missing, present: ['the tank level', 'the harvester modules'] }), litres: null, limit: null }
  }

  const status = statusFor(rule, version)
  const assumptions = assumptionsFor(rule, version)
  const inputs = { present: ['the undamaged modules', 'the undamaged tanks', 'the tank level', 'the deposit'] }

  if (basis.idle) {
    return { result: envelope({ value: 0, status, rule, inputs, assumptions }), litres: 0, limit: null }
  }

  const litres = Math.min(basis.perYear * horizon, basis.depositLitres, basis.room)
  const limit = litres === basis.room ? 'tanks' : litres === basis.depositLitres ? 'deposit' : 'rate'

  return { result: envelope({ value: litres, status, rule, inputs, assumptions }), litres, limit }
}

// A race's harvesters over `horizon` years, one row per ship: the row of the query with `basis` fields, `obtainable` (a result), `obtainableLitres`, `limit`, `depositYears` (how long the body's deposit lasts at the rate of the ships that can fill their tanks now, null when any ship there is unknown) and `ships` and `overDeposit` for bodies shared by several. Ships over one body take from one deposit: the report's `litres` holds each body's total to the deposit. `unknown` counts ships whose output is unknown. `admins`: as `loadNavalAdmins` gives them.
export const harvesterReport = (ships, { admins, horizon, version = null }) => {
  const entries = ships.map((ship) => {
    const basis = harvesterBasis(ship, { admin: harvesterAdminBonus(admins, ship), version })

    return { ship, basis, taken: harvesterObtainable(basis, horizon, version) }
  })
  const bodies = {}

  entries.filter(({ ship }) => ship.SystemBodyID).forEach(({ ship, basis, taken }) => {
    const body = (bodies[ship.SystemBodyID] = bodies[ship.SystemBodyID] || { ships: 0, demand: 0, perYear: 0, unknown: 0, depositLitres: basis.depositLitres })

    body.ships++

    if (taken.litres === null) {
      body.unknown++
    } else {
      body.demand += taken.litres
    }

    if (basis.idle === null) {
      body.perYear += basis.perYear
    }
  })

  Object.values(bodies).forEach((body) => {
    body.litres = body.depositLitres === null ? body.demand : Math.min(body.demand, body.depositLitres)
    body.years = !body.unknown && body.depositLitres !== null && body.perYear > 0 ? body.depositLitres / body.perYear : null
  })

  return {
    rows: entries.map(({ ship, basis, taken }) => {
      const body = bodies[ship.SystemBodyID] || null

      return { ...ship, ...basis, obtainable: taken.result, obtainableLitres: taken.litres, limit: taken.limit, depositYears: body ? body.years : null, ships: body ? body.ships : 0, overDeposit: body !== null && body.depositLitres !== null && body.demand > body.depositLitres }
    }),
    litres: Object.values(bodies).reduce((sum, body) => sum + body.litres, 0),
    unknown: entries.filter(({ taken }) => taken.litres === null).length,
  }
}

// Litres or items at a readable precision: 2.5 bn, 1.2 M, 3.4 k.
export const compact = (value) => {
  const size = Math.abs(value)

  if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 2)} bn`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 1)} M`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} k`
  }

  return `${roundToDecimal(value, 0)}`
}

// The rule registry for the Logistics page's figures, with the evidence in docs/plans/aurcalcs/build-2.md § Logistics.
const LOGISTICS_VERSIONS = ['2.7.x']
const LEDGER = 'matches the game\'s own mineral ledger on every sample colony (docs/plans/aurcalcs/build-2.md § Logistics)'

registerRule({
  id: 'logistics.refineryOutput',
  versions: LOGISTICS_VERSIONS,
  units: 'L/yr',
  verification: 'confirmed',
  structure: ['FCT_Population.Refineries, FuelProduction, FuelProdStatus', 'the colony\'s production modifier'],
  note: `Refineries times the racial rate times the colony's production modifier, while production is on; ${LEDGER}.`,
})

registerRule({
  id: 'logistics.soriumLasts',
  versions: LOGISTICS_VERSIONS,
  units: 'years',
  verification: 'estimated',
  structure: ['FCT_Population.Sorium', 'logistics.refineryOutput'],
  note: 'The colony\'s Sorium stock over the tonnes its refineries use a year (their output over 2,000 L a tonne). Sorium that is mined or delivered meanwhile is not counted; the figure is not compared with a stored value.',
  assumptions: ['No Sorium is mined or delivered to the colony meanwhile'],
})

registerRule({
  id: 'logistics.mspProduction',
  versions: LOGISTICS_VERSIONS,
  units: 'MSP/yr',
  verification: 'confirmed',
  structure: ['FCT_Population.MaintenanceFacilities, MSPProduction, MaintProdStatus', 'the colony\'s production modifier'],
  note: `Facilities times the racial rate times 4 MSP per BP times the production modifier, while production is on; ${LEDGER}.`,
})

registerRule({
  id: 'logistics.mspOutput',
  versions: LOGISTICS_VERSIONS,
  units: 'MSP/yr',
  verification: 'estimated',
  structure: ['FCT_Population stockpiles of the input minerals', 'FCT_Population.Mines, Deposit<mineral>'],
  note: 'The production figure (logistics.mspProduction) held to what the input minerals allow. Mines elsewhere, orbital mining and incoming hauls are not visible from the colony row, so the cap can understate a colony supplied that way.',
  assumptions: ['Only the colony\'s own stockpile and its own body\'s mines supply the input minerals'],
})

registerRule({
  id: 'logistics.facilityCapacity',
  versions: LOGISTICS_VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_Population.MaintenanceFacilities, MaintenanceCapacity, Efficiency, CapacityModifier, EconomicProdModifier'],
  note: 'Facilities times the racial capacity times the colony\'s efficiency and modifiers, never negative, from the game\'s documentation; not compared with a stored figure.',
})

registerRule({
  id: 'logistics.fuelStock',
  versions: LOGISTICS_VERSIONS,
  units: 'L',
  verification: 'confirmed',
  structure: ['FCT_Population.FuelStockpile', 'FCT_Ship.Fuel'],
  note: 'The stored fuel of the colonies, tankers and other ships, summed as stored.',
})

registerRule({
  id: 'logistics.maintenanceStock',
  versions: LOGISTICS_VERSIONS,
  units: 'MSP',
  verification: 'confirmed',
  structure: ['FCT_Population.MaintenanceStockpile, WarningMSP', 'FCT_Ship.CurrentMaintSupplies and FCT_ShipClass.MinimumSupplies of the supply ships'],
  note: 'The stored maintenance stockpiles of the colonies at a spot and the spare MSP (above the class minimum) of the supply ships there, summed as stored.',
})

registerRule({
  id: 'logistics.maintainedFleet',
  versions: LOGISTICS_VERSIONS,
  units: 't, MSP/yr',
  verification: 'estimated',
  structure: ['FCT_ShipClass.Commercial, Size, Cost, MaintModules, Crew, SupplyShip', 'FCT_Ship.MaintenanceState, CurrentCrew, MothershipID'],
  note: 'What the ships of a fleet need maintained and the maintenance modules aboard: military classes not in a military hangar, a class\'s cost over 4 (its full cost while overhauling) a year, modules scaled by the crew aboard. A fleet with a ship the save does not describe is left out of the sums.',
  assumptions: ['A military class in no hangar is maintained where its fleet is'],
})

registerRule({
  id: 'logistics.maintenanceLocation',
  versions: LOGISTICS_VERSIONS,
  units: 'MSP/yr, t, years',
  verification: 'estimated',
  structure: ['FCT_Fleet.OrbitBodyID, Xcor, Ycor', 'FCT_ShipClass.Commercial, Size', 'FCT_Population maintenance columns'],
  note: 'Capacity, upkeep, net MSP and runway of the ships and colonies at one spot. The documentation\'s worked example (100 kt in orbit against 80 kt of capacity gives 80 %) is reproduced; the figures are not compared with a stored total, and the upkeep draws from where ships are, not where they are assigned.',
  assumptions: ['Ships use the supplies where they are, populations first, then supply ships, then their own', 'A ship in a military hangar needs none'],
})

registerRule({
  id: 'logistics.fullPowerBurn',
  versions: LOGISTICS_VERSIONS,
  units: 'L/yr per ship',
  verification: 'estimated',
  structure: ['FCT_ShipClass.EnginePower, FuelEfficiency'],
  note: 'Engine power times the fuel per engine-power hour times the hours of a year: the burn of a ship at full power all year, an upper bound. The save does not hold how long fleets run their engines, so the figure shown is a range.',
  assumptions: ['The ship runs its engines at full power for every hour of the year'],
})

registerRule({
  id: 'logistics.harvesterOutput',
  versions: LOGISTICS_VERSIONS,
  units: 'L/yr per ship',
  verification: 'confirmed',
  structure: ['FCT_ClassComponent and FCT_DamagedComponent (the undamaged harvester modules)', 'FCT_Race.FuelProduction', 'FCT_Ship.CurrentCrew, FCT_ShipClass.Crew', 'FCT_CommanderBonuses (Mining) and the naval admin chain', 'FCT_MineralDeposit.Accessibility of the body at the fleet\'s coordinates'],
  note: 'Undamaged modules times the racial Fuel Production rate (not the component\'s own value) times the commander\'s and naval admin Mining bonuses times the deposit\'s accessibility times the share of the crew aboard when it is short; a fleet with no command takes the race\'s root naval admin command. This is the game\'s 2.7.1 rule: its stored inputs (racial rate, class modules, accessibility, tank levels) were reconciled on two saves, but no clean fuel increment between saves has been observed, so the rate itself rests on the rule and those inputs.',
})

registerRule({
  id: 'logistics.harvesterObtainable',
  versions: LOGISTICS_VERSIONS,
  units: 'L',
  verification: 'confirmed',
  structure: ['logistics.harvesterOutput', 'FCT_Ship.Fuel and the undamaged FuelStorage components (FCT_ClassComponent, FCT_DamagedComponent)', 'FCT_MineralDeposit.Amount'],
  note: 'The unconstrained rate times the horizon, held first to the tonnes of Sorium the deposit has (2,000 L each) and then to the free room in the undamaged tanks; a ship with any room is filled and one with none gives nothing. The game\'s 2.7.1 order. The tank cap was observed on a save pair (35 of 36 ships ended at capacity); the rate was not, and the deposit\'s decline per cycle is not modelled.',
  assumptions: ['The deposit\'s accessibility holds over the horizon: it falls once less than half of the original amount is left, and that is not applied', 'Ships over one deposit take it in turn, so a body\'s total is held to the deposit and each ship\'s own figure is taken against all of it', 'The ship stays where it is, with its modules, crew and commanders, over the horizon'],
})
