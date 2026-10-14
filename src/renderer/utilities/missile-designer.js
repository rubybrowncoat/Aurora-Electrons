// The missile designer: the missiles the race has researched and the missiles it could design from the tech it holds (or a hypothetical next level of it, or figures typed by hand), set side by side under one scenario. The arithmetic is design-rules.js's (`evaluateMissile`, the missile engine, the sensor detection), the saved designs and their levels are design-data.js's, the hit chance is missile-hit.js's and the hypothetical levels are tech-scenarios.js's: this module only chooses the inputs, keeps the baseline apart from the alternatives and says where every figure comes from. The save is only read.
//
// A column is one missile. The baseline is a saved design, pinned: what it stored and what the rules rebuild from its inputs, figure by figure, each judged as agreeing, differing, unknown or unsupported (never agreeing while unknown or unsupported). An alternative is a saved design nominated unchanged, or a design made here (`draft`): its source is 'researched' when every tech line it uses is a level the race has, 'hypothetical' when one is a level the race has not researched (tech-scenarios.js), and 'manual' when the tech figures are typed. At most MAX_ALTERNATIVES alternatives are compared; a fourth is refused with its reason, never dropped quietly.
//
// The engine. A missile engine is designed at a thrust modifier of the missile's own. Above the race's greatest thrust modifier (tech type 130) the fuel use is boosted: that overboost is the missile rule of design-rules.js `missileEngineDesign`, and a ship's thrust limits (its least thrust modifier, its engine size cap) are never read here. The factor shown is the fuel use at the thrust over the fuel use with no overboost, both from that function. Obsolete missile figures (maneuver rating, agility) are not inputs and no column of them is read.
//
// The planner figure. warhead × hit chance × (1 − PD / speed), in the damage unit of the warhead. It is the planner's own heuristic and no game statistic: PD is a point-defence attenuation entered in the units of speed (km/s) and is no verified model of interception. It is worked out only for a finite PD of 0 or more that is not above the missile's speed, with a speed above 0; outside that domain it is unavailable with the reason, never negative and never 0. The hit chance is missile-hit.js's capped chance (as a fraction) for the target speed, jammer and tactical modifier of the Designed Tech page's hit chance panel, which this page shares.

import { MIN_SENSOR_MSP, MSP_PER_HS, SENSOR_RULES, TONS_PER_HS, VALIDATED_RETARGETING, agrees, evaluateMissile, missileEngineDesign, missileSignature, roundHalfEven, sensorEffectiveRange, thrustOfMissileEngine } from './design-rules'
import { LINE_STATE, MISSILE_TECH, heldMissileLevels, loadMissileFixture, matchLevels, missileEngineOf, missileLevelRecord, missileStageOf, ownedMissiles, resolveMissileLevels, savedMissileCandidate } from './design-data'
import { entered, hitScenario, versionLimit } from './missile-hit'
import { STATUS, combine, isAvailable, ofRule, registerRule, unavailable, valueOrNull } from './provenance'
import { hypotheticalOf, markHypothetical } from './tech-scenarios'

export const MAX_ALTERNATIVES = 3
export const NAME_LENGTH = 80
export const DESIGNER_KIND = 'planner.missileDesign'
export const MISSILE_LINK_TYPE = 'missile'
export const DESIGNER_SCHEMA = 2
const TECH_LINK_TYPE = 'tech'
const TECH_NAME_LENGTH = 200

export const SOURCES = Object.freeze({ SAVED: 'saved', RESEARCHED: 'researched', HYPOTHETICAL: 'hypothetical', MANUAL: 'manual' })

export const SOURCE_LABELS = Object.freeze({ saved: 'Saved design', researched: 'Researched tech', hypothetical: 'Hypothetical tech', manual: 'Manual figures' })

export const PLANNER_FIGURE = 'Planner figure'
export const PLANNER_FIGURE_FORMULA = 'warhead × hit chance × (1 − PD / speed)'
export const PLANNER_FIGURE_HINT = 'A planner figure, not a game statistic: the warhead strength times the capped hit chance times (1 − PD / speed), per warhead. PD is a point-defence attenuation in km/s, the units of speed, and no verified model of interception. It needs a finite PD of 0 or more, not above the missile speed. The strength and the hit chance are those of one warhead and are not multiplied by the number of warheads.'

const VERSIONS = ['2.7.x']

export const DESIGNER_RULES = Object.freeze({ plannerFigure: 'missileDesigner.plannerFigure', manualTech: 'missileDesigner.manualTech', overboost: 'missileDesigner.overboost', size: 'missileDesigner.sizeUnits' })

registerRule({
  id: DESIGNER_RULES.plannerFigure,
  versions: VERSIONS,
  units: 'damage',
  verification: STATUS.ASSUMED,
  structure: ['FCT_MissileType.WarheadStrength, Speed, ATG, ECCM, MultipleWarheads', 'the target speed, missile jammer, tactical modifier and point-defence figure (entered)'],
  assumptions: ['The point-defence figure is a planning attenuation in km/s, not a verified interception model', 'The figure is per warhead: the warhead strength and the capped hit chance are those of one warhead, and neither is multiplied by the number of warheads; the chance of the missile being shot down is not applied'],
  note: 'The planner figure: the warhead strength times the capped hit chance (as a fraction) times one less the point-defence figure over the missile speed. It is the planner\'s own heuristic and is no game statistic. Valid only for a finite point-defence figure of 0 or more that is not above the missile speed, with a speed above 0; elsewhere it is unavailable, never negative.',
})

registerRule({
  id: DESIGNER_RULES.manualTech,
  versions: VERSIONS,
  units: 'tech level',
  verification: STATUS.ASSUMED,
  structure: [],
  assumptions: ['The tech figures are typed here and are not read from the save'],
  note: 'A figure built on tech levels typed by hand: what the race holds is not read, so nothing built on them is confirmed.',
})

registerRule({
  id: DESIGNER_RULES.overboost,
  versions: VERSIONS,
  units: '×',
  verification: STATUS.ESTIMATED,
  structure: ['FCT_TechSystem.AdditionalInfo (tech type 130, the greatest thrust modifier)', 'FCT_ShipDesignComponents.FuelEfficiency, ComponentValue of a missile engine'],
  assumptions: ['The race\'s greatest thrust modifier is the level the overboost starts from, as for a saved missile engine; a ship\'s thrust limits are not read'],
  note: 'The factor the fuel use of a missile engine is multiplied by above the race\'s greatest thrust modifier: the fuel use at the missile\'s thrust over the fuel use with no overboost, both from the missile engine rule. 1 at or below the greatest thrust modifier.',
})

registerRule({
  id: DESIGNER_RULES.size,
  versions: VERSIONS,
  units: 'MSP, HS, t',
  verification: STATUS.CONFIRMED,
  structure: ['FCT_MissileType.Size'],
  note: 'A missile size in MSP shown in hull spaces (20 MSP to the HS) and in tons (50 tons to the HS, so 2.5 tons to the MSP).',
})

// ---- Sizes ---------------------------------------------------------------------------------------------------------

// A size in MSP as the three units the designer shows: MSP, hull spaces and tons. Null in, nothing out: an unknown size has no unit.
export const sizeOf = (msp) => (typeof msp === 'number' && Number.isFinite(msp) ? Object.freeze({ msp, hs: msp / MSP_PER_HS, tons: msp / MSP_PER_HS * TONS_PER_HS }) : null)

// ---- The tech lines ------------------------------------------------------------------------------------------------

// The tech line each figure of a design reads, as the save numbers them (design-data.js MISSILE_TECH).
export const DESIGN_LINES = Object.freeze({ warhead: MISSILE_TECH.warhead, laserEfficiency: MISSILE_TECH.laserEfficiency, terminal: MISSILE_TECH.terminal, retarget: MISSILE_TECH.retarget, eccm: MISSILE_TECH.eccm, reactor: MISSILE_TECH.reactor, active: MISSILE_TECH.active, thermal: MISSILE_TECH.thermal, em: MISSILE_TECH.em, geo: MISSILE_TECH.geo, engine: MISSILE_TECH.engine, fuel: MISSILE_TECH.fuel, maxThrust: MISSILE_TECH.maxThrust })

export const DESIGN_LINE_TYPES = Object.freeze(Object.values(DESIGN_LINES))

export const LINE_LABELS = Object.freeze({ warhead: 'Warhead strength', laserEfficiency: 'Laser warhead efficiency', terminal: 'Terminal guidance', retarget: 'Retargeting', eccm: 'ECCM', reactor: 'Power plant', active: 'Active sensor', thermal: 'Thermal sensor', em: 'EM sensor', geo: 'Geo sensor', engine: 'Engine', fuel: 'Fuel consumption', maxThrust: 'Greatest thrust modifier' })

const figureOfLevel = (level) => (level && level.info !== null && level.info !== undefined && level.info !== '' && Number.isFinite(Number(level.info)) ? Number(level.info) : null)

// The figures of the levels a page designs with, by name (`levels` maps a tech type to a level { info }, or null for a line with none): null for a line the race has no level of.
export const techFigures = (levels) => Object.fromEntries(Object.entries(DESIGN_LINES).map(([name, type]) => [name, figureOfLevel(levels[type])]))

// The levels a page designs with from a resolution of the tech lines (tech-scenarios.js `resolveChoices`), a level per type.
export const levelsOf = (resolution) => Object.fromEntries(DESIGN_LINE_TYPES.map((type) => [type, resolution[type] ? resolution[type].level : null]))

// ---- The planner figure ---------------------------------------------------------------------------------------------

const NON_FINITE = /^\s*[-+]?(infinity|inf|nan)\s*$/i

// Why a point-defence figure typed or stored is not a figure of the domain, or an empty text. It is checked on its own, before any missile: blank, not a number, not finite and negative are each a field error.
export const pdProblem = (value) => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return 'Enter the point-defence figure as a number: 0 for none'
  }

  if (typeof value === 'number' ? !Number.isFinite(value) : NON_FINITE.test(String(value)) || entered(value) === null) {
    return typeof value === 'number' || NON_FINITE.test(String(value)) ? 'The point-defence figure must be finite' : 'The point-defence figure is not a number'
  }

  return Number(value) < 0 ? 'The point-defence figure must be 0 or more' : ''
}

// The planner figure of one missile: `warhead` (damage), `hitChance` (percent, the capped chance) and `speed` (km/s) are results, `pd` the figure as typed. Returns { result, fieldError, rowError }: `fieldError` is the problem of the PD itself, `rowError` what makes the missile's own domain fail (a speed that is not above 0, a PD above the speed). The result is unavailable whenever either is set, or a figure is unknown, and says why.
export const plannerFigure = ({ warhead, hitChance, speed, pd }) => {
  const rule = DESIGNER_RULES.plannerFigure
  const fieldError = pdProblem(pd)
  const units = 'damage'

  if (fieldError) {
    return { result: unavailable({ rule, missing: [fieldError], units }), fieldError, rowError: '' }
  }

  const attenuation = Number(pd)
  const speedValue = valueOrNull(speed)

  if (speedValue === null) {
    return { result: unavailable({ rule, missing: ['the missile speed, which is not known'], units }), fieldError: '', rowError: '' }
  }

  if (!(speedValue > 0)) {
    const rowError = 'The missile speed is not above 0, so PD / speed has no value'

    return { result: unavailable({ rule, missing: [rowError], units }), fieldError: '', rowError }
  }

  if (attenuation > speedValue) {
    const rowError = `The point-defence figure ${attenuation} is above the missile speed ${speedValue} km/s: the figure would be negative`

    return { result: unavailable({ rule, missing: [rowError], units }), fieldError: '', rowError }
  }

  const result = combine({ rule, parts: { warhead, 'hit chance': hitChance, speed }, compute: (values) => values.warhead * (values['hit chance'] / 100) * (1 - attenuation / values.speed), units, inputs: { present: ['point-defence figure'] }, assumptions: [`a point-defence figure of ${attenuation} km/s`] })

  return { result, fieldError: '', rowError: '' }
}

// ---- Overboost and the saved engine --------------------------------------------------------------------------------

// The overboost of a missile engine: `thrust` against `maxThrust` (the race's greatest thrust modifier) through the missile engine rule, never through a ship's limits. { over, excess, factor }: the factor is the fuel use at the thrust over the fuel use with no overboost, 1 when the thrust is not over. Null while a figure is not known.
export const overboostOf = ({ sizeMsp, thrust, engineTech, fuelTech, maxThrust }) => {
  const known = [sizeMsp, thrust, engineTech, fuelTech, maxThrust].every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)

  if (!known) {
    return null
  }

  const boosted = missileEngineDesign({ sizeMsp, thrust, engineTech, fuelTech, maxThrust })
  const free = missileEngineDesign({ sizeMsp, thrust, engineTech, fuelTech, maxThrust: Infinity })

  return { over: thrust > maxThrust, excess: Math.max(0, thrust - maxThrust), factor: boosted.fuelEfficiency / free.fuelEfficiency }
}

// The engine of a saved design as the rules read it: the component, the thrust it was designed at (the design's own PowerMod, else the thrust its stored power implies), the two tech figures it names and the greatest thrust modifier the design had. The greatest thrust modifier is the held level whose boost reproduces the stored fuel efficiency, the game's pick among those that do; none that does leaves it unknown (never the current level). Null for a design with no engine component.
const savedEngineOf = (fixture, design) => {
  const { row } = design

  if (!(row.EngineID > 0)) {
    return null
  }

  const component = fixture.components[row.EngineID]

  if (!component) {
    return { component: null, reason: `the engine component ${row.EngineID} is not in the save` }
  }

  const engineLevel = missileLevelRecord(fixture, component.tech1)
  const fuelLevel = missileLevelRecord(fixture, component.tech2)
  const engineTech = engineLevel ? engineLevel.info : null
  const fuelTech = fuelLevel ? fuelLevel.info : null
  const given = typeof row.PowerMod === 'number' && row.PowerMod > 0
  const thrust = given ? row.PowerMod : (engineTech > 0 ? thrustOfMissileEngine({ power: component.power, sizeMsp: component.size, engineTech }) : null)
  const held = heldMissileLevels(fixture, design.race)[MISSILE_TECH.maxThrust] || []
  const known = typeof thrust === 'number' && typeof engineTech === 'number' && typeof fuelTech === 'number'
  const { matches, level } = matchLevels(held, (info) => known && agrees(component.fuelEfficiency, missileEngineDesign({ sizeMsp: component.size, thrust, engineTech, fuelTech, maxThrust: info }).fuelEfficiency))

  return { component, thrust, thrustStored: given, engineTech, fuelTech, maxThrust: level, maxThrustMatches: matches, reason: known ? (level ? null : `no held level of the greatest thrust modifier reproduces the stored fuel use at a thrust of ${thrust}`) : 'the engine or fuel tech level the engine names is not in the save' }
}

// ---- The rows ------------------------------------------------------------------------------------------------------

// What a column says of each input and figure, in the order the page lists them. `digits` is how many decimals the figure carries (`precision` says how the game rounds it), `size` marks a quantity of MSP shown in HS and tons as well.
export const INPUT_ROWS = Object.freeze([
  Object.freeze({ id: 'engines', label: 'Engines', unit: '', digits: 0, hint: 'The number of engines of the missile. A missile with none has no speed.' }),
  Object.freeze({ id: 'engineMsp', label: 'Engine size, each', unit: 'MSP', digits: 4, size: true, hint: 'The size of one engine. The engines together are counted to 4 decimals.' }),
  Object.freeze({ id: 'thrust', label: 'Missile thrust modifier', unit: '×', digits: 4, hint: 'The thrust modifier the missile engine is designed at. A ship engine\'s thrust limits do not apply to it.' }),
  Object.freeze({ id: 'maxThrust', label: 'Greatest thrust modifier', unit: '×', digits: 4, hint: 'The race\'s greatest thrust modifier (tech type 130): above it the fuel use of a missile engine is boosted. For a saved design it is the level that reproduces its stored fuel use.' }),
  Object.freeze({ id: 'overboost', label: 'Overboost fuel multiplier', unit: '×', digits: 4, hint: 'The fuel use at the thrust over the fuel use with no overboost: 1 at or below the greatest thrust modifier.' }),
  Object.freeze({ id: 'fuelMsp', label: 'Fuel', unit: 'MSP', digits: 4, size: true, hint: 'The size allotted to fuel: 2,500 litres to the MSP, the litres cut to a whole number.' }),
  Object.freeze({ id: 'warheadMsp', label: 'Warhead', unit: 'MSP', digits: 4, size: true, hint: 'The size allotted to the warhead.' }),
  Object.freeze({ id: 'warheads', label: 'Warheads', unit: '', digits: 0, hint: 'Each warhead after the first adds 0.1 MSP to the size and cost.' }),
  Object.freeze({ id: 'decoys', label: 'ECM decoys', unit: '', digits: 0, hint: 'Each decoy adds 0.5 MSP.' }),
  Object.freeze({ id: 'activeMsp', label: 'Active sensor', unit: 'MSP', digits: 4, size: true, hint: 'The size allotted to an active sensor. Under 0.25 MSP a sensor has no strength.' }),
  Object.freeze({ id: 'thermalMsp', label: 'Thermal sensor', unit: 'MSP', digits: 4, size: true, hint: 'The size allotted to a thermal sensor.' }),
  Object.freeze({ id: 'emMsp', label: 'EM sensor', unit: 'MSP', digits: 4, size: true, hint: 'The size allotted to an EM sensor.' }),
  Object.freeze({ id: 'geoMsp', label: 'Geo sensor', unit: 'MSP', digits: 4, size: true, hint: 'The size allotted to a geo sensor.' }),
  Object.freeze({ id: 'resolution', label: 'Sensor resolution', unit: 'HS', digits: 2, hint: 'The resolution of the active sensor, which sets its range.' }),
  Object.freeze({ id: 'sizeLimit', label: 'Size limit', unit: 'MSP', digits: 4, size: true, hint: 'The designer\'s limit on the missile\'s size, 0 for none. A save does not store it.' }),
  Object.freeze({ id: 'eccm', label: 'ECCM', unit: 'level', digits: 0, hint: 'The ECCM level of the missile, 0.25 MSP.' }),
  Object.freeze({ id: 'terminal', label: 'Terminal guidance', unit: '×', digits: 2, hint: 'The multiplier on the hit chance, 0.25 MSP; 1 for none.' }),
  Object.freeze({ id: 'retarget', label: 'Retargeting', unit: 'level', digits: 0, hint: 'Retargeting, 0.5 MSP at level 1. A higher level has no saved design to check its size and cost against.' }),
  Object.freeze({ id: 'laser', label: 'Laser warhead', unit: '', digits: 0, hint: 'A laser warhead keeps the share of the strength its efficiency gives, 0.25 MSP.' }),
])

export const FIGURE_ROWS = Object.freeze([
  Object.freeze({ id: 'sizeSum', label: 'Size sum', unit: 'MSP', digits: 4, size: true, saved: null, precision: 'The contributions added up, each to 4 decimals, before the size floor of 1 MSP and the size limit.', hint: 'The full sum of the sizes of every part. The stored size is this sum, raised to the floor or cut to the limit.' }),
  Object.freeze({ id: 'size', label: 'Size', unit: 'MSP', digits: 4, size: true, saved: 'Size', precision: 'The sum, not below 1 MSP (5 for a ship decoy) and not above the size limit.', hint: 'The missile\'s size in MSP, HS and tons.' }),
  Object.freeze({ id: 'speed', label: 'Speed', unit: 'km/s', digits: 1, saved: 'Speed', precision: 'Engine power over the size in HS, times 1,000, to 0.1 km/s (half to even), never over 270,000.', hint: 'The speed of the missile at full power.' }),
  Object.freeze({ id: 'maxRange', label: 'Range', unit: 'km', digits: 0, saved: 'MaxRange', precision: 'The speed times the endurance, not rounded.', hint: 'The distance the fuel carries the missile.' }),
  Object.freeze({ id: 'endurance', label: 'Endurance', unit: 's', digits: 1, saved: 'Endurance', precision: 'The fuel over the burn per hour, in seconds, to 0.1 s (half to even).', hint: 'The seconds the fuel lasts at full power.' }),
  Object.freeze({ id: 'fuelRequired', label: 'Fuel', unit: 'L', digits: 0, saved: 'FuelRequired', precision: '2,500 litres to the MSP, cut down to a whole litre.', hint: 'The litres of fuel the missile carries.' }),
  Object.freeze({ id: 'damage', label: 'Warhead damage', unit: 'damage', digits: 3, saved: 'WarheadStrength', precision: 'The warhead MSP times the warhead tech, to 3 decimals (a laser warhead keeps its efficiency share).', hint: 'The strength of the warhead.' }),
  Object.freeze({ id: 'sensorRange', label: 'Active sensor range', unit: 'km', digits: 0, saved: 'SensorRange', precision: 'From the sensor strength, the EM sensitivity and the resolution, to a whole km.', hint: 'How far the missile\'s own active sensor sees.' }),
  Object.freeze({ id: 'signature', label: 'Signature', unit: 'HS', digits: 4, saved: null, precision: 'The size over 20 MSP, never below 0.3 HS.', hint: 'The size another active sensor sees the missile by.' }),
  Object.freeze({ id: 'reach', label: 'Sensor reach against the target', unit: 'km', digits: 0, saved: null, precision: 'The sensor range cut by the square of the target\'s signature over the sensor\'s resolution when the target is under it.', hint: 'The range at which the missile\'s own active sensor sees a target of the signature entered above.' }),
  Object.freeze({ id: 'cost', label: 'Cost', unit: 'BP', digits: 4, saved: 'Cost', precision: 'The contributions added up, each to 3 or 4 decimals.', hint: 'The build cost of the missile.' }),
  Object.freeze({ id: 'hitChance', label: 'Hit chance', unit: '%', digits: 2, saved: null, precision: 'The capped chance of one warhead against the target speed, jammer and modifier of the scenario.', hint: 'The shared combat hit chance, limited to 100.' }),
  Object.freeze({ id: 'planner', label: PLANNER_FIGURE, unit: 'damage', digits: 3, saved: null, precision: PLANNER_FIGURE_FORMULA, hint: PLANNER_FIGURE_HINT }),
])

export const rowOf = (id) => INPUT_ROWS.find((row) => row.id === id) || FIGURE_ROWS.find((row) => row.id === id) || null

// ---- Gated options -------------------------------------------------------------------------------------------------

// The options of a saved missile the designer does not build, each listed on every column with its state: 'not-offered' (the column has none), 'carried' (a seeded design has it and keeps it as it was), 'recorded' (a saved design stores it and no rule here models it) or 'blocked' (asked for and not allowed, with the reason). An option is never left out for being unsupported.
export const GATED_OPTIONS = Object.freeze([
  Object.freeze({ id: 'secondStage', label: 'Second stage', reason: 'A second stage is another saved design: the designer carries the one a seeded design has and builds none.' }),
  Object.freeze({ id: 'shipDecoy', label: 'Ship decoy', reason: 'A decoy missile is carried from a seeded design as it was: its warhead is a decoy and no hit chance is worked out for it.' }),
  Object.freeze({ id: 'groundPod', label: 'Ground attack pod', reason: 'A ground pod\'s size, cost and Vendarite are not covered by the missile accounting rules, so no figure of it is worked out.' }),
  Object.freeze({ id: 'enhancedRadiation', label: 'Enhanced radiation warhead', reason: 'The multiplier of an enhanced radiation warhead is a design choice the rules do not cover, so its cost is not worked out.' }),
  Object.freeze({ id: 'retargetHigh', label: `Retargeting above level ${VALIDATED_RETARGETING}`, reason: `A retargeting level above ${VALIDATED_RETARGETING} has no saved design to check its size and cost against.` }),
  Object.freeze({ id: 'missileEcm', label: 'Missile ECM', reason: 'A saved design records its missile ECM level, but no size, cost or hit rule here follows from it.' }),
  Object.freeze({ id: 'laserFocus', label: 'Laser warhead focus', reason: 'A saved design records its laser focus, but no size, cost or hit rule here follows from it.' }),
])

const gatedEntry = (id, state, extra = '') => {
  const option = GATED_OPTIONS.find((entry) => entry.id === id)

  return Object.freeze({ id, label: option.label, state, reason: extra ? `${option.reason} ${extra}` : option.reason })
}

const GATED_STATE_TEXT = Object.freeze({ 'not-offered': 'Not offered', carried: 'Carried unchanged', recorded: 'Recorded, not modelled', blocked: 'Blocked' })

export const gatedStateText = (state) => GATED_STATE_TEXT[state] || state

// ---- Drafts --------------------------------------------------------------------------------------------------------

const MANUAL_FIELDS = Object.freeze(Object.keys(DESIGN_LINES))

const text = (value) => (value === null || value === undefined ? '' : String(value))

const numberText = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toPrecision(12))) : '')

export const emptyManual = () => Object.fromEntries(MANUAL_FIELDS.map((name) => [name, '']))

// A design made here, every figure as typed (so a field that is not a figure is kept and reported, not replaced): `techMode` is 'page' (the page's tech lines) or 'manual' (the figures of `manual`), `options` what the design switches on, `carried` what a seeded design keeps that the designer cannot change, `seededFrom` the saved design it started from.
export const emptyDraft = (name = '') => ({
  kind: 'designed',
  key: '',
  name,
  techMode: 'page',
  seededFrom: null,
  engines: '1',
  engineMsp: '',
  thrust: '',
  fuelMsp: '0',
  warheadMsp: '0',
  warheads: '1',
  decoys: '0',
  activeMsp: '0',
  thermalMsp: '0',
  emMsp: '0',
  geoMsp: '0',
  resolution: '',
  sizeLimit: '0',
  options: { eccm: false, terminal: false, retarget: false, laser: false },
  carried: { stageId: 0, stages: 0, shipDecoy: false, groundPod: false, enhancedRadiation: false },
  manual: emptyManual(),
})

// A saved design nominated unchanged as an alternative.
export const savedAlternative = (savedId, name = '') => ({ kind: 'saved', key: '', name, savedId })

const copyOf = (value) => JSON.parse(JSON.stringify(value))

// The draft a saved design seeds: its own sizes, counts and options as text, designed with the page's tech lines. What it keeps that the designer cannot change (a second stage, a decoy warhead, a ground pod, an enhanced radiation warhead) is carried. Nothing the save did not store is invented: a thrust the design does not store and its engine does not imply is left blank.
export const seedDraft = (saved, name = '') => {
  const { row, engine } = saved
  const draft = emptyDraft(name || `${row.Name} (reoptimised)`)
  const thrust = engine && engine.thrust ? engine.thrust : null

  return Object.assign(draft, {
    seededFrom: saved.id,
    engines: text(row.NumEngines),
    engineMsp: engine && engine.component ? numberText(engine.component.size) : '',
    thrust: numberText(thrust),
    fuelMsp: text(row.MSPFuel),
    warheadMsp: text(row.MSPWarhead),
    warheads: text(row.MultipleWarheads),
    decoys: text(row.NumDecoys),
    activeMsp: text(row.MSPActive),
    thermalMsp: text(row.MSPThermal),
    emMsp: text(row.MSPEM),
    geoMsp: text(row.MSPGeo),
    resolution: row.SensorResolution > 0 ? text(row.SensorResolution) : '',
    options: { eccm: row.ECCM > 0, terminal: row.ATG > 1, retarget: row.Retargeting > 0, laser: row.LaserWarhead > 0 },
    carried: { stageId: row.SecondStageID > 0 ? row.SecondStageID : 0, stages: row.SecondStageID > 0 || row.NumSS > 0 ? Number(row.NumSS) || 0 : 0, shipDecoy: row.ShipDecoy === 1, groundPod: row.GroundShots > 0, enhancedRadiation: saved.enhancedRadiation },
  })
}

const FIELD_LABELS = Object.freeze({ engines: 'Engines', engineMsp: 'Engine size', thrust: 'Thrust modifier', fuelMsp: 'Fuel', warheadMsp: 'Warhead', warheads: 'Warheads', decoys: 'ECM decoys', activeMsp: 'Active sensor', thermalMsp: 'Thermal sensor', emMsp: 'EM sensor', geoMsp: 'Geo sensor', resolution: 'Sensor resolution', sizeLimit: 'Size limit' })

// A draft as numbers, or the field errors that stop it: `values` is every field read (null where blank and allowed to be), `errors` { field: message } for a field that is not a figure it can be. A figure is never filled in: a blank thrust of an engine that is counted is an error, not a thrust of 1.
export const readDraft = (draft) => {
  const errors = {}
  const values = {}
  const number = (field, { min = 0, above = false, whole = false, blank = false, label = FIELD_LABELS[field] } = {}, source = draft, target = values) => {
    const raw = source[field]
    const parsed = entered(raw)

    if (parsed === null) {
      if (blank && (raw === null || raw === undefined || String(raw).trim() === '')) {
        target[field] = null

        return
      }

      errors[`${source === draft ? '' : 'manual.'}${field}`] = `${label}: enter a number`
      target[field] = null

      return
    }

    if (whole && !Number.isInteger(parsed)) {
      errors[`${source === draft ? '' : 'manual.'}${field}`] = `${label}: enter a whole number`
    } else if (above ? !(parsed > min) : parsed < min) {
      errors[`${source === draft ? '' : 'manual.'}${field}`] = `${label}: enter ${above ? 'a number above' : 'a number of'} ${min}${above ? '' : ' or more'}`
    }

    target[field] = parsed
  }

  number('engines', { whole: true })
  number('engineMsp', { above: values.engines > 0 })
  number('thrust', { above: values.engines > 0, blank: !(values.engines > 0) })
  number('fuelMsp')
  number('warheadMsp')
  number('warheads', { min: 1, whole: true })
  number('decoys', { whole: true })
  number('activeMsp')
  number('thermalMsp')
  number('emMsp')
  number('geoMsp')
  number('resolution', { above: true, blank: true })
  number('sizeLimit')

  values.manual = {}

  if (draft.techMode === 'manual') {
    MANUAL_FIELDS.forEach((name) => number(name, { above: ['engine', 'fuel', 'maxThrust'].includes(name), blank: true, label: LINE_LABELS[name] }, draft.manual || {}, values.manual))
  }

  if (typeof draft.name === 'string' && draft.name.length > NAME_LENGTH) {
    errors.name = `The name is at most ${NAME_LENGTH} characters`
  }

  return { values, errors }
}

// The line of a design that is used, so that a hypothetical level of a line the design does not read does not make it hypothetical.
const usedLines = (values, draft) => {
  const sensors = [['active', values.activeMsp], ['thermal', values.thermalMsp], ['em', values.emMsp], ['geo', values.geoMsp]].filter(([, msp]) => msp >= MIN_SENSOR_MSP).map(([name]) => name)
  const used = new Set(sensors)

  if (values.engines > 0) {
    ;['engine', 'fuel', 'maxThrust'].forEach((name) => used.add(name))
  }

  if (values.warheadMsp > 0 && !draft.carried.shipDecoy) {
    used.add('warhead')
  }

  if (sensors.length) {
    used.add('reactor')
  }

  if (sensors.includes('active')) {
    used.add('em')
  }

  Object.entries(draft.options).forEach(([name, on]) => {
    if (on) {
      used.add(name === 'laser' ? 'laserEfficiency' : name)
    }
  })

  return [...used]
}

// ---- A designed column's candidate ----------------------------------------------------------------------------------

const gateOf = (name, on, figure, label, manual) => {
  if (!on) {
    return null
  }

  return figure === null || (['eccm', 'retarget'].includes(name) && !(Math.trunc(figure) > 0)) ? `${label}: ${manual ? 'no usable figure is typed for the tech line' : 'the tech line has no level to design with'}, so the option is not applied` : null
}

// The candidate `evaluateMissile` takes from a draft read without errors and the tech figures it designs with, and what the designer refused to apply: an option switched on whose tech line has no level is not applied, and says so.
const candidateOf = (draft, values, tech, stage) => {
  const blocked = []
  const asked = draft.options
  const apply = (name) => {
    const reason = gateOf(name, asked[name], name === 'laser' ? tech.laserEfficiency : tech[name], name === 'laser' ? 'Laser warhead' : LINE_LABELS[name], draft.techMode === 'manual')

    if (reason) {
      blocked.push({ id: name, reason })
    }

    return asked[name] && !reason
  }
  const eccm = apply('eccm')
  const terminal = apply('terminal')
  const retarget = apply('retarget')
  const laser = apply('laser')
  const hasEngine = values.engines > 0
  const engine = hasEngine ? { sizeMsp: values.engineMsp, thrust: values.thrust, engineTech: tech.engine, fuelTech: tech.fuel, maxThrust: tech.maxThrust } : null

  return {
    blocked,
    candidate: {
      engine,
      engines: hasEngine ? values.engines : 0,
      fuelMsp: values.fuelMsp,
      warheadMsp: values.warheadMsp,
      warheads: values.warheads,
      shipDecoy: draft.carried.shipDecoy,
      decoys: values.decoys,
      activeMsp: values.activeMsp,
      thermalMsp: values.thermalMsp,
      emMsp: values.emMsp,
      geoMsp: values.geoMsp,
      sizeLimit: values.sizeLimit,
      stage: stage || null,
      stages: stage ? draft.carried.stages : 0,
      options: { eccm: eccm ? Math.trunc(tech.eccm) : 0, terminal: terminal ? tech.terminal : 1, retarget: retarget ? Math.trunc(tech.retarget) : 0, laser },
      tech: { warhead: tech.warhead, laserEfficiency: tech.laserEfficiency, reactor: tech.reactor, active: tech.active, thermal: tech.thermal, em: tech.em, geo: tech.geo },
      sensor: { resolution: values.resolution, emSensitivity: tech.em },
      groundPod: draft.carried.groundPod,
      enhancedRadiation: draft.carried.enhancedRadiation,
    },
  }
}

// ---- Cells ---------------------------------------------------------------------------------------------------------

const reasonOf = (result) => (isAvailable(result) ? null : result.inputs.missing.join('; ') || 'not known')

// One figure of a column: its result (provenance), the value, why it has none, its unit conversions, and for a saved design what the save stored and how the two compare.
const figureCell = (id, result, extra = {}) => {
  const definition = rowOf(id)
  const value = valueOrNull(result)

  return Object.freeze({ id, result, value, reason: reasonOf(result), size: definition.size && value !== null ? sizeOf(value) : null, stored: null, verdict: null, explained: null, ...extra })
}

const inputCell = (id, value, basis, extra = {}) => {
  const known = typeof value === 'number' && Number.isFinite(value)

  return Object.freeze({ id, value: known ? value : null, size: rowOf(id).size && known ? sizeOf(value) : null, basis, note: null, ...extra })
}

const NO_FIGURE = (rule, missing, units) => unavailable({ rule, missing: [missing], units })

// ---- Saved designs -------------------------------------------------------------------------------------------------

// What the rules rebuild a saved design from: its levels (resolved from the levels the race holds), its engine and its stage, and the size limit the design was made under when the stored size shows one. `limited` is true when the contributions add up to more than the stored size by exactly the rounding of the engine's size and the design's speed is reproduced at the stored size: the game allots the fuel as the remainder of the size and caps the size there.
export const savedDesign = (fixture, design) => {
  const row = design.row
  const { lines, tech } = resolveMissileLevels(row, heldMissileLevels(fixture, design.race))
  const engine = missileEngineOf(fixture, row)
  const stage = missileStageOf(fixture, row)
  const enhancedRadiation = savedMissileCandidate(row, { engine, stage, tech }).enhancedRadiation
  const candidateAt = (sizeLimit) => savedMissileCandidate(row, { engine, stage, tech, sizeLimit })
  const free = evaluateMissile(candidateAt(0))
  const sum = free.totals.sizeSum
  const excess = isAvailable(sum) ? sum.value - row.Size : null
  const engineRounding = engine && !engine.missing ? roundHalfEven(engine.sizeMsp * row.NumEngines, 4) - engine.sizeMsp * row.NumEngines : 0
  const capped = excess !== null && excess > 0 && !agrees(sum.value, row.Size) ? evaluateMissile(candidateAt(row.Size)) : null
  const limited = capped !== null && Math.abs(excess - engineRounding) <= 1e-9 && isAvailable(capped.figures.speed) && agrees(row.Speed, capped.figures.speed.value)
  const built = limited ? capped : free

  return { id: design.id, race: design.race, row, lines, tech, engine: savedEngineOf(fixture, design), enhancedRadiation, free, built, limited, excess }
}

const lineNote = 'The levels behind the recomputed figures are the held levels whose figure reproduces the stored one, so agreement shows that some held level gives the figure, not that the rule gives it independently (design.missileLevels).'

// Whether the stored figure and the recomputed one agree: 'unsupported' when the rules do not cover the design (never agreement), 'unknown' when either is missing (never zero), 'agree' or 'differ' at the reproduction tolerance (exactly, for a whole-number figure).
export const judgeFigure = ({ stored, computed, unsupported = false, integer = false }) => {
  if (unsupported) {
    return 'unsupported'
  }

  const known = (value) => typeof value === 'number' && Number.isFinite(value)

  if (!known(stored) || !known(computed)) {
    return 'unknown'
  }

  return (integer ? stored === computed : agrees(stored, computed)) ? 'agree' : 'differ'
}

const COUNTED = Object.freeze(['agree', 'differ', 'unknown', 'unsupported'])

const countVerdicts = (cells) => Object.fromEntries(COUNTED.map((verdict) => [verdict, cells.filter((cell) => cell.verdict === verdict).length]))

// ---- Columns -------------------------------------------------------------------------------------------------------

const BASELINE = 'baseline'

// The hit chance of a missile figure set and the rest of the derived figures every column has: the missile's signature, its sensor's reach against the target and its hit chance, from the evaluation and the scenario.
const derived = ({ evaluation, candidate, scenario, version }) => {
  const speed = evaluation.figures.speed
  const size = evaluation.totals.size
  const signature = isAvailable(size) ? ofRule({ rule: SENSOR_RULES.detection, value: missileSignature({ sizeMsp: size.value }), units: 'HS', inputs: { present: ['missile size'] } }) : NO_FIGURE(SENSOR_RULES.detection, 'the missile size is not known', 'HS')
  const range = evaluation.figures.sensorRange
  const target = entered(scenario.targetSignature)
  const resolution = candidate.sensor.resolution
  const reach = !isAvailable(range) ? NO_FIGURE(SENSOR_RULES.detection, `the missile's own sensor range: ${reasonOf(range)}`, 'km') : target === null || target < 0 ? NO_FIGURE(SENSOR_RULES.detection, 'a target signature of 0 or more HS (entered above)', 'km') : sensorEffectiveRange({ rangeKm: range.value, signature: target, resolution })
  const missile = { key: 'candidate', name: 'Candidate', kind: 'candidate', speed: valueOrNull(speed), atg: candidate.options.terminal, eccm: candidate.options.eccm, warheads: candidate.warheads, shipDecoy: candidate.shipDecoy, obsolete: false, secondStageId: candidate.stages > 0 ? 1 : 0, secondStages: candidate.stages }
  const hit = hitScenario({ missile, targetSpeed: scenario.targetSpeed, jammer: scenario.jammer, modifier: scenario.modifier, version })

  return { signature, reach, hit: hit.capped }
}

const damageOf = (evaluation) => (evaluation.candidate.options.laser ? evaluation.figures.laserWarhead : evaluation.figures.warheadStrength)

const figureResults = (evaluation, extras, scenario) => {
  const figures = { sizeSum: evaluation.totals.sizeSum, size: evaluation.totals.size, speed: evaluation.figures.speed, maxRange: evaluation.figures.maxRange, endurance: evaluation.figures.endurance, fuelRequired: evaluation.figures.fuelRequired, damage: damageOf(evaluation), sensorRange: evaluation.figures.sensorRange, signature: extras.signature, reach: extras.reach, cost: evaluation.totals.cost, hitChance: extras.hit }
  const planner = plannerFigure({ warhead: figures.damage, hitChance: figures.hitChance, speed: figures.speed, pd: scenario.pd })

  return { figures: { ...figures, planner: planner.result }, planner }
}

// The shape every column has, so the table's columns carry the same rows: what a figure needs it to be a column is filled in by the caller.
const inRowOrder = (inputs) => Object.fromEntries([...INPUT_ROWS.filter((definition) => definition.id in inputs).map((definition) => [definition.id, inputs[definition.id]]), ...Object.entries(inputs).filter(([id]) => !INPUT_ROWS.some((definition) => definition.id === id))])

const columnOf = (base) => Object.freeze({ errors: {}, rowErrors: [], pdError: '', gated: [], blocked: [], withheld: '', assumptions: [], hypothetical: [], comparison: null, evaluation: null, figures: {}, valid: true, ...base, inputs: inRowOrder(base.inputs || {}) })

const withOverboost = (cells, engineFigures, basis) => {
  const over = engineFigures ? overboostOf(engineFigures) : null
  const rule = DESIGNER_RULES.overboost
  const result = over ? ofRule({ rule, value: over.factor, units: '×', inputs: { present: ['thrust', 'greatest thrust modifier', 'engine tech', 'fuel tech'] }, assumptions: [] }) : null

  cells.maxThrust = inputCell('maxThrust', engineFigures ? engineFigures.maxThrust : null, basis, engineFigures && engineFigures.maxThrust === null ? { note: engineFigures.reason || null } : {})
  cells.overboost = Object.freeze({ ...inputCell('overboost', over ? over.factor : null, basis), result, over: over ? over.over : null, excess: over ? over.excess : null, note: over ? (over.over ? `The thrust is ${over.excess} over the greatest thrust modifier: the fuel use is boosted.` : 'The thrust is within the greatest thrust modifier: no overboost.') : (cells.maxThrust.note || 'The thrust, the greatest thrust modifier or an engine tech level is not known, so no overboost can be worked out.') })
}

// A saved design as a column: the figures the save stored and the figures the rules rebuild, each judged.
const savedColumn = ({ role, key, saved, scenario, version, obsolete = false, name = null }) => {
  const { row, built, free, limited, excess } = saved
  const evaluation = built
  const extras = derived({ evaluation, candidate: evaluation.candidate, scenario, version })
  const { figures, planner } = figureResults(evaluation, extras, scenario)
  const ground = row.GroundShots > 0
  const warheadUnsupported = saved.lines.warhead.state === LINE_STATE.UNSUPPORTED
  const unsupported = (dependent) => ground || (dependent && warheadUnsupported)
  const compared = {}
  const sizeFigure = { ...figures, size: free.totals.size }

  FIGURE_ROWS.filter((definition) => definition.saved).forEach((definition) => {
    const result = sizeFigure[definition.id]
    const stored = definition.id === 'damage' && row.LaserWarhead > 0 ? row.LaserWarhead : row[definition.saved]
    const noSensor = definition.id === 'sensorRange' && !(row.MSPActive >= MIN_SENSOR_MSP)
    const verdict = noSensor ? 'none' : judgeFigure({ stored, computed: valueOrNull(result), unsupported: unsupported(definition.id === 'damage' || definition.id === 'cost'), integer: definition.id === 'sensorRange' })
    const explained = definition.id === 'size' && limited && verdict === 'differ' ? `The stored contributions add up to ${Number(free.totals.sizeSum.value.toPrecision(10))} MSP, ${Number(excess.toPrecision(4))} over the stored size: exactly the engine size rounded to 4 decimals; the game allots the fuel as the remainder of the size it was made to and caps the size there, and at the stored size the speed reproduces.` : null

    compared[definition.id] = figureCell(definition.id, result, { stored: typeof stored === 'number' ? stored : null, verdict, explained })
  })

  const cells = { ...Object.fromEntries(FIGURE_ROWS.map((definition) => [definition.id, figureCell(definition.id, figures[definition.id])])), ...compared }
  const engine = saved.engine
  const basis = 'stored in the save'
  const inputs = {
    engines: inputCell('engines', row.NumEngines, basis),
    engineMsp: inputCell('engineMsp', engine && engine.component ? engine.component.size : null, basis),
    thrust: inputCell('thrust', engine ? engine.thrust : null, engine && engine.thrustStored ? basis : 'implied by the engine\'s stored power'),
    fuelMsp: inputCell('fuelMsp', row.MSPFuel, basis),
    warheadMsp: inputCell('warheadMsp', row.MSPWarhead, basis),
    warheads: inputCell('warheads', row.MultipleWarheads, basis),
    decoys: inputCell('decoys', row.NumDecoys, basis),
    activeMsp: inputCell('activeMsp', row.MSPActive, basis),
    thermalMsp: inputCell('thermalMsp', row.MSPThermal, basis),
    emMsp: inputCell('emMsp', row.MSPEM, basis),
    geoMsp: inputCell('geoMsp', row.MSPGeo, basis),
    resolution: inputCell('resolution', row.SensorResolution > 0 ? row.SensorResolution : null, basis),
    sizeLimit: inputCell('sizeLimit', limited ? row.Size : null, limited ? 'the stored size the design was capped at' : 'the save does not store it', limited ? {} : { note: 'The save stores no size limit.' }),
    eccm: inputCell('eccm', row.ECCM, basis),
    terminal: inputCell('terminal', row.ATG, basis),
    retarget: inputCell('retarget', row.Retargeting, basis),
    laser: inputCell('laser', row.LaserWarhead > 0 ? 1 : 0, basis),
  }

  withOverboost(inputs, engine && engine.component ? { sizeMsp: engine.component.size, thrust: engine.thrust, engineTech: engine.engineTech, fuelTech: engine.fuelTech, maxThrust: engine.maxThrust ? engine.maxThrust.info : null, reason: engine.reason } : (engine ? { reason: engine.reason } : null), basis)

  const gated = GATED_OPTIONS.map((option) => {
    const present = { secondStage: row.SecondStageID > 0 || row.NumSS > 0, shipDecoy: row.ShipDecoy === 1, groundPod: ground, enhancedRadiation: saved.enhancedRadiation, retargetHigh: row.Retargeting > VALIDATED_RETARGETING, missileEcm: row.MissileECM > 0, laserFocus: row.LaserWarheadRangeModifier > 0 }[option.id]

    return gatedEntry(option.id, present ? 'recorded' : 'not-offered')
  })

  const fields = Object.values(compared)
  const resolved = Object.values(saved.lines).some((line) => line.state === LINE_STATE.RESOLVED)

  return columnOf({
    key,
    role,
    kind: 'saved',
    name: name || row.Name,
    source: SOURCES.SAVED,
    savedId: saved.id,
    obsolete,
    inputs,
    figures: cells,
    gated,
    comparison: { counts: countVerdicts(fields), fields: Object.keys(compared) },
    assumptions: resolved ? [lineNote] : [],
    evaluation,
    planner,
    limited,
    pdError: planner.fieldError,
    rowErrors: planner.rowError ? [planner.rowError] : [],
  })
}

const MANUAL_ASSUMPTION = 'Manual tech figures typed here: the race\'s own levels are not read, so nothing built on them is confirmed'

// A design made here as a column. A draft with a field error has no figures: each is unavailable with the field's message.
const designedColumn = ({ role, key, draft, context, scenario, version, name }) => {
  const { values, errors } = readDraft(draft)
  const manual = draft.techMode === 'manual'
  const used = usedLines(values, draft)
  const hypothetical = manual ? { lines: [], assumptions: [] } : hypotheticalOf(context.resolution, used.map((line) => DESIGN_LINES[line]))
  const source = manual ? SOURCES.MANUAL : hypothetical.lines.length ? SOURCES.HYPOTHETICAL : SOURCES.RESEARCHED
  const assumptions = manual ? [MANUAL_ASSUMPTION] : hypothetical.assumptions
  const base = { key, role, kind: 'designed', name, source, savedId: null, seededFrom: draft.seededFrom || null, hypothetical: hypothetical.assumptions, assumptions, errors }
  const carried = draft.carried
  const gatedFrom = (blocked, evaluation) => GATED_OPTIONS.map((option) => {
    const carriedNow = { secondStage: carried.stages > 0, shipDecoy: carried.shipDecoy, groundPod: carried.groundPod, enhancedRadiation: carried.enhancedRadiation }[option.id]
    const refused = blocked.find((entry) => entry.id === option.id) || (evaluation && evaluation.unsupported.find((entry) => entry.option === (option.id === 'retargetHigh' ? 'retarget' : option.id)))

    if (option.id === 'retargetHigh') {
      return gatedEntry(option.id, evaluation && evaluation.candidate.options.retarget > VALIDATED_RETARGETING ? 'blocked' : 'not-offered')
    }

    return carriedNow ? gatedEntry(option.id, 'carried') : gatedEntry(option.id, refused ? 'blocked' : 'not-offered')
  })

  if (Object.keys(errors).length) {
    const why = Object.values(errors).join('; ')
    const none = (id) => figureCell(id, NO_FIGURE(DESIGNER_RULES.plannerFigure, `a field of the design is not valid: ${why}`, rowOf(id).unit))

    return columnOf({ ...base, valid: false, figures: Object.fromEntries(FIGURE_ROWS.map((definition) => [definition.id, none(definition.id)])), inputs: Object.fromEntries(INPUT_ROWS.map((definition) => [definition.id, inputCell(definition.id, null, 'entered')])), gated: gatedFrom([], null) })
  }

  const tech = manual ? values.manual : techFigures(context.levels)
  const stageRow = carried.stages > 0 ? { SecondStageID: carried.stageId, NumSS: carried.stages } : null
  const stage = stageRow ? (context.fixture ? missileStageOf(context.fixture, stageRow) : { missing: true }) : null
  const { candidate, blocked } = candidateOf(draft, values, tech, stage)
  const evaluation = evaluateMissile(candidate)
  const extras = derived({ evaluation, candidate, scenario, version })
  const { figures, planner } = figureResults(evaluation, extras, scenario)
  const marks = manual ? [MANUAL_ASSUMPTION] : hypothetical.assumptions
  const mark = (result) => (marks.length ? markHypothetical(result, marks) : result)
  const basis = manual ? 'typed here' : 'entered here'
  const lineBasis = (name) => (manual ? 'typed here' : hypothetical.lines.some((line) => line.typeId === DESIGN_LINES[name]) ? 'a level the race has not researched' : 'the race\'s tech')
  const inputs = {
    engines: inputCell('engines', values.engines, basis),
    engineMsp: inputCell('engineMsp', values.engines > 0 ? values.engineMsp : null, basis),
    thrust: inputCell('thrust', values.engines > 0 ? values.thrust : null, basis),
    fuelMsp: inputCell('fuelMsp', values.fuelMsp, basis),
    warheadMsp: inputCell('warheadMsp', values.warheadMsp, basis),
    warheads: inputCell('warheads', values.warheads, basis),
    decoys: inputCell('decoys', values.decoys, basis),
    activeMsp: inputCell('activeMsp', values.activeMsp, basis),
    thermalMsp: inputCell('thermalMsp', values.thermalMsp, basis),
    emMsp: inputCell('emMsp', values.emMsp, basis),
    geoMsp: inputCell('geoMsp', values.geoMsp, basis),
    resolution: inputCell('resolution', values.resolution, basis),
    sizeLimit: inputCell('sizeLimit', values.sizeLimit, basis),
    eccm: inputCell('eccm', candidate.options.eccm, lineBasis('eccm')),
    terminal: inputCell('terminal', candidate.options.terminal, lineBasis('terminal')),
    retarget: inputCell('retarget', candidate.options.retarget, lineBasis('retarget')),
    laser: inputCell('laser', candidate.options.laser ? 1 : 0, lineBasis('laserEfficiency')),
  }

  withOverboost(inputs, values.engines > 0 ? { sizeMsp: values.engineMsp, thrust: values.thrust, engineTech: tech.engine, fuelTech: tech.fuel, maxThrust: tech.maxThrust, reason: 'a tech level of the engine, the fuel use or the greatest thrust modifier is not known' } : null, lineBasis('maxThrust'))

  const withheld = blocked.length ? `${blocked.map((entry) => entry.reason).join('; ')}. The figures would be those of a missile without ${blocked.length === 1 ? 'it' : 'them'}, so none is shown as this missile's` : ''
  const cells = Object.fromEntries(FIGURE_ROWS.map((definition) => [definition.id, figureCell(definition.id, withheld ? NO_FIGURE(DESIGNER_RULES.plannerFigure, withheld, definition.unit) : mark(figures[definition.id]))]))

  return columnOf({
    ...base,
    inputs,
    figures: cells,
    gated: gatedFrom(blocked, evaluation),
    blocked,
    withheld,
    evaluation,
    planner,
    pdError: planner.fieldError,
    rowErrors: planner.rowError ? [planner.rowError] : [],
  })
}

// ---- Comparing -----------------------------------------------------------------------------------------------------

// What the columns are worked out from: `fixture` the race's own saved designs (design-data.js `loadMissileFixture`, null while they are not read) and the tech lines' `resolution` (tech-scenarios.js `resolveChoices`), with `version` the save's formula version.
export const designerContext = ({ fixture, resolution, version = null, obsolete = {} }) => ({ fixture, resolution, levels: levelsOf(resolution), version, obsolete, saved: new Map() })

const savedOf = (context, id) => {
  if (!context.fixture) {
    return null
  }

  if (!context.saved.has(id)) {
    const design = context.fixture.designs.find((entry) => entry.id === id && !entry.stageOnly)

    context.saved.set(id, design ? savedDesign(context.fixture, design) : null)
  }

  return context.saved.get(id)
}

const missingColumn = ({ role, key, name, kind, savedId = null }, reason) => columnOf({ key, role, kind, name, source: SOURCES.SAVED, savedId, valid: false, errors: { savedId: reason }, figures: Object.fromEntries(FIGURE_ROWS.map((definition) => [definition.id, figureCell(definition.id, NO_FIGURE(DESIGNER_RULES.plannerFigure, reason, definition.unit))])), inputs: Object.fromEntries(INPUT_ROWS.map((definition) => [definition.id, inputCell(definition.id, null, 'not known')])), gated: GATED_OPTIONS.map((option) => gatedEntry(option.id, 'not-offered')) })

const SCENARIO_DEFAULTS = Object.freeze({ targetSpeed: '10000', jammer: '0', modifier: '1', pd: '0', targetSignature: '' })

export const scenarioOf = (scenario = {}) => ({ ...SCENARIO_DEFAULTS, ...scenario })

const savedColumnOf = (context, spec, scenario) => {
  const saved = savedOf(context, spec.savedId)

  if (!saved) {
    return missingColumn(spec, context.fixture ? `The design ${spec.savedId} is not one the race has researched and owns` : 'The race\'s saved designs are not read')
  }

  try {
    return savedColumn({ role: spec.role, key: spec.key, saved, scenario, version: context.version, obsolete: Boolean(context.obsolete[spec.savedId]), name: spec.name || null })
  } catch (error) {
    return missingColumn(spec, `The saved design cannot be rebuilt: ${error.message}`)
  }
}

const labelOf = (draft, index) => (typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : `Alternative ${index + 1}`)

// The columns of a comparison: the pinned baseline (a saved design, or none) and the alternatives, `spec` being { baselineId, alternatives: [saved alternative or draft], scenario: { targetSpeed, jammer, modifier, pd, targetSignature } }. Returns { columns (the baseline first), refused (alternatives beyond MAX_ALTERNATIVES, each with its reason), pdError, rowErrors }. The baseline is worked out from the save alone and no alternative changes it.
export const compareDesigns = (context, spec) => {
  const scenario = scenarioOf(spec.scenario)
  const accepted = spec.alternatives.slice(0, MAX_ALTERNATIVES)
  const refused = spec.alternatives.slice(MAX_ALTERNATIVES).map((entry, index) => ({ key: entry.key || `alt-${MAX_ALTERNATIVES + index + 1}`, name: labelOf(entry, MAX_ALTERNATIVES + index), reason: `At most ${MAX_ALTERNATIVES} alternatives are compared beside the baseline: this one is not shown.` }))
  const columns = []

  if (spec.baselineId !== null && spec.baselineId !== undefined) {
    columns.push(savedColumnOf(context, { role: BASELINE, key: BASELINE, savedId: spec.baselineId }, scenario))
  }

  accepted.forEach((entry, index) => {
    const key = entry.key || `alt-${index + 1}`
    const role = 'alternative'

    if (entry.kind === 'saved') {
      columns.push(savedColumnOf(context, { role, key, savedId: entry.savedId, name: entry.name && entry.name.trim() ? entry.name.trim() : null }, scenario))
    } else {
      columns.push(designedColumn({ role, key, draft: entry, context, scenario, version: context.version, name: labelOf(entry, index) }))
    }
  })

  return { columns, refused, pdError: pdProblem(scenario.pd), rowErrors: columns.flatMap((column) => column.rowErrors.map((message) => ({ key: column.key, name: column.name, message }))) }
}

// A new alternative added to the list: { ok: true, list } or { ok: false, reason } when three are held already. The entry gets the next unused key.
export const addAlternative = (list, entry) => {
  if (list.length >= MAX_ALTERNATIVES) {
    return { ok: false, reason: `At most ${MAX_ALTERNATIVES} alternatives are compared beside the baseline: remove one first.` }
  }

  const keys = new Set(list.map((item) => item.key))
  let next = 1

  while (keys.has(`alt-${next}`)) {
    next += 1
  }

  return { ok: true, list: [...list, { ...copyOf(entry), key: `alt-${next}` }] }
}

export const removeAlternative = (list, key) => list.filter((entry) => entry.key !== key)

// The baseline a saved design pins: its id. Seeding an alternative from it changes neither: the alternative is a copy of the design's figures and the baseline keeps the save's.
export const seedAlternative = (context, savedId) => {
  const saved = savedOf(context, savedId)

  return saved ? { ok: true, baselineId: savedId, draft: seedDraft(saved) } : { ok: false, reason: `The design ${savedId} is not one the race has researched and owns` }
}

// ---- The copied summary ---------------------------------------------------------------------------------------------

const numberIn = (value, digits) => (value === null ? 'unknown' : String(Number(value.toFixed(digits))))

const cellText = (cell, digits, unit) => (cell.value === null ? `unknown (${cell.reason})` : `${numberIn(cell.value, digits)}${unit ? ` ${unit}` : ''}`)

// The comparison as plain text for a note or a message: one block a column, the figures with their units and status, the planner figure named as such with its formula and the point-defence figure it used, and what could not be worked out with the reason.
export const summaryText = (comparison, scenario) => {
  const settings = scenarioOf(scenario)
  const lines = [`Missile designer comparison. ${PLANNER_FIGURE}: ${PLANNER_FIGURE_FORMULA}, a planner figure and not a game statistic, per warhead (not multiplied by the number of warheads). Point-defence figure ${settings.pd} km/s; target speed ${settings.targetSpeed} km/s, missile jammer ${settings.jammer}, tactical modifier ${settings.modifier}.`]

  comparison.columns.forEach((column) => {
    lines.push('', `${column.role === BASELINE ? 'Baseline (pinned)' : 'Alternative'}: ${column.name} (${SOURCE_LABELS[column.source]})`)

    FIGURE_ROWS.forEach((definition) => {
      const cell = column.figures[definition.id]
      const label = definition.id === 'planner' ? `${PLANNER_FIGURE} (not a game statistic)` : definition.label
      const status = cell.result && isAvailable(cell.result) ? ` [${cell.result.status}]` : ''
      const size = cell.size ? ` = ${numberIn(cell.size.hs, 4)} HS = ${numberIn(cell.size.tons, 3)} t` : ''

      lines.push(`  ${label}: ${cellText(cell, definition.digits, definition.unit)}${size}${status}`)
    })

    if (column.rowErrors.length) {
      lines.push(...column.rowErrors.map((message) => `  Error: ${message}`))
    }

    if (column.blocked.length) {
      lines.push(...column.blocked.map((entry) => `  Not applied: ${entry.reason}`), '  No figure of this column is shown as the missile\'s: the option asked for is not applied.')
    }

    lines.push(...column.gated.filter((entry) => entry.state !== 'not-offered').map((entry) => `  ${entry.label}: ${gatedStateText(entry.state).toLowerCase()}`))
  })

  if (comparison.refused.length) {
    lines.push('', ...comparison.refused.map((entry) => `Not compared: ${entry.name}. ${entry.reason}`))
  }

  const limit = versionLimit(null)

  return `${lines.join('\n')}${limit ? `\n\n${limit}.` : ''}`
}

// ---- Loading -------------------------------------------------------------------------------------------------------

// The missiles the race owns (the race that researched a design owns it) and has researched (it holds the design's tech, FCT_RaceTech), as the saved designs of the fixture the rules read, with the obsolete flags. A design the race owns and does not hold, or holds and does not own, is not imported: `excluded` counts the first. Another race's designs never enter.
export const loadDesigns = async (database, { GameID, RaceID }) => {
  const [held] = await database.query('select FCT_RaceTech.TechID, FCT_RaceTech.Obsolete from FCT_RaceTech where FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID', { replacements: { GameID, RaceID } })
  const researched = new Map(held.map((row) => [Number(row.TechID), Boolean(row.Obsolete)]))
  const owned = await ownedMissiles(database, GameID, RaceID)
  const known = owned.filter((row) => researched.has(row.MissileID))
  const fixture = await loadMissileFixture(database, GameID, known)

  return Object.freeze({ fixture, obsolete: Object.freeze(Object.fromEntries(known.map((row) => [row.MissileID, researched.get(row.MissileID)]))), excluded: owned.length - known.length })
}

export const NO_DESIGNS = Object.freeze({ fixture: null, obsolete: Object.freeze({}), excluded: 0 })

// The saved designs of the race as menu entries, oldest id first; a stage-only design (a second stage another design names) is not offered.
export const savedChoices = (designs) => (designs.fixture ? designs.fixture.designs.filter((design) => !design.stageOnly).map((design) => ({ id: design.id, name: design.row.Name, obsolete: Boolean(designs.obsolete[design.id]), size: design.row.Size, speed: design.row.Speed })).sort((a, b) => a.id - b.id) : [])

// ---- The record ----------------------------------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isText = (value) => typeof value === 'string'

const DRAFT_TEXT_FIELDS = Object.freeze(['engines', 'engineMsp', 'thrust', 'fuelMsp', 'warheadMsp', 'warheads', 'decoys', 'activeMsp', 'thermalMsp', 'emMsp', 'geoMsp', 'resolution', 'sizeLimit'])

const SCENARIO_FIELDS = Object.freeze(Object.keys(SCENARIO_DEFAULTS))

const savedIdOk = (value) => Number.isInteger(value) && value > 0

const entryProblems = (entry, index) => {
  const where = `alternative ${index + 1}`

  if (!isObject(entry)) {
    return [`${where} is an object`]
  }

  if (!isText(entry.key) || !isText(entry.name) || entry.name.length > NAME_LENGTH) {
    return [`${where} has a key and a name of at most ${NAME_LENGTH} characters`]
  }

  if (entry.kind === 'saved') {
    return savedIdOk(entry.savedId) ? [] : [`${where} names a saved design`]
  }

  if (entry.kind !== 'designed') {
    return [`${where} is saved or designed`]
  }

  const problems = []

  if (!['page', 'manual'].includes(entry.techMode)) {
    problems.push(`${where} designs with the page's tech or typed figures`)
  }

  if (!(entry.seededFrom === null || savedIdOk(entry.seededFrom))) {
    problems.push(`${where} was seeded from a saved design or none`)
  }

  DRAFT_TEXT_FIELDS.forEach((field) => {
    if (!isText(entry[field])) {
      problems.push(`${where} has ${field} as text`)
    }
  })

  if (!isObject(entry.options) || !['eccm', 'terminal', 'retarget', 'laser'].every((name) => typeof entry.options[name] === 'boolean')) {
    problems.push(`${where} has its options as true or false`)
  }

  const carried = entry.carried

  if (!isObject(carried) || !Number.isInteger(carried.stageId) || carried.stageId < 0 || !Number.isInteger(carried.stages) || carried.stages < 0 || !['shipDecoy', 'groundPod', 'enhancedRadiation'].every((name) => typeof carried[name] === 'boolean')) {
    problems.push(`${where} has what it carries as a stage and flags`)
  }

  if (!isObject(entry.manual) || !MANUAL_FIELDS.every((name) => isText(entry.manual[name]))) {
    problems.push(`${where} has its typed tech figures as text`)
  }

  return problems
}

const TECH_KINDS = Object.freeze({ RESEARCHED: 'researched', HYPOTHETICAL: 'hypothetical' })

const techProblems = (tech) => {
  if (!isObject(tech) || !isObject(tech.choices)) {
    return ['the tech has its choices as a map by tech type']
  }

  const problems = []

  Object.entries(tech.choices).forEach(([type, choice]) => {
    if (!DESIGN_LINE_TYPES.includes(Number(type)) || String(Number(type)) !== type) {
      problems.push(`the tech choice for ${type} is not a tech line a design reads`)
    } else if (!isObject(choice) || !savedIdOk(choice.techId) || !isText(choice.name) || !choice.name.trim() || choice.name.length > TECH_NAME_LENGTH || !Object.values(TECH_KINDS).includes(choice.kind)) {
      problems.push(`the tech choice for ${type} is { techId, name, kind } of a researched or hypothetical level`)
    }
  })

  return problems
}

// What is wrong with a payload, as sentences; none for a payload the record keeps: { name, baselineId (a saved design or null), alternatives (at most three), scenario (text fields), tech: { choices } (the researched and hypothetical levels chosen, by tech type) }.
export const problemsOf = (payload) => {
  if (!isObject(payload)) {
    return ['the payload is an object']
  }

  const problems = []

  if (!isText(payload.name) || !payload.name.trim() || payload.name.length > NAME_LENGTH) {
    problems.push(`the name is 1 to ${NAME_LENGTH} characters`)
  }

  if (!(payload.baselineId === null || savedIdOk(payload.baselineId))) {
    problems.push('the baseline is a saved design or none')
  }

  if (!Array.isArray(payload.alternatives) || payload.alternatives.length > MAX_ALTERNATIVES) {
    problems.push(`the alternatives are a list of at most ${MAX_ALTERNATIVES}`)
  } else {
    payload.alternatives.forEach((entry, index) => problems.push(...entryProblems(entry, index)))
  }

  if (!isObject(payload.scenario) || !SCENARIO_FIELDS.every((field) => isText(payload.scenario[field]))) {
    problems.push('the scenario has its fields as text')
  }

  problems.push(...techProblems(payload.tech))

  return problems
}

// The designs a record names, as the rows its links are fingerprinted from and resolved against: `known` by id.
export const knownDesigns = (designs) => Object.fromEntries((designs.fixture ? designs.fixture.designs.filter((design) => !design.stageOnly) : []).map((design) => [design.id, { id: design.id, name: design.row.Name, size: design.row.Size, speed: design.row.Speed, cost: design.row.Cost, warhead: design.row.WarheadStrength }]))

const idsOf = (payload) => [...new Set([payload.baselineId, ...payload.alternatives.filter((entry) => entry.kind === 'saved').map((entry) => entry.savedId), ...payload.alternatives.filter((entry) => entry.kind === 'designed' && entry.seededFrom).map((entry) => entry.seededFrom)].filter(savedIdOk))]

// The adapter of the scenario repository for the designer's inputs. A record is of the branch (policy 'branch'): the research a hypothetical alternative rests on belongs to it. The saved designs it names are links of type 'missile' fingerprinted by their name and figures, so a design that is gone reads as missing and one whose figures changed as changed, and neither is rebound.
export const designerAdapter = Object.freeze({
  kind: DESIGNER_KIND,
  schema: DESIGNER_SCHEMA,
  validate: problemsOf,
  migrate: (payload, fromSchema) => (fromSchema < 2 ? { ...payload, tech: { choices: {} } } : payload),
  fingerprint: (type, row) => (type === TECH_LINK_TYPE ? [type, row.typeId, row.name, row.info, row.info2, row.cost].join('|') : [type, row.name, row.size, row.speed, row.cost, row.warhead].join('|')),
  resolve: (links, context) => links.map((link) => (context && context.known && context.known[link.type] && context.known[link.type][link.id]) || null),
  versions: () => ({ 'missileDesigner.plannerFigure': VERSIONS.join(', ') }),
})

const registered = new WeakSet()

// Registers the adapter with a repository's `registerAdapter`, once per function.
export const registerDesigner = (register) => {
  if (registered.has(register)) {
    return
  }

  try {
    register(designerAdapter)
  } catch (error) {
    if (!/registered already/.test(String(error && error.message))) {
      throw error
    }
  }

  registered.add(register)
}

const NOT_APPLIED = ['newer-schema', 'no-adapter', 'invalid-payload']

const unappliedReason = (item) => `A comparison written by another version of the app or not valid is not listed (${item.flags.join(', ')}).`

// The comparisons of the race on the branch as the open save reads them: `{ entries, notes, error }`, an entry `{ uuid, name, payload, revision, status, ahead, links, flags }`. One saved at a later game time is listed and flagged `ahead`. Nothing is written.
export const readDesigns = (repository, scope, designs, tech = null) => {
  const empty = { entries: [], notes: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed

  try {
    listed = repository.list(scope, { kind: DESIGNER_KIND, context: { known: { [MISSILE_LINK_TYPE]: knownDesigns(designs), [TECH_LINK_TYPE]: tech && tech.known ? tech.known : {} } } })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: { code: error.code, message: error.message } }
    }

    throw error
  }

  const unreadable = (item) => item.flags.some((flag) => NOT_APPLIED.includes(flag))

  return {
    entries: listed.filter((item) => !unreadable(item)).map((item) => ({ uuid: item.record.uuid, name: item.payload.name, payload: copyOf(item.payload), revision: item.record.revision, status: item.status, ahead: item.status === 'ahead', links: copyOf(item.links || []), flags: item.flags })),
    notes: listed.filter(unreadable).map((item) => ({ uuid: item.record.uuid, flags: item.flags, reason: unappliedReason(item) })),
    error: null,
  }
}

const failure = (error) => ({ ok: false, code: (error && error.code) || 'failed', message: error && error.message ? error.message : String(error) })

const mayWrite = async (repository, scope) => {
  if (!repository) {
    return { ok: false, code: 'no-repository', message: 'The scenario records are not available in this window, so the comparison is not kept.' }
  }

  if (!scope) {
    return { ok: false, code: 'no-scope', message: 'The campaign of this save is not settled yet, so the comparison is not kept.' }
  }

  if (!(await repository.writable(scope.campaignId))) {
    return { ok: false, code: 'not-owner', message: 'Another tab holds the scenario file, so the comparison is not kept.' }
  }

  return { ok: true }
}

const assumptionsOf = () => ['The comparison keeps the inputs only: every figure is worked out again from the save when it is opened', `The ${PLANNER_FIGURE.toLowerCase()} is the planner's own heuristic, not a game statistic`]

const patchOf = (payload, designs, tech, carry) => {
  const known = knownDesigns(designs)
  const techKnown = tech && tech.known ? tech.known : {}

  const linkOf = (type, id, row) => {
    const kept = carry.find((link) => link.type === type && link.id === id)

    if (kept) {
      return kept.fingerprint ? { type, id, fingerprint: kept.fingerprint } : null
    }

    return row ? { type, id, row } : null
  }

  const missileLinks = idsOf(payload).map((id) => linkOf(MISSILE_LINK_TYPE, id, known[id]))
  const techLinks = Object.values(payload.tech.choices).map((choice) => linkOf(TECH_LINK_TYPE, choice.techId, techKnown[choice.techId]))

  return {
    payload: copyOf(payload),
    links: [...missileLinks, ...techLinks].filter(Boolean),
    assumptions: assumptionsOf(),
  }
}

// Keeps a comparison: a new record of the race on the branch when `entry` is null, else the record `entry` names, edited over the revision the entry was read at. A stale revision is refused with the code 'revision-conflict' and the stored payload, and nothing is written, unless `overwrite` says to write over what is stored. A design the payload names that the save does not hold is refused. A link is never re-fingerprinted by a save: `carry` is the links of the choices as they were read (`carryOf`, `techLinksOf`, whatever their status), a fingerprint is kept as it was stored and a choice read with none stays unlinked, because its ID may have been given to another object since; only a choice that has no entry in `carry`, being chosen now, is linked to the object as the open save has it. Returns `{ ok: true, record }` or `{ ok: false, code, message }`.
export const saveDesign = async (repository, scope, designs, { entry = null, payload, overwrite = false, tech = null, carry = [] }) => {
  try {
    const allowed = await mayWrite(repository, scope)

    if (!allowed.ok) {
      return allowed
    }

    const problems = problemsOf(payload)

    if (problems.length) {
      return { ok: false, code: 'invalid-design', message: `The comparison is not valid: ${problems.join('; ')}` }
    }

    const known = knownDesigns(designs)
    const unknown = idsOf(payload).filter((id) => !known[id])

    if (unknown.length) {
      return { ok: false, code: 'unknown-design', message: `The comparison names a design the race has not researched and owns: ${unknown.join(', ')}` }
    }

    if (!entry) {
      return { ok: true, record: repository.create(scope, { kind: DESIGNER_KIND, policy: 'branch', ...patchOf(payload, designs, tech, carry) }) }
    }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, patchOf(payload, designs, tech, carry)) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      if (!overwrite) {
        return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
      }

      return { ok: true, record: repository.reconcile(scope, error, patchOf(payload, designs, tech, carry)) }
    }
  } catch (error) {
    return failure(error)
  }
}

// Moves a comparison saved at a later game time to the open save (its payload is not changed), so that it applies here.
export const moveDesign = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope)

    return allowed.ok ? { ok: true, record: repository.update(scope, entry.uuid, entry.revision, { rebase: true }) } : allowed
  } catch (error) {
    return failure(error)
  }
}

// Deletes a comparison over the revision the entry was read at; a stale revision is refused and nothing is deleted.
export const deleteDesign = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope)

    return allowed.ok ? { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) } : allowed
  } catch (error) {
    return failure(error)
  }
}

// The tech levels a page designs with that differ from the game's pick, as a record keeps them. `selection` maps a tech type to { techId, source, name } (tech-scenarios.js `selectionOf`): a level the race has researched ('preference') is kept as 'researched', a record's choice ('scenario') as 'hypothetical'. A level is kept by its ID and name, never by its figures, and only for the lines a design reads.
export const techChoicesOf = (selection, tech) => ({ choices: Object.fromEntries(DESIGN_LINE_TYPES.filter((type) => selection && selection[type] && savedIdOk(selection[type].techId)).map((type) => [type, { techId: selection[type].techId, name: selection[type].name || (tech && tech.known && tech.known[selection[type].techId] ? tech.known[selection[type].techId].name : `tech ${selection[type].techId}`), kind: selection[type].source === 'preference' ? TECH_KINDS.RESEARCHED : TECH_KINDS.HYPOTHETICAL }])) })

const fingerprintOf = (link) => (typeof link.fingerprint === 'string' && link.fingerprint ? link.fingerprint : null)

// The tech links of a selection as they were read, for `saveDesign` to carry: each choice that has a link (the stored one of a comparison or a tech scenario, whatever its status) by tech ID, with the stored fingerprint, or none when it was read with none. A choice made now has no link and is not carried.
export const techLinksOf = (selection) => Object.values(selection || {}).filter((choice) => choice && choice.link && savedIdOk(choice.techId)).map((choice) => ({ type: TECH_LINK_TYPE, id: choice.techId, fingerprint: fingerprintOf(choice.link) }))

// The links of a comparison as it was read or written, for `saveDesign` to carry: each stored link of a saved design or a tech with its fingerprint, and a tech choice of the payload that has no link with none, so that it stays unlinked until it is chosen again.
export const carryOf = (links, payload) => {
  const stored = (links || []).filter((link) => link && (link.type === MISSILE_LINK_TYPE || link.type === TECH_LINK_TYPE))
  const choices = payload && payload.tech && payload.tech.choices ? Object.values(payload.tech.choices) : []

  return [...stored.map((link) => ({ type: link.type, id: link.id, fingerprint: fingerprintOf(link) })), ...choices.filter((choice) => !stored.some((link) => link.type === TECH_LINK_TYPE && link.id === choice.techId)).map((choice) => ({ type: TECH_LINK_TYPE, id: choice.techId, fingerprint: null }))]
}

// What a payload from the page's state is: the baseline, the alternatives (each as typed), the scenario texts and the tech levels chosen.
export const payloadOf = ({ name, baselineId, alternatives, scenario, tech = null }) => ({ name: text(name).trim(), baselineId: baselineId === undefined ? null : baselineId, alternatives: copyOf(alternatives), scenario: Object.fromEntries(SCENARIO_FIELDS.map((field) => [field, text(scenarioOf(scenario)[field])])), tech: tech === null ? { choices: {} } : copyOf(tech) })
