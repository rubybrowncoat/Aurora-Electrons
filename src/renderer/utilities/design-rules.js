// The game's design rules, for the planners: what a component or a class built from the race's tech comes out at, as the game's design windows work it out. Pure functions with the units in their argument names: sizes in hull spaces (HS), power in engine power (EP), fuel in litres, speed in km/s, distance in km, cost in BP. docs/DATABASE.md § Design rules states each rule in prose.

import { combine, envelope, getRule, isAvailable, ofRule, registerRule, STATUS, unavailable } from './provenance'
import { HIT_RULES, hitScenario } from './missile-hit'
import { PACKAGE_STATUS, REQUEST_TOLERANCE, packerFor } from './tank-packing'

export { PACKAGE_STATUS, REQUEST_TOLERANCE, createTankPacker, meetsRequest, packerFor } from './tank-packing'

export const TONS_PER_HS = 50
export const THRUST_EXPONENT = 2.5
export const MAX_SPEED = 270000
export const COMMERCIAL_JUMP_MULTIPLIER = 5
// An engine is commercial from this size up, at this thrust or less; any other engine is military.
export const COMMERCIAL_ENGINE_MIN_HS = 25
export const COMMERCIAL_ENGINE_MAX_THRUST = 0.5
// The squadron size and radius techs the game's automatic jump drive uses (its "Add jump drive" button), whatever the race has researched.
export const DEFAULT_SQUADRON_SIZE_TECH = 819
export const DEFAULT_SQUADRON_RADIUS_TECH = 827
// The drive type techs: a military drive, and a commercial one, which moves five times the size it is designed for.
export const MILITARY_JUMP_DRIVE_TECH = 33302
export const COMMERCIAL_JUMP_DRIVE_TECH = 33303

// Rounds a midpoint to the even neighbour, as the game's rounding does, so 0.125 at 2 decimals is 0.12 and 2.5 is 2.
export const roundHalfEven = (value, decimals = 0) => {
  const factor = 10 ** decimals
  const scaled = value * factor
  const floor = Math.floor(scaled)

  if (Math.abs(scaled - floor - 0.5) < 1e-9) {
    return (Math.abs(floor) % 2 === 0 ? floor : floor + 1) / factor
  }

  return Math.round(scaled) / factor
}

// Cuts a positive value to a whole number, as the game's decimal sums do, without letting float error take 7 down to 6.9999999.
const floorExact = (value) => Math.floor(value + 1e-9)

// An engine as the game designs it from an engine tech (`engineTech` EP per HS), a fuel consumption tech (`fuelTech` litres per EP-hour at thrust 1 and 10 HS), a thermal reduction tech (`thermalTech` the share of the power that shows as heat, `thermalCost` what that reduction multiplies the cost by), a thrust modifier and a size in HS. Returns { power, fuelPerEph, fuelPerHour, commercial, cost, crew, htk, explosionChance, maxExplosion, thermal, sizeHS, tons }: `fuelPerEph` litres per EP-hour, `fuelPerHour` litres an hour at full power, `explosionChance` a percentage.
export const engineDesign = ({ sizeHS, thrust, engineTech, fuelTech, thermalTech = 1, thermalCost = 1 }) => {
  const power = roundHalfEven(engineTech * sizeHS * thrust, 2)
  const fuelPerEph = fuelTech * thrust ** THRUST_EXPONENT * Math.sqrt(10 / sizeHS)
  const costMultiplier = thermalTech < 1 ? thermalCost : 1
  const cost = Math.max(5, power / 2 * costMultiplier * (thrust < 1 ? thrust : 1))

  return {
    power,
    fuelPerEph,
    fuelPerHour: power * fuelPerEph,
    commercial: sizeHS >= COMMERCIAL_ENGINE_MIN_HS && thrust <= COMMERCIAL_ENGINE_MAX_THRUST,
    cost,
    crew: Math.max(1, roundHalfEven(sizeHS * thrust)),
    htk: Math.max(1, floorExact(Math.sqrt(sizeHS))),
    explosionChance: floorExact(thrust * 10),
    maxExplosion: floorExact(power / 4),
    thermal: thermalTech * power,
    sizeHS,
    tons: sizeHS * TONS_PER_HS,
  }
}

// A class's top speed in km/s from its engines' total power and its size: the power per HS times 1,000, cut to a whole number and capped at 270,000.
export const classSpeed = ({ enginePower, sizeHS }) => {
  return sizeHS > 0 ? Math.min(MAX_SPEED, floorExact(enginePower / sizeHS * 1000)) : 0
}

// Litres an hour a ship's engines burn at a share of their power (`fraction`, 1 at full speed): the burn scales with the speed, so the range doesn't.
export const burnPerHour = ({ enginePower, fuelPerEph, fraction = 1 }) => {
  return enginePower * fraction * fuelPerEph
}

// The km a ship covers on `fuel` litres, at any one speed, as the class window works it out at full power.
export const fullPowerRangeKm = ({ fuel, enginePower, fuelPerEph, speed }) => {
  const burn = burnPerHour({ enginePower, fuelPerEph })

  return burn > 0 ? fuel / burn * speed * 3600 : 0
}

// The hours `fuel` litres last at a share of the engines' power.
export const enduranceHours = ({ fuel, enginePower, fuelPerEph, fraction = 1 }) => {
  const burn = burnPerHour({ enginePower, fuelPerEph, fraction })

  return burn > 0 ? fuel / burn : 0
}

// A moving ship's thermal signature: the engines' power times their thermal rating (`stealthRating`, the engine design's thermal share) times the share of top speed it moves at, never under a twentieth of its size. A ship that isn't moving shows that floor.
export const thermalSignature = ({ enginePower, stealthRating, fraction = 1, sizeHS }) => {
  return Math.max(sizeHS / 20, enginePower * stealthRating * fraction)
}

// A class's stored thermal signature: the sum over its engines (`engines` of { power, thermalRating, count }) of the count times the power times the thermal rating, so the engines weigh by their power and never as an unweighted mean of their ratings.
export const classThermal = ({ engines }) => {
  return engines.reduce((total, { power, thermalRating, count }) => total + count * power * thermalRating, 0)
}

// The package of fuel tanks that holds `litres` from `tanks` ({ id, name, sizeHS, litres, cost, crew }) in the fewest HS, then the fewest BP, then the fewest tanks (`objective: 'lightest'`, the default), or in the fewest BP first (`'cheapest'`). The game has no packing rule; the objective is the planner's own, and the package is its exact optimum, worked out by the table solver of tank-packing.js, which also names the request tolerance. Returns { status ('optimal', 'bound-exhausted' or 'infeasible'), reason, complete (the answer is proved), feasible (the picks hold the litres), objective, requestedLitres, litres (delivered), excessLitres, count, sizeHS, cost, crew (null when a tank's crew is unknown), picks: [{ ...tank, count }] }, largest tank first. A caller that packs many requests from one list gets the packer once with `packerFor(tanks)`, which keeps its tables.
export const packTanks = ({ litres, tanks, objective = 'lightest' }) => packerFor(tanks).pack(litres, objective)

const PACKAGE_REASONS = {
  'table-cap': 'the request is larger than the largest table the planner builds and no repeating pattern was proved',
  'catalogue-not-whole': 'the tank figures cannot be made whole numbers',
  'request-too-large': 'the request is too large to size exactly',
}

const PACKAGE_MISSING = {
  'no-usable-tank': 'a fuel tank with known litres, size and cost',
  'invalid-request': 'a valid litres request',
  'request-not-finite': 'a finite litres request',
}

// A package's HS as a result of design.packTanks: the planner's own policy ('assumed') when the package is proved the best, 'estimated' when a bound ran out and it is only a package that holds the litres, unavailable when no package is known.
export const tankPackageResult = (pack) => {
  if (!pack.feasible) {
    return unavailable({ rule: 'design.packTanks', units: 'HS', missing: [PACKAGE_MISSING[pack.reason] || `a package: ${PACKAGE_REASONS[pack.reason] || 'none was found'}`] })
  }

  const inputs = { present: ['tank sizes', 'tank litres', 'tank costs'] }

  if (pack.status === PACKAGE_STATUS.OPTIMAL) {
    return ofRule({ rule: 'design.packTanks', value: pack.sizeHS, units: 'HS', inputs })
  }

  return envelope({ value: pack.sizeHS, status: STATUS.ESTIMATED, rule: 'design.packTanks', units: 'HS', inputs, assumptions: [`The package holds the litres but is not proved the ${pack.objective}: ${PACKAGE_REASONS[pack.reason] || pack.reason}`] })
}

// A jump drive as the game designs it for ships up to `shipSizeHS`, from the jump drive efficiency tech (`efficiency`) and the cost multipliers of the squadron size and radius techs. A commercial drive is five times the size and moves five times the ships. Returns { sizeHS, capacityHS, cost, crew, htk, commercial, modifiedEfficiency }.
export const jumpDriveDesign = ({ shipSizeHS, efficiency, squadronSizeCost = 1, squadronRadiusCost = 1, commercial = false }) => {
  const scaling = Math.max(1, (shipSizeHS / 20) ** 0.25)
  const modifiedEfficiency = efficiency * scaling
  const sizeHS = shipSizeHS / modifiedEfficiency

  return {
    sizeHS: commercial ? roundHalfEven(sizeHS * COMMERCIAL_JUMP_MULTIPLIER, 2) : sizeHS,
    capacityHS: commercial ? shipSizeHS * COMMERCIAL_JUMP_MULTIPLIER : shipSizeHS,
    cost: shipSizeHS / efficiency * squadronSizeCost * squadronRadiusCost * 5,
    crew: roundHalfEven(sizeHS * 2),
    htk: floorExact(Math.sqrt(sizeHS)),
    commercial,
    modifiedEfficiency,
  }
}

// The jump drive the game adds to a class of `hullHS` without one: it designs a drive for the class's size, rounded up (a fifth of it for a commercial drive), and grows it by 1 HS until the drive moves the class with the drive aboard. The drive grows slower than what it moves, so a race with any efficiency tech gets there. The game also re-sizes the armour as the class grows; this keeps the rest of the hull as it is. Returns the drive with `designHS` (the size it was designed for) and `totalHS` (the hull with it), or null without an efficiency tech.
export const selfJumpDrive = ({ hullHS, efficiency, squadronSizeCost = 1, squadronRadiusCost = 1, commercial = false }) => {
  if (!(efficiency > 0)) {
    return null
  }

  let designHS = commercial ? Math.ceil(hullHS / COMMERCIAL_JUMP_MULTIPLIER) : Math.ceil(hullHS)

  for (;;) {
    const drive = jumpDriveDesign({ shipSizeHS: designHS, efficiency, squadronSizeCost, squadronRadiusCost, commercial })
    const totalHS = hullHS + drive.sizeHS

    if (totalHS <= drive.capacityHS) {
      return { ...drive, designHS, totalHS }
    }

    designHS += 1
  }
}

// Ship maintenance: the class window's own figures, from a design alone. Component type ids as the game stores them in FCT_ShipDesignComponents.ComponentTypeID.
export const ARMOUR_COMPONENT_TYPE = 11
export const ENGINEERING_COMPONENT_TYPE = 31
export const MAINTENANCE_STORAGE_COMPONENT_TYPE = 47
// A class's engineering is judged against this share of its size (HS of engineering per HS of hull); a class without engineering fails at this many percent a year per HS instead.
export const ENGINEERING_COVERAGE = 0.04
export const UNENGINEERED_AFR_PER_HS = 10
// The most years the class window's maintenance loop runs.
export const MAINTENANCE_LIFE_YEARS = 200

// Rounds a positive value up to a whole number, without letting float error take 3 up to 4 (a 0.1 HS component times 30 is 3.0000000000000004).
const ceilExact = (value) => Math.ceil(value - 1e-9)

const given = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))

const positive = (value) => given(value) && Number(value) > 0

const nonNegative = (value) => given(value) && Number(value) >= 0

const KIND_FLAGS = [true, false, 1, 0]

// Splits [name, ok, reason] checks into the inputs present and the ones missing; a missing input is named by its reason where it has one.
const gather = (checks) => ({ present: checks.filter(([, ok]) => ok).map(([name]) => name), missing: checks.filter(([, ok]) => !ok).map(([name, , reason]) => reason || name) })

// The class's engineering MSP: half its cost over its engineering coverage factor (`engineeringValue` the sum of the engineering components' value times count, `cost` the class's BP), cut to a whole number. Not applicable, with the reason named, for a class with no engineering (its supplies are its storage alone) or no cost; never 0.
export const engineeringMsp = ({ sizeHS, cost, engineeringValue }) => {
  const rule = 'design.engineeringMsp'
  const { present, missing } = gather([
    ['class size', positive(sizeHS), 'class size above zero'],
    ['class cost', given(cost) && Number(cost) >= 0, 'the class cost'],
    ['engineering', nonNegative(engineeringValue), 'the class\'s engineering'],
  ])

  if (!missing.length && Number(cost) === 0) {
    missing.push('class cost above zero: engineering MSP is half the cost, so a class with no cost has none')
  }

  if (!missing.length && Number(engineeringValue) === 0) {
    missing.push('engineering above zero: a class with none has no engineering MSP, its supplies are its maintenance storage alone')
  }

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  return ofRule({ rule, value: floorExact(Number(cost) / 2 * Number(engineeringValue) / (Number(sizeHS) * ENGINEERING_COVERAGE)), inputs: { present } })
}

// The MSP the class's maintenance storage components hold: each component's value times its count, cut to a whole number on its own, then summed (`components` as { value, count }). A class with no storage component holds none; that is a known 0.
export const maintenanceStorage = ({ components }) => {
  const rule = 'design.maintenanceStorage'
  const rows = Array.isArray(components) ? components : null
  const { present, missing } = gather([
    ['storage components', rows !== null, 'storage components (the class\'s maintenance storage rows, none if it has none)'],
    ['storage values and counts', rows !== null && rows.every((row) => nonNegative(row.value) && nonNegative(row.count)), 'a storage value and count of zero or more for every component'],
  ])

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  return ofRule({ rule, value: rows.reduce((total, row) => total + floorExact(Number(row.value) * Number(row.count)), 0), inputs: { present } })
}

// The class's MSP, as stored in MaintSupplies: engineering MSP plus storage. A class with no engineering (`engineeringValue` of 0) holds its storage alone, which is the game's own figure for it; an unknown engineering, or a class with engineering but no cost, gives no figure.
export const classMaintenanceSupplies = ({ sizeHS, cost, engineeringValue, storage }) => {
  const rule = 'design.classMaintenanceSupplies'
  const stored = maintenanceStorage({ components: storage })

  if (given(engineeringValue) && Number(engineeringValue) === 0) {
    return combine({ rule, parts: { storage: stored }, compute: (values) => values.storage, assumptions: ['no engineering: the class holds its maintenance storage alone'] })
  }

  return combine({ rule, parts: { engineering: engineeringMsp({ sizeHS, cost, engineeringValue }), storage: stored }, compute: (values) => values.engineering + values.storage })
}

// The class's annual failure rate, in percent a year at a maintenance clock of one year (the stored BaseFailureChance): half the size times the coverage factor, `sizeHS` x 0.04 over the engineering. A class with no engineering fails at ten percent a year per HS of size, the game's own flat rate, and the result says so; an unknown engineering gives no figure.
export const annualFailureRate = ({ sizeHS, engineeringValue }) => {
  const rule = 'design.annualFailureRate'
  const { present, missing } = gather([
    ['class size', positive(sizeHS), 'class size above zero'],
    ['engineering', nonNegative(engineeringValue), 'engineering of zero or more'],
  ])

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  if (Number(engineeringValue) === 0) {
    return ofRule({ rule, value: Number(sizeHS) * UNENGINEERED_AFR_PER_HS, inputs: { present }, assumptions: ['no engineering: the game\'s flat rate of 10% a year per HS replaces the coverage formula'] })
  }

  return ofRule({ rule, value: Number(sizeHS) / 2 * (Number(sizeHS) * ENGINEERING_COVERAGE / Number(engineeringValue)), inputs: { present } })
}

// The damage allocation table of a class built from `components` in design order, as { sizeHS, count, armour }: each component other than armour takes the next slice of the roll, its size times its count rounded up, and its chance-to-hit threshold is the running total; armour takes none (threshold 0). Returns { chanceToHit: [one threshold per component, in the order given], maxDacRoll: the total }. A class with nothing but armour has no roll and gives no figure. The order of the table is the game's design order, which a saved class does not keep apart from its thresholds; the roll and every slice are the same in any order.
export const damageAllocation = ({ components }) => {
  const rule = 'design.damageAllocation'
  const rows = Array.isArray(components) ? components : null
  const { present, missing } = gather([
    ['components', rows !== null && rows.length > 0, 'components'],
    ['component sizes and counts', rows !== null && rows.every((row) => nonNegative(row.sizeHS) && nonNegative(row.count)), 'a size and count of zero or more for every component'],
  ])

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  let total = 0
  const chanceToHit = rows.map((row) => {
    if (row.armour) {
      return 0
    }

    total += ceilExact(Number(row.sizeHS) * Number(row.count))

    return total
  })

  if (total === 0) {
    return unavailable({ rule, present, missing: ['a component other than armour with a size: a class with none has no damage allocation roll'] })
  }

  return ofRule({ rule, value: { chanceToHit, maxDacRoll: total }, inputs: { present } })
}

// The average MSP a failure costs a class: each component's cost weighted by the share of the damage roll it covers, which is the difference between its chance-to-hit threshold and the one before it (components in threshold order, armour at 0 first) over `maxDacRoll`. `components` as { chanceToHit, cost }. The weights are those slices of the roll, not the components' counts or sizes: a component's slice is its size times its count rounded up. A class with no roll, thresholds past the roll, or only free components gives no figure, never 0.
export const averageRepairCost = ({ components, maxDacRoll }) => {
  const rule = 'design.averageRepairCost'
  const rows = Array.isArray(components) ? components : []
  const { present, missing } = gather([
    ['components', rows.length > 0, 'components'],
    ['component thresholds', rows.length > 0 && rows.every((row) => nonNegative(row.chanceToHit)), 'a chance-to-hit threshold of zero or more for every component'],
    ['component costs', rows.length > 0 && rows.every((row) => nonNegative(row.cost)), 'a cost of zero or more for every component'],
    ['damage roll', nonNegative(maxDacRoll), 'the class\'s damage roll'],
  ])

  if (!missing.length && Number(maxDacRoll) === 0) {
    missing.push('a damage roll above zero: a class with none has no damage allocation')
  }

  if (!missing.length && rows.some((row) => Number(row.chanceToHit) > Number(maxDacRoll))) {
    missing.push('component thresholds within the damage roll')
  }

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  let previous = 0
  let weighted = 0

  for (const row of [...rows].sort((a, b) => a.chanceToHit - b.chanceToHit)) {
    weighted += Number(row.cost) * ((Number(row.chanceToHit) - previous) / Number(maxDacRoll))
    previous = Number(row.chanceToHit)
  }

  if (!(weighted > 0)) {
    return unavailable({ rule, present, missing: ['a component cost above zero: a failure of a class whose parts are free draws no supplies'] })
  }

  return ofRule({ rule, value: weighted, inputs: { present } })
}

// A class's expected maintenance life as the class window works it out, one row a year of an unmaintained clock that is never reset: in year n the failure rate is `baseFailureChance` x n / 100 and the supplies spent that year are `averageRepairCost` times it, so the draw grows by the same step every year; the loop stops in the year the running total passes `maintSupplies`. Returns { life, firstYear, fiveYear, years: [{ year, failureRate, supplyUse, cumulative, remaining, fundedFraction }] } where `life` is the whole years before that year plus the part of it the remainder pays for, to 2 decimals (the game's rounding), `firstYear` the first year's spend and `fiveYear` the game's 5-year figure (15 times it, the sum of years 1 to 5). The last row is the year the supplies run out: `fundedFraction` below 1, `cumulative` the supplies spent. `commercial` is true or false (or 1 or 0 as the save stores it) and has no default; a commercial class has no life. A missing input, no failure (a zero rate or repair cost), or supplies that outlast the 200 years give no figure. This is the class's expected series on a fresh clock: it knows nothing of a ship's actual clock, crew, commanders, location coverage or the supplies it holds now (see `incrementFailureChance`).
export const maintenanceLifeSeries = ({ commercial, baseFailureChance, averageRepairCost: repairCost, maintSupplies }) => {
  const rule = 'design.maintenanceLifeSeries'
  const { present, missing } = gather([
    ['class type (military or commercial)', KIND_FLAGS.includes(commercial), 'class type (military or commercial)'],
    ['base failure chance', nonNegative(baseFailureChance), 'the class\'s annual failure rate'],
    ['average repair cost', nonNegative(repairCost), 'the class\'s average repair cost'],
    ['maintenance supplies', nonNegative(maintSupplies), 'maintenance supplies of zero or more'],
  ])

  if (commercial === true || commercial === 1) {
    missing.unshift('a military class: the game gives a commercial class no maintenance life')
  }

  if (nonNegative(baseFailureChance) && Number(baseFailureChance) === 0) {
    missing.push('a failure chance above zero: a class that never fails has no maintenance life')
  }

  if (nonNegative(repairCost) && Number(repairCost) === 0) {
    missing.push('an average repair cost above zero: a class whose failures cost nothing has no maintenance life')
  }

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  const years = []
  let cumulative = 0

  for (let year = 1; year <= MAINTENANCE_LIFE_YEARS; year++) {
    const failureRate = Number(baseFailureChance) * year / 100
    const supplyUse = Number(repairCost) * failureRate

    if (cumulative + supplyUse > Number(maintSupplies)) {
      const fundedFraction = (Number(maintSupplies) - cumulative) / supplyUse

      years.push({ year, failureRate, supplyUse, cumulative: Number(maintSupplies), remaining: 0, fundedFraction })

      const firstYear = Number(repairCost) * Number(baseFailureChance) / 100

      return ofRule({ rule, value: { life: roundHalfEven((year - 1) + fundedFraction, 2), firstYear, fiveYear: firstYear * 15, years }, inputs: { present } })
    }

    cumulative += supplyUse
    years.push({ year, failureRate, supplyUse, cumulative, remaining: Number(maintSupplies) - cumulative, fundedFraction: 1 })
  }

  return unavailable({ rule, present, missing: [`supplies that run out within ${MAINTENANCE_LIFE_YEARS} years`] })
}

// The chance, in percent, that a ship suffers a maintenance failure in one game increment, as the game works it out for a ship outside a maintenance location or short of cover. `baseFailureChance` is the ship's own annual failure rate: the class's stored one while all its engineering is undamaged (the game re-reads the ship's engineering each increment, so damage raises it); `clockYears` the years since its last overhaul; `elapsedYears` the increment's length; `uncoveredFraction` 1 away from maintenance and one minus the coverage where capacity or supplies fall short; `crewPerformance` and `engineeringBonus` the ship's crew performance modifier and its combined commander and admin engineering multiplier; `training` whether its fleet is under a training command (doubles the rate). A ship whose clock is at zero is not tested and gives no figure. Every input is the ship's runtime state and has no default.
export const incrementFailureChance = ({ baseFailureChance, clockYears, elapsedYears, uncoveredFraction, crewPerformance, engineeringBonus, training }) => {
  const rule = 'design.incrementFailureChance'
  const { present, missing } = gather([
    ['annual failure rate', nonNegative(baseFailureChance), 'an annual failure rate of zero or more'],
    ['maintenance clock', nonNegative(clockYears), 'a maintenance clock of zero or more years'],
    ['elapsed years', nonNegative(elapsedYears), 'elapsed years of zero or more'],
    ['uncovered fraction', given(uncoveredFraction) && Number(uncoveredFraction) >= 0 && Number(uncoveredFraction) <= 1, 'an uncovered fraction from 0 to 1'],
    ['crew performance', given(crewPerformance), 'the ship\'s crew performance modifier'],
    ['engineering bonus', given(engineeringBonus), 'the combined commander and admin engineering multiplier'],
    ['training command', KIND_FLAGS.includes(training), 'whether the fleet is under a training command'],
  ])

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  const base = Number(baseFailureChance) * Number(clockYears)

  if (!(base > 0)) {
    return unavailable({ rule, present, missing: ['a maintenance clock and failure rate above zero: the game does not test a ship whose product is zero'] })
  }

  const rate = (training === true || training === 1) ? base * 2 : base

  return ofRule({ rule, value: Number(elapsedYears) * (rate * Number(uncoveredFraction)) * (2 - Number(crewPerformance)) * (2 - Number(engineeringBonus)), inputs: { present } })
}

// ---------- missile designs ----------

// A missile is built from its engine, the sizes the designer allots to fuel, warhead, sensors and decoys, the options switched on, a second stage and a size limit. Its size is in MSP and an engine's size scales by hull spaces, 20 MSP to the HS. Every function below is one formula as plain numbers: a figure that needs an input the caller does not have is null, never 0. `evaluateMissile` gives the provenance results. docs/DATABASE.md § Design rules states each rule in prose.
export const MSP_PER_HS = 20
export const FUEL_LITRES_PER_MSP = 2500
export const MAX_MISSILE_SPEED = 270000
export const MIN_MISSILE_SIZE = 1
export const MIN_SHIP_DECOY_SIZE = 5
export const MIN_SENSOR_MSP = 0.25
export const SENSOR_STRENGTH_FACTOR = 0.05
export const REACTOR_OUTPUT_DIVISOR = 5
export const REACTOR_BP_PER_OUTPUT = 3
export const WARHEAD_BP_DIVISOR = 4
export const ECCM_MSP = 0.25
export const TERMINAL_GUIDANCE_MSP = 0.25
export const RETARGETING_MSP = 0.5
export const LASER_WARHEAD_MSP = 0.25
export const EXTRA_WARHEAD_MSP = 0.1
export const DECOY_MSP = 0.5
export const SHIP_DECOY_BP_PER_MSP = 4
export const SHIP_DECOY_STRENGTH_PER_MSP = 200
export const ECCM_BP_DIVISOR = 20
export const THRUST_BOOST_SLOPE = 4
export const SENSOR_PI = 3.1416
// The highest retargeting level whose size and cost a saved design shows; a higher one is not validated.
export const VALIDATED_RETARGETING = 1

// The highest value of each quantity the cost and mineral formulas read, among the saved designs whose cost and minerals the accounting reproduces (the fixtures of scripts/lib/missile-fixtures.json: scripts/check-design-rules.js derives these from them and fails when they differ). The formulas take products of a size and a tech (a strength, a damage), so the products are bounded as well as the sizes, and no tech level is bounded alone. A candidate with a quantity above its value is beyond what the cost and minerals are checked for, so they are estimated there (design.missileAccountingExtended).
export const MISSILE_COST_DOMAIN = Object.freeze({ warheadMsp: 23, warheadDamage: 46, shipDecoyMsp: 39, warheads: 4, activeMsp: 0.675, thermalMsp: 0.25, emMsp: 0.25, geoMsp: 0.343, activeStrength: 0.65, thermalStrength: 0.18, emStrength: 0.08, geoStrength: 0.02, reactorOutput: 0.13, laserEfficiency: 60, eccm: 15, terminal: 1.9, decoys: 3, engineBp: 22.5, enginePower: 45, stages: 9 })

// The minerals a saved missile design stores, and the two the game also charges for which it has no column: a laser warhead's Corundium and a ground pod's Vendarite.
export const MISSILE_STORED_MINERALS = Object.freeze(['Corbomite', 'Tritanium', 'Boronide', 'Uridium', 'Gallicite'])
export const MISSILE_UNSTORED_MINERALS = Object.freeze(['Corundium', 'Vendarite'])
export const MISSILE_MINERALS = Object.freeze([...MISSILE_STORED_MINERALS, ...MISSILE_UNSTORED_MINERALS])

// The options of a missile, in the order the game adds their sizes: each has an MSP, a BP and a mineral amount.
export const MISSILE_OPTIONS = Object.freeze({ engine: 'Engine', fuel: 'Fuel', warhead: 'Warhead', reactor: 'Sensor reactor', active: 'Active sensor', thermal: 'Thermal sensor', em: 'EM sensor', geo: 'Geo sensor', decoys: 'ECM decoys', extraWarheads: 'Extra warheads', secondStage: 'Second stage', eccm: 'ECCM', terminal: 'Terminal guidance', retarget: 'Retargeting', laser: 'Laser warhead' })
export const CONTRIBUTIONS = Object.freeze(Object.keys(MISSILE_OPTIONS))

// Whether two figures reproduce one another: 1e-9 of the larger, and never closer than 1e-12 absolute, so two zeros agree.
export const REPRODUCTION_TOLERANCE = 1e-9

export const agrees = (stored, computed) => Math.abs(stored - computed) <= Math.max(1e-12, REPRODUCTION_TOLERANCE * Math.max(Math.abs(stored), Math.abs(computed)))

const isKnown = (value) => value !== null && value !== undefined && !Number.isNaN(value)

const allKnown = (...values) => values.every(isKnown)

const zeroMinerals = () => Object.fromEntries(MISSILE_MINERALS.map((name) => [name, 0]))

const mineralsOf = (amounts) => ({ ...zeroMinerals(), ...amounts })

// An engine's power and fuel use as the game designs a missile engine from its engine tech (EP per HS at thrust 1), fuel tech (litres per EP-hour at thrust 1 and 10 HS), thrust modifier and size in MSP. Above the race's greatest thrust modifier the fuel use is boosted by the excess over it, four times over; the power and the cost are not. Returns { power, fuelEfficiency, cost }.
export const missileEngineDesign = ({ sizeMsp, thrust, engineTech, fuelTech, maxThrust }) => {
  const sizeHS = sizeMsp / MSP_PER_HS
  const boost = thrust > maxThrust ? (thrust - maxThrust) / maxThrust * THRUST_BOOST_SLOPE + 1 : 1
  const power = roundHalfEven(engineTech * sizeHS * thrust, 2)

  return { power, fuelEfficiency: fuelTech * thrust ** THRUST_EXPONENT * boost * Math.sqrt(10 / sizeHS), cost: power / 2 * (thrust < 1 ? thrust : 1) }
}

// The thrust modifier an engine was designed at, from its stored power: the design rounds the power to 2 decimals, so this is exact to that rounding.
export const thrustOfMissileEngine = ({ power, sizeMsp, engineTech }) => power / (engineTech * (sizeMsp / MSP_PER_HS))

// A warhead's strength: its MSP times the warhead tech, cut by the radiation multiplier, to 3 decimals. A ship decoy has 200 a MSP and no tech.
export const missileWarheadStrength = ({ warheadMsp, warheadTech, radiationMultiplier = 1, shipDecoy = false }) => {
  if (!(warheadMsp > 0)) {
    return 0
  }

  if (shipDecoy) {
    return roundHalfEven(warheadMsp * SHIP_DECOY_STRENGTH_PER_MSP / radiationMultiplier, 3)
  }

  return isKnown(warheadTech) ? roundHalfEven(warheadMsp * warheadTech / radiationMultiplier, 3) : null
}

// The damage the warhead does before the radiation split, unrounded: what the Tritanium of the warhead is a quarter of.
export const missileWarheadDamage = ({ warheadMsp, warheadTech, shipDecoy = false }) => {
  if (!(warheadMsp > 0)) {
    return 0
  }

  if (shipDecoy) {
    return warheadMsp * SHIP_DECOY_STRENGTH_PER_MSP
  }

  return isKnown(warheadTech) ? warheadMsp * warheadTech : null
}

// A sensor's strength: its MSP times the sensor tech times 0.05, to 2 decimals; a sensor under a quarter of an MSP has none.
export const missileSensorStrength = ({ sensorMsp, sensorTech }) => {
  if (!(sensorMsp >= MIN_SENSOR_MSP)) {
    return 0
  }

  return isKnown(sensorTech) ? roundHalfEven(sensorMsp * sensorTech * SENSOR_STRENGTH_FACTOR, 2) : null
}

// The reactor that feeds the sensors: a fifth of the summed strength is the output the reactor must give, to 4 decimals, and its size is that over the power plant tech times 0.05, to 4 decimals. With no output the reactor is not needed, whatever the tech.
export const missileReactorOutput = (strengths) => (strengths.every(isKnown) ? roundHalfEven(strengths.reduce((total, value) => total + value, 0) / REACTOR_OUTPUT_DIVISOR, 4) : null)

export const missileReactorMsp = ({ output, reactorTech }) => {
  if (!isKnown(output)) {
    return null
  }

  if (output === 0) {
    return 0
  }

  return isKnown(reactorTech) && reactorTech > 0 ? roundHalfEven(output / (reactorTech * SENSOR_STRENGTH_FACTOR), 4) : null
}

// A laser warhead keeps the share of the strength its efficiency tech (a percentage) gives, to 3 decimals.
export const missileLaserStrength = ({ strength, efficiency }) => (allKnown(strength, efficiency) ? roundHalfEven(strength * (efficiency / 100), 3) : null)

// An active sensor's range in km: the square root of its strength times the EM sensitivity the design recorded times the resolution to the power 2/3, over pi as the game approximates it, in millions of km, rounded to a whole number.
export const missileSensorRange = ({ strength, emSensitivity, resolution }) => {
  if (!(resolution !== 0 && strength !== 0)) {
    return 0
  }

  return allKnown(strength, emSensitivity) ? roundHalfEven(Math.sqrt(strength * emSensitivity * resolution ** (2 / 3) / SENSOR_PI) * 1e6, 0) : null
}

const contribution = (msp, bp, minerals, unknown = null) => ({ msp, bp, minerals: minerals === null ? null : mineralsOf(minerals), unknown })

const sumOf = (contributions, field) => (contributions.some((entry) => !isKnown(entry[field])) ? null : contributions.reduce((total, entry) => total + entry[field], 0))

const sumMinerals = (contributions) => Object.fromEntries(MISSILE_MINERALS.map((name) => [name, contributions.some((entry) => entry.minerals === null || entry.minerals[name] === null) ? null : contributions.reduce((total, entry) => total + entry.minerals[name], 0)]))

// The size of a design from the sum of its contributions: no under 5 for a ship decoy and 1 otherwise, and no over the designer's size limit (0 for none).
const clampSize = (sum, { shipDecoy, sizeLimit }) => {
  let size = sum

  if (shipDecoy && size < MIN_SHIP_DECOY_SIZE) {
    size = MIN_SHIP_DECOY_SIZE
  } else if (size < MIN_MISSILE_SIZE) {
    size = MIN_MISSILE_SIZE
  }

  if (sizeLimit > 0 && size > sizeLimit) {
    size = sizeLimit
  }

  return size
}

const ENGINE_MISSING = 'the engine component the design names is not in the save'
const STAGE_MISSING = 'the second stage design is not in the save'

// A design built by the game's own order of work. `input`:
//   warheadMsp, warheads (the count, 1 or more; each warhead after the first adds 0.1 MSP to the size and to the Tritanium and cost), shipDecoy (whether the decoy tech was held and chosen), decoys (ECM decoys), fuelMsp, activeMsp, thermalMsp, emMsp, geoMsp, sizeLimit (0 for none: the designer's limit on the missile's size, which a save does not store);
//   engine ({ sizeMsp, cost, power, fuelEfficiency } of the engine component; { missing: true, storedMsp, reason } for an engine the design has but the figures of which are not known, `storedMsp` its size or null where that is not known; null for no engine) and engines (the count);
//   stage ({ size, cost, fuelRequired, totalFlightTime, minerals } of the second-stage design, { missing: true, reason } for one not known, or null) and stages (its count);
//   options { eccm, terminal, retarget, laser } as the values the design stored (`eccm` the ECCM level, `terminal` the guidance multiplier, `retarget` the retargeting level, `laser` whether a laser warhead is fitted);
//   tech { warhead, laserEfficiency, reactor, active, thermal, em, geo } the levels' figures, null where the level is not known;
//   unsupported { [option]: { reason, size } } the options whose accounting the rules do not cover: the option's cost and minerals are unknown, and its size too when `size` is true.
// Returns { contributions: { name: { msp, bp, minerals, unknown } }, figures }. A figure that depends on an unknown input is null and the contribution that lacks it says why; the size of a contribution can be known while its cost is not (a sensor's MSP is the designer's, its cost needs its tech).
export const missileAccounting = (input) => {
  const { warheadMsp, warheads, shipDecoy, decoys, fuelMsp, activeMsp, thermalMsp, emMsp, geoMsp, sizeLimit = 0, engine, engines, stage, stages, options, tech, unsupported = {} } = input
  const baseDamage = missileWarheadDamage({ warheadMsp, warheadTech: tech.warhead, shipDecoy })
  const strength = unsupported.warhead ? null : missileWarheadStrength({ warheadMsp, warheadTech: tech.warhead, shipDecoy })
  const strengths = [missileSensorStrength({ sensorMsp: activeMsp, sensorTech: tech.active }), missileSensorStrength({ sensorMsp: thermalMsp, sensorTech: tech.thermal }), missileSensorStrength({ sensorMsp: emMsp, sensorTech: tech.em }), missileSensorStrength({ sensorMsp: geoMsp, sensorTech: tech.geo })]
  const output = missileReactorOutput(strengths)
  const reactor = missileReactorMsp({ output, reactorTech: tech.reactor })
  const laserWarhead = options.laser ? missileLaserStrength({ strength, efficiency: tech.laserEfficiency }) : 0
  const extra = warheads > 1 ? EXTRA_WARHEAD_MSP * (warheads - 1) : 0
  const hasEngine = Boolean(engine) && engines > 0
  const contributions = {}

  if (!hasEngine) {
    contributions.engine = contribution(0, 0, {})
  } else if (engine.missing) {
    contributions.engine = contribution(engine.storedMsp, null, { Boronide: null, Gallicite: null }, engine.reason || ENGINE_MISSING)
  } else {
    const engineBp = roundHalfEven(engine.cost * engines, 4)

    contributions.engine = contribution(roundHalfEven(engine.sizeMsp * engines, 4), engineBp, { Boronide: engineBp / 2, Gallicite: engineBp / 2 })
  }

  contributions.fuel = contribution(fuelMsp, 0, {})

  if (shipDecoy) {
    contributions.warhead = contribution(warheadMsp, SHIP_DECOY_BP_PER_MSP * warheadMsp, { Corbomite: SHIP_DECOY_BP_PER_MSP * warheadMsp })
  } else if (warheadMsp > 0 && !isKnown(baseDamage)) {
    contributions.warhead = contribution(warheadMsp, null, null, 'the warhead tech level (type 12) is not known')
  } else {
    const warheadBp = isKnown(baseDamage) ? baseDamage / WARHEAD_BP_DIVISOR : 0

    contributions.warhead = contribution(warheadMsp, warheadBp, { Tritanium: warheadBp })
  }

  const reactorBp = isKnown(output) ? roundHalfEven(output * REACTOR_BP_PER_OUTPUT, 3) : null

  if (!isKnown(output)) {
    contributions.reactor = contribution(null, null, null, 'the strength of a sensor is not known: its tech level is not')
  } else if (!isKnown(reactor)) {
    contributions.reactor = contribution(null, reactorBp, { Boronide: reactorBp }, 'the power plant tech level (type 41) is not known')
  } else {
    contributions.reactor = contribution(reactor, reactorBp, { Boronide: reactorBp })
  }

  const sensorContribution = (name, msp, value) => {
    contributions[name] = isKnown(value) ? contribution(msp, value, { Uridium: value }) : contribution(msp, null, null, `the ${name} sensor tech level is not known`)
  }

  sensorContribution('active', activeMsp, strengths[0])
  sensorContribution('thermal', thermalMsp, strengths[1])
  sensorContribution('em', emMsp, strengths[2])
  sensorContribution('geo', geoMsp, strengths[3])
  contributions.decoys = contribution(decoys * DECOY_MSP, decoys > 0 ? decoys : 0, { Corbomite: decoys > 0 ? decoys : 0 })
  contributions.extraWarheads = contribution(extra, extra, { Tritanium: extra })

  if (stage && stages > 0 && stage.missing) {
    contributions.secondStage = contribution(null, null, null, stage.reason || STAGE_MISSING)
  } else if (stage && stages > 0) {
    contributions.secondStage = contribution(stage.size * stages, stage.cost * stages, Object.fromEntries(Object.entries(stage.minerals).map(([name, amount]) => [name, amount * stages])))
  } else {
    contributions.secondStage = contribution(0, 0, {})
  }

  contributions.eccm = contribution(options.eccm > 0 ? ECCM_MSP : 0, options.eccm / ECCM_BP_DIVISOR, { Corbomite: options.eccm / ECCM_BP_DIVISOR })
  contributions.terminal = options.terminal > 1 ? contribution(TERMINAL_GUIDANCE_MSP, options.terminal - 1, { Uridium: options.terminal - 1 }) : contribution(0, 0, {})
  contributions.retarget = contribution(options.retarget > 0 ? RETARGETING_MSP : 0, options.retarget === 1 ? 0.5 : 0, { Uridium: options.retarget === 1 ? 0.5 : 0 })

  if (!options.laser) {
    contributions.laser = contribution(0, 0, {})
  } else if (!isKnown(tech.laserEfficiency)) {
    contributions.laser = contribution(null, null, null, 'the laser warhead efficiency tech level (type 274) is not known')
  } else {
    contributions.laser = contribution(LASER_WARHEAD_MSP, tech.laserEfficiency / 100, { Corundium: tech.laserEfficiency / 100 })
  }

  for (const [name, { reason, size }] of Object.entries(unsupported)) {
    contributions[name] = contribution(size ? null : contributions[name].msp, null, null, reason)
  }

  const list = CONTRIBUTIONS.map((name) => contributions[name])
  const sum = sumOf(list, 'msp')
  const cost = sumOf(list, 'bp')
  const size = isKnown(sum) ? clampSize(sum, { shipDecoy, sizeLimit }) : null
  const powerKnown = !hasEngine || !engine.missing
  const enginePower = !hasEngine ? 0 : powerKnown ? roundHalfEven(engine.power * engines, 4) : null
  const speed = size === null || enginePower === null ? null : Math.min(MAX_MISSILE_SPEED, roundHalfEven(enginePower / (size / MSP_PER_HS) * 1000, 1))
  const ownFuel = floorExact(FUEL_LITRES_PER_MSP * fuelMsp)
  const fuelRequired = stage && stages > 0 && stage.missing ? null : ownFuel + (stage && stages > 0 ? stage.fuelRequired * stages : 0)
  const endurance = enginePower === null ? null : enginePower > 0 ? roundHalfEven(ownFuel / (enginePower * engine.fuelEfficiency) * 3600, 1) : 1
  const maxRange = speed === null || endurance === null ? null : speed * endurance
  const stageFlight = stage && stages > 0 ? (stage.missing ? null : stage.totalFlightTime) : 0

  return {
    contributions,
    figures: {
      baseWarheadDamage: baseDamage,
      warheadStrength: strength,
      laserWarhead,
      strengths: { active: strengths[0], thermal: strengths[1], em: strengths[2], geo: strengths[3] },
      reactorOutput: output,
      sizeSum: sum,
      size,
      cost,
      minerals: sumMinerals(list),
      enginePower,
      fuelRequired,
      speed,
      endurance,
      maxRange,
      totalFlightTime: endurance === null || stageFlight === null ? null : endurance + stageFlight,
    },
  }
}

// ---------- the missile candidate evaluator ----------

// The rules a missile evaluation reports under, so a check or a screen names them in one place.
export const MISSILE_RULES = Object.freeze({ engine: 'design.missileEngineDesign', accounting: 'design.missileAccounting', extended: 'design.missileAccountingExtended', feasibility: 'design.missileFeasibility', efficacy: 'design.missileEfficacy' })

// What a candidate's accounting does not cover. The reasons are shown as they are.
const GROUND_POD_REASON = 'a ground pod\'s size, cost and Vendarite are not covered by the missile accounting rules'
const ENHANCED_RADIATION_REASON = 'the cost of a warhead with an enhanced radiation share is not covered by the missile accounting rules'
const RETARGETING_REASON = `a retargeting level above ${VALIDATED_RETARGETING} has no saved design to check its size and cost against`
const MULTIPLE_WARHEADS_ASSUMPTION = 'Each warhead after the first adds 0.1 MSP, which the size floor or limit of some saved designs hides'
const STAGED_FLIGHT_ASSUMPTION = 'The flight time and the endurance of a design with second stages reproduce for every saved design but one (design 154678 of the stock sample, 0.08% under, the cause not identified), so they are not confirmed'

// The quantities the cost and mineral formulas read, each { id, label, read(input, raw) }: the value in a candidate, null where the candidate does not give it (an unknown tech) or the quantity does not apply. The ids are those of MISSILE_COST_DOMAIN.
const COST_QUANTITIES = Object.freeze([
  { id: 'warheadMsp', label: 'warhead size', read: (input) => (input.shipDecoy ? 0 : input.warheadMsp) },
  { id: 'warheadDamage', label: 'warhead damage', read: (input, raw) => (input.shipDecoy ? 0 : raw.baseWarheadDamage) },
  { id: 'shipDecoyMsp', label: 'ship decoy size', read: (input) => (input.shipDecoy ? input.warheadMsp : 0) },
  { id: 'warheads', label: 'warhead count', read: (input) => input.warheads },
  { id: 'activeMsp', label: 'active sensor size', read: (input) => input.activeMsp },
  { id: 'thermalMsp', label: 'thermal sensor size', read: (input) => input.thermalMsp },
  { id: 'emMsp', label: 'EM sensor size', read: (input) => input.emMsp },
  { id: 'geoMsp', label: 'geo sensor size', read: (input) => input.geoMsp },
  { id: 'activeStrength', label: 'active sensor strength', read: (_input, raw) => raw.strengths.active },
  { id: 'thermalStrength', label: 'thermal sensor strength', read: (_input, raw) => raw.strengths.thermal },
  { id: 'emStrength', label: 'EM sensor strength', read: (_input, raw) => raw.strengths.em },
  { id: 'geoStrength', label: 'geo sensor strength', read: (_input, raw) => raw.strengths.geo },
  { id: 'reactorOutput', label: 'sensor reactor output', read: (_input, raw) => raw.reactorOutput },
  { id: 'laserEfficiency', label: 'laser efficiency', read: (input) => (input.options.laser ? input.tech.laserEfficiency : 0) },
  { id: 'eccm', label: 'ECCM level', read: (input) => input.options.eccm },
  { id: 'terminal', label: 'terminal guidance multiplier', read: (input) => input.options.terminal },
  { id: 'decoys', label: 'ECM decoy count', read: (input) => input.decoys },
  { id: 'engineBp', label: 'engine cost', read: (input) => (input.engine && input.engines > 0 ? (input.engine.missing ? null : input.engine.cost * input.engines) : 0) },
  { id: 'enginePower', label: 'engine power', read: (_input, raw) => raw.enginePower },
  { id: 'stages', label: 'second stage count', read: (input) => input.stages },
])

const CANDIDATE_FIELDS = Object.freeze(['engine', 'engines', 'fuelMsp', 'warheadMsp', 'warheads', 'shipDecoy', 'decoys', 'activeMsp', 'thermalMsp', 'emMsp', 'geoMsp', 'sizeLimit', 'stage', 'stages', 'options', 'tech', 'sensor', 'groundPod', 'enhancedRadiation'])
const OPTION_FIELDS = Object.freeze(['eccm', 'terminal', 'retarget', 'laser'])
const TECH_FIELDS = Object.freeze(['warhead', 'laserEfficiency', 'reactor', 'active', 'thermal', 'em', 'geo'])
const BUDGET_FIELDS = Object.freeze(['maxMsp', 'maxBp', 'minerals'])

const refuse = (message) => {
  throw new Error(`Missile evaluation: ${message}`)
}

const amountOf = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    refuse(`${name} must be a number of 0 or more, not ${String(value)}`)
  }

  return value
}

const countOf = (value, name) => {
  if (!Number.isInteger(amountOf(value, name))) {
    refuse(`${name} must be a whole number, not ${String(value)}`)
  }

  return value
}

const optional = (value, fallback) => (value === undefined ? fallback : value)

const techOf = (value, name) => (value === null || value === undefined ? null : amountOf(value, name))

const unknownKeys = (object, allowed, name) => {
  const extra = Object.keys(object).filter((key) => !allowed.includes(key))

  if (extra.length) {
    refuse(`${name} has no field ${extra.join(', ')}`)
  }
}

const objectOf = (value, name) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`${name} must be an object`)
  }

  return value
}

// The engine of a candidate: null for none; { sizeMsp, cost, power, fuelEfficiency } for a stored engine component; { sizeMsp, thrust, engineTech, fuelTech, maxThrust } for one designed by the rule (a missing tech leaves the engine unknown, with the size it takes); { missing: true, storedMsp, reason } for an engine whose figures are not known.
const normaliseMissileEngine = (engine, engines) => {
  if (engine === null || engine === undefined) {
    return null
  }

  objectOf(engine, 'engine')

  if (engine.missing) {
    unknownKeys(engine, ['missing', 'storedMsp', 'reason'], 'engine')

    return { missing: true, storedMsp: techOf(engine.storedMsp, 'engine.storedMsp'), reason: engine.reason || ENGINE_MISSING }
  }

  const sizeMsp = amountOf(engine.sizeMsp, 'engine.sizeMsp')

  if (engine.thrust !== undefined) {
    unknownKeys(engine, ['sizeMsp', 'thrust', 'engineTech', 'fuelTech', 'maxThrust'], 'engine')
    const ENGINE_TECH_WORDS = { engineTech: 'engine technology', fuelTech: 'fuel consumption technology', maxThrust: 'greatest thrust technology' }

    const thrust = amountOf(engine.thrust, 'engine.thrust')
    const techs = { engineTech: techOf(engine.engineTech, 'engine.engineTech'), fuelTech: techOf(engine.fuelTech, 'engine.fuelTech'), maxThrust: techOf(engine.maxThrust, 'engine.maxThrust') }

    if (!(sizeMsp > 0 && thrust > 0) || Object.values(techs).includes(0)) {
      refuse('a designed engine needs a size, a thrust and techs above 0')
    }

    const lacking = Object.keys(techs).filter((name) => techs[name] === null)

    if (lacking.length) {
      return { missing: true, storedMsp: roundHalfEven(sizeMsp * engines, 4), reason: `the ${lacking.map((name) => ENGINE_TECH_WORDS[name]).join(', ')} of the engine design are not known` }
    }

    const { cost, power, fuelEfficiency } = missileEngineDesign({ sizeMsp, thrust, ...techs })

    return { sizeMsp, cost, power, fuelEfficiency }
  }

  unknownKeys(engine, ['sizeMsp', 'cost', 'power', 'fuelEfficiency'], 'engine')

  return { sizeMsp, cost: amountOf(engine.cost, 'engine.cost'), power: amountOf(engine.power, 'engine.power'), fuelEfficiency: amountOf(engine.fuelEfficiency, 'engine.fuelEfficiency') }
}

// The second stage: null for none, { size, cost, fuelRequired, totalFlightTime, minerals } of the stage design with every mineral of MISSILE_MINERALS given (an omitted one is a fault, never 0), or { missing: true, reason } for a stage whose design is not known.
const normaliseMissileStage = (stage) => {
  if (stage === null || stage === undefined) {
    return null
  }

  objectOf(stage, 'stage')

  if (stage.missing) {
    unknownKeys(stage, ['missing', 'reason'], 'stage')

    return { missing: true, reason: stage.reason || STAGE_MISSING }
  }

  unknownKeys(stage, ['size', 'cost', 'fuelRequired', 'totalFlightTime', 'minerals'], 'stage')
  objectOf(stage.minerals, 'stage.minerals')
  unknownKeys(stage.minerals, MISSILE_MINERALS, 'stage.minerals')

  return { size: amountOf(stage.size, 'stage.size'), cost: amountOf(stage.cost, 'stage.cost'), fuelRequired: amountOf(stage.fuelRequired, 'stage.fuelRequired'), totalFlightTime: amountOf(stage.totalFlightTime, 'stage.totalFlightTime'), minerals: Object.fromEntries(MISSILE_MINERALS.map((name) => [name, amountOf(stage.minerals[name], `stage.minerals.${name}`)])) }
}

// A candidate in the form the accounting reads, every field checked: a number is finite and 0 or more, a count a whole number, a tech a number or null (not known), a part counted at 1 or more has its record (a count of 0 is no part). A fault in the candidate is the caller's, so it throws; an unknown tech is no fault and stays null.
export const normaliseMissileCandidate = (candidate) => {
  objectOf(candidate, 'candidate')
  unknownKeys(candidate, CANDIDATE_FIELDS, 'candidate')

  const options = objectOf(optional(candidate.options, {}), 'options')
  const tech = objectOf(optional(candidate.tech, {}), 'tech')
  const sensor = objectOf(optional(candidate.sensor, {}), 'sensor')

  unknownKeys(options, OPTION_FIELDS, 'options')
  unknownKeys(tech, TECH_FIELDS, 'tech')
  unknownKeys(sensor, ['resolution', 'emSensitivity'], 'sensor')

  const hasEngine = candidate.engine !== null && candidate.engine !== undefined
  const hasStage = candidate.stage !== null && candidate.stage !== undefined
  const engines = countOf(optional(candidate.engines, hasEngine ? 1 : 0), 'engines')
  const stages = countOf(optional(candidate.stages, hasStage ? 1 : 0), 'stages')

  if (engines > 0 && !hasEngine) {
    refuse(`engines is ${engines} but the candidate has no engine: a counted engine needs its record, or { missing: true } where its figures are not known`)
  }

  if (stages > 0 && !hasStage) {
    refuse(`stages is ${stages} but the candidate has no stage: a counted stage needs its record, or { missing: true } where its design is not known`)
  }

  return {
    engine: normaliseMissileEngine(candidate.engine, engines),
    engines,
    fuelMsp: amountOf(optional(candidate.fuelMsp, 0), 'fuelMsp'),
    warheadMsp: amountOf(optional(candidate.warheadMsp, 0), 'warheadMsp'),
    warheads: countOf(optional(candidate.warheads, 1), 'warheads'),
    shipDecoy: Boolean(candidate.shipDecoy),
    decoys: countOf(optional(candidate.decoys, 0), 'decoys'),
    activeMsp: amountOf(optional(candidate.activeMsp, 0), 'activeMsp'),
    thermalMsp: amountOf(optional(candidate.thermalMsp, 0), 'thermalMsp'),
    emMsp: amountOf(optional(candidate.emMsp, 0), 'emMsp'),
    geoMsp: amountOf(optional(candidate.geoMsp, 0), 'geoMsp'),
    sizeLimit: amountOf(optional(candidate.sizeLimit, 0), 'sizeLimit'),
    stage: normaliseMissileStage(candidate.stage),
    stages,
    options: { eccm: amountOf(optional(options.eccm, 0), 'options.eccm'), terminal: amountOf(optional(options.terminal, 1), 'options.terminal'), retarget: countOf(optional(options.retarget, 0), 'options.retarget'), laser: Boolean(options.laser) },
    tech: Object.fromEntries(TECH_FIELDS.map((name) => [name, techOf(tech[name], `tech.${name}`)])),
    sensor: { resolution: techOf(sensor.resolution, 'sensor.resolution'), emSensitivity: techOf(sensor.emSensitivity, 'sensor.emSensitivity') },
    groundPod: Boolean(candidate.groundPod),
    enhancedRadiation: Boolean(candidate.enhancedRadiation),
  }
}

// A budget: { maxMsp, maxBp, minerals: { Name: limit } }, every limit optional (null for none). A limit that is not a number of 0 or more, a field or a mineral that does not exist throws.
export const normaliseMissileBudget = (budget = {}) => {
  objectOf(budget, 'budget')
  unknownKeys(budget, BUDGET_FIELDS, 'budget')

  const minerals = objectOf(optional(budget.minerals, {}), 'budget.minerals')

  unknownKeys(minerals, MISSILE_MINERALS, 'budget.minerals')

  return { maxMsp: techOf(budget.maxMsp, 'budget.maxMsp'), maxBp: techOf(budget.maxBp, 'budget.maxBp'), minerals: Object.fromEntries(Object.entries(minerals).map(([name, limit]) => [name, amountOf(limit, `budget.minerals.${name}`)])) }
}

// The options the accounting rules do not cover, as { [option]: { reason, size } }: `size` is true where the option's size is not covered either.
const unsupportedMissileOptions = (input) => {
  const found = {}

  if (input.groundPod) {
    for (const id of CONTRIBUTIONS) {
      found[id] = { reason: GROUND_POD_REASON, size: true }
    }
  }

  if (input.enhancedRadiation && !found.warhead) {
    found.warhead = { reason: ENHANCED_RADIATION_REASON, size: false }
  }

  if (input.options.retarget > VALIDATED_RETARGETING && !found.retarget) {
    found.retarget = { reason: RETARGETING_REASON, size: true }
  }

  return found
}

// A figure of the accounting: unavailable (never 0) where it is not known, confirmed in the domain the rules are checked in, and estimated by design.missileAccountingExtended where `outside` lists why the figure is beyond it.
const missileFigure = (value, units, missing, outside = []) => (isKnown(value) ? ofRule({ rule: outside.length ? MISSILE_RULES.extended : MISSILE_RULES.accounting, value, inputs: { present: ['candidate'] }, units, assumptions: outside }) : unavailable({ rule: MISSILE_RULES.accounting, missing, units }))

const costQuantitiesOf = (input, raw) => Object.fromEntries(COST_QUANTITIES.map(({ id, read }) => [id, read(input, raw)]))

// The quantities of a candidate that the cost and mineral formulas read (the ids of MISSILE_COST_DOMAIN), null where a figure behind one is not known: what scripts/check-design-rules.js takes the highest of, among the saved designs whose cost reproduces, to check the domain.
export const missileCostQuantities = (candidate) => {
  const input = normaliseMissileCandidate(candidate)

  return costQuantitiesOf(input, missileAccounting(input).figures)
}

// Why the cost and minerals of a candidate are beyond what the rules are checked for: each quantity the formulas read that is above the highest of a saved design whose cost reproduces.
const missileCostOutside = (input, raw) => {
  const found = costQuantitiesOf(input, raw)

  return COST_QUANTITIES.filter(({ id }) => isKnown(found[id]) && found[id] > MISSILE_COST_DOMAIN[id] && !agrees(found[id], MISSILE_COST_DOMAIN[id])).map(({ id, label }) => `The ${label} ${found[id]} is above ${MISSILE_COST_DOMAIN[id]}, the highest of a saved design whose cost and minerals reproduce`)
}

const missileOption = (id, entry, rejection, input, outside) => {
  const minerals = entry.minerals !== null && MISSILE_MINERALS.every((name) => isKnown(entry.minerals[name])) ? entry.minerals : null
  const complete = isKnown(entry.msp) && isKnown(entry.bp) && minerals !== null
  const status = rejection ? 'unsupported' : complete ? 'known' : 'unknown'
  const reasons = status === 'known' ? [] : [entry.unknown || 'the accounting of the option is not known']
  const assumptions = id === 'extraWarheads' && input.warheads > 1 ? [MULTIPLE_WARHEADS_ASSUMPTION] : []
  const result = (value, units, beyond = []) => (isKnown(value) ? ofRule({ rule: beyond.length ? MISSILE_RULES.extended : MISSILE_RULES.accounting, value, inputs: { present: [id] }, units, assumptions: [...assumptions, ...beyond] }) : unavailable({ rule: MISSILE_RULES.accounting, missing: reasons, present: [], units, assumptions }))

  return { id, label: MISSILE_OPTIONS[id], status, reasons, msp: result(entry.msp, 'MSP'), bp: result(entry.bp, 'BP', outside), minerals: result(minerals, 'minerals', outside) }
}

const readResult = (result) => (isAvailable(result) ? { value: result.value, reason: null, status: result.status, caveats: result.assumptions } : { value: null, reason: result.inputs.missing.join('; '), status: result.status, caveats: [] })

const readFigure = (name) => ({ figures }) => readResult(figures[name])

// What a candidate's options are expected to do, each effect `{ id, option, label, units, rule, applies, read }`: `rule` the id of the rule that models it (null where no rule does), `applies` whether the candidate has the option, `read` the figure as { value, reason }. An effect counts toward a ranking only when its rule is confirmed against saved data; the hit effects rest on the missile-hit rules, which are not.
export const MISSILE_EFFECTS = Object.freeze([
  { id: 'warheadStrength', option: 'warhead', label: 'Warhead strength', units: 'damage', rule: MISSILE_RULES.accounting, applies: ({ input }) => input.warheadMsp > 0 && !input.shipDecoy, read: readFigure('warheadStrength') },
  { id: 'laserStrength', option: 'laser', label: 'Laser warhead strength', units: 'damage', rule: MISSILE_RULES.accounting, applies: ({ input }) => input.options.laser, read: readFigure('laserWarhead') },
  { id: 'speed', option: 'engine', label: 'Speed', units: 'km/s', rule: MISSILE_RULES.accounting, applies: ({ input }) => Boolean(input.engine) && input.engines > 0, read: readFigure('speed') },
  { id: 'endurance', option: 'fuel', label: 'Endurance', units: 'seconds', rule: MISSILE_RULES.accounting, applies: ({ input }) => Boolean(input.engine) && input.engines > 0, read: readFigure('endurance') },
  { id: 'maxRange', option: 'fuel', label: 'Maximum range', units: 'km', rule: MISSILE_RULES.accounting, applies: ({ input }) => Boolean(input.engine) && input.engines > 0, read: readFigure('maxRange') },
  { id: 'sensorRange', option: 'active', label: 'Active sensor range', units: 'km', rule: MISSILE_RULES.accounting, applies: ({ input }) => input.activeMsp > 0 && input.sensor.resolution !== null && input.sensor.emSensitivity !== null, read: readFigure('sensorRange') },
  { id: 'eccmHit', option: 'eccm', label: 'Hit chance multiplier against a jammer', units: 'multiplier', rule: HIT_RULES.jammer, applies: ({ input, scenario }) => input.options.eccm > 0 && scenario !== null, read: ({ hit }) => readResult(hit.effect) },
  { id: 'terminalHit', option: 'terminal', label: 'Hit chance with terminal guidance', units: '%', rule: HIT_RULES.raw, applies: ({ input, scenario }) => input.options.terminal > 1 && scenario !== null, read: ({ hit }) => readResult(hit.raw) },
  { id: 'warheadHits', option: 'extraWarheads', label: 'Expected warhead hits', units: 'hits', rule: HIT_RULES.hits, applies: ({ input, scenario }) => input.warheads > 1 && scenario !== null, read: ({ hit }) => readResult(hit.hitsCapped) },
  { id: 'retargeting', option: 'retarget', label: 'Retargeting', units: '', rule: null, applies: ({ input }) => input.options.retarget > 0, read: () => ({ value: null, reason: null }) },
  { id: 'shipDecoy', option: 'warhead', label: 'Ship decoy', units: '', rule: null, applies: ({ input }) => input.shipDecoy, read: () => ({ value: null, reason: null }) },
  { id: 'ecmDecoys', option: 'decoys', label: 'ECM decoys', units: '', rule: null, applies: ({ input }) => input.decoys > 0, read: () => ({ value: null, reason: null }) },
  { id: 'secondStageHit', option: 'secondStage', label: 'Hit of the second stage', units: '', rule: null, applies: ({ input }) => input.stages > 0, read: () => ({ value: null, reason: null }) },
])

const missileEffect = (definition, context) => {
  const rule = definition.rule ? getRule(definition.rule) : null
  const { value, reason: unavailableReason, status = null, caveats = [] } = definition.read(context)
  const weak = status === STATUS.ESTIMATED || status === STATUS.ASSUMED
  const verified = Boolean(rule) && rule.verification === STATUS.CONFIRMED && !weak
  const unverifiedReason = rule ? (rule.verification === STATUS.CONFIRMED ? `the figure is ${status} here, not confirmed against saved data: ${caveats.join('; ')}` : `the rule for this effect is ${rule.verification}, not confirmed against saved data`) : 'no rule models this effect'
  const counted = verified && value !== null

  return { id: definition.id, option: definition.option, label: definition.label, units: definition.units, rule: definition.rule, verification: rule ? rule.verification : null, verified, counted, value, reason: counted ? null : verified ? unavailableReason : unverifiedReason }
}

// The effects of the candidate's options. Only an effect whose rule is confirmed against saved data counts: `counted` lists those for a ranking to use, `excluded` the others with the reason, and no effect gives a score of its own. A hit effect is worked out only when a scenario `{ targetSpeed, jammer, modifier, version }` is given.
const missileEfficacy = ({ input, figures, scenario, effects }) => {
  const speed = isAvailable(figures.speed) ? figures.speed.value : null
  const missile = { key: 'candidate', name: 'Candidate', kind: 'candidate', speed, atg: input.options.terminal, eccm: input.options.eccm, warheads: input.warheads, shipDecoy: input.shipDecoy, obsolete: false, secondStageId: input.stages > 0 ? 1 : 0, secondStages: input.stages }
  const hit = scenario === null ? null : hitScenario({ missile, targetSpeed: scenario.targetSpeed, jammer: scenario.jammer, modifier: scenario.modifier, version: scenario.version })
  const context = { input, figures, scenario, hit }
  const listed = effects.filter((definition) => definition.applies(context)).map((definition) => missileEffect(definition, context))

  return { rule: MISSILE_RULES.efficacy, scenario, effects: listed, counted: listed.filter((effect) => effect.counted).map(({ id, value, units }) => ({ id, value, units })), excluded: listed.filter((effect) => !effect.counted).map(({ id, reason }) => ({ id, reason })) }
}

const over = (found, allowed) => found > allowed && !agrees(found, allowed)

const violationText = ({ limit, allowed, found }) => `${limit} is ${found}, over the ${allowed} allowed`

// The candidate against the budget, from figures that are all known: the size compared is the one the options ask for, or the least size the game gives, whichever is larger.
const missileViolations = (totals, limits) => {
  const checks = [['size', limits.maxMsp, Math.max(totals.size.value, totals.sizeSum.value)], ['cost', limits.maxBp, totals.cost.value], ...Object.entries(limits.minerals).map(([name, allowed]) => [name, allowed, totals.minerals[name].value])]

  return checks.filter(([, allowed, found]) => allowed !== null && over(found, allowed)).map(([limit, allowed, found]) => ({ limit, allowed, found }))
}

// The feasibility result: the verdict at the weakest status of the totals a limit was compared with, so a cost that is only estimated gives an estimated verdict.
const missileFeasibility = (totals, limits, violations) => {
  const compared = {}

  if (limits.maxMsp !== null) {
    compared.size = totals.size
    compared.sizeSum = totals.sizeSum
  }

  if (limits.maxBp !== null) {
    compared.cost = totals.cost
  }

  for (const name of Object.keys(limits.minerals)) {
    compared[name] = totals.minerals[name]
  }

  return combine({ rule: MISSILE_RULES.feasibility, parts: compared, compute: () => ({ feasible: violations.length === 0, violations, limits }), units: 'MSP, BP', inputs: { present: ['candidate', 'budget'] } })
}

// A candidate's missile as the game builds it, with the budget it has to fit and the scenario its hit effects are read in. Returns { candidate, budget, verdict, feasibility, unknown, unsupported, options, totals, figures, efficacy }.
//   options: one record per option, { id, label, status ('known', 'unknown' or 'unsupported'), reasons, msp, bp, minerals } with each figure a result of design.missileAccounting (unavailable, never 0, where it is not known; estimated, by design.missileAccountingExtended, where the tech figures it rests on are above those the rules are checked for).
//   totals: { sizeSum, size, cost, minerals: { name: result } }.
//   verdict: 'unsupported' when an option is outside the rules, 'unknown' when an option's accounting is not known (feasibility is then not claimed either way), else 'feasible' or 'infeasible' against the budget. `feasibility` is the result of design.missileFeasibility, at the weakest status of the totals it compared with a limit.
//   efficacy: the options' effects apart from the accounting, see missileEfficacy.
export const evaluateMissile = (candidate, { budget = {}, scenario = null, effects = MISSILE_EFFECTS } = {}) => {
  const input = normaliseMissileCandidate(candidate)
  const limits = normaliseMissileBudget(budget)
  const rejections = unsupportedMissileOptions(input)
  const { contributions, figures: raw } = missileAccounting({ ...input, unsupported: rejections })
  const outside = missileCostOutside(input, raw)
  const staged = input.stages > 0 ? [STAGED_FLIGHT_ASSUMPTION] : []
  const options = CONTRIBUTIONS.map((id) => missileOption(id, contributions[id], rejections[id], input, outside))
  const unsupported = options.filter((option) => option.status === 'unsupported').map(({ id, label, reasons }) => ({ option: id, label, reason: reasons.join('; ') }))
  const unknown = options.filter((option) => option.status === 'unknown').map(({ id, label, reasons }) => ({ option: id, label, reason: reasons.join('; ') }))
  const why = [...new Set([...unsupported, ...unknown].map(({ reason }) => reason))]
  const rangeInputs = input.sensor.resolution !== null && input.sensor.emSensitivity !== null
  const range = rangeInputs && input.activeMsp > 0 ? missileSensorRange({ strength: raw.strengths.active, emSensitivity: input.sensor.emSensitivity, resolution: input.sensor.resolution }) : null
  const rangeWhy = input.activeMsp > 0 ? (rangeInputs ? why : ['the resolution and the EM sensitivity of the active sensor are not given']) : ['the missile has no active sensor']
  const figures = { speed: missileFigure(raw.speed, 'km/s', why), endurance: missileFigure(raw.endurance, 'seconds', why, staged), maxRange: missileFigure(raw.maxRange, 'km', why, staged), fuelRequired: missileFigure(raw.fuelRequired, 'L', why), totalFlightTime: missileFigure(raw.totalFlightTime, 'seconds', why, staged), warheadStrength: missileFigure(raw.warheadStrength, 'damage', why), laserWarhead: missileFigure(raw.laserWarhead, 'damage', why), sensorStrengths: Object.fromEntries(Object.entries(raw.strengths).map(([name, value]) => [name, missileFigure(value, 'strength', why)])), sensorRange: missileFigure(range, 'km', rangeWhy) }
  const totals = { sizeSum: missileFigure(raw.sizeSum, 'MSP', why), size: missileFigure(raw.size, 'MSP', why), cost: missileFigure(raw.cost, 'BP', why, outside), minerals: Object.fromEntries(MISSILE_MINERALS.map((name) => [name, missileFigure(raw.minerals[name], 'minerals', why, outside)])) }
  const efficacy = missileEfficacy({ input, figures, scenario, effects })
  const base = { candidate: input, budget: limits, unknown, unsupported, options, totals, figures, efficacy }

  if (unsupported.length) {
    return { ...base, verdict: 'unsupported', feasibility: unavailable({ rule: MISSILE_RULES.feasibility, missing: why }) }
  }

  if (unknown.length) {
    return { ...base, verdict: 'unknown', feasibility: unavailable({ rule: MISSILE_RULES.feasibility, missing: why }) }
  }

  const violations = missileViolations(totals, limits)
  const feasible = violations.length === 0

  return { ...base, verdict: feasible ? 'feasible' : 'infeasible', feasibility: missileFeasibility(totals, limits, violations) }
}

// Sorts evaluations before any ranking: `admitted` holds only those whose verdict is 'feasible', `rejected` the others with the verdict and the reasons ({ evaluation, verdict, reasons }). An infeasible candidate is over its budget; an unknown or unsupported one is withheld, since nothing shows it fits.
export const admitMissiles = (evaluations) => {
  const admitted = []
  const rejected = []

  for (const evaluation of evaluations) {
    if (evaluation.verdict === 'feasible') {
      admitted.push(evaluation)
    } else {
      const reasons = evaluation.verdict === 'infeasible' ? evaluation.feasibility.value.violations.map(violationText) : [...evaluation.unsupported, ...evaluation.unknown].map(({ label, reason }) => `${label}: ${reason}`)

      rejected.push({ evaluation, verdict: evaluation.verdict, reasons })
    }
  }

  return { admitted, rejected }
}

// ---------- sensors and fire controls ----------

// A sensor or a fire control as the game designs it from the race's techs. Sizes are in HS, ranges in km, a signature and a resolution in HS (a target of that many HS, or 50 t for each). The design functions take the numbers a design uses and return plain figures, like `engineDesign`; the effective range, the inverse sizing and the fire control request give provenance results and are unavailable, never 0, when an input is not known. docs/DATABASE.md § Design rules states each rule in prose.
export const SENSOR_RANGE_UNIT_KM = 1000000
export const SENSOR_RESOLUTION_EXPONENT = 2 / 3
export const MISSILE_FIRE_CONTROL_RANGE_FACTOR = 2
export const SENSOR_JAMMER_BASE = 0.75
export const PASSIVE_RANGE_MULTIPLIER = 250000
export const MISSILE_SIGNATURE_MIN = 0.3
// The least size, in missile points (MSP), a missile shows a missile fire control: the fire control reads the missile's size itself, not a size over the MSP of a hull space.
export const MISSILE_FIRE_CONTROL_SIGNATURE_MIN = 0.33
// The least cross-section a class shows an active sensor, in HS: the same game constant as the missile signature floor.
export const CROSS_SECTION_MIN = MISSILE_SIGNATURE_MIN
// The EM signature of shields that are up, per point of shield strength.
export const SHIELD_EM_MULTIPLIER = 30
export const SENSOR_CREW_PER_HS = 2
export const FIRE_CONTROL_CREW_PER_HS = 4
export const BEAM_FIRE_CONTROL_MAX_RANGE_KM = 1400000
export const BEAM_FIRE_CONTROL_MIN_SIZE_HS = 0.01
export const BEAM_FIRE_CONTROL_KM_PER_COST_UNIT = 20000
export const BEAM_FIRE_CONTROL_TRACKING_COST_STEP = 1000
export const BEAM_FIRE_CONTROL_POINT_DEFENCE_TRACKING = 4
export const FIRE_CONTROL_SPECIAL = Object.freeze({ none: 0, pointDefence: 1, singleWeapon: 6 })
export const SENSOR_MODES = Object.freeze({ search: 'search', missileFireControl: 'missileFireControl' })

// The rules a sensor or fire control result is reported under.
export const SENSOR_RULES = Object.freeze({ active: 'design.activeSensorDesign', passive: 'design.passiveSensorDesign', beam: 'design.beamFireControlDesign', limits: 'design.beamFireControlLimits', detection: 'design.sensorDetection', sizing: 'design.sensorInverseSizing' })

// The values 1 to `last` in steps of `step`, each divided by `scale`, so a decimal step is exact (0.1 is 1 over 10, never a sum of floats).
const ladderOf = (first, last, step, scale) => Array.from({ length: Math.floor((last - first) / step) + 1 }, (_, index) => (first + index * step) / scale)

// The sizes the design window offers for a sensor: 0.1 HS steps below 2 HS, quarter HS steps from 2 to under 5, whole HS from 5 to 50. Read from the window's lists; the sizes of the AI's own sensors in the saves (3.3, 5.625) are off it, so a stored size is not required to lie on it.
export const SENSOR_SIZES_HS = Object.freeze([...ladderOf(1, 19, 1, 10), ...ladderOf(200, 475, 25, 100), ...ladderOf(5, 50, 1, 1)])

// The resolutions the window offers, in HS: 1 to 20, 25 to 200 in fives, 220 to 500 in twenties.
export const SENSOR_RESOLUTIONS_HS = Object.freeze([...ladderOf(1, 20, 1, 1), ...ladderOf(25, 200, 5, 1), ...ladderOf(220, 500, 20, 1)])

// The range and tracking multipliers the window offers for a beam fire control: 0.1 to 3.99 in hundredths, and 4.
export const FIRE_CONTROL_MULTIPLIERS = Object.freeze([...ladderOf(10, 399, 1, 100), 4])

// The fraction of the maximum range a sensor keeps against a target whose signature is under its resolution: the square of the ratio of the two; a target at or above the resolution gives 1.
export const sensorResolutionFactor = ({ signature, resolution }) => (signature < resolution ? (signature / resolution) ** 2 : 1)

// The fraction of its range a sensor keeps under a target's sensor jammer: 0.75 to the power of the jammer less the sensor's ECCM, when the jammer is the stronger and 1 when it is not. The missile hit chance (missile-hit.js `jammerMultiplier`) is another rule: it takes 0.75 to the whole jammer, not to the excess, and only when the jammer is the stronger.
export const sensorJammerFactor = ({ jammer, eccm }) => (jammer > eccm ? SENSOR_JAMMER_BASE ** (jammer - eccm) : 1)

// The signature, in HS, an active sensor sees a missile by: its size in MSP over the MSP of a hull space, never below 0.3.
export const missileSignature = ({ sizeMsp }) => Math.max(sizeMsp / MSP_PER_HS, MISSILE_SIGNATURE_MIN)

// The size a missile fire control sees a missile target by, set against the fire control's resolution: the missile's size in MSP, never below 0.33. It is not the search signature, and no jammer term applies to it (docs/plans/planners/mechanics-sensors.md).
export const missileFireControlSignature = ({ sizeMsp }) => Math.max(sizeMsp, MISSILE_FIRE_CONTROL_SIGNATURE_MIN)

// An active sensor, or a missile fire control (`mode` 'missileFireControl'), as the game designs it from the active sensor strength tech (`strengthTech` per HS), the EM sensitivity tech, the resolution, and the hardening and ECCM techs (`hardeningRating` the CTD, `hardeningCost` the cost factor, `eccmRating`, `eccmCost` the cost factor). Returns { strength, rangeKm, searchRangeKm, cost, uridium, corbomite, crew, htk, eccm, ctd, sizeHS, tons }: `searchRangeKm` is the range of the same sensor as a search sensor, `rangeKm` twice that for a fire control. The cost is the size times the strength tech times the hardening factor to 1 decimal (the Uridium) times the ECCM factor; the Corbomite is the rest.
export const activeSensorDesign = ({ sizeHS, resolution, strengthTech, emTech, hardeningRating, hardeningCost, eccmRating, eccmCost, mode = SENSOR_MODES.search }) => {
  const strength = strengthTech * sizeHS
  const searchRangeKm = Math.sqrt(strength * emTech * resolution ** SENSOR_RESOLUTION_EXPONENT / SENSOR_PI) * SENSOR_RANGE_UNIT_KM
  const uridium = roundHalfEven(sizeHS * strengthTech * hardeningCost, 1)
  const cost = uridium * eccmCost

  return {
    strength,
    rangeKm: mode === SENSOR_MODES.missileFireControl ? searchRangeKm * MISSILE_FIRE_CONTROL_RANGE_FACTOR : searchRangeKm,
    searchRangeKm,
    cost,
    uridium,
    corbomite: cost - uridium,
    crew: roundHalfEven(sizeHS * SENSOR_CREW_PER_HS),
    htk: sizeHS < 1 ? 0 : 1,
    eccm: Math.trunc(eccmRating),
    ctd: Math.trunc(hardeningRating),
    sizeHS,
    tons: sizeHS * TONS_PER_HS,
  }
}

// A thermal or EM sensor as the game designs it from the sensitivity tech and the hardening tech. Returns { sensitivity, cost, uridium, crew, htk, ctd, sizeHS, tons }: the sensitivity is the size times the tech, the cost that times the hardening factor to 1 decimal, all of it Uridium.
export const passiveSensorDesign = ({ sizeHS, sensitivityTech, hardeningRating, hardeningCost }) => {
  const sensitivity = sizeHS * sensitivityTech
  const cost = roundHalfEven(sensitivity * hardeningCost, 1)

  return { sensitivity, cost, uridium: cost, crew: roundHalfEven(sizeHS * SENSOR_CREW_PER_HS), htk: sizeHS < 1 ? 0 : 1, ctd: Math.trunc(hardeningRating), sizeHS, tons: sizeHS * TONS_PER_HS }
}

// The tracking speed a beam fire control stores: the tracking multiplier times the speed rating, rounded to the nearest km/s (ties to even).
export const fireControlTracking = (trackingMultiplier, speedRating) => roundHalfEven(trackingMultiplier * speedRating)

// A beam fire control as the game designs it from the distance and speed rating techs, a range and a tracking multiplier, the single weapon tech's number (1, or under 1 for a single weapon control) and the hardening and ECCM techs. Returns { rangeKm, uncappedRangeKm, rangeCapped, trackingKmS, sizeHS, roundedSizeHS, sizeFloored, cost, uridium, corbomite, crew, htk, eccm, ctd, specialFunction }. The range is the multiplier times the distance rating, never above `maxRangeKm` (1,400,000 km unless a save is read that applies another limit); the tracking is the multiplier times the speed rating, rounded; the size is half the product of the multipliers times the weapon number, rounded to 2 decimals and never below 0.01 HS; the crew is four a HS of the rounded size, before the floor. The Uridium is the capped range over 20,000 times the tracking over 1,000 cut to a whole number (not rounded, not kept fractional) times the hardening factor and the weapon number, to 1 decimal; the cost is that times the ECCM factor and the Corbomite the rest.
export const beamFireControlDesign = ({ rangeMultiplier, trackingMultiplier, distanceRating, speedRating, weaponNumber, hardeningRating, hardeningCost, eccmRating, eccmCost, maxRangeKm = BEAM_FIRE_CONTROL_MAX_RANGE_KM }) => {
  const uncappedRangeKm = rangeMultiplier * distanceRating
  const rangeKm = Math.min(maxRangeKm, uncappedRangeKm)
  const trackingKmS = fireControlTracking(trackingMultiplier, speedRating)
  const roundedSizeHS = roundHalfEven(rangeMultiplier * trackingMultiplier / 2 * weaponNumber, 2)
  const uridium = roundHalfEven(rangeKm / BEAM_FIRE_CONTROL_KM_PER_COST_UNIT * Math.floor(trackingKmS / BEAM_FIRE_CONTROL_TRACKING_COST_STEP) * hardeningCost * weaponNumber, 1)
  const sizeHS = Math.max(BEAM_FIRE_CONTROL_MIN_SIZE_HS, roundedSizeHS)
  const cost = uridium * eccmCost

  return {
    rangeKm,
    uncappedRangeKm,
    rangeCapped: uncappedRangeKm > maxRangeKm,
    trackingKmS,
    sizeHS,
    roundedSizeHS,
    sizeFloored: roundedSizeHS < BEAM_FIRE_CONTROL_MIN_SIZE_HS,
    cost,
    uridium,
    corbomite: cost - uridium,
    crew: roundHalfEven(roundedSizeHS * FIRE_CONTROL_CREW_PER_HS),
    htk: sizeHS < 1 ? 0 : 1,
    eccm: Math.trunc(eccmRating),
    ctd: Math.trunc(hardeningRating),
    specialFunction: weaponNumber < 1 ? FIRE_CONTROL_SPECIAL.singleWeapon : trackingMultiplier === BEAM_FIRE_CONTROL_POINT_DEFENCE_TRACKING ? FIRE_CONTROL_SPECIAL.pointDefence : FIRE_CONTROL_SPECIAL.none,
  }
}

// The range a passive sensor detects a signature at: the square root of its sensitivity times the signature, times 250,000.
export const passiveDetectionRange = ({ sensitivity, signature }) => Math.sqrt(sensitivity * signature) * PASSIVE_RANGE_MULTIPLIER

const SENSOR_RANGE_TOLERANCE = 1e-9

// Whether a range reaches a wanted one, to the last binary digits of the float.
export const reaches = (rangeKm, wantedKm) => rangeKm >= wantedKm * (1 - SENSOR_RANGE_TOLERANCE)

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// The inputs among `named` ({ label: [value, test, reason] }) that are missing, as their reasons, and those present as their labels.
const sensorInputs = (checks) => gather(checks.map(([name, value, test, reason]) => [name, numberOrNull(value) !== null && test(value), reason]))

const POSITIVE = (value) => value > 0
const NON_NEGATIVE = (value) => value >= 0

// The range an active sensor reaches against a target: its maximum range (`rangeKm`, a stored `MaxSensorRange` or `activeSensorDesign`'s) cut by the square of the signature over the resolution when the target is under it, and by 0.75 to the jammer less the ECCM when a jammer stronger than the ECCM is on the target. With no jammer entered the target has none; the ECCM is needed only against one. A signature that is 0 gives no range. Returns { value: km } with the two factors in `figures`.
export const sensorEffectiveRange = ({ rangeKm, signature, resolution, jammer = 0, eccm = null }) => {
  const rule = SENSOR_RULES.detection
  const { present, missing } = sensorInputs([
    ['maximum range', rangeKm, POSITIVE, 'the sensor\'s maximum range above zero'],
    ['target signature', signature, NON_NEGATIVE, 'the target\'s signature, 0 or more HS'],
    ['resolution', resolution, POSITIVE, 'the sensor\'s resolution above zero'],
    ['target jammer', jammer, NON_NEGATIVE, 'the target\'s sensor jammer strength, 0 or more'],
  ])

  if (!missing.length && jammer > 0 && !(numberOrNull(eccm) !== null && eccm >= 0)) {
    missing.push('the sensor\'s ECCM, 0 or more (it decides whether the jammer counts)')
  }

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  const resolutionFactor = sensorResolutionFactor({ signature, resolution })
  const jammerFactor = jammer > 0 ? sensorJammerFactor({ jammer, eccm }) : 1

  return ofRule({ rule, value: rangeKm * resolutionFactor * jammerFactor, inputs: { present }, assumptions: [`a target sensor jammer of ${jammer}`] })
}

// The range a passive sensor detects a signature at, as a result of design.sensorDetection (km): the sensor's sensitivity (its design's value, which its component count does not add to) and the signature of the target, both needed. Unavailable, naming the missing one, when the sensitivity is not a finite number above zero or the signature is not a finite number of 0 or more; a signature of 0 gives a range of 0.
export const passiveRange = ({ sensitivity, signature }) => {
  const rule = SENSOR_RULES.detection
  const { present, missing } = sensorInputs([
    ['sensor sensitivity', sensitivity, POSITIVE, 'the sensor\'s sensitivity above zero'],
    ['target signature', signature, NON_NEGATIVE, 'the target\'s signature, 0 or more'],
  ])

  if (missing.length) {
    return unavailable({ rule, present, missing, units: 'km' })
  }

  return ofRule({ rule, value: passiveDetectionRange({ sensitivity, signature }), units: 'km', inputs: { present }, assumptions: ['the sensor\'s sensitivity is that of its design, whatever the number of sensors', 'a target sensor jammer and a cloak do not change a passive range'] })
}

// A class's cross-section as an active sensor sees it: the size times the sensor reduction of its cloak (1 without one), never under the floor of 0.3 HS.
export const classCrossSection = ({ sizeHS, sensorReduction = 1 }) => Math.max(sizeHS * sensorReduction, CROSS_SECTION_MIN)

// The sensor reduction a class takes from its cloaks (`cloaks` of { maxShipHS, rating }, in the order the class mounts them): the rating of the last cloak whose largest ship, in HS, is at least the class's size, and 1 without one.
export const cloakReduction = ({ sizeHS, cloaks }) => {
  let reduction = 1

  for (const { maxShipHS, rating } of cloaks) {
    if (maxShipHS >= sizeHS) {
      reduction = rating
    }
  }

  return reduction
}

// The EM signature a class's shields give while they are up: the shield strength times 30.
export const shieldEmission = ({ shieldStrength }) => shieldStrength * SHIELD_EM_MULTIPLIER

// The EM signature an active sensor that is switched on gives: its strength times its resolution, each cut to a whole number, never under 1. Each active sensor design is seen on its own, so the emissions of a ship's sensors are never summed.
export const activeSensorEmission = ({ strength, resolution }) => Math.max(1, Math.trunc(strength) * Math.trunc(resolution))

// The smallest entry of an ascending `ladder` that `meets`, found by bisection (what is met at a size is met at every larger one), with the entry below it. `index` is -1 when none meets.
const smallestMeeting = (ladder, meets) => {
  let low = 0
  let high = ladder.length

  while (low < high) {
    const middle = (low + high) >> 1

    if (meets(ladder[middle])) {
      high = middle
    } else {
      low = middle + 1
    }
  }

  return low === ladder.length ? { index: -1, value: null, below: ladder[ladder.length - 1] } : { index: low, value: ladder[low], below: low > 0 ? ladder[low - 1] : null }
}

// The effective range of an active sensor of a size, against a target: the design's range (the fire control's is twice the search sensor's), the resolution cut and the jammer cut.
const sizedEffectiveRange = ({ sizeHS, mode, signature, resolution, strengthTech, emTech, jammer, eccm }) => {
  const { rangeKm } = activeSensorDesign({ sizeHS, resolution, strengthTech, emTech, hardeningRating: 0, hardeningCost: 0, eccmRating: 0, eccmCost: 0, mode })

  return rangeKm * sensorResolutionFactor({ signature, resolution }) * (jammer > 0 ? sensorJammerFactor({ jammer, eccm }) : 1)
}

const SIZING_ASSUMPTIONS = ['the sizes are those the design window offers (0.1 HS steps below 2 HS, quarter HS steps to 5 HS, whole HS to 50 HS)']

// The smallest legal size of an active sensor (`mode` 'search') or missile fire control ('missileFireControl') whose range against a target of `signature` HS, at `resolution`, under a sensor `jammer` and the sensor's `eccm`, reaches `targetRangeKm`, from the active sensor strength tech and the EM sensitivity tech. The value is { status, sizeHS, exactSizeHS, rangeKm, smallerHS, smallerRangeKm, minimumHS, largestHS }: 'sized' (the size reaches the range and `smallerHS`, the next smaller legal size, falls short of it with `smallerRangeKm`), 'minimum-bound' (the smallest legal size, `minimumHS`, already reaches it: nothing smaller is offered, `smallerHS` null) or 'beyond-largest' (not even `largestHS` reaches it: `sizeHS` null). `exactSizeHS` is the size that reaches it exactly, not rounded to a legal size.
export const sensorSizeForRange = ({ mode = SENSOR_MODES.search, targetRangeKm, signature, resolution, strengthTech, emTech, jammer = 0, eccm = null }) => {
  const rule = SENSOR_RULES.sizing

  if (!Object.values(SENSOR_MODES).includes(mode)) {
    throw new Error(`Unknown sensor mode ${mode}; choose ${Object.values(SENSOR_MODES).join(' or ')}`)
  }

  const { present, missing } = sensorInputs([
    ['wanted range', targetRangeKm, POSITIVE, 'the range wanted, above zero'],
    ['target signature', signature, POSITIVE, 'the target\'s signature above zero (a target of no size is never seen)'],
    ['resolution', resolution, POSITIVE, 'the sensor\'s resolution above zero'],
    ['active sensor strength tech', strengthTech, POSITIVE, 'the active sensor strength tech above zero'],
    ['EM sensitivity tech', emTech, POSITIVE, 'the EM sensitivity tech above zero'],
    ['target jammer', jammer, NON_NEGATIVE, 'the target\'s sensor jammer strength, 0 or more'],
  ])

  if (!missing.length && jammer > 0 && !(numberOrNull(eccm) !== null && eccm >= 0)) {
    missing.push('the sensor\'s ECCM, 0 or more (it decides whether the jammer counts)')
  }

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  const rangeOf = (sizeHS) => sizedEffectiveRange({ sizeHS, mode, signature, resolution, strengthTech, emTech, jammer, eccm })
  const factor = (mode === SENSOR_MODES.missileFireControl ? MISSILE_FIRE_CONTROL_RANGE_FACTOR : 1) * sensorResolutionFactor({ signature, resolution }) * (jammer > 0 ? sensorJammerFactor({ jammer, eccm }) : 1)
  const exactSizeHS = (targetRangeKm / factor / SENSOR_RANGE_UNIT_KM) ** 2 * SENSOR_PI / (strengthTech * emTech * resolution ** SENSOR_RESOLUTION_EXPONENT)
  const found = smallestMeeting(SENSOR_SIZES_HS, (sizeHS) => reaches(rangeOf(sizeHS), targetRangeKm))
  const minimumHS = SENSOR_SIZES_HS[0]
  const largestHS = SENSOR_SIZES_HS[SENSOR_SIZES_HS.length - 1]

  if (found.index < 0) {
    return ofRule({ rule, value: { status: 'beyond-largest', sizeHS: null, exactSizeHS, rangeKm: rangeOf(largestHS), smallerHS: largestHS, smallerRangeKm: rangeOf(largestHS), minimumHS, largestHS }, inputs: { present }, assumptions: SIZING_ASSUMPTIONS })
  }

  const status = found.index === 0 ? 'minimum-bound' : 'sized'

  return ofRule({ rule, value: { status, sizeHS: found.value, exactSizeHS, rangeKm: rangeOf(found.value), smallerHS: found.below, smallerRangeKm: found.below === null ? null : rangeOf(found.below), minimumHS, largestHS }, inputs: { present }, assumptions: SIZING_ASSUMPTIONS })
}

// A search sensor and the missile fire control that goes with it, each sized for one engagement range against one target: { search, fireControl }, each a `sensorSizeForRange` value. The fire control's range is twice the search sensor's at one size, so at one tech and resolution it needs a quarter of the exact size.
export const engagementSensorPair = ({ engagementRangeKm, signature, resolution, strengthTech, emTech, jammer = 0, eccm = null }) => {
  const request = { targetRangeKm: engagementRangeKm, signature, resolution, strengthTech, emTech, jammer, eccm }

  return combine({ rule: SENSOR_RULES.sizing, parts: { search: sensorSizeForRange({ ...request, mode: SENSOR_MODES.search }), fireControl: sensorSizeForRange({ ...request, mode: SENSOR_MODES.missileFireControl }) }, compute: (values) => ({ search: values.search, fireControl: values.fireControl }) })
}

// The legal multiplier that is the smallest one for which `meets(multiplier)` holds, as an axis of a beam fire control request: { status, multiplier, exactMultiplier, smaller }, with the statuses of `sensorSizeForRange`. `exactMultiplier` is the unrounded ratio wanted.
const multiplierFor = (exactMultiplier, meets) => {
  const found = smallestMeeting(FIRE_CONTROL_MULTIPLIERS, meets)
  const last = FIRE_CONTROL_MULTIPLIERS[FIRE_CONTROL_MULTIPLIERS.length - 1]

  if (found.index < 0) {
    return { status: 'beyond-largest', multiplier: null, exactMultiplier, smaller: last }
  }

  return { status: found.index === 0 ? 'minimum-bound' : 'sized', multiplier: found.value, exactMultiplier, smaller: found.below }
}

// The beam fire control that reaches `rangeKm` and tracks `trackingKmS` from the race's distance and speed rating techs, with the smallest legal multipliers that do. The value is { range, tracking, design }: `range` and `tracking` are each { status, multiplier, exactMultiplier, smaller } (statuses as in `sensorSizeForRange`: 'sized' with the next smaller legal multiplier falling short, 'minimum-bound' at 0.1, 'beyond-largest' above 4), and `design` is `beamFireControlDesign` at those multipliers, null when an axis is beyond the largest. A range above 1,400,000 km is beyond what any multiplier gives, since the game caps it there. The tracking axis is searched on the tracking the game stores (the multiplier times the speed rating, rounded), not on the unrounded ratio, so the multiplier chosen gives the tracking asked for. The request is an estimate: it asks the confirmed forward rule for the smallest multipliers, under a range cap no save evidences and a window of legal multipliers taken from the design window; the confirmed forward `design` is carried as its own part.
export const beamFireControlForRequest = ({ rangeKm, trackingKmS, distanceRating, speedRating, weaponNumber, hardeningRating, hardeningCost, eccmRating, eccmCost }) => {
  const rule = SENSOR_RULES.sizing
  const { present, missing } = sensorInputs([
    ['wanted range', rangeKm, POSITIVE, 'the range wanted, above zero'],
    ['wanted tracking speed', trackingKmS, POSITIVE, 'the tracking speed wanted, above zero'],
    ['distance rating tech', distanceRating, POSITIVE, 'the fire control distance rating tech above zero'],
    ['speed rating tech', speedRating, POSITIVE, 'the fire control speed rating tech above zero'],
    ['single weapon number', weaponNumber, POSITIVE, 'the single weapon fire control tech\'s number above zero'],
    ['hardening', hardeningRating, NON_NEGATIVE, 'the hardening tech\'s rating'],
    ['hardening cost factor', hardeningCost, NON_NEGATIVE, 'the hardening tech\'s cost factor'],
    ['ECCM', eccmRating, NON_NEGATIVE, 'the ECCM tech\'s rating'],
    ['ECCM cost factor', eccmCost, NON_NEGATIVE, 'the ECCM tech\'s cost factor'],
  ])

  if (missing.length) {
    return unavailable({ rule, present, missing })
  }

  const range = rangeKm > BEAM_FIRE_CONTROL_MAX_RANGE_KM ? { status: 'beyond-largest', multiplier: null, exactMultiplier: rangeKm / distanceRating, smaller: null } : multiplierFor(rangeKm / distanceRating, (multiplier) => multiplier * distanceRating >= rangeKm * (1 - SENSOR_RANGE_TOLERANCE))
  const tracking = multiplierFor(trackingKmS / speedRating, (multiplier) => fireControlTracking(multiplier, speedRating) >= trackingKmS * (1 - SENSOR_RANGE_TOLERANCE))
  const design = range.multiplier === null || tracking.multiplier === null ? null : beamFireControlDesign({ rangeMultiplier: range.multiplier, trackingMultiplier: tracking.multiplier, distanceRating, speedRating, weaponNumber, hardeningRating, hardeningCost, eccmRating, eccmCost })
  const sizing = ofRule({ rule, value: { range, tracking }, inputs: { present }, assumptions: ['the multipliers are those the design window offers (0.1 to 3.99 in hundredths, and 4)'] })
  const limits = ofRule({ rule: SENSOR_RULES.limits, value: { maxRangeKm: BEAM_FIRE_CONTROL_MAX_RANGE_KM }, inputs: { present: ['range limit'] } })
  const parts = { sizing, limits }

  if (design) {
    parts.forward = ofRule({ rule: SENSOR_RULES.beam, value: design, inputs: { present } })
  }

  return combine({ rule, parts, compute: (values) => ({ range: values.sizing.range, tracking: values.sizing.tracking, design: values.forward || null }) })
}

// The rule registry: each rule above registered once, with the game versions it is known for and how far it is checked. `scripts/check-design-rules.js` reads these entries and reports each check under its rule id. The planners' results carry the id (utilities/provenance.js); a rule whose evidence changes is edited here, once.
const DESIGN_VERSIONS = ['2.7.x']

registerRule({
  id: 'design.engineDesign',
  versions: DESIGN_VERSIONS,
  units: 'EP, L/EPH, HS, BP',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.EnginePowerMod', 'FCT_ShipDesignComponents.BGTech1..3', 'FCT_TechSystem.AdditionalInfo, AdditionalInfo2'],
  note: 'Reproduces the power, fuel per engine-power hour, cost, crew, HTK, explosion figures, thermal share and military flag of every stored engine of a stock sample save and a modded save; the modded rows it cannot reproduce are set outside the rule.',
})

registerRule({
  id: 'design.classSpeed',
  versions: DESIGN_VERSIONS,
  units: 'km/s',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.EnginePower, Size, MaxSpeed', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentValue'],
  note: 'Reproduces the stored top speed of every class of both sample saves. A class without engines keeps the game\'s starting speed of 1, which this formula does not give.',
})

registerRule({
  id: 'design.burnPerHour',
  versions: DESIGN_VERSIONS,
  units: 'L/h',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.ComponentValue, FuelEfficiency', 'FCT_ClassComponent.NumComponent'],
  note: 'Engine power times the share in use times the fuel per engine-power hour. The stored class fuel efficiency it starts from is reproduced from the class\'s engines.',
})

registerRule({
  id: 'design.fullPowerRangeKm',
  versions: DESIGN_VERSIONS,
  units: 'km',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.FuelCapacity, FuelEfficiency, EnginePower, MaxSpeed'],
  note: 'Fuel over the full-power burn, times the speed, times 3,600: the class window\'s figure, in km and the same at any speed. The stored fuel efficiency it uses is reproduced for every class with fuel.',
})

registerRule({
  id: 'design.enduranceHours',
  versions: DESIGN_VERSIONS,
  units: 'hours',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.FuelCapacity, FuelEfficiency, EnginePower'],
  note: 'Fuel over the burn at the share of power in use; the burn rule is the one of the burn per hour rule.',
})

registerRule({
  id: 'design.thermalSignature',
  versions: DESIGN_VERSIONS,
  units: 'thermal signature',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.StealthRating, ComponentValue', 'FCT_ClassComponent.NumComponent', 'FCT_ShipClass.ClassThermal, EnginePower, Size'],
  note: 'The signature of a ship under way is the engines\' power times their thermal rating times the share of top speed it moves at, never under a twentieth of its size, and a ship with no move orders shows that floor. The saves store the sum at full power (the class thermal signature) and no live signature, so the speed-share rule is not compared with a saved outcome.',
  assumptions: ['The share of top speed the ship moves at is chosen by the player', 'The engines are all at their nominal count: damage is ignored', 'No ship is under tow, which would raise the mass that sets the speed', 'The ship is one of a fleet with move orders: with none the signature is the floor of a twentieth of the size'],
})

registerRule({
  id: 'design.classThermal',
  versions: DESIGN_VERSIONS,
  units: 'thermal signature',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.ClassThermal', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentValue, StealthRating of the engines'],
  note: 'The sum over the class\'s engines of the count times the engine power times its thermal rating reproduces the stored thermal signature of every class of the saves, but for two classes of one modded save, which store 12.5 times the sum and are pinned in the check. The game allows one engine design to a class, so a class of several designs is only hypothetical or modded: the sum is then power-weighted and estimated, never the mean of the ratings.',
  assumptions: ['The class mounts one engine design, as the game\'s class designer requires'],
})

registerRule({
  id: 'design.classCrossSection',
  versions: DESIGN_VERSIONS,
  units: 'HS',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.ClassCrossSection, SensorReduction, Size', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentValue, CloakRating of the cloaks'],
  note: 'The size times the sensor reduction, never under 0.3 HS, reproduces the stored cross-section of every class of the saves; the stored reduction is the rating of the last fitted cloak whose largest ship is at least the class\'s size, else 1. An active sensor sees the cross-section while the cloak is undamaged and the size once it is damaged.',
  assumptions: ['The cloak is undamaged for the cross-section; the size is the cross-section of a class whose cloak is damaged'],
})

registerRule({
  id: 'design.classSize',
  versions: DESIGN_VERSIONS,
  units: 'HS',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.Size'],
  note: 'The size the save stores for the class, in HS; the tons are the size times 50. The size is read as stored, never rebuilt from the components, and is the base of the cross-section and of the idle thermal signature (the class cross section rule, the thermal signature rule).',
  assumptions: ['A class whose save stores no size has an unknown size and no tons, never 0'],
})

registerRule({
  id: 'design.emEmission',
  versions: DESIGN_VERSIONS,
  units: 'EM signature',
  verification: 'estimated',
  structure: ['FCT_ShipClass.ShieldStrength', 'FCT_ShipDesignComponents.ComponentValue, Resolution of the active sensors'],
  note: 'The EM signature is the shield strength times 30 while the shields are up, or the active sensor\'s strength times its resolution (each cut to a whole number, never under 1) while it is switched on, each active sensor design seen on its own and never summed. The saves store no emission, so the rule is arithmetic on stored strengths and is not compared with a saved outcome.',
  assumptions: ['Shields are up at their full strength: live shields may be lower', 'An active sensor is switched on'],
})

registerRule({
  id: 'design.packTanks',
  versions: DESIGN_VERSIONS,
  units: 'HS, L, BP',
  verification: 'assumed',
  structure: ['FCT_ShipDesignComponents.Size, ComponentValue, Cost of the race\'s stock fuel tanks'],
  note: 'The game has no packing rule: the objective is the planner\'s own (fewest HS, then fewest BP, then fewest tanks; the cheapest package takes the fewest BP first). Under it the package is exact, not a heuristic: a table over whole-number litres, HS and BP, with a repeating pattern checked on the table for the requests past its size, equal to the exhaustive enumeration of every package on the stock tanks, on the modded save\'s tanks and on synthetic catalogues, and every package holds the litres it was asked for, from the catalogue\'s own rows. The litres each tank holds and its cost are stored figures. A result says whether it is proved: a package a bound cut short is estimated, and a request no tank can hold is unavailable.',
  assumptions: ['The package is chosen by the planner\'s own objective, which the game does not apply', `A request is met when the litres held reach it within ${REQUEST_TOLERANCE} of it`],
})

registerRule({
  id: 'design.jumpDriveDesign',
  versions: DESIGN_VERSIONS,
  units: 'HS, BP',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.Size, Cost, Crew, HTK, ComponentValue, BGTech1..4', 'FCT_TechSystem.AdditionalInfo, AdditionalInfo2'],
  note: 'Reproduces the size, cost, crew, HTK and capacity of every stored jump drive of a modded save. The one commercial drive of the stock sample save was designed under an older rule that kept the size to 1 decimal, and is explained, not reproduced.',
})

registerRule({
  id: 'design.selfJumpDrive',
  versions: DESIGN_VERSIONS,
  units: 'HS, BP',
  verification: 'estimated',
  structure: ['FCT_TechSystem.AdditionalInfo of the race\'s jump drive efficiency, squadron size and radius techs'],
  note: 'The drive sizing loop is the game\'s, but the game also re-sizes the armour as the class grows and this keeps the rest of the hull as it is, so the figure is approximate for a class with armour.',
  assumptions: ['The rest of the hull stays as it is while the drive is added', 'The default squadron size and radius techs are used'],
})

registerRule({
  id: 'design.propulsionShare',
  versions: DESIGN_VERSIONS,
  units: '%, HS',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.Size', 'FCT_ShipDesignComponents.Size'],
  note: 'The engines\' and tanks\' HS over the finished ship\'s HS: arithmetic on stored sizes, or on sizes the engine and tank rules give.',
})

registerRule({
  id: 'design.propulsionCrew',
  versions: DESIGN_VERSIONS,
  units: 'crew',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.Crew'],
  note: 'The sum of the engines\' and tanks\' crew, each stored, or given by the engine rule that reproduces every stored engine.',
})

registerRule({
  id: 'design.savedPropulsionCost',
  versions: DESIGN_VERSIONS,
  units: 'BP',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.Cost', 'FCT_ClassComponent.NumComponent'],
  note: 'The stored cost of each engine and tank a saved class mounts, times its count. It covers the propulsion parts only, not the whole class.',
})

registerRule({
  id: 'design.propulsionSetCost',
  versions: DESIGN_VERSIONS,
  units: 'BP',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.Cost of the stock tanks', 'FCT_TechSystem.AdditionalInfo, AdditionalInfo2 of the engine, fuel and thermal techs'],
  note: 'The engine cost rule reproduces every stored engine\'s cost, bar one modded row (the engine design rule), but the engines of a set are not yet designed in the game, the tank mix is the planner\'s own lightest package (the tank packing rule) and the figure leaves out the rest of the class.',
  assumptions: ['Engines are priced by the design rule, not by a stored component', 'Tanks are the planner\'s own lightest package, which the game does not apply', 'Only the engines and fuel tanks are counted, not the rest of the class'],
})

registerRule({
  id: 'design.engineeringMsp',
  versions: DESIGN_VERSIONS,
  units: 'MSP',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.Size, Cost, MaintSupplies', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID 31, ComponentValue'],
  note: 'Half the class cost over the coverage factor (size x 0.04 over the engineering), cut to a whole number. Reproduced with the storage rule in every stored maintenance supplies of a stock sample save and a modded save, bar the rows explained as set outside the rule.',
})

registerRule({
  id: 'design.maintenanceStorage',
  versions: DESIGN_VERSIONS,
  units: 'MSP',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.ComponentTypeID 47, ComponentValue', 'FCT_ClassComponent.NumComponent'],
  note: 'Each storage component\'s value times its count, cut to a whole number, summed. Reproduced with the engineering rule in the stored maintenance supplies.',
})

registerRule({
  id: 'design.classMaintenanceSupplies',
  versions: DESIGN_VERSIONS,
  units: 'MSP',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.MaintSupplies', 'design.engineeringMsp', 'design.maintenanceStorage'],
  note: 'Engineering MSP plus storage; a class without engineering holds its storage alone. Compared with the stored maintenance supplies of every class of both sample saves.',
  assumptions: ['The class is a stored or designed class whose cost, size and component rows are final'],
})

registerRule({
  id: 'design.annualFailureRate',
  versions: DESIGN_VERSIONS,
  units: '% a year',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.Size, BaseFailureChance', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID 31, ComponentValue'],
  note: 'Half the size times size x 0.04 over the engineering, in percent at a clock of one year; a class without engineering fails at 10% a year per HS. Compared with the stored base failure chance of every class of both sample saves.',
})

registerRule({
  id: 'design.damageAllocation',
  versions: DESIGN_VERSIONS,
  units: 'damage roll',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.MaxDACRoll', 'FCT_ClassComponent.ChanceToHit, NumComponent', 'FCT_ShipDesignComponents.Size, ComponentTypeID 11'],
  note: 'Each component other than armour takes size times count rounded up of the roll; the thresholds are the running total and damage allocation roll the sum. Compared with every stored damage allocation roll and chance to hit of both sample saves.',
})

registerRule({
  id: 'design.averageRepairCost',
  versions: DESIGN_VERSIONS,
  units: 'MSP',
  verification: 'estimated',
  structure: ['FCT_ClassComponent.ChanceToHit', 'FCT_ShipClass.MaxDACRoll', 'FCT_ShipDesignComponents.Cost'],
  note: 'Each component\'s cost weighted by the difference of its damage allocation threshold and the one before it over damage allocation roll. The thresholds and the roll it weighs by are reproduced by the damage allocation rule, but the save stores no repair cost to compare the figure with.',
})

registerRule({
  id: 'design.maintenanceLifeSeries',
  versions: DESIGN_VERSIONS,
  units: 'years, MSP',
  verification: 'estimated',
  structure: ['FCT_ShipClass.BaseFailureChance, MaintSupplies, Commercial'],
  note: 'The class window\'s yearly supply series on a fresh, never-overhauled clock: the spend in year n is the average repair cost times the failure rate times n, summed until the supplies run out, over at most 200 years. The save stores no maintenance life to compare it with, and the series is an expectation, not a promise of when a ship fails.',
  assumptions: ['The ship\'s maintenance clock starts at zero and is never reset', 'Failures draw the average repair cost, not a particular component\'s'],
})

registerRule({
  id: 'design.incrementFailureChance',
  versions: DESIGN_VERSIONS,
  units: '% an increment',
  verification: 'estimated',
  structure: ['FCT_ShipClass.BaseFailureChance', 'FCT_Ship.LastOverhaul'],
  note: 'Elapsed years times the annual failure rate times the clock, doubled in a training command, times the uncovered share, times 2 minus the crew performance modifier and 2 minus the engineering bonus. Read from the game; the save stores no ship\'s failure chance to compare it with.',
  assumptions: ['The ship\'s engineering is undamaged, so its annual failure rate is the class\'s'],
})

registerRule({
  id: 'design.missileEngineDesign',
  versions: DESIGN_VERSIONS,
  units: 'EP, L/EPH, BP',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.Size, Cost, ComponentValue, FuelEfficiency of a missile engine', 'FCT_TechSystem.AdditionalInfo of the engine, fuel and greatest thrust techs'],
  note: 'A missile engine\'s power, fuel use and cost from its size, thrust modifier and techs; the fuel use is boosted four times over the excess of the thrust over the race\'s greatest. Reproduces the thrust of every missile engine a saved design uses, to the rounding of its stored power.',
  assumptions: ['The engine techs are the levels the race held at the highest development cost'],
})

registerRule({
  id: 'design.missileAccounting',
  versions: DESIGN_VERSIONS,
  units: 'MSP, BP, minerals',
  verification: 'confirmed',
  structure: ['FCT_MissileType.Size, Cost, MSPFuel, MSPWarhead, MSPActive, MSPThermal, MSPEM, MSPGeo, MSPReactor, NumDecoys, MultipleWarheads, NumEngines, NumSS, ECCM, ATG, Retargeting, LaserWarhead, Speed, Endurance, MaxRange, FuelRequired, TotalFlightTime', 'FCT_MissileType.Corbomite, Tritanium, Boronide, Uridium, Gallicite', 'FCT_TechSystem.AdditionalInfo of the warhead, sensor, power plant and laser efficiency techs'],
  note: `The size, cost and minerals of a missile as the sum of its options (engine, fuel, warhead, sensor reactor, four sensors, ECM decoys, extra warheads, second stage, ECCM, terminal guidance, retargeting, laser warhead), with the speed, endurance and range they give. Compared with every stored design of six saves: the rows it does not reproduce are explained, or unknown where a tech level is not held. An option the rules do not cover (a ground pod, an enhanced radiation warhead, a retargeting level above ${VALIDATED_RETARGETING}) is unavailable, never 0.`,
  assumptions: ['The techs are the levels the race held at the highest development cost', 'The sensor, warhead, laser and reactor figures are read from the tech level the stored figure resolves to'],
})

registerRule({
  id: 'design.missileAccountingExtended',
  versions: DESIGN_VERSIONS,
  units: 'BP, minerals, seconds, km',
  verification: 'estimated',
  structure: ['design.missileAccounting', 'FCT_MissileType.Cost, Uridium, Corundium, Endurance, MaxRange, TotalFlightTime of designs 500724 (game 140) and 154678 (game 138)'],
  note: 'The cost and minerals of a missile in which a quantity the cost formulas read (a size, a sensor strength, a warhead damage, the reactor output, the engine cost and power, a count or level; the checked missile cost domain) is above the highest of a saved design whose cost reproduces, and the endurance, range and flight time of one with second stages: the accounting\'s formulas applied past what a saved design confirms. The modded design 500724 (thermal sensor strength 150, reactor output 30, laser 90) is stored 137.2 BP under the rule with its Uridium and Corundium short, and design 154678 (nine second stages) 0.08% under in endurance; the cause of neither is identified. The bound is on the quantities the formulas read, not on a tech level alone: a size and a tech that give the same strength are the same case.',
  assumptions: ['The formulas of the missile accounting rule hold past the quantities and the stage counts a saved design reproduces'],
})

registerRule({
  id: 'design.missileFeasibility',
  versions: DESIGN_VERSIONS,
  units: 'MSP, BP, minerals',
  verification: 'confirmed',
  structure: ['design.missileAccounting'],
  note: `Whether a candidate's size, cost and minerals are within the limits it was given: each over a limit by more than ${REPRODUCTION_TOLERANCE} of it is a violation. Only a candidate whose every option is known is judged; a candidate with an unknown or an unsupported option has no verdict.`,
  assumptions: ['The limits are the player\'s own, not the game\'s'],
})

registerRule({
  id: 'design.missileEfficacy',
  versions: DESIGN_VERSIONS,
  units: '',
  verification: 'assumed',
  structure: ['design.missileAccounting', 'the missileHit rules'],
  note: 'The effects a candidate\'s options are meant to have, apart from the accounting. Only an effect whose rule is confirmed against saved data counts toward a ranking, and no effect adds a score of its own: the planner\'s own policy, since the game has no such rule.',
  assumptions: ['An effect counts only when its rule is confirmed against saved data'],
})

registerRule({
  id: SENSOR_RULES.active,
  versions: DESIGN_VERSIONS,
  units: 'HS, km, BP, minerals',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.Size, Cost, Crew, HTK, ComponentValue, MaxSensorRange, Resolution, ECCM, ElectronicCTD, Uridium, Corbomite of an active sensor or a missile fire control', 'FCT_TechSystem.AdditionalInfo, AdditionalInfo2 of the active sensor strength, EM sensitivity, hardening and ECCM techs'],
  note: 'An active sensor or missile fire control from its size, resolution and techs: the strength is the size times the strength tech, the range the square root of strength times the EM sensitivity times the resolution to the power of two thirds over pi (3.1416), in millions of km, doubled for a missile fire control. The Uridium is the strength times the hardening cost factor to 1 decimal, the cost that times the ECCM cost factor. Reproduces the strength, range, cost, minerals, crew, HTK, ECCM and CTD of every owned sensor of the stock saves, and of the modded save but for the rows set outside the rule.',
  assumptions: ['The techs are the ones named by the component\'s tech slots, found by tech type', 'The pi of the range is 3.1416'],
})

registerRule({
  id: SENSOR_RULES.passive,
  versions: DESIGN_VERSIONS,
  units: 'HS, sensitivity, BP',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.Size, Cost, Crew, HTK, ComponentValue, ElectronicCTD, Uridium of a thermal or EM sensor', 'FCT_TechSystem.AdditionalInfo, AdditionalInfo2 of the sensitivity and hardening techs'],
  note: 'A thermal or EM sensor from its size and techs: the sensitivity is the size times the sensitivity tech, the cost that times the hardening cost factor to 1 decimal, all of it Uridium. Reproduces every owned passive sensor of the stock saves, and of the modded save but for the rows set outside the rule.',
  assumptions: ['The techs are the ones named by the component\'s tech slots, found by tech type'],
})

registerRule({
  id: SENSOR_RULES.beam,
  versions: DESIGN_VERSIONS,
  units: 'km, km/s, HS, BP, minerals',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.Size, Cost, Crew, HTK, ComponentValue, TrackingSpeed, FCRangeModifier, FCSpeedModifier, SpecialFunction, ECCM, ElectronicCTD, Uridium, Corbomite of a beam fire control', 'FCT_TechSystem.AdditionalInfo, AdditionalInfo2 of the fire control distance, speed, single weapon, hardening and ECCM techs'],
  note: 'A beam fire control from its range and tracking multipliers and techs: the range is the range multiplier times the distance rating tech, the tracking the tracking multiplier times the speed rating tech, the size half the product of the multipliers times the single weapon number, to 2 decimals, the crew four a HS. The Uridium is the range over 20,000 times the tracking over 1,000 cut to a whole number times the hardening cost factor and the weapon number, to 1 decimal; the cost is that times the ECCM cost factor. Reproduces range, tracking, size, crew, cost and minerals of every owned fire control of the stock saves, and of the modded save but for the rows set outside the rule.',
  assumptions: ['The techs are the ones named by the component\'s tech slots, found by tech type', 'The single weapon tech\'s number is 1 for a full fire control and under 1 for a single weapon one'],
})

registerRule({
  id: SENSOR_RULES.limits,
  versions: DESIGN_VERSIONS,
  units: 'km, HS',
  verification: 'estimated',
  structure: ['design.beamFireControlDesign', 'FCT_ShipDesignComponents.ComponentValue, Size of beam fire controls'],
  note: `The range of a beam fire control never above ${BEAM_FIRE_CONTROL_MAX_RANGE_KM} km and its size never below ${BEAM_FIRE_CONTROL_MIN_SIZE_HS} HS. No sampled stock-save fire control reaches the range limit (the greatest range observed is 384,000 km, in the 1973 save) and the modded save stores ranges up to 40,000,000 km, so no saved row shows the cap applied and the cap is checked only on a synthetic design; the size floor is seen only on a modded row.`,
  assumptions: ['The limits hold as stated for a stock design', 'A modded save storing an uncapped range is outside them'],
})

registerRule({
  id: SENSOR_RULES.detection,
  versions: DESIGN_VERSIONS,
  units: 'km',
  verification: 'estimated',
  structure: ['design.activeSensorDesign', 'design.passiveSensorDesign'],
  note: `The range a sensor detects a target at: the maximum range times the square of the target's signature over the resolution when the signature is below it, times 0.75 to the power of the target's jammer less the sensor's ECCM when the jammer is the stronger, for a ship target; a missile is seen by a signature of its size in MSP over ${MSP_PER_HS}, never below ${MISSILE_SIGNATURE_MIN} HS, and no jammer applies to it; a passive sensor sees a signature at the square root of sensitivity times signature times ${PASSIVE_RANGE_MULTIPLIER} km. The saves store no detection result, so these are checked as arithmetic of the stated rules and as the way the stored maximum range is used, not against a saved outcome. The jammer rule is not the missile hit penalty, which takes 0.75 to the whole jammer.`,
  assumptions: ['The resolution and the signature are in the same unit (HS)', 'No target jammer means a jammer of 0'],
})

registerRule({
  id: SENSOR_RULES.sizing,
  versions: DESIGN_VERSIONS,
  units: 'HS, km',
  verification: 'estimated',
  structure: ['design.activeSensorDesign', 'design.sensorDetection', 'design.beamFireControlDesign'],
  note: 'The smallest legal size of an active sensor or missile fire control, or the smallest legal multipliers of a beam fire control, that reaches a wanted range, by the forward rules; the next smaller legal size falls short of it, or a minimum or a beyond-largest bound is reported. The legal sizes are the design window\'s lists, which the saves do not store: the AI\'s own sensors are saved at sizes off them.',
  assumptions: ['The legal sizes, resolutions and multipliers are those the design window offers', 'The techs are the levels the race holds'],
})
