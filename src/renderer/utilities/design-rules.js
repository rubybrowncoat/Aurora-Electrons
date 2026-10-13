// The game's design rules, for the planners: what a component or a class built from the race's tech comes out at, as the game's design windows work it out. Pure functions with the units in their argument names: sizes in hull spaces (HS), power in engine power (EP), fuel in litres, speed in km/s, distance in km, cost in BP. docs/DATABASE.md § Design rules states each rule in prose.

import { combine, envelope, ofRule, registerRule, STATUS, unavailable } from './provenance'
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

// The rule registry: each rule above registered once, with the game versions it is known for and how far it is checked. `scripts/check-design-rules.js` reads these entries and reports each check under its rule id. The planners' results carry the id (utilities/provenance.js); a rule whose evidence changes is edited here, once.
const DESIGN_VERSIONS = ['2.7.x']
const SAVE_CHECK = 'scripts/check-design-rules.js'

registerRule({
  id: 'design.engineDesign',
  versions: DESIGN_VERSIONS,
  units: 'EP, L/EPH, HS, BP',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.EnginePowerMod', 'FCT_ShipDesignComponents.BGTech1..3', 'FCT_TechSystem.AdditionalInfo, AdditionalInfo2'],
  note: `Reproduces the power, fuel per engine-power hour, cost, crew, HTK, explosion figures, thermal share and military flag of every stored engine of a stock 2.7.1 save and a modded 2.7.0 save (${SAVE_CHECK}); the modded rows it cannot reproduce are listed there as set outside the rule. docs/DATABASE.md § Design rules.`,
})

registerRule({
  id: 'design.classSpeed',
  versions: DESIGN_VERSIONS,
  units: 'km/s',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.EnginePower, Size, MaxSpeed', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentValue'],
  note: `Reproduces the stored top speed of every class of both sample saves (${SAVE_CHECK}). A class without engines keeps the game's starting speed of 1, which this formula does not give.`,
})

registerRule({
  id: 'design.burnPerHour',
  versions: DESIGN_VERSIONS,
  units: 'L/h',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.ComponentValue, FuelEfficiency', 'FCT_ClassComponent.NumComponent'],
  note: `Engine power times the share in use times the fuel per engine-power hour. The stored class fuel efficiency it starts from is reproduced from the class's engines (${SAVE_CHECK}); the linear burn is settled in docs/plans/planners/mechanics-operations.md.`,
})

registerRule({
  id: 'design.fullPowerRangeKm',
  versions: DESIGN_VERSIONS,
  units: 'km',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.FuelCapacity, FuelEfficiency, EnginePower, MaxSpeed'],
  note: `Fuel over the full-power burn, times the speed, times 3,600: the class window's figure, in km and the same at any speed (docs/plans/planners/mechanics-operations.md, settled). The stored fuel efficiency it uses is reproduced for every class with fuel (${SAVE_CHECK}).`,
})

registerRule({
  id: 'design.enduranceHours',
  versions: DESIGN_VERSIONS,
  units: 'hours',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.FuelCapacity, FuelEfficiency, EnginePower'],
  note: 'Fuel over the burn at the share of power in use; the burn rule is the one of design.burnPerHour.',
})

registerRule({
  id: 'design.thermalSignature',
  versions: DESIGN_VERSIONS,
  units: 'thermal signature',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.StealthRating', 'FCT_ShipClass.ClassThermal'],
  note: 'The rule is read from the game and settled in docs/plans/planners/mechanics-sensors.md, but no stored signature is compared with it yet.',
  assumptions: ['The share of top speed the ship moves at is chosen by the player'],
})

registerRule({
  id: 'design.packTanks',
  versions: DESIGN_VERSIONS,
  units: 'HS, L, BP',
  verification: 'assumed',
  structure: ['FCT_ShipDesignComponents.Size, ComponentValue, Cost of the race\'s stock fuel tanks'],
  note: 'The game has no packing rule: the objective is the planner\'s own (fewest HS, then fewest BP, then fewest tanks; the cheapest package takes the fewest BP first). Under it the package is exact, not a heuristic: a table over whole-number litres, HS and BP, with a repeating pattern checked on the table for the requests past its size, equal to the exhaustive enumeration of every package on the stock tanks, on the modded save\'s tanks and on synthetic catalogues (scripts/check-tank-packing.js), and every package holds the litres it was asked for, from the catalogue\'s own rows. The litres each tank holds and its cost are stored figures. A result says whether it is proved: a package a bound cut short is estimated, and a request no tank can hold is unavailable.',
  assumptions: ['The package is chosen by the planner\'s own objective, which the game does not apply', `A request is met when the litres held reach it within ${REQUEST_TOLERANCE} of it`],
})

registerRule({
  id: 'design.jumpDriveDesign',
  versions: DESIGN_VERSIONS,
  units: 'HS, BP',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.Size, Cost, Crew, HTK, ComponentValue, BGTech1..4', 'FCT_TechSystem.AdditionalInfo, AdditionalInfo2'],
  note: `Reproduces the size, cost, crew, HTK and capacity of every stored jump drive of a modded 2.7.0 save (${SAVE_CHECK}). The one commercial drive of the stock 2.7.1 save was designed under an older rule that kept the size to 1 decimal, and is listed there as explained.`,
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
  note: 'The engine cost rule reproduces every stored engine\'s cost, bar one modded row (design.engineDesign), but the engines of a set are not yet designed in the game, the tank mix is the planner\'s own lightest package (design.packTanks) and the figure leaves out the rest of the class.',
  assumptions: ['Engines are priced by the design rule, not by a stored component', 'Tanks are the planner\'s own lightest package, which the game does not apply', 'Only the engines and fuel tanks are counted, not the rest of the class'],
})

registerRule({
  id: 'design.engineeringMsp',
  versions: DESIGN_VERSIONS,
  units: 'MSP',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.Size, Cost, MaintSupplies', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID 31, ComponentValue'],
  note: `Half the class cost over the coverage factor (size x 0.04 over the engineering), cut to a whole number. Reproduced with the storage rule in every stored MaintSupplies of a stock 2.7.1 save and a modded 2.7.0 save, bar the rows ${SAVE_CHECK} lists as explained.`,
})

registerRule({
  id: 'design.maintenanceStorage',
  versions: DESIGN_VERSIONS,
  units: 'MSP',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.ComponentTypeID 47, ComponentValue', 'FCT_ClassComponent.NumComponent'],
  note: `Each storage component's value times its count, cut to a whole number, summed. Reproduced with the engineering rule in the stored MaintSupplies (${SAVE_CHECK}).`,
})

registerRule({
  id: 'design.classMaintenanceSupplies',
  versions: DESIGN_VERSIONS,
  units: 'MSP',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.MaintSupplies', 'design.engineeringMsp', 'design.maintenanceStorage'],
  note: `Engineering MSP plus storage; a class without engineering holds its storage alone. Compared with the stored MaintSupplies of every class of both sample saves (${SAVE_CHECK}).`,
  assumptions: ['The class is a stored or designed class whose cost, size and component rows are final'],
})

registerRule({
  id: 'design.annualFailureRate',
  versions: DESIGN_VERSIONS,
  units: '% a year',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.Size, BaseFailureChance', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID 31, ComponentValue'],
  note: `Half the size times size x 0.04 over the engineering, in percent at a clock of one year; a class without engineering fails at 10% a year per HS. Compared with the stored BaseFailureChance of every class of both sample saves (${SAVE_CHECK}).`,
})

registerRule({
  id: 'design.damageAllocation',
  versions: DESIGN_VERSIONS,
  units: 'damage roll',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.MaxDACRoll', 'FCT_ClassComponent.ChanceToHit, NumComponent', 'FCT_ShipDesignComponents.Size, ComponentTypeID 11'],
  note: `Each component other than armour takes size times count rounded up of the roll; the thresholds are the running total and MaxDACRoll the sum. Compared with every stored MaxDACRoll and ChanceToHit of both sample saves (${SAVE_CHECK}).`,
})

registerRule({
  id: 'design.averageRepairCost',
  versions: DESIGN_VERSIONS,
  units: 'MSP',
  verification: 'estimated',
  structure: ['FCT_ClassComponent.ChanceToHit', 'FCT_ShipClass.MaxDACRoll', 'FCT_ShipDesignComponents.Cost'],
  note: 'Each component\'s cost weighted by the difference of its damage allocation threshold and the one before it over MaxDACRoll. The thresholds and the roll it weighs by are reproduced by design.damageAllocation, but the save stores no repair cost to compare the figure with; docs/plans/backlog/evidence/AE-106-01.md works one saved class through by hand.',
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
