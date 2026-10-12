// The game's design rules, for the planners: what a component or a class built from the race's tech comes out at, as the game's design windows work it out. Pure functions with the units in their argument names: sizes in hull spaces (HS), power in engine power (EP), fuel in litres, speed in km/s, distance in km, cost in BP. docs/DATABASE.md § Design rules states each rule in prose.

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

const tankTotals = (picks) => ({
  picks,
  sizeHS: picks.reduce((sum, pick) => sum + pick.sizeHS * pick.count, 0),
  litres: picks.reduce((sum, pick) => sum + pick.litres * pick.count, 0),
  cost: picks.reduce((sum, pick) => sum + pick.cost * pick.count, 0),
})

// The fuel tanks that hold `litres` in the fewest HS, then the fewest BP, from `tanks` ({ id, name, sizeHS, litres, cost }). Going from the largest tank down, each size either takes as many as fit and hands the rest to the smaller sizes, or takes one more and holds the lot; the lighter of the two wins. The game has no packing rule; this is the planner's own, as A4xCalc's was. Returns { picks: [{ ...tank, count }], sizeHS, litres, cost }, largest tank first.
export const packTanks = ({ litres, tanks }) => {
  const largestFirst = tanks.filter((tank) => tank.litres > 0 && tank.sizeHS > 0).sort((a, b) => b.litres - a.litres)

  const pack = (index, remaining) => {
    if (remaining <= 1e-9 || index >= largestFirst.length) {
      return tankTotals([])
    }

    const tank = largestFirst[index]
    const whole = floorExact(remaining / tank.litres)
    const left = remaining - whole * tank.litres

    if (left <= 1e-9) {
      return tankTotals([{ ...tank, count: whole }])
    }

    const covered = tankTotals([{ ...tank, count: whole + 1 }])

    if (index === largestFirst.length - 1) {
      return covered
    }

    const rest = pack(index + 1, left)
    const split = tankTotals(whole > 0 ? [{ ...tank, count: whole }, ...rest.picks] : rest.picks)
    const lighter = split.sizeHS < covered.sizeHS - 1e-9 || (Math.abs(split.sizeHS - covered.sizeHS) <= 1e-9 && split.cost <= covered.cost)

    return lighter ? split : covered
  }

  return pack(0, litres)
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
