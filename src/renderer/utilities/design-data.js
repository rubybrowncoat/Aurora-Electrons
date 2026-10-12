// The race's ship classes and the parts the propulsion planner starts from: the classes with the engines, fuel tanks and jump drives they mount, the stock fuel tanks the race may fit, and the race's own engine designs. Sizes are in hull spaces (HS), power in engine power (EP), fuel in litres, as in design-rules.js.

import { TONS_PER_HS } from './design-rules'

const COMPONENT_ENGINE = 1
const COMPONENT_FUEL_TANK = 3
const COMPONENT_JUMP_DRIVE = 16

const CLASSES_SQL = 'select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, FCT_ShipClass.FuelCapacity, FCT_ShipClass.MaxSpeed, FCT_ShipClass.Commercial, FCT_ShipClass.Cost, FCT_ShipClass.Crew, FCT_ShipClass.Obsolete from FCT_ShipClass where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID order by FCT_ShipClass.ClassName'

const CLASS_PARTS_SQL = `select FCT_ClassComponent.ClassID, FCT_ClassComponent.ComponentID, FCT_ClassComponent.NumComponent, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.ComponentTypeID, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.FuelEfficiency, FCT_ShipDesignComponents.StealthRating, FCT_ShipDesignComponents.EnginePowerMod, FCT_ShipDesignComponents.MilitarySystem, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.Crew, FCT_ShipDesignComponents.HTK, FCT_ShipDesignComponents.ExplosionChance, FCT_ShipDesignComponents.MaxExplosionSize, FCT_ShipDesignComponents.JumpRating, FCT_ShipDesignComponents.JumpDistance from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.GameID = :GameID and FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID and FCT_ShipDesignComponents.ComponentTypeID in (${COMPONENT_ENGINE}, ${COMPONENT_FUEL_TANK}, ${COMPONENT_JUMP_DRIVE})`

const TANKS_SQL = `select FCT_ShipDesignComponents.SDComponentID, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.Crew, FCT_ShipDesignComponents.HTK, FCT_ShipDesignComponents.ComponentValue from FCT_ShipDesignComponents inner join FCT_RaceTech on FCT_RaceTech.TechID = FCT_ShipDesignComponents.SDComponentID and FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID where FCT_ShipDesignComponents.GameID = 0 and FCT_ShipDesignComponents.ComponentTypeID = ${COMPONENT_FUEL_TANK} order by FCT_ShipDesignComponents.Size desc`

const ENGINES_SQL = `select FCT_ShipDesignComponents.SDComponentID, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.FuelEfficiency, FCT_ShipDesignComponents.StealthRating, FCT_ShipDesignComponents.EnginePowerMod, FCT_ShipDesignComponents.MilitarySystem, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.Crew, FCT_ShipDesignComponents.HTK, FCT_ShipDesignComponents.ExplosionChance, FCT_ShipDesignComponents.MaxExplosionSize, FCT_RaceTech.Obsolete from FCT_RaceTech inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_RaceTech.TechID and (FCT_ShipDesignComponents.GameID = FCT_RaceTech.GameID or FCT_ShipDesignComponents.GameID = 0) where FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID and FCT_ShipDesignComponents.ComponentTypeID = ${COMPONENT_ENGINE} order by FCT_ShipDesignComponents.Name`

// An engine as the planner works with it: what `engineDesign` returns, plus the stored name and id. `thermalRating` is the share of the power that shows as heat; `thrust` is the engine's own thrust modifier, which the game stores with the component.
const engineOf = (row) => ({
  id: row.SDComponentID,
  name: row.Name,
  sizeHS: row.Size,
  tons: row.Size * TONS_PER_HS,
  power: row.ComponentValue,
  fuelPerEph: row.FuelEfficiency,
  fuelPerHour: row.ComponentValue * row.FuelEfficiency,
  thrust: row.EnginePowerMod,
  thermalRating: row.StealthRating,
  thermal: row.StealthRating * row.ComponentValue,
  commercial: !row.MilitarySystem,
  cost: row.Cost,
  crew: row.Crew,
  htk: row.HTK,
  explosionChance: row.ExplosionChance,
  maxExplosion: row.MaxExplosionSize,
})

// The race's ship classes.
export const loadClasses = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(CLASSES_SQL, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze({
    id: row.ShipClassID,
    name: row.ClassName,
    sizeHS: row.Size,
    enginePower: row.EnginePower,
    fuelPerEph: row.FuelEfficiency,
    fuel: row.FuelCapacity,
    speed: row.MaxSpeed,
    commercial: Boolean(row.Commercial),
    cost: row.Cost,
    crew: row.Crew,
    obsolete: Boolean(row.Obsolete),
  })))
}

// Every engine, fuel tank and jump drive the race's classes mount, one row per class and component.
export const loadClassParts = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(CLASS_PARTS_SQL, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze({
    classId: row.ClassID,
    typeId: row.ComponentTypeID,
    count: row.NumComponent,
    engine: row.ComponentTypeID === COMPONENT_ENGINE ? Object.freeze(engineOf({ ...row, SDComponentID: row.ComponentID })) : null,
    tank: row.ComponentTypeID === COMPONENT_FUEL_TANK ? Object.freeze({ id: row.ComponentID, name: row.Name, sizeHS: row.Size, litres: row.ComponentValue, cost: row.Cost, crew: row.Crew, htk: row.HTK }) : null,
    drive: row.ComponentTypeID === COMPONENT_JUMP_DRIVE ? Object.freeze({ id: row.ComponentID, name: row.Name, sizeHS: row.Size, capacityHS: row.ComponentValue, squadronSize: row.JumpRating, radius: row.JumpDistance, cost: row.Cost, crew: row.Crew, htk: row.HTK, commercial: !row.MilitarySystem }) : null,
  })))
}

// The stock fuel tanks the race may fit, largest first, as `packTanks` takes them ({ id, name, sizeHS, litres, cost }, with crew and HTK).
export const loadStockTanks = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(TANKS_SQL, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze({ id: row.SDComponentID, name: row.Name, sizeHS: row.Size, litres: row.ComponentValue, cost: row.Cost, crew: row.Crew, htk: row.HTK })))
}

// The engines the race has designed (and the base engines it starts with), marked obsolete when the race has set them aside.
export const loadRaceEngines = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(ENGINES_SQL, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze({ ...engineOf(row), obsolete: Boolean(row.Obsolete) })))
}

const sum = (items, value) => items.reduce((total, item) => total + value(item), 0)

// A class taken apart for the propulsion planner: `hullHS` is what is left of its size without the engines and fuel tanks it mounts (a jump drive stays in it, and `driveHS` says how much of the hull that is), with the `engines` (each with its `count`), the `tanks`, the `fuel` the class stores and the jump `drives` it mounts. `enginePower` and `burnFull` (litres an hour at full power) are summed from the engines' own stored figures, because the class's stored engine power is cut to a whole number. `stored` keeps the class's own figures for comparison.
export const splitClass = (shipClass, parts) => {
  const engines = parts.filter((part) => part.engine).map((part) => ({ ...part.engine, count: part.count }))
  const tanks = parts.filter((part) => part.tank).map((part) => ({ ...part.tank, count: part.count }))
  const drives = parts.filter((part) => part.drive).map((part) => ({ ...part.drive, count: part.count }))
  const engineHS = sum(engines, (engine) => engine.sizeHS * engine.count)
  const tankHS = sum(tanks, (tank) => tank.sizeHS * tank.count)

  return Object.freeze({
    id: shipClass.id,
    name: shipClass.name,
    sizeHS: shipClass.sizeHS,
    hullHS: Math.max(0, shipClass.sizeHS - engineHS - tankHS),
    engines,
    engineCount: sum(engines, (engine) => engine.count),
    enginePower: sum(engines, (engine) => engine.power * engine.count),
    burnFull: sum(engines, (engine) => engine.fuelPerHour * engine.count),
    engineHS,
    tanks,
    tankHS,
    fuel: shipClass.fuel,
    drives,
    driveHS: sum(drives, (drive) => drive.sizeHS * drive.count),
    stored: shipClass,
  })
}

// Every class taken apart, by class id.
export const splitClasses = (classes, classParts) => {
  const partsByClass = {}

  classParts.forEach((part) => (partsByClass[part.classId] = partsByClass[part.classId] || []).push(part))

  return Object.freeze(Object.fromEntries(classes.map((shipClass) => [shipClass.id, splitClass(shipClass, partsByClass[shipClass.id] || [])])))
}
