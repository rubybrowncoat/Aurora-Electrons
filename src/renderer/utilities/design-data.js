// The race's ship classes and the parts the propulsion planner starts from: the classes with the engines, fuel tanks and jump drives they mount, the stock fuel tanks the race may fit, and the race's own engine designs; then the shared component contract every planner builds on (a component record with its quantities, flags and provenance, the loaders that read the race's own components, and additive totals that refuse to mix saves or races). Sizes are in hull spaces (HS), power in engine power (EP), fuel in litres, as in design-rules.js.

import { MIN_SENSOR_MSP, MISSILE_STORED_MINERALS, MSP_PER_HS, TONS_PER_HS, agrees, missileLaserStrength, missileReactorMsp, missileReactorOutput, missileSensorStrength, missileWarheadStrength } from './design-rules'
import { STATUS, combine, envelope, getRule, registerRule, ruleSupports, satisfies, unavailable } from './provenance'
import { loadFormulaVersion } from './capabilities'

const COMPONENT_ENGINE = 1
const COMPONENT_FUEL_TANK = 3
const COMPONENT_JUMP_DRIVE = 16

const CLASSES_SQL = 'select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipClass.EnginePower, FCT_ShipClass.FuelEfficiency, FCT_ShipClass.FuelCapacity, FCT_ShipClass.MaxSpeed, FCT_ShipClass.Commercial, FCT_ShipClass.Cost, FCT_ShipClass.Crew, FCT_ShipClass.Obsolete from FCT_ShipClass where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID order by FCT_ShipClass.ClassName'

const CLASS_PARTS_SQL = `select FCT_ClassComponent.ClassID, FCT_ClassComponent.ComponentID, FCT_ClassComponent.NumComponent, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.ComponentTypeID, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.FuelEfficiency, FCT_ShipDesignComponents.StealthRating, FCT_ShipDesignComponents.EnginePowerMod, FCT_ShipDesignComponents.MilitarySystem, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.Crew, FCT_ShipDesignComponents.HTK, FCT_ShipDesignComponents.ExplosionChance, FCT_ShipDesignComponents.MaxExplosionSize, FCT_ShipDesignComponents.JumpRating, FCT_ShipDesignComponents.JumpDistance from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.GameID = :GameID and FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID and FCT_ShipDesignComponents.ComponentTypeID in (${COMPONENT_ENGINE}, ${COMPONENT_FUEL_TANK}, ${COMPONENT_JUMP_DRIVE})`

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

// The stock fuel tanks the race may fit, largest first, as `packTanks` takes them ({ id, name, sizeHS, litres, cost }, with crew and HTK). Read through the component contract, so a figure the save lacks is null, not 0.
export const loadStockTanks = async (database, context) => tanksOf(await readComponents(database, context, { types: [COMPONENT_FUEL_TANK], scope: 'stock', identify: false }))

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

// The shared component contract. A component is one record whatever its source: read from the save (`imported`), worked out by a registered design rule (`recomputed`) or entered by the player (`manual`). A figure its source does not give is null, which means unknown and never 0, and every answer comes through `quantityOf` or `flagOf` as a provenance result, so an unknown figure is unavailable and cannot satisfy a condition. A record lists the `capabilities` it can speak to: a manual component supplies only the additive figures (size, cost, crew, power demand, minerals), so a sensor range, a weapon figure or a fuel capacity asked of it is unavailable, not 0.

// The size scale of a missile is in MSP; a hull space is this many (the constant of design-rules.js). A component converts between the two only within the family it declares.
export { MSP_PER_HS }

export const COMPONENT_ORIGIN = Object.freeze({ IMPORTED: 'imported', RECOMPUTED: 'recomputed', MANUAL: 'manual' })

const ORIGIN_RULES = Object.freeze({ imported: 'component.imported', recomputed: 'component.recomputed', manual: 'component.manual' })
const TOTALS_RULE = 'component.additiveTotals'

registerRule({
  id: ORIGIN_RULES.imported,
  versions: ['2.7.x'],
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents', 'FCT_RaceTech.TechID = FCT_ShipDesignComponents.SDComponentID'],
  note: 'A component row read as the save stores it, the race\'s own through its research; the meaning of each column is that of the 2.7 schema (docs `components`), so a save that is not 2.7-shaped reads as estimated.',
})

registerRule({
  id: ORIGIN_RULES.recomputed,
  versions: ['2.7.x'],
  verification: 'confirmed',
  structure: ['FCT_TechSystem'],
  note: 'A component whose figures a registered design rule worked out from the race\'s technology rather than read from a stored row; each figure takes the verification of the rule the component names.',
})

registerRule({
  id: ORIGIN_RULES.manual,
  versions: ['x'],
  verification: 'assumed',
  note: 'A part the player describes with additive figures only; nothing is checked against the save.',
  assumptions: ['The figures were entered by the player and are taken as given'],
})

registerRule({
  id: TOTALS_RULE,
  versions: ['x'],
  units: 'HS, t, BP, crew, power',
  verification: 'confirmed',
  note: 'Plain sums of the figures every component carries, each times its count; a sum is as strong as its weakest term and unavailable when any term is unknown or the components do not come from one save and race.',
})

const MINERALS = Object.freeze(['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite'])
const FLAG_COLUMNS = Object.freeze({ military: 'MilitarySystem', shippingLine: 'ShippingLineSystem', noMaintFailure: 'NoMaintFailure', singleSystemOnly: 'SingleSystemOnly', shipyardRepairOnly: 'ShipyardRepairOnly' })
const TECH_COLUMNS = Object.freeze(['BGTech1', 'BGTech2', 'BGTech3', 'BGTech4', 'BGTech5', 'BGTech6', 'BGTech7'])

const definition = (name, label, units, column) => Object.freeze({ name, label, units, column })
const SENSOR_STRENGTH = definition('sensorStrength', 'sensor strength', '', 'ComponentValue')
const ENGINE_POWER = definition('enginePower', 'engine power', 'EP', 'ComponentValue')

// The component types whose stored `ComponentValue` (and companion columns) have a documented meaning, each with the named quantities a record of the type carries and, where the type's stored `Size` is not in hull spaces, its `sizeFamily`. A missile engine stores its size in MSP (2.5 t each, as Designed Tech shows it), every other listed type in hull spaces. A type not listed still loads with its additive figures, in hull spaces, and no typed capability.
export const COMPONENT_TYPES = Object.freeze({
  [COMPONENT_ENGINE]: Object.freeze({ key: 'engine', quantities: [ENGINE_POWER] }),
  2: Object.freeze({ key: 'crewQuarters', quantities: [definition('crewHoused', 'crew housed', 'crew', 'ComponentValue')] }),
  [COMPONENT_FUEL_TANK]: Object.freeze({ key: 'fuelStorage', quantities: [definition('fuelLitres', 'fuel capacity', 'L', 'ComponentValue')] }),
  8: Object.freeze({ key: 'thermalSensor', quantities: [SENSOR_STRENGTH] }),
  [COMPONENT_JUMP_DRIVE]: Object.freeze({ key: 'jumpDrive', quantities: [definition('jumpCapacityHS', 'jump capacity', 'HS', 'ComponentValue'), definition('jumpSquadronSize', 'jump squadron size', '', 'JumpRating'), definition('jumpRadius', 'jump radius', '', 'JumpDistance')] }),
  18: Object.freeze({ key: 'reactor', quantities: [definition('powerOutput', 'power output', '', 'ComponentValue')] }),
  24: Object.freeze({ key: 'activeSensor', quantities: [SENSOR_STRENGTH, definition('sensorRange', 'sensor range', 'km', 'MaxSensorRange'), definition('sensorResolution', 'sensor resolution', '', 'Resolution')] }),
  31: Object.freeze({ key: 'engineering', quantities: [definition('engineeringHS', 'engineering space', 'HS', 'ComponentValue')] }),
  41: Object.freeze({ key: 'emSensor', quantities: [SENSOR_STRENGTH] }),
  47: Object.freeze({ key: 'maintenanceStorage', quantities: [definition('maintenanceMSP', 'maintenance storage', 'MSP', 'ComponentValue')] }),
  56: Object.freeze({ key: 'missileEngine', sizeFamily: 'msp', quantities: [ENGINE_POWER] }),
})

// The baseline parts a planner packs rather than designs: crew quarters, fuel storage, engineering spaces, maintenance storage and the maintenance module.
export const FIXED_PART_TYPES = Object.freeze([2, COMPONENT_FUEL_TANK, 31, 47, 48])

const TYPED_QUANTITIES = Object.freeze(Object.fromEntries(Object.values(COMPONENT_TYPES).flatMap((type) => type.quantities).map((quantity) => [quantity.name, quantity])))
const BASIC_FIELDS = Object.freeze({ cost: definition('cost', 'cost', 'BP', 'Cost'), crew: definition('crew', 'crew', 'crew', 'Crew'), powerDemand: definition('powerDemand', 'power demand', 'power', 'PowerRequirement'), htk: definition('htk', 'hit to kill', 'HTK', 'HTK') })
const ADDITIVE_CAPABILITIES = Object.freeze(['size', 'cost', 'crew', 'powerDemand', 'minerals'])
const MEASURED_CAPABILITIES = Object.freeze([...ADDITIVE_CAPABILITIES, 'htk'])

const numberOf = (value) => (Number.isFinite(value) ? value : null)
const booleanOf = (value) => (value === 1 || value === true ? true : value === 0 || value === false ? false : null)

const givenNumber = (value, name) => {
  if (value === undefined || value === null) {
    return null
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`A component's ${name} is a number of 0 or more, or left out when it is not known`)
  }

  return value
}

// The rule a component's figures are enveloped under: the named design rule for a recomputed component, so its versions, note and standing assumptions travel with each figure, and the origin's own rule otherwise.
const ruleOf = ({ source }) => (source.origin === COMPONENT_ORIGIN.RECOMPUTED ? source.rule : ORIGIN_RULES[source.origin])

// Wraps one figure of a component as a result under its origin's rule: unavailable naming the input when it is unknown, otherwise at the strength the origin allows (assumed for a manual one, the named design rule's for a recomputed one, confirmed for an imported one from a 2.7-shaped save and estimated from any other).
const stated = (component, label, value, units, assumptions = []) => {
  const { source } = component
  const rule = ruleOf(component)
  const input = `${label} of ${component.name}`

  if (value === null || value === undefined) {
    return unavailable({ rule, missing: [input], units })
  }

  const notes = [...assumptions]
  let status = STATUS.ASSUMED

  if (source.origin === COMPONENT_ORIGIN.RECOMPUTED) {
    status = getRule(source.rule).verification
    notes.push(`Worked out by ${source.rule}`)
  } else if (source.origin === COMPONENT_ORIGIN.IMPORTED) {
    status = ruleSupports(rule, source.formulaVersion) === true ? STATUS.CONFIRMED : STATUS.ESTIMATED

    if (status === STATUS.ESTIMATED) {
      notes.push('The save is not shown to be a 2.7 save, so the meaning of the stored figures is not verified for its game version')
    }
  }

  return envelope({ value, status, rule, inputs: { present: [input] }, units, assumptions: notes })
}

const unsupported = (component, label, reason) => unavailable({ rule: ruleOf(component), missing: [`${label} of ${component.name} (${reason})`] })

const SIZE_UNITS = Object.freeze({ sizeHS: 'HS', sizeMSP: 'MSP', tons: 't' })

// The size in one unit. Only the declared family converts: an HS component answers in HS and tons, an MSP one in MSP, HS and tons, and an undeclared one in nothing.
const sizeResult = (component, name) => {
  const { family, value } = component.size
  const units = SIZE_UNITS[name]

  if (family === null) {
    return unsupported(component, 'size', 'its size family, HS or MSP, is not declared')
  }

  if (name === 'sizeMSP' && family !== 'msp') {
    return unsupported(component, 'size in MSP', 'its size is declared in HS and is not converted')
  }

  const converted = family === 'msp' && name !== 'sizeMSP'
  const sizeHS = value === null ? null : family === 'msp' ? value / MSP_PER_HS : value
  const figure = name === 'sizeMSP' ? value : name === 'tons' ? (sizeHS === null ? null : sizeHS * TONS_PER_HS) : sizeHS

  return stated(component, 'size', figure, units, converted ? [`The size is declared in MSP and counted at ${MSP_PER_HS} MSP to the hull space`] : [])
}

const mineralsResult = (component) => {
  const { minerals } = component

  if (minerals === null) {
    return stated(component, 'mineral cost', null, 'units')
  }

  const unknown = MINERALS.filter((mineral) => minerals[mineral] === null)

  return unknown.length ? unavailable({ rule: ruleOf(component), missing: unknown.map((mineral) => `${mineral} of ${component.name}`), units: 'units' }) : stated(component, 'mineral cost', { ...minerals }, 'units')
}

// One quantity of a component as a result: `sizeHS`, `sizeMSP`, `tons`, `cost`, `crew`, `powerDemand`, `htk`, `minerals` (a vector by mineral name) or a typed one of its type (`fuelLitres`, `enginePower`, `sensorRange` and the rest of COMPONENT_TYPES). Unavailable when the figure is unknown or the component does not support it.
export const quantityOf = (component, name) => {
  if (name in SIZE_UNITS) {
    return sizeResult(component, name)
  }

  if (name === 'minerals') {
    return mineralsResult(component)
  }

  const measured = BASIC_FIELDS[name]
  const typed = TYPED_QUANTITIES[name]
  const known = measured || typed

  if (!known) {
    throw new Error(`Unknown component quantity ${name}`)
  }

  if (!component.capabilities.includes(name)) {
    return unsupported(component, known.label, component.source.origin === COMPONENT_ORIGIN.MANUAL ? 'a manual component supplies only additive figures' : 'its component type does not carry it')
  }

  return stated(component, known.label, measured ? component[name] : component.quantities[name], known.units)
}

// One classification flag of a component (`military`, `shippingLine`, `noMaintFailure`, `singleSystemOnly`, `shipyardRepairOnly`) as a result whose value is true or false, unavailable when the flag is unknown.
export const flagOf = (component, name) => {
  if (!(name in FLAG_COLUMNS)) {
    throw new Error(`Unknown component flag ${name}`)
  }

  return stated(component, `${name} flag`, component.flags[name], '')
}

// Whether a component has a flag as expected: true or false, or null when the flag is unknown. A condition passes only on true.
export const meetsFlag = (component, name, expected = true) => satisfies(flagOf(component, name), (value) => value === expected)

// Whether a numeric quantity lies within { min, max } (either may be left out): true or false, or null when the figure is unknown or unsupported. A condition passes only on true.
export const meetsQuantity = (component, name, { min = null, max = null } = {}) => satisfies(quantityOf(component, name), (value) => (min === null || value >= min) && (max === null || value <= max))

const sourceOf = (saveSource, origin, rule, pinned) => Object.freeze({ ...saveSource, origin, rule, pinned })

const PORTABLE_SOURCE = Object.freeze({ gameId: null, raceId: null, campaignId: null, branchId: null, formulaVersion: null, openId: null, fingerprint: null, revision: null, componentState: null })

const buildComponent = ({ id, name, typeId = null, stock = null, family = null, size = null, cost = null, crew = null, powerDemand = null, htk = null, minerals = null, quantities = {}, flags = {}, tech = null, additiveOnly = false }, source) => {
  if (!(typeof id === 'number' || (typeof id === 'string' && id.trim()))) {
    throw new Error('A component needs an id')
  }

  const type = COMPONENT_TYPES[typeId] || null
  const typedNames = additiveOnly || !type ? [] : type.quantities.map((quantity) => quantity.name)

  return Object.freeze({
    id,
    name: typeof name === 'string' && name.trim() ? name : String(id),
    type: Object.freeze({ id: Number.isInteger(typeId) ? typeId : null, key: type ? type.key : null }),
    stock,
    size: Object.freeze({ family, value: size }),
    cost,
    crew,
    powerDemand,
    htk: additiveOnly ? null : htk,
    minerals: minerals && Object.freeze({ ...minerals }),
    quantities: Object.freeze(Object.fromEntries(typedNames.map((typedName) => [typedName, numberOf(quantities[typedName])]))),
    flags: Object.freeze(Object.fromEntries(Object.keys(FLAG_COLUMNS).map((flag) => [flag, flags[flag] === undefined ? null : booleanOf(flags[flag])]))),
    tech: tech && Object.freeze({ ...tech, designedFrom: Object.freeze([...tech.designedFrom]) }),
    capabilities: Object.freeze(additiveOnly ? [...ADDITIVE_CAPABILITIES] : [...MEASURED_CAPABILITIES, ...typedNames]),
    source,
  })
}

const sizeOfSpec = ({ sizeHS, sizeMSP }) => {
  if (sizeHS !== undefined && sizeHS !== null && sizeMSP !== undefined && sizeMSP !== null) {
    throw new Error('A component declares its size in HS or in MSP, not both')
  }

  const hasMsp = sizeMSP !== undefined && sizeMSP !== null
  const hasHs = sizeHS !== undefined && sizeHS !== null

  return { family: hasMsp ? 'msp' : hasHs ? 'hs' : null, size: givenNumber(hasMsp ? sizeMSP : sizeHS, hasMsp ? 'sizeMSP' : 'sizeHS') }
}

const mineralsOfSpec = (minerals) => {
  if (minerals === undefined || minerals === null) {
    return null
  }

  const stray = Object.keys(minerals).filter((mineral) => !MINERALS.includes(mineral))

  if (stray.length) {
    throw new Error(`Unknown mineral ${stray.join(', ')}`)
  }

  return Object.fromEntries(MINERALS.map((mineral) => [mineral, givenNumber(minerals[mineral], mineral)]))
}

const flagsOfSpec = (flags = {}) => {
  const stray = Object.keys(flags).filter((flag) => !(flag in FLAG_COLUMNS))

  if (stray.length) {
    throw new Error(`Unknown component flag ${stray.join(', ')}`)
  }

  return Object.fromEntries(Object.entries(flags).map(([flag, value]) => [flag, value === undefined || value === null ? null : Boolean(value)]))
}

const designedSpec = (spec) => ({ id: spec.id, name: spec.name, typeId: spec.typeId, ...sizeOfSpec(spec), cost: givenNumber(spec.cost, 'cost'), crew: givenNumber(spec.crew, 'crew'), powerDemand: givenNumber(spec.powerDemand, 'powerDemand'), minerals: mineralsOfSpec(spec.minerals), flags: flagsOfSpec(spec.flags) })

// A part the player describes: `{ id, name, typeId?, sizeHS or sizeMSP, cost?, crew?, powerDemand?, minerals?, flags? }` with every figure optional (left out means unknown) and only the additive capabilities. `minerals` names the minerals it uses, and one it leaves out is unknown, so name a mineral with 0 to say it costs none. `source` (a `loadComponentSource` result) pins the part to a save and race; without it the part is portable and joins any set. Returns an assumed record.
export const manualComponent = (spec, source = null) => buildComponent({ ...designedSpec(spec), additiveOnly: true }, sourceOf(source || PORTABLE_SOURCE, COMPONENT_ORIGIN.MANUAL, null, Boolean(source)))

// A part whose figures a registered design rule worked out for the race: the manual fields plus `htk` and the typed `quantities` of its type. `rule` names the rule (`design.engineDesign`), whose verification each figure takes; `source` is the race's `loadComponentSource` result.
export const recomputedComponent = (spec, { rule, source }) => {
  if (!source) {
    throw new Error('A recomputed component needs the source it was worked out for')
  }

  if (!getRule(rule)) {
    throw new Error(`Rule ${rule} is not registered`)
  }

  return buildComponent({ ...designedSpec(spec), htk: givenNumber(spec.htk, 'htk'), quantities: spec.quantities || {} }, sourceOf(source, COMPONENT_ORIGIN.RECOMPUTED, rule, true))
}

const importedComponent = (row, source) => {
  const type = COMPONENT_TYPES[row.ComponentTypeID]

  return buildComponent({
    id: row.SDComponentID,
    name: row.Name,
    typeId: row.ComponentTypeID,
    stock: row.GameID === 0,
    family: type && type.sizeFamily ? type.sizeFamily : 'hs',
    size: numberOf(row.Size),
    cost: numberOf(row.Cost),
    crew: numberOf(row.Crew),
    powerDemand: numberOf(row.PowerRequirement),
    htk: numberOf(row.HTK),
    minerals: Object.fromEntries(MINERALS.map((mineral) => [mineral, numberOf(row[mineral])])),
    quantities: Object.fromEntries((type ? type.quantities : []).map((quantity) => [quantity.name, row[quantity.column]])),
    flags: Object.fromEntries(Object.entries(FLAG_COLUMNS).map(([flag, column]) => [flag, booleanOf(row[column])])),
    tech: { id: row.SDComponentID, obsolete: booleanOf(row.Obsolete), designedFrom: TECH_COLUMNS.map((column) => row[column]).filter((value) => Number.isFinite(value) && value > 0) },
  }, sourceOf(source, COMPONENT_ORIGIN.IMPORTED, null, true))
}

const ANCHOR_SQL = 'select SystemID, SystemNumber, round(Age, 4) as Age, AbundanceModifier, Stars, DustDensity, SystemTypeID from FCT_System where GameID = :GameID and SolSystem = 0 order by SystemID limit 16'
const LEDGER_SQL = 'select count(*) as Increments, max(IncrementID) as TipID from FCT_Increments where GameID = :GameID'
const LEDGER_TEXT_SQL = "select group_concat(Pair, ',') as Ledger from (select IncrementID || ':' || GameTime as Pair from FCT_Increments where GameID = :GameID order by IncrementID)"
const TIP_SQL = 'select GameTime from FCT_Increments where IncrementID = :TipID'
const GAME_TIME_SQL = 'select GameTime from FCT_Game where GameID = :GameID'
const ANCHOR_COLUMNS = Object.freeze(['SystemID', 'SystemNumber', 'Age', 'AbundanceModifier', 'Stars', 'DustDensity', 'SystemTypeID'])
const MIN_COMMON_SYSTEMS = 8

const openIds = new WeakMap()
let openCount = 0

const openIdOf = (database) => {
  if (!openIds.has(database)) {
    openIds.set(database, ++openCount)
  }

  return openIds.get(database)
}

// A digest of a text: two 64-bit mixing passes with different seeds, as 32 hex digits. It is evidence that two texts are equal, so that a changed ledger or component row shows, and it is not a security hash.
const digestLane = (text, seed) => {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)

    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`
}

const digestOf = (text) => `${digestLane(text, 0)}${digestLane(text, 0x9e3779b9)}${text.length.toString(16)}`

const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

const hasAll = (columns, names) => names.every((name) => columns.has(name))

const loadFingerprint = async (database, GameID) => {
  const systemColumns = await columnsOf(database, 'FCT_System')

  if (!hasAll(systemColumns, [...ANCHOR_COLUMNS, 'GameID', 'SolSystem'])) {
    return null
  }

  const [rows] = await database.query(ANCHOR_SQL, { replacements: { GameID } })

  return Object.freeze(rows.map((row) => Object.freeze({ ...row })))
}

const loadRevision = async (database, GameID) => {
  const [gameColumns, incrementColumns] = await Promise.all([columnsOf(database, 'FCT_Game'), columnsOf(database, 'FCT_Increments')])
  let gameTime = null
  let increments = null
  let tipIncrementId = null
  let tipGameTime = null
  let ledgerDigest = null

  if (hasAll(gameColumns, ['GameID', 'GameTime'])) {
    const [[game]] = await database.query(GAME_TIME_SQL, { replacements: { GameID } })

    gameTime = game ? numberOf(game.GameTime) : null
  }

  if (hasAll(incrementColumns, ['IncrementID', 'GameID', 'GameTime'])) {
    const [[ledger]] = await database.query(LEDGER_SQL, { replacements: { GameID } })

    increments = ledger ? numberOf(ledger.Increments) : null
    tipIncrementId = ledger ? numberOf(ledger.TipID) : null

    if (tipIncrementId !== null) {
      const [[tip]] = await database.query(TIP_SQL, { replacements: { TipID: tipIncrementId } })

      tipGameTime = tip ? numberOf(tip.GameTime) : null
    }

    const [[ledgerText]] = await database.query(LEDGER_TEXT_SQL, { replacements: { GameID } })

    ledgerDigest = ledgerText && typeof ledgerText.Ledger === 'string' ? digestOf(ledgerText.Ledger) : null
  }

  return Object.freeze({ gameTime, increments, tipIncrementId, tipGameTime, ledgerDigest })
}

// What a component read from an opened save is tied to, so components of different saves, races or revisions are never combined without notice: `gameId`, `raceId`, the `formulaVersion` the save's schema stands for (`loadFormulaVersion`, null when it is not 2.7-shaped), `openId` (the opened copy of the save, which lasts as long as the database object), the `fingerprint` that tells campaigns apart without any app state (the lowest-numbered systems other than the home system, as the campaign-identity evidence describes), the `revision` of the save (game time, the number of increments in the game's ledger, its last one and a digest of the whole ledger, `ledgerDigest`) and `componentState`, a digest of every component row the race holds (all columns, with its research flags), which tells two opens at one point of the ledger apart when a component was edited without the game time moving. `campaignId` and `branchId` stay null until the campaign store supplies them. A part the save cannot give is null.
export const loadComponentSource = async (database, { GameID, RaceID }, { campaignId = null, branchId = null } = {}) => {
  const [formulaVersion, fingerprint, revision, componentState] = await Promise.all([loadFormulaVersion(database), loadFingerprint(database, GameID), loadRevision(database, GameID), loadComponentState(database, GameID, RaceID)])

  return Object.freeze({ gameId: GameID, raceId: RaceID, campaignId, branchId, formulaVersion, openId: openIdOf(database), fingerprint, revision, componentState })
}

// Whether two fingerprints are of one campaign: 'same' (every system they share agrees, and they share at least as many as it takes to tell), 'different' (a shared system disagrees) or 'insufficient' (too few shared systems, as in a template or a new game, or a fingerprint the save could not give).
export const relateFingerprints = (a, b) => {
  if (!a || !b) {
    return 'insufficient'
  }

  const known = new Map(a.map((system) => [system.SystemID, system]))
  const shared = b.filter((system) => known.has(system.SystemID))

  if (shared.some((system) => ANCHOR_COLUMNS.some((column) => known.get(system.SystemID)[column] !== system[column]))) {
    return 'different'
  }

  return shared.length >= MIN_COMMON_SYSTEMS ? 'same' : 'insufficient'
}

const REVISION_FIELDS = Object.freeze(['gameTime', 'increments', 'tipIncrementId', 'tipGameTime', 'ledgerDigest'])

// Whether two revisions are one point of a save: true, false, or null when either lacks a figure. The ledger digest covers every increment, so ledgers that agree in count, tip and game time but not in the middle are different.
const sameRevision = (a, b) => (!a || !b || REVISION_FIELDS.some((field) => a[field] === null || b[field] === null) ? null : REVISION_FIELDS.every((field) => a[field] === b[field]))

// How two component sources relate, for the rule that nothing combines silently: 'same', 'other-race', 'other-save' (another game, another campaign or a fingerprint that differs), 'other-revision' (one campaign at another point of its ledger, or at the same point with different component rows) or 'unknown-save' (the fingerprints, the ledger or the component rows cannot tell, as for a template, a new game or a save that lacks a table, and the sources are not the same opened copy). One opened copy of one game is the same save; two opened copies are the same only when their fingerprints agree, their ledgers are equal in digest and their component rows are equal in digest.
export const compareSources = (a, b) => {
  if (a.raceId !== b.raceId) {
    return 'other-race'
  }

  if (a.gameId !== b.gameId || (a.campaignId !== null && b.campaignId !== null && a.campaignId !== b.campaignId)) {
    return 'other-save'
  }

  if (a.branchId !== null && b.branchId !== null && a.branchId !== b.branchId) {
    return 'other-revision'
  }

  if (a.openId !== null && a.openId === b.openId) {
    return 'same'
  }

  const relation = relateFingerprints(a.fingerprint, b.fingerprint)

  if (relation === 'different') {
    return 'other-save'
  }

  if (relation === 'insufficient') {
    return 'unknown-save'
  }

  const revision = sameRevision(a.revision, b.revision)

  if (revision === null) {
    return 'unknown-save'
  }

  if (revision === false) {
    return 'other-revision'
  }

  if (!a.componentState || !b.componentState) {
    return 'unknown-save'
  }

  return a.componentState === b.componentState ? 'same' : 'other-revision'
}

const COMPONENT_TABLE = 'FCT_ShipDesignComponents'
const RACE_TECH_TABLE = 'FCT_RaceTech'
const REQUIRED_COMPONENT_COLUMNS = Object.freeze(['SDComponentID', 'GameID', 'Name', 'ComponentTypeID', 'Size', 'Cost'])
const REQUIRED_RACE_TECH_COLUMNS = Object.freeze(['GameID', 'TechID', 'RaceID'])
const OPTIONAL_COMPONENT_COLUMNS = Object.freeze([...new Set(['Crew', 'PowerRequirement', 'HTK', ...MINERALS, ...Object.values(FLAG_COLUMNS), ...TECH_COLUMNS, ...Object.values(TYPED_QUANTITIES).map((quantity) => quantity.column)])])

const missingColumns = (componentColumns, raceTechColumns) => [...REQUIRED_COMPONENT_COLUMNS.filter((column) => !componentColumns.has(column)).map((column) => `${COMPONENT_TABLE}.${column}`), ...REQUIRED_RACE_TECH_COLUMNS.filter((column) => !raceTechColumns.has(column)).map((column) => `${RACE_TECH_TABLE}.${column}`)]

const componentsSql = (componentColumns, raceTechColumns, types, scope) => {
  const missing = missingColumns(componentColumns, raceTechColumns)

  if (missing.length) {
    throw new Error(`The save lacks ${missing.join(', ')}, which the component read needs`)
  }

  const selected = [...REQUIRED_COMPONENT_COLUMNS, ...OPTIONAL_COMPONENT_COLUMNS].map((column) => (componentColumns.has(column) ? `c.${column} as ${column}` : `null as ${column}`))
  const obsolete = raceTechColumns.has('Obsolete') ? 't.Obsolete as Obsolete' : 'null as Obsolete'
  const typeTest = types ? ` and c.ComponentTypeID in (${types.join(', ')})` : ''
  const scopeTest = scope === 'stock' ? 'c.GameID = 0' : '(c.GameID = 0 or c.GameID = :GameID)'

  return `select ${selected.join(', ')}, ${obsolete} from FCT_RaceTech t inner join FCT_ShipDesignComponents c on c.SDComponentID = t.TechID and ${scopeTest} where t.GameID = :GameID and t.RaceID = :RaceID${typeTest} order by c.ComponentTypeID, c.Name, c.SDComponentID`
}

// A digest of every component row the race holds, as the unfiltered read returns them, or null when the save lacks a table or column the read needs.
const loadComponentState = async (database, GameID, RaceID) => {
  const [componentColumns, raceTechColumns] = await Promise.all([columnsOf(database, COMPONENT_TABLE), columnsOf(database, RACE_TECH_TABLE)])

  if (missingColumns(componentColumns, raceTechColumns).length) {
    return null
  }

  const [rows] = await database.query(componentsSql(componentColumns, raceTechColumns, null, 'any'), { replacements: { GameID, RaceID } })

  return digestOf(JSON.stringify(rows.map((row) => Object.values(row))))
}

// `identify: false` skips the save's identity (fingerprint and revision), for a caller that keeps only plain figures and never the component records.
const readComponents = async (database, { GameID, RaceID }, { types = null, scope = 'any', source = null, identify = true }) => {
  if (types && !types.every((type) => Number.isInteger(type))) {
    throw new Error('Component types are whole numbers')
  }

  if (types && !types.length) {
    return Object.freeze([])
  }

  if (scope !== 'any' && scope !== 'stock') {
    throw new Error(`Unknown component scope ${scope}; choose any or stock`)
  }

  if (source && (source.gameId !== GameID || source.raceId !== RaceID)) {
    throw new Error('The source belongs to another game or race than the one being read')
  }

  if (source && source.openId !== openIdOf(database)) {
    throw new Error('The source was read from another opened copy of the save, so it does not describe this one; load a new one with loadComponentSource')
  }

  const saveSource = source || (identify ? loadComponentSource(database, { GameID, RaceID }) : { ...PORTABLE_SOURCE, gameId: GameID, raceId: RaceID })
  const [componentColumns, raceTechColumns, resolvedSource] = await Promise.all([columnsOf(database, COMPONENT_TABLE), columnsOf(database, RACE_TECH_TABLE), saveSource])
  const [rows] = await database.query(componentsSql(componentColumns, raceTechColumns, types, scope), { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => importedComponent(row, resolvedSource)))
}

// Every component the race has researched (FCT_RaceTech TechID = SDComponentID), frozen records ordered by type then name: the stock rows (game 0) the race holds and the rows its own game made. `types` limits it to component type ids, `scope: 'stock'` to the stock rows, and `source` is a `loadComponentSource` result to share between loads.
export const loadOwnComponents = (database, context, options = {}) => readComponents(database, context, options)

// The fixed parts the race has researched, which are stock rows by definition: crew quarters, fuel storage, engineering, maintenance storage and the maintenance module (`types` narrows it to some of them). A save may change their capacities and costs, so the rows are read from the open save, never assumed.
export const loadFixedParts = async (database, context, { types = FIXED_PART_TYPES, source = null } = {}) => {
  const stray = types.filter((type) => !FIXED_PART_TYPES.includes(type))

  if (stray.length) {
    throw new Error(`Type ${stray.join(', ')} is not a fixed part`)
  }

  return readComponents(database, context, { types, scope: 'stock', source })
}

// A fuel tank as `packTanks` takes it, from a component: a figure the save lacks is null, which `packTanks` leaves out rather than counting as nothing.
const tankOf = (component) => Object.freeze({ id: component.id, name: component.name, sizeHS: component.size.family === 'hs' ? component.size.value : null, litres: component.quantities.fuelLitres === undefined ? null : component.quantities.fuelLitres, cost: component.cost, crew: component.crew, htk: component.htk })

const byLargest = (a, b) => (a.sizeHS === null) - (b.sizeHS === null) || b.sizeHS - a.sizeHS || a.id - b.id

const tanksOf = (components) => Object.freeze(components.map(tankOf).sort(byLargest))

// The race's fuel tanks as tank records ({ id, name, sizeHS, litres, cost, crew, htk } plus `stock` and the `component` it came from), largest first, for the stock and the modded catalogue alike: every tank the race has researched, or with `scope: 'stock'` the stock rows only.
export const loadFuelTanks = async (database, context, { scope = 'any', source = null } = {}) => {
  const components = await readComponents(database, context, { types: [COMPONENT_FUEL_TANK], scope, source })

  return Object.freeze(components.map((component) => Object.freeze({ ...tankOf(component), stock: component.stock, component })).sort(byLargest))
}

const CONFLICT_TEXT = Object.freeze({
  'other-race': 'belong to different races',
  'other-save': 'come from different saves',
  'other-revision': 'come from different revisions of one save, or from one point of it with different component rows',
  'unknown-save': 'are not shown to come from the same save',
})

const describeConflict = ({ a, b, reason }) => `${a.name} (${a.id}) and ${b.name} (${b.id}) ${CONFLICT_TEXT[reason]}`

const SOURCE_FIELDS = Object.freeze(['gameId', 'raceId', 'campaignId', 'branchId', 'openId', 'fingerprint', 'revision', 'componentState'])

// Whether two sources are one and the same read of a save (every component of one `loadComponentSource` result shares its fingerprint and revision), so a set of hundreds of components is compared once per source and not once per component.
const sameSource = (a, b) => SOURCE_FIELDS.every((field) => a[field] === b[field])

// The pairs that must not be combined: the sources of the components bound to a save and race are all compared with one another, so the verdict does not depend on the order of the set (a source that names no campaign is compared with each campaign, but two campaigns are compared with each other). A portable manual part joins any set. A pair is named by the first component of each source.
const scopeConflicts = (components) => {
  const bound = []

  components.filter((component) => component.source.pinned).forEach((component) => {
    if (!bound.some((known) => sameSource(known.source, component.source))) {
      bound.push(component)
    }
  })

  return bound.flatMap((a, index) => bound.slice(index + 1).map((b) => ({ a, b, reason: compareSources(a.source, b.source) }))).filter(({ reason }) => reason !== 'same').map(({ a, b, reason }) => Object.freeze({ a: Object.freeze({ id: a.id, name: a.name }), b: Object.freeze({ id: b.id, name: b.name }), reason }))
}

const totalOf = (items, conflicts, name, units, start, add) => {
  if (conflicts.length) {
    return unavailable({ rule: TOTALS_RULE, missing: conflicts.map(describeConflict), units })
  }

  const labels = items.map(({ component }, index) => `${index + 1}. ${component.name}`)

  return combine({ rule: TOTALS_RULE, parts: Object.fromEntries(items.map(({ component }, index) => [labels[index], quantityOf(component, name)])), compute: (values) => items.reduce((total, { count }, index) => add(total, values[labels[index]], count), start()), units })
}

const addScalar = (total, value, count) => total + value * count
const addMinerals = (total, vector, count) => Object.fromEntries(MINERALS.map((mineral) => [mineral, total[mineral] + vector[mineral] * count]))

// The basic totals of a set of components, `[{ component, count }]`: `results` has an envelope each for `sizeHS`, `tons`, `cost`, `crew`, `powerDemand` and `minerals`, so one unknown cost leaves the size total standing. Components bound to different races or saves (or to revisions of one save) do not combine: every total is then unavailable and `conflicts` names the pairs. `components` keeps what each term was, with its origin, stock mark and source revision, so a total built from imported and manual parts still shows which was which.
export const componentTotals = (entries) => {
  const items = entries.map(({ component, count }) => {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`The count of ${component.name} is a whole number of 0 or more`)
    }

    return { component, count }
  })

  const conflicts = scopeConflicts(items.map(({ component }) => component))
  const mineralsStart = () => Object.fromEntries(MINERALS.map((mineral) => [mineral, 0]))

  return Object.freeze({
    count: items.reduce((total, { count }) => total + count, 0),
    results: Object.freeze({
      sizeHS: totalOf(items, conflicts, 'sizeHS', 'HS', () => 0, addScalar),
      tons: totalOf(items, conflicts, 'tons', 't', () => 0, addScalar),
      cost: totalOf(items, conflicts, 'cost', 'BP', () => 0, addScalar),
      crew: totalOf(items, conflicts, 'crew', 'crew', () => 0, addScalar),
      powerDemand: totalOf(items, conflicts, 'powerDemand', 'power', () => 0, addScalar),
      minerals: totalOf(items, conflicts, 'minerals', 'units', mineralsStart, addMinerals),
    }),
    components: Object.freeze(items.map(({ component, count }) => Object.freeze({ id: component.id, name: component.name, typeId: component.type.id, origin: component.source.origin, rule: component.source.rule, stock: component.stock, count, capabilities: component.capabilities, gameId: component.source.gameId, raceId: component.source.raceId, campaignId: component.source.campaignId, branchId: component.source.branchId, formulaVersion: component.source.formulaVersion, revision: component.source.revision }))),
    conflicts: Object.freeze(conflicts),
  })
}

// ---------- missile designs ----------

// The tech types a missile design reads, as the save numbers them: warhead 12, thermal 19, active 20, engine 40, power plant 41, fuel 65, ECCM 83, geo 89, EM 125, max thrust 130, radiation 163, laser efficiency 274, terminal guidance 275, retargeting 276, laser focus 277, missile ECM 279, multiple warheads 280 and ship decoy 281.
export const MISSILE_TECH = Object.freeze({ warhead: 12, thermal: 19, active: 20, reactor: 41, eccm: 83, geo: 89, em: 125, maxThrust: 130, radiation: 163, laserEfficiency: 274, terminal: 275, retarget: 276, laserFocus: 277, missileEcm: 279, multipleWarheads: 280, shipDecoy: 281, engine: 40, fuel: 65 })
export const MISSILE_TECH_TYPES = Object.freeze(Object.values(MISSILE_TECH).sort((a, b) => a - b))

// The columns of FCT_MissileType the missile rules read.
export const MISSILE_COLUMNS = Object.freeze(['Name', 'EngineID', 'NumEngines', 'Cost', 'Size', 'Speed', 'RadDamage', 'FuelRequired', 'Endurance', 'MaxRange', 'WarheadStrength', 'SensorStrength', 'SensorResolution', 'SensorRange', 'ThermalStrength', 'EMStrength', 'Geostrength', 'TotalFlightTime', 'SecondStageID', 'NumSS', 'Corbomite', 'Tritanium', 'Boronide', 'Uridium', 'Gallicite', 'MSPReactor', 'MSPWarhead', 'MSPEngine', 'MSPFuel', 'MSPActive', 'MSPThermal', 'MSPEM', 'MSPGeo', 'ECCM', 'EMSensitivity', 'GroundShots', 'PowerMod', 'ATG', 'Retargeting', 'LaserWarhead', 'LaserWarheadRangeModifier', 'NumDecoys', 'MSPDecoys', 'MissileECM', 'MultipleWarheads', 'MSPMultipleWarheads', 'ShipDecoy'])

const MISSILES_SQL = `select FCT_MissileType.MissileID, ${MISSILE_COLUMNS.map((column) => `FCT_MissileType.${column}`).join(', ')}, FCT_TechSystem.RaceID as OwnerID from FCT_MissileType left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_MissileType.MissileID and FCT_TechSystem.TechTypeID = 122 where FCT_MissileType.GameID = :game`

// A missile has no owner column: the race that researched it is the RaceID of its FCT_TechSystem row (tech type 122, TechSystemID = MissileID), the row the Designed Tech page joins. `race` null reads every design of the game.
export const ownedMissiles = async (database, game, race = null) => {
  const [rows] = race === null ? await database.query(`${MISSILES_SQL} order by FCT_MissileType.MissileID`, { replacements: { game } }) : await database.query(`${MISSILES_SQL} and FCT_TechSystem.RaceID = :race order by FCT_MissileType.MissileID`, { replacements: { game, race } })

  return rows
}

const missileDesign = (row, stageOnly) => ({ id: row.MissileID, race: row.OwnerID === undefined ? null : row.OwnerID, row: Object.fromEntries(MISSILE_COLUMNS.map((column) => [column, row[column]])), ...(stageOnly ? { stageOnly: true } : {}) })

// The fixture a set of designs needs, as plain data: `{ game, levels: { id: { type, info, cost } }, races: { id: { name, held: { type: [level ids] } } }, components: { id: { id, name, size, cost, power, fuelEfficiency, tech1, tech2 } }, designs: [{ id, race, row, stageOnly? }] }` with `row` the FCT_MissileType columns the rules read. The designs are `owned` (rows of `ownedMissiles`) and the second stages they name (`stageOnly`), the levels of the missile tech types each owner holds and the engine components with their two techs.
export const loadMissileFixture = async (database, game, owned) => {
  const designs = new Map(owned.map((row) => [row.MissileID, missileDesign(row, false)]))
  const pending = [...owned]

  while (pending.length) {
    const stageId = pending.pop().SecondStageID

    if (stageId > 0 && !designs.has(stageId)) {
      const [[stage]] = await database.query(`${MISSILES_SQL} and FCT_MissileType.MissileID = :id`, { replacements: { game, id: stageId } })

      if (stage) {
        designs.set(stageId, missileDesign(stage, true))
        pending.push(stage)
      }
    }
  }

  const levels = {}
  const races = {}
  const levelOf = (row) => {
    levels[row.id] = { type: row.type, info: row.info, cost: row.cost }
  }
  const raceIds = [...new Set([...designs.values()].map((design) => design.race).filter((race) => race !== null))]

  for (const raceId of raceIds) {
    const [[race]] = await database.query('select FCT_Race.RaceName from FCT_Race where FCT_Race.GameID = :game and FCT_Race.RaceID = :race', { replacements: { game, race: raceId } })
    const [held] = await database.query(`select FCT_TechSystem.TechSystemID as id, FCT_TechSystem.TechTypeID as type, FCT_TechSystem.AdditionalInfo as info, FCT_TechSystem.DevelopCost as cost from FCT_RaceTech inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID where FCT_RaceTech.GameID = :game and FCT_RaceTech.RaceID = :race and FCT_TechSystem.TechTypeID in (${MISSILE_TECH_TYPES.join(',')}) order by FCT_TechSystem.TechSystemID`, { replacements: { game, race: raceId } })

    held.forEach(levelOf)
    races[raceId] = { name: race ? race.RaceName : null, held: Object.fromEntries([...new Set(held.map((row) => row.type))].map((type) => [type, held.filter((row) => row.type === type).map((row) => row.id)])) }
  }

  const engineIds = [...new Set([...designs.values()].map((design) => design.row.EngineID).filter((id) => id > 0))].map(Number)
  const components = {}

  if (engineIds.length) {
    const [rows] = await database.query(`select FCT_ShipDesignComponents.SDComponentID, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.Cost, FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.FuelEfficiency, FCT_ShipDesignComponents.BGTech1, FCT_ShipDesignComponents.BGTech2 from FCT_ShipDesignComponents where FCT_ShipDesignComponents.GameID = :game and FCT_ShipDesignComponents.SDComponentID in (${engineIds.join(',')})`, { replacements: { game } })

    for (const row of rows) {
      components[row.SDComponentID] = { id: row.SDComponentID, name: row.Name, size: row.Size, cost: row.Cost, power: row.ComponentValue, fuelEfficiency: row.FuelEfficiency, tech1: row.BGTech1, tech2: row.BGTech2 }
    }

    const techIds = [...new Set(rows.flatMap((row) => [row.BGTech1, row.BGTech2]).filter((id) => id > 0))].map(Number)

    if (techIds.length) {
      const [techs] = await database.query(`select FCT_TechSystem.TechSystemID as id, FCT_TechSystem.TechTypeID as type, FCT_TechSystem.AdditionalInfo as info, FCT_TechSystem.DevelopCost as cost from FCT_TechSystem where FCT_TechSystem.TechSystemID in (${techIds.join(',')})`, { replacements: {} })

      techs.forEach(levelOf)
    }
  }

  return { game, levels, races, components, designs: [...designs.values()] }
}

// A level held by the race: { id, info, cost } with `cost` its development cost, the order the game picks by.
const byGamePick = (levels) => levels.reduce((best, level) => (!best || level.cost > best.cost ? level : best), null)

// The levels of a line whose figure reproduces what the design stored, the game's pick among them (the one that cost the most to develop) and every one of them. `reproduces(info)` is true when the level, used as the design's, gives the stored figure.
export const matchLevels = (levels, reproduces) => {
  const matches = (levels || []).filter((level) => reproduces(level.info))

  return { matches, level: byGamePick(matches) }
}

export const missileLevelRecord = (fixture, id) => (fixture.levels[id] ? { id: Number(id), info: fixture.levels[id].info, cost: fixture.levels[id].cost } : null)

// The levels a race holds, by tech type, as resolveMissileLevels reads them.
export const heldMissileLevels = (fixture, race) => {
  const entry = fixture.races[race]
  const held = {}

  for (const [type, ids] of Object.entries(entry ? entry.held : {})) {
    held[type] = ids.map((id) => missileLevelRecord(fixture, id)).filter(Boolean)
  }

  return held
}

export const missileLevelsOfType = (fixture, type) => Object.keys(fixture.levels).filter((id) => fixture.levels[id].type === type).map((id) => missileLevelRecord(fixture, id))

export const LINE_STATE = Object.freeze({ UNUSED: 'unused', RESOLVED: 'resolved', UNRESOLVED: 'unresolved', UNSUPPORTED: 'unsupported' })

const line = (state, level, reason, extra = {}) => ({ state, level: level || null, reason: reason || null, ...extra })

// What a stored design says it used, as the options a candidate takes.
export const missileOptionsOf = (row) => ({ eccm: row.ECCM, terminal: row.ATG, retarget: row.Retargeting, laser: row.LaserWarhead > 0 })

// Whether a stored design has a warhead whose radiation damage differs from its strength: an enhanced radiation warhead, the multiplier of which is a design choice the rules do not cover.
const hasEnhancedRadiation = (row) => row.RadDamage > 0 && row.WarheadStrength > 0 && !agrees(row.RadDamage, row.WarheadStrength) && row.ShipDecoy !== 1

// Resolves the technology levels of a design from the levels its race holds (`held`: { [tech type]: [{ id, info, cost }] }). Each line is `unused` (the design does not use it), `resolved` (a held level reproduces the stored figure; `level` is the game's pick among those that do, `matches` all of them, `current` the race's current pick of the line so that a historical level shows), `unresolved` (no held level does: the reason says which stored figure is left unexplained) or `unsupported` (a use the rules do not cover). `tech` is the figures of the resolved levels, null for every other line. A resolved level is the one the stored figure picks, so the level agrees with the figure by construction: it is an estimate of the tech, not an independent reading of it.
export const resolveMissileLevels = (row, held) => {
  const lines = {}
  const options = missileOptionsOf(row)
  const decoy = row.ShipDecoy === 1
  const resolveBy = (name, type, used, reproduces, why) => {
    if (!used) {
      lines[name] = line(LINE_STATE.UNUSED)

      return
    }

    const { matches, level } = matchLevels(held[type], reproduces)
    const current = byGamePick(held[type] || [])

    lines[name] = level ? line(LINE_STATE.RESOLVED, level, null, { matches, current, historical: current !== null && current.id !== level.id && current.info !== level.info }) : line(LINE_STATE.UNRESOLVED, null, why, { matches: [], current })
  }

  if (row.GroundShots > 0) {
    lines.warhead = line(LINE_STATE.UNSUPPORTED, null, 'a ground attack pod: its cost and size follow other rules')
  } else if (hasEnhancedRadiation(row)) {
    lines.warhead = line(LINE_STATE.UNSUPPORTED, null, 'an enhanced radiation warhead: its multiplier is a design choice the rules do not cover')
  } else if (decoy) {
    lines.warhead = line(LINE_STATE.UNUSED)
  } else {
    resolveBy('warhead', MISSILE_TECH.warhead, row.MSPWarhead > 0, (info) => agrees(row.WarheadStrength, missileWarheadStrength({ warheadMsp: row.MSPWarhead, warheadTech: info })), `no held warhead level gives the stored strength ${row.WarheadStrength} from ${row.MSPWarhead} MSP`)
  }

  const strengthOfWarhead = row.WarheadStrength

  resolveBy('laserEfficiency', MISSILE_TECH.laserEfficiency, options.laser, (info) => agrees(row.LaserWarhead, missileLaserStrength({ strength: strengthOfWarhead, efficiency: info })), `no held laser efficiency level gives the stored laser strength ${row.LaserWarhead} from a warhead of ${strengthOfWarhead}`)
  resolveBy('terminal', MISSILE_TECH.terminal, options.terminal > 1, (info) => agrees(row.ATG, info), `no held terminal guidance level is the stored ${row.ATG}`)
  resolveBy('retarget', MISSILE_TECH.retarget, options.retarget > 0, (info) => Math.trunc(info) === row.Retargeting, `no held retargeting level is the stored ${row.Retargeting}`)
  resolveBy('eccm', MISSILE_TECH.eccm, options.eccm > 0, (info) => Math.trunc(info) === row.ECCM, `no held ECCM level is the stored ${row.ECCM}`)
  resolveBy('multipleWarheads', MISSILE_TECH.multipleWarheads, row.MultipleWarheads > 1, (info) => info > 0, `no held multiple warheads tech level (type ${MISSILE_TECH.multipleWarheads}) is above 0 for the stored ${row.MultipleWarheads} warheads`)
  resolveBy('shipDecoy', MISSILE_TECH.shipDecoy, decoy, (info) => info > 0, `no held ship decoy tech level (type ${MISSILE_TECH.shipDecoy}) is above 0 for the stored ship decoy`)

  // Three levels the design records as they stood and the figures above do not follow from: the EM sensitivity behind the active sensor's range, the laser focus range modifier and the missile ECM level. An unresolved one is unknown provenance, not a difference.
  resolveBy('emSensitivity', MISSILE_TECH.em, row.EMSensitivity > 0, (info) => info === row.EMSensitivity, `no held EM sensitivity level is the recorded ${row.EMSensitivity}`)
  resolveBy('laserFocus', MISSILE_TECH.laserFocus, row.LaserWarheadRangeModifier > 0, (info) => info === row.LaserWarheadRangeModifier, `no held laser focus level is the recorded ${row.LaserWarheadRangeModifier}`)
  resolveBy('missileEcm', MISSILE_TECH.missileEcm, row.MissileECM > 0, (info) => Math.trunc(info) === row.MissileECM, `no held missile ECM level is the recorded ${row.MissileECM}`)

  // A sensor under 0.25 MSP has no strength and needs no tech; the tech of a bigger one is the level whose strength the design stored.
  const sensorLine = (name, type, msp, stored) => resolveBy(name, type, msp >= MIN_SENSOR_MSP, (info) => agrees(stored, missileSensorStrength({ sensorMsp: msp, sensorTech: info })), `no held level gives the stored ${name} strength ${stored} from ${msp} MSP`)

  sensorLine('active', MISSILE_TECH.active, row.MSPActive, row.SensorStrength)
  sensorLine('thermal', MISSILE_TECH.thermal, row.MSPThermal, row.ThermalStrength)
  sensorLine('em', MISSILE_TECH.em, row.MSPEM, row.EMStrength)
  sensorLine('geo', MISSILE_TECH.geo, row.MSPGeo, row.Geostrength)

  const figuresOf = (name) => (lines[name].state === LINE_STATE.RESOLVED ? lines[name].level.info : null)
  const strengths = [row.MSPActive >= MIN_SENSOR_MSP ? row.SensorStrength : 0, row.MSPThermal >= MIN_SENSOR_MSP ? row.ThermalStrength : 0, row.MSPEM >= MIN_SENSOR_MSP ? row.EMStrength : 0, row.MSPGeo >= MIN_SENSOR_MSP ? row.Geostrength : 0]
  const output = missileReactorOutput(strengths)

  resolveBy('reactor', MISSILE_TECH.reactor, output > 0, (info) => agrees(row.MSPReactor, missileReactorMsp({ output, reactorTech: info })), `no held power plant level gives the stored reactor ${row.MSPReactor} MSP for an output of ${output}`)

  const tech = { warhead: figuresOf('warhead'), laserEfficiency: figuresOf('laserEfficiency'), reactor: figuresOf('reactor'), active: figuresOf('active'), thermal: figuresOf('thermal'), em: figuresOf('em'), geo: figuresOf('geo') }

  return { lines, tech }
}

// Whether a stored design mounts an engine: its row names an engine component or gives the engine a size or a speed. The engine-less designs of the saves (decoys, buoys) store 1 engine with none of the three.
const mountsMissileEngine = (row) => row.EngineID > 0 || row.MSPEngine > 0 || row.Speed > 0

// An engine the design mounts and the record of which is absent: its size is the stored one where the row has it, and nothing else is known.
const missingMissileEngine = (row) => ({ missing: true, storedMsp: row.MSPEngine > 0 ? row.MSPEngine : null })

// The engine component a stored design mounts, as a candidate's engine: null where the row shows none mounted, { missing: true, storedMsp } for an engine whose component the save does not hold.
export const missileEngineOf = (fixture, row) => {
  if (!mountsMissileEngine(row)) {
    return null
  }

  const component = row.EngineID > 0 ? fixture.components[row.EngineID] : null

  if (!component) {
    return missingMissileEngine(row)
  }

  return { sizeMsp: component.size, cost: component.cost, power: component.power, fuelEfficiency: component.fuelEfficiency }
}

// The minerals a stored design lists, summed: null when one is not known.
export const storedMineralTotal = (row) => (MISSILE_STORED_MINERALS.some((name) => row[name] === null || row[name] === undefined) ? null : MISSILE_STORED_MINERALS.reduce((total, name) => total + row[name], 0))

// Whether a stored design mounts a second stage: its row names one or counts one.
const mountsMissileStage = (row) => row.SecondStageID > 0 || row.NumSS > 0

// The second stage a stored design names, as a candidate's stage: another design of the fixture; what its Cost holds beyond its stored minerals is its Corundium (the one mineral with no column), so the stage carries it as such, and its Vendarite is the known 0 of a stage with no ground pod. Null for no stage, { missing: true } for one the fixture does not hold, whose minerals are not stored or which carries a ground pod (its Vendarite is not stored).
export const missileStageOf = (fixture, row) => {
  if (!mountsMissileStage(row)) {
    return null
  }

  const stage = row.SecondStageID > 0 ? fixture.designs.find((design) => design.id === row.SecondStageID) : null

  if (!stage) {
    return { missing: true }
  }

  const stored = storedMineralTotal(stage.row)

  if (stored === null || stage.row.GroundShots > 0) {
    return { missing: true }
  }

  return { size: stage.row.Size, cost: stage.row.Cost, fuelRequired: stage.row.FuelRequired, totalFlightTime: stage.row.TotalFlightTime, minerals: { ...Object.fromEntries(MISSILE_STORED_MINERALS.map((name) => [name, stage.row[name]])), Corundium: stage.row.Cost - stored, Vendarite: 0 } }
}

// A stored design as a candidate: its sizes, options and counts from the row, the engine, the stage and the levels' figures given (`missileEngineOf`, `missileStageOf`, the `tech` of `resolveMissileLevels`), and `sizeLimit` the size the design was capped at (0 for none: the save does not store it). Whether an engine or a stage is mounted is read from the row, not from the record given: a row that shows one mounted gets its count, and a missing marker where the record is absent (unknown, never none); a row that shows none is counted 0 (the engine-less designs store 1). A record given for a part the row does not mount, or a count of 0 for one it does, is a contradiction and throws. A ground pod and an enhanced radiation warhead are marked, as the rules do not cover them.
export const savedMissileCandidate = (row, { engine, stage, tech, sizeLimit = 0 }) => {
  const engineMounted = mountsMissileEngine(row)
  const stageMounted = mountsMissileStage(row)

  if (!engineMounted && engine) {
    throw new Error(`The design ${row.MissileID} shows no engine mounted but was given one`)
  }

  if (!stageMounted && stage) {
    throw new Error(`The design ${row.MissileID} shows no second stage mounted but was given one`)
  }

  if ((engineMounted && !(row.NumEngines > 0)) || (stageMounted && !(row.NumSS > 0))) {
    throw new Error(`The design ${row.MissileID} shows a part mounted but counts none`)
  }

  return { warheadMsp: row.MSPWarhead, warheads: row.MultipleWarheads, shipDecoy: row.ShipDecoy === 1, decoys: row.NumDecoys, fuelMsp: row.MSPFuel, activeMsp: row.MSPActive, thermalMsp: row.MSPThermal, emMsp: row.MSPEM, geoMsp: row.MSPGeo, sizeLimit, engine: engineMounted ? engine || missingMissileEngine(row) : null, engines: engineMounted ? row.NumEngines : 0, stage: stageMounted ? stage || { missing: true } : null, stages: stageMounted ? row.NumSS : 0, options: missileOptionsOf(row), tech, sensor: { resolution: row.SensorResolution, emSensitivity: row.EMSensitivity }, groundPod: row.GroundShots > 0, enhancedRadiation: hasEnhancedRadiation(row) }
}

// A design of a fixture as a candidate: its levels resolved from the levels its race holds, its engine and stage from the fixture. `sizeLimit` as in savedMissileCandidate.
export const missileCandidateOf = (fixture, design, { sizeLimit = 0 } = {}) => savedMissileCandidate(design.row, { engine: missileEngineOf(fixture, design.row), stage: missileStageOf(fixture, design.row), tech: resolveMissileLevels(design.row, heldMissileLevels(fixture, design.race)).tech, sizeLimit })

registerRule({
  id: 'design.missileLevels',
  versions: ['2.7.x'],
  units: 'tech level',
  verification: 'estimated',
  structure: ['FCT_RaceTech.TechID', 'FCT_TechSystem.TechTypeID, AdditionalInfo, DevelopCost', 'FCT_MissileType'],
  note: 'A saved missile design records no tech level. The level it was made with is the one the race holds whose figure reproduces the stored one, the held level that cost the most to develop when several do; a design whose figure no held level gives has an unknown level. The level therefore agrees with the stored figure by construction, and a comparison made from it says that some held level gives the figure, not that the rule gives it independently (scripts/check-design-rules.js reports these as resolved from the stored figure).',
  assumptions: ['The race has not lost or replaced a level it held when the design was made', 'The game picks the level of greatest development cost among those that give the stored figure'],
})

// The component types of the sensors and fire controls, as the save numbers them: thermal sensor 8, EM sensor 41, active sensor 24, missile fire control 25, beam fire control 19.
export const SENSOR_COMPONENT_TYPES = Object.freeze({ thermal: 8, em: 41, active: 24, missileFireControl: 25, beamFireControl: 19 })

// The tech types a sensor or a fire control reads, as the save numbers them: thermal sensitivity 19, EM sensitivity 125, active sensor strength 20, hardening 139, ECCM 83, and for a beam fire control the distance rating 4, the speed rating 5 and the single weapon tech 268. A component names its techs in BGTech1 to BGTech7 and the slot of a role is never assumed: the tech types are what DIM_TechType describes (`SENSOR_TECH_DESCRIPTIONS`), and a component's tech of a role is the one of that type among its slots.
export const SENSOR_TECH = Object.freeze({ thermal: 19, em: 125, strength: 20, hardening: 139, eccm: 83, distance: 4, speed: 5, singleWeapon: 268 })

// The description DIM_TechType gives each tech type of SENSOR_TECH, the evidence that the numbers above are the roles named.
export const SENSOR_TECH_DESCRIPTIONS = Object.freeze({ 19: 'Thermal Sensor Sensitivity', 125: 'EM Sensor Sensitivity', 20: 'Active Sensor Strength', 139: 'Hardening', 83: 'ECCM', 4: 'Fire Control Distance Rating', 5: 'Fire Control Speed Rating', 268: 'Single Weapon Fire Control' })

export const SENSOR_COLUMNS = Object.freeze(['Name', 'ComponentTypeID', 'Size', 'Cost', 'Crew', 'HTK', 'ComponentValue', 'MaxSensorRange', 'Resolution', 'ECCM', 'ElectronicCTD', 'TrackingSpeed', 'FCRangeModifier', 'FCSpeedModifier', 'SpecialFunction', 'Uridium', 'Corbomite', ...TECH_COLUMNS])

const SENSOR_TYPE_IDS = Object.freeze(Object.values(SENSOR_COMPONENT_TYPES))
const SENSOR_SELECT = `select FCT_ShipDesignComponents.SDComponentID, ${SENSOR_COLUMNS.map((column) => `FCT_ShipDesignComponents.${column}`).join(', ')}`
const SENSOR_WHERE = `FCT_ShipDesignComponents.ComponentTypeID in (${SENSOR_TYPE_IDS.join(',')}) and FCT_ShipDesignComponents.GameID in (0, :game)`

// The sensors and fire controls a race has researched (FCT_RaceTech TechID = SDComponentID), as rows; `race` null reads every one that any race of the game holds, each once.
export const ownedSensors = async (database, game, race = null) => {
  if (race === null) {
    const [rows] = await database.query(`${SENSOR_SELECT} from FCT_ShipDesignComponents where ${SENSOR_WHERE} and FCT_ShipDesignComponents.SDComponentID in (select FCT_RaceTech.TechID from FCT_RaceTech where FCT_RaceTech.GameID = :game) order by FCT_ShipDesignComponents.SDComponentID`, { replacements: { game } })

    return rows
  }

  const [rows] = await database.query(`${SENSOR_SELECT} from FCT_ShipDesignComponents inner join FCT_RaceTech on FCT_RaceTech.TechID = FCT_ShipDesignComponents.SDComponentID where ${SENSOR_WHERE} and FCT_RaceTech.GameID = :game and FCT_RaceTech.RaceID = :race order by FCT_ShipDesignComponents.SDComponentID`, { replacements: { game, race } })

  return rows
}

const wholeIds = (ids) => [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b)

// The fixture the sensor and fire control rules need, as plain data: `{ game, techTypes: { type: description }, techs: { id: { type, info, info2 } }, components: [{ id, race, row }] }` with `row` the SENSOR_COLUMNS of the stored component, `techs` every tech a component names that FCT_TechSystem holds (AdditionalInfo as `info`, AdditionalInfo2 as `info2`) and `techTypes` what DIM_TechType calls the types of SENSOR_TECH. `race` is the race the components were read for, or null for those held by any race of the game.
export const loadSensorFixture = async (database, game, race = null) => {
  const rows = await ownedSensors(database, game, race)
  const components = rows.map((row) => ({ id: row.SDComponentID, race, row: Object.fromEntries(SENSOR_COLUMNS.map((column) => [column, row[column]])) }))
  const techIds = wholeIds(rows.flatMap((row) => TECH_COLUMNS.map((column) => row[column])))
  const techs = {}

  if (techIds.length) {
    const [techRows] = await database.query(`select FCT_TechSystem.TechSystemID, FCT_TechSystem.TechTypeID, FCT_TechSystem.AdditionalInfo, FCT_TechSystem.AdditionalInfo2 from FCT_TechSystem where FCT_TechSystem.TechSystemID in (${techIds.join(',')})`, { replacements: {} })

    for (const row of techRows) {
      techs[row.TechSystemID] = { type: row.TechTypeID, info: row.AdditionalInfo, info2: row.AdditionalInfo2 }
    }
  }

  const types = Object.values(SENSOR_TECH)
  const [typeRows] = await database.query(`select DIM_TechType.TechTypeID, DIM_TechType.Description from DIM_TechType where DIM_TechType.TechTypeID in (${types.join(',')})`, { replacements: {} })

  return { game, techTypes: Object.fromEntries(typeRows.map((row) => [row.TechTypeID, row.Description])), techs, components }
}

// The tech of one type (`type` of SENSOR_TECH) a stored component names, found by the type of the tech and never by the slot it sits in: `{ state: 'resolved', id, slot, info, info2 }`; `'missing'` when no slot names a tech of the type and every slot named is known; `'unresolved'` when no known slot has the type and a slot names a tech the fixture does not hold (it could be that one); `'ambiguous'` when two slots name techs of the type. Each carries a `reason` unless resolved.
export const sensorTechOf = (fixture, row, type) => {
  const named = TECH_COLUMNS.map((column) => ({ slot: column, id: row[column] })).filter((entry) => Number.isInteger(entry.id) && entry.id > 0)
  const found = named.filter((entry) => fixture.techs[entry.id] && fixture.techs[entry.id].type === type)
  const unknown = named.filter((entry) => !fixture.techs[entry.id])
  const label = fixture.techTypes[type] || `tech type ${type}`

  if (found.length > 1) {
    return { state: 'ambiguous', reason: `${found.length} of the component's techs are of type ${type} (${label}): ${found.map((entry) => entry.id).join(', ')}` }
  }

  if (found.length === 1) {
    const tech = fixture.techs[found[0].id]

    return { state: 'resolved', id: found[0].id, slot: found[0].slot, info: tech.info, info2: tech.info2 }
  }

  if (unknown.length) {
    return { state: 'unresolved', reason: `the save holds no tech row for ${unknown.map((entry) => entry.id).join(', ')}, one of which may be the ${label} tech` }
  }

  return { state: 'missing', reason: `the component names no ${label} tech (type ${type})` }
}
