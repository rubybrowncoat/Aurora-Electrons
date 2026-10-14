/*
  The size, cost and mineral accounting of a missile design, reconstructed from the figures the save stores with it: a prototype of the rules AE-152-02 moves into utilities/design-rules.js. It is an ES module with no imports, like the utilities, so scripts/check-design-rules.js loads it through scripts/lib/utilities.js (`loadUtilities(['missile-accounting'], { directory: scripts/lib })`) and a mutant check loads a mutated copy of the folder the same way.

  What a missile design is made from. The game builds a missile from its engine component (the design stores the component's id and the count), the sizes the designer allots to fuel, warhead, sensors and decoys, the options switched on (ECCM, active terminal guidance, retargeting, laser warhead), a second stage and a size limit. Every technology a figure needs is the level the race had researched at the highest development cost when the design was made: the design records neither the level nor the date, so a historical design is not rebuilt from the race's current best level but from the held level that reproduces the figures it stored (`resolveLevels`). A figure whose level cannot be found, or whose evidence the save lacks, is unknown (null) with its reason, never 0.

  Rounding follows the game's decimal arithmetic: a midpoint goes to the even neighbour (`roundHalfEven`), engine power to 2 decimals, sensor strength to 2, warhead strength to 3, the reactor's output and size to 4, speed and endurance to 1, and the fuel carried is cut to a whole litre.
*/

// Missile sizes are in MSP; an engine's size scales by hull spaces, 20 MSP to the HS.
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
export const THRUST_EXPONENT = 2.5
export const THRUST_BOOST_SLOPE = 4
export const SENSOR_PI = 3.1416

// The tech types a missile design reads, as DIM_TechType numbers them.
export const TECH = Object.freeze({ warhead: 12, thermal: 19, active: 20, reactor: 41, eccm: 83, geo: 89, em: 125, maxThrust: 130, radiation: 163, laserEfficiency: 274, terminal: 275, retarget: 276, laserFocus: 277, missileEcm: 279, multipleWarheads: 280, shipDecoy: 281, engine: 40, fuel: 65 })

// The minerals FCT_MissileType stores, and the two the game also charges for which it has no column: a laser warhead's Corundium and a ground pod's Vendarite.
export const STORED_MINERALS = Object.freeze(['Corbomite', 'Tritanium', 'Boronide', 'Uridium', 'Gallicite'])
export const UNSTORED_MINERALS = Object.freeze(['Corundium', 'Vendarite'])
export const MINERALS = Object.freeze([...STORED_MINERALS, ...UNSTORED_MINERALS])

// The size contributions in the order the game adds them, then the fixed add-ons.
export const CONTRIBUTIONS = Object.freeze(['engine', 'fuel', 'warhead', 'reactor', 'active', 'thermal', 'em', 'geo', 'decoys', 'extraWarheads', 'secondStage', 'eccm', 'terminal', 'retarget', 'laser'])

// Rounds a midpoint to the even neighbour, as the game's decimal rounding does, so 0.175 at 2 decimals is 0.18 and 0.125 is 0.12.
export const roundHalfEven = (value, decimals = 0) => {
  const factor = 10 ** decimals
  const scaled = value * factor
  const floor = Math.floor(scaled)

  if (Math.abs(scaled - floor - 0.5) < 1e-9) {
    return (Math.abs(floor) % 2 === 0 ? floor : floor + 1) / factor
  }

  return Math.round(scaled) / factor
}

// Cuts to a whole number as the game's decimal cast does, without letting float error take 2632 down to 2631.9999999.
export const floorExact = (value) => Math.floor(value + 1e-9)

// Whether two figures agree to the checks' tolerance: 1e-9 of the larger, and never closer than 1e-12 absolute, so two zeros agree.
export const REPRODUCTION_TOLERANCE = 1e-9

export const agrees = (stored, computed) => Math.abs(stored - computed) <= Math.max(1e-12, REPRODUCTION_TOLERANCE * Math.max(Math.abs(stored), Math.abs(computed)))

const isKnown = (value) => value !== null && value !== undefined && !Number.isNaN(value)

const allKnown = (...values) => values.every(isKnown)

const zeroMinerals = () => Object.fromEntries(MINERALS.map((name) => [name, 0]))

const mineralsOf = (amounts) => ({ ...zeroMinerals(), ...amounts })

// ---------- the elementary rules, each one formula of the game ----------

// An engine's power and fuel use as the game designs a missile engine from its engine tech (EP per HS at thrust 1), fuel tech (litres per EP-hour at thrust 1 and 10 HS), thrust modifier and size in MSP. Above the race's greatest thrust modifier the fuel use is boosted by the excess over it, four times over; the power and the cost are not.
export const missileEngineDesign = ({ sizeMsp, thrust, engineTech, fuelTech, maxThrust }) => {
  const sizeHS = sizeMsp / MSP_PER_HS
  const boost = thrust > maxThrust ? (thrust - maxThrust) / maxThrust * THRUST_BOOST_SLOPE + 1 : 1
  const power = roundHalfEven(engineTech * sizeHS * thrust, 2)

  return { power, fuelEfficiency: fuelTech * thrust ** THRUST_EXPONENT * boost * Math.sqrt(10 / sizeHS), cost: power / 2 * (thrust < 1 ? thrust : 1) }
}

// The thrust modifier an engine was designed at, from its stored power: the design rounds the power to 2 decimals, so this is exact to that rounding.
export const thrustOfEngine = ({ power, sizeMsp, engineTech }) => power / (engineTech * (sizeMsp / MSP_PER_HS))

// A warhead's strength: its MSP times the warhead tech, cut by the radiation multiplier, to 3 decimals. A ship decoy has 200 a MSP and no tech.
export const warheadStrength = ({ warheadMsp, warheadTech, radiationMultiplier = 1, shipDecoy = false }) => {
  if (!(warheadMsp > 0)) {
    return 0
  }

  if (shipDecoy) {
    return roundHalfEven(warheadMsp * SHIP_DECOY_STRENGTH_PER_MSP / radiationMultiplier, 3)
  }

  return isKnown(warheadTech) ? roundHalfEven(warheadMsp * warheadTech / radiationMultiplier, 3) : null
}

// The damage the warhead does before the radiation split, unrounded: what the Tritanium of the warhead is a quarter of.
export const baseWarheadDamage = ({ warheadMsp, warheadTech, shipDecoy = false }) => {
  if (!(warheadMsp > 0)) {
    return 0
  }

  if (shipDecoy) {
    return warheadMsp * SHIP_DECOY_STRENGTH_PER_MSP
  }

  return isKnown(warheadTech) ? warheadMsp * warheadTech : null
}

// A sensor's strength: its MSP times the sensor tech times 0.05, to 2 decimals; a sensor under a quarter of an MSP has none.
export const sensorStrength = ({ sensorMsp, sensorTech }) => {
  if (!(sensorMsp >= MIN_SENSOR_MSP)) {
    return 0
  }

  return isKnown(sensorTech) ? roundHalfEven(sensorMsp * sensorTech * SENSOR_STRENGTH_FACTOR, 2) : null
}

// The reactor that feeds the sensors: a fifth of the summed strength is the output the reactor must give, to 4 decimals, and its size is that over the power plant tech times 0.05, to 4 decimals. With no output the reactor is not needed, whatever the tech.
export const reactorOutput = (strengths) => (strengths.every(isKnown) ? roundHalfEven(strengths.reduce((total, value) => total + value, 0) / REACTOR_OUTPUT_DIVISOR, 4) : null)

export const reactorMsp = ({ output, reactorTech }) => {
  if (!isKnown(output)) {
    return null
  }

  if (output === 0) {
    return 0
  }

  return isKnown(reactorTech) && reactorTech > 0 ? roundHalfEven(output / (reactorTech * SENSOR_STRENGTH_FACTOR), 4) : null
}

// A laser warhead keeps the share of the strength its efficiency tech (a percentage) gives, to 3 decimals.
export const laserWarheadStrength = ({ strength, efficiency }) => (allKnown(strength, efficiency) ? roundHalfEven(strength * (efficiency / 100), 3) : null)

// An active sensor's range in km: the square root of its strength times the EM sensitivity the design recorded times the resolution to the power 2/3, over pi as the game approximates it, in millions of km, rounded to a whole number.
export const activeSensorRange = ({ strength, emSensitivity, resolution }) => {
  if (!(resolution !== 0 && strength !== 0)) {
    return 0
  }

  return allKnown(strength, emSensitivity) ? roundHalfEven(Math.sqrt(strength * emSensitivity * resolution ** (2 / 3) / SENSOR_PI) * 1e6, 0) : null
}

// ---------- the build-up of one design ----------

const contribution = (msp, bp, minerals, unknown = null) => ({ msp, bp, minerals: minerals === null ? null : mineralsOf(minerals), unknown })

const SUM = (contributions, field) => (contributions.some((entry) => !isKnown(entry[field])) ? null : contributions.reduce((total, entry) => total + entry[field], 0))

const sumMinerals = (contributions) => Object.fromEntries(MINERALS.map((name) => [name, contributions.some((entry) => entry.minerals === null || entry.minerals[name] === null) ? null : contributions.reduce((total, entry) => total + entry.minerals[name], 0)]))

// The unrounded sum of a design's size contributions, before the add-ons' own sizes and the floor and cap: the game's "Size" line.
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

// A design built by the game's own order of work. `input`:
//   warheadMsp, warheads (the count, 1 or more; each warhead after the first adds 0.1 MSP to the size and to the Tritanium and cost), shipDecoy (whether the decoy tech was held and chosen), decoys (ECM decoys), fuelMsp, activeMsp, thermalMsp, emMsp, geoMsp, sizeLimit (0 for none: the designer's limit on the missile's size, which the save does not store);
//   engine ({ sizeMsp, cost, power, fuelEfficiency } of the engine component; { missing: true, storedMsp } for an engine the design has but the save no longer holds; null for no engine) and engines (the count);
//   stage ({ size, cost, fuelRequired, totalFlightTime, minerals } of the second-stage design, or null) and stages (its count);
//   options { eccm, terminal, retarget, laser } as the values the design stored (`eccm` the ECCM level, `terminal` the guidance multiplier, `retarget` the retargeting level, `laser` whether a laser warhead is fitted);
//   tech { warhead, laserEfficiency, reactor, active, thermal, em, geo } the levels' figures, null where the level is not known.
// Returns { contributions: { name: { msp, bp, minerals, unknown } }, figures }. A figure that depends on an unknown input is null and the contribution that lacks it says why; the size of a contribution can be known while its cost is not (a sensor's MSP is the designer's, its cost needs its tech).
export const buildMissile = (input) => {
  const { warheadMsp, warheads, shipDecoy, decoys, fuelMsp, activeMsp, thermalMsp, emMsp, geoMsp, sizeLimit = 0, engine, engines, stage, stages, options, tech } = input
  const baseDamage = baseWarheadDamage({ warheadMsp, warheadTech: tech.warhead, shipDecoy })
  const strength = warheadStrength({ warheadMsp, warheadTech: tech.warhead, shipDecoy })
  const strengths = [sensorStrength({ sensorMsp: activeMsp, sensorTech: tech.active }), sensorStrength({ sensorMsp: thermalMsp, sensorTech: tech.thermal }), sensorStrength({ sensorMsp: emMsp, sensorTech: tech.em }), sensorStrength({ sensorMsp: geoMsp, sensorTech: tech.geo })]
  const output = reactorOutput(strengths)
  const reactor = reactorMsp({ output, reactorTech: tech.reactor })
  const laserWarhead = options.laser ? laserWarheadStrength({ strength, efficiency: tech.laserEfficiency }) : 0
  const extra = warheads > 1 ? EXTRA_WARHEAD_MSP * (warheads - 1) : 0
  const hasEngine = Boolean(engine) && engines > 0
  const contributions = {}

  if (!hasEngine) {
    contributions.engine = contribution(0, 0, {})
  } else if (engine.missing) {
    contributions.engine = contribution(engine.storedMsp, null, { Boronide: null, Gallicite: null }, 'the engine component the design names is not in the save')
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
    contributions.secondStage = contribution(null, null, null, 'the second stage design is not in the save')
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

  const list = CONTRIBUTIONS.map((name) => contributions[name])
  const sum = SUM(list, 'msp')
  const cost = SUM(list, 'bp')
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

// ---------- the levels a design was made with ----------

// A level held by the race: { id, info, cost } with `cost` its development cost, the order the game picks by.
const byGamePick = (levels) => levels.reduce((best, level) => (!best || level.cost > best.cost ? level : best), null)

// The levels of a line whose figure reproduces what the design stored, the game's pick among them (the one that cost the most to develop) and every one of them. `reproduces(info)` is true when the level, used as the design's, gives the stored figure.
export const matchLevels = (levels, reproduces) => {
  const matches = (levels || []).filter((level) => reproduces(level.info))

  return { matches, level: byGamePick(matches) }
}

const LINE_STATE = Object.freeze({ UNUSED: 'unused', RESOLVED: 'resolved', UNRESOLVED: 'unresolved', UNSUPPORTED: 'unsupported' })

export { LINE_STATE }

// What a comparison rests on: `reproduced` (the figure is rebuilt from inputs the design stores and compared with another stored figure) or `resolved-from-stored` (the technology level behind it was itself picked by matching the stored figure being compared, so agreement says that some held level gives it, not that the rule gives it independently).
export const BASIS = Object.freeze({ REPRODUCED: 'reproduced', RESOLVED: 'resolved-from-stored' })

const line = (state, level, reason, extra = {}) => ({ state, level: level || null, reason: reason || null, ...extra })

// What a stored design says it used, as the options the build takes.
export const optionsOf = (row) => ({ eccm: row.ECCM, terminal: row.ATG, retarget: row.Retargeting, laser: row.LaserWarhead > 0 })

// The stored column each line's level is picked to match, for the unknown-provenance comparison of a line no held level resolves.
const LEVEL_STORED = Object.freeze({ warhead: 'WarheadStrength', shipDecoy: 'ShipDecoy', laserEfficiency: 'LaserWarhead', terminal: 'ATG', retarget: 'Retargeting', eccm: 'ECCM', multipleWarheads: 'MultipleWarheads', emSensitivity: 'EMSensitivity', laserFocus: 'LaserWarheadRangeModifier', missileEcm: 'MissileECM', active: 'SensorStrength', thermal: 'ThermalStrength', em: 'EMStrength', geo: 'Geostrength', reactor: 'MSPReactor' })

// Resolves the technology levels of a design from the levels its race holds (`held`: { [tech type]: [{ id, info, cost }] }). Each line is `unused` (the design does not use it), `resolved` (a held level reproduces the stored figure; `level` is the game's pick among those that do, `matches` all of them, `current` the race's current pick of the line so that a historical level shows), `unresolved` (no held level does: the reason says which stored figure is left unexplained) or `unsupported` (a use the rules do not cover). `tech` is the figures of the resolved levels, null for every other line.
export const resolveLevels = (row, held) => {
  const lines = {}
  const options = optionsOf(row)
  const decoy = row.ShipDecoy === 1
  const radiation = row.RadDamage > 0 && row.WarheadStrength > 0 && !agrees(row.RadDamage, row.WarheadStrength) && !decoy
  const resolveBy = (name, type, used, reproduces, why) => {
    if (!used) {
      lines[name] = line(LINE_STATE.UNUSED)

      return
    }

    const { matches, level } = matchLevels(held[type], reproduces)
    const current = byGamePick(held[type] || [])

    lines[name] = level ? line(LINE_STATE.RESOLVED, level, null, { matches, current, historical: current !== null && current.id !== level.id && current.info !== level.info, basis: BASIS.RESOLVED }) : line(LINE_STATE.UNRESOLVED, null, why, { matches: [], current })
  }

  if (row.GroundShots > 0) {
    lines.warhead = line(LINE_STATE.UNSUPPORTED, null, 'a ground attack pod: its cost and size follow other rules')
  } else if (radiation) {
    lines.warhead = line(LINE_STATE.UNSUPPORTED, null, 'an enhanced radiation warhead: its multiplier is a design choice the rules do not cover')
  } else if (decoy) {
    lines.warhead = line(LINE_STATE.UNUSED)
  } else {
    resolveBy('warhead', TECH.warhead, row.MSPWarhead > 0, (info) => agrees(row.WarheadStrength, warheadStrength({ warheadMsp: row.MSPWarhead, warheadTech: info })), `no held warhead level gives the stored strength ${row.WarheadStrength} from ${row.MSPWarhead} MSP`)
  }

  const strengthOfWarhead = row.WarheadStrength

  resolveBy('laserEfficiency', TECH.laserEfficiency, options.laser, (info) => agrees(row.LaserWarhead, laserWarheadStrength({ strength: strengthOfWarhead, efficiency: info })), `no held laser efficiency level gives the stored laser strength ${row.LaserWarhead} from a warhead of ${strengthOfWarhead}`)
  resolveBy('terminal', TECH.terminal, options.terminal > 1, (info) => agrees(row.ATG, info), `no held terminal guidance level is the stored ${row.ATG}`)
  resolveBy('retarget', TECH.retarget, options.retarget > 0, (info) => Math.trunc(info) === row.Retargeting, `no held retargeting level is the stored ${row.Retargeting}`)
  resolveBy('eccm', TECH.eccm, options.eccm > 0, (info) => Math.trunc(info) === row.ECCM, `no held ECCM level is the stored ${row.ECCM}`)
  resolveBy('multipleWarheads', TECH.multipleWarheads, row.MultipleWarheads > 1, (info) => info > 0, `no held multiple warheads tech level (type ${TECH.multipleWarheads}) is above 0 for the stored ${row.MultipleWarheads} warheads`)
  resolveBy('shipDecoy', TECH.shipDecoy, decoy, (info) => info > 0, `no held ship decoy tech level (type ${TECH.shipDecoy}) is above 0 for the stored ship decoy`)

  // Three levels the design records as they stood and the figures above do not follow from: the EM sensitivity behind the active sensor's range, the laser focus range modifier and the missile ECM level. An unresolved one is unknown provenance, not a difference.
  resolveBy('emSensitivity', TECH.em, row.EMSensitivity > 0, (info) => info === row.EMSensitivity, `no held EM sensitivity level is the recorded ${row.EMSensitivity}`)
  resolveBy('laserFocus', TECH.laserFocus, row.LaserWarheadRangeModifier > 0, (info) => info === row.LaserWarheadRangeModifier, `no held laser focus level is the recorded ${row.LaserWarheadRangeModifier}`)
  resolveBy('missileEcm', TECH.missileEcm, row.MissileECM > 0, (info) => Math.trunc(info) === row.MissileECM, `no held missile ECM level is the recorded ${row.MissileECM}`)

  // A sensor under 0.25 MSP has no strength and needs no tech; the tech of a bigger one is the level whose strength the design stored.
  const sensorLine = (name, type, msp, stored) => resolveBy(name, type, msp >= MIN_SENSOR_MSP, (info) => agrees(stored, sensorStrength({ sensorMsp: msp, sensorTech: info })), `no held level gives the stored ${name} strength ${stored} from ${msp} MSP`)

  sensorLine('active', TECH.active, row.MSPActive, row.SensorStrength)
  sensorLine('thermal', TECH.thermal, row.MSPThermal, row.ThermalStrength)
  sensorLine('em', TECH.em, row.MSPEM, row.EMStrength)
  sensorLine('geo', TECH.geo, row.MSPGeo, row.Geostrength)

  const figuresOf = (name) => (lines[name].state === LINE_STATE.RESOLVED ? lines[name].level.info : null)
  const strengths = [row.MSPActive >= MIN_SENSOR_MSP ? row.SensorStrength : 0, row.MSPThermal >= MIN_SENSOR_MSP ? row.ThermalStrength : 0, row.MSPEM >= MIN_SENSOR_MSP ? row.EMStrength : 0, row.MSPGeo >= MIN_SENSOR_MSP ? row.Geostrength : 0]
  const output = reactorOutput(strengths)

  resolveBy('reactor', TECH.reactor, output > 0, (info) => agrees(row.MSPReactor, reactorMsp({ output, reactorTech: info })), `no held power plant level gives the stored reactor ${row.MSPReactor} MSP for an output of ${output}`)

  const tech = { warhead: figuresOf('warhead'), laserEfficiency: figuresOf('laserEfficiency'), reactor: figuresOf('reactor'), active: figuresOf('active'), thermal: figuresOf('thermal'), em: figuresOf('em'), geo: figuresOf('geo') }

  return { lines, tech }
}

// ---------- the reconciliation of a design with what the save stored ----------

// A fixture is what the save held for a set of designs, as plain data: { levels: { id: { type, info, cost } }, races: { id: { name, held: { type: [level ids] } } }, components: { id: { id, name, size, cost, power, fuelEfficiency, tech1, tech2 } }, designs: [{ id, race, row }] } with `row` the FCT_MissileType columns the rules read.
const levelRecord = (fixture, id) => (fixture.levels[id] ? { id: Number(id), info: fixture.levels[id].info, cost: fixture.levels[id].cost } : null)

// The levels a race holds, by tech type, as resolveLevels reads them.
export const heldLevels = (fixture, race) => {
  const entry = fixture.races[race]
  const held = {}

  for (const [type, ids] of Object.entries(entry ? entry.held : {})) {
    held[type] = ids.map((id) => levelRecord(fixture, id)).filter(Boolean)
  }

  return held
}

const levelsOfType = (fixture, type) => Object.keys(fixture.levels).filter((id) => fixture.levels[id].type === type).map((id) => levelRecord(fixture, id))

// What a comparison says: 'unsupported' when it names a case the rules do not cover (never agreement), 'unknown' when the stored or the computed figure is missing (never zero), else 'agree' or 'differ' at the reproduction tolerance (an 'integer' figure exactly).
export const judge = (comparison) => {
  if (comparison.unsupported) {
    return 'unsupported'
  }

  if (!isKnown(comparison.stored) || !isKnown(comparison.computed)) {
    return 'unknown'
  }

  const same = comparison.kind === 'integer' ? Number(comparison.stored) === Number(comparison.computed) : agrees(Number(comparison.stored), Number(comparison.computed))

  return same ? 'agree' : 'differ'
}

// A pinned difference is a hand-audited discrepancy of one design of one game: `{ game, id, field, stored, computed, reason }`. It explains a difference only while the design's stored and computed figures are the audited ones at the reproduction tolerance, so a changed figure, or another save that reuses the id, is not covered.
const pinned = (audited, found) => agrees(audited, found)

export const knownDifference = (known, game, id, entry) => {
  const row = known.find((candidate) => candidate.game === game && candidate.id === id && candidate.field === entry.field && pinned(candidate.stored, entry.stored) && pinned(candidate.computed, entry.computed))

  return row ? row.reason : null
}

// The verdict of a comparison and, for a difference, the reason it is explained by (its own or a pinned one); a difference with no reason is a mismatch.
export const classify = (known, game, id, entry) => {
  const verdict = judge(entry)

  if (verdict !== 'differ') {
    return { verdict, reason: null }
  }

  return { verdict, reason: entry.explain || knownDifference(known, game, id, entry) }
}

const comparison = (field, scope, stored, computed, kind = 'decimal', extra = {}) => ({ field, scope, stored: isKnown(stored) ? stored : null, computed: isKnown(computed) ? computed : null, kind, basis: BASIS.REPRODUCED, ...extra })

// The missile engine component against the engine the rules design from its two techs and the thrust (the missile's PowerMod; for an engine no design in the set uses, the thrust its stored power implies). The greatest thrust modifier the design had is the held level whose boost reproduces the stored fuel efficiency; none that does leaves the fuel efficiency unknown. `race` is null when the owner is not known, and every max thrust level of the save is then a candidate.
export const reconcileEngine = (fixture, component, { thrust = null, race = null } = {}) => {
  const engineLevel = levelRecord(fixture, component.tech1)
  const fuelLevel = levelRecord(fixture, component.tech2)
  const engineTech = engineLevel ? engineLevel.info : null
  const fuelTech = fuelLevel ? fuelLevel.info : null
  const given = isKnown(thrust) && thrust > 0
  const used = given ? thrust : (isKnown(engineTech) && engineTech > 0 ? thrustOfEngine({ power: component.power, sizeMsp: component.size, engineTech }) : null)
  const candidates = race === null ? levelsOfType(fixture, TECH.maxThrust) : (heldLevels(fixture, race)[TECH.maxThrust] || [])
  const designAt = (maxThrust) => (isKnown(used) && isKnown(engineTech) && isKnown(fuelTech) ? missileEngineDesign({ sizeMsp: component.size, thrust: used, engineTech, fuelTech, maxThrust }) : null)
  const { matches, level } = matchLevels(candidates, (info) => { const design = designAt(info); return design !== null && agrees(component.fuelEfficiency, design.fuelEfficiency) })
  const chosen = !given || matches.length < candidates.length ? BASIS.RESOLVED : BASIS.REPRODUCED
  const design = designAt(level ? level.info : candidates.length ? candidates[0].info : 1)
  const reasonNoTech = !engineLevel ? `the engine tech level ${component.tech1} is not in the save` : !fuelLevel ? `the fuel tech level ${component.tech2} is not in the save` : null
  const comparisons = []

  if (given) {
    comparisons.push(comparison('EnginePower', 'engine', component.power, design ? design.power : null, 'decimal', { reason: reasonNoTech }))
  }

  comparisons.push(comparison('EngineCost', 'engine', component.cost, design ? design.cost : null, 'decimal', { reason: reasonNoTech, basis: given ? BASIS.REPRODUCED : BASIS.RESOLVED }))
  comparisons.push(comparison('FuelEfficiency', 'engine', component.fuelEfficiency, level && design ? design.fuelEfficiency : null, 'decimal', { basis: chosen, reason: reasonNoTech || `no held max thrust level (type ${TECH.maxThrust}) reproduces the stored fuel efficiency at thrust ${isKnown(used) ? Number(used.toPrecision(6)) : 'unknown'}` }))

  return { id: component.id, name: component.name, thrust: used, maxThrust: level, maxThrustMatches: matches, comparisons }
}

const engineOf = (fixture, row) => {
  if (!(row.NumEngines > 0) && !(row.MSPEngine > 0)) {
    return null
  }

  const component = row.EngineID > 0 ? fixture.components[row.EngineID] : null

  if (!component) {
    return row.MSPEngine > 0 ? { missing: true, storedMsp: row.MSPEngine } : null
  }

  return { sizeMsp: component.size, cost: component.cost, power: component.power, fuelEfficiency: component.fuelEfficiency }
}

const sumStored = (row) => (STORED_MINERALS.some((name) => !isKnown(row[name])) ? null : STORED_MINERALS.reduce((total, name) => total + row[name], 0))

// A second stage is another design of the fixture; what its Cost holds beyond its stored minerals is its Corundium (the one mineral with no column), so the stage carries it as such.
const stageOf = (fixture, row) => {
  if (!(row.SecondStageID > 0)) {
    return null
  }

  const stage = fixture.designs.find((design) => design.id === row.SecondStageID)

  if (!stage) {
    return { missing: true }
  }

  const stored = sumStored(stage.row)

  if (stored === null) {
    return { missing: true }
  }

  return { size: stage.row.Size, cost: stage.row.Cost, fuelRequired: stage.row.FuelRequired, totalFlightTime: stage.row.TotalFlightTime, minerals: { ...Object.fromEntries(STORED_MINERALS.map((name) => [name, stage.row[name]])), Corundium: stage.row.Cost - stored } }
}

const inputOf = (row, engine, stage, tech, sizeLimit) => ({ warheadMsp: row.MSPWarhead, warheads: row.MultipleWarheads, shipDecoy: row.ShipDecoy === 1, decoys: row.NumDecoys, fuelMsp: row.MSPFuel, activeMsp: row.MSPActive, thermalMsp: row.MSPThermal, emMsp: row.MSPEM, geoMsp: row.MSPGeo, sizeLimit, engine, engines: row.NumEngines, stage, stages: row.NumSS, options: optionsOf(row), tech })

// One design against its stored row: every figure the rules rebuild from the levels its race holds, each as a comparison { field, scope, stored, computed, kind, reason?, explain?, unsupported? } to pass through `judge`, plus what the rebuild is made of (`lines`: the levels, `ledger`: size, cost and minerals per contribution). `explain` is a reason to give when the comparison differs and the difference is understood; a comparison is never `explain`ed to agree.
export const reconcileMissile = (fixture, design) => {
  const row = design.row
  const { lines, tech } = resolveLevels(row, heldLevels(fixture, design.race))
  const engine = engineOf(fixture, row)
  const stage = stageOf(fixture, row)
  const unwritten = row.MultipleWarheads > 1 && row.MSPMultipleWarheads === 0
  const free = buildMissile(inputOf(row, engine, stage, tech, 0))
  const engineRounding = engine && !engine.missing ? roundHalfEven(engine.sizeMsp * row.NumEngines, 4) - engine.sizeMsp * row.NumEngines : 0
  const excess = isKnown(free.figures.sizeSum) ? free.figures.sizeSum - row.Size : null
  const capped = excess !== null && excess > 0 && !agrees(free.figures.sizeSum, row.Size) ? buildMissile(inputOf(row, engine, stage, tech, row.Size)) : null
  const limited = capped !== null && Math.abs(excess - engineRounding) <= 1e-9 && isKnown(capped.figures.speed) && agrees(row.Speed, capped.figures.speed)
  const built = limited ? capped : free
  const figures = built.figures
  const ground = row.GroundShots > 0
  const warheadUnsupported = lines.warhead.state === LINE_STATE.UNSUPPORTED
  const reasons = [...new Set([...Object.values(lines).filter((entry) => entry.state === LINE_STATE.UNRESOLVED).map((entry) => entry.reason), ...CONTRIBUTIONS.map((name) => built.contributions[name].unknown).filter(Boolean)])]
  const reason = reasons.length ? reasons.join('; ') : null
  const unsupportedBy = lines.warhead.reason
  const comparisons = []
  const add = (field, scope, stored, computed, kind = 'decimal', { explain = null, warheadDependent = false, basis = BASIS.REPRODUCED } = {}) => comparisons.push(comparison(field, scope, stored, computed, kind, { reason, explain, basis, unsupported: ground || (warheadDependent && warheadUnsupported) ? unsupportedBy : null }))
  const basisOf = (name) => (lines[name].state === LINE_STATE.RESOLVED ? BASIS.RESOLVED : BASIS.REPRODUCED)
  const storedPlain = sumStored(row)
  const minerals = figures.minerals
  const dependent = { warheadDependent: true }
  const decoy = row.ShipDecoy === 1

  add('Size', 'size', row.Size, free.figures.size, 'decimal', limited ? { explain: `the stored contributions add up to ${Number(free.figures.sizeSum.toPrecision(10))} MSP, ${Number(excess.toPrecision(4))} over the stored size: exactly the engine's size rounded to 4 decimals in MSPEngine; the game allots the fuel as the remainder of the size the design was made to and caps the size there, and at the stored size the speed reproduces` } : {})
  add('MSPEngine', 'size', row.MSPEngine, engine && engine.missing ? null : built.contributions.engine.msp)

  if (engine && engine.missing) {
    add('EngineComponent', 'engine', row.EngineID, null, 'integer')
  }

  add('MSPReactor', 'size', row.MSPReactor, built.contributions.reactor.msp, 'decimal', { basis: basisOf('reactor') })
  add('MSPDecoys', 'size', row.MSPDecoys, built.contributions.decoys.msp)
  add('MSPMultipleWarheads', 'size', row.MSPMultipleWarheads, built.contributions.extraWarheads.msp, 'decimal', unwritten ? { explain: 'the design stores 0 for the size of the warheads after the first although its cost and Tritanium include 0.1 each, as game 137 of the 2.6 and 2.7.1 saves and game 139 of the 2.7.0 save store it; seen in the modded sample and in game 143 of the 2.7.0 save, where the designs sit at the size floor or at their size limit, which hides whether the size adds it' } : {})
  add('WarheadStrength', 'warhead', row.WarheadStrength, figures.warheadStrength, 'decimal', { warheadDependent: true, basis: basisOf('warhead') })
  add('RadDamage', 'warhead', row.RadDamage, decoy ? 0 : figures.warheadStrength, 'decimal', { warheadDependent: true, basis: basisOf('warhead') })
  add('LaserWarhead', 'warhead', row.LaserWarhead, figures.laserWarhead, 'decimal', { warheadDependent: true, basis: basisOf('laserEfficiency') })

  for (const [field, key] of [['SensorStrength', 'active'], ['ThermalStrength', 'thermal'], ['EMStrength', 'em'], ['Geostrength', 'geo']]) {
    add(field, 'sensor', row[field], figures.strengths[key], 'decimal', { basis: basisOf(key) })
  }

  add('SensorRange', 'sensor', row.SensorRange, row.MSPActive >= MIN_SENSOR_MSP ? activeSensorRange({ strength: figures.strengths.active, emSensitivity: row.EMSensitivity, resolution: row.SensorResolution }) : 0, 'integer')
  add('Cost', 'cost', row.Cost, figures.cost, 'decimal', dependent)

  for (const name of STORED_MINERALS) {
    add(name, 'cost', row[name], minerals[name], 'decimal', dependent)
  }

  add('UnstoredMinerals', 'cost', storedPlain === null ? null : row.Cost - storedPlain, isKnown(minerals.Corundium) && isKnown(minerals.Vendarite) ? minerals.Corundium + minerals.Vendarite : null, 'decimal', dependent)
  add('Speed', 'performance', row.Speed, figures.speed)
  add('Endurance', 'performance', row.Endurance, figures.endurance)
  add('MaxRange', 'performance', row.MaxRange, figures.maxRange)
  add('FuelRequired', 'performance', row.FuelRequired, figures.fuelRequired)
  add('TotalFlightTime', 'performance', row.TotalFlightTime, figures.totalFlightTime)

  for (const [name, entry] of Object.entries(lines)) {
    if (entry.state === LINE_STATE.UNRESOLVED) {
      comparisons.push(comparison(`Level:${name}`, 'level', row[LEVEL_STORED[name]], null, 'decimal', { reason: entry.reason }))
    }
  }

  return { id: design.id, name: row.Name, race: design.race, lines, limited, ledger: built.contributions, figures, comparisons }
}
